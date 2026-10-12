import type { Logger } from 'pino';
import { failure, success, type Result } from '../../domain/errors.js';
import type { IdProvider } from '../id-provider.js';
import type { IncomingHcuMessage } from '../message-types.js';
import { PLUGIN_ID } from '../plugin-identity.js';
import { validateInteractionDocument, type InteractionDocument, type InteractionStateStore,
  type PersistedInteraction } from './interaction-state.js';
import { HcuUserMessageService, type CreateUserMessageInput } from './user-message-service.js';

export type OverrideAnswer = 'YES' | 'NO';

export interface OverrideInteractionOptions {
  readonly messages: HcuUserMessageService;
  readonly idProvider: IdProvider;
  readonly onYes: () => void;
  readonly onAnswer?: (id: string, answer: OverrideAnswer) => void;
  readonly logger?: Logger;
  readonly messageMode?: 'DRY_RUN' | 'LIVE' | 'INSTALLED_LIVE';
  readonly stateStore?: InteractionStateStore;
  readonly now?: () => number;
}

interface OpenInteraction {
  readonly id: string;
  readonly input: CreateUserMessageInput;
  resolved: boolean;
}

/** Exactly one question per explicitly delimited session; no inferred car-state lifecycle. */
export class OverrideInteractionCoordinator {
  private requested = false;
  private open: OpenInteraction | null = null;
  private readonly pendingDeletionIds = new Set<string>();
  private readonly creatingById = new Map<string, Promise<Result<void>>>();
  private readonly deletingById = new Map<string, Promise<void>>();
  private reconciling: Promise<Result<void>> | null = null;
  private lastMessageValue: string | null = null;
  private lastAnswerValue: string | null = null;
  private sessionId = '';
  private overrideActive = false;
  private readonly records = new Map<string, PersistedInteraction>();
  private loaded = false;
  private initialized = false;
  private stopped = false;
  private initialization: Promise<Result<void>> | null = null;
  private persistenceQueue: Promise<Result<void>> = Promise.resolve(success(undefined));
  private persistenceErrorValue: string | null = null;
  private overrideRestored = false;
  private startupReconciled = false;

  constructor(private readonly options: OverrideInteractionOptions) {}

  get openUserMessageId(): string | null {
    return this.open !== null && !this.open.resolved ? this.open.id : null;
  }

  get lastMessage(): string | null { return this.lastMessageValue; }
  get lastAnswer(): string | null { return this.lastAnswerValue; }
  get persistenceError(): string | null { return this.persistenceErrorValue; }

  /** Installed startup: restores session evidence, then lists only this plugin's messages. */
  async initialize(options: { readonly reconcile?: boolean } = {}): Promise<Result<void>> {
    const reconcile = options.reconcile !== false;
    if (this.stopped) return failure('ConfigurationError', 'HCU interaction coordinator is stopped.');
    if (this.options.stateStore === undefined) return success(undefined);
    if (this.initialized && (!reconcile || this.startupReconciled)) return success(undefined);
    if (this.initialization !== null) return this.initialization;
    const run = this.initializeOnce(reconcile);
    this.initialization = run;
    try { return await run; } finally { this.initialization = null; }
  }

  /** Keeps an open current-session question; shutdown never creates or blindly deletes it. */
  async shutdown(): Promise<Result<void>> {
    this.stopped = true;
    await Promise.all(this.creatingById.values());
    await Promise.all(this.deletingById.values());
    if (this.initialization !== null) await this.initialization;
    if (this.options.stateStore !== undefined && !this.loaded) {
      return failure('ConfigurationError', 'Unloaded HCU interaction state was preserved.');
    }
    return this.persist();
  }

