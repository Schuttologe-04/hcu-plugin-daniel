import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHcuInstalledCli } from '../../../src/cli/hcu-installed.js';
import type { AppConfig, ChargerConfig } from '../../../src/config/config-types.js';
import { failure, success, type Result } from '../../../src/domain/errors.js';
import { ChargerActuator } from '../../../src/goe/control/charger-actuator.js';
import type { ChargerControlClient, ControlObservation } from '../../../src/goe/control/control-types.js';
import { makeEmptyOwnership, type OwnershipDocument, type OwnershipState } from '../../../src/goe/control/ownership-state.js';
import { FileOwnershipStore } from '../../../src/goe/control/ownership-store.js';
import { FileConfigStore } from '../../../src/hcu/config/config-store.js';
import { FileInteractionStateStore } from '../../../src/hcu/messages/interaction-state-store.js';
import type { HcuEnvelope } from '../../../src/hcu/message-types.js';
import { PLUGIN_ID } from '../../../src/hcu/plugin-identity.js';
import { HcuWebSocketClient, type HcuWebSocketFactory } from '../../../src/hcu/websocket-client.js';
import { createLogger } from '../../../src/logging/logger.js';
import type { HcuPluginApplication } from '../../../src/orchestration/hcu-plugin-application.js';
import { makeObservation, makeOwnedState } from '../goe/control/ownership-helpers.js';
import { fakeFactory, type FakeSocket, SequenceIds, transportSettings } from '../hcu/transport-helpers.js';
import { makeConfig } from '../load-management/helpers.js';

const OLD_CONTROLLER = '192.168.0.89';
const NEW_CONTROLLER = '10.0.0.89';
const NEW_HOSTS: Readonly<Record<string, string>> = { garage: '10.0.0.94', links: '10.0.0.144', rechts: '10.0.0.145' };
const applications = new Set<HcuPluginApplication>();
const directories: string[] = [];

interface CapturedMessage extends HcuEnvelope { readonly body: Readonly<Record<string, unknown>> }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function captured(text: string): CapturedMessage {
  const value: unknown = JSON.parse(text);
  if (!record(value) || typeof value['id'] !== 'string' || typeof value['pluginId'] !== 'string'
    || typeof value['type'] !== 'string' || (value['body'] !== undefined && !record(value['body']))) {
    throw new Error('Invalid mock HCU envelope');
  }
  return { id: value['id'], pluginId: value['pluginId'], type: value['type'], body: value['body'] ?? {} };
}

/** Every socket is fake, including the installed application's initial connection. */
class MockHcu {
  readonly sockets = fakeFactory();
  readonly messages: CapturedMessage[] = [];
  readonly pendingUpdates = new Map<string, (message: CapturedMessage) => void>();
  readonly factory: HcuWebSocketFactory = (url, options) => {
    const socket = this.sockets.factory(url, options) as FakeSocket;
    const send = socket.send.bind(socket);
    socket.send = text => {
      send(text);
      const message = captured(text);
      this.messages.push(message);
      if (message.type === 'CONFIG_UPDATE_RESPONSE') {
        this.pendingUpdates.get(message.id)?.(message);
        this.pendingUpdates.delete(message.id);
      }
      if (message.type === 'LIST_USER_MESSAGES_REQUEST') {
        void Promise.resolve().then(() => socket.emit('message', JSON.stringify({ id: message.id,
          pluginId: PLUGIN_ID, type: 'LIST_USER_MESSAGES_RESPONSE', body: { userMessageMap: {} } })));
      }
    };
    return socket;
  };
  #sequence = 0;

  get socket(): FakeSocket {
    const socket = this.sockets.sockets.at(-1);
    if (socket === undefined) throw new Error('Mock HCU has not started');
    return socket;
  }

