import { describe, expect, it, vi } from 'vitest';
import { failure } from '../../../../src/domain/errors.js';
import { decodeHcuMessage } from '../../../../src/hcu/message-codec.js';
import type { HcuEnvelope, IncomingHcuMessage } from '../../../../src/hcu/message-types.js';
import { PLUGIN_ID } from '../../../../src/hcu/plugin-identity.js';
import { PluginDeviceService } from '../../../../src/hcu/devices/plugin-device-service.js';
import type { PluginDevice } from '../../../../src/hcu/devices/device-types.js';
import { allEnabledConfig, makeConfig } from '../../load-management/helpers.js';
import { telemetry } from './helpers.js';

function incoming(type: string, body: Readonly<Record<string, unknown>> = {}, id = 'hcu-request'): IncomingHcuMessage {
  const result = decodeHcuMessage({ pluginId: PLUGIN_ID, id, type, body });
  if (!result.ok || result.value.kind !== 'known') throw new Error('Invalid test message');
  return result.value.message;
}

function setup() {
  const clock = { now: 0 };
  const sent: HcuEnvelope[] = [];
  const state = { refuses: false, throws: false };
  const send = vi.fn((message: HcuEnvelope): boolean => {
    if (state.throws) throw new Error('Private socket payload');
    if (state.refuses) return false;
    sent.push(structuredClone(message)); return true;
  });
  let sequence = 0;
  const service = new PluginDeviceService({ config: makeConfig(), sender: { pluginId: PLUGIN_ID, send },
    idProvider: { nextId: () => `device-event-${++sequence}` }, now: () => clock.now });
  const ofType = (type: string) => sent.filter(message => message.type === type);
  const include = (ids = ['charger-garage']) => {
    service.setConnectionState('CONNECTED'); service.observe(telemetry());
    service.handle(incoming('INCLUSION_EVENT', { deviceIds: ids }, 'inclusion-event'));
  };
  const sample = (at: number, report = telemetry()) => {
    clock.now = at; service.observe(report, { sampledAtMs: at, receivedAtMs: at });
  };
  const minute = (start: number, report = telemetry()) => {
    for (let at = start + 2_000; at <= start + 60_000; at += 2_000) sample(at, report);
  };
  const powerEvents = () => ofType('STATUS_EVENT').filter(message =>
    (message.body?.['features'] as readonly { type: string }[]).some(feature => feature.type === 'currentPower'));
  return { service, sent, send, state, ofType, include, clock, sample, minute, powerEvents };
}

function devices(message: HcuEnvelope | undefined): readonly PluginDevice[] {
  return (message?.body?.['devices'] ?? []) as readonly PluginDevice[];
}

