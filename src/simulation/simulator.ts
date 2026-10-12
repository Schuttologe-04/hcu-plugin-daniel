import type { AppConfig } from '../config/config-types.js';
import { mapCarState, type ChargerStatus } from '../domain/charger.js';
import type { ControllerStatus } from '../domain/controller.js';
import { failure, success } from '../domain/errors.js';
import type { ControlAction } from '../load-management/control-action.js';
import { LoadManager } from '../load-management/load-manager.js';
import type { EngineDecision } from '../load-management/load-manager-state.js';

export interface SimulationSample {
  readonly timestampMs: number;
  /** Signed controller power; null explicitly models an unavailable measurement. */
  readonly gridPowerW: number | null;
}

export interface SimulationStep extends SimulationSample {
  readonly gridImportW: number | null;
  readonly state: EngineDecision['state'];
  readonly action: ControlAction | null;
  readonly actionId: string | null;
  readonly status: EngineDecision['status'];
  /** Immutable snapshot observed by the engine before the action at this step. */
  readonly observedChargers: readonly ChargerStatus[];
}

function simulatedCurrent(status: ChargerStatus, temporaryLimit: number | null): number {
  return Math.min(
    status.configuredCurrentA,
    status.maximumCurrentA ?? Number.POSITIVE_INFINITY,
    temporaryLimit ?? Number.POSITIVE_INFINITY,
  );
}

/**
 * Simplified deterministic device model, not a go-e command executor.
 * It returns an independent in-memory snapshot and never contacts a device.
 * Grid samples are supplied separately: no guessed electrical power conversion.
 */
export function applySimulatedAction(status: ChargerStatus, action: ControlAction): ChargerStatus {
  if (status.id !== action.chargerId) {
    throw new Error('A simulated action must refer to the supplied charger.');
  }
  const cloned = { ...status, rawNrg: status.rawNrg === null ? null : [...status.rawNrg] };
  switch (action.type) {
    case 'SET_TEMPORARY_CURRENT_LIMIT':
      if (!Number.isSafeInteger(action.amps) || action.amps < status.minimumCurrentA) {
        throw new Error('A simulated temporary current limit must respect the charger minimum.');
      }
      return {
        ...cloned,
        temporaryCurrentLimitA: action.amps,
        effectiveCurrentA: status.effectiveCurrentA === null ? null : simulatedCurrent(status, action.amps),
      };
    case 'PAUSE':
      return {
        ...cloned,
        carState: mapCarState(4),
        chargingAllowed: false,
        forceState: 1,
        effectiveCurrentA: null,
      };
    case 'RESUME':
      return {
        ...cloned,
        carState: mapCarState(2),
        chargingAllowed: true,
        forceState: 0,
        effectiveCurrentA: simulatedCurrent(status, status.temporaryCurrentLimitA),
      };
    case 'CLEAR_TEMPORARY_CURRENT_LIMIT':
      return {
        ...cloned,
        temporaryCurrentLimitA: null,
        effectiveCurrentA: status.effectiveCurrentA === null ? null : simulatedCurrent(status, null),
      };
  }
}

function copyStatus(status: ChargerStatus): ChargerStatus {
  return {
    ...status,
    carState: { ...status.carState },
    rawNrg: status.rawNrg === null ? null : [...status.rawNrg],
  };
}

/**
 * Evaluate one decision per explicit sample, apply it only to in-memory devices,
 * acknowledge it, and expose the result on the following sample.
 * This harness has no timers, filesystem access, HTTP or logging dependencies.
 */
export function runSimulation(
  config: AppConfig,
  initialStatuses: readonly ChargerStatus[],
  samples: readonly SimulationSample[],
): readonly SimulationStep[] {
  const manager = new LoadManager(config);
  let chargers = initialStatuses.map(copyStatus);
  const steps: SimulationStep[] = [];

  for (const [index, sample] of samples.entries()) {
    const controller = sample.gridPowerW === null
      ? failure('MissingMeasurementError', 'The simulated Grid measurement is unavailable.')
      : success<ControllerStatus>({
        host: config.controller.host,
        reachable: true,
        gridPowerW: sample.gridPowerW,
        gridImportW: Math.max(sample.gridPowerW, 0),
        gridPhaseCurrentsA: { l1: null, l2: null, l3: null },
      });
    const observedChargers = chargers.map(copyStatus);
    const decision = manager.evaluate({
      timestampMs: sample.timestampMs,
      measurementId: `simulation-${index}`,
      controller,
      chargers: observedChargers.map((status) => ({ chargerId: status.id, status: success(status) })),
    });
    steps.push({
      ...sample,
      gridImportW: sample.gridPowerW === null ? null : Math.max(sample.gridPowerW, 0),
      state: decision.state,
      action: decision.action,
      actionId: decision.actionId,
      status: decision.status,
      observedChargers,
    });

    if (decision.action !== null && decision.actionId !== null) {
      const action = decision.action;
      chargers = chargers.map((status) => status.id === action.chargerId
        ? applySimulatedAction(status, action)
        : status);
      manager.acknowledgeAction(decision.actionId, 'applied');
    }
  }
  return steps;
}
