import { describe, expect, it, vi } from 'vitest';
import type { ChargerConfig } from '../../../../src/config/config-types.js';
import { failure, success, type Result } from '../../../../src/domain/errors.js';
import { DEFAULT_ACTUATOR_POLICY, resolveActuatorPolicy, type ActuatorContext } from '../../../../src/goe/control/actuator-policy.js';
import { ChargerActuator } from '../../../../src/goe/control/charger-actuator.js';
import type { ChargerControlClient, ControlObservation, WriteGate } from '../../../../src/goe/control/control-types.js';
import { makeEmptyOwnership, validateOwnershipDocument, type OwnershipDocument, type OwnershipState, type OwnershipStore } from '../../../../src/goe/control/ownership-state.js';
import type { ControlAction } from '../../../../src/load-management/control-action.js';

const garage: ChargerConfig = { id: 'garage', name: 'Garage', host: 'charger-garage.test', enabled: true, priority: 1 };
const links: ChargerConfig = { id: 'links', name: 'Links', host: 'charger-links.test', enabled: true, priority: 20 };
const healthy: ActuatorContext = { telemetryHealthy: true, telemetrySampledAtMs: 1_000, recoveryAllowed: true, overrideActive: false, loadManagementEnabled: true };
const live: WriteGate = { executionMode: 'LIVE', realWritesEnabled: true };
const limit = (amps: number, chargerId = garage.id): ControlAction => ({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId, amps });
const pause: ControlAction = { type: 'PAUSE', chargerId: garage.id };
const resume: ControlAction = { type: 'RESUME', chargerId: garage.id };
const clear: ControlAction = { type: 'CLEAR_TEMPORARY_CURRENT_LIMIT', chargerId: garage.id };

function createHarness(options: { gate?: WriteGate; initial?: Partial<ControlObservation>; saved?: OwnershipDocument; configs?: readonly ChargerConfig[] } = {}) {
  const clock = { now: 1_000 };
  const configs = options.configs ?? [garage];
  const observations = new Map<string, ControlObservation>();
  for (const config of configs) observations.set(config.id, {
    chargerId: config.id, host: config.host, readStartedAtMs: clock.now, observedAtMs: clock.now,
    amp: 14, tcl: null, frc: 0, loe: false, car: 2, mca: 6, acu: 14,
    ama: 32, acp: true, mcpd: 0, alw: true, ...options.initial,
  });
  let document: OwnershipDocument | null = options.saved ?? null;
  const change = (patch: Partial<ControlObservation>, id = garage.id) => {
    const current = observations.get(id);
    if (current === undefined) throw new Error('Missing fake device.');
    observations.set(id, { ...current, ...patch });
  };
  const readStatus = vi.fn(async (config: ChargerConfig): Promise<Result<ControlObservation>> => {
    const status = observations.get(config.id);
    return status === undefined ? failure('ConnectionError', 'Fake unavailable')
      : success({ ...status, readStartedAtMs: clock.now, observedAtMs: clock.now });
  });
  const setTemporaryCurrentLimit = vi.fn(async (config: ChargerConfig, amps: number): Promise<Result<void>> => {
    change({ tcl: amps, acu: amps }, config.id);
    return success(undefined);
  });
  const clearTemporaryCurrentLimit = vi.fn(async (config: ChargerConfig): Promise<Result<void>> => {
    change({ tcl: null, acu: observations.get(config.id)?.amp ?? null }, config.id);
    return success(undefined);
  });
  const pauseDevice = vi.fn(async (config: ChargerConfig): Promise<Result<void>> => {
    change({ frc: 1, car: 4, acu: null, alw: false }, config.id);
    return success(undefined);
  });
  const resumeDevice = vi.fn(async (config: ChargerConfig): Promise<Result<void>> => {
    const status = observations.get(config.id);
    change({ frc: 0, car: 2, acu: status?.tcl ?? status?.amp ?? null, alw: true }, config.id);
    return success(undefined);
  });
  const client: ChargerControlClient = { readStatus, setTemporaryCurrentLimit, clearTemporaryCurrentLimit, pause: pauseDevice, resume: resumeDevice };
  const load = vi.fn(async (): Promise<Result<OwnershipDocument | null>> => success(structuredClone(document)));
  const save = vi.fn(async (value: OwnershipDocument): Promise<Result<void>> => {
    const parsed = validateOwnershipDocument(value);
    if (!parsed.ok) return parsed;
    document = structuredClone(parsed.value);
    return success(undefined);
  });
  const store: OwnershipStore = { load, save };
  const sleep = vi.fn(async () => undefined);
  const actuator = new ChargerActuator({ client, store, gate: options.gate ?? live, now: () => clock.now, sleep });
  return {
    actuator, client, store, clock, change, readStatus, setTemporaryCurrentLimit,
    clearTemporaryCurrentLimit, pauseDevice, resumeDevice, load, save, sleep,
    document: () => structuredClone(document),
    initialize: () => actuator.initialize(configs),
    context: (): ActuatorContext => ({ ...healthy, telemetrySampledAtMs: clock.now }),
    writeCount: () => setTemporaryCurrentLimit.mock.calls.length + clearTemporaryCurrentLimit.mock.calls.length + pauseDevice.mock.calls.length + resumeDevice.mock.calls.length,
  };
}

function persistedOwned(overrides: Partial<OwnershipState> = {}): OwnershipDocument {
  const baseline: ControlObservation = {
    chargerId: garage.id, host: garage.host, readStartedAtMs: 100, observedAtMs: 100,
    amp: 14, tcl: null, frc: 0, loe: false, car: 2, mca: 6, acu: 14,
    ama: 32, acp: true, mcpd: 0, alw: true,
  };
  const readback = { ...baseline, tcl: 10, acu: 10, readStartedAtMs: 200, observedAtMs: 200 };
  return { version: 1, chargers: [{
    ...makeEmptyOwnership(garage, 200), baseline, pluginOwnedTcl: 10,
    lastObservedState: readback, lastReadback: readback,
    lastConfirmedWrite: { action: limit(10), confirmedAtMs: 200 }, ownershipStatus: 'OWNED',
    ...overrides,
  }] };
}

