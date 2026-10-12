import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChargerConfig } from '../../../../src/config/config-types.js';
import { GoEChargerControlClient } from '../../../../src/goe/control/charger-control-client.js';
import type { ChargerControlClient, ExecutionMode, WriteGate } from '../../../../src/goe/control/control-types.js';

const CHARGER: ChargerConfig = { id: 'garage', name: 'Garage', host: 'charger.example:8080', enabled: true, priority: 1 };
const LIVE: WriteGate = { executionMode: 'LIVE', realWritesEnabled: true };
const STATUS = { amp: 14, tcl: null, frc: 0, loe: false, car: 2, mca: 6, acu: 14, ama: 32, acp: true, mcpd: 0, alw: true };
const operations = [
  { name: 'setTemporaryCurrentLimit', key: 'tcl', value: '13', run: (client: ChargerControlClient, config: ChargerConfig) => client.setTemporaryCurrentLimit(config, 13) },
  { name: 'clearTemporaryCurrentLimit', key: 'tcl', value: 'null', run: (client: ChargerControlClient, config: ChargerConfig) => client.clearTemporaryCurrentLimit(config) },
  { name: 'pause', key: 'frc', value: '1', run: (client: ChargerControlClient, config: ChargerConfig) => client.pause(config) },
  { name: 'resume', key: 'frc', value: '0', run: (client: ChargerControlClient, config: ChargerConfig) => client.resume(config) },
] as const;

function response(value: unknown): Response {
  return new Response(JSON.stringify(value));
}

function client(fetchMock: typeof fetch, gate: WriteGate = LIVE) {
  return new GoEChargerControlClient({ gate, now: () => 1000, fetch: fetchMock, tclClearCapability: 'JSON_NULL_VERIFIED' });
}

afterEach(() => vi.useRealTimers());

