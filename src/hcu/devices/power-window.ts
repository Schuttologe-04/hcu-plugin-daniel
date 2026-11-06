/** Presentation cadence only: these constants never configure the load manager. */
export const POWER_PUBLISH_INTERVAL_MS = 60_000;
export const POWER_SAMPLE_MAX_AGE_MS = 4_000;
export const POWER_MIN_WINDOW_COVERAGE_MS = 54_000;

export interface CompletedPowerWindow {
  readonly startMs: number;
  readonly endMs: number;
  readonly coverageMs: number;
  /** Rounded watts; absent when less than 90% of this full minute was valid. */
  readonly powerW: number | undefined;
}

interface HeldSample { readonly powerW: number; readonly sampledAtMs: number }
interface WeightedPower { readonly coverageMs: number; readonly meanW: number }

function validTime(value: number | undefined): value is number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    && value <= Number.MAX_SAFE_INTEGER - POWER_PUBLISH_INTERVAL_MS - POWER_SAMPLE_MAX_AGE_MS;
}

/**
 * One independent, bounded measurement series. Call once per existing poll.
 * sampledAtMs is the poll's start, nowMs its observation/callback completion.
 * A sample is held forward until the next poll starts, at most four seconds.
 * No averaging sample, clock, timer, queue or hardware access is created here.
 */
export class PowerWindowAggregator {
  #startMs: number | undefined;
  #cursorMs: number | undefined;
  #lastNowMs: number | undefined;
  #lastSampledAtMs: number | undefined;
  #lastValue: number | undefined;
  #held: HeldSample | undefined;
  #weighted: WeightedPower = { coverageMs: 0, meanW: 0 };
  #latest: CompletedPowerWindow | undefined;

  clear(): void {
    this.#startMs = undefined;
    this.#cursorMs = undefined;
    this.#lastNowMs = undefined;
    this.#lastSampledAtMs = undefined;
    this.#lastValue = undefined;
    this.#held = undefined;
    this.#weighted = { coverageMs: 0, meanW: 0 };
    this.#latest = undefined;
  }

  /**
   * Returns only the newest completed window, once. A large clock jump discards
   * older windows in O(1), rather than replaying a history of missed events.
   * An invalid current observation immediately invalidates the cached mean.
   */
  observe(value: number | undefined, sampledAtMs: number | undefined, nowMs: number): CompletedPowerWindow | undefined {
    if (!validTime(nowMs) || (this.#lastNowMs !== undefined && nowMs < this.#lastNowMs)
      || (sampledAtMs !== undefined && (!validTime(sampledAtMs) || sampledAtMs > nowMs))) {
      this.clear();
      return undefined;
    }
    const atMs = sampledAtMs ?? nowMs;
    if (this.#cursorMs !== undefined && atMs < this.#cursorMs) {
      this.clear();
      this.#lastNowMs = nowMs;
      return undefined;
    }
    const valid = sampledAtMs !== undefined && nowMs - sampledAtMs <= POWER_SAMPLE_MAX_AGE_MS
      && value !== undefined && Number.isFinite(value);
    const nextValue = valid ? value : undefined;
    this.#lastNowMs = nowMs;
    if (sampledAtMs !== undefined && sampledAtMs === this.#lastSampledAtMs) {
      // Reconfiguration/repeated callbacks cannot fabricate another measurement
      // or renew the preceding measurement's four-second validity.
      if (nextValue !== this.#lastValue || !valid) { this.#held = undefined; this.#latest = undefined; }
      return undefined;
    }
    if (this.#held !== undefined && atMs - this.#held.sampledAtMs > POWER_SAMPLE_MAX_AGE_MS) {
      // A later fresh sample cannot revive a cached mean across an unobserved
      // outage. Keep the current integral: a short gap may still meet 90%.
      this.#latest = undefined;
    }
    if (this.#startMs === undefined) { this.#startMs = atMs; this.#cursorMs = atMs; }
    const completed = this.#advance(atMs);
    this.#lastSampledAtMs = sampledAtMs;
    this.#lastValue = nextValue;
    this.#held = nextValue === undefined ? undefined : { powerW: nextValue, sampledAtMs: atMs };
    if (nextValue === undefined) this.#latest = undefined;
    else if (completed !== undefined) this.#latest = completed.powerW === undefined ? undefined : completed;
    return completed;
  }

  /** A completed average is not proof of fresh source telemetry. */
  latest(nowMs: number): CompletedPowerWindow | undefined {
    const value = this.#latest;
    if (!validTime(nowMs) || (this.#lastNowMs !== undefined && nowMs < this.#lastNowMs)) {
      // The timeline itself is uncertain. Discard pre-jump coverage, too, so a
      // subsequent return to the old clock cannot resurrect its aggregate.
      this.clear();
      return undefined;
    }
    if (value === undefined || nowMs < value.endMs) return undefined;
    // Allow one incomplete next minute plus bounded poll-arrival jitter only.
    if (nowMs > value.endMs + POWER_PUBLISH_INTERVAL_MS + POWER_SAMPLE_MAX_AGE_MS) {
      this.#latest = undefined;
      return undefined;
    }
    return value;
  }

  #advance(atMs: number): CompletedPowerWindow | undefined {
    const startMs = this.#startMs;
    const cursorMs = this.#cursorMs;
    if (startMs === undefined || cursorMs === undefined) return undefined;
    const endMs = startMs + POWER_PUBLISH_INTERVAL_MS;
    if (atMs < endMs) {
      this.#weighted = this.#add(this.#weighted, cursorMs, atMs);
      this.#cursorMs = atMs;
      return undefined;
    }
    const crossed = Math.floor((atMs - startMs) / POWER_PUBLISH_INTERVAL_MS);
    const nextStartMs = startMs + crossed * POWER_PUBLISH_INTERVAL_MS;
    // A held sample spans at most four seconds. Only the old and final windows
    // need inspecting even if the caller resumes years later.
    const completedStartMs = nextStartMs - POWER_PUBLISH_INTERVAL_MS;
    const completedWeight = crossed === 1
      ? this.#add(this.#weighted, cursorMs, endMs)
      : this.#add({ coverageMs: 0, meanW: 0 }, Math.max(cursorMs, completedStartMs), nextStartMs);
    const rounded = Math.round(completedWeight.meanW);
    const completed: CompletedPowerWindow = {
      startMs: completedStartMs, endMs: nextStartMs, coverageMs: completedWeight.coverageMs,
      powerW: completedWeight.coverageMs >= POWER_MIN_WINDOW_COVERAGE_MS && Number.isFinite(rounded)
        ? Object.is(rounded, -0) ? 0 : rounded : undefined,
    };
    this.#startMs = nextStartMs;
    this.#weighted = this.#add({ coverageMs: 0, meanW: 0 }, Math.max(cursorMs, nextStartMs), atMs);
    this.#cursorMs = atMs;
    return completed;
  }

  #add(previous: WeightedPower, fromMs: number, toMs: number): WeightedPower {
    const held = this.#held;
    if (held === undefined) return previous;
    const durationMs = Math.min(toMs, held.sampledAtMs + POWER_SAMPLE_MAX_AGE_MS) - Math.max(fromMs, held.sampledAtMs);
    if (durationMs <= 0) return previous;
    const coverageMs = previous.coverageMs + durationMs;
    // Normalized weights avoid overflowing a finite watt value by multiplying
    // it by milliseconds before dividing it back down.
    const meanW = previous.meanW * (previous.coverageMs / coverageMs) + held.powerW * (durationMs / coverageMs);
    return { coverageMs, meanW };
  }
}