  update(properties: Readonly<Record<string, unknown>>): Promise<CapturedMessage> {
    const id = `initial-config-${++this.#sequence}`;
    const response = new Promise<CapturedMessage>(resolveResponse => this.pendingUpdates.set(id, resolveResponse));
    this.socket.emit('message', JSON.stringify({ id, pluginId: PLUGIN_ID,
      type: 'CONFIG_UPDATE_REQUEST', body: { properties } }));
    return response;
  }
}

function initialConfig(liveControlEnabled: boolean | undefined): AppConfig {
  const config = makeConfig({ chargers: [
    { id: 'garage', name: 'Garage', host: '192.168.0.94', enabled: true, priority: 1 },
    { id: 'links', name: 'Links', host: '192.168.0.144', enabled: true, priority: 20 },
    { id: 'rechts', name: 'Rechts', host: '', enabled: false, priority: 20 },
  ] });
  return { ...config, controller: { host: OLD_CONTROLLER },
    loadManagement: { ...config.loadManagement, ...(liveControlEnabled === undefined ? {} : { liveControlEnabled }) },
    notifications: { intervention: false, interactive: false, controllerConnectionError: false, chargerConnectionError: false } };
}

function unknownDocument(config: AppConfig): OwnershipDocument {
  return { version: 1, chargers: config.chargers.filter(charger => charger.enabled).map(charger => ({
    ...makeEmptyOwnership(charger, 1_000), ownershipStatus: 'UNKNOWN', conflictStatus: 'CHARGER_STATUS_UNAVAILABLE',
  })) };
}

async function files(config: AppConfig, persistedUnknown = false) {
  const directory = await mkdtemp(join(tmpdir(), 'hcu-initial-config-v021-'));
  directories.push(directory);
  const configStore = new FileConfigStore(directory);
  const ownershipStore = new FileOwnershipStore(directory);
  expect((await configStore.save(config)).ok).toBe(true);
  if (persistedUnknown) expect((await ownershipStore.save(unknownDocument(config))).ok).toBe(true);
  return { directory, configStore, ownershipStore };
}

function observation(config: ChargerConfig, now: number): ControlObservation {
  return makeObservation({ chargerId: config.id, host: config.host, readStartedAtMs: now, observedAtMs: now,
    firmwareVersion: '59.4', tclClearCapability: 'VERIFIED',
    ...(config.id === 'garage' ? {} : { car: 1, acu: null, alw: false }) });
}

