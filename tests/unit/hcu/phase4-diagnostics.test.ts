import { describe, expect, it, vi } from 'vitest';
import { buildConfigTemplate, UNAVAILABLE } from '../../../src/hcu/config/config-template-builder.js';
import { makeEmptyOwnership, type OwnershipState } from '../../../src/goe/control/ownership-state.js';
import type { ControlObservation } from '../../../src/goe/control/control-types.js';
import { LoadManager } from '../../../src/load-management/load-manager.js';
import { initialRuntimeSnapshot, type RuntimeSnapshot } from '../../../src/orchestration/runtime-snapshot.js';
import { makeConfig } from '../load-management/helpers.js';

function owned(): OwnershipState {
  const config = makeConfig().chargers[0]!;
  const baseline: ControlObservation = { chargerId: config.id, host: config.host, readStartedAtMs: 100, observedAtMs: 100,
    amp: 14, tcl: null, frc: 0, loe: false, car: 2, mca: 6, acu: 14, ama: 32, acp: true, mcpd: 0, alw: true };
  const readback = { ...baseline, readStartedAtMs: 200, observedAtMs: 200, tcl: 6, acu: null, frc: 1, car: 4, alw: false };
  return { ...makeEmptyOwnership(config, 200), baseline, ownershipStatus: 'OWNED', pluginOwnedTcl: 6, pluginOwnedPause: true,
    lastObservedState: readback, lastReadback: readback,
    lastConfirmedWrite: { action: { type: 'PAUSE', chargerId: config.id }, confirmedAtMs: 200 } };
}

function liveSnapshot(): RuntimeSnapshot {
  return { ...initialRuntimeSnapshot('LIVE'), realChargerWritesEnabled: true,
    engine: { ...new LoadManager(makeConfig()).snapshot, state: 'PAUSED' },
    telemetryHealth: { state: 'HEALTHY', healthy: true, recoveryAllowed: true, gridImportW: 17_000,
      sampledAtMs: 1000, stableSinceMs: 0, reason: null },
    actuator: { state: 'CONFIRMED', ownership: [owned()],
      lastResult: { status: 'CONFIRMED', code: 'CONFIRMED', message: 'Confirmed' } },
  };
}

