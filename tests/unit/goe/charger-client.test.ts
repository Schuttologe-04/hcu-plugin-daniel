import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { ChargerConfig } from '../../../src/config/config-types.js';
import { failure, success } from '../../../src/domain/errors.js';
import { CHARGER_STATUS_FIELDS, GoEChargerClient } from '../../../src/goe/charger-client.js';
import type { StatusReader } from '../../../src/goe/http-client.js';

const garage: ChargerConfig = {
  id: 'garage', name: 'go-eCharger Garage', host: '192.168.0.94', enabled: true, priority: 1,
};
const idle: unknown = JSON.parse(readFileSync(new URL('../../fixtures/charger/garage-idle.json', import.meta.url), 'utf8'));

describe('GoEChargerClient', () => {
  it('requests only the selected status fields through the status-only reader', async () => {
    const readStatus = vi.fn<StatusReader['readStatus']>().mockResolvedValue(success(idle));
    const client = new GoEChargerClient(garage, { readStatus });
    const result = await client.readStatus();
    expect(result.ok).toBe(true);
    expect(readStatus).toHaveBeenCalledExactlyOnceWith(garage.host, CHARGER_STATUS_FIELDS);
    expect(CHARGER_STATUS_FIELDS).toEqual([
      'fna', 'fwv', 'car', 'amp', 'acu', 'ama', 'alw', 'frc', 'tcl', 'mca', 'acp', 'mcpd', 'modelStatus', 'nrg',
    ]);
  });

  it('never requests a disabled charger, even if invoked directly', async () => {
    const readStatus = vi.fn<StatusReader['readStatus']>();
    const client = new GoEChargerClient({ ...garage, enabled: false, host: '' }, { readStatus });
    expect(await client.readStatus()).toMatchObject({ ok: false, error: { code: 'ConfigurationError' } });
    expect(readStatus).not.toHaveBeenCalled();
  });

  it.each(['ConnectionError', 'TimeoutError', 'InvalidResponseError'] as const)('returns a transport %s unchanged', async (code) => {
    const expected = failure(code, 'A safe device error.');
    const readStatus = vi.fn<StatusReader['readStatus']>().mockResolvedValue(expected);
    const result = await new GoEChargerClient(garage, { readStatus }).readStatus();
    expect(result).toEqual(expected);
  });

  it('contains exceptions from custom status readers without leaking exception details', async () => {
    const readStatus = vi.fn<StatusReader['readStatus']>().mockRejectedValue(new Error('secret credential'));
    expect(await new GoEChargerClient(garage, { readStatus }).readStatus()).toEqual({
      ok: false, error: { code: 'ConnectionError', message: 'Charger status request failed.' },
    });
  });

  it('returns invalid device data as an explicit error', async () => {
    const readStatus = vi.fn<StatusReader['readStatus']>().mockResolvedValue(success({ fna: 'Incomplete' }));
    expect(await new GoEChargerClient(garage, { readStatus }).readStatus()).toMatchObject({
      ok: false, error: { code: 'InvalidResponseError' },
    });
  });
});
