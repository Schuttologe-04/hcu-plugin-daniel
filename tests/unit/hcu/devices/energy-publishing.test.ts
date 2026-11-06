import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../../src/config/config-types.js';
import type { ProbeReport } from '../../../../src/diagnostics/probe-service.js';
import { failure, success } from '../../../../src/domain/errors.js';
import { decodeHcuMessage } from '../../../../src/hcu/message-codec.js';
import type { HcuEnvelope, IncomingHcuMessage } from '../../../../src/hcu/message-types.js';
import { PLUGIN_ID } from '../../../../src/hcu/plugin-identity.js';
import { PluginDeviceService, type DeviceObservationTiming } from '../../../../src/hcu/devices/plugin-device-service.js';
import { makeConfig } from '../../load-management/helpers.js';
import { telemetry } from './helpers.js';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function incoming(type: string, body: Readonly<Record<string, unknown>>, id: string): IncomingHcuMessage {
  const decoded = decodeHcuMessage({ pluginId: PLUGIN_ID, id, type, body });
  if (!decoded.ok || decoded.value.kind !== 'known') throw new Error('Invalid offline device request');
  return decoded.value.message;
}

function features(message: HcuEnvelope): readonly Record<string, unknown>[] {
  const value = message.body?.['features'];
  if (!Array.isArray(value)) return [];
  return value.filter(record);
}

function devices(message: HcuEnvelope | undefined): readonly Record<string, unknown>[] {
  const value = message?.body?.['devices'];
  if (!Array.isArray(value)) throw new Error('Expected complete offline device response');
  return value.filter(record);
}

function feature(device: Record<string, unknown> | undefined, type: string): Record<string, unknown> | undefined {
  const values = device?.['features'];
  return Array.isArray(values) ? values.filter(record).find(value => value['type'] === type) : undefined;
}

function devicePower(device: Record<string, unknown> | undefined): unknown { return feature(device, 'currentPower')?.['currentPower']; }
function deviceUnreach(device: Record<string, unknown> | undefined): unknown { return feature(device, 'maintenance')?.['unreach']; }

interface Powers {
  readonly gridW?: number;
  readonly homeW?: number | null;
  readonly solarW?: number | null;
  readonly chargerW?: Readonly<Record<string, number | null>>;
}

function reading(config: AppConfig = makeConfig(), powers: Powers = {}): ProbeReport {
  const report = telemetry(config);
  if (!report.controller.ok) throw new Error('Expected successful offline controller fixture');
  const gridPowerW = powers.gridW ?? report.controller.value.gridPowerW;
  return {
    controller: success({ ...report.controller.value, host: config.controller.host, gridPowerW,
      gridImportW: Math.max(gridPowerW, 0),
      homePowerW: Object.hasOwn(powers, 'homeW') ? powers.homeW ?? null : report.controller.value.homePowerW ?? null,
      solarPowerW: Object.hasOwn(powers, 'solarW') ? powers.solarW ?? null : report.controller.value.solarPowerW ?? null }),
    chargers: report.chargers.map(charger => charger.status !== 'reachable' ? charger : {
      ...charger, value: { ...charger.value, currentPowerW: powers.chargerW !== undefined && Object.hasOwn(powers.chargerW, charger.config.id)
        ? powers.chargerW[charger.config.id] ?? null : charger.value.currentPowerW ?? null },
    }),
  };
}

