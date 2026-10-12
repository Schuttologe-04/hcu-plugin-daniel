import { failure, success, type Result } from '../domain/errors.js';
import { isValidDeviceHost } from '../goe/device-host.js';
import {
  DEFAULT_HTTP_TIMEOUT_MS,
  type AppConfig,
  type ChargerConfig,
  type NotificationSettings,
} from './config-types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isSafeInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function invalid(message: string): Result<never> {
  return failure('ConfigurationError', message);
}

/** Validate data from any provider without trusting external JSON types. */
export function validateConfig(input: unknown): Result<AppConfig> {
  if (!isRecord(input)) {
    return invalid('Configuration must be an object.');
  }

  const controller = input['controller'];
  if (!isRecord(controller) || typeof controller['host'] !== 'string' ||
      !isValidDeviceHost(controller['host'])) {
    return invalid('controller.host must be a valid DNS name, IPv4 address or bracketed IPv6 address with an optional port.');
  }

  const settings = input['loadManagement'];
  if (!isRecord(settings)) {
    return invalid('loadManagement must be an object.');
  }
  const enabled = settings['enabled'];
  const liveControlEnabled = settings['liveControlEnabled'];
  const gridLimitW = settings['gridLimitW'];
  const safetyReserveW = settings['safetyReserveW'];
  const triggerDurationSeconds = settings['triggerDurationSeconds'];
  const controlIntervalSeconds = settings['controlIntervalSeconds'];
  const ampStep = settings['ampStep'];

  if (typeof enabled !== 'boolean') {
    return invalid('loadManagement.enabled must be a boolean.');
  }
  if (liveControlEnabled !== undefined && typeof liveControlEnabled !== 'boolean') {
    return invalid('loadManagement.liveControlEnabled must be a boolean.');
  }
  if (!isFiniteNumber(gridLimitW) || gridLimitW <= 0) {
    return invalid('loadManagement.gridLimitW must be a finite number greater than zero.');
  }
  if (!isFiniteNumber(safetyReserveW) || safetyReserveW < 0 || safetyReserveW >= gridLimitW) {
    return invalid('loadManagement.safetyReserveW must be non-negative and less than gridLimitW.');
  }
  if (!isPositiveInteger(triggerDurationSeconds)) {
    return invalid('loadManagement.triggerDurationSeconds must be a positive integer.');
  }
  if (!isPositiveInteger(controlIntervalSeconds)) {
    return invalid('loadManagement.controlIntervalSeconds must be a positive integer.');
  }
  if (!isPositiveInteger(ampStep)) {
    return invalid('loadManagement.ampStep must be a positive integer.');
  }

  const rawChargers: unknown = input['chargers'];
  if (!Array.isArray(rawChargers)) {
    return invalid('chargers must be an array.');
  }
  const chargers: ChargerConfig[] = [];
  const ids = new Set<string>();
  for (let index = 0; index < rawChargers.length; index += 1) {
    const entry: unknown = rawChargers[index];
    if (!isRecord(entry)) {
      return invalid(`chargers[${index}] must be an object.`);
    }
    const id = entry['id'];
    const name = entry['name'];
    const host = entry['host'];
    const chargerEnabled = entry['enabled'];
    const priority = entry['priority'];
    if (!isNonEmptyString(id) || id !== id.trim()) {
      return invalid(`chargers[${index}].id must be a non-empty string without surrounding whitespace.`);
    }
    if (ids.has(id)) {
      return invalid(`chargers[${index}].id must be unique.`);
    }
    if (!isNonEmptyString(name)) {
      return invalid(`chargers[${index}].name must be a non-empty string.`);
    }
    if (typeof chargerEnabled !== 'boolean') {
      return invalid(`chargers[${index}].enabled must be a boolean.`);
    }
    if (typeof host !== 'string' ||
        (host === '' ? chargerEnabled : !isValidDeviceHost(host))) {
      return invalid(`chargers[${index}].host must be valid; only a disabled charger may use an empty host.`);
    }
    if (!isPositiveInteger(priority)) {
      return invalid(`chargers[${index}].priority must be a positive integer.`);
    }
    ids.add(id);
    chargers.push({ id, name, host, enabled: chargerEnabled, priority });
  }

  let timeoutMs = DEFAULT_HTTP_TIMEOUT_MS;
  const http = input['http'];
  if (http !== undefined) {
    if (!isRecord(http) || !isPositiveInteger(http['timeoutMs']) || http['timeoutMs'] > 2_147_483_647) {
      return invalid('http.timeoutMs must be a positive integer no greater than 2147483647.');
    }
    timeoutMs = http['timeoutMs'];
  }

  let notifications: NotificationSettings | undefined;
  if (input['notifications'] !== undefined) {
    const preferences = input['notifications'];
    if (!isRecord(preferences) ||
        typeof preferences['intervention'] !== 'boolean' ||
        typeof preferences['controllerConnectionError'] !== 'boolean' ||
        typeof preferences['chargerConnectionError'] !== 'boolean' ||
        typeof preferences['interactive'] !== 'boolean') {
      return invalid('notifications must contain four boolean preferences: intervention, controllerConnectionError, chargerConnectionError and interactive.');
    }
    notifications = {
      intervention: preferences['intervention'],
      controllerConnectionError: preferences['controllerConnectionError'],
      chargerConnectionError: preferences['chargerConnectionError'],
      interactive: preferences['interactive'],
    };
  }

  return success({
    controller: { host: controller['host'] },
    loadManagement: {
      enabled,
      ...(liveControlEnabled === undefined ? {} : { liveControlEnabled }),
      gridLimitW,
      safetyReserveW,
      triggerDurationSeconds,
      controlIntervalSeconds,
      ampStep,
    },
    chargers,
    http: { timeoutMs },
    ...(notifications === undefined ? {} : { notifications }),
  });
}
