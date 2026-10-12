import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHcuInstalledCli, type InstalledCliDependencies } from '../../../src/cli/hcu-installed.js';
import { validateConfig } from '../../../src/config/config-schema.js';
import { buildConfigTemplate } from '../../../src/hcu/config/config-template-builder.js';
import { InstalledHcuEnvironment } from '../../../src/hcu/runtime/installed-environment.js';
import { HcuWebSocketClient } from '../../../src/hcu/websocket-client.js';
import { ChargerActuator } from '../../../src/goe/control/charger-actuator.js';
import { failure, success } from '../../../src/domain/errors.js';
import { createLogger } from '../../../src/logging/logger.js';
import type { HcuPluginApplication } from '../../../src/orchestration/hcu-plugin-application.js';
import { makeConfig } from '../load-management/helpers.js';
import { makeObservation } from '../goe/control/ownership-helpers.js';
import { fakeFactory, SequenceIds } from './transport-helpers.js';

const apps: HcuPluginApplication[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Real network forbidden'); }));
});
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.stop()));
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

function setup(persisted = false) {
  const seed = { ...makeConfig(), loadManagement: { ...makeConfig().loadManagement, liveControlEnabled: false } };
  const store = { load: vi.fn(async () => success(persisted ? seed : null)), save: vi.fn(async () => success(undefined)) };
  const seedProvider = { load: vi.fn(async () => seed) };
  const readTextFile = vi.fn(async (path: string) => path === '/TOKEN' ? 'MOCK_INSTALLED_TOKEN' : 'MOCK_METADATA');
  const environment = new InstalledHcuEnvironment({ readTextFile });
  const interactionStore = { load: vi.fn(async () => success(null)), save: vi.fn(async () => success(undefined)) };
  const fake = fakeFactory();
  const write = vi.fn(async () => success(undefined));
  const actuatorFactory = vi.fn<NonNullable<InstalledCliDependencies['actuatorFactory']>>((_config, _directory, gate, now) => new ChargerActuator({ gate, now,
    store: { load: async () => success(null), save: async () => success(undefined) },
    client: { readStatus: async charger => success(makeObservation({ chargerId: charger.id, host: charger.host,
      readStartedAtMs: now(), observedAtMs: now(), firmwareVersion: '59.4', tclClearCapability: 'VERIFIED' })),
      setTemporaryCurrentLimit: write, clearTemporaryCurrentLimit: write, pause: write, resume: write },
  }));
  const logger = createLogger('error', { write: () => undefined });
  const dependencies: InstalledCliDependencies = { store, seedProvider, environment, interactionStore, actuatorFactory, logger,
    registerSignals: false, now: () => 0, idProvider: new SequenceIds(),
    clientFactory: settings => new HcuWebSocketClient({ ...settings, webSocketFactory: fake.factory, idProvider: new SequenceIds() }),
    onStarted: (app: HcuPluginApplication) => apps.push(app) };
  return { seed, dependencies, store, seedProvider, readTextFile, interactionStore, actuatorFactory, write, fake };
}

describe('installed container entry without any actual HCU or charger requests', () => {
  it('help performs no credential read, socket creation or actuator initialization', async () => {
    const h = setup();
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    expect(await runHcuInstalledCli(['--help'], h.dependencies)).toBe(0);
    expect(h.readTextFile).not.toHaveBeenCalled();
    expect(h.actuatorFactory).not.toHaveBeenCalled();
    expect(h.fake.sockets).toHaveLength(0);
  });

  it('initializes empty data from a safe seed without writing any charger', async () => {
    const h = setup();
    expect(await runHcuInstalledCli([], h.dependencies)).toBe(0);
    expect(h.store.save).toHaveBeenCalledWith(h.seed);
    expect(h.readTextFile.mock.calls.map(([path]) => path)).toEqual(['/TOKEN', '/CLIENTID', '/SGTIN']);
    expect(apps[0]?.snapshot).toMatchObject({ mode: 'INSTALLED_LIVE', realChargerWritesEnabled: true, automaticLiveControlEnabled: false });
    expect(h.write).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(h.fake.calls[0]?.url).toBe('wss://host.containers.internal:9001');
  });

  it('retains authoritative persisted configuration instead of reapplying the seed', async () => {
    const h = setup(true);
    expect(await runHcuInstalledCli([], h.dependencies)).toBe(0);
    expect(h.seedProvider.load).not.toHaveBeenCalled();
    expect(h.store.save).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  });

  it('rejects an unsafe first-install seed with automatic control enabled', async () => {
    const h = setup();
    h.seedProvider.load.mockResolvedValue({ ...h.seed, loadManagement: { ...h.seed.loadManagement, liveControlEnabled: true } });
    expect(await runHcuInstalledCli([], h.dependencies)).toBe(2);
    expect(h.actuatorFactory).not.toHaveBeenCalled();
    expect(h.store.save).not.toHaveBeenCalled();
  });

  it('contains corrupt message persistence during startup and never overwrites it', async () => {
    const h = setup();
    h.interactionStore.load.mockResolvedValue(failure('ConfigurationError', 'Corrupt mock file'));
    expect(await runHcuInstalledCli([], h.dependencies)).toBe(2);
    expect(h.interactionStore.save).not.toHaveBeenCalled();
    expect(h.fake.sockets).toHaveLength(0);
    expect(h.write).not.toHaveBeenCalled();
  });

  it('rejects global TLS bypass before reading system credentials', async () => {
    const h = setup(); vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
    expect(await runHcuInstalledCli([], h.dependencies)).toBe(2);
    expect(h.readTextFile).not.toHaveBeenCalled();
  });

  it('keeps installed activation optional in legacy config and validates its explicit type', () => {
    expect(validateConfig(makeConfig()).ok).toBe(true);
    expect(validateConfig({ ...makeConfig(), loadManagement: { ...makeConfig().loadManagement, liveControlEnabled: 'true' } }).ok).toBe(false);
  });

  it.each(['', 'invalid token', 'token\u0000value', '\ufffdcorrupt', 'x'.repeat(4097)])('rejects invalid installed token content %# without exposing it', async (token) => {
    const result = await new InstalledHcuEnvironment({ readTextFile: async path => path === '/TOKEN' ? token : 'MOCK_METADATA' }).resolve();
    expect(result).toMatchObject({ ok: false, error: { code: 'ConfigurationError' } });
    expect(JSON.stringify(result)).not.toContain('MOCK_METADATA');
    if (token.length > 0) expect(JSON.stringify(result)).not.toContain(token);
  });

  it('shows installed activation false as a valid optional checkbox and available capability', async () => {
    const h = setup(); await runHcuInstalledCli([], h.dependencies);
    const snapshot = apps[0]!.snapshot;
    const properties = buildConfigTemplate(h.seed, snapshot).properties;
    expect(properties['loadManagement.liveControlEnabled']).toMatchObject({ dataType: 'BOOLEAN', currentValue: 'false', defaultValue: 'false' });
    expect(properties['loadManagement.liveControlEnabled']).not.toHaveProperty('required');
    expect(properties['diagnostics.containerWriteCapability']?.currentValue).toBe('verfügbar');
    expect(properties['diagnostics.automaticLiveControlEnabled']?.currentValue).toBe('AUS');
  });
});
