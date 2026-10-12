import type { ChargerConfig } from '../../config/config-types.js';
import { DEFAULT_HTTP_TIMEOUT_MS } from '../../config/config-types.js';
import { failure, success, type Result } from '../../domain/errors.js';
import { isValidDeviceHost } from '../device-host.js';
import type { ChargerControlClient, ControlObservation, WriteGate } from './control-types.js';

export interface GoEChargerControlClientOptions {
  readonly gate: WriteGate;
  readonly now: () => number;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  /**
   * The official API describes tcl expiry but does not specify its clear value.
   * Supply this only after JSON null was verified for the target device profile.
   * No default capability is inferred from firmware, status or a successful set.
   */
  readonly tclClearCapability?: 'JSON_NULL_VERIFIED';
  /** Installed distribution: the user's verified hardware profile, never an arbitrary allow-list. */
  readonly tclClearFirmwareProfile?: 'GO_E_59_4';
}

const CONTROL_FIELDS = ['amp', 'tcl', 'frc', 'loe', 'car', 'mca', 'acu', 'ama', 'acp', 'mcpd', 'alw', 'fwv'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCurrent(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNullableCurrent(value: unknown): value is number | null {
  return value === null || isCurrent(value);
}

/**
 * The only device-writing HTTP boundary. Public operations cannot accept API keys,
 * verbs or paths. The separate actuator must perform pre-checks and readbacks.
 */
export class GoEChargerControlClient implements ChargerControlClient {
  readonly #gate: WriteGate;
  readonly #now: () => number;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;
  readonly #tclClearCapability: 'JSON_NULL_VERIFIED' | undefined;
  readonly #tclClearFirmwareProfile: 'GO_E_59_4' | undefined;

  constructor(options: GoEChargerControlClientOptions) {
    // A caller cannot mutate the supplied gate object to promote a DEV client.
    this.#gate = { ...options.gate };
    this.#now = options.now;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    this.#tclClearCapability = options.tclClearCapability;
    this.#tclClearFirmwareProfile = options.tclClearFirmwareProfile;
  }

  async readStatus(config: ChargerConfig): Promise<Result<ControlObservation>> {
    const target = this.#validateTarget(config);
    if (!target.ok) return target;
    const start = this.#timestamp();
    if (!start.ok) return start;
    const chargerId = config.id;
    const host = config.host;
    const url = new URL(`http://${host}/api/status`);
    url.searchParams.set('filter', CONTROL_FIELDS.join(','));
    const response = await this.#request(url);
    if (!response.ok) return response;
    const end = this.#timestamp();
    if (!end.ok) return end;
    if (end.value < start.value) {
      return failure('ConfigurationError', 'Control observation clock moved backwards.');
    }
    const raw = response.value;
    if (!isRecord(raw)
      || !isCurrent(raw['amp'])
      || !isNullableCurrent(raw['tcl'])
      || !isCurrent(raw['frc'])
      || !isNullableCurrent(raw['car'])
      || !isCurrent(raw['mca'])
      || !isNullableCurrent(raw['acu'])
      || !(raw['ama'] === undefined || isNullableCurrent(raw['ama']))
      || typeof raw['acp'] !== 'boolean'
      || !isCurrent(raw['mcpd'])
      || typeof raw['alw'] !== 'boolean') {
      return failure('InvalidResponseError', 'Control status contains missing or invalid fields.');
    }
    return success({
      chargerId, host, readStartedAtMs: start.value, observedAtMs: end.value,
      amp: raw['amp'], tcl: raw['tcl'], frc: raw['frc'],
      loe: typeof raw['loe'] === 'boolean' ? raw['loe'] : null,
      car: raw['car'], mca: raw['mca'], acu: raw['acu'], ama: raw['ama'] ?? null,
      acp: raw['acp'], mcpd: raw['mcpd'], alw: raw['alw'],
      ...(this.#tclClearFirmwareProfile === undefined ? {} : {
        firmwareVersion: typeof raw['fwv'] === 'string' && raw['fwv'].length > 0 ? raw['fwv'] : null,
        tclClearCapability: typeof raw['fwv'] !== 'string' || raw['fwv'].length === 0 ? 'UNKNOWN' as const
          : this.#tclClearCapability === 'JSON_NULL_VERIFIED' && raw['fwv'] === '59.4' ? 'VERIFIED' as const : 'BLOCKED' as const,
      }),
    });
  }

  setTemporaryCurrentLimit(config: ChargerConfig, amps: number): Promise<Result<void>> {
    // Even an untyped caller cannot turn the numeric setter into a clear operation.
    if (!isCurrent(amps)) {
      return Promise.resolve(failure('ConfigurationError', 'WRITE_BLOCKED: temporary current must be a nonnegative integer.'));
    }
    return this.#writeKey(config, 'tcl', amps);
  }

  clearTemporaryCurrentLimit(config: ChargerConfig, beforeSend?: (current?: ControlObservation) => Result<void>): Promise<Result<void>> {
    // The write gate is checked first even when the clear capability is absent.
    return this.#writeKey(config, 'tcl', null, beforeSend);
  }

  pause(config: ChargerConfig): Promise<Result<void>> {
    return this.#writeKey(config, 'frc', 1);
  }

  resume(config: ChargerConfig): Promise<Result<void>> {
    return this.#writeKey(config, 'frc', 0);
  }

  async #writeKey(config: ChargerConfig, key: 'tcl' | 'frc', value: number | null,
    beforeSend?: (current?: ControlObservation) => Result<void>): Promise<Result<void>> {
    if (this.#gate.executionMode !== 'LIVE' || this.#gate.realWritesEnabled !== true) {
      return failure('ConfigurationError', 'WRITE_BLOCKED: LIVE mode and explicit real-write permission are both required.');
    }
    const target = this.#validateTarget(config);
    if (!target.ok) return target;
    // Runtime whitelist remains explicit even though this private method is typed.
    if ((key !== 'tcl' && key !== 'frc')
      || (key === 'frc' && value !== 0 && value !== 1)
      || (key === 'tcl' && value !== null && !isCurrent(value))) {
      return failure('ConfigurationError', 'WRITE_BLOCKED: invalid permitted control value.');
    }
    if (key === 'tcl' && value === null && this.#tclClearCapability !== 'JSON_NULL_VERIFIED') {
      return failure('ConfigurationError', 'WRITE_BLOCKED: TCL_CLEAR_SEMANTICS_UNVERIFIED.');
    }
    let clearObservation: ControlObservation | undefined;
    if (key === 'tcl' && value === null && this.#tclClearFirmwareProfile !== undefined) {
      // A cached version or old ownership record is insufficient after a firmware update.
      const current = await this.readStatus(config);
      if (!current.ok || current.value.tclClearCapability !== 'VERIFIED') {
        return failure('ConfigurationError', 'WRITE_BLOCKED: TCL_CLEAR_FIRMWARE_NOT_VERIFIED.');
      }
      clearObservation = current.value;
    }
    // Firmware reads may outlive consent, shutdown or the telemetry freshness
    // budget. No await is permitted between this live fence and the HTTP send.
    if (beforeSend !== undefined) {
      try {
        const permitted = beforeSend(clearObservation);
        if (!permitted.ok) return permitted;
      } catch {
        return failure('ConfigurationError', 'WRITE_BLOCKED: pre-send safety check failed.');
      }
    }
    // Official HTTP API v2 uses a GET with one JSON-encoded value; never a body.
    const url = new URL(`http://${config.host}/api/set`);
    url.searchParams.set(key, JSON.stringify(value));
    const response = await this.#request(url);
    if (!response.ok) return response;
    if (!isRecord(response.value) || response.value[key] !== true) {
      return failure('InvalidResponseError', 'Control request was not acknowledged by the device.');
    }
    // This acknowledges only transport success. The actuator must read back.
    return success(undefined);
  }

  #validateTarget(config: ChargerConfig): Result<void> {
    if (config.enabled !== true) {
      return failure('ConfigurationError', 'WRITE_BLOCKED: disabled charger.');
    }
    if (!isValidDeviceHost(config.host)) {
      return failure('ConfigurationError', 'Device host is invalid. Use a host with an optional port, without URL components.');
    }
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0 || this.#timeoutMs > 2_147_483_647) {
      return failure('ConfigurationError', 'HTTP timeout must be a positive integer within the supported timer range.');
    }
    return success(undefined);
  }

  #timestamp(): Result<number> {
    try {
      const timestamp = this.#now();
      return Number.isSafeInteger(timestamp) && timestamp >= 0
        ? success(timestamp)
        : failure('ConfigurationError', 'Control observation clock is invalid.');
    } catch {
      return failure('ConfigurationError', 'Control observation clock is unavailable.');
    }
  }

  async #request(url: URL): Promise<Result<unknown>> {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(url, {
        method: 'GET', redirect: 'manual', credentials: 'omit',
        signal: abortController.signal, headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        abortController.abort();
        return failure('ConnectionError', `Control HTTP request returned HTTP ${response.status}.`);
      }
      const body = await response.text();
      abortController.signal.throwIfAborted();
      try {
        const payload: unknown = JSON.parse(body);
        return success(payload);
      } catch {
        return failure('InvalidResponseError', 'Control response is not valid JSON.');
      }
    } catch {
      return abortController.signal.aborted
        ? failure('TimeoutError', `Control HTTP request timed out after ${this.#timeoutMs} ms.`)
        : failure('ConnectionError', 'Unable to communicate with charger control API.');
    } finally {
      clearTimeout(timer);
    }
  }
}
