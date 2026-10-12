import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ChargerConfig } from '../../../src/config/config-types.js';
import { mapChargerStatus } from '../../../src/goe/charger-mapper.js';

const garage: ChargerConfig = { id: 'garage', name: 'Garage', host: 'garage.test', enabled: true, priority: 1 };
const rawFixture: unknown = JSON.parse(readFileSync(new URL('../../fixtures/charger/garage-idle.json', import.meta.url), 'utf8'));
if (typeof rawFixture !== 'object' || rawFixture === null || Array.isArray(rawFixture)) throw new Error('Invalid fixture');
const fixture = rawFixture as Record<string, unknown>;

function withPower(power: unknown): unknown[] {
  return [230, 231, 232, null, 14, 14, 14, 3200, 3300, 3400, null, power, 99, 98, 99, null];
}

function mapped(nrg: unknown) {
  const result = mapChargerStatus({ ...fixture, nrg }, garage);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('actual charger power from nrg[11]', () => {
  it.each([11000, 0, -100, 11000.125])('accepts the actual finite nrg[11] value %j without scaling or rounding', (power) => {
    const nrg = withPower(power);
    const status = mapped(nrg);
    expect(status.currentPowerW).toBe(power);
    expect(status.rawNrg).toEqual(nrg);
    expect(status.reachable).toBe(true);
  });

  it.each([null, undefined, [], [230, 230, 230, null, 14, 14, 14, 3300, 3300, 3300, null]])(
    'keeps absent or short nrg power unavailable (%j)', (nrg) => {
      expect(mapped(nrg).currentPowerW).toBeNull();
    },
  );

  it('keeps a genuinely omitted nrg property unavailable', () => {
    const result = mapChargerStatus(fixture, garage);
    expect(result).toMatchObject({ ok: true, value: { currentPowerW: null, rawNrg: null, reachable: true } });
  });

  it.each([null, undefined, '11000', true, {}, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'treats invalid nrg[11] as missing measurement, preserving essential charger availability (%j)', (power) => {
      const status = mapped(withPower(power));
      expect(status.currentPowerW).toBeNull();
      expect(status.reachable).toBe(true);
      expect(status.configuredCurrentA).toBe(14);
      expect(status.minimumCurrentA).toBe(6);
      if (power !== null) expect(status.rawNrg).toBeNull();
    },
  );

  it.each(['11000', 11000, {}, false])('does not derive power from a non-array nrg (%j)', (nrg) => {
    expect(mapped(nrg)).toMatchObject({ currentPowerW: null, rawNrg: null, reachable: true });
  });

  it('uses only index 11 even if another auxiliary nrg slot is malformed', () => {
    const nrg = withPower(11000);
    nrg[0] = 'invalid voltage';
    expect(mapped(nrg)).toMatchObject({ currentPowerW: 11000, rawNrg: null, reachable: true });
  });

  it('does not estimate missing power from current, voltage, phase power or charging state', () => {
    const nrg = withPower(null).slice(0, 11);
    const result = mapChargerStatus({ ...fixture, car: 2, amp: 14, acu: 6, tcl: 6, ama: 32, nrg }, garage);
    expect(result).toMatchObject({ ok: true, value: {
      currentPowerW: null, configuredCurrentA: 14, effectiveCurrentA: 6,
      temporaryCurrentLimitA: 6, maximumCurrentA: 32, minimumCurrentA: 6,
      carState: { label: 'charging' }, rawNrg: nrg,
    } });
  });

  it('preserves every validated raw entry in an independent frozen array', () => {
    const nrg = withPower(11000);
    const status = mapped(nrg);
    expect(status.rawNrg).toEqual(nrg);
    expect(status.rawNrg).not.toBe(nrg);
    expect(Object.isFrozen(status.rawNrg)).toBe(true);
    nrg[11] = 0;
    expect(status.rawNrg?.[11]).toBe(11000);
    expect(status.currentPowerW).toBe(11000);
  });

  it('does not retain holes as falsely validated raw measurements', () => {
    const nrg: unknown[] = [];
    nrg[11] = 11000;
    expect(mapped(nrg)).toMatchObject({ currentPowerW: 11000, rawNrg: null });
  });

  it('still rejects invalid essential control fields even with valid measured power', () => {
    const result = mapChargerStatus({ ...fixture, mca: '6', nrg: withPower(11000) }, garage);
    expect(result).toMatchObject({ ok: false, error: { code: 'InvalidResponseError' } });
  });
});
