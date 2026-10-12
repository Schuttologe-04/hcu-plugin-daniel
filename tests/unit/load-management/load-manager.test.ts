import { describe, expect, it, vi } from 'vitest';
import { KnownCarState, mapCarState, type ChargerStatus } from '../../../src/domain/charger.js';
import type { ControllerStatus } from '../../../src/domain/controller.js';
import { failure, success } from '../../../src/domain/errors.js';
import { LoadManager } from '../../../src/load-management/load-manager.js';
import {
  allEnabledConfig, controller, idle, makeCharger, makeConfig, SimulationHarness,
} from './helpers.js';

function minimumCharger(id = 'garage', patch: Partial<ChargerStatus> = {}): ChargerStatus {
  return makeCharger(id, { effectiveCurrentA: 6, temporaryCurrentLimitA: 6, ...patch });
}

function limitedGarage(): SimulationHarness {
  const simulation = new SimulationHarness();
  const decision = simulation.trigger();
  expect(decision.action).toEqual({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 13 });
  return simulation;
}

function pausedGarage(pauseDurationMs = 0): SimulationHarness {
  const simulation = new SimulationHarness(makeConfig(), [makeCharger('garage', {
    configuredCurrentA: 7, effectiveCurrentA: 7, minimumChargingPauseDuration: pauseDurationMs,
  }), idle('links')]);
  expect(simulation.trigger().action).toEqual({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 6 });
  expect(simulation.step(34_000, 22_000).action).toEqual({ type: 'PAUSE', chargerId: 'garage' });
  return simulation;
}

describe('LoadManager trigger and explicit time', () => {
  it.each([18_999, 19_000])('Grid %i W stays NORMAL', (watts) => {
    const simulation = new SimulationHarness();
    const result = simulation.evaluate(0, watts);
    expect(result.state).toBe('NORMAL');
    expect(result.action).toBeNull();
    expect(result.status.triggerStartedAtMs).toBeNull();
  });

  it('Grid 19,001 W starts TRIGGER_PENDING at the observation timestamp', () => {
    const result = new SimulationHarness().evaluate(5_000, 19_001);
    expect(result.state).toBe('TRIGGER_PENDING');
    expect(result.status.triggerStartedAtMs).toBe(5_000);
    expect(result.action).toBeNull();
  });

  it.each([29_000, 29_999])('does not reduce after only %i ms of continuous excess', (timestamp) => {
    const simulation = new SimulationHarness();
    simulation.evaluate(0, 22_839);
    const result = simulation.evaluate(timestamp, 22_839);
    expect(result.state).toBe('TRIGGER_PENDING');
    expect(result.action).toBeNull();
  });

  it('enters LIMITING and emits the first 1 A reduction at exactly 30 seconds', () => {
    const result = new SimulationHarness().trigger();
    expect(result.state).toBe('LIMITING');
    expect(result.action).toEqual({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 13 });
  });

  it('fully discards the trigger timer when the excess stops after 20 seconds', () => {
    const simulation = new SimulationHarness();
    simulation.evaluate(0, 22_000);
    const reset = simulation.evaluate(20_000, 19_000);
    expect(reset.state).toBe('NORMAL');
    expect(reset.status.triggerStartedAtMs).toBeNull();
    expect(simulation.evaluate(25_000, 22_000).state).toBe('TRIGGER_PENDING');
    expect(simulation.evaluate(50_000, 22_000).action).toBeNull();
    expect(simulation.evaluate(55_000, 22_000).action).toEqual({
      type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 13,
    });
  });

  it('cancels the pending trigger if all chargers stop actively charging', () => {
    const simulation = new SimulationHarness();
    simulation.evaluate(0, 22_000);
    simulation.patch('garage', { carState: mapCarState(KnownCarState.Idle), effectiveCurrentA: null });
    expect(simulation.evaluate(20_000, 22_000).state).toBe('NORMAL');
    simulation.patch('garage', { carState: mapCarState(KnownCarState.Charging), effectiveCurrentA: 14 });
    expect(simulation.evaluate(30_000, 22_000).state).toBe('TRIGGER_PENDING');
    expect(simulation.evaluate(59_999, 22_000).action).toBeNull();
  });

  it('cancels pending excess if the remaining active charger becomes uncontrollable', () => {
    const simulation = new SimulationHarness(makeConfig(), [makeCharger('garage', {
      effectiveCurrentA: 7, temporaryCurrentLimitA: 7, allowChargingPause: false,
    }), idle('links')]);
    expect(simulation.evaluate(0, 22_000).state).toBe('TRIGGER_PENDING');
    simulation.patch('garage', { effectiveCurrentA: 6, temporaryCurrentLimitA: 6 });
    const cancelled = simulation.evaluate(20_000, 22_000);
    expect(cancelled.state).toBe('NORMAL');
    expect(cancelled.status.triggerStartedAtMs).toBeNull();
    simulation.patch('garage', { effectiveCurrentA: 7, temporaryCurrentLimitA: 7 });
    expect(simulation.evaluate(25_000, 22_000).state).toBe('TRIGGER_PENDING');
    expect(simulation.evaluate(54_999, 22_000).action).toBeNull();
    expect(simulation.evaluate(55_000, 22_000).action).toMatchObject({ amps: 6 });
  });

  it('does not trigger an excess without any active charging load', () => {
    const simulation = new SimulationHarness(makeConfig(), [idle('garage'), idle('links')]);
    expect(simulation.evaluate(0, 25_000).state).toBe('NORMAL');
    expect(simulation.evaluate(60_000, 25_000).action).toBeNull();
  });

  it('uses the centralized known car=2 definition and ignores unknown future car codes', () => {
    const simulation = new SimulationHarness(makeConfig(), [makeCharger('garage', {
      carState: mapCarState(77),
    }), idle('links')]);
    expect(simulation.evaluate(0, 25_000).state).toBe('NORMAL');
  });

  it('ignores charging observations for disabled chargers', () => {
    const simulation = new SimulationHarness(makeConfig(), [idle('garage'), idle('links'), makeCharger('rechts')]);
    expect(simulation.evaluate(0, 25_000).state).toBe('NORMAL');
    expect(simulation.evaluate(30_000, 25_000).action).toBeNull();
  });

  it('does not start automatic regulation when configuration disables load management', () => {
    const simulation = new SimulationHarness(makeConfig({ loadManagement: { enabled: false } }));
    expect(simulation.evaluate(0, 25_000).state).toBe('NORMAL');
    expect(simulation.evaluate(30_000, 25_000).action).toBeNull();
  });

  it('negative grid power preserves export and does not trigger limiting', () => {
    const result = new SimulationHarness().evaluate(0, -6_500);
    expect(result.state).toBe('NORMAL');
    expect(result.status.gridImportW).toBe(0);
    expect(result.action).toBeNull();
  });

  it('derives thresholds, trigger duration and interval from configuration', () => {
    const simulation = new SimulationHarness(makeConfig({ loadManagement: {
      gridLimitW: 12_000, safetyReserveW: 250, triggerDurationSeconds: 5, controlIntervalSeconds: 2,
    } }));
    expect(simulation.evaluate(0, 12_001).status).toMatchObject({
      targetGridW: 11_750, recoveryThresholdW: 11_500,
    });
    expect(simulation.evaluate(4_999, 12_001).action).toBeNull();
    expect(simulation.step(5_000, 12_001).action).toMatchObject({ amps: 13 });
    expect(simulation.evaluate(6_999, 12_001).action).toBeNull();
    expect(simulation.step(7_000, 12_001).action).toMatchObject({ amps: 12 });
  });

  it('does not read Date.now or create a hidden interval to measure trigger time', () => {
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Wall clock forbidden'); });
    const interval = vi.spyOn(globalThis, 'setInterval');
    expect(new SimulationHarness().trigger().action).toMatchObject({ amps: 13 });
    expect(dateNow).not.toHaveBeenCalled();
    expect(interval).not.toHaveBeenCalled();
  });
});

