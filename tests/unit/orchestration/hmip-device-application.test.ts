import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHcuInstalledCli } from '../../../src/cli/hcu-installed.js';
import type { AppConfig, ChargerConfig } from '../../../src/config/config-types.js';
import type { ChargerProbeResult, ProbeReport } from '../../../src/diagnostics/probe-service.js';
import { mapCarState } from '../../../src/domain/charger.js';
import { failure, success, type Result } from '../../../src/domain/errors.js';
import { ChargerActuator } from '../../../src/goe/control/charger-actuator.js';
import type { ChargerControlClient, ControlObservation } from '../../../src/goe/control/control-types.js';
import type { OwnershipDocument } from '../../../src/goe/control/ownership-state.js';
import { FileOwnershipStore } from '../../../src/goe/control/ownership-store.js';
import { FileConfigStore } from '../../../src/hcu/config/config-store.js';
import type { InteractionDocument } from '../../../src/hcu/messages/interaction-state.js';
import { FileInteractionStateStore } from '../../../src/hcu/messages/interaction-state-store.js';
import type { HcuEnvelope } from '../../../src/hcu/message-types.js';
import { PLUGIN_ID } from '../../../src/hcu/plugin-identity.js';
import { HcuWebSocketClient, type HcuWebSocketFactory } from '../../../src/hcu/websocket-client.js';
import { createLogger } from '../../../src/logging/logger.js';
import { HcuPluginApplication } from '../../../src/orchestration/hcu-plugin-application.js';
import { makeObservation, makeOwnedState } from '../goe/control/ownership-helpers.js';
import { fakeFactory, type FakeSocket, SequenceIds, transportSettings } from '../hcu/transport-helpers.js';
import { controller, makeCharger, makeConfig } from '../load-management/helpers.js';

const ALL_IDS = ['controller-grid', 'controller-home', 'controller-solar', 'charger-garage', 'charger-links'];
const applications: HcuPluginApplication[] = [];
const directories: string[] = [];

interface CapturedMessage extends HcuEnvelope { readonly body: Readonly<Record<string, unknown>> }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function captured(payload: string): CapturedMessage {
  const value: unknown = JSON.parse(payload);
  if (!record(value) || typeof value['id'] !== 'string' || typeof value['pluginId'] !== 'string'
    || typeof value['type'] !== 'string' || (value['body'] !== undefined && !record(value['body']))) {
    throw new Error('Invalid mock HCU envelope');
  }
  return { id: value['id'], pluginId: value['pluginId'], type: value['type'], body: value['body'] ?? {} };
}

/** A socket boundary only: this fixture never connects to an HCU. */
class MockHcu {
  readonly sockets = fakeFactory();
  readonly messages: CapturedMessage[] = [];
  readonly factory: HcuWebSocketFactory = (url, options) => {
    const socket = this.sockets.factory(url, options) as FakeSocket;
    const send = socket.send.bind(socket);
    socket.send = (payload) => {
      send(payload);
      const message = captured(payload);
      this.messages.push(message);
      if (message.type === 'LIST_USER_MESSAGES_REQUEST') {
        void Promise.resolve().then(() => socket.emit('message', JSON.stringify({ id: message.id,
          pluginId: PLUGIN_ID, type: 'LIST_USER_MESSAGES_RESPONSE', body: { userMessageMap: {} } })));
      }
    };
    return socket;
  };

  get socket(): FakeSocket {
    const socket = this.sockets.sockets.at(-1);
    if (socket === undefined) throw new Error('Mock HCU not started');
    return socket;
  }

  ofType(type: string): CapturedMessage[] { return this.messages.filter(message => message.type === type); }
  emit(type: string, id: string, body: Readonly<Record<string, unknown>> = {}): void {
    this.socket.emit('message', JSON.stringify({ id, pluginId: PLUGIN_ID, type, body }));
  }
}

async function flush(): Promise<void> { for (let index = 0; index < 80; index += 1) await Promise.resolve(); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => { throw new Error('Actual network forbidden in device tests'); }));
});

afterEach(async () => {
  await Promise.all(applications.splice(0).map(application => application.stop()));
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const base = resolve(tmpdir());
  for (const directory of directories.splice(0)) {
    const absolute = resolve(directory);
    if (!absolute.startsWith(`${base}${sep}hcu-devices-v020-`)) throw new Error('Unsafe test cleanup target');
    await rm(absolute, { recursive: true, force: true });
  }
});

