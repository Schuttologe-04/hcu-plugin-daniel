import { describe, expect, it, vi } from 'vitest';
import { failure, success, type Result } from '../../../../src/domain/errors.js';
import { decodeHcuMessage } from '../../../../src/hcu/message-codec.js';
import type { HcuRequester, IncomingHcuMessage } from '../../../../src/hcu/message-types.js';
import { HcuUserMessageService, type CreateUserMessageInput } from '../../../../src/hcu/messages/user-message-service.js';

const input: CreateUserMessageInput = {
  title: { de: 'TEST: go-e Lastmanagement', en: 'TEST: go-e load management' },
  message: { de: 'Dry-Run: Wallboxen unverändert.', en: 'Dry run: chargers unchanged.' },
  behaviorType: 'ACKNOWLEDGEABLE_BY_YES_NO',
  messageCategory: 'WARN',
};

function response(type: string, body: Readonly<Record<string, unknown>>): Result<IncomingHcuMessage> {
  const decoded = decodeHcuMessage({ id: 'request-1', pluginId: 'test.plugin', type, body });
  if (!decoded.ok) return decoded;
  return decoded.value.kind === 'known' ? success(decoded.value.message)
    : failure('InvalidResponseError', 'Unexpected test response type.');
}

function fixture(body: Readonly<Record<string, unknown>> = { success: true, userMessageId: 'message-1' }) {
  const request = vi.fn<HcuRequester['request']>(async (_type, _body, responseType) => response(responseType, body));
  const nextId = vi.fn(() => 'message-1');
  return { request, nextId, service: new HcuUserMessageService({ request }, { nextId }, () => 1744111671079) };
}

describe('HcuUserMessageService', () => {
  it('sends the documented create body with localized text and an injected timestamp', async () => {
    const { service, request, nextId } = fixture();
    expect(await service.create(input)).toEqual(success({ userMessageId: 'message-1' }));
    expect(nextId).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('CREATE_USER_MESSAGE_REQUEST', {
      ...input, userMessageId: 'message-1', timestamp: 1744111671079,
    }, 'CREATE_USER_MESSAGE_RESPONSE');
  });

  it('reuses an explicit userMessageId without generating another ID', async () => {
    const { service, nextId } = fixture();
    expect((await service.create({ ...input, userMessageId: 'message-1' })).ok).toBe(true);
    expect(nextId).not.toHaveBeenCalled();
  });

  it.each(['ACKNOWLEDGEABLE_BY_YES_NO', 'ACKNOWLEDGEABLE_BY_OK', 'DISMISSIBLE', 'NOT_DISMISSIBLE'] as const)(
    'supports documented behavior %s', async (behaviorType) => {
      expect((await fixture().service.create({ ...input, behaviorType })).ok).toBe(true);
    },
  );

  it.each(['INFO', 'WARN', 'ERROR'] as const)('supports category %s', async (messageCategory) => {
    expect((await fixture().service.create({ ...input, messageCategory })).ok).toBe(true);
  });

  it('checks the response ID as well as the request correlation enforced by transport', async () => {
    const { service } = fixture({ success: true, userMessageId: 'another-message' });
    expect(await service.create(input)).toMatchObject({ ok: false, error: { code: 'InvalidResponseError' } });
  });

  it('reports HCU rejection without exposing the protocol error text', async () => {
    const { service } = fixture({ success: false, userMessageId: 'message-1', error: { code: 'ERROR', message: 'secret' } });
    const result = await service.create(input);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('does not accept another response type', async () => {
    const request = vi.fn<HcuRequester['request']>(async () => response('LIST_USER_MESSAGES_RESPONSE', { userMessageMap: {} }));
    const service = new HcuUserMessageService({ request }, { nextId: () => 'message-1' }, () => 0);
    expect((await service.create(input)).ok).toBe(false);
  });

  it('rejects empty German text before sending anything', async () => {
    const { service, request } = fixture();
    expect((await service.create({ ...input, title: { de: '' } })).ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects unsupported localization keys before sending', async () => {
    const { service, request } = fixture();
    expect((await service.create({ ...input, message: { de: 'Test', german: 'Test' } })).ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid timestamp %s', async (time) => {
    const { request } = fixture();
    const service = new HcuUserMessageService({ request }, { nextId: () => 'message-1' }, () => time);
    expect((await service.create(input)).ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('contains provider exceptions', async () => {
    const { request } = fixture();
    const service = new HcuUserMessageService({ request }, { nextId: () => { throw new Error('secret'); } }, () => 0);
    expect(await service.create(input)).toMatchObject({ ok: false, error: { code: 'ConfigurationError' } });
  });

  it('contains request exceptions and preserves safe request failures', async () => {
    const request = vi.fn<HcuRequester['request']>(async () => { throw new Error('secret'); });
    const service = new HcuUserMessageService({ request }, { nextId: () => 'message-1' }, () => 0);
    expect(await service.create(input)).toEqual(failure('ConnectionError', 'HCU user-message request failed.'));
    request.mockResolvedValue(failure('TimeoutError', 'HCU request timeout.'));
    expect(await service.create(input)).toEqual(failure('TimeoutError', 'HCU request timeout.'));
  });

  it('deletes only the specified plugin message through the documented operation', async () => {
    const { service, request } = fixture();
    expect(await service.delete('message-1')).toEqual(success(undefined));
    expect(request).toHaveBeenCalledWith('DELETE_USER_MESSAGE_REQUEST', { userMessageId: 'message-1' }, 'DELETE_USER_MESSAGE_RESPONSE');
  });

  it('rejects an empty deletion ID without sending', async () => {
    const { service, request } = fixture();
    expect((await service.delete('')).ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('validates deletion success and the returned ID', async () => {
    expect((await fixture({ success: false, userMessageId: 'message-1' }).service.delete('message-1')).ok).toBe(false);
    expect((await fixture({ success: true, userMessageId: 'other' }).service.delete('message-1')).ok).toBe(false);
  });

  it('lists the documented identifier-to-long map', async () => {
    const { service, request } = fixture({ userMessageMap: { 'message-1': 1744111671079, 'message-2': 0 } });
    expect(await service.list()).toEqual(success({ 'message-1': 1744111671079, 'message-2': 0 }));
    expect(request).toHaveBeenCalledWith('LIST_USER_MESSAGES_REQUEST', {}, 'LIST_USER_MESSAGES_RESPONSE');
  });

  it.each(['message-1', ['message-1'], { 'message-1': '123' }, { 'message-1': null }, { 'message-1': 1.5 }])(
    'rejects malformed message maps at the transport boundary: %j', async (userMessageMap) => {
      expect((await fixture({ userMessageMap }).service.list()).ok).toBe(false);
    },
  );

  it('rejects negative map timestamps', async () => {
    expect((await fixture({ userMessageMap: { 'message-1': -1 } }).service.list()).ok).toBe(false);
  });
});
