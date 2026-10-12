import { describe, expect, it } from 'vitest';
import { failure, success } from '../../../../src/domain/errors.js';
import { createDeviceRegistry } from '../../../../src/hcu/devices/device-registry.js';
import { projectDevice } from '../../../../src/hcu/devices/device-projection.js';
import type { DeviceDefinition } from '../../../../src/hcu/devices/device-types.js';
import { controller, makeConfig, allEnabledConfig } from '../../load-management/helpers.js';
import { telemetry } from './helpers.js';

const config = makeConfig();
function definition(id: string): DeviceDefinition {
  const result = createDeviceRegistry(config).find(device => device.deviceId === id);
  if (result === undefined) throw new Error('Missing test definition');
  return result;
}

describe('stable configured plugin device identities', () => {
  it('defines exactly five sensor devices with configured labels and no battery/custom channels', () => {
    expect(createDeviceRegistry(config).map(({ deviceId, deviceType, friendlyName }) => ({ deviceId, deviceType, friendlyName }))).toEqual([
      { deviceId: 'controller-grid', deviceType: 'GRID_CONNECTION_POINT', friendlyName: 'go-e Netz' },
      { deviceId: 'controller-home', deviceType: 'ENERGY_METER', friendlyName: 'go-e Hausverbrauch' },
      { deviceId: 'controller-solar', deviceType: 'INVERTER', friendlyName: 'go-e Solar' },
      { deviceId: 'charger-garage', deviceType: 'EV_CHARGER', friendlyName: 'Garage' },
      { deviceId: 'charger-links', deviceType: 'EV_CHARGER', friendlyName: 'Links' },
    ]);
  });

  it('keeps identities across host/name changes and reconstructed registries', () => {
    const changed = { ...config, controller: { host: 'new-controller.test' },
      chargers: config.chargers.map(charger => ({ ...charger, name: 'New name', host: charger.enabled ? 'new-host.test' : '' })) };
    expect(createDeviceRegistry(changed).map(device => device.deviceId)).toEqual(createDeviceRegistry(config).map(device => device.deviceId));
    expect(createDeviceRegistry(structuredClone(changed))).toEqual(createDeviceRegistry(changed));
  });

  it('adds Rechts through existing configuration and never from reachability', () => {
    expect(createDeviceRegistry(allEnabledConfig()).at(-1)).toMatchObject({ deviceId: 'charger-rechts', deviceType: 'EV_CHARGER' });
    const invalid = { ...config, chargers: config.chargers.map(charger => ({ ...charger, enabled: true, host: '' })) };
    expect(createDeviceRegistry(invalid)).toHaveLength(3);
    const disabled = { ...config, loadManagement: { ...config.loadManagement, liveControlEnabled: false } };
    expect(createDeviceRegistry(disabled)).toHaveLength(5);
  });
});

