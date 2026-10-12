import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../src/config/config-types.js';
import { mapCarState, type ChargerStatus } from '../../../src/domain/charger.js';
import { demoSamples, demoStatuses, runDemoSimulation } from '../../../src/simulation/demo.js';
import { applySimulatedAction, runSimulation } from '../../../src/simulation/simulator.js';

function config(): AppConfig {
  return {
    controller: { host: 'controller.sim' },
    loadManagement: {
      enabled: true,
      gridLimitW: 19_000,
      safetyReserveW: 500,
      triggerDurationSeconds: 30,
      controlIntervalSeconds: 4,
      ampStep: 1,
    },
    chargers: [
      { id: 'garage', name: 'Garage', host: 'garage.sim', enabled: true, priority: 1 },
      { id: 'links', name: 'Links', host: 'links.sim', enabled: true, priority: 20 },
      { id: 'rechts', name: 'Rechts', host: '', enabled: false, priority: 20 },
    ],
    http: { timeoutMs: 3_000 },
  };
}

function garage(): ChargerStatus {
  const status = demoStatuses(config()).find((charger) => charger.id === 'garage');
  if (status === undefined) throw new Error('The Garage simulation fixture is missing.');
  return { ...status, rawNrg: [230, null, 14] };
}

afterEach(() => vi.unstubAllGlobals());

describe('applySimulatedAction', () => {
  it('sets only the in-memory temporary limit and retains the user amp setting', () => {
    const original = Object.freeze(garage());
    const changed = applySimulatedAction(original, {
      type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 13,
    });
    expect(changed.temporaryCurrentLimitA).toBe(13);
    expect(changed.effectiveCurrentA).toBe(13);
    expect(changed.configuredCurrentA).toBe(14);
    expect(original.temporaryCurrentLimitA).toBeNull();
    expect(original.effectiveCurrentA).toBe(14);
    expect(changed.rawNrg).toEqual(original.rawNrg);
    expect(changed.rawNrg).not.toBe(original.rawNrg);
  });

  it('respects amp and maximum current in the simulated effective current', () => {
    const changed = applySimulatedAction({ ...garage(), maximumCurrentA: 10 }, {
      type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 13,
    });
    expect(changed.effectiveCurrentA).toBe(10);
    expect(changed.temporaryCurrentLimitA).toBe(13);
  });

  it('keeps an unavailable effective current unavailable while setting a limit', () => {
    const changed = applySimulatedAction({ ...garage(), effectiveCurrentA: null }, {
      type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 6,
    });
    expect(changed.effectiveCurrentA).toBeNull();
  });

  it('models the confirmed pause/resume sequence while retaining the minimum tcl', () => {
    const original = { ...garage(), temporaryCurrentLimitA: 6, effectiveCurrentA: 6 };
    const paused = applySimulatedAction(original, { type: 'PAUSE', chargerId: 'garage' });
    expect(paused).toMatchObject({
      temporaryCurrentLimitA: 6, effectiveCurrentA: null,
      forceState: 1, chargingAllowed: false, carState: mapCarState(4),
    });
    const resumed = applySimulatedAction(paused, { type: 'RESUME', chargerId: 'garage' });
    expect(resumed).toMatchObject({
      temporaryCurrentLimitA: 6, effectiveCurrentA: 6,
      forceState: 0, chargingAllowed: true, carState: mapCarState(2),
    });
    expect(original.forceState).toBe(0);
  });

  it('clears a simulated limit without rewriting the user setting', () => {
    const changed = applySimulatedAction({ ...garage(), temporaryCurrentLimitA: 6, effectiveCurrentA: 6 }, {
      type: 'CLEAR_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage',
    });
    expect(changed.temporaryCurrentLimitA).toBeNull();
    expect(changed.effectiveCurrentA).toBe(14);
    expect(changed.configuredCurrentA).toBe(14);
  });

  it('does not unpause a charger merely by clearing its in-memory temporary limit', () => {
    const paused = { ...garage(), effectiveCurrentA: null, chargingAllowed: false, forceState: 1 };
    const changed = applySimulatedAction(paused, {
      type: 'CLEAR_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage',
    });
    expect(changed.effectiveCurrentA).toBeNull();
    expect(changed.forceState).toBe(1);
    expect(changed.chargingAllowed).toBe(false);
  });

  it('rejects applying an action to another charger', () => {
    expect(() => applySimulatedAction(garage(), { type: 'PAUSE', chargerId: 'links' })).toThrow();
  });

  it.each([5, 6.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects unsafe simulated limits: %s', (amps) => {
    expect(() => applySimulatedAction(garage(), {
      type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps,
    })).toThrow();
  });
});

