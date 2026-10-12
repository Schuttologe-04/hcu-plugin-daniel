import { readFile } from 'node:fs/promises';
import { failure, type Result } from '../domain/errors.js';
import { validateConfig } from './config-schema.js';
import type { AppConfig, ConfigProvider } from './config-types.js';

/** Current local source; replace with another ConfigProvider for HCUweb later. */
export class FileConfigProvider implements ConfigProvider {
  public constructor(private readonly path: string) {}

  public async load(): Promise<unknown> {
    const contents = await readFile(this.path, 'utf8');
    const parsed: unknown = JSON.parse(contents);
    return parsed;
  }
}

/** The application boundary never exposes filesystem, JSON or provider errors. */
export async function loadConfig(provider: ConfigProvider): Promise<Result<AppConfig>> {
  try {
    return validateConfig(await provider.load());
  } catch {
    return failure('ConfigurationError', 'Configuration could not be loaded or parsed.');
  }
}
