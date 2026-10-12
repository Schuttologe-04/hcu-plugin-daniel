import { mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, NotificationSettings } from '../../../src/config/config-types.js';
import type { ChargerProbeResult, ProbeReport } from '../../../src/diagnostics/probe-service.js';
import { failure, success, type Result } from '../../../src/domain/errors.js';
import type { HcuEnvelope } from '../../../src/hcu/message-types.js';
import { FileConfigStore, type ConfigStore } from '../../../src/hcu/config/config-store.js';
import { HcuWebSocketClient, type HcuWebSocketFactory } from '../../../src/hcu/websocket-client.js';
import { HcuPluginApplication } from '../../../src/orchestration/hcu-plugin-application.js';
import type { RuntimeSnapshot } from '../../../src/orchestration/runtime-snapshot.js';
import { FakeSocket, fakeFactory, SequenceIds, transportSettings } from '../hcu/transport-helpers.js';
import { controller, idle, makeCharger, makeConfig } from '../load-management/helpers.js';

type CapturedMessage = HcuEnvelope & { readonly body: Readonly<Record<string, unknown>> };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The fake HCU also validates outgoing JSON instead of using an unchecked cast. */
function captured(payload: string): CapturedMessage {
  const value: unknown = JSON.parse(payload);
  if (!record(value) || typeof value['id'] !== 'string' || typeof value['pluginId'] !== 'string'
    || typeof value['type'] !== 'string' || (value['body'] !== undefined && !record(value['body']))) {
    throw new Error('Invalid outgoing HCU envelope in integration test');
  }
  return { id: value['id'], pluginId: value['pluginId'], type: value['type'], body: value['body'] ?? {} };
}

class MemoryStore implements ConfigStore {
  saved: AppConfig | null = null;
  failSave = false;
  saves = 0;
  async load(): Promise<Result<AppConfig | null>> { return success(structuredClone(this.saved)); }
  async save(config: AppConfig): Promise<Result<void>> {
    this.saves += 1;
    if (this.failSave) return failure('ConfigurationError', 'Simulated storage failure');
    this.saved = structuredClone(config);
    return success(undefined);
  }
}

class MockHcu {
  readonly messages: CapturedMessage[] = [];
  readonly userMessages = new Map<string, number>();
  readonly factory = fakeFactory();
  readonly createSocket: HcuWebSocketFactory;
  readonly #waiting = new Set<(message: CapturedMessage) => void>();
  #ack = 0;