  async requestIntervention(): Promise<Result<void>> {
    if (this.stopped || (this.options.stateStore !== undefined && !this.initialized)) {
      return failure('ConfigurationError', 'HCU interaction persistence is not ready.');
    }
    if (this.requested) {
      return this.open === null ? success(undefined)
        : this.creatingById.get(this.open.id) ?? success(undefined);
    }
    let id: string;
    try {
      id = this.options.idProvider.nextId();
    } catch {
      return failure('ConfigurationError', 'Override message ID provider failed.');
    }
    if (typeof id !== 'string' || id.trim().length === 0 || id !== id.trim()
      || (this.options.stateStore !== undefined && (id.length > 256 || /[\u0000-\u001f\u007f]/u.test(id) || this.records.has(id)))) {
      return failure('ConfigurationError', 'Invalid override user message ID.');
    }
    this.requested = true;
    const live = this.options.messageMode === 'LIVE' || this.options.messageMode === 'INSTALLED_LIVE';
    const installed = this.options.messageMode === 'INSTALLED_LIVE';
    this.open = {
      id,
      resolved: false,
      input: {
        userMessageId: id,
        title: installed ? { de: 'go-e Lastmanagement', en: 'go-e load management' }
          : live ? { de: 'go-e Lastmanagement – bestätigter Eingriff', en: 'go-e load management – confirmed intervention' }
          : { de: 'TEST: go-e Lastmanagement', en: 'TEST: go-e load management' },
        message: installed ? {
          de: 'Das Lastmanagement hat die Ladeleistung begrenzt, weil der Netzbezug den eingestellten Grenzwert überschritten hat.\n\n'
            + 'JA = für den aktuellen Ladevorgang normale Ladeleistung erlauben.\n'
            + 'NEIN = automatische Begrenzung beibehalten. Fremde Einstellungen bleiben erhalten.',
          en: 'Load management limited charging power because grid import exceeded the configured limit.\n\n'
            + 'YES = allow normal charging power for the current session.\n'
            + 'NO = retain automatic limiting. External settings are preserved.',
        } : live ? {
          de: 'Ein explizit gestarteter Live-Eingriff wurde durch Gerätestatus bestätigt. '
            + 'Sollen die eindeutig vom Plugin gesetzten Einschränkungen für diese Ladesession wieder aufgehoben werden?\n\n'
            + 'JA = Override anfordern. NEIN = Einschränkung beibehalten. Fremde Einstellungen bleiben erhalten.',
          en: 'An explicitly started live intervention was confirmed by device readback. '
            + 'Request removal of restrictions owned by this plugin for the current session?\n\n'
            + 'YES = request override. NO = retain the restriction. External settings are preserved.',
        } : {
          de: 'Dry-Run: Das Lastmanagement hätte jetzt eingegriffen. '
            + 'Es wurden keine Einstellungen an den Wallboxen verändert.\n\n'
            + 'JA = Override in der Simulation aktivieren.\n'
            + 'NEIN = automatische Simulation fortsetzen.',
          en: 'Dry run: load management would now intervene. No charger settings have been changed.\n\n'
            + 'YES = activate simulation override.\nNO = continue automatic simulation.',
        },
        behaviorType: 'ACKNOWLEDGEABLE_BY_YES_NO',
        messageCategory: 'WARN',
      },
    };
    this.lastMessageValue = `${live ? 'go-e Lastmanagement' : 'TEST: go-e Lastmanagement'} (${id})`;
    if (this.options.stateStore !== undefined) {
      const createdAt = this.timestamp();
      if (createdAt === null) {
        this.open = null;
        this.requested = false;
        return failure('ConfigurationError', 'Invalid HCU interaction timestamp.');
      }
      this.records.set(id, { userMessageId: id, sessionId: this.sessionId,
        messagePurpose: live ? 'LIVE_INTERVENTION' : 'TEST_INTERVENTION', createdAt, state: 'OPEN', answer: null });
    }
    return this.createOpen(this.open);
  }

