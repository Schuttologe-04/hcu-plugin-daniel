import { describe, expect, it } from 'vitest';
import type { ProbeReport } from '../../../../src/diagnostics/probe-service.js';
import { failure, success } from '../../../../src/domain/errors.js';
import { PluginDeviceService } from '../../../../src/hcu/devices/plugin-device-service.js';
import { createDeviceRegistry } from '../../../../src/hcu/devices/device-registry.js';
import { projectDevice } from '../../../../src/hcu/devices/device-projection.js';
import type { PluginDeviceFeature } from '../../../../src/hcu/devices/device-types.js';
import type { HcuEnvelope, IncomingHcuMessage } from '../../../../src/hcu/message-types.js';
import { PLUGIN_ID } from '../../../../src/hcu/plugin-identity.js';
import { makeConfig } from '../../load-management/helpers.js';
import { telemetry } from './helpers.js';

const DAY_MS = 86_400_000;
const FOURTEEN_DAYS_MS = 14 * DAY_MS;
const POLL_MS = 2000;

function simulate(interruptions: boolean) {
  const config = makeConfig();
  const registry = createDeviceRegistry(config);
  const clock = { now: 0 };
  const totals = { samples: 0, previousPower: 0, power: 0, controllerPower: 0, maintenance: 0, statuses: 0 };
  const oldPublished = new Map<string, number>();
  const lastPowerAt = new Map<string, number>();
  let minimumPowerGapMs = Infinity;
  let sequence = 0;
  const send = (message: HcuEnvelope) => {
    if (message.type === 'STATUS_RESPONSE') totals.statuses++;
    if (message.type !== 'STATUS_EVENT') return true;
    const id = message.body?.['deviceId'];
    if (typeof id !== 'string') throw new Error('Invalid test event');
    for (const feature of message.body?.['features'] as readonly PluginDeviceFeature[]) {
      if (feature.type === 'maintenance') totals.maintenance++;
      else if (feature.currentPower !== undefined) {
        totals.power++;
        if (id.startsWith('controller-')) totals.controllerPower++;
        const previous = lastPowerAt.get(id);
        if (previous !== undefined) minimumPowerGapMs = Math.min(minimumPowerGapMs, clock.now - previous);
        lastPowerAt.set(id, clock.now);
      }
    }
    return true;
  };
  const service = new PluginDeviceService({ config, sender: { pluginId: PLUGIN_ID, send },
    idProvider: { nextId: () => String(++sequence) }, now: () => clock.now });
  const include = () => service.handle({ pluginId: PLUGIN_ID, type: 'INCLUSION_EVENT', id: 'include',
    body: { deviceIds: registry.map(device => device.deviceId) } } satisfies IncomingHcuMessage);
  const base = telemetry(config);
  if (!base.controller.ok) throw new Error('Expected fixture controller');
  const originalController = base.controller.value;
  service.setConnectionState('CONNECTED');
  for (let at = 0; at <= FOURTEEN_DAYS_MS; at += POLL_MS) {
    clock.now = at;
    const power = 1000 + (at / POLL_MS) % 3000;
    const report: ProbeReport = {
      controller: interruptions && at >= 7 * DAY_MS && at < 7 * DAY_MS + 60_000
        ? failure('TimeoutError', 'Offline mock')
        : success({ ...originalController, gridPowerW: power, gridImportW: power, homePowerW: power + 50, solarPowerW: -power - 500 }),
      chargers: base.chargers.map(charger => charger.status !== 'reachable' ? charger
        : { ...charger, value: { ...charger.value, currentPowerW: power * (charger.config.id === 'garage' ? 2 : 3) } }),
    };
    if (interruptions && at === 10 * DAY_MS) service.setConnectionState('RECONNECTING');
    if (interruptions && at === 10 * DAY_MS + 60_000) service.setConnectionState('CONNECTED');
    service.observe(report, { sampledAtMs: at, receivedAtMs: at });
    totals.samples++;
    if (at === 0 || (interruptions && at === 10 * DAY_MS + 60_000)) include();
    // Reference contract of v0.2.1: each changed rounded source value was sent.
    // Initial full status establishes the baseline, not a regular power event.
    for (const definition of registry) {
      const value = projectDevice(definition, report).features.find(feature => feature.type === 'currentPower')?.currentPower;
      if (value === undefined) continue;
      if (at !== 0 && value !== oldPublished.get(definition.deviceId)) totals.previousPower++;
      oldPublished.set(definition.deviceId, value);
    }
  }
  service.setConnectionState('STOPPED');
  return { ...totals, minimumPowerGapMs, identities: service.deviceIds };
}

describe('fourteen simulated days of existing two-second observations', () => {
  it('reduces regular power events by exactly factor 30 for all five varying sources', () => {
    const result = simulate(false);
    expect(result).toMatchObject({ samples: 604_801, previousPower: 3_024_000, power: 100_800,
      controllerPower: 60_480, maintenance: 0, statuses: 1, minimumPowerGapMs: 60_000 });
    expect(result.previousPower / result.power).toBe(30);
    expect(result.identities).toEqual(['controller-grid', 'controller-home', 'controller-solar', 'charger-garage', 'charger-links']);
    console.info('14-day stable publishing:', JSON.stringify(result));
  }, 60_000);

  it('does not replay outage windows or burst after a one-minute HCU reconnect', () => {
    const result = simulate(true);
    expect(result.samples).toBe(604_801);
    expect(result.power).toBe(100_784);
    expect(result.controllerPower).toBe(60_468);
    expect(result.previousPower).toBe(3_023_910);
    expect(result.maintenance).toBe(6); // Three controller channels down, then up.
    expect(result.statuses).toBe(2); // Initial inclusion plus reconnect inclusion.
    expect(result.minimumPowerGapMs).toBeGreaterThanOrEqual(60_000);
    console.info('14-day interrupted publishing:', JSON.stringify(result));
  }, 60_000);
});