async function startProcess(stores: Awaited<ReturnType<typeof files>>, newHostsReachable = true) {
  const clock = { now: 10_000 };
  const hcu = new MockHcu();
  const writes = {
    setTemporaryCurrentLimit: vi.fn(async (): Promise<Result<void>> => failure('ConfigurationError', 'Unexpected mocked write')),
    clearTemporaryCurrentLimit: vi.fn(async (): Promise<Result<void>> => failure('ConfigurationError', 'Unexpected mocked write')),
    pause: vi.fn(async (): Promise<Result<void>> => failure('ConfigurationError', 'Unexpected mocked write')),
    resume: vi.fn(async (): Promise<Result<void>> => failure('ConfigurationError', 'Unexpected mocked write')),
  };
  const readStatus = vi.fn(async (config: ChargerConfig): Promise<Result<ControlObservation>> =>
    config.host.startsWith('10.0.0.') && newHostsReachable
      ? success(observation(config, clock.now)) : failure('ConnectionError', 'Mock charger unavailable'));
  const controls: ChargerControlClient = { ...writes, readStatus };
  const fetchMock = vi.fn<typeof fetch>(async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname !== '/api/status' || options?.method !== 'GET'
      || ![OLD_CONTROLLER, NEW_CONTROLLER, '192.168.0.94', '192.168.0.144', ...Object.values(NEW_HOSTS)].includes(url.hostname)) {
      throw new Error('Unexpected HTTP boundary in initial-config test');
    }
    if (!newHostsReachable || !url.hostname.startsWith('10.0.0.')) throw new Error('Mock device unavailable');
    return new Response(JSON.stringify(url.hostname === NEW_CONTROLLER
      ? { ccn: ['Grid'], ccp: [22_839], cpc: [[null, null, null, null]] }
      : { fna: 'Mock charger', fwv: '59.4', car: 2, amp: 14, acu: 14, ama: 16,
        alw: true, frc: 0, tcl: null, mca: 6, acp: true, mcpd: 0, modelStatus: 15 }));
  });
  vi.stubGlobal('fetch', fetchMock);
  const seedProvider = { load: vi.fn(async () => { throw new Error('Existing config must not consult the seed'); }) };
  let application: HcuPluginApplication | undefined;
  let actuator: ChargerActuator | undefined;
  const result = await runHcuInstalledCli([], {
    environment: { resolve: async () => success({ ...transportSettings, dataDirectory: stores.directory }) },
    store: stores.configStore, interactionStore: new FileInteractionStateStore(stores.directory), seedProvider,
    registerSignals: false, now: () => clock.now, idProvider: new SequenceIds(),
    logger: createLogger('error', { write: () => undefined }),
    clientFactory: settings => new HcuWebSocketClient({ ...settings, webSocketFactory: hcu.factory, idProvider: new SequenceIds() }),
    actuatorFactory: (_config, _directory, gate, now) => {
      actuator = new ChargerActuator({ client: controls, store: stores.ownershipStore, gate, now, sleep: async () => undefined });
      return actuator;
    },
    onStarted: app => { application = app; applications.add(app); },
  });
  expect(result).toBe(0);
  if (application === undefined || actuator === undefined) throw new Error('Mock installed process did not start');
  const app = application;
  hcu.socket.emit('open');
  await app.interactions.reconcile();
  return { app, actuator, hcu, clock, controls, readStatus, writes, fetchMock, seedProvider,
    stop: async () => { await app.stop(); applications.delete(app); },
    assertNoWrites: () => { for (const write of Object.values(writes)) expect(write).not.toHaveBeenCalled(); },
  };
}

function newBindingProperties(): Readonly<Record<string, unknown>> {
  return { 'controller.host': NEW_CONTROLLER, 'chargers.garage.host': NEW_HOSTS['garage'],
    'chargers.links.host': NEW_HOSTS['links'] };
}

function protectedHistories(): readonly { readonly label: string; readonly state: OwnershipState }[] {
  const config = initialConfig(false);
  const garage = config.chargers.find(charger => charger.id === 'garage');
  if (garage === undefined) throw new Error('Missing mock garage');
  const empty: OwnershipState = { ...makeEmptyOwnership(garage, 1_000), ownershipStatus: 'UNKNOWN',
    conflictStatus: 'CHARGER_STATUS_UNAVAILABLE' };
  const baseline = observation(garage, 0);
  const limited = { ...observation(garage, 1_000), tcl: 10, acu: 10 };
  const paused = { ...observation(garage, 1_000), frc: 1, car: 4, acu: null, alw: false };
  const pending: OwnershipState['pendingWrite'] = {
    action: { type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 13 },
    expectedTcl: 13, expectedFrc: 0, startedAtMs: 1_000,
  };
  return [
    { label: 'UNKNOWN with baseline evidence', state: { ...empty, baseline } },
    { label: 'UNKNOWN with a confirmed write but no current claim', state: { ...empty,
      lastConfirmedWrite: { action: { type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 10 }, confirmedAtMs: 1_000 } } },
    { label: 'UNKNOWN with readback evidence', state: { ...empty, lastReadback: limited } },
    { label: 'UNKNOWN with an unconfirmed pending write', state: { ...empty, baseline, pendingWrite: pending } },
    { label: 'plugin-owned temporary limit followed by a startup outage', state: makeOwnedState({ host: garage.host,
      baseline, lastObservedState: limited, lastReadback: limited }) },
    { label: 'plugin-owned pause followed by a startup outage', state: makeOwnedState({ host: garage.host, baseline,
      pluginOwnedTcl: null, pluginOwnedPause: true, lastObservedState: paused, lastReadback: paused,
      lastConfirmedWrite: { action: { type: 'PAUSE', chargerId: 'garage' }, confirmedAtMs: 1_000 } }) },
    { label: 'an existing external-change conflict', state: { ...empty, ownershipStatus: 'CONFLICT',
      conflictStatus: 'EXTERNAL_TCL_CHANGE', lastObservedState: limited } },
    { label: 'an in-flight RECONCILING write', state: { ...empty, ownershipStatus: 'RECONCILING',
      conflictStatus: null, baseline, pendingWrite: pending } },
    { label: 'UNKNOWN with an observed foreign temporary limit', state: { ...empty, lastObservedState: limited } },
    { label: 'UNKNOWN with an observed foreign pause', state: { ...empty, lastObservedState: paused } },
    { label: 'UNKNOWN with observed native load balancing', state: { ...empty,
      lastObservedState: { ...baseline, loe: true } } },
  ];
}