describe('ChargerActuator live gate and input boundaries', () => {
  it.each([
    ['HCU_DEV', false, false], ['HCU_DEV', true, false],
    ['DRY_RUN', false, false], ['DRY_RUN', true, false],
    ['LIVE', false, false], ['LIVE', true, true],
  ] as const)('%s and flag %s permits writes: %s', async (executionMode, realWritesEnabled, allowed) => {
    const h = createHarness({ gate: { executionMode, realWritesEnabled } });
    expect((await h.initialize()).ok).toBe(true);
    const result = await h.actuator.execute(limit(13), garage, healthy);
    expect(result.status).toBe(allowed ? 'CONFIRMED' : 'BLOCKED');
    expect(h.writeCount()).toBe(allowed ? 1 : 0);
    if (!allowed) expect(h.readStatus).toHaveBeenCalledTimes(1);
  });

  it('copies the gate so caller mutation cannot promote a DEV actuator', async () => {
    const gate = { executionMode: 'HCU_DEV' as const, realWritesEnabled: true };
    const h = createHarness({ gate });
    await h.initialize();
    Object.assign(gate, { executionMode: 'LIVE' });
    expect((await h.actuator.execute(limit(13), garage, healthy)).code).toBe('WRITE_BLOCKED');
    expect(h.writeCount()).toBe(0);
  });

  it('requires initialization before any network operation in execute', async () => {
    const h = createHarness();
    expect((await h.actuator.execute(limit(13), garage, healthy)).code).toBe('ACTUATOR_NOT_INITIALIZED');
    expect(h.readStatus).not.toHaveBeenCalled();
  });

  it('never polls or writes a disabled charger', async () => {
    const disabled = { ...garage, enabled: false, host: '' };
    const h = createHarness({ configs: [disabled] });
    await h.initialize();
    expect((await h.actuator.execute(limit(13), disabled, healthy)).code).toBe('CHARGER_DISABLED');
    expect(h.readStatus).not.toHaveBeenCalled();
    expect(h.writeCount()).toBe(0);
  });

  it('rejects a host changed after startup reconciliation', async () => {
    const h = createHarness(); await h.initialize();
    expect((await h.actuator.execute(limit(13), { ...garage, host: 'another-charger.test' }, healthy)).code).toBe('CHARGER_NOT_RECONCILED');
    expect(h.writeCount()).toBe(0);
  });

  it('rejects an action for another charger', async () => {
    const h = createHarness(); await h.initialize();
    expect((await h.actuator.execute(limit(13, 'links'), garage, healthy)).code).toBe('CHARGER_IDENTITY_MISMATCH');
    expect(h.writeCount()).toBe(0);
  });

  it.each([0, 5, 15, 1.5, NaN, Infinity])('rejects unsafe current %s without writes', async amps => {
    const h = createHarness(); await h.initialize();
    expect((await h.actuator.execute(limit(amps), garage, healthy)).code).toBe('INVALID_CURRENT_LIMIT');
    expect(h.writeCount()).toBe(0);
  });

  it('respects the measured device minimum instead of hardcoding 6 A', async () => {
    const h = createHarness({ initial: { mca: 8 } }); await h.initialize();
    expect((await h.actuator.execute(limit(7), garage, healthy)).status).toBe('BLOCKED');
    expect((await h.actuator.execute(limit(8), garage, healthy)).status).toBe('CONFIRMED');
  });

  it('honors the measured device maximum', async () => {
    const h = createHarness({ initial: { ama: 12 } }); await h.initialize();
    expect((await h.actuator.execute(limit(13), garage, healthy)).status).toBe('BLOCKED');
    expect(h.writeCount()).toBe(0);
  });
});