describe('LoadManager action cadence and fresh feedback', () => {
  it('produces one 1 A step per decision and waits four seconds between commands', () => {
    const simulation = limitedGarage();
    for (const timestamp of [30_000, 31_000, 33_999]) {
      expect(simulation.evaluate(timestamp, 22_000).action).toBeNull();
    }
    const second = simulation.step(34_000, 22_000);
    expect(second.action).toEqual({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 12 });
    expect(simulation.status('garage').configuredCurrentA).toBe(14);
    expect(simulation.evaluate(37_999, 22_000).action).toBeNull();
    expect(simulation.step(38_000, 22_000).action).toMatchObject({ amps: 11 });
  });

  it('does not restart the thirty-second trigger in an existing limiting phase', () => {
    const simulation = limitedGarage();
    expect(simulation.step(34_000, 20_000).action).toMatchObject({ amps: 12 });
    expect(simulation.step(38_000, 19_001).action).toMatchObject({ amps: 11 });
  });

  it('does not issue another action while the last proposed action is unacknowledged', () => {
    const simulation = new SimulationHarness();
    simulation.evaluate(0, 22_000);
    const proposed = simulation.evaluate(30_000, 22_000);
    expect(proposed.action).toMatchObject({ amps: 13 });
    expect(proposed.actionId).toEqual(expect.any(String));
    const held = simulation.evaluate(34_000, 22_000);
    expect(held.action).toBeNull();
    expect(held.status.pendingAction).toMatchObject({ id: proposed.actionId, action: proposed.action });
    simulation.apply(proposed);
    expect(simulation.step(38_000, 22_000).action).toMatchObject({ amps: 12 });
  });

  it('does not reuse the same measurement to emit several current steps even if time advances', () => {
    const simulation = new SimulationHarness();
    simulation.evaluate(0, 22_000, 'start');
    const first = simulation.evaluate(30_000, 22_000, 'measurement-30');
    simulation.apply(first);
    expect(simulation.evaluate(34_000, 22_000, 'measurement-30').action).toBeNull();
    expect(simulation.evaluate(38_000, 22_000, 'measurement-30').action).toBeNull();
    expect(simulation.evaluate(42_000, 22_000, 'measurement-42').action).toMatchObject({ amps: 12 });
  });

  it('requires a fresh observation of the acknowledged temporary limit', () => {
    const simulation = new SimulationHarness();
    simulation.evaluate(0, 22_000);
    const proposed = simulation.evaluate(30_000, 22_000);
    if (!proposed.actionId) throw new Error('Expected proposal');
    simulation.engine.acknowledgeAction(proposed.actionId);
    const inconsistent = simulation.evaluate(34_000, 22_000);
    expect(inconsistent.state).toBe('FAULT');
    expect(inconsistent.action).toBeNull();
    expect(inconsistent.status.restrictions).toHaveLength(1);
  });

  it('failed acknowledgement does not install a fictitious simulated restriction', () => {
    const simulation = new SimulationHarness();
    simulation.evaluate(0, 22_000);
    const proposed = simulation.evaluate(30_000, 22_000);
    if (!proposed.actionId) throw new Error('Expected proposal');
    simulation.engine.acknowledgeAction(proposed.actionId, 'failed');
    expect(simulation.engine.state).toBe('FAULT');
    expect(simulation.engine.snapshot.pendingAction).toBeNull();
    expect(simulation.engine.snapshot.restrictions).toHaveLength(0);
  });

  it('wrong and stale acknowledgement IDs leave the real pending proposal intact', () => {
    const simulation = new SimulationHarness();
    simulation.evaluate(0, 22_000);
    const proposed = simulation.evaluate(30_000, 22_000);
    expect(simulation.engine.acknowledgeAction('unrelated-action')).toBe(false);
    expect(simulation.engine.snapshot.pendingAction).toMatchObject({ id: proposed.actionId });
    expect(simulation.engine.snapshot.restrictions).toHaveLength(0);
    simulation.apply(proposed);
    if (!proposed.actionId) throw new Error('Expected proposal');
    expect(simulation.engine.acknowledgeAction(proposed.actionId)).toBe(false);
    expect(simulation.engine.snapshot.restrictions).toMatchObject([{ temporaryCurrentLimitA: 13 }]);
  });

  it('never changes ownership implicitly because feedback happens to match an unacknowledged intent', () => {
    const simulation = new SimulationHarness();
    simulation.evaluate(0, 22_000);
    const proposed = simulation.evaluate(30_000, 22_000);
    simulation.patch('garage', { temporaryCurrentLimitA: 13, effectiveCurrentA: 13 });
    const result = simulation.evaluate(34_000, 22_000);
    expect(result.action).toBeNull();
    expect(result.status.pendingAction).toMatchObject({ id: proposed.actionId });
    expect(result.status.restrictions).toHaveLength(0);
  });

  it('keeps the RECOVERING state while an emitted recovery current increase awaits acknowledgement', () => {
    const simulation = limitedGarage();
    const recovery = simulation.evaluate(34_000, 18_000);
    expect(recovery.state).toBe('RECOVERING');
    expect(recovery.action).toMatchObject({ amps: 14 });
    const pending = simulation.evaluate(38_000, 18_000);
    expect(pending.state).toBe('RECOVERING');
    expect(pending.action).toBeNull();
    expect(pending.status.pendingAction).toMatchObject({ id: recovery.actionId });
  });

  it('keeps the RECOVERING state while abstract RESUME awaits acknowledgement', () => {
    const simulation = pausedGarage();
    const resume = simulation.evaluate(38_000, 18_000);
    expect(resume.action).toMatchObject({ type: 'RESUME' });
    const pending = simulation.evaluate(42_000, 18_000);
    expect(pending.state).toBe('RECOVERING');
    expect(pending.action).toBeNull();
    expect(pending.status.pendingAction).toMatchObject({ id: resume.actionId });
  });

  it('requires fresh matching feedback after CLEAR acknowledgement before ending the phase', () => {
    const simulation = limitedGarage();
    simulation.step(34_000, 18_000);
    const clear = simulation.evaluate(38_000, 18_000);
    expect(clear.action).toEqual({ type: 'CLEAR_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage' });
    if (!clear.actionId) throw new Error('Expected clear proposal');
    simulation.engine.acknowledgeAction(clear.actionId);
    expect(simulation.engine.snapshot.restrictions).toHaveLength(0);
    const mismatch = simulation.evaluate(42_000, 18_000);
    expect(mismatch.state).toBe('FAULT');
    expect(mismatch.action).toBeNull();
    expect(mismatch.status.awaitingObservationChargerIds).toContain('garage');
    simulation.patch('garage', { temporaryCurrentLimitA: null, effectiveCurrentA: 14 });
    const confirmed = simulation.evaluate(46_000, 18_000);
    expect(confirmed.state).toBe('NORMAL');
    expect(confirmed.status.awaitingObservationChargerIds).toHaveLength(0);
  });

  it('requires observed restoration of a foreign baseline before discarding the feedback wait', () => {
    const simulation = new SimulationHarness(makeConfig(), [makeCharger('garage', {
      effectiveCurrentA: 10, temporaryCurrentLimitA: 10,
    }), idle('links')]);
    simulation.trigger();
    const restored = simulation.evaluate(34_000, 18_000);
    expect(restored.action).toEqual({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 10 });
    if (!restored.actionId) throw new Error('Expected restore proposal');
    simulation.engine.acknowledgeAction(restored.actionId);
    const mismatch = simulation.evaluate(38_000, 18_000);
    expect(mismatch.state).toBe('FAULT');
    expect(mismatch.action).toBeNull();
    simulation.patch('garage', { temporaryCurrentLimitA: 10, effectiveCurrentA: 10 });
    expect(simulation.evaluate(42_000, 18_000).state).toBe('NORMAL');
  });

  it('confirms a restored foreign-limit RESUME even when acknowledging it removes all ownership', () => {
    const simulation = new SimulationHarness(makeConfig(), [minimumCharger(), idle('links')]);
    expect(simulation.trigger().action).toEqual({ type: 'PAUSE', chargerId: 'garage' });
    const restored = simulation.evaluate(34_000, 18_000);
    expect(restored.action).toEqual({ type: 'RESUME', chargerId: 'garage' });
    if (!restored.actionId) throw new Error('Expected resume proposal');
    simulation.engine.acknowledgeAction(restored.actionId);
    expect(simulation.engine.snapshot.restrictions).toHaveLength(0);
    const mismatch = simulation.evaluate(38_000, 18_000);
    expect(mismatch.state).toBe('FAULT');
    expect(mismatch.action).toBeNull();
    simulation.patch('garage', { forceState: 0, chargingAllowed: true, effectiveCurrentA: 6,
      carState: mapCarState(KnownCarState.Charging) });
    expect(simulation.evaluate(42_000, 18_000).state).toBe('NORMAL');
    expect(simulation.status('garage').temporaryCurrentLimitA).toBe(6);
  });
});

