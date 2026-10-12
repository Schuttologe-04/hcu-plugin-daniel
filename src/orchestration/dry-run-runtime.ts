import type { Logger } from 'pino';
import type { AppConfig } from '../config/config-types.js';
import { getNotificationSettings } from '../config/notification-settings.js';
import { probeDevices, type ProbeReport } from '../diagnostics/probe-service.js';
import { isActivelyCharging, mapCarState, type ChargerStatus } from '../domain/charger.js';
import { failure, success, type Result } from '../domain/errors.js';
import type { IdProvider } from '../hcu/id-provider.js';
import { LoadManager } from '../load-management/load-manager.js';
import type { ChargerObservation } from '../load-management/engine-input.js';
import { applySimulatedAction } from '../simulation/simulator.js';
import { ActionJournal, summarizeCharger } from './action-journal.js';
import { initialRuntimeSnapshot, type RuntimeSnapshot } from './runtime-snapshot.js';

interface SimulatedControl {
  readonly status: ChargerStatus;
  readonly realTemporaryLimitA: number | null;
  readonly realForceState: number;
}

export interface DryRunRuntimeOptions {
  readonly config: AppConfig;
  readonly now: () => number;
  readonly idProvider: IdProvider;
  readonly probe?: (config: AppConfig) => Promise<ProbeReport>;
  readonly onIntervention?: () => Promise<Result<void>>;
  readonly onEndSession?: () => Promise<void>;
  readonly getInteractionStatus?: () => { readonly lastMessage: string | null; readonly lastAnswer: string | null };
  readonly onConnectionWarning?: (kind: 'controller' | 'charger') => Promise<void>;
  readonly logger?: Logger;
}

/**
 * Real GET observations plus a separate virtual control layer.
 * An action is applied ONLY through applySimulatedAction, never through a device client.
 */
export class DryRunRuntime {
  #config: AppConfig;
  #engine: LoadManager;
  #snapshot = initialRuntimeSnapshot('DRY_RUN');
  readonly #virtual = new Map<string, SimulatedControl>();
  readonly journal = new ActionJournal();
  readonly #probe: (config: AppConfig) => Promise<ProbeReport>;
  #generation = 0;
  #tickPromise: Promise<RuntimeSnapshot> | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  #interventionAnnounced = false;
  #lastControllerFailed = false;
  #lastChargerFailed = false;

  constructor(private readonly options: DryRunRuntimeOptions) {
    this.#config = structuredClone(options.config);
    this.#engine = new LoadManager(this.#config);
    this.#probe = options.probe ?? ((config) => probeDevices(config));
  }

