import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChargerConfig } from '../../../../src/config/config-types.js';
import { failure, success, type Result } from '../../../../src/domain/errors.js';
import { ChargerActuator } from '../../../../src/goe/control/charger-actuator.js';
import type { ChargerControlClient, ControlObservation } from '../../../../src/goe/control/control-types.js';
import { canRebindOwnership, makeEmptyOwnership, type OwnershipDocument, type OwnershipState, type OwnershipStore } from '../../../../src/goe/control/ownership-state.js';
import { makeObservation, makeOwnedState, testCharger } from './ownership-helpers.js';

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Hardware requests are forbidden'); })); });
afterEach(() => { vi.unstubAllGlobals(); });

const replacement: ChargerConfig = { ...testCharger, host: '10.0.0.94' };

function unreachable(patch: Partial<OwnershipState> = {}): OwnershipState {
  return { ...makeEmptyOwnership(testCharger, 1_000), ownershipStatus: 'UNKNOWN',
    conflictStatus: 'CHARGER_STATUS_UNAVAILABLE', ...patch };
}

function setup(initial: readonly OwnershipState[]) {
  const clock = { now: 2_000 };
  let persisted: OwnershipDocument = { version: 1, chargers: structuredClone(initial) };
  const load = vi.fn(async (): Promise<Result<OwnershipDocument | null>> => success(structuredClone(persisted)));
  const save = vi.fn(async (document: OwnershipDocument): Promise<Result<void>> => {
    persisted = structuredClone(document); return success(undefined);
  });
  const store: OwnershipStore = { load, save };
  const readStatus = vi.fn(async (config: ChargerConfig): Promise<Result<ControlObservation>> => {
    const prior = persisted.chargers.find(state => state.chargerId === config.id && state.host === config.host);
    return success({ ...makeObservation(), ...(prior?.lastReadback ?? {}), chargerId: config.id, host: config.host,
      readStartedAtMs: clock.now, observedAtMs: clock.now });
  });
  const setTemporaryCurrentLimit = vi.fn(async (): Promise<Result<void>> => success(undefined));
  const clearTemporaryCurrentLimit = vi.fn(async (): Promise<Result<void>> => success(undefined));
  const pause = vi.fn(async (): Promise<Result<void>> => success(undefined));
  const resume = vi.fn(async (): Promise<Result<void>> => success(undefined));
  const client: ChargerControlClient = { readStatus, setTemporaryCurrentLimit, clearTemporaryCurrentLimit, pause, resume };
  const actuator = new ChargerActuator({ client, store, gate: { executionMode: 'LIVE', realWritesEnabled: true },
    now: () => clock.now, policy: { maxRetries: 0 }, sleep: async () => undefined });
  const expectNoWrites = () => {
    expect(setTemporaryCurrentLimit).not.toHaveBeenCalled();
    expect(clearTemporaryCurrentLimit).not.toHaveBeenCalled();
    expect(pause).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  };
  return { actuator, clock, readStatus, setTemporaryCurrentLimit, load, save, expectNoWrites, document: () => structuredClone(persisted) };
}

