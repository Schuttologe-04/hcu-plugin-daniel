import type { AppConfig, ChargerConfig } from '../config/config-types.js';
import { isActivelyCharging, type ChargerStatus } from '../domain/charger.js';
import type { ControlAction } from './control-action.js';
import type { EngineInput } from './engine-input.js';
import type { EngineDecision, EngineFault, EngineSnapshot, LoadManagementState, OwnedRestriction } from './load-manager-state.js';
import { derivePolicy, readControlCurrent, type LoadPolicy } from './policy.js';
import { PriorityScheduler } from './priority-scheduler.js';

type ControlCurrent = Extract<ReturnType<typeof readControlCurrent>, { ok: true }>['value'];
interface Candidate {
  readonly config: ChargerConfig;
  readonly status: ChargerStatus;
  readonly control: ControlCurrent;
}
interface InternalRestriction extends OwnedRestriction {
  readonly minimumPauseDurationMs: number;
  readonly awaitingResumeObservation: boolean;
}
interface PlannedAction {
  readonly id: string;
  readonly action: ControlAction;
  readonly baselineTemporaryCurrentLimitA: number | null;
  readonly minimumPauseDurationMs: number;
  readonly state: LoadManagementState;
}
interface ReleaseObservation {
  readonly temporaryCurrentLimitA: number | null;
  readonly resumed: boolean;
}

/** Deterministic domain component: no clock, timer, I/O, logging or command transport. */
export class LoadManager {
  readonly #policy: LoadPolicy;
  readonly #enabled: boolean;
  readonly #chargers: readonly ChargerConfig[];
  readonly #scheduler: PriorityScheduler;
  readonly #restrictions = new Map<string, InternalRestriction>();
  readonly #seenMeasurements = new Set<string>();
  readonly #awaitingReleaseObservation = new Map<string, ReleaseObservation>();
  #state: LoadManagementState = 'NORMAL';
  #gridImportW: number | null = null;
  #triggerStartedAtMs: number | null = null;
  #lastActionAtMs: number | null = null;
  #lastTimestampMs: number | null = null;
  #overrideActive = false;
  #regulationActive = false;
  #sessionEndRequested = false;
  #pending: PlannedAction | null = null;
  #actionSequence = 0;
  #fault: EngineFault | null = null;
  #unavailableChargerIds: string[] = [];
  #controllableChargingLoadRemaining = false;

  constructor(config: AppConfig, private readonly actionIdPrefix = '') {
    this.#policy = derivePolicy(config.loadManagement);
    this.#enabled = config.loadManagement.enabled;
    this.#chargers = config.chargers.map((charger) => ({ ...charger }));
    this.#scheduler = new PriorityScheduler(this.#chargers.map((charger) => ({ chargerId: charger.id, priority: charger.priority })));
  }

