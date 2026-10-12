import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../../src/config/config-types.js';
import { success, type Result } from '../../../src/domain/errors.js';
import { ChargerActuator } from '../../../src/goe/control/charger-actuator.js';
import { GoEChargerControlClient } from '../../../src/goe/control/charger-control-client.js';
import type { OwnershipDocument, OwnershipStore } from '../../../src/goe/control/ownership-state.js';
import { InstalledRuntime, type InstalledScheduler } from '../../../src/orchestration/installed-runtime.js';
import { makeConfig, allEnabledConfig } from '../load-management/helpers.js';

interface RawStatus {
  fna: string; fwv: string; amp: number; acu: number | null; tcl: number | null; frc: number;
  loe: boolean; car: number; mca: number; ama: number; acp: boolean; mcpd: number;
  alw: boolean; modelStatus: number;
}

function setup(options: { config?: AppConfig; enabled?: boolean; persisted?: OwnershipDocument;
  capability?: boolean; fakeClock?: boolean; scheduler?: InstalledScheduler } = {}) {
  const seed = options.config ?? makeConfig();
  const config = { ...seed, notifications: { intervention: true, interactive: true,
    controllerConnectionError: false, chargerConnectionError: false },
    loadManagement: { ...seed.loadManagement, liveControlEnabled: options.enabled ?? false } };
  const clock = { now: 0 };
  const now = options.fakeClock ? () => Date.now() : () => clock.now;
  const actual = new Map<string, RawStatus>();
  for (const charger of config.chargers) actual.set(charger.id, {
    fna: charger.name, fwv: '59.4', amp: 14, acu: charger.id === 'garage' ? 14 : null,
    tcl: null, frc: 0, loe: false, car: charger.id === 'garage' ? 2 : 1,
    mca: 6, ama: 32, acp: true, mcpd: 0, alw: charger.id === 'garage', modelStatus: 15,
  });
  let grid = 22_839;
  let controllerUnavailable = false;
  const unavailable = new Set<string>();
  const requests: URL[] = [];
  const writes: { chargerId: string; key: string; value: number | null; at: number }[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    requests.push(url);
    expect(init?.method).toBe('GET');
    if (url.hostname === 'controller.test') {
      if (controllerUnavailable) throw new Error('Mock controller unavailable');
      expect(url.pathname).toBe('/api/status');
      return new Response(JSON.stringify({ ccn: ['Grid'], ccp: [grid], cpc: [[1, 2, 3, null]] }));
    }
    const id = url.hostname.split('.')[0] ?? '';
    const status = actual.get(id);
    if (status === undefined || unavailable.has(id)) throw new Error('Mock charger unavailable');
    if (url.pathname === '/api/status') return new Response(JSON.stringify(status));
    if (url.pathname !== '/api/set') throw new Error('Unexpected mock path');
    const entries = [...url.searchParams.entries()];
    expect(entries).toHaveLength(1);
    const [key, encoded] = entries[0] ?? [];
    expect(['tcl', 'frc']).toContain(key);
    const value: unknown = JSON.parse(encoded ?? 'null');
    if (typeof value !== 'number' && value !== null) throw new Error('Unexpected mock value');
    writes.push({ chargerId: id, key: key ?? '', value, at: now() });
    if (key === 'tcl') {
      status.tcl = value;
      status.acu = status.frc === 1 || status.car !== 2 ? null : value ?? status.amp;
    } else {
      if (value !== 0 && value !== 1) throw new Error('Unexpected force state');
      status.frc = value;
      status.car = value === 1 ? 4 : 2;
      status.alw = value === 0;
      status.acu = value === 1 ? null : status.tcl ?? status.amp;
    }
    return new Response(JSON.stringify({ [key ?? '']: true }));
  });
  vi.stubGlobal('fetch', fetchMock);
  let persisted: OwnershipDocument | null = structuredClone(options.persisted ?? null);
  const store: OwnershipStore = {
    load: vi.fn(async (): Promise<Result<OwnershipDocument | null>> => success(structuredClone(persisted))),
    save: vi.fn(async (document): Promise<Result<void>> => { persisted = structuredClone(document); return success(undefined); }),
  };
  const gate = { executionMode: 'LIVE' as const, realWritesEnabled: options.capability ?? true };
  const client = new GoEChargerControlClient({ gate, now, fetch: fetchMock,
    tclClearCapability: 'JSON_NULL_VERIFIED', tclClearFirmwareProfile: 'GO_E_59_4' });
  const actuator = new ChargerActuator({ gate, now, client, store, sleep: async () => undefined,
    requireVerifiedClearForNewOwnership: true });
  let sequence = 0;
  const onSnapshot = vi.fn();
  const onIntervention = vi.fn(async () => success(undefined));
  const onEndSession = vi.fn(async () => undefined);
  const runtime = new InstalledRuntime({ config, gate, actuator, now,
    idProvider: { nextId: () => `installed-${++sequence}` }, onSnapshot, onIntervention, onEndSession,
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }) });
  const state = (id = 'garage') => { const value = actual.get(id); if (value === undefined) throw new Error('Unknown charger'); return value; };
  const tick = async (timestamp: number, newGrid?: number) => {
    clock.now = timestamp;
    if (newGrid !== undefined) grid = newGrid;
    return runtime.tick();
  };
  return { runtime, config, actuator, store, actual, state, writes, requests, fetchMock, tick, clock,
    onSnapshot, onIntervention, onEndSession, unavailable, persisted: () => structuredClone(persisted),
    setGrid: (value: number) => { grid = value; }, failController: (value = true) => { controllerUnavailable = value; } };
}