  async handleAcknowledgement(message: IncomingHcuMessage): Promise<boolean> {
    if (this.stopped || message.type !== 'USER_MESSAGE_ACK_EVENT'
      || (this.options.stateStore !== undefined && message.pluginId !== PLUGIN_ID)
      || (this.options.stateStore !== undefined && !this.initialized)) return false;
    const { userMessageId, ackType } = message.body;
    const interaction = this.open;
    if (interaction === null || interaction.resolved || userMessageId !== interaction.id
      || (ackType !== 'YES' && ackType !== 'NO')) {
      this.options.logger?.debug('Ignored unassigned or completed HCU acknowledgement');
      return false;
    }
    // Mark first, before any await: a duplicate event cannot apply the override twice.
    interaction.resolved = true;
    const oldRecord = this.records.get(interaction.id);
    if (oldRecord !== undefined) {
      this.records.set(interaction.id, { ...oldRecord, state: 'ANSWERED', answer: ackType });
      this.overrideActive = ackType === 'YES';
      const stored = await this.persist();
      if (!stored.ok) {
        this.records.set(interaction.id, oldRecord);
        this.overrideActive = false;
        interaction.resolved = false;
        return false;
      }
      // An explicit session end or shutdown while saving invalidates a late ACK.
      if (this.stopped || this.open !== interaction || oldRecord.sessionId !== this.sessionId) return false;
    }
    this.pendingDeletionIds.add(interaction.id);
    this.lastAnswerValue = `${ackType} (${interaction.id})`;
    if (ackType === 'YES') this.options.onYes();
    this.options.onAnswer?.(interaction.id, ackType);
    await this.cleanup();
    return true;
  }

  /** Reuses the original ID (same-ID create replaces per API), never opens another question. */
  async reconcile(): Promise<Result<void>> {
    if (this.stopped) return success(undefined);
    if (this.options.stateStore !== undefined && (!this.initialized || !this.startupReconciled)) return this.initialize();
    if (this.reconciling !== null) return this.reconciling;
    const run = this.reconcileOnce();
    this.reconciling = run;
    try { return await run; } finally { this.reconciling = null; }
  }

  async endSession(): Promise<void> {
    if (this.stopped) return;
    const oldId = this.open?.id;
    if (oldId !== undefined) this.pendingDeletionIds.add(oldId);
    if (this.options.stateStore !== undefined) {
      for (const [id, entry] of this.records) {
        if (entry.sessionId === this.sessionId && entry.state !== 'DELETED') {
          this.records.set(id, { ...entry, state: 'STALE' });
          this.pendingDeletionIds.add(id);
        }
      }
      const nextSessionId = this.newSessionId();
      if (nextSessionId === null) { this.initialized = false; return; }
      this.sessionId = nextSessionId;
      this.overrideActive = false;
      this.overrideRestored = false;
    }
    this.open = null;
    this.requested = false;
    if (this.options.stateStore !== undefined) {
      const stored = await this.persist();
      if (!stored.ok) { this.initialized = false; return; }
    }
    // A create already on the wire may finish after endSession; wait, then remove that ID.
    const oldCreation = oldId === undefined ? undefined : this.creatingById.get(oldId);
    if (oldCreation !== undefined) await oldCreation;
    await this.cleanup();
  }

  private async createOpen(interaction: OpenInteraction): Promise<Result<void>> {
    const inFlight = this.creatingById.get(interaction.id);
    if (inFlight !== undefined) return inFlight;
    const run = (async (): Promise<Result<void>> => {
      if (this.options.stateStore !== undefined) {
        const persisted = await this.persist();
        if (!persisted.ok) return persisted;
      }
      if (this.stopped) return failure('ConfigurationError', 'HCU interaction coordinator is stopped.');
      const result = await this.options.messages.create(interaction.input);
      return result.ok ? success(undefined) : result;
    })();
    this.creatingById.set(interaction.id, run);
    try { return await run; } finally { this.creatingById.delete(interaction.id); }
  }

  private async reconcileOnce(): Promise<Result<void>> {
    const currentId = this.open?.id;
    await Promise.all([...this.creatingById.entries()]
      .filter(([id]) => id === currentId || this.pendingDeletionIds.has(id))
      .map(([, creation]) => creation));
    if (this.open === null && this.pendingDeletionIds.size === 0) return success(undefined);
    const listed = await this.options.messages.list();
    if (!listed.ok) return listed;
    for (const id of this.pendingDeletionIds) {
      if (!Object.hasOwn(listed.value, id)) {
        this.pendingDeletionIds.delete(id);
        const entry = this.records.get(id);
        if (entry !== undefined) this.records.set(id, { ...entry, state: 'DELETED' });
      }
    }
    const persisted = await this.persist();
    if (!persisted.ok) return persisted;
    await this.cleanup();
    const interaction = this.open;
    if (interaction === null || interaction.resolved) return success(undefined);
    if (Object.hasOwn(listed.value, interaction.id)) return success(undefined);
    return this.createOpen(interaction);
  }

