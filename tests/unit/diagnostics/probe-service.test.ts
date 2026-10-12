import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../src/config/config-types.js';
import { probeDevices } from '../../../src/diagnostics/probe-service.js';
import { failure, success } from '../../../src/domain/errors.js';
import { CHARGER_STATUS_FIELDS } from '../../../src/goe/charger-client.js';
import type { StatusReader } from '../../../src/goe/http-client.js';
import { createLogger } from '../../../src/logging/logger.js';

const controller: unknown = JSON.parse(readFileSync(new URL('../../fixtures/controller/grid-import.json', import.meta.url), 'utf8'));
const garage: unknown = JSON.parse(readFileSync(new URL('../../fixtures/charger/garage-idle.json', import.meta.url), 'utf8'));
const links: unknown = JSON.parse(readFileSync(new URL('../../fixtures/charger/links-idle.json', import.meta.url), 'utf8'));

function configuration(): AppConfig {
  return {
    controller: { host: 'controller.test' },
    loadManagement: {
      enabled: true, gridLimitW: 19000, safetyReserveW: 500,
      triggerDurationSeconds: 30, controlIntervalSeconds: 4, ampStep: 1,
    },
    http: { timeoutMs: 3000 },
    chargers: [
      { id: 'garage', name: 'Garage', host: 'garage.test', enabled: true, priority: 1 },
      { id: 'links', name: 'Links', host: 'links.test', enabled: true, priority: 20 },
      { id: 'rechts', name: 'Rechts', host: '', enabled: false, priority: 20 },
    ],
  };
}

