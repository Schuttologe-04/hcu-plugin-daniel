import { describe, expect, it } from 'vitest';
import { canRebindOwnership, makeEmptyOwnership, type OwnershipState } from '../../../../src/goe/control/ownership-state.js';
import { makeObservation, makeOwnedState, testCharger } from './ownership-helpers.js';
import type { ControlAction } from '../../../../src/load-management/control-action.js';

function unreachable(patch: Partial<OwnershipState> = {}): OwnershipState {
  return { ...makeEmptyOwnership(testCharger, 1_000), ownershipStatus: 'UNKNOWN',
    conflictStatus: 'CHARGER_STATUS_UNAVAILABLE', ...patch };
}

function released(action: ControlAction = { type: 'CLEAR_TEMPORARY_CURRENT_LIMIT', chargerId: testCharger.id },
  tcl: number | null = null, frc = 0): OwnershipState {
  const observed = makeObservation({ tcl, frc, readStartedAtMs: 990, observedAtMs: 1_000 });
  return { ...makeEmptyOwnership(testCharger, 1_000), lastReadback: observed, lastObservedState: observed,
    lastConfirmedWrite: { action, confirmedAtMs: 1_000 } };
}

describe('conservative ownership rebinding policy', () => {
  it('permits a validated empty NONE record without modifying it', () => {
    const state = makeEmptyOwnership(testCharger, 1_000);
    const before = structuredClone(state);
    expect(canRebindOwnership(state)).toBe(true);
    expect(state).toEqual(before);
  });

  it('preserves the existing NONE permission after a fully confirmed release', () => {
    expect(canRebindOwnership(released())).toBe(true);
  });

  it('retains confirmed numeric foreign-baseline restoration via SET or CLEAR', () => {
    expect(canRebindOwnership(released({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: testCharger.id, amps: 12 }, 12))).toBe(true);
    // Existing CLEAR also uses the setter when a foreign numeric baseline existed.
    expect(canRebindOwnership(released({ type: 'CLEAR_TEMPORARY_CURRENT_LIMIT', chargerId: testCharger.id }, 12))).toBe(true);
  });

  it('retains a fully confirmed RESUME release with the original foreign limit', () => {
    expect(canRebindOwnership(released({ type: 'RESUME', chargerId: testCharger.id }, 8))).toBe(true);
  });

  it.each([
    { lastConfirmedWrite: null }, { lastReadback: null }, { lastObservedState: null },
    { lastConfirmedWrite: { action: { type: 'PAUSE' as const, chargerId: testCharger.id }, confirmedAtMs: 1_000 } },
    { lastConfirmedWrite: { action: { type: 'SET_TEMPORARY_CURRENT_LIMIT' as const, chargerId: testCharger.id, amps: 12 }, confirmedAtMs: 1_000 } },
    { lastConfirmedWrite: { action: { type: 'RESUME' as const, chargerId: testCharger.id }, confirmedAtMs: 1_000 },
      lastReadback: makeObservation({ frc: 1, readStartedAtMs: 990, observedAtMs: 1_000 }),
      lastObservedState: makeObservation({ frc: 1, readStartedAtMs: 990, observedAtMs: 1_000 }) },
    { lastConfirmedWrite: { action: { type: 'CLEAR_TEMPORARY_CURRENT_LIMIT' as const, chargerId: testCharger.id }, confirmedAtMs: 999 } },
    { lastObservedState: makeObservation({ readStartedAtMs: 980, observedAtMs: 1_000 }) },
    { lastObservedState: makeObservation({ readStartedAtMs: 980, observedAtMs: 999 }) },
    { updatedAt: 999 },
    { lastObservedState: makeObservation({ tcl: 8, readStartedAtMs: 990, observedAtMs: 1_000 }) },
    { lastObservedState: makeObservation({ frc: 1, readStartedAtMs: 990, observedAtMs: 1_000 }) },
    { lastObservedState: makeObservation({ loe: true, readStartedAtMs: 990, observedAtMs: 1_000 }) },
    { lastReadback: makeObservation({ loe: true, readStartedAtMs: 990, observedAtMs: 1_000 }) },
  ])('rejects contradictory or orphaned NONE release history %j', (patch) => {
    expect(canRebindOwnership({ ...released(), ...patch })).toBe(false);
  });

  it('permits only the never-controlled unavailable UNKNOWN exception', () => {
    const state = unreachable();
    const before = structuredClone(state);
    expect(canRebindOwnership(state)).toBe(true);
    expect(state).toEqual(before);
  });

  it('allows an earlier validated observation with no limit, pause or native load balancing', () => {
    expect(canRebindOwnership(unreachable({ lastObservedState: makeObservation() }))).toBe(true);
  });

  it('rejects UNKNOWN when its last observation is newer than the state timestamp', () => {
    expect(canRebindOwnership(unreachable({ updatedAt: 999,
      lastObservedState: makeObservation({ readStartedAtMs: 990, observedAtMs: 1_000 }) }))).toBe(false);
  });

  it.each(['OWNED', 'CONFLICT', 'RECONCILING'] as const)('never rebinds status %s', (ownershipStatus) => {
    const state = ownershipStatus === 'OWNED' ? makeOwnedState()
      : unreachable({ ownershipStatus, conflictStatus: ownershipStatus === 'CONFLICT' ? 'EXTERNAL_TCL_CHANGE' : null });
    expect(canRebindOwnership(state)).toBe(false);
  });

  it.each([null, 'NATIVE_LOAD_BALANCING_UNKNOWN', 'WRITE_OUTCOME_UNKNOWN', 'READBACK_MISMATCH',
    'UNCONFIRMED_PENDING_WRITE', 'INVALID_PERSISTED_OWNERSHIP', 'EXTERNAL_AMP_CHANGE', 'FUTURE_UNKNOWN_REASON'])
  ('blocks UNKNOWN reason %s even with no claimed limit', (conflictStatus) => {
    expect(canRebindOwnership(unreachable({ conflictStatus }))).toBe(false);
  });

  it.each([
    { baseline: makeObservation() },
    { lastConfirmedWrite: { action: { type: 'CLEAR_TEMPORARY_CURRENT_LIMIT' as const, chargerId: testCharger.id }, confirmedAtMs: 1_000 } },
    { lastReadback: makeObservation() },
    { pluginOwnedTcl: 6 },
    { pluginOwnedPause: true },
    { baseline: makeObservation(), pendingWrite: {
      action: { type: 'SET_TEMPORARY_CURRENT_LIMIT' as const, chargerId: testCharger.id, amps: 6 },
      expectedTcl: 6, expectedFrc: 0, startedAtMs: 1_000,
    } },
  ])('rejects UNKNOWN with any ownership/write evidence %j', (patch) => {
    expect(canRebindOwnership(unreachable(patch))).toBe(false);
  });

  it.each([{ tcl: 6 }, { frc: 1 }, { frc: 2 }, { loe: true }, { loe: null }])
  ('preserves suspicious last observed controls %j', (patch) => {
    expect(canRebindOwnership(unreachable({ lastObservedState: makeObservation(patch) }))).toBe(false);
  });

  it.each([
    null, {}, { ...unreachable(), updatedAt: Number.NaN },
    { ...unreachable(), baseline: undefined }, { ...unreachable(), pluginOwnedPause: 'false' },
    { ...unreachable(), lastObservedState: { ...makeObservation(), host: 'another.test' } },
    { ...unreachable(), lastObservedState: { ...makeObservation(), loe: 'false' } },
  ])('validates the complete record before granting a rebind (%j)', (state) => {
    expect(canRebindOwnership(state as unknown as OwnershipState)).toBe(false);
  });

  it('does not trust a NONE label when evidence or a conflict remains', () => {
    expect(canRebindOwnership(makeOwnedState({ ownershipStatus: 'NONE' }))).toBe(false);
    expect(canRebindOwnership({ ...makeEmptyOwnership(testCharger, 1_000), baseline: makeObservation() })).toBe(false);
    expect(canRebindOwnership({ ...makeEmptyOwnership(testCharger, 1_000), conflictStatus: 'EXTERNAL_TCL_CHANGE' })).toBe(false);
  });
});
