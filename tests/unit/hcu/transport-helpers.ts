import type { HcuWebSocket, HcuWebSocketConnectionOptions, HcuWebSocketFactory } from '../../../src/hcu/websocket-client.js';
import type { IdProvider } from '../../../src/hcu/id-provider.js';
import { PLUGIN_ID } from '../../../src/hcu/plugin-identity.js';

export class SequenceIds implements IdProvider {
  #count = 0;
  nextId(): string { this.#count += 1; return `request-${this.#count}`; }
}

export class FakeSocket implements HcuWebSocket {
  readyState = 0;
  readonly sent: string[] = [];
  closeCalls = 0;
  terminateCalls = 0;
  sendThrows = false;
  readonly #listeners = new Map<string, Array<(data?: unknown) => void>>();

  on(event: 'open' | 'message' | 'close' | 'error', listener: (data?: unknown) => void): void {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener);
    this.#listeners.set(event, listeners);
  }

  emit(event: 'open' | 'message' | 'close' | 'error', data?: unknown): void {
    if (event === 'open') this.readyState = 1;
    if (event === 'close') this.readyState = 3;
    for (const listener of this.#listeners.get(event) ?? []) listener(data);
  }

  send(data: string): void {
    if (this.sendThrows) throw new Error('sensitive native detail');
    this.sent.push(data);
  }

  close(): void { this.closeCalls += 1; this.readyState = 3; }
  terminate(): void { this.terminateCalls += 1; this.readyState = 3; }
}

export function fakeFactory(): {
  readonly factory: HcuWebSocketFactory;
  readonly sockets: FakeSocket[];
  readonly calls: Array<{ url: string; options: HcuWebSocketConnectionOptions }>;
} {
  const sockets: FakeSocket[] = [];
  const calls: Array<{ url: string; options: HcuWebSocketConnectionOptions }> = [];
  return {
    sockets,
    calls,
    factory: (url, options) => {
      const socket = new FakeSocket();
      calls.push({ url, options });
      sockets.push(socket);
      return socket;
    },
  };
}

export const transportSettings = {
  url: 'wss://hcu1-1234.local:9001',
  authtoken: 'local-unit-test-secret',
  pluginId: PLUGIN_ID,
  allowSelfSigned: false,
};
