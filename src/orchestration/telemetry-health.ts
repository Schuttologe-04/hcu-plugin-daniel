import type { ControllerStatus } from '../domain/controller.js';
import type { Result } from '../domain/errors.js';

export interface TelemetryHealth {
  readonly state: 'UNKNOWN' | 'FAULT' | 'STABILIZING' | 'HEALTHY';
  readonly healthy: boolean;
  readonly recoveryAllowed: boolean;
  readonly gridImportW: number | null;
  readonly sampledAtMs: number | null;
  readonly stableSinceMs: number | null;
  readonly reason: string | null;
}

/** Explicit timestamps; only continuous fresh telemetry opens recovery after a fault. */
export class TelemetryHealthGuard {
  #health: TelemetryHealth = { state: 'UNKNOWN', healthy: false, recoveryAllowed: false,
    gridImportW: null, sampledAtMs: null, stableSinceMs: null, reason: 'NO_TELEMETRY' };
  #needsStabilization = true;
  #lastNow: number | null = null;

  constructor(readonly maxAgeMs = 4_000, readonly recoveryStableMs = 10_000) {
    if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0 || !Number.isSafeInteger(recoveryStableMs) || recoveryStableMs <= 0) {
      throw new Error('Telemetry health intervals must be positive integers.');
    }
  }

  observe(controller: Result<ControllerStatus>, sampledAtMs: number, nowMs: number): TelemetryHealth {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || (this.#lastNow !== null && nowMs < this.#lastNow)) return this.#fault('INVALID_CLOCK');
    this.#lastNow = nowMs;
    // An incoming fresh measurement replaces the old sample. Continuity depends
    // on sample starts, not on the old sample's age after the new HTTP read ends.
    // A fault already exposed by snapshot() remains recorded in #health.
    const previous = this.#health;
    if (!Number.isSafeInteger(sampledAtMs) || sampledAtMs < 0 || sampledAtMs > nowMs
      || nowMs - sampledAtMs > this.maxAgeMs) return this.#fault('STALE_TELEMETRY');
    if (!controller.ok) return this.#fault('CONTROLLER_UNAVAILABLE');
    const value = controller.value;
    if (typeof value !== 'object' || value === null || value.reachable !== true || !Number.isFinite(value.gridPowerW) || !Number.isFinite(value.gridImportW)
      || value.gridImportW !== Math.max(value.gridPowerW, 0)) return this.#fault('INVALID_GRID');
    if (previous.sampledAtMs !== null && sampledAtMs < previous.sampledAtMs) return this.#fault('NON_MONOTONIC_TELEMETRY');
    const continuous = previous.healthy && previous.sampledAtMs !== null
      && sampledAtMs - previous.sampledAtMs <= this.maxAgeMs;
    if (!continuous) this.#needsStabilization = true;
    const stableSinceMs = continuous ? previous.stableSinceMs ?? sampledAtMs : sampledAtMs;
    if (this.#needsStabilization && sampledAtMs - stableSinceMs >= this.recoveryStableMs) this.#needsStabilization = false;
    this.#health = { state: this.#needsStabilization ? 'STABILIZING' : 'HEALTHY', healthy: true,
      recoveryAllowed: !this.#needsStabilization, gridImportW: value.gridImportW,
      sampledAtMs, stableSinceMs, reason: this.#needsStabilization ? 'RECOVERY_STABILIZING' : null };
    return { ...this.#health };
  }

  snapshot(nowMs: number): TelemetryHealth {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || (this.#lastNow !== null && nowMs < this.#lastNow)) {
      return this.#fault('INVALID_CLOCK');
    }
    this.#lastNow = nowMs;
    if (this.#health.sampledAtMs !== null && nowMs - this.#health.sampledAtMs > this.maxAgeMs) this.#fault('STALE_TELEMETRY');
    return { ...this.#health };
  }

  #fault(reason: string): TelemetryHealth {
    this.#needsStabilization = true;
    this.#health = { state: 'FAULT', healthy: false, recoveryAllowed: false, gridImportW: null,
      sampledAtMs: null, stableSinceMs: null, reason };
    return { ...this.#health };
  }
}
