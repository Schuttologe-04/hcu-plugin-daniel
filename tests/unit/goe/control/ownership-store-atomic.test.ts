import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileOwnershipStore } from '../../../../src/goe/control/ownership-store.js';
import { makeOwnedState } from './ownership-helpers.js';

const io = vi.hoisted(() => ({
  events: [] as string[],
  mkdir: vi.fn(), open: vi.fn(), readFile: vi.fn(), rename: vi.fn(), unlink: vi.fn(),
  writeFile: vi.fn(), sync: vi.fn(), close: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: io.mkdir, open: io.open, readFile: io.readFile, rename: io.rename, unlink: io.unlink,
}));

beforeEach(() => {
  io.events.splice(0);
  io.mkdir.mockReset().mockImplementation(async () => { io.events.push('mkdir'); });
  io.open.mockReset().mockImplementation(async () => {
    io.events.push('open');
    return { writeFile: io.writeFile, sync: io.sync, close: io.close };
  });
  io.writeFile.mockReset().mockImplementation(async () => { io.events.push('write'); });
  io.sync.mockReset().mockImplementation(async () => { io.events.push('sync'); });
  io.close.mockReset().mockImplementation(async () => { io.events.push('close'); });
  io.rename.mockReset().mockImplementation(async () => { io.events.push('rename'); });
  io.unlink.mockReset().mockImplementation(async () => { io.events.push('unlink'); });
  io.readFile.mockReset();
});

describe('ownership commit ordering', () => {
  it('commits through exclusive temporary open, write, fsync, close and same-directory rename', async () => {
    const store = new FileOwnershipStore('tests/.tmp-ownership-mocked');
    const document = { version: 1 as const, chargers: [makeOwnedState()] };
    expect(await store.save(document)).toEqual({ ok: true, value: undefined });
    expect(io.events).toEqual(['mkdir', 'open', 'write', 'sync', 'close', 'rename']);
    const temporaryPath: unknown = io.open.mock.calls[0]?.[0];
    expect(temporaryPath).toMatch(/\.actuator-state-[0-9a-f-]+\.tmp$/u);
    expect(io.open).toHaveBeenCalledWith(temporaryPath, 'wx', 0o600);
    expect(io.rename).toHaveBeenCalledWith(temporaryPath, store.path);
    expect(io.writeFile).toHaveBeenCalledWith(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
    expect(io.unlink).not.toHaveBeenCalled();
  });

  it.each(['write', 'sync', 'close', 'rename'] as const)('never commits incomplete state when %s fails', async (stage) => {
    const method = stage === 'write' ? io.writeFile : io[stage];
    method.mockImplementation(async () => {
      io.events.push(stage);
      throw new Error('private error payload');
    });
    const store = new FileOwnershipStore('tests/.tmp-ownership-mocked');
    const result = await store.save({ version: 1, chargers: [makeOwnedState()] });
    expect(result).toMatchObject({ ok: false, error: { code: 'ConfigurationError' } });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(io.close).toHaveBeenCalledOnce();
    if (stage !== 'rename') expect(io.rename).not.toHaveBeenCalled();
    expect(io.unlink).toHaveBeenCalledWith(io.open.mock.calls[0]?.[0]);
  });

  it('does not touch the filesystem for invalid ownership', async () => {
    expect((await new FileOwnershipStore('tests/.tmp-ownership-mocked').save({ version: 1, chargers: [makeOwnedState({ baseline: null })] })).ok).toBe(false);
    expect(io.events).toEqual([]);
  });
});
