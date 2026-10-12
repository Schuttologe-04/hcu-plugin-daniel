import { failure, success, type Result } from '../../domain/errors.js';
import { PLUGIN_ID } from '../plugin-identity.js';

export type InteractionPurpose = 'LIVE_INTERVENTION' | 'TEST_INTERVENTION' | 'LEGACY_PLUGIN_MESSAGE';
export type PersistedInteractionState = 'OPEN' | 'ANSWERED' | 'STALE' | 'DELETED';

export interface PersistedInteraction {
  readonly userMessageId: string;
  readonly sessionId: string;
  readonly messagePurpose: InteractionPurpose;
  readonly createdAt: number;
  readonly state: PersistedInteractionState;
  readonly answer: 'YES' | 'NO' | null;
}

export interface InteractionDocument {
  readonly version: 1;
  readonly pluginId: typeof PLUGIN_ID;
  readonly session: {
    readonly sessionId: string;
    readonly interventionRequested: boolean;
    readonly overrideActive: boolean;
  };
  readonly messages: readonly PersistedInteraction[];
}

export interface InteractionStateStore {
  load(): Promise<Result<InteractionDocument | null>>;
  save(document: InteractionDocument): Promise<Result<void>>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
}

/** A strict projection prevents credentials and arbitrary HCU payloads entering persistence. */
export function validateInteractionDocument(input: unknown): Result<InteractionDocument> {
  if (!record(input) || input['version'] !== 1 || input['pluginId'] !== PLUGIN_ID
    || !record(input['session']) || !Array.isArray(input['messages']) || input['messages'].length > 100) {
    return failure('ConfigurationError', 'Invalid persisted HCU interaction document.');
  }
  const session = input['session'];
  if (!validId(session['sessionId']) || typeof session['interventionRequested'] !== 'boolean'
    || typeof session['overrideActive'] !== 'boolean'
    || (session['overrideActive'] && !session['interventionRequested'])) {
    return failure('ConfigurationError', 'Invalid persisted HCU interaction session.');
  }
  const messages: PersistedInteraction[] = [];
  const ids = new Set<string>();
  let currentOpen = 0;
  for (const item of input['messages'] as readonly unknown[]) {
    if (!record(item) || !validId(item['userMessageId']) || !validId(item['sessionId'])
      || typeof item['createdAt'] !== 'number' || !Number.isSafeInteger(item['createdAt']) || item['createdAt'] < 0
      || typeof item['messagePurpose'] !== 'string'
      || !['LIVE_INTERVENTION', 'TEST_INTERVENTION', 'LEGACY_PLUGIN_MESSAGE'].includes(item['messagePurpose'])
      || typeof item['state'] !== 'string' || !['OPEN', 'ANSWERED', 'STALE', 'DELETED'].includes(item['state'])
      || (item['answer'] !== null && item['answer'] !== 'YES' && item['answer'] !== 'NO')
      || ids.has(item['userMessageId'])
      || (item['state'] === 'ANSWERED' && item['answer'] === null)
      || (item['state'] === 'OPEN' && item['answer'] !== null)) {
      return failure('ConfigurationError', 'Invalid persisted HCU interaction entry.');
    }
    ids.add(item['userMessageId']);
    if (item['state'] === 'OPEN' && item['sessionId'] === session['sessionId']) currentOpen += 1;
    messages.push({
      userMessageId: item['userMessageId'], sessionId: item['sessionId'],
      messagePurpose: item['messagePurpose'] as InteractionPurpose, createdAt: item['createdAt'],
      state: item['state'] as PersistedInteractionState, answer: item['answer'],
    });
  }
  const affirmativeEvidence = messages.some((entry) => entry.sessionId === session['sessionId']
    && entry.answer === 'YES' && (entry.state === 'ANSWERED' || entry.state === 'DELETED'));
  const currentQuestionCount = messages.filter((entry) => entry.sessionId === session['sessionId']
    && entry.messagePurpose !== 'LEGACY_PLUGIN_MESSAGE').length;
  if (currentOpen > 1 || (currentOpen === 1 && (!session['interventionRequested'] || session['overrideActive']))
    || currentQuestionCount > 1 || (session['overrideActive'] && !affirmativeEvidence)) {
    return failure('ConfigurationError', 'Contradictory persisted HCU interaction state.');
  }
  return success({
    version: 1, pluginId: PLUGIN_ID,
    session: {
      sessionId: session['sessionId'], interventionRequested: session['interventionRequested'],
      overrideActive: session['overrideActive'],
    }, messages,
  });
}
