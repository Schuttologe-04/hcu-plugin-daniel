import { describe, expect, it } from 'vitest';
import { decodeHcuMessage, encodeHcuMessage } from '../../../src/hcu/message-codec.js';

const base = { id: 'correlation', pluginId: 'plugin' };

describe('Connect API message codec', () => {
  it('validates a JSON PluginMessage and normalizes its optional body', () => {
    expect(decodeHcuMessage(JSON.stringify({ ...base, type: 'PLUGIN_STATE_REQUEST' }))).toEqual({
      ok: true, value: { kind: 'known', message: { ...base, type: 'PLUGIN_STATE_REQUEST', body: {} } },
    });
  });

  it.each(['{', 'secret-auth-token', '', 'undefined'])('contains malformed JSON %s', (input) => {
    const result = decodeHcuMessage(input);
    expect(result).toMatchObject({ ok: false, error: { code: 'InvalidResponseError' } });
    expect(JSON.stringify(result)).not.toContain('secret-auth-token');
  });

  it.each([null, [], 1, true, {}, { id: 'id', type: 'PLUGIN_STATE_REQUEST' },
    { ...base, id: '' }, { ...base, pluginId: ' ' }, { ...base, type: 1 },
    { ...base, type: 'PLUGIN_STATE_REQUEST', body: null },
    { ...base, type: 'PLUGIN_STATE_REQUEST', body: [] },
  ])('rejects invalid envelopes %#', (input) => {
    expect(decodeHcuMessage(input)).toMatchObject({ ok: false });
  });

  it.each(['CONFIG_TEMPLATE_REQUEST', 'CONFIG_UPDATE_REQUEST'])('accepts an optional empty %s body', (type) => {
    expect(decodeHcuMessage({ ...base, type })).toMatchObject({ ok: true, value: { kind: 'known', message: { body: {} } } });
  });

  it('validates config update properties as an object and retains externally typed values as unknown', () => {
    expect(decodeHcuMessage({ ...base, type: 'CONFIG_UPDATE_REQUEST', body: { languageCode: 'de', properties: { grid: 19000, active: true } } }))
      .toMatchObject({ ok: true, value: { kind: 'known', message: { body: { languageCode: 'de', properties: { grid: 19000, active: true } } } } });
  });

  it.each([
    { type: 'CONFIG_TEMPLATE_REQUEST', body: { languageCode: 1 } },
    { type: 'CONFIG_UPDATE_REQUEST', body: { languageCode: false } },
    { type: 'CONFIG_UPDATE_REQUEST', body: { properties: null } },
    { type: 'CONFIG_UPDATE_REQUEST', body: { properties: [] } },
    { type: 'CONFIG_UPDATE_REQUEST', body: { properties: 'x' } },
  ])('rejects malformed config request %#', (request) => {
    expect(decodeHcuMessage({ ...base, ...request })).toMatchObject({ ok: false });
  });

  it.each(['YES', 'NO', 'OK'])('accepts documented acknowledgement %s', (ackType) => {
    expect(decodeHcuMessage({ ...base, type: 'USER_MESSAGE_ACK_EVENT', body: { ackType, userMessageId: 'message' } }))
      .toMatchObject({ ok: true, value: { kind: 'known', message: { body: { ackType, userMessageId: 'message' } } } });
  });

  it.each([{}, { ackType: 'YES' }, { ackType: 'yes', userMessageId: 'message' },
    { ackType: 'CANCEL', userMessageId: 'message' }, { ackType: 'YES', userMessageId: '' },
    { ackType: 'YES', userMessageId: 3 }])('rejects malformed acknowledgement %#', (body) => {
    expect(decodeHcuMessage({ ...base, type: 'USER_MESSAGE_ACK_EVENT', body })).toMatchObject({ ok: false });
  });

  it.each(['CREATE_USER_MESSAGE_RESPONSE', 'DELETE_USER_MESSAGE_RESPONSE'])('validates %s', (type) => {
    expect(decodeHcuMessage({ ...base, type, body: { success: true, userMessageId: 'message' } })).toMatchObject({ ok: true });
    expect(decodeHcuMessage({ ...base, type, body: { success: false, userMessageId: 'message', error: { code: 'ERROR' } } })).toMatchObject({ ok: true });
    expect(decodeHcuMessage({ ...base, type, body: { success: true } })).toMatchObject({ ok: false });
    expect(decodeHcuMessage({ ...base, type, body: { success: 'true', userMessageId: 'message' } })).toMatchObject({ ok: false });
    expect(decodeHcuMessage({ ...base, type, body: { success: false, userMessageId: 'message', error: { code: 1 } } })).toMatchObject({ ok: false });
  });

  it('follows the list field table Map<String, Long> rather than the erroneous string example', () => {
    const result = decodeHcuMessage({ ...base, type: 'LIST_USER_MESSAGES_RESPONSE', body: { userMessageMap: { a: 1720034123, b: 1720034124 } } });
    expect(result).toMatchObject({ ok: true, value: { kind: 'known', message: { body: { userMessageMap: { a: 1720034123, b: 1720034124 } } } } });
    expect(decodeHcuMessage({ ...base, type: 'LIST_USER_MESSAGES_RESPONSE', body: { userMessageMap: 'a' } })).toMatchObject({ ok: false });
  });

  it.each([null, [], { a: '123' }, { a: 1.5 }, { a: Infinity }, { a: Number.MAX_SAFE_INTEGER + 1 }, { '': 1 }])('rejects invalid list map %#', (userMessageMap) => {
    expect(decodeHcuMessage({ ...base, type: 'LIST_USER_MESSAGES_RESPONSE', body: { userMessageMap } })).toMatchObject({ ok: false });
  });

  it('allows an empty list map and copies keys without a prototype', () => {
    const result = decodeHcuMessage('{"id":"id","pluginId":"plugin","type":"LIST_USER_MESSAGES_RESPONSE","body":{"userMessageMap":{"__proto__":1720034123}}}');
    expect(result.ok).toBe(true);
    if (result.ok && result.value.kind === 'known' && result.value.message.type === 'LIST_USER_MESSAGES_RESPONSE') {
      expect(Object.getPrototypeOf(result.value.message.body.userMessageMap)).toBeNull();
      expect(result.value.message.body.userMessageMap['__proto__']).toBe(1720034123);
    }
    expect(decodeHcuMessage({ ...base, type: 'LIST_USER_MESSAGES_RESPONSE', body: { userMessageMap: {} } })).toMatchObject({ ok: true });
  });

  it('accepts protocol errors with optional messages and arbitrary original JSON', () => {
    expect(decodeHcuMessage({ ...base, type: 'ERROR_RESPONSE', body: { error: { code: 'ERROR' }, originalMessage: 'Hello' } })).toMatchObject({ ok: true });
    expect(decodeHcuMessage({ ...base, type: 'ERROR_RESPONSE', body: { error: { code: 'ERROR', message: 'detail' }, originalMessage: { invalid: true } } })).toMatchObject({ ok: true });
    expect(decodeHcuMessage({ ...base, type: 'ERROR_RESPONSE', body: { error: { code: 'ERROR' } } })).toMatchObject({ ok: false });
  });

  it('ignores future types and drops the untrusted body', () => {
    expect(decodeHcuMessage({ ...base, type: 'FUTURE_EVENT', body: { secret: 'token' } })).toEqual({ ok: true, value: { kind: 'ignored', messageType: 'FUTURE_EVENT' } });
    expect(decodeHcuMessage({ ...base, type: 'secret auth token in type', body: {} })).toEqual({ ok: true, value: { kind: 'ignored', messageType: 'UNRECOGNIZED' } });
  });

  it('encodes only the envelope fields and preserves omitted body', () => {
    expect(encodeHcuMessage({ ...base, type: 'LIST_USER_MESSAGES_REQUEST' })).toEqual({ ok: true, value: '{"id":"correlation","pluginId":"plugin","type":"LIST_USER_MESSAGES_REQUEST"}' });
  });

  it('rejects cyclic bodies and returns a safe serialization error', () => {
    const body: Record<string, unknown> = {};
    body['cycle'] = body;
    expect(encodeHcuMessage({ ...base, type: 'TEST', body })).toMatchObject({ ok: false, error: { code: 'InvalidResponseError' } });
  });
});