  get engine(): LoadManager { return this.#engine; }

  get snapshot(): RuntimeSnapshot {
    const interaction = this.options.getInteractionStatus?.();
    return structuredClone({
      ...this.#snapshot,
      engine: this.#snapshot.observedAtMs === null ? null : this.#engine.snapshot,
      lastHcuMessage: interaction?.lastMessage ?? this.#snapshot.lastHcuMessage,
      lastHcuAnswer: interaction?.lastAnswer ?? this.#snapshot.lastHcuAnswer,
    });
  }

  setConnectionState(state: string): void { this.#snapshot = { ...this.#snapshot, connectionState: state }; }

  applyManualOverride(): void { this.#engine.applyManualOverride(); }

  async endSession(): Promise<void> {
    this.#engine.endSession();
    this.#interventionAnnounced = false;
    await this.options.onEndSession?.();
  }

  /** Explicit config replacement resets only this simulation; no device needs undoing. */
  async reconfigure(config: AppConfig): Promise<void> {
    this.#generation += 1;
    this.#config = structuredClone(config);
    this.#engine = new LoadManager(this.#config);
    this.#virtual.clear();
    this.#interventionAnnounced = false;
    this.#lastControllerFailed = false;
    this.#lastChargerFailed = false;
    this.#snapshot = { ...initialRuntimeSnapshot('DRY_RUN'), connectionState: this.#snapshot.connectionState };
    try { await this.options.onEndSession?.(); }
    catch { this.options.logger?.warn('Old HCU test interaction cleanup remains pending'); }
  }

  async tick(): Promise<RuntimeSnapshot> {
    if (this.#tickPromise !== null) return this.#tickPromise;
    const work = this.#performTick();
    this.#tickPromise = work;
    try { return await work; }
    finally { if (this.#tickPromise === work) this.#tickPromise = null; }
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#schedule(0);
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#tickPromise;
  }

  #schedule(delayMs: number): void {
    if (!this.#running) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.tick().catch(() => {
        this.options.logger?.error('Dry-run snapshot failed; no device action was executed');
      }).finally(() => this.#schedule(this.#config.loadManagement.controlIntervalSeconds * 1_000));
    }, delayMs);
  }

  async #performTick(): Promise<RuntimeSnapshot> {
    const config = this.#config;
    const generation = this.#generation;
    let report: ProbeReport;
    try { report = await this.#probe(config); }
    catch {
      report = {
        controller: failure('ConnectionError', 'Read-only device observation failed.'),
        chargers: config.chargers.map((charger) => charger.enabled
          ? { status: 'unavailable', reachable: false, config: charger, error: { code: 'ConnectionError', message: 'Read-only charger observation failed.' } }
          : { status: 'disabled', reachable: false, config: charger }),
      };
    }
    if (generation !== this.#generation) return this.snapshot;
    const timestampMs = this.options.now();
    const observations: ChargerObservation[] = [];
    const virtualStatuses: ChargerStatus[] = [];
    const realById = new Map<string, ChargerStatus>();
    const sourceConflicts: string[] = [];
    for (const charger of report.chargers) {
      if (charger.status === 'disabled') continue;
      if (charger.status === 'unavailable') {
        observations.push({ chargerId: charger.config.id, status: { ok: false, error: charger.error } });
        continue;
      }
      const real = charger.value;
      realById.set(real.id, real);
      const projected = this.#project(real, sourceConflicts);
      observations.push({ chargerId: real.id, status: success(projected) });
      virtualStatuses.push(projected);
    }
    // A foreign change invalidates the virtual scenario. Unknown safety is never zero load.
    const simulationNote = sourceConflicts.length === 0 ? undefined
      : 'Real charger controls changed during the dry-run. The virtual scenario cannot safely continue.';
    const decision = this.#engine.evaluate({
      timestampMs, measurementId: `${generation}:${this.options.idProvider.nextId()}`,
      controller: simulationNote === undefined ? report.controller
        : failure('InvalidResponseError', simulationNote),
      chargers: observations,
    });
    const { simulationNote: previousNote, ...previousSnapshot } = this.#snapshot;
    this.#snapshot = {
      ...previousSnapshot, observedAtMs: timestampMs, probe: structuredClone(report),
      engine: decision.status, lastDecision: decision,
      lastAction: decision.action ?? this.#snapshot.lastAction,
      ...(simulationNote === undefined ? {} : { simulationNote }),
    };
    if (simulationNote !== undefined && previousNote === undefined) {
      this.options.logger?.warn({ chargerIds: sourceConflicts }, 'Virtual charger model unavailable after a real control change');
    }

    if (decision.action !== null && decision.actionId !== null) {
      const source = virtualStatuses.find((status) => status.id === decision.action?.chargerId);
      const real = realById.get(decision.action.chargerId);
      if (source !== undefined && real !== undefined) {
        const prior = this.#virtual.get(source.id);
        this.#virtual.set(source.id, {
          status: applySimulatedAction(source, decision.action),
          realTemporaryLimitA: prior === undefined ? real.temporaryCurrentLimitA : prior.realTemporaryLimitA,
          realForceState: prior?.realForceState ?? real.forceState,
        });
        this.#engine.acknowledgeAction(decision.actionId, 'applied');
        this.journal.append({
          timestamp: timestampMs, engineState: decision.state, gridImportW: decision.status.gridImportW,
          action: decision.action, chargerSnapshotSummary: virtualStatuses.map(summarizeCharger),
        });
        this.options.logger?.info({ mode: 'DRY_RUN', engineState: decision.state, action: decision.action, realChargerWritesEnabled: false }, 'Hypothetical charger action recorded');
        const notifications = getNotificationSettings(config);
        if (!this.#interventionAnnounced && notifications.intervention && notifications.interactive
          && (decision.action.type === 'SET_TEMPORARY_CURRENT_LIMIT' || decision.action.type === 'PAUSE')
          && decision.state !== 'OVERRIDE') {
          this.#interventionAnnounced = true;
          try { await this.options.onIntervention?.(); }
          catch { this.options.logger?.warn('HCU test interaction could not be created; automatic simulation continues'); }
        }
      }
    }
    if (generation !== this.#generation) return this.snapshot;
    const activeIds = new Set([
      ...this.#engine.snapshot.restrictions.map((restriction) => restriction.chargerId),
      ...this.#engine.snapshot.awaitingObservationChargerIds,
      ...(this.#engine.snapshot.pendingAction === null ? [] : [this.#engine.snapshot.pendingAction.action.chargerId]),
    ]);
    for (const id of this.#virtual.keys()) if (!activeIds.has(id)) this.#virtual.delete(id);

    const controllerFailed = !report.controller.ok;
    const chargerFailed = report.chargers.some((charger) => charger.status === 'unavailable');
    const notifications = getNotificationSettings(config);
    if (controllerFailed && !this.#lastControllerFailed && notifications.controllerConnectionError) {
      await this.#warnConnection('controller');
    }
    if (generation !== this.#generation) return this.snapshot;
    if (chargerFailed && !this.#lastChargerFailed && notifications.chargerConnectionError) {
      await this.#warnConnection('charger');
    }
    if (generation !== this.#generation) return this.snapshot;
    this.#lastControllerFailed = controllerFailed;
    this.#lastChargerFailed = chargerFailed;
    return this.snapshot;
  }

  async #warnConnection(kind: 'controller' | 'charger'): Promise<void> {
    try { await this.options.onConnectionWarning?.(kind); }
    catch { this.options.logger?.warn({ device: kind }, 'HCU test warning unavailable'); }
  }

  #project(real: ChargerStatus, conflicts: string[]): ChargerStatus {
    const virtual = this.#virtual.get(real.id);
    if (virtual === undefined) return structuredClone(real);
    if (real.temporaryCurrentLimitA !== virtual.realTemporaryLimitA || real.forceState !== virtual.realForceState) conflicts.push(real.id);
    if (virtual.status.forceState === 1 && !virtual.status.chargingAllowed) {
      return { ...real, temporaryCurrentLimitA: virtual.status.temporaryCurrentLimitA,
        forceState: 1, chargingAllowed: false, carState: mapCarState(4), effectiveCurrentA: null };
    }
    const limit = virtual.status.temporaryCurrentLimitA;
    return {
      ...real, temporaryCurrentLimitA: limit,
      effectiveCurrentA: real.effectiveCurrentA === null ? null : Math.min(real.effectiveCurrentA,
        real.configuredCurrentA, real.maximumCurrentA ?? real.configuredCurrentA, limit ?? real.configuredCurrentA),
      carState: isActivelyCharging(real) ? real.carState : { ...real.carState },
    };
  }
}
