import type { AppConfig } from '../config/config-types.js';
import type { ChargerStatus } from '../domain/charger.js';
import { failure, success, type Result } from '../domain/errors.js';

export type LoadManagementSettings = AppConfig['loadManagement'];

/** All thresholds and durations originate in the validated configuration. */
export interface LoadPolicy {
  readonly gridLimitW: number;
  readonly targetGridW: number;
  readonly recoveryThresholdW: number;
  readonly triggerDurationMs: number;
  readonly controlIntervalMs: number;
  readonly ampStep: number;
}

export function derivePolicy(settings: LoadManagementSettings): LoadPolicy {
  return {
    gridLimitW: settings.gridLimitW,
    targetGridW: settings.gridLimitW - settings.safetyReserveW,
    recoveryThresholdW: settings.gridLimitW - 2 * settings.safetyReserveW,
    triggerDurationMs: settings.triggerDurationSeconds * 1_000,
    controlIntervalMs: settings.controlIntervalSeconds * 1_000,
    ampStep: settings.ampStep,
  };
}

export interface ControlCurrent {
  readonly effectiveCurrentA: number;
  /** The user's amp setting is a ceiling, never a value the engine changes. */
  readonly normalCurrentA: number;
  readonly temporaryCurrentLimitA: number | null;
  readonly minimumCurrentA: number;
}

function isPositiveCurrent(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && value > 0;
}

/**
 * Read the conservative current available for a reduction decision.
 * acu is essential: amp alone cannot establish the actual effective current.
 * Recovery uses the separately saved amp/ama/foreign-tcl ceiling, not this acu.
 */
export function readControlCurrent(status: ChargerStatus): Result<ControlCurrent> {
  const configured = status.configuredCurrentA;
  const effective = status.effectiveCurrentA;
  const temporary = status.temporaryCurrentLimitA;
  const maximum = status.maximumCurrentA;
  const minimum = status.minimumCurrentA;

  if (
    !isPositiveCurrent(configured)
    || !isPositiveCurrent(effective)
    || !isPositiveCurrent(minimum)
    || (temporary !== null && !isPositiveCurrent(temporary))
    || (maximum !== null && !isPositiveCurrent(maximum))
  ) {
    return failure('InvalidResponseError', 'Required charger current values are unavailable or invalid');
  }

  const controlCurrent = Math.min(configured, effective, temporary ?? configured, maximum ?? configured);
  if (minimum > controlCurrent) {
    return failure('InvalidResponseError', 'Charger current is below its reported minimum');
  }

  return success({
    effectiveCurrentA: controlCurrent,
    normalCurrentA: configured,
    temporaryCurrentLimitA: temporary,
    minimumCurrentA: minimum,
  });
}