describe('LoadManager priorities and fair equal-priority scheduling', () => {
  it('reduces Links before Garage when both are actively charging', () => {
    const simulation = new SimulationHarness(makeConfig(), [makeCharger(), makeCharger('links')]);
    expect(simulation.trigger().action).toEqual({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'links', amps: 13 });
    expect(simulation.status('garage').temporaryCurrentLimitA).toBeNull();
  });

  it('reduces Garage when no lower-priority charger is actively charging', () => {
    expect(new SimulationHarness().trigger().action).toEqual({
      type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 13,
    });
  });

  it('pauses minimum-current Links before reducing Garage', () => {
    const simulation = new SimulationHarness(makeConfig(), [makeCharger(), minimumCharger('links')]);
    expect(simulation.trigger().action).toEqual({ type: 'PAUSE', chargerId: 'links' });
    expect(simulation.status('garage').temporaryCurrentLimitA).toBeNull();
    expect(simulation.step(34_000, 22_000).action).toEqual({
      type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 13,
    });
  });

  it('prefers Garage when returning owned charging capacity', () => {
    const simulation = new SimulationHarness(makeConfig(), [makeCharger(), minimumCharger('links')]);
    simulation.trigger();
    simulation.step(34_000, 22_000);
    const recovery = simulation.step(38_000, 18_000);
    expect(recovery.state).toBe('RECOVERING');
    expect(recovery.action).toEqual({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 14 });
    expect(simulation.status('links').forceState).toBe(1);
  });

  it('holds lower-priority recovery while the owned higher-priority pause still awaits its minimum duration', () => {
    const simulation = new SimulationHarness(makeConfig(), [
      minimumCharger('garage', { minimumChargingPauseDuration: 20_000 }), idle('links'),
    ]);
    expect(simulation.trigger().action).toEqual({ type: 'PAUSE', chargerId: 'garage' });
    simulation.patch('links', { carState: mapCarState(KnownCarState.Charging), effectiveCurrentA: 14,
      chargingAllowed: true, forceState: 0, modelStatus: 15 });
    expect(simulation.step(34_000, 22_000).action).toEqual({
      type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'links', amps: 13,
    });
    expect(simulation.evaluate(38_000, 18_000).action).toBeNull();
    expect(simulation.evaluate(46_000, 18_000).action).toBeNull();
    expect(simulation.step(50_000, 18_000).action).toEqual({ type: 'RESUME', chargerId: 'garage' });
    expect(simulation.step(54_000, 18_000).action).toEqual({
      type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'links', amps: 14,
    });
  });

  it('alternates equal-priority active chargers deterministically by round robin', () => {
    const simulation = new SimulationHarness(allEnabledConfig(), [idle('garage'), makeCharger('links'), makeCharger('rechts')]);
    expect(simulation.trigger().action).toEqual({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'links', amps: 13 });
    expect(simulation.step(34_000, 22_000).action).toEqual({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'rechts', amps: 13 });
    expect(simulation.step(38_000, 22_000).action).toEqual({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'links', amps: 12 });
    expect(simulation.step(42_000, 22_000).action).toEqual({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'rechts', amps: 12 });
  });

  it('skips idle peers without preventing the active equal-priority charger from regulating', () => {
    const simulation = new SimulationHarness(allEnabledConfig(), [idle('garage'), idle('links'), makeCharger('rechts')]);
    expect(simulation.trigger().action).toMatchObject({ chargerId: 'rechts', amps: 13 });
    expect(simulation.step(34_000, 22_000).action).toMatchObject({ chargerId: 'rechts', amps: 12 });
  });

  it('skips minimum-current peers for reductions while another equal-priority peer can reduce', () => {
    const simulation = new SimulationHarness(allEnabledConfig(), [idle('garage'), minimumCharger('links'), makeCharger('rechts')]);
    expect(simulation.trigger().action).toMatchObject({ chargerId: 'rechts', amps: 13 });
    expect(simulation.step(34_000, 22_000).action).toMatchObject({ chargerId: 'rechts', amps: 12 });
    expect(simulation.status('links').forceState).toBe(0);
  });

  it('maintains equal-priority fairness across fourteen consecutive regulation cycles', () => {
    const simulation = new SimulationHarness(allEnabledConfig(), [idle('garage'), makeCharger('links'), makeCharger('rechts')]);
    simulation.evaluate(0, 22_000);
    for (let index = 0; index < 14; index += 1) {
      const decision = simulation.step(30_000 + index * 4_000, 22_000);
      expect(decision.action).toEqual({
        type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: index % 2 === 0 ? 'links' : 'rechts',
        amps: 13 - Math.floor(index / 2),
      });
    }
    expect(simulation.status('links').effectiveCurrentA).toBe(7);
    expect(simulation.status('rechts').effectiveCurrentA).toBe(7);
  });

  it('also alternates equal-priority owned limits during recovery', () => {
    const simulation = new SimulationHarness(allEnabledConfig(), [idle('garage'), makeCharger('links'), makeCharger('rechts')]);
    simulation.trigger();
    simulation.step(34_000, 22_000);
    expect(simulation.step(38_000, 18_000).action).toEqual({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'links', amps: 14 });
    expect(simulation.step(42_000, 18_000).action).toEqual({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'rechts', amps: 14 });
    expect(simulation.step(46_000, 18_000).action).toEqual({ type: 'CLEAR_TEMPORARY_CURRENT_LIMIT', chargerId: 'links' });
    expect(simulation.step(50_000, 18_000).action).toEqual({ type: 'CLEAR_TEMPORARY_CURRENT_LIMIT', chargerId: 'rechts' });
  });

  it('does not let an unavailable lower-priority charger invalidate a reachable charger', () => {
    const simulation = new SimulationHarness();
    simulation.chargers.set('links', failure('ConnectionError', 'Unavailable'));
    const decision = simulation.trigger();
    expect(decision.state).toBe('LIMITING');
    expect(decision.action).toMatchObject({ chargerId: 'garage', amps: 13 });
    expect(decision.status.unavailableChargerIds).toContain('links');
  });
});

