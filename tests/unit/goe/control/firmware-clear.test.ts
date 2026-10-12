import { describe, expect, it, vi } from 'vitest';
import { GoEChargerControlClient } from '../../../../src/goe/control/charger-control-client.js';
import { ChargerActuator } from '../../../../src/goe/control/charger-actuator.js';
import { failure, success } from '../../../../src/domain/errors.js';
import { makeObservation, makeOwnedState, testCharger } from './ownership-helpers.js';
import type { OwnershipDocument } from '../../../../src/goe/control/ownership-state.js';
import { reconcileOwnership } from '../../../../src/goe/control/actuator-reconciler.js';

const status = { amp: 14, tcl: 13, frc: 0, loe: false, car: 2, mca: 6, acu: 13,
  ama: 32, acp: true, mcpd: 0, alw: true };
const gate = { executionMode: 'LIVE' as const, realWritesEnabled: true };

function setup(firmware: unknown) {
  const fetchMock = vi.fn<typeof fetch>(async (url) => new Response(JSON.stringify(
    new URL(String(url)).pathname === '/api/status' ? { ...status, fwv: firmware } : { tcl: true })));
  const client = new GoEChargerControlClient({ gate, now: () => 0, fetch: fetchMock,
    tclClearCapability: 'JSON_NULL_VERIFIED', tclClearFirmwareProfile: 'GO_E_59_4' });
  return { client, fetchMock };
}

