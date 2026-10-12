import { failure, success, type Result } from '../../domain/errors.js';
import type { IdProvider } from '../id-provider.js';
import type { HcuRequester, IncomingHcuMessage } from '../message-types.js';

/** Connect API 1.0.1, sections 6.6.2 and 6.6.7; these are protocol values. */
export type UserMessageBehavior =
  | 'ACKNOWLEDGEABLE_BY_YES_NO'
  | 'ACKNOWLEDGEABLE_BY_OK'
  | 'DISMISSIBLE'
  | 'NOT_DISMISSIBLE';

export type UserMessageCategory = 'INFO' | 'WARN' | 'ERROR';

export type LocalizedText = Readonly<Record<string, string>> & { readonly de: string };

export interface CreateUserMessageInput {
  readonly userMessageId?: string;
  readonly title: LocalizedText;
  readonly message: LocalizedText;
  readonly behaviorType: UserMessageBehavior;
  readonly messageCategory: UserMessageCategory;
}

function validText(text: LocalizedText): boolean {
  return typeof text === 'object' && text !== null && !Array.isArray(text)
    && typeof text.de === 'string' && text.de.trim().length > 0
    && Object.entries(text).every(([language, value]) =>
      /^[a-z]{2}$/.test(language) && typeof value === 'string' && value.trim().length > 0);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value === value.trim();
}

/** HCU-only service. It has no device client and cannot execute ControlActions. */
export class HcuUserMessageService {
  constructor(
    private readonly requester: Pick<HcuRequester, 'request'>,
    private readonly idProvider: IdProvider,
    /** Timestamp unit is supplied by the runtime; see docs/hcu-integration.md. */
    private readonly now: () => number,
  ) {}

  async create(input: CreateUserMessageInput): Promise<Result<{ readonly userMessageId: string }>> {
    const behaviors: readonly string[] = [
      'ACKNOWLEDGEABLE_BY_YES_NO', 'ACKNOWLEDGEABLE_BY_OK', 'DISMISSIBLE', 'NOT_DISMISSIBLE',
    ];
    if (!validText(input.title) || !validText(input.message)
      || !behaviors.includes(input.behaviorType)
      || !['INFO', 'WARN', 'ERROR'].includes(input.messageCategory)) {
      return failure('ConfigurationError', 'Invalid HCU user message input.');
    }
    let userMessageId: string;
    let timestamp: number;
    try {
      userMessageId = input.userMessageId ?? this.idProvider.nextId();
      timestamp = this.now();
    } catch {
      return failure('ConfigurationError', 'HCU message ID or timestamp provider failed.');
    }
    if (!validId(userMessageId) || !Number.isSafeInteger(timestamp) || timestamp < 0) {
      return failure('ConfigurationError', 'Invalid HCU user message ID or timestamp.');
    }
    const response = await this.request('CREATE_USER_MESSAGE_REQUEST', {
      userMessageId,
      title: { ...input.title },
      message: { ...input.message },
      behaviorType: input.behaviorType,
      messageCategory: input.messageCategory,
      timestamp,
    }, 'CREATE_USER_MESSAGE_RESPONSE');
    if (!response.ok) return response;
    if (response.value.type !== 'CREATE_USER_MESSAGE_RESPONSE') {
      return failure('InvalidResponseError', 'Invalid HCU create-user-message response.');
    }
    const body = response.value.body;
    if (typeof body.success !== 'boolean' || body.userMessageId !== userMessageId) {
      return failure('InvalidResponseError', 'Invalid HCU create-user-message response.');
    }
    if (!body.success) {
      return failure('InvalidResponseError', 'HCU rejected the user message.');
    }
    return success({ userMessageId });
  }

  async delete(userMessageId: string): Promise<Result<void>> {
    if (!validId(userMessageId)) {
      return failure('ConfigurationError', 'Invalid HCU user message ID.');
    }
    const response = await this.request('DELETE_USER_MESSAGE_REQUEST', {
      userMessageId,
    }, 'DELETE_USER_MESSAGE_RESPONSE');
    if (!response.ok) return response;
    if (response.value.type !== 'DELETE_USER_MESSAGE_RESPONSE') {
      return failure('InvalidResponseError', 'Invalid HCU delete-user-message response.');
    }
    const body = response.value.body;
    if (typeof body.success !== 'boolean' || body.userMessageId !== userMessageId) {
      return failure('InvalidResponseError', 'Invalid HCU delete-user-message response.');
    }
    return body.success ? success(undefined)
      : failure('InvalidResponseError', 'HCU could not delete the user message.');
  }

  async list(): Promise<Result<Readonly<Record<string, number>>>> {
    const response = await this.request('LIST_USER_MESSAGES_REQUEST', {}, 'LIST_USER_MESSAGES_RESPONSE');
    if (!response.ok) return response;
    if (response.value.type !== 'LIST_USER_MESSAGES_RESPONSE') {
      return failure('InvalidResponseError', 'Invalid HCU user-message map.');
    }
    const map = response.value.body.userMessageMap;
    if (typeof map !== 'object' || map === null || Array.isArray(map)) {
      return failure('InvalidResponseError', 'Invalid HCU user-message map.');
    }
    // The field table specifies Map<String, Long>; the HTML example is inconsistent.
    const entries: [string, number][] = [];
    for (const [id, timestamp] of Object.entries(map)) {
      if (!validId(id) || typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp)
        || timestamp < 0) {
        return failure('InvalidResponseError', 'Invalid HCU user-message map entry.');
      }
      entries.push([id, timestamp]);
    }
    return success(Object.freeze(Object.fromEntries(entries)));
  }

  private async request(
    type: string,
    body: Readonly<Record<string, unknown>>,
    responseType: string,
  ): Promise<Result<IncomingHcuMessage>> {
    try {
      return await this.requester.request(type, body, responseType);
    } catch {
      return failure('ConnectionError', 'HCU user-message request failed.');
    }
  }
}
