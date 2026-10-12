import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PLUGIN_ID } from '../../../../src/hcu/plugin-identity.js';
import { validateInteractionDocument, type InteractionDocument } from '../../../../src/hcu/messages/interaction-state.js';
import { FileInteractionStateStore } from '../../../../src/hcu/messages/interaction-state-store.js';

const prefix = resolve('tests', '.tmp-hcu-interactions-');
const directories: string[] = [];
const document = (): InteractionDocument => ({ version: 1, pluginId: PLUGIN_ID,
  session: { sessionId: 'session-1', interventionRequested: true, overrideActive: false },
  messages: [{ userMessageId: 'question-1', sessionId: 'session-1', messagePurpose: 'LIVE_INTERVENTION',
    createdAt: 1_000, state: 'OPEN', answer: null }] });

async function createStore() {
  const directory = await mkdtemp(prefix);
  directories.push(directory);
  return { directory, store: new FileInteractionStateStore(directory) };
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const absolute = resolve(directory);
    if (!absolute.startsWith(prefix)) throw new Error('Refusing cleanup outside interaction test directory');
    await rm(absolute, { recursive: true, force: true });
  }
});

describe('atomic HCU interaction state', () => {
  it('uses a separate user-message-state.json file and distinguishes first install from corrupt persistence', async () => {
    const { store } = await createStore();
    expect(store.path).toMatch(/user-message-state\.json$/u);
    expect(await store.load()).toEqual({ ok: true, value: null });
    await writeFile(store.path, '{ damaged');
    expect(await store.load()).toMatchObject({ ok: false, error: { code: 'ConfigurationError' } });
    expect(await readFile(store.path, 'utf8')).toBe('{ damaged');
  });

  it('atomically round-trips across restart and removes temporary files', async () => {
    const { store, directory } = await createStore();
    expect((await store.save(document())).ok).toBe(true);
    expect(await new FileInteractionStateStore(directory).load()).toEqual({ ok: true, value: document() });
    expect(await readdir(directory)).toEqual(['user-message-state.json']);
    expect(await readFile(store.path, 'utf8')).toBe(`${JSON.stringify(document(), null, 2)}\n`);
  });

  it('does not overwrite the last valid document when new input contradicts session evidence', async () => {
    const { store } = await createStore();
    await store.save(document());
    expect((await store.save({ ...document(), session: { ...document().session, overrideActive: true } })).ok).toBe(false);
    expect(await store.load()).toEqual({ ok: true, value: document() });
  });

  it('strips credentials, raw HCU payloads and unknown fields on save and load', async () => {
    const { store } = await createStore();
    const input = { ...document(), authToken: 'private-token', clientId: 'private-client', activationKey: 'private-key',
      session: { ...document().session, secret: 'private-session' },
      messages: [{ ...document().messages[0]!, rawPayload: 'private-payload' }] };
    expect((await store.save(input)).ok).toBe(true);
    expect(await readFile(store.path, 'utf8')).not.toMatch(/private|secret|authToken|clientId|activationKey|rawPayload/u);
    await writeFile(store.path, JSON.stringify(input));
    expect(await store.load()).toEqual({ ok: true, value: document() });
  });

  it('contains write errors without exposing a raw filesystem path or credential-like content', async () => {
    const { directory } = await createStore();
    const blocked = `${directory}/private-token`;
    await writeFile(blocked, 'obstructed');
    const result = await new FileInteractionStateStore(blocked).save(document());
    expect(result).toMatchObject({ ok: false, error: { code: 'ConfigurationError' } });
    expect(JSON.stringify(result)).not.toMatch(/private|EEXIST|ENOENT/u);
  });

  it('contains read errors rather than treating an unreadable file as first install', async () => {
    const { store } = await createStore();
    await mkdir(store.path);
    expect((await store.load()).ok).toBe(false);
  });

  it('cleans up a failed rename temporary without replacing existing content', async () => {
    const { store, directory } = await createStore();
    await mkdir(store.path);
    expect((await store.save(document())).ok).toBe(false);
    expect(await readdir(directory)).toEqual(['user-message-state.json']);
  });
});

describe('interaction schema validation', () => {
  it.each([
    null, [], {}, { ...document(), version: 2 }, { ...document(), pluginId: 'foreign.plugin' },
    { ...document(), session: null }, { ...document(), messages: {} },
    { ...document(), session: { ...document().session, sessionId: '' } },
    { ...document(), session: { ...document().session, sessionId: ' bad ' } },
    { ...document(), session: { ...document().session, interventionRequested: 'true' } },
    { ...document(), session: { ...document().session, overrideActive: 1 } },
    { ...document(), session: { ...document().session, interventionRequested: false } },
    { ...document(), session: { ...document().session, overrideActive: true } },
    { ...document(), messages: [...document().messages, ...document().messages] },
    ...[
      { userMessageId: '' }, { userMessageId: 'bad\nID' }, { sessionId: '' }, { createdAt: -1 },
      { createdAt: Number.NaN }, { createdAt: 1.5 }, { createdAt: '1000' }, { messagePurpose: 'UNKNOWN' },
      { messagePurpose: {} }, { state: 'UNKNOWN' }, { state: {} }, { answer: 'OK' },
      { state: 'ANSWERED', answer: null }, { state: 'OPEN', answer: 'YES' },
    ].map((patch) => ({ ...document(), messages: [{ ...document().messages[0], ...patch }] })),
  ])('rejects corrupt or contradictory document %#', (input) => {
    expect(validateInteractionDocument(input)).toMatchObject({ ok: false, error: { code: 'ConfigurationError' } });
  });

  it('accepts a persisted YES only with matching affirmative current-session evidence', () => {
    const original = document();
    const input: InteractionDocument = { ...original, session: { ...original.session, overrideActive: true },
      messages: [{ ...original.messages[0]!, state: 'DELETED', answer: 'YES' }] };
    expect(validateInteractionDocument(input)).toEqual({ ok: true, value: input });
    expect(validateInteractionDocument({ ...input, messages: [{ ...input.messages[0], sessionId: 'old-session' }] }).ok).toBe(false);
  });

  it('rejects multiple open current-session questions even when IDs are distinct', () => {
    const original = document();
    expect(validateInteractionDocument({ ...original, messages: [...original.messages,
      { ...original.messages[0], userMessageId: 'question-2' }] }).ok).toBe(false);
  });
});