function fixture(options: { live?: boolean; grid?: { value: number }; offline?: boolean; schedulerClock?: boolean } = {}) {
  const config = makeConfig({ loadManagement: { liveControlEnabled: options.live ?? false } });
  const configured: AppConfig = { ...config, notifications: {
    intervention: false, interactive: false, controllerConnectionError: false, chargerConnectionError: false,
  } };
  const clock = { now: 0 };
  const now = () => options.schedulerClock ? Date.now() : clock.now;
  const grid = options.grid ?? { value: 22_839 };
  const power = new Map([['garage', 11_000], ['links', 0]]);
  const observations = new Map(config.chargers.filter(charger => charger.enabled).map(charger => [charger.id,
    makeObservation({ chargerId: charger.id, host: charger.host, ama: 32, firmwareVersion: '59.4',
      tclClearCapability: 'VERIFIED', ...(charger.id === 'links' ? { car: 1, acu: null, alw: false } : {}) })]));
  const actual = (chargerId: string): ControlObservation => {
    const observation = observations.get(chargerId);
    if (observation === undefined) throw new Error('Unknown simulated charger');
    return observation;
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
  const controls: ChargerControlClient = { ...writes, readStatus: vi.fn(async charger =>
    success({ ...actual(charger.id), readStartedAtMs: now(), observedAtMs: now() })) };
  let ownership: OwnershipDocument | null = null;
  const actuator = new ChargerActuator({ client: controls, gate: { executionMode: 'LIVE', realWritesEnabled: true },
    now, sleep: async () => undefined, store: {
      load: async () => success(structuredClone(ownership)),
      save: async document => { ownership = structuredClone(document); return success(undefined); },
    } });
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.hostname !== configured.controller.host || url.pathname !== '/api/status') throw new Error('Unexpected device request');
    return new Response(JSON.stringify({ ccn: ['Grid', 'Home', 'Solar'], ccp: [grid.value, 4985.4, -9.2],
      cpc: Array.from({ length: 3 }, () => [null, null, null, null]) }));
  });
  vi.stubGlobal('fetch', fetchMock);
  const probe = vi.fn(async (currentConfig: AppConfig): Promise<ProbeReport> => ({
    controller: options.offline ? failure('ConnectionError', 'Mock controller offline')
      : success({ ...controller(grid.value), homePowerW: 4985.4, solarPowerW: -9.2 }),
    chargers: currentConfig.chargers.map((charger): ChargerProbeResult => {
      if (!charger.enabled) return { status: 'disabled', reachable: false, config: charger };
      if (options.offline) return { status: 'unavailable', reachable: false, config: charger,
        error: { code: 'ConnectionError', message: 'Mock charger offline' } };
      const observation = actual(charger.id);
      return { status: 'reachable', reachable: true, config: charger, value: makeCharger(charger.id, {
        host: charger.host, carState: mapCarState(observation.car), effectiveCurrentA: observation.acu,
        temporaryCurrentLimitA: observation.tcl, forceState: observation.frc, chargingAllowed: observation.alw,
        maximumCurrentA: observation.ama, currentPowerW: power.get(charger.id) ?? null,
      }) };
    }),
  }));
  const hcu = new MockHcu();
  const client = new HcuWebSocketClient({ ...transportSettings, webSocketFactory: hcu.factory, idProvider: new SequenceIds() });
  const app = new HcuPluginApplication({ client, config: configured, mode: 'INSTALLED_LIVE',
    realWritesEnabled: true, liveActuator: actuator, now, idProvider: new SequenceIds(), probe,
    store: { load: async () => success(configured), save: async () => success(undefined) } });
  applications.push(app);
  return {
    app, actuator, client, controls, writes, hcu, probe, power, grid, fetchMock,
    countWrites: () => Object.values(writes).reduce((total, write) => total + write.mock.calls.length, 0),
    start: async () => { expect((await app.initialize()).ok).toBe(true); app.start(); hcu.socket.emit('open'); await flush(); },
    step: async (now: number) => { clock.now = now; const snapshot = await app.installed!.tick(); await flush(); return snapshot; },
  };
}

function deviceIds(message: CapturedMessage | undefined): string[] {
  if (message === undefined || !Array.isArray(message.body['devices'])) throw new Error('Expected device response');
  return message.body['devices'].map((device: unknown) => {
    if (!record(device) || typeof device['deviceId'] !== 'string') throw new Error('Expected device identifier');
    return device['deviceId'];
  });
}

