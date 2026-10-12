import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { FileConfigProvider, loadConfig } from '../config/config-loader.js';
import { probeDevices } from '../diagnostics/probe-service.js';
import { createLogger, parseLogLevel } from '../logging/logger.js';
import { formatProbeReport } from './probe-format.js';

/** Exit 0: all enabled devices valid; 1: device unavailable; 2: configuration/usage error. */
export async function runProbeCli(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  let configPath: string;
  try {
    const { values } = parseArgs({
      args: [...args],
      options: { config: { type: 'string', default: 'config.json' }, help: { type: 'boolean', short: 'h' } },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      process.stdout.write('Usage: npm run probe -- --config ./config.json\nPerforms one read-only GET status request per enabled device.\n');
      return 0;
    }
    configPath = values.config;
  } catch {
    process.stderr.write('Invalid arguments. Use npm run probe -- --help\n');
    return 2;
  }

  const logger = createLogger(parseLogLevel(process.env['LOG_LEVEL']));
  const config = await loadConfig(new FileConfigProvider(configPath));
  if (!config.ok) {
    logger.error({ errorCode: config.error.code, detail: config.error.message }, 'Configuration could not be loaded');
    return 2;
  }
  logger.info('Configuration loaded');
  const report = await probeDevices(config.value, { logger });
  process.stdout.write(formatProbeReport(report));
  return report.controller.ok && report.chargers.every((charger) => charger.status !== 'unavailable') ? 0 : 1;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  try {
    process.exitCode = await runProbeCli();
  } catch {
    process.stderr.write('The diagnostic could not be completed.\n');
    process.exitCode = 2;
  }
}
