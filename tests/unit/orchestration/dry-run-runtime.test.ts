import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, NotificationSettings } from '../../../src/config/config-types.js';
import type { ProbeReport, ChargerProbeResult } from '../../../src/diagnostics/probe-service.js';
import type { ChargerStatus } from '../../../src/domain/charger.js';
import { failure, success, type Result } from '../../../src/domain/errors.js';
import { DryRunRuntime } from '../../../src/orchestration/dry-run-runtime.js';
import { controller, idle, makeCharger, makeConfig } from '../load-management/helpers.js';

function report(config: AppConfig, garage: ChargerStatus = makeCharger(), grid = 22_839): ProbeReport {
  return {
    controller: success(controller(grid)),
    chargers: config.chargers.map((charger): ChargerProbeResult => {
      if (!charger.enabled) return { status: 'disabled', reachable: false, config: charger };
      return { status: 'reachable', reachable: true, config: charger,
        value: charger.id === 'garage' ? garage : idle(charger.id) };
    }),
  };
}

function setup(options: { config?: AppConfig; notifications?: Partial<NotificationSettings> } = {}) {
  const config: AppConfig = options.config ?? { ...makeConfig(), notifications: {
    intervention: true, interactive: true, controllerConnectionError: false,
    chargerConnectionError: false, ...options.notifications,
  } };
  const clock = { time: 0 };
  let observed = report(config);
  let sequence = 0;
  const probe = vi.fn(async (_config: AppConfig): Promise<ProbeReport> => structuredClone(observed));
  const onIntervention = vi.fn(async (): Promise<Result<void>> => success(undefined));
  const onEndSession = vi.fn(async () => undefined);
  const onConnectionWarning = vi.fn(async (_kind: 'controller' | 'charger') => undefined);
  const interaction = { lastMessage: null as string | null, lastAnswer: null as string | null };
  const runtime = new DryRunRuntime({ config, now: () => clock.time,
    idProvider: { nextId: () => `measurement-${++sequence}` }, probe,
    onIntervention, onEndSession, onConnectionWarning, getInteractionStatus: () => interaction });
  return { runtime, config, clock, probe, onIntervention, onEndSession, onConnectionWarning, interaction,
    setReport: (value: ProbeReport) => { observed = value; },
    setGrid: (grid: number) => { observed = { ...observed, controller: success(controller(grid)) }; },
    step: async (timestamp: number) => { clock.time = timestamp; return runtime.tick(); },
  };
}

