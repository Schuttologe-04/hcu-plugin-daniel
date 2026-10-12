import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { validateConfig } from '../config/config-schema.js';
import type { ControlAction } from '../load-management/control-action.js';
import { runDemoSimulation } from '../simulation/demo.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Preserve policy and charger metadata, replace device addresses before validation. */
export function simulationConfiguration(input: unknown): unknown {
  if (!isRecord(input)) return input;
  return {
    ...input,
    controller: isRecord(input['controller']) ? { ...input['controller'], host: 'controller.sim' } : input['controller'],
    chargers: Array.isArray(input['chargers'])
      ? input['chargers'].map((charger: unknown, index: number) => isRecord(charger)
        ? { ...charger, host: `charger-${index}.sim` }
        : charger)
      : input['chargers'],
  };
}

function formatAction(action: ControlAction | null): string {
  if (action === null) return 'no action';
  return action.type === 'SET_TEMPORARY_CURRENT_LIMIT'
    ? `${action.type} ${action.chargerId} ${action.amps} A`
    : `${action.type} ${action.chargerId}`;
}

/** Offline demonstration only; this CLI never constructs a device client. */
export async function runSimulateCli(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  let configPath: string;
  try {
    const { values } = parseArgs({
      args: [...args],
      options: {
        config: { type: 'string', default: 'config.example.json' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: false,
    });
    if (values.help) {
      process.stdout.write('Usage: npm run simulate -- --config ./config.example.json\nOffline simulation: no device requests; all actions apply only to in-memory snapshots.\n');
      return 0;
    }
    configPath = values.config;
  } catch {
    process.stderr.write('Invalid arguments. Use npm run simulate -- --help\n');
    return 2;
  }

  let input: unknown;
  try {
    input = JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    process.stderr.write('The simulation configuration could not be read as JSON.\n');
    return 2;
  }
  const config = validateConfig(simulationConfiguration(input));
  if (!config.ok) {
    process.stderr.write(`Invalid simulation configuration: ${config.error.message}\n`);
    return 2;
  }

  process.stdout.write('Offline simulation — no real devices contacted.\nThe Grid sequence is supplied independently; charger power is not estimated.\n');
  for (const step of runDemoSimulation(config.value)) {
    const grid = step.gridImportW === null ? 'unavailable' : `${step.gridImportW} W`;
    process.stdout.write(`t=${step.timestampMs / 1_000}s Grid=${grid} ${step.state} -> ${formatAction(step.action)}\n`);
  }
  return 0;
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  try {
    process.exitCode = await runSimulateCli();
  } catch {
    process.stderr.write('The offline simulation could not be completed.\n');
    process.exitCode = 2;
  }
}
