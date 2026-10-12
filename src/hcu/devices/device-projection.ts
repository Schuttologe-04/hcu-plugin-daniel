import type { ProbeReport } from '../../diagnostics/probe-service.js';
import type { ErrorCode } from '../../domain/errors.js';
import type { DeviceDefinition, PluginDevice } from './device-types.js';

function roundedPower(value: number | null | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const rounded = Math.round(value);
  return Object.is(rounded, -0) ? 0 : rounded;
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
  let power: number | undefined;
  let unreach: boolean | undefined;
  let firmware: string | undefined;
  const source = definition.source;
  if (report !== null && source.kind === 'controller') {
    const controller = report.controller;
    if (!controller.ok) unreach = unreachable(controller.error.code);
    else if (controller.value.host === source.host) {
      unreach = false;
      power = roundedPower(source.channel === 'Grid' ? controller.value.gridPowerW
        : source.channel === 'Home' ? controller.value.homePowerW
          : controller.value.solarPowerW === null || controller.value.solarPowerW === undefined
            ? undefined : -controller.value.solarPowerW);
    }
  } else if (report !== null && source.kind === 'charger') {
    const charger = report.chargers.find(value => value.config.id === source.chargerId && value.config.host === source.host);
    if (charger?.status === 'unavailable') unreach = unreachable(charger.error.code);
    else if (charger?.status === 'reachable' && charger.value.id === source.chargerId && charger.value.host === source.host) {
      unreach = false;
      power = roundedPower(charger.value.currentPowerW);
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