async function trigger(context: ReturnType<typeof setup>) {
  await context.step(0);
  return context.step(30_000);
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('DryRunRuntime real read-only observations plus separate simulated controls', () => {
  it('exposes an empty explicit dry-run snapshot without probing or notifying at construction', () => {
    const context = setup();
    expect(context.runtime.snapshot).toMatchObject({ mode: 'DRY_RUN', observedAtMs: null,
      probe: null, engine: null, realChargerWritesEnabled: false });
    expect(context.probe).not.toHaveBeenCalled();
    expect(context.onIntervention).not.toHaveBeenCalled();
  });

  it('covers the real 22.839 kW sample: no action before 30 s, then only abstract Garage 13 A', async () => {
    const context = setup();
    expect((await context.step(0)).engine?.state).toBe('TRIGGER_PENDING');
    expect((await context.step(29_999)).lastDecision?.action).toBeNull();
    const snapshot = await context.step(30_000);
    expect(snapshot.engine?.state).toBe('LIMITING');
    expect(snapshot.lastAction).toEqual({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 13 });
    expect(snapshot.engine?.pendingAction).toBeNull();
    expect(snapshot.engine?.restrictions).toMatchObject([{ chargerId: 'garage', temporaryCurrentLimitA: 13 }]);
    expect(context.runtime.journal.entries).toHaveLength(1);
    expect(context.onIntervention).toHaveBeenCalledOnce();
  });

  it('retains actual amp/acu/tcl in the real snapshot while the virtual loop moves from 13 A to 12 A', async () => {
    const context = setup();
    await trigger(context);
    const snapshot = await context.step(34_000);
    expect(snapshot.lastAction).toEqual({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 12 });
    expect(snapshot.engine?.restrictions[0]?.temporaryCurrentLimitA).toBe(12);
    const garage = snapshot.probe?.chargers.find((charger) => charger.config.id === 'garage');
    expect(garage?.status).toBe('reachable');
    if (garage?.status !== 'reachable') throw new Error('Expected real Garage observation');
    expect(garage.value).toMatchObject({ configuredCurrentA: 14, effectiveCurrentA: 14, temporaryCurrentLimitA: null, forceState: 0 });
    expect(snapshot.probe?.controller).toEqual(success(controller(22_839)));
    expect(snapshot.engine?.gridImportW).toBe(22_839);
    expect(context.runtime.journal.entries.at(-1)?.chargerSnapshotSummary[0]?.effectiveCurrentA).toBe(13);
  });

  it('requires a fresh configured interval between virtual actions', async () => {
    const context = setup();
    await trigger(context);
    expect((await context.step(33_999)).lastDecision?.action).toBeNull();
    expect(context.runtime.journal.entries).toHaveLength(1);
    expect((await context.step(34_000)).lastDecision?.action).toMatchObject({ amps: 12 });
    expect(context.runtime.journal.entries).toHaveLength(2);
  });

  it('continues the simulation while HCU is disconnected and does not manufacture an override', async () => {
    const context = setup();
    context.runtime.setConnectionState('DISCONNECTED');
    context.onIntervention.mockResolvedValue(failure('ConnectionError', 'HCU offline'));
    await trigger(context);
    const snapshot = await context.step(34_000);
    expect(snapshot.connectionState).toBe('DISCONNECTED');
    expect(snapshot.engine?.overrideActive).toBe(false);
    expect(snapshot.lastDecision?.action).toMatchObject({ amps: 12 });
    expect(context.onIntervention).toHaveBeenCalledOnce();
  });

  it('contains unexpected HCU callback exceptions without changing automatic regulation', async () => {
    const context = setup();
    context.onIntervention.mockRejectedValue(new Error('failed HCU notification'));
    await expect(trigger(context)).resolves.toMatchObject({ engine: { state: 'LIMITING' } });
    expect((await context.step(34_000)).lastDecision?.action).toMatchObject({ amps: 12 });
    expect(context.runtime.engine.snapshot.overrideActive).toBe(false);
  });

  it('further reduction steps and reconnect do not spam additional override questions', async () => {
    const context = setup();
    await trigger(context);
    await context.step(34_000);
    context.runtime.setConnectionState('RECONNECTING');
    await context.step(38_000);
    context.runtime.setConnectionState('READY');
    await context.step(42_000);
    expect(context.onIntervention).toHaveBeenCalledOnce();
    expect(context.runtime.journal.entries).toHaveLength(4);
  });

  it.each([
    { intervention: false, interactive: true },
    { intervention: true, interactive: false },
    { intervention: false, interactive: false },
  ])('notification toggles %j suppress only HCU interaction, preserving the engine action', async (notifications) => {
    const context = setup({ notifications });
    expect((await trigger(context)).lastAction).toMatchObject({ amps: 13 });
    expect(context.onIntervention).not.toHaveBeenCalled();
  });

  it('legacy phase-1 configuration without notification settings sends no questions', async () => {
    const context = setup({ config: makeConfig() });
    expect((await trigger(context)).lastAction).toMatchObject({ amps: 13 });
    expect(context.onIntervention).not.toHaveBeenCalled();
  });

  it('controller outage enters FAULT, keeps virtual restrictions, and never frees power', async () => {
    const context = setup();
    await trigger(context);
    const broken = report(context.config);
    context.setReport({ ...broken, controller: failure('MissingMeasurementError', 'Grid is unavailable') });
    const snapshot = await context.step(34_000);
    expect(snapshot.engine).toMatchObject({ state: 'FAULT', gridImportW: null, restrictions: [{ temporaryCurrentLimitA: 13 }] });
    expect(snapshot.lastDecision?.action).toBeNull();
    expect(context.runtime.journal.entries).toHaveLength(1);
  });

  it('an unexpected probe rejection becomes an explicit safe controller fault', async () => {
    const context = setup();
    context.probe.mockRejectedValue(new Error('network reader failed'));
    await expect(context.step(0)).resolves.toMatchObject({ engine: { state: 'FAULT', gridImportW: null } });
    expect(context.runtime.journal.entries).toHaveLength(0);
    expect(context.onIntervention).not.toHaveBeenCalled();
  });

  it('isolates unavailable idle Links and keeps reachable Garage controllable', async () => {
    const context = setup();
    const observed = report(context.config);
    context.setReport({ ...observed, chargers: observed.chargers.map((charger): ChargerProbeResult =>
      charger.config.id === 'links' ? { status: 'unavailable', reachable: false, config: charger.config,
        error: { code: 'ConnectionError', message: 'Links offline' } } : charger) });
    const snapshot = await trigger(context);
    expect(snapshot.engine?.state).toBe('LIMITING');
    expect(snapshot.engine?.unavailableChargerIds).toEqual(['links']);
    expect(snapshot.lastAction).toMatchObject({ chargerId: 'garage', amps: 13 });
  });

  it.each([
    { temporaryCurrentLimitA: 10 },
    { forceState: 1 },
  ])('fails closed when real controls change behind virtual ownership: %j', async (patch) => {
    const context = setup();
    await trigger(context);
    context.setReport(report(context.config, makeCharger('garage', patch), 17_000));
    const snapshot = await context.step(34_000);
    expect(snapshot.engine?.state).toBe('FAULT');
    expect(snapshot.lastDecision?.action).toBeNull();
    expect(snapshot.simulationNote).toContain('Real charger controls changed');
    expect(snapshot.engine?.restrictions[0]?.temporaryCurrentLimitA).toBe(13);
    expect(context.runtime.journal.entries).toHaveLength(1);
  });

  it('negative actual signed Grid safely allows virtual recovery while preserving real measurement', async () => {
    const context = setup();
    await trigger(context);
    context.setGrid(-500);
    const snapshot = await context.step(34_000);
    expect(snapshot.engine?.gridImportW).toBe(0);
    expect(snapshot.lastDecision?.action).toMatchObject({ amps: 14 });
    expect(snapshot.probe?.controller).toEqual(success(controller(-500)));
  });

  it('simulates minimum/pause/unachievable/resume safely without modifying real Charger values', async () => {
    const context = setup();
    await trigger(context);
    for (let timestamp = 34_000; timestamp <= 58_000; timestamp += 4_000) await context.step(timestamp);
    expect(context.runtime.engine.snapshot.restrictions[0]?.temporaryCurrentLimitA).toBe(6);
    const paused = await context.step(62_000);
    expect(paused.lastDecision?.action).toEqual({ type: 'PAUSE', chargerId: 'garage' });
    expect(paused.engine?.restrictions[0]?.paused).toBe(true);
    const impossible = await context.step(66_000);
    expect(impossible.engine?.state).toBe('LIMIT_UNACHIEVABLE');
    expect(impossible.lastDecision?.action).toBeNull();
    const countBeforeRecovery = context.runtime.journal.entries.length;
    context.setGrid(17_000);
    const resumed = await context.step(70_000);
    expect(resumed.lastDecision?.action).toEqual({ type: 'RESUME', chargerId: 'garage' });
    expect(resumed.engine?.restrictions[0]).toMatchObject({ paused: false, temporaryCurrentLimitA: 6 });
    expect(context.runtime.journal.entries).toHaveLength(countBeforeRecovery + 1);
    const raised = await context.step(74_000);
    expect(raised.lastDecision?.action).toEqual({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 7 });
    const real = raised.probe?.chargers.find((charger) => charger.config.id === 'garage');
    if (real?.status !== 'reachable') throw new Error('Expected real Charger snapshot');
    expect(real.value).toMatchObject({ carState: { code: 2 }, effectiveCurrentA: 14, temporaryCurrentLimitA: null, forceState: 0 });
    expect(context.onIntervention).toHaveBeenCalledOnce();
  });

  it('uses central hysteresis to hold 18.250 kW and only recover at the 18.000 kW threshold', async () => {
    const context = setup();
    await trigger(context);
    context.setGrid(18_250);
    expect((await context.step(34_000)).lastDecision?.action).toBeNull();
    expect(context.runtime.journal.entries).toHaveLength(1);
    context.setGrid(18_000);
    expect((await context.step(38_000)).lastDecision?.action).toMatchObject({ amps: 14 });
  });

  it('explicit override generates only virtual cleanup and no further trigger while active', async () => {
    const context = setup();
    await trigger(context);
    context.runtime.applyManualOverride();
    const cleared = await context.step(34_000);
    expect(cleared.engine?.state).toBe('OVERRIDE');
    expect(cleared.lastDecision?.action).toEqual({ type: 'CLEAR_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage' });
    expect((await context.step(38_000)).lastDecision?.action).toBeNull();
    expect(context.runtime.engine.snapshot.overrideActive).toBe(true);
  });

  it('explicit session event ends override while retaining engine-owned cleanup state', async () => {
    const context = setup();
    await trigger(context);
    context.runtime.applyManualOverride();
    await context.runtime.endSession();
    expect(context.runtime.engine.snapshot).toMatchObject({ overrideActive: false,
      restrictions: [{ chargerId: 'garage', temporaryCurrentLimitA: 13 }] });
    expect(context.onEndSession).toHaveBeenCalledOnce();
    expect(context.runtime.engine.state).toBe('RECOVERING');
  });

  it('does not infer real session-end from a reported car=4', async () => {
    const context = setup();
    context.runtime.applyManualOverride();
    context.setReport(report(context.config, makeCharger('garage', { carState: { kind: 'known', code: 4, label: 'complete' },
      effectiveCurrentA: null, chargingAllowed: false })));
    const snapshot = await context.step(0);
    expect(snapshot.engine?.overrideActive).toBe(true);
    expect(context.onEndSession).not.toHaveBeenCalled();
  });

  it('exposes safe interaction summaries and clones its returned real snapshots', async () => {
    const context = setup();
    context.interaction.lastMessage = 'TEST: go-e Lastmanagement';
    context.interaction.lastAnswer = 'YES';
    const snapshot = await context.step(0);
    expect(snapshot.lastHcuMessage).toBe('TEST: go-e Lastmanagement');
    expect(snapshot.lastHcuAnswer).toBe('YES');
    if (!snapshot.probe?.controller.ok) throw new Error('Expected Grid value');
    Object.assign(snapshot.probe.controller.value, { gridImportW: 0 });
    expect(context.runtime.snapshot.probe?.controller).toEqual(success(controller(22_839)));
  });
});

describe('DryRunRuntime polling lifecycle and atomic reconfiguration', () => {
  it('coalesces overlapping manual ticks into one read-only observation', async () => {
    const context = setup();
    let resolveProbe: (value: ProbeReport) => void = () => undefined;
    context.probe.mockReturnValueOnce(new Promise((resolve) => { resolveProbe = resolve; }));
    const first = context.runtime.tick();
    const second = context.runtime.tick();
    expect(context.probe).toHaveBeenCalledOnce();
    resolveProbe(report(context.config));
    const snapshots = await Promise.all([first, second]);
    expect(snapshots[0]).toEqual(snapshots[1]);
    expect(context.probe).toHaveBeenCalledOnce();
  });

  it('discards an old in-flight probe after configuration generation changes', async () => {
    const context = setup();
    let resolveProbe: (value: ProbeReport) => void = () => undefined;
    context.probe.mockReturnValueOnce(new Promise((resolve) => { resolveProbe = resolve; }));
    const pending = context.runtime.tick();
    const config = makeConfig({ loadManagement: { gridLimitW: 25_000 } });
    await context.runtime.reconfigure(config);
    resolveProbe(report(context.config));
    const snapshot = await pending;
    expect(snapshot.observedAtMs).toBeNull();
    expect(snapshot.engine).toBeNull();
    expect(context.runtime.journal.entries).toHaveLength(0);
    expect(context.onIntervention).not.toHaveBeenCalled();
    expect(context.onEndSession).toHaveBeenCalledOnce();
    await context.runtime.tick();
    expect(context.probe).toHaveBeenLastCalledWith(config);
    expect(context.runtime.engine.snapshot.targetGridW).toBe(24_500);
  });

  it('resets virtual ownership on explicit valid config swap and preserves HCU connection status', async () => {
    const context = setup();
    context.runtime.setConnectionState('READY');
    await trigger(context);
    await context.runtime.reconfigure(makeConfig({ loadManagement: { gridLimitW: 25_000 } }));
    expect(context.runtime.snapshot).toMatchObject({ observedAtMs: null, probe: null,
      engine: null, lastAction: null, connectionState: 'READY' });
    expect(context.runtime.engine.snapshot.restrictions).toEqual([]);
    expect(context.runtime.journal.entries).toHaveLength(1);
    expect((await context.step(34_000)).engine?.state).toBe('NORMAL');
  });

  it('start is idempotent, configured polling cadence is honored, and stop removes future polls', async () => {
    vi.useFakeTimers();
    const context = setup();
    context.runtime.start(); context.runtime.start();
    expect(context.probe).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(context.probe).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3_999);
    expect(context.probe).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(context.probe).toHaveBeenCalledTimes(2);
    await context.runtime.stop();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(context.probe).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop waits for an in-flight observation and does not reschedule after its completion', async () => {
    vi.useFakeTimers();
    const context = setup();
    let resolveProbe: (value: ProbeReport) => void = () => undefined;
    context.probe.mockReturnValueOnce(new Promise((resolve) => { resolveProbe = resolve; }));
    context.runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    let stopped = false;
    const stop = context.runtime.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    resolveProbe(report(context.config));
    await stop;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(context.probe).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('controller/charger warning callbacks are edge-triggered and do not alter fault semantics', async () => {
    const context = setup({ notifications: { controllerConnectionError: true, chargerConnectionError: true } });
    const observed = report(context.config);
    context.setReport({ controller: failure('ConnectionError', 'Controller offline'),
      chargers: observed.chargers.map((charger): ChargerProbeResult => charger.config.id === 'links'
        ? { status: 'unavailable', reachable: false, config: charger.config,
          error: { code: 'ConnectionError', message: 'Links offline' } } : charger) });
    expect((await context.step(0)).engine?.state).toBe('FAULT');
    expect((await context.step(4_000)).engine?.state).toBe('FAULT');
    expect(context.onConnectionWarning.mock.calls).toEqual([['controller'], ['charger']]);
    context.setReport(observed);
    await context.step(8_000);
    context.setReport({ ...observed, controller: failure('ConnectionError', 'Controller offline again') });
    await context.step(12_000);
    expect(context.onConnectionWarning.mock.calls).toEqual([['controller'], ['charger'], ['controller']]);
  });

  it('contains warning callback failures and never manufactures recovery', async () => {
    const context = setup({ notifications: { controllerConnectionError: true } });
    context.onConnectionWarning.mockRejectedValueOnce(new Error('HCU offline'));
    context.setReport({ ...report(context.config), controller: failure('ConnectionError', 'Controller offline') });
    await expect(context.step(0)).resolves.toMatchObject({ engine: { state: 'FAULT' } });
    expect(context.runtime.journal.entries).toHaveLength(0);
  });
});
