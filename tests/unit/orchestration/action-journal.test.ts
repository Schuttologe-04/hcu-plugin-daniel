import { describe, expect, it } from 'vitest';
import { ActionJournal, summarizeCharger, type ActionJournalEntry } from '../../../src/orchestration/action-journal.js';
import { makeCharger } from '../load-management/helpers.js';

function entry(timestamp = 0): ActionJournalEntry {
  return {
    timestamp, engineState: 'LIMITING', gridImportW: 22_839,
    action: { type: 'SET_TEMPORARY_CURRENT_LIMIT', chargerId: 'garage', amps: 13 },
    chargerSnapshotSummary: [summarizeCharger(makeCharger())],
  };
}

describe('bounded dry-run action journal', () => {
  it('retains the latest fifty actions in chronological append order', () => {
    const journal = new ActionJournal();
    for (let index = 0; index < 60; index += 1) journal.append(entry(index));
    expect(journal.entries).toHaveLength(50);
    expect(journal.entries[0]?.timestamp).toBe(10);
    expect(journal.entries.at(-1)?.timestamp).toBe(59);
  });

  it('supports a small injected diagnostic capacity', () => {
    const journal = new ActionJournal(2);
    journal.append(entry(1)); journal.append(entry(2)); journal.append(entry(3));
    expect(journal.entries.map((value) => value.timestamp)).toEqual([2, 3]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid capacity %s', (capacity) => {
    expect(() => new ActionJournal(capacity)).toThrow('positive integer');
  });

  it('copies input action and summaries instead of retaining mutable input objects', () => {
    const journal = new ActionJournal();
    const source = entry();
    journal.append(source);
    Object.assign(source.action, { amps: 2 });
    Object.assign(source.chargerSnapshotSummary[0]!, { effectiveCurrentA: 99 });
    expect(journal.entries[0]?.action).toMatchObject({ amps: 13 });
    expect(journal.entries[0]?.chargerSnapshotSummary[0]?.effectiveCurrentA).toBe(14);
  });

  it('copies output values so an inspector cannot mutate subsequent journal reads', () => {
    const journal = new ActionJournal();
    journal.append(entry());
    const exported = journal.entries;
    Object.assign(exported[0]!.action, { amps: 1 });
    Object.assign(exported[0]!.chargerSnapshotSummary[0]!, { effectiveCurrentA: 99 });
    expect(journal.entries[0]?.action).toMatchObject({ amps: 13 });
    expect(journal.entries[0]?.chargerSnapshotSummary[0]?.effectiveCurrentA).toBe(14);
  });

  it('summarizes only documented charger values, without raw responses, hosts or names', () => {
    const summary = summarizeCharger(makeCharger('garage', { rawNrg: [230, 230, 230] }));
    expect(Object.keys(summary)).toEqual([
      'chargerId', 'carState', 'configuredCurrentA', 'effectiveCurrentA',
      'temporaryCurrentLimitA', 'minimumCurrentA',
    ]);
    expect(JSON.stringify(summary)).not.toMatch(/rawNrg|host|reportedName|firmware/u);
  });

  it('projects documented entry/action/summary fields and strips unknown raw payload extras', () => {
    const journal = new ActionJournal();
    const source = { ...entry(), rawResponse: { privateNetworkData: true },
      action: { type: 'SET_TEMPORARY_CURRENT_LIMIT' as const, chargerId: 'garage', amps: 13, secretToken: 'do-not-retain' },
      chargerSnapshotSummary: [{ ...summarizeCharger(makeCharger()), rawNrg: [1, 2, 3] }] };
    journal.append(source);
    expect(journal.entries[0]).toEqual(entry());
    expect(JSON.stringify(journal.entries)).not.toMatch(/rawResponse|secretToken|rawNrg|do-not-retain/u);
  });
});
