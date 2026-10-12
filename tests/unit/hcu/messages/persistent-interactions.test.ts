import { describe, expect, it, vi } from 'vitest';
import { failure, success, type Result } from '../../../../src/domain/errors.js';
import type { HcuRequester } from '../../../../src/hcu/message-types.js';
import { decodeHcuMessage } from '../../../../src/hcu/message-codec.js';
import { PLUGIN_ID } from '../../../../src/hcu/plugin-identity.js';
import { OverrideInteractionCoordinator } from '../../../../src/hcu/messages/acknowledgement-router.js';
import { validateInteractionDocument, type InteractionDocument, type InteractionStateStore } from '../../../../src/hcu/messages/interaction-state.js';
import { HcuUserMessageService } from '../../../../src/hcu/messages/user-message-service.js';

class MemoryStore implements InteractionStateStore {
  document: InteractionDocument | null = null;
  refuseSave = false;
  refuseLoad = false;
  saved: InteractionDocument[] = [];
  async load(): Promise<Result<InteractionDocument | null>> {
    return this.refuseLoad ? failure('ConfigurationError', 'Store unreadable.') : success(structuredClone(this.document));
  }
  async save(document: InteractionDocument): Promise<Result<void>> {
    if (this.refuseSave) return failure('ConfigurationError', 'Store unwritable.');
    const validated = validateInteractionDocument(document);
    if (!validated.ok) return validated;
    this.document = structuredClone(validated.value);
    this.saved.push(structuredClone(validated.value));
    return success(undefined);
  }
}

function response(type: string, body: Readonly<Record<string, unknown>>) {
  const decoded = decodeHcuMessage({ id: 'response', pluginId: PLUGIN_ID, type, body });
  if (!decoded.ok) return decoded;
  return decoded.value.kind === 'known' ? success(decoded.value.message)
    : failure('InvalidResponseError', 'Unknown mock response.');
}

function fixture(store = new MemoryStore(), remoteMessages = new Map<string, number>(), prefix = 'first') {
  let sequence = 0;
  let offline = false;
  let refuseDelete = false;
  const request = vi.fn<HcuRequester['request']>(async (type, body, responseType) => {
    if (offline) return failure('ConnectionError', 'Mock HCU offline.');
    if (type === 'LIST_USER_MESSAGES_REQUEST') return response('LIST_USER_MESSAGES_RESPONSE',
      { userMessageMap: Object.fromEntries(remoteMessages) });
    const id = body['userMessageId'];
    if (typeof id !== 'string') return failure('ConfigurationError', 'Missing mock ID.');
    if (type === 'CREATE_USER_MESSAGE_REQUEST') remoteMessages.set(id, 1_000);
    if (type === 'DELETE_USER_MESSAGE_REQUEST' && !refuseDelete) remoteMessages.delete(id);
    return response(responseType, { userMessageId: id, success: type !== 'DELETE_USER_MESSAGE_REQUEST' || !refuseDelete });
  });
  const nextId = vi.fn(() => `${prefix}-${++sequence}`);
  const onYes = vi.fn<() => void>();
  const onAnswer = vi.fn<(id: string, answer: 'YES' | 'NO') => void>();
  const messages = new HcuUserMessageService({ request }, { nextId }, () => 1_000);
  const coordinator = new OverrideInteractionCoordinator({ messages, idProvider: { nextId }, onYes, onAnswer,
    stateStore: store, now: () => 1_000, messageMode: 'INSTALLED_LIVE' });
  const calls = (type: string) => request.mock.calls.filter(([kind]) => kind === type);
  const acknowledge = (answer: 'YES' | 'NO', id = coordinator.openUserMessageId ?? 'missing', pluginId = PLUGIN_ID) =>
    coordinator.handleAcknowledgement({ id: 'ack', pluginId, type: 'USER_MESSAGE_ACK_EVENT',
      body: { userMessageId: id, ackType: answer } });
  return { store, remoteMessages, coordinator, request, nextId, onYes, onAnswer, calls, acknowledge,
    setOffline: (value: boolean) => { offline = value; }, setRefuseDelete: (value: boolean) => { refuseDelete = value; } };
}

