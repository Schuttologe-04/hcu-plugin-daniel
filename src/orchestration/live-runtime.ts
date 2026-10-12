import type { AppConfig, ChargerConfig } from '../config/config-types.js';
import { getNotificationSettings } from '../config/notification-settings.js';
import { probeDevices, type ProbeReport } from '../diagnostics/probe-service.js';
import type { ControllerStatus } from '../domain/controller.js';
import { failure, success, type Result } from '../domain/errors.js';
import type { IdProvider } from '../hcu/id-provider.js';
import { GoEHttpClient } from '../goe/http-client.js';
import { GoEControllerClient } from '../goe/controller-client.js';
import type { WriteGate } from '../goe/control/control-types.js';
import type { ChargerActuator } from '../goe/control/charger-actuator.js';
import type { ActuatorContext } from '../goe/control/actuator-policy.js';
import type { ActuatorResult } from '../goe/control/actuator-result.js';
import { LoadManager } from '../load-management/load-manager.js';
import type { ControlAction } from '../load-management/control-action.js';
import { ActionJournal, summarizeCharger } from './action-journal.js';
import { TelemetryHealthGuard } from './telemetry-health.js';
import { initialRuntimeSnapshot, type RuntimeSnapshot } from './runtime-snapshot.js';

export interface LiveRuntimeOptions {
  readonly config: AppConfig;
  readonly gate: WriteGate;
  readonly actuator: ChargerActuator;
  readonly now: () => number;
  readonly idProvider: IdProvider;
  readonly probe?: (config: AppConfig) => Promise<ProbeReport>;
  readonly readController?: (config: AppConfig) => Promise<Result<ControllerStatus>>;
  readonly onIntervention?: () => Promise<Result<void>>;
  readonly onEndSession?: () => Promise<void>;
  readonly onWarning?: (reason: 'FAULT' | 'LIMIT_UNACHIEVABLE') => Promise<void>;
  readonly getInteractionStatus?: () => { readonly lastMessage: string | null; readonly lastAnswer: string | null };
  /** Installed orchestration only. Remote LIVE retains its phase-4 prepared behavior. */
  readonly installed?: boolean;
  readonly requireStableTelemetryForWrites?: boolean;
}

/** Prepared live integration. No timer, implicit write, startup cleanup or automatic canary. */
export class LiveRuntime {
  #config: AppConfig;
  #manager: LoadManager;
  readonly #gate: WriteGate;
  #health = new TelemetryHealthGuard();
  #snapshot = initialRuntimeSnapshot('LIVE');
  #ready = false;
  #stopped = false;
  #busy = false;
  #announced = false;
  #shutdownError: string | null = null;
  #lastWarning: { reason: string; at: number } | null = null;
  readonly journal = new ActionJournal();

  constructor(private readonly options: LiveRuntimeOptions) {
    this.#config = structuredClone(options.config);
    this.#gate = { ...options.gate };
    this.#manager = new LoadManager(this.#config, `${this.options.idProvider.nextId()}:`);
  }

