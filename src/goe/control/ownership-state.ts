import type { ChargerConfig } from '../../config/config-types.js';
import { failure, success, type Result } from '../../domain/errors.js';
import type { ControlAction } from '../../load-management/control-action.js';
import { isValidDeviceHost } from '../device-host.js';
import type { ControlObservation } from './control-types.js';

export type OwnershipStatus = 'NONE' | 'OWNED' | 'CONFLICT' | 'UNKNOWN' | 'RECONCILING';

export interface OwnershipState {
  readonly chargerId: string;
  readonly host: string;
  readonly baseline: ControlObservation | null;
  readonly pluginOwnedTcl: number | null;
  readonly pluginOwnedPause: boolean;
  readonly lastObservedState: ControlObservation | null;
  readonly lastConfirmedWrite: { readonly action: ControlAction; readonly confirmedAtMs: number } | null;
  readonly lastReadback: ControlObservation | null;
  readonly ownershipStatus: OwnershipStatus;
  readonly conflictStatus: string | null;
  readonly updatedAt: number;
  readonly pendingWrite: {
    readonly action: ControlAction;
    readonly expectedTcl: number | null;
    readonly expectedFrc: number;
    readonly startedAtMs: number;
  } | null;
}

export interface OwnershipDocument {
  readonly version: 1;
  readonly chargers: readonly OwnershipState[];
}

export interface OwnershipStore {
  load(): Promise<Result<OwnershipDocument | null>>;
  save(document: OwnershipDocument): Promise<Result<void>>;
}