  get state(): LoadManagementState { return this.#state; }

  /** Discard an unexecuted intent before re-evaluating a newer live observation. */
  cancelPendingAction(actionId: string): boolean {
    if (this.#pending?.id !== actionId) return false;
    this.#pending = null;
    return true;
  }

  /** Explicit, already reconciled hardware evidence; never infers ownership from car state. */
  restoreConfirmedRestrictions(entries: readonly {
    readonly restriction: OwnedRestriction; readonly minimumPauseDurationMs: number;
  }[], timestampMs: number): boolean {
    if (this.#seenMeasurements.size > 0 || this.#pending !== null || this.#restrictions.size > 0
      || !Number.isSafeInteger(timestampMs) || timestampMs < 0) return false;
    const ids = new Set<string>();
    for (const { restriction, minimumPauseDurationMs } of entries) {
      if (ids.has(restriction.chargerId) || !this.#chargers.some((charger) => charger.enabled && charger.id === restriction.chargerId)
        || typeof restriction.paused !== 'boolean' || (!restriction.paused && restriction.pausedAtMs !== null)
        || !Number.isSafeInteger(minimumPauseDurationMs) || minimumPauseDurationMs < 0
        || (restriction.temporaryCurrentLimitA === null && !restriction.paused)
        || [restriction.temporaryCurrentLimitA, restriction.baselineTemporaryCurrentLimitA].some((limit) =>
          limit !== null && (!Number.isSafeInteger(limit) || limit <= 0))
        || (restriction.temporaryCurrentLimitA !== null && restriction.baselineTemporaryCurrentLimitA !== null
          && restriction.temporaryCurrentLimitA > restriction.baselineTemporaryCurrentLimitA)
        || (restriction.paused && (restriction.pausedAtMs === null || !Number.isSafeInteger(restriction.pausedAtMs)
          || restriction.pausedAtMs < 0 || restriction.pausedAtMs > timestampMs))) return false;
      ids.add(restriction.chargerId);
    }
    for (const { restriction, minimumPauseDurationMs } of entries) this.#restrictions.set(restriction.chargerId,
      { ...restriction, minimumPauseDurationMs, awaitingResumeObservation: false });
    this.#regulationActive = entries.length > 0;
    this.#state = entries.length === 0 ? 'NORMAL' : entries.every((entry) => entry.restriction.paused) ? 'PAUSED' : 'LIMITING';
    this.#lastTimestampMs = timestampMs;
    this.#lastActionAtMs = entries.length > 0 ? timestampMs : null;
    return true;
  }

  get snapshot(): EngineSnapshot {
    return {
      state: this.#state,
      gridImportW: this.#gridImportW,
      targetGridW: this.#policy.targetGridW,
      recoveryThresholdW: this.#policy.recoveryThresholdW,
      triggerStartedAtMs: this.#triggerStartedAtMs,
      lastActionAtMs: this.#lastActionAtMs,
      overrideActive: this.#overrideActive,
      pendingAction: this.#pending === null ? null : { id: this.#pending.id, action: { ...this.#pending.action } },
      restrictions: [...this.#restrictions.values()].map(({ minimumPauseDurationMs: _duration, awaitingResumeObservation: _awaiting, ...restriction }) => ({ ...restriction })),
      awaitingObservationChargerIds: [...this.#awaitingReleaseObservation.keys()],
      fault: this.#fault === null ? null : { ...this.#fault },
      unavailableChargerIds: [...this.#unavailableChargerIds],
      controllableChargingLoadRemaining: this.#controllableChargingLoadRemaining,
    };
  }

  /** Explicit simulator acknowledgement. No real command is performed here. */
  acknowledgeAction(actionId: string, outcome: 'applied' | 'failed' = 'applied'): boolean {
    const pending = this.#pending;
    if (pending === null || pending.id !== actionId) return false;
    this.#pending = null;
    if (outcome === 'failed') {
      this.#setFault({ code: 'ACTION_FAILED', message: 'The planned action was not applied.', chargerId: pending.action.chargerId });
      return true;
    }

    const action = pending.action;
    const existing = this.#restrictions.get(action.chargerId);
    const restriction: InternalRestriction = existing ?? {
      chargerId: action.chargerId,
      baselineTemporaryCurrentLimitA: pending.baselineTemporaryCurrentLimitA,
      temporaryCurrentLimitA: null,
      paused: false,
      pausedAtMs: null,
      minimumPauseDurationMs: pending.minimumPauseDurationMs,
      awaitingResumeObservation: false,
    };
    switch (action.type) {
      case 'SET_TEMPORARY_CURRENT_LIMIT':
        if (action.amps === restriction.baselineTemporaryCurrentLimitA && !restriction.paused) {
          this.#restrictions.delete(action.chargerId);
          this.#awaitingReleaseObservation.set(action.chargerId, { temporaryCurrentLimitA: action.amps, resumed: false });
        } else {
          this.#restrictions.set(action.chargerId, { ...restriction, temporaryCurrentLimitA: action.amps });
        }
        break;
      case 'PAUSE':
        this.#restrictions.set(action.chargerId, { ...restriction, paused: true, pausedAtMs: this.#lastTimestampMs,
          minimumPauseDurationMs: pending.minimumPauseDurationMs });
        break;
      case 'RESUME':
        if (restriction.temporaryCurrentLimitA === null) {
          this.#restrictions.delete(action.chargerId);
          this.#awaitingReleaseObservation.set(action.chargerId, {
            temporaryCurrentLimitA: restriction.baselineTemporaryCurrentLimitA, resumed: true,
          });
        } else {
          this.#restrictions.set(action.chargerId, { ...restriction, paused: false, pausedAtMs: null, awaitingResumeObservation: true });
        }
        break;
      case 'CLEAR_TEMPORARY_CURRENT_LIMIT':
        // Such actions are planned only if there was no foreign baseline limit.
        this.#restrictions.delete(action.chargerId);
        this.#awaitingReleaseObservation.set(action.chargerId, { temporaryCurrentLimitA: null, resumed: false });
        break;
    }
    return true;
  }

