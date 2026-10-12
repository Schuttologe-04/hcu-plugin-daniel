import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { FileConfigProvider, loadConfig } from '../config/config-loader.js';
import type { ConfigProvider } from '../config/config-types.js';
import { FileConfigStore, type ConfigStore } from '../hcu/config/config-store.js';
import { RandomIdProvider, type IdProvider } from '../hcu/id-provider.js';
import type { HcuEnvironment, ResolvedHcuEnvironment } from '../hcu/runtime/hcu-environment.js';
import { RemoteDevelopmentEnvironment } from '../hcu/runtime/remote-environment.js';
import { HcuWebSocketClient } from '../hcu/websocket-client.js';
import { createLogger, parseLogLevel } from '../logging/logger.js';
import { HcuPluginApplication } from '../orchestration/hcu-plugin-application.js';
import type { Logger } from 'pino';
import { ChargerActuator } from '../goe/control/charger-actuator.js';
import { GoEChargerControlClient } from '../goe/control/charger-control-client.js';
import { FileOwnershipStore } from '../goe/control/ownership-store.js';
import type { AppConfig } from '../config/config-types.js';
import type { WriteGate } from '../goe/control/control-types.js';

export interface HcuCliDependencies {
  readonly environment?: HcuEnvironment;
  readonly store?: ConfigStore;
  readonly configProvider?: ConfigProvider;
  readonly clientFactory?: (settings: ResolvedHcuEnvironment) => HcuWebSocketClient;
  readonly now?: () => number;
  readonly idProvider?: IdProvider;
  readonly logger?: Logger;
  readonly onStarted?: (application: HcuPluginApplication) => void;
  readonly realWritesFlag?: string;
  readonly actuatorFactory?: (config: AppConfig, dataDirectory: string, gate: WriteGate, now: () => number) => ChargerActuator;
}

/** Starts only the explicitly selected mode. Helpers never acquire a token or activate HCU settings. */
export async function runHcuCli(args: readonly string[] = process.argv.slice(2), dependencies: HcuCliDependencies = {}, entryMode: 'HCU_DEV' | 'LIVE' = 'HCU_DEV'): Promise<number> {
  let configPath: string;
  let dryRun: boolean;
  let testMessage: boolean;
  try {
    const { values } = parseArgs({
      args: [...args], strict: true, allowPositionals: false,
      options: {
        config: { type: 'string', default: 'config.json' },
        'dry-run': { type: 'boolean', default: false },
        'test-message': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h' },
      },
    });
    if (values.help) {
      if (entryMode === 'LIVE') {
        process.stdout.write('Usage: npm run hcu:live -- --config ./config.json\n'
          + 'Requires GOE_REAL_WRITES_ENABLED=true. Prepared runtime and read-only startup reconciliation only.\n'
          + 'No automatic live control loop, refresh timer or canary is started.\n');
        return 0;
      }
      process.stdout.write('Usage: npm run hcu:dev -- --config ./config.json\n'
        + 'hcu:dev: HCU only; hcu:dry-run: explicit read-only go-e polling and virtual actions.\n'
        + 'hcu:test-message: explicitly sends one TEST YES/NO question and waits for responses.\n'
        + 'No command writes to a go-e device. Credentials are read only from the environment.\n');
      return 0;
    }
    configPath = values.config;
    dryRun = values['dry-run'];
    testMessage = values['test-message'];
    if (dryRun && testMessage) throw new Error('Select one explicit mode.');
    if (entryMode === 'LIVE' && (dryRun || testMessage)) throw new Error('LIVE cannot be mixed with read-only modes.');
  } catch {
    process.stderr.write('Invalid HCU arguments. Use npm run hcu:dev -- --help\n');
    return 2;
  }
  const logger = dependencies.logger ?? createLogger(parseLogLevel(process.env['LOG_LEVEL']));
  const realWritesEnabled = entryMode === 'LIVE' && (dependencies.realWritesFlag ?? process.env['GOE_REAL_WRITES_ENABLED']) === 'true';
  if (entryMode === 'LIVE' && !realWritesEnabled) {
    logger.error('WRITE_BLOCKED: hcu:live requires GOE_REAL_WRITES_ENABLED=true; startup stopped.');
    return 2;
  }
  const environment = await (dependencies.environment ?? new RemoteDevelopmentEnvironment()).resolve();
  if (!environment.ok) {
    logger.error({ errorCode: environment.error.code, detail: environment.error.message }, 'HCU remote environment unavailable');
    return 2;
  }
  const store = dependencies.store ?? new FileConfigStore(environment.value.dataDirectory);
  const persisted = await store.load();
  if (!persisted.ok) {
    logger.error({ errorCode: persisted.error.code }, 'Persisted configuration invalid; startup stopped');
    return 2;
  }
  let config = persisted.value;
  if (config === null) {
    const seeded = await loadConfig(dependencies.configProvider ?? new FileConfigProvider(configPath));
    if (!seeded.ok) {
      logger.error({ errorCode: seeded.error.code }, 'A valid initial plugin configuration is required');
      return 2;
    }
    const saved = await store.save(seeded.value);
    if (!saved.ok) {
      logger.error({ errorCode: saved.error.code }, 'Initial configuration could not be persisted');
      return 2;
    }
    config = seeded.value;
  }
  const ids = dependencies.idProvider ?? new RandomIdProvider();
  const now = dependencies.now ?? (() => Date.now());
  const gate: WriteGate = { executionMode: entryMode, realWritesEnabled };
  const actuator = entryMode === 'LIVE'
    ? dependencies.actuatorFactory?.(config, environment.value.dataDirectory, gate, now)
      ?? new ChargerActuator({ gate, now, logger,
        client: new GoEChargerControlClient({ gate, now, timeoutMs: config.http.timeoutMs }),
        store: new FileOwnershipStore(environment.value.dataDirectory) })
    : undefined;
  const client = dependencies.clientFactory?.(environment.value)
    ?? new HcuWebSocketClient({ ...environment.value, logger, idProvider: ids });
  const application = new HcuPluginApplication({
    client, store, config, mode: entryMode === 'LIVE' ? 'LIVE' : dryRun ? 'DRY_RUN' : 'HCU_DEV',
    now, idProvider: ids, logger, sendTestMessage: testMessage,
    ...(actuator === undefined ? {} : { liveActuator: actuator, realWritesEnabled }),
  });
  if (application.live !== null) {
    const initialized = await application.live.initialize();
    if (!initialized.ok) {
      logger.error({ errorCode: initialized.error.code }, 'LIVE reconciliation failed; startup stopped');
      await application.stop();
      return 2;
    }
  }
  const shutdown = (): void => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    void application.stop().then(() => { process.exitCode = 0; }, () => {
      logger.error('HCU plugin shutdown failed; check ownership persistence before restarting');
      process.exitCode = 1;
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  application.start();
  dependencies.onStarted?.(application);
  logger.info({ mode: entryMode === 'LIVE' ? 'LIVE' : dryRun ? 'DRY_RUN' : 'HCU_DEV', realChargerWritesEnabled: realWritesEnabled,
    automaticLiveControlEnabled: false }, 'HCU plugin started');
  return 0;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  try { process.exitCode = await runHcuCli(); }
  catch {
    process.stderr.write('The HCU plugin could not be started. No credentials were logged.\n');
    process.exitCode = 2;
  }
}