function setup(config = makeConfig()) {
  const clock = { now: 0 };
  const sent: HcuEnvelope[] = [];
  const refusedPowerIds = new Set<string>();
  const send = vi.fn((message: HcuEnvelope): boolean => {
    if (message.type === 'STATUS_EVENT' && features(message).some(item => typeof item['currentPower'] === 'number')
      && typeof message.body?.['deviceId'] === 'string' && refusedPowerIds.has(message.body['deviceId'])) return false;
    sent.push(structuredClone(message));
    return true;
  });
  let sequence = 0;
  const service = new PluginDeviceService({ config, now: () => clock.now,
    sender: { pluginId: PLUGIN_ID, send }, idProvider: { nextId: () => `offline-energy-${++sequence}` } });
  service.setConnectionState('CONNECTED');
  const request = (type: string, body: Readonly<Record<string, unknown>> = {}, id = `request-${++sequence}`) => {
    expect(service.handle(incoming(type, body, id))).toBe(true);
    return sent.at(-1);
  };
  const include = (ids: readonly string[] = service.deviceIds) => request('INCLUSION_EVENT', { deviceIds: ids });
  const sample = (atMs: number, report = reading(config), timing: DeviceObservationTiming = { sampledAtMs: atMs, receivedAtMs: atMs }) => {
    clock.now = atMs;
    service.observe(report, timing);
  };
  const range = (fromMs: number, throughMs: number, reportAt: (atMs: number) => ProbeReport = () => reading(config)) => {
    for (let atMs = fromMs; atMs <= throughMs; atMs += 2_000) sample(atMs, reportAt(atMs));
  };
  const events = () => sent.filter(message => message.type === 'STATUS_EVENT');
  const powerEvents = () => events().filter(message => features(message).some(item => typeof item['currentPower'] === 'number'));
  const latest = (id: string, response = request('STATUS_REQUEST', { deviceIds: [id] })) => devices(response).find(device => device['deviceId'] === id);
  return { clock, service, sent, send, refusedPowerIds, request, include, sample, range, events, powerEvents, latest };
}

