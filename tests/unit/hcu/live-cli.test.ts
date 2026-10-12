import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHcuCli, type HcuCliDependencies } from '../../../src/cli/hcu-dev.js';
import { runHcuLiveCli } from '../../../src/cli/hcu-live.js';
import type { AppConfig, ChargerConfig } from '../../../src/config/config-types.js';
import { failure, success, type Result } from '../../../src/domain/errors.js';
import { ChargerActuator } from '../../../src/goe/control/charger-actuator.js';
import type { ChargerControlClient, ControlObservation } from '../../../src/goe/control/control-types.js';
import type { OwnershipDocument } from '../../../src/goe/control/ownership-state.js';
import { HcuWebSocketClient } from '../../../src/hcu/websocket-client.js';
import type { ResolvedHcuEnvironment } from '../../../src/hcu/runtime/hcu-environment.js';
import { createLogger } from '../../../src/logging/logger.js';
import type { HcuPluginApplication } from '../../../src/orchestration/hcu-plugin-application.js';
import { makeConfig } from '../load-management/helpers.js';
import { fakeFactory, SequenceIds, transportSettings } from './transport-helpers.js';

const applications: HcuPluginApplication[] = [];
let initialInterrupt: NodeJS.SignalsListener[];
let initialTerminate: NodeJS.SignalsListener[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  initialInterrupt = process.listeners('SIGINT');
  initialTerminate = process.listeners('SIGTERM');
  // No test can accidentally reach native fetch, even on a faulty startup path.
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockRejectedValue(new Error('Unmocked HTTP forbidden')));
});

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.stop()));
  for (const listener of process.listeners('SIGINT')) if (!initialInterrupt.includes(listener)) process.off('SIGINT', listener);
  for (const listener of process.listeners('SIGTERM')) if (!initialTerminate.includes(listener)) process.off('SIGTERM', listener);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function setup(realWritesFlag = 'true') {
  const config = makeConfig();
  const ids = new SequenceIds();
  const clock = { now: 1000 };
  const sockets = fakeFactory();
  const environment = { resolve: vi.fn(async () => success({ ...transportSettings, dataDirectory: './never-written-test-data' })) };
  const store = { load: vi.fn(async () => success<AppConfig | null>(config)), save: vi.fn(async (_value: AppConfig) => success(undefined)) };
  const configProvider = { load: vi.fn(async (): Promise<unknown> => config) };
  const ownershipStore = {
    load: vi.fn(async (): Promise<Result<OwnershipDocument | null>> => success(null)),
    save: vi.fn(async (_value: OwnershipDocument) => success(undefined)),
  };
  const readStatus = vi.fn(async (charger: ChargerConfig): Promise<Result<ControlObservation>> => success({
    chargerId: charger.id, host: charger.host, readStartedAtMs: clock.now, observedAtMs: clock.now,
    amp: 14, tcl: null, frc: 0, loe: false, car: 2, mca: 6, acu: 14, ama: 32, acp: true, mcpd: 0, alw: true,
  }));
  const setTemporaryCurrentLimit = vi.fn(async (_charger: ChargerConfig, _amps: number) => success(undefined));
  const clearTemporaryCurrentLimit = vi.fn(async (_charger: ChargerConfig) => success(undefined));
  const pause = vi.fn(async (_charger: ChargerConfig) => success(undefined));
  const resume = vi.fn(async (_charger: ChargerConfig) => success(undefined));
  const control: ChargerControlClient = { readStatus, setTemporaryCurrentLimit, clearTemporaryCurrentLimit, pause, resume };
  const actuatorFactory = vi.fn<NonNullable<HcuCliDependencies['actuatorFactory']>>((_config, _directory, gate, now) => new ChargerActuator({
    gate, now, client: control, store: ownershipStore, sleep: async () => undefined,
  }));
  const clientFactory = vi.fn((settings: ResolvedHcuEnvironment) => new HcuWebSocketClient({ ...settings, idProvider: ids, webSocketFactory: sockets.factory }));
  let application: HcuPluginApplication | undefined;
  const dependencies: HcuCliDependencies = {
    environment, store, configProvider, clientFactory, actuatorFactory,
    now: () => clock.now, idProvider: ids, realWritesFlag,
    logger: createLogger('error', { write: () => undefined }),
    onStarted: (value) => { application = value; applications.push(value); },
  };
  return { config, dependencies, clock, environment, store, configProvider, ownershipStore, readStatus, actuatorFactory, clientFactory, sockets,
    writes: [setTemporaryCurrentLimit, clearTemporaryCurrentLimit, pause, resume],
    get application() { if (application === undefined) throw new Error('Application not started'); return application; },
  };
}