  private async cleanup(): Promise<void> {
    for (const id of this.pendingDeletionIds) {
      if (this.stopped) return;
      const existing = this.deletingById.get(id);
      if (existing !== undefined) { await existing; continue; }
      const run = (async (): Promise<void> => {
        const creating = this.creatingById.get(id);
        if (creating !== undefined) await creating;
        if (this.stopped || !this.pendingDeletionIds.has(id)) return;
        const result = await this.options.messages.delete(id);
        if (result.ok) {
          this.pendingDeletionIds.delete(id);
          const entry = this.records.get(id);
          if (entry !== undefined) this.records.set(id, { ...entry, state: 'DELETED' });
          await this.persist();
        } else this.options.logger?.warn({ errorCode: result.error.code }, 'HCU message cleanup pending');
      })();
      this.deletingById.set(id, run);
      try { await run; } finally { this.deletingById.delete(id); }
    }
  }

  private timestamp(): number | null {
    try {
      const value = (this.options.now ?? Date.now)();
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    } catch { return null; }
  }

  private newSessionId(): string | null {
    try {
      const id = this.options.idProvider.nextId();
      return typeof id === 'string' && id.length > 0 && id.length <= 256 && id === id.trim()
        && !/[\u0000-\u001f\u007f]/u.test(id) ? id : null;
    } catch { return null; }
  }

  private document(): InteractionDocument {
    // Keep bounded tombstones, but never drop open or pending cleanup evidence.
    const pending = [...this.records.values()].filter((entry) => entry.state !== 'DELETED');
    const available = Math.max(0, 100 - pending.length);
    const deleted = available === 0 ? []
      : [...this.records.values()].filter((entry) => entry.state === 'DELETED').slice(-available);
    return { version: 1, pluginId: PLUGIN_ID,
      session: { sessionId: this.sessionId, interventionRequested: this.requested, overrideActive: this.overrideActive },
      messages: [...deleted, ...pending].map((entry) => ({ ...entry })) };
  }

  private async persist(): Promise<Result<void>> {
    if (this.options.stateStore === undefined) return success(undefined);
    const document = this.document();
    const save = async (): Promise<Result<void>> => {
      try { return await this.options.stateStore!.save(document); } catch {
        return failure('ConfigurationError', 'HCU interaction state persistence failed.');
      }
    };
    const run = this.persistenceQueue.then(save, save);
    this.persistenceQueue = run;
    const result = await run;
    this.persistenceErrorValue = result.ok ? null : result.error.message;
    if (!result.ok) this.options.logger?.error({ errorCode: result.error.code }, 'HCU interaction persistence failed');
    return result;
  }

