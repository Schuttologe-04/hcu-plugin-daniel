import type { AppConfig } from '../config/config-types.js';
import { mapCarState, type ChargerStatus } from '../domain/charger.js';
import { derivePolicy } from '../load-management/policy.js';
import type { SimulationSample, SimulationStep } from './simulator.js';
import { runSimulation } from './simulator.js';

/** Technical sample corresponding to the real phase-1 observation in the task. */
export function demoStatuses(config: AppConfig): readonly ChargerStatus[] {
  return config.chargers.filter((charger) => charger.enabled).map((charger) => {
    const charging = charger.id === 'garage';
    return {
      id: charger.id,
      configuredName: charger.name,
      reportedName: charger.name,
      host: charger.host,
      reachable: true,
      firmwareVersion: '59.4',
      carState: mapCarState(charging ? 2 : 1),
      configuredCurrentA: 14,
      effectiveCurrentA: charging ? 14 : null,
      temporaryCurrentLimitA: null,
      maximumCurrentA: null,
      minimumCurrentA: 6,
      chargingAllowed: charging,
      forceState: 0,
      allowChargingPause: true,
      minimumChargingPauseDuration: 0,
      modelStatus: charging ? 15 : 2,
      rawNrg: null,
    };
  });
}

/** Policy times/thresholds are derived from the supplied validated configuration. */
export function demoSamples(config: AppConfig): readonly SimulationSample[] {
  const policy = derivePolicy(config.loadManagement);
  const triggerMs = policy.triggerDurationMs;
  const intervalMs = policy.controlIntervalMs;
  const gridW = 22_839;
  return [
    { timestampMs: 0, gridPowerW: gridW },
    { timestampMs: Math.floor(triggerMs / 3), gridPowerW: gridW },
    { timestampMs: Math.floor(2 * triggerMs / 3), gridPowerW: gridW },
    { timestampMs: triggerMs - 1, gridPowerW: gridW },
    { timestampMs: triggerMs, gridPowerW: gridW },
    { timestampMs: triggerMs + intervalMs, gridPowerW: gridW },
    { timestampMs: triggerMs + 2 * intervalMs, gridPowerW: gridW },
    {
      timestampMs: triggerMs + 3 * intervalMs,
      gridPowerW: policy.targetGridW,
    },
    {
      timestampMs: triggerMs + 4 * intervalMs,
      gridPowerW: policy.recoveryThresholdW,
    },
    { timestampMs: triggerMs + 5 * intervalMs, gridPowerW: null },
  ];
}

export function runDemoSimulation(config: AppConfig): readonly SimulationStep[] {
  return runSimulation(config, demoStatuses(config), demoSamples(config));
}