  constructor() {
    const makeSocket = this.factory.factory;
    this.createSocket = (url, options) => {
      makeSocket(url, options);
      const socket = this.socket();
      const original = socket.send.bind(socket);
      socket.send = (payload: string) => {
        original(payload);
        const message = captured(payload);
        this.messages.push(message);
        for (const listener of this.#waiting) listener(message);
        // Actual transport receives the documented response on a later microtask.
        void Promise.resolve().then(() => this.#respond(socket, message));
      };
      return socket;
    };
  }

  socket(): FakeSocket {
    const socket = this.factory.sockets.at(-1);
    if (socket === undefined) throw new Error('Fake HCU socket has not been created');
    return socket;
  }

  ofType(type: string): CapturedMessage[] { return this.messages.filter((message) => message.type === type); }

  next(type: string): Promise<CapturedMessage> {
    return new Promise((resolve) => {
      const listener = (message: CapturedMessage) => {
        if (message.type !== type) return;
        this.#waiting.delete(listener);
        resolve(message);
      };
      this.#waiting.add(listener);
    });
  }

  receive(type: string, body: Readonly<Record<string, unknown>> = {}, id = 'hcu-request'): void {
    this.socket().emit('message', JSON.stringify({ pluginId: transportSettings.pluginId, id, type, body }));
  }

  acknowledge(userMessageId: string, ackType: 'YES' | 'NO' | 'OK'): void {
    this.#ack += 1;
    this.receive('USER_MESSAGE_ACK_EVENT', { userMessageId, ackType }, `ack-${this.#ack}`);
  }

  #respond(socket: FakeSocket, message: CapturedMessage): void {
    if (socket.readyState !== 1) return;
    let type: string;
    let body: Readonly<Record<string, unknown>>;
    switch (message.type) {
      case 'CREATE_USER_MESSAGE_REQUEST': {
        const id = message.body['userMessageId'];
        const timestamp = message.body['timestamp'];
        if (typeof id !== 'string' || typeof timestamp !== 'number') throw new Error('Invalid fake HCU message creation');
        this.userMessages.set(id, timestamp);
        type = 'CREATE_USER_MESSAGE_RESPONSE'; body = { success: true, userMessageId: id };
        break;
      }
      case 'DELETE_USER_MESSAGE_REQUEST': {
        const id = message.body['userMessageId'];
        if (typeof id !== 'string') throw new Error('Invalid fake HCU deletion');
        this.userMessages.delete(id);
        type = 'DELETE_USER_MESSAGE_RESPONSE'; body = { success: true, userMessageId: id };
        break;
      }
      case 'LIST_USER_MESSAGES_REQUEST':
        type = 'LIST_USER_MESSAGES_RESPONSE'; body = { userMessageMap: Object.fromEntries(this.userMessages) };
        break;
      default: return;
    }
    socket.emit('message', JSON.stringify({ id: message.id, pluginId: message.pluginId, type, body }));
  }
}

function realReport(config: AppConfig): ProbeReport {
  return {
    controller: success(controller(22_839)),
    chargers: config.chargers.map((charger): ChargerProbeResult => charger.enabled
      ? { status: 'reachable', reachable: true, config: charger,
        value: charger.id === 'garage' ? makeCharger() : idle(charger.id) }
      : { status: 'disabled', reachable: false, config: charger }),
  };
}

async function flush(): Promise<void> {
  // All mocked HCU operations are finite promises; no sleeps or network are involved.
  for (let index = 0; index < 30; index += 1) await Promise.resolve();
}

const applications: HcuPluginApplication[] = [];
const temporaryDirectories: string[] = [];

function setup(options: {
  mode?: RuntimeSnapshot['mode'];
  store?: ConfigStore;
  notifications?: Partial<NotificationSettings>;
  sendTestMessage?: boolean;
} = {}) {
  vi.useFakeTimers();
  const config: AppConfig = { ...makeConfig(), notifications: {
    intervention: true, interactive: true, controllerConnectionError: false, chargerConnectionError: false,
    ...options.notifications,
  } };
  const clock = { time: 0 };
  const hcu = new MockHcu();
  const client = new HcuWebSocketClient({ ...transportSettings, webSocketFactory: hcu.createSocket,
    idProvider: new SequenceIds() });
  const store = options.store ?? new MemoryStore();
  const probe = vi.fn(async (current: AppConfig) => realReport(current));
  const app = new HcuPluginApplication({ client, config, store, mode: options.mode ?? 'HCU_DEV',
    now: () => clock.time, idProvider: new SequenceIds(), probe,
    ...(options.sendTestMessage === undefined ? {} : { sendTestMessage: options.sendTestMessage }),
  });
  applications.push(app);
  return {
    app, hcu, client, probe, store, config, clock,
    start: async (manualDryRun = true) => {
      app.start(); hcu.socket().emit('open');
      if (manualDryRun) await app.dryRun?.stop();
      await flush();
    },
    step: async (timestamp: number) => {
      if (app.dryRun === null) throw new Error('Expected a dry-run runtime');
      clock.time = timestamp;
      return app.dryRun.tick();
    },
  };
}

async function trigger(context: ReturnType<typeof setup>): Promise<RuntimeSnapshot> {
  await context.step(0);
  return context.step(30_000);
}

function questionId(context: ReturnType<typeof setup>): string {
  const id = context.app.interactions.openUserMessageId;
  if (id === null) throw new Error('Expected one open TEST question');
  return id;
}

afterEach(async () => {
  for (const application of applications) await application.stop();
  applications.length = 0;
  vi.useRealTimers();
  for (const directory of temporaryDirectories) {
    const absolute = resolve(directory);
    if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('hcu-app-')) {
      throw new Error('Refusing cleanup outside the test temporary directory');
    }
    await rm(absolute, { recursive: true, force: true });
  }
  temporaryDirectories.length = 0;
});

