import { describe, expect, it } from 'vitest';
import { validateConfig } from '../../../src/config/config-schema.js';
import { DEFAULT_HTTP_TIMEOUT_MS } from '../../../src/config/config-types.js';
import { isValidDeviceHost } from '../../../src/goe/device-host.js';

function validConfig() {
  return {
    controller: { host: 'controller.local' },
    loadManagement: {
      enabled: true,
      gridLimitW: 19_000,
      safetyReserveW: 500,
      triggerDurationSeconds: 30,
      controlIntervalSeconds: 4,
      ampStep: 1,
    },
    chargers: [
      { id: 'garage', name: 'Garage', host: '192.168.0.94', enabled: true, priority: 1 },
      { id: 'links', name: 'Links', host: '192.168.0.144', enabled: true, priority: 20 },
      { id: 'rechts', name: 'Rechts', host: '', enabled: false, priority: 20 },
    ],
  };
}

function expectConfigurationError(input: unknown, field: string) {
  expect(validateConfig(input)).toEqual({
    ok: false,
    error: {
      code: 'ConfigurationError',
      message: expect.stringContaining(field),
    },
  });
}

describe('validateConfig', () => {
  it('accepts the complete configuration and defaults the HTTP timeout', () => {
    const config = validConfig();
    expect(validateConfig(config)).toEqual({
      ok: true,
      value: { ...config, http: { timeoutMs: DEFAULT_HTTP_TIMEOUT_MS } },
    });
  });

  it('accepts an explicitly configured HTTP timeout', () => {
    const config = { ...validConfig(), http: { timeoutMs: 5_000 } };
    expect(validateConfig(config)).toEqual({ ok: true, value: config });
  });

  it('rejects an enabled charger without a host', () => {
    const config = validConfig();
    config.chargers.push({ id: 'bad', name: 'Bad', host: '', enabled: true, priority: 2 });
    expectConfigurationError(config, 'host');
  });

  it('allows a disabled charger without a host', () => {
    expect(validateConfig(validConfig()).ok).toBe(true);
  });

  it('validates a non-empty host even for disabled chargers', () => {
    const config = validConfig();
    config.chargers.push({ id: 'bad', name: 'Bad', host: 'http://charger', enabled: false, priority: 2 });
    expectConfigurationError(config, 'host');
  });

  it('rejects duplicate charger IDs', () => {
    const config = validConfig();
    config.chargers.push({ id: 'garage', name: 'Duplicate', host: '', enabled: false, priority: 20 });
    expectConfigurationError(config, 'unique');
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid priority %s',
    (priority) => {
      const config = validConfig();
      config.chargers.push({ id: 'bad', name: 'Bad', host: '', enabled: false, priority });
      expectConfigurationError(config, 'priority');
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects gridLimitW %s', (gridLimitW) => {
    const config = validConfig();
    config.loadManagement.gridLimitW = gridLimitW;
    expectConfigurationError(config, 'gridLimitW');
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 19_000, 20_000])(
    'rejects invalid safetyReserveW %s',
    (safetyReserveW) => {
      const config = validConfig();
      config.loadManagement.safetyReserveW = safetyReserveW;
      expectConfigurationError(config, 'safetyReserveW');
    },
  );

  it('accepts a zero safety reserve', () => {
    const config = validConfig();
    config.loadManagement.safetyReserveW = 0;
    expect(validateConfig(config).ok).toBe(true);
  });

  it.each([0, -4, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects interval %s', (interval) => {
    const config = validConfig();
    config.loadManagement.controlIntervalSeconds = interval;
    expectConfigurationError(config, 'controlIntervalSeconds');
  });

  it.each(['triggerDurationSeconds', 'ampStep'])(
    'rejects zero for %s',
    (field) => {
      const config = validConfig();
      expectConfigurationError({
        ...config,
        loadManagement: { ...config.loadManagement, [field]: 0 },
      }, field);
    },
  );

  it.each([0, -1, 0.5, 2_147_483_648, Number.POSITIVE_INFINITY, '3000', undefined])(
    'rejects invalid configured HTTP timeout %s',
    (timeoutMs) => expectConfigurationError({ ...validConfig(), http: { timeoutMs } }, 'timeoutMs'),
  );

  it.each([null, [], false, 'config'])('rejects a non-object root %s', (input) => {
    expectConfigurationError(input, 'object');
  });

  it.each(['controller', 'loadManagement', 'chargers'])('rejects missing %s', (field) => {
    const config: Record<string, unknown> = { ...validConfig() };
    delete config[field];
    expectConfigurationError(config, field);
  });

  it('requires an actual boolean for loadManagement.enabled', () => {
    const config = validConfig();
    expectConfigurationError({ ...config, loadManagement: { ...config.loadManagement, enabled: 'true' } }, 'enabled');
  });

  it('requires an actual boolean for a charger enabled flag', () => {
    expectConfigurationError({
      ...validConfig(),
      chargers: [{ id: 'bad', name: 'Bad', host: 'charger.local', enabled: 'false', priority: 2 }],
    }, 'enabled');
  });

  it.each(['', ' ', ' garage'])('rejects invalid charger ID %s', (id) => {
    expectConfigurationError({
      ...validConfig(),
      chargers: [{ id, name: 'Bad', host: '', enabled: false, priority: 2 }],
    }, '.id');
  });

  it('rejects an empty charger name', () => {
    expectConfigurationError({
      ...validConfig(),
      chargers: [{ id: 'bad', name: ' ', host: '', enabled: false, priority: 2 }],
    }, '.name');
  });

  it('does not return references to mutable input objects', () => {
    const input = validConfig();
    const result = validateConfig(input);
    input.controller.host = 'changed.local';
    input.chargers.length = 0;
    if (!result.ok) {
      throw new Error('Valid configuration was unexpectedly rejected.');
    }
    expect(result.value.controller.host).toBe('controller.local');
    expect(result.value.chargers).toHaveLength(3);
  });
});

describe('isValidDeviceHost', () => {
  it.each([
    '192.168.0.94', '127.0.0.1:8080', 'controller.local', 'charger',
    'CHARGER.example:65535', 'charger.example.', '[::1]', '[2001:db8::1]:8080',
  ])('accepts a host authority: %s', (host) => {
    expect(isValidDeviceHost(host)).toBe(true);
  });

  it.each([
    '', ' ', ' charger.local', 'charger.local ', 'http://charger.local',
    'https://charger.local', 'user:password@charger.local', 'charger.local/path',
    'charger.local?filter=amp', 'charger.local#fragment', 'charger.local\\path',
    '192.168.0.999', '192.168.0.094', '127.1', '12345', '0x7f000001',
    'charger.local:0', 'charger.local:65536', 'charger.local:-1', 'charger.local:abc',
    'charger.local:', 'charger..local', '-charger.local', 'charger_.local',
    '::1', '[invalid]', '[::1]suffix', '[fe80::1%eth0]', '<GO_E_CONTROLLER_IP>',
    `${'a'.repeat(64)}.local`, `${'a.'.repeat(128)}local`,
  ])('rejects an invalid or URL-shaped host: %s', (host) => {
    expect(isValidDeviceHost(host)).toBe(false);
  });

  it('rejects an invalid controller host at the configuration boundary', () => {
    expectConfigurationError({ ...validConfig(), controller: { host: 'http://controller.local' } }, 'controller.host');
  });
});
