import { describe, expect, it } from 'vitest';
import type { ChargerStatus } from '../../../src/domain/charger.js';
import { mapCarState } from '../../../src/domain/charger.js';
import { derivePolicy, readControlCurrent, type LoadManagementSettings } from '../../../src/load-management/policy.js';

const settings: LoadManagementSettings = {
  enabled: true,
  gridLimitW: 19_000,
  safetyReserveW: 500,
  triggerDurationSeconds: 30,
  controlIntervalSeconds: 4,
  ampStep: 1,
};

function charger(overrides: Partial<ChargerStatus> = {}): ChargerStatus {
  return {
    id: 'garage', configuredName: 'Garage', reportedName: 'Garage', host: 'garage.local',
    reachable: true, firmwareVersion: '59.4', carState: mapCarState(2),
    configuredCurrentA: 14, effectiveCurrentA: 14, temporaryCurrentLimitA: null,
    maximumCurrentA: null, minimumCurrentA: 6, chargingAllowed: true, forceState: 0,
    allowChargingPause: true, minimumChargingPauseDuration: 0, modelStatus: 15, rawNrg: null,
    ...overrides,
  };
}

describe('derivePolicy', () => {
  it('derives the supplied thresholds and millisecond durations', () => {
    expect(derivePolicy(settings)).toEqual({
      gridLimitW: 19_000, targetGridW: 18_500, recoveryThresholdW: 18_000,
      triggerDurationMs: 30_000, controlIntervalMs: 4_000, ampStep: 1,
    });
  });

  it('uses all configured parameters without fixed current or time constants', () => {
    expect(derivePolicy({
      ...settings, gridLimitW: 24_000, safetyReserveW: 1_200,
      triggerDurationSeconds: 12, controlIntervalSeconds: 2, ampStep: 2,
    })).toEqual({
      gridLimitW: 24_000, targetGridW: 22_800, recoveryThresholdW: 21_600,
      triggerDurationMs: 12_000, controlIntervalMs: 2_000, ampStep: 2,
    });
  });

  it('derives coincident thresholds when reserve is zero', () => {
    expect(derivePolicy({ ...settings, safetyReserveW: 0 })).toMatchObject({
      gridLimitW: 19_000, targetGridW: 19_000, recoveryThresholdW: 19_000,
    });
  });
});

describe('readControlCurrent', () => {
  it('keeps normal amp separate from effective current and foreign temporary limit', () => {
    expect(readControlCurrent(charger({ effectiveCurrentA: 10, temporaryCurrentLimitA: 12 }))).toEqual({
      ok: true,
      value: { effectiveCurrentA: 10, normalCurrentA: 14, temporaryCurrentLimitA: 12, minimumCurrentA: 6 },
    });
  });

  it.each([
    [{ effectiveCurrentA: 10 }, 10],
    [{ temporaryCurrentLimitA: 9 }, 9],
    [{ maximumCurrentA: 8 }, 8],
    [{ configuredCurrentA: 7 }, 7],
  ] satisfies readonly [Partial<ChargerStatus>, number][])(
    'takes the conservative minimum of all available current ceilings (%j)',
    (overrides, effectiveCurrentA) => {
      expect(readControlCurrent(charger(overrides))).toMatchObject({ ok: true, value: { effectiveCurrentA } });
    },
  );

  it('reads a different minimum from the device instead of assuming 6 A', () => {
    expect(readControlCurrent(charger({ minimumCurrentA: 8, effectiveCurrentA: 9 }))).toMatchObject({
      ok: true, value: { minimumCurrentA: 8, effectiveCurrentA: 9 },
    });
  });

  it('does not infer current from amp when acu is null', () => {
    expect(readControlCurrent(charger({ effectiveCurrentA: null }))).toEqual({
      ok: false,
      error: { code: 'InvalidResponseError', message: 'Required charger current values are unavailable or invalid' },
    });
  });

  it.each([
    { configuredCurrentA: 0 }, { configuredCurrentA: -1 }, { configuredCurrentA: 14.5 },
    { effectiveCurrentA: Number.NaN }, { effectiveCurrentA: Number.POSITIVE_INFINITY },
    { effectiveCurrentA: 0 }, { effectiveCurrentA: 14.5 },
    { temporaryCurrentLimitA: -1 }, { temporaryCurrentLimitA: Number.NaN },
    { maximumCurrentA: 0 }, { maximumCurrentA: Number.POSITIVE_INFINITY },
    { minimumCurrentA: 0 }, { minimumCurrentA: 6.5 },
  ] satisfies readonly Partial<ChargerStatus>[])(
    'rejects corrupt current data (%j)',
    (overrides) => {
      expect(readControlCurrent(charger(overrides))).toMatchObject({
        ok: false, error: { code: 'InvalidResponseError' },
      });
    },
  );

  it.each([
    { effectiveCurrentA: 5 }, { configuredCurrentA: 5 }, { temporaryCurrentLimitA: 5 },
    { maximumCurrentA: 5 }, { minimumCurrentA: 15 },
  ] satisfies readonly Partial<ChargerStatus>[])(
    'rejects a current ceiling below the reported minimum (%j)',
    (overrides) => {
      expect(readControlCurrent(charger(overrides))).toEqual({
        ok: false, error: { code: 'InvalidResponseError', message: 'Charger current is below its reported minimum' },
      });
    },
  );

  it('does not mutate input while inspecting available current', () => {
    const input = Object.freeze(charger({ effectiveCurrentA: 10, temporaryCurrentLimitA: 11 }));
    expect(readControlCurrent(input).ok).toBe(true);
    expect(input.effectiveCurrentA).toBe(10);
    expect(input.temporaryCurrentLimitA).toBe(11);
  });
});
