import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GoEHttpClient } from '../../../src/goe/http-client.js';
import { GoEControllerClient } from '../../../src/goe/controller-client.js';
import { GoEChargerClient } from '../../../src/goe/charger-client.js';
import { HcuWebSocketClient } from '../../../src/hcu/websocket-client.js';
import { createLogger } from '../../../src/logging/logger.js';
import { DryRunRuntime } from '../../../src/orchestration/dry-run-runtime.js';
import { makeConfig } from '../load-management/helpers.js';
import { fakeFactory, SequenceIds, transportSettings } from './transport-helpers.js';

const sourceRoot = fileURLToPath(new URL('../../../src/', import.meta.url));

/** Bounded to productive TypeScript sources; no dependencies, build artifacts or credentials. */
function sources(directory: string, depth = 0): Array<{ path: string; text: string }> {
  if (depth > 8) throw new Error('Source safety scan exceeded its explicit depth boundary');
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path, depth + 1);
    if (!entry.isFile() || !entry.name.endsWith('.ts')) return [];
    return [{ path: relative(sourceRoot, path).replaceAll('\\', '/'), text: readFileSync(path, 'utf8') }];
  });
}

const clients: HcuWebSocketClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.stop();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('phase-3 safety boundary: all real go-e communication remains read-only', () => {
  it('confines the phase-4 write endpoint to the separate gated Control Client', () => {
    const scanned = sources(sourceRoot);
    expect(scanned.length).toBeGreaterThan(0);
    const matches = scanned.filter((source) => /\/api\/set\b/iu.test(source.text)).map((source) => source.path);
    expect(matches).toEqual(['goe/control/charger-control-client.ts']);
  });

  it('uses only the fixed GET status endpoint in the go-e HTTP layer', () => {
    const goeSources = sources(join(sourceRoot, 'goe')).filter((source) => !source.path.startsWith('goe/control/'));
    const methodLiterals = goeSources.flatMap((source) => [...source.text.matchAll(/\bmethod\s*:\s*['"]([^'"]+)['"]/gu)]
      .map((match) => ({ source: source.path, method: match[1] })));
    expect(methodLiterals).toEqual([{ source: 'goe/http-client.ts', method: 'GET' }]);
    const http = goeSources.find((source) => source.path === 'goe/http-client.ts');
    expect(http?.text).toContain('new URL(`http://${host}/api/status`)');
    expect(http?.text).toContain("redirect: 'manual'");
    expect(goeSources.some((source) => /\bmethod\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/iu.test(source.text))).toBe(false);
  });

  it('exposes status reading only, with no public device-control operations', () => {
    for (const client of [GoEHttpClient, GoEControllerClient, GoEChargerClient]) {
      const methods = Object.getOwnPropertyNames(client.prototype).filter((name) => name !== 'constructor');
      expect(methods).toEqual(['readStatus']);
    }
  });

  it('rejects endpoint/query injection before any fetch invocation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new GoEHttpClient({ fetch });
    for (const host of ['garage.test/api/status', 'garage.test?amp=6', 'garage.test#other', 'user:token@garage.test']) {
      expect((await client.readStatus(host, ['amp', 'tcl'])).ok).toBe(false);
    }
    expect((await client.readStatus('garage.test', ['amp&frc=1'])).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('even with the live flag every dry-run fetch remains GET/status through reduction, PAUSE, RESUME and override cleanup', async () => {
    vi.stubEnv('GOE_REAL_WRITES_ENABLED', 'true');
    const config = makeConfig();
    let timestamp = 0;
    let gridPowerW = 22_839;
    const rawGarage = {
      fna: 'go-eCharger Garage', fwv: '59.4', car: 2, amp: 14, acu: 14,
      tcl: null, ama: 32, mca: 6, alw: true, frc: 0, acp: true, mcpd: 0, modelStatus: 15,
    };
    const rawLinks = { ...rawGarage, fna: 'go-eCharger Links', car: 1, acu: null, alw: false, modelStatus: 2 };
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const response = url.hostname === 'controller.test'
        ? { ccn: ['Solar', 'Grid', 'Home'], ccp: [-500, gridPowerW, 500],
          cpc: [[null, null, null, null], [28, 31, 20, null], [null, null, null, null]] }
        : url.hostname === 'garage.test' ? rawGarage : rawLinks;
      return new Response(JSON.stringify(response));
    });
    vi.stubGlobal('fetch', fetch);
    const runtime = new DryRunRuntime({ config, now: () => timestamp, idProvider: new SequenceIds() });
    await runtime.tick();
    timestamp = 30_000;
    expect((await runtime.tick()).lastDecision?.action).toMatchObject({ type: 'SET_TEMPORARY_CURRENT_LIMIT', amps: 13 });
    for (timestamp = 34_000; timestamp <= 58_000; timestamp += 4_000) await runtime.tick();
    timestamp = 62_000;
    expect((await runtime.tick()).lastDecision?.action).toEqual({ type: 'PAUSE', chargerId: 'garage' });
    gridPowerW = 17_000;
    timestamp = 66_000;
    expect((await runtime.tick()).lastDecision?.action).toEqual({ type: 'RESUME', chargerId: 'garage' });
    runtime.applyManualOverride();
    timestamp = 70_000;
    expect((await runtime.tick()).lastDecision?.action).toEqual({ type: 'CLEAR_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage' });
    expect(runtime.snapshot.realChargerWritesEnabled).toBe(false);
    expect(runtime.journal.entries.map((entry) => entry.action.type)).toContain('PAUSE');
    expect(fetch.mock.calls.length).toBeGreaterThan(30);
    for (const [input, options] of fetch.mock.calls) {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(['controller.test', 'garage.test', 'links.test']).toContain(url.hostname);
      expect(url.pathname).toBe('/api/status');
      expect([...url.searchParams.keys()]).toEqual(['filter']);
      expect(options?.method).toBe('GET');
      expect(options?.redirect).toBe('manual');
      expect(options?.body).toBeUndefined();
    }
    expect(rawGarage).toMatchObject({ amp: 14, acu: 14, tcl: null, frc: 0, car: 2 });
    await runtime.stop();
  });
});

describe('HCU transport log confidentiality at the untrusted message boundary', () => {
  it('never logs an unknown future type even when that type happens to equal the auth token', () => {
    const dummyToken = 'ABCDEF1234567890ABCDEF1234567890';
    const fake = fakeFactory();
    const logs: string[] = [];
    const logger = createLogger('debug', { write: (line: string) => { logs.push(line); } });
    const client = new HcuWebSocketClient({ ...transportSettings, authtoken: dummyToken,
      logger, webSocketFactory: fake.factory, idProvider: new SequenceIds() });
    clients.push(client);
    const onMessage = vi.fn();
    client.onMessage(onMessage);
    client.start();
    fake.sockets[0]?.emit('open');
    fake.sockets[0]?.emit('message', JSON.stringify({ pluginId: client.pluginId,
      id: 'unknown-message', type: dummyToken, body: { authtoken: dummyToken } }));
    expect(client.state).toBe('CONNECTED');
    expect(onMessage).not.toHaveBeenCalled();
    const combined = logs.join('');
    expect(combined).toContain('Unknown HCU message type ignored');
    expect(combined).not.toContain(dummyToken);
    expect(combined).not.toContain('messageType');
  });
});