describe('persisted installed HCU interactions', () => {
  it('lists plugin messages on first startup even without a prior intervention', async () => {
    const f = fixture();
    expect(await f.coordinator.initialize()).toEqual(success(undefined));
    expect(f.calls('LIST_USER_MESSAGES_REQUEST')).toHaveLength(1);
    expect(f.calls('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(0);
    expect(f.store.document?.session).toEqual({ sessionId: 'first-1', interventionRequested: false, overrideActive: false });
  });

  it('can restore local state without HCU I/O and performs startup LIST after reconnect', async () => {
    const f = fixture();
    f.setOffline(true);
    expect(await f.coordinator.initialize({ reconcile: false })).toEqual(success(undefined));
    expect(f.request).not.toHaveBeenCalled();
    expect((await f.coordinator.reconcile()).ok).toBe(false);
    f.setOffline(false);
    expect((await f.coordinator.reconcile()).ok).toBe(true);
    expect(f.calls('LIST_USER_MESSAGES_REQUEST')).toHaveLength(2);
  });

  it('requires initialization and never creates a question without durable session state', async () => {
    const f = fixture();
    expect((await f.coordinator.requestIntervention()).ok).toBe(false);
    expect(f.request).not.toHaveBeenCalled();
  });

  it('persists ID, explicit session, purpose, timestamp and OPEN state before sending CREATE', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    f.request.mockImplementationOnce(async (_type, body, responseType) => {
      expect(f.store.document?.messages).toContainEqual({ userMessageId: 'first-2', sessionId: 'first-1',
        messagePurpose: 'LIVE_INTERVENTION', createdAt: 1_000, state: 'OPEN', answer: null });
      f.remoteMessages.set('first-2', 1_000);
      return response(responseType, { success: true, userMessageId: body['userMessageId'] });
    });
    expect((await f.coordinator.requestIntervention()).ok).toBe(true);
    const input = f.calls('CREATE_USER_MESSAGE_REQUEST')[0]?.[1];
    expect(input?.['title']).toEqual({ de: 'go-e Lastmanagement', en: 'go-e load management' });
    expect(JSON.stringify(input)).not.toMatch(/TEST|Dry.Run|Hypothetical/u);
  });

  it('recognizes the same open message after shutdown/restart without duplicate CREATE or DELETE', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    await f.coordinator.requestIntervention();
    expect((await f.coordinator.shutdown()).ok).toBe(true);
    expect(f.calls('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(0);
    const next = fixture(f.store, f.remoteMessages, 'second');
    expect((await next.coordinator.initialize()).ok).toBe(true);
    expect(next.coordinator.openUserMessageId).toBe('first-2');
    await next.coordinator.requestIntervention();
    expect(next.calls('LIST_USER_MESSAGES_REQUEST')).toHaveLength(1);
    expect(next.calls('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(0);
    expect(next.calls('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(0);
  });

  it('recreates a known missing open question using its original ID', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    await f.coordinator.requestIntervention();
    f.remoteMessages.clear();
    const next = fixture(f.store, f.remoteMessages, 'second');
    expect((await next.coordinator.initialize()).ok).toBe(true);
    expect(next.calls('CREATE_USER_MESSAGE_REQUEST').map((call) => call[1]['userMessageId'])).toEqual(['first-2']);
    expect(next.nextId).not.toHaveBeenCalled();
  });

  it('persisted NO is complete across restart and does not create another question in the session', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    await f.coordinator.requestIntervention();
    expect(await f.acknowledge('NO')).toBe(true);
    const next = fixture(f.store, f.remoteMessages, 'second');
    await next.coordinator.initialize();
    await next.coordinator.requestIntervention();
    expect(next.coordinator.openUserMessageId).toBe(null);
    expect(next.calls('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(0);
    expect(next.onYes).not.toHaveBeenCalled();
    expect(next.coordinator.lastAnswer).toBe('NO (first-2)');
  });

  it('restores a persisted YES override before any HCU connection and only once per process', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    await f.coordinator.requestIntervention();
    await f.acknowledge('YES');
    const next = fixture(f.store, f.remoteMessages, 'second');
    next.setOffline(true);
    expect((await next.coordinator.initialize({ reconcile: false })).ok).toBe(true);
    expect(next.request).not.toHaveBeenCalled();
    expect(next.onYes).toHaveBeenCalledTimes(1);
    await next.coordinator.initialize({ reconcile: false });
    next.setOffline(false);
    await next.coordinator.reconcile();
    expect(next.onYes).toHaveBeenCalledTimes(1);
    await next.coordinator.requestIntervention();
    expect(next.calls('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(0);
  });

  it('explicit endSession clears persisted override and permits exactly one new question', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    await f.coordinator.requestIntervention();
    await f.acknowledge('YES');
    await f.coordinator.endSession();
    expect(f.store.document?.session).toEqual({ sessionId: 'first-3', interventionRequested: false, overrideActive: false });
    await f.coordinator.requestIntervention();
    expect(f.coordinator.openUserMessageId).toBe('first-4');
    const next = fixture(f.store, f.remoteMessages, 'second');
    await next.coordinator.initialize({ reconcile: false });
    expect(next.onYes).not.toHaveBeenCalled();
  });

  it('cleans plugin-scoped legacy TEST/orphan IDs at startup once and keeps the current question', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    await f.coordinator.requestIntervention();
    f.remoteMessages.set('old-development-test', 500);
    const next = fixture(f.store, f.remoteMessages, 'second');
    await next.coordinator.initialize();
    await next.coordinator.reconcile();
    await next.coordinator.initialize();
    expect(next.calls('DELETE_USER_MESSAGE_REQUEST').map((call) => call[1]['userMessageId'])).toEqual(['old-development-test']);
    expect([...f.remoteMessages.keys()]).toEqual(['first-2']);
    expect(next.store.document?.messages).toContainEqual({ userMessageId: 'old-development-test', sessionId: 'first-1',
      messagePurpose: 'LEGACY_PLUGIN_MESSAGE', createdAt: 500, state: 'DELETED', answer: null });
  });

  it('never derives deletion targets from unknown or foreign ACKs', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    await f.coordinator.requestIntervention();
    expect(await f.acknowledge('YES', 'foreign-id')).toBe(false);
    expect(await f.coordinator.handleAcknowledgement({ id: 'r', pluginId: 'foreign.plugin',
      type: 'USER_MESSAGE_ACK_EVENT', body: { userMessageId: 'first-2', ackType: 'YES' } })).toBe(false);
    expect(f.onYes).not.toHaveBeenCalled();
    expect(f.calls('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(0);
  });

  it('cleans a known persisted TEST question without treating it as a productive session or override', async () => {
    const f = fixture();
    f.store.document = { version: 1, pluginId: PLUGIN_ID,
      session: { sessionId: 'test-session', interventionRequested: true, overrideActive: false },
      messages: [{ userMessageId: 'known-test', sessionId: 'test-session', messagePurpose: 'TEST_INTERVENTION',
        createdAt: 100, state: 'OPEN', answer: null }] };
    f.remoteMessages.set('known-test', 100);
    await f.coordinator.initialize();
    await f.coordinator.reconcile();
    expect(f.calls('DELETE_USER_MESSAGE_REQUEST').map((call) => call[1]['userMessageId'])).toEqual(['known-test']);
    expect(f.calls('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(0);
    expect(f.coordinator.openUserMessageId).toBe(null);
    expect(f.onYes).not.toHaveBeenCalled();
    await f.coordinator.requestIntervention();
    expect(f.calls('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(1);
    expect(f.store.document?.session.sessionId).not.toBe('test-session');
  });

  it('a historic TEST YES never restores a real hardware override in installed mode', async () => {
    const f = fixture();
    f.store.document = { version: 1, pluginId: PLUGIN_ID,
      session: { sessionId: 'test-session', interventionRequested: true, overrideActive: true },
      messages: [{ userMessageId: 'known-test', sessionId: 'test-session', messagePurpose: 'TEST_INTERVENTION',
        createdAt: 100, state: 'DELETED', answer: 'YES' }] };
    await f.coordinator.initialize({ reconcile: false });
    expect(f.onYes).not.toHaveBeenCalled();
    expect(f.store.document?.session.overrideActive).toBe(false);
  });

  it('explicit session end during a delayed ACK save prevents applying that YES to the next session', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    await f.coordinator.requestIntervention();
    const originalSave = f.store.save.bind(f.store);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const save = vi.spyOn(f.store, 'save').mockImplementationOnce(async (document) => {
      await gate;
      return originalSave(document);
    });
    const answering = f.acknowledge('YES');
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const ending = f.coordinator.endSession();
    release?.();
    expect(await answering).toBe(false);
    await ending;
    expect(f.onYes).not.toHaveBeenCalled();
    expect(f.store.document?.session.overrideActive).toBe(false);
    expect(f.store.document?.session.interventionRequested).toBe(false);
  });

  it('shutdown during a delayed ACK save never applies new in-process override or sends cleanup', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    await f.coordinator.requestIntervention();
    const originalSave = f.store.save.bind(f.store);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const save = vi.spyOn(f.store, 'save').mockImplementationOnce(async (document) => {
      await gate;
      return originalSave(document);
    });
    const answering = f.acknowledge('YES');
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const stopping = f.coordinator.shutdown();
    release?.();
    expect(await answering).toBe(false);
    expect((await stopping).ok).toBe(true);
    expect(f.onYes).not.toHaveBeenCalled();
    expect(f.calls('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(0);
  });

  it('startup LIST completing after an accepted ACK cannot resurrect the resolved question', async () => {
    const f = fixture();
    await f.coordinator.initialize({ reconcile: false });
    await f.coordinator.requestIntervention();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.request.mockImplementationOnce(async () => {
      await gate;
      return response('LIST_USER_MESSAGES_RESPONSE', { userMessageMap: {} });
    });
    const listing = f.coordinator.reconcile();
    await vi.waitFor(() => expect(f.calls('LIST_USER_MESSAGES_REQUEST')).toHaveLength(1));
    expect(await f.acknowledge('YES')).toBe(true);
    release?.();
    expect((await listing).ok).toBe(true);
    expect(f.calls('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(1);
    expect(f.remoteMessages.size).toBe(0);
    expect(f.onYes).toHaveBeenCalledTimes(1);
  });

  it('durably resolves matching family YES once even when duplicate ACKs race', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    await f.coordinator.requestIntervention();
    const [first, duplicate] = await Promise.all([f.acknowledge('YES'), f.acknowledge('YES')]);
    expect([first, duplicate]).toEqual([true, false]);
    expect(f.onYes).toHaveBeenCalledTimes(1);
    expect(f.store.document?.session.overrideActive).toBe(true);
    expect(f.calls('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(1);
  });

  it('does not apply override or delete when ACK persistence fails; a later ACK can retry safely', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    await f.coordinator.requestIntervention();
    f.store.refuseSave = true;
    expect(await f.acknowledge('YES')).toBe(false);
    expect(f.onYes).not.toHaveBeenCalled();
    expect(f.calls('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(0);
    expect(f.coordinator.persistenceError).not.toBe(null);
    f.store.refuseSave = false;
    expect(await f.acknowledge('YES')).toBe(true);
    expect(f.onYes).toHaveBeenCalledTimes(1);
  });

  it('blocks CREATE when the pending interaction cannot be persisted and later reuses that same ID', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    f.store.refuseSave = true;
    expect((await f.coordinator.requestIntervention()).ok).toBe(false);
    expect(f.calls('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(0);
    f.store.refuseSave = false;
    expect((await f.coordinator.reconcile()).ok).toBe(true);
    expect(f.calls('CREATE_USER_MESSAGE_REQUEST').map((call) => call[1]['userMessageId'])).toEqual(['first-2']);
  });

  it('retains answered cleanup intent across restart when DELETE failed', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    await f.coordinator.requestIntervention();
    f.setRefuseDelete(true);
    await f.acknowledge('NO');
    expect(f.store.document?.messages[0]?.state).toBe('ANSWERED');
    const next = fixture(f.store, f.remoteMessages, 'second');
    await next.coordinator.initialize();
    await next.coordinator.reconcile();
    expect(next.calls('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(1);
    expect(next.calls('CREATE_USER_MESSAGE_REQUEST')).toHaveLength(0);
  });

  it('does not loop on refused orphan DELETE; one retry requires another explicit reconcile', async () => {
    const f = fixture();
    f.remoteMessages.set('legacy-test', 100);
    f.setRefuseDelete(true);
    await f.coordinator.initialize();
    expect(f.calls('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(1);
    await f.coordinator.reconcile();
    expect(f.calls('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(2);
    f.setRefuseDelete(false);
    await f.coordinator.reconcile();
    await f.coordinator.reconcile();
    expect(f.calls('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(3);
  });

  it('does not delete active warnings that were created after startup', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    f.remoteMessages.set('new-active-warning', 2_000);
    await f.coordinator.reconcile();
    expect(f.calls('DELETE_USER_MESSAGE_REQUEST')).toHaveLength(0);
  });

  it('contains load/save exceptions and never overwrites unreadable existing state on shutdown', async () => {
    const f = fixture();
    f.store.refuseLoad = true;
    expect((await f.coordinator.initialize()).ok).toBe(false);
    expect((await f.coordinator.shutdown()).ok).toBe(false);
    expect(f.store.saved).toHaveLength(0);
    expect(f.request).not.toHaveBeenCalled();
  });

  it('corrupt identity/state prevents LIST cleanup and question creation', async () => {
    const f = fixture();
    f.store.document = { version: 1, pluginId: 'foreign.plugin', session: { sessionId: 'x',
      interventionRequested: false, overrideActive: false }, messages: [] } as unknown as InteractionDocument;
    expect((await f.coordinator.initialize()).ok).toBe(false);
    expect(f.request).not.toHaveBeenCalled();
    expect((await f.coordinator.requestIntervention()).ok).toBe(false);
  });

  it('after shutdown refuses new questions/ACKs and reconcile does no HCU I/O', async () => {
    const f = fixture();
    await f.coordinator.initialize();
    await f.coordinator.requestIntervention();
    await f.coordinator.shutdown();
    f.request.mockClear();
    expect((await f.coordinator.requestIntervention()).ok).toBe(false);
    expect(await f.acknowledge('YES')).toBe(false);
    await f.coordinator.reconcile();
    await f.coordinator.endSession();
    expect(f.request).not.toHaveBeenCalled();
  });
});
