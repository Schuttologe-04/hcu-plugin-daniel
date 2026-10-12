import { describe, expect, it, vi } from 'vitest';
import { failure, success, type Result } from '../../../../src/domain/errors.js';
import { decodeHcuMessage } from '../../../../src/hcu/message-codec.js';
import type { HcuRequester, IncomingHcuMessage } from '../../../../src/hcu/message-types.js';
import { OverrideInteractionCoordinator } from '../../../../src/hcu/messages/acknowledgement-router.js';
import { HcuUserMessageService } from '../../../../src/hcu/messages/user-message-service.js';

function decoded(type: string, body: Readonly<Record<string, unknown>>): Result<IncomingHcuMessage> {
  const result = decodeHcuMessage({ id: 'request-1', pluginId: 'test.plugin', type, body });
  if (!result.ok) return result;
  return result.value.kind === 'known' ? success(result.value.message)
    : failure('InvalidResponseError', 'Unexpected test type.');
}

function ack(userMessageId: string, ackType: 'YES' | 'NO' | 'OK'): IncomingHcuMessage {
  return { id: 'ack-1', pluginId: 'test.plugin', type: 'USER_MESSAGE_ACK_EVENT', body: { userMessageId, ackType } };
}

function fixture() {
  let sequence = 0;
  let offline = false;
  let refuseDeletion = false;
  const remoteMessages = new Map<string, number>();
  const request = vi.fn<HcuRequester['request']>(async (type, body, responseType) => {
    if (offline) return failure('ConnectionError', 'HCU offline.');
    if (type === 'LIST_USER_MESSAGES_REQUEST') return decoded(responseType, { userMessageMap: Object.fromEntries(remoteMessages) });
    const id = body['userMessageId'];
    if (typeof id !== 'string') return failure('ConfigurationError', 'Missing test ID.');
    if (type === 'CREATE_USER_MESSAGE_REQUEST') {
      remoteMessages.set(id, 1000);
      return decoded(responseType, { success: true, userMessageId: id });
    }
    if (type === 'DELETE_USER_MESSAGE_REQUEST') {
      if (!refuseDeletion) remoteMessages.delete(id);
      return decoded(responseType, { success: !refuseDeletion, userMessageId: id });
    }
    return failure('InvalidResponseError', 'Unexpected test request.');
  });
  const nextId = vi.fn(() => `intervention-${++sequence}`);
  const onYes = vi.fn<() => void>();
  const onAnswer = vi.fn<(id: string, answer: 'YES' | 'NO') => void>();
  const messages = new HcuUserMessageService({ request }, { nextId }, () => 1000);
  const coordinator = new OverrideInteractionCoordinator({ messages, idProvider: { nextId }, onYes, onAnswer });
  const createCalls = () => request.mock.calls.filter(([type]) => type === 'CREATE_USER_MESSAGE_REQUEST');
  return {
    coordinator, request, nextId, onYes, onAnswer, createCalls, remoteMessages,
    setOffline: (value: boolean) => { offline = value; },
    setRefuseDeletion: (value: boolean) => { refuseDeletion = value; },
  };
}

