import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileConfigProvider, loadConfig } from '../../../src/config/config-loader.js';
import type { ConfigProvider } from '../../../src/config/config-types.js';

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));

function validConfig() {
  return {
    controller: { host: 'controller.local' },
    loadManagement: {
      enabled: true,
      gridLimitW: 19_000,
      safetyReserveW: 500,
      triggerDurationSeconds: 30,
      controlIntervalSeconds: 4,
      ampStep: 1,
    },
    chargers: [],
  };
}

describe('loadConfig', () => {
  beforeEach(() => vi.resetAllMocks());

  it('loads and validates a local JSON file', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(validConfig()));
    const result = await loadConfig(new FileConfigProvider('config.json'));
    expect(readFile).toHaveBeenCalledWith('config.json', 'utf8');
    expect(result).toEqual({ ok: true, value: { ...validConfig(), http: { timeoutMs: 3_000 } } });
  });

  it('works with another config provider without filesystem access', async () => {
    const provider: ConfigProvider = { load: async () => validConfig() };
    expect((await loadConfig(provider)).ok).toBe(true);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('rejects invalid data from a replacement provider', async () => {
    const provider: ConfigProvider = { load: async () => ({ controller: { host: '' } }) };
    expect(await loadConfig(provider)).toEqual({
      ok: false,
      error: { code: 'ConfigurationError', message: expect.stringContaining('controller.host') },
    });
  });

  it('wraps invalid JSON in a ConfigurationError', async () => {
    vi.mocked(readFile).mockResolvedValue('{invalid json');
    expect(await loadConfig(new FileConfigProvider('config.json'))).toEqual({
      ok: false,
      error: { code: 'ConfigurationError', message: 'Configuration could not be loaded or parsed.' },
    });
  });

  it('wraps file read errors without leaking file paths or underlying messages', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT C:/private/config.json secret-token'));
    expect(await loadConfig(new FileConfigProvider('C:/private/config.json'))).toEqual({
      ok: false,
      error: { code: 'ConfigurationError', message: 'Configuration could not be loaded or parsed.' },
    });
  });

  it('wraps arbitrary provider errors', async () => {
    const provider: ConfigProvider = { load: async () => { throw new Error('provider credential'); } };
    expect(await loadConfig(provider)).toEqual({
      ok: false,
      error: { code: 'ConfigurationError', message: 'Configuration could not be loaded or parsed.' },
    });
  });
});