async function trigger(context: ReturnType<typeof setup>) {
  expect((await context.runtime.initialize()).ok).toBe(true);
  for (const at of [0, 4_000, 8_000, 12_000, 16_000, 20_000, 24_000, 28_000, 29_999]) await context.tick(at);
  return context.tick(30_000);
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('installed productive loop with a fully mocked HTTP boundary', () => {
  it('first-install disabled mode observes all enabled devices without abstract or real writes', async () => {
    const c = setup();
    expect(c.requests).toHaveLength(0);
    c.runtime.start();
    expect(c.requests).toHaveLength(0);
    await c.runtime.initialize();
    for (let at = 0; at <= 60_000; at += 4_000) await c.tick(at);
    expect(c.runtime.snapshot).toMatchObject({ mode: 'INSTALLED_LIVE', automaticLiveControlEnabled: false,
      realChargerWritesEnabled: true, engine: { state: 'NORMAL', pendingAction: null } });
    expect(c.writes).toEqual([]);
    expect(c.requests.some(url => url.hostname === 'controller.test')).toBe(true);
    expect(c.requests.some(url => url.hostname === 'garage.test')).toBe(true);
    expect(c.requests.some(url => url.hostname === 'links.test')).toBe(true);
    expect(c.requests.some(url => url.hostname === 'rechts.test')).toBe(false);
    expect(c.runtime.journal.events).toEqual([]);
  });

  it('an enabled config never bypasses the immutable container capability', async () => {
    const c = setup({ enabled: true, capability: false });
    expect((await c.runtime.initialize()).ok).toBe(false);
    await c.tick(30_000);
    expect(c.requests).toEqual([]);
    expect(c.writes).toEqual([]);
  });

  it('preserves the 30-second trigger and one 1-A write per 4-second decision', async () => {
    const c = setup({ enabled: true });
    const initialized = await c.runtime.initialize();
    expect(initialized.ok).toBe(true);
    for (const at of [0, 4_000, 8_000, 12_000, 16_000, 20_000, 24_000, 28_000, 29_999]) {
      await c.tick(at);
      expect(c.writes).toHaveLength(0);
    }
    expect(c.runtime.snapshot.engine?.state).toBe('TRIGGER_PENDING');
    await c.tick(30_000);
    expect(c.writes).toEqual([{ chargerId: 'garage', key: 'tcl', value: 13, at: 30_000 }]);
    await c.tick(31_000); await c.tick(33_999);
    expect(c.writes).toHaveLength(1);
    await c.tick(34_000);
    expect(c.writes.at(-1)).toEqual({ chargerId: 'garage', key: 'tcl', value: 12, at: 34_000 });
    expect(c.state().amp).toBe(14);
    expect(c.runtime.engine.snapshot.restrictions).toMatchObject([{ temporaryCurrentLimitA: 12 }]);
    expect(c.onIntervention).toHaveBeenCalledOnce();
    expect(c.actuator.states.find(state => state.chargerId === 'garage')?.lastReadback?.tcl).toBe(12);
  });

  it('waits ten seconds of fresh telemetry after activation even if the trigger is shorter', async () => {
    const c = setup({ config: makeConfig({ loadManagement: { triggerDurationSeconds: 1 } }) });
    await c.runtime.initialize();
    for (const at of [0, 4_000, 8_000, 12_000]) await c.tick(at);
    expect(c.runtime.snapshot.telemetryHealth?.recoveryAllowed).toBe(true);
    await c.runtime.reconfigure({ ...c.config, loadManagement: { ...c.config.loadManagement, liveControlEnabled: true } });
    for (const at of [12_000, 13_000, 16_000, 20_000]) {
      await c.tick(at);
      expect(c.writes).toHaveLength(0);
    }
    await c.tick(24_000);
    expect(c.runtime.snapshot.telemetryHealth?.recoveryAllowed).toBe(true);
    expect(c.writes).toHaveLength(1);
  });

  it('reduces Links before Garage and respects deterministic round robin for equal priorities', async () => {
    const c = setup({ enabled: true, config: allEnabledConfig() });
    Object.assign(c.state('links'), { car: 2, acu: 14, alw: true });
    Object.assign(c.state('rechts'), { car: 2, acu: 14, alw: true });
    await trigger(c);
    for (const at of [34_000, 38_000, 42_000]) await c.tick(at);
    expect(c.writes.map(write => [write.chargerId, write.value])).toEqual([
      ['links', 13], ['rechts', 13], ['links', 12], ['rechts', 12],
    ]);
    expect(c.state().tcl).toBeNull();
  });

  it('pauses Links at its reported minimum before reducing Garage', async () => {
    const c = setup({ enabled: true });
    Object.assign(c.state('links'), { car: 2, acu: 6, tcl: 6, alw: true });
    await trigger(c);
    expect(c.writes[0]).toMatchObject({ chargerId: 'links', key: 'frc', value: 1 });
    await c.tick(34_000);
    expect(c.writes[1]).toMatchObject({ chargerId: 'garage', key: 'tcl', value: 13 });
    expect(c.actuator.states.find(state => state.chargerId === 'links')?.pluginOwnedPause).toBe(true);
  });

  it('runs the full decrement, pause, readback, resume, and later current recovery path', async () => {
    const c = setup({ enabled: true });
    await trigger(c);
    for (let at = 34_000; at <= 62_000; at += 4_000) await c.tick(at);
    expect(c.writes.slice(0, 8).map(write => write.value)).toEqual([13, 12, 11, 10, 9, 8, 7, 6]);
    expect(c.writes.at(-1)).toMatchObject({ key: 'frc', value: 1 });
    expect(c.actuator.states.find(state => state.chargerId === 'garage')?.pluginOwnedPause).toBe(true);
    await c.tick(66_000, 17_000);
    expect(c.writes.at(-1)).toMatchObject({ key: 'frc', value: 0 });
    expect(c.state().tcl).toBe(6);
    expect(c.writes).toHaveLength(10);
    await c.tick(70_000);
    expect(c.writes.at(-1)).toMatchObject({ key: 'tcl', value: 7 });
    expect(c.state().amp).toBe(14);
  });

  it('recovers Garage before Links after both acquired own limits', async () => {
    const c = setup({ enabled: true });
    Object.assign(c.state('links'), { car: 2, acu: 7, amp: 7, alw: true });
    await trigger(c); // Links -> 6.
    await c.tick(34_000); // Pause Links.
    await c.tick(38_000); // Garage -> 13.
    await c.tick(42_000, 17_000);
    expect(c.writes.at(-1)).toMatchObject({ chargerId: 'garage', key: 'tcl', value: 14 });
    await c.tick(46_000);
    expect(c.writes.at(-1)).toMatchObject({ chargerId: 'garage', key: 'tcl', value: null });
    await c.tick(50_000);
    expect(c.writes.at(-1)).toMatchObject({ chargerId: 'links', key: 'frc', value: 0 });
  });

  it('deactivation cancels new reductions and only releases own restrictions with stable reserve', async () => {
    const c = setup({ enabled: true });
    await trigger(c);
    await c.runtime.reconfigure({ ...c.config, loadManagement: { ...c.config.loadManagement, liveControlEnabled: false } });
    for (const at of [34_000, 38_000, 42_000, 46_000]) await c.tick(at);
    expect(c.writes).toHaveLength(1);
    expect(c.state().tcl).toBe(13);
    expect(c.runtime.snapshot.automaticLiveControlEnabled).toBe(false);
    await c.tick(50_000, 17_000);
    expect(c.writes.at(-1)).toMatchObject({ key: 'tcl', value: null });
    expect(c.actuator.states.find(state => state.chargerId === 'garage')?.ownershipStatus).toBe('NONE');
  });

  it('never releases or refreshes while the controller is unavailable after deactivation', async () => {
    const c = setup({ enabled: true });
    await trigger(c);
    await c.runtime.reconfigure({ ...c.config, loadManagement: { ...c.config.loadManagement, liveControlEnabled: false } });
    c.failController();
    for (const at of [34_000, 38_000, 350_000]) await c.tick(at);
    expect(c.writes).toHaveLength(1);
    expect(c.state().tcl).toBe(13);
    expect(c.runtime.snapshot.engine?.state).toBe('FAULT');
  });

  it('disabled restart holds persisted ownership instead of startup clear or resume', async () => {
    const first = setup({ enabled: true });
    await trigger(first);
    const saved = first.persisted();
    expect(saved).not.toBeNull();
    if (saved === null) throw new Error('Expected persisted ownership');
    const second = setup({ persisted: saved });
    Object.assign(second.state(), { tcl: 13, acu: 13 });
    second.clock.now = 34_000;
    await second.runtime.initialize();
    for (const at of [34_000, 38_000, 42_000, 46_000]) await second.tick(at, 17_000);
    expect(second.writes).toHaveLength(0);
    expect(second.state().tcl).toBe(13);
  });

  it('recovers only after ten new healthy seconds following controller fault', async () => {
    const c = setup({ enabled: true });
    await trigger(c);
    c.failController(); await c.tick(34_000);
    c.failController(false);
    for (const at of [38_000, 42_000, 46_000]) {
      await c.tick(at, 17_000);
      expect(c.writes).toHaveLength(1);
    }
    await c.tick(50_000);
    expect(c.writes.at(-1)).toMatchObject({ key: 'tcl', value: 14 });
  });

  it('an unreachable idle charger does not prevent another reachable charger from being controlled', async () => {
    const c = setup({ enabled: true });
    c.unavailable.add('links');
    await trigger(c);
    expect(c.writes[0]).toMatchObject({ chargerId: 'garage', key: 'tcl', value: 13 });
    expect(c.runtime.engine.snapshot.unavailableChargerIds).toContain('links');
  });

  it('native load balancing and unknown firmware block own actuation conservatively', async () => {
    const c = setup({ enabled: true });
    c.state().loe = true;
    await trigger(c);
    expect(c.writes).toHaveLength(0);
    expect(c.actuator.states.find(state => state.chargerId === 'garage')?.ownershipStatus).toBe('CONFLICT');
    const unknown = setup({ enabled: true });
    unknown.state().fwv = '60.0';
    await trigger(unknown);
    expect(unknown.writes).toHaveLength(0);
    expect(unknown.actuator.states.find(state => state.chargerId === 'garage')?.lastObservedState?.tclClearCapability).toBe('BLOCKED');
  });

  it('Override resumes own pause first, then clears its own temporary limit without new reductions', async () => {
    const c = setup({ enabled: true });
    await trigger(c);
    for (let at = 34_000; at <= 62_000; at += 4_000) await c.tick(at);
    c.runtime.applyManualOverride();
    await c.tick(66_000);
    expect(c.writes.at(-1)).toMatchObject({ key: 'frc', value: 0 });
    expect(c.state().tcl).toBe(6);
    await c.tick(70_000);
    expect(c.writes.at(-1)).toMatchObject({ key: 'tcl', value: null });
    const count = c.writes.length;
    for (const at of [74_000, 78_000, 82_000]) await c.tick(at);
    expect(c.writes).toHaveLength(count);
    expect(c.runtime.snapshot.engine?.state).toBe('OVERRIDE');
  });

  it('refreshes an owned limit at 300 seconds only while activated and healthy', async () => {
    const c = setup({ enabled: true });
    await trigger(c);
    for (let at = 34_000; at <= 326_000; at += 4_000) await c.tick(at, 18_250);
    expect(c.writes).toHaveLength(1);
    await c.tick(330_000, 18_250);
    expect(c.writes).toHaveLength(2);
    expect(c.writes.at(-1)).toMatchObject({ key: 'tcl', value: 13 });
    await c.tick(334_000);
    expect(c.writes).toHaveLength(2);
  });

  it('does not refresh during Override or after an external ownership change', async () => {
    const c = setup({ enabled: true });
    await trigger(c);
    c.state().tcl = 9;
    c.state().acu = 9;
    for (let at = 34_000; at <= 334_000; at += 4_000) await c.tick(at, 18_250);
    expect(c.writes).toHaveLength(1);
    const own = setup({ enabled: true });
    await trigger(own);
    own.runtime.applyManualOverride();
    own.failController();
    await own.tick(330_000);
    expect(own.writes).toHaveLength(1);
  });

  it('permits safe HCUweb host rebinding only when ownership is NONE, and reconciles it read-only', async () => {
    const c = setup();
    await c.runtime.initialize();
    const changed = { ...c.config, chargers: c.config.chargers.map(charger => charger.id === 'garage'
      ? { ...charger, host: 'garage.replacement.test' } : charger) };
    await c.runtime.reconfigure(changed);
    expect(c.actuator.states.find(state => state.chargerId === 'garage')).toMatchObject({ host: 'garage.replacement.test', ownershipStatus: 'NONE' });
    expect(c.writes).toHaveLength(0);
    const owned = setup({ enabled: true });
    await trigger(owned);
    await expect(owned.runtime.reconfigure({ ...owned.config, chargers: changed.chargers })).rejects.toThrow('Outstanding ownership');
    expect(owned.state().tcl).toBe(13);
  });

  it('runs one scheduler chain, prevents overlap, and shuts down all timers without release', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const c = setup({ enabled: true, fakeClock: true });
    await c.runtime.initialize();
    c.runtime.start(); c.runtime.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(32_000);
    expect(c.writes).toHaveLength(1);
    expect(c.writes[0]).toMatchObject({ value: 13, at: 30_000 });
    expect(vi.getTimerCount()).toBe(1);
    await c.runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(c.writes).toHaveLength(1);
    expect(c.state().tcl).toBe(13);
    expect(c.runtime.snapshot.actuator?.state).toBe('STOPPED');
  });

  it('coalesces concurrent cycle calls instead of evaluating the same measurement twice', async () => {
    const c = setup();
    await c.runtime.initialize();
    const first = c.runtime.tick();
    const second = c.runtime.tick();
    expect(second).toBe(first);
    await first;
    expect(c.onSnapshot).toHaveBeenCalledOnce();
    expect(c.writes).toHaveLength(0);
  });

  it('LIMIT_UNACHIEVABLE does not repeat pause commands and a later recovery remains possible', async () => {
    const c = setup({ enabled: true });
    await trigger(c);
    for (let at = 34_000; at <= 62_000; at += 4_000) await c.tick(at);
    const count = c.writes.length;
    for (const at of [66_000, 70_000, 74_000]) await c.tick(at);
    expect(c.runtime.snapshot.engine?.state).toBe('LIMIT_UNACHIEVABLE');
    expect(c.writes).toHaveLength(count);
    await c.tick(78_000, 17_000);
    expect(c.writes.at(-1)).toMatchObject({ key: 'frc', value: 0 });
  });

  it('Override preserves a foreign numeric tcl baseline and never adopts a foreign pause', async () => {
    const c = setup({ enabled: true });
    Object.assign(c.state(), { tcl: 10, acu: 10 });
    Object.assign(c.state('links'), { tcl: 6, frc: 1, acu: null, alw: false, car: 4 });
    await trigger(c);
    expect(c.writes[0]).toMatchObject({ chargerId: 'garage', key: 'tcl', value: 9 });
    c.runtime.applyManualOverride();
    await c.tick(34_000);
    expect(c.writes[1]).toMatchObject({ chargerId: 'garage', key: 'tcl', value: 10 });
    expect(c.state('links').frc).toBe(1);
    expect(c.state('links').tcl).toBe(6);
    expect(c.writes.some(write => write.chargerId === 'links')).toBe(false);
  });

  it('an explicit YES can remove persisted own limits in disabled mode after new stabilization', async () => {
    const first = setup({ enabled: true });
    await trigger(first);
    const saved = first.persisted();
    if (saved === null) throw new Error('Expected saved ownership');
    const c = setup({ persisted: saved });
    Object.assign(c.state(), { tcl: 13, acu: 13 });
    c.clock.now = 34_000;
    await c.runtime.initialize();
    c.runtime.applyManualOverride();
    for (const at of [34_000, 38_000, 42_000]) {
      await c.tick(at);
      expect(c.writes).toHaveLength(0);
    }
    await c.tick(46_000);
    expect(c.writes).toEqual([{ chargerId: 'garage', key: 'tcl', value: null, at: 46_000 }]);
    expect(c.runtime.snapshot.automaticLiveControlEnabled).toBe(false);
  });

  it('explicit session end resets Override; car=4 alone never does', async () => {
    const c = setup({ enabled: true });
    await trigger(c);
    c.runtime.applyManualOverride();
    await c.tick(34_000);
    Object.assign(c.state(), { car: 4, acu: null, alw: false });
    await c.tick(38_000);
    expect(c.runtime.snapshot.engine?.overrideActive).toBe(true);
    await c.runtime.endSession();
    Object.assign(c.state(), { car: 2, acu: 14, alw: true });
    await c.tick(42_000);
    expect(c.runtime.snapshot.engine).toMatchObject({ overrideActive: false, state: 'TRIGGER_PENDING' });
  });

  it('deactivation arriving during precheck fences an unsent reduction', async () => {
    const c = setup({ enabled: true });
    await trigger(c);
    const original = c.fetchMock.getMockImplementation();
    if (original === undefined) throw new Error('Missing mock implementation');
    let release: (() => void) | undefined;
    const deferred = new Promise<void>(resolve => { release = resolve; });
    let intercepted = false;
    c.fetchMock.mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (!intercepted && url.hostname === 'garage.test' && url.pathname === '/api/status'
        && url.searchParams.get('filter')?.includes('loe')) {
        intercepted = true;
        await deferred;
      }
      return original(input, init);
    });
    const ticking = c.tick(34_000);
    await vi.waitFor(() => expect(intercepted).toBe(true));
    const disabling = c.runtime.reconfigure({ ...c.config,
      loadManagement: { ...c.config.loadManagement, liveControlEnabled: false } });
    release?.();
    await ticking; await disabling;
    expect(c.writes).toHaveLength(1);
    expect(c.state().tcl).toBe(13);
    expect(c.runtime.snapshot.automaticLiveControlEnabled).toBe(false);
  });

  it('shutdown during a transmitted write completes its readback, persists it, and creates no new message', async () => {
    const c = setup({ enabled: true });
    await c.runtime.initialize();
    for (const at of [0, 4_000, 8_000, 12_000, 16_000, 20_000, 24_000, 28_000]) await c.tick(at);
    const original = c.fetchMock.getMockImplementation();
    if (original === undefined) throw new Error('Missing mock implementation');
    let release: (() => void) | undefined;
    const deferred = new Promise<void>(resolve => { release = resolve; });
    c.fetchMock.mockImplementation(async (input, init) => {
      const response = await original(input, init);
      if (new URL(String(input)).pathname === '/api/set') await deferred;
      return response;
    });
    const ticking = c.tick(30_000);
    await vi.waitFor(() => expect(c.writes).toHaveLength(1));
    const stopped = c.runtime.stop();
    release?.();
    await ticking;
    expect((await stopped).ok).toBe(true);
    expect(c.persisted()?.chargers.find(state => state.chargerId === 'garage')).toMatchObject({
      pluginOwnedTcl: 13, ownershipStatus: 'OWNED', lastReadback: { tcl: 13 },
    });
    expect(c.onIntervention).not.toHaveBeenCalled();
    expect(c.writes).toHaveLength(1);
    expect(c.runtime.snapshot.actuator?.state).toBe('STOPPED');
  });

  it('reports a failed reconciliation as actuator FAULT and blocks subsequent writes', async () => {
    const c = setup({ enabled: true });
    await trigger(c);
    vi.mocked(c.store.load).mockRejectedValueOnce(new Error('Disk failure'));
    await expect(c.runtime.reconfigure(c.config)).rejects.toThrow('Ownership reconciliation failed');
    await c.tick(34_000);
    expect(c.writes).toHaveLength(1);
    expect(c.runtime.snapshot.actuator?.state).toBe('FAULT');
  });

  it('a stopped actuator cannot be revived by a queued configuration initialization', async () => {
    const c = setup({ enabled: true });
    await c.runtime.initialize();
    await c.runtime.stop();
    expect((await c.actuator.initialize(c.config.chargers)).ok).toBe(false);
    await expect(c.runtime.reconfigure(c.config)).rejects.toThrow('cannot be reconfigured');
    expect(c.writes).toHaveLength(0);
  });

  it('an innocuous HCUweb update keeps the current intervention session and its announcement', async () => {
    const c = setup({ enabled: true });
    await trigger(c);
    expect(c.onIntervention).toHaveBeenCalledOnce();
    await c.runtime.reconfigure({ ...c.config, loadManagement: { ...c.config.loadManagement, gridLimitW: 20_000 } });
    for (const at of [34_000, 38_000, 42_000, 46_000]) await c.tick(at);
    expect(c.onEndSession).not.toHaveBeenCalled();
    expect(c.onIntervention).toHaveBeenCalledOnce();
  });

  it('HCUweb reconfiguration preserves a manual session Override and never signals session end', async () => {
    const c = setup({ enabled: true });
    await trigger(c);
    c.runtime.applyManualOverride();
    await c.tick(34_000);
    await c.runtime.reconfigure({ ...c.config, notifications: { ...c.config.notifications, chargerConnectionError: true } });
    for (const at of [38_000, 42_000, 46_000, 50_000]) await c.tick(at);
    expect(c.runtime.engine.snapshot.overrideActive).toBe(true);
    expect(c.onEndSession).not.toHaveBeenCalled();
    expect(c.writes).toHaveLength(2);
  });

  it('re-enabling after operational cleanup does not erase an ongoing message session', async () => {
    const c = setup({ enabled: true });
    await trigger(c);
    await c.runtime.reconfigure({ ...c.config, loadManagement: { ...c.config.loadManagement, liveControlEnabled: false } });
    for (const at of [34_000, 38_000, 42_000, 46_000]) await c.tick(at, 17_000);
    await c.runtime.reconfigure(c.config);
    expect(c.onEndSession).not.toHaveBeenCalled();
    expect(c.runtime.engine.snapshot.overrideActive).toBe(false);
    expect(c.runtime.snapshot.automaticLiveControlEnabled).toBe(true);
  });

  it('a slower configured decision interval still polls fresh telemetry and spaces device actions accordingly', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const c = setup({ enabled: true, fakeClock: true, config: makeConfig({ loadManagement: { controlIntervalSeconds: 8 } }) });
    await c.runtime.initialize();
    c.runtime.start();
    await vi.advanceTimersByTimeAsync(32_000);
    expect(c.runtime.snapshot.telemetryHealth?.recoveryAllowed).toBe(true);
    expect(c.writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(c.writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(c.writes).toHaveLength(2);
    expect(c.writes.map(write => write.at)).toEqual([30_000, 38_000]);
    await c.runtime.stop();
  });

  it('keeps telemetry stable despite timer jitter without shortening the four-second action interval', async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const scheduler: InstalledScheduler = {
      setTimeout: (callback, delay) => setTimeout(callback, delay + 1),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    const c = setup({ enabled: true, fakeClock: true, scheduler });
    await c.runtime.initialize();
    c.runtime.start();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(c.writes).toHaveLength(0);
    expect(c.runtime.snapshot.telemetryHealth?.recoveryAllowed).toBe(true);
    await vi.advanceTimersByTimeAsync(17);
    expect(c.writes.map(write => write.at)).toEqual([30_016]);
    await vi.advanceTimersByTimeAsync(4_002);
    expect(c.writes.map(write => write.at)).toEqual([30_016, 34_018]);
    expect(c.runtime.snapshot.telemetryHealth?.recoveryAllowed).toBe(true);
    expect(c.writes.map(write => write.value)).toEqual([13, 12]);
    await c.runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