export function makeEmptyOwnership(config: ChargerConfig, now: number): OwnershipState {
  return {
    chargerId: config.id, host: config.host, baseline: null,
    pluginOwnedTcl: null, pluginOwnedPause: false,
    lastObservedState: null, lastConfirmedWrite: null, lastReadback: null,
    ownershipStatus: 'NONE', conflictStatus: null, updatedAt: now, pendingWrite: null,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function time(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function current(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function nullableCurrent(value: unknown): value is number | null {
  return value === null || current(value);
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Project only known validated fields; credentials and raw payloads are never retained. */
function observation(input: unknown, chargerId: string, host: string): ControlObservation | null | undefined {
  if (input === null) return null;
  if (!record(input) || input.chargerId !== chargerId || input.host !== host ||
      !time(input.readStartedAtMs) || !time(input.observedAtMs) || input.readStartedAtMs > input.observedAtMs ||
      !current(input.amp) || !nullableCurrent(input.tcl) ||
      !nonnegativeInteger(input.frc) ||
      (input.loe !== null && typeof input.loe !== 'boolean') ||
      (input.car !== null && !nonnegativeInteger(input.car)) ||
      !current(input.mca) || (input.acu !== null && !nonnegativeInteger(input.acu)) ||
      !nullableCurrent(input.ama) || typeof input.acp !== 'boolean' ||
      !nonnegativeInteger(input.mcpd) || typeof input.alw !== 'boolean') return undefined;
  if (input.firmwareVersion !== undefined && input.firmwareVersion !== null &&
      (typeof input.firmwareVersion !== 'string' || input.firmwareVersion.length === 0 || input.firmwareVersion.length > 128)) return undefined;
  if (input.tclClearCapability !== undefined && !['VERIFIED', 'BLOCKED', 'UNKNOWN'].includes(String(input.tclClearCapability))) return undefined;
  return {
    chargerId, host, readStartedAtMs: input.readStartedAtMs, observedAtMs: input.observedAtMs,
    amp: input.amp, tcl: input.tcl, frc: input.frc, loe: input.loe, car: input.car,
    mca: input.mca, acu: input.acu, ama: input.ama, acp: input.acp, mcpd: input.mcpd, alw: input.alw,
    ...(input.firmwareVersion === undefined ? {} : { firmwareVersion: input.firmwareVersion as string | null }),
    ...(input.tclClearCapability === undefined ? {} : { tclClearCapability: input.tclClearCapability as 'VERIFIED' | 'BLOCKED' | 'UNKNOWN' }),
  };
}

function action(input: unknown, chargerId: string): ControlAction | undefined {
  if (!record(input) || input.chargerId !== chargerId) return undefined;
  switch (input.type) {
    case 'SET_TEMPORARY_CURRENT_LIMIT':
      return current(input.amps) ? { type: input.type, chargerId, amps: input.amps } : undefined;
    case 'PAUSE': case 'RESUME': case 'CLEAR_TEMPORARY_CURRENT_LIMIT':
      return { type: input.type, chargerId };
    default: return undefined;
  }
}

function state(input: unknown): OwnershipState | undefined {
  if (!record(input) || typeof input.chargerId !== 'string' || input.chargerId.length === 0 ||
      input.chargerId !== input.chargerId.trim() || typeof input.host !== 'string' ||
      !isValidDeviceHost(input.host) || !nullableCurrent(input.pluginOwnedTcl) ||
      typeof input.pluginOwnedPause !== 'boolean' || !time(input.updatedAt) ||
      (input.conflictStatus !== null && (typeof input.conflictStatus !== 'string' || !/^[A-Z][A-Z0-9_]*$/u.test(input.conflictStatus))) ||
      !['NONE', 'OWNED', 'CONFLICT', 'UNKNOWN', 'RECONCILING'].includes(String(input.ownershipStatus))) return undefined;

  const baseline = observation(input.baseline, input.chargerId, input.host);
  const lastObservedState = observation(input.lastObservedState, input.chargerId, input.host);
  const lastReadback = observation(input.lastReadback, input.chargerId, input.host);
  if (baseline === undefined || lastObservedState === undefined || lastReadback === undefined) return undefined;

  let lastConfirmedWrite: OwnershipState['lastConfirmedWrite'] = null;
  if (input.lastConfirmedWrite !== null) {
    if (!record(input.lastConfirmedWrite) || !time(input.lastConfirmedWrite.confirmedAtMs)) return undefined;
    const confirmedAction = action(input.lastConfirmedWrite.action, input.chargerId);
    if (confirmedAction === undefined) return undefined;
    lastConfirmedWrite = { action: confirmedAction, confirmedAtMs: input.lastConfirmedWrite.confirmedAtMs };
  }
  let pendingWrite: OwnershipState['pendingWrite'] = null;
  if (input.pendingWrite !== null) {
    if (!record(input.pendingWrite) || !time(input.pendingWrite.startedAtMs) ||
        !nullableCurrent(input.pendingWrite.expectedTcl) ||
        !nonnegativeInteger(input.pendingWrite.expectedFrc)) return undefined;
    const pendingAction = action(input.pendingWrite.action, input.chargerId);
    if (pendingAction === undefined) return undefined;
    // A pending write may only describe the one permitted operation being attempted.
    if (pendingAction.type === 'SET_TEMPORARY_CURRENT_LIMIT' && input.pendingWrite.expectedTcl !== pendingAction.amps ||
        pendingAction.type === 'PAUSE' && input.pendingWrite.expectedFrc !== 1 ||
        pendingAction.type === 'RESUME' && input.pendingWrite.expectedFrc !== 0) return undefined;
    pendingWrite = {
      action: pendingAction, expectedTcl: input.pendingWrite.expectedTcl,
      expectedFrc: input.pendingWrite.expectedFrc, startedAtMs: input.pendingWrite.startedAtMs,
    };
  }
  const owns = input.pluginOwnedTcl !== null || input.pluginOwnedPause;
  // In-flight or conflicting states retain their ownership history, but never invent it.
  if ((owns || pendingWrite !== null) && baseline === null ||
      owns && lastConfirmedWrite === null ||
      input.pluginOwnedPause && baseline?.frc !== 0 ||
      input.pluginOwnedTcl !== null && baseline !== null && baseline.tcl !== null && input.pluginOwnedTcl > baseline.tcl ||
      input.ownershipStatus === 'NONE' && (owns || pendingWrite !== null) ||
      input.ownershipStatus === 'OWNED' && (!owns || pendingWrite !== null || lastReadback === null) ||
      input.ownershipStatus === 'CONFLICT' && input.conflictStatus === null) return undefined;

  return {
    chargerId: input.chargerId, host: input.host, baseline,
    pluginOwnedTcl: input.pluginOwnedTcl, pluginOwnedPause: input.pluginOwnedPause,
    lastObservedState, lastConfirmedWrite, lastReadback,
    ownershipStatus: input.ownershipStatus as OwnershipStatus,
    conflictStatus: input.conflictStatus, updatedAt: input.updatedAt, pendingWrite,
  };
}

/** Corrupt or contradictory state is rejected, never silently reset to unowned. */
export function validateOwnershipDocument(input: unknown): Result<OwnershipDocument> {
  if (!record(input) || input.version !== 1 || !Array.isArray(input.chargers)) {
    return failure('ConfigurationError', 'Persisted actuator ownership state is invalid.');
  }
  const chargers: OwnershipState[] = [];
  const identifiers = new Set<string>();
  for (const entry of input.chargers) {
    const parsed = state(entry);
    if (parsed === undefined || identifiers.has(parsed.chargerId)) {
      return failure('ConfigurationError', 'Persisted actuator ownership state is invalid.');
    }
    identifiers.add(parsed.chargerId);
    chargers.push(parsed);
  }
  return success({ version: 1, chargers });
}