describe('60-second energy publication across every HCU device entry point', () => {
  it('keeps fractional raw power until the final rounded minute mean', () => {
    const c = setup(); c.include(['charger-garage']);
    c.range(0, 60_000, atMs => reading(makeConfig(), { chargerW: { garage: atMs < 40_000 ? 0.49 : 1.49 } }));
    expect(c.powerEvents()).toHaveLength(1);
    expect(c.powerEvents()[0]?.body).toEqual({ deviceId: 'charger-garage', features: [{ type: 'currentPower', currentPower: 1 }] });
    expect(devicePower(c.latest('charger-garage'))).toBe(1);
  });

  it('preserves signed grid, raw Home and inverted Solar throughout the mean', () => {
    const c = setup(); c.include();
    c.range(0, 60_000, atMs => reading(makeConfig(), { gridW: atMs < 30_000 ? -3_000 : 1_000,
      homeW: -700, solarW: atMs < 30_000 ? -2_000 : 1_000, chargerW: { garage: 0 } }));
    const response = c.request('STATUS_REQUEST', {}, 'signed-minute');
    expect(response?.id).toBe('signed-minute');
    expect(devicePower(c.latest('controller-grid', response))).toBe(-1_000);
    expect(devicePower(c.latest('controller-home', response))).toBe(-700);
    expect(devicePower(c.latest('controller-solar', response))).toBe(500);
    expect(devicePower(c.latest('charger-garage', response))).toBe(0);
    expect(c.powerEvents()).toHaveLength(5);
  });

  it('never manufactures coverage from repeated Status, Discovery or Inclusion requests', () => {
    const c = setup(); c.include(); c.sample(0);
    for (let atMs = 1_000; atMs < 60_000; atMs += 1_000) {
      c.clock.now = atMs;
      for (const type of ['STATUS_REQUEST', 'DISCOVER_REQUEST', 'INCLUSION_EVENT']) {
        const response = c.request(type, type === 'INCLUSION_EVENT' ? { deviceIds: c.service.deviceIds } : {}, `${type}-${atMs}`);
        if (type !== 'INCLUSION_EVENT') expect(response?.id).toBe(`${type}-${atMs}`);
        for (const device of devices(response)) expect(devicePower(device)).toBeUndefined();
      }
    }
    c.sample(60_000);
    expect(c.powerEvents()).toHaveLength(0);
    expect(devicePower(c.latest('controller-grid'))).toBeUndefined();
  });

  it('answers all request paths with the last valid completed mean, never the new live value', () => {
    const c = setup(); c.include();
    c.range(0, 60_000, atMs => reading(makeConfig(), { chargerW: { garage: atMs === 60_000 ? 9_000 : 1_000 } }));
    c.sample(62_000, reading(makeConfig(), { chargerW: { garage: 12_000 } }));
    const eventsBefore = c.events().length;
    for (const type of ['STATUS_REQUEST', 'DISCOVER_REQUEST', 'INCLUSION_EVENT']) {
      const response = c.request(type, type === 'INCLUSION_EVENT' ? { deviceIds: c.service.deviceIds } : {}, `cached-${type}`);
      expect(devicePower(c.latest('charger-garage', response))).toBe(1_000);
      if (type !== 'INCLUSION_EVENT') expect(response?.id).toBe(`cached-${type}`);
    }
    expect(c.events()).toHaveLength(eventsBefore);
  });

  it('does not renew cached source freshness through HCU requests', () => {
    const c = setup(); c.include(); c.range(0, 60_000);
    c.clock.now = 64_000;
    expect(devicePower(c.latest('controller-grid'))).toBe(4_995);
    c.clock.now = 64_001;
    const stale = c.latest('controller-grid');
    expect(devicePower(stale)).toBeUndefined();
    expect(deviceUnreach(stale)).toBeUndefined();
    expect(c.powerEvents()).toHaveLength(5);
  });

  it('reports a connection loss and recovery immediately with Maintenance only, then earns a fresh minute', () => {
    const c = setup(); c.include(); c.range(0, 60_000);
    const before = c.events().length;
    c.sample(62_000, { ...reading(), controller: failure('ConnectionError', 'Controlled offline controller') });
    expect(c.events().slice(before)).toHaveLength(3);
    for (const event of c.events().slice(before)) expect(event.body?.['features']).toEqual([{ type: 'maintenance', unreach: true }]);
    const afterFailure = c.events().length;
    c.sample(80_000, reading(makeConfig(), { gridW: 8_000 }));
    for (const event of c.events().slice(afterFailure)) expect(event.body?.['features']).toEqual([{ type: 'maintenance', unreach: false }]);
    expect(devicePower(c.latest('controller-grid'))).toBeUndefined();
    const powersBeforeRecoveryMinute = c.powerEvents().length;
    c.range(82_000, 138_000, () => reading(makeConfig(), { gridW: 8_000 }));
    expect(c.powerEvents()).toHaveLength(powersBeforeRecoveryMinute);
    c.sample(140_000, reading(makeConfig(), { gridW: 8_000 }));
    expect(c.powerEvents().slice(powersBeforeRecoveryMinute).map(event => event.body?.['deviceId']))
      .toEqual(['controller-grid', 'controller-home', 'controller-solar']);
    expect(devicePower(c.latest('controller-grid'))).toBe(8_000);
  });

  it('does not suppress negative reachability evidence from a timeout longer than four seconds', () => {
    const c = setup(); c.include(); c.range(0, 60_000);
    const before = c.events().length;
    c.sample(67_000, { ...reading(), controller: failure('TimeoutError', 'Controlled slow timeout') },
      { sampledAtMs: 62_000, receivedAtMs: 67_000 });
    expect(c.events().slice(before)).toHaveLength(3);
    for (const event of c.events().slice(before)) expect(event.body?.['features']).toEqual([{ type: 'maintenance', unreach: true }]);
    c.clock.now = 70_000;
    const offline = c.latest('controller-grid');
    expect(devicePower(offline)).toBeUndefined();
    expect(deviceUnreach(offline)).toBe(true);
  });

  it.each([
    { name: 'already stale', nowMs: 67_000, sampledAtMs: 62_000, receivedAtMs: 67_000 },
    { name: 'future sample', nowMs: 68_000, sampledAtMs: 70_000, receivedAtMs: 68_000 },
    { name: 'future receipt', nowMs: 62_000, sampledAtMs: 62_000, receivedAtMs: 63_000 },
    { name: 'retrograde receipt', nowMs: 62_000, sampledAtMs: 62_000, receivedAtMs: 61_000 },
  ])('omits power for $name timing rather than exposing cached or live watts', timing => {
    const c = setup(); c.include(); c.range(0, 60_000);
    const before = c.powerEvents().length;
    c.sample(timing.nowMs, reading(makeConfig(), { gridW: 19_000 }), timing);
    expect(devicePower(c.latest('controller-grid'))).toBeUndefined();
    expect(c.powerEvents()).toHaveLength(before);
  });

  it('does not extend validity when a reconfiguration callback republishes the same old snapshot', () => {
    const c = setup(); c.include(); c.range(0, 60_000);
    const old = reading();
    for (let nowMs = 62_000; nowMs < 120_000; nowMs += 2_000) {
      c.sample(nowMs, old, { sampledAtMs: 60_000, receivedAtMs: 60_000 });
    }
    c.sample(120_000);
    expect(c.powerEvents()).toHaveLength(5);
    expect(devicePower(c.latest('controller-grid'))).toBeUndefined();
  });

  it.each([{ validFromMs: 6_000, expected: 1_234 }, { validFromMs: 8_000, expected: undefined }])(
    'requires independent 54-second Home coverage with first valid Home at $validFromMs', ({ validFromMs, expected }) => {
      const c = setup(); c.include();
      c.range(0, 60_000, atMs => reading(makeConfig(), { homeW: atMs < validFromMs ? null : 1_234 }));
      const response = c.request('STATUS_REQUEST');
      expect(devicePower(c.latest('controller-home', response))).toBe(expected);
      expect(devicePower(c.latest('controller-grid', response))).toBe(4_995);
      expect(devicePower(c.latest('controller-solar', response))).toBe(9);
      expect(devicePower(c.latest('charger-garage', response))).toBe(1_000);
      expect(c.powerEvents()).toHaveLength(expected === undefined ? 4 : 5);
    },
  );

  it.each([null, NaN, Infinity, -Infinity])('invalid Home %s discards its old mean without invalidating fresh Grid', invalidHomeW => {
    const c = setup(); c.include(); c.range(0, 60_000);
    c.sample(62_000, reading(makeConfig(), { homeW: invalidHomeW }));
    const response = c.request('STATUS_REQUEST');
    expect(devicePower(c.latest('controller-home', response))).toBeUndefined();
    expect(deviceUnreach(c.latest('controller-home', response))).toBe(false);
    expect(devicePower(c.latest('controller-grid', response))).toBe(4_995);
    c.sample(64_000);
    expect(devicePower(c.latest('controller-home'))).toBeUndefined();
  });

  it('deduplicates unchanged rounded completed means across multiple windows', () => {
    const c = setup(); c.include(['charger-garage']);
    c.range(0, 60_000, () => reading(makeConfig(), { chargerW: { garage: 1_000.2 } }));
    c.range(62_000, 120_000, () => reading(makeConfig(), { chargerW: { garage: 1_000.49 } }));
    expect(c.powerEvents()).toHaveLength(1);
    c.range(122_000, 180_000, () => reading(makeConfig(), { chargerW: { garage: 1_001.4 } }));
    expect(c.powerEvents()).toHaveLength(2);
    expect(c.powerEvents().map(event => features(event)[0]?.['currentPower'])).toEqual([1_000, 1_001]);
  });

  it('contains one failed power send and never retries that window on fast polls', () => {
    const c = setup(); c.include(); c.refusedPowerIds.add('charger-garage');
    c.range(0, 60_000);
    const garageAttempts = () => c.send.mock.calls.filter(([message]) => message.type === 'STATUS_EVENT'
      && message.body?.['deviceId'] === 'charger-garage' && features(message).some(item => typeof item['currentPower'] === 'number'));
    expect(garageAttempts()).toHaveLength(1);
    expect(c.powerEvents().map(event => event.body?.['deviceId']))
      .toEqual(['controller-grid', 'controller-home', 'controller-solar', 'charger-links']);
    c.refusedPowerIds.clear();
    c.range(62_000, 118_000);
    expect(garageAttempts()).toHaveLength(1);
    c.sample(120_000);
    expect(garageAttempts()).toHaveLength(2);
    expect(c.powerEvents()).toHaveLength(5);
    expect(devicePower(c.latest('charger-garage'))).toBe(1_000);
  });

  it('preserves means when labels change, but resets only the rebound physical source', () => {
    const initial = makeConfig();
    const c = setup(initial); c.include(); c.range(0, 60_000);
    const renamed = { ...initial, chargers: initial.chargers.map(charger => charger.id === 'garage' ? { ...charger, name: 'New display name' } : charger) };
    c.service.configure(renamed);
    expect(c.latest('charger-garage')?.['friendlyName']).toBe('New display name');
    expect(devicePower(c.latest('charger-garage'))).toBe(1_000);
    const rebound = { ...renamed, chargers: renamed.chargers.map(charger => charger.id === 'garage' ? { ...charger, host: 'replacement.test' } : charger) };
    c.service.configure(rebound);
    expect(c.service.deviceIds).toEqual(['controller-grid', 'controller-home', 'controller-solar', 'charger-garage', 'charger-links']);
    expect(devicePower(c.latest('charger-garage'))).toBeUndefined();
    expect(deviceUnreach(c.latest('charger-garage'))).toBeUndefined();
    expect(devicePower(c.latest('charger-links'))).toBe(0);
    expect(devicePower(c.latest('controller-grid'))).toBe(4_995);
    c.range(62_000, 120_000, () => reading(rebound, { chargerW: { garage: 2_000 } }));
    expect(devicePower(c.latest('charger-garage'))).toBeUndefined();
    c.sample(122_000, reading(rebound, { chargerW: { garage: 2_000 } }));
    expect(devicePower(c.latest('charger-garage'))).toBe(2_000);
  });

  it('resets the three controller series on a controller host change, without losing charger means', () => {
    const initial = makeConfig();
    const c = setup(initial); c.include(); c.range(0, 60_000);
    c.service.configure({ ...initial, controller: { host: 'new-controller.test' } });
    const response = c.request('STATUS_REQUEST');
    for (const id of ['controller-grid', 'controller-home', 'controller-solar']) expect(devicePower(c.latest(id, response))).toBeUndefined();
    expect(devicePower(c.latest('charger-garage', response))).toBe(1_000);
    expect(devicePower(c.latest('charger-links', response))).toBe(0);
  });

  it('supports arbitrary configured charger identities and removes disabled devices without publishing them', () => {
    const config = makeConfig({ chargers: [
      { id: 'carport-west', name: 'Carport West', host: 'carport.test', enabled: true, priority: 10 },
      { id: 'future-charger', name: 'Future', host: '', enabled: false, priority: 20 },
    ] });
    const c = setup(config); c.include();
    c.range(0, 60_000, () => reading(config, { chargerW: { 'carport-west': 4_321 } }));
    expect(c.service.deviceIds).toEqual(['controller-grid', 'controller-home', 'controller-solar', 'charger-carport-west']);
    expect(devicePower(c.latest('charger-carport-west'))).toBe(4_321);
    c.service.configure({ ...config, chargers: config.chargers.map(charger => ({ ...charger, enabled: false })) });
    expect(c.service.includedDeviceIds).not.toContain('charger-carport-west');
    expect(c.service.deviceIds).toEqual(['controller-grid', 'controller-home', 'controller-solar']);
    const response = c.request('STATUS_REQUEST', { deviceIds: ['charger-carport-west', 'charger-future-charger'] });
    expect(devices(response)).toEqual([]);
    const count = c.events().length;
    c.range(62_000, 122_000, () => reading(config));
    expect(c.events().slice(count).some(event => event.body?.['deviceId'] === 'charger-carport-west')).toBe(false);
  });

  it('starts a new warmup after reconnect without a burst of old power windows', () => {
    const c = setup(); c.include(); c.range(0, 60_000);
    const before = c.powerEvents().length;
    c.service.setConnectionState('RECONNECTING');
    const nextStart = 2 * 24 * 60 * 60_000;
    c.sample(nextStart - 2_000, reading(makeConfig(), { gridW: 15_000 }));
    c.service.setConnectionState('CONNECTED'); c.service.setConnectionState('READY');
    c.include();
    expect(devicePower(c.latest('controller-grid'))).toBeUndefined();
    c.range(nextStart, nextStart + 58_000, () => reading(makeConfig(), { gridW: 15_000 }));
    expect(c.powerEvents()).toHaveLength(before);
    c.sample(nextStart + 60_000, reading(makeConfig(), { gridW: 15_000 }));
    expect(c.powerEvents()).toHaveLength(before + 5);
    expect(devicePower(c.latest('controller-grid'))).toBe(15_000);
  });

  it('adds no timers while receiving samples and serving protocol requests', () => {
    vi.useFakeTimers();
    try {
      const c = setup(); c.include();
      const before = vi.getTimerCount();
      c.range(0, 180_000);
      for (let index = 0; index < 100; index += 1) c.request('STATUS_REQUEST');
      c.service.setConnectionState('STOPPED');
      expect(vi.getTimerCount()).toBe(before);
    } finally { vi.useRealTimers(); }
  });
});
