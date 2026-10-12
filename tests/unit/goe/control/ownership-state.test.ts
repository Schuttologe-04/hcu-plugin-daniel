import { describe, expect, it } from 'vitest';
import { makeEmptyOwnership, validateOwnershipDocument } from '../../../../src/goe/control/ownership-state.js';
import { makeObservation, makeOwnedState, testCharger } from './ownership-helpers.js';

describe('validated persistent actuator ownership', () => {
  it('initializes with no ownership, no fabricated baseline and explicit time', () => {
    expect(makeEmptyOwnership(testCharger, 17)).toEqual({
      chargerId: 'garage', host: 'garage.test', baseline: null,
      pluginOwnedTcl: null, pluginOwnedPause: false, lastObservedState: null,
      lastConfirmedWrite: null, lastReadback: null, ownershipStatus: 'NONE',
      conflictStatus: null, pendingWrite: null, updatedAt: 17,
    });
  });

  it('accepts empty and confirmed owned documents', () => {
    expect(validateOwnershipDocument({ version: 1, chargers: [] })).toEqual({ ok: true, value: { version: 1, chargers: [] } });
    const document = { version: 1 as const, chargers: [makeEmptyOwnership(testCharger, 0), makeOwnedState({ chargerId: 'other' })] };
    // Nested identity remains bound to its charger, even in otherwise valid documents.
    expect(validateOwnershipDocument(document).ok).toBe(false);
    expect(validateOwnershipDocument({ version: 1, chargers: [makeOwnedState()] }).ok).toBe(true);
  });

  it.each([null, [], {}, { version: 2, chargers: [] }, { version: 1, chargers: null }])('rejects invalid document %j', (input) => {
    expect(validateOwnershipDocument(input)).toMatchObject({ ok: false, error: { code: 'ConfigurationError' } });
  });

  it('rejects duplicate IDs rather than silently taking the last state', () => {
    expect(validateOwnershipDocument({ version: 1, chargers: [makeOwnedState(), makeOwnedState()] }).ok).toBe(false);
  });

  it.each([
    { host: '' }, { host: 'http://garage.test/' }, { host: 'user:secret@garage.test' },
    { pluginOwnedTcl: 0 }, { pluginOwnedTcl: -1 }, { pluginOwnedTcl: 6.5 },
    { pluginOwnedPause: 'true' }, { updatedAt: Number.NaN }, { updatedAt: -1 },
    { updatedAt: 0.1 }, { updatedAt: Number.MAX_SAFE_INTEGER + 1 },
    { pluginOwnedTcl: Number.MAX_SAFE_INTEGER + 1 },
    { ownershipStatus: 'SAFE' }, { ownershipStatus: 'NONE' },
    { baseline: null }, { lastConfirmedWrite: null }, { lastReadback: null },
    { ownershipStatus: 'CONFLICT', conflictStatus: null },
    { conflictStatus: 'raw token with spaces' },
  ])('rejects invalid ownership fields %j', (fields) => {
    expect(validateOwnershipDocument({ version: 1, chargers: [{ ...makeOwnedState(), ...fields }] }).ok).toBe(false);
  });

  it('rejects claiming a foreign pause', () => {
    const state = makeOwnedState({ baseline: makeObservation({ frc: 1 }), pluginOwnedPause: true });
    expect(validateOwnershipDocument({ version: 1, chargers: [state] }).ok).toBe(false);
  });

  it('rejects an owned limit looser than the original external limit', () => {
    const state = makeOwnedState({ baseline: makeObservation({ tcl: 8 }) });
    expect(validateOwnershipDocument({ version: 1, chargers: [state] }).ok).toBe(false);
  });

  it('retains a stricter owned limit layered onto an external baseline', () => {
    const state = makeOwnedState({ baseline: makeObservation({ tcl: 12 }) });
    expect(validateOwnershipDocument({ version: 1, chargers: [state] })).toEqual({ ok: true, value: { version: 1, chargers: [state] } });
  });

  it.each([
    { type: 'SET_AMP', chargerId: 'garage', amps: 10 },
    { type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: null },
    { type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 0 },
    { type: 'PAUSE', chargerId: 'other' },
  ])('rejects invalid confirmed control actions %j', (action) => {
    const state = { ...makeOwnedState(), lastConfirmedWrite: { action, confirmedAtMs: 1_000 } };
    expect(validateOwnershipDocument({ version: 1, chargers: [state] }).ok).toBe(false);
  });

  it.each([
    { amp: '14' }, { tcl: 'null' }, { frc: null }, { loe: 0 }, { car: -1 },
    { mca: 0 }, { acu: -1 }, { ama: -1 }, { acp: null }, { mcpd: -1 },
    { alw: 1 }, { readStartedAtMs: 2_000, observedAtMs: 1_000 }, { chargerId: 'other' },
    { acu: 0.1 }, { mcpd: 0.1 }, { frc: Number.MAX_SAFE_INTEGER + 1 },
    { car: Number.MAX_SAFE_INTEGER + 1 }, { observedAtMs: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid normalized observation %j', (fields) => {
    const state = { ...makeOwnedState(), lastObservedState: { ...makeObservation(), ...fields } };
    expect(validateOwnershipDocument({ version: 1, chargers: [state] }).ok).toBe(false);
  });

  it('retains missing measurements as null without inventing zero', () => {
    const state = makeOwnedState({ lastObservedState: makeObservation({ loe: null, car: null, acu: null, ama: null }) });
    const result = validateOwnershipDocument({ version: 1, chargers: [state] });
    expect(result.ok && result.value.chargers[0]?.lastObservedState).toMatchObject({ loe: null, car: null, acu: null, ama: null });
  });

  it('permits durable pending intent but never claims it is already owned', () => {
    const state = {
      ...makeEmptyOwnership(testCharger, 1_000), baseline: makeObservation(), ownershipStatus: 'RECONCILING',
      pendingWrite: {
        action: { type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 10 },
        expectedTcl: 10, expectedFrc: 0, startedAtMs: 1_000,
      },
    };
    expect(validateOwnershipDocument({ version: 1, chargers: [state] }).ok).toBe(true);
    expect(validateOwnershipDocument({ version: 1, chargers: [{ ...state, ownershipStatus: 'OWNED' }] }).ok).toBe(false);
  });

  it.each([
    { type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 9 },
    { type: 'PAUSE', chargerId: 'garage' },
    { type: 'RESUME', chargerId: 'garage' },
  ])('rejects contradictory pending targets %j', (action) => {
    const state = {
      ...makeOwnedState(), ownershipStatus: 'RECONCILING',
      pendingWrite: { action, expectedTcl: 10, expectedFrc: 2, startedAtMs: 1_000 },
    };
    expect(validateOwnershipDocument({ version: 1, chargers: [state] }).ok).toBe(false);
  });

  it('whitelists fields throughout the document instead of retaining secrets or raw JSON', () => {
    const original = makeOwnedState();
    const input = {
      version: 1, authToken: 'private-auth', chargers: [{
        ...original, clientId: 'private-client', rawResponse: { untouched: 'private-raw' },
        baseline: { ...original.baseline, activationKey: 'private-key' },
        lastConfirmedWrite: {
          ...original.lastConfirmedWrite,
          action: { ...original.lastConfirmedWrite?.action, password: 'private-password' },
        },
      }],
    };
    const result = validateOwnershipDocument(input);
    expect(result).toEqual({ ok: true, value: { version: 1, chargers: [original] } });
    expect(JSON.stringify(result)).not.toMatch(/private|authToken|clientId|activationKey|rawResponse|password/u);
  });
});
