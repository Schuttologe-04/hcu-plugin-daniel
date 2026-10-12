import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Logger } from 'pino';
import { FileConfigProvider, loadConfig } from '../config/config-loader.js';
import type { AppConfig, ConfigProvider } from '../config/config-types.js';
import { FileConfigStore, type ConfigStore } from '../hcu/config/config-store.js';
import { RandomIdProvider, type IdProvider } from '../hcu/id-provider.js';
import { FileInteractionStateStore } from '../hcu/messages/interaction-state-store.js';
import type { InteractionStateStore } from '../hcu/messages/interaction-state.js';
import type { HcuEnvironment, ResolvedHcuEnvironment } from '../hcu/runtime/hcu-environment.js';
import { InstalledHcuEnvironment } from '../hcu/runtime/installed-environment.js';
import { HcuWebSocketClient } from '../hcu/websocket-client.js';
import { PLUGIN_ID } from '../hcu/plugin-identity.js';
import { ChargerActuator } from '../goe/control/charger-actuator.js';
import { GoEChargerControlClient } from '../goe/control/charger-control-client.js';
import { FileOwnershipStore } from '../goe/control/ownership-store.js';
import type { WriteGate } from '../goe/control/control-types.js';
import { createLogger, parseLogLevel } from '../logging/logger.js';
import { HcuPluginApplication } from '../orchestration/hcu-plugin-application.js';

/** Distribution capability, separate from persistent operational activation. */
export const INSTALLED_WRITE_CAPABILITY = true;

export interface InstalledCliDependencies {
  readonly environment?: HcuEnvironment;
  readonly store?: ConfigStore;
  readonly seedProvider?: ConfigProvider;
  readonly interactionStore?: InteractionStateStore;
  readonly clientFactory?: (settings: ResolvedHcuEnvironment) => HcuWebSocketClient;
  readonly actuatorFactory?: (config: AppConfig, directory: string, gate: WriteGate, now: () => number) => ChargerActuator;
  readonly now?: () => number;
  readonly idProvider?: IdProvider;
  readonly logger?: Logger;
  readonly registerSignals?: boolean;
  readonly onStarted?: (application: HcuPluginApplication) => void;
}

/** Dedicated container entry; never consults remote credentials or enables user activation. */
export async function runHcuInstalledCli(args: readonly string[] = process.argv.slice(2), dependencies: InstalledCliDependencies = {}): Promise<number> {
  try {
    const { values } = parseArgs({ args: [...args], strict: true, allowPositionals: false,
      options: { help: { type: 'boolean', short: 'h' } } });
    if (values.help) {
      process.stdout.write('Installed HCU plugin: /TOKEN, /CLIENTID, /SGTIN; persistence /data.\n'
        + 'First install: telemetry active, automatic real control disabled. Enable consciously in HCUweb.\n');
      return 0;
    }
  } catch { process.stderr.write('Invalid installed plugin arguments.\n'); return 2; }
  const logger = dependencies.logger ?? createLogger(parseLogLevel(process.env['LOG_LEVEL']));
  if (process.env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0') {
    logger.error('Global TLS validation bypass is not allowed in installed mode'); return 2;
  }
  // Local HCU certificate exception belongs only to this WSS connection.
  const environment = await (dependencies.environment ?? new InstalledHcuEnvironment({ allowSelfSigned: true })).resolve();
  if (!environment.ok) { logger.error({ errorCode: environment.error.code }, 'Installed HCU files unavailable'); return 2; }
  if (environment.value.pluginId !== PLUGIN_ID) { logger.error('Installed plugin identity mismatch'); return 2; }
  const store = dependencies.store ?? new FileConfigStore(environment.value.dataDirectory);
  const loaded = await store.load();
  if (!loaded.ok) { logger.error({ errorCode: loaded.error.code }, 'Installed configuration is invalid'); return 2; }
  let config = loaded.value;
  if (config === null) {
    const seeded = await loadConfig(dependencies.seedProvider ?? new FileConfigProvider('/app/config.installed.json'));
    if (!seeded.ok || seeded.value.loadManagement.liveControlEnabled !== false) {
      logger.error('First-install seed must be valid and explicitly disable real control'); return 2;
    }
    if (!(await store.save(seeded.value)).ok) { logger.error('First-install configuration could not be persisted'); return 2; }
    config = seeded.value;
  }
  const now = dependencies.now ?? (() => Date.now());
  const ids = dependencies.idProvider ?? new RandomIdProvider();
  const gate: WriteGate = { executionMode: 'LIVE', realWritesEnabled: INSTALLED_WRITE_CAPABILITY };
  const actuator = dependencies.actuatorFactory?.(config, environment.value.dataDirectory, gate, now)
    ?? new ChargerActuator({ gate, now, logger, requireVerifiedClearForNewOwnership: true,
      store: new FileOwnershipStore(environment.value.dataDirectory),
      client: new GoEChargerControlClient({ gate, now, timeoutMs: config.http.timeoutMs,
        tclClearCapability: 'JSON_NULL_VERIFIED', tclClearFirmwareProfile: 'GO_E_59_4' }) });
  const client = dependencies.clientFactory?.(environment.value)
    ?? new HcuWebSocketClient({ ...environment.value, logger, idProvider: ids });
  const app = new HcuPluginApplication({ client, store, config, mode: 'INSTALLED_LIVE', liveActuator: actuator,
    realWritesEnabled: INSTALLED_WRITE_CAPABILITY, now, idProvider: ids, logger,
    interactionStore: dependencies.interactionStore ?? new FileInteractionStateStore(environment.value.dataDirectory) });
  const initialized = await app.initialize();
  if (!initialized.ok) {
    logger.error({ errorCode: initialized.error.code }, 'Installed reconciliation failed; no automatic control started');
    try { await app.stop(); } catch { logger.error('Failed installed startup state was preserved for recovery'); }
    return 2;
  }
  if (dependencies.registerSignals !== false) {
    const shutdown = (): void => {
      process.off('SIGTERM', shutdown); process.off('SIGINT', shutdown);
      void app.stop().then(() => { process.exitCode = 0; }, () => {
        logger.error('Installed shutdown persistence failed'); process.exitCode = 1;
      });
    };
    process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  }
  app.start();
  dependencies.onStarted?.(app);
  logger.info({ mode: 'INSTALLED_LIVE', realChargerWritesEnabled: INSTALLED_WRITE_CAPABILITY,
    automaticLiveControlEnabled: config.loadManagement.liveControlEnabled === true }, 'Installed HCU plugin started');
  return 0;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  try { process.exitCode = await runHcuInstalledCli(); }
  catch { process.stderr.write('Installed HCU plugin could not start; no credentials were logged.\n'); process.exitCode = 2; }
}