describe('runSimulation', () => {
  it('replays the real 22,839-W observation with the first Garage limit at exactly 30 s', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const steps = runDemoSimulation(config());
    expect(steps.slice(0, 4).map((step) => step.state)).toEqual([
      'TRIGGER_PENDING', 'TRIGGER_PENDING', 'TRIGGER_PENDING', 'TRIGGER_PENDING',
    ]);
    expect(steps.slice(0, 4).every((step) => step.action === null)).toBe(true);
    expect(steps[4]).toMatchObject({
      timestampMs: 30_000,
      gridImportW: 22_839,
      state: 'LIMITING',
      action: { type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 13 },
    });
    expect(steps[5]).toMatchObject({
      timestampMs: 34_000,
      action: { type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 12 },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('observes applied limits only on subsequent samples and preserves initial snapshots', () => {
    const statuses = demoStatuses(config());
    const original = structuredClone(statuses);
    const steps = runSimulation(config(), statuses, [
      { timestampMs: 0, gridPowerW: 22_839 },
      { timestampMs: 30_000, gridPowerW: 22_839 },
      { timestampMs: 34_000, gridPowerW: 22_839 },
    ]);
    expect(steps[1]?.observedChargers[0]?.temporaryCurrentLimitA).toBeNull();
    expect(steps[2]?.observedChargers[0]?.temporaryCurrentLimitA).toBe(13);
    expect(statuses).toEqual(original);
  });

  it('models null as FAULT without automatically restoring an existing limit', () => {
    const steps = runSimulation(config(), [garage()], [
      { timestampMs: 0, gridPowerW: 22_839 },
      { timestampMs: 30_000, gridPowerW: 22_839 },
      { timestampMs: 34_000, gridPowerW: null },
    ]);
    expect(steps[2]).toMatchObject({ state: 'FAULT', action: null, gridImportW: null });
    expect(steps[2]?.observedChargers[0]?.temporaryCurrentLimitA).toBe(13);
  });

  it('preserves negative signed Grid power while reporting zero import', () => {
    const steps = runSimulation(config(), [garage()], [{ timestampMs: 0, gridPowerW: -1_500 }]);
    expect(steps[0]).toMatchObject({ state: 'NORMAL', action: null, gridPowerW: -1_500, gridImportW: 0 });
  });

  it('is deterministic for identical inputs', () => {
    expect(runDemoSimulation(config())).toEqual(runDemoSimulation(config()));
  });

  it('derives demonstration times and recovery thresholds from configuration', () => {
    const adjusted: AppConfig = {
      ...config(),
      loadManagement: {
        ...config().loadManagement,
        triggerDurationSeconds: 12,
        controlIntervalSeconds: 2,
        gridLimitW: 16_000,
        safetyReserveW: 700,
      },
    };
    const samples = demoSamples(adjusted);
    expect(samples[3]?.timestampMs).toBe(11_999);
    expect(samples[4]?.timestampMs).toBe(12_000);
    expect(samples[5]?.timestampMs).toBe(14_000);
    expect(samples[7]?.gridPowerW).toBe(15_300);
    expect(samples[8]?.gridPowerW).toBe(14_600);
  });

  it('uses integer timestamps even when the configured trigger duration is not divisible by three', () => {
    const short: AppConfig = {
      ...config(),
      loadManagement: { ...config().loadManagement, triggerDurationSeconds: 1 },
    };
    expect(demoSamples(short).every((sample) => Number.isSafeInteger(sample.timestampMs))).toBe(true);
    expect(runDemoSimulation(short).some((step) => step.status.fault?.code === 'INVALID_INPUT')).toBe(false);
  });
});
