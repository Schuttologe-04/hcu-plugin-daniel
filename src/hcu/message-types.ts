import type { Result } from '../domain/errors.js';

/** Connect API 1.0.1 PluginMessage envelope. Bodies depend on the message type. */
export interface HcuEnvelope {
  readonly pluginId: string;
  readonly id: string;
  readonly type: string;
  readonly body?: Readonly<Record<string, unknown>>;
}

export type HcuConnectionState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'READY'
  | 'RECONNECTING'
  | 'STOPPED';

export type PluginReadinessStatus = 'READY' | 'CONFIG_REQUIRED' | 'ERROR';
export type HcuAcknowledgementType = 'YES' | 'NO' | 'OK';

/** Error.message is optional in the authoritative section 6.5.2. */
export interface HcuProtocolError {
  readonly code: string;
  readonly message?: string;
}

type Message<T extends string, Body extends Readonly<Record<string, unknown>>> = {
  readonly pluginId: string;
  readonly id: string;
  readonly type: T;
  readonly body: Body;
};

export type PluginStateRequest = Message<'PLUGIN_STATE_REQUEST', Readonly<Record<string, unknown>>>;
export type ConfigTemplateRequest = Message<'CONFIG_TEMPLATE_REQUEST', {
  readonly languageCode?: string;
}>;
export type ConfigUpdateRequest = Message<'CONFIG_UPDATE_REQUEST', {
  readonly languageCode?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
}>;
export type UserMessageAcknowledgementEvent = Message<'USER_MESSAGE_ACK_EVENT', {
  readonly ackType: HcuAcknowledgementType;
  readonly userMessageId: string;
}>;
export type CreateUserMessageResponse = Message<'CREATE_USER_MESSAGE_RESPONSE', {
  readonly success: boolean;
  readonly userMessageId: string;
  readonly error?: HcuProtocolError;
}>;
export type DeleteUserMessageResponse = Message<'DELETE_USER_MESSAGE_RESPONSE', {
  readonly success: boolean;
  readonly userMessageId: string;
  readonly error?: HcuProtocolError;
}>;
export type ListUserMessagesResponse = Message<'LIST_USER_MESSAGES_RESPONSE', {
  readonly userMessageMap: Readonly<Record<string, number>>;
}>;
export type HcuErrorResponse = Message<'ERROR_RESPONSE', {
  readonly error: HcuProtocolError;
  /** Arbitrary JSON; the API even illustrates an original malformed string. Never log it. */
  readonly originalMessage: unknown;
}>;

export type IncomingHcuMessage =
  | PluginStateRequest
  | ConfigTemplateRequest
  | ConfigUpdateRequest
  | UserMessageAcknowledgementEvent
  | CreateUserMessageResponse
  | DeleteUserMessageResponse
  | ListUserMessagesResponse
  | HcuErrorResponse;

export interface HcuSender {
  readonly pluginId: string;
  send(message: HcuEnvelope): boolean;
}

export interface HcuRequester extends HcuSender {
  readonly state: HcuConnectionState;
  request(type: string, body: Readonly<Record<string, unknown>>, responseType: string): Promise<Result<IncomingHcuMessage>>;
  onMessage(listener: (message: IncomingHcuMessage) => void | Promise<void>): () => void;
  onState(listener: (state: HcuConnectionState) => void): () => void;
}