describe('HcuPluginApplication with a mocked HCU and real WebSocket transport', () => {
  it('HCU_DEV connects READY without go-e polling, engine or unsolicited TEST messages', async () => {
    const context = setup();
    await context.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(context.client.state).toBe('READY');
    expect(context.app.dryRun).toBeNull();
    expect(context.probe).not.toHaveBeenCalled();
    expect(context.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(0);
    expect(context.app.snapshot).toMatchObject({ mode: 'HCU_DEV', engine: null, probe: null,
      realChargerWritesEnabled: false, connectionState: 'READY' });
    expect(context.hcu.ofType('PLUGIN_STATE_RESPONSE')).toMatchObject([{ body: { pluginReadinessStatus: 'READY' } }]);
  });

  it('answers a valid state request with the same correlation id and ignores malformed requests', async () => {
    const context = setup(); await context.start();
    context.hcu.receive('PLUGIN_STATE_REQUEST', {}, 'state-query');
    context.hcu.socket().emit('message', '{"type":"PLUGIN_STATE_REQUEST"}');
    await flush();
    expect(context.hcu.ofType('PLUGIN_STATE_RESPONSE')).toHaveLength(2);
    expect(context.hcu.ofType('PLUGIN_STATE_RESPONSE').at(-1)).toMatchObject({ id: 'state-query', body: { pluginReadinessStatus: 'READY' } });
  });

  it('returns HCUweb groups and live configuration without synchronously probing go-e', async () => {
    const context = setup(); await context.start();
    const response = context.hcu.next('CONFIG_TEMPLATE_RESPONSE');
    context.hcu.receive('CONFIG_TEMPLATE_REQUEST', { languageCode: 'de' }, 'template-query');
    expect(await response).toMatchObject({ id: 'template-query', body: {
      groups: { controller: {}, loadManagement: {}, chargerGarage: {}, chargerLinks: {}, chargerRechts: {}, notifications: {}, diagnostics: {} },
      properties: {
        'loadManagement.gridLimitW': { currentValue: '19000' },
        'loadManagement.targetGridW': { currentValue: '18500' },
        'loadManagement.recoveryThresholdW': { currentValue: '18000' },
        'diagnostics.engineState': { currentValue: 'unavailable' },
        'diagnostics.realChargerWrites': { currentValue: 'disabled' },
      },
    } });
    expect(context.probe).not.toHaveBeenCalled();
    expect(JSON.stringify(await response)).not.toContain(transportSettings.authtoken);
  });

  it('persists a valid correlated config update before updating the dry-run runtime', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hcu-app-'));
    temporaryDirectories.push(directory);
    const store = new FileConfigStore(directory);
    const context = setup({ mode: 'DRY_RUN', store }); await context.start();
    await trigger(context);
    const response = context.hcu.next('CONFIG_UPDATE_RESPONSE');
    context.hcu.receive('CONFIG_UPDATE_REQUEST', { properties: {
      'loadManagement.gridLimitW': '20000', 'controller.host': 'new-controller.test',
    } }, 'update-query');
    expect(await response).toMatchObject({ id: 'update-query', body: { status: 'APPLIED' } });
    expect(context.app.configService.current).toMatchObject({ controller: { host: 'new-controller.test' }, loadManagement: { gridLimitW: 20_000 } });
    expect(await store.load()).toEqual(success(context.app.configService.current));
    expect(context.app.dryRun?.engine.snapshot.restrictions).toHaveLength(0);
    await context.step(34_000);
    expect(context.probe.mock.calls.at(-1)?.[0]).toEqual(context.app.configService.current);
  });

  it('invalid updates atomically preserve the current runtime and persisted configuration', async () => {
    const store = new MemoryStore();
    const context = setup({ mode: 'DRY_RUN', store }); await context.start(); await trigger(context);
    const oldConfig = context.app.configService.current;
    const response = context.hcu.next('CONFIG_UPDATE_RESPONSE');
    context.hcu.receive('CONFIG_UPDATE_REQUEST', { properties: {
      'controller.host': 'new-controller.test', 'chargers.garage.host': '',
    } }, 'invalid-update');
    expect(await response).toMatchObject({ id: 'invalid-update', body: { status: 'FAILED' } });
    expect(context.app.configService.current).toEqual(oldConfig);
    expect(context.app.dryRun?.engine.snapshot.restrictions).toMatchObject([{ temporaryCurrentLimitA: 13 }]);
    expect(store.saves).toBe(0);
  });

  it('a persistence failure leaves the prior valid runtime intact', async () => {
    const store = new MemoryStore(); store.failSave = true;
    const context = setup({ mode: 'DRY_RUN', store }); await context.start(); await trigger(context);
    const oldConfig = context.app.configService.current;
    const response = context.hcu.next('CONFIG_UPDATE_RESPONSE');
    context.hcu.receive('CONFIG_UPDATE_REQUEST', { properties: { 'loadManagement.gridLimitW': 21000 } });
    expect(await response).toMatchObject({ body: { status: 'FAILED' } });
    expect(context.app.configService.current).toEqual(oldConfig);
    expect(context.app.dryRun?.engine.snapshot.restrictions).toMatchObject([{ temporaryCurrentLimitA: 13 }]);
  });

  it('an explicitly requested TEST message works without creating or running an engine', async () => {
    const context = setup({ sendTestMessage: true }); await context.start();
    const messages = context.hcu.ofType('CREATE_USER_MESSAGE_REQUEST');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.body).toMatchObject({ title: { de: 'TEST: go-e Lastmanagement' },
      behaviorType: 'ACKNOWLEDGEABLE_BY_YES_NO', messageCategory: 'WARN' });
    expect(JSON.stringify(messages[0]?.body['message'])).toContain('Es wurden keine Einstellungen an den Wallboxen verändert');
    expect(context.app.dryRun).toBeNull();
    expect(context.probe).not.toHaveBeenCalled();
    context.hcu.acknowledge(questionId(context), 'YES'); await flush();
    expect(context.app.snapshot.engine).toBeNull();
    expect(context.hcu.ofType('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(1);
  });

  it('the separate DRY_RUN start actually enables scheduled read-only observations', async () => {
    const context = setup({ mode: 'DRY_RUN' }); await context.start(false);
    expect(context.probe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(context.probe).toHaveBeenCalledOnce();
    expect(context.app.snapshot.engine?.state).toBe('TRIGGER_PENDING');
    context.clock.time = 4000;
    await vi.advanceTimersByTimeAsync(4000);
    expect(context.probe).toHaveBeenCalledTimes(2);
    expect(context.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(0);
  });

  it('the real 22.839 kW case generates Garage 13 A and exactly one TEST YES/NO question', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network allowed in this test'));
    const context = setup({ mode: 'DRY_RUN' }); await context.start();
    expect((await context.step(0)).engine?.state).toBe('TRIGGER_PENDING');
    expect((await context.step(29_999)).lastDecision?.action).toBeNull();
    expect(context.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(0);
    const snapshot = await context.step(30_000);
    expect(snapshot).toMatchObject({ mode: 'DRY_RUN', engine: { state: 'LIMITING', gridImportW: 22_839 },
      lastAction: { type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 13 }, realChargerWritesEnabled: false });
    expect(context.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(1);
    expect(context.app.dryRun?.journal.entries).toHaveLength(1);
    const realGarage = snapshot.probe?.chargers.find((charger) => charger.config.id === 'garage');
    if (realGarage?.status !== 'reachable') throw new Error('Expected Garage observation');
    expect(realGarage.value).toMatchObject({ effectiveCurrentA: 14, temporaryCurrentLimitA: null, forceState: 0 });
    await context.step(34_000); await context.step(38_000);
    expect(context.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('YES activates override and returns only a virtual limit-clear action', async () => {
    const context = setup({ mode: 'DRY_RUN' }); await context.start(); await trigger(context);
    const id = questionId(context);
    context.hcu.acknowledge(id, 'YES'); await flush();
    expect(context.app.dryRun?.engine.snapshot).toMatchObject({ state: 'OVERRIDE', overrideActive: true });
    expect(context.hcu.userMessages.has(id)).toBe(false);
    expect(context.hcu.ofType('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(1);
    const snapshot = await context.step(34_000);
    expect(snapshot.lastDecision?.action).toEqual({ type: 'CLEAR_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage' });
    expect(snapshot.lastHcuAnswer).toContain('YES');
    expect((await context.step(38_000)).engine?.overrideActive).toBe(true);
    expect(context.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(1);
  });

  it('YES after virtual pause first resumes, then clears the owned limit in a later cycle', async () => {
    const context = setup({ mode: 'DRY_RUN' }); await context.start(); await trigger(context);
    for (let timestamp = 34_000; timestamp <= 62_000; timestamp += 4000) await context.step(timestamp);
    expect(context.app.snapshot.lastAction).toEqual({ type: 'PAUSE', chargerId: 'garage' });
    context.hcu.acknowledge(questionId(context), 'YES'); await flush();
    expect((await context.step(66_000)).lastDecision?.action).toEqual({ type: 'RESUME', chargerId: 'garage' });
    expect((await context.step(70_000)).lastDecision?.action).toEqual({ type: 'CLEAR_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage' });
    expect(context.app.dryRun?.journal.entries.at(-2)?.action.type).toBe('RESUME');
    expect(context.app.dryRun?.journal.entries.at(-1)?.action.type).toBe('CLEAR_TEMPORARY_CURRENT_LIMIT');
  });

  it('NO completes the question and retains automatic regulation without repeat questions', async () => {
    const context = setup({ mode: 'DRY_RUN' }); await context.start(); await trigger(context);
    context.hcu.acknowledge(questionId(context), 'NO'); await flush();
    expect(context.app.dryRun?.engine.snapshot.overrideActive).toBe(false);
    expect(context.app.interactions.openUserMessageId).toBeNull();
    expect((await context.step(34_000)).lastDecision?.action).toMatchObject({ amps: 12 });
    expect(context.app.snapshot.lastHcuAnswer).toContain('NO');
    expect(context.hcu.ofType('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(1);
    expect(context.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(1);
  });

  it('no acknowledgement leaves automation active and the single question open', async () => {
    const context = setup({ mode: 'DRY_RUN' }); await context.start(); await trigger(context);
    const id = questionId(context);
    expect((await context.step(34_000)).lastDecision?.action).toMatchObject({ amps: 12 });
    expect(context.app.dryRun?.engine.snapshot.overrideActive).toBe(false);
    expect(context.app.interactions.openUserMessageId).toBe(id);
    expect(context.hcu.ofType('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(0);
  });

  it('unassigned IDs and OK cannot activate override or remove the actual question', async () => {
    const context = setup({ mode: 'DRY_RUN' }); await context.start(); await trigger(context);
    const id = questionId(context);
    context.hcu.acknowledge('old-or-foreign-message', 'YES');
    context.hcu.acknowledge(id, 'OK'); await flush();
    expect(context.app.dryRun?.engine.snapshot.overrideActive).toBe(false);
    expect(questionId(context)).toBe(id);
    expect(context.hcu.ofType('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(0);
  });

  it('duplicate YES events apply override and delete the question only once', async () => {
    const context = setup({ mode: 'DRY_RUN' }); await context.start(); await trigger(context);
    const runtime = context.app.dryRun;
    if (runtime === null) throw new Error('Expected dry-run runtime');
    const apply = vi.spyOn(runtime, 'applyManualOverride');
    const id = questionId(context);
    context.hcu.acknowledge(id, 'YES'); context.hcu.acknowledge(id, 'YES'); await flush();
    expect(apply).toHaveBeenCalledOnce();
    expect(context.hcu.ofType('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(1);
  });

  it('reconnect reports readiness, lists the original question and does not duplicate it', async () => {
    const context = setup({ mode: 'DRY_RUN' }); await context.start(); await trigger(context);
    const id = questionId(context);
    context.hcu.socket().emit('close');
    await context.step(34_000);
    expect(context.app.snapshot.engine?.overrideActive).toBe(false);
    await vi.advanceTimersByTimeAsync(1000); context.hcu.socket().emit('open'); await flush();
    expect(context.client.state).toBe('READY');
    expect(context.hcu.ofType('PLUGIN_STATE_RESPONSE')).toHaveLength(2);
    expect(context.hcu.ofType('LIST_USER_MESSAGES_REQUEST')).toHaveLength(1);
    expect(context.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(1);
    expect(questionId(context)).toBe(id);
    context.hcu.acknowledge(id, 'YES'); await flush();
    expect(context.app.snapshot.engine?.overrideActive).toBe(true);
  });

  it('a question missing after reconnect is recreated with the same id, never a second identity', async () => {
    const context = setup({ mode: 'DRY_RUN' }); await context.start(); await trigger(context);
    const id = questionId(context);
    context.hcu.userMessages.delete(id);
    context.hcu.socket().emit('close'); await vi.advanceTimersByTimeAsync(1000);
    context.hcu.socket().emit('open'); await flush();
    const creates = context.hcu.ofType('CREATE_USER_MESSAGE_REQUEST');
    expect(creates).toHaveLength(2);
    expect(creates.map((message) => message.body['userMessageId'])).toEqual([id, id]);
    expect(context.hcu.userMessages.size).toBe(1);
  });

  it('an intervention while HCU is offline continues simulation and restores one question on reconnect', async () => {
    const context = setup({ mode: 'DRY_RUN' }); await context.start();
    context.hcu.socket().emit('close');
    const snapshot = await trigger(context);
    expect(snapshot.lastAction).toMatchObject({ amps: 13 });
    expect(snapshot.engine?.overrideActive).toBe(false);
    const id = questionId(context);
    expect(context.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(0);
    expect((await context.step(34_000)).lastDecision?.action).toMatchObject({ amps: 12 });
    await vi.advanceTimersByTimeAsync(1000); context.hcu.socket().emit('open'); await flush();
    expect(context.hcu.ofType('LIST_USER_MESSAGES_REQUEST')).toHaveLength(1);
    expect(context.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toMatchObject([{ body: { userMessageId: id } }]);
    expect(context.hcu.userMessages.size).toBe(1);
  });

  it('an explicit session-end event ends override and re-arms the next simulated session', async () => {
    const context = setup({ mode: 'DRY_RUN' }); await context.start(); await trigger(context);
    const oldId = questionId(context);
    context.hcu.acknowledge(oldId, 'YES'); await flush();
    await context.step(34_000); await context.step(38_000);
    await context.app.endSession();
    expect(context.app.dryRun?.engine.snapshot.overrideActive).toBe(false);
    await context.step(42_000);
    await context.step(46_000);
    await context.step(76_000);
    expect(context.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(2);
    expect(questionId(context)).not.toBe(oldId);
    context.hcu.acknowledge(oldId, 'YES'); await flush();
    expect(context.app.dryRun?.engine.snapshot.overrideActive).toBe(false);
  });

  it('HCUweb diagnosis shows the actual Grid, hypothetical action and disabled real writes', async () => {
    const context = setup({ mode: 'DRY_RUN' }); await context.start(); await trigger(context);
    const observations = context.probe.mock.calls.length;
    const response = context.hcu.next('CONFIG_TEMPLATE_RESPONSE');
    context.hcu.receive('CONFIG_TEMPLATE_REQUEST', { languageCode: 'de' });
    expect(await response).toMatchObject({ body: { properties: {
      'diagnostics.engineState': { currentValue: 'LIMITING' },
      'diagnostics.gridImportW': { currentValue: '22839' },
      'diagnostics.targetGridW': { currentValue: '18500' },
      'diagnostics.lastAction': { currentValue: 'SET_TEMPORARY_CURRENT_LIMIT garage 13 A' },
      'diagnostics.executionMode': { currentValue: 'DRY_RUN' },
      'diagnostics.realChargerWrites': { currentValue: 'disabled' },
      'chargers.garage.amp': { currentValue: '14' },
      'chargers.garage.tcl': { currentValue: 'unavailable' },
    } } });
    expect(context.probe).toHaveBeenCalledTimes(observations);
  });

  it('a later controller warning replaces the old question in last-HCU-message diagnostics', async () => {
    const context = setup({ mode: 'DRY_RUN', notifications: { controllerConnectionError: true } });
    await context.start(); await trigger(context);
    expect(context.app.snapshot.lastHcuMessage).toContain('go-e Lastmanagement');
    context.probe.mockResolvedValueOnce({ ...realReport(context.config), controller: failure('ConnectionError', 'Controller unavailable') });
    const snapshot = await context.step(34_000);
    expect(snapshot.engine?.state).toBe('FAULT');
    expect(snapshot.lastHcuMessage).toBe('TEST: go-e Verbindungswarnung (controller)');
    expect(snapshot.lastDecision?.action).toBeNull();
    expect(context.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(2);
    const response = context.hcu.next('CONFIG_TEMPLATE_RESPONSE');
    context.hcu.receive('CONFIG_TEMPLATE_REQUEST', { languageCode: 'de' });
    expect(await response).toMatchObject({ body: { properties: {
      'diagnostics.lastHcuMessage': { currentValue: 'TEST: go-e Verbindungswarnung (controller)' },
    } } });
  });

  it.each([{ intervention: false }, { interactive: false }])('notification settings %j suppress the HCU question, not the engine', async (notifications) => {
    const context = setup({ mode: 'DRY_RUN', notifications }); await context.start();
    expect((await trigger(context)).lastAction).toMatchObject({ amps: 13 });
    expect(context.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(0);
    expect(context.app.dryRun?.engine.snapshot.overrideActive).toBe(false);
  });
});