describe('LoadManager effective current, minimum current and abstract pauses', () => {
  it('uses effective acu instead of blindly reducing the configured amp', () => {
    const simulation = new SimulationHarness(makeConfig(), [makeCharger('garage', {
      configuredCurrentA: 14, effectiveCurrentA: 10, temporaryCurrentLimitA: 12,
    }), idle('links')]);
    expect(simulation.trigger().action).toEqual({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 9 });
    expect(simulation.status('garage').configuredCurrentA).toBe(14);
  });

  it('reduces 7 A to the measured 6 A minimum', () => {
    const simulation = new SimulationHarness(makeConfig(), [makeCharger('garage', {
      effectiveCurrentA: 7, temporaryCurrentLimitA: 7,
    }), idle('links')]);
    expect(simulation.trigger().action).toEqual({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 6 });
  });

  it('never emits 5 A when minimum current is 6 A', () => {
    const simulation = new SimulationHarness(makeConfig(), [minimumCharger(), idle('links')]);
    expect(simulation.trigger().action).toEqual({ type: 'PAUSE', chargerId: 'garage' });
    expect(simulation.step(34_000, 22_000).action).toBeNull();
  });

  it('honors an observed minimum other than 6 A', () => {
    const simulation = new SimulationHarness(makeConfig(), [makeCharger('garage', {
      minimumCurrentA: 8, effectiveCurrentA: 9, temporaryCurrentLimitA: 9,
    }), idle('links')]);
    expect(simulation.trigger().action).toMatchObject({ amps: 8 });
    expect(simulation.step(34_000, 22_000).action).toEqual({ type: 'PAUSE', chargerId: 'garage' });
  });

  it('does not trigger or pause an already-minimum charger that reports acp=false', () => {
    const simulation = new SimulationHarness(makeConfig(), [minimumCharger('garage', { allowChargingPause: false }), idle('links')]);
    const first = simulation.trigger();
    expect(first.action).toBeNull();
    expect(first.state).toBe('NORMAL');
  });

  it('reports an unachievable target in an existing phase when minimum current cannot be paused', () => {
    const simulation = new SimulationHarness(makeConfig(), [makeCharger('garage', {
      effectiveCurrentA: 7, temporaryCurrentLimitA: 7, allowChargingPause: false,
    }), idle('links')]);
    expect(simulation.trigger().action).toMatchObject({ amps: 6 });
    const result = simulation.evaluate(34_000, 22_000);
    expect(result.state).toBe('LIMIT_UNACHIEVABLE');
    expect(result.action).toBeNull();
  });

  it('does not generate repeated PAUSE actions for the same owned pause', () => {
    const simulation = pausedGarage();
    for (const timestamp of [38_000, 42_000, 46_000]) {
      expect(simulation.step(timestamp, 22_000).action).toBeNull();
    }
    expect(simulation.engine.snapshot.restrictions).toMatchObject([{ chargerId: 'garage', paused: true }]);
  });

  it('recovery resumes a paused charger at its retained minimum before increasing later', () => {
    const simulation = pausedGarage();
    const resumed = simulation.step(38_000, 18_000);
    expect(resumed.state).toBe('RECOVERING');
    expect(resumed.action).toEqual({ type: 'RESUME', chargerId: 'garage' });
    expect(simulation.status('garage').temporaryCurrentLimitA).toBe(6);
    expect(simulation.status('garage').effectiveCurrentA).toBe(6);
    expect(simulation.evaluate(38_000, 18_000).action).toBeNull();
    expect(simulation.evaluate(41_999, 18_000).action).toBeNull();
    expect(simulation.step(42_000, 18_000).action).toEqual({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 7 });
  });

  it('respects observed minimum pause duration before abstract RESUME', () => {
    const simulation = pausedGarage(10_000);
    expect(simulation.evaluate(38_000, 18_000).action).toBeNull();
    expect(simulation.evaluate(43_999, 18_000).action).toBeNull();
    expect(simulation.step(44_000, 18_000).action).toEqual({ type: 'RESUME', chargerId: 'garage' });
  });

  it('uses the latest observed pause duration when the pause itself is acknowledged', () => {
    const simulation = new SimulationHarness(makeConfig(), [makeCharger('garage', {
      configuredCurrentA: 7, effectiveCurrentA: 7, minimumChargingPauseDuration: 0,
    }), idle('links')]);
    expect(simulation.trigger().action).toMatchObject({ amps: 6 });
    simulation.patch('garage', { minimumChargingPauseDuration: 20_000 });
    expect(simulation.step(34_000, 22_000).action).toEqual({ type: 'PAUSE', chargerId: 'garage' });
    expect(simulation.evaluate(38_000, 18_000).action).toBeNull();
    expect(simulation.evaluate(53_999, 18_000).action).toBeNull();
    expect(simulation.step(54_000, 18_000).action).toEqual({ type: 'RESUME', chargerId: 'garage' });
  });

  it('skips pause-duration-blocked equal-priority owners until their own RESUME becomes eligible', () => {
    const simulation = new SimulationHarness(allEnabledConfig(), [
      idle('garage'),
      minimumCharger('links', { minimumChargingPauseDuration: 20_000 }),
      minimumCharger('rechts', { minimumChargingPauseDuration: 10_000 }),
    ]);
    expect(simulation.trigger().action).toEqual({ type: 'PAUSE', chargerId: 'links' });
    expect(simulation.step(34_000, 22_000).action).toEqual({ type: 'PAUSE', chargerId: 'rechts' });
    expect(simulation.evaluate(38_000, 18_000).action).toBeNull();
    expect(simulation.evaluate(42_000, 18_000).action).toBeNull();
    expect(simulation.step(44_000, 18_000).action).toEqual({ type: 'RESUME', chargerId: 'rechts' });
    expect(simulation.evaluate(48_000, 18_000).action).toBeNull();
    expect(simulation.step(50_000, 18_000).action).toEqual({ type: 'RESUME', chargerId: 'links' });
  });

  it('establishes a retained minimum temporary limit before pausing a minimum-current charger', () => {
    const simulation = new SimulationHarness(makeConfig(), [makeCharger('garage', {
      configuredCurrentA: 6, effectiveCurrentA: 6, temporaryCurrentLimitA: null,
    }), idle('links')]);
    expect(simulation.trigger().action).toEqual({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 6 });
    expect(simulation.step(34_000, 22_000).action).toEqual({ type: 'PAUSE', chargerId: 'garage' });
    expect(simulation.step(38_000, 18_000).action).toEqual({ type: 'RESUME', chargerId: 'garage' });
    expect(simulation.status('garage').temporaryCurrentLimitA).toBe(6);
  });

  it('requires the acknowledged RESUME to be observed before attempting a recovery increase', () => {
    const simulation = pausedGarage();
    const resumed = simulation.evaluate(38_000, 18_000);
    expect(resumed.action).toEqual({ type: 'RESUME', chargerId: 'garage' });
    if (!resumed.actionId) throw new Error('Expected resume proposal');
    simulation.engine.acknowledgeAction(resumed.actionId);
    const inconsistent = simulation.evaluate(42_000, 18_000);
    expect(inconsistent.state).toBe('FAULT');
    expect(inconsistent.action).toBeNull();
    expect(inconsistent.status.restrictions).toHaveLength(1);
  });

  it('does not interpret the pause-observed car=4 as an automatic session end', () => {
    const simulation = pausedGarage();
    expect(simulation.status('garage').carState.code).toBe(KnownCarState.Complete);
    simulation.engine.applyManualOverride();
    expect(simulation.step(38_000, 22_000).state).toBe('OVERRIDE');
    expect(simulation.engine.snapshot.overrideActive).toBe(true);
  });
});