function goodReader(): StatusReader {
  return { readStatus: vi.fn<StatusReader['readStatus']>().mockImplementation(async (host) => (
    success(host === 'controller.test' ? controller : host === 'garage.test' ? garage : links)
  )) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('probeDevices', () => {
  it('isolates one charger failure and preserves the other charger and controller results', async () => {
    const readStatus = vi.fn<StatusReader['readStatus']>().mockImplementation(async (host) => {
      if (host === 'links.test') return failure('ConnectionError', 'Charger cannot be reached.');
      return success(host === 'controller.test' ? controller : garage);
    });
    const report = await probeDevices(configuration(), { http: { readStatus } });
    expect(report.controller).toMatchObject({ ok: true, value: { gridPowerW: 18430.77734 } });
    expect(report.chargers.map((charger) => charger.status)).toEqual(['reachable', 'unavailable', 'disabled']);
    expect(report.chargers[0]).toMatchObject({ config: { id: 'garage' }, value: { firmwareVersion: '59.4' } });
    expect(report.chargers[1]).toMatchObject({ error: { code: 'ConnectionError' } });
    expect(readStatus).toHaveBeenCalledTimes(3);
    expect(readStatus).not.toHaveBeenCalledWith('', expect.anything());
  });

  it('never invokes the reader for a disabled charger', async () => {
    const http = goodReader();
    const report = await probeDevices(configuration(), { http });
    expect(report.chargers[2]).toMatchObject({ status: 'disabled', reachable: false, config: { id: 'rechts' } });
    expect(http.readStatus).toHaveBeenCalledTimes(3);
    expect(http.readStatus).toHaveBeenCalledWith('garage.test', CHARGER_STATUS_FIELDS);
    expect(http.readStatus).toHaveBeenCalledWith('links.test', CHARGER_STATUS_FIELDS);
  });

  it('includes auxiliary controller and measured charger power in the existing three-read snapshot', async () => {
    const readStatus = vi.fn<StatusReader['readStatus']>().mockImplementation(async (host) => {
      if (host === 'controller.test') return success({
        ccn: ['Solar', 'Grid', 'Home'], ccp: [-5000, 22000, 17000],
        cpc: [[1, 2, 3, null], [1, 2, 3, null], [1, 2, 3, null]],
      });
      if (typeof garage !== 'object' || garage === null) throw new Error('Invalid fixture');
      return success({ ...garage, nrg: [230, 230, 230, null, 14, 14, 14, 3300, 3300, 3300, null,
        host === 'garage.test' ? 11000 : 0] });
    });
    const report = await probeDevices(configuration(), { http: { readStatus } });
    expect(report.controller).toMatchObject({ ok: true, value: {
      gridPowerW: 22000, gridImportW: 22000, homePowerW: 17000, solarPowerW: -5000,
    } });
    expect(report.chargers[0]).toMatchObject({ status: 'reachable', value: { currentPowerW: 11000 } });
    expect(report.chargers[1]).toMatchObject({ status: 'reachable', value: { currentPowerW: 0 } });
    expect(report.chargers[2]).toMatchObject({ status: 'disabled' });
    expect(readStatus).toHaveBeenCalledTimes(3);
    expect(readStatus).toHaveBeenCalledWith('controller.test', ['ccn', 'ccp', 'cpc']);
  });

  it('isolates invalid auxiliary energy telemetry without fabricating power or marking healthy devices offline', async () => {
    const readStatus = vi.fn<StatusReader['readStatus']>().mockImplementation(async (host) => {
      if (host === 'controller.test') return success({
        ccn: ['Home', 'Grid', 'Solar'], ccp: ['invalid', 22000, null],
        cpc: ['invalid optional phases', [1, 2, 3, null], [null, null, null, null]],
      });
      if (typeof garage !== 'object' || garage === null) throw new Error('Invalid fixture');
      return success({ ...garage, nrg: [230, 230, 230, null, 14, 14, 14, 3300, 3300, 3300, null, 'invalid power'] });
    });
    const report = await probeDevices(configuration(), { http: { readStatus } });
    expect(report.controller).toMatchObject({ ok: true, value: {
      gridPowerW: 22000, gridImportW: 22000, homePowerW: null, solarPowerW: null,
    } });
    expect(report.chargers[0]).toMatchObject({ status: 'reachable', value: { currentPowerW: null, rawNrg: null } });
    expect(report.chargers[1]).toMatchObject({ status: 'reachable', value: { currentPowerW: null, rawNrg: null } });
    expect(readStatus).toHaveBeenCalledTimes(3);
  });

  it('still returns charger snapshots when the controller is unavailable', async () => {
    const readStatus = vi.fn<StatusReader['readStatus']>().mockImplementation(async (host) => (
      host === 'controller.test' ? failure('TimeoutError', 'Controller timed out.') : success(garage)
    ));
    const report = await probeDevices(configuration(), { http: { readStatus } });
    expect(report.controller).toMatchObject({ ok: false, error: { code: 'TimeoutError' } });
    expect(report.chargers.map((charger) => charger.status)).toEqual(['reachable', 'reachable', 'disabled']);
  });

  it('isolates unexpected exceptions from injected readers', async () => {
    const readStatus = vi.fn<StatusReader['readStatus']>().mockImplementation(async (host) => {
      if (host === 'controller.test' || host === 'garage.test') throw new Error('secret exception');
      return success(links);
    });
    const report = await probeDevices(configuration(), { http: { readStatus } });
    expect(report.controller).toMatchObject({ ok: false, error: { code: 'ConnectionError' } });
    expect(report.chargers.map((charger) => charger.status)).toEqual(['unavailable', 'reachable', 'disabled']);
    expect(JSON.stringify(report)).not.toContain('secret exception');
  });

  it('performs one GET status request per enabled device with native fetch mocked', async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return new Response(JSON.stringify(url.hostname === 'controller.test' ? controller : garage));
    });
    vi.stubGlobal('fetch', fetchMock);
    const report = await probeDevices(configuration());
    expect(report.controller.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const hosts: string[] = [];
    for (const [input, options] of fetchMock.mock.calls) {
      const url = new URL(input instanceof Request ? input.url : String(input));
      hosts.push(url.hostname);
      expect(url.pathname).toBe('/api/status');
      expect([...url.searchParams.keys()]).toEqual(['filter']);
      expect(url.searchParams.get('filter')).toBe(url.hostname === 'controller.test' ? 'ccn,ccp,cpc' : CHARGER_STATUS_FIELDS.join(','));
      expect(options).toMatchObject({ method: 'GET', redirect: 'manual' });
      expect(options?.body).toBeUndefined();
    }
    expect(hosts.sort()).toEqual(['controller.test', 'garage.test', 'links.test']);
  });

  it('does not schedule polling or control actions for enabled load-management settings', async () => {
    vi.useFakeTimers();
    const http = goodReader();
    await probeDevices(configuration(), { http });
    expect(http.readStatus).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120000);
    expect(http.readStatus).toHaveBeenCalledTimes(3);
    const changed = configuration();
    await probeDevices({
      ...changed,
      loadManagement: { ...changed.loadManagement, enabled: false, gridLimitW: 1, ampStep: 10 },
      chargers: changed.chargers.map((charger) => ({ ...charger, priority: 999 })),
    }, { http });
    expect(http.readStatus).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('logs safe summaries while measurements are debug-only and raw data stay absent', async () => {
    const messages: string[] = [];
    const logger = createLogger('debug', { write: (message: string) => { messages.push(message); } });
    const readStatus = vi.fn<StatusReader['readStatus']>().mockImplementation(async (host) => {
      if (host === 'links.test') return failure('ConnectionError', 'secret-token-from-error');
      if (host === 'controller.test') return success(controller);
      if (typeof garage !== 'object' || garage === null) throw new Error('Fixture not an object');
      return success({ ...garage, password: 'secret-password', unrelated: 'private-device-payload' });
    });
    await probeDevices(configuration(), { http: { readStatus }, logger });
    const rawLog = messages.join('');
    expect(rawLog).not.toMatch(/secret-token|secret-password|private-device-payload/);
    const logs: unknown[] = messages.map((message) => JSON.parse(message) as unknown);
    expect(logs).toContainEqual(expect.objectContaining({ level: 30, chargerId: 'garage', msg: 'Charger reachable' }));
    expect(logs).toContainEqual(expect.objectContaining({ level: 40, chargerId: 'links', errorCode: 'ConnectionError' }));
    expect(logs).toContainEqual(expect.objectContaining({ level: 20, gridPowerW: 18430.77734 }));
    expect(logs).not.toContainEqual(expect.objectContaining({ level: 30, gridPowerW: expect.anything() }));
  });

  it('logs invalid controller data as an error while valid chargers remain available', async () => {
    const messages: string[] = [];
    const logger = createLogger('info', { write: (message: string) => { messages.push(message); } });
    const readStatus = vi.fn<StatusReader['readStatus']>().mockImplementation(async (host) => (
      success(host === 'controller.test' ? 'invalid' : garage)
    ));
    const report = await probeDevices(configuration(), { http: { readStatus }, logger });
    expect(report.controller).toMatchObject({ ok: false, error: { code: 'InvalidResponseError' } });
    expect(messages.map((message) => JSON.parse(message) as unknown)).toContainEqual(expect.objectContaining({
      level: 50, errorCode: 'InvalidResponseError', msg: 'Invalid controller response',
    }));
  });
});
