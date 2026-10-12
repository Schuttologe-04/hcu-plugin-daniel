import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { failure, success, type Result } from '../../domain/errors.js';
import { validateInteractionDocument, type InteractionDocument, type InteractionStateStore } from './interaction-state.js';

export type { InteractionStateStore } from './interaction-state.js';

/** Atomic, versioned HCU interaction state, separate from config and actuator ownership. */
export class FileInteractionStateStore implements InteractionStateStore {
  public readonly path: string;
  private readonly directory: string;

  public constructor(directory: string) {
    this.directory = resolve(directory);
    this.path = join(this.directory, 'user-message-state.json');
  }

  public async load(): Promise<Result<InteractionDocument | null>> {
    let text: string;
    try { text = await readFile(this.path, 'utf8'); } catch (error: unknown) {
      return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
        ? success(null) : failure('ConfigurationError', 'HCU interaction state could not be read.');
    }
    try { return validateInteractionDocument(JSON.parse(text) as unknown); } catch {
      return failure('ConfigurationError', 'Persisted HCU interaction state is corrupt.');
    }
  }

  public async save(document: InteractionDocument): Promise<Result<void>> {
    const validated = validateInteractionDocument(document);
    if (!validated.ok) return validated;
    const temporary = join(this.directory, `.user-message-state-${randomUUID()}.tmp`);
    try {
      await mkdir(this.directory, { recursive: true });
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(validated.value, null, 2)}\n`, 'utf8');
        await file.sync();
      } finally { await file.close(); }
      await rename(temporary, this.path);
      return success(undefined);
    } catch {
      try { await unlink(temporary); } catch { /* Preserve the original failed-commit result. */ }
      return failure('ConfigurationError', 'HCU interaction state could not be stored atomically.');
    }
  }
}