describe('pure device telemetry projection', () => {
  it('rounds only display watts while retaining the original domain floats', () => {
    const report = telemetry();
    expect(projectDevice(definition('controller-grid'), report).features).toEqual([
      { type: 'currentPower', currentPower: 4995 }, { type: 'maintenance', unreach: false },
    ]);
    expect(projectDevice(definition('controller-home'), report).features[0]).toEqual({ type: 'currentPower', currentPower: 4985 });
    expect(report.controller).toMatchObject({ value: { gridPowerW: 4994.687988, homePowerW: 4985.463867 } });
  });

  it('keeps negative Grid export signed, without gridImportW clamping', () => {
    const report = { ...telemetry(), controller: success(controller(-5000)) };
    expect(projectDevice(definition('controller-grid'), report).features[0]).toEqual({ type: 'currentPower', currentPower: -5000 });
  });

  it.each([[-5000, 5000], [0, 0], [500, -500]])('projects raw Solar %s W as %s W by negation', (raw, projected) => {
    const report = { ...telemetry(), controller: success({ ...controller(2000), solarPowerW: raw }) };
    expect(projectDevice(definition('controller-solar'), report).features[0]).toEqual({ type: 'currentPower', currentPower: projected });
    expect(report.controller).toMatchObject({ value: { solarPowerW: raw } });
  });

  it.each([null, undefined, NaN, Infinity, -Infinity])('omits unavailable Home watts %s without changing reachability', (homePowerW) => {
    const report = { ...telemetry(), controller: success({ ...controller(2000), ...(homePowerW === undefined ? {} : { homePowerW }) }) };
    expect(projectDevice(definition('controller-home'), report).features).toEqual([
      { type: 'currentPower' }, { type: 'maintenance', unreach: false },
    ]);
  });

  it.each([null, undefined, NaN, Infinity, -Infinity])('never creates charger power fallback for %s', (currentPowerW) => {
    const report = telemetry();
    const chargers = report.chargers.map(charger => charger.status !== 'reachable' ? charger : {
      ...charger, value: { ...charger.value, ...(currentPowerW === undefined ? {} : { currentPowerW }),
        configuredCurrentA: 14, effectiveCurrentA: 14, temporaryCurrentLimitA: 10,
        rawNrg: Array.from({ length: 11 }, () => 1000) },
    });
    // Remove the default helper's measurement for the explicitly absent case.
    if (currentPowerW === undefined) for (const charger of chargers) if (charger.status === 'reachable') delete charger.value.currentPowerW;
    expect(projectDevice(definition('charger-garage'), { ...report, chargers }).features).toEqual([
      { type: 'currentPower' }, { type: 'maintenance', unreach: false },
    ]);
  });

  it('publishes real charger zero and only verified firmware metadata', () => {
    const projected = projectDevice(definition('charger-garage'), telemetry(config, 0));
    expect(projected.features[0]).toEqual({ type: 'currentPower', currentPower: 0 });
    expect(projected.firmwareVersion).toBe('59.4');
    expect(projectDevice(definition('controller-grid'), telemetry())).not.toHaveProperty('firmwareVersion');
    expect(projected).not.toHaveProperty('modelType');
    expect(projected).not.toHaveProperty('source');
  });

  it.each(['ConnectionError', 'TimeoutError'] as const)('marks all controller logical devices unreachable for %s, without zero', (code) => {
    const report = { ...telemetry(), controller: failure(code, 'Sanitized failure') };
    for (const id of ['controller-grid', 'controller-home', 'controller-solar']) expect(projectDevice(definition(id), report).features).toEqual([
      { type: 'currentPower' }, { type: 'maintenance', unreach: true },
    ]);
  });

  it.each(['MissingMeasurementError', 'InvalidResponseError'] as const)('keeps received invalid measurement %s distinct from offline', (code) => {
    expect(projectDevice(definition('controller-grid'), { ...telemetry(), controller: failure(code, 'Sanitized failure') }).features).toEqual([
      { type: 'currentPower' }, { type: 'maintenance', unreach: false },
    ]);
  });

  it('omits reachability before the first observation and for unknown configuration state', () => {
    expect(projectDevice(definition('controller-grid'), null).features).toEqual([{ type: 'currentPower' }, { type: 'maintenance' }]);
    expect(projectDevice(definition('controller-grid'), { ...telemetry(), controller: failure('ConfigurationError', 'Not configured') }).features[1]).toEqual({ type: 'maintenance' });
  });

  it('isolates one unreachable charger from the other devices', () => {
    const report = telemetry();
    const chargers = report.chargers.map(charger => charger.config.id !== 'garage' ? charger :
      { status: 'unavailable' as const, reachable: false as const, config: charger.config,
        error: { code: 'ConnectionError' as const, message: 'Offline' } });
    expect(projectDevice(definition('charger-garage'), { ...report, chargers }).features[1]).toEqual({ type: 'maintenance', unreach: true });
    expect(projectDevice(definition('charger-links'), { ...report, chargers }).features).toEqual([
      { type: 'currentPower', currentPower: 0 }, { type: 'maintenance', unreach: false },
    ]);
  });

  it('does not reuse stale telemetry after a configured host changes', () => {
    const changed = { ...definition('charger-garage'), source: { kind: 'charger' as const, chargerId: 'garage', host: 'replacement.test' } };
    expect(projectDevice(changed, telemetry()).features).toEqual([{ type: 'currentPower' }, { type: 'maintenance' }]);
  });
});