describe('explicit LIVE CLI and closed startup gate', () => {
  it.each(['', 'false', 'TRUE', 'True', '1', ' true', 'true ', 'yes'])('rejects nonexact flag %j before credentials, files or sockets', async (flag) => {
    const h = setup(flag);
    expect(await runHcuLiveCli([], h.dependencies)).toBe(2);
    expect(h.environment.resolve).not.toHaveBeenCalled();
    expect(h.store.load).not.toHaveBeenCalled();
    expect(h.configProvider.load).not.toHaveBeenCalled();
    expect(h.actuatorFactory).not.toHaveBeenCalled();
    expect(h.clientFactory).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('rejects an absent environment flag before resolving HCU credentials', async () => {
    const h = setup();
    vi.stubEnv('GOE_REAL_WRITES_ENABLED', undefined);
    const { realWritesFlag: _ignored, ...dependencies } = h.dependencies;
    expect(await runHcuLiveCli([], dependencies)).toBe(2);
    expect(h.environment.resolve).not.toHaveBeenCalled();
    expect(h.actuatorFactory).not.toHaveBeenCalled();
  });

  it.each([runHcuCli, runHcuLiveCli])('help does not initialize any runtime, credentials, files or socket', async (run) => {
    const h = setup('false');
    expect(await run(['--help'], h.dependencies)).toBe(0);
    expect(h.environment.resolve).not.toHaveBeenCalled();
    expect(h.store.load).not.toHaveBeenCalled();
    expect(h.actuatorFactory).not.toHaveBeenCalled();
    expect(h.clientFactory).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each([['--live'], ['--dry-run', '--live'], ['--test-message', '--live']].map(args => ({ args })))('the existing DEV entry point cannot promote itself with $args', async ({ args }) => {
    const h = setup();
    expect(await runHcuCli(args, h.dependencies)).toBe(2);
    expect(h.environment.resolve).not.toHaveBeenCalled();
    expect(h.actuatorFactory).not.toHaveBeenCalled();
  });

  it.each([['--dry-run'], ['--test-message'], ['--dry-run', '--test-message']].map(args => ({ args })))('the LIVE entry point rejects mixing with $args', async ({ args }) => {
    const h = setup();
    expect(await runHcuLiveCli(args, h.dependencies)).toBe(2);
    expect(h.environment.resolve).not.toHaveBeenCalled();
    expect(h.actuatorFactory).not.toHaveBeenCalled();
  });

  it('LIVE plus true performs only startup status reconciliation and never runs an automatic control or refresh loop', async () => {
    const h = setup();
    expect(await runHcuLiveCli([], h.dependencies)).toBe(0);
    expect(h.actuatorFactory).toHaveBeenCalledTimes(1);
    expect(h.actuatorFactory.mock.calls[0]?.[2]).toEqual({ executionMode: 'LIVE', realWritesEnabled: true });
    expect(h.ownershipStore.load).toHaveBeenCalledTimes(1);
    expect(h.ownershipStore.save).toHaveBeenCalledTimes(1);
    expect(h.readStatus.mock.calls.map(([charger]) => charger.id)).toEqual(['garage', 'links']);
    expect(h.application.dryRun).toBeNull();
    expect(h.application.live).not.toBeNull();
    expect(h.application.snapshot).toMatchObject({ mode: 'LIVE', realChargerWritesEnabled: true,
      observedAtMs: null, lastDecision: null, actuator: { state: 'PREPARED' } });
    const observe = vi.spyOn(h.application.live!, 'observe');
    const refresh = vi.spyOn(h.application.live!, 'refresh');
    h.sockets.sockets[0]?.emit('open');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(observe).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    expect(h.readStatus).toHaveBeenCalledTimes(2);
    for (const write of h.writes) expect(write).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('corrupt ownership prevents HCU startup and preserves failed evidence instead of overwriting it', async () => {
    const h = setup();
    h.ownershipStore.load.mockResolvedValue(failure('ConfigurationError', 'Corrupt ownership'));
    expect(await runHcuLiveCli([], h.dependencies)).toBe(2);
    expect(h.sockets.calls).toEqual([]);
    expect(h.readStatus).not.toHaveBeenCalled();
    expect(h.ownershipStore.save).not.toHaveBeenCalled();
    for (const write of h.writes) expect(write).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('read-only commands remain independent of the global write flag', () => {
  it('DEV with an accidentally true environment flag never creates an actuator or polls go-e', async () => {
    const h = setup();
    vi.stubEnv('GOE_REAL_WRITES_ENABLED', 'true');
    expect(await runHcuCli([], h.dependencies)).toBe(0);
    h.sockets.sockets[0]?.emit('open');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h.actuatorFactory).not.toHaveBeenCalled();
    expect(h.ownershipStore.load).not.toHaveBeenCalled();
    expect(h.application.live).toBeNull();
    expect(h.application.snapshot.realChargerWritesEnabled).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('DRY_RUN with true flag keeps real GET snapshots and applies only virtual limitations', async () => {
    const h = setup();
    vi.stubEnv('GOE_REAL_WRITES_ENABLED', 'true');
    h.clock.now = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.hostname === 'controller.test') return new Response(JSON.stringify({ ccn: ['Grid'], ccp: [22_839], cpc: [[null, null, null, null]] }));
      return new Response(JSON.stringify({ fna: url.hostname, fwv: '59.4', car: url.hostname === 'garage.test' ? 2 : 1,
        amp: 14, acu: url.hostname === 'garage.test' ? 14 : null, tcl: null, frc: 0, mca: 6, ama: 32, acp: true, mcpd: 0, alw: true, modelStatus: 15 }));
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await runHcuCli(['--dry-run'], h.dependencies)).toBe(0);
    await h.application.dryRun!.tick();
    h.clock.now = 30_000;
    await h.application.dryRun!.tick();
    expect(h.application.snapshot).toMatchObject({ mode: 'DRY_RUN', realChargerWritesEnabled: false,
      lastAction: { type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 13 } });
    const real = h.application.snapshot.probe?.chargers.find((charger) => charger.config.id === 'garage');
    expect(real).toMatchObject({ status: 'reachable', value: { temporaryCurrentLimitA: null, configuredCurrentA: 14, effectiveCurrentA: 14 } });
    expect(h.application.live).toBeNull();
    expect(h.actuatorFactory).not.toHaveBeenCalled();
    for (const write of h.writes) expect(write).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalled();
    for (const [input, options] of fetchMock.mock.calls) {
      expect(new URL(String(input)).pathname).toBe('/api/status');
      expect(options?.method).toBe('GET');
    }
  });
});
