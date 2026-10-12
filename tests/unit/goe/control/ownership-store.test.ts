import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reconcileOwnership } from '../../../../src/goe/control/actuator-reconciler.js';
import { FileOwnershipStore } from '../../../../src/goe/control/ownership-store.js';
import type { OwnershipDocument } from '../../../../src/goe/control/ownership-state.js';
import { makeObservation, makeOwnedState } from './ownership-helpers.js';

const prefix = resolve('tests', '.tmp-ownership-');
const directories: string[] = [];
async function createStore() {
  const directory = await mkdtemp(prefix);
  directories.push(directory);
  return { directory, store: new FileOwnershipStore(directory) };
}
const document = (): OwnershipDocument => ({ version: 1, chargers: [makeOwnedState()] });

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const absolute = resolve(directory);
    if (!absolute.startsWith(prefix)) throw new Error('Refusing test cleanup outside known temporary directory');
    await rm(absolute, { recursive: true, force: true });
  }
});

describe('atomic actuator ownership persistence', () => {
  it('distinguishes missing state from corrupt state without resetting ownership', async () => {
    const { store } = await createStore();
    expect(await store.load()).toEqual({ ok: true, value: null });
    await writeFile(store.path, '{corrupt');
    expect(await store.load()).toMatchObject({ ok: false, error: { code: 'ConfigurationError' } });
    expect(await readFile(store.path, 'utf8')).toBe('{corrupt');
  });

  it('round-trips confirmed state across a new store instance and leaves no temporary files', async () => {
    const { store, directory } = await createStore();
    expect(await store.save(document())).toEqual({ ok: true, value: undefined });
    expect(await new FileOwnershipStore(directory).load()).toEqual({ ok: true, value: document() });
    expect(await readdir(directory)).toEqual(['actuator-state.json']);
    expect(await readFile(store.path, 'utf8')).toBe(`${JSON.stringify(document(), null, 2)}\n`);
  });

  it('replaces the complete previous document', async () => {
    const { store } = await createStore();
    await store.save(document());
    expect(await store.save({ version: 1, chargers: [] })).toEqual({ ok: true, value: undefined });
    expect(await store.load()).toEqual({ ok: true, value: { version: 1, chargers: [] } });
  });

  it('preserves last valid state if new state fails validation', async () => {
    const { store } = await createStore();
    await store.save(document());
    const unsafe: OwnershipDocument = { version: 1, chargers: [makeOwnedState({ baseline: null })] };
    expect((await store.save(unsafe)).ok).toBe(false);
    expect(await store.load()).toEqual({ ok: true, value: document() });
  });

  it.each([
    { version: 7, chargers: [] },
    { version: 1, chargers: [{ pluginOwnedPause: true }] },
    { version: 1, chargers: [makeOwnedState({ baseline: makeObservation({ frc: 1 }), pluginOwnedPause: true })] },
  ])('rejects parseable but unsafe persisted state %j', async (input) => {
    const { store } = await createStore();
    await writeFile(store.path, JSON.stringify(input));
    expect(await store.load()).toMatchObject({ ok: false, error: { code: 'ConfigurationError' } });
  });

  it('never persists credentials, activation keys or raw network objects', async () => {
    const { store } = await createStore();
    const original = makeOwnedState();
    const input = {
      version: 1 as const, authToken: 'private-token', clientId: 'private-id',
      chargers: [{
        ...original, activationKey: 'private-key',
        baseline: { ...makeObservation(), raw: { password: 'private-password' } },
        lastReadback: { ...original.lastReadback, rawPayload: 'private-payload' } as typeof original.lastReadback,
      }],
    };
    expect((await store.save(input)).ok).toBe(true);
    expect(await readFile(store.path, 'utf8')).not.toMatch(/private|authToken|clientId|activationKey|password|raw/u);
    expect(await store.load()).toEqual({ ok: true, value: document() });
  });

  it('strips unknown data also when loading an existing document', async () => {
    const { store } = await createStore();
    await writeFile(store.path, JSON.stringify({ ...document(), authToken: 'private-token' }));
    expect(await store.load()).toEqual({ ok: true, value: document() });
  });

  it('reconciles loaded ownership with current status before trusting it', async () => {
    const { store, directory } = await createStore();
    await store.save(document());
    const loaded = await new FileOwnershipStore(directory).load();
    expect(loaded.ok).toBe(true);
    if (!loaded.ok || loaded.value === null || loaded.value.chargers[0] === undefined) throw new Error('Expected persisted state');
    const current = makeObservation({ tcl: 8, readStartedAtMs: 1_990, observedAtMs: 2_000 });
    expect(reconcileOwnership(loaded.value.chargers[0], current)).toMatchObject({ ownershipStatus: 'CONFLICT', conflictStatus: 'EXTERNAL_TCL_CHANGE' });
  });

  it('returns a safe error for filesystem failures without including raw exception content', async () => {
    const { directory } = await createStore();
    const obstructed = `${directory}/private-token`;
    await writeFile(obstructed, 'not a directory');
    const store = new FileOwnershipStore(obstructed);
    const result = await store.save(document());
    expect(result).toMatchObject({ ok: false, error: { code: 'ConfigurationError' } });
    expect(JSON.stringify(result)).not.toContain('private-token');
  });

  it('reports a read error distinct from an absent file', async () => {
    const { store } = await createStore();
    await mkdir(store.path);
    expect(await store.load()).toMatchObject({ ok: false, error: { code: 'ConfigurationError' } });
  });

  it('cleans temporary files when final rename fails', async () => {
    const { store, directory } = await createStore();
    await mkdir(store.path);
    expect((await store.save(document())).ok).toBe(false);
    expect(await readdir(directory)).toEqual(['actuator-state.json']);
  });
});
