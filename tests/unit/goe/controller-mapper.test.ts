import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mapControllerStatus } from '../../../src/goe/controller-mapper.js';

const host = 'controller.local';
const fixture: unknown = JSON.parse(
  readFileSync(new URL('../../fixtures/controller/grid-import.json', import.meta.url), 'utf8'),
);
const exportFixture: unknown = JSON.parse(
  readFileSync(new URL('../../fixtures/controller/grid-export.json', import.meta.url), 'utf8'),
);

function payload(gridPower: unknown = 18430.77734) {
  return {
    ccn: ['Home', 'Grid'],
    ccp: [18426.33203, gridPower],
    cpc: [[28.6, 31.7, 20.9, null], [28.45207596, 31.58973694, 20.83134842, null]],
  };
}

describe('mapControllerStatus', () => {
  it('finds Grid by category name and preserves the supplied measurements', () => {
    expect(mapControllerStatus(fixture, host)).toEqual({
      ok: true,
      value: {
        host,
        reachable: true,
        gridPowerW: 18430.77734,
        gridImportW: 18430.77734,
        homePowerW: 18426.33203,
        solarPowerW: -4.445766449,
        gridPhaseCurrentsA: { l1: 28.45207596, l2: 31.58973694, l3: 20.83134842 },
      },
    });
  });

  it('uses the matching power and currents when Grid moves to another index', () => {
    const source = payload();
    const result = mapControllerStatus({
      ccn: ['Grid', 'Home'],
      ccp: [source.ccp[1], source.ccp[0]],
      cpc: [source.cpc[1], source.cpc[0]],
    }, host);
    expect(result).toEqual(mapControllerStatus(source, host));
  });

  it('keeps export negative and clamps only gridImportW to zero', () => {
    const result = mapControllerStatus(exportFixture, host);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.gridPowerW).toBe(-2500);
    expect(result.value.gridImportW).toBe(0);
    expect(result.value.gridPhaseCurrentsA).toEqual({ l1: 3.7, l2: 3.7, l3: 3.7 });
  });

  it('accepts a measured zero', () => {
    expect(mapControllerStatus(payload(0), host)).toMatchObject({
      ok: true, value: { gridPowerW: 0, gridImportW: 0 },
    });
  });

  it('returns an unavailable error for null Grid power instead of zero', () => {
    expect(mapControllerStatus(payload(null), host)).toMatchObject({
      ok: false, error: { code: 'MissingMeasurementError' },
    });
  });

  it('returns a clear error for a missing Grid category', () => {
    const source = payload();
    expect(mapControllerStatus({ ...source, ccn: ['Home', 'Solar'] }, host)).toMatchObject({
      ok: false, error: { code: 'MissingMeasurementError' },
    });
  });

  it('rejects duplicate Grid categories', () => {
    expect(mapControllerStatus({ ...payload(), ccn: ['Grid', 'Grid'] }, host)).toMatchObject({
      ok: false, error: { code: 'InvalidResponseError' },
    });
  });

  it.each(['ccn', 'ccp', 'cpc'] as const)('rejects unequal category lengths caused by %s', (field) => {
    const source = payload();
    expect(mapControllerStatus({ ...source, [field]: source[field].slice(0, 1) }, host)).toMatchObject({
      ok: false, error: { code: 'InvalidResponseError' },
    });
  });

  it('retains unavailable phase currents as null', () => {
    const source = payload();
    expect(mapControllerStatus({ ...source, cpc: [source.cpc[0], [null, 1, null, null]] }, host))
      .toMatchObject({ ok: true, value: { gridPhaseCurrentsA: { l1: null, l2: 1, l3: null } } });
  });

  it.each([null, 'bad', [1, 2], [1, 'bad', 3], [1, Number.NaN, 3]])('rejects malformed phase row %j', (row) => {
    const source = payload();
    expect(mapControllerStatus({ ...source, cpc: [source.cpc[0], row] }, host)).toMatchObject({
      ok: false, error: { code: 'InvalidResponseError' },
    });
  });

  it.each(['123', true, {}, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid Grid power %j', (power) => {
    expect(mapControllerStatus(payload(power), host)).toMatchObject({
      ok: false, error: { code: 'InvalidResponseError' },
    });
  });

  it.each([null, [], 'invalid', {}, { ccn: null, ccp: [], cpc: [] }])('rejects an invalid status structure %j', (value) => {
    expect(mapControllerStatus(value, host)).toMatchObject({
      ok: false, error: { code: 'InvalidResponseError' },
    });
  });

  it('rejects malformed category names and invalid safety-critical Grid measurements', () => {
    expect(mapControllerStatus({ ...payload(), ccn: [3, 'Grid'] }, host)).toMatchObject({
      ok: false, error: { code: 'InvalidResponseError' },
    });
    expect(mapControllerStatus({ ...payload(), ccp: [100, 'bad'] }, host)).toMatchObject({
      ok: false, error: { code: 'InvalidResponseError' },
    });
  });
});
