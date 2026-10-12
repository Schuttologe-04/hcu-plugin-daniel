import type { AppConfig, ChargerConfig } from '../../../src/config/config-types.js';
import { KnownCarState, mapCarState, type ChargerStatus } from '../../../src/domain/charger.js';
import type { ControllerStatus } from '../../../src/domain/controller.js';
import { success, type Result } from '../../../src/domain/errors.js';
import type { ControlAction } from '../../../src/load-management/control-action.js';
import { LoadManager } from '../../../src/load-management/load-manager.js';

export function makeConfig(options: {
  loadManagement?: Partial<AppConfig['loadManagement']>;
  chargers?: readonly ChargerConfig[];
} = {}): AppConfig {
  return {
    controller: { host: 'controller.test' },
    loadManagement: {
      enabled: true,
      gridLimitW: 19_000,
      safetyReserveW: 500,
      triggerDurationSeconds: 30,
      controlIntervalSeconds: 4,
      ampStep: 1,
      ...options.loadManagement,
    },
    chargers: options.chargers ?? [
      { id: 'garage', name: 'Garage', host: 'garage.test', enabled: true, priority: 1 },
      { id: 'links', name: 'Links', host: 'links.test', enabled: true, priority: 20 },
      { id: 'rechts', name: 'Rechts', host: '', enabled: false, priority: 20 },
    ],
    http: { timeoutMs: 3_000 },
  };
}

export function allEnabledConfig(): AppConfig {
  const config = makeConfig();
  return { ...config, chargers: config.chargers.map((charger) => ({
    ...charger, enabled: true, host: `${charger.id}.test`,
  })) };
}

export function makeCharger(id = 'garage', patch: Partial<ChargerStatus> = {}): ChargerStatus {
  return {
    id,
    configuredName: id,
    reportedName: `go-eCharger ${id}`,
    host: `${id}.test`,
    reachable: true,
    firmwareVersion: '59.4',
    carState: mapCarState(KnownCarState.Charging),
    configuredCurrentA: 14,
    effectiveCurrentA: 14,
    temporaryCurrentLimitA: null,
    maximumCurrentA: 32,
    minimumCurrentA: 6,
    chargingAllowed: true,
    forceState: 0,
    allowChargingPause: true,
    minimumChargingPauseDuration: 0,
    modelStatus: 15,
    rawNrg: null,
    ...patch,
  };
}

export function idle(id: string): ChargerStatus {
  return makeCharger(id, {
    carState: mapCarState(KnownCarState.Idle),
    effectiveCurrentA: null,
    chargingAllowed: false,
    modelStatus: 2,
  });
}

export function controller(gridPowerW: number): ControllerStatus {
  return {
    host: 'controller.test', reachable: true, gridPowerW,
    gridImportW: Math.max(gridPowerW, 0),
    gridPhaseCurrentsA: { l1: null, l2: null, l3: null },
  };
}

/** Applies only in-memory domain actions; never invokes an HTTP/device client. */
export function applySimulatedAction(status: ChargerStatus, action: ControlAction): ChargerStatus {
  if (status.id !== action.chargerId) throw new Error('Action targets another simulated charger');
  switch (action.type) {
    case 'SET_TEMPORARY_CURRENT_LIMIT':
      return { ...status, temporaryCurrentLimitA: action.amps,
        effectiveCurrentA: status.forceState === 1 ? null : Math.min(status.configuredCurrentA, action.amps) };
    case 'PAUSE':
      return { ...status, carState: mapCarState(KnownCarState.Complete),
        effectiveCurrentA: null, chargingAllowed: false, forceState: 1, modelStatus: 4 };
    case 'RESUME':
      return { ...status, carState: mapCarState(KnownCarState.Charging),
        effectiveCurrentA: Math.min(status.configuredCurrentA, status.temporaryCurrentLimitA ?? status.configuredCurrentA),
        chargingAllowed: true, forceState: 0, modelStatus: 15 };
    case 'CLEAR_TEMPORARY_CURRENT_LIMIT':
      return { ...status, temporaryCurrentLimitA: null,
        effectiveCurrentA: status.forceState === 1 ? null : status.configuredCurrentA };
  }
}

export type Decision = ReturnType<LoadManager['evaluate']>;

/** Explicit observations and explicit acknowledgements keep every test deterministic. */
export class SimulationHarness {
  readonly engine: LoadManager;
  readonly chargers = new Map<string, Result<ChargerStatus>>();
  private observationCounter = 0;

  constructor(readonly config = makeConfig(), chargers: readonly ChargerStatus[] = [makeCharger(), idle('links')]) {
    this.engine = new LoadManager(config);
    for (const charger of chargers) this.chargers.set(charger.id, success(charger));
  }

  status(id: string): ChargerStatus {
    const result = this.chargers.get(id);
    if (!result?.ok) throw new Error(`Simulated charger ${id} is unavailable`);
    return result.value;
  }

  patch(id: string, patch: Partial<ChargerStatus>): void {
    this.chargers.set(id, success({ ...this.status(id), ...patch }));
  }

  evaluate(timestampMs: number, gridPowerW: number, measurementId?: string): Decision {
    return this.evaluateController(timestampMs, success(controller(gridPowerW)), measurementId);
  }

  evaluateController(timestampMs: number, value: Result<ControllerStatus>, measurementId?: string): Decision {
    this.observationCounter += 1;
    return this.engine.evaluate({
      timestampMs,
      measurementId: measurementId ?? `observation-${this.observationCounter}`,
      controller: value,
      chargers: [...this.chargers].map(([chargerId, status]) => ({ chargerId, status })),
    });
  }

  apply(decision: Decision): void {
    if (!decision.action || !decision.actionId) throw new Error('Expected an abstract action to apply');
    const { chargerId } = decision.action;
    this.chargers.set(chargerId, success(applySimulatedAction(this.status(chargerId), decision.action)));
    this.engine.acknowledgeAction(decision.actionId);
  }

  step(timestampMs: number, gridPowerW: number): Decision {
    const decision = this.evaluate(timestampMs, gridPowerW);
    if (decision.action) this.apply(decision);
    return decision;
  }

  trigger(gridPowerW = 22_839): Decision {
    this.evaluate(0, gridPowerW);
    return this.step(this.config.loadManagement.triggerDurationSeconds * 1_000, gridPowerW);
  }
}
