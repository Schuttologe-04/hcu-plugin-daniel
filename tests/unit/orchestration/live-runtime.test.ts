import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, ChargerConfig } from '../../../src/config/config-types.js';
import type { ProbeReport, ChargerProbeResult } from '../../../src/diagnostics/probe-service.js';
import { mapCarState } from '../../../src/domain/charger.js';
import type { ControllerStatus } from '../../../src/domain/controller.js';
import { failure, success, type Result } from '../../../src/domain/errors.js';
import { ChargerActuator } from '../../../src/goe/control/charger-actuator.js';
import type { ChargerControlClient, ControlObservation, WriteGate } from '../../../src/goe/control/control-types.js';
import type { OwnershipDocument, OwnershipStore } from '../../../src/goe/control/ownership-state.js';
import { LoadManager } from '../../../src/load-management/load-manager.js';
import { LiveRuntime } from '../../../src/orchestration/live-runtime.js';
import { controller, makeCharger, makeConfig } from '../load-management/helpers.js';
import { makeObservation, makeOwnedState } from '../goe/control/ownership-helpers.js';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Real network is forbidden in runtime tests'); }));
});
afterEach(() => { vi.unstubAllGlobals(); });

function setup(options: { config?: AppConfig; gate?: WriteGate; persisted?: OwnershipDocument | null; now?: number } = {}) {
  const config: AppConfig = options.config ?? { ...makeConfig(), notifications: {
    intervention: true, interactive: true, controllerConnectionError: false, chargerConnectionError: false,
  } };
  const clock = { now: options.now ?? 0 };
  const actual = new Map<string, ControlObservation>();
  for (const charger of config.chargers.filter(value => value.enabled)) actual.set(charger.id, makeObservation({
    chargerId: charger.id, host: charger.host, ama: 32,
    ...(charger.id === 'garage' ? {} : { car: 1, acu: null, alw: false }),
  }));
  const unreachable = new Set<string>();
  let persisted = structuredClone(options.persisted ?? null);
  const store: OwnershipStore = {
    load: vi.fn(async (): Promise<Result<OwnershipDocument | null>> => success(structuredClone(persisted))),
    save: vi.fn(async (document): Promise<Result<void>> => { persisted = structuredClone(document); return success(undefined); }),
  };
  function state(id: string): ControlObservation {
    const value = actual.get(id);
    if (value === undefined) throw new Error('Unknown test charger');
    return value;
  }
  function patch(id: string, fields: Partial<ControlObservation>) { actual.set(id, { ...state(id), ...fields }); }
  const writes = {
    setTemporaryCurrentLimit: vi.fn(async (charger: ChargerConfig, amps: number): Promise<Result<void>> => {
      patch(charger.id, { tcl: amps, acu: state(charger.id).frc === 1 ? null : amps }); return success(undefined);
    }),
    clearTemporaryCurrentLimit: vi.fn(async (charger: ChargerConfig): Promise<Result<void>> => {
      patch(charger.id, { tcl: null, acu: state(charger.id).frc === 1 ? null : state(charger.id).amp }); return success(undefined);
    }),
    pause: vi.fn(async (charger: ChargerConfig): Promise<Result<void>> => {
      patch(charger.id, { frc: 1, car: 4, acu: null, alw: false }); return success(undefined);
    }),
    resume: vi.fn(async (charger: ChargerConfig): Promise<Result<void>> => {
      patch(charger.id, { frc: 0, car: 2, acu: state(charger.id).tcl ?? state(charger.id).amp, alw: true }); return success(undefined);
    }),
  };
  const readStatus = vi.fn(async (charger: ChargerConfig): Promise<Result<ControlObservation>> => {
    if (unreachable.has(charger.id)) return failure('ConnectionError', 'Mock charger unavailable');
    return success({ ...state(charger.id), readStartedAtMs: clock.now, observedAtMs: clock.now });
  });
  const client: ChargerControlClient = { readStatus, ...writes };
  const gate: WriteGate = options.gate ?? { executionMode: 'LIVE', realWritesEnabled: true };
  const actuator = new ChargerActuator({ client, store, gate, now: () => clock.now, sleep: async () => undefined });
  let grid: Result<ControllerStatus> = success(controller(22_839));
  const readController = vi.fn(async (): Promise<Result<ControllerStatus>> => structuredClone(grid));
  const probe = vi.fn(async (currentConfig: AppConfig): Promise<ProbeReport> => ({
    controller: structuredClone(grid),
    chargers: currentConfig.chargers.map((charger): ChargerProbeResult => {
      if (!charger.enabled) return { status: 'disabled', reachable: false, config: charger };
      if (unreachable.has(charger.id)) return { status: 'unavailable', reachable: false, config: charger,
        error: { code: 'ConnectionError', message: 'Mock charger unavailable' } };
      const current = state(charger.id);
      return { status: 'reachable', reachable: true, config: charger,
        value: makeCharger(charger.id, { host: current.host, configuredCurrentA: current.amp,
          temporaryCurrentLimitA: current.tcl, effectiveCurrentA: current.acu,
          forceState: current.frc, carState: mapCarState(current.car), chargingAllowed: current.alw,
          maximumCurrentA: current.ama, minimumCurrentA: current.mca,
          allowChargingPause: current.acp, minimumChargingPauseDuration: current.mcpd,
        }) };
    }),
  }));
  let sequence = 0;
  const onIntervention = vi.fn(async (): Promise<Result<void>> => success(undefined));
  const onEndSession = vi.fn(async () => undefined);
  const onWarning = vi.fn(async (_reason: 'FAULT' | 'LIMIT_UNACHIEVABLE') => undefined);
  const runtime = new LiveRuntime({ config, gate, actuator, now: () => clock.now,
    idProvider: { nextId: () => `live-observation-${++sequence}` }, probe, readController,
    onIntervention, onEndSession, onWarning });
  const step = async (timestamp: number, value?: number) => {
    clock.now = timestamp;
    if (value !== undefined) grid = success(controller(value));
    return runtime.observe();
  };
  const execute = async () => {
    const pending = runtime.engine.snapshot.pendingAction;
    if (pending === null) throw new Error('Expected pending abstract action');
    return runtime.executePendingAction(pending.id);
  };
  return { runtime, config, gate, clock, actual, client, writes, readStatus, store, probe,
    readController, onIntervention, onEndSession, onWarning, unreachable, patch, state, step, execute,
    setGrid: (value: Result<ControllerStatus>) => { grid = value; },
    persisted: () => structuredClone(persisted),
    writeCount: () => Object.values(writes).reduce((total, method) => total + method.mock.calls.length, 0),
  };
}

