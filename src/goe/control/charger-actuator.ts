import type { Logger } from 'pino';
import type { ChargerConfig } from '../../config/config-types.js';
import { isActivelyCharging, mapCarState } from '../../domain/charger.js';
import { failure, success, type Result } from '../../domain/errors.js';
import type { ControlAction } from '../../load-management/control-action.js';
import { isValidDeviceHost } from '../device-host.js';
import { reconcileOwnership } from './actuator-reconciler.js';
import { resolveActuatorPolicy, type ActuatorContext, type ActuatorPolicy } from './actuator-policy.js';
import type { ActuatorResult, ActuatorStatus } from './actuator-result.js';
import type { ChargerControlClient, ControlObservation, WriteGate } from './control-types.js';
import { canRebindOwnership, makeEmptyOwnership, validateOwnershipDocument, type OwnershipState, type OwnershipStore } from './ownership-state.js';

export interface ChargerActuatorOptions {
  readonly client: ChargerControlClient;
  readonly store: OwnershipStore;
  readonly gate: WriteGate;
  readonly now: () => number;
  readonly policy?: Partial<ActuatorPolicy>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly logger?: Pick<Logger, 'info' | 'warn' | 'error'>;
  /** Installed profile must possess a verified rollback before claiming a new null baseline. */
  readonly requireVerifiedClearForNewOwnership?: boolean;
}

interface ReadResult {
  readonly result: Result<ControlObservation>;
  readonly attempts: number;
}

interface Target {
  readonly tcl: number | null;
  readonly frc: number;
}

/** Status-read freshness may advance before a cancelled, never-sent action. */
function ownershipEvidence(state: OwnershipState): string {
  return JSON.stringify({ ...state, updatedAt: 0,
    lastObservedState: state.lastObservedState === null ? null : {
      ...state.lastObservedState, readStartedAtMs: 0, observedAtMs: 0,
    } });
}

/** The only orchestrator permitted to use the four typed device operations.
 * Persisted intent precedes every write; ownership follows verified readback.
 */
export class ChargerActuator {
  readonly #client: ChargerControlClient;
  readonly #store: OwnershipStore;
  readonly #gate: WriteGate;
  readonly #now: () => number;
  readonly #policy: ActuatorPolicy;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #logger: ChargerActuatorOptions['logger'];
  readonly #requireVerifiedClear: boolean;
  readonly #states = new Map<string, OwnershipState>();
  readonly #lastTclConfirmation = new Map<string, number>();
  #queue: Promise<void> = Promise.resolve();
  #initialized = false;
  #stopped = false;
  #operationGeneration = 0;
  #lastResult: ActuatorResult | null = null;

  constructor(options: ChargerActuatorOptions) {
    this.#client = options.client;
    this.#store = options.store;
    this.#gate = Object.freeze({ ...options.gate });
    this.#now = options.now;
    this.#policy = resolveActuatorPolicy(options.policy);
    this.#sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.#logger = options.logger;
    this.#requireVerifiedClear = options.requireVerifiedClearForNewOwnership === true;
  }

