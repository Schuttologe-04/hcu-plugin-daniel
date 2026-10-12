import { describe, expect, it } from 'vitest';
import { success } from '../../../src/domain/errors.js';
import { validateConfig } from '../../../src/config/config-schema.js';
import { buildConfigTemplate } from '../../../src/hcu/config/config-template-builder.js';
import { initialRuntimeSnapshot } from '../../../src/orchestration/runtime-snapshot.js';
import { LoadManager } from '../../../src/load-management/load-manager.js';
import { controller, idle, makeCharger, makeConfig } from '../load-management/helpers.js';

describe('HCU config template from last runtime snapshot', () => {
  const config = makeConfig();
  const template = () => buildConfigTemplate(config, initialRuntimeSnapshot());

  it('contains all seven presentation groups with German names', () => {
    expect(Object.keys(template().groups)).toEqual([
      'controller', 'loadManagement', 'chargerGarage', 'chargerLinks',
      'chargerRechts', 'notifications', 'diagnostics',
    ]);
    expect(template().groups['notifications']?.friendlyName).toBe('Benachrichtigungen');
  });

  it('shows current grid limit and derived thresholds without separate persisted values', () => {
    const properties = template().properties;
    expect(properties['loadManagement.gridLimitW']?.currentValue).toBe('19000');
    expect(properties['loadManagement.targetGridW']).toMatchObject({ currentValue: '18500', dataType: 'READONLY' });
    expect(properties['loadManagement.recoveryThresholdW']).toMatchObject({ currentValue: '18000', dataType: 'READONLY' });
    expect(properties['loadManagement.ampStep']).toMatchObject({ currentValue: '1', dataType: 'READONLY' });
  });

  it('derives thresholds from edited settings', () => {
    const changed = makeConfig({ loadManagement: { gridLimitW: 25_000, safetyReserveW: 750 } });
    const properties = buildConfigTemplate(changed, initialRuntimeSnapshot()).properties;
    expect(properties['loadManagement.targetGridW']?.currentValue).toBe('24250');
    expect(properties['loadManagement.recoveryThresholdW']?.currentValue).toBe('23500');
  });

  it('uses config priorities and disabled third slot', () => {
    const properties = template().properties;
    expect(properties['chargers.garage.priority']?.currentValue).toBe('1');
    expect(properties['chargers.links.priority']?.currentValue).toBe('20');
    expect(properties['chargers.rechts.priority']?.currentValue).toBe('20');
    expect(properties['chargers.rechts.enabled']).toMatchObject({ dataType: 'BOOLEAN', currentValue: 'false' });
    expect(properties['chargers.rechts.host']).toMatchObject({ currentValue: '', required: false });
  });

  it('uses only documented scalar field types and String values', () => {
    for (const property of Object.values(template().properties)) {
      expect(typeof property.currentValue).toBe('string');
      if (property.dataType === 'BOOLEAN') expect(property).not.toHaveProperty('required');
      else expect(typeof property.required).toBe('boolean');
      if (property.defaultValue !== undefined) expect(typeof property.defaultValue).toBe('string');
    }
  });

  it.each([true, false])('allows %s for every checkbox without a required constraint', (enabled) => {
    const changed = {
      ...config,
      loadManagement: { ...config.loadManagement, enabled },
      chargers: config.chargers.map((charger) => ({ ...charger, enabled,
        host: enabled && !charger.host ? `${charger.id}.test` : charger.host })),
      notifications: { intervention: enabled, controllerConnectionError: enabled,
        chargerConnectionError: enabled, interactive: enabled },
    };
    expect(validateConfig(changed).ok).toBe(true);
    const properties = buildConfigTemplate(changed, initialRuntimeSnapshot()).properties;
    const checkboxes = Object.entries(properties).filter(([, property]) => property.dataType === 'BOOLEAN');
    expect(checkboxes.map(([id]) => id)).toEqual([
      'loadManagement.enabled', 'chargers.garage.enabled', 'chargers.links.enabled', 'chargers.rechts.enabled',
      'notifications.intervention', 'notifications.controllerConnectionError',
      'notifications.chargerConnectionError', 'notifications.interactive',
    ]);
    for (const [, property] of checkboxes) {
      expect(property.currentValue).toBe(String(enabled));
      expect(property).not.toHaveProperty('required');
    }
    // A disabled Rechts slot with an empty host remains a valid config and template.
    if (!enabled) expect(properties['chargers.rechts.host']).toMatchObject({ currentValue: '', required: false });
    expect(properties['controller.host']?.required).toBe(true);
    expect(properties['loadManagement.gridLimitW']?.required).toBe(true);
  });

  it('shows unavailable rather than inventing absent status values', () => {
    for (const id of ['controller.gridImportW', 'chargers.garage.amp', 'chargers.links.firmwareVersion', 'diagnostics.engineState']) {
      expect(template().properties[id]?.currentValue).toBe('unavailable');
    }
  });

  it('projects device status including null as unavailable and raw car code', () => {
    const garage = makeCharger();
    const links = idle('links');
    const snapshot = { ...initialRuntimeSnapshot('DRY_RUN'), observedAtMs: 30_000,
      probe: { controller: success(controller(22_839)), chargers: [
        { status: 'reachable' as const, reachable: true as const, config: config.chargers[0]!, value: garage },
        { status: 'reachable' as const, reachable: true as const, config: config.chargers[1]!, value: links },
      ] } };
    const properties = buildConfigTemplate(config, snapshot).properties;
    expect(properties['controller.gridImportW']?.currentValue).toBe('22839');
    expect(properties['chargers.garage.car']?.currentValue).toBe('2');
    expect(properties['chargers.garage.amp']?.currentValue).toBe('14');
    expect(properties['chargers.garage.mca']?.currentValue).toBe('6');
    expect(properties['chargers.garage.tcl']?.currentValue).toBe('unavailable');
    expect(properties['chargers.links.acu']?.currentValue).toBe('unavailable');
  });

  it('does not present stale device data after a host configuration change', () => {
    const snapshot = { ...initialRuntimeSnapshot(), probe: { controller: success(controller(22_839)), chargers: [
      { status: 'reachable' as const, reachable: true as const, config: config.chargers[0]!, value: makeCharger() },
    ] } };
    const moved = { ...config, controller: { host: 'new-controller.test' }, chargers: config.chargers.map((charger) => ({ ...charger, host: 'moved.test' })) };
    const properties = buildConfigTemplate(moved, snapshot).properties;
    expect(properties['controller.gridPowerW']?.currentValue).toBe('unavailable');
    expect(properties['chargers.garage.amp']?.currentValue).toBe('unavailable');
  });

  it('marks all diagnostic fields read-only and makes dry-run safety visible', () => {
    const properties = buildConfigTemplate(config, initialRuntimeSnapshot('DRY_RUN')).properties;
    for (const [id, property] of Object.entries(properties)) {
      if (id.startsWith('diagnostics.')) expect(property.dataType).toBe('READONLY');
    }
    expect(properties['diagnostics.executionMode']?.currentValue).toBe('DRY_RUN');
    expect(properties['diagnostics.realChargerWrites']?.currentValue).toBe('disabled');
  });

  it('shows 22.839 kW engine decision and abstract 13 A action', () => {
    const engine = new LoadManager(config);
    const input = { controller: success(controller(22_839)), chargers: [
      { chargerId: 'garage', status: success(makeCharger()) },
      { chargerId: 'links', status: success(idle('links')) },
    ] };
    engine.evaluate({ ...input, measurementId: 'first', timestampMs: 0 });
    const decision = engine.evaluate({ ...input, measurementId: 'second', timestampMs: 30_000 });
    const snapshot = { ...initialRuntimeSnapshot('DRY_RUN'), engine: decision.status,
      lastDecision: decision, lastAction: decision.action };
    const properties = buildConfigTemplate(config, snapshot).properties;
    expect(properties['diagnostics.engineState']?.currentValue).toBe('LIMITING');
    expect(properties['diagnostics.lastAction']?.currentValue).toBe('SET_TEMPORARY_CURRENT_LIMIT garage 13 A');
  });

  it('has no credentials/token properties and no raw network response fields', () => {
    expect(JSON.stringify(template())).not.toMatch(/authtoken|HCU_AUTHTOKEN|password|rawNrg|\/TOKEN/iu);
  });

  it('provides required English template rendering when requested', () => {
    expect(buildConfigTemplate(config, initialRuntimeSnapshot(), 'en').groups['notifications']?.friendlyName).toBe('Notifications');
  });

  it('omits unavailable editable values for absent slots without inventing defaults', () => {
    const properties = buildConfigTemplate(makeConfig({ chargers: [] }), initialRuntimeSnapshot()).properties;
    expect(properties['chargers.garage.enabled']).not.toHaveProperty('currentValue');
    expect(properties['chargers.garage.priority']).not.toHaveProperty('currentValue');
    expect(properties['chargers.garage.amp']?.currentValue).toBe('unavailable');
  });
});
