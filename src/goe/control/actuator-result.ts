import type { ControlAction } from '../../load-management/control-action.js';

export type ActuatorStatus =
  | 'BLOCKED' | 'CONFIRMED' | 'FAILED' | 'CONFLICT' | 'UNREACHABLE'
  | 'READBACK_FAILED' | 'READBACK_MISMATCH';

/** Sanitized diagnostic data: no credentials, payload or native error object. */
export interface ActuatorResult {
  readonly status: ActuatorStatus;
  readonly code: string;
  readonly message: string;
  readonly action: ControlAction;
  readonly chargerId: string;
  readonly writeAttempted: boolean;
  /** Device writes are attempted at most once per execute call. */
  readonly attempts: number;
  readonly readAttempts: number;
  readonly confirmedAtMs?: number;
}
