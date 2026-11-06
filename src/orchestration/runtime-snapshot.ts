import type { ProbeReport } from '../diagnostics/probe-service.js';
import type { ControlAction } from '../load-management/control-action.js';
import type { EngineDecision, EngineSnapshot } from '../load-management/load-manager-state.js';
import { PLUGIN_VERSION } from '../hcu/plugin-identity.js';
import type { OwnershipState } from '../goe/control/ownership-state.js';
import type { TelemetryHealth } from './telemetry-health.js';

export interface ActuatorDiagnostics {
  readonly state: string;
  readonly ownership: readonly OwnershipState[];
  readonly lastResult: { readonly status: string; readonly code: string; readonly message: string } | null;
}

/** Real observations and simulated engine state deliberately have distinct fields. */
export interface RuntimeSnapshot {
  readonly mode: 'HCU_DEV' | 'DRY_RUN' | 'LIVE' | 'INSTALLED_LIVE';
  readonly connectionState: string;
  readonly pluginVersion: string;
  readonly observedAtMs: number | null;
  /** Start of the existing concurrent read, for bounded HCU display aggregation only. */
  readonly probeStartedAtMs?: number;
  readonly probe: ProbeReport | null;
  readonly engine: EngineSnapshot | null;
  readonly lastDecision: EngineDecision | null;
  readonly lastAction: ControlAction | null;
  readonly lastHcuMessage: string | null;
  readonly lastHcuAnswer: string | null;
  readonly realChargerWritesEnabled: boolean;
  readonly automaticLiveControlEnabled?: boolean;
  readonly configurationState?: 'CONFIGURED' | 'NOT_CONFIGURED';
  readonly openInterventionMessage?: string | null;
  readonly messageStatePersistenceError?: string | null;
  readonly simulationNote?: string;
  readonly telemetryHealth?: TelemetryHealth;
  readonly actuator?: ActuatorDiagnostics;
}

export function initialRuntimeSnapshot(mode: RuntimeSnapshot['mode'] = 'HCU_DEV'): RuntimeSnapshot {
  return {
    mode, connectionState: 'DISCONNECTED', pluginVersion: PLUGIN_VERSION,
    observedAtMs: null, probe: null, engine: null, lastDecision: null, lastAction: null,
    lastHcuMessage: null, lastHcuAnswer: null, realChargerWritesEnabled: false,
  };
}
