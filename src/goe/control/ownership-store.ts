import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { failure, success, type Result } from '../../domain/errors.js';
import { validateOwnershipDocument, type OwnershipDocument, type OwnershipStore } from './ownership-state.js';

export type { OwnershipStore } from './ownership-state.js';

function missingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

/** Same-directory atomic persistence; all state is revalidated and whitelisted. */
export class FileOwnershipStore implements OwnershipStore {
  private readonly directory: string;
  public readonly path: string;

  public constructor(directory: string) {
    this.directory = resolve(directory);
    this.path = join(this.directory, 'actuator-state.json');
  }

  public async load(): Promise<Result<OwnershipDocument | null>> {
    let contents: string;
    try {
      contents = await readFile(this.path, 'utf8');
    } catch (error: unknown) {
      return missingFile(error) ? success(null)
        : failure('ConfigurationError', 'Persisted actuator ownership state could not be read.');
    }
    try {
      const input: unknown = JSON.parse(contents);
      return validateOwnershipDocument(input);
    } catch {
      return failure('ConfigurationError', 'Persisted actuator ownership state is corrupt.');
    }
  }

  public async save(document: OwnershipDocument): Promise<Result<void>> {
    const validated = validateOwnershipDocument(document);
    if (!validated.ok) return validated;
    const temporaryPath = join(this.directory, `.actuator-state-${randomUUID()}.tmp`);
    try {
      await mkdir(this.directory, { recursive: true });
      const file = await open(temporaryPath, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(validated.value, null, 2)}\n`, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, this.path);
      return success(undefined);
    } catch {
      try { await unlink(temporaryPath); } catch { /* Best effort: never mask the failed commit. */ }
      return failure('ConfigurationError', 'Actuator ownership state could not be stored atomically.');
    }
  }
}