describe('baseline, temporary current ownership and readback', () => {
  it('persists the baseline and pending intent before writing, and claims after readback', async () => {
    const h = createHarness(); await h.initialize();
    h.setTemporaryCurrentLimit.mockImplementationOnce(async (_config, amps) => {
      const saved = h.document()?.chargers[0];
      expect(saved?.baseline).toMatchObject({ amp: 14, tcl: null, frc: 0, loe: false, car: 2, mca: 6, acu: 14 });
      expect(saved?.ownershipStatus).toBe('RECONCILING');
      expect(saved?.pluginOwnedTcl).toBeNull();
      expect(saved?.pendingWrite).toMatchObject({ action: limit(13), expectedTcl: 13, expectedFrc: 0 });
      h.change({ tcl: amps, acu: amps }); return success(undefined);
    });
    expect(await h.actuator.execute(limit(13), garage, healthy)).toMatchObject({ status: 'CONFIRMED', writeAttempted: true, attempts: 1, readAttempts: 2 });
    expect(h.actuator.states[0]).toMatchObject({ pluginOwnedTcl: 13, ownershipStatus: 'OWNED', pendingWrite: null });
    expect(h.readStatus).toHaveBeenCalledTimes(3);
  });

  it('never loosens an external 8 A limit to 10 A', async () => {
    const h = createHarness({ initial: { tcl: 8, acu: 8 } }); await h.initialize();
    expect((await h.actuator.execute(limit(10), garage, healthy)).code).toBe('EXTERNAL_LIMIT_PRESERVED');
    expect(h.writeCount()).toBe(0);
    expect(h.actuator.states[0]?.pluginOwnedTcl).toBeNull();
  });

  it('reduces an external 12 A limit to 10 A and CLEAR restores 12 rather than null', async () => {
    const h = createHarness({ initial: { tcl: 12, acu: 12 } }); await h.initialize();
    expect((await h.actuator.execute(limit(10), garage, healthy)).status).toBe('CONFIRMED');
    expect((await h.actuator.execute(clear, garage, healthy)).status).toBe('CONFIRMED');
    expect(h.setTemporaryCurrentLimit.mock.calls.map(([, amps]) => amps)).toEqual([10, 12]);
    expect(h.clearTemporaryCurrentLimit).not.toHaveBeenCalled();
    expect(h.actuator.states[0]).toMatchObject({ pluginOwnedTcl: null, ownershipStatus: 'NONE' });
  });

  it('supports the engine numeric-baseline SET release during override', async () => {
    const h = createHarness({ initial: { tcl: 12, acu: 12 } }); await h.initialize();
    await h.actuator.execute(limit(10), garage, healthy);
    expect((await h.actuator.execute(limit(12), garage, { ...healthy, overrideActive: true })).status).toBe('CONFIRMED');
    expect(h.actuator.states[0]).toMatchObject({ pluginOwnedTcl: null, ownershipStatus: 'NONE' });
    expect(h.clearTemporaryCurrentLimit).not.toHaveBeenCalled();
  });

  it('numeric-baseline restoration is still blocked during telemetry stabilization', async () => {
    const h = createHarness({ initial: { tcl: 12, acu: 12 } }); await h.initialize();
    await h.actuator.execute(limit(10), garage, healthy);
    expect((await h.actuator.execute(limit(12), garage, { ...healthy, overrideActive: true, recoveryAllowed: false })).code).toBe('RECOVERY_NOT_STABLE');
    expect(h.writeCount()).toBe(1);
  });

  it('never deletes an external limit without its own confirmed ownership', async () => {
    const h = createHarness({ initial: { tcl: 8, acu: 8 } }); await h.initialize();
    expect((await h.actuator.execute(clear, garage, healthy)).code).toBe('TEMPORARY_LIMIT_NOT_OWNED');
    expect(h.writeCount()).toBe(0);
  });

  it('preserves external changes rather than fighting a user', async () => {
    const h = createHarness(); await h.initialize();
    await h.actuator.execute(limit(10), garage, healthy);
    h.change({ tcl: 8, acu: 8 });
    expect((await h.actuator.execute(limit(9), garage, healthy)).code).toBe('EXTERNAL_TCL_CHANGE');
    expect(h.actuator.states[0]?.ownershipStatus).toBe('CONFLICT');
    expect((await h.actuator.execute(clear, garage, healthy)).status).toBe('CONFLICT');
    expect(h.writeCount()).toBe(1);
  });

  it('does not treat HTTP success with wrong readback as ownership', async () => {
    const h = createHarness(); await h.initialize();
    h.setTemporaryCurrentLimit.mockResolvedValueOnce(success(undefined));
    expect((await h.actuator.execute(limit(13), garage, healthy)).status).toBe('READBACK_MISMATCH');
    expect(h.actuator.states[0]).toMatchObject({ ownershipStatus: 'UNKNOWN', pluginOwnedTcl: null });
    expect(h.actuator.states[0]?.pendingWrite).not.toBeNull();
    expect((await h.actuator.execute(clear, garage, healthy)).status).toBe('BLOCKED');
  });

  it.each(['amp', 'loe', 'mca', 'ama', 'acp', 'mcpd'] as const)('rejects a simultaneous %s control change during readback', async key => {
    const h = createHarness(); await h.initialize();
    h.setTemporaryCurrentLimit.mockImplementationOnce(async (_config, amps) => {
      const patch: Partial<ControlObservation> = key === 'amp' ? { amp: 12 }
        : key === 'loe' ? { loe: true } : key === 'mca' ? { mca: 8 }
          : key === 'ama' ? { ama: 24 } : key === 'acp' ? { acp: false } : { mcpd: 10 };
      h.change({ ...patch, tcl: amps, acu: amps }); return success(undefined);
    });
    expect((await h.actuator.execute(limit(13), garage, healthy)).status).toBe('READBACK_MISMATCH');
    expect(h.actuator.states[0]?.ownershipStatus).toBe('UNKNOWN');
  });

  it('reports a failed write with diagnostic readback but without a speculative ownership claim or write retry', async () => {
    const h = createHarness(); await h.initialize();
    h.setTemporaryCurrentLimit.mockResolvedValueOnce(failure('TimeoutError', 'SECRET native payload'));
    const result = await h.actuator.execute(limit(13), garage, healthy);
    expect(result).toMatchObject({ status: 'FAILED', attempts: 1, readAttempts: 2 });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(h.setTemporaryCurrentLimit).toHaveBeenCalledTimes(1);
    expect(h.actuator.states[0]?.ownershipStatus).toBe('UNKNOWN');
    expect(h.actuator.states[0]?.lastReadback).toMatchObject({ tcl: null });
  });

  it('a timed-out write accepted by the fake device remains UNKNOWN even with matching diagnostic readback', async () => {
    const h = createHarness(); await h.initialize();
    h.setTemporaryCurrentLimit.mockImplementationOnce(async (_config, amps) => {
      h.change({ tcl: amps, acu: amps });
      return failure('TimeoutError', 'Fake acknowledgement timeout');
    });
    expect(await h.actuator.execute(limit(13), garage, healthy)).toMatchObject({
      status: 'FAILED', attempts: 1, readAttempts: 2,
    });
    expect(h.actuator.states[0]).toMatchObject({ ownershipStatus: 'UNKNOWN', pluginOwnedTcl: null });
    expect(h.actuator.states[0]?.lastReadback).toMatchObject({ tcl: 13, acu: 13 });
    expect(h.actuator.states[0]?.pendingWrite).not.toBeNull();
    expect(h.setTemporaryCurrentLimit).toHaveBeenCalledTimes(1);
    expect((await h.actuator.execute(clear, garage, healthy)).status).toBe('BLOCKED');
  });

  it('write timeout followed by diagnostic readback timeout remains safe and bounded', async () => {
    const h = createHarness(); await h.initialize();
    h.setTemporaryCurrentLimit.mockImplementationOnce(async () => {
      h.readStatus.mockResolvedValue(failure('TimeoutError', 'Fake readback timeout'));
      return failure('TimeoutError', 'Fake write timeout');
    });
    expect(await h.actuator.execute(limit(13), garage, healthy)).toMatchObject({
      status: 'FAILED', attempts: 1, readAttempts: 4,
    });
    expect(h.actuator.states[0]).toMatchObject({ ownershipStatus: 'UNKNOWN', lastReadback: null, pluginOwnedTcl: null });
    expect(h.sleep).toHaveBeenCalledTimes(2);
    expect(h.writeCount()).toBe(1);
  });

  it('an invalid write acknowledgement still triggers diagnostic readback and never CONFIRMED', async () => {
    const h = createHarness(); await h.initialize();
    h.setTemporaryCurrentLimit.mockResolvedValueOnce(failure('InvalidResponseError', 'Fake invalid acknowledgement'));
    expect(await h.actuator.execute(limit(13), garage, healthy)).toMatchObject({
      status: 'FAILED', attempts: 1, readAttempts: 2,
    });
    expect(h.readStatus).toHaveBeenCalledTimes(3);
    expect(h.actuator.states[0]?.ownershipStatus).toBe('UNKNOWN');
    expect(h.writeCount()).toBe(1);
  });

  it('contains thrown write exceptions and never retries an uncertain write', async () => {
    const h = createHarness(); await h.initialize();
    h.setTemporaryCurrentLimit.mockRejectedValueOnce(new Error('SECRET'));
    expect((await h.actuator.execute(limit(13), garage, healthy)).status).toBe('FAILED');
    expect(h.writeCount()).toBe(1);
  });

  it('does not lose ownership when the strict client definitively blocks unverified clear syntax', async () => {
    const h = createHarness(); await h.initialize();
    await h.actuator.execute(limit(13), garage, healthy);
    h.clearTemporaryCurrentLimit.mockResolvedValueOnce(failure('ConfigurationError', 'WRITE_BLOCKED: TCL_CLEAR_SEMANTICS_UNVERIFIED.'));
    expect(await h.actuator.execute(clear, garage, healthy)).toMatchObject({ status: 'BLOCKED', writeAttempted: false, attempts: 0 });
    expect(h.actuator.states[0]).toMatchObject({ pluginOwnedTcl: 13, ownershipStatus: 'OWNED', pendingWrite: null });
  });

  it('returns state copies that cannot mutate actuator ownership', async () => {
    const h = createHarness(); await h.initialize();
    await h.actuator.execute(limit(13), garage, healthy);
    Object.assign(h.actuator.states[0] ?? {}, { pluginOwnedTcl: 30 });
    Object.assign(h.actuator.lastResult ?? {}, { code: 'MUTATED' });
    expect(h.actuator.states[0]?.pluginOwnedTcl).toBe(13);
    expect(h.actuator.lastResult?.code).toBe('CONFIRMED');
  });
});

