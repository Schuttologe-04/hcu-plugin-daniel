import { describe, expect, it } from 'vitest';
import {
  POWER_MIN_WINDOW_COVERAGE_MS, POWER_PUBLISH_INTERVAL_MS, POWER_SAMPLE_MAX_AGE_MS,
  PowerWindowAggregator, type CompletedPowerWindow,
} from '../../../../src/hcu/devices/power-window.js';

function observeAt(series: PowerWindowAggregator, atMs: number, powerW: number | undefined, delayMs = 0) {
  return series.observe(powerW, atMs, atMs + delayMs);
}

function minute(series: PowerWindowAggregator, powerAt: (atMs: number) => number | undefined, startMs = 0): CompletedPowerWindow | undefined {
  let completed: CompletedPowerWindow | undefined;
  for (let atMs = startMs; atMs <= startMs + 60_000; atMs += 2_000) {
    const value = observeAt(series, atMs, powerAt(atMs));
    if (value !== undefined) completed = value;
  }
  return completed;
}

describe('time-weighted power windows used only at the HCU publication boundary', () => {
  it('defines a full minute, bounded sample validity and a conservative 90% minimum', () => {
    expect(POWER_PUBLISH_INTERVAL_MS).toBe(60_000);
    expect(POWER_SAMPLE_MAX_AGE_MS).toBe(4_000);
    expect(POWER_MIN_WINDOW_COVERAGE_MS).toBe(54_000);
  });

  it.each([0, 1_000, -2_500, 0.49, 0.5, -0.1, -1.5])('averages and rounds a constant %s W only after a full minute', powerW => {
    const series = new PowerWindowAggregator();
    const completed = minute(series, () => powerW);
    const rounded = Math.round(powerW);
    expect(completed).toEqual({ startMs: 0, endMs: 60_000, coverageMs: 60_000, powerW: Object.is(rounded, -0) ? 0 : rounded });
  });

  it('averages 20 seconds each of 1000, 2000 and 3000 W to 2000 W', () => {
    const series = new PowerWindowAggregator();
    expect(minute(series, atMs => atMs < 20_000 ? 1_000 : atMs < 40_000 ? 2_000 : 3_000)?.powerW).toBe(2_000);
  });

  it('uses elapsed time, rather than the number of irregular observations', () => {
    const series = new PowerWindowAggregator();
    // The second half has more samples, but exactly the same duration.
    for (let atMs = 0; atMs < 30_000; atMs += 3_000) observeAt(series, atMs, 1_000);
    for (let atMs = 30_000; atMs < 60_000; atMs += 1_000) observeAt(series, atMs, 3_000);
    expect(observeAt(series, 60_000, 9_000)).toEqual({ startMs: 0, endMs: 60_000, coverageMs: 60_000, powerW: 2_000 });
  });

  it('attributes an exact-boundary sample to the next window only', () => {
    const series = new PowerWindowAggregator();
    expect(minute(series, atMs => atMs < 60_000 ? 1_000 : 9_000)?.powerW).toBe(1_000);
    expect(minute(series, () => 9_000, 60_000)?.powerW).toBe(9_000);
  });

  it('preserves signed grid/import-export and already-projected solar watts without absolute values', () => {
    const grid = new PowerWindowAggregator();
    const solar = new PowerWindowAggregator();
    expect(minute(grid, atMs => atMs < 30_000 ? -3_000 : 1_000)?.powerW).toBe(-1_000);
    expect(minute(solar, () => 1_234)?.powerW).toBe(1_234);
  });

  it('does not round raw samples before integrating their strong fluctuations', () => {
    const series = new PowerWindowAggregator();
    // Prematurely rounded samples average to 0.333 W -> 0 W. Keeping raw
    // values for 40s at .49 W + 20s at 1.49 W yields 0.823 W -> 1 W.
    expect(minute(series, atMs => atMs < 40_000 ? 0.49 : 1.49)?.powerW).toBe(1);
    const swinging = new PowerWindowAggregator();
    expect(minute(swinging, atMs => (atMs / 2_000) % 2 === 0 ? -100_000.25 : 100_000.25)?.powerW).toBe(0);
  });

  it('weights from source poll-start times and never from delayed callback completion', () => {
    const series = new PowerWindowAggregator();
    for (let atMs = 0; atMs < 60_000; atMs += 2_000) observeAt(series, atMs, atMs < 30_000 ? 1_000 : 3_000, atMs % 4_000 === 0 ? 1_000 : 0);
    expect(observeAt(series, 60_000, 7_000, 1_000)?.powerW).toBe(2_000);
  });

  it('does not finalize a window by extrapolating the current sample to callback completion', () => {
    const series = new PowerWindowAggregator();
    for (let atMs = 0; atMs <= 58_000; atMs += 2_000) observeAt(series, atMs, 1_000);
    expect(observeAt(series, 59_000, 2_000, 1_500)).toBeUndefined();
    expect(observeAt(series, 61_000, 3_000)?.powerW).toBe(1_017);
  });

  it('allows one missed 2-second observation by holding its predecessor for at most four seconds', () => {
    const series = new PowerWindowAggregator();
    let completed: CompletedPowerWindow | undefined;
    for (let atMs = 0; atMs <= 60_000; atMs += 2_000) {
      if (atMs === 20_000) continue;
      completed = observeAt(series, atMs, 1_000) ?? completed;
    }
    expect(completed?.coverageMs).toBe(60_000);
    expect(completed?.powerW).toBe(1_000);
  });

  it('ends the preceding valid sample at the start of a failed poll and does not insert zero', () => {
    const series = new PowerWindowAggregator();
    const completed = minute(series, atMs => atMs === 20_000 ? undefined : 1_000);
    expect(completed).toEqual({ startMs: 0, endMs: 60_000, coverageMs: 58_000, powerW: 1_000 });
  });

  it('uses the failed poll start rather than its later callback for missing coverage', () => {
    const series = new PowerWindowAggregator();
    for (let atMs = 0; atMs <= 18_000; atMs += 2_000) observeAt(series, atMs, 1_000);
    observeAt(series, 20_000, undefined, 3_000);
    for (let atMs = 24_000; atMs < 60_000; atMs += 2_000) observeAt(series, atMs, 1_000);
    expect(observeAt(series, 60_000, 1_000)?.coverageMs).toBe(56_000);
  });

  it('never makes a complete average from just one isolated sample', () => {
    const series = new PowerWindowAggregator();
    observeAt(series, 0, 4_000);
    expect(observeAt(series, 60_000, 5_000)).toEqual({ startMs: 0, endMs: 60_000, coverageMs: 4_000, powerW: undefined });
  });

  it('includes a window with exactly 90% coverage and omits a window just below it', () => {
    const make = (gapEnd: number) => {
      const series = new PowerWindowAggregator();
      observeAt(series, 0, undefined);
      for (let atMs = gapEnd; atMs < 60_000; atMs += 2_000) observeAt(series, atMs, 1_234);
      return observeAt(series, 60_000, 1_234);
    };
    expect(make(6_000)).toEqual({ startMs: 0, endMs: 60_000, coverageMs: 54_000, powerW: 1_234 });
    expect(make(6_001)).toEqual({ startMs: 0, endMs: 60_000, coverageMs: 53_999, powerW: undefined });
  });

  it('starts the first minute at the first observation, even when it has no measurement', () => {
    const series = new PowerWindowAggregator();
    observeAt(series, 7_000, undefined);
    for (let atMs = 15_000; atMs < 67_000; atMs += 2_000) observeAt(series, atMs, 1_000);
    expect(observeAt(series, 67_000, 1_000)).toEqual({ startMs: 7_000, endMs: 67_000, coverageMs: 52_000, powerW: undefined });
  });

  it('keeps completely missing windows unavailable rather than reporting zero', () => {
    const series = new PowerWindowAggregator();
    expect(minute(series, () => undefined)).toEqual({ startMs: 0, endMs: 60_000, coverageMs: 0, powerW: undefined });
    expect(series.latest(60_000)).toBeUndefined();
  });

  it.each([NaN, Infinity, -Infinity])('does not include invalid power %s', invalid => {
    const series = new PowerWindowAggregator();
    const completed = minute(series, atMs => atMs === 20_000 ? invalid : 500);
    expect(completed?.coverageMs).toBe(58_000);
    expect(completed?.powerW).toBe(500);
  });

  it('ignores duplicate source timestamps rather than counting failed polls as repeated samples', () => {
    const series = new PowerWindowAggregator();
    observeAt(series, 0, 1_000);
    expect(series.observe(1_000, 0, 2_000)).toBeUndefined();
    expect(series.observe(1_000, 0, 4_000)).toBeUndefined();
    expect(series.observe(1_000, 0, 10_000)).toBeUndefined();
    expect(observeAt(series, 60_000, 2_000)?.powerW).toBeUndefined();
  });

  it('does not let conflicting duplicate samples renew or rewrite a completed average', () => {
    const series = new PowerWindowAggregator();
    minute(series, () => 1_000);
    expect(series.latest(60_000)?.powerW).toBe(1_000);
    expect(observeAt(series, 60_000, 9_000)).toBeUndefined();
    expect(series.latest(60_000)).toBeUndefined();
    expect(observeAt(series, 120_000, 9_000)?.powerW).toBeUndefined();
  });

  it('invalidates a cached mean immediately when current telemetry is invalid', () => {
    const series = new PowerWindowAggregator();
    minute(series, () => 1_000);
    expect(series.latest(61_000)?.powerW).toBe(1_000);
    observeAt(series, 62_000, undefined);
    expect(series.latest(62_000)).toBeUndefined();
    observeAt(series, 64_000, 2_000);
    expect(series.latest(64_000)).toBeUndefined();
    for (let atMs = 66_000; atMs < 120_000; atMs += 2_000) observeAt(series, atMs, 2_000);
    expect(observeAt(series, 120_000, 2_000)?.powerW).toBe(1_966);
  });

  it('never accepts an already-stale measurement as a new held value', () => {
    const series = new PowerWindowAggregator();
    for (let atMs = 0; atMs < 60_000; atMs += 2_000) observeAt(series, atMs, 1_000, 4_001);
    expect(observeAt(series, 60_000, 1_000, 4_001)?.powerW).toBeUndefined();
  });

  it('accepts the explicit four-second validity boundary, without extending it', () => {
    const series = new PowerWindowAggregator();
    expect(minute(series, () => 1_000)?.powerW).toBe(1_000);
    expect(observeAt(series, 62_000, 1_000, 4_000)).toBeUndefined();
    expect(series.latest(66_000)?.powerW).toBe(1_000);
  });

  it('returns only the most recent completed empty window after a long interruption', () => {
    const series = new PowerWindowAggregator();
    minute(series, () => 1_000);
    const yearsLater = 100 * 365 * 24 * 60 * 60_000;
    const result = observeAt(series, yearsLater, 2_000);
    expect(result).toEqual({ startMs: yearsLater - 60_000, endMs: yearsLater, coverageMs: 0, powerW: undefined });
    expect(series.latest(yearsLater)).toBeUndefined();
    expect(observeAt(series, yearsLater, 2_000)).toBeUndefined();
    expect(minute(series, () => 2_000, yearsLater)?.powerW).toBe(2_000);
  });

  it('does not replay a previously completed average after a missed minute', () => {
    const series = new PowerWindowAggregator();
    minute(series, () => 1_000);
    expect(series.latest(124_000)?.powerW).toBe(1_000);
    expect(series.latest(124_001)).toBeUndefined();
    expect(series.latest(125_000)).toBeUndefined();
  });

  it('does not revive a cached good-minute average after an unobserved telemetry gap', () => {
    const series = new PowerWindowAggregator();
    minute(series, () => 1_000);
    expect(series.latest(60_000)?.powerW).toBe(1_000);
    expect(observeAt(series, 80_000, 2_000)).toBeUndefined();
    expect(series.latest(80_000)).toBeUndefined();
    for (let atMs = 82_000; atMs < 120_000; atMs += 2_000) observeAt(series, atMs, 2_000);
    expect(observeAt(series, 120_000, 2_000)).toEqual({ startMs: 60_000, endMs: 120_000, coverageMs: 44_000, powerW: undefined });
    expect(series.latest(120_000)).toBeUndefined();
    expect(minute(series, () => 2_000, 120_000)?.powerW).toBe(2_000);
    expect(series.latest(180_000)?.powerW).toBe(2_000);
  });

  it('invalidates the old cache after a short gap while preserving sufficient current-minute coverage', () => {
    const series = new PowerWindowAggregator();
    minute(series, () => 1_000);
    observeAt(series, 66_000, 2_000);
    expect(series.latest(66_000)).toBeUndefined();
    for (let atMs = 68_000; atMs < 120_000; atMs += 2_000) observeAt(series, atMs, 2_000);
    expect(observeAt(series, 120_000, 2_000)).toEqual({ startMs: 60_000, endMs: 120_000, coverageMs: 58_000, powerW: 1_931 });
    expect(series.latest(120_000)?.powerW).toBe(1_931);
  });

  it('retains a cached mean across a sample gap of exactly four seconds', () => {
    const series = new PowerWindowAggregator();
    minute(series, () => 1_000);
    observeAt(series, 64_000, 2_000);
    expect(series.latest(64_000)?.powerW).toBe(1_000);
  });

  it('clears all in-memory data for restart, source binding change or explicit recovery reset', () => {
    const series = new PowerWindowAggregator();
    minute(series, () => 1_000);
    series.clear();
    expect(series.latest(60_000)).toBeUndefined();
    expect(observeAt(series, 100_000, 5_000)).toBeUndefined();
    expect(observeAt(series, 159_999, 5_000)).toBeUndefined();
    expect(observeAt(series, 160_000, 5_000)?.powerW).toBeUndefined();
    expect(minute(series, () => 5_000, 160_000)?.powerW).toBe(5_000);
  });

  it.each([NaN, Infinity, -1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 0.5])('clears data for an unsafe clock %s', invalidTime => {
    const series = new PowerWindowAggregator();
    minute(series, () => 1_000);
    expect(series.observe(1_000, invalidTime, invalidTime)).toBeUndefined();
    expect(series.latest(60_000)).toBeUndefined();
  });

  it('rejects future timestamps and retrograde callback clocks', () => {
    const future = new PowerWindowAggregator();
    minute(future, () => 1_000);
    expect(future.observe(1_000, 65_000, 64_000)).toBeUndefined();
    expect(future.latest(65_000)).toBeUndefined();
    const backwards = new PowerWindowAggregator();
    minute(backwards, () => 1_000);
    expect(backwards.observe(1_000, 59_000, 59_000)).toBeUndefined();
    expect(backwards.latest(60_000)).toBeUndefined();
  });

  it('rejects source timestamps older than the already processed source timeline', () => {
    const series = new PowerWindowAggregator();
    minute(series, () => 1_000);
    expect(series.observe(1_000, 59_000, 61_000)).toBeUndefined();
    expect(series.latest(61_000)).toBeUndefined();
    expect(observeAt(series, 62_000, 1_000)).toBeUndefined();
  });

  it('does not present cached windows after a status-read clock jumps backwards', () => {
    const series = new PowerWindowAggregator();
    minute(series, () => 1_000);
    observeAt(series, 62_000, 1_000);
    expect(series.latest(61_000)).toBeUndefined();
    expect(series.latest(62_000)).toBeUndefined();
  });

  it('discards pre-jump integral when status time moves backwards then returns to its former future', () => {
    const series = new PowerWindowAggregator();
    minute(series, () => 1_000);
    observeAt(series, 62_000, 1_000);
    expect(series.latest(61_000)).toBeUndefined();
    expect(observeAt(series, 64_000, 2_000)).toBeUndefined();
    for (let atMs = 66_000; atMs <= 120_000; atMs += 2_000) expect(observeAt(series, atMs, 2_000)).toBeUndefined();
    expect(observeAt(series, 124_000, 2_000)).toEqual({ startMs: 64_000, endMs: 124_000, coverageMs: 60_000, powerW: 2_000 });
  });

  it('does not treat a missing source timestamp as measured power', () => {
    const series = new PowerWindowAggregator();
    expect(series.observe(1_000, undefined, 0)).toBeUndefined();
    expect(series.observe(1_000, undefined, 60_000)).toEqual({ startMs: 0, endMs: 60_000, coverageMs: 0, powerW: undefined });
  });

  it('keeps independent series and preserves zero as a valid complete measurement', () => {
    const grid = new PowerWindowAggregator();
    const home = new PowerWindowAggregator();
    const solar = new PowerWindowAggregator();
    expect(minute(grid, () => -2_000)?.powerW).toBe(-2_000);
    expect(minute(home, () => 1_500)?.powerW).toBe(1_500);
    expect(minute(solar, () => 0)?.powerW).toBe(0);
    expect(grid.latest(60_000)?.powerW).toBe(-2_000);
    home.clear();
    expect(solar.latest(60_000)?.powerW).toBe(0);
  });
});
