import { describe, expect, it } from 'vitest';
import { decodeHcuMessage } from '../../../src/hcu/message-codec.js';

const base = { id: 'device-request', pluginId: 'plugin' };

function decode(type: string, body?: Readonly<Record<string, unknown>>) {
  return decodeHcuMessage({ ...base, type, ...(body === undefined ? {} : { body }) });
}

describe('Connect API device message codec', () => {
  it('accepts discovery with omitted or empty body and discards untrusted additions', () => {
    const expected = { ok: true, value: { kind: 'known', message: { ...base, type: 'DISCOVER_REQUEST', body: {} } } };
    expect(decode('DISCOVER_REQUEST')).toEqual(expected);
    expect(decode('DISCOVER_REQUEST', {})).toEqual(expected);
    expect(decode('DISCOVER_REQUEST', { authToken: 'never-forward-this' })).toEqual(expected);
  });

  it.each(['INCLUSION_EVENT', 'EXCLUSION_EVENT'])('validates and deduplicates %s opaque device IDs', (type) => {
    expect(decode(type, { deviceIds: ['controller-grid', 'charger-garage', 'controller-grid'], secret: 'discard' })).toEqual({
      ok: true, value: { kind: 'known', message: { ...base, type,
        body: { deviceIds: ['controller-grid', 'charger-garage'] } } },
    });
    expect(decode(type, { deviceIds: [] })).toMatchObject({ ok: true, value: { message: { body: { deviceIds: [] } } } });
  });

  it.each(['INCLUSION_EVENT', 'EXCLUSION_EVENT'])('requires the %s inclusion/exclusion snapshot field', (type) => {
    expect(decode(type)).toMatchObject({ ok: false, error: { code: 'InvalidResponseError' } });
    expect(decode(type, {})).toMatchObject({ ok: false });
  });

  it.each(['INCLUSION_EVENT', 'EXCLUSION_EVENT', 'STATUS_REQUEST'])('rejects malformed or excessive %s device ID collections', (type) => {
    for (const identifiers of [null, 'controller-grid', {}, [1], [''], [' '], [false],
      ['x'.repeat(257)], Array.from({ length: 257 }, (_, index) => `charger-${index}`)]) {
      expect(decode(type, { deviceIds: identifiers })).toMatchObject({ ok: false });
    }
  });

  it('preserves optional status-request selection and the original message ID', () => {
    expect(decode('STATUS_REQUEST')).toEqual({
      ok: true, value: { kind: 'known', message: { ...base, type: 'STATUS_REQUEST', body: {} } },
    });
    expect(decode('STATUS_REQUEST', { deviceIds: [], unrelated: true })).toEqual({
      ok: true, value: { kind: 'known', message: { ...base, type: 'STATUS_REQUEST', body: { deviceIds: [] } } },
    });
    expect(decode('STATUS_REQUEST', { deviceIds: ['controller-grid', 'controller-grid'] }))
      .toMatchObject({ ok: true, value: { message: { id: base.id, body: { deviceIds: ['controller-grid'] } } } });
  });

  it('validates control feature wire types and retains true, false, signed and zero measurements', () => {
    expect(decode('CONTROL_REQUEST', { deviceId: 'charger-garage', features: [
      { type: 'currentPower', currentPower: -500.25, unrelated: 'discard' },
      { type: 'maintenance', unreach: false, lowBat: true, sabotage: false, secret: 'discard' },
    ], amp: 32 })).toEqual({
      ok: true, value: { kind: 'known', message: { ...base, type: 'CONTROL_REQUEST', body: {
        deviceId: 'charger-garage', features: [
          { type: 'currentPower', currentPower: -500.25 },
          { type: 'maintenance', unreach: false, lowBat: true, sabotage: false },
        ],
      } } },
    });
    expect(decode('CONTROL_REQUEST', { deviceId: 'controller-grid', features: [{ type: 'currentPower', currentPower: 0 }] }))
      .toMatchObject({ ok: true, value: { message: { body: { features: [{ type: 'currentPower', currentPower: 0 }] } } } });
  });

  it('accepts omitted feature values according to the optional CurrentPower and Maintenance field tables', () => {
    expect(decode('CONTROL_REQUEST', { deviceId: 'controller-grid', features: [
      { type: 'currentPower' }, { type: 'maintenance' },
    ] })).toMatchObject({ ok: true, value: { message: { body: { features: [
      { type: 'currentPower' }, { type: 'maintenance' },
    ] } } } });
  });

  it('keeps future control feature discriminators so the read-only service can reject them safely', () => {
    expect(decode('CONTROL_REQUEST', { deviceId: 'charger-garage', features: [
      { type: 'switchState', on: true }, { type: 'futureFeature', nested: { authToken: 'discard' } },
    ] })).toEqual({
      ok: true, value: { kind: 'known', message: { ...base, type: 'CONTROL_REQUEST', body: {
        deviceId: 'charger-garage', features: [{ type: 'switchState' }, { type: 'futureFeature' }],
      } } },
    });
  });

  it.each([null, '0', true, NaN, Infinity, -Infinity])('rejects invalid CurrentPower target %s', (currentPower) => {
    expect(decode('CONTROL_REQUEST', { deviceId: 'charger-garage', features: [{ type: 'currentPower', currentPower }] }))
      .toMatchObject({ ok: false, error: { code: 'InvalidResponseError' } });
  });

  it.each(['unreach', 'lowBat', 'sabotage'])('rejects invalid Maintenance %s target values', (key) => {
    for (const value of [null, 'false', 0, [], {}]) {
      expect(decode('CONTROL_REQUEST', { deviceId: 'charger-garage', features: [{ type: 'maintenance', [key]: value }] }))
        .toMatchObject({ ok: false });
    }
  });

  it.each([{}, { deviceId: 'charger-garage' }, { deviceId: '', features: [] },
    { deviceId: false, features: [] }, { deviceId: 'x'.repeat(257), features: [] },
    { deviceId: 'charger-garage', features: null }, { deviceId: 'charger-garage', features: {} },
    { deviceId: 'charger-garage', features: [null] }, { deviceId: 'charger-garage', features: [[]] },
    { deviceId: 'charger-garage', features: [{}] }, { deviceId: 'charger-garage', features: [{ type: '' }] },
    { deviceId: 'charger-garage', features: [{ type: 1 }] },
    { deviceId: 'charger-garage', features: [{ type: 'x'.repeat(257) }] },
    { deviceId: 'charger-garage', features: [{ type: 'currentPower', currentPower: 1 }, { type: 'currentPower', currentPower: 2 }] },
    { deviceId: 'charger-garage', features: Array.from({ length: 129 }, (_, index) => ({ type: `future${index}` })) },
  ])('rejects malformed control body %#', (body) => {
    expect(decode('CONTROL_REQUEST', body)).toMatchObject({ ok: false });
  });

  it('accepts an empty control feature set for an explicit read-only failure response', () => {
    expect(decode('CONTROL_REQUEST', { deviceId: 'charger-garage', features: [] }))
      .toMatchObject({ ok: true, value: { message: { body: { features: [] } } } });
  });

  it('rejects malformed JSON and never exposes invalid payload contents', () => {
    expect(decodeHcuMessage('{"id":"device-request","pluginId":"plugin","type":"INCLUSION_EVENT","body":'))
      .toMatchObject({ ok: false });
    const result = decode('CONTROL_REQUEST', { deviceId: 'charger-garage', features: [
      { type: 'maintenance', unreach: 'never-forward-secret' },
    ] });
    expect(JSON.stringify(result)).not.toContain('never-forward-secret');
  });
});
