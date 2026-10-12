export type PluginDeviceType = 'GRID_CONNECTION_POINT' | 'ENERGY_METER' | 'INVERTER' | 'EV_CHARGER';

/** Connect API 1.0.1: optional measurements are omitted, never null. */
export interface CurrentPowerFeature {
  readonly type: 'currentPower';
  readonly currentPower?: number;
}

export interface MaintenanceFeature {
  readonly type: 'maintenance';
  readonly unreach?: boolean;
}

export type PluginDeviceFeature = CurrentPowerFeature | MaintenanceFeature;

export interface PluginDevice {
  readonly deviceId: string;
  readonly deviceType: PluginDeviceType;
  readonly friendlyName: string;
  readonly firmwareVersion?: string;
  readonly features: readonly PluginDeviceFeature[];
}

export interface DeviceDefinition {
  readonly deviceId: string;
  readonly deviceType: PluginDeviceType;
  readonly friendlyName: string;
  readonly source:
    | { readonly kind: 'controller'; readonly channel: 'Grid' | 'Home' | 'Solar'; readonly host: string }
    | { readonly kind: 'charger'; readonly chargerId: string; readonly host: string };
}
