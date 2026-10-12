import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, ChargerConfig } from '../../../src/config/config-types.js';
import type { ChargerProbeResult, ProbeReport } from '../../../src/diagnostics/probe-service.js';
import { mapCarState } from '../../../src/domain/charger.js';
import { failure, success, type Result } from '../../../src/domain/errors.js';
import { ChargerActuator } from '../../../src/goe/control/charger-actuator.js';
import type { ChargerControlClient, ControlObservation } from '../../../src/goe/control/control-types.js';
import type { OwnershipDocument } from '../../../src/goe/control/ownership-state.js';
import type { InteractionDocument, InteractionStateStore } from '../../../src/hcu/messages/interaction-state.js';
import { validateInteractionDocument } from '../../../src/hcu/messages/interaction-state.js';
import type { HcuEnvelope } from '../../../src/hcu/message-types.js';
import { PLUGIN_ID } from '../../../src/hcu/plugin-identity.js';
import { HcuWebSocketClient, type HcuWebSocketFactory } from '../../../src/hcu/websocket-client.js';
import { HcuPluginApplication } from '../../../src/orchestration/hcu-plugin-application.js';
import { controller, makeCharger, makeConfig } from '../load-management/helpers.js';
import { makeObservation } from '../goe/control/ownership-helpers.js';
import { fakeFactory, type FakeSocket, SequenceIds, transportSettings } from '../hcu/transport-helpers.js';

type Captured = HcuEnvelope & { readonly body: Readonly<Record<string, unknown>> };
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function captured(payload: string): Captured {
  const value: unknown = JSON.parse(payload);
  if (!record(value) || typeof value['id'] !== 'string' || typeof value['pluginId'] !== 'string'
    || typeof value['type'] !== 'string' || (value['body'] !== undefined && !record(value['body']))) {
    throw new Error('Invalid mock HCU envelope');
  }
  return { id: value['id'], pluginId: value['pluginId'], type: value['type'], body: value['body'] ?? {} };
}

class MemoryMessages implements InteractionStateStore {
  document: InteractionDocument | null = null;
  async load(): Promise<Result<InteractionDocument | null>> { return success(structuredClone(this.document)); }
  async save(document: InteractionDocument): Promise<Result<void>> {
    const validated = validateInteractionDocument(document);
    if (!validated.ok) return validated;
    this.document = structuredClone(validated.value);
    return success(undefined);
  }
}

class MockHcu {
  readonly messages: Captured[] = [];
  readonly sockets = fakeFactory();
  readonly factory: HcuWebSocketFactory;
  refuseDelete = false;
  holdCreateResponses = false;
  #event = 0;
  constructor(readonly userMessages: Map<string, number>) {
    this.factory = (url, options) => {
      const socket = this.sockets.factory(url, options) as FakeSocket;
      const send = socket.send.bind(socket);
      socket.send = (payload) => {
        send(payload);
        const message = captured(payload);
        this.messages.push(message);
        void Promise.resolve().then(() => this.respond(socket, message));
      };
      return socket;
    };
  }
  get socket(): FakeSocket {
    const socket = this.sockets.sockets.at(-1);
    if (socket === undefined) throw new Error('Mock socket not started');
    return socket;
  }
  ofType(type: string): Captured[] { return this.messages.filter((message) => message.type === type); }
  emit(type: string, body: Readonly<Record<string, unknown>>): void {
    this.socket.emit('message', JSON.stringify({ id: `event-${++this.#event}`, pluginId: PLUGIN_ID, type, body }));
  }
  private respond(socket: FakeSocket, message: Captured): void {
    if (socket.readyState !== 1) return;
    const id = message.body['userMessageId'];
    let type: string;
    let body: Readonly<Record<string, unknown>>;
    switch (message.type) {
      case 'CREATE_USER_MESSAGE_REQUEST':
        if (typeof id !== 'string' || typeof message.body['timestamp'] !== 'number') throw new Error('Malformed mock create');
        this.userMessages.set(id, message.body['timestamp']);
        if (this.holdCreateResponses) return;
        type = 'CREATE_USER_MESSAGE_RESPONSE'; body = { success: true, userMessageId: id }; break;
      case 'DELETE_USER_MESSAGE_REQUEST':
        if (typeof id !== 'string') throw new Error('Malformed mock delete');
        if (!this.refuseDelete) this.userMessages.delete(id);
        type = 'DELETE_USER_MESSAGE_RESPONSE'; body = { success: !this.refuseDelete, userMessageId: id }; break;
      case 'LIST_USER_MESSAGES_REQUEST':
        type = 'LIST_USER_MESSAGES_RESPONSE'; body = { userMessageMap: Object.fromEntries(this.userMessages) }; break;
      default: return;
    }
    socket.emit('message', JSON.stringify({ id: message.id, pluginId: message.pluginId, type, body }));
  }
}

