import type { ChargerConfig } from '../../../../src/config/config-types.js';
import type { ControlObservation } from '../../../../src/goe/control/control-types.js';
import { makeEmptyOwnership, type OwnershipState } from '../../../../src/goe/control/ownership-state.js';

export const testCharger: ChargerConfig = {
  id: 'garage', host: 'garage.test', name: 'Garage', enabled: true, priority: 1,
};

export function makeObservation(overrides: Partial<ControlObservation> = {}): ControlObservation {
  return {
    chargerId: testCharger.id, host: testCharger.host,
    readStartedAtMs: 0, observedAtMs: 0, amp: 14, tcl: null, frc: 0,
    loe: false, car: 2, mca: 6, acu: 14, ama: 16, acp: true, mcpd: 0, alw: true,
    ...overrides,
  };
}

export function makeOwnedState(overrides: Partial<OwnershipState> = {}): OwnershipState {
  return {
    ...makeEmptyOwnership(testCharger, 1_000),
    baseline: makeObservation(), pluginOwnedTcl: 10,
    lastObservedState: makeObservation({ readStartedAtMs: 990, observedAtMs: 1_000, tcl: 10, acu: 10 }),
    lastReadback: makeObservation({ readStartedAtMs: 990, observedAtMs: 1_000, tcl: 10, acu: 10 }),
    lastConfirmedWrite: {
      action: { type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: testCharger.id, amps: 10 },
      confirmedAtMs: 1_000,
    },
    ownershipStatus: 'OWNED',
    ...overrides,
  };
}
