import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, ChargerConfig } from '../../../src/config/config-types.js';
import type { ChargerProbeResult, ProbeReport } from '../../../src/diagnostics/probe-service.js';
import { mapCarState } from '../../../src/domain/charger.js';
import { success, type Result } from '../../../src/domain/errors.js';
import { ChargerActuator } from '../../../src/goe/control/charger-actuator.js';
import type { ChargerControlClient, ControlObservation } from '../../../src/goe/control/control-types.js';
import type { OwnershipDocument } from '../../../src/goe/control/ownership-state.js';
import type { HcuEnvelope } from '../../../src/hcu/message-types.js';
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
  if (!record(value) || typeof value.id !== 'string' || typeof value.pluginId !== 'string' || typeof value.type !== 'string'
    || value.body !== undefined && !record(value.body)) throw new Error('Invalid mocked HCU message');
  return { id: value.id, pluginId: value.pluginId, type: value.type, body: value.body ?? {} };
}

/** Real application/transport; only the remote HCU surface is replaced. */
class MockHcu {
  readonly messages: Captured[] = [];
  readonly userMessages = new Map<string, number>();
  readonly sockets = fakeFactory();
  readonly factory: HcuWebSocketFactory;
  #event = 0;

  constructor() {
    this.factory = (url, options) => {
      const socket = this.sockets.factory(url, options) as FakeSocket;
      const send = socket.send.bind(socket);
      socket.send = (payload: string) => {
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
    if (socket === undefined) throw new Error('Mocked HCU socket unavailable');
    return socket;
  }

  ofType(type: string): Captured[] { return this.messages.filter(message => message.type === type); }
  ack(userMessageId: string, ackType: 'YES' | 'NO' | 'OK'): void {
    this.socket.emit('message', JSON.stringify({ id: `ack-${++this.#event}`, pluginId: transportSettings.pluginId,
      type: 'USER_MESSAGE_ACK_EVENT', body: { userMessageId, ackType } }));
  }

  private respond(socket: FakeSocket, message: Captured): void {
    if (socket.readyState !== 1) return;
    const id = message.body['userMessageId'];
    let type: string;
    let body: Readonly<Record<string, unknown>>;
    switch (message.type) {
      case 'CREATE_USER_MESSAGE_REQUEST':
        if (typeof id !== 'string' || typeof message.body['timestamp'] !== 'number') throw new Error('Malformed Create');
        this.userMessages.set(id, message.body['timestamp']);
        type = 'CREATE_USER_MESSAGE_RESPONSE'; body = { success: true, userMessageId: id }; break;
      case 'DELETE_USER_MESSAGE_REQUEST':
        if (typeof id !== 'string') throw new Error('Malformed Delete');
        this.userMessages.delete(id);
        type = 'DELETE_USER_MESSAGE_RESPONSE'; body = { success: true, userMessageId: id }; break;
      case 'LIST_USER_MESSAGES_REQUEST':
        type = 'LIST_USER_MESSAGES_RESPONSE'; body = { userMessageMap: Object.fromEntries(this.userMessages) }; break;
      default: return;
    }
    socket.emit('message', JSON.stringify({ id: message.id, pluginId: message.pluginId, type, body }));
  }
}

async function flush(): Promise<void> { for (let index = 0; index < 40; index += 1) await Promise.resolve(); }
const applications: HcuPluginApplication[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  await Promise.all(applications.splice(0).map(application => application.stop()));
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup() {
  const config: AppConfig = { ...makeConfig(), notifications: { intervention: true, interactive: true,
    controllerConnectionError: false, chargerConnectionError: false } };
  const clock = { now: 0 };
  const hcu = new MockHcu();
  const observations = new Map<string, ControlObservation>(config.chargers.filter(charger => charger.enabled).map(charger => [charger.id,
    makeObservation({ chargerId: charger.id, host: charger.host, ama: 32,
      ...(charger.id === 'garage' ? {} : { car: 1, acu: null, alw: false }) })]));
  const actual = (id: string): ControlObservation => {
    const value = observations.get(id);
    if (value === undefined) throw new Error('Unknown mocked charger');
    return value;
  };
  const patch = (id: string, fields: Partial<ControlObservation>): void => { observations.set(id, { ...actual(id), ...fields }); };
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
  const controls: ChargerControlClient = { ...writes, readStatus: vi.fn(async (charger: ChargerConfig) =>
    success({ ...actual(charger.id), readStartedAtMs: clock.now, observedAtMs: clock.now })) };
  let saved: OwnershipDocument | null = null;
  const actuator = new ChargerActuator({ client: controls, gate: { executionMode: 'LIVE', realWritesEnabled: true },
    now: () => clock.now, sleep: async () => undefined, store: {
      load: async () => success(saved), save: async document => { saved = structuredClone(document); return success(undefined); },
    } });
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ccn: ['Grid'], ccp: [22_839], cpc: [[null, null, null, null]] })));
  // Native fetch is forbidden: only the controller status read has a mocked response.
  fetchMock.mockImplementation(async input => {
    const url = new URL(String(input));
    if (url.hostname !== 'controller.test' || url.pathname !== '/api/status') throw new Error('Unexpected real HTTP path');
    return new Response(JSON.stringify({ ccn: ['Grid'], ccp: [22_839], cpc: [[null, null, null, null]] }));
  });
  vi.stubGlobal('fetch', fetchMock);
  const probe = vi.fn(async (currentConfig: AppConfig): Promise<ProbeReport> => ({ controller: success(controller(22_839)),
    chargers: currentConfig.chargers.map((charger): ChargerProbeResult => {
      if (!charger.enabled) return { status: 'disabled', reachable: false, config: charger };
      const status = actual(charger.id);
      return { status: 'reachable', reachable: true, config: charger, value: makeCharger(charger.id, {
        host: status.host, configuredCurrentA: status.amp, effectiveCurrentA: status.acu, temporaryCurrentLimitA: status.tcl,
        forceState: status.frc, carState: mapCarState(status.car), chargingAllowed: status.alw, maximumCurrentA: status.ama,
        minimumCurrentA: status.mca, allowChargingPause: status.acp, minimumChargingPauseDuration: status.mcpd,
      }) };
    }),
  }));
  const client = new HcuWebSocketClient({ ...transportSettings, idProvider: new SequenceIds(), webSocketFactory: hcu.factory });
  const app = new HcuPluginApplication({ client, config, mode: 'LIVE', realWritesEnabled: true, liveActuator: actuator,
    idProvider: new SequenceIds(), now: () => clock.now, probe,
    store: { load: async () => success(config), save: async () => success(undefined) } });
  applications.push(app);
  return { app, hcu, client, actuator, writes, clock, fetchMock,
    writeCount: () => Object.values(writes).reduce((count, write) => count + write.mock.calls.length, 0),
    start: async () => { expect((await app.live!.initialize()).ok).toBe(true); app.start(); hcu.socket.emit('open'); await flush(); },
    step: async (timestamp: number) => { clock.now = timestamp; return app.live!.observe(); },
    execute: async () => {
      const pending = app.live!.engine.snapshot.pendingAction;
      if (pending === null) throw new Error('Expected a pending abstract action');
      const result = await app.live!.executePendingAction(pending.id); await flush(); return result;
    },
  };
}