interface SharedState {
  config: AppConfig;
  ownership: OwnershipDocument | null;
  messages: MemoryMessages;
  remoteMessages: Map<string, number>;
  observations: Map<string, ControlObservation>;
}

function sharedState(enabled = true): SharedState {
  const config: AppConfig = { ...makeConfig({ loadManagement: { liveControlEnabled: enabled } }),
    notifications: { intervention: true, interactive: true, controllerConnectionError: false, chargerConnectionError: false } };
  return { config, ownership: null, messages: new MemoryMessages(), remoteMessages: new Map(),
    observations: new Map(config.chargers.filter((charger) => charger.enabled).map((charger) => [charger.id,
      makeObservation({ chargerId: charger.id, host: charger.host, ama: 32, firmwareVersion: '59.4',
        tclClearCapability: 'VERIFIED', ...(charger.id === 'garage' ? {} : { car: 1, acu: null, alw: false }) })])) };
}

const applications: HcuPluginApplication[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.stop()));
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function flush(): Promise<void> { for (let index = 0; index < 100; index += 1) await Promise.resolve(); }

function processFixture(shared = sharedState(), options: { now?: number; prefix?: string; pluginId?: string } = {}) {
  const clock = { now: options.now ?? 0 };
  const hcu = new MockHcu(shared.remoteMessages);
  const actual = (id: string) => {
    const state = shared.observations.get(id);
    if (state === undefined) throw new Error('Unknown mock charger');
    return state;
  };
  const patch = (id: string, fields: Partial<ControlObservation>) => shared.observations.set(id, { ...actual(id), ...fields });
  const writes = {
    setTemporaryCurrentLimit: vi.fn(async (charger: ChargerConfig, amps: number): Promise<Result<void>> => {
      patch(charger.id, { tcl: amps, acu: amps }); return success(undefined);
    }),
    clearTemporaryCurrentLimit: vi.fn(async (charger: ChargerConfig): Promise<Result<void>> => {
      patch(charger.id, { tcl: null, acu: actual(charger.id).amp }); return success(undefined);
    }),
    pause: vi.fn(async (charger: ChargerConfig): Promise<Result<void>> => {
      patch(charger.id, { frc: 1, car: 4, acu: null, alw: false }); return success(undefined);
    }),
    resume: vi.fn(async (charger: ChargerConfig): Promise<Result<void>> => {
      patch(charger.id, { frc: 0, car: 2, acu: actual(charger.id).tcl ?? actual(charger.id).amp, alw: true }); return success(undefined);
    }),
  };
  const controls: ChargerControlClient = { ...writes, readStatus: vi.fn(async (charger) =>
    success({ ...actual(charger.id), readStartedAtMs: clock.now, observedAtMs: clock.now })) };
  const actuator = new ChargerActuator({ client: controls, gate: { executionMode: 'LIVE', realWritesEnabled: true },
    now: () => clock.now, sleep: async () => undefined, store: { load: async () => success(structuredClone(shared.ownership)),
      save: async (document) => { shared.ownership = structuredClone(document); return success(undefined); } } });
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.hostname !== 'controller.test' || url.pathname !== '/api/status') throw new Error('Unexpected real HTTP request');
    return new Response(JSON.stringify({ ccn: ['Grid'], ccp: [22_839], cpc: [[null, null, null, null]] }));
  });
  vi.stubGlobal('fetch', fetchMock);
  const probe = vi.fn(async (config: AppConfig): Promise<ProbeReport> => ({ controller: success(controller(22_839)),
    chargers: config.chargers.map((charger): ChargerProbeResult => {
      if (!charger.enabled) return { status: 'disabled', reachable: false, config: charger };
      const current = actual(charger.id);
      return { status: 'reachable', reachable: true, config: charger,
        value: makeCharger(charger.id, { host: current.host, configuredCurrentA: current.amp, effectiveCurrentA: current.acu,
          temporaryCurrentLimitA: current.tcl, forceState: current.frc, carState: mapCarState(current.car),
          chargingAllowed: current.alw, maximumCurrentA: current.ama, minimumCurrentA: current.mca,
          allowChargingPause: current.acp, minimumChargingPauseDuration: current.mcpd }) };
    }) }));
  const client = new HcuWebSocketClient({ ...transportSettings, pluginId: options.pluginId ?? PLUGIN_ID,
    idProvider: new SequenceIds(), webSocketFactory: hcu.factory });
  let sequence = 0;
  const create = () => new HcuPluginApplication({ client, config: shared.config, mode: 'INSTALLED_LIVE',
    realWritesEnabled: true, liveActuator: actuator, interactionStore: shared.messages,
    now: () => clock.now, idProvider: { nextId: () => `${options.prefix ?? 'first'}-${++sequence}` }, probe,
    store: { load: async () => success(structuredClone(shared.config)),
      save: async (config) => { shared.config = structuredClone(config); return success(undefined); } } });
  const app = create();
  applications.push(app);
  return { shared, clock, hcu, controls, actuator, writes, fetchMock, app, client, create, probe,
    countWrites: () => Object.values(writes).reduce((total, write) => total + write.mock.calls.length, 0),
    start: async () => { expect((await app.initialize()).ok).toBe(true); app.start(); hcu.socket.emit('open'); await flush(); },
    step: async (now: number) => { clock.now = now; const result = await app.installed!.tick(); await flush(); return result; },
  };
}

