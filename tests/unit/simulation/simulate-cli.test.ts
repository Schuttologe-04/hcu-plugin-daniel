import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSimulateCli, simulationConfiguration } from '../../../src/cli/simulate.js';

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));

function configuration(): unknown {
  return {
    controller: { host: '<GO_E_CONTROLLER_IP>' },
    loadManagement: {
      enabled: true, gridLimitW: 19_000, safetyReserveW: 500,
      triggerDurationSeconds: 30, controlIntervalSeconds: 4, ampStep: 1,
    },
    chargers: [
      { id: 'garage', name: 'Garage', host: '192.168.0.94', enabled: true, priority: 1 },
      { id: 'links', name: 'Links', host: '192.168.0.144', enabled: true, priority: 20 },
      { id: 'rechts', name: 'Rechts', host: '', enabled: false, priority: 20 },
    ],
  };
}

function stdout(): string {
  return vi.mocked(process.stdout.write).mock.calls.map(([chunk]) => String(chunk)).join('');
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(readFile).mockResolvedValue(JSON.stringify(configuration()));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('offline simulate CLI', () => {
  it('runs the demo with example config, synthetic addresses and zero device requests', async () => {
    expect(await runSimulateCli([])).toBe(0);
    expect(readFile).toHaveBeenCalledWith('config.example.json', 'utf8');
    expect(stdout()).toContain('Offline simulation');
    expect(stdout()).toContain('t=29.999s Grid=22839 W TRIGGER_PENDING -> no action');
    expect(stdout()).toContain('t=30s Grid=22839 W LIMITING -> SET_TEMPORARY_CURRENT_LIMIT garage 13 A');
    expect(stdout()).toContain('FAULT -> no action');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a custom file without loading a real device client', async () => {
    expect(await runSimulateCli(['--config', 'custom.json'])).toBe(0);
    expect(readFile).toHaveBeenCalledWith('custom.json', 'utf8');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows help without reading a file or contacting devices', async () => {
    expect(await runSimulateCli(['--help'])).toBe(0);
    expect(stdout()).toContain('Usage: npm run simulate');
    expect(readFile).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['--unsupported'], ['positional'], ['--config'],
  ])('rejects invalid arguments %j', async (...args) => {
    expect(await runSimulateCli(args)).toBe(2);
    expect(readFile).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['{bad json', '{}', 'null'])('rejects invalid configuration: %s', async (json) => {
    vi.mocked(readFile).mockResolvedValue(json);
    expect(await runSimulateCli([])).toBe(2);
    expect(process.stderr.write).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports unreadable files without leaking the native error', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('secret native path'));
    expect(await runSimulateCli([])).toBe(2);
    expect(process.stderr.write).toHaveBeenCalledWith('The simulation configuration could not be read as JSON.\n');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('replaces only device addresses without mutating the input policy or charger metadata', () => {
    const input = configuration();
    const initial = structuredClone(input);
    expect(simulationConfiguration(input)).toMatchObject({
      controller: { host: 'controller.sim' },
      loadManagement: { gridLimitW: 19_000, safetyReserveW: 500 },
      chargers: [
        { id: 'garage', host: 'charger-0.sim', priority: 1 },
        { id: 'links', host: 'charger-1.sim', priority: 20 },
        { id: 'rechts', host: 'charger-2.sim', enabled: false },
      ],
    });
    expect(input).toEqual(initial);
  });
});
