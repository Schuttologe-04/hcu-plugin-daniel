import type { ControlAction } from './control-action.js';

export type LoadManagementState =
  | 'NORMAL' | 'TRIGGER_PENDING' | 'LIMITING' | 'PAUSED'
  | 'RECOVERING' | 'OVERRIDE' | 'LIMIT_UNACHIEVABLE' | 'FAULT';

export interface EngineFault {
  readonly code: 'INVALID_INPUT' | 'CONTROLLER_UNAVAILABLE' | 'INVALID_GRID'
    | 'INVALID_CHARGER' | 'OWNERSHIP_CONFLICT' | 'ACTION_FAILED';
  readonly message: string;
  readonly chargerId?: string;
}

export interface OwnedRestriction {
  readonly chargerId: string;
  /** An external limit is restored rather than cleared. */
  readonly baselineTemporaryCurrentLimitA: number | null;
  readonly temporaryCurrentLimitA: number | null;
  readonly paused: boolean;
  readonly pausedAtMs: number | null;
}

export interface PendingAction {
  readonly id: string;
  readonly action: ControlAction;
}

export interface EngineSnapshot {
  readonly state: LoadManagementState;
  readonly gridImportW: number | null;
  readonly targetGridW: number;
  readonly recoveryThresholdW: number;
  readonly triggerStartedAtMs: number | null;
  readonly lastActionAtMs: number | null;
  readonly overrideActive: boolean;
  readonly pendingAction: PendingAction | null;
  readonly restrictions: readonly OwnedRestriction[];
  /** Released ownership is not considered observed until a fresh matching snapshot arrives. */
  readonly awaitingObservationChargerIds: readonly string[];
  readonly fault: EngineFault | null;
  readonly unavailableChargerIds: readonly string[];
  readonly controllableChargingLoadRemaining: boolean;
}

export interface EngineDecision {
  readonly state: LoadManagementState;
  readonly action: ControlAction | null;
  readonly actionId: string | null;
  readonly status: EngineSnapshot;
}
