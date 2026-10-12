import type { AppConfig } from '../../config/config-types.js';
import { getNotificationSettings } from '../../config/notification-settings.js';
import type { ChargerStatus } from '../../domain/charger.js';
import type { ControlAction } from '../../load-management/control-action.js';
import { derivePolicy } from '../../load-management/policy.js';
import type { RuntimeSnapshot } from '../../orchestration/runtime-snapshot.js';

/** Connect API 1.0.1 sections 6.5.3/6.5.4; values are strings even for BOOLEAN. */
export interface GroupTemplate {
  readonly friendlyName: string;
  readonly description?: string;
  readonly order?: number;
}

export interface PropertyTemplate {
  readonly dataType: 'BOOLEAN' | 'INTEGER' | 'NUMBER' | 'READONLY' | 'STRING';
  readonly friendlyName: string;
  readonly currentValue?: string;
  readonly defaultValue?: string;
  readonly description?: string;
  readonly groupId?: string;
  readonly order?: number;
  readonly required?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minimumLength?: number;
  readonly maximumLength?: number;
}

export interface ConfigTemplate {
  readonly groups: Readonly<Record<string, GroupTemplate>>;
  readonly properties: Readonly<Record<string, PropertyTemplate>>;
}

export const HCU_CHARGER_SLOTS = ['garage', 'links', 'rechts'] as const;
export const UNAVAILABLE = 'unavailable';

function text(value: string | number | boolean | null | undefined): string {
  return value === null || value === undefined ? UNAVAILABLE : String(value);
}

/** A compact domain summary, without raw JSON, device URLs or HTTP payloads. */
export function summarizeControlAction(action: ControlAction | null): string {
  if (action === null) return UNAVAILABLE;
  return `${action.type} ${action.chargerId}${action.type === 'SET_TEMPORARY_CURRENT_LIMIT' ? ` ${action.amps} A` : ''}`;
}