describe('pause, resume and override ownership', () => {
  it('requires RESUME before any non-refresh temporary current action for an owned pause', async () => {
    const h = createHarness(); await h.initialize();
    await h.actuator.execute(limit(6), garage, healthy);
    await h.actuator.execute(pause, garage, healthy);
    expect((await h.actuator.execute(limit(7), garage, healthy)).code).toBe('RESUME_REQUIRED_FIRST');
    expect(h.setTemporaryCurrentLimit).toHaveBeenCalledTimes(1);
  });

  it('honors the measured minimum pause duration even for explicitly requested override resume', async () => {
    const h = createHarness({ initial: { amp: 6, acu: 6, mcpd: 4_000 } }); await h.initialize();
    await h.actuator.execute(pause, garage, healthy);
    expect((await h.actuator.execute(resume, garage, { ...healthy, overrideActive: true })).code).toBe('MINIMUM_PAUSE_DURATION_NOT_REACHED');
    h.clock.now += 4_000;
    expect((await h.actuator.execute(resume, garage, { ...h.context(), overrideActive: true })).status).toBe('CONFIRMED');
    expect(h.resumeDevice).toHaveBeenCalledTimes(1);
  });

  it('claims a pause only after confirmed frc=1 and resumes before clearing its tcl', async () => {
    const h = createHarness(); await h.initialize();
    await h.actuator.execute(limit(6), garage, healthy);
    expect((await h.actuator.execute(pause, garage, healthy)).status).toBe('CONFIRMED');
    expect(h.actuator.states[0]?.pluginOwnedPause).toBe(true);
    expect((await h.actuator.execute(clear, garage, { ...healthy, overrideActive: true })).code).toBe('RESUME_REQUIRED_FIRST');
    expect((await h.actuator.execute(resume, garage, { ...healthy, overrideActive: true })).status).toBe('CONFIRMED');
    expect(h.actuator.states[0]).toMatchObject({ pluginOwnedPause: false, pluginOwnedTcl: 6 });
    expect((await h.actuator.execute(clear, garage, { ...healthy, overrideActive: true })).status).toBe('CONFIRMED');
    expect(h.pauseDevice).toHaveBeenCalledTimes(1);
    expect(h.resumeDevice).toHaveBeenCalledTimes(1);
    expect(h.actuator.states[0]?.ownershipStatus).toBe('NONE');
  });

  it('never resumes a pre-existing external frc=1 pause', async () => {
    const h = createHarness({ initial: { frc: 1, car: 4, acu: null, alw: false } }); await h.initialize();
    expect((await h.actuator.execute(resume, garage, { ...healthy, overrideActive: true })).code).toBe('PAUSE_NOT_OWNED');
    expect(h.resumeDevice).not.toHaveBeenCalled();
  });

  it('preserves an external pause even while removing its own temporary limit', async () => {
    const h = createHarness({ initial: { frc: 1, car: 4, acu: null, alw: false } }); await h.initialize();
    await h.actuator.execute(limit(10), garage, healthy);
    expect((await h.actuator.execute(clear, garage, healthy)).status).toBe('CONFIRMED');
    expect(h.resumeDevice).not.toHaveBeenCalled();
    expect(h.document()?.chargers[0]?.lastReadback?.frc).toBe(1);
  });

  it('does not repeat PAUSE for its own paused charger', async () => {
    const h = createHarness({ initial: { amp: 6, acu: 6 } }); await h.initialize();
    expect((await h.actuator.execute(pause, garage, healthy)).status).toBe('CONFIRMED');
    expect((await h.actuator.execute(pause, garage, healthy)).code).toBe('PAUSE_NOT_OWNABLE');
    expect(h.pauseDevice).toHaveBeenCalledTimes(1);
  });

  it('does not claim a pause if frc remains neutral despite HTTP success', async () => {
    const h = createHarness({ initial: { amp: 6, acu: 6 } }); await h.initialize();
    h.pauseDevice.mockResolvedValueOnce(success(undefined));
    expect((await h.actuator.execute(pause, garage, healthy)).status).toBe('READBACK_MISMATCH');
    expect(h.actuator.states[0]?.pluginOwnedPause).toBe(false);
  });

  it('reports an external frc change instead of re-pausing or resuming', async () => {
    const h = createHarness({ initial: { amp: 6, acu: 6 } }); await h.initialize();
    await h.actuator.execute(pause, garage, healthy);
    h.change({ frc: 0 });
    expect((await h.actuator.execute(resume, garage, healthy)).code).toBe('EXTERNAL_FRC_CHANGE');
    expect(h.pauseDevice).toHaveBeenCalledTimes(1);
    expect(h.resumeDevice).not.toHaveBeenCalled();
  });

  it.each([
    [{ acp: false }, 'CHARGER_NOT_PAUSABLE'], [{ car: 1 }, 'CHARGER_NOT_PAUSABLE'],
    [{ car: 4 }, 'CHARGER_NOT_PAUSABLE'], [{ acu: 7, amp: 7 }, 'MINIMUM_CURRENT_NOT_REACHED'],
  ] as const)('requires an active pausable charger at minimum: %j', async (initial, code) => {
    const h = createHarness({ initial: { amp: 6, acu: 6, ...initial } }); await h.initialize();
    expect((await h.actuator.execute(pause, garage, healthy)).code).toBe(code);
    expect(h.pauseDevice).not.toHaveBeenCalled();
  });

  it('blocks new reductions and pauses during override', async () => {
    const h = createHarness({ initial: { amp: 6, acu: 6 } }); await h.initialize();
    expect((await h.actuator.execute(limit(6), garage, { ...healthy, overrideActive: true })).code).toBe('OVERRIDE_ACTIVE');
    expect((await h.actuator.execute(pause, garage, { ...healthy, overrideActive: true })).code).toBe('OVERRIDE_ACTIVE');
    expect(h.writeCount()).toBe(0);
  });
});

