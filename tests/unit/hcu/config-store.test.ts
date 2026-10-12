import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/config-loader.js';
import { FileConfigStore, StoredConfigProvider } from '../../../src/hcu/config/config-store.js';
import { makeConfig } from '../load-management/helpers.js';

const prefix = resolve('tests', '.tmp-hcu-config-');
const directories: string[] = [];

async function store() {
  const directory = await mkdtemp(prefix);
  directories.push(directory);
  return { directory, store: new FileConfigStore(directory) };
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const target = resolve(directory);
    if (!target.startsWith(prefix)) throw new Error('Refusing cleanup outside test directory');
    await rm(target, { recursive: true, force: true });
  }
});

describe('atomic AppConfig store', () => {
  it('distinguishes a missing store from a corrupt store', async () => {
    const { store: persistence } = await store();
    expect(await persistence.load()).toEqual({ ok: true, value: null });
    await writeFile(persistence.path, '{ corrupt', 'utf8');
    expect(await persistence.load()).toMatchObject({ ok: false, error: { code: 'ConfigurationError' } });
  });

  it('round-trips complete validated config and leaves no temporary files', async () => {
    const { store: persistence, directory } = await store();
    const config = makeConfig();
    expect(await persistence.save(config)).toEqual({ ok: true, value: undefined });
    expect(await persistence.load()).toEqual({ ok: true, value: config });
    expect(await readdir(directory)).toEqual(['plugin-config.json']);
    expect(await readFile(persistence.path, 'utf8')).toBe(`${JSON.stringify(config, null, 2)}\n`);
  });

  it('replaces persisted configuration completely in an atomic rename', async () => {
    const { store: persistence } = await store();
    await persistence.save(makeConfig());
    const config = makeConfig({ loadManagement: { gridLimitW: 24_000 } });
    await persistence.save(config);
    expect(await persistence.load()).toEqual({ ok: true, value: config });
  });

  it('does not overwrite the valid file when a new config fails validation', async () => {
    const { store: persistence } = await store();
    await persistence.save(makeConfig());
    expect((await persistence.save(makeConfig({ loadManagement: { gridLimitW: 0 } }))).ok).toBe(false);
    expect(await persistence.load()).toEqual({ ok: true, value: makeConfig() });
  });

  it('strips credential fields rather than persisting them with plugin configuration', async () => {
    const { store: persistence } = await store();
    const withCredentials = { ...makeConfig(), authtoken: 'private-auth-value', credentials: { password: 'private-password' } };
    await persistence.save(withCredentials);
    const persisted = await readFile(persistence.path, 'utf8');
    expect(persisted).not.toMatch(/private|authtoken|credentials/u);
    expect(await persistence.load()).toEqual({ ok: true, value: makeConfig() });
  });

  it('rejects invalid but parseable persisted configuration', async () => {
    const { store: persistence } = await store();
    await writeFile(persistence.path, JSON.stringify({ controller: { host: 'x' } }));
    expect((await persistence.load()).ok).toBe(false);
  });

  it('surfaces filesystem write failures as safe Result errors', async () => {
    const { directory } = await store();
    const blockedPath = `${directory}/blocked`;
    await writeFile(blockedPath, 'file obstructing directory');
    const persistence = new FileConfigStore(blockedPath);
    expect(await persistence.save(makeConfig())).toMatchObject({ ok: false, error: { code: 'ConfigurationError' } });
  });

  it('integrates with the existing replaceable ConfigProvider/loader interface', async () => {
    const { store: persistence } = await store();
    await persistence.save(makeConfig());
    expect(await loadConfig(new StoredConfigProvider(persistence))).toEqual({ ok: true, value: makeConfig() });
  });

  it('does not silently default a missing/corrupt persisted provider', async () => {
    const { store: persistence } = await store();
    expect((await loadConfig(new StoredConfigProvider(persistence))).ok).toBe(false);
    await writeFile(persistence.path, 'not JSON');
    expect((await loadConfig(new StoredConfigProvider(persistence))).ok).toBe(false);
  });
});
