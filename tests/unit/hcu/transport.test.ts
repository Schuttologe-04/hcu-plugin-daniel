import { afterEach, describe, expect, it, vi } from 'vitest';
import { HcuWebSocketClient, type HcuWebSocketClientOptions } from '../../../src/hcu/websocket-client.js';
import { createLogger } from '../../../src/logging/logger.js';
import type { HcuConnectionState, IncomingHcuMessage } from '../../../src/hcu/message-types.js';
import { fakeFactory, SequenceIds, transportSettings } from './transport-helpers.js';

const clients: HcuWebSocketClient[] = [];

function setup(extra: Partial<HcuWebSocketClientOptions> = {}) {
  const fake = fakeFactory();
  const logs: string[] = [];
  const logger = createLogger('debug', { write: (line: string) => { logs.push(line); } });
  const client = new HcuWebSocketClient({ ...transportSettings, idProvider: new SequenceIds(),
    webSocketFactory: fake.factory, logger, ...extra });
  clients.push(client);
  return { client, fake, logs };
}

afterEach(() => {
  for (const client of clients) client.stop();
  clients.length = 0;
  vi.useRealTimers();
});

describe('HCU WebSocket transport', () => {
  it('opens the configured WSS address with documented auth headers and local TLS policy', () => {
    const { client, fake } = setup();
    expect(client.state).toBe('DISCONNECTED');
    client.start();
    expect(client.state).toBe('CONNECTING');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toEqual({ url: transportSettings.url, options: {
      headers: { authtoken: transportSettings.authtoken, 'plugin-id': transportSettings.pluginId },
      rejectUnauthorized: true, handshakeTimeout: 5000, maxPayload: 262144, followRedirects: false,
    } });
    expect(fake.calls[0]?.options.headers).not.toHaveProperty('hmip-system-events');
    fake.sockets[0]?.emit('open');
    expect(client.state).toBe('CONNECTED');
    client.markReady();
    expect(client.state).toBe('READY');
  });

  it('accepts self-signed certificates only for the explicitly configured socket', () => {
    const previousGlobal = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    const { client, fake } = setup({ allowSelfSigned: true });
    client.start();
    expect(fake.calls[0]?.options.rejectUnauthorized).toBe(false);
    expect(process.env['NODE_TLS_REJECT_UNAUTHORIZED']).toBe(previousGlobal);
  });

  it('never logs token, credentials, URL, raw payload, native errors or protocol errors', async () => {
    const { client, fake, logs } = setup();
    client.start();
    fake.sockets[0]?.emit('open');
    fake.sockets[0]?.emit('message', '{secret payload');
    fake.sockets[0]?.emit('message', JSON.stringify({ id: 'x', pluginId: transportSettings.pluginId, type: 'FUTURE_EVENT', body: { authtoken: transportSettings.authtoken } }));
    const pending = client.request('LIST_USER_MESSAGES_REQUEST', {}, 'LIST_USER_MESSAGES_RESPONSE');
    fake.sockets[0]?.emit('message', JSON.stringify({ id: 'request-1', pluginId: transportSettings.pluginId, type: 'ERROR_RESPONSE', body: {
      error: { code: 'ERROR', message: transportSettings.authtoken }, originalMessage: { secret: transportSettings.authtoken },
    } }));
    expect(await pending).toEqual({ ok: false, error: { code: 'InvalidResponseError', message: 'HCU rejected the request.' } });
    fake.sockets[0]?.emit('error', new Error(`native ${transportSettings.authtoken}`));
    const combined = logs.join('');
    expect(combined).not.toContain(transportSettings.authtoken);
    expect(combined).not.toContain(transportSettings.url);
    expect(combined).not.toContain('secret payload');
    expect(combined).not.toContain('originalMessage');
  });

  it('ignores malformed JSON and future types while preserving an open connection', () => {
    const { client, fake } = setup();
    const listener = vi.fn<(message: IncomingHcuMessage) => void>();
    client.onMessage(listener);
    client.start(); fake.sockets[0]?.emit('open');
    for (const input of ['{', JSON.stringify({ id: 'x', pluginId: client.pluginId, type: 'FUTURE_EVENT', body: {} }),
      JSON.stringify({ id: 'x', pluginId: client.pluginId, type: 'USER_MESSAGE_ACK_EVENT', body: { ackType: 'YES' } }),
    ]) fake.sockets[0]?.emit('message', input);
    expect(listener).not.toHaveBeenCalled();
    expect(client.state).toBe('CONNECTED');
    fake.sockets[0]?.emit('message', JSON.stringify({ id: 'request', pluginId: client.pluginId, type: 'PLUGIN_STATE_REQUEST' }));
    expect(listener).toHaveBeenCalledOnce();
  });

  it('routes validated known messages and never routes a different plugin id', () => {
    const { client, fake } = setup();
    const listener = vi.fn<(message: IncomingHcuMessage) => void>();
    const unsubscribe = client.onMessage(listener);
    client.start(); fake.sockets[0]?.emit('open');
    const message = { pluginId: client.pluginId, id: 'request', type: 'CONFIG_TEMPLATE_REQUEST', body: { languageCode: 'de' } };
    fake.sockets[0]?.emit('message', JSON.stringify({ ...message, pluginId: 'other-plugin' }));
    expect(listener).not.toHaveBeenCalled();
    fake.sockets[0]?.emit('message', Buffer.from(JSON.stringify(message)));
    expect(listener).toHaveBeenCalledWith(message);
    unsubscribe();
    fake.sockets[0]?.emit('message', JSON.stringify(message));
    expect(listener).toHaveBeenCalledOnce();
  });

  it('supports the ws binary frame representations without trusting objects', () => {
    const { client, fake } = setup();
    const listener = vi.fn<(message: IncomingHcuMessage) => void>();
    client.onMessage(listener);
    client.start(); fake.sockets[0]?.emit('open');
    const text = JSON.stringify({ pluginId: client.pluginId, id: 'request', type: 'PLUGIN_STATE_REQUEST' });
    const arrayBuffer = new ArrayBuffer(Buffer.byteLength(text));
    new Uint8Array(arrayBuffer).set(Buffer.from(text));
    fake.sockets[0]?.emit('message', arrayBuffer);
    fake.sockets[0]?.emit('message', [Buffer.from(text.substring(0, 10)), Buffer.from(text.substring(10))]);
    fake.sockets[0]?.emit('message', {});
    fake.sockets[0]?.emit('message', [Buffer.from('{}'), 'not a buffer']);
    fake.sockets[0]?.emit('message', 'x'.repeat(262145));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('contains synchronous and asynchronous service-handler failures and continues routing', async () => {
    const { client, fake, logs } = setup();
    const healthyListener = vi.fn<(message: IncomingHcuMessage) => void>();
    client.onMessage(() => { throw new Error('private synchronous exception'); });
    client.onMessage(async () => { throw new Error('private asynchronous exception'); });
    client.onMessage(healthyListener);
    client.start(); fake.sockets[0]?.emit('open');
    fake.sockets[0]?.emit('message', JSON.stringify({ id: 'x', pluginId: client.pluginId, type: 'PLUGIN_STATE_REQUEST' }));
    await Promise.resolve(); await Promise.resolve();
    expect(healthyListener).toHaveBeenCalledOnce();
    expect(logs.join('')).not.toContain('private');
    expect(client.state).toBe('CONNECTED');
  });

  it('detects disconnect and backs off exponentially with a cap', async () => {
    vi.useFakeTimers();
    const { client, fake } = setup({ reconnectBaseMs: 1000, reconnectMaxMs: 4000 });
    const states: HcuConnectionState[] = [];
    client.onState((state) => { states.push(state); });
    client.start(); fake.sockets[0]?.emit('close');
    expect(states).toContain('DISCONNECTED');
    expect(client.state).toBe('RECONNECTING');
    await vi.advanceTimersByTimeAsync(999); expect(fake.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(fake.calls).toHaveLength(2);
    fake.sockets[1]?.emit('close');
    await vi.advanceTimersByTimeAsync(1999); expect(fake.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); expect(fake.calls).toHaveLength(3);
    fake.sockets[2]?.emit('close');
    await vi.advanceTimersByTimeAsync(4000); expect(fake.calls).toHaveLength(4);
    fake.sockets[3]?.emit('close');
    await vi.advanceTimersByTimeAsync(4000); expect(fake.calls).toHaveLength(5);
    expect(fake.calls.every((call) => call.options.headers.authtoken === transportSettings.authtoken)).toBe(true);
  });

  it('resets retry backoff after an authenticated connection succeeds', async () => {
    vi.useFakeTimers();
    const { client, fake } = setup();
    client.start(); fake.sockets[0]?.emit('close');
    await vi.advanceTimersByTimeAsync(1000);
    fake.sockets[1]?.emit('open'); fake.sockets[1]?.emit('close');
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.calls).toHaveLength(3);
  });

  it('bounds failed reconnect attempts and permits an explicit restart', async () => {
    vi.useFakeTimers();
    const { client, fake } = setup({ maxReconnectAttempts: 2 });
    client.start(); fake.sockets[0]?.emit('close');
    await vi.advanceTimersByTimeAsync(1000); fake.sockets[1]?.emit('close');
    await vi.advanceTimersByTimeAsync(2000); fake.sockets[2]?.emit('close');
    expect(client.state).toBe('DISCONNECTED');
    await vi.advanceTimersByTimeAsync(60_000); expect(fake.calls).toHaveLength(3);
    client.start(); expect(fake.calls).toHaveLength(4);
  });

  it('shutdown cancels pending reconnect and stops delivery from stale sockets', async () => {
    vi.useFakeTimers();
    const { client, fake } = setup();
    const listener = vi.fn<(message: IncomingHcuMessage) => void>();
    client.onMessage(listener);
    client.start(); fake.sockets[0]?.emit('close');
    client.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.state).toBe('STOPPED');
    expect(fake.calls).toHaveLength(1);
    fake.sockets[0]?.emit('open');
    fake.sockets[0]?.emit('message', JSON.stringify({ id: 'x', pluginId: client.pluginId, type: 'PLUGIN_STATE_REQUEST' }));
    expect(listener).not.toHaveBeenCalled();
  });

  it('shutdown closes its active socket and can be restarted once explicitly', () => {
    const { client, fake } = setup();
    client.start(); client.start(); expect(fake.calls).toHaveLength(1);
    fake.sockets[0]?.emit('open');
    client.stop();
    expect(fake.sockets[0]?.closeCalls).toBe(1);
    expect(fake.sockets[0]?.terminateCalls).toBe(1);
    client.start(); expect(fake.calls).toHaveLength(2);
  });

  it('correlates responses by id, plugin id and response type', async () => {
    const { client, fake } = setup();
    client.start(); fake.sockets[0]?.emit('open');
    const first = client.request('LIST_USER_MESSAGES_REQUEST', {}, 'LIST_USER_MESSAGES_RESPONSE');
    const second = client.request('CREATE_USER_MESSAGE_REQUEST', { title: { de: 'TEST' } }, 'CREATE_USER_MESSAGE_RESPONSE');
    expect(fake.sockets[0]?.sent.map((value) => JSON.parse(value) as unknown)).toMatchObject([
      { pluginId: client.pluginId, id: 'request-1', type: 'LIST_USER_MESSAGES_REQUEST', body: {} },
      { pluginId: client.pluginId, id: 'request-2', type: 'CREATE_USER_MESSAGE_REQUEST' },
    ]);
    fake.sockets[0]?.emit('message', JSON.stringify({ pluginId: client.pluginId, id: 'request-1', type: 'CREATE_USER_MESSAGE_RESPONSE', body: { success: true, userMessageId: 'wrong-type' } }));
    fake.sockets[0]?.emit('message', JSON.stringify({ pluginId: 'other-plugin', id: 'request-1', type: 'LIST_USER_MESSAGES_RESPONSE', body: { userMessageMap: {} } }));
    fake.sockets[0]?.emit('message', JSON.stringify({ pluginId: client.pluginId, id: 'request-2', type: 'CREATE_USER_MESSAGE_RESPONSE', body: { success: true, userMessageId: 'created' } }));
    fake.sockets[0]?.emit('message', JSON.stringify({ pluginId: client.pluginId, id: 'request-1', type: 'LIST_USER_MESSAGES_RESPONSE', body: { userMessageMap: { created: 100 } } }));
    expect(await first).toMatchObject({ ok: true, value: { id: 'request-1', type: 'LIST_USER_MESSAGES_RESPONSE', body: { userMessageMap: { created: 100 } } } });
    expect(await second).toMatchObject({ ok: true, value: { id: 'request-2', type: 'CREATE_USER_MESSAGE_RESPONSE' } });
  });

  it('times out requests without leaking body values', async () => {
    vi.useFakeTimers();
    const { client, fake } = setup({ requestTimeoutMs: 200 });
    client.start(); fake.sockets[0]?.emit('open');
    const result = client.request('LIST_USER_MESSAGES_REQUEST', { secret: 'do not expose' }, 'LIST_USER_MESSAGES_RESPONSE');
    await vi.advanceTimersByTimeAsync(200);
    expect(await result).toEqual({ ok: false, error: { code: 'TimeoutError', message: 'HCU request timed out.' } });
  });

  it.each(['disconnect', 'shutdown'])('fails pending requests on %s immediately', async (mode) => {
    const { client, fake } = setup();
    client.start(); fake.sockets[0]?.emit('open');
    const result = client.request('LIST_USER_MESSAGES_REQUEST', {}, 'LIST_USER_MESSAGES_RESPONSE');
    if (mode === 'shutdown') client.stop(); else fake.sockets[0]?.emit('close');
    expect(await result).toMatchObject({ ok: false, error: { code: 'ConnectionError' } });
  });

  it('returns failure for offline requests and send errors rather than throwing', async () => {
    const { client, fake } = setup();
    expect(await client.request('LIST_USER_MESSAGES_REQUEST', {}, 'LIST_USER_MESSAGES_RESPONSE')).toMatchObject({ ok: false });
    expect(client.send({ pluginId: client.pluginId, id: 'x', type: 'LIST_USER_MESSAGES_REQUEST' })).toBe(false);
    client.start(); fake.sockets[0]?.emit('open');
    const socket = fake.sockets[0];
    if (!socket) throw new Error('missing fake socket');
    socket.sendThrows = true;
    expect(await client.request('LIST_USER_MESSAGES_REQUEST', {}, 'LIST_USER_MESSAGES_RESPONSE')).toMatchObject({ ok: false, error: { code: 'ConnectionError' } });
    expect(client.send({ pluginId: client.pluginId, id: 'x', type: 'LIST_USER_MESSAGES_REQUEST' })).toBe(false);
  });

  it('rejects repeated pending request identifiers rather than miscorrelating a response', async () => {
    const { client, fake } = setup({ idProvider: { nextId: () => 'duplicate' } });
    client.start(); fake.sockets[0]?.emit('open');
    const first = client.request('LIST_USER_MESSAGES_REQUEST', {}, 'LIST_USER_MESSAGES_RESPONSE');
    expect(await client.request('LIST_USER_MESSAGES_REQUEST', {}, 'LIST_USER_MESSAGES_RESPONSE')).toMatchObject({ ok: false, error: { code: 'InvalidResponseError' } });
    expect(fake.sockets[0]?.sent).toHaveLength(1);
    client.stop(); await first;
  });

  it('rejects invalid outbound identities or cyclic bodies without sending', () => {
    const { client, fake } = setup();
    client.start(); fake.sockets[0]?.emit('open');
    expect(client.send({ pluginId: 'other-plugin', id: 'x', type: 'PLUGIN_STATE_RESPONSE' })).toBe(false);
    expect(client.send({ pluginId: client.pluginId, id: '', type: 'PLUGIN_STATE_RESPONSE' })).toBe(false);
    const body: Record<string, unknown> = {};
    body['self'] = body;
    expect(client.send({ pluginId: client.pluginId, id: 'x', type: 'PLUGIN_STATE_RESPONSE', body })).toBe(false);
    expect(fake.sockets[0]?.sent).toHaveLength(0);
  });

  it('contains factory errors and retries on a bounded schedule', async () => {
    vi.useFakeTimers();
    const factory = vi.fn().mockImplementation(() => { throw new Error(transportSettings.authtoken); });
    const { client, logs } = setup({ webSocketFactory: factory, maxReconnectAttempts: 1 });
    client.start(); expect(client.state).toBe('RECONNECTING');
    await vi.advanceTimersByTimeAsync(1000);
    expect(client.state).toBe('DISCONNECTED');
    expect(factory).toHaveBeenCalledTimes(2);
    expect(logs.join('')).not.toContain(transportSettings.authtoken);
  });

  it('guards state subscribers and supports unsubscribe', () => {
    const { client, fake, logs } = setup();
    client.onState(() => { throw new Error('secret-state-handler'); });
    const subscriber = vi.fn<(state: HcuConnectionState) => void>();
    const unsubscribe = client.onState(subscriber);
    client.markReady(); expect(client.state).toBe('DISCONNECTED');
    client.start(); unsubscribe(); fake.sockets[0]?.emit('open');
    expect(subscriber).toHaveBeenCalledOnce();
    expect(logs.join('')).not.toContain('secret-state-handler');
  });

  it.each([
    { url: 'ws://hcu.local:9001' }, { url: 'wss://user:secret@hcu.local:9001' },
    { url: 'wss://hcu.local:9001/api' }, { url: 'wss://hcu.local:9001/?token=secret' },
    { authtoken: '' }, { authtoken: 'header\r\ninjection' }, { pluginId: '' },
    { requestTimeoutMs: 0 }, { reconnectBaseMs: -1 }, { reconnectMaxMs: 100 },
    { handshakeTimeoutMs: 0 }, { maxReconnectAttempts: -1 },
  ])('rejects invalid connection configuration %# before connecting', (options) => {
    const { client, fake, logs } = setup(options);
    client.start();
    expect(fake.calls).toHaveLength(0);
    expect(client.lastError).toMatchObject({ code: 'ConfigurationError' });
    expect(logs.join('')).not.toContain('secret');
  });
});