async function trigger(h: ReturnType<typeof setup>): Promise<void> {
  await h.start();
  for (const timestamp of [0, 4000, 8000, 12_000, 16_000, 20_000, 24_000, 28_000, 30_000]) await h.step(timestamp);
}
function questionId(h: ReturnType<typeof setup>): string {
  const id = h.app.interactions.openUserMessageId;
  if (id === null) throw new Error('Expected a LIVE intervention question');
  return id;
}

describe('LIVE HCU application with mocked HCU and actual actuator orchestration', () => {
  it('emits no intervention for a merely abstract action, then one LIVE YES/NO question after confirmed readback', async () => {
    const h = setup(); await trigger(h);
    expect(h.app.live!.engine.snapshot.pendingAction?.action).toEqual({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 13 });
    expect(h.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(0);
    expect(h.writeCount()).toBe(0);
    expect(await h.execute()).toMatchObject({ ok: true, value: { status: 'CONFIRMED' } });
    const questions = h.hcu.ofType('CREATE_USER_MESSAGE_REQUEST');
    expect(questions).toHaveLength(1);
    expect(questions[0]?.body).toMatchObject({ title: { de: 'go-e Lastmanagement – bestätigter Eingriff' },
      behaviorType: 'ACKNOWLEDGEABLE_BY_YES_NO', messageCategory: 'WARN' });
    expect(JSON.stringify(questions[0]?.body)).not.toMatch(/TEST:|Dry-Run|keine Einstellungen an den Wallboxen verändert/u);
    expect(JSON.stringify(questions[0]?.body)).toContain('JA = Override anfordern');
    expect(h.app.snapshot.lastHcuMessage).not.toContain('TEST');
    await h.step(34_000); await h.execute();
    expect(h.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(1);
  });

  it('accepts the matching YES once, cancels an unsent reduction and never executes cleanup implicitly', async () => {
    const h = setup(); await trigger(h); await h.execute();
    await h.step(34_000);
    const pending = h.app.live!.engine.snapshot.pendingAction;
    expect(pending?.action).toMatchObject({ amps: 12 });
    const override = vi.spyOn(h.app.live!, 'applyManualOverride');
    const cancellation = vi.spyOn(h.actuator, 'cancelPendingOperations');
    const id = questionId(h);
    h.hcu.ack(id, 'YES'); h.hcu.ack(id, 'YES'); h.hcu.ack(id, 'NO'); await flush();
    expect(override).toHaveBeenCalledTimes(1);
    expect(cancellation).toHaveBeenCalledTimes(1);
    expect(h.app.live!.engine.snapshot).toMatchObject({ state: 'OVERRIDE', overrideActive: true, pendingAction: null });
    expect(h.hcu.ofType('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(1);
    expect(h.hcu.userMessages.has(id)).toBe(false);
    expect(h.writeCount()).toBe(1);
    expect(h.writes.clearTemporaryCurrentLimit).not.toHaveBeenCalled();
    expect(await h.app.live!.executePendingAction(pending!.id)).toMatchObject({ ok: false });
    expect(h.app.snapshot.lastHcuAnswer).toContain('YES');
  });

  it('NO preserves automatic regulation and ignores a later contradictory YES for the completed ID', async () => {
    const h = setup(); await trigger(h); await h.execute();
    const id = questionId(h);
    const override = vi.spyOn(h.app.live!, 'applyManualOverride');
    h.hcu.ack(id, 'NO'); await flush(); h.hcu.ack(id, 'YES'); await flush();
    expect(override).not.toHaveBeenCalled();
    expect(h.app.live!.engine.snapshot.overrideActive).toBe(false);
    expect((await h.step(34_000)).lastDecision?.action).toMatchObject({ amps: 12 });
    expect(h.app.snapshot.lastHcuAnswer).toContain('NO');
    expect(h.hcu.ofType('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(1);
    expect(h.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(1);
    expect(h.writeCount()).toBe(1);
  });

  it('unknown, stale-session and OK acknowledgements never grant LIVE consent', async () => {
    const h = setup(); await trigger(h); await h.execute();
    const oldId = questionId(h);
    const override = vi.spyOn(h.app.live!, 'applyManualOverride');
    h.hcu.ack('unknown-message', 'YES'); h.hcu.ack(oldId, 'OK'); await flush();
    expect(override).not.toHaveBeenCalled();
    expect(questionId(h)).toBe(oldId);
    await h.app.endSession(); await flush();
    h.hcu.ack(oldId, 'YES'); h.hcu.ack(oldId, 'NO'); await flush();
    expect(override).not.toHaveBeenCalled();
    expect(h.app.live!.engine.snapshot.overrideActive).toBe(false);
    expect(h.app.interactions.openUserMessageId).toBeNull();
    expect(h.writeCount()).toBe(1);
  });

  it('failed readback never creates a confirmed-intervention question', async () => {
    const h = setup(); await trigger(h);
    h.writes.setTemporaryCurrentLimit.mockImplementationOnce(async () => success(undefined));
    expect(await h.execute()).toMatchObject({ ok: true, value: { status: 'READBACK_MISMATCH' } });
    expect(h.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(0);
    expect(h.app.interactions.openUserMessageId).toBeNull();
    expect(h.app.live!.engine.snapshot.state).toBe('FAULT');
  });

  it('disconnect never implies consent, device cleanup or another write; reconnect reconciles the existing question', async () => {
    const h = setup(); await trigger(h); await h.execute();
    const id = questionId(h);
    const previous = h.hcu.socket;
    previous.emit('close');
    h.hcu.ack(id, 'YES'); await flush();
    expect(h.client.state).toBe('RECONNECTING');
    expect(h.app.live!.engine.snapshot.overrideActive).toBe(false);
    expect(h.writeCount()).toBe(1);
    expect(h.writes.resume).not.toHaveBeenCalled();
    expect(h.writes.clearTemporaryCurrentLimit).not.toHaveBeenCalled();
    expect(h.hcu.ofType('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(0);
    await h.step(34_000);
    expect(h.app.live!.engine.snapshot.pendingAction?.action).toMatchObject({ amps: 12 });
    expect(h.writeCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    h.hcu.socket.emit('open'); await flush();
    expect(h.client.state).toBe('READY');
    expect(questionId(h)).toBe(id);
    expect(h.hcu.ofType('LIST_USER_MESSAGES_REQUEST')).toHaveLength(1);
    expect(h.hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(1);
    expect(h.writeCount()).toBe(1);
    for (const [input, options] of h.fetchMock.mock.calls) {
      expect(new URL(String(input)).pathname).toBe('/api/status');
      expect(options?.method).toBe('GET');
    }
  });
});