function powerEvents(hcu: MockHcu): CapturedMessage[] {
  return hcu.ofType('STATUS_EVENT').filter(message => Array.isArray(message.body['features'])
    && message.body['features'].some((feature: unknown) => record(feature) && typeof feature['currentPower'] === 'number'));
}

describe('read-only HmIP devices in the installed application', () => {
  it('projection and a no-op publisher produce identical decisions, actions and ownership from the same telemetry', async () => {
    const grid = { value: 22_839 };
    const active = fixture({ live: true, grid });
    const noProjection = fixture({ live: true, grid });
    vi.spyOn(noProjection.app.devices, 'observe').mockImplementation(() => undefined);
    await active.start(); await noProjection.start();
    active.hcu.emit('INCLUSION_EVENT', 'active-inclusion', { deviceIds: ALL_IDS });
    await flush();
    for (const time of [0, 4_000, 8_000, 12_000, 16_000, 20_000, 24_000, 28_000, 30_000, 34_000]) {
      await active.step(time); await noProjection.step(time);
      expect(active.app.installed!.engine.snapshot).toEqual(noProjection.app.installed!.engine.snapshot);
      expect(active.app.snapshot.lastDecision?.action).toEqual(noProjection.app.snapshot.lastDecision?.action);
      expect(active.actuator.states).toEqual(noProjection.actuator.states);
    }
    expect(active.writes.setTemporaryCurrentLimit.mock.calls.map(([charger, amps]) => [charger.id, amps]))
      .toEqual([['garage', 13], ['garage', 12]]);
    expect(noProjection.writes.setTemporaryCurrentLimit.mock.calls.map(([charger, amps]) => [charger.id, amps]))
      .toEqual([['garage', 13], ['garage', 12]]);
    expect(active.probe).toHaveBeenCalledTimes(10);
    expect(noProjection.probe).toHaveBeenCalledTimes(10);
    expect(active.hcu.ofType('STATUS_EVENT').length).toBeGreaterThan(0);
    // The initial maintenance updates do not expose a raw sample before the first complete minute.
    expect(powerEvents(active.hcu)).toHaveLength(0);
    expect(noProjection.hcu.ofType('STATUS_EVENT')).toHaveLength(0);
    // Continue through an average publication and recovery using the same raw inputs.
    grid.value = 17_000;
    for (let time = 36_000; time <= 60_000; time += 2_000) {
      await active.step(time); await noProjection.step(time);
      expect(active.app.installed!.engine.snapshot).toEqual(noProjection.app.installed!.engine.snapshot);
      expect(active.app.snapshot.lastDecision?.action).toEqual(noProjection.app.snapshot.lastDecision?.action);
      expect(active.actuator.states).toEqual(noProjection.actuator.states);
    }
    expect(active.writes.setTemporaryCurrentLimit.mock.calls.map(([charger, amps]) => [charger.id, amps]))
      .toEqual(noProjection.writes.setTemporaryCurrentLimit.mock.calls.map(([charger, amps]) => [charger.id, amps]));
    expect(powerEvents(active.hcu)).toHaveLength(5);
    expect(noProjection.hcu.ofType('STATUS_EVENT')).toHaveLength(0);
  });

  it('a throwing minute publisher does not stall the next two-second telemetry cycle or create an engine fault', async () => {
    const f = fixture({ live: true });
    await f.start(); await f.step(0);
    f.hcu.emit('INCLUSION_EVENT', 'included', { deviceIds: ALL_IDS }); await flush();
    const send = f.client.send.bind(f.client);
    const failingSend = vi.spyOn(f.client, 'send').mockImplementation(message => {
      if (message.type === 'STATUS_EVENT') throw new Error('Mock publication failure');
      return send(message);
    });
    f.power.set('garage', 10_500);
    for (const time of [4_000, 8_000, 12_000, 16_000, 20_000, 24_000, 28_000, 30_000]) await f.step(time);
    expect(f.writes.setTemporaryCurrentLimit).toHaveBeenCalledTimes(1);
    const polls = f.probe.mock.calls.length;
    f.power.set('garage', 10_000);
    await f.step(34_000);
    expect(f.probe).toHaveBeenCalledTimes(polls + 1);
    expect(f.writes.setTemporaryCurrentLimit).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'garage' }), 12);
    expect(f.app.installed!.engine.state).toBe('LIMITING');
    expect(f.app.installed!.engine.snapshot.fault).toBeNull();
    expect(failingSend.mock.calls.some(([message]) => message.type === 'STATUS_EVENT')).toBe(false);
    f.grid.value = 18_500;
    for (let time = 36_000; time <= 60_000; time += 2_000) await f.step(time);
    expect(f.app.devices.lastPublishError).toBe('HCU_DEVICE_PUBLISH_FAILED');
    expect(failingSend.mock.calls.some(([message]) => message.type === 'STATUS_EVENT')).toBe(true);
    const pollsAfterFailedPublication = f.probe.mock.calls.length;
    f.grid.value = 22_839;
    await f.step(62_000);
    expect(f.probe).toHaveBeenCalledTimes(pollsAfterFailedPublication + 1);
    expect(f.writes.setTemporaryCurrentLimit).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'garage' }), 11);
    expect(f.app.installed!.engine.state).toBe('LIMITING');
    expect(f.app.installed!.engine.snapshot.fault).toBeNull();
  });

  it('the existing scheduler keeps two-second polls while all five sensors publish completed minutes only', async () => {
    vi.setSystemTime(0);
    const f = fixture({ schedulerClock: true, grid: { value: 17_000 } });
    await f.start();
    f.hcu.emit('INCLUSION_EVENT', 'minute-inclusion', { deviceIds: ALL_IDS }); await flush();
    await vi.advanceTimersByTimeAsync(0);
    const initialPolls = f.probe.mock.calls.length;
    expect(initialPolls).toBe(1);
    await vi.advanceTimersByTimeAsync(58_000);
    expect(f.probe).toHaveBeenCalledTimes(30);
    expect(powerEvents(f.hcu)).toHaveLength(0);
    f.hcu.emit('STATUS_REQUEST', 'before-complete-minute', { deviceIds: ALL_IDS }); await flush();
    expect(JSON.stringify(f.hcu.ofType('STATUS_RESPONSE').at(-1))).not.toContain('"currentPower":');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.probe).toHaveBeenCalledTimes(31);
    expect(powerEvents(f.hcu).map(message => message.body['deviceId'])).toEqual(ALL_IDS);
    expect(f.countWrites()).toBe(0);
    expect(f.fetchMock).not.toHaveBeenCalled();
    f.hcu.emit('STATUS_REQUEST', 'completed-minute', { deviceIds: ALL_IDS }); await flush();
    expect(JSON.stringify(f.hcu.ofType('STATUS_RESPONSE').at(-1))).toContain('"currentPower":17000');
    const expectedPolls = f.probe.mock.calls.length;
    for (let index = 0; index < 20; index += 1) f.hcu.emit('STATUS_REQUEST', `cached-minute-${index}`, { deviceIds: ALL_IDS });
    await flush();
    expect(f.probe).toHaveBeenCalledTimes(expectedPolls);
    expect(powerEvents(f.hcu)).toHaveLength(5);
    await f.app.stop();
    const stoppedPolls = f.probe.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f.probe).toHaveBeenCalledTimes(stoppedPolls);
  });

  it.each(ALL_IDS)('CONTROL_REQUEST for %s fails without actuator calls or additional polls', async id => {
    const f = fixture(); await f.start(); await f.step(0);
    const execute = vi.spyOn(f.actuator, 'execute');
    const refresh = vi.spyOn(f.actuator, 'refresh');
    const reads = vi.mocked(f.controls.readStatus).mock.calls.length;
    const polls = f.probe.mock.calls.length;
    f.hcu.emit('CONTROL_REQUEST', `readonly-${id}`, { deviceId: id,
      features: [{ type: 'currentPower', currentPower: 32 }, { type: 'switchState', on: true }] });
    await flush();
    expect(f.hcu.ofType('CONTROL_RESPONSE').at(-1)).toMatchObject({ id: `readonly-${id}`, body: { deviceId: id, success: false } });
    expect(execute).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
    expect(f.countWrites()).toBe(0);
    expect(f.controls.readStatus).toHaveBeenCalledTimes(reads);
    expect(f.probe).toHaveBeenCalledTimes(polls);
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it('offline configured devices remain discoverable while automatic control is disabled and requests do not poll', async () => {
    const f = fixture({ offline: true }); await f.start(); await f.step(0);
    const polls = f.probe.mock.calls.length;
    f.hcu.emit('DISCOVER_REQUEST', 'offline-discovery'); await flush();
    const discovery = f.hcu.ofType('DISCOVER_RESPONSE').at(-1);
    expect(discovery).toMatchObject({ id: 'offline-discovery', body: { success: true } });
    expect(deviceIds(discovery)).toEqual(ALL_IDS);
    expect(JSON.stringify(discovery)).not.toContain('charger-rechts');
    expect(JSON.stringify(discovery)).toContain('"unreach":true');
    expect(JSON.stringify(discovery)).not.toContain('"currentPower":0');
    expect(f.app.snapshot.automaticLiveControlEnabled).toBe(false);
    expect(f.probe).toHaveBeenCalledTimes(polls); expect(f.countWrites()).toBe(0);
  });

  it('inclusion, exclusion and reconnect reconcile logical devices without modifying chargers', async () => {
    const f = fixture(); await f.start(); await f.step(0);
    f.hcu.emit('INCLUSION_EVENT', 'first-inclusion', { deviceIds: ['controller-grid', 'charger-garage'] }); await flush();
    expect(f.app.devices.includedDeviceIds).toEqual(['controller-grid', 'charger-garage']);
    expect(deviceIds(f.hcu.ofType('STATUS_RESPONSE').at(-1))).toEqual(['controller-grid', 'charger-garage']);
    f.power.set('garage', 12_000); await f.step(4_000);
    expect(powerEvents(f.hcu)).toHaveLength(0);
    f.hcu.emit('EXCLUSION_EVENT', 'garage-excluded', { deviceIds: ['charger-garage'] }); await flush();
    const events = f.hcu.ofType('STATUS_EVENT').length;
    f.power.set('garage', 13_000); await f.step(8_000);
    expect(f.hcu.ofType('STATUS_EVENT')).toHaveLength(events);
    f.hcu.socket.emit('close');
    expect(f.app.devices.inclusionKnown).toBe(false);
    expect(f.app.devices.includedDeviceIds).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    f.hcu.socket.emit('open'); await flush();
    f.grid.value = 17_000; await f.step(12_000);
    expect(f.hcu.ofType('STATUS_EVENT')).toHaveLength(events);
    f.hcu.emit('STATUS_REQUEST', 'explicit-after-reconnect', { deviceIds: ['controller-grid'] }); await flush();
    expect(f.hcu.ofType('STATUS_RESPONSE').at(-1)).toMatchObject({ id: 'explicit-after-reconnect' });
    expect(deviceIds(f.hcu.ofType('STATUS_RESPONSE').at(-1))).toEqual(['controller-grid']);
    expect(JSON.stringify(f.hcu.ofType('STATUS_RESPONSE').at(-1))).not.toContain('"currentPower":');
    f.hcu.emit('INCLUSION_EVENT', 'fresh-inclusion', { deviceIds: ['charger-links'] }); await flush();
    expect(f.app.devices.includedDeviceIds).toEqual(['charger-links']);
    expect(deviceIds(f.hcu.ofType('STATUS_RESPONSE').at(-1))).toEqual(['charger-links']);
    expect(f.countWrites()).toBe(0);
  });

  it.each([false, true])('an update preserves liveControlEnabled=%s and real 0.1.0 files without seed overwrite or clear/resume', async liveControlEnabled => {
    const directory = await mkdtemp(join(tmpdir(), 'hcu-devices-v020-'));
    directories.push(directory);
    const config = makeConfig({ loadManagement: { liveControlEnabled, gridLimitW: 19_500 } });
    const paused = makeObservation({ readStartedAtMs: 990, observedAtMs: 1_000, tcl: 6, acu: null, frc: 1, car: 4, alw: false });
    const ownership: OwnershipDocument = { version: 1, chargers: [makeOwnedState({ pluginOwnedTcl: 6,
      pluginOwnedPause: true, lastObservedState: paused, lastReadback: paused,
      lastConfirmedWrite: { action: { type: 'PAUSE', chargerId: 'garage' }, confirmedAtMs: 1_000 } })] };
    const messages: InteractionDocument = { version: 1, pluginId: PLUGIN_ID,
      session: { sessionId: 'preserved-v010-session', interventionRequested: true, overrideActive: false },
      messages: [{ userMessageId: 'preserved-v010-question', sessionId: 'preserved-v010-session',
        messagePurpose: 'LIVE_INTERVENTION', createdAt: 1_000, state: 'DELETED', answer: 'NO' }] };
    await Promise.all([
      writeFile(join(directory, 'plugin-config.json'), JSON.stringify(config)),
      writeFile(join(directory, 'actuator-state.json'), JSON.stringify(ownership)),
      writeFile(join(directory, 'user-message-state.json'), JSON.stringify(messages)),
    ]);
    const store = new FileConfigStore(directory);
    const configSave = vi.spyOn(store, 'save');
    const messageStore = new FileInteractionStateStore(directory);
    const ownershipStore = new FileOwnershipStore(directory);
    const write = vi.fn(async (): Promise<Result<void>> => success(undefined));
    const hcu = new MockHcu();
    const seed = { load: vi.fn(async () => { throw new Error('Existing configuration must not read a seed'); }) };
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input));
      if (url.pathname !== '/api/status') throw new Error('Unexpected physical write');
      if (url.hostname === 'controller.test') return new Response(JSON.stringify({ ccn: ['Home', 'Grid', 'Solar'],
        ccp: [4985.4, 4994.7, -9.2], cpc: Array.from({ length: 3 }, () => [null, null, null, null]) }));
      return new Response(JSON.stringify({ fna: url.hostname, fwv: '59.4', car: 4, amp: 14, acu: null,
        tcl: url.hostname === 'garage.test' ? 6 : 9, ama: 16, alw: false, frc: 1, mca: 6, acp: true,
        mcpd: 0, modelStatus: 4, nrg: [...Array.from({ length: 11 }, () => null), 0] }));
    }));
    let app: HcuPluginApplication | undefined;
    expect(await runHcuInstalledCli([], {
      store, interactionStore: messageStore, seedProvider: seed, registerSignals: false, now: () => 10_000,
      idProvider: new SequenceIds(), logger: createLogger('error', { write: () => undefined }),
      environment: { resolve: async () => success({ ...transportSettings, dataDirectory: directory }) },
      clientFactory: settings => new HcuWebSocketClient({ ...settings, webSocketFactory: hcu.factory, idProvider: new SequenceIds() }),
      actuatorFactory: (_config, _directory, gate, now) => new ChargerActuator({ gate, now, store: ownershipStore,
        client: { readStatus: async charger => success(makeObservation({ chargerId: charger.id, host: charger.host,
          readStartedAtMs: now(), observedAtMs: now(), tcl: charger.id === 'garage' ? 6 : 9,
          frc: 1, car: 4, acu: null, alw: false })), setTemporaryCurrentLimit: write,
        clearTemporaryCurrentLimit: write, pause: write, resume: write } }),
      onStarted: started => { app = started; applications.push(started); },
    })).toBe(0);
    if (app === undefined) throw new Error('Installed app did not start');
    hcu.socket.emit('open'); await flush(); await app.interactions.reconcile();
    await app.installed!.tick();
    hcu.emit('DISCOVER_REQUEST', 'upgraded-discovery'); await flush();
    expect(deviceIds(hcu.ofType('DISCOVER_RESPONSE').at(-1))).toEqual(ALL_IDS);
    expect(configSave).not.toHaveBeenCalled(); expect(seed.load).not.toHaveBeenCalled();
    expect(await store.load()).toEqual(success(config));
    expect(app.snapshot.automaticLiveControlEnabled).toBe(liveControlEnabled);
    expect(app.snapshot.actuator?.ownership.find(state => state.chargerId === 'garage'))
      .toMatchObject({ pluginOwnedTcl: 6, pluginOwnedPause: true, ownershipStatus: 'OWNED',
        lastConfirmedWrite: ownership.chargers[0]?.lastConfirmedWrite });
    expect(await messageStore.load()).toEqual(success(messages));
    expect(write).not.toHaveBeenCalled();
    expect(hcu.ofType('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(0);
    expect(hcu.ofType('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(0);
    await app.stop();
    const savedOwnership = await ownershipStore.load();
    expect(savedOwnership).toMatchObject({ ok: true, value: { version: 1, chargers: [expect.objectContaining({
      chargerId: 'garage', pluginOwnedTcl: 6, pluginOwnedPause: true, ownershipStatus: 'OWNED',
    }), expect.objectContaining({ chargerId: 'links', ownershipStatus: 'NONE' })] } });
    expect(await messageStore.load()).toEqual(success(messages));
    expect(await readFile(store.path, 'utf8')).toBe(JSON.stringify(config));
    expect((await readdir(directory)).sort()).toEqual(['actuator-state.json', 'plugin-config.json', 'user-message-state.json']);
  });
});