describe('pre-write safety, telemetry faults and retries', () => {
  it.each([null, -1, 1_001, 0.5, NaN])('rejects missing, future or invalid Grid sample timestamp %s', async telemetrySampledAtMs => {
    const h = createHarness(); await h.initialize();
    expect((await h.actuator.execute(limit(13), garage, { ...healthy, telemetrySampledAtMs })).code).toBe('GRID_TELEMETRY_STALE');
    expect(h.writeCount()).toBe(0);
  });

  it('rechecks Grid age after transient charger reads, before the write', async () => {
    const h = createHarness(); await h.initialize();
    h.readStatus.mockImplementationOnce(async () => {
      h.clock.now += 4_001; return failure('TimeoutError', 'Delayed charger response');
    });
    expect((await h.actuator.execute(limit(13), garage, healthy)).code).toBe('GRID_TELEMETRY_STALE');
    expect(h.writeCount()).toBe(0);
  });

  it.each([true, null])('never writes with native load balancing %s', async loe => {
    const h = createHarness({ initial: { loe } }); await h.initialize();
    expect((await h.actuator.execute(limit(13), garage, healthy)).status).toBe(loe === true ? 'CONFLICT' : 'BLOCKED');
    expect(h.writeCount()).toBe(0);
  });

  it('detects loe enabled after startup before the first write', async () => {
    const h = createHarness(); await h.initialize(); h.change({ loe: true });
    expect((await h.actuator.execute(limit(13), garage, healthy)).code).toBe('NATIVE_LOAD_BALANCING_CONFLICT');
    expect(h.writeCount()).toBe(0);
  });

  it.each([limit(13), clear, resume, pause])('grid faults block %j and preserve confirmed restrictions', async action => {
    const h = createHarness(); await h.initialize();
    await h.actuator.execute(limit(6), garage, healthy);
    const before = h.actuator.states;
    expect((await h.actuator.execute(action, garage, { ...healthy, telemetryHealthy: false })).code).toBe('GRID_TELEMETRY_FAULT');
    expect(h.actuator.states).toEqual(before);
    expect(h.writeCount()).toBe(1);
  });

  it('blocks upward recovery while allowing a further reduction during stabilization', async () => {
    const h = createHarness(); await h.initialize();
    await h.actuator.execute(limit(10), garage, healthy);
    const stabilizing = { ...healthy, recoveryAllowed: false };
    expect((await h.actuator.execute(limit(11), garage, stabilizing)).code).toBe('RECOVERY_NOT_STABLE');
    expect((await h.actuator.execute(clear, garage, stabilizing)).code).toBe('RECOVERY_NOT_STABLE');
    expect((await h.actuator.execute(limit(9), garage, stabilizing)).status).toBe('CONFIRMED');
  });

  it('blocks RESUME before telemetry recovery stabilization', async () => {
    const h = createHarness({ initial: { amp: 6, acu: 6 } }); await h.initialize();
    await h.actuator.execute(pause, garage, healthy);
    expect((await h.actuator.execute(resume, garage, { ...healthy, recoveryAllowed: false })).code).toBe('RECOVERY_NOT_STABLE');
    expect(h.resumeDevice).not.toHaveBeenCalled();
  });

  it.each([
    { readStartedAtMs: -1, observedAtMs: 1_000 },
    { readStartedAtMs: 6_000, observedAtMs: 6_000 },
    { readStartedAtMs: 1_000, observedAtMs: 999 },
    { readStartedAtMs: 0, observedAtMs: 1_000 },
  ])('rejects stale or inconsistent status timestamps %j', async timestamps => {
    const h = createHarness(); await h.initialize(); h.clock.now = 5_001;
    const read = await h.client.readStatus(garage);
    if (!read.ok) throw new Error('Expected fake status');
    h.readStatus.mockResolvedValueOnce(success({ ...read.value, ...timestamps }));
    expect((await h.actuator.execute(limit(13), garage, h.context())).code).toBe('STALE_OR_INVALID_CHARGER_STATUS');
    expect(h.writeCount()).toBe(0);
  });

  it('checks status freshness again after slow persistence', async () => {
    const h = createHarness(); await h.initialize();
    h.save.mockImplementationOnce(async () => { h.clock.now += 4_001; return success(undefined); });
    expect((await h.actuator.execute(limit(13), garage, healthy)).code).toBe('GRID_TELEMETRY_STALE');
    expect(h.writeCount()).toBe(0);
  });

  it('limits failed pre-write GET retries to three attempts and sends no command', async () => {
    const h = createHarness(); await h.initialize();
    h.readStatus.mockResolvedValue(failure('TimeoutError', 'Fake timeout'));
    const result = await h.actuator.execute(limit(13), garage, healthy);
    expect(result).toMatchObject({ status: 'UNREACHABLE', attempts: 0, readAttempts: 3 });
    expect(h.sleep).toHaveBeenCalledTimes(2);
    expect(h.writeCount()).toBe(0);
    expect(h.actuator.states[0]?.ownershipStatus).toBe('UNKNOWN');
  });

  it('retries transient status failures and writes only after a successful fresh read', async () => {
    const h = createHarness(); await h.initialize();
    h.readStatus.mockResolvedValueOnce(failure('TimeoutError', 'Fake timeout'));
    expect(await h.actuator.execute(limit(13), garage, healthy)).toMatchObject({ status: 'CONFIRMED', attempts: 1, readAttempts: 3 });
    expect(h.sleep).toHaveBeenCalledTimes(1);
    expect(h.writeCount()).toBe(1);
  });

  it('does not retry invalid response structure', async () => {
    const h = createHarness(); await h.initialize();
    h.readStatus.mockResolvedValueOnce(failure('InvalidResponseError', 'Bad response'));
    expect((await h.actuator.execute(limit(13), garage, healthy)).readAttempts).toBe(1);
    expect(h.sleep).not.toHaveBeenCalled();
    expect(h.writeCount()).toBe(0);
  });

  it('contains thrown read exceptions and exhausts only bounded GET retries', async () => {
    const h = createHarness(); await h.initialize();
    h.readStatus.mockRejectedValue(new Error('SECRET'));
    expect((await h.actuator.execute(limit(13), garage, healthy)).status).toBe('UNREACHABLE');
    expect(h.readStatus).toHaveBeenCalledTimes(4);
  });

  it('readback timeout never confirms a write and is not followed by another write', async () => {
    const h = createHarness(); await h.initialize();
    h.setTemporaryCurrentLimit.mockImplementationOnce(async (_config, amps) => {
      h.change({ tcl: amps });
      h.readStatus.mockResolvedValue(failure('TimeoutError', 'Readback timeout'));
      return success(undefined);
    });
    expect(await h.actuator.execute(limit(13), garage, healthy)).toMatchObject({ status: 'READBACK_FAILED', attempts: 1, readAttempts: 4 });
    expect(h.writeCount()).toBe(1);
    expect(h.actuator.states[0]?.pluginOwnedTcl).toBeNull();
  });

  it('an unreachable charger does not prevent a separate reachable charger action', async () => {
    const h = createHarness({ configs: [garage, links] }); await h.initialize();
    const normalRead = h.readStatus.getMockImplementation();
    h.readStatus.mockImplementation(async config => config.id === links.id
      ? failure('ConnectionError', 'Fake unreachable') : normalRead!(config));
    expect((await h.actuator.execute(limit(13, links.id), links, healthy)).status).toBe('UNREACHABLE');
    expect((await h.actuator.execute(limit(13), garage, healthy)).status).toBe('CONFIRMED');
    expect(h.setTemporaryCurrentLimit).toHaveBeenCalledTimes(1);
  });
});