describe('LoadManager hysteresis and completing recovery', () => {
  it.each([18_500.001, 18_501, 20_000])('continues reducing above the target (%s W)', (gridW) => {
    const simulation = limitedGarage();
    expect(simulation.step(34_000, gridW).action).toMatchObject({ amps: 12 });
  });

  it.each([18_000.001, 18_250, 18_500])('holds the existing limit in the hysteresis band (%s W)', (gridW) => {
    const simulation = limitedGarage();
    const result = simulation.evaluate(34_000, gridW);
    expect(result.action).toBeNull();
    expect(result.status.restrictions).toMatchObject([{ chargerId: 'garage', temporaryCurrentLimitA: 13 }]);
  });

  it.each([18_000, 17_999, 0, -3_000])('permits only one recovery amp step at or below threshold (%s W)', (gridW) => {
    const simulation = limitedGarage();
    const result = simulation.step(34_000, gridW);
    expect(result.state).toBe('RECOVERING');
    expect(result.action).toEqual({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 14 });
  });

  it('can reverse a recovery step when a later measurement exceeds the target', () => {
    const simulation = limitedGarage();
    simulation.step(34_000, 18_000);
    const result = simulation.step(38_000, 19_000);
    expect(result.state).toBe('LIMITING');
    expect(result.action).toEqual({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 13 });
  });

  it('raises current stepwise, clears its own temporary limit, then returns NORMAL after stable feedback', () => {
    const simulation = limitedGarage();
    simulation.step(34_000, 18_000);
    const cleared = simulation.step(38_000, 18_000);
    expect(cleared.action).toEqual({ type: 'CLEAR_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage' });
    expect(simulation.engine.snapshot.restrictions).toHaveLength(0);
    expect(simulation.evaluate(41_999, 18_000).state).not.toBe('NORMAL');
    const finished = simulation.evaluate(42_000, 18_000);
    expect(finished.state).toBe('NORMAL');
    expect(finished.action).toBeNull();
    expect(simulation.status('garage').configuredCurrentA).toBe(14);
  });

  it('never clears a foreign temporary current limit or treats it as initially owned', () => {
    const simulation = new SimulationHarness(makeConfig(), [makeCharger('garage', {
      effectiveCurrentA: 10, temporaryCurrentLimitA: 10,
    }), idle('links')]);
    expect(simulation.evaluate(0, 18_000).action).toBeNull();
    expect(simulation.engine.snapshot.restrictions).toHaveLength(0);
    expect(simulation.trigger().action).toMatchObject({ amps: 9 });
    expect(simulation.step(34_000, 18_000).action).toEqual({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 10 });
    expect(simulation.engine.snapshot.restrictions).toHaveLength(0);
    expect(simulation.evaluate(38_000, 18_000).state).toBe('NORMAL');
    expect(simulation.status('garage').temporaryCurrentLimitA).toBe(10);
  });

  it('records ownership separately from the normal user current', () => {
    const simulation = limitedGarage();
    expect(simulation.engine.snapshot.restrictions).toEqual([expect.objectContaining({
      chargerId: 'garage', baselineTemporaryCurrentLimitA: null, temporaryCurrentLimitA: 13, paused: false,
    })]);
    expect(simulation.status('garage').configuredCurrentA).toBe(14);
  });
});

