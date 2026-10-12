import type { AppConfig } from '../config/config-types.js';
import { failure, type Result } from '../domain/errors.js';
import { LiveRuntime, type LiveRuntimeOptions } from './live-runtime.js';
import type { RuntimeSnapshot } from './runtime-snapshot.js';

export interface InstalledScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface InstalledRuntimeOptions extends LiveRuntimeOptions {
  readonly scheduler?: InstalledScheduler;
  readonly onSnapshot?: (snapshot: RuntimeSnapshot) => void;
  readonly onError?: () => void;
}

const nativeScheduler: InstalledScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** One sequential installed loop. The phase-4 LIVE runtime still owns every device action. */
export class InstalledRuntime {
  readonly #live: LiveRuntime;
  readonly #scheduler: InstalledScheduler;
  #config: AppConfig;
  #timer: unknown;
  #started = false;
  #stopped = false;
  #initialized = false;
  #transitioning = false;
  #generation = 0;
  #cycle: Promise<RuntimeSnapshot> | null = null;
  #cleanup = false;
  #manualOverride = false;

  constructor(private readonly options: InstalledRuntimeOptions) {
    this.#config = structuredClone(options.config);
    this.#scheduler = options.scheduler ?? nativeScheduler;
    this.#live = new LiveRuntime({ ...options, config: this.#engineConfig(this.#config),
      installed: true, requireStableTelemetryForWrites: true });
  }

  get engine() { return this.#live.engine; }
  get journal() { return this.#live.journal; }
  get snapshot(): RuntimeSnapshot {
    return { ...this.#live.snapshot, mode: 'INSTALLED_LIVE',
      automaticLiveControlEnabled: this.#automaticEnabled() };
  }

  async initialize(): Promise<Result<void>> {
    if (this.#stopped) return failure('ConfigurationError', 'Installed runtime is stopped.');
    const result = await this.#live.initialize();
    this.#initialized = result.ok;
    return result;
  }

  /** Starting installs a timer, but never changes the persistent user's activation choice. */
  start(): void {
    if (this.#started || this.#stopped || !this.#initialized) return;
    this.#started = true;
    this.#schedule(0);
  }

  setConnectionState(state: string): void { this.#live.setConnectionState(state); }

  applyManualOverride(): void {
    this.#manualOverride = true;
    if (!this.#automaticEnabled() && this.options.actuator.states.some(state => state.pluginOwnedTcl !== null || state.pluginOwnedPause)) {
      this.#cleanup = true;
    }
    this.#live.applyManualOverride();
  }

  async endSession(): Promise<void> {
    this.#generation += 1;
    this.#live.cancelPendingOperations();
    await this.#cycle;
    await this.#live.endSession();
    this.#manualOverride = false;
    if (this.#cleanup) this.#live.applyManualOverride();
  }

  async reconfigure(config: AppConfig): Promise<void> {
    if (this.#stopped || this.#transitioning) throw new Error('Installed runtime cannot be reconfigured now.');
    this.#transitioning = true;
    this.#generation += 1;
    this.#live.cancelPendingOperations();
    try {
      await this.#cycle;
      if (this.#stopped) throw new Error('Installed runtime stopped during configuration update.');
      const wasEnabled = this.#automaticEnabled();
      const enabled = config.loadManagement.enabled && config.loadManagement.liveControlEnabled === true;
      const owned = this.options.actuator.states.some((state) => state.pluginOwnedTcl !== null || state.pluginOwnedPause);
      const cleanup = !enabled && owned;
      // Deactivation cleanup is an operational intent, not a real session-end event.
      await this.#live.reconfigure(this.#engineConfig(config, cleanup), {
        preserveOverride: !(enabled && this.#cleanup && !this.#manualOverride),
      });
      if (this.#stopped) throw new Error('Installed runtime stopped during configuration update.');
      this.#config = structuredClone(config);
      this.#cleanup = cleanup;
      if (cleanup || this.#manualOverride) this.#live.applyManualOverride();
      if (!wasEnabled && enabled) this.#live.resetTelemetry();
      this.#publish();
    } finally { this.#transitioning = false; }
  }

  /** Public for deterministic tests; production calls it only through the one scheduler. */
  tick(): Promise<RuntimeSnapshot> {
    if (this.#cycle !== null) return this.#cycle;
    if (this.#stopped || !this.#initialized || this.#transitioning) return Promise.resolve(this.snapshot);
    const generation = this.#generation;
    const operation = this.#runCycle(generation);
    this.#cycle = operation;
    void operation.finally(() => { if (this.#cycle === operation) this.#cycle = null; }).catch(() => undefined);
    return operation;
  }

  async stop(): Promise<Result<void>> {
    this.#stopped = true;
    this.#started = false;
    this.#generation += 1;
    if (this.#timer !== undefined) this.#scheduler.clearTimeout(this.#timer);
    this.#timer = undefined;
    // The actuator fence is immediate; already sent requests finish readback/persistence.
    this.#live.cancelPendingOperations();
    const stopped = this.#live.stop();
    await this.#cycle;
    return stopped;
  }

  async #runCycle(generation: number): Promise<RuntimeSnapshot> {
    try {
      await this.#live.observe();
      if (this.#stopped || this.#transitioning || generation !== this.#generation) return this.snapshot;
      const health = this.#live.snapshot.telemetryHealth;
      const pending = this.#live.engine.snapshot.pendingAction;
      const safeCleanup = this.#cleanup && (this.#manualOverride || (health?.gridImportW !== null
        && health?.gridImportW !== undefined && health.gridImportW <= this.#live.engine.snapshot.recoveryThresholdW));
      if (pending !== null && health?.recoveryAllowed === true && (this.#automaticEnabled() || safeCleanup)) {
        await this.#live.executePendingAction(pending.id);
      }
      // Maintenance runs only after observation and never alongside an action.
      if (pending === null && !this.#stopped && !this.#transitioning && generation === this.#generation
        && this.#automaticEnabled() && health?.recoveryAllowed === true && this.#live.engine.state !== 'FAULT'
        && !this.#live.engine.snapshot.overrideActive) {
        await this.#live.refresh();
      }
      this.#publish();
      return this.snapshot;
    } catch {
      try { this.options.onError?.(); } catch { /* A diagnostic subscriber never enables writes. */ }
      return this.snapshot;
    }
  }

  #automaticEnabled(): boolean {
    return !this.#stopped && this.options.gate.executionMode === 'LIVE' && this.options.gate.realWritesEnabled === true
      && this.#config.loadManagement.enabled && this.#config.loadManagement.liveControlEnabled === true;
  }

  #engineConfig(config: AppConfig, cleanup = this.#cleanup): AppConfig {
    return { ...structuredClone(config), loadManagement: { ...config.loadManagement,
      enabled: cleanup || (config.loadManagement.enabled && config.loadManagement.liveControlEnabled === true) } };
  }

  #schedule(delayMs: number): void {
    this.#timer = this.#scheduler.setTimeout(() => {
      this.#timer = undefined;
      const startedAt = this.options.now();
      void this.tick().finally(() => {
        if (this.#started && !this.#stopped) {
          // Preserve sample-start cadence instead of adding request duration to every interval.
          // Reserve half the freshness budget for timer jitter and HTTP latency.
          // The engine still enforces the configured interval between actions.
          const interval = Math.min(this.#live.telemetryMaxAgeMs / 2, this.#config.loadManagement.controlIntervalSeconds * 1_000);
          this.#schedule(Math.max(1, interval - Math.max(0, this.options.now() - startedAt)));
        }
      });
    }, delayMs);
  }

  #publish(): void {
    try { this.options.onSnapshot?.(this.snapshot); } catch { /* HCU transport does not own local control health. */ }
  }
}
