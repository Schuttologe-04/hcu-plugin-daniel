import { describe, expect, it } from 'vitest';
import { mapControllerStatus } from '../../../src/goe/controller-mapper.js';

const host = 'controller.test';

function response(names: readonly string[], powers: readonly unknown[]) {
  return { ccn: names, ccp: powers, cpc: names.map(() => [1, 2, 3, null]) };
}

describe('controller auxiliary energy telemetry', () => {
  it('maps Grid, Home and raw Solar from one response without rounding', () => {
    expect(mapControllerStatus(response(['Home', 'Grid', 'Solar'], [4985.463867, 4994.687988, -9.224525452]), host))
      .toMatchObject({ ok: true, value: {
        gridPowerW: 4994.687988, gridImportW: 4994.687988,
        homePowerW: 4985.463867, solarPowerW: -9.224525452,
      } });
  });

  it('uses channel names when Solar, Custom, Grid and Home are reordered', () => {
    expect(mapControllerStatus(response(['Solar', 'Custom 1', 'Grid', 'Home'], [-5000, null, -1000, 4000]), host))
      .toMatchObject({ ok: true, value: {
        gridPowerW: -1000, gridImportW: 0, homePowerW: 4000, solarPowerW: -5000,
      } });
  });

  it.each(['Home', 'Solar'] as const)('keeps valid Grid usable when %s is missing', (category) => {
    const result = mapControllerStatus(response(['Grid'], [22000]), host);
    expect(result).toMatchObject({ ok: true, value: { gridPowerW: 22000, gridImportW: 22000 } });
    if (!result.ok) throw new Error('Grid should remain valid');
    expect(result.value[category === 'Home' ? 'homePowerW' : 'solarPowerW']).toBeNull();
  });

  it.each(['Home', 'Solar'] as const)('retains actual zero for %s', (category) => {
    const result = mapControllerStatus(response(['Grid', category], [22000, 0]), host);
    if (!result.ok) throw new Error('Grid should remain valid');
    expect(result.value[category === 'Home' ? 'homePowerW' : 'solarPowerW']).toBe(0);
  });

  for (const category of ['Home', 'Solar'] as const) {
    it.each([null, undefined, '5000', true, {}, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
      `isolates unavailable or malformed ${category} power (%j)`, (power) => {
        const result = mapControllerStatus(response(['Grid', category], [22000, power]), host);
        expect(result).toMatchObject({ ok: true, value: { gridPowerW: 22000, gridImportW: 22000 } });
        if (!result.ok) throw new Error('Grid should remain valid');
        expect(result.value[category === 'Home' ? 'homePowerW' : 'solarPowerW']).toBeNull();
      },
    );

    it(`treats duplicate ${category} as unavailable while unique Grid remains valid`, () => {
      const result = mapControllerStatus(response([category, 'Grid', category], [5000, 22000, 6000]), host);
      if (!result.ok) throw new Error('Grid should remain valid');
      expect(result.value.gridImportW).toBe(22000);
      expect(result.value[category === 'Home' ? 'homePowerW' : 'solarPowerW']).toBeNull();
    });

    it(`does not require irrelevant ${category} phase currents`, () => {
      const raw = response(['Grid', category], [22000, 5000]);
      expect(mapControllerStatus({ ...raw, cpc: [raw.cpc[0], 'invalid auxiliary phase row'] }, host))
        .toMatchObject({ ok: true, value: { gridPowerW: 22000, gridPhaseCurrentsA: { l1: 1, l2: 2, l3: 3 } } });
    });
  }

  it.each([-5000, 0, 500])('preserves the original Solar sign (%i) in the domain model', (solarPowerW) => {
    expect(mapControllerStatus(response(['Grid', 'Solar'], [10000, solarPowerW]), host))
      .toMatchObject({ ok: true, value: { solarPowerW } });
  });

  it('preserves the strict validation of other channels', () => {
    expect(mapControllerStatus(response(['Grid', 'Custom 1'], [22000, 'invalid']), host))
      .toMatchObject({ ok: false, error: { code: 'InvalidResponseError' } });
  });

  it('still rejects invalid Grid even when all auxiliary channels are valid', () => {
    expect(mapControllerStatus(response(['Home', 'Grid', 'Solar'], [4000, null, -5000]), host))
      .toMatchObject({ ok: false, error: { code: 'MissingMeasurementError' } });
    expect(mapControllerStatus(response(['Home', 'Grid', 'Solar'], [4000, Number.NaN, -5000]), host))
      .toMatchObject({ ok: false, error: { code: 'InvalidResponseError' } });
  });
});
