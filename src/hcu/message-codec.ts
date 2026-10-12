import { failure, success, type Result } from '../domain/errors.js';
import type { ControlRequestFeature, HcuEnvelope, HcuProtocolError, IncomingHcuMessage } from './message-types.js';

export type DecodedHcuMessage =
  | { readonly kind: 'known'; readonly message: IncomingHcuMessage }
  | { readonly kind: 'ignored'; readonly messageType: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function optionalLanguage(body: Record<string, unknown>): boolean {
  return body['languageCode'] === undefined || typeof body['languageCode'] === 'string';
}

function protocolError(value: unknown): value is HcuProtocolError {
  return record(value) && nonEmptyString(value['code'])
    && (value['message'] === undefined || typeof value['message'] === 'string');
}

// These bounds protect the read-only dispatcher from oversized collections.
// Device IDs are opaque strings in Connect API 1.0.1, not necessarily UUIDs.
const MAX_DEVICE_IDS = 256;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_CONTROL_FEATURES = 128;

function deviceIdentifier(value: unknown): value is string {
  return nonEmptyString(value) && value.length <= MAX_IDENTIFIER_LENGTH;
}

function deviceIds(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_DEVICE_IDS) return undefined;
  const validated = new Set<string>();
  for (const candidate of value) {
    if (!deviceIdentifier(candidate)) return undefined;
    validated.add(candidate);
  }
  return [...validated];
}

function controlFeatures(value: unknown): readonly ControlRequestFeature[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_CONTROL_FEATURES) return undefined;
  const validated: ControlRequestFeature[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!record(candidate) || !nonEmptyString(candidate['type'])
      || candidate['type'].length > MAX_IDENTIFIER_LENGTH || seen.has(candidate['type'])) return undefined;
    const type = candidate['type'];
    seen.add(type);
    if (type === 'currentPower') {
      const currentPower = candidate['currentPower'];
      // The feature is required by energy devices, but its Double value is optional.
      if (currentPower !== undefined && (typeof currentPower !== 'number' || !Number.isFinite(currentPower))) return undefined;
      validated.push({ type, ...(currentPower === undefined ? {} : { currentPower }) });
    } else if (type === 'maintenance') {
      const unreach = candidate['unreach'];
      const lowBat = candidate['lowBat'];
      const sabotage = candidate['sabotage'];
      if ([unreach, lowBat, sabotage].some((field) => field !== undefined && typeof field !== 'boolean')) return undefined;
      validated.push({ type,
        ...(typeof unreach === 'boolean' ? { unreach } : {}),
        ...(typeof lowBat === 'boolean' ? { lowBat } : {}),
        ...(typeof sabotage === 'boolean' ? { sabotage } : {}),
      });
    } else {
      // The sensor service rejects control even for future features. Retain only
      // their discriminator so unknown target values cannot become a write path.
      validated.push({ type });
    }
  }
  return validated;
}

function invalid(): Result<never> {
  // The reason is deliberately independent of the untrusted payload.
  return failure('InvalidResponseError', 'HCU message does not match the Connect API schema.');
}