async function trigger(f: ReturnType<typeof processFixture>) {
  await f.start();
  for (const now of [0, 4_000, 8_000, 12_000, 16_000, 20_000, 24_000, 28_000, 30_000]) await f.step(now);
  expect(f.countWrites()).toBe(1);
  const id = f.app.interactions.openUserMessageId;
  if (id === null) throw new Error('Expected productive intervention question');
  return id;
}

describe('installed application persistence and HCU integration', () => {
  it('durable family YES survives harmless HCU config update, stop and restart without extra messages', async () => {
    const first = processFixture();
    const id = await trigger(first);
    first.hcu.emit('USER_MESSAGE_ACK_EVENT', { userMessageId: id, ackType: 'YES' });
    await flush();
    expect(first.app.installed!.engine.snapshot.overrideActive).toBe(true);
    expect(first.shared.messages.document?.session.overrideActive).toBe(true);
    expect(first.hcu.ofType('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(1);
    first.hcu.emit('CONFIG_UPDATE_REQUEST', { properties: { 'loadManagement.gridLimitW': 20_000 } });
    await flush();
    expect(first.hcu.ofType('CONFIG_UPDATE_RESPONSE').at(-1)?.body['status']).toBe('APPLIED');
    expect(first.app.installed!.engine.snapshot.overrideActive).toBe(true);
    expect(first.shared.messages.document?.session.overrideActive).toBe(true);
    expect(first.hcu.ofType('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(1);
    expect(first.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(1);
    await first.app.stop();
    const restarted = processFixture(first.shared, { now: 40_000, prefix: 'restart' });
    await restarted.start();
    expect(restarted.app.installed!.engine.snapshot.overrideActive).toBe(true);
    expect(restarted.app.snapshot.lastHcuAnswer).toContain('YES');
    expect(restarted.shared.config.loadManagement.gridLimitW).toBe(20_000);
    expect(restarted.countWrites()).toBe(0);
    expect(restarted.hcu.ofType('LIST_USER_MESSAGES_REQUEST')).toHaveLength(1);
    expect(restarted.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(0);
    expect(restarted.hcu.ofType('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(0);
  });

  it('restores known OPEN question diagnostics, production friendly name and same ID across restart', async () => {
    const first = processFixture();
    const id = await trigger(first);
    await first.app.stop();
    expect(first.shared.remoteMessages.has(id)).toBe(true);
    const restarted = processFixture(first.shared, { now: 40_000, prefix: 'restart' });
    await restarted.start();
    expect(restarted.app.snapshot.openInterventionMessage).toBe(id);
    expect(restarted.app.snapshot.lastHcuMessage).toContain(id);
    expect(restarted.app.snapshot.messageStatePersistenceError).toBe(null);
    expect(restarted.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(0);
    expect(restarted.hcu.ofType('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(0);
    expect(restarted.hcu.ofType('PLUGIN_STATE_RESPONSE')[0]?.body['friendlyName']).toEqual({ de: 'go-e Lastmanagement', en: 'go-e load management' });
    expect(JSON.stringify(restarted.hcu.ofType('PLUGIN_STATE_RESPONSE'))).not.toMatch(/TEST|Dry.Run/u);
  });

  it('a harmless HCUweb update preserves the current OPEN question and its explicit session', async () => {
    const f = processFixture();
    const id = await trigger(f);
    const sessionId = f.shared.messages.document?.session.sessionId;
    f.hcu.emit('CONFIG_UPDATE_REQUEST', { properties: { 'loadManagement.safetyReserveW': 600 } });
    await flush();
    expect(f.hcu.ofType('CONFIG_UPDATE_RESPONSE').at(-1)?.body['status']).toBe('APPLIED');
    expect(f.app.snapshot.openInterventionMessage).toBe(id);
    expect(f.shared.messages.document?.session.sessionId).toBe(sessionId);
    expect(f.hcu.ofType('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(0);
    expect(f.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(1);
  });

  it('restores durable override before an offline HCU and allows only stable local owned cleanup', async () => {
    const first = processFixture();
    const id = await trigger(first);
    first.hcu.emit('USER_MESSAGE_ACK_EVENT', { userMessageId: id, ackType: 'YES' });
    await flush();
    await first.app.stop();
    const restarted = processFixture(first.shared, { now: 40_000, prefix: 'restart' });
    expect((await restarted.app.initialize()).ok).toBe(true);
    expect(restarted.app.installed!.engine.snapshot.overrideActive).toBe(true);
    expect(restarted.client.state).toBe('DISCONNECTED');
    expect(restarted.hcu.messages).toHaveLength(0);
    expect(restarted.countWrites()).toBe(0);
    restarted.app.start();
    // The mock socket deliberately stays unopened: local health does not depend on HCU.
    for (const now of [40_000, 44_000, 48_000]) await restarted.step(now);
    expect(restarted.countWrites()).toBe(0);
    await restarted.step(52_000);
    expect(restarted.writes.clearTemporaryCurrentLimit).toHaveBeenCalledTimes(1);
    expect(restarted.writes.setTemporaryCurrentLimit).not.toHaveBeenCalled();
    expect(restarted.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(0);
    expect(restarted.app.installed!.engine.snapshot.overrideActive).toBe(true);
  });

  it('startup cleans a known TEST question once without producing TEST text or a new automatic question', async () => {
    const shared = sharedState(false);
    shared.messages.document = { version: 1, pluginId: PLUGIN_ID,
      session: { sessionId: 'old-test-session', interventionRequested: true, overrideActive: false },
      messages: [{ userMessageId: 'old-test-question', sessionId: 'old-test-session', messagePurpose: 'TEST_INTERVENTION',
        createdAt: 100, state: 'OPEN', answer: null }] };
    shared.remoteMessages.set('old-test-question', 100);
    const f = processFixture(shared);
    await f.start();
    await f.step(0);
    expect(f.hcu.ofType('DELETE_USER_MESSAGE_REQUEST').map((message) => message.body['userMessageId'])).toEqual(['old-test-question']);
    expect(f.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(0);
    expect(f.app.snapshot.openInterventionMessage).toBe(null);
    expect(f.app.snapshot.lastHcuMessage).toBe(null);
    expect(f.countWrites()).toBe(0);
  });

  it('rejects foreign installed plugin namespace before any socket or device I/O', () => {
    expect(() => processFixture(sharedState(), { pluginId: 'foreign.plugin' })).toThrow('Installed plugin identity mismatch');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('the shared installed tick retries stale message cleanup only after sixty seconds without a delete loop', async () => {
    const shared = sharedState(false);
    shared.remoteMessages.set('old-test-orphan', 100);
    const f = processFixture(shared);
    f.hcu.refuseDelete = true;
    await f.start();
    expect(f.hcu.ofType('LIST_USER_MESSAGES_REQUEST')).toHaveLength(1);
    expect(f.hcu.ofType('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(1);
    await f.step(0);
    await f.step(59_999);
    expect(f.hcu.ofType('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(1);
    f.hcu.refuseDelete = false;
    await f.step(60_000);
    expect(f.hcu.ofType('LIST_USER_MESSAGES_REQUEST')).toHaveLength(2);
    expect(f.hcu.ofType('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(2);
    await f.step(60_001);
    expect(f.hcu.ofType('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(2);
    expect(shared.remoteMessages.size).toBe(0);
    expect(f.countWrites()).toBe(0);
  });

  it('shutdown immediately fences new questions while preserving the existing OPEN question and timers stop', async () => {
    const f = processFixture();
    const id = await trigger(f);
    const creates = f.hcu.ofType('CREATE_USER_MESSAGE_REQUEST').length;
    const stopping = f.app.stop();
    expect((await f.app.interactions.requestIntervention()).ok).toBe(false);
    await stopping;
    expect(f.shared.messages.document?.messages.find((message) => message.userMessageId === id)?.state).toBe('OPEN');
    expect(f.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(creates);
    expect(f.hcu.ofType('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(0);
    expect(f.shared.remoteMessages.has(id)).toBe(true);
    const writes = f.countWrites();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.countWrites()).toBe(writes);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pending HCU CREATE acknowledgement never blocks the next four-second decision or duplicates the question', async () => {
    const f = processFixture();
    f.hcu.holdCreateResponses = true;
    const id = await trigger(f);
    expect(f.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(1);
    expect(f.app.snapshot.openInterventionMessage).toBe(id);
    // No CREATE response is emitted and no request timeout is advanced. A new
    // explicit four-second sample still reaches the actual actuator/readback.
    await f.step(34_000);
    expect(f.countWrites()).toBe(2);
    expect(f.writes.setTemporaryCurrentLimit.mock.calls.map(([, amps]) => amps)).toEqual([13, 12]);
    expect(f.app.snapshot.observedAtMs).toBe(34_000);
    expect(f.app.snapshot.telemetryHealth?.healthy).toBe(true);
    expect(f.shared.ownership?.chargers.find((state) => state.chargerId === 'garage')?.pluginOwnedTcl).toBe(12);
    expect(f.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(1);
    expect(f.hcu.ofType('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(0);
    await f.app.stop();
    expect(f.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(1);
    expect(f.hcu.ofType('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(0);
    expect(f.shared.messages.document?.messages.find((message) => message.userMessageId === id)?.state).toBe('OPEN');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an unanswered HCU warning never stalls fresh telemetry after controller health recovers', async () => {
    const shared = sharedState();
    shared.config = { ...shared.config, notifications: { intervention: true, interactive: true,
      controllerConnectionError: true, chargerConnectionError: false } };
    const f = processFixture(shared);
    f.hcu.holdCreateResponses = true;
    f.probe.mockImplementationOnce(async () => ({ controller: failure('ConnectionError', 'Mock controller offline'), chargers: [] }));
    await f.start();
    await f.step(0);
    expect(f.app.snapshot.telemetryHealth?.healthy).toBe(false);
    expect(f.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(1);
    expect(f.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')[0]?.body['behaviorType']).toBe('DISMISSIBLE');
    expect(JSON.stringify(f.hcu.ofType('CREATE_USER_MESSAGE_REQUEST'))).not.toMatch(/TEST|Dry.Run/u);
    await f.step(4_000);
    expect(f.app.snapshot.observedAtMs).toBe(4_000);
    expect(f.app.snapshot.telemetryHealth?.healthy).toBe(true);
    expect(f.app.snapshot.telemetryHealth?.recoveryAllowed).toBe(false);
    expect(f.probe).toHaveBeenCalledTimes(2);
    expect(f.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(1);
    expect(f.countWrites()).toBe(0);
    await f.app.stop();
    expect(f.hcu.ofType('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
