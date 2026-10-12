import type { ControlAction } from '../load-management/control-action.js';
import type { LoadManagementState } from '../load-management/load-manager-state.js';
import type { ChargerStatus } from '../domain/charger.js';

export interface ChargerSnapshotSummary {
  readonly chargerId: string;
  readonly carState: number | null;
  readonly configuredCurrentA: number;
  readonly effectiveCurrentA: number | null;
  readonly temporaryCurrentLimitA: number | null;
  readonly minimumCurrentA: number;
}

export interface ActionJournalEntry {
  readonly timestamp: number;
  readonly engineState: LoadManagementState;
  readonly gridImportW: number | null;
  readonly action: ControlAction;
  readonly chargerSnapshotSummary: readonly ChargerSnapshotSummary[];
}

export type JournalEventKind = 'ABSTRACT_ACTION' | 'WRITE_BLOCKED' | 'WRITE_ATTEMPTED' | 'WRITE_CONFIRMED'
  | 'READBACK_MISMATCH' | 'OWNERSHIP_CONFLICT' | 'FAULT';
export interface ActionJournalEvent {
  readonly kind: JournalEventKind;
  readonly timestamp: number;
  readonly engineState: LoadManagementState;
  readonly gridImportW: number | null;
  readonly action: ControlAction | null;
  readonly chargerSnapshotSummary: readonly ChargerSnapshotSummary[];
  readonly result?: string;
  readonly errorCode?: string;
  readonly retryCount?: number;
}

function copyEvent(event: ActionJournalEvent): ActionJournalEvent {
  return { timestamp: event.timestamp, engineState: event.engineState, gridImportW: event.gridImportW,
    chargerSnapshotSummary: event.chargerSnapshotSummary.map(copySummary),
    action: event.action === null ? null : copyAction(event.action), kind: event.kind,
    ...(event.result === undefined ? {} : { result: event.result }),
    ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
    ...(event.retryCount === undefined ? {} : { retryCount: event.retryCount }) };
}

export function summarizeCharger(status: ChargerStatus): ChargerSnapshotSummary {
  return {
    chargerId: status.id, carState: status.carState.code,
    configuredCurrentA: status.configuredCurrentA, effectiveCurrentA: status.effectiveCurrentA,
    temporaryCurrentLimitA: status.temporaryCurrentLimitA, minimumCurrentA: status.minimumCurrentA,
  };
}

function copy(entry: ActionJournalEntry): ActionJournalEntry {
  return {
    timestamp: entry.timestamp, engineState: entry.engineState, gridImportW: entry.gridImportW, action: copyAction(entry.action),
    chargerSnapshotSummary: entry.chargerSnapshotSummary.map(copySummary),
  };
}

function copyAction(action: ControlAction): ControlAction {
  return action.type === 'SET_TEMPORARY_CURRENT_LIMIT'
    ? { type: action.type, chargerId: action.chargerId, amps: action.amps }
    : { type: action.type, chargerId: action.chargerId };
}

function copySummary(status: ChargerSnapshotSummary): ChargerSnapshotSummary {
  return { chargerId: status.chargerId, carState: status.carState, configuredCurrentA: status.configuredCurrentA,
    effectiveCurrentA: status.effectiveCurrentA, temporaryCurrentLimitA: status.temporaryCurrentLimitA,
    minimumCurrentA: status.minimumCurrentA };
}

/** Bounded diagnostics only: no raw payloads and no persistent event database. */
export class ActionJournal {
  readonly #events: ActionJournalEvent[] = [];
  constructor(private readonly capacity = 50) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) throw new Error('Journal capacity must be a positive integer.');
  }
  append(entry: ActionJournalEntry): void {
    this.appendEvent({ ...copy(entry), kind: 'ABSTRACT_ACTION' });
  }
  appendEvent(event: ActionJournalEvent): void {
    this.#events.push(copyEvent(event));
    if (this.#events.length > this.capacity) this.#events.splice(0, this.#events.length - this.capacity);
  }
  get events(): readonly ActionJournalEvent[] { return this.#events.map(copyEvent); }
  /** Existing consumers still receive only action entries, without internal event metadata. */
  get entries(): readonly ActionJournalEntry[] {
    return this.#events.flatMap((event) => event.action === null ? [] : [copy({ ...event, action: event.action })]);
  }
}