/** Read-only snapshot projection; opening HCUweb never triggers device polling. */
export function buildConfigTemplate(
  config: AppConfig,
  snapshot: RuntimeSnapshot,
  languageCode = 'de',
): ConfigTemplate {
  const english = languageCode === 'en';
  const label = (de: string, en: string): string => english ? en : de;
  const policy = derivePolicy(config.loadManagement);
  const notifications = getNotificationSettings(config);
  const groups: Record<string, GroupTemplate> = {
    controller: { friendlyName: 'go-e Controller', order: 10 },
    loadManagement: { friendlyName: label('Lastmanagement', 'Load management'), order: 20 },
    chargerGarage: { friendlyName: label('Ladestation Garage', 'Charger garage'), order: 30 },
    chargerLinks: { friendlyName: label('Ladestation Links', 'Charger left'), order: 40 },
    chargerRechts: { friendlyName: label('Ladestation Rechts', 'Charger right'), order: 50 },
    notifications: { friendlyName: label('Benachrichtigungen', 'Notifications'), order: 60 },
    diagnostics: { friendlyName: label('Diagnose', 'Diagnostics'), order: 70 },
  };
  const properties: Record<string, PropertyTemplate> = {};
  const orders: Record<string, number> = {};
  const property = (
    id: string,
    groupId: string,
    friendlyName: string,
    dataType: PropertyTemplate['dataType'],
    value: string | number | boolean | null | undefined,
    extra: Partial<PropertyTemplate> = {},
  ): void => {
    const order = (orders[groupId] ?? 0) + 10;
    orders[groupId] = order;
    const { required, ...extraProperties } = extra;
    properties[id] = { groupId, friendlyName, dataType,
      ...(value === undefined && dataType !== 'READONLY' ? {} : { currentValue: text(value) }), order,
      // HCUweb treats required checkboxes as needing to be checked. False is valid.
      ...(dataType === 'BOOLEAN' ? {} : { required: required ?? dataType !== 'READONLY' }),
      ...extraProperties };
  };
  const readOnly = (id: string, group: string, name: string, value: string | number | boolean | null | undefined): void => {
    property(id, group, name, 'READONLY', value);
  };

  property('controller.host', 'controller', label('Controller-Adresse', 'Controller address'), 'STRING', config.controller.host, { minimumLength: 1 });
  property('loadManagement.enabled', 'controller', label('Lastmanagement aktiv', 'Load management enabled'), 'BOOLEAN', config.loadManagement.enabled);
  if (snapshot.mode === 'INSTALLED_LIVE') {
    property('loadManagement.liveControlEnabled', 'loadManagement', label('Reale Laderegelung aktiv', 'Automatic real charger control'),
      'BOOLEAN', config.loadManagement.liveControlEnabled === true, { defaultValue: 'false' });
    readOnly('diagnostics.containerWriteCapability', 'diagnostics', label('Reale Schreibfähigkeit', 'Container write capability'),
      snapshot.realChargerWritesEnabled ? label('verfügbar', 'available') : label('gesperrt', 'blocked'));
    readOnly('diagnostics.automaticLiveControlEnabled', 'diagnostics', label('Automatische Regelung', 'Automatic control'),
      snapshot.automaticLiveControlEnabled ? label('EIN', 'ON') : label('AUS', 'OFF'));
    readOnly('diagnostics.openInterventionMessage', 'diagnostics', label('Offene Lastmanagement-Frage', 'Open intervention message'), snapshot.openInterventionMessage);
    readOnly('diagnostics.messageStatePersistenceError', 'diagnostics', label('Nachrichten-Persistenzfehler', 'Message persistence error'), snapshot.messageStatePersistenceError);
  }
  const controller = snapshot.probe?.controller;
  const measured = controller?.ok && controller.value.host === config.controller.host ? controller.value : null;
  readOnly('controller.connectionStatus', 'controller', label('Verbindungsstatus', 'Connection status'), measured === null ? UNAVAILABLE : 'reachable');
  readOnly('controller.gridPowerW', 'controller', label('Aktueller Grid-Wert (W)', 'Current grid power (W)'), measured?.gridPowerW);
  readOnly('controller.gridImportW', 'controller', label('Aktueller positiver Netzbezug (W)', 'Current grid import (W)'), measured?.gridImportW);

  property('loadManagement.gridLimitW', 'loadManagement', label('Grid-Grenzwert (W)', 'Grid limit (W)'), 'NUMBER', config.loadManagement.gridLimitW, { minimum: 0 });
  property('loadManagement.safetyReserveW', 'loadManagement', label('Sicherheitsreserve (W)', 'Safety reserve (W)'), 'NUMBER', config.loadManagement.safetyReserveW, { minimum: 0 });
  property('loadManagement.triggerDurationSeconds', 'loadManagement', label('Überschreitungsdauer (s)', 'Trigger duration (s)'), 'INTEGER', config.loadManagement.triggerDurationSeconds, { minimum: 1 });
  property('loadManagement.controlIntervalSeconds', 'loadManagement', label('Regelintervall (s)', 'Control interval (s)'), 'INTEGER', config.loadManagement.controlIntervalSeconds, { minimum: 1 });
  readOnly('loadManagement.ampStep', 'loadManagement', label('Regelschritt (A)', 'Current step (A)'), config.loadManagement.ampStep);
  readOnly('loadManagement.targetGridW', 'loadManagement', label('Regelziel (W)', 'Target grid import (W)'), policy.targetGridW);
  readOnly('loadManagement.recoveryThresholdW', 'loadManagement', label('Recovery-Schwelle (W)', 'Recovery threshold (W)'), policy.recoveryThresholdW);

  for (const slot of HCU_CHARGER_SLOTS) {
    const group = `charger${slot[0]?.toUpperCase()}${slot.slice(1)}`;
    const prefix = `chargers.${slot}`;
    const charger = config.chargers.find((entry) => entry.id === slot);
    const last = snapshot.probe?.chargers.find((entry) => entry.config.id === slot);
    const status: ChargerStatus | null = charger?.enabled === true && last?.status === 'reachable' && last.value.host === charger.host
      ? last.value : null;
    property(`${prefix}.enabled`, group, label('Aktiv', 'Enabled'), 'BOOLEAN', charger?.enabled);
    property(`${prefix}.name`, group, label('Name', 'Name'), 'STRING', charger?.name, { minimumLength: 1, required: charger !== undefined });
    property(`${prefix}.host`, group, label('Host/IP', 'Host/IP'), 'STRING', charger?.host, { required: charger?.enabled ?? false });
    property(`${prefix}.priority`, group, label('Priorität', 'Priority'), 'INTEGER', charger?.priority, { minimum: 1, required: charger !== undefined });
    readOnly(`${prefix}.reachable`, group, label('Erreichbar', 'Reachable'), status?.reachable);
    readOnly(`${prefix}.reportedName`, group, label('Gemeldeter Name', 'Reported name'), status?.reportedName);
    readOnly(`${prefix}.firmwareVersion`, group, label('Firmware', 'Firmware'), status?.firmwareVersion);
    if (snapshot.mode === 'INSTALLED_LIVE') readOnly(`${prefix}.tclClearCapability`, group, 'TCL clear capability',
      status?.firmwareVersion === null || status?.firmwareVersion === undefined ? 'unknown'
        : status.firmwareVersion === '59.4' ? 'verified' : 'blocked');
    readOnly(`${prefix}.car`, group, 'car', status?.carState.code);
    readOnly(`${prefix}.amp`, group, 'amp (A)', status?.configuredCurrentA);
    readOnly(`${prefix}.acu`, group, 'acu (A)', status?.effectiveCurrentA);
    readOnly(`${prefix}.tcl`, group, 'tcl (A)', status?.temporaryCurrentLimitA);
    readOnly(`${prefix}.mca`, group, 'mca (A)', status?.minimumCurrentA);
    readOnly(`${prefix}.frc`, group, 'frc', status?.forceState);
    readOnly(`${prefix}.modelStatus`, group, 'modelStatus', status?.modelStatus);
  }

  property('notifications.intervention', 'notifications', label('Meldung bei Lastmanagement-Eingriff aktiv', 'Notify on load management intervention'), 'BOOLEAN', notifications.intervention, { defaultValue: 'false' });
  property('notifications.controllerConnectionError', 'notifications', label('Warnung bei Controller-Verbindungsfehler aktiv', 'Warn on controller connection failure'), 'BOOLEAN', notifications.controllerConnectionError, { defaultValue: 'false' });
  property('notifications.chargerConnectionError', 'notifications', label('Warnung bei Charger-Verbindungsfehler aktiv', 'Warn on charger connection failure'), 'BOOLEAN', notifications.chargerConnectionError, { defaultValue: 'false' });
  property('notifications.interactive', 'notifications', label('Interaktive JA/NEIN-Abfrage', 'Interactive YES/NO question'), 'BOOLEAN', notifications.interactive, { defaultValue: 'true' });

  readOnly('diagnostics.pluginVersion', 'diagnostics', label('Plugin-Version', 'Plugin version'), snapshot.pluginVersion);
  readOnly('diagnostics.connectionState', 'diagnostics', label('HCU-Verbindungsstatus', 'HCU connection state'), snapshot.connectionState);
  readOnly('diagnostics.engineState', 'diagnostics', label('Engine-Zustand', 'Engine state'), snapshot.engine?.state);
  readOnly('diagnostics.gridPowerW', 'diagnostics', 'Grid (W)', measured?.gridPowerW);
  readOnly('diagnostics.gridImportW', 'diagnostics', 'Grid import (W)', measured?.gridImportW);
  readOnly('diagnostics.gridLimitW', 'diagnostics', label('Grid-Grenzwert (W)', 'Grid limit (W)'), policy.gridLimitW);
  readOnly('diagnostics.targetGridW', 'diagnostics', label('Regelziel (W)', 'Target grid import (W)'), policy.targetGridW);
  readOnly('diagnostics.recoveryThresholdW', 'diagnostics', label('Recovery-Schwelle (W)', 'Recovery threshold (W)'), policy.recoveryThresholdW);
  readOnly('diagnostics.lastDecision', 'diagnostics', label('Letzte Engine-Entscheidung', 'Last engine decision'), snapshot.lastDecision === null ? null
    : `${snapshot.lastDecision.state}; ${summarizeControlAction(snapshot.lastDecision.action)}`);
  readOnly('diagnostics.lastAction', 'diagnostics', label('Letzte abstrakte ControlAction', 'Last abstract control action'), summarizeControlAction(snapshot.lastAction));
  readOnly('diagnostics.lastHcuMessage', 'diagnostics', label('Letzte HCU-Meldung', 'Last HCU message'), snapshot.lastHcuMessage);
  readOnly('diagnostics.lastHcuAnswer', 'diagnostics', label('Letzte HCU-Antwort', 'Last HCU answer'), snapshot.lastHcuAnswer);
  readOnly('diagnostics.executionMode', 'diagnostics', label('Ausführungsmodus', 'Execution mode'), snapshot.mode);
  readOnly('diagnostics.realChargerWrites', 'diagnostics', label('Reale Charger-Schreibzugriffe', 'Real charger writes'), snapshot.realChargerWritesEnabled ? 'enabled' : 'disabled');
  readOnly('diagnostics.simulationNote', 'diagnostics', label('Simulationshinweis', 'Simulation note'), snapshot.simulationNote);
  readOnly('diagnostics.controllerTelemetryHealth', 'diagnostics', label('Controller-Telemetrie', 'Controller telemetry health'), snapshot.telemetryHealth?.state);
  readOnly('diagnostics.recoveryAllowed', 'diagnostics', label('Recovery freigegeben', 'Recovery allowed'), snapshot.telemetryHealth?.recoveryAllowed);
  readOnly('diagnostics.actuatorState', 'diagnostics', label('Actuator-Zustand', 'Actuator state'), snapshot.actuator?.state);
  readOnly('diagnostics.lastActuatorError', 'diagnostics', label('Letzter Actuator-Fehler', 'Last actuator error'), snapshot.actuator?.lastResult?.status === 'CONFIRMED' ? null : snapshot.actuator?.lastResult?.code);
  readOnly('diagnostics.limitUnachievable', 'diagnostics', 'LIMIT_UNACHIEVABLE', snapshot.engine === null ? undefined : snapshot.engine.state === 'LIMIT_UNACHIEVABLE');
  readOnly('diagnostics.fault', 'diagnostics', 'FAULT', snapshot.engine?.fault?.code);
  for (const slot of HCU_CHARGER_SLOTS) {
    const state = snapshot.actuator?.ownership.find((entry) => entry.chargerId === slot);
    const prefix = `diagnostics.${slot}`;
    readOnly(`${prefix}.ownershipStatus`, 'diagnostics', `${slot}: Ownership`, state?.ownershipStatus);
    readOnly(`${prefix}.conflictStatus`, 'diagnostics', `${slot}: Konflikt`, state?.conflictStatus);
    readOnly(`${prefix}.pluginOwnedTcl`, 'diagnostics', `${slot}: Plugin tcl (A)`, state?.pluginOwnedTcl);
    readOnly(`${prefix}.pluginOwnedPause`, 'diagnostics', `${slot}: Plugin-Pause`, state?.pluginOwnedPause);
    readOnly(`${prefix}.lastConfirmedWrite`, 'diagnostics', `${slot}: Letzter bestätigter Write`, state?.lastConfirmedWrite === null || state?.lastConfirmedWrite === undefined ? null
      : `${summarizeControlAction(state.lastConfirmedWrite.action)} @ ${state.lastConfirmedWrite.confirmedAtMs}`);
    readOnly(`${prefix}.lastReadback`, 'diagnostics', `${slot}: Letzter Readback`, state?.lastReadback === null || state?.lastReadback === undefined ? null
      : `tcl=${text(state.lastReadback.tcl)}, frc=${state.lastReadback.frc}, loe=${text(state.lastReadback.loe)} @ ${state.lastReadback.observedAtMs}`);
  }
  return { groups, properties };
}
