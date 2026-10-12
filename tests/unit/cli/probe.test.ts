import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runProbeCli } from '../../../src/cli/probe.js';

const logger = vi.hoisted(() => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));
vi.mock('../../../src/logging/logger.js', () => ({ createLogger: vi.fn(() => logger), parseLogLevel: vi.fn(() => 'info') }));

const controller: unknown = JSON.parse(readFileSync(new URL('../../fixtures/controller/grid-import.json', import.meta.url), 'utf8'));
const charger: unknown = JSON.parse(readFileSync(new URL('../../fixtures/charger/garage-idle.json', import.meta.url), 'utf8'));

function configuration(): unknown {
  return {
    controller: { host: 'controller.test' },
    loadManagement: { enabled: true, gridLimitW: 19000, safetyReserveW: 500, triggerDurationSeconds: 30, controlIntervalSeconds: 4, ampStep: 1 },
    chargers: [
      { id: 'garage', name: 'Garage', host: 'garage.test', enabled: true, priority: 1 },
      { id: 'rechts', name: 'Rechts', host: '', enabled: false, priority: 20 },
    ],
  };
}

function stdoutText(): string {
  return vi.mocked(process.stdout.write).mock.calls.map(([chunk]) => String(chunk)).join('');
}

let fetchMock: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return new Response(JSON.stringify(url.hostname === 'controller.test' ? controller : charger));
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(readFile).mockResolvedValue(JSON.stringify(configuration()));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('runProbeCli', () => {
  it('shows help without reading configuration or contacting devices', async () => {
    expect(await runProbeCli(['--help'])).toBe(0);
    expect(stdoutText()).toContain('Usage: npm run probe');
    expect(readFile).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([{ args: ['--unsupported'] }, { args: ['unexpected-positional'] }, { args: ['--config'] }])('returns usage exit 2 for invalid arguments ($args) without network calls', async ({ args }) => {
    expect(await runProbeCli(args)).toBe(2);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('Invalid arguments'));
    expect(readFile).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns exit 2 for an invalid configuration without contacting devices', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify({ controller: { host: '' } }));
    expect(await runProbeCli([])).toBe(2);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'ConfigurationError' }), 'Configuration could not be loaded');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stdoutText()).toBe('');
  });

  it('returns exit 2 for invalid JSON and suppresses source errors', async () => {
    vi.mocked(readFile).mockResolvedValue('{bad json');
    expect(await runProbeCli([])).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it('loads the supplied config path and returns success exit 0 with the report', async () => {
    expect(await runProbeCli(['--config', 'custom-config.json'])).toBe(0);
    expect(readFile).toHaveBeenCalledWith('custom-config.json', 'utf8');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(stdoutText()).toContain('Grid: 18.431 W');
    expect(stdoutText()).toContain('Garage\nHost: garage.test\nStatus: reachable');
    expect(stdoutText()).toContain('Rechts\nStatus: disabled');
  });

  it('returns exit 1 for a failed charger while still printing controller and disabled status', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === 'garage.test') throw new Error('private network error');
      return new Response(JSON.stringify(controller));
    });
    expect(await runProbeCli([])).toBe(1);
    expect(stdoutText()).toContain('Grid: 18.431 W');
    expect(stdoutText()).toContain('Garage\nHost: garage.test\nStatus: unavailable');
    expect(stdoutText()).toContain('Rechts\nStatus: disabled');
    expect(stdoutText()).not.toContain('private network error');
  });

  it('returns exit 1 for a failed controller while printing a successful charger', async () => {
    fetchMock.mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return new Response(JSON.stringify(url.hostname === 'controller.test' ? { ccn: [] } : charger));
    });
    expect(await runProbeCli([])).toBe(1);
    expect(stdoutText()).toContain('go-e Controller\n---------------\nStatus: unavailable');
    expect(stdoutText()).toContain('Garage\nHost: garage.test\nStatus: reachable');
  });

  it('has no startup side effects when imported as a module', async () => {
    vi.resetModules();
    await import('../../../src/cli/probe.js');
    expect(readFile).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(process.stdout.write).not.toHaveBeenCalled();
    expect(process.stderr.write).not.toHaveBeenCalled();
  });
});
