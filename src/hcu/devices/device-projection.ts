import type { ProbeReport } from '../../diagnostics/probe-service.js';
import type { ErrorCode } from '../../domain/errors.js';
import type { DeviceDefinition, PluginDevice } from './device-types.js';

function roundedPower(value: number | null | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Unrounded, signed watts for the display-only time integral. No estimated power. */
export function readDevicePower(definition: DeviceDefinition, report: ProbeReport | null): number | undefined {
  const source = definition.source;
  let value: number | null | undefined;
  if (source.kind === 'controller' && report?.controller.ok && report.controller.value.host === source.host) {
    const controller = report.controller.value;
    value = source.channel === 'Grid' ? controller.gridPowerW : source.channel === 'Home' ? controller.homePowerW
      : controller.solarPowerW === null || controller.solarPowerW === undefined ? undefined : -controller.solarPowerW;
  } else if (source.kind === 'charger' && report !== null) {
    const charger = report.chargers.find(item => item.config.id === source.chargerId && item.config.host === source.host);
    if (charger?.status === 'reachable' && charger.value.id === source.chargerId && charger.value.host === source.host) {
      value = charger.value.currentPowerW;
    }
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A received but invalid measurement is distinct from a failed connection. */
function unreachable(error: ErrorCode): boolean | undefined {
  switch (error) {
    case 'ConnectionError': case 'TimeoutError': return true;
    case 'MissingMeasurementError': case 'InvalidResponseError': return false;
    case 'ConfigurationError': return undefined;
  }
}

/** Pure read-only projection. It cannot access an engine, actuator or network. */
export function projectDevice(definition: DeviceDefinition, report: ProbeReport | null): PluginDevice {
  const power = roundedPower(readDevicePower(definition, report));
  let unreach: boolean | undefined;
  let firmware: string | undefined;
  const source = definition.source;
  if (report !== null && source.kind === 'controller') {
    const controller = report.controller;
    if (!controller.ok) unreach = unreachable(controller.error.code);
    else if (controller.value.host === source.host) {
      unreach = false;
    }
  } else if (report !== null && source.kind === 'charger') {
    const charger = report.chargers.find(value => value.config.id === source.chargerId && value.config.host === source.host);
    if (charger?.status === 'unavailable') unreach = unreachable(charger.error.code);
    else if (charger?.status === 'reachable' && charger.value.id === source.chargerId && charger.value.host === source.host) {
      unreach = false;
      if (typeof charger.value.firmwareVersion === 'string' && charger.value.firmwareVersion.trim().length > 0) firmware = charger.value.firmwareVersion;
    }
  }
  return {
    deviceId: definition.deviceId, deviceType: definition.deviceType, friendlyName: definition.friendlyName,
    ...(firmware === undefined ? {} : { firmwareVersion: firmware }),
    features: [
      { type: 'currentPower', ...(power === undefined ? {} : { currentPower: power }) },
      { type: 'maintenance', ...(unreach === undefined ? {} : { unreach }) },
    ],
  };
}
