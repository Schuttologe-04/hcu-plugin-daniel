import type { Logger } from 'pino';
import type { AppConfig } from '../../config/config-types.js';
import type { ProbeReport } from '../../diagnostics/probe-service.js';
import type { IdProvider } from '../id-provider.js';
import type { HcuConnectionState, HcuEnvelope, HcuSender, IncomingHcuMessage } from '../message-types.js';
import { createDeviceRegistry } from './device-registry.js';
import { projectDevice, readDevicePower } from './device-projection.js';
import { PowerWindowAggregator, POWER_SAMPLE_MAX_AGE_MS } from './power-window.js';
import type { DeviceDefinition, PluginDevice, PluginDeviceFeature } from './device-types.js';

interface PublishedFeatures { readonly power: number | undefined; readonly unreach: boolean | undefined }
interface Series {
  readonly average: PowerWindowAggregator;
  attemptedWindowEndMs: number | undefined;
}

export interface DeviceObservationTiming {
  /** Conservative common start of the existing concurrent controller/charger read. */
  readonly sampledAtMs: number;
  readonly receivedAtMs: number;
}

export interface PluginDeviceServiceOptions {
  readonly config: AppConfig;
  readonly sender: HcuSender;
  readonly idProvider: IdProvider;
  readonly now?: () => number;
  readonly logger?: Logger;
}

/** Bounded by configured identities; no sample queue, timer, polling or persistence. */
export class PluginDeviceService {
  #definitions = new Map<string, DeviceDefinition>();
  #report: ProbeReport | null = null;
  #timing: DeviceObservationTiming | undefined;
  #included = new Set<string>();
  #inclusionKnown = false;
  #connected = false;
  readonly #series = new Map<string, Series>();
  readonly #published = new Map<string, PublishedFeatures>();
  #lastPublishError: string | null = null;

  constructor(private readonly options: PluginDeviceServiceOptions) { this.configure(options.config); }

