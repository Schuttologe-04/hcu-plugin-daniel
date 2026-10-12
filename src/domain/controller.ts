/** A successful snapshot. Unavailable measurements use Result failures instead. */
export interface ControllerStatus {
  readonly host: string;
  readonly reachable: true;
  /** Signed power: positive is grid import, negative is export. */
  readonly gridPowerW: number;
  readonly gridImportW: number;
  /** Unavailable phase measurements remain null, never zero. */
  readonly gridPhaseCurrentsA: {
    readonly l1: number | null;
    readonly l2: number | null;
    readonly l3: number | null;
  };
}
