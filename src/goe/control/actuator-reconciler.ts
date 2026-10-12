import type { ControlObservation } from './control-types.js';
import { validateOwnershipDocument, type OwnershipState } from './ownership-state.js';

/** Pure comparison only: reconciliation never adopts an uncertain write or restores a device. */
export function reconcileOwnership(state: OwnershipState, observation: ControlObservation): OwnershipState {
  const validated = validateOwnershipDocument({ version: 1, chargers: [state] });
  const previous = validated.ok ? validated.value.chargers[0] : undefined;
  const observedAt = Number.isFinite(observation.observedAtMs) && observation.observedAtMs >= 0
    ? observation.observedAtMs : state.updatedAt;
  const update = { ...state, lastObservedState: { ...observation }, updatedAt: observedAt };
  if (previous === undefined) {
    return { ...update, ownershipStatus: 'UNKNOWN', conflictStatus: 'INVALID_PERSISTED_OWNERSHIP' };
  }
  if (observation.chargerId !== previous.chargerId || observation.host !== previous.host) {
    // Do not attach another device's controls to the stored charger identity.
    return { ...previous, updatedAt: observedAt, ownershipStatus: 'CONFLICT', conflictStatus: 'CHARGER_IDENTITY_CHANGED' };
  }
  // This also validates current observations without trusting their TypeScript declaration.
  const validObservation = validateOwnershipDocument({ version: 1, chargers: [
    { ...previous, lastObservedState: observation },
  ] });
  if (!validObservation.ok) {
    return { ...previous, updatedAt: observedAt, ownershipStatus: 'UNKNOWN', conflictStatus: 'INVALID_CONTROL_OBSERVATION' };
  }
  const observed = validObservation.value.chargers[0]?.lastObservedState;
  if (observed === undefined || observed === null) {
    return { ...previous, updatedAt: observedAt, ownershipStatus: 'UNKNOWN', conflictStatus: 'INVALID_CONTROL_OBSERVATION' };
  }
  const result = { ...previous, lastObservedState: observed, updatedAt: observed.observedAtMs };
  if (observed.loe === true) {
    return { ...result, ownershipStatus: 'CONFLICT', conflictStatus: 'NATIVE_LOAD_BALANCING_CONFLICT' };
  }
  if (observed.loe === null) {
    return { ...result, ownershipStatus: 'UNKNOWN', conflictStatus: 'NATIVE_LOAD_BALANCING_UNKNOWN' };
  }
  if (previous.pendingWrite !== null) {
    return { ...result, ownershipStatus: 'UNKNOWN', conflictStatus: 'UNCONFIRMED_PENDING_WRITE' };
  }
  // A known external change is sticky until explicitly evaluated; matching again is no proof.
  if (previous.ownershipStatus === 'CONFLICT') return result;
  if (previous.ownershipStatus === 'UNKNOWN') {
    // An unreachable device before any intervention does not create ownership.
    // A new validated read may reopen baseline capture, but never adopts limits
    // or pauses visible on that device. Any persisted write evidence stays sticky.
    const emptyHistory = previous.baseline === null && previous.lastConfirmedWrite === null
      && previous.lastReadback === null && previous.pendingWrite === null
      && previous.pluginOwnedTcl === null && !previous.pluginOwnedPause;
    const newerRead = observed.readStartedAtMs >= previous.updatedAt
      && observed.observedAtMs >= previous.updatedAt;
    return emptyHistory && newerRead
      ? { ...result, ownershipStatus: 'NONE', conflictStatus: null }
      : result;
  }

  const owns = previous.pluginOwnedTcl !== null || previous.pluginOwnedPause;
  if (!owns) {
    return { ...result, ownershipStatus: 'NONE', conflictStatus: null };
  }
  const baseline = previous.baseline;
  const write = previous.lastConfirmedWrite;
  const readback = previous.lastReadback;
  if (baseline === null || write === null || readback === null ||
      baseline.observedAtMs > write.confirmedAtMs ||
      readback.observedAtMs < write.confirmedAtMs || readback.readStartedAtMs < baseline.observedAtMs ||
      observed.observedAtMs < readback.observedAtMs || observed.readStartedAtMs < readback.readStartedAtMs ||
      baseline.loe !== false || readback.loe !== false || readback.amp !== baseline.amp) {
    return { ...result, ownershipStatus: 'UNKNOWN', conflictStatus: 'OWNERSHIP_EVIDENCE_INCOMPLETE' };
  }
  const expectedTcl = previous.pluginOwnedTcl ?? baseline.tcl;
  const expectedFrc = previous.pluginOwnedPause ? 1 : baseline.frc;
  if (observed.amp !== baseline.amp) {
    return { ...result, ownershipStatus: 'CONFLICT', conflictStatus: 'EXTERNAL_AMP_CHANGE' };
  }
  if (readback.firmwareVersion !== undefined && readback.firmwareVersion !== null
    && observed.firmwareVersion !== readback.firmwareVersion) {
    return { ...result, ownershipStatus: 'CONFLICT', conflictStatus: 'FIRMWARE_PROFILE_CHANGED' };
  }
  if (observed.tcl !== expectedTcl || readback.tcl !== expectedTcl) {
    return { ...result, ownershipStatus: 'CONFLICT', conflictStatus: 'EXTERNAL_TCL_CHANGE' };
  }
  if (observed.frc !== expectedFrc || readback.frc !== expectedFrc) {
    return { ...result, ownershipStatus: 'CONFLICT', conflictStatus: 'EXTERNAL_FRC_CHANGE' };
  }
  if (write.action.type === 'SET_TEMPORARY_CURRENT_LIMIT' && write.action.amps !== previous.pluginOwnedTcl ||
      write.action.type === 'PAUSE' && !previous.pluginOwnedPause ||
      write.action.type === 'RESUME' && previous.pluginOwnedPause ||
      write.action.type === 'CLEAR_TEMPORARY_CURRENT_LIMIT' && previous.pluginOwnedTcl !== null) {
    return { ...result, ownershipStatus: 'UNKNOWN', conflictStatus: 'OWNERSHIP_EVIDENCE_INCONSISTENT' };
  }
  return { ...result, ownershipStatus: 'OWNED', conflictStatus: null };
}
