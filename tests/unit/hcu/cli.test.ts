import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../../src/logging/logger.js';
import { runHcuCli, type HcuCliDependencies } from '../../../src/cli/hcu-dev.js';
import type { AppConfig } from '../../../src/config/config-types.js';
import { success, failure } from '../../../src/domain/errors.js';
import type { HcuPluginApplication } from '../../../src/orchestration/hcu-plugin-application.js';
import { HcuWebSocketClient } from '../../../src/hcu/websocket-client.js';
import type { ResolvedHcuEnvironment } from '../../../src/hcu/runtime/hcu-environment.js';
import { fakeFactory, transportSettings, SequenceIds } from './transport-helpers.js';
import { makeConfig } from '../load-management/helpers.js';

const applications: HcuPluginApplication[] = [];
let initialInterrupt: NodeJS.SignalsListener[];
let initialTerminate: NodeJS.SignalsListener[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  initialInterrupt = process.listeners('SIGINT');
  initialTerminate = process.listeners('SIGTERM');
});

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.stop()));
  for (const listener of process.listeners('SIGINT')) {
    if (!initialInterrupt.includes(listener)) process.off('SIGINT', listener);
  }
  for (const listener of process.listeners('SIGTERM')) {
    if (!initialTerminate.includes(listener)) process.off('SIGTERM', listener);
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup() {
  const sockets = fakeFactory();
  const config = makeConfig();
  const ids = new SequenceIds();
  const environment = { resolve: vi.fn(async () => success({ ...transportSettings, dataDirectory: './test-data' })) };
  const store = { load: vi.fn(async () => success<AppConfig | null>(config)),
    save: vi.fn(async (_config: AppConfig) => success(undefined)) };
  const configProvider = { load: vi.fn(async (): Promise<unknown> => config) };
  let application: HcuPluginApplication | undefined;
  const clientFactory = vi.fn((settings: ResolvedHcuEnvironment) => new HcuWebSocketClient({ ...settings,
    idProvider: ids, webSocketFactory: sockets.factory }));
  const dependencies: HcuCliDependencies = {
    environment, store, configProvider, clientFactory, idProvider: ids, now: () => 0,
    logger: createLogger('error', { write: () => undefined }),
    onStarted: (value) => { application = value; applications.push(value); },
  };
  return { dependencies, environment, store, configProvider, clientFactory, sockets,
    get application() {
      if (application === undefined) throw new Error('Application did not start');
      return application;
    } };
}

describe('Explicit HCU CLI modes and safe startup', () => {
  it.each([[], ['--dry-run'], ['--test-message']].map((mode) => ({ mode })))('help does not resolve credentials, touch configuration or open a socket ($mode)', async ({ mode }) => {
    const context = setup();
    expect(await runHcuCli([...mode, '--help'], context.dependencies)).toBe(0);
    expect(context.environment.resolve).not.toHaveBeenCalled();
    expect(context.store.load).not.toHaveBeenCalled();
    expect(context.clientFactory).not.toHaveBeenCalled();
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('No command writes to a go-e device'));
  });

  it.each([['--unknown'], ['unwanted'], ['--config'], ['--dry-run', '--test-message']].map((args) => ({ args })))('rejects invalid arguments before starting ($args)', async ({ args }) => {
    const context = setup();
    expect(await runHcuCli(args, context.dependencies)).toBe(2);
    expect(context.environment.resolve).not.toHaveBeenCalled();
    expect(context.clientFactory).not.toHaveBeenCalled();
  });

  it('stops on missing credentials before reading or persisting configuration', async () => {
    const context = setup();
    context.environment.resolve.mockResolvedValue(failure('ConfigurationError', 'Missing HCU_AUTHTOKEN.'));
    expect(await runHcuCli([], context.dependencies)).toBe(2);
    expect(context.store.load).not.toHaveBeenCalled();
    expect(context.store.save).not.toHaveBeenCalled();
    expect(context.clientFactory).not.toHaveBeenCalled();
  });

  it('does not silently replace a corrupt persisted configuration with local defaults', async () => {
    const context = setup();
    context.store.load.mockResolvedValue(failure('ConfigurationError', 'Corrupt persisted configuration.'));
    expect(await runHcuCli([], context.dependencies)).toBe(2);
    expect(context.configProvider.load).not.toHaveBeenCalled();
    expect(context.store.save).not.toHaveBeenCalled();
    expect(context.clientFactory).not.toHaveBeenCalled();
  });

  it('uses the persisted validated configuration and default HCU-only mode without go-e polling', async () => {
    const context = setup();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    expect(await runHcuCli([], context.dependencies)).toBe(0);
    context.sockets.sockets[0]?.emit('open');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(context.application.dryRun).toBeNull();
    expect(context.application.configService.current).toEqual(makeConfig());
    expect(context.configProvider.load).not.toHaveBeenCalled();
    expect(context.store.save).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(context.sockets.sockets[0]?.sent.some((text) => text.includes('CREATE_USER_MESSAGE_REQUEST'))).toBe(false);
  });

  it('seeds absent persistence from a fully validated provider before opening a socket', async () => {
    const context = setup();
    context.store.load.mockResolvedValue(success(null));
    context.configProvider.load.mockResolvedValue({ ...makeConfig(), authtoken: 'must-not-persist' });
    expect(await runHcuCli(['--config', './initial.json'], context.dependencies)).toBe(0);
    expect(context.store.save).toHaveBeenCalledExactlyOnceWith(makeConfig());
    expect(context.clientFactory.mock.invocationCallOrder[0]).toBeGreaterThan(context.store.save.mock.invocationCallOrder[0] ?? Infinity);
    expect(JSON.stringify(context.application.configService.current)).not.toContain('must-not-persist');
  });

  it('rejects invalid initial configuration without creating persistence or connection', async () => {
    const context = setup();
    context.store.load.mockResolvedValue(success(null));
    context.configProvider.load.mockResolvedValue({ invalid: true });
    expect(await runHcuCli([], context.dependencies)).toBe(2);
    expect(context.store.save).not.toHaveBeenCalled();
    expect(context.clientFactory).not.toHaveBeenCalled();
  });

  it('requires a successful first persistence commit before connecting', async () => {
    const context = setup();
    context.store.load.mockResolvedValue(success(null));
    context.store.save.mockResolvedValue(failure('ConfigurationError', 'Cannot persist configuration.'));
    expect(await runHcuCli([], context.dependencies)).toBe(2);
    expect(context.clientFactory).not.toHaveBeenCalled();
  });

  it('creates the polling runtime only when --dry-run was explicitly selected', async () => {
    const context = setup();
    expect(await runHcuCli(['--dry-run'], context.dependencies)).toBe(0);
    expect(context.application.dryRun).not.toBeNull();
    expect(context.application.snapshot).toMatchObject({ mode: 'DRY_RUN', realChargerWritesEnabled: false });
    // Do not advance the initial polling timer: this test exercises startup without any real HTTP.
  });

  it('selects test-message without constructing an engine or a go-e polling runtime', async () => {
    const context = setup();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    expect(await runHcuCli(['--test-message'], context.dependencies)).toBe(0);
    expect(context.application.dryRun).toBeNull();
    expect(context.sockets.sockets[0]?.sent).toEqual([]);
    context.sockets.sockets[0]?.emit('open');
    expect(context.sockets.sockets[0]?.sent.filter((text) => text.includes('CREATE_USER_MESSAGE_REQUEST'))).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