beforeEach(() => {
  vi.useFakeTimers();
  // No startup path may ever reach the real fetch implementation.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => { throw new Error('Actual network forbidden'); }));
});

afterEach(async () => {
  for (const application of applications) await application.stop();
  applications.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  const base = `${resolve(tmpdir())}${sep}hcu-initial-config-v021-`;
  for (const directory of directories.splice(0)) {
    const target = resolve(directory);
    if (!target.startsWith(base)) throw new Error('Unsafe initial-config test cleanup target');
    await rm(target, { recursive: true, force: true });
  }
});

describe.each([false, true])('installed initial HCUweb configuration with liveControlEnabled=%s', liveControlEnabled => {
  it.each([false, true])('moves generated or persisted v0.2 UNKNOWN state to the new network and survives restart (persisted=%s)', async persistedUnknown => {
    const config = initialConfig(liveControlEnabled);
    const stores = await files(config, persistedUnknown);
    const first = await startProcess(stores);
    expect(first.actuator.states).toHaveLength(2);
    for (const state of first.actuator.states) expect(state).toMatchObject({ ownershipStatus: 'UNKNOWN', baseline: null,
      lastConfirmedWrite: null, lastReadback: null, pendingWrite: null, pluginOwnedTcl: null, pluginOwnedPause: false });
    const response = await first.hcu.update(newBindingProperties());
    expect(response.body['status']).toBe('APPLIED');
    expect(first.app.configService.current).toMatchObject({ controller: { host: NEW_CONTROLLER },
      loadManagement: { liveControlEnabled } });
    expect(first.actuator.states.map(state => [state.chargerId, state.host, state.ownershipStatus])).toEqual([
      ['garage', NEW_HOSTS['garage'], 'NONE'], ['links', NEW_HOSTS['links'], 'NONE'],
    ]);
    first.assertNoWrites();
    const savedConfig = first.app.configService.current;
    expect(await stores.configStore.load()).toEqual(success(savedConfig));
    const savedOwnership = await stores.ownershipStore.load();
    await first.stop();
    const restarted = await startProcess(stores);
    expect(restarted.app.configService.current).toEqual(savedConfig);
    expect(await stores.ownershipStore.load()).toEqual(savedOwnership);
    expect(restarted.app.snapshot.automaticLiveControlEnabled).toBe(liveControlEnabled);
    expect(restarted.seedProvider.load).not.toHaveBeenCalled();
    expect(restarted.readStatus.mock.calls.map(([charger]) => charger.host)).toEqual([NEW_HOSTS['garage'], NEW_HOSTS['links']]);
    restarted.assertNoWrites();
  });

  it('persists new bindings even while the new network devices are still unavailable', async () => {
    const stores = await files(initialConfig(liveControlEnabled), true);
    const first = await startProcess(stores, false);
    expect((await first.hcu.update(newBindingProperties())).body['status']).toBe('APPLIED');
    for (const state of first.actuator.states) expect(state).toMatchObject({ ownershipStatus: 'UNKNOWN',
      baseline: null, lastConfirmedWrite: null, lastReadback: null, pendingWrite: null });
    expect(first.actuator.states.map(state => state.host)).toEqual([NEW_HOSTS['garage'], NEW_HOSTS['links']]);
    const savedConfig = first.app.configService.current;
    await first.stop();
    const restarted = await startProcess(stores, false);
    expect(restarted.app.configService.current).toEqual(savedConfig);
    expect(restarted.actuator.states.map(state => state.host)).toEqual([NEW_HOSTS['garage'], NEW_HOSTS['links']]);
    expect(restarted.seedProvider.load).not.toHaveBeenCalled();
    first.assertNoWrites(); restarted.assertNoWrites();
  });

  it.each([
    { label: 'controller only', properties: { 'controller.host': NEW_CONTROLLER } },
    { label: 'one charger host', properties: { 'chargers.garage.host': NEW_HOSTS['garage'] } },
    { label: 'enable previously disabled Rechts', properties: { 'chargers.rechts.enabled': true, 'chargers.rechts.host': NEW_HOSTS['rechts'] } },
    { label: 'disable uncontrolled charger', properties: { 'chargers.links.enabled': false, 'chargers.links.host': '' } },
    { label: 'display name and priority', properties: { 'chargers.garage.name': 'New garage', 'chargers.garage.priority': 2 } },
  ])('accepts $label without adopting another charger\'s telemetry-only UNKNOWN as ownership', async ({ properties }) => {
    const stores = await files(initialConfig(liveControlEnabled), true);
    const f = await startProcess(stores);
    const response = await f.hcu.update(properties);
    expect(response.body['status']).toBe('APPLIED');
    expect(await stores.configStore.load()).toEqual(success(f.app.configService.current));
    expect(f.app.configService.current.loadManagement.liveControlEnabled).toBe(liveControlEnabled);
    f.assertNoWrites();
  });

  it('rejects an invalid host atomically and leaves file configuration and ownership unchanged', async () => {
    const stores = await files(initialConfig(liveControlEnabled), true);
    const f = await startProcess(stores);
    const configBefore = await readFile(stores.configStore.path, 'utf8');
    const ownershipBefore = await readFile(stores.ownershipStore.path, 'utf8');
    const readsBefore = f.readStatus.mock.calls.length;
    const response = await f.hcu.update({ ...newBindingProperties(), 'chargers.garage.host': 'http://10.0.0.94/api/set' });
    expect(response.body['status']).toBe('FAILED');
    expect(await readFile(stores.configStore.path, 'utf8')).toBe(configBefore);
    expect(await readFile(stores.ownershipStore.path, 'utf8')).toBe(ownershipBefore);
    expect(f.readStatus).toHaveBeenCalledTimes(readsBefore);
    f.assertNoWrites();
  });

  it('does not rebind runtime when writing the validated configuration fails', async () => {
    const config = initialConfig(liveControlEnabled);
    const stores = await files(config, true);
    const f = await startProcess(stores);
    const statesBefore = f.actuator.states;
    const readsBefore = f.readStatus.mock.calls.length;
    vi.spyOn(stores.configStore, 'save').mockResolvedValueOnce(failure('ConfigurationError', 'Mock config persistence failure'));
    expect((await f.hcu.update(newBindingProperties())).body['status']).toBe('FAILED');
    expect(f.app.configService.current).toEqual(config);
    expect(await stores.configStore.load()).toEqual(success(config));
    expect(f.actuator.states).toEqual(statesBefore);
    expect(f.readStatus).toHaveBeenCalledTimes(readsBefore);
    f.assertNoWrites();
  });

  it.each(['once', 'always'] as const)('rolls back config and never writes after ownership persistence fails %s', async mode => {
    const config = initialConfig(liveControlEnabled);
    const stores = await files(config, true);
    const f = await startProcess(stores);
    const beforeOwnership = await readFile(stores.ownershipStore.path, 'utf8');
    const save = vi.spyOn(stores.ownershipStore, 'save');
    const failed = failure('ConfigurationError', 'Mock ownership persistence failure');
    if (mode === 'once') save.mockResolvedValueOnce(failed);
    else save.mockResolvedValue(failed);
    expect((await f.hcu.update(newBindingProperties())).body['status']).toBe('FAILED');
    expect(f.app.configService.current).toEqual(config);
    expect(await stores.configStore.load()).toEqual(success(config));
    expect(await readFile(stores.ownershipStore.path, 'utf8')).toBe(beforeOwnership);
    expect(f.actuator.states.map(state => state.host)).toEqual(['192.168.0.94', '192.168.0.144']);
    if (mode === 'always') {
      expect(f.app.snapshot.actuator?.state).toBe('STOPPED');
      expect(f.app.snapshot.automaticLiveControlEnabled).toBe(false);
      const readsBefore = f.readStatus.mock.calls.length;
      expect((await f.hcu.update({ 'controller.host': NEW_CONTROLLER })).body['status']).toBe('FAILED');
      expect(f.readStatus).toHaveBeenCalledTimes(readsBefore);
      expect(f.app.configService.current).toEqual(config);
    }
    f.assertNoWrites();
  });

  it('stops control but keeps HCU diagnostics available when an ownership refusal cannot restore disk configuration', async () => {
    const config = initialConfig(liveControlEnabled);
    const stores = await files(config, true);
    const previous = unknownDocument(config);
    const garage = config.chargers.find(charger => charger.id === 'garage');
    if (garage === undefined) throw new Error('Missing mock garage');
    const pending: OwnershipDocument = { version: 1, chargers: previous.chargers.map(state => state.chargerId !== 'garage' ? state : {
      ...state, baseline: observation(garage, 0),
      pendingWrite: { action: { type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 13 },
        expectedTcl: 13, expectedFrc: 0, startedAtMs: 1_000 },
    }) };
    expect((await stores.ownershipStore.save(pending)).ok).toBe(true);
    const f = await startProcess(stores);
    const saveConfig = stores.configStore.save.bind(stores.configStore);
    const save = vi.spyOn(stores.configStore, 'save').mockImplementationOnce(saveConfig)
      .mockResolvedValueOnce(failure('ConfigurationError', 'Private filesystem details must not escape'));
    const response = await f.hcu.update(newBindingProperties());
    expect(response.body['status']).toBe('FAILED');
    expect(response.body['message']).toContain('nicht sicher wiederhergestellt');
    expect(response.body['message']).toContain('Plugin neu starten');
    expect(JSON.stringify(response)).not.toContain('Private filesystem details');
    expect(f.app.snapshot.actuator?.state).toBe('STOPPED');
    expect(f.app.snapshot.connectionState).toBe('READY');
    expect(f.app.snapshot.automaticLiveControlEnabled).toBe(false);
    expect(f.app.configService.current).toEqual(config);
    const persisted = await stores.configStore.load();
    expect(persisted).toMatchObject({ ok: true, value: { controller: { host: NEW_CONTROLLER } } });
    expect(f.actuator.states.find(state => state.chargerId === 'garage')?.pendingWrite).toEqual(pending.chargers[0]?.pendingWrite);
    const readsBefore = f.readStatus.mock.calls.length;
    const savesBefore = save.mock.calls.length;
    expect((await f.hcu.update({ 'controller.host': NEW_CONTROLLER })).body['status']).toBe('FAILED');
    expect(f.readStatus).toHaveBeenCalledTimes(readsBefore);
    expect(save).toHaveBeenCalledTimes(savesBefore);
    f.assertNoWrites();
  });
});

