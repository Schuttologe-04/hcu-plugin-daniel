import type { ChargerConfig } from '../../config/config-types.js';
import type { Result } from '../../domain/errors.js';

export type ExecutionMode = 'HCU_DEV' | 'DRY_RUN' | 'LIVE';
export interface WriteGate {
  readonly executionMode: ExecutionMode;
  readonly realWritesEnabled: boolean;
}

/** Timestamped, validated controls only; no raw network response is retained. */
export interface ControlObservation {
  readonly chargerId: string;
  readonly host: string;
  readonly readStartedAtMs: number;
  readonly observedAtMs: number;
  readonly amp: number;
  readonly tcl: number | null;
  readonly frc: number;
  readonly loe: boolean | null;
  readonly car: number | null;
  readonly mca: number;
  readonly acu: number | null;
  readonly ama: number | null;
  readonly acp: boolean;
  readonly mcpd: number;
  readonly alw: boolean;
  /** Optional for compatibility with phase-4 persisted evidence. Never inferred. */
  readonly firmwareVersion?: string | null;
  readonly tclClearCapability?: 'VERIFIED' | 'BLOCKED' | 'UNKNOWN';
}

/** Exactly four typed operations. No path or arbitrary key can be supplied. */
export interface ChargerControlClient {
  readStatus(config: ChargerConfig): Promise<Result<ControlObservation>>;
  setTemporaryCurrentLimit(config: ChargerConfig, amps: number): Promise<Result<void>>;
  /** Recheck the caller's live fence after any client-side asynchronous preflight. */
  clearTemporaryCurrentLimit(config: ChargerConfig, beforeSend?: (current?: ControlObservation) => Result<void>): Promise<Result<void>>;
  pause(config: ChargerConfig): Promise<Result<void>>;
  resume(config: ChargerConfig): Promise<Result<void>>;
}
