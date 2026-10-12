import { describe, expect, it } from 'vitest';
import { reconcileOwnership } from '../../../../src/goe/control/actuator-reconciler.js';
import { makeEmptyOwnership, type OwnershipState } from '../../../../src/goe/control/ownership-state.js';
import { makeObservation, makeOwnedState, testCharger } from './ownership-helpers.js';

const observed = (changes: Parameters<typeof makeObservation>[0] = {}) => makeObservation({
  tcl: 10, acu: 10, readStartedAtMs: 1_990, observedAtMs: 2_000, ...changes,
});

describe('conservative restart ownership reconciliation', () => {
  it('retains a confirmed owned limit with matching baseline, readback and current controls', () => {
    const state = makeOwnedState();
    expect(reconcileOwnership(state, observed())).toMatchObject({
      ownershipStatus: 'OWNED', pluginOwnedTcl: 10, pluginOwnedPause: false,
      conflictStatus: null, updatedAt: 2_000, baseline: state.baseline,
    });
    expect(state.updatedAt).toBe(1_000);
  });

  it('reconstructs a confirmed owned pause instead of inventing a resume', () => {
    const state = makeOwnedState({
      pluginOwnedPause: true,
      lastConfirmedWrite: { action: { type: 'PAUSE', chargerId: 'garage' }, confirmedAtMs: 1_000 },
      lastReadback: makeObservation({ tcl: 10, frc: 1, car: 4, acu: null, alw: false, readStartedAtMs: 990, observedAtMs: 1_000 }),
    });
    const result = reconcileOwnership(state, observed({ frc: 1, car: 4, acu: null, alw: false }));
    expect(result.ownershipStatus).toBe('OWNED');
    expect(result.pluginOwnedPause).toBe(true);
    expect(result.pluginOwnedTcl).toBe(10);
    expect(result.lastConfirmedWrite).toEqual(state.lastConfirmedWrite);
  });

  it('reconstructs an owned pause with no owned temporary limit', () => {
    const state = makeOwnedState({
      pluginOwnedPause: true, pluginOwnedTcl: null,
      lastConfirmedWrite: { action: { type: 'PAUSE', chargerId: 'garage' }, confirmedAtMs: 1_000 },
      lastReadback: makeObservation({ frc: 1, readStartedAtMs: 990, observedAtMs: 1_000 }),
    });
    expect(reconcileOwnership(state, observed({ tcl: null, frc: 1 }))).toMatchObject({ ownershipStatus: 'OWNED', pluginOwnedPause: true });
  });

  it('never re-pauses when a previously owned pause has been released externally', () => {
    const state = makeOwnedState({
      pluginOwnedPause: true,
      lastConfirmedWrite: { action: { type: 'PAUSE', chargerId: 'garage' }, confirmedAtMs: 1_000 },
      lastReadback: makeObservation({ tcl: 10, frc: 1, readStartedAtMs: 990, observedAtMs: 1_000 }),
    });
    const result = reconcileOwnership(state, observed({ frc: 0 }));
    expect(result).toMatchObject({ ownershipStatus: 'CONFLICT', conflictStatus: 'EXTERNAL_FRC_CHANGE' });
    expect(result.lastConfirmedWrite).toEqual(state.lastConfirmedWrite);
  });

  it.each([8, 12, null])('detects external tcl %j without rewriting or clearing it', (tcl) => {
    const result = reconcileOwnership(makeOwnedState(), observed({ tcl }));
    expect(result).toMatchObject({ ownershipStatus: 'CONFLICT', conflictStatus: 'EXTERNAL_TCL_CHANGE', pluginOwnedTcl: 10 });
    expect(result.lastObservedState?.tcl).toBe(tcl);
    expect(result.pendingWrite).toBeNull();
  });

  it('preserves an original external limit as the baseline', () => {
    const state = makeOwnedState({ baseline: makeObservation({ tcl: 12 }) });
    const result = reconcileOwnership(state, observed());
    expect(result.ownershipStatus).toBe('OWNED');
    expect(result.baseline?.tcl).toBe(12);
  });

  it('does not claim an existing foreign pause or limit in unowned state', () => {
    const state = makeEmptyOwnership(testCharger, 0);
    const result = reconcileOwnership(state, observed({ frc: 1, tcl: 8 }));
    expect(result).toMatchObject({ ownershipStatus: 'NONE', pluginOwnedTcl: null, pluginOwnedPause: false, baseline: null });
  });

  it('detects a changed user amp and never treats it as a writable field', () => {
    expect(reconcileOwnership(makeOwnedState(), observed({ amp: 12 }))).toMatchObject({ ownershipStatus: 'CONFLICT', conflictStatus: 'EXTERNAL_AMP_CHANGE' });
  });

  it.each([{ host: 'replacement.test' }, { chargerId: 'replacement' }])('does not attach controls from another charger %j', (changes) => {
    const state = makeOwnedState();
    const result = reconcileOwnership(state, observed(changes));
    expect(result).toMatchObject({ ownershipStatus: 'CONFLICT', conflictStatus: 'CHARGER_IDENTITY_CHANGED' });
    expect(result.lastObservedState).toEqual(state.lastObservedState);
  });

  it('blocks native load balancing without disabling it', () => {
    const result = reconcileOwnership(makeOwnedState(), observed({ loe: true }));
    expect(result).toMatchObject({ ownershipStatus: 'CONFLICT', conflictStatus: 'NATIVE_LOAD_BALANCING_CONFLICT' });
    expect(result.lastObservedState?.loe).toBe(true);
  });

  it('keeps unknown native load balancing unknown', () => {
    expect(reconcileOwnership(makeOwnedState(), observed({ loe: null }))).toMatchObject({ ownershipStatus: 'UNKNOWN', conflictStatus: 'NATIVE_LOAD_BALANCING_UNKNOWN' });
  });

  it.each([10, null])('never adopts a pending first write even when tcl is %j', (tcl) => {
    const state: OwnershipState = {
      ...makeEmptyOwnership(testCharger, 1_000), baseline: makeObservation(), ownershipStatus: 'RECONCILING',
      pendingWrite: {
        action: { type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 10 },
        expectedTcl: 10, expectedFrc: 0, startedAtMs: 1_000,
      },
    };
    const result = reconcileOwnership(state, observed({ tcl }));
    expect(result).toMatchObject({ ownershipStatus: 'UNKNOWN', conflictStatus: 'UNCONFIRMED_PENDING_WRITE', pluginOwnedTcl: null });
    expect(result.pendingWrite).toEqual(state.pendingWrite);
  });

  it('never interprets an unconfirmed pending resume as permission to resume again', () => {
    const state = makeOwnedState({
      pluginOwnedPause: true, ownershipStatus: 'RECONCILING',
      lastReadback: makeObservation({ tcl: 10, frc: 1, readStartedAtMs: 990, observedAtMs: 1_000 }),
      lastConfirmedWrite: { action: { type: 'PAUSE', chargerId: 'garage' }, confirmedAtMs: 1_000 },
      pendingWrite: { action: { type: 'RESUME', chargerId: 'garage' }, expectedTcl: 10, expectedFrc: 0, startedAtMs: 1_100 },
    });
    expect(reconcileOwnership(state, observed())).toMatchObject({ ownershipStatus: 'UNKNOWN', conflictStatus: 'UNCONFIRMED_PENDING_WRITE' });
  });

  it('keeps a previous conflict sticky even after controls again match', () => {
    const state = makeOwnedState({ ownershipStatus: 'CONFLICT', conflictStatus: 'EXTERNAL_TCL_CHANGE' });
    expect(reconcileOwnership(state, observed())).toMatchObject({ ownershipStatus: 'CONFLICT', conflictStatus: 'EXTERNAL_TCL_CHANGE' });
  });

  it('keeps previous uncertainty sticky instead of adopting matching controls', () => {
    const state = makeOwnedState({ ownershipStatus: 'UNKNOWN', conflictStatus: 'OWNERSHIP_EVIDENCE_INCOMPLETE' });
    expect(reconcileOwnership(state, observed())).toMatchObject({ ownershipStatus: 'UNKNOWN', conflictStatus: 'OWNERSHIP_EVIDENCE_INCOMPLETE' });
  });

  it('recovers from unreachable startup only when no write or ownership history exists', () => {
    const state = { ...makeEmptyOwnership(testCharger, 1_000),
      ownershipStatus: 'UNKNOWN' as const, conflictStatus: 'CHARGER_STATUS_UNAVAILABLE' };
    const result = reconcileOwnership(state, observed());
    expect(result).toMatchObject({ ownershipStatus: 'NONE', conflictStatus: null,
      pluginOwnedTcl: null, pluginOwnedPause: false, baseline: null,
      lastConfirmedWrite: null, lastReadback: null, pendingWrite: null });
  });

  it('does not adopt existing tcl/frc while reopening an empty ownership history', () => {
    const state = { ...makeEmptyOwnership(testCharger, 1_000),
      ownershipStatus: 'UNKNOWN' as const, conflictStatus: 'CHARGER_STATUS_UNAVAILABLE' };
    const result = reconcileOwnership(state, observed({ tcl: 8, frc: 1, car: 4, acu: null, alw: false }));
    expect(result).toMatchObject({ ownershipStatus: 'NONE', pluginOwnedTcl: null, pluginOwnedPause: false, baseline: null });
    expect(result.lastObservedState).toMatchObject({ tcl: 8, frc: 1 });
  });

  it.each([true, null])('requires known disabled native load balancing before empty-history recovery: %j', (loe) => {
    const state = { ...makeEmptyOwnership(testCharger, 1_000),
      ownershipStatus: 'UNKNOWN' as const, conflictStatus: 'CHARGER_STATUS_UNAVAILABLE' };
    expect(reconcileOwnership(state, observed({ loe })).ownershipStatus).toBe(loe === true ? 'CONFLICT' : 'UNKNOWN');
  });

  it('does not recover empty ownership from a read begun before the last uncertainty', () => {
    const state = { ...makeEmptyOwnership(testCharger, 1_000),
      ownershipStatus: 'UNKNOWN' as const, conflictStatus: 'CHARGER_STATUS_UNAVAILABLE' };
    expect(reconcileOwnership(state, observed({ readStartedAtMs: 999, observedAtMs: 1_000 }))).toMatchObject({ ownershipStatus: 'UNKNOWN', conflictStatus: 'CHARGER_STATUS_UNAVAILABLE' });
  });

  it.each([
    { baseline: makeObservation() },
    { lastReadback: makeObservation() },
    { lastConfirmedWrite: { action: { type: 'CLEAR_TEMPORARY_CURRENT_LIMIT' as const, chargerId: 'garage' }, confirmedAtMs: 1_000 } },
  ])('does not recover UNKNOWN with any historical write evidence %j', (history) => {
    const state = { ...makeEmptyOwnership(testCharger, 1_000), ...history,
      ownershipStatus: 'UNKNOWN' as const, conflictStatus: 'CHARGER_STATUS_UNAVAILABLE' };
    expect(reconcileOwnership(state, observed())).toMatchObject({ ownershipStatus: 'UNKNOWN', pluginOwnedTcl: null, pluginOwnedPause: false });
  });

  it('requires a confirmed readback rather than relying on last observed values', () => {
    const state = makeOwnedState({ ownershipStatus: 'RECONCILING', lastReadback: null });
    expect(reconcileOwnership(state, observed())).toMatchObject({ ownershipStatus: 'UNKNOWN', conflictStatus: 'OWNERSHIP_EVIDENCE_INCOMPLETE' });
  });

  it('does not accept readback older than the confirmed write', () => {
    const state = makeOwnedState({ lastReadback: makeObservation({ tcl: 10, observedAtMs: 999 }) });
    expect(reconcileOwnership(state, observed())).toMatchObject({ ownershipStatus: 'UNKNOWN', conflictStatus: 'OWNERSHIP_EVIDENCE_INCOMPLETE' });
  });

  it.each([
    { lastReadback: makeObservation({ tcl: 10, observedAtMs: 1_000, loe: null }) },
    { lastReadback: makeObservation({ tcl: 10, observedAtMs: 1_000, loe: true }) },
    { lastReadback: makeObservation({ tcl: 10, observedAtMs: 1_000, amp: 12 }) },
    { baseline: makeObservation({ loe: true }) },
    { baseline: makeObservation({ loe: null }) },
    { baseline: makeObservation({ observedAtMs: 1_500 }) },
  ])('rejects incomplete or contradictory historical observation evidence %j', (changes) => {
    expect(reconcileOwnership(makeOwnedState(changes), observed())).toMatchObject({ ownershipStatus: 'UNKNOWN', conflictStatus: 'OWNERSHIP_EVIDENCE_INCOMPLETE' });
  });

  it('does not trust historical write/readback timestamps in the future', () => {
    const state = makeOwnedState({
      lastConfirmedWrite: { action: { type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 10 }, confirmedAtMs: 3_000 },
      lastReadback: makeObservation({ tcl: 10, readStartedAtMs: 2_990, observedAtMs: 3_000 }),
    });
    expect(reconcileOwnership(state, observed())).toMatchObject({ ownershipStatus: 'UNKNOWN', conflictStatus: 'OWNERSHIP_EVIDENCE_INCOMPLETE' });
  });

  it('rejects a contradictory confirmed action rather than inferring ownership', () => {
    const state = makeOwnedState({ lastConfirmedWrite: { action: { type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 12 }, confirmedAtMs: 1_000 } });
    expect(reconcileOwnership(state, observed())).toMatchObject({ ownershipStatus: 'UNKNOWN', conflictStatus: 'OWNERSHIP_EVIDENCE_INCONSISTENT' });
  });

  it('does not invent a session end from car=4', () => {
    expect(reconcileOwnership(makeOwnedState(), observed({ car: 4 }))).toMatchObject({ ownershipStatus: 'OWNED', pluginOwnedTcl: 10 });
  });

  it('does not infer a fault-free control value from an invalid observation', () => {
    const input = { ...observed(), tcl: Number.NaN };
    expect(reconcileOwnership(makeOwnedState(), input)).toMatchObject({ ownershipStatus: 'UNKNOWN', conflictStatus: 'INVALID_CONTROL_OBSERVATION' });
  });

  it('treats invalid persisted data conservatively', () => {
    const state = makeOwnedState({ baseline: null });
    expect(reconcileOwnership(state, observed())).toMatchObject({ ownershipStatus: 'UNKNOWN', conflictStatus: 'INVALID_PERSISTED_OWNERSHIP' });
  });

  it('drops structural extra fields from valid persisted/current state', () => {
    const state = { ...makeOwnedState(), authToken: 'private-token' };
    const current = { ...observed(), rawPayload: 'private-payload' };
    expect(JSON.stringify(reconcileOwnership(state, current))).not.toMatch(/private|authToken|rawPayload/u);
  });
});
