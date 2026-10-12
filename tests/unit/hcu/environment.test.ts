import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RemoteDevelopmentEnvironment } from '../../../src/hcu/runtime/remote-environment.js';
import { InstalledHcuEnvironment } from '../../../src/hcu/runtime/installed-environment.js';
import { PLUGIN_ID } from '../../../src/hcu/plugin-identity.js';

const environment = { HCU_WS_URL: 'wss://hcu1-1234.local:9001', HCU_AUTHTOKEN: 'local-unit-test-secret' };

describe('HCU environments', () => {
  it('uses the binding PSD plugin identifier as the central project default', () => {
    expect(PLUGIN_ID).toBe('com.psd.hcu.goe.loadmanagement');
  });

  it('loads remote credentials separately, defaults to certificate validation and central plugin identity', async () => {
    expect(await new RemoteDevelopmentEnvironment(environment).resolve()).toEqual({ ok: true, value: {
      url: environment.HCU_WS_URL, authtoken: environment.HCU_AUTHTOKEN, pluginId: PLUGIN_ID,
      allowSelfSigned: false, dataDirectory: resolve('./data'),
    } });
  });

  it('allows explicit per-connection self-signed TLS and a separate local data directory', async () => {
    expect(await new RemoteDevelopmentEnvironment({ ...environment, HCU_PLUGIN_ID: 'custom.plugin', HCU_ALLOW_SELF_SIGNED: 'true', HCU_DATA_DIR: './test-data' }).resolve())
      .toMatchObject({ ok: true, value: { pluginId: 'custom.plugin', allowSelfSigned: true, dataDirectory: resolve('./test-data') } });
    expect(await new RemoteDevelopmentEnvironment({ ...environment, HCU_ALLOW_SELF_SIGNED: 'false' }).resolve())
      .toMatchObject({ ok: true, value: { allowSelfSigned: false } });
  });

  it.each([
    {}, { HCU_WS_URL: environment.HCU_WS_URL },
    { ...environment, HCU_WS_URL: 'http://hcu.local:9001' },
    { ...environment, HCU_WS_URL: 'ws://hcu.local:9001' },
    { ...environment, HCU_WS_URL: 'wss://user:password@hcu.local:9001' },
    { ...environment, HCU_WS_URL: 'wss://hcu.local:9001/?authtoken=secret' },
    { ...environment, HCU_WS_URL: 'wss://hcu.local:9001/path' },
    { ...environment, HCU_WS_URL: 'wss://hcu.local:9001/#secret' },
    { ...environment, HCU_WS_URL: ' wss://hcu.local:9001 ' },
    { ...environment, HCU_AUTHTOKEN: '' },
    { ...environment, HCU_AUTHTOKEN: 'secret\nheader' },
    { ...environment, HCU_PLUGIN_ID: '' },
    { ...environment, HCU_PLUGIN_ID: 'plugin\r\nheader' },
    { ...environment, HCU_ALLOW_SELF_SIGNED: '1' },
    { ...environment, HCU_ALLOW_SELF_SIGNED: 'yes' },
    { ...environment, HCU_DATA_DIR: '' },
  ])('rejects invalid remote configuration %# without exposing the token', async (env) => {
    const result = await new RemoteDevelopmentEnvironment(env).resolve();
    expect(result).toMatchObject({ ok: false, error: { code: 'ConfigurationError' } });
    expect(JSON.stringify(result)).not.toContain(environment.HCU_AUTHTOKEN);
    expect(JSON.stringify(result)).not.toContain('password');
  });

  it('prepares installed HCU runtime files without confusing CLIENTID with plugin-id', async () => {
    const files: Readonly<Record<string, string>> = {
      '/TOKEN': 'unit-test-token\n', '/CLIENTID': 'connect-client-identifier\n', '/SGTIN': '3014F711A00000C000000ABC\n',
    };
    const readTextFile = vi.fn<(path: string) => Promise<string>>().mockImplementation(async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error('unexpected runtime path');
      return text;
    });
    expect(await new InstalledHcuEnvironment({ readTextFile }).resolve()).toEqual({ ok: true, value: {
      url: 'wss://host.containers.internal:9001', authtoken: 'unit-test-token', pluginId: PLUGIN_ID,
      allowSelfSigned: false, dataDirectory: '/data', clientId: 'connect-client-identifier', sgtin: '3014F711A00000C000000ABC',
    } });
    expect(readTextFile.mock.calls.map(([path]) => path)).toEqual(['/TOKEN', '/CLIENTID', '/SGTIN']);
  });

  it('accepts explicit installed runtime TLS policy and central/custom plugin identity', async () => {
    const result = await new InstalledHcuEnvironment({ pluginId: 'custom.plugin', allowSelfSigned: true, readTextFile: async () => 'runtime-value' }).resolve();
    expect(result).toMatchObject({ ok: true, value: { pluginId: 'custom.plugin', allowSelfSigned: true } });
  });

  it('contains installed runtime filesystem errors without exposing file contents or native details', async () => {
    const result = await new InstalledHcuEnvironment({ readTextFile: async () => { throw new Error('unit-test-token secret details'); } }).resolve();
    expect(result).toMatchObject({ ok: false, error: { code: 'ConfigurationError' } });
    expect(JSON.stringify(result)).not.toContain('unit-test-token');
  });

  it('rejects corrupt or missing installed metadata', async () => {
    expect(await new InstalledHcuEnvironment({ readTextFile: async () => '' }).resolve()).toMatchObject({ ok: false });
    expect(await new InstalledHcuEnvironment({ readTextFile: async (path) => path === '/TOKEN' ? 'invalid token' : 'valid-metadata' }).resolve()).toMatchObject({ ok: false });
  });
});
