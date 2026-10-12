import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { AppConfig, ConfigProvider } from '../../config/config-types.js';
import { validateConfig } from '../../config/config-schema.js';
import { failure, success, type Result } from '../../domain/errors.js';

export interface ConfigStore {
  load(): Promise<Result<AppConfig | null>>;
  save(config: AppConfig): Promise<Result<void>>;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** Persists only validated AppConfig; remote credentials are deliberately absent. */
export class FileConfigStore implements ConfigStore {
  private readonly directory: string;
  public readonly path: string;

  public constructor(directory: string) {
    this.directory = resolve(directory);
    this.path = join(this.directory, 'plugin-config.json');
  }

  public async load(): Promise<Result<AppConfig | null>> {
    let contents: string;
    try {
      contents = await readFile(this.path, 'utf8');
    } catch (error: unknown) {
      return isMissingFile(error) ? success(null)
        : failure('ConfigurationError', 'Persisted plugin configuration could not be read.');
    }
    try {
      const parsed: unknown = JSON.parse(contents);
      const validated = validateConfig(parsed);
      return validated.ok ? validated
        : failure('ConfigurationError', 'Persisted plugin configuration is invalid.');
    } catch {
      return failure('ConfigurationError', 'Persisted plugin configuration is corrupt.');
    }
  }

  public async save(config: AppConfig): Promise<Result<void>> {
    // Validate again at the persistence boundary and strip unknown fields/tokens.
    const validated = validateConfig(config);
    if (!validated.ok) return validated;
    const temporaryPath = join(this.directory, `.plugin-config-${randomUUID()}.tmp`);
    try {
      await mkdir(this.directory, { recursive: true });
      const file = await open(temporaryPath, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(validated.value, null, 2)}\n`, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      // Same-directory rename commits the complete file, never partial JSON.
      await rename(temporaryPath, this.path);
      return success(undefined);
    } catch {
      try { await unlink(temporaryPath); } catch { /* Best-effort temp cleanup. */ }
      return failure('ConfigurationError', 'Plugin configuration could not be stored atomically.');
    }
  }
}

/** Adapts persisted configuration to the existing provider/loader contract. */
export class StoredConfigProvider implements ConfigProvider {
  public constructor(private readonly store: ConfigStore) {}

  public async load(): Promise<unknown> {
    const result = await this.store.load();
    if (!result.ok || result.value === null) {
      throw new Error('Persisted plugin configuration is unavailable.');
    }
    return result.value;
  }
}
