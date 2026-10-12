/** Numeric car states documented by the official go-e HTTP API v2. */
export enum KnownCarState {
  UnknownOrError = 0,
  Idle = 1,
  Charging = 2,
  WaitingForCar = 3,
  Complete = 4,
  Error = 5,
}

export type KnownCarStateLabel =
  | 'unknown/error'
  | 'idle'
  | 'charging'
  | 'waiting-for-car'
  | 'complete'
  | 'error';

/** Unknown future codes and internal-error null values remain distinguishable. */
export type CarState =
  | { readonly kind: 'known'; readonly code: KnownCarState; readonly label: KnownCarStateLabel }
  | { readonly kind: 'unknown'; readonly code: number; readonly label: 'unknown' }
  | { readonly kind: 'unavailable'; readonly code: null; readonly label: 'unavailable' };

export interface ChargerStatus {
  readonly id: string;
  readonly configuredName: string;
  readonly reportedName: string;
  readonly host: string;
  readonly reachable: true;
  readonly firmwareVersion: string | null;
  readonly carState: CarState;
  readonly configuredCurrentA: number;
  readonly effectiveCurrentA: number | null;
  readonly temporaryCurrentLimitA: number | null;
  readonly maximumCurrentA: number | null;
  readonly minimumCurrentA: number;
  readonly chargingAllowed: boolean;
  /** Raw frc code; future codes are preserved without inventing semantics. */
  readonly forceState: number;
  readonly allowChargingPause: boolean;
  /** Raw mcpd duration in milliseconds; zero means the minimum pause is disabled. */
  readonly minimumChargingPauseDuration: number;
  readonly modelStatus: number;
  /** No index meaning or scaling is assumed. Missing nrg is explicitly null. */
  readonly rawNrg: readonly (number | null)[] | null;
}

export function mapCarState(code: number | null): CarState {
  switch (code) {
    case null:
      return { kind: 'unavailable', code, label: 'unavailable' };
    case KnownCarState.UnknownOrError:
      return { kind: 'known', code, label: 'unknown/error' };
    case KnownCarState.Idle:
      return { kind: 'known', code, label: 'idle' };
    case KnownCarState.Charging:
      return { kind: 'known', code, label: 'charging' };
    case KnownCarState.WaitingForCar:
      return { kind: 'known', code, label: 'waiting-for-car' };
    case KnownCarState.Complete:
      return { kind: 'known', code, label: 'complete' };
    case KnownCarState.Error:
      return { kind: 'known', code, label: 'error' };
    default:
      return { kind: 'unknown', code, label: 'unknown' };
  }
}

/** Device-reported charging state; this does not infer measured charging power. */
export function isActivelyCharging(status: Pick<ChargerStatus, 'carState'>): boolean {
  return status.carState.kind === 'known' && status.carState.code === KnownCarState.Charging;
}
