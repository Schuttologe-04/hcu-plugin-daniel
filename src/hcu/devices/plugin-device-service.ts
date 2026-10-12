import type { Logger } from 'pino';
import type { AppConfig } from '../../config/config-types.js';
import type { ProbeReport } from '../../diagnostics/probe-service.js';
import type { IdProvider } from '../id-provider.js';
import type { HcuConnectionState, HcuEnvelope, HcuSender, IncomingHcuMessage } from '../message-types.js';
import { createDeviceRegistry } from './device-registry.js';
import { projectDevice } from './device-projection.js';
import type { DeviceDefinition, PluginDevice, PluginDeviceFeature } from './device-types.js';

interface PublishedFeatures { readonly power: number | undefined; readonly unreach: boolean | undefined }

export interface PluginDeviceServiceOptions {
  readonly config: AppConfig;
  readonly sender: HcuSender;
  readonly idProvider: IdProvider;
  readonly logger?: Logger;
}

/** Bounded by configured identities; synchronous sends, no queue, polling or timer. */
export class PluginDeviceService {
  #definitions = new Map<string, DeviceDefinition>();
  #report: ProbeReport | null = null;
  #included = new Set<string>();
  #inclusionKnown = false;
  #connected = false;
  readonly #published = new Map<string, PublishedFeatures>();
  #lastPublishError: string | null = null;

  constructor(private readonly options: PluginDeviceServiceOptions) { this.configure(options.config); }

  get deviceIds(): readonly string[] { return [...this.#definitions.keys()]; }
  get includedDeviceIds(): readonly string[] { return [...this.#included]; }
  get inclusionKnown(): boolean { return this.#inclusionKnown; }
  get lastPublishError(): string | null { return this.#lastPublishError; }

  configure(config: AppConfig): void {
    const next = new Map(createDeviceRegistry(config).map(definition => [definition.deviceId, definition]));
    const binding = (definitions: Map<string, DeviceDefinition>): string => JSON.stringify([...definitions.values()].map(({ deviceId, source }) => ({ deviceId, source })));
    if (binding(next) !== binding(this.#definitions)) this.#report = null;
    this.#definitions = next;
    // A disabled/removed configuration has neither status nor unsolicited updates.
    for (const id of this.#included) if (!next.has(id)) this.#included.delete(id);
    for (const id of this.#published.keys()) if (!next.has(id)) this.#published.delete(id);
  }

  setConnectionState(state: HcuConnectionState): void {
    const connected = state === 'CONNECTED' || state === 'READY';
    if (!connected || !this.#connected) {
      this.#included.clear();
      this.#published.clear();
      this.#inclusionKnown = false;
    }
    this.#connected = connected;
  }

  /** Receives the existing validated poll result; never re-reads a physical device. */
  observe(report: ProbeReport | null): void {
    this.#report = report;
    if (!this.#connected || !this.#inclusionKnown) return;
    for (const id of this.#included) {
      const device = this.#device(id);
      if (device === undefined) continue;
      const values = this.#values(device);
      const previous = this.#published.get(id);
      const features: PluginDeviceFeature[] = [];
      if (values.power !== undefined && values.power !== previous?.power) features.push({ type: 'currentPower', currentPower: values.power });
      if (values.unreach !== undefined && values.unreach !== previous?.unreach) features.push({ type: 'maintenance', unreach: values.unreach });
      if (features.length === 0) continue;
      if (this.#send('STATUS_EVENT', this.options.idProvider.nextId(), { deviceId: id, features })) {
        // An omitted power never overwrites the last actually delivered measurement.
        this.#published.set(id, { power: values.power ?? previous?.power, unreach: values.unreach ?? previous?.unreach });
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

  #device(id: string): PluginDevice | undefined {
    const definition = this.#definitions.get(id);
    return definition === undefined ? undefined : projectDevice(definition, this.#report);
  }

  #devices(ids: readonly string[]): readonly PluginDevice[] {
    return [...new Set(ids)].flatMap(id => { const device = this.#device(id); return device === undefined ? [] : [device]; });
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
    } catch { /* Record a sanitized delivery failure; never expose payloads. */ }
    this.#lastPublishError = 'HCU_DEVICE_PUBLISH_FAILED';
    this.options.logger?.warn({ code: this.#lastPublishError, messageType: type }, 'Plugin device publication failed');
    return false;
  }
}
