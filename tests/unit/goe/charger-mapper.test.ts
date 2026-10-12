import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ChargerConfig } from '../../../src/config/config-types.js';
import { KnownCarState, type ChargerStatus } from '../../../src/domain/charger.js';
import { mapChargerStatus } from '../../../src/goe/charger-mapper.js';

const garage: ChargerConfig = {
  id: 'garage', name: 'Configured Garage', host: '192.168.0.94', enabled: true, priority: 1,
};

function fixture(name: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(new URL(`../../fixtures/charger/${name}.json`, import.meta.url), 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid fixture');
  return value as Record<string, unknown>;
}

function mapped(value: unknown): ChargerStatus {
  const result = mapChargerStatus(value, garage);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('mapChargerStatus', () => {
  it('normalizes the supplied Garage response, including car=2 as charging', () => {
    const status = mapped({ ...fixture('garage-idle'), car: 2, ama: 32 });
    expect(status).toEqual({
      id: 'garage',
      configuredName: 'Configured Garage',
      reportedName: 'go-eCharger Garage',
      host: '192.168.0.94',
      reachable: true,
      firmwareVersion: '59.4',
      carState: { kind: 'known', code: KnownCarState.Charging, label: 'charging' },
      configuredCurrentA: 14,
      effectiveCurrentA: 14,
      temporaryCurrentLimitA: null,
      maximumCurrentA: 32,
      minimumCurrentA: 6,
      chargingAllowed: true,
      forceState: 0,
      allowChargingPause: true,
      minimumChargingPauseDuration: 0,
      modelStatus: 15,
      currentPowerW: null,
      rawNrg: null,
    });
  });

  it('preserves null tcl without inventing a current limit', () => {
    expect(mapped(fixture('garage-idle')).temporaryCurrentLimitA).toBeNull();
  });

  it('preserves null acu without replacing it with zero', () => {
    expect(mapped(fixture('links-idle')).effectiveCurrentA).toBeNull();
  });

  it('keeps configured and effective current separate for the 6 A fixture', () => {
    const status = mapped(fixture('garage-charging-6a'));
    expect(status.configuredCurrentA).toBe(14);
    expect(status.effectiveCurrentA).toBe(6);
    expect(status.temporaryCurrentLimitA).toBe(6);
    expect(status.firmwareVersion).toBeNull();
  });

  it('maps car=4 to documented complete even in the supplied paused fixture', () => {
    const status = mapped(fixture('garage-paused'));
    expect(status.carState).toEqual({ kind: 'known', code: KnownCarState.Complete, label: 'complete' });
    expect(status.chargingAllowed).toBe(false);
    expect(status.forceState).toBe(1);
    expect(status.modelStatus).toBe(4);
    expect(status.effectiveCurrentA).toBeNull();
  });

  it('preserves an unknown future numerical car state', () => {
    expect(mapped({ ...fixture('garage-idle'), car: 77 }).carState).toEqual({
      kind: 'unknown', code: 77, label: 'unknown',
    });
  });

  it('represents a null car state as explicitly unavailable', () => {
    expect(mapped({ ...fixture('garage-idle'), car: null }).carState).toEqual({
      kind: 'unavailable', code: null, label: 'unavailable',
    });
  });

  it('reads minimum current, pause compatibility and firmware from each response', () => {
    const status = mapped({ ...fixture('garage-idle'), mca: 8, acp: false, fwv: '60.2', mcpd: 90000 });
    expect(status.minimumCurrentA).toBe(8);
    expect(status.allowChargingPause).toBe(false);
    expect(status.firmwareVersion).toBe('60.2');
    expect(status.minimumChargingPauseDuration).toBe(90000);
  });

  it('preserves every nrg element with no guessed units or scaling', () => {
    const rawNrg = [230.1, 231, 232, null, 14, 14.5, 14, 3200, 3350, 3250, null, 9800, 99, 98, 99, null];
    const status = mapped({ ...fixture('garage-idle'), nrg: rawNrg });
    expect(status.rawNrg).toEqual(rawNrg);
    rawNrg[0] = 999;
    expect(status.rawNrg?.[0]).toBe(230.1);
  });

  it.each([undefined, null])('keeps unavailable firmware, maximum current and nrg explicit (%s)', (value) => {
    const status = mapped({ ...fixture('garage-idle'), fwv: value, ama: value, nrg: value });
    expect(status.firmwareVersion).toBeNull();
    expect(status.maximumCurrentA).toBeNull();
    expect(status.rawNrg).toBeNull();
  });

  it.each([null, [], 'status', 5])('rejects non-object device responses (%j)', (value) => {
    expect(mapChargerStatus(value, garage)).toMatchObject({ ok: false, error: { code: 'InvalidResponseError' } });
  });

  it.each([
    { fna: 23 }, { fwv: 59.4 }, { car: '2' }, { car: -1 }, { car: 1.5 },
    { amp: null }, { amp: '14' }, { amp: Number.NaN }, { amp: Number.POSITIVE_INFINITY },
    { acu: '14' }, { ama: '32' }, { alw: 1 }, { frc: -1 }, { tcl: '6' },
    { mca: undefined }, { mca: -6 }, { acp: 'true' }, { mcpd: -1 }, { modelStatus: null },
  ])('rejects malformed external fields (%j)', (patch) => {
    expect(mapChargerStatus({ ...fixture('garage-idle'), ...patch }, garage)).toMatchObject({
      ok: false, error: { code: 'InvalidResponseError' },
    });
  });

  it.each([[1, '2'], [Number.NaN], [Number.POSITIVE_INFINITY], {}])(
    'isolates malformed auxiliary nrg without invalidating essential charger state (%j)', (nrg) => {
      const status = mapped({ ...fixture('garage-idle'), nrg });
      expect(status.reachable).toBe(true);
      expect(status.currentPowerW).toBeNull();
      expect(status.rawNrg).toBeNull();
      expect(status.configuredCurrentA).toBe(14);
      expect(status.minimumCurrentA).toBe(6);
    },
  );
});