/** The string form and already-decoded values both enter as unknown and are validated. */
export function decodeHcuMessage(input: unknown): Result<DecodedHcuMessage> {
  let payload: unknown = input;
  if (typeof input === 'string') {
    try {
      payload = JSON.parse(input) as unknown;
    } catch {
      return failure('InvalidResponseError', 'HCU message is not valid JSON.');
    }
  }
  if (!record(payload) || !nonEmptyString(payload['id']) || !nonEmptyString(payload['pluginId'])
    || !nonEmptyString(payload['type'])) return invalid();
  const id = payload['id'];
  const pluginId = payload['pluginId'];
  const type = payload['type'];
  const suppliedBody = payload['body'];
  if (suppliedBody !== undefined && !record(suppliedBody)) return invalid();
  // PluginMessage.body is optional. Required body fields below still must exist.
  const body = suppliedBody ?? {};
  const base = { id, pluginId };
  let message: IncomingHcuMessage;
  switch (type) {
    case 'PLUGIN_STATE_REQUEST':
      message = { ...base, type, body: {} };
      break;
    case 'DISCOVER_REQUEST':
      message = { ...base, type, body: {} };
      break;
    case 'INCLUSION_EVENT':
    case 'EXCLUSION_EVENT': {
      const identifiers = deviceIds(body['deviceIds']);
      if (identifiers === undefined) return invalid();
      message = { ...base, type, body: { deviceIds: identifiers } };
      break;
    }
    case 'STATUS_REQUEST': {
      if (body['deviceIds'] === undefined) {
        message = { ...base, type, body: {} };
      } else {
        const identifiers = deviceIds(body['deviceIds']);
        if (identifiers === undefined) return invalid();
        message = { ...base, type, body: { deviceIds: identifiers } };
      }
      break;
    }
    case 'CONTROL_REQUEST': {
      const deviceId = body['deviceId'];
      const features = controlFeatures(body['features']);
      if (!deviceIdentifier(deviceId) || features === undefined) return invalid();
      message = { ...base, type, body: { deviceId, features } };
      break;
    }
    case 'CONFIG_TEMPLATE_REQUEST':
      if (!optionalLanguage(body)) return invalid();
      message = { ...base, type, body: typeof body['languageCode'] === 'string'
        ? { languageCode: body['languageCode'] } : {} };
      break;
    case 'CONFIG_UPDATE_REQUEST': {
      if (!optionalLanguage(body) || (body['properties'] !== undefined && !record(body['properties']))) return invalid();
      const language = typeof body['languageCode'] === 'string' ? { languageCode: body['languageCode'] } : {};
      const properties = record(body['properties']) ? { properties: body['properties'] } : {};
      message = { ...base, type, body: { ...language, ...properties } };
      break;
    }
    case 'USER_MESSAGE_ACK_EVENT': {
      const ackType = body['ackType'];
      const userMessageId = body['userMessageId'];
      if ((ackType !== 'YES' && ackType !== 'NO' && ackType !== 'OK') || !nonEmptyString(userMessageId)) return invalid();
      message = { ...base, type, body: { ackType, userMessageId } };
      break;
    }
    case 'CREATE_USER_MESSAGE_RESPONSE':
    case 'DELETE_USER_MESSAGE_RESPONSE': {
      const succeeded = body['success'];
      const userMessageId = body['userMessageId'];
      const error = body['error'];
      if (typeof succeeded !== 'boolean' || !nonEmptyString(userMessageId)
        || (error !== undefined && !protocolError(error))) return invalid();
      message = { ...base, type, body: { success: succeeded, userMessageId, ...(error === undefined ? {} : { error }) } };
      break;
    }
    case 'LIST_USER_MESSAGES_RESPONSE': {
      const userMessageMap = body['userMessageMap'];
      if (!record(userMessageMap)) return invalid();
      const validatedMap: Record<string, number> = Object.create(null) as Record<string, number>;
      for (const [key, value] of Object.entries(userMessageMap)) {
        if (!nonEmptyString(key) || typeof value !== 'number' || !Number.isSafeInteger(value)) return invalid();
        validatedMap[key] = value;
      }
      message = { ...base, type, body: { userMessageMap: validatedMap } };
      break;
    }
    case 'ERROR_RESPONSE': {
      const error = body['error'];
      if (!protocolError(error) || !Object.hasOwn(body, 'originalMessage')) return invalid();
      message = { ...base, type, body: { error, originalMessage: body['originalMessage'] } };
      break;
    }
    default:
      // Do not return arbitrary unknown fields or an unbounded user-supplied type to logging.
      return success({ kind: 'ignored', messageType: /^[A-Z][A-Z0-9_]{0,79}$/.test(type) ? type : 'UNRECOGNIZED' });
  }
  return success({ kind: 'known', message });
}

/** Serialization catches invalid values/cycles without exposing values or exception messages. */
export function encodeHcuMessage(message: HcuEnvelope): Result<string> {
  if (!nonEmptyString(message.id) || !nonEmptyString(message.pluginId) || !nonEmptyString(message.type)
    || (message.body !== undefined && !record(message.body))) return invalid();
  try {
    return success(JSON.stringify({ id: message.id, pluginId: message.pluginId, type: message.type,
      ...(message.body === undefined ? {} : { body: message.body }) }));
  } catch {
    return failure('InvalidResponseError', 'HCU message cannot be serialized as JSON.');
  }
}