describe('ownership persistence, restart and safe shutdown', () => {
  it('a consent change cancels an action still waiting for the pre-write read', async () => {
    const h = createHarness(); await h.initialize();
    const originalRead = h.readStatus.getMockImplementation();
    h.readStatus.mockImplementationOnce(async config => {
      h.actuator.cancelPendingOperations();
      if (originalRead === undefined) throw new Error('Missing fake read');
      return originalRead(config);
    });
    expect((await h.actuator.execute(limit(13), garage, healthy)).code).toBe('OPERATION_CANCELLED');
    expect(h.writeCount()).toBe(0);
  });

  it('a consent change after saving intent cancels and removes that unsent intent', async () => {
    const h = createHarness(); await h.initialize();
    const originalSave = h.save.getMockImplementation();
    h.save.mockImplementationOnce(async document => {
      h.actuator.cancelPendingOperations();
      if (originalSave === undefined) throw new Error('Missing fake save');
      return originalSave(document);
    });
    expect((await h.actuator.execute(limit(13), garage, healthy)).code).toBe('OPERATION_CANCELLED');
    expect(h.actuator.states[0]).toMatchObject({ ownershipStatus: 'NONE', pendingWrite: null });
    expect(h.writeCount()).toBe(0);
  });

  it('an already transmitted write still receives readback even if consent changes in flight', async () => {
    const h = createHarness(); await h.initialize();
    h.setTemporaryCurrentLimit.mockImplementationOnce(async (_config, amps) => {
      h.actuator.cancelPendingOperations();
      h.change({ tcl: amps, acu: amps }); return success(undefined);
    });
    expect((await h.actuator.execute(limit(13), garage, healthy)).status).toBe('CONFIRMED');
    expect(h.actuator.states[0]?.pluginOwnedTcl).toBe(13);
    expect(h.writeCount()).toBe(1);
  });

  it('reconstructs a persisted confirmed own pause conservatively and performs no write at startup', async () => {
    const saved = persistedOwned();
    const state = saved.chargers[0];
    if (state?.lastReadback === null || state?.lastReadback === undefined) throw new Error('Missing fake readback');
    const readback = { ...state.lastReadback, frc: 1, car: 4, acu: null, alw: false };
    const ownedPause: OwnershipDocument = { version: 1, chargers: [{
      ...state, pluginOwnedPause: true, lastReadback: readback, lastObservedState: readback,
      lastConfirmedWrite: { action: pause, confirmedAtMs: readback.observedAtMs },
    }] };
    const h = createHarness({ saved: ownedPause, initial: { tcl: 10, frc: 1, car: 4, acu: null, alw: false } });
    expect((await h.initialize()).ok).toBe(true);
    expect(h.actuator.states[0]).toMatchObject({ pluginOwnedPause: true, ownershipStatus: 'OWNED' });
    expect(h.writeCount()).toBe(0);
  });

  it('a confirmed own pause externally released before restart is never re-applied', async () => {
    const saved = persistedOwned();
    const state = saved.chargers[0];
    if (state?.lastReadback === null || state?.lastReadback === undefined) throw new Error('Missing fake readback');
    const readback = { ...state.lastReadback, frc: 1, car: 4, acu: null, alw: false };
    const ownedPause: OwnershipDocument = { version: 1, chargers: [{
      ...state, pluginOwnedPause: true, lastReadback: readback, lastObservedState: readback,
      lastConfirmedWrite: { action: pause, confirmedAtMs: readback.observedAtMs },
    }] };
    const h = createHarness({ saved: ownedPause, initial: { tcl: 10, frc: 0, acu: 10 } }); await h.initialize();
    expect(h.actuator.states[0]).toMatchObject({ ownershipStatus: 'CONFLICT', conflictStatus: 'EXTERNAL_FRC_CHANGE' });
    expect((await h.actuator.execute(resume, garage, healthy)).status).toBe('CONFLICT');
    expect(h.writeCount()).toBe(0);
  });

  it('filters arbitrary fields before baseline persistence', async () => {
    const h = createHarness(); await h.initialize();
    const status = await h.client.readStatus(garage);
    if (!status.ok) throw new Error('Missing fake status');
    h.readStatus.mockResolvedValueOnce(success({ ...status.value, authToken: 'SECRET', rawResponse: { hidden: 'SECRET' } }));
    expect((await h.actuator.execute(limit(13), garage, healthy)).status).toBe('CONFIRMED');
    expect(JSON.stringify(h.save.mock.calls)).not.toContain('SECRET');
    expect(JSON.stringify(h.actuator.states)).not.toContain('SECRET');
  });

  it('fails closed for corrupted ownership and does not overwrite the corrupt file', async () => {
    const h = createHarness(); h.load.mockResolvedValueOnce(failure('ConfigurationError', 'Corrupt file'));
    expect((await h.initialize()).ok).toBe(false);
    expect(h.save).not.toHaveBeenCalled();
    expect(h.readStatus).not.toHaveBeenCalled();
    expect((await h.actuator.execute(limit(13), garage, healthy)).code).toBe('ACTUATOR_NOT_INITIALIZED');
    expect((await h.actuator.shutdown()).ok).toBe(true);
    expect(h.save).not.toHaveBeenCalled();
  });

  it('rejects contradictory persisted ownership rather than clearing restrictions', async () => {
    const saved = persistedOwned({ baseline: null });
    const h = createHarness({ saved });
    expect((await h.initialize()).ok).toBe(false);
    expect(h.writeCount()).toBe(0);
  });

  it('startup compares a confirmed tcl with the actual device and writes nothing', async () => {
    const h = createHarness({ saved: persistedOwned(), initial: { tcl: 10, acu: 10 } });
    expect((await h.initialize()).ok).toBe(true);
    expect(h.actuator.states[0]?.ownershipStatus).toBe('OWNED');
    expect(h.writeCount()).toBe(0);
  });

  it('startup detects an external lower tcl and does not restore a persisted higher tcl', async () => {
    const h = createHarness({ saved: persistedOwned(), initial: { tcl: 8, acu: 8 } }); await h.initialize();
    expect(h.actuator.states[0]).toMatchObject({ ownershipStatus: 'CONFLICT', conflictStatus: 'EXTERNAL_TCL_CHANGE' });
    expect((await h.actuator.execute(clear, garage, healthy)).status).toBe('CONFLICT');
    expect(h.writeCount()).toBe(0);
  });

  it('a persisted in-flight intent never becomes confirmed ownership from matching status', async () => {
    const saved = persistedOwned({ ownershipStatus: 'RECONCILING', pendingWrite: { action: limit(9), expectedTcl: 9, expectedFrc: 0, startedAtMs: 300 } });
    const h = createHarness({ saved, initial: { tcl: 9, acu: 9 } }); await h.initialize();
    expect(h.actuator.states[0]).toMatchObject({ ownershipStatus: 'UNKNOWN', conflictStatus: 'UNCONFIRMED_PENDING_WRITE' });
    expect((await h.actuator.execute(clear, garage, healthy)).status).toBe('BLOCKED');
    expect(h.writeCount()).toBe(0);
  });

  it('blocks the first write if baseline or pending intent cannot be saved', async () => {
    const h = createHarness(); await h.initialize();
    h.save.mockResolvedValueOnce(failure('ConfigurationError', 'Disk full'));
    expect((await h.actuator.execute(limit(13), garage, healthy)).code).toBe('OWNERSHIP_PERSIST_FAILED');
    expect(h.writeCount()).toBe(0);
    expect(h.actuator.states[0]?.ownershipStatus).toBe('NONE');
  });

  it('does not claim ownership if confirmed readback cannot be persisted', async () => {
    const h = createHarness(); await h.initialize();
    h.setTemporaryCurrentLimit.mockImplementationOnce(async (_config, amps) => {
      h.change({ tcl: amps });
      h.save.mockResolvedValue(failure('ConfigurationError', 'Disk full'));
      return success(undefined);
    });
    expect((await h.actuator.execute(limit(13), garage, healthy)).code).toBe('CONFIRMED_WRITE_PERSIST_FAILED');
    expect(h.actuator.states[0]).toMatchObject({ ownershipStatus: 'UNKNOWN', pluginOwnedTcl: null });
    expect(h.writeCount()).toBe(1);
  });

  it('shutdown persists restrictions and never emits clear or resume', async () => {
    const h = createHarness(); await h.initialize();
    await h.actuator.execute(limit(6), garage, healthy);
    await h.actuator.execute(pause, garage, healthy);
    expect((await h.actuator.shutdown()).ok).toBe(true);
    expect(h.actuator.states[0]).toMatchObject({ pluginOwnedTcl: 6, pluginOwnedPause: true, ownershipStatus: 'OWNED' });
    expect(h.clearTemporaryCurrentLimit).not.toHaveBeenCalled();
    expect(h.resumeDevice).not.toHaveBeenCalled();
    expect((await h.actuator.execute(resume, garage, healthy)).code).toBe('ACTUATOR_STOPPED');
  });

  it('cancels work awaiting persistence when shutdown starts', async () => {
    const h = createHarness(); await h.initialize();
    h.save.mockImplementationOnce(async () => { void h.actuator.shutdown(); return success(undefined); });
    expect((await h.actuator.execute(limit(13), garage, healthy)).code).toBe('ACTUATOR_STOPPED');
    expect(h.writeCount()).toBe(0);
  });

  it('serializes concurrent actions so every action obtains a new pre-write status', async () => {
    const h = createHarness(); await h.initialize();
    let release: (() => void) | undefined;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    h.setTemporaryCurrentLimit.mockImplementationOnce(async (_config, amps) => {
      await waiting; h.change({ tcl: amps, acu: amps }); return success(undefined);
    });
    const first = h.actuator.execute(limit(13), garage, healthy);
    const second = h.actuator.execute(limit(12), garage, healthy);
    await vi.waitFor(() => expect(h.setTemporaryCurrentLimit).toHaveBeenCalledTimes(1));
    expect(h.readStatus).toHaveBeenCalledTimes(2);
    release?.();
    expect((await first).status).toBe('CONFIRMED');
    expect((await second).status).toBe('CONFIRMED');
    expect(h.readStatus).toHaveBeenCalledTimes(5);
  });
});