describe('initial configuration legacy activation and the installed write gate', () => {
  it('preserves absence of the legacy live flag through update and restart as operationally disabled', async () => {
    const stores = await files(initialConfig(undefined), true);
    const first = await startProcess(stores);
    expect((await first.hcu.update(newBindingProperties())).body['status']).toBe('APPLIED');
    expect(first.app.configService.current.loadManagement).not.toHaveProperty('liveControlEnabled');
    await first.stop();
    const restarted = await startProcess(stores);
    expect(restarted.app.snapshot.automaticLiveControlEnabled).toBe(false);
    expect(restarted.app.configService.current.loadManagement).not.toHaveProperty('liveControlEnabled');
    restarted.assertNoWrites();
  });

  it('keeps automatic control disabled after an initial binding update despite healthy continuously excessive Grid', async () => {
    const stores = await files(initialConfig(false));
    const f = await startProcess(stores);
    expect((await f.hcu.update(newBindingProperties())).body['status']).toBe('APPLIED');
    for (const now of [10_000, 14_000, 18_000, 22_000, 26_000, 30_000, 34_000, 38_000, 40_000, 44_000]) {
      f.clock.now = now;
      await f.app.installed!.tick();
    }
    expect(f.app.snapshot.telemetryHealth).toMatchObject({ state: 'HEALTHY', gridImportW: 22_839 });
    expect(f.app.snapshot.automaticLiveControlEnabled).toBe(false);
    expect(f.app.installed!.engine.state).toBe('NORMAL');
    expect(f.fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const [input, options] of f.fetchMock.mock.calls) {
      expect(new URL(input instanceof Request ? input.url : String(input)).pathname).toBe('/api/status');
      expect(options?.method).toBe('GET');
    }
    f.assertNoWrites();
  });
});