  get engine(): LoadManager { return this.#manager; }
  get telemetryMaxAgeMs(): number { return this.#health.maxAgeMs; }
  get snapshot(): RuntimeSnapshot {
    const interaction = this.options.getInteractionStatus?.();
    const health = this.#health.snapshot(this.options.now());
    const last = this.options.actuator.lastResult;
    const engine = this.#manager.snapshot;
    const visibleEngine = this.#snapshot.observedAtMs !== null && !health.healthy
      ? { ...engine, state: 'FAULT' as const, gridImportW: null,
        fault: { code: 'CONTROLLER_UNAVAILABLE' as const, message: 'Controller telemetry is unavailable or stale.' } }
      : engine;
    return structuredClone({ ...this.#snapshot, engine: visibleEngine,
      realChargerWritesEnabled: this.#gate.executionMode === 'LIVE' && this.#gate.realWritesEnabled,
      telemetryHealth: health,
      actuator: { state: this.#stopped ? 'STOPPED' : !this.#ready ? 'FAULT' : last?.status ?? 'PREPARED',
        ownership: this.options.actuator.states,
        lastResult: this.#shutdownError === null
          ? last === null ? null : { status: last.status, code: last.code, message: last.message }
          : { status: 'FAILED', code: 'OWNERSHIP_SHUTDOWN_SAVE_FAILED', message: this.#shutdownError } },
      lastHcuMessage: interaction?.lastMessage ?? null, lastHcuAnswer: interaction?.lastAnswer ?? null });
  }

  async initialize(): Promise<Result<void>> {
    if (this.#gate.executionMode !== 'LIVE' || this.#gate.realWritesEnabled !== true) return failure('ConfigurationError', 'WRITE_BLOCKED: LIVE and GOE_REAL_WRITES_ENABLED=true are both required.');
    const initialized = await this.options.actuator.initialize(this.#config.chargers);
    if (!initialized.ok) return initialized;
    if (!this.#restoreEngine()) return failure('ConfigurationError', 'Reconciled restrictions could not be restored safely.');
    this.#ready = true;
    return success(undefined);
  }

  setConnectionState(state: string): void { this.#snapshot = { ...this.#snapshot, connectionState: state }; }
  cancelPendingOperations(): void {
    this.options.actuator.cancelPendingOperations();
    if (!this.#busy) {
      const pending = this.#manager.snapshot.pendingAction;
      if (pending !== null) this.#manager.cancelPendingAction(pending.id);
    }
  }
  resetTelemetry(): void { this.#health = new TelemetryHealthGuard(); }
  applyManualOverride(): void {
    this.options.actuator.cancelPendingOperations();
    // In-flight results must still be acknowledged if the request was already sent.
    const pending = this.#manager.snapshot.pendingAction;
    if (!this.#busy && pending !== null) this.#manager.cancelPendingAction(pending.id);
    this.#manager.applyManualOverride();
  }
  async endSession(): Promise<void> {
    if (this.#busy) throw new Error('A live operation is still in progress.');
    this.#manager.endSession(); this.#announced = false;
    await this.options.onEndSession?.();
  }

  async reconfigure(config: AppConfig, lifecycle: { readonly preserveOverride?: boolean } = {}): Promise<void> {
    if (this.#stopped) throw new Error('A stopped live runtime cannot be reconfigured.');
    if (this.#busy) throw new Error('A live operation is still in progress.');
    // A changed host/disabled charger cannot silently detach outstanding ownership.
    const outstanding = this.options.actuator.states.some((state) => state.pluginOwnedTcl !== null
      || state.pluginOwnedPause || state.pendingWrite !== null || state.ownershipStatus !== 'NONE');
    const binding = (value: AppConfig): string => JSON.stringify({ controller: value.controller.host,
      chargers: value.chargers.map(({ id, host, enabled }) => ({ id, host, enabled })).sort((a, b) => a.id.localeCompare(b.id)) });
    const bindingsChanged = binding(config) !== binding(this.#config);
    if (bindingsChanged && (outstanding || this.options.installed !== true)) throw new Error(outstanding
      ? 'Outstanding ownership prevents changing device bindings.'
      : 'Changing LIVE device bindings requires a stopped runtime and startup reconciliation.');
    if (this.options.installed === true) {
      const reconciled = await this.options.actuator.initialize(config.chargers);
      if (!reconciled.ok) { this.#ready = false; throw new Error('Ownership reconciliation failed.'); }
      if (this.#stopped) throw new Error('A stopped live runtime cannot be reconfigured.');
      this.resetTelemetry();
    }
    const manager = this.#manager;
    const previous = this.#config;
    this.#config = structuredClone(config);
    this.#manager = new LoadManager(this.#config, `${this.options.idProvider.nextId()}:`);
    if (!this.#restoreEngine()) { this.#manager = manager; this.#config = previous; throw new Error('Ownership restoration failed.'); }
    this.#ready = true;
    if (lifecycle.preserveOverride !== false && manager.snapshot.overrideActive) this.#manager.applyManualOverride();
    if (this.options.installed !== true) this.#announced = false;
    const controllerState = this.#snapshot.connectionState;
    this.#snapshot = { ...initialRuntimeSnapshot('LIVE'), connectionState: controllerState };
    if (this.options.installed !== true) await this.options.onEndSession?.();
  }

  /** Read-only observation; callers must explicitly schedule this in a future integration. */
  async observe(): Promise<RuntimeSnapshot> {
    if (!this.#ready || this.#stopped || this.#busy) return this.snapshot;
    this.#busy = true;
    try {
      const start = this.options.now();
      const report = await this.#probe();
      const now = this.options.now();
      const health = this.#health.observe(report.controller, start, now);
      const pending = this.#manager.snapshot.pendingAction;
      if (pending !== null) this.#manager.cancelPendingAction(pending.id);
      const decision = this.#manager.evaluate({ timestampMs: now, measurementId: this.options.idProvider.nextId(),
        controller: health.healthy ? report.controller : failure('MissingMeasurementError', 'Controller telemetry is unavailable or stale.'),
        chargers: report.chargers.flatMap((charger) => charger.status === 'disabled' ? []
          : [{ chargerId: charger.config.id, status: charger.status === 'reachable' ? success(charger.value) : { ok: false as const, error: charger.error } }]),
      });
      this.#snapshot = { ...this.#snapshot, observedAtMs: now, probe: report, engine: decision.status,
        lastDecision: decision, lastAction: decision.action ?? this.#snapshot.lastAction };
      if (decision.action !== null) this.journal.append({ timestamp: now, engineState: decision.state,
        gridImportW: decision.status.gridImportW, action: decision.action, chargerSnapshotSummary: this.#summaries() });
      if (decision.state === 'FAULT' || decision.state === 'LIMIT_UNACHIEVABLE') {
        this.journal.appendEvent({ kind: 'FAULT', timestamp: now, engineState: decision.state,
          gridImportW: decision.status.gridImportW, action: null, chargerSnapshotSummary: this.#summaries(),
          errorCode: decision.status.fault?.code ?? 'LIMIT_UNACHIEVABLE' });
        const notifications = getNotificationSettings(this.#config);
        const notify = decision.state === 'LIMIT_UNACHIEVABLE' ? notifications.intervention
          : report.controller.ok ? notifications.chargerConnectionError : notifications.controllerConnectionError;
        if (!this.#stopped && notify && (this.#lastWarning?.reason !== decision.state || now - this.#lastWarning.at >= 60_000)) {
          this.#lastWarning = { reason: decision.state, at: now };
          try { await this.options.onWarning?.(decision.state); } catch { /* Never turn missing HCU into consent. */ }
        }
      }
      return this.snapshot;
    } finally { this.#busy = false; }
  }

  /** The sole runtime actuation entry point requires the current explicit action ID. */
  async executePendingAction(actionId: string): Promise<Result<ActuatorResult>> {
    if (!this.#ready || this.#stopped || this.#busy) return failure('ConfigurationError', 'WRITE_BLOCKED: runtime is not ready or is busy.');
    const pending = this.#manager.snapshot.pendingAction;
    if (pending === null || pending.id !== actionId) return failure('ConfigurationError', 'WRITE_BLOCKED: no matching current engine action.');
    const config = this.#config.chargers.find((charger) => charger.id === pending.action.chargerId);
    if (config === undefined) return failure('ConfigurationError', 'WRITE_BLOCKED: charger is not configured.');
    this.#busy = true;
    try {
      const started = this.options.now();
      const controller = await this.#readController();
      const health = this.#health.observe(controller, started, this.options.now());
      const recovery = this.#isRecovery(pending.action);
      const validDecision = health.healthy && (!this.options.requireStableTelemetryForWrites || health.recoveryAllowed) && (recovery
        ? health.recoveryAllowed && (this.#manager.snapshot.overrideActive || (health.gridImportW !== null && health.gridImportW <= this.#manager.snapshot.recoveryThresholdW))
        : health.gridImportW !== null && health.gridImportW > this.#manager.snapshot.targetGridW);
      if (!validDecision) {
        this.#manager.cancelPendingAction(pending.id);
        if (!health.healthy) this.#manager.evaluate({ timestampMs: this.options.now(), measurementId: this.options.idProvider.nextId(),
          controller: failure('MissingMeasurementError', 'Controller telemetry is unavailable or stale.'), chargers: [] });
        this.journal.appendEvent({ kind: 'WRITE_BLOCKED', timestamp: this.options.now(), engineState: this.#manager.state,
          gridImportW: health.gridImportW, action: pending.action, chargerSnapshotSummary: this.#summaries(), errorCode: 'TELEMETRY_OR_DECISION_UNSAFE' });
        return failure('ConfigurationError', 'WRITE_BLOCKED: fresh telemetry does not permit this action.');
      }
      const result = await this.options.actuator.execute(pending.action, config, this.#context());
      if (result.status === 'CONFIRMED') this.#manager.acknowledgeAction(pending.id, 'applied');
      else if (result.status === 'BLOCKED') this.#manager.cancelPendingAction(pending.id);
      else this.#manager.acknowledgeAction(pending.id, 'failed');
      this.#recordResult(result, pending.action);
      const notifications = getNotificationSettings(this.#config);
      if (!this.#stopped && !this.#announced && result.status === 'CONFIRMED' && !this.#manager.snapshot.overrideActive
        && notifications.intervention && notifications.interactive
        && (pending.action.type === 'SET_TEMPORARY_CURRENT_LIMIT' || pending.action.type === 'PAUSE')) {
        this.#announced = true;
        try { await this.options.onIntervention?.(); } catch { /* No HCU answer means no override. */ }
      }
      return success(result);
    } finally { this.#busy = false; }
  }

  /** Explicit maintenance; phase 4 intentionally installs no background live scheduler. */
  async refresh(): Promise<readonly ActuatorResult[]> {
    if (!this.#ready || this.#busy || this.#stopped) return [];
    this.#busy = true;
    try {
      const started = this.options.now();
      const controller = await this.#readController();
      const health = this.#health.observe(controller, started, this.options.now());
      if (!health.healthy) {
        const pending = this.#manager.snapshot.pendingAction;
        if (pending !== null) this.#manager.cancelPendingAction(pending.id);
        this.#manager.evaluate({ timestampMs: this.options.now(), measurementId: this.options.idProvider.nextId(),
          controller: failure('MissingMeasurementError', 'Controller telemetry is unavailable or stale.'), chargers: [] });
        this.journal.appendEvent({ kind: 'FAULT', timestamp: this.options.now(), engineState: 'FAULT', gridImportW: null,
          action: null, chargerSnapshotSummary: this.#summaries(), errorCode: health.reason ?? 'CONTROLLER_UNAVAILABLE' });
      }
      const results = await this.options.actuator.refresh(this.#config.chargers, this.#context());
      for (const result of results) if (result.action !== null) this.#recordResult(result, result.action);
      return results;
    } finally { this.#busy = false; }
  }

  async stop(): Promise<Result<void>> {
    this.#stopped = true;
    const result = await this.options.actuator.shutdown();
    if (!result.ok) {
      this.#shutdownError = 'Ownership state could not be persisted at shutdown.';
      this.journal.appendEvent({ kind: 'FAULT', timestamp: this.options.now(), engineState: this.#manager.state,
        gridImportW: null, action: null, chargerSnapshotSummary: this.#summaries(), errorCode: 'OWNERSHIP_SHUTDOWN_SAVE_FAILED' });
    }
    return result;
  }

  #context(): ActuatorContext {
    const health = this.#health.snapshot(this.options.now());
    return { telemetryHealthy: health.healthy, recoveryAllowed: health.recoveryAllowed,
      telemetrySampledAtMs: health.sampledAtMs,
      overrideActive: this.#manager.snapshot.overrideActive,
      // An explicit Installed override may clean up existing owned restrictions while activation is OFF.
      // Actuator override rules reject new reductions/pause and preserve foreign ownership.
      loadManagementEnabled: this.#config.loadManagement.enabled
        || (this.options.installed === true && this.#manager.snapshot.overrideActive) };
  }

  #isRecovery(action: ControlAction): boolean {
    if (action.type === 'CLEAR_TEMPORARY_CURRENT_LIMIT' || action.type === 'RESUME') return true;
    if (action.type === 'PAUSE') return false;
    const owned = this.options.actuator.states.find((state) => state.chargerId === action.chargerId)?.pluginOwnedTcl;
    return owned !== undefined && owned !== null && action.amps > owned;
  }

  #restoreEngine(): boolean {
    return this.#manager.restoreConfirmedRestrictions(this.options.actuator.states.filter((state) => state.ownershipStatus === 'OWNED'
      && this.#config.chargers.some((charger) => charger.enabled && charger.id === state.chargerId && charger.host === state.host)
      && (state.pluginOwnedTcl !== null || state.pluginOwnedPause)).map((state) => ({
        restriction: { chargerId: state.chargerId, baselineTemporaryCurrentLimitA: state.baseline?.tcl ?? null,
          temporaryCurrentLimitA: state.pluginOwnedTcl, paused: state.pluginOwnedPause,
          pausedAtMs: state.pluginOwnedPause ? state.lastConfirmedWrite?.confirmedAtMs ?? state.updatedAt : null },
        minimumPauseDurationMs: state.baseline?.mcpd ?? 0,
      })), this.options.now());
  }

  #summaries() { return this.#snapshot.probe?.chargers.flatMap((charger) => charger.status === 'reachable' ? [summarizeCharger(charger.value)] : []) ?? []; }

  #recordResult(result: ActuatorResult, action: ControlAction): void {
    const entry = { timestamp: this.options.now(), engineState: this.#manager.state,
      gridImportW: this.#health.snapshot(this.options.now()).gridImportW, action, chargerSnapshotSummary: this.#summaries(),
      result: result.status, errorCode: result.code, retryCount: Math.max(result.readAttempts - 1, 0) };
    if (result.writeAttempted) this.journal.appendEvent({ ...entry, kind: 'WRITE_ATTEMPTED' });
    this.journal.appendEvent({ ...entry, kind: result.status === 'CONFIRMED' ? 'WRITE_CONFIRMED'
      : result.status === 'BLOCKED' ? 'WRITE_BLOCKED' : result.status === 'READBACK_MISMATCH' ? 'READBACK_MISMATCH'
        : result.status === 'CONFLICT' ? 'OWNERSHIP_CONFLICT' : 'FAULT' });
  }

  async #readController(): Promise<Result<ControllerStatus>> {
    try { return await (this.options.readController?.(this.#config)
      ?? new GoEControllerClient(this.#config.controller.host, new GoEHttpClient({ timeoutMs: this.#config.http.timeoutMs })).readStatus()); }
    catch { return failure('ConnectionError', 'Controller read failed.'); }
  }

  async #probe(): Promise<ProbeReport> {
    try { return await (this.options.probe?.(this.#config) ?? probeDevices(this.#config)); }
    catch { return { controller: failure('ConnectionError', 'Device observation failed.'), chargers: this.#config.chargers.map((config: ChargerConfig) =>
      config.enabled ? { config, status: 'unavailable' as const, reachable: false as const, error: { code: 'ConnectionError' as const, message: 'Device observation failed.' } }
        : { config, status: 'disabled' as const, reachable: false as const }) }; }
  }
}
