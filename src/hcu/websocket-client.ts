import WebSocket from 'ws';
import type { Logger } from 'pino';
import { failure, type AppError, type Result } from '../domain/errors.js';
import { RandomIdProvider, type IdProvider } from './id-provider.js';
import { decodeHcuMessage, encodeHcuMessage } from './message-codec.js';
import type { HcuConnectionState, HcuEnvelope, HcuRequester, IncomingHcuMessage } from './message-types.js';
import { validateHcuConnectionSettings, type HcuConnectionSettings } from './runtime/hcu-environment.js';

/** Small injectable socket boundary: unit tests never open an actual HCU connection. */
export interface HcuWebSocket {
  readonly readyState: number;
  on(event: 'open' | 'message' | 'close' | 'error', listener: (data?: unknown) => void): unknown;
  send(data: string): void;
  close(): void;
  terminate(): void;
}

export interface HcuWebSocketConnectionOptions {
  readonly headers: Readonly<{ authtoken: string; 'plugin-id': string }>;
  readonly rejectUnauthorized: boolean;
  readonly handshakeTimeout: number;
  readonly maxPayload: number;
  readonly followRedirects: false;
}

export type HcuWebSocketFactory = (url: string, options: HcuWebSocketConnectionOptions) => HcuWebSocket;

export interface HcuWebSocketClientOptions extends HcuConnectionSettings {
  readonly logger?: Logger;
  readonly idProvider?: IdProvider;
  readonly webSocketFactory?: HcuWebSocketFactory;
  readonly requestTimeoutMs?: number;
  readonly reconnectBaseMs?: number;
  readonly reconnectMaxMs?: number;
  readonly maxReconnectAttempts?: number;
  readonly handshakeTimeoutMs?: number;
}

interface PendingRequest {
  readonly responseType: string;
  readonly resolve: (result: Result<IncomingHcuMessage>) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_MAX_PAYLOAD = 262_144;

function positiveTimer(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
}

/** Transport only: no HCU configuration, notification or engine policy belongs here. */
export class HcuWebSocketClient implements HcuRequester {
  readonly pluginId: string;
  readonly #options: HcuWebSocketClientOptions;
  readonly #factory: HcuWebSocketFactory;
  readonly #idProvider: IdProvider;
  readonly #requestTimeoutMs: number;
  readonly #reconnectBaseMs: number;
  readonly #reconnectMaxMs: number;
  readonly #maxReconnectAttempts: number;
  readonly #handshakeTimeoutMs: number;
  readonly #messageListeners = new Set<(message: IncomingHcuMessage) => void | Promise<void>>();
  readonly #stateListeners = new Set<(state: HcuConnectionState) => void>();
  readonly #pending = new Map<string, PendingRequest>();
  #state: HcuConnectionState = 'DISCONNECTED';
  #lastError: AppError | undefined;
  #socket: HcuWebSocket | undefined;
  #running = false;
  #reconnectAttempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: HcuWebSocketClientOptions) {
    this.#options = options;
    this.pluginId = options.pluginId;
    this.#factory = options.webSocketFactory ?? ((url, socketOptions) => new WebSocket(url, socketOptions));
    this.#idProvider = options.idProvider ?? new RandomIdProvider();
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.#reconnectBaseMs = options.reconnectBaseMs ?? 1_000;
    this.#reconnectMaxMs = options.reconnectMaxMs ?? 30_000;
    this.#maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5_000;
  }