describe('GoEChargerControlClient hard write gate', () => {
  it.each([
    ['HCU_DEV', false], ['HCU_DEV', true], ['DRY_RUN', false], ['DRY_RUN', true], ['LIVE', false],
  ] as const)('%s plus flag=%s blocks all four operations before HTTP', async (executionMode, realWritesEnabled) => {
    const fetchMock = vi.fn<typeof fetch>();
    const control = client(fetchMock, { executionMode, realWritesEnabled });
    for (const operation of operations) {
      const result = await operation.run(control, CHARGER);
      expect(result).toMatchObject({ ok: false, error: { code: 'ConfigurationError', message: expect.stringContaining('WRITE_BLOCKED') } });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(operations)('LIVE plus true permits only $name with its fixed key/value', async (operation) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response({ [operation.key]: true }));
    expect(await operation.run(client(fetchMock), CHARGER)).toEqual({ ok: true, value: undefined });
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    const url = new URL(String(input));
    expect(url.origin).toBe('http://charger.example:8080');
    expect(url.pathname).toBe('/api/set');
    expect([...url.searchParams.entries()]).toEqual([[operation.key, operation.value]]);
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit', headers: { accept: 'application/json' } });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init).not.toHaveProperty('body');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not treat a truthy string flag as a write permission', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const gate = { executionMode: 'LIVE', realWritesEnabled: 'true' } as unknown as WriteGate;
    expect(await client(fetchMock, gate).pause(CHARGER)).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not treat an unknown execution mode as LIVE', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    expect(await client(fetchMock, { executionMode: 'live' as ExecutionMode, realWritesEnabled: true }).pause(CHARGER)).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('captures the mode so mutating the input cannot promote a DEV client', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const gate: { executionMode: ExecutionMode; realWritesEnabled: boolean } = { executionMode: 'HCU_DEV', realWritesEnabled: false };
    const control = client(fetchMock, gate);
    gate.executionMode = 'LIVE';
    gate.realWritesEnabled = true;
    expect(await control.pause(CHARGER)).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exposes no generic key/path API or method for amp, loe or other device settings', () => {
    const control = client(vi.fn<typeof fetch>());
    expect(Object.getOwnPropertyNames(GoEChargerControlClient.prototype).sort()).toEqual([
      'clearTemporaryCurrentLimit', 'constructor', 'pause', 'readStatus', 'resume', 'setTemporaryCurrentLimit',
    ]);
    expect(Object.keys(control)).toEqual([]);
  });
});

describe('control validation before HTTP', () => {
  it('blocks tcl clear until its null semantics were explicitly verified', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const control = new GoEChargerControlClient({ gate: LIVE, now: () => 1000, fetch: fetchMock });
    expect(await control.clearTemporaryCurrentLimit(CHARGER)).toMatchObject({ ok: false, error: { message: expect.stringContaining('TCL_CLEAR_SEMANTICS_UNVERIFIED') } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(operations)('disabled chargers cannot perform $name', async (operation) => {
    const fetchMock = vi.fn<typeof fetch>();
    expect(await operation.run(client(fetchMock), { ...CHARGER, enabled: false, host: '' })).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('disabled chargers are not read either', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    expect(await client(fetchMock).readStatus({ ...CHARGER, enabled: false })).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['', 'http://charger.example', 'user:secret@charger.example', 'charger.example/api/set', 'charger.example?tcl=1', 'charger.example#fragment', '999.0.0.1', 'charger.example:0'])('rejects host/path injection %s for reads and writes', async (host) => {
    const fetchMock = vi.fn<typeof fetch>();
    const control = client(fetchMock);
    const config = { ...CHARGER, host };
    expect(await control.readStatus(config)).toMatchObject({ ok: false });
    for (const operation of operations) expect(await operation.run(control, config)).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 'amp=14' as unknown as number, null as unknown as number])('rejects invalid tcl value %s', async (amps) => {
    const fetchMock = vi.fn<typeof fetch>();
    // Numeric limit-setting must remain numeric even if clear capability exists.
    const control = client(fetchMock);
    expect(await control.setTemporaryCurrentLimit(CHARGER, amps)).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([0, -1, 0.5, NaN, Infinity, 2_147_483_648])('rejects invalid timeout %s before any HTTP', async (timeoutMs) => {
    const fetchMock = vi.fn<typeof fetch>();
    const control = new GoEChargerControlClient({ gate: LIVE, now: () => 1000, fetch: fetchMock, timeoutMs });
    expect(await control.readStatus(CHARGER)).toMatchObject({ ok: false });
    expect(await control.pause(CHARGER)).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('control HTTP and acknowledgement', () => {
  it.each([null, [], {}, { tcl: false }, { tcl: 'device error secret' }, { frc: true }, { tcl: 1 }])('requires the exact written key to be true in the JSON acknowledgement %j', async (body) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(body));
    const result = await client(fetchMock).setTemporaryCurrentLimit(CHARGER, 13);
    expect(result).toMatchObject({ ok: false, error: { code: 'InvalidResponseError' } });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([301, 302, 307, 308, 401, 404, 500])('contains HTTP %s without following redirects or retrying', async (status) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('sensitive body', { status, headers: { location: 'http://foreign.example/write' } }));
    expect(await client(fetchMock).pause(CHARGER)).toMatchObject({ ok: false, error: { code: 'ConnectionError' } });
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('manual');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['', '{broken', '<html>secret</html>'])('contains invalid JSON %s', async (body) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const result = await client(fetchMock).pause(CHARGER);
    expect(result).toMatchObject({ ok: false, error: { code: 'InvalidResponseError' } });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('contains native exceptions and never includes device payloads or tokens', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error('authtoken=secret raw payload'));
    const result = await client(fetchMock).resume(CHARGER);
    expect(result).toMatchObject({ ok: false, error: { code: 'ConnectionError' } });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('times out an attempted set without treating it as confirmed', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('native timeout secret')));
    }));
    const pending = client(fetchMock).pause(CHARGER);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'TimeoutError' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the abort deadline active while receiving the set response body', async () => {
    vi.useFakeTimers();
    const reply = response({ tcl: true });
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      vi.spyOn(reply, 'text').mockImplementation(() => new Promise<string>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('body stalled')));
      }));
      return reply;
    });
    const pending = client(fetchMock).setTemporaryCurrentLimit(CHARGER, 13);
    await vi.advanceTimersByTimeAsync(3000);
    expect(await pending).toMatchObject({ ok: false, error: { code: 'TimeoutError' } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the timeout after successful transport acknowledgement', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response({ frc: true }));
    expect(await client(fetchMock).pause(CHARGER)).toMatchObject({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
    // A successful HTTP acknowledgement causes no implicit read or retry here.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('timestamped validated control status', () => {
  it('returns only validated control fields, timestamps and configured identity', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response({ ...STATUS, authtoken: 'secret', unrelated: ['raw'] }));
    const now = vi.fn<() => number>().mockReturnValueOnce(1000).mockReturnValueOnce(1020);
    const control = new GoEChargerControlClient({ gate: { executionMode: 'HCU_DEV', realWritesEnabled: false }, now, fetch: fetchMock });
    expect(await control.readStatus(CHARGER)).toEqual({ ok: true, value: {
      chargerId: 'garage', host: 'charger.example:8080', readStartedAtMs: 1000, observedAtMs: 1020, ...STATUS,
    } });
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/api/status');
    expect(url.searchParams.get('filter')?.split(',')).toEqual(['amp', 'tcl', 'frc', 'loe', 'car', 'mca', 'acu', 'ama', 'acp', 'mcpd', 'alw', 'fwv']);
  });

  it.each([undefined, null, 'false', 0, {}, []])('missing or invalid loe=%j stays explicitly unavailable', async (loe) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response({ ...STATUS, loe }));
    expect(await client(fetchMock).readStatus(CHARGER)).toMatchObject({ ok: true, value: { loe: null } });
  });

  it('preserves native load balancing true for actuator conflict detection', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response({ ...STATUS, loe: true }));
    expect(await client(fetchMock).readStatus(CHARGER)).toMatchObject({ ok: true, value: { loe: true } });
  });

  it('preserves nullable controls and an unknown future car/frc numeric state', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response({ ...STATUS, car: 99, frc: 99, tcl: null, acu: null, ama: null }));
    expect(await client(fetchMock).readStatus(CHARGER)).toMatchObject({ ok: true, value: { car: 99, frc: 99, tcl: null, acu: null, ama: null } });
  });

  it.each(['amp', 'tcl', 'frc', 'car', 'mca', 'acu', 'acp', 'mcpd', 'alw'])('rejects missing essential status field %s instead of inventing values', async (field) => {
    const raw: Record<string, unknown> = { ...STATUS };
    delete raw[field];
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(raw));
    expect(await client(fetchMock).readStatus(CHARGER)).toMatchObject({ ok: false, error: { code: 'InvalidResponseError' } });
  });

  it.each(['amp', 'tcl', 'frc', 'car', 'mca', 'acu', 'ama', 'mcpd'])('rejects invalid numeric field %s', async (field) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response({ ...STATUS, [field]: '6' }));
    expect(await client(fetchMock).readStatus(CHARGER)).toMatchObject({ ok: false, error: { code: 'InvalidResponseError' } });
  });

  it.each([null, [], 'status', 0])('rejects invalid status structure %j', async (raw) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(raw));
    expect(await client(fetchMock).readStatus(CHARGER)).toMatchObject({ ok: false, error: { code: 'InvalidResponseError' } });
  });

  it('allows missing ama only as explicit unknown', async () => {
    const raw: Record<string, unknown> = { ...STATUS };
    delete raw['ama'];
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(raw));
    expect(await client(fetchMock).readStatus(CHARGER)).toMatchObject({ ok: true, value: { ama: null } });
  });

  it('rejects a clock failure before HTTP', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const control = new GoEChargerControlClient({ gate: LIVE, now: () => { throw new Error('secret'); }, fetch: fetchMock });
    expect(await control.readStatus(CHARGER)).toMatchObject({ ok: false, error: { code: 'ConfigurationError' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([-1, NaN, Infinity, 0.5])('rejects invalid clock timestamp %s', async (timestamp) => {
    const fetchMock = vi.fn<typeof fetch>();
    const control = new GoEChargerControlClient({ gate: LIVE, now: () => timestamp, fetch: fetchMock });
    expect(await control.readStatus(CHARGER)).toMatchObject({ ok: false, error: { code: 'ConfigurationError' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a backwards clock and cannot claim a fresh observation', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response(STATUS));
    const now = vi.fn<() => number>().mockReturnValueOnce(1000).mockReturnValueOnce(900);
    const control = new GoEChargerControlClient({ gate: LIVE, now, fetch: fetchMock });
    expect(await control.readStatus(CHARGER)).toMatchObject({ ok: false, error: { code: 'ConfigurationError' } });
  });
});
