import { describe, expect, it } from 'vitest';
import { isActivelyCharging, KnownCarState, mapCarState } from '../../../src/domain/charger.js';

describe('car state', () => {
  it.each([
    [KnownCarState.UnknownOrError, 'unknown/error'],
    [KnownCarState.Idle, 'idle'],
    [KnownCarState.Charging, 'charging'],
    [KnownCarState.WaitingForCar, 'waiting-for-car'],
    [KnownCarState.Complete, 'complete'],
    [KnownCarState.Error, 'error'],
  ] as const)('maps documented state %i to %s', (code, label) => {
    expect(mapCarState(code)).toEqual({ kind: 'known', code, label });
  });

  it.each([null, 0, 1, 3, 4, 5, 77])('does not claim active charging for state %s', (code) => {
    expect(isActivelyCharging({ carState: mapCarState(code) })).toBe(false);
  });

  it('uses the documented charging state in one centralized helper', () => {
    expect(isActivelyCharging({ carState: mapCarState(2) })).toBe(true);
  });
});
