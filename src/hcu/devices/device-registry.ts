import type { AppConfig } from '../../config/config-types.js';
import { isValidDeviceHost } from '../../goe/device-host.js';
import type { DeviceDefinition } from './device-types.js';

/** Logical identities do not depend on host, label, time or process randomness. */
export const CONTROLLER_DEVICE_IDS = {
  Grid: 'controller-grid', Home: 'controller-home', Solar: 'controller-solar',
} as const;

export function chargerDeviceId(chargerId: string): string { return `charger-${chargerId}`; }

export function createDeviceRegistry(config: AppConfig): readonly DeviceDefinition[] {
  const controller = (channel: 'Grid' | 'Home' | 'Solar', deviceType: DeviceDefinition['deviceType'], friendlyName: string): DeviceDefinition => ({
    deviceId: CONTROLLER_DEVICE_IDS[channel], deviceType, friendlyName,
    source: { kind: 'controller', channel, host: config.controller.host },
  });
  return [
    controller('Grid', 'GRID_CONNECTION_POINT', 'go-e Netz'),
    controller('Home', 'ENERGY_METER', 'go-e Hausverbrauch'),
    controller('Solar', 'INVERTER', 'go-e Solar'),
    ...config.chargers.filter(charger => charger.enabled && isValidDeviceHost(charger.host)).map((charger): DeviceDefinition => ({
      deviceId: chargerDeviceId(charger.id), deviceType: 'EV_CHARGER', friendlyName: charger.name,
      source: { kind: 'charger', chargerId: charger.id, host: charger.host },
    })),
  ];
}