  get deviceIds(): readonly string[] { return [...this.#definitions.keys()]; }
  get includedDeviceIds(): readonly string[] { return [...this.#included]; }
  get inclusionKnown(): boolean { return this.#inclusionKnown; }
  get lastPublishError(): string | null { return this.#lastPublishError; }

  configure(config: AppConfig): void {
    const next = new Map(createDeviceRegistry(config).map(definition => [definition.deviceId, definition]));
    for (const [id, definition] of next) {
      // A stable logical ID must never inherit another host's integral or delivered value.
      if (JSON.stringify(definition.source) !== JSON.stringify(this.#definitions.get(id)?.source)) {
        this.#series.delete(id);
        this.#published.delete(id);
      }
    }
    this.#definitions = next;
    for (const id of this.#included) if (!next.has(id)) this.#included.delete(id);
    for (const id of this.#published.keys()) if (!next.has(id)) this.#published.delete(id);
    for (const id of this.#series.keys()) if (!next.has(id)) this.#series.delete(id);
  }

  setConnectionState(state: HcuConnectionState): void {
    const connected = state === 'CONNECTED' || state === 'READY';
    if (!connected || !this.#connected) {
      this.#included.clear();
      this.#published.clear();
      this.#series.clear();
      this.#inclusionKnown = false;
      // Reconnect starts a new minute on the next actual observation, not an old snapshot.
      this.#report = null;
      this.#timing = undefined;
    }
    this.#connected = connected;
  }

  /** Consumes existing poll results. HCU requests never advance time integrals. */
  observe(report: ProbeReport | null, timing?: DeviceObservationTiming): void {
    const now = this.#now();
    this.#report = report;
    this.#timing = timing ?? { sampledAtMs: now, receivedAtMs: now };
    const completed = new Set<string>();
    for (const [id, definition] of this.#definitions) {
      if (!this.#connected) continue;
      let series = this.#series.get(id);
      if (series === undefined) {
        series = { average: new PowerWindowAggregator(), attemptedWindowEndMs: undefined };
        this.#series.set(id, series);
      }
      const source = projectDevice(definition, report);
      const rawPower = readDevicePower(definition, report);
      if (this.#values(source).unreach === true) {
        // A physical disconnect must earn a new minute after recovery.
        series.average.clear();
        this.#forgetPower(id);
        continue;
      }
      const window = series.average.observe(rawPower, this.#timing.sampledAtMs, this.#timing.receivedAtMs);
      if (rawPower === undefined || !this.#fresh(now)) this.#forgetPower(id);
      if (window !== undefined && window.endMs !== series.attemptedWindowEndMs) {
        // No replay on later polls, including after a failed power send.
        series.attemptedWindowEndMs = window.endMs;
        completed.add(id);
      }
    }
    if (!this.#connected || !this.#inclusionKnown) return;
    for (const id of this.#included) {
      const device = this.#device(id, now);
      if (device === undefined) continue;
      const values = this.#values(device);
      const previous = this.#published.get(id);
      const features: PluginDeviceFeature[] = [];
      if (completed.has(id) && values.power !== undefined && values.power !== previous?.power) {
        features.push({ type: 'currentPower', currentPower: values.power });
      }
      if (values.unreach !== undefined && values.unreach !== previous?.unreach) features.push({ type: 'maintenance', unreach: values.unreach });
      if (features.length === 0) continue;
      if (this.#send('STATUS_EVENT', this.options.idProvider.nextId(), { deviceId: id, features })) {
        this.#published.set(id, {
          power: features.some(feature => feature.type === 'currentPower') ? values.power : previous?.power,
          unreach: values.unreach ?? previous?.unreach,
        });
      }
    }
  }

  handle(message: IncomingHcuMessage): boolean {
    if (message.pluginId !== this.options.sender.pluginId) return false;
    switch (message.type) {
      case 'DISCOVER_REQUEST':
        this.#send('DISCOVER_RESPONSE', message.id, { success: true, devices: this.#devices(this.deviceIds) });
        return true;
      case 'INCLUSION_EVENT':
        this.#included = new Set(message.body.deviceIds.filter(id => this.#definitions.has(id)));
        this.#inclusionKnown = true;
        this.#published.clear();
        this.#status(this.includedDeviceIds, this.options.idProvider.nextId());
        return true;
      case 'EXCLUSION_EVENT':
        for (const id of message.body.deviceIds) { this.#included.delete(id); this.#published.delete(id); }
        return true;
      case 'STATUS_REQUEST':
        this.#status(message.body.deviceIds ?? this.deviceIds, message.id);
        return true;
      case 'CONTROL_REQUEST':
        this.#send('CONTROL_RESPONSE', message.id, { deviceId: message.body.deviceId, success: false,
          error: { code: this.#definitions.has(message.body.deviceId) ? 'READ_ONLY_DEVICE' : 'UNKNOWN_DEVICE' } });
        return true;
      default: return false;
    }
  }

  #now(): number { return (this.options.now ?? Date.now)(); }

  #fresh(now: number): boolean {
    const timing = this.#timing;
    return timing !== undefined && Number.isSafeInteger(now) && Number.isSafeInteger(timing.sampledAtMs)
      && Number.isSafeInteger(timing.receivedAtMs) && timing.sampledAtMs >= 0 && timing.receivedAtMs >= timing.sampledAtMs
      && timing.receivedAtMs <= now && now - timing.sampledAtMs <= POWER_SAMPLE_MAX_AGE_MS;
  }

  #forgetPower(id: string): void {
    const previous = this.#published.get(id);
    if (previous !== undefined) this.#published.set(id, { power: undefined, unreach: previous.unreach });
  }

  #device(id: string, now = this.#now()): PluginDevice | undefined {
    const definition = this.#definitions.get(id);
    if (definition === undefined) return undefined;
    const current = projectDevice(definition, this.#report);
    const fresh = this.#fresh(now);
    const maintenance = current.features.find(feature => feature.type === 'maintenance');
    const average = fresh && readDevicePower(definition, this.#report) !== undefined
      ? this.#series.get(id)?.average.latest(now)?.powerW : undefined;
    return { ...current, features: [
      { type: 'currentPower', ...(average === undefined ? {} : { currentPower: Object.is(Math.round(average), -0) ? 0 : Math.round(average) }) },
      // Explicit connection failures remain negative evidence even after a slow
      // timeout. Freshness is required to assert recovery, never to hide failure.
      fresh || maintenance?.unreach === true ? maintenance ?? { type: 'maintenance' } : { type: 'maintenance' },
    ] };
  }

  #devices(ids: readonly string[]): readonly PluginDevice[] {
    const now = this.#now();
    return [...new Set(ids)].flatMap(id => { const device = this.#device(id, now); return device === undefined ? [] : [device]; });
  }

  #values(device: PluginDevice): PublishedFeatures {
    return {
      power: device.features.find(feature => feature.type === 'currentPower')?.currentPower,
      unreach: device.features.find(feature => feature.type === 'maintenance')?.unreach,
    };
  }

  #status(ids: readonly string[], messageId: string): void {
    const devices = this.#devices(ids);
    if (this.#send('STATUS_RESPONSE', messageId, { success: true, devices })) {
      for (const device of devices) if (this.#included.has(device.deviceId)) this.#published.set(device.deviceId, this.#values(device));
    }
  }

  #send(type: string, id: string, body: NonNullable<HcuEnvelope['body']>): boolean {
    try {
      if (this.options.sender.send({ pluginId: this.options.sender.pluginId, id, type, body })) {
        this.#lastPublishError = null;
        return true;
      }
    } catch { /* Sanitized per-device failure; no payload or retry queue. */ }
    this.#lastPublishError = 'HCU_DEVICE_PUBLISH_FAILED';
    this.options.logger?.warn({ code: this.#lastPublishError, messageType: type }, 'Plugin device publication failed');
    return false;
  }
}