describe('phase 4 HCUweb diagnostic projection', () => {
  it('projects all LIVE gate, health, ownership, confirmation and readback fields as READONLY', () => {
    const fetchMock = vi.fn<typeof fetch>();
    const template = buildConfigTemplate(makeConfig(), liveSnapshot(), 'en');
    const values = {
      'diagnostics.executionMode': 'LIVE', 'diagnostics.realChargerWrites': 'enabled',
      'diagnostics.controllerTelemetryHealth': 'HEALTHY', 'diagnostics.recoveryAllowed': 'true',
      'diagnostics.engineState': 'PAUSED', 'diagnostics.actuatorState': 'CONFIRMED',
      'diagnostics.garage.ownershipStatus': 'OWNED', 'diagnostics.garage.conflictStatus': UNAVAILABLE,
      'diagnostics.garage.pluginOwnedTcl': '6', 'diagnostics.garage.pluginOwnedPause': 'true',
      'diagnostics.garage.lastConfirmedWrite': 'PAUSE garage @ 200',
      'diagnostics.garage.lastReadback': 'tcl=6, frc=1, loe=false @ 200',
      'diagnostics.lastActuatorError': UNAVAILABLE, 'diagnostics.limitUnachievable': 'false', 'diagnostics.fault': UNAVAILABLE,
    };
    for (const [id, currentValue] of Object.entries(values)) expect(template.properties[id]).toMatchObject({ dataType: 'READONLY', required: false, currentValue });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['HCU_DEV', 'DRY_RUN'] as const)('%s shows disabled real writes and absent actuator data as unavailable', (mode) => {
    const template = buildConfigTemplate(makeConfig(), initialRuntimeSnapshot(mode));
    expect(template.properties['diagnostics.realChargerWrites']?.currentValue).toBe('disabled');
    expect(template.properties['diagnostics.executionMode']?.currentValue).toBe(mode);
    for (const id of ['controllerTelemetryHealth', 'actuatorState', 'lastActuatorError', 'garage.ownershipStatus', 'garage.pluginOwnedTcl', 'garage.pluginOwnedPause', 'garage.lastConfirmedWrite', 'garage.lastReadback']) {
      expect(template.properties[`diagnostics.${id}`]).toMatchObject({ dataType: 'READONLY', currentValue: UNAVAILABLE });
    }
  });

  it('shows faults and conflicts without translating missing Grid into zero or clearing restrictions', () => {
    const source = liveSnapshot();
    const snapshot: RuntimeSnapshot = { ...source,
      engine: { ...source.engine!, state: 'FAULT', gridImportW: null, fault: { code: 'CONTROLLER_UNAVAILABLE', message: 'No Grid' } },
      telemetryHealth: { state: 'FAULT', healthy: false, recoveryAllowed: false, gridImportW: null, sampledAtMs: null, stableSinceMs: null, reason: 'STALE_TELEMETRY' },
      actuator: { state: 'CONFLICT', ownership: [{ ...owned(), ownershipStatus: 'CONFLICT', conflictStatus: 'EXTERNAL_TCL_CHANGE' }],
        lastResult: { status: 'CONFLICT', code: 'EXTERNAL_TCL_CHANGE', message: 'Conflict' } },
    };
    const properties = buildConfigTemplate(makeConfig(), snapshot).properties;
    expect(properties['diagnostics.gridImportW']?.currentValue).toBe(UNAVAILABLE);
    expect(properties['diagnostics.controllerTelemetryHealth']?.currentValue).toBe('FAULT');
    expect(properties['diagnostics.recoveryAllowed']?.currentValue).toBe('false');
    expect(properties['diagnostics.fault']?.currentValue).toBe('CONTROLLER_UNAVAILABLE');
    expect(properties['diagnostics.garage.conflictStatus']?.currentValue).toBe('EXTERNAL_TCL_CHANGE');
    expect(properties['diagnostics.lastActuatorError']?.currentValue).toBe('EXTERNAL_TCL_CHANGE');
    expect(properties['diagnostics.garage.pluginOwnedPause']?.currentValue).toBe('true');
    expect(properties['diagnostics.garage.pluginOwnedTcl']?.currentValue).toBe('6');
  });

  it('explicitly projects LIMIT_UNACHIEVABLE', () => {
    const snapshot = liveSnapshot();
    const properties = buildConfigTemplate(makeConfig(), { ...snapshot, engine: { ...snapshot.engine!, state: 'LIMIT_UNACHIEVABLE' } }).properties;
    expect(properties['diagnostics.limitUnachievable']).toMatchObject({ dataType: 'READONLY', currentValue: 'true' });
    expect(properties['diagnostics.engineState']?.currentValue).toBe('LIMIT_UNACHIEVABLE');
  });

  it('never copies credentials or full payload extras from runtime ownership into the template', () => {
    const source = liveSnapshot();
    const state = { ...owned(), authtoken: 'secret-token', clientId: 'secret-client', activationKey: 'secret-key', rawPayload: { devicePrivateData: true },
      baseline: { ...owned().baseline!, rawBody: 'secret-baseline' }, lastReadback: { ...owned().lastReadback!, rawBody: 'secret-readback' } };
    const snapshot = { ...source, authtoken: 'secret-root', actuator: { ...source.actuator!, ownership: [state] } };
    const template = buildConfigTemplate(makeConfig(), snapshot);
    expect(JSON.stringify(template)).not.toMatch(/secret|rawPayload|rawBody|authtoken|activationKey|clientId/u);
  });

  it('keeps all eight BOOLEAN controls optional, including disabled chargers and false notifications', () => {
    const config = { ...makeConfig(), notifications: { intervention: false, controllerConnectionError: false, chargerConnectionError: false, interactive: false } };
    const template = buildConfigTemplate(config, liveSnapshot());
    const booleans = Object.values(template.properties).filter((property) => property.dataType === 'BOOLEAN');
    expect(booleans).toHaveLength(8);
    for (const property of booleans) expect(property).not.toHaveProperty('required');
    expect(template.properties['chargers.rechts.enabled']?.currentValue).toBe('false');
    for (const setting of Object.keys(config.notifications)) expect(template.properties[`notifications.${setting}`]?.currentValue).toBe('false');
    expect(template.properties).not.toHaveProperty('GOE_REAL_WRITES_ENABLED');
    expect(template.properties).not.toHaveProperty('actuator.tclClearCapability');
  });
});