describe('LoadManager safe FAULT and LIMIT_UNACHIEVABLE states', () => {
  it('reports LIMIT_UNACHIEVABLE after all available charging load is paused', () => {
    const simulation = pausedGarage();
    const result = simulation.evaluate(38_000, 20_500);
    expect(result.state).toBe('LIMIT_UNACHIEVABLE');
    expect(result.action).toBeNull();
    expect(result.status).toMatchObject({
      gridImportW: 20_500, targetGridW: 18_500, controllableChargingLoadRemaining: false,
    });
  });

  it('does not produce a command loop while the limit remains unachievable', () => {
    const simulation = pausedGarage();
    for (const timestamp of [38_000, 42_000, 46_000, 50_000]) {
      const result = simulation.evaluate(timestamp, 20_500);
      expect(result.state).toBe('LIMIT_UNACHIEVABLE');
      expect(result.action).toBeNull();
    }
  });

  it('allows recovery from LIMIT_UNACHIEVABLE once adequate reserve is measured', () => {
    const simulation = pausedGarage();
    expect(simulation.evaluate(38_000, 20_500).state).toBe('LIMIT_UNACHIEVABLE');
    expect(simulation.step(42_000, 18_000).action).toEqual({ type: 'RESUME', chargerId: 'garage' });
  });

  it('reports a paused state while all owned chargers stay paused inside the hysteresis band', () => {
    const simulation = pausedGarage();
    const result = simulation.evaluate(38_000, 18_250);
    expect(result.state).toBe('PAUSED');
    expect(result.action).toBeNull();
  });

  it('leaves LIMIT_UNACHIEVABLE for PAUSED once grid returns to the hysteresis band', () => {
    const simulation = pausedGarage();
    expect(simulation.evaluate(38_000, 20_500).state).toBe('LIMIT_UNACHIEVABLE');
    const held = simulation.evaluate(42_000, 18_250);
    expect(held.state).toBe('PAUSED');
    expect(held.action).toBeNull();
  });

  it.each(['ConnectionError', 'TimeoutError', 'MissingMeasurementError'] as const)(
    'missing or unavailable controller (%s) never releases an owned restriction', (code) => {
      const simulation = limitedGarage();
      const result = simulation.evaluateController(34_000, failure(code, 'Controller measurement unavailable'));
      expect(result.state).toBe('FAULT');
      expect(result.action).toBeNull();
      expect(result.status.gridImportW).toBeNull();
      expect(result.status.fault).not.toBeNull();
      expect(result.status.restrictions).toMatchObject([{ chargerId: 'garage', temporaryCurrentLimitA: 13 }]);
    },
  );

  it('a reused measurement ID cannot hide controller failure or release an owned restriction', () => {
    const simulation = limitedGarage();
    expect(simulation.evaluate(31_000, 22_000, 'reused-observation').action).toBeNull();
    const fault = simulation.evaluateController(34_000,
      failure('ConnectionError', 'Controller unavailable'), 'reused-observation');
    expect(fault.state).toBe('FAULT');
    expect(fault.action).toBeNull();
    expect(fault.status.gridImportW).toBeNull();
    expect(fault.status.restrictions).toMatchObject([{ chargerId: 'garage', temporaryCurrentLimitA: 13 }]);
  });

  it('invalid grid under a reused measurement ID breaks continuous trigger time', () => {
    const simulation = new SimulationHarness();
    expect(simulation.evaluate(0, 22_000, 'reused-trigger').state).toBe('TRIGGER_PENDING');
    const invalidGrid = { ...controller(22_000), gridImportW: null } as unknown as ControllerStatus;
    const fault = simulation.evaluateController(20_000, success(invalidGrid), 'reused-trigger');
    expect(fault.state).toBe('FAULT');
    expect(fault.action).toBeNull();
    expect(fault.status.gridImportW).toBeNull();
    expect(fault.status.triggerStartedAtMs).toBeNull();
    const restarted = simulation.evaluate(25_000, 22_000, 'fresh-trigger');
    expect(restarted.state).toBe('TRIGGER_PENDING');
    expect(restarted.status.triggerStartedAtMs).toBe(25_000);
    expect(simulation.evaluate(54_999, 22_000).action).toBeNull();
    expect(simulation.evaluate(55_000, 22_000).action).toMatchObject({
      type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 13,
    });
  });

  it.each([null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1])(
    'rejects malformed normalized gridImportW (%s) rather than assuming zero', (gridImportW) => {
      const simulation = limitedGarage();
      const invalid = { ...controller(22_000), gridImportW } as unknown as ControllerStatus;
      const result = simulation.evaluateController(34_000, success(invalid));
      expect(result.state).toBe('FAULT');
      expect(result.action).toBeNull();
      expect(result.status.gridImportW).toBeNull();
      expect(result.status.restrictions).toHaveLength(1);
    },
  );

  it('rejects contradictory signed grid power and normalized import', () => {
    const simulation = limitedGarage();
    const result = simulation.evaluateController(34_000, success({ ...controller(22_000), gridImportW: 0 }));
    expect(result.state).toBe('FAULT');
    expect(result.action).toBeNull();
  });

  it('valid controller recovery continues the active regulation phase without a new thirty-second timer', () => {
    const simulation = limitedGarage();
    simulation.evaluateController(34_000, failure('ConnectionError', 'Unavailable'));
    const result = simulation.step(38_000, 22_000);
    expect(result.state).toBe('LIMITING');
    expect(result.action).toMatchObject({ amps: 12 });
    expect(result.status.fault).toBeNull();
  });

  it('a controller fault breaks continuity of a pending thirty-second trigger', () => {
    const simulation = new SimulationHarness();
    simulation.evaluate(0, 22_000);
    expect(simulation.evaluateController(20_000, failure('ConnectionError', 'Unavailable')).state).toBe('FAULT');
    expect(simulation.evaluate(25_000, 22_000).state).toBe('TRIGGER_PENDING');
    expect(simulation.evaluate(50_000, 22_000).action).toBeNull();
    expect(simulation.evaluate(55_000, 22_000).action).toMatchObject({ amps: 13 });
  });

  it('does not speculate when the active charging current is unknown', () => {
    const simulation = new SimulationHarness(makeConfig(), [makeCharger('garage', { effectiveCurrentA: null }), idle('links')]);
    simulation.evaluate(0, 22_000);
    const result = simulation.evaluate(30_000, 22_000);
    expect(result.state).toBe('FAULT');
    expect(result.action).toBeNull();
  });

  it('does not restore an owned limit on a charger whose latest status is unavailable', () => {
    const simulation = limitedGarage();
    simulation.chargers.set('garage', failure('ConnectionError', 'Unavailable'));
    const result = simulation.evaluate(34_000, 18_000);
    expect(result.state).toBe('FAULT');
    expect(result.action).toBeNull();
    expect(result.status.restrictions).toHaveLength(1);
  });

  it('external tcl changes do not silently erase existing ownership or trigger speculative recovery', () => {
    const simulation = limitedGarage();
    simulation.patch('garage', { temporaryCurrentLimitA: 8, effectiveCurrentA: 8 });
    const result = simulation.evaluate(34_000, 18_000);
    expect(result.state).toBe('FAULT');
    expect(result.action).toBeNull();
    expect(result.status.restrictions).toMatchObject([{ chargerId: 'garage', temporaryCurrentLimitA: 13 }]);
  });

  it('an externally forced pause conflicts with a non-paused engine restriction and is not resumed automatically', () => {
    const simulation = limitedGarage();
    simulation.patch('garage', { forceState: 1, chargingAllowed: false,
      effectiveCurrentA: null, carState: mapCarState(KnownCarState.Complete) });
    const result = simulation.evaluate(34_000, 18_000);
    expect(result.state).toBe('FAULT');
    expect(result.action).toBeNull();
    expect(result.status.restrictions).toMatchObject([{ chargerId: 'garage', paused: false }]);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('invalid timestamp %s produces a safe FAULT', (timestamp) => {
    const result = new SimulationHarness().evaluate(timestamp, 18_000);
    expect(result.state).toBe('FAULT');
    expect(result.action).toBeNull();
  });

  it('out-of-order timestamps never release capacity', () => {
    const simulation = limitedGarage();
    expect(simulation.evaluate(29_000, 18_000).action).toBeNull();
  });
});

describe('LoadManager manual override and explicit session lifecycle', () => {
  it('manual override changes the visible state to OVERRIDE immediately', () => {
    const simulation = limitedGarage();
    simulation.engine.applyManualOverride();
    expect(simulation.engine.state).toBe('OVERRIDE');
    expect(simulation.engine.snapshot.overrideActive).toBe(true);
  });

  it('override clears only its owned temporary current limit', () => {
    const simulation = limitedGarage();
    simulation.engine.applyManualOverride();
    const result = simulation.step(34_000, 22_000);
    expect(result.state).toBe('OVERRIDE');
    expect(result.action).toEqual({ type: 'CLEAR_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage' });
    expect(simulation.engine.snapshot.restrictions).toHaveLength(0);
  });

  it('override first resumes an owned pause then clears its limit in a later cycle', () => {
    const simulation = pausedGarage();
    simulation.engine.applyManualOverride();
    const resumed = simulation.step(38_000, 22_000);
    expect(resumed.action).toEqual({ type: 'RESUME', chargerId: 'garage' });
    expect(simulation.status('garage').temporaryCurrentLimitA).toBe(6);
    expect(simulation.evaluate(38_000, 22_000).action).toBeNull();
    expect(simulation.step(42_000, 22_000).action).toEqual({ type: 'CLEAR_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage' });
    expect(simulation.engine.state).toBe('OVERRIDE');
  });

  it('does not renew an automatic high-grid trigger during the overridden session', () => {
    const simulation = limitedGarage();
    simulation.engine.applyManualOverride();
    simulation.step(34_000, 25_000);
    for (const timestamp of [38_000, 80_000, 120_000]) {
      const result = simulation.evaluate(timestamp, 25_000);
      expect(result.state).toBe('OVERRIDE');
      expect(result.action).toBeNull();
    }
  });

  it('explicit endSession re-enables a fresh thirty-second trigger after cleanup', () => {
    const simulation = limitedGarage();
    simulation.engine.applyManualOverride();
    simulation.step(34_000, 25_000);
    simulation.engine.endSession();
    expect(simulation.engine.snapshot.overrideActive).toBe(false);
    expect(simulation.evaluate(40_000, 25_000).state).toBe('TRIGGER_PENDING');
    expect(simulation.evaluate(69_999, 25_000).action).toBeNull();
    expect(simulation.evaluate(70_000, 25_000).action).toMatchObject({ chargerId: 'garage', amps: 13 });
  });

  it('endSession never silently discards outstanding owned restrictions', () => {
    const simulation = limitedGarage();
    simulation.engine.applyManualOverride();
    simulation.engine.endSession();
    expect(simulation.engine.snapshot.restrictions).toMatchObject([{ chargerId: 'garage', temporaryCurrentLimitA: 13 }]);
  });

  it('override respects a foreign pre-existing temporary limit', () => {
    const simulation = new SimulationHarness(makeConfig(), [makeCharger('garage', {
      effectiveCurrentA: 10, temporaryCurrentLimitA: 10,
    }), idle('links')]);
    simulation.trigger();
    simulation.engine.applyManualOverride();
    expect(simulation.step(34_000, 22_000).action).toEqual({
      type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 10,
    });
    expect(simulation.status('garage').temporaryCurrentLimitA).toBe(10);
    expect(simulation.engine.snapshot.restrictions).toHaveLength(0);
  });

  it('override does not release owned restrictions when controller measurement is missing', () => {
    const simulation = limitedGarage();
    simulation.engine.applyManualOverride();
    const result = simulation.evaluateController(34_000, failure('MissingMeasurementError', 'No grid measurement'));
    expect(result.state).toBe('FAULT');
    expect(result.action).toBeNull();
    expect(result.status.overrideActive).toBe(true);
    expect(result.status.restrictions).toHaveLength(1);
    expect(simulation.step(38_000, 22_000).action).toEqual({ type: 'CLEAR_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage' });
  });

  it('override does not resume chargers already paused outside engine ownership', () => {
    const simulation = new SimulationHarness(makeConfig(), [makeCharger('garage', {
      carState: mapCarState(KnownCarState.Complete), effectiveCurrentA: null,
      temporaryCurrentLimitA: 6, forceState: 1, chargingAllowed: false,
    }), idle('links')]);
    simulation.engine.applyManualOverride();
    const result = simulation.evaluate(0, 18_000);
    expect(result.state).toBe('OVERRIDE');
    expect(result.action).toBeNull();
    expect(result.status.restrictions).toHaveLength(0);
  });
});

describe('real Phase-1 observation replay and domain isolation', () => {
  it('22,839 W: charging Garage, idle Links and disabled Rechts produce Garage 13 A only after 30 seconds', () => {
    const simulation = new SimulationHarness(makeConfig(), [
      makeCharger('garage', { configuredCurrentA: 14, effectiveCurrentA: 14,
        temporaryCurrentLimitA: null, minimumCurrentA: 6 }),
      idle('links'),
    ]);
    for (const timestampMs of [0, 10_000, 20_000, 29_999]) {
      const result = simulation.evaluate(timestampMs, 22_839);
      expect(result.state).toBe('TRIGGER_PENDING');
      expect(result.action).toBeNull();
    }
    const result = simulation.evaluate(30_000, 22_839);
    expect(result.state).toBe('LIMITING');
    expect(result.action).toEqual({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 13 });
    expect(result.status.gridImportW).toBe(22_839);
    expect(result.status.targetGridW).toBe(18_500);
  });

  it('calculates abstract actions without calling fetch or changing configuration', () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden in engine'));
    const config = makeConfig();
    const before = structuredClone(config);
    const simulation = new SimulationHarness(config);
    simulation.trigger();
    simulation.step(34_000, 22_000);
    simulation.step(38_000, 18_000);
    simulation.engine.applyManualOverride();
    simulation.step(42_000, 18_000);
    expect(network).not.toHaveBeenCalled();
    expect(config).toEqual(before);
  });

  it('constructs an independent NORMAL engine without global state from another engine', () => {
    limitedGarage();
    const fresh = new LoadManager(makeConfig());
    expect(fresh.state).toBe('NORMAL');
    expect(fresh.snapshot.restrictions).toHaveLength(0);
    expect(fresh.snapshot.pendingAction).toBeNull();
  });

  it('returned snapshots cannot mutate the internal pending intent or ownership records', () => {
    const simulation = new SimulationHarness();
    simulation.evaluate(0, 22_000);
    const proposed = simulation.evaluate(30_000, 22_000);
    const pendingSnapshot = simulation.engine.snapshot;
    if (!pendingSnapshot.pendingAction) throw new Error('Expected pending action');
    Object.assign(pendingSnapshot.pendingAction.action, { amps: 99 });
    expect(simulation.engine.snapshot.pendingAction?.action).toMatchObject({ amps: 13 });
    simulation.apply(proposed);
    const ownedSnapshot = simulation.engine.snapshot;
    const record = ownedSnapshot.restrictions[0];
    if (!record) throw new Error('Expected restriction');
    Object.assign(record, { temporaryCurrentLimitA: 99, paused: true });
    expect(simulation.engine.snapshot.restrictions).toMatchObject([{ temporaryCurrentLimitA: 13, paused: false }]);
  });
});