  get state(): HcuConnectionState { return this.#state; }
  get lastError(): AppError | undefined { return this.#lastError; }

  onMessage(listener: (message: IncomingHcuMessage) => void | Promise<void>): () => void {
    this.#messageListeners.add(listener);
    return () => { this.#messageListeners.delete(listener); };
  }

  onState(listener: (state: HcuConnectionState) => void): () => void {
    this.#stateListeners.add(listener);
    return () => { this.#stateListeners.delete(listener); };
  }

  start(): void {
    if (this.#running) return;
    const settings = validateHcuConnectionSettings(this.#options);
    if (!settings.ok) {
      this.#lastError = settings.error;
      this.#options.logger?.error({ code: settings.error.code }, 'HCU connection configuration invalid');
      return;
    }
    if (!positiveTimer(this.#requestTimeoutMs) || !positiveTimer(this.#reconnectBaseMs)
      || !positiveTimer(this.#reconnectMaxMs) || this.#reconnectMaxMs < this.#reconnectBaseMs
      || !positiveTimer(this.#handshakeTimeoutMs) || !Number.isSafeInteger(this.#maxReconnectAttempts)
      || this.#maxReconnectAttempts < 0 || this.#maxReconnectAttempts > 100) {
      this.#lastError = { code: 'ConfigurationError', message: 'HCU transport timing configuration is invalid.' };
      this.#options.logger?.error({ code: 'ConfigurationError' }, 'HCU transport timing configuration invalid');
      return;
    }
    this.#running = true;
    this.#reconnectAttempt = 0;
    this.#lastError = undefined;
    this.#connect(false);
  }

  stop(): void {
    this.#running = false;
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#failPending('HCU connection stopped.');
    const socket = this.#socket;
    this.#socket = undefined;
    this.#transition('STOPPED');
    if (socket !== undefined) {
      try { socket.close(); socket.terminate(); } catch { /* Shutdown cannot leak socket errors. */ }
    }
  }

  markReady(): void {
    if (this.#state === 'CONNECTED' || this.#state === 'READY') this.#transition('READY');
  }

  send(message: HcuEnvelope): boolean {
    if (message.pluginId !== this.pluginId || !this.#socket || this.#socket.readyState !== WebSocket.OPEN
      || (this.#state !== 'CONNECTED' && this.#state !== 'READY')) return false;
    const encoded = encodeHcuMessage(message);
    if (!encoded.ok) {
      this.#options.logger?.warn({ code: encoded.error.code }, 'HCU outgoing message rejected');
      return false;
    }
    try {
      this.#socket.send(encoded.value);
      return true;
    } catch {
      this.#options.logger?.warn({ code: 'ConnectionError' }, 'Unable to send HCU message');
      return false;
    }
  }

  request(type: string, body: Readonly<Record<string, unknown>>, responseType: string): Promise<Result<IncomingHcuMessage>> {
    if (!this.#socket || (this.#state !== 'CONNECTED' && this.#state !== 'READY')) {
      return Promise.resolve(failure('ConnectionError', 'HCU connection is not available.'));
    }
    const id = this.#idProvider.nextId();
    if (this.#pending.has(id)) return Promise.resolve(failure('InvalidResponseError', 'HCU request identifier is already in use.'));
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve(failure('TimeoutError', 'HCU request timed out.'));
      }, this.#requestTimeoutMs);
      this.#pending.set(id, { responseType, timer, resolve });
      if (!this.send({ id, pluginId: this.pluginId, type, body })) {
        clearTimeout(timer);
        this.#pending.delete(id);
        resolve(failure('ConnectionError', 'HCU request could not be sent.'));
      }
    });
  }

  #connect(reconnecting: boolean): void {
    if (!this.#running) return;
    this.#transition(reconnecting ? 'RECONNECTING' : 'CONNECTING');
    let socket: HcuWebSocket;
    try {
      socket = this.#factory(this.#options.url, {
        headers: { authtoken: this.#options.authtoken, 'plugin-id': this.pluginId },
        rejectUnauthorized: !this.#options.allowSelfSigned,
        handshakeTimeout: this.#handshakeTimeoutMs,
        maxPayload: DEFAULT_MAX_PAYLOAD,
        followRedirects: false,
      });
    } catch {
      this.#lastError = { code: 'ConnectionError', message: 'Unable to establish the HCU connection.' };
      this.#options.logger?.warn({ code: 'ConnectionError' }, 'Unable to establish HCU connection');
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    socket.on('open', () => {
      if (this.#socket !== socket || !this.#running) return;
      this.#reconnectAttempt = 0;
      this.#lastError = undefined;
      this.#options.logger?.info('HCU WebSocket connected');
      this.#transition('CONNECTED');
    });
    socket.on('message', (data) => {
      if (this.#socket === socket && this.#running) this.#receive(data);
    });
    socket.on('close', () => { this.#disconnected(socket); });
    socket.on('error', () => {
      if (this.#socket !== socket) return;
      this.#options.logger?.warn({ code: 'ConnectionError' }, 'HCU WebSocket connection failed');
      this.#disconnected(socket);
      try { socket.terminate(); } catch { /* Never expose TLS/header/native exceptions. */ }
    });
  }

  #disconnected(socket: HcuWebSocket): void {
    if (this.#socket !== socket) return;
    this.#socket = undefined;
    this.#lastError = { code: 'ConnectionError', message: 'HCU WebSocket disconnected.' };
    this.#failPending('HCU connection disconnected.');
    this.#transition('DISCONNECTED');
    this.#options.logger?.warn('HCU WebSocket disconnected');
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (!this.#running || this.#reconnectTimer !== undefined) return;
    if (this.#reconnectAttempt >= this.#maxReconnectAttempts) {
      this.#running = false;
      this.#transition('DISCONNECTED');
      this.#options.logger?.error({ attempts: this.#reconnectAttempt }, 'HCU reconnect attempts exhausted');
      return;
    }
    const delayMs = Math.min(this.#reconnectMaxMs, this.#reconnectBaseMs * 2 ** this.#reconnectAttempt);
    this.#reconnectAttempt += 1;
    this.#transition('RECONNECTING');
    this.#options.logger?.debug({ attempt: this.#reconnectAttempt, delayMs }, 'HCU reconnect scheduled');
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#connect(true);
    }, delayMs);
  }

  #receive(data: unknown): void {
    let text: string;
    if (typeof data === 'string') text = data;
    else if (Buffer.isBuffer(data)) text = data.toString('utf8');
    else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf8');
    else if (Array.isArray(data) && data.every(Buffer.isBuffer)) text = Buffer.concat(data).toString('utf8');
    else {
      this.#options.logger?.warn({ code: 'InvalidResponseError' }, 'Unsupported HCU message frame');
      return;
    }
    if (Buffer.byteLength(text) > DEFAULT_MAX_PAYLOAD) {
      this.#options.logger?.warn({ code: 'InvalidResponseError' }, 'HCU message exceeded size limit');
      return;
    }
    const decoded = decodeHcuMessage(text);
    if (!decoded.ok) {
      this.#options.logger?.warn({ code: decoded.error.code }, 'Malformed HCU message ignored');
      return;
    }
    if (decoded.value.kind === 'ignored') {
      // Unknown type strings are untrusted payload too; never echo them into logs.
      this.#options.logger?.debug('Unknown HCU message type ignored');
      return;
    }
    const message = decoded.value.message;
    if (message.pluginId !== this.pluginId) {
      this.#options.logger?.warn('HCU message for a different plugin ignored');
      return;
    }
    const pending = this.#pending.get(message.id);
    if (pending && (message.type === pending.responseType || message.type === 'ERROR_RESPONSE')) {
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      pending.resolve(message.type === 'ERROR_RESPONSE'
        ? failure('InvalidResponseError', 'HCU rejected the request.')
        : { ok: true, value: message });
    }
    for (const listener of this.#messageListeners) {
      try {
        void Promise.resolve(listener(message)).catch(() => {
          this.#options.logger?.error({ code: 'InvalidResponseError' }, 'HCU message handler failed');
        });
      } catch {
        this.#options.logger?.error({ code: 'InvalidResponseError' }, 'HCU message handler failed');
      }
    }
  }

  #transition(state: HcuConnectionState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of this.#stateListeners) {
      try { listener(state); } catch {
        this.#options.logger?.error({ code: 'ConnectionError' }, 'HCU connection-state handler failed');
      }
    }
  }

  #failPending(message: string): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(failure('ConnectionError', message));
    }
    this.#pending.clear();
  }
}
