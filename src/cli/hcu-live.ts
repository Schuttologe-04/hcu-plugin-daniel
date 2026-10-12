import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runHcuCli, type HcuCliDependencies } from './hcu-dev.js';

/** Separate entry point: hcu:dev/dry-run cannot select LIVE using their arguments. */
export function runHcuLiveCli(args: readonly string[] = process.argv.slice(2), dependencies: HcuCliDependencies = {}): Promise<number> {
  return runHcuCli(args, dependencies, 'LIVE');
}

const entryPath = process.argv[1];
if (entryPath !== undefined && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  try { process.exitCode = await runHcuLiveCli(); }
  catch { process.stderr.write('LIVE startup failed closed. No credentials were logged.\n'); process.exitCode = 2; }
}
