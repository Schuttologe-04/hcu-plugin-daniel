/** Transport-neutral configuration, ready for a future HCU config provider. */
export interface ChargerConfig {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly enabled: boolean;
  /** A smaller number represents a higher future charging priority. */
  readonly priority: number;
}

/** HCU notification preferences only; credentials never belong to AppConfig. */
export interface NotificationSettings {
  readonly intervention: boolean;
  readonly controllerConnectionError: boolean;
  readonly chargerConnectionError: boolean;
  readonly interactive: boolean;
}

export interface AppConfig {
  readonly controller: {
    readonly host: string;
  };
  /** Validated phase-2 settings; phase 1 never acts on these values. */
  readonly loadManagement: {
    readonly enabled: boolean;
    /** Explicit operational activation; absent legacy settings are disabled. */
    readonly liveControlEnabled?: boolean;
    readonly gridLimitW: number;
    readonly safetyReserveW: number;
    readonly triggerDurationSeconds: number;
    readonly controlIntervalSeconds: number;
    readonly ampStep: number;
  };
  readonly chargers: readonly ChargerConfig[];
  readonly http: {
    readonly timeoutMs: number;
  };
  /** Optional for backwards-compatible phase-1/2 configuration providers. */
  readonly notifications?: NotificationSettings;
}

export const DEFAULT_HTTP_TIMEOUT_MS = 3_000;

/** A provider returns untrusted data; loadConfig performs validation. */
export interface ConfigProvider {
  load(): Promise<unknown>;
}
