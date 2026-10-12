import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChargerConfig } from '../../../../src/config/config-types.js';
import { failure, success, type Result } from '../../../../src/domain/errors.js';
import { ChargerActuator } from '../../../../src/goe/control/charger-actuator.js';
import type { ActuatorContext } from '../../../../src/goe/control/actuator-policy.js';
import type { ChargerControlClient, ControlObservation } from '../../../../src/goe/control/control-types.js';
import type { OwnershipDocument, OwnershipStore } from '../../../../src/goe/control/ownership-state.js';
import { makeObservation, testCharger } from './ownership-helpers.js';

beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Hardware requests are forbidden'); })); });
afterEach(() => { vi.unstubAllGlobals(); });

function setup() {
  let current = makeObservation();
  const clock = { now: 0 };
  let unavailable = true;
  let persisted: OwnershipDocument | null = null;
  const store: OwnershipStore = {
    load: async () => success(structuredClone(persisted)),
    save: async (document) => { persisted = structuredClone(document); return success(undefined); },
  };
  const client: ChargerControlClient = {
    readStatus: vi.fn(async (): Promise<Result<ControlObservation>> => unavailable
      ? failure('ConnectionError', 'Mock device unreachable')
      : success({ ...current, readStartedAtMs: clock.now, observedAtMs: clock.now })),
    setTemporaryCurrentLimit: vi.fn(async (_config: ChargerConfig, amps: number): Promise<Result<void>> => {
      current = { ...current, tcl: amps, acu: amps }; return success(undefined);
    }),
    clearTemporaryCurrentLimit: vi.fn(async (): Promise<Result<void>> => success(undefined)),
    pause: vi.fn(async (): Promise<Result<void>> => success(undefined)),
    resume: vi.fn(async (): Promise<Result<void>> => success(undefined)),
  };
  const createActuator = () => new ChargerActuator({ client, store,
    gate: { executionMode: 'LIVE', realWritesEnabled: true }, now: () => clock.now,
    policy: { maxRetries: 0 }, sleep: async () => undefined });
  const context = (): ActuatorContext => ({ telemetryHealthy: true, telemetrySampledAtMs: clock.now,
    recoveryAllowed: true, overrideActive: false, loadManagementEnabled: true });
  return { clock, client, createActuator, context,
    reconnect: () => { unavailable = false; clock.now = 1_000; },
    patch: (fields: Partial<ControlObservation>) => { current = { ...current, ...fields }; },
    actual: () => current,
  };
}

describe('unowned charger reconnect without speculative ownership adoption', () => {
  it('recovers after an unreachable startup, then captures and confirms a new own limit explicitly', async () => {
    const context = setup();
    const actuator = context.createActuator();
    expect((await actuator.initialize([testCharger])).ok).toBe(true);
    expect(actuator.states[0]).toMatchObject({ ownershipStatus: 'UNKNOWN', baseline: null, pendingWrite: null });
    expect(context.client.setTemporaryCurrentLimit).not.toHaveBeenCalled();
    context.reconnect();
    expect(await actuator.execute({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 13 }, testCharger, context.context())).toMatchObject({ status: 'CONFIRMED' });
    expect(actuator.states[0]).toMatchObject({ ownershipStatus: 'OWNED', pluginOwnedTcl: 13, baseline: { tcl: null } });
    expect(context.client.setTemporaryCurrentLimit).toHaveBeenCalledOnce();
    expect(context.client.clearTemporaryCurrentLimit).not.toHaveBeenCalled();
    expect(context.client.resume).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('also recovers persisted empty UNKNOWN at restart while retaining foreign restrictions', async () => {
    const context = setup();
    await context.createActuator().initialize([testCharger]);
    context.reconnect();
    context.patch({ tcl: 8, acu: 8 });
    const restarted = context.createActuator();
    expect((await restarted.initialize([testCharger])).ok).toBe(true);
    expect(restarted.states[0]).toMatchObject({ ownershipStatus: 'NONE', pluginOwnedTcl: null, pluginOwnedPause: false });
    expect(await restarted.execute({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 10 }, testCharger, context.context())).toMatchObject({ status: 'BLOCKED', code: 'EXTERNAL_LIMIT_PRESERVED' });
    expect(context.actual().tcl).toBe(8);
    expect(context.client.setTemporaryCurrentLimit).not.toHaveBeenCalled();
    expect(context.client.clearTemporaryCurrentLimit).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('never resumes a foreign pause after recovery from empty UNKNOWN', async () => {
    const context = setup();
    const actuator = context.createActuator();
    await actuator.initialize([testCharger]);
    context.reconnect();
    context.patch({ frc: 1, tcl: 8, car: 4, acu: null, alw: false });
    expect(await actuator.execute({ type: 'RESUME', chargerId: 'garage' }, testCharger, context.context())).toMatchObject({ status: 'BLOCKED', code: 'PAUSE_NOT_OWNED' });
    expect(context.actual()).toMatchObject({ frc: 1, tcl: 8 });
    expect(context.client.resume).not.toHaveBeenCalled();
    expect(context.client.setTemporaryCurrentLimit).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires native load balancing to remain disabled after reconnect', async () => {
    const context = setup();
    const actuator = context.createActuator();
    await actuator.initialize([testCharger]);
    context.reconnect();
    context.patch({ loe: true });
    expect(await actuator.execute({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 13 }, testCharger, context.context())).toMatchObject({ status: 'CONFLICT', code: 'NATIVE_LOAD_BALANCING_CONFLICT' });
    expect(context.client.setTemporaryCurrentLimit).not.toHaveBeenCalled();
    expect(context.actual().loe).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});