describe('Connect API sensor device lifecycle and bounded publication', () => {
  it('discovers exactly the configured five devices before any poll or inclusion', () => {
    const c = setup();
    expect(c.service.handle(incoming('DISCOVER_REQUEST'))).toBe(true);
    const response = c.ofType('DISCOVER_RESPONSE')[0];
    expect(response?.id).toBe('hcu-request');
    expect(response?.body?.['success']).toBe(true);
    expect(devices(response).map(device => device.deviceId)).toEqual(c.service.deviceIds);
    for (const device of devices(response)) expect(device.features).toEqual([{ type: 'currentPower' }, { type: 'maintenance' }]);
    expect(c.ofType('STATUS_EVENT')).toHaveLength(0);
  });

  it('keeps configured offline devices discoverable and exposes Rechts only after valid activation', () => {
    const c = setup();
    c.service.observe({ ...telemetry(), controller: failure('ConnectionError', 'Offline') });
    c.service.handle(incoming('DISCOVER_REQUEST'));
    expect(devices(c.sent.at(-1))).toHaveLength(5);
    c.service.configure(allEnabledConfig());
    c.service.handle(incoming('DISCOVER_REQUEST'));
    expect(devices(c.sent.at(-1)).at(-1)?.deviceId).toBe('charger-rechts');
  });

  it('treats Inclusion as a complete bounded set and uses a fresh ID for proactive full status', () => {
    const c = setup();
    c.include(['controller-grid', 'charger-garage', 'foreign-id']);
    expect(c.service.includedDeviceIds).toEqual(['controller-grid', 'charger-garage']);
    const first = c.ofType('STATUS_RESPONSE')[0];
    expect(first?.id).not.toBe('inclusion-event');
    expect(devices(first).map(device => device.deviceId)).toEqual(['controller-grid', 'charger-garage']);
    c.service.handle(incoming('INCLUSION_EVENT', { deviceIds: ['charger-links'] }));
    expect(c.service.includedDeviceIds).toEqual(['charger-links']);
    c.service.observe(telemetry(makeConfig(), 2000));
    expect(c.ofType('STATUS_EVENT')).toHaveLength(0);
  });

  it('responds to all/subset/empty/unknown explicit StatusRequests with the request ID', () => {
    const c = setup();
    c.service.observe(telemetry());
    c.service.handle(incoming('STATUS_REQUEST', {}, 'all'));
    expect(devices(c.sent.at(-1))).toHaveLength(5);
    expect(c.sent.at(-1)?.id).toBe('all');
    c.service.handle(incoming('STATUS_REQUEST', { deviceIds: ['controller-grid', 'charger-garage', 'unknown'] }, 'subset'));
    expect(devices(c.sent.at(-1)).map(device => device.deviceId)).toEqual(['controller-grid', 'charger-garage']);
    expect(c.sent.at(-1)?.id).toBe('subset');
    c.service.handle(incoming('STATUS_REQUEST', { deviceIds: [] }));
    expect(devices(c.sent.at(-1))).toEqual([]);
    c.service.handle(incoming('STATUS_REQUEST', { deviceIds: ['charger-rechts'] }));
    expect(devices(c.sent.at(-1))).toEqual([]);
  });

  it('deduplicates completed rounded means, never each changed raw sample', () => {
    const c = setup(); c.include();
    for (let at = 2000; at < 60_000; at += 2000) c.sample(at, telemetry(makeConfig(), 1000.2));
    expect(c.ofType('STATUS_EVENT')).toHaveLength(0);
    c.sample(60_000, telemetry(makeConfig(), 1000.49));
    expect(c.ofType('STATUS_EVENT')[0]?.body).toEqual({ deviceId: 'charger-garage', features: [{ type: 'currentPower', currentPower: 1000 }] });
    c.minute(60_000, telemetry(makeConfig(), 1000.2));
    expect(c.ofType('STATUS_EVENT')).toHaveLength(1);
    c.minute(120_000, telemetry(makeConfig(), 1001));
    expect(c.ofType('STATUS_EVENT')).toHaveLength(2);
    expect(c.ofType('STATUS_EVENT')[0]?.id).not.toBe(c.ofType('STATUS_EVENT')[1]?.id);
  });

  it('does not turn missing power into zero, but later publishes a real zero', () => {
    const c = setup(); c.include();
    c.minute(0, telemetry(makeConfig(), null));
    expect(c.ofType('STATUS_EVENT')).toHaveLength(0);
    c.service.handle(incoming('STATUS_REQUEST', { deviceIds: ['charger-garage'] }));
    expect(devices(c.sent.at(-1))[0]?.features).toEqual([{ type: 'currentPower' }, { type: 'maintenance', unreach: false }]);
    expect(JSON.stringify(c.sent.at(-1))).not.toContain('currentPower":0');
    c.sample(62_000, telemetry(makeConfig(), 0));
    c.minute(62_000, telemetry(makeConfig(), 0));
    expect(c.ofType('STATUS_EVENT').at(-1)?.body).toEqual({ deviceId: 'charger-garage', features: [{ type: 'currentPower', currentPower: 0 }] });
  });

  it('publishes failure and recovery Maintenance immediately without attaching raw power', () => {
    const c = setup(); c.include(['controller-grid', 'controller-home', 'controller-solar']);
    c.sample(2000, { ...telemetry(), controller: failure('TimeoutError', 'Offline') });
    expect(c.ofType('STATUS_EVENT')).toHaveLength(3);
    for (const message of c.ofType('STATUS_EVENT')) expect(message.body?.['features']).toEqual([{ type: 'maintenance', unreach: true }]);
    c.sample(4000);
    for (const message of c.ofType('STATUS_EVENT').slice(3)) expect(message.body?.['features']).toEqual([{ type: 'maintenance', unreach: false }]);
    c.sample(6000, { ...telemetry(), controller: failure('ConnectionError', 'Offline again') });
    const changed = telemetry();
    if (!changed.controller.ok) throw new Error('Expected fixture controller');
    c.sample(8000, { ...changed, controller: { ok: true, value: { ...changed.controller.value, gridPowerW: -500, gridImportW: 0 } } });
    expect(c.ofType('STATUS_EVENT').findLast(message => message.body?.['deviceId'] === 'controller-grid')?.body?.['features']).toEqual([
      { type: 'maintenance', unreach: false },
    ]);
    expect(c.powerEvents()).toHaveLength(0);
  });

  it('excludes only logical devices and never publishes them again unless reincluded', () => {
    const c = setup(); c.include(['charger-garage', 'charger-links']);
    c.service.handle(incoming('EXCLUSION_EVENT', { deviceIds: ['charger-garage', 'foreign'] }));
    c.service.observe(telemetry(makeConfig(), 2000));
    expect(c.ofType('STATUS_EVENT')).toHaveLength(0);
    expect(c.service.includedDeviceIds).toEqual(['charger-links']);
    c.service.handle(incoming('INCLUSION_EVENT', { deviceIds: ['charger-garage'] }));
    expect(devices(c.ofType('STATUS_RESPONSE').at(-1))[0]?.features[0]).toEqual({ type: 'currentPower' });
    c.minute(0, telemetry(makeConfig(), 2000));
    expect(c.powerEvents()).toHaveLength(1);
    expect(c.powerEvents()[0]?.body?.['deviceId']).toBe('charger-garage');
  });

  it('discards inclusion on disconnect and waits for fresh Inclusion after reconnect', () => {
    const c = setup(); c.include();
    c.service.setConnectionState('RECONNECTING');
    for (let index = 0; index < 1000; index++) c.service.observe(telemetry(makeConfig(), index));
    expect(c.service.inclusionKnown).toBe(false);
    expect(c.service.includedDeviceIds).toEqual([]);
    c.service.setConnectionState('CONNECTED'); c.service.setConnectionState('READY');
    c.service.observe(telemetry(makeConfig(), 2000));
    expect(c.ofType('STATUS_EVENT')).toHaveLength(0);
    c.service.handle(incoming('STATUS_REQUEST', { deviceIds: ['charger-garage'] }, 'explicit'));
    expect(devices(c.sent.at(-1))[0]?.features[0]).toEqual({ type: 'currentPower' });
    expect(c.service.inclusionKnown).toBe(false);
    c.service.handle(incoming('INCLUSION_EVENT', { deviceIds: ['charger-garage'] }));
    c.service.observe(telemetry(makeConfig(), 3000));
    expect(c.powerEvents()).toHaveLength(0);
    c.minute(0, telemetry(makeConfig(), 3000));
    expect(c.powerEvents()).toHaveLength(1);
  });

  it.each(['controller-grid', 'controller-home', 'controller-solar', 'charger-garage', 'charger-links', 'charger-rechts'])('rejects control for %s without any hardware boundary', (deviceId) => {
    const c = setup();
    c.service.handle(incoming('CONTROL_REQUEST', { deviceId, features: [{ type: 'currentPower', currentPower: 10000 }] }, 'control'));
    expect(c.sent).toEqual([{ id: 'control', pluginId: PLUGIN_ID, type: 'CONTROL_RESPONSE', body: {
      deviceId, success: false, error: { code: deviceId === 'charger-rechts' ? 'UNKNOWN_DEVICE' : 'READ_ONLY_DEVICE' },
    } }]);
  });

  it('contains publisher throws and retries unsent Maintenance, without replaying power windows', () => {
    const c = setup(); c.include(['charger-garage', 'charger-links']);
    c.state.throws = true;
    const offline = { ...telemetry(), chargers: telemetry().chargers.map(charger => charger.config.id !== 'garage' ? charger : {
      status: 'unavailable' as const, reachable: false as const, config: charger.config, error: { code: 'TimeoutError' as const, message: 'Offline' },
    }) };
    expect(() => c.sample(2000, offline)).not.toThrow();
    expect(c.service.lastPublishError).toBe('HCU_DEVICE_PUBLISH_FAILED');
    c.state.throws = false;
    c.sample(4000, offline);
    expect(c.ofType('STATUS_EVENT')).toHaveLength(1);
    expect(c.service.lastPublishError).toBe(null);
    c.sample(6000, offline);
    expect(c.ofType('STATUS_EVENT')).toHaveLength(1);
  });

  it('continues other included devices after one device send fails', () => {
    const c = setup(); c.include(['controller-grid', 'controller-home', 'controller-solar']);
    c.send.mockImplementation(message => {
      if (message.body?.['deviceId'] === 'controller-grid') throw new Error('Socket failure');
      c.sent.push(structuredClone(message)); return true;
    });
    c.service.observe({ ...telemetry(), controller: failure('ConnectionError', 'Offline') });
    expect(c.ofType('STATUS_EVENT').map(message => message.body?.['deviceId'])).toEqual(['controller-home', 'controller-solar']);
  });

  it('clears disabled identities, keeps stable ID for renamed host and sends current metadata on request', () => {
    const c = setup(); c.include(['charger-garage', 'charger-links']);
    const next = { ...makeConfig(), chargers: makeConfig().chargers.map(charger => charger.id === 'links' ? { ...charger, enabled: false }
      : charger.id === 'garage' ? { ...charger, name: 'Renamed', host: 'replacement.test' } : charger) };
    c.service.configure(next);
    expect(c.service.includedDeviceIds).toEqual(['charger-garage']);
    c.service.handle(incoming('STATUS_REQUEST'));
    const garage = devices(c.sent.at(-1)).find(device => device.deviceId === 'charger-garage');
    expect(garage?.friendlyName).toBe('Renamed');
    expect(garage?.features).toEqual([{ type: 'currentPower' }, { type: 'maintenance' }]);
    expect(devices(c.sent.at(-1))).toHaveLength(4);
  });

  it('ignores foreign plugin messages and preserves READY inclusion during state refinement', () => {
    const c = setup(); c.include();
    expect(c.service.handle({ ...incoming('DISCOVER_REQUEST'), pluginId: 'foreign' })).toBe(false);
    c.service.setConnectionState('READY');
    expect(c.service.includedDeviceIds).toEqual(['charger-garage']);
    c.service.setConnectionState('STOPPED');
    c.service.observe(telemetry(makeConfig(), 2000));
    expect(c.ofType('STATUS_EVENT')).toHaveLength(0);
  });
});
