import { describe, expect, it } from 'vitest';
import type { ControllerStatus } from '../../../src/domain/controller.js';
import { failure, success } from '../../../src/domain/errors.js';
import { TelemetryHealthGuard } from '../../../src/orchestration/telemetry-health.js';
import { controller } from '../load-management/helpers.js';

const valid = (grid = 17_000) => success(controller(grid));

describe('deterministic fresh controller telemetry gate', () => {
  it('starts unavailable without inventing zero and defaults to 4 s age / 10 s stability', () => {
    const guard = new TelemetryHealthGuard();
    expect(guard.maxAgeMs).toBe(4_000);
    expect(guard.recoveryStableMs).toBe(10_000);
    expect(guard.snapshot(0)).toEqual({ state: 'UNKNOWN', healthy: false, recoveryAllowed: false,
      gridImportW: null, sampledAtMs: null, stableSinceMs: null, reason: 'NO_TELEMETRY' });
  });

  it('permits reductions on first valid sample while recovery remains blocked', () => {
    expect(new TelemetryHealthGuard().observe(valid(22_839), 0, 0)).toMatchObject({
      state: 'STABILIZING', healthy: true, recoveryAllowed: false, gridImportW: 22_839, stableSinceMs: 0,
    });
  });

  it('opens recovery exactly at 10 s of continuous fresh samples', () => {
    const guard = new TelemetryHealthGuard();
    for (const timestamp of [0, 4_000, 8_000, 9_999]) {
      expect(guard.observe(valid(), timestamp, timestamp).recoveryAllowed).toBe(false);
    }
    expect(guard.observe(valid(), 10_000, 10_000)).toMatchObject({ state: 'HEALTHY', healthy: true, recoveryAllowed: true, stableSinceMs: 0 });
  });

  it('preserves continuity with 4 s sample starts and 10 ms HTTP completion latency', () => {
    const guard = new TelemetryHealthGuard();
    for (const sampledAtMs of [0, 4_000, 8_000]) {
      expect(guard.observe(valid(), sampledAtMs, sampledAtMs + 10)).toMatchObject({
        state: 'STABILIZING', healthy: true, recoveryAllowed: false, stableSinceMs: 0,
      });
    }
    expect(guard.observe(valid(), 12_000, 12_010)).toMatchObject({
      state: 'HEALTHY', healthy: true, recoveryAllowed: true, stableSinceMs: 0,
    });
    expect(guard.snapshot(12_010).recoveryAllowed).toBe(true);
  });

  it('a stale fault already exposed by snapshot resets stability even with a fresh in-flight sample', () => {
    const guard = new TelemetryHealthGuard();
    for (const sampledAtMs of [0, 4_000, 8_000, 12_000]) guard.observe(valid(), sampledAtMs, sampledAtMs + 10);
    expect(guard.snapshot(16_001)).toMatchObject({ state: 'FAULT', healthy: false, recoveryAllowed: false });
    // The read started before snapshot reported the old sample as stale; its
    // fresh result must not erase the observed fault or retain the old stability.
    expect(guard.observe(valid(), 16_000, 16_010)).toMatchObject({
      state: 'STABILIZING', recoveryAllowed: false, stableSinceMs: 16_000,
    });
    for (const sampledAtMs of [20_000, 24_000, 25_999]) {
      expect(guard.observe(valid(), sampledAtMs, sampledAtMs + 10).recoveryAllowed).toBe(false);
    }
    expect(guard.observe(valid(), 26_000, 26_010).recoveryAllowed).toBe(true);
  });

  it('a fresh incoming read after an excessive sample-start gap resets already established recovery', () => {
    const guard = new TelemetryHealthGuard();
    for (const sampledAtMs of [0, 4_000, 8_000, 12_000]) guard.observe(valid(), sampledAtMs, sampledAtMs + 10);
    expect(guard.observe(valid(), 16_001, 16_011)).toMatchObject({
      state: 'STABILIZING', healthy: true, recoveryAllowed: false, stableSinceMs: 16_001,
    });
  });

  it('allows exactly 4 s age and rejects any older reading', () => {
    const guard = new TelemetryHealthGuard();
    expect(guard.observe(valid(), 0, 4_000).healthy).toBe(true);
    expect(guard.snapshot(4_001)).toMatchObject({ state: 'FAULT', healthy: false, recoveryAllowed: false, gridImportW: null, reason: 'STALE_TELEMETRY' });
  });

  it('resets stability when sample gaps exceed the age limit', () => {
    const guard = new TelemetryHealthGuard();
    guard.observe(valid(), 0, 0);
    guard.observe(valid(), 4_000, 4_000);
    expect(guard.observe(valid(), 8_001, 8_001)).toMatchObject({ recoveryAllowed: false, stableSinceMs: 8_001 });
    for (const timestamp of [12_001, 16_001, 18_000]) guard.observe(valid(), timestamp, timestamp);
    expect(guard.snapshot(18_000).recoveryAllowed).toBe(false);
    expect(guard.observe(valid(), 18_001, 18_001).recoveryAllowed).toBe(true);
  });

  it('requires a new 10 s stabilization after a controller fault', () => {
    const guard = new TelemetryHealthGuard();
    for (const timestamp of [0, 4_000, 8_000, 10_000]) guard.observe(valid(), timestamp, timestamp);
    expect(guard.observe(failure('ConnectionError', 'Controller unavailable'), 11_000, 11_000)).toMatchObject({ reason: 'CONTROLLER_UNAVAILABLE', gridImportW: null });
    for (const timestamp of [12_000, 16_000, 20_000, 21_999]) {
      expect(guard.observe(valid(), timestamp, timestamp).recoveryAllowed).toBe(false);
    }
    expect(guard.observe(valid(), 22_000, 22_000)).toMatchObject({ recoveryAllowed: true, stableSinceMs: 12_000 });
  });

  it('preserves negative signed Grid as valid zero import, unlike unavailable Grid', () => {
    expect(new TelemetryHealthGuard().observe(valid(-500), 0, 0)).toMatchObject({ healthy: true, gridImportW: 0 });
    expect(new TelemetryHealthGuard().observe(failure('MissingMeasurementError', 'Grid missing'), 0, 0)).toMatchObject({ healthy: false, gridImportW: null });
  });

  it.each([
    { gridPowerW: Number.NaN }, { gridPowerW: Number.POSITIVE_INFINITY },
    { gridPowerW: null }, { gridImportW: null }, { gridImportW: Number.NaN },
    { gridImportW: -1 }, { gridImportW: 0 }, { reachable: false },
  ])('rejects invalid or inconsistent normalized values %j', (patch) => {
    const invalid = { ...controller(100), ...patch } as unknown as ControllerStatus;
    expect(new TelemetryHealthGuard().observe(success(invalid), 0, 0)).toMatchObject({
      healthy: false, recoveryAllowed: false, gridImportW: null, reason: 'INVALID_GRID',
    });
  });

  it.each([null, undefined, false])('fails safely on malformed normalized controller value %j', (input) => {
    const invalid = input as unknown as ControllerStatus;
    expect(new TelemetryHealthGuard().observe(success(invalid), 0, 0)).toMatchObject({ healthy: false, reason: 'INVALID_GRID' });
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('rejects invalid clocks %s', (now) => {
    expect(new TelemetryHealthGuard().observe(valid(), 0, now)).toMatchObject({ healthy: false, recoveryAllowed: false, gridImportW: null, reason: 'INVALID_CLOCK' });
  });

  it('rejects clock reversal and does not silently continue recovery', () => {
    const guard = new TelemetryHealthGuard();
    guard.observe(valid(), 1_000, 1_000);
    expect(guard.observe(valid(), 999, 999)).toMatchObject({ healthy: false, reason: 'INVALID_CLOCK' });
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 101])('rejects invalid/future sample time %s', (sampledAt) => {
    expect(new TelemetryHealthGuard().observe(valid(), sampledAt, 100)).toMatchObject({ healthy: false, reason: 'STALE_TELEMETRY' });
  });

  it('rejects nonmonotonic sample timestamps', () => {
    const guard = new TelemetryHealthGuard();
    guard.observe(valid(), 1_000, 1_000);
    expect(guard.observe(valid(), 999, 1_001)).toMatchObject({ healthy: false, reason: 'NON_MONOTONIC_TELEMETRY' });
  });

  it('replaying an old sample cannot build recovery stability', () => {
    const guard = new TelemetryHealthGuard();
    guard.observe(valid(), 0, 0);
    expect(guard.observe(valid(), 0, 3_999)).toMatchObject({ stableSinceMs: 0, recoveryAllowed: false });
    expect(guard.observe(valid(), 0, 10_000)).toMatchObject({ healthy: false, recoveryAllowed: false });
  });

  it('does not expose its mutable internal health state', () => {
    const guard = new TelemetryHealthGuard();
    const snapshot = guard.observe(valid(), 0, 0);
    const edited = snapshot as { gridImportW: number | null };
    edited.gridImportW = 0;
    expect(guard.snapshot(0).gridImportW).toBe(17_000);
  });

  it.each([{ age: 0, stable: 10_000 }, { age: 4_000, stable: 0 },
    { age: 4.5, stable: 10_000 }, { age: 4_000, stable: Number.MAX_SAFE_INTEGER + 1 }])('rejects unsafe policy %j', ({ age, stable }) => {
    expect(() => new TelemetryHealthGuard(age, stable)).toThrow();
  });
});