async function trigger(context: ReturnType<typeof setup>) {
  expect((await context.runtime.initialize()).ok).toBe(true);
  for (const timestamp of [0, 4_000, 8_000, 12_000, 16_000, 20_000, 24_000, 28_000]) await context.step(timestamp);
  return context.step(30_000);
}

describe('prepared LIVE runtime using only mocked devices', () => {
  it('constructor and initialize never write, install timers or start a canary', async () => {
    const context = setup();
    expect(context.readStatus).not.toHaveBeenCalled();
    expect(context.probe).not.toHaveBeenCalled();
    expect(context.runtime.snapshot).toMatchObject({ mode: 'LIVE', observedAtMs: null, actuator: { state: 'FAULT' } });
    await context.runtime.initialize();
    expect(context.readStatus).toHaveBeenCalledTimes(2);
    expect(context.probe).not.toHaveBeenCalled();
    expect(context.writeCount()).toBe(0);
    expect(context.runtime.snapshot).toMatchObject({ actuator: { state: 'PREPARED' }, realChargerWritesEnabled: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { executionMode: 'HCU_DEV' as const, realWritesEnabled: false },
    { executionMode: 'HCU_DEV' as const, realWritesEnabled: true },
    { executionMode: 'DRY_RUN' as const, realWritesEnabled: false },
    { executionMode: 'DRY_RUN' as const, realWritesEnabled: true },
    { executionMode: 'LIVE' as const, realWritesEnabled: false },
  ])('rejects startup closed with gate %j', async (gate) => {
    const context = setup({ gate });
    expect(await context.runtime.initialize()).toMatchObject({ ok: false, error: { code: 'ConfigurationError' } });
    expect(context.readStatus).not.toHaveBeenCalled();
    await context.step(30_000);
    expect(context.probe).not.toHaveBeenCalled();
    expect(context.writeCount()).toBe(0);
  });

  it('the 22.839 kW scenario produces only abstract 13 A until explicit execution', async () => {
    const context = setup();
    const snapshot = await trigger(context);
    expect(snapshot.engine?.state).toBe('LIMITING');
    expect(snapshot.lastDecision?.action).toEqual({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 13 });
    expect(context.state('garage').tcl).toBeNull();
    expect(context.writeCount()).toBe(0);
    expect(context.runtime.engine.snapshot.restrictions).toEqual([]);
    expect(context.runtime.journal.events.at(-1)).toMatchObject({ kind: 'ABSTRACT_ACTION' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('executes the exact pending ID only after fresh controller read and verified device readback', async () => {
    const context = setup();
    await trigger(context);
    const pending = context.runtime.engine.snapshot.pendingAction;
    expect(pending).not.toBeNull();
    const result = await context.execute();
    expect(result).toMatchObject({ ok: true, value: { status: 'CONFIRMED', writeAttempted: true } });
    expect(context.readController).toHaveBeenCalledOnce();
    expect(context.writes.setTemporaryCurrentLimit).toHaveBeenCalledWith(context.config.chargers[0], 13);
    expect(context.state('garage').tcl).toBe(13);
    expect(context.runtime.engine.snapshot.restrictions).toMatchObject([{ chargerId: 'garage', temporaryCurrentLimitA: 13 }]);
    expect(context.runtime.engine.snapshot.pendingAction).toBeNull();
    expect(context.onIntervention).toHaveBeenCalledOnce();
    expect(context.runtime.journal.events.slice(-2).map(entry => entry.kind)).toEqual(['WRITE_ATTEMPTED', 'WRITE_CONFIRMED']);
    expect(await context.runtime.executePendingAction(pending?.id ?? '')).toMatchObject({ ok: false });
    expect(context.writeCount()).toBe(1);
  });

  it('rejects unknown or superseded pending IDs without touching a device', async () => {
    const context = setup();
    await trigger(context);
    const previous = context.runtime.engine.snapshot.pendingAction?.id;
    expect(await context.runtime.executePendingAction('foreign-id')).toMatchObject({ ok: false });
    await context.step(34_000);
    expect(context.runtime.engine.snapshot.pendingAction?.id).not.toBe(previous);
    expect(await context.runtime.executePendingAction(previous ?? '')).toMatchObject({ ok: false });
    expect(context.readController).not.toHaveBeenCalled();
    expect(context.writeCount()).toBe(0);
  });

  it('never reuses an old explicit action ID after reconfiguration', async () => {
    const context = setup();
    await trigger(context);
    const oldId = context.runtime.engine.snapshot.pendingAction?.id;
    await context.runtime.reconfigure({ ...context.config,
      loadManagement: { ...context.config.loadManagement, gridLimitW: 20_000 } });
    for (const timestamp of [34_000, 38_000, 42_000, 46_000, 50_000, 54_000, 58_000, 62_000, 64_000]) await context.step(timestamp);
    const currentId = context.runtime.engine.snapshot.pendingAction?.id;
    expect(currentId).not.toBeNull();
    expect(currentId).not.toBe(oldId);
    expect(await context.runtime.executePendingAction(oldId ?? '')).toMatchObject({ ok: false });
    expect(context.writeCount()).toBe(0);
  });

  it('serializes explicit execution and rejects concurrent actions/configuration', async () => {
    const context = setup();
    await trigger(context);
    let release: ((value: Result<ControllerStatus>) => void) | undefined;
    context.readController.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pendingId = context.runtime.engine.snapshot.pendingAction?.id ?? '';
    const execution = context.runtime.executePendingAction(pendingId);
    expect(await context.runtime.executePendingAction(pendingId)).toMatchObject({ ok: false });
    const probes = context.probe.mock.calls.length;
    await context.runtime.observe();
    expect(context.probe).toHaveBeenCalledTimes(probes);
    await expect(context.runtime.reconfigure(context.config)).rejects.toThrow('still in progress');
    await expect(context.runtime.endSession()).rejects.toThrow('still in progress');
    release?.(success(controller(22_839)));
    expect(await execution).toMatchObject({ ok: true, value: { status: 'CONFIRMED' } });
    expect(context.writeCount()).toBe(1);
  });

  it('cancels obsolete intent when the new controller reading no longer needs reduction', async () => {
    const context = setup();
    await trigger(context);
    context.setGrid(success(controller(18_000)));
    expect(await context.execute()).toMatchObject({ ok: false });
    expect(context.runtime.engine.snapshot.pendingAction).toBeNull();
    expect(context.writeCount()).toBe(0);
    expect(context.runtime.journal.events.at(-1)).toMatchObject({ kind: 'WRITE_BLOCKED', errorCode: 'TELEMETRY_OR_DECISION_UNSAFE' });
  });

  it('does not acknowledge a write merely because its mocked request returns success', async () => {
    const context = setup();
    await trigger(context);
    context.writes.setTemporaryCurrentLimit.mockResolvedValue(success(undefined));
    expect(await context.execute()).toMatchObject({ ok: true, value: { status: 'READBACK_MISMATCH' } });
    expect(context.runtime.engine.state).toBe('FAULT');
    expect(context.runtime.engine.snapshot.restrictions).toEqual([]);
    expect(context.onIntervention).not.toHaveBeenCalled();
    expect(context.runtime.journal.events.at(-1)?.kind).toBe('READBACK_MISMATCH');
  });

  it('keeps owned constraints on controller loss and never treats unavailable Grid as zero', async () => {
    const context = setup();
    await trigger(context); await context.execute();
    context.setGrid(failure('MissingMeasurementError', 'Grid missing'));
    const snapshot = await context.step(34_000);
    expect(snapshot.engine).toMatchObject({ state: 'FAULT', gridImportW: null });
    expect(snapshot.telemetryHealth).toMatchObject({ healthy: false, recoveryAllowed: false, gridImportW: null });
    expect(snapshot.engine?.restrictions[0]?.temporaryCurrentLimitA).toBe(13);
    expect(context.state('garage').tcl).toBe(13);
    expect(context.writeCount()).toBe(1);
    expect(await context.runtime.refresh()).toEqual([]);
    expect(context.writes.clearTemporaryCurrentLimit).not.toHaveBeenCalled();
    expect(context.writes.resume).not.toHaveBeenCalled();
  });

  it('exposes an expired cached Grid as FAULT while retaining owned restrictions', async () => {
    const context = setup();
    await trigger(context); await context.execute();
    context.clock.now = 34_001;
    expect(context.runtime.snapshot.telemetryHealth).toMatchObject({ state: 'FAULT', healthy: false, gridImportW: null });
    expect(context.runtime.snapshot.engine).toMatchObject({ state: 'FAULT', gridImportW: null,
      restrictions: [{ chargerId: 'garage', temporaryCurrentLimitA: 13 }] });
    expect(context.state('garage').tcl).toBe(13);
    expect(context.writeCount()).toBe(1);
  });

  it('refresh detects controller faults, reports engine FAULT and preserves restrictions', async () => {
    const context = setup();
    await trigger(context); await context.execute();
    context.setGrid(failure('ConnectionError', 'Controller unavailable'));
    context.clock.now = 330_000;
    expect(await context.runtime.refresh()).toEqual([]);
    expect(context.runtime.snapshot.telemetryHealth?.healthy).toBe(false);
    expect(context.runtime.engine.state).toBe('FAULT');
    expect(context.state('garage').tcl).toBe(13);
    expect(context.writeCount()).toBe(1);
  });

  it('explicit maintenance refreshes only due owned limits, never during Override', async () => {
    const context = setup();
    await trigger(context); await context.execute();
    context.clock.now = 329_999;
    expect(await context.runtime.refresh()).toEqual([]);
    context.clock.now = 330_000;
    expect(await context.runtime.refresh()).toMatchObject([{ status: 'CONFIRMED' }]);
    expect(context.writes.setTemporaryCurrentLimit).toHaveBeenCalledTimes(2);
    expect(await context.runtime.refresh()).toEqual([]);
    context.runtime.applyManualOverride();
    context.clock.now = 630_000;
    expect(await context.runtime.refresh()).toEqual([]);
    expect(context.writes.setTemporaryCurrentLimit).toHaveBeenCalledTimes(2);
  });

  it('rejects pending execution if the pre-write controller request becomes stale', async () => {
    const context = setup();
    await trigger(context);
    context.readController.mockImplementation(async () => { context.clock.now += 4_001; return success(controller(22_839)); });
    expect(await context.execute()).toMatchObject({ ok: false });
    expect(context.runtime.engine.state).toBe('FAULT');
    expect(context.runtime.snapshot.telemetryHealth?.healthy).toBe(false);
    expect(context.writeCount()).toBe(0);
  });

  it('allows recovery only after 10 s of restored continuous valid telemetry', async () => {
    const context = setup();
    await trigger(context); await context.execute();
    context.setGrid(failure('ConnectionError', 'Controller unavailable'));
    await context.step(34_000);
    for (const timestamp of [35_000, 39_000, 43_000, 44_999]) {
      await context.step(timestamp, 17_000);
      expect(context.runtime.snapshot.telemetryHealth?.recoveryAllowed).toBe(false);
      if (context.runtime.engine.snapshot.pendingAction !== null) expect((await context.execute()).ok).toBe(false);
    }
    await context.step(45_000, 17_000);
    expect(context.runtime.snapshot.telemetryHealth?.recoveryAllowed).toBe(true);
    // A cancelled unexecuted intent still observes the existing engine's control interval.
    await context.step(49_000, 17_000);
    expect(await context.execute()).toMatchObject({ ok: true, value: { status: 'CONFIRMED' } });
    expect(context.state('garage').tcl).toBe(14);
    expect(context.writes.clearTemporaryCurrentLimit).not.toHaveBeenCalled();
    await context.step(53_000, 17_000);
    expect(await context.execute()).toMatchObject({ ok: true, value: { status: 'CONFIRMED' } });
    expect(context.state('garage').tcl).toBeNull();
    expect(context.writes.clearTemporaryCurrentLimit).toHaveBeenCalledOnce();
  });

  it('continues explicit local control while HCU is disconnected without manufacturing consent', async () => {
    const context = setup();
    context.runtime.setConnectionState('DISCONNECTED');
    context.onIntervention.mockResolvedValue(failure('ConnectionError', 'HCU unavailable'));
    await trigger(context); await context.execute();
    await context.step(34_000); await context.execute();
    expect(context.state('garage').tcl).toBe(12);
    expect(context.runtime.snapshot.connectionState).toBe('DISCONNECTED');
    expect(context.runtime.engine.snapshot.overrideActive).toBe(false);
    expect(context.onIntervention).toHaveBeenCalledOnce();
  });

  it('isolates an unavailable lower-priority charger and still limits Garage', async () => {
    const context = setup();
    context.unreachable.add('links');
    await trigger(context);
    expect(context.runtime.engine.snapshot.unavailableChargerIds).toContain('links');
    expect(await context.execute()).toMatchObject({ ok: true, value: { status: 'CONFIRMED' } });
    expect(context.state('garage').tcl).toBe(13);
    expect(context.writes.setTemporaryCurrentLimit.mock.calls[0]?.[0].id).toBe('garage');
  });

  it('YES before pause removes only a confirmed owned limit and suppresses new triggers', async () => {
    const context = setup();
    await trigger(context); await context.execute();
    context.runtime.applyManualOverride();
    await context.step(34_000);
    expect(context.runtime.engine.state).toBe('OVERRIDE');
    expect(context.runtime.engine.snapshot.pendingAction?.action.type).toBe('CLEAR_TEMPORARY_CURRENT_LIMIT');
    expect(await context.execute()).toMatchObject({ ok: true, value: { status: 'CONFIRMED' } });
    await context.step(38_000);
    expect(context.runtime.engine.snapshot.pendingAction).toBeNull();
    expect(context.runtime.engine.state).toBe('OVERRIDE');
    expect(context.writes.resume).not.toHaveBeenCalled();
    expect(context.state('garage').amp).toBe(14);
  });

  it('YES after owned pause resumes while retaining an external minimum limit', async () => {
    const context = setup();
    context.patch('garage', { amp: 6, tcl: 6, acu: 6 });
    await trigger(context);
    expect(context.runtime.engine.snapshot.pendingAction?.action.type).toBe('PAUSE');
    await context.execute();
    expect(context.state('garage').frc).toBe(1);
    context.runtime.applyManualOverride();
    await context.step(34_000);
    expect(context.runtime.engine.snapshot.pendingAction?.action.type).toBe('RESUME');
    await context.execute();
    expect(context.state('garage').frc).toBe(0);
    await context.step(38_000);
    expect(context.runtime.engine.snapshot.pendingAction).toBeNull();
    expect(context.writes.resume).toHaveBeenCalledOnce();
    expect(context.writes.clearTemporaryCurrentLimit).not.toHaveBeenCalled();
    expect(context.state('garage').tcl).toBe(6);
  });

  it('YES after reducing to minimum retains owned tcl during RESUME, then clears it', async () => {
    const context = setup();
    context.patch('garage', { amp: 7, acu: 7 });
    await trigger(context); await context.execute();
    expect(context.state('garage').tcl).toBe(6);
    await context.step(34_000); await context.execute();
    expect(context.state('garage').frc).toBe(1);
    context.runtime.applyManualOverride();
    await context.step(38_000);
    expect(context.runtime.engine.snapshot.pendingAction?.action.type).toBe('RESUME');
    await context.execute();
    expect(context.state('garage')).toMatchObject({ frc: 0, tcl: 6, acu: 6 });
    expect(context.writes.clearTemporaryCurrentLimit).not.toHaveBeenCalled();
    await context.step(42_000);
    expect(context.runtime.engine.snapshot.pendingAction?.action.type).toBe('CLEAR_TEMPORARY_CURRENT_LIMIT');
    await context.execute();
    expect(context.state('garage')).toMatchObject({ frc: 0, tcl: null, amp: 7 });
    expect(context.runtime.engine.snapshot.overrideActive).toBe(true);
  });

  it('enters LIMIT_UNACHIEVABLE without repeated PAUSE or notification spam', async () => {
    const context = setup();
    context.patch('garage', { amp: 7, acu: 7 });
    await trigger(context); await context.execute();
    await context.step(34_000); await context.execute();
    expect(context.writes.pause).toHaveBeenCalledOnce();
    for (const time of [38_000, 42_000, 46_000, 50_000]) {
      const snapshot = await context.step(time);
      expect(snapshot.engine?.state).toBe('LIMIT_UNACHIEVABLE');
      expect(snapshot.engine?.pendingAction).toBeNull();
      expect(snapshot.engine?.controllableChargingLoadRemaining).toBe(false);
    }
    expect(context.onWarning).toHaveBeenCalledOnce();
    expect(context.onWarning).toHaveBeenCalledWith('LIMIT_UNACHIEVABLE');
    expect(context.writes.pause).toHaveBeenCalledOnce();
    expect(context.writeCount()).toBe(2);
    expect(context.state('garage')).toMatchObject({ frc: 1, tcl: 6 });
  });

  it('Override restores a foreign baseline instead of clearing it', async () => {
    const context = setup();
    context.patch('garage', { tcl: 12, acu: 12 });
    await trigger(context); await context.execute();
    expect(context.state('garage').tcl).toBe(11);
    context.runtime.applyManualOverride();
    await context.step(34_000);
    expect(context.runtime.engine.snapshot.pendingAction?.action).toEqual({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 12 });
    await context.execute();
    expect(context.state('garage').tcl).toBe(12);
    expect(context.writes.clearTemporaryCurrentLimit).not.toHaveBeenCalled();
    expect(context.runtime.engine.snapshot.restrictions).toEqual([]);
  });

  it('unknown controller blocks Override cleanup as well', async () => {
    const context = setup();
    await trigger(context); await context.execute();
    context.runtime.applyManualOverride();
    await context.step(34_000);
    context.setGrid(failure('MissingMeasurementError', 'Grid unavailable'));
    expect(await context.execute()).toMatchObject({ ok: false });
    expect(context.state('garage').tcl).toBe(13);
    expect(context.writes.clearTemporaryCurrentLimit).not.toHaveBeenCalled();
  });

  it('Override never resumes a foreign pause or clears its external tcl', async () => {
    const context = setup();
    context.patch('garage', { frc: 1, car: 4, acu: null, alw: false, tcl: 8 });
    await context.runtime.initialize();
    context.runtime.applyManualOverride();
    for (const time of [0, 4_000, 8_000, 12_000]) await context.step(time);
    expect(context.runtime.engine.snapshot.pendingAction).toBeNull();
    expect(context.runtime.snapshot.actuator?.ownership[0]).toMatchObject({ ownershipStatus: 'NONE', pluginOwnedPause: false, pluginOwnedTcl: null });
    expect(context.state('garage')).toMatchObject({ frc: 1, tcl: 8 });
    expect(context.writeCount()).toBe(0);
  });

  it('requires explicit session end; car=4 never clears Override', async () => {
    const context = setup();
    await context.runtime.initialize();
    context.runtime.applyManualOverride();
    context.patch('garage', { car: 4, acu: null, alw: false });
    await context.step(0);
    expect(context.runtime.engine.snapshot.overrideActive).toBe(true);
    await context.runtime.endSession();
    expect(context.runtime.engine.snapshot.overrideActive).toBe(false);
    expect(context.onEndSession).toHaveBeenCalledOnce();
    expect(context.writeCount()).toBe(0);
  });

  it('blocks changed charger/controller bindings while a restriction is owned', async () => {
    const context = setup();
    await trigger(context); await context.execute();
    const changed = { ...context.config, chargers: context.config.chargers.map(charger => charger.id === 'garage' ? { ...charger, host: 'different.test' } : charger) };
    await expect(context.runtime.reconfigure(changed)).rejects.toThrow('Outstanding ownership');
    await expect(context.runtime.reconfigure({ ...context.config, controller: { host: 'replacement.test' } })).rejects.toThrow('Outstanding ownership');
    expect(context.runtime.engine.snapshot.restrictions[0]?.temporaryCurrentLimitA).toBe(13);
    expect(context.state('garage').tcl).toBe(13);
    expect(context.writeCount()).toBe(1);
  });

  it('preserves confirmed ownership and Override on harmless parameter changes', async () => {
    const context = setup();
    await trigger(context); await context.execute();
    context.runtime.applyManualOverride();
    await context.runtime.reconfigure({ ...context.config, loadManagement: { ...context.config.loadManagement, gridLimitW: 20_000 } });
    expect(context.runtime.engine.snapshot.overrideActive).toBe(true);
    expect(context.runtime.engine.snapshot.targetGridW).toBe(19_500);
    expect(context.runtime.engine.snapshot.restrictions[0]?.temporaryCurrentLimitA).toBe(13);
    expect(context.writeCount()).toBe(1);
  });

  it('rejects changed LIVE bindings even without ownership before accepting a configuration', async () => {
    const context = setup();
    await context.runtime.initialize();
    const changed = { ...context.config, chargers: context.config.chargers.map(charger => charger.id === 'garage'
      ? { ...charger, host: 'different.test' } : charger) };
    await expect(context.runtime.reconfigure(changed)).rejects.toThrow('startup reconciliation');
    await context.step(0);
    expect(context.probe).toHaveBeenLastCalledWith(context.config);
    expect(context.writeCount()).toBe(0);
  });

  it('allows priority and display-name changes while retaining confirmed device ownership', async () => {
    const context = setup();
    await trigger(context); await context.execute();
    await context.runtime.reconfigure({ ...context.config, chargers: context.config.chargers.map(charger => ({
      ...charger, name: `${charger.name} updated`, priority: charger.priority + 1,
    })).reverse() });
    expect(context.runtime.engine.snapshot.restrictions[0]?.temporaryCurrentLimitA).toBe(13);
    expect(context.runtime.snapshot.actuator?.ownership.find(state => state.chargerId === 'garage')?.ownershipStatus).toBe('OWNED');
    expect(context.writeCount()).toBe(1);
  });

  it('manual override discards an unexecuted reduction without losing confirmed restrictions', async () => {
    const context = setup();
    await trigger(context); await context.execute();
    await context.step(34_000);
    const pendingId = context.runtime.engine.snapshot.pendingAction?.id;
    expect(pendingId).toBeDefined();
    context.runtime.applyManualOverride();
    expect(context.runtime.engine.snapshot.pendingAction).toBeNull();
    expect(context.runtime.engine.snapshot.overrideActive).toBe(true);
    expect(context.runtime.engine.snapshot.restrictions[0]?.temporaryCurrentLimitA).toBe(13);
    expect(await context.runtime.executePendingAction(pendingId ?? '')).toMatchObject({ ok: false });
    expect(context.writeCount()).toBe(1);
  });

  it('parameter reconfiguration preserves the interval since the last confirmed write', async () => {
    const context = setup();
    await trigger(context); await context.execute();
    await context.runtime.reconfigure({ ...context.config,
      loadManagement: { ...context.config.loadManagement, gridLimitW: 20_000 } });
    await context.step(30_000);
    expect(context.runtime.engine.snapshot.pendingAction).toBeNull();
    await context.step(33_999);
    expect(context.runtime.engine.snapshot.pendingAction).toBeNull();
    expect(context.writeCount()).toBe(1);
    await context.step(34_000);
    expect(context.runtime.engine.snapshot.pendingAction?.action).toMatchObject({ type: 'SET_TEMPORARY_CURRENT_LIMIT', amps: 12 });
    expect(await context.execute()).toMatchObject({ ok: true, value: { status: 'CONFIRMED' } });
    expect(context.writeCount()).toBe(2);
  });

  it('shutdown persists restrictions and prohibits further observations/actions/refresh', async () => {
    const context = setup();
    await trigger(context); await context.execute();
    const reads = context.readStatus.mock.calls.length;
    const probes = context.probe.mock.calls.length;
    await context.runtime.stop();
    expect(context.state('garage').tcl).toBe(13);
    expect(context.persisted()?.chargers[0]?.pluginOwnedTcl).toBe(13);
    expect(context.runtime.snapshot.actuator?.state).toBe('STOPPED');
    await context.step(34_000);
    expect(await context.runtime.refresh()).toEqual([]);
    expect(await context.runtime.executePendingAction('any')).toMatchObject({ ok: false });
    expect(context.readStatus).toHaveBeenCalledTimes(reads);
    expect(context.probe).toHaveBeenCalledTimes(probes);
    expect(context.writeCount()).toBe(1);
    expect(context.writes.resume).not.toHaveBeenCalled();
    expect(context.writes.clearTemporaryCurrentLimit).not.toHaveBeenCalled();
  });

  it('reports failed shutdown persistence without clearing or resuming a charger', async () => {
    const context = setup();
    await trigger(context); await context.execute();
    vi.mocked(context.store.save).mockResolvedValueOnce(failure('ConfigurationError', 'Mock disk failure'));
    expect(await context.runtime.stop()).toMatchObject({ ok: false, error: { code: 'ConfigurationError' } });
    expect(context.runtime.snapshot.actuator).toMatchObject({ state: 'STOPPED',
      lastResult: { status: 'FAILED', code: 'OWNERSHIP_SHUTDOWN_SAVE_FAILED' } });
    expect(context.runtime.journal.events.at(-1)).toMatchObject({ kind: 'FAULT', errorCode: 'OWNERSHIP_SHUTDOWN_SAVE_FAILED' });
    expect(context.state('garage').tcl).toBe(13);
    expect(context.writeCount()).toBe(1);
    expect(context.writes.resume).not.toHaveBeenCalled();
    expect(context.writes.clearTemporaryCurrentLimit).not.toHaveBeenCalled();
    expect(await context.runtime.refresh()).toEqual([]);
  });

  it('imports reconciled confirmed ownership into the existing engine after restart', async () => {
    const owned = makeOwnedState({
      baseline: makeObservation({ ama: 32 }),
      lastObservedState: makeObservation({ tcl: 10, acu: 10, ama: 32, readStartedAtMs: 990, observedAtMs: 1_000 }),
      lastReadback: makeObservation({ tcl: 10, acu: 10, ama: 32, readStartedAtMs: 990, observedAtMs: 1_000 }),
    });
    const context = setup({ persisted: { version: 1, chargers: [owned] }, now: 2_000 });
    context.patch('garage', { tcl: 10, acu: 10 });
    expect((await context.runtime.initialize()).ok).toBe(true);
    expect(context.runtime.engine.snapshot).toMatchObject({ state: 'LIMITING', restrictions: [{ temporaryCurrentLimitA: 10, chargerId: 'garage' }] });
    expect(context.runtime.snapshot.actuator?.ownership[0]?.ownershipStatus).toBe('OWNED');
    expect(context.writeCount()).toBe(0);
    await context.step(2_000, 17_000);
    if (context.runtime.engine.snapshot.pendingAction !== null) expect((await context.execute()).ok).toBe(false);
    expect(context.writeCount()).toBe(0);
  });

  it('holds a persisted owned pause at restart and resumes only after stable telemetry', async () => {
    const owned = makeOwnedState({
      baseline: makeObservation({ amp: 7, acu: 7, ama: 32 }), pluginOwnedTcl: 6, pluginOwnedPause: true,
      lastConfirmedWrite: { action: { type: 'PAUSE', chargerId: 'garage' }, confirmedAtMs: 30_000 },
      lastObservedState: makeObservation({ amp: 7, tcl: 6, acu: null, frc: 1, car: 4, alw: false, ama: 32, readStartedAtMs: 29_990, observedAtMs: 30_000 }),
      lastReadback: makeObservation({ amp: 7, tcl: 6, acu: null, frc: 1, car: 4, alw: false, ama: 32, readStartedAtMs: 29_990, observedAtMs: 30_000 }),
      updatedAt: 30_000,
    });
    const context = setup({ persisted: { version: 1, chargers: [owned] }, now: 34_000 });
    context.patch('garage', { amp: 7, tcl: 6, acu: null, frc: 1, car: 4, alw: false });
    expect((await context.runtime.initialize()).ok).toBe(true);
    expect(context.runtime.engine.state).toBe('PAUSED');
    expect(context.writeCount()).toBe(0);
    context.runtime.applyManualOverride();
    for (const time of [34_000, 38_000, 42_000]) {
      await context.step(time);
      if (context.runtime.engine.snapshot.pendingAction !== null) expect((await context.execute()).ok).toBe(false);
      expect(context.state('garage').frc).toBe(1);
    }
    await context.step(46_000);
    expect(await context.execute()).toMatchObject({ ok: true, value: { status: 'CONFIRMED' } });
    expect(context.state('garage')).toMatchObject({ frc: 0, tcl: 6 });
    expect(context.writes.clearTemporaryCurrentLimit).not.toHaveBeenCalled();
    await context.step(50_000); await context.execute();
    expect(context.state('garage').tcl).toBeNull();
  });

  it('does not import conflicting persisted ownership or automatically repair it', async () => {
    const context = setup({ persisted: { version: 1, chargers: [makeOwnedState()] }, now: 2_000 });
    context.patch('garage', { tcl: 8, acu: 8 });
    expect((await context.runtime.initialize()).ok).toBe(true);
    expect(context.runtime.snapshot.actuator?.ownership[0]?.ownershipStatus).toBe('CONFLICT');
    expect(context.runtime.engine.snapshot.restrictions).toEqual([]);
    expect(context.state('garage').tcl).toBe(8);
    expect(context.writeCount()).toBe(0);
  });

  it('never adopts corrupt persisted ownership into an empty normal runtime', async () => {
    const context = setup();
    vi.mocked(context.store.load).mockResolvedValue(failure('ConfigurationError', 'Corrupt ownership file'));
    expect((await context.runtime.initialize()).ok).toBe(false);
    await context.step(30_000);
    expect(context.probe).not.toHaveBeenCalled();
    expect(context.writeCount()).toBe(0);
  });

  it('rate-limits repeated FAULT notifications and does not require HCU connectivity', async () => {
    const context = setup({ config: { ...makeConfig(), notifications: {
      intervention: true, interactive: true, controllerConnectionError: true, chargerConnectionError: true,
    } } });
    await context.runtime.initialize();
    context.setGrid(failure('ConnectionError', 'Controller fault'));
    context.onWarning.mockRejectedValue(new Error('HCU disconnected'));
    await context.step(0); await context.step(4_000); await context.step(59_999);
    expect(context.onWarning).toHaveBeenCalledOnce();
    await context.step(60_000);
    expect(context.onWarning).toHaveBeenCalledTimes(2);
    expect(context.writeCount()).toBe(0);
  });

  it('honors disabled controller notifications while keeping fault diagnostics', async () => {
    const context = setup();
    await context.runtime.initialize();
    context.setGrid(failure('ConnectionError', 'Controller unavailable'));
    await context.step(0); await context.step(60_000);
    expect(context.runtime.engine.state).toBe('FAULT');
    expect(context.onWarning).not.toHaveBeenCalled();
    expect(context.writeCount()).toBe(0);
  });

  it('bounds repeated fault diagnostics to fifty sanitized journal events', async () => {
    const context = setup();
    await context.runtime.initialize();
    context.setGrid(failure('ConnectionError', 'Controller unavailable'));
    for (let index = 0; index < 100; index += 1) await context.step(index * 4_000);
    expect(context.runtime.journal.events).toHaveLength(50);
    expect(context.runtime.journal.events.every(event => event.kind === 'FAULT')).toBe(true);
    expect(context.runtime.journal.events[0]?.timestamp).toBe(200_000);
    expect(context.writeCount()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('minimal phase-4 engine evidence APIs', () => {
  const restriction = { chargerId: 'garage', baselineTemporaryCurrentLimitA: null,
    temporaryCurrentLimitA: 10, paused: false, pausedAtMs: null };
  it('imports confirmed restrictions once into an unused engine', () => {
    const engine = new LoadManager(makeConfig());
    expect(engine.restoreConfirmedRestrictions([{ restriction, minimumPauseDurationMs: 0 }], 1_000)).toBe(true);
    expect(engine.state).toBe('LIMITING');
    expect(engine.restoreConfirmedRestrictions([{ restriction, minimumPauseDurationMs: 0 }], 1_000)).toBe(false);
  });

  it.each([
    { chargerId: 'missing' }, { chargerId: 'rechts' }, { temporaryCurrentLimitA: 0 },
    { temporaryCurrentLimitA: Number.MAX_SAFE_INTEGER + 1 },
    { baselineTemporaryCurrentLimitA: 8 }, { temporaryCurrentLimitA: null },
    { paused: true, pausedAtMs: null }, { paused: true, pausedAtMs: -1 }, { paused: true, pausedAtMs: 1_001 },
  ])('rejects invalid imported restriction %j without partial ownership', (patch) => {
    const engine = new LoadManager(makeConfig());
    expect(engine.restoreConfirmedRestrictions([{ restriction: { ...restriction, ...patch }, minimumPauseDurationMs: 0 }], 1_000)).toBe(false);
    expect(engine.snapshot.restrictions).toEqual([]);
  });

  it('rejects duplicate imported restrictions atomically', () => {
    const engine = new LoadManager(makeConfig());
    const entry = { restriction, minimumPauseDurationMs: 0 };
    expect(engine.restoreConfirmedRestrictions([entry, entry], 1_000)).toBe(false);
    expect(engine.snapshot.restrictions).toEqual([]);
  });

  it.each([
    { paused: false, pausedAtMs: 1_000 },
    { paused: 'true', pausedAtMs: 1_000 },
  ])('rejects contradictory or untyped pause flags %j', (patch) => {
    const engine = new LoadManager(makeConfig());
    const untyped = { ...restriction, ...patch } as unknown as typeof restriction;
    expect(engine.restoreConfirmedRestrictions([{ restriction: untyped, minimumPauseDurationMs: 0 }], 1_000)).toBe(false);
    expect(engine.snapshot.restrictions).toEqual([]);
  });

  it('only cancels the exact unexecuted pending action', () => {
    const engine = new LoadManager(makeConfig());
    const input = (time: number) => ({ timestampMs: time, measurementId: `time-${time}`,
      controller: success(controller(22_839)), chargers: [{ chargerId: 'garage', status: success(makeCharger()) }] });
    engine.evaluate(input(0));
    const decision = engine.evaluate(input(30_000));
    expect(engine.cancelPendingAction('wrong-id')).toBe(false);
    expect(engine.snapshot.pendingAction).not.toBeNull();
    expect(engine.cancelPendingAction(decision.actionId ?? '')).toBe(true);
    expect(engine.snapshot.pendingAction).toBeNull();
    expect(engine.snapshot.restrictions).toEqual([]);
    expect(engine.acknowledgeAction(decision.actionId ?? '')).toBe(false);
  });

  it('does not import ownership after measurements have started', () => {
    const engine = new LoadManager(makeConfig());
    engine.evaluate({ timestampMs: 0, measurementId: 'started', controller: success(controller(10_000)), chargers: [] });
    expect(engine.restoreConfirmedRestrictions([{ restriction, minimumPauseDurationMs: 0 }], 1_000)).toBe(false);
  });
});