  private async initializeOnce(reconcile: boolean): Promise<Result<void>> {
    if (!this.loaded) {
      let loaded: Result<InteractionDocument | null>;
      try { loaded = await this.options.stateStore!.load(); } catch {
        return failure('ConfigurationError', 'HCU interaction state could not be loaded.');
      }
      if (!loaded.ok) return loaded;
      if (loaded.value !== null) {
        const validated = validateInteractionDocument(loaded.value);
        if (!validated.ok) return validated;
        const document = validated.value;
        this.sessionId = document.session.sessionId;
        this.requested = document.session.interventionRequested;
        this.overrideActive = document.session.overrideActive;
        for (const entry of document.messages) this.records.set(entry.userMessageId, entry);
        if (this.options.messageMode === 'INSTALLED_LIVE') {
          const sessionEntries = document.messages.filter((entry) => entry.sessionId === this.sessionId
            && entry.messagePurpose !== 'LEGACY_PLUGIN_MESSAGE');
          for (const entry of sessionEntries) {
            if (entry.messagePurpose === 'TEST_INTERVENTION' && entry.state !== 'DELETED') {
              this.records.set(entry.userMessageId, { ...entry, state: 'STALE' });
            }
          }
          if (sessionEntries.length > 0 && sessionEntries.every((entry) => entry.messagePurpose === 'TEST_INTERVENTION')) {
            const id = this.newSessionId();
            if (id === null) return failure('ConfigurationError', 'Invalid installed HCU session ID.');
            this.sessionId = id;
            this.requested = false;
            this.overrideActive = false;
          }
        }
        const current = [...this.records.values()].find((entry) => entry.state === 'OPEN'
          && entry.sessionId === this.sessionId && entry.messagePurpose !== 'LEGACY_PLUGIN_MESSAGE');
        if (current !== undefined) {
          const input = this.restoredInput(current);
          this.open = { id: current.userMessageId, resolved: false, input };
          this.lastMessageValue = `${current.messagePurpose === 'TEST_INTERVENTION' ? 'TEST: ' : ''}go-e Lastmanagement (${current.userMessageId})`;
        }
        for (const entry of this.records.values()) {
          if ((entry.state === 'ANSWERED' || entry.state === 'DELETED') && entry.answer !== null
            && entry.sessionId === this.sessionId) {
            this.lastAnswerValue = `${entry.answer} (${entry.userMessageId})`;
          }
        }
      } else {
        const id = this.newSessionId();
        if (id === null) return failure('ConfigurationError', 'Invalid HCU session ID.');
        this.sessionId = id;
      }
      this.loaded = true;
    }
    const localStored = await this.persist();
    if (!localStored.ok) return localStored;
    if (this.stopped) return failure('ConfigurationError', 'HCU interaction coordinator is stopped.');
    this.initialized = true;
    if (this.overrideActive && !this.overrideRestored) {
      this.overrideRestored = true;
      this.options.onYes();
    }
    if (!reconcile) return success(undefined);
    const listed = await this.options.messages.list();
    if (!listed.ok) return listed;
    // The authenticated Connect API LIST is plugin-scoped. Unknown listed IDs are
    // previous-process or legacy TEST orphans, not IDs obtained from foreign ACKs.
    for (const [id, createdAt] of Object.entries(listed.value)) {
      if (!this.records.has(id)) this.records.set(id, { userMessageId: id, sessionId: this.sessionId,
        messagePurpose: 'LEGACY_PLUGIN_MESSAGE', createdAt, state: 'STALE', answer: null });
    }
    for (const [id, entry] of this.records) {
      const active = entry.state === 'OPEN' && entry.sessionId === this.sessionId
        && entry.messagePurpose !== 'LEGACY_PLUGIN_MESSAGE';
      if (!active && entry.state !== 'DELETED') {
        if (Object.hasOwn(listed.value, id)) this.pendingDeletionIds.add(id);
        else this.records.set(id, { ...entry, state: 'DELETED' });
      }
    }
    const persisted = await this.persist();
    if (!persisted.ok) return persisted;
    await this.cleanup();
    if (this.stopped) return failure('ConfigurationError', 'HCU interaction coordinator is stopped.');
    this.startupReconciled = true;
    if (this.open !== null && !this.open.resolved && !Object.hasOwn(listed.value, this.open.id)) return this.createOpen(this.open);
    return success(undefined);
  }

  private restoredInput(entry: PersistedInteraction): CreateUserMessageInput {
    const live = entry.messagePurpose === 'LIVE_INTERVENTION';
    return { userMessageId: entry.userMessageId,
      title: { de: live ? 'go-e Lastmanagement' : 'TEST: go-e Lastmanagement' },
      message: { de: live
        ? 'Das Lastmanagement hat die Ladeleistung begrenzt, weil der Netzbezug den eingestellten Grenzwert überschritten hat.\n\n'
          + 'JA = für den aktuellen Ladevorgang normale Ladeleistung erlauben.\nNEIN = automatische Begrenzung beibehalten. Fremde Einstellungen bleiben erhalten.'
        : 'Dry-Run: Das Lastmanagement hätte eingegriffen. Es wurden keine Einstellungen an den Wallboxen verändert.\n\nJA = Override in der Simulation. NEIN = Simulation fortsetzen.' },
      behaviorType: 'ACKNOWLEDGEABLE_BY_YES_NO', messageCategory: 'WARN' };
  }
}