  applyManualOverride(): void {
    this.#overrideActive = true;
    this.#triggerStartedAtMs = null;
    this.#state = 'OVERRIDE';
  }

  /** Session boundaries are supplied by the future integration, never inferred from car=4. */
  endSession(): void {
    this.#overrideActive = false;
    this.#triggerStartedAtMs = null;
    this.#seenMeasurements.clear();
    this.#scheduler.reset();
    this.#fault = null;
    this.#sessionEndRequested = true;
    // Ownership survives if an explicit event arrives before cleanup is complete.
    this.#regulationActive = this.#restrictions.size > 0 || this.#pending !== null;
    this.#state = this.#regulationActive || this.#awaitingReleaseObservation.size > 0 ? 'RECOVERING' : 'NORMAL';
  }

  evaluate(input: EngineInput): EngineDecision {
    if (!Number.isSafeInteger(input.timestampMs) || input.timestampMs < 0
      || typeof input.measurementId !== 'string' || input.measurementId.length === 0
      || (this.#lastTimestampMs !== null && input.timestampMs < this.#lastTimestampMs)) {
      return this.#setFault({ code: 'INVALID_INPUT', message: 'Measurements require a unique ID and a nondecreasing, non-negative integer timestamp.' });
    }
    const repeatedMeasurement = this.#seenMeasurements.has(input.measurementId);
    this.#seenMeasurements.add(input.measurementId);
    this.#lastTimestampMs = input.timestampMs;

    const controller = input.controller;
    if (!controller.ok) {
      this.#gridImportW = null;
      return this.#setFault({ code: 'CONTROLLER_UNAVAILABLE', message: 'No valid controller measurement is available.' });
    }
    const grid = controller.value;
    if (typeof grid !== 'object' || grid === null || grid.reachable !== true
      || !Number.isFinite(grid.gridPowerW) || !Number.isFinite(grid.gridImportW)
      || grid.gridImportW < 0 || grid.gridImportW !== Math.max(grid.gridPowerW, 0)) {
      this.#gridImportW = null;
      return this.#setFault({ code: 'INVALID_GRID', message: 'Grid import must be a finite, non-negative measurement consistent with signed grid power.' });
    }
    // Deduplication cannot hide an unavailable controller or invalid Grid value.
    if (repeatedMeasurement) return this.#decision();
    this.#gridImportW = grid.gridImportW;
    this.#fault = null;

    const available = new Map<string, ChargerStatus>();
    const observations = new Map(input.chargers.map((entry) => [entry.chargerId, entry.status]));
    if (observations.size !== input.chargers.length) {
      return this.#setFault({ code: 'INVALID_INPUT', message: 'Charger observations contain duplicate IDs.' });
    }
    this.#unavailableChargerIds = [];
    for (const config of this.#chargers) {
      if (!config.enabled) continue;
      const observation = observations.get(config.id);
      if (observation === undefined || !observation.ok) {
        this.#unavailableChargerIds.push(config.id);
        continue;
      }
      const status = observation.value;
      if (typeof status !== 'object' || status === null || status.reachable !== true || status.id !== config.id) {
        return this.#setFault({ code: 'INVALID_CHARGER', message: 'Charger identity or availability contradicts its observation.', chargerId: config.id });
      }
      available.set(config.id, status);
    }

    // Wait for an explicit acknowledgement; fresh measurements cannot apply an intent implicitly.
    if (this.#pending !== null) {
      this.#state = this.#overrideActive ? 'OVERRIDE' : this.#pending.state;
      return this.#decision();
    }

    for (const [chargerId, expected] of this.#awaitingReleaseObservation) {
      const status = available.get(chargerId);
      if (status === undefined) {
        return this.#setFault({ code: 'INVALID_CHARGER', message: 'A released restriction still requires a reachable confirming observation.', chargerId });
      }
      if (status.temporaryCurrentLimitA !== expected.temporaryCurrentLimitA
        || (expected.resumed && (status.forceState !== 0 || !status.chargingAllowed || !isActivelyCharging(status)))) {
        return this.#setFault({ code: 'OWNERSHIP_CONFLICT', message: 'The released restriction has not been confirmed by a matching observation.', chargerId });
      }
      this.#awaitingReleaseObservation.delete(chargerId);
    }
    if (this.#sessionEndRequested && this.#restrictions.size === 0) {
      this.#regulationActive = false;
      this.#sessionEndRequested = false;
    }

    for (const restriction of this.#restrictions.values()) {
      const status = available.get(restriction.chargerId);
      if (status === undefined) continue;
      const expectedLimit = restriction.temporaryCurrentLimitA ?? restriction.baselineTemporaryCurrentLimitA;
      if (status.temporaryCurrentLimitA !== expectedLimit
        || (restriction.paused && (status.forceState !== 1 || status.chargingAllowed !== false || status.effectiveCurrentA !== null || isActivelyCharging(status)))
        || (!restriction.paused && status.forceState !== 0)
        || (restriction.awaitingResumeObservation && (!status.chargingAllowed || !isActivelyCharging(status)))) {
        return this.#setFault({ code: 'OWNERSHIP_CONFLICT', message: 'The observed restriction differs from the explicitly acknowledged engine action.', chargerId: restriction.chargerId });
      }
      if (restriction.awaitingResumeObservation) {
        this.#restrictions.set(restriction.chargerId, { ...restriction, awaitingResumeObservation: false });
      }
    }

    const candidates: Candidate[] = [];
    for (const config of this.#chargers) {
      const status = available.get(config.id);
      if (status === undefined || !isActivelyCharging(status) || this.#restrictions.get(config.id)?.paused) continue;
      const current = readControlCurrent(status);
      if (!current.ok || !status.chargingAllowed || status.forceState !== 0
        || typeof status.allowChargingPause !== 'boolean'
        || !Number.isSafeInteger(status.minimumChargingPauseDuration) || status.minimumChargingPauseDuration < 0) {
        return this.#setFault({ code: 'INVALID_CHARGER', message: 'An actively charging device lacks consistent data for a safe current decision.', chargerId: config.id });
      }
      candidates.push({ config, status, control: current.value });
    }
    this.#controllableChargingLoadRemaining = candidates.some((candidate) =>
      candidate.control.effectiveCurrentA > candidate.control.minimumCurrentA || candidate.status.allowChargingPause,
    );

    if (this.#overrideActive) {
      this.#state = 'OVERRIDE';
      if (!this.#intervalElapsed(input.timestampMs)) return this.#decision();
      return this.#restore(available, input.timestampMs, true);
    }
    if (!this.#enabled) {
      this.#state = this.#restrictions.size > 0 ? 'PAUSED' : 'NORMAL';
      this.#triggerStartedAtMs = null;
      return this.#decision();
    }

    if (!this.#regulationActive) {
      if (grid.gridImportW <= this.#policy.gridLimitW || !this.#controllableChargingLoadRemaining) {
        this.#state = 'NORMAL';
        this.#triggerStartedAtMs = null;
        return this.#decision();
      }
      if (this.#triggerStartedAtMs === null) this.#triggerStartedAtMs = input.timestampMs;
      if (input.timestampMs - this.#triggerStartedAtMs < this.#policy.triggerDurationMs) {
        this.#state = 'TRIGGER_PENDING';
        return this.#decision();
      }
      this.#regulationActive = true;
      this.#triggerStartedAtMs = null;
      this.#state = 'LIMITING';
    }

    // End only after a fresh, safe measurement at least one interval after the last release.
    if (this.#restrictions.size === 0 && grid.gridImportW <= this.#policy.gridLimitW && this.#intervalElapsed(input.timestampMs)) {
      this.#regulationActive = false;
      this.#state = 'NORMAL';
      return this.#decision();
    }
    if (grid.gridImportW > this.#policy.targetGridW) {
      return this.#reduce(candidates, input.timestampMs);
    }
    if (grid.gridImportW <= this.#policy.recoveryThresholdW) {
      this.#state = 'RECOVERING';
      if (!this.#intervalElapsed(input.timestampMs)) return this.#decision();
      return this.#restore(available, input.timestampMs, false);
    }
    if (this.#state === 'FAULT' || this.#state === 'NORMAL' || this.#state === 'TRIGGER_PENDING' || this.#state === 'LIMIT_UNACHIEVABLE') {
      this.#state = this.#hasPause() ? 'PAUSED' : 'LIMITING';
    }
    return this.#decision();
  }

  #reduce(candidates: readonly Candidate[], timestampMs: number): EngineDecision {
    const priorities = [...new Set(candidates.map((candidate) => candidate.config.priority))].sort((a, b) => b - a);
    for (const priority of priorities) {
      const group = candidates.filter((candidate) => candidate.config.priority === priority);
      // Within a tie group, reduce above-minimum members before considering a pause.
      const reducible = group.filter((candidate) => candidate.control.effectiveCurrentA > candidate.control.minimumCurrentA);
      const eligible = reducible.length > 0 ? reducible : group.filter((candidate) => candidate.status.allowChargingPause);
      if (eligible.length === 0) continue;
      this.#state = 'LIMITING';
      if (!this.#intervalElapsed(timestampMs)) return this.#decision();
      const chosenId = this.#scheduler.select(eligible.map((candidate) => ({ chargerId: candidate.config.id, priority })), 'reduce');
      const chosen = eligible.find((candidate) => candidate.config.id === chosenId);
      if (chosen === undefined) continue;
      if (chosen.control.effectiveCurrentA > chosen.control.minimumCurrentA) {
        return this.#emit({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: chosen.config.id,
          amps: Math.max(chosen.control.minimumCurrentA, chosen.control.effectiveCurrentA - this.#policy.ampStep) }, chosen.status, timestampMs);
      }
      // A pause must retain an explicit minimum temporary limit for controlled restart.
      if (chosen.status.temporaryCurrentLimitA !== chosen.control.minimumCurrentA) {
        return this.#emit({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: chosen.config.id, amps: chosen.control.minimumCurrentA }, chosen.status, timestampMs);
      }
      this.#state = 'PAUSED';
      return this.#emit({ type: 'PAUSE', chargerId: chosen.config.id }, chosen.status, timestampMs);
    }
    if (this.#unavailableChargerIds.some((id) => this.#restrictions.has(id))) {
      return this.#setFault({ code: 'INVALID_CHARGER', message: 'An owned restriction is unavailable and cannot be safely evaluated.' });
    }
    this.#state = 'LIMIT_UNACHIEVABLE';
    return this.#decision();
  }

  #restore(available: ReadonlyMap<string, ChargerStatus>, timestampMs: number, override: boolean): EngineDecision {
    const reachableOwners = this.#chargers.filter((config) => this.#restrictions.has(config.id) && available.has(config.id));
    const bestPriority = reachableOwners.length === 0 ? null : Math.min(...reachableOwners.map((config) => config.priority));
    const owned = reachableOwners.filter((config) => config.priority === bestPriority).filter((config) => {
      const restriction = this.#restrictions.get(config.id);
      return restriction !== undefined && (!restriction.paused || (restriction.pausedAtMs !== null
        && timestampMs - restriction.pausedAtMs >= restriction.minimumPauseDurationMs));
    });
    const chosenId = this.#scheduler.select(owned.map((config) => ({ chargerId: config.id, priority: config.priority })), 'recover');
    if (chosenId === null) {
      if (this.#restrictions.size > 0 && reachableOwners.length === 0) return this.#setFault({ code: 'INVALID_CHARGER', message: 'No reachable owner can safely restore the remaining restrictions.' });
      return this.#decision();
    }
    const restriction = this.#restrictions.get(chosenId);
    const status = available.get(chosenId);
    if (restriction === undefined || status === undefined) return this.#decision();
    if (!Number.isSafeInteger(status.configuredCurrentA) || status.configuredCurrentA <= 0
      || !Number.isSafeInteger(status.minimumCurrentA) || status.minimumCurrentA <= 0
      || (status.maximumCurrentA !== null && (!Number.isSafeInteger(status.maximumCurrentA) || status.maximumCurrentA <= 0))) {
      return this.#setFault({ code: 'INVALID_CHARGER', message: 'Safe recovery requires valid user and device current limits.', chargerId: chosenId });
    }
    if (restriction.paused) {
      if (restriction.pausedAtMs === null || timestampMs - restriction.pausedAtMs < restriction.minimumPauseDurationMs) return this.#decision();
      if (status.temporaryCurrentLimitA !== status.minimumCurrentA) {
        return this.#setFault({ code: 'OWNERSHIP_CONFLICT', message: 'Resume requires the preserved minimum temporary current limit.', chargerId: chosenId });
      }
      return this.#emit({ type: 'RESUME', chargerId: chosenId }, status, timestampMs);
    }
    const currentLimit = restriction.temporaryCurrentLimitA;
    if (currentLimit === null) return this.#decision();
    const normalCeiling = Math.min(status.configuredCurrentA, status.maximumCurrentA ?? status.configuredCurrentA,
      restriction.baselineTemporaryCurrentLimitA ?? status.configuredCurrentA);
    if (normalCeiling < status.minimumCurrentA) {
      return this.#setFault({ code: 'INVALID_CHARGER', message: 'Recovery ceiling is below the reported minimum current.', chargerId: chosenId });
    }
    if (!override && currentLimit < normalCeiling) {
      return this.#emit({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: chosenId,
        amps: Math.min(normalCeiling, currentLimit + this.#policy.ampStep) }, status, timestampMs);
    }
    if (restriction.baselineTemporaryCurrentLimitA !== null) {
      // Restore external ownership even if the user's normal amp has changed in the meantime.
      return this.#emit({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: chosenId,
        amps: restriction.baselineTemporaryCurrentLimitA }, status, timestampMs);
    }
    return this.#emit({ type: 'CLEAR_TEMPORARY_CURRENT_LIMIT', chargerId: chosenId }, status, timestampMs);
  }

  #emit(action: ControlAction, status: ChargerStatus, timestampMs: number): EngineDecision {
    const existing = this.#restrictions.get(action.chargerId);
    const id = `${this.actionIdPrefix}action-${++this.#actionSequence}`;
    this.#pending = {
      id, action,
      baselineTemporaryCurrentLimitA: existing === undefined ? status.temporaryCurrentLimitA : existing.baselineTemporaryCurrentLimitA,
      minimumPauseDurationMs: status.minimumChargingPauseDuration,
      state: this.#state,
    };
    this.#lastActionAtMs = timestampMs;
    return this.#decision(action, id);
  }

  #intervalElapsed(timestampMs: number): boolean {
    return this.#lastActionAtMs === null || timestampMs - this.#lastActionAtMs >= this.#policy.controlIntervalMs;
  }

  #hasPause(): boolean { return [...this.#restrictions.values()].some((restriction) => restriction.paused); }

  #setFault(fault: EngineFault): EngineDecision {
    this.#fault = fault;
    this.#state = 'FAULT';
    this.#triggerStartedAtMs = null;
    return this.#decision();
  }

  #decision(action: ControlAction | null = null, actionId: string | null = null): EngineDecision {
    return { state: this.#state, action: action === null ? null : { ...action }, actionId, status: this.snapshot };
  }
}