describe('OverrideInteractionCoordinator', () => {
  it('creates exactly one TEST YES/NO question for the first simulated intervention', async () => {
    const f = fixture();
    expect(await f.coordinator.requestIntervention()).toEqual(success(undefined));
    expect(f.createCalls()).toHaveLength(1);
    expect(f.createCalls()[0]?.[1]).toMatchObject({
      userMessageId: 'intervention-1', behaviorType: 'ACKNOWLEDGEABLE_BY_YES_NO', messageCategory: 'WARN',
      title: { de: 'TEST: go-e Lastmanagement' },
    });
    const message = f.createCalls()[0]?.[1]['message'];
    expect(message).toMatchObject({ de: expect.stringContaining('Es wurden keine Einstellungen an den Wallboxen verändert.') });
    expect(f.coordinator.openUserMessageId).toBe('intervention-1');
  });

  it('deduplicates subsequent steps and concurrent intervention requests', async () => {
    const f = fixture();
    await Promise.all([f.coordinator.requestIntervention(), f.coordinator.requestIntervention()]);
    await f.coordinator.requestIntervention();
    expect(f.createCalls()).toHaveLength(1);
    expect(f.nextId).toHaveBeenCalledTimes(1);
  });

  it('applies YES once to the matching question and deletes it', async () => {
    const f = fixture();
    await f.coordinator.requestIntervention();
    expect(await f.coordinator.handleAcknowledgement(ack('intervention-1', 'YES'))).toBe(true);
    expect(f.onYes).toHaveBeenCalledTimes(1);
    expect(f.onAnswer).toHaveBeenCalledWith('intervention-1', 'YES');
    expect(f.remoteMessages.size).toBe(0);
    expect(f.coordinator.openUserMessageId).toBe(null);
    expect(f.coordinator.lastAnswer).toBe('YES (intervention-1)');
  });

  it('NO continues automatic simulation and deletes the question', async () => {
    const f = fixture();
    await f.coordinator.requestIntervention();
    expect(await f.coordinator.handleAcknowledgement(ack('intervention-1', 'NO'))).toBe(true);
    expect(f.onYes).not.toHaveBeenCalled();
    expect(f.onAnswer).toHaveBeenCalledWith('intervention-1', 'NO');
    expect(f.remoteMessages.size).toBe(0);
  });

  it('no response never implies override', async () => {
    const f = fixture();
    await f.coordinator.requestIntervention();
    await f.coordinator.reconcile();
    expect(f.onYes).not.toHaveBeenCalled();
    expect(f.coordinator.lastAnswer).toBe(null);
  });

  it.each(['YES', 'NO'] as const)('ignores unknown ID with %s', async (answer) => {
    const f = fixture();
    await f.coordinator.requestIntervention();
    expect(await f.coordinator.handleAcknowledgement(ack('unknown', answer))).toBe(false);
    expect(f.onYes).not.toHaveBeenCalled();
    expect(f.onAnswer).not.toHaveBeenCalled();
    expect(f.coordinator.openUserMessageId).toBe('intervention-1');
  });

  it('ignores OK on a YES/NO question', async () => {
    const f = fixture();
    await f.coordinator.requestIntervention();
    expect(await f.coordinator.handleAcknowledgement(ack('intervention-1', 'OK'))).toBe(false);
    expect(f.onYes).not.toHaveBeenCalled();
  });

  it('ignores duplicate or conflicting acknowledgements before cleanup completes', async () => {
    const f = fixture();
    await f.coordinator.requestIntervention();
    const accepted = f.coordinator.handleAcknowledgement(ack('intervention-1', 'YES'));
    expect(await f.coordinator.handleAcknowledgement(ack('intervention-1', 'NO'))).toBe(false);
    expect(await f.coordinator.handleAcknowledgement(ack('intervention-1', 'YES'))).toBe(false);
    expect(await accepted).toBe(true);
    expect(f.onYes).toHaveBeenCalledTimes(1);
    expect(f.onAnswer).toHaveBeenCalledTimes(1);
  });

  it('does not create another question after a NO response within the same session', async () => {
    const f = fixture();
    await f.coordinator.requestIntervention();
    await f.coordinator.handleAcknowledgement(ack('intervention-1', 'NO'));
    await f.coordinator.requestIntervention();
    await f.coordinator.reconcile();
    expect(f.createCalls()).toHaveLength(1);
  });

  it('reconciles an existing open message without another create on reconnect', async () => {
    const f = fixture();
    await f.coordinator.requestIntervention();
    f.setOffline(true);
    expect((await f.coordinator.reconcile()).ok).toBe(false);
    f.setOffline(false);
    await Promise.all([f.coordinator.reconcile(), f.coordinator.reconcile()]);
    expect(f.createCalls()).toHaveLength(1);
    expect(f.nextId).toHaveBeenCalledTimes(1);
  });

  it('restores a missing known message using the SAME ID, as documented replacement', async () => {
    const f = fixture();
    await f.coordinator.requestIntervention();
    f.remoteMessages.clear();
    await f.coordinator.reconcile();
    expect(f.createCalls()).toHaveLength(2);
    expect(f.createCalls().map((call) => call[1]['userMessageId'])).toEqual(['intervention-1', 'intervention-1']);
    expect(f.nextId).toHaveBeenCalledTimes(1);
    expect(f.remoteMessages.size).toBe(1);
  });

  it('retains the same ID after an offline create and retries only on reconnect reconciliation', async () => {
    const f = fixture();
    f.setOffline(true);
    expect((await f.coordinator.requestIntervention()).ok).toBe(false);
    await f.coordinator.requestIntervention();
    expect(f.createCalls()).toHaveLength(1);
    expect(f.onYes).not.toHaveBeenCalled();
    f.setOffline(false);
    expect((await f.coordinator.reconcile()).ok).toBe(true);
    expect(f.createCalls()).toHaveLength(2);
    expect(f.nextId).toHaveBeenCalledTimes(1);
  });

  it('an uncertain creation result is reconciled by listing, without duplicate create', async () => {
    const f = fixture();
    f.request.mockImplementationOnce(async (_type, body) => {
      const id = body['userMessageId'];
      if (typeof id === 'string') f.remoteMessages.set(id, 1000);
      return failure('TimeoutError', 'Response lost after HCU accepted create.');
    });
    expect((await f.coordinator.requestIntervention()).ok).toBe(false);
    await f.coordinator.reconcile();
    expect(f.createCalls()).toHaveLength(1);
  });

  it('deferred cleanup failure does not suppress accepted YES and is retried after reconnect', async () => {
    const f = fixture();
    await f.coordinator.requestIntervention();
    f.setRefuseDeletion(true);
    await f.coordinator.handleAcknowledgement(ack('intervention-1', 'YES'));
    expect(f.onYes).toHaveBeenCalledTimes(1);
    expect(f.remoteMessages.size).toBe(1);
    f.setRefuseDeletion(false);
    await f.coordinator.reconcile();
    expect(f.remoteMessages.size).toBe(0);
    expect(f.createCalls()).toHaveLength(1);
  });

  it('marks remote-already-deleted questions complete without creating them again', async () => {
    const f = fixture();
    await f.coordinator.requestIntervention();
    f.setOffline(true);
    await f.coordinator.handleAcknowledgement(ack('intervention-1', 'NO'));
    f.remoteMessages.clear();
    f.setOffline(false);
    await f.coordinator.reconcile();
    expect(f.createCalls()).toHaveLength(1);
  });

  it('explicit endSession clears an open question and permits a new unique ID', async () => {
    const f = fixture();
    await f.coordinator.requestIntervention();
    await f.coordinator.endSession();
    expect(f.remoteMessages.size).toBe(0);
    expect(await f.coordinator.handleAcknowledgement(ack('intervention-1', 'YES'))).toBe(false);
    await f.coordinator.requestIntervention();
    expect(f.coordinator.openUserMessageId).toBe('intervention-2');
    expect(f.createCalls()).toHaveLength(2);
    expect(f.onYes).not.toHaveBeenCalled();
  });

  it('explicit endSession during create cleans up the eventual remote result', async () => {
    const f = fixture();
    const creating = f.coordinator.requestIntervention();
    const ending = f.coordinator.endSession();
    await Promise.all([creating, ending]);
    expect(f.remoteMessages.size).toBe(0);
    expect(f.coordinator.openUserMessageId).toBe(null);
  });

  it('a delayed create from an old session cannot replace or delete the new session question', async () => {
    const f = fixture();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.request.mockImplementationOnce(async (_type, body, responseType) => {
      await gate;
      const id = body['userMessageId'];
      if (typeof id !== 'string') return failure('ConfigurationError', 'Missing test ID.');
      f.remoteMessages.set(id, 1000);
      return decoded(responseType, { success: true, userMessageId: id });
    });
    const oldCreate = f.coordinator.requestIntervention();
    const oldEnd = f.coordinator.endSession();
    expect(await f.coordinator.requestIntervention()).toEqual(success(undefined));
    expect(f.coordinator.openUserMessageId).toBe('intervention-2');
    expect(await f.coordinator.handleAcknowledgement(ack('intervention-1', 'YES'))).toBe(false);
    release?.();
    await Promise.all([oldCreate, oldEnd]);
    expect(f.coordinator.openUserMessageId).toBe('intervention-2');
    expect([...f.remoteMessages.keys()]).toEqual(['intervention-2']);
    expect(f.onYes).not.toHaveBeenCalled();
  });

  it('does not list or create without an actual intervention', async () => {
    const f = fixture();
    await f.coordinator.reconcile();
    expect(f.request).not.toHaveBeenCalled();
    expect(f.coordinator.lastMessage).toBe(null);
  });
});
