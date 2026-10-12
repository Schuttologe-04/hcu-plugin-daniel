import { describe, expect, it } from 'vitest';
import { ActionJournal, summarizeCharger, type ActionJournalEvent, type JournalEventKind } from '../../../src/orchestration/action-journal.js';
import { makeCharger } from '../load-management/helpers.js';

const kinds: readonly JournalEventKind[] = ['ABSTRACT_ACTION', 'WRITE_BLOCKED', 'WRITE_ATTEMPTED', 'WRITE_CONFIRMED', 'READBACK_MISMATCH', 'OWNERSHIP_CONFLICT', 'FAULT'];
function event(kind: JournalEventKind, timestamp = 0): ActionJournalEvent {
  return { kind, timestamp, engineState: 'LIMITING', gridImportW: 22_839,
    action: { type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 13 },
    chargerSnapshotSummary: [summarizeCharger(makeCharger())],
    result: kind, errorCode: kind === 'READBACK_MISMATCH' ? 'READBACK_MISMATCH' : 'NONE', retryCount: 0 };
}

describe('phase 4 structured action journal events', () => {
  it('distinguishes all seven event kinds without conflating abstract actions with confirmed writes', () => {
    const journal = new ActionJournal();
    for (const kind of kinds) journal.appendEvent(event(kind));
    expect(journal.events.map((entry) => entry.kind)).toEqual(kinds);
    expect(journal.events[0]?.kind).toBe('ABSTRACT_ACTION');
    expect(journal.events[3]?.kind).toBe('WRITE_CONFIRMED');
  });

  it('keeps the latest fifty events across actions, readbacks, conflicts and faults', () => {
    const journal = new ActionJournal();
    for (let index = 0; index < 70; index += 1) journal.appendEvent({ ...event(kinds[index % kinds.length]!, index), action: index % 2 === 0 ? null : event('ABSTRACT_ACTION').action });
    expect(journal.events).toHaveLength(50);
    expect(journal.events[0]?.timestamp).toBe(20);
    expect(journal.events.at(-1)?.timestamp).toBe(69);
    expect(journal.entries).toHaveLength(25);
  });

  it('records a fault with no charger command and no invented zero-Grid measurement', () => {
    const journal = new ActionJournal();
    journal.appendEvent({ ...event('FAULT'), action: null, gridImportW: null, engineState: 'FAULT', errorCode: 'CONTROLLER_UNAVAILABLE' });
    expect(journal.events[0]).toMatchObject({ kind: 'FAULT', action: null, gridImportW: null, engineState: 'FAULT' });
    expect(journal.entries).toEqual([]);
  });

  it('strips raw response and secret extras recursively from projected action and summary fields', () => {
    const journal = new ActionJournal();
    const source = { ...event('WRITE_ATTEMPTED'), authToken: 'secret', rawResponse: { deviceSecret: true },
      action: { type: 'SET_TEMPORARY_CURRENT_LIMIT' as const, chargerId: 'garage', amps: 13, activationKey: 'secret' },
      chargerSnapshotSummary: [{ ...summarizeCharger(makeCharger()), rawNrg: [1, 2, 3], rawPayload: 'secret' }],
    };
    journal.appendEvent(source);
    expect(journal.events[0]).toEqual(event('WRITE_ATTEMPTED'));
    expect(JSON.stringify(journal.events)).not.toMatch(/secret|authToken|activationKey|rawResponse|rawPayload|rawNrg/u);
  });

  it('copies event inputs and exported outputs to preserve immutable history', () => {
    const journal = new ActionJournal();
    const source = event('WRITE_CONFIRMED');
    journal.appendEvent(source);
    Object.assign(source, { kind: 'FAULT' });
    Object.assign(source.action!, { amps: 1 });
    Object.assign(source.chargerSnapshotSummary[0]!, { effectiveCurrentA: 999 });
    const exported = journal.events;
    Object.assign(exported[0]!, { result: 'FAILED' });
    Object.assign(exported[0]!.action!, { amps: 2 });
    expect(journal.events[0]).toEqual(event('WRITE_CONFIRMED'));
  });

  it('preserves the existing append/entries contract without adding event metadata to legacy entries', () => {
    const journal = new ActionJournal();
    const source = event('ABSTRACT_ACTION');
    const { kind: _kind, result: _result, errorCode: _code, retryCount: _retry, ...legacy } = source;
    if (legacy.action === null) throw new Error('Action expected');
    journal.append({ ...legacy, action: legacy.action });
    expect(journal.entries).toEqual([legacy]);
    expect(journal.events[0]?.kind).toBe('ABSTRACT_ACTION');
    expect(journal.entries[0]).not.toHaveProperty('kind');
    expect(journal.entries[0]).not.toHaveProperty('result');
    expect(journal.entries[0]).not.toHaveProperty('retryCount');
  });
});