describe('HCU binding protection for real persisted ownership and write evidence', () => {
  it.each(protectedHistories())('rejects binding changes for $label without replacing historical evidence', async ({ state }) => {
    const config = initialConfig(false);
    const stores = await files(config, true);
    const document: OwnershipDocument = { version: 1,
      chargers: unknownDocument(config).chargers.map(previous => previous.chargerId === 'garage' ? state : previous) };
    // The actual store validates every fixture; no invalid cast bypasses the persisted schema.
    expect((await stores.ownershipStore.save(document)).ok).toBe(true);
    const f = await startProcess(stores);
    expect(f.actuator.states.find(current => current.chargerId === 'garage')).toMatchObject({
      baseline: state.baseline, lastConfirmedWrite: state.lastConfirmedWrite, lastReadback: state.lastReadback,
      lastObservedState: state.lastObservedState, pendingWrite: state.pendingWrite,
      pluginOwnedTcl: state.pluginOwnedTcl, pluginOwnedPause: state.pluginOwnedPause,
    });
    const ownershipBefore = await readFile(stores.ownershipStore.path, 'utf8');
    const statesBefore = f.actuator.states;
    const readsBefore = f.readStatus.mock.calls.length;
    for (const properties of [
      { 'controller.host': NEW_CONTROLLER },
      { 'chargers.links.host': NEW_HOSTS['links'] },
      newBindingProperties(),
    ]) {
      expect((await f.hcu.update(properties)).body['status']).toBe('FAILED');
      expect(f.app.configService.current).toEqual(config);
      expect(await stores.configStore.load()).toEqual(success(config));
      expect(f.actuator.states).toEqual(statesBefore);
      expect(await readFile(stores.ownershipStore.path, 'utf8')).toBe(ownershipBefore);
    }
    expect(f.readStatus.mock.calls.slice(readsBefore).every(([charger]) => !charger.host.startsWith('10.0.0.'))).toBe(true);
    expect(f.fetchMock).not.toHaveBeenCalled();
    f.assertNoWrites();
  });
});