describe('read-only actuator host rebinding and staged initialization', () => {
  it('rebinds a persisted never-controlled unreachable seed address and reconciles the new host read-only', async () => {
    const h = setup([unreachable()]);
    expect(await h.actuator.initialize([replacement])).toEqual(success(undefined));
    expect(h.readStatus).toHaveBeenCalledExactlyOnceWith(replacement);
    expect(h.actuator.states[0]).toMatchObject({ host: replacement.host, ownershipStatus: 'NONE', baseline: null,
      pluginOwnedTcl: null, pluginOwnedPause: false, pendingWrite: null, lastConfirmedWrite: null });
    expect(h.document().chargers).toEqual(h.actuator.states);
    h.expectNoWrites();
  });

  it('can save a new address that is still unreachable without fabricating ownership or a measurement', async () => {
    const h = setup([unreachable()]);
    h.readStatus.mockResolvedValue(failure('ConnectionError', 'Mock unavailable'));
    expect((await h.actuator.initialize([replacement])).ok).toBe(true);
    const state = h.actuator.states[0];
    expect(state).toMatchObject({ host: replacement.host, ownershipStatus: 'UNKNOWN', conflictStatus: 'CHARGER_STATUS_UNAVAILABLE',
      baseline: null, lastObservedState: null, lastReadback: null, pendingWrite: null, lastConfirmedWrite: null });
    expect(state !== undefined && canRebindOwnership(state)).toBe(true);
    h.expectNoWrites();
  });

  it('keeps external limits on a newly observed host unowned and performs no cleanup', async () => {
    const h = setup([unreachable()]);
    h.readStatus.mockResolvedValue(success(makeObservation({ host: replacement.host, tcl: 8, frc: 1, car: 4,
      acu: null, alw: false, readStartedAtMs: 2_000, observedAtMs: 2_000 })));
    expect((await h.actuator.initialize([replacement])).ok).toBe(true);
    expect(h.actuator.states[0]).toMatchObject({ ownershipStatus: 'NONE', pluginOwnedTcl: null, pluginOwnedPause: false,
      lastObservedState: { tcl: 8, frc: 1 } });
    h.expectNoWrites();
  });

  it.each([
    makeOwnedState(), unreachable({ baseline: makeObservation() }),
    unreachable({ conflictStatus: 'WRITE_OUTCOME_UNKNOWN' }),
    unreachable({ lastReadback: makeObservation() }),
    unreachable({ lastObservedState: makeObservation({ frc: 1 }) }),
    unreachable({ ownershipStatus: 'CONFLICT', conflictStatus: 'NATIVE_LOAD_BALANCING_CONFLICT' }),
  ])('rejects unsafe host rebinding before polling or changing persistence (%j)', async (state) => {
    const h = setup([state]);
    const before = h.document();
    expect((await h.actuator.initialize([replacement])).ok).toBe(false);
    expect(h.readStatus).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    expect(h.document()).toEqual(before);
    h.expectNoWrites();
  });

  it('preflights every changed host before reading an earlier safe replacement', async () => {
    const links: ChargerConfig = { ...testCharger, id: 'links', host: 'links.test' };
    const identity = { chargerId: links.id, host: links.host };
    const ownedLinks = makeOwnedState({ ...identity, baseline: makeObservation(identity),
      lastObservedState: makeObservation({ ...identity, tcl: 10, acu: 10 }),
      lastReadback: makeObservation({ ...identity, tcl: 10, acu: 10 }),
      lastConfirmedWrite: { action: { type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: links.id, amps: 10 }, confirmedAtMs: 1_000 } });
    const h = setup([unreachable(), ownedLinks]);
    expect((await h.actuator.initialize([replacement, { ...links, host: '10.0.0.144' }])).ok).toBe(false);
    expect(h.readStatus).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    h.expectNoWrites();
  });

  it('keeps already initialized ownership evidence unchanged when a replacement is blocked', async () => {
    const h = setup([makeOwnedState()]);
    await h.actuator.initialize([testCharger]);
    const before = h.actuator.states;
    const persisted = h.document();
    h.readStatus.mockClear(); h.save.mockClear();
    expect((await h.actuator.initialize([replacement])).ok).toBe(false);
    expect(h.actuator.states).toEqual(before);
    expect(h.document()).toEqual(persisted);
    expect(h.readStatus).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    h.expectNoWrites();
  });

  it.each([
    unreachable({ ownershipStatus: 'CONFLICT', conflictStatus: 'NATIVE_LOAD_BALANCING_CONFLICT' }),
    unreachable({ conflictStatus: 'NATIVE_LOAD_BALANCING_UNKNOWN' }),
    unreachable({ conflictStatus: 'INVALID_CONTROL_OBSERVATION' }),
    unreachable({ conflictStatus: 'WRITE_OUTCOME_UNKNOWN' }),
    unreachable({ conflictStatus: null }),
  ])('does not turn an existing uncertainty into the safe initial-outage exception (%j)', async (state) => {
    const h = setup([state]);
    h.readStatus.mockResolvedValue(failure('TimeoutError', 'Mock unavailable'));
    expect((await h.actuator.initialize([testCharger])).ok).toBe(true);
    expect(h.actuator.states[0]).toMatchObject({ ownershipStatus: state.ownershipStatus, conflictStatus: state.conflictStatus });
    expect(h.actuator.states[0] !== undefined && canRebindOwnership(h.actuator.states[0])).toBe(false);
    h.readStatus.mockClear(); h.save.mockClear();
    expect((await h.actuator.initialize([replacement])).ok).toBe(false);
    expect(h.readStatus).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    h.expectNoWrites();
  });

  it('preserves old in-memory evidence and disables execution when loading the store fails', async () => {
    const h = setup([makeOwnedState()]);
    await h.actuator.initialize([testCharger]);
    const before = h.actuator.states;
    h.load.mockResolvedValue(failure('ConfigurationError', 'Mock read failure'));
    expect((await h.actuator.initialize([testCharger])).ok).toBe(false);
    expect(h.actuator.states).toEqual(before);
    expect(await h.actuator.execute({ type: 'CLEAR_TEMPORARY_CURRENT_LIMIT', chargerId: testCharger.id }, testCharger,
      { telemetryHealthy: true, telemetrySampledAtMs: 2_000, recoveryAllowed: true, overrideActive: true, loadManagementEnabled: true }))
      .toMatchObject({ status: 'BLOCKED', code: 'ACTUATOR_NOT_INITIALIZED' });
    h.expectNoWrites();
  });

  it('validates the whole loaded document and preserves evidence when duplicate records are found', async () => {
    const h = setup([makeOwnedState()]);
    await h.actuator.initialize([testCharger]);
    const before = h.actuator.states;
    const persisted = h.document();
    h.load.mockResolvedValue(success({ version: 1, chargers: [unreachable(), unreachable()] }));
    h.readStatus.mockClear(); h.save.mockClear();
    expect((await h.actuator.initialize([replacement])).ok).toBe(false);
    expect(h.actuator.states).toEqual(before);
    expect(h.document()).toEqual(persisted);
    expect(h.readStatus).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    h.expectNoWrites();
  });

  it('does not replace old in-memory evidence when a staged replacement cannot be persisted', async () => {
    const h = setup([unreachable()]);
    h.readStatus.mockResolvedValueOnce(failure('ConnectionError', 'Mock unavailable'));
    await h.actuator.initialize([testCharger]);
    const before = h.actuator.states;
    const document = h.document();
    h.save.mockImplementationOnce(async () => {
      expect(h.actuator.states).toEqual(before);
      return failure('ConfigurationError', 'Mock persistence failure');
    });
    expect((await h.actuator.initialize([replacement])).ok).toBe(false);
    expect(h.actuator.states).toEqual(before);
    expect(h.document()).toEqual(document);
    h.expectNoWrites();
  });

  it.each(['older NONE', 'missing', 'different conflict'] as const)
  ('cannot forget protected in-memory evidence by reloading a %s disk record', async (change) => {
    const h = setup([makeOwnedState()]);
    await h.actuator.initialize([testCharger]);
    const before = h.actuator.states;
    const document = h.document();
    h.load.mockResolvedValue(success(change === 'missing' ? null : { version: 1, chargers: [
      change === 'older NONE' ? makeEmptyOwnership(testCharger, 0)
        : makeOwnedState({ ownershipStatus: 'CONFLICT', conflictStatus: 'EXTERNAL_TCL_CHANGE', updatedAt: 2_001 }),
    ] }));
    h.readStatus.mockClear(); h.save.mockClear();
    expect((await h.actuator.initialize([testCharger])).ok).toBe(false);
    expect(h.actuator.states).toEqual(before);
    expect(h.document()).toEqual(document);
    expect(h.readStatus).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    h.expectNoWrites();
  });

  it('allows reinitialization after a cancelled precheck changes only the last-read freshness', async () => {
    const h = setup([makeOwnedState()]);
    await h.actuator.initialize([testCharger]);
    const persisted = h.document();
    h.clock.now = 3_000;
    h.readStatus.mockImplementationOnce(async () => {
      h.actuator.cancelPendingOperations();
      return success(makeObservation({ tcl: 10, acu: 10, readStartedAtMs: 3_000, observedAtMs: 3_000 }));
    });
    expect(await h.actuator.execute({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: testCharger.id, amps: 9 }, testCharger,
      { telemetryHealthy: true, telemetrySampledAtMs: 3_000, recoveryAllowed: true, overrideActive: false, loadManagementEnabled: true }))
      .toMatchObject({ status: 'BLOCKED', code: 'OPERATION_CANCELLED', writeAttempted: false });
    expect(h.actuator.states[0]?.lastObservedState?.observedAtMs).toBe(3_000);
    expect(h.document()).toEqual(persisted);
    expect((await h.actuator.initialize([testCharger])).ok).toBe(true);
    expect(h.actuator.states[0]).toMatchObject({ ownershipStatus: 'OWNED', pluginOwnedTcl: 10 });
    h.expectNoWrites();
  });

  it.each([{ mca: 7 }, { firmwareVersion: '59.4' }])
  ('still protects differing last-observed control fields after a cancelled precheck (%j)', async (patch) => {
    const h = setup([makeOwnedState()]);
    await h.actuator.initialize([testCharger]);
    h.clock.now = 3_000;
    h.readStatus.mockImplementationOnce(async () => {
      h.actuator.cancelPendingOperations();
      return success(makeObservation({ tcl: 10, acu: 10, readStartedAtMs: 3_000, observedAtMs: 3_000, ...patch }));
    });
    expect(await h.actuator.execute({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: testCharger.id, amps: 9 }, testCharger,
      { telemetryHealthy: true, telemetrySampledAtMs: 3_000, recoveryAllowed: true, overrideActive: false, loadManagementEnabled: true }))
      .toMatchObject({ status: 'BLOCKED', writeAttempted: false });
    const before = h.actuator.states;
    const document = h.document();
    h.readStatus.mockClear(); h.save.mockClear();
    expect((await h.actuator.initialize([testCharger])).ok).toBe(false);
    expect(h.actuator.states).toEqual(before);
    expect(h.document()).toEqual(document);
    expect(h.readStatus).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    h.expectNoWrites();
  });

  it('keeps volatile uncertainty after a failed evidence commit instead of trusting the older pending disk state', async () => {
    const h = setup([makeEmptyOwnership(testCharger, 1_000)]);
    await h.actuator.initialize([testCharger]);
    h.setTemporaryCurrentLimit.mockImplementationOnce(async () => {
      h.save.mockResolvedValue(failure('ConfigurationError', 'Mock evidence commit failure'));
      return success(undefined);
    });
    expect(await h.actuator.execute({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: testCharger.id, amps: 13 }, testCharger,
      { telemetryHealthy: true, telemetrySampledAtMs: 2_000, recoveryAllowed: true, overrideActive: false, loadManagementEnabled: true }))
      .toMatchObject({ status: 'READBACK_MISMATCH', writeAttempted: true });
    const before = h.actuator.states;
    const document = h.document();
    expect(before[0]).toMatchObject({ ownershipStatus: 'UNKNOWN', conflictStatus: 'READBACK_MISMATCH', pendingWrite: { expectedTcl: 13 } });
    expect(document.chargers[0]).toMatchObject({ ownershipStatus: 'RECONCILING', pendingWrite: { expectedTcl: 13 } });
    h.readStatus.mockClear(); h.save.mockClear();
    expect((await h.actuator.initialize([testCharger])).ok).toBe(false);
    expect(h.actuator.states).toEqual(before);
    expect(h.document()).toEqual(document);
    expect(h.readStatus).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
    expect(h.setTemporaryCurrentLimit).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('retains disabled and removed records without reading or erasing their restrictions', async () => {
    const h = setup([makeOwnedState()]);
    expect((await h.actuator.initialize([{ ...testCharger, enabled: false, host: '' }])).ok).toBe(true);
    expect(h.actuator.states).toEqual([makeOwnedState()]);
    expect((await h.actuator.initialize([])).ok).toBe(true);
    expect(h.actuator.states).toEqual([makeOwnedState()]);
    expect(h.readStatus).not.toHaveBeenCalled();
    h.expectNoWrites();
  });
});