describe('temporary-current refresh is explicit, bounded and safe', () => {
  it('a renewed identical restriction does not release power during telemetry stabilization', async () => {
    const h = createHarness(); await h.initialize(); await h.actuator.execute(limit(6), garage, healthy);
    h.clock.now += 300_000; h.change({ acu: 0 });
    expect((await h.actuator.refresh([garage], { ...h.context(), recoveryAllowed: false }))[0]?.status).toBe('CONFIRMED');
    expect(h.actuator.states[0]?.pluginOwnedTcl).toBe(6);
  });

  it('refreshes only after five minutes, verifies readback and does not spam', async () => {
    const h = createHarness(); await h.initialize(); await h.actuator.execute(limit(13), garage, healthy);
    h.clock.now += 299_999;
    expect(await h.actuator.refresh([garage], h.context())).toEqual([]);
    h.clock.now += 1;
    expect((await h.actuator.refresh([garage], h.context()))[0]?.status).toBe('CONFIRMED');
    expect(h.setTemporaryCurrentLimit).toHaveBeenCalledTimes(2);
    expect(await h.actuator.refresh([garage], h.context())).toEqual([]);
  });

  it.each([
    { overrideActive: true }, { telemetryHealthy: false }, { loadManagementEnabled: false },
  ])('does not refresh with unsafe context %j', async patch => {
    const h = createHarness(); await h.initialize(); await h.actuator.execute(limit(13), garage, healthy);
    h.clock.now += 300_000;
    expect(await h.actuator.refresh([garage], { ...healthy, ...patch })).toEqual([]);
    expect(h.writeCount()).toBe(1);
  });

  it('refresh still performs a new pre-write check and detects external tcl', async () => {
    const h = createHarness(); await h.initialize(); await h.actuator.execute(limit(13), garage, healthy);
    h.change({ tcl: 8, acu: 8 }); h.clock.now += 300_000;
    expect((await h.actuator.refresh([garage], h.context()))[0]?.status).toBe('CONFLICT');
    expect(await h.actuator.refresh([garage], h.context())).toEqual([]);
    expect(h.writeCount()).toBe(1);
  });

  it('does not refresh after clearing the owned restriction', async () => {
    const h = createHarness(); await h.initialize(); await h.actuator.execute(limit(13), garage, healthy);
    await h.actuator.execute(clear, garage, healthy); h.clock.now += 300_000;
    expect(await h.actuator.refresh([garage], h.context())).toEqual([]);
    expect(h.writeCount()).toBe(2);
  });

  it('does not refresh a foreign limit', async () => {
    const h = createHarness({ initial: { tcl: 8, acu: 8 } }); await h.initialize(); h.clock.now += 300_000;
    expect(await h.actuator.refresh([garage], h.context())).toEqual([]);
    expect(h.writeCount()).toBe(0);
  });

  it('does not refresh disabled chargers or after shutdown', async () => {
    const h = createHarness(); await h.initialize(); await h.actuator.execute(limit(13), garage, healthy);
    h.clock.now += 300_000;
    expect(await h.actuator.refresh([{ ...garage, enabled: false }], healthy)).toEqual([]);
    await h.actuator.shutdown();
    expect(await h.actuator.refresh([garage], h.context())).toEqual([]);
    expect(h.writeCount()).toBe(1);
  });

  it('keeps an owned temporary limit refreshed during a plugin-owned pause without resuming it', async () => {
    const h = createHarness(); await h.initialize(); await h.actuator.execute(limit(6), garage, healthy);
    await h.actuator.execute(pause, garage, healthy); h.clock.now += 300_000;
    expect((await h.actuator.refresh([garage], h.context()))[0]?.status).toBe('CONFIRMED');
    expect(h.actuator.states[0]).toMatchObject({ pluginOwnedPause: true, pluginOwnedTcl: 6 });
    expect(h.resumeDevice).not.toHaveBeenCalled();
  });
});

describe('actuator policy', () => {
  it('uses the conservative documented defaults', () => {
    expect(DEFAULT_ACTUATOR_POLICY).toEqual({ maxStatusAgeMs: 4_000, tclRefreshMs: 300_000, maxRetries: 2, retryDelayMs: 100 });
    expect(resolveActuatorPolicy()).toEqual(DEFAULT_ACTUATOR_POLICY);
  });

  it.each([
    { maxStatusAgeMs: 0 }, { tclRefreshMs: -1 }, { maxRetries: 4 }, { maxRetries: -1 }, { retryDelayMs: 1_001 },
  ])('rejects unsafe policy %j', policy => {
    expect(() => resolveActuatorPolicy(policy)).toThrow('Invalid actuator policy.');
  });
});