describe('installed firmware-scoped clear capability', () => {
  it('reads the current 59.4 firmware then writes exactly JSON-null, never amp/frc/loe', async () => {
    const { client, fetchMock } = setup('59.4');
    expect(await client.readStatus(testCharger)).toMatchObject({ ok: true, value: { firmwareVersion: '59.4', tclClearCapability: 'VERIFIED' } });
    fetchMock.mockClear();
    expect(await client.clearTemporaryCurrentLimit(testCharger)).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls[0]?.pathname).toBe('/api/status');
    expect(urls[1]?.pathname).toBe('/api/set');
    expect([...urls[1]!.searchParams.entries()]).toEqual([['tcl', 'null']]);
  });

  it.each(['59.3', '59.5', '60.0', '059.4', '59.4 ', '59.4-beta', '', null, 59.4, undefined])(
    'blocks incompatible or unknown firmware %s without a write', async (version) => {
      const { client, fetchMock } = setup(version);
      expect(await client.clearTemporaryCurrentLimit(testCharger)).toMatchObject({ ok: false,
        error: { message: expect.stringContaining('TCL_CLEAR_FIRMWARE_NOT_VERIFIED') } });
      expect(fetchMock.mock.calls.every(([url]) => new URL(String(url)).pathname === '/api/status')).toBe(true);
    });

  it('re-reads firmware after an update instead of using cached verified evidence', async () => {
    const { client, fetchMock } = setup('59.4');
    await client.readStatus(testCharger);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...status, fwv: '60.0' })));
    fetchMock.mockClear();
    expect((await client.clearTemporaryCurrentLimit(testCharger)).ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('firmware profile alone does not bypass the explicit clear capability or write gate', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const noCapability = new GoEChargerControlClient({ gate, now: () => 0, fetch: fetchMock,
      tclClearFirmwareProfile: 'GO_E_59_4' });
    expect((await noCapability.clearTemporaryCurrentLimit(testCharger)).ok).toBe(false);
    const dev = new GoEChargerControlClient({ gate: { executionMode: 'HCU_DEV', realWritesEnabled: true },
      now: () => 0, fetch: fetchMock, tclClearCapability: 'JSON_NULL_VERIFIED', tclClearFirmwareProfile: 'GO_E_59_4' });
    expect((await dev.clearTemporaryCurrentLimit(testCharger)).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['BLOCKED', 'UNKNOWN'] as const)('will not claim a null baseline without a verified rollback: %s', async (capability) => {
    let document: OwnershipDocument | null = null;
    const set = vi.fn(async () => success(undefined));
    const actuator = new ChargerActuator({ gate, now: () => 0, requireVerifiedClearForNewOwnership: true,
      store: { load: async () => success(document), save: async (value) => { document = value; return success(undefined); } },
      client: { readStatus: async () => success(makeObservation({ tclClearCapability: capability })),
        setTemporaryCurrentLimit: set, clearTemporaryCurrentLimit: set, pause: set, resume: set } });
    expect((await actuator.initialize([testCharger])).ok).toBe(true);
    expect(await actuator.execute({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 13 }, testCharger,
      { telemetryHealthy: true, recoveryAllowed: true, telemetrySampledAtMs: 0, overrideActive: false, loadManagementEnabled: true }))
      .toMatchObject({ status: 'BLOCKED', code: 'TCL_CLEAR_FIRMWARE_NOT_VERIFIED' });
    expect(set).not.toHaveBeenCalled();
  });

  it.each(['59.5', null, undefined])('retains own restrictions and reports conflict when an owned firmware profile changes to %s', (version) => {
    const own = makeOwnedState({ lastReadback: makeObservation({ tcl: 10, acu: 10,
      readStartedAtMs: 990, observedAtMs: 1_000, firmwareVersion: '59.4', tclClearCapability: 'VERIFIED' }) });
    const observed = makeObservation({ tcl: 10, acu: 10, readStartedAtMs: 2_000, observedAtMs: 2_000,
      ...(version === undefined ? {} : { firmwareVersion: version }) });
    expect(reconcileOwnership(own, observed)).toMatchObject({ ownershipStatus: 'CONFLICT',
      conflictStatus: 'FIRMWARE_PROFILE_CHANGED', pluginOwnedTcl: 10 });
  });

  it('runs the optional caller fence after the fresh firmware read and blocks without sending', async () => {
    const { client, fetchMock } = setup('59.4');
    const fence = vi.fn(() => {
      expect(fetchMock).toHaveBeenCalledOnce();
      return failure('ConfigurationError', 'WRITE_BLOCKED: OPERATION_CANCELLED.');
    });
    expect(await client.clearTemporaryCurrentLimit(testCharger, fence)).toMatchObject({ ok: false,
      error: { code: 'ConfigurationError', message: expect.stringContaining('OPERATION_CANCELLED') } });
    expect(fence).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('contains a throwing caller fence and never sends the clear request', async () => {
    const { client, fetchMock } = setup('59.4');
    expect(await client.clearTemporaryCurrentLimit(testCharger, () => { throw new Error('Unsafe caller'); }))
      .toMatchObject({ ok: false, error: { code: 'ConfigurationError' } });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(['shutdown', 'deactivation', 'override', 'stale telemetry',
    'external tcl', 'external frc', 'external amp', 'native balancing'] as const)(
    'never sends clear when %s occurs during the extra clear-firmware GET', async (event) => {
      const clock = { now: 0 };
      const current = { ...status, tcl: null as number | null, acu: 14, fwv: '59.4' };
      let document: OwnershipDocument | null = null;
      let reads = 0;
      let deferredReadAt = -1;
      let releaseRead: () => void = () => { throw new Error('No deferred read'); };
      let announceRead: () => void = () => { throw new Error('No deferred read'); };
      const readReached = new Promise<void>(resolve => { announceRead = resolve; });
      const readReleased = new Promise<void>(resolve => { releaseRead = resolve; });
      const writes: (number | null)[] = [];
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const url = new URL(String(input));
        if (url.pathname === '/api/status') {
          reads += 1;
          if (reads === deferredReadAt) { announceRead(); await readReleased; }
          return new Response(JSON.stringify(current));
        }
        expect(url.pathname).toBe('/api/set');
        expect([...url.searchParams.keys()]).toEqual(['tcl']);
        const value: unknown = JSON.parse(url.searchParams.get('tcl') ?? 'null');
        if (value !== null && typeof value !== 'number') throw new Error('Unexpected mock current');
        writes.push(value);
        current.tcl = value;
        current.acu = value ?? current.amp;
        return new Response(JSON.stringify({ tcl: true }));
      });
      const client = new GoEChargerControlClient({ gate, now: () => clock.now, fetch: fetchMock,
        tclClearCapability: 'JSON_NULL_VERIFIED', tclClearFirmwareProfile: 'GO_E_59_4' });
      const actuator = new ChargerActuator({ gate, now: () => clock.now, client,
        requireVerifiedClearForNewOwnership: true,
        store: { load: async () => success(document), save: async (value) => {
          document = structuredClone(value); return success(undefined);
        } } });
      const context = { telemetryHealthy: true, recoveryAllowed: true, telemetrySampledAtMs: 0,
        overrideActive: false, loadManagementEnabled: true };
      expect((await actuator.initialize([testCharger])).ok).toBe(true);
      expect(await actuator.execute({ type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 13 },
        testCharger, context)).toMatchObject({ status: 'CONFIRMED' });
      deferredReadAt = reads + 2; // Actuator pre-check, followed by client firmware preflight.
      const clearing = actuator.execute({ type: 'CLEAR_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage' }, testCharger, context);
      await readReached;
      const shutdown = event === 'shutdown' ? actuator.shutdown() : null;
      if (event === 'deactivation' || event === 'override') actuator.cancelPendingOperations();
      if (event === 'stale telemetry') clock.now = 4_001;
      if (event === 'external tcl') { current.tcl = 8; current.acu = 8; }
      if (event === 'external frc') current.frc = 1;
      if (event === 'external amp') current.amp = 12;
      if (event === 'native balancing') current.loe = true;
      releaseRead();
      expect(await clearing).toMatchObject({ status: 'BLOCKED', writeAttempted: false });
      if (shutdown !== null) expect((await shutdown).ok).toBe(true);
      expect(writes).toEqual([13]);
      expect(current.tcl).toBe(event === 'external tcl' ? 8 : 13);
      const ownershipStatus = event.startsWith('external') || event === 'native balancing' ? 'CONFLICT' : 'OWNED';
      expect(actuator.states[0]).toMatchObject({ ownershipStatus, pluginOwnedTcl: 13, pendingWrite: null });
      expect(document).toMatchObject({ chargers: [{ ownershipStatus, pluginOwnedTcl: 13, pendingWrite: null }] });
      if (ownershipStatus === 'CONFLICT') {
        expect(actuator.states[0]?.lastObservedState).toMatchObject({ tcl: current.tcl, frc: current.frc,
          amp: current.amp, loe: current.loe });
      }
    });
});