  get states(): readonly OwnershipState[] { return structuredClone([...this.#states.values()]); }
  get lastResult(): ActuatorResult | null { return structuredClone(this.#lastResult); }

  initialize(chargers: readonly ChargerConfig[]): Promise<Result<void>> {
    return this.#serialize(async () => {
      if (this.#stopped) return failure('ConfigurationError', 'A stopped actuator cannot be reinitialized.');
      this.#initialized = false;
      const states = new Map<string, OwnershipState>();
      const lastTclConfirmation = new Map<string, number>();
      let loaded;
      try { loaded = await this.#store.load(); }
      catch { return failure('ConfigurationError', 'Actuator ownership state could not be loaded.'); }
      if (!loaded.ok) return failure('ConfigurationError', 'Actuator ownership state could not be loaded.');
      if (loaded.value !== null) {
        const parsed = validateOwnershipDocument(loaded.value);
        if (!parsed.ok) return failure('ConfigurationError', 'Actuator ownership state is invalid.');
        for (const state of parsed.value.chargers) states.set(state.chargerId, state);
      }
      // A failed evidence commit must not be forgotten by reloading an older
      // document. Never overwrite divergent disk evidence with an in-memory repair.
      for (const current of this.#states.values()) {
        if (canRebindOwnership(current)) continue;
        const validated = validateOwnershipDocument({ version: 1, chargers: [current] });
        const saved = states.get(current.chargerId);
        const validatedCurrent = validated.ok ? validated.value.chargers[0] : undefined;
        if (validatedCurrent === undefined || saved === undefined
          || ownershipEvidence(validatedCurrent) !== ownershipEvidence(saved)) {
          return failure('ConfigurationError', 'Persisted actuator ownership differs from protected runtime evidence.');
        }
      }
      // Reject every unsafe rebind before reading or committing any new target.
      for (const config of chargers) {
        if (!config.enabled) continue;
        if (!isValidDeviceHost(config.host)) return failure('ConfigurationError', 'Actuator charger host is invalid.');
        const saved = states.get(config.id);
        if (saved !== undefined && saved.host !== config.host && !canRebindOwnership(saved)) {
          return failure('ConfigurationError', 'Outstanding ownership prevents changing device bindings.');
        }
      }
      // Retain removed/disabled records: their restrictions must never be forgotten.
      for (const config of chargers) {
        if (!config.enabled) continue;
        const saved = states.get(config.id);
        // A user may rebind an unowned charger. Never transplant ownership to a new host.
        const previous = saved === undefined || (saved.host !== config.host && canRebindOwnership(saved))
          ? makeEmptyOwnership(config, this.#now()) : saved;
        const read = await this.#read(config);
        // A later outage must not disguise a conflict as a harmless initial outage.
        const newlyUnavailable = previous.conflictStatus === null
          && (previous.ownershipStatus === 'NONE' || previous.ownershipStatus === 'OWNED');
        const state = read.result.ok && this.#fresh(read.result.value, config)
          ? reconcileOwnership(previous, read.result.value)
          : { ...previous, ...(newlyUnavailable ? {
            ownershipStatus: 'UNKNOWN' as const, conflictStatus: 'CHARGER_STATUS_UNAVAILABLE',
          } : {}), updatedAt: this.#now() };
        states.set(config.id, state);
        if (state.pluginOwnedTcl !== null && state.lastReadback !== null) {
          lastTclConfirmation.set(config.id, state.lastReadback.observedAtMs);
        }
      }
      if (!await this.#save([...states.values()])) return failure('ConfigurationError', 'Actuator ownership state could not be persisted.');
      if (this.#stopped) return failure('ConfigurationError', 'Actuator stopped during ownership initialization.');
      this.#states.clear();
      this.#lastTclConfirmation.clear();
      for (const [id, state] of states) this.#states.set(id, state);
      for (const [id, confirmedAt] of lastTclConfirmation) this.#lastTclConfirmation.set(id, confirmedAt);
      this.#initialized = true;
      return success(undefined);
    });
  }

  execute(action: ControlAction, config: ChargerConfig, context: ActuatorContext): Promise<ActuatorResult> {
    const safeAction = copyAction(action);
    const safeConfig = { ...config };
    const safeContext = { ...context };
    const generation = this.#operationGeneration;
    return this.#serialize(() => this.#execute(safeAction, safeConfig, safeContext, false, generation));
  }

  /** Cancel queued/preparing writes when consent or session state changes.
   * A write already sent is still read back and persisted conservatively.
   */
  cancelPendingOperations(): void { this.#operationGeneration += 1; }

  /** Explicitly invoked maintenance; no background timer or unattended LIVE loop. */
  refresh(chargers: readonly ChargerConfig[], context: ActuatorContext): Promise<readonly ActuatorResult[]> {
    const safeConfigs = chargers.map(config => ({ ...config }));
    const safeContext = { ...context };
    const generation = this.#operationGeneration;
    return this.#serialize(async () => {
      if (this.#blocked(safeContext) !== null || safeContext.overrideActive) return [];
      const results: ActuatorResult[] = [];
      for (const config of safeConfigs) {
        const state = this.#states.get(config.id);
        if (!config.enabled || state?.ownershipStatus !== 'OWNED' || state.pluginOwnedTcl === null || state.conflictStatus !== null) continue;
        const confirmedAt = this.#lastTclConfirmation.get(config.id) ?? state.lastReadback?.observedAtMs;
        if (confirmedAt === undefined || this.#now() - confirmedAt < this.#policy.tclRefreshMs) continue;
        results.push(await this.#execute({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: config.id, amps: state.pluginOwnedTcl }, config, safeContext, true, generation));
      }
      return results;
    });
  }

  shutdown(): Promise<Result<void>> {
    // Cancel queued work immediately. Already transmitted writes still complete readback.
    this.#stopped = true;
    this.cancelPendingOperations();
    return this.#serialize(async () => {
      // Failed startup must not overwrite a corrupt/unknown persisted record.
      if (!this.#initialized) return success(undefined);
      return await this.#persist() ? success(undefined)
        : failure('ConfigurationError', 'Actuator ownership state could not be persisted at shutdown.');
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  #blocked(context: ActuatorContext): string | null {
    if (this.#gate.executionMode !== 'LIVE' || this.#gate.realWritesEnabled !== true) return 'WRITE_BLOCKED';
    if (!this.#initialized) return 'ACTUATOR_NOT_INITIALIZED';
    if (this.#stopped) return 'ACTUATOR_STOPPED';
    if (context.loadManagementEnabled !== true) return 'LOAD_MANAGEMENT_DISABLED';
    if (context.telemetryHealthy !== true) return 'GRID_TELEMETRY_FAULT';
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0 || context.telemetrySampledAtMs === null ||
        !Number.isSafeInteger(context.telemetrySampledAtMs) || context.telemetrySampledAtMs < 0 ||
        context.telemetrySampledAtMs > now || now - context.telemetrySampledAtMs > this.#policy.maxStatusAgeMs) return 'GRID_TELEMETRY_STALE';
    return null;
  }

  async #execute(action: ControlAction, config: ChargerConfig, context: ActuatorContext, refresh: boolean, generation: number): Promise<ActuatorResult> {
    let readAttempts = 0;
    const report = (status: ActuatorStatus, code: string, writeAttempted = false, confirmedAtMs?: number): ActuatorResult => {
      const result: ActuatorResult = {
        status, code, message: safeMessage(code), action, chargerId: action.chargerId,
        writeAttempted, attempts: writeAttempted ? 1 : 0, readAttempts,
        ...(confirmedAtMs === undefined ? {} : { confirmedAtMs }),
      };
      this.#lastResult = result;
      this.#logger?.[status === 'CONFIRMED' ? 'info' : 'warn']({
        chargerId: action.chargerId, action: action.type, result: status, code,
        ownership: this.#states.get(action.chargerId)?.ownershipStatus,
        retryCount: Math.max(0, readAttempts - (writeAttempted ? 2 : 1)),
      }, 'Charger actuator result');
      return structuredClone(result);
    };
    let blocked = this.#blocked(context);
    if (blocked !== null) return report('BLOCKED', blocked);
    if (generation !== this.#operationGeneration) return report('BLOCKED', 'OPERATION_CANCELLED');
    if (!config.enabled) return report('BLOCKED', 'CHARGER_DISABLED');
    if (action.chargerId !== config.id || !isValidDeviceHost(config.host)) return report('BLOCKED', 'CHARGER_IDENTITY_MISMATCH');
    let state = this.#states.get(config.id);
    if (state === undefined || state.host !== config.host) return report('BLOCKED', 'CHARGER_NOT_RECONCILED');
    const read = await this.#read(config);
    readAttempts += read.attempts;
    if (!read.result.ok) {
      await this.#uncertain(state, 'CHARGER_UNREACHABLE');
      return report('UNREACHABLE', 'CHARGER_UNREACHABLE');
    }
    const observed = read.result.value;
    if (!this.#fresh(observed, config)) {
      await this.#uncertain(state, 'STALE_OR_INVALID_CHARGER_STATUS');
      return report('BLOCKED', 'STALE_OR_INVALID_CHARGER_STATUS');
    }
    state = reconcileOwnership(state, observed);
    this.#states.set(config.id, state);
    if (state.ownershipStatus === 'CONFLICT') {
      await this.#persist();
      return report('CONFLICT', state.conflictStatus ?? 'OWNERSHIP_CONFLICT');
    }
    if (state.ownershipStatus !== 'NONE' && state.ownershipStatus !== 'OWNED') {
      await this.#persist();
      return report('BLOCKED', state.conflictStatus ?? 'OWNERSHIP_UNKNOWN');
    }
    const target = this.#target(action, state, observed, context, refresh);
    if (typeof target === 'string') return report('BLOCKED', target);
    blocked = this.#blocked(context);
    if (blocked !== null) return report('BLOCKED', blocked);
    if (generation !== this.#operationGeneration) return report('BLOCKED', 'OPERATION_CANCELLED');
    const pending: OwnershipState = {
      ...state, baseline: state.ownershipStatus === 'NONE' ? observed : state.baseline,
      ownershipStatus: 'RECONCILING', conflictStatus: null, updatedAt: this.#now(),
      pendingWrite: { action, expectedTcl: target.tcl, expectedFrc: target.frc, startedAtMs: this.#now() },
    };
    if (!await this.#persistReplacement(pending)) return report('BLOCKED', 'OWNERSHIP_PERSIST_FAILED');
    this.#states.set(config.id, pending);
    // Persistence may take time; validate freshness and shutdown again immediately before sending.
    blocked = this.#blocked(context);
    if (blocked !== null || generation !== this.#operationGeneration || !this.#fresh(observed, config)) {
      await this.#restoreUnsent(state);
      return report('BLOCKED', blocked ?? (generation !== this.#operationGeneration ? 'OPERATION_CANCELLED' : 'STALE_OR_INVALID_CHARGER_STATUS'));
    }
    let written: Result<void>;
    let latestClearObservation: ControlObservation | null = null;
    try { written = await this.#write(action, config, target, (current) => {
      const unsafe = this.#blocked(context);
      if (unsafe !== null) return failure('ConfigurationError', `WRITE_BLOCKED: ${unsafe}.`);
      if (generation !== this.#operationGeneration) return failure('ConfigurationError', 'WRITE_BLOCKED: OPERATION_CANCELLED.');
      if (!this.#fresh(observed, config)) return failure('ConfigurationError', 'WRITE_BLOCKED: STALE_OR_INVALID_CHARGER_STATUS.');
      if (current !== undefined) {
        latestClearObservation = current;
        if (!this.#fresh(current, config)) return failure('ConfigurationError', 'WRITE_BLOCKED: STALE_OR_INVALID_CHARGER_STATUS.');
        const reconciled = reconcileOwnership(state, current);
        if (reconciled.ownershipStatus !== 'OWNED' || reconciled.conflictStatus !== null) {
          return failure('ConfigurationError', 'WRITE_BLOCKED: OWNERSHIP_CHANGED_DURING_CLEAR_PREFLIGHT.');
        }
        if (current.tcl !== observed.tcl || current.frc !== observed.frc || current.amp !== observed.amp
          || current.loe !== false || current.mca !== observed.mca || current.ama !== observed.ama
          || current.acp !== observed.acp || current.mcpd !== observed.mcpd
          || current.firmwareVersion !== observed.firmwareVersion) {
          return failure('ConfigurationError', 'WRITE_BLOCKED: CONTROL_CHANGED_DURING_CLEAR_PREFLIGHT.');
        }
      }
      return success(undefined);
    }); }
    catch { written = failure('ConnectionError', 'Actuator write failed.'); }
    if (!written.ok) {
      // ConfigurationError is the typed client's definitive pre-send rejection.
      if (written.error.code === 'ConfigurationError') {
        await this.#restoreUnsent(latestClearObservation === null ? state : reconcileOwnership(state, latestClearObservation));
        return report('BLOCKED', 'CONTROL_OPERATION_NOT_AVAILABLE');
      }
      // A timeout or invalid acknowledgement does not prove that the device
      // rejected the write. Always attempt bounded diagnostic readback, but
      // never turn an ambiguous transport outcome into confirmed ownership.
      const diagnosticReadback = await this.#read(config);
      readAttempts += diagnosticReadback.attempts;
      const diagnosticObservation = diagnosticReadback.result.ok &&
        this.#fresh(diagnosticReadback.result.value, config) && pending.pendingWrite !== null &&
        diagnosticReadback.result.value.readStartedAtMs >= pending.pendingWrite.startedAtMs
        ? diagnosticReadback.result.value : null;
      await this.#uncertain({
        ...pending, lastReadback: diagnosticObservation,
        lastObservedState: diagnosticObservation ?? pending.lastObservedState,
      }, 'WRITE_OUTCOME_UNKNOWN');
      return report('FAILED', 'ACTUATOR_WRITE_FAILED', true);
    }
    const readback = await this.#read(config);
    readAttempts += readback.attempts;
    if (!readback.result.ok) {
      await this.#uncertain(pending, 'READBACK_UNAVAILABLE');
      return report('READBACK_FAILED', 'READBACK_UNAVAILABLE', true);
    }
    const actual = readback.result.value;
    if (!this.#fresh(actual, config) || pending.pendingWrite === null || actual.readStartedAtMs < pending.pendingWrite.startedAtMs ||
        actual.tcl !== target.tcl || actual.frc !== target.frc ||
        actual.amp !== observed.amp || actual.loe !== false || actual.mca !== observed.mca ||
        actual.ama !== observed.ama || actual.acp !== observed.acp || actual.mcpd !== observed.mcpd
        || actual.firmwareVersion !== observed.firmwareVersion) {
      await this.#uncertain({ ...pending, lastReadback: this.#fresh(actual, config) ? actual : null }, 'READBACK_MISMATCH');
      return report('READBACK_MISMATCH', 'READBACK_MISMATCH', true);
    }
    const restoringForeignBaseline = action.type === 'SET_TEMPORARY_CURRENT_LIMIT' &&
      state.pluginOwnedTcl !== null && !state.pluginOwnedPause && state.baseline?.tcl === action.amps;
    const ownedTcl = action.type === 'SET_TEMPORARY_CURRENT_LIMIT' ? restoringForeignBaseline ? null : target.tcl
      : action.type === 'CLEAR_TEMPORARY_CURRENT_LIMIT' ? null : state.pluginOwnedTcl;
    const ownedPause = action.type === 'PAUSE' ? true : action.type === 'RESUME' ? false : state.pluginOwnedPause;
    const owns = ownedTcl !== null || ownedPause;
    const confirmed: OwnershipState = {
      ...pending, baseline: owns ? pending.baseline : null,
      pluginOwnedTcl: ownedTcl, pluginOwnedPause: ownedPause,
      lastObservedState: actual, lastReadback: actual,
      lastConfirmedWrite: { action, confirmedAtMs: actual.observedAtMs },
      ownershipStatus: owns ? 'OWNED' : 'NONE', conflictStatus: null,
      updatedAt: actual.observedAtMs, pendingWrite: null,
    };
    if (!await this.#persistReplacement(confirmed)) {
      await this.#uncertain({ ...pending, lastReadback: actual }, 'CONFIRMED_WRITE_PERSIST_FAILED');
      return report('FAILED', 'CONFIRMED_WRITE_PERSIST_FAILED', true);
    }
    this.#states.set(config.id, confirmed);
    if (action.type === 'SET_TEMPORARY_CURRENT_LIMIT') this.#lastTclConfirmation.set(config.id, actual.observedAtMs);
    if (ownedTcl === null) this.#lastTclConfirmation.delete(config.id);
    return report('CONFIRMED', 'CONFIRMED', true, actual.observedAtMs);
  }

  #target(action: ControlAction, state: OwnershipState, observed: ControlObservation, context: ActuatorContext, refresh: boolean): Target | string {
    const baseline = state.baseline ?? observed;
    switch (action.type) {
      case 'SET_TEMPORARY_CURRENT_LIMIT': {
        if (this.#requireVerifiedClear && state.ownershipStatus === 'NONE' && baseline.tcl === null
          && observed.tclClearCapability !== 'VERIFIED') return 'TCL_CLEAR_FIRMWARE_NOT_VERIFIED';
        if (state.pluginOwnedPause && !refresh) return 'RESUME_REQUIRED_FIRST';
        const restoringForeignBaseline = state.ownershipStatus === 'OWNED' && state.pluginOwnedTcl !== null &&
          !state.pluginOwnedPause && baseline.tcl !== null && action.amps === baseline.tcl;
        if (context.overrideActive && !restoringForeignBaseline) return 'OVERRIDE_ACTIVE';
        if (!Number.isInteger(action.amps) || action.amps < observed.mca || action.amps > observed.amp ||
            observed.ama !== null && action.amps > observed.ama) return 'INVALID_CURRENT_LIMIT';
        if (baseline.tcl !== null && action.amps > baseline.tcl) return 'EXTERNAL_LIMIT_PRESERVED';
        if (state.pluginOwnedTcl === null && observed.tcl !== null && action.amps >= observed.tcl) return 'EXTERNAL_LIMIT_PRESERVED';
        const effective = Math.min(observed.amp, observed.acu ?? observed.amp, observed.tcl ?? observed.amp, observed.ama ?? observed.amp);
        if (action.amps > effective && !context.recoveryAllowed && !(refresh && action.amps === observed.tcl)) return 'RECOVERY_NOT_STABLE';
        if (action.amps === observed.tcl && !refresh) return 'NO_CHANGE_REQUIRED';
        return { tcl: action.amps, frc: observed.frc };
      }
      case 'PAUSE': {
        if (context.overrideActive) return 'OVERRIDE_ACTIVE';
        if (observed.frc !== 0 || state.pluginOwnedPause) return 'PAUSE_NOT_OWNABLE';
        if (!observed.acp || !isActivelyCharging({ carState: mapCarState(observed.car) })) return 'CHARGER_NOT_PAUSABLE';
        const effective = Math.min(observed.amp, observed.acu ?? observed.amp, observed.tcl ?? observed.amp);
        if (effective > observed.mca) return 'MINIMUM_CURRENT_NOT_REACHED';
        return { tcl: observed.tcl, frc: 1 };
      }
      case 'RESUME':
        if (!context.recoveryAllowed) return 'RECOVERY_NOT_STABLE';
        if (!state.pluginOwnedPause || state.ownershipStatus !== 'OWNED' || baseline.frc !== 0 || observed.frc !== 1) return 'PAUSE_NOT_OWNED';
        // The engine tracks the original pause. This additional check is conservative
        // after a restart/refresh, where the persisted last confirmation may be newer.
        if (state.lastConfirmedWrite === null || this.#now() - state.lastConfirmedWrite.confirmedAtMs < observed.mcpd) return 'MINIMUM_PAUSE_DURATION_NOT_REACHED';
        return { tcl: observed.tcl, frc: 0 };
      case 'CLEAR_TEMPORARY_CURRENT_LIMIT':
        if (!context.recoveryAllowed) return 'RECOVERY_NOT_STABLE';
        if (state.pluginOwnedTcl === null || state.ownershipStatus !== 'OWNED') return 'TEMPORARY_LIMIT_NOT_OWNED';
        if (state.pluginOwnedPause) return 'RESUME_REQUIRED_FIRST';
        return { tcl: baseline.tcl, frc: observed.frc };
      default: return 'INVALID_ACTION';
    }
  }

  #write(action: ControlAction, config: ChargerConfig, target: Target,
    beforeSend: (current?: ControlObservation) => Result<void>): Promise<Result<void>> {
    switch (action.type) {
      case 'SET_TEMPORARY_CURRENT_LIMIT': return this.#client.setTemporaryCurrentLimit(config, action.amps);
      case 'PAUSE': return this.#client.pause(config);
      case 'RESUME': return this.#client.resume(config);
      case 'CLEAR_TEMPORARY_CURRENT_LIMIT':
        return target.tcl === null ? this.#client.clearTemporaryCurrentLimit(config, beforeSend)
          : this.#client.setTemporaryCurrentLimit(config, target.tcl);
    }
  }

  async #read(config: ChargerConfig): Promise<ReadResult> {
    let last: Result<ControlObservation> = failure('ConnectionError', 'Charger status could not be read.');
    for (let attempt = 0; attempt <= this.#policy.maxRetries; attempt += 1) {
      try { last = await this.#client.readStatus(config); }
      catch { last = failure('ConnectionError', 'Charger status could not be read.'); }
      if (last.ok) return { result: success(copyObservation(last.value)), attempts: attempt + 1 };
      if (last.error.code === 'ConfigurationError' || last.error.code === 'InvalidResponseError') {
        return { result: last, attempts: attempt + 1 };
      }
      if (attempt < this.#policy.maxRetries) {
        try { await this.#sleep(this.#policy.retryDelayMs); }
        catch { return { result: failure('ConnectionError', 'Charger status retry was interrupted.'), attempts: attempt + 1 }; }
      }
    }
    return { result: last, attempts: this.#policy.maxRetries + 1 };
  }

  #fresh(observed: ControlObservation, config: ChargerConfig): boolean {
    const now = this.#now();
    if (!Number.isFinite(now) || now < 0 || !Number.isFinite(observed.readStartedAtMs) ||
        !Number.isFinite(observed.observedAtMs) || observed.readStartedAtMs < 0 ||
        observed.observedAtMs < observed.readStartedAtMs || observed.observedAtMs > now ||
        now - observed.readStartedAtMs > this.#policy.maxStatusAgeMs) return false;
    const checked = validateOwnershipDocument({ version: 1, chargers: [{
      ...makeEmptyOwnership(config, now), lastObservedState: observed,
    }] });
    return checked.ok;
  }

  async #persistReplacement(replacement: OwnershipState): Promise<boolean> {
    const states = [...this.#states.values()].map(state => state.chargerId === replacement.chargerId ? replacement : state);
    return this.#save(states);
  }

  #persist(): Promise<boolean> { return this.#save([...this.#states.values()]); }

  async #save(chargers: readonly OwnershipState[]): Promise<boolean> {
    const validated = validateOwnershipDocument({ version: 1, chargers });
    if (!validated.ok) return false;
    try { return (await this.#store.save(validated.value)).ok; }
    catch { return false; }
  }

  async #uncertain(state: OwnershipState, code: string): Promise<void> {
    this.#states.set(state.chargerId, { ...state, ownershipStatus: 'UNKNOWN', conflictStatus: code, updatedAt: this.#now() });
    await this.#persist();
  }

  async #restoreUnsent(state: OwnershipState): Promise<void> {
    if (await this.#persistReplacement(state)) this.#states.set(state.chargerId, state);
    else await this.#uncertain(this.#states.get(state.chargerId) ?? state, 'UNSENT_INTENT_PERSIST_FAILED');
  }
}

function copyAction(action: ControlAction): ControlAction {
  return action.type === 'SET_TEMPORARY_CURRENT_LIMIT'
    ? { type: action.type, chargerId: action.chargerId, amps: action.amps }
    : { type: action.type, chargerId: action.chargerId };
}

function safeMessage(code: string): string {
  return code === 'CONFIRMED' ? 'Device readback confirmed the requested control state.'
    : 'Charger action was not confirmed; inspect the actuator result code.';
}

function copyObservation(observation: ControlObservation): ControlObservation {
  return {
    chargerId: observation.chargerId, host: observation.host,
    readStartedAtMs: observation.readStartedAtMs, observedAtMs: observation.observedAtMs,
    amp: observation.amp, tcl: observation.tcl, frc: observation.frc, loe: observation.loe,
    car: observation.car, mca: observation.mca, acu: observation.acu, ama: observation.ama,
    acp: observation.acp, mcpd: observation.mcpd, alw: observation.alw,
    ...(observation.firmwareVersion === undefined ? {} : { firmwareVersion: observation.firmwareVersion }),
    ...(observation.tclClearCapability === undefined ? {} : { tclClearCapability: observation.tclClearCapability }),
  };
}
