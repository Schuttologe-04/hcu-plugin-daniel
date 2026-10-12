import type { ChargerStatus } from '../domain/charger.js';
import type { ControllerStatus } from '../domain/controller.js';
import type { Result } from '../domain/errors.js';

export interface ChargerObservation {
  readonly chargerId: string;
  readonly status: Result<ChargerStatus>;
}

/** The timestamp belongs to this complete measurement, not an internal timer. */
export interface EngineInput {
  readonly timestampMs: number;
  /** Unique within a session. Re-evaluating a measurement cannot emit another action. */
  readonly measurementId: string;
  readonly controller: Result<ControllerStatus>;
  readonly chargers: readonly ChargerObservation[];
}
