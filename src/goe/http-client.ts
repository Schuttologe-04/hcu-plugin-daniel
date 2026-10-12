import { DEFAULT_HTTP_TIMEOUT_MS } from '../config/config-types.js';
import { failure, success, type Result } from '../domain/errors.js';
import { isValidDeviceHost } from './device-host.js';

/** Only the fixed, read-only status endpoint is available at this boundary. */
export interface StatusReader {
  readStatus(host: string, fields: readonly string[]): Promise<Result<unknown>>;
}

export interface GoEHttpOptions {
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

export class GoEHttpClient implements StatusReader {
  readonly #timeoutMs: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: GoEHttpOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async readStatus(host: string, fields: readonly string[]): Promise<Result<unknown>> {
    if (!isValidDeviceHost(host)) {
      return failure('ConfigurationError', 'Device host is invalid. Use a host with an optional port, without URL components.');
    }
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0 || this.#timeoutMs > 2_147_483_647) {
      return failure('ConfigurationError', 'HTTP timeout must be a positive integer within the supported timer range.');
    }
    if (fields.length === 0 || fields.some((field) => !/^[a-zA-Z][a-zA-Z0-9]*$/.test(field))) {
      return failure('ConfigurationError', 'Status filter must contain valid API field names.');
    }

    // A caller cannot supply a path, verb, body, or additional query parameter.
    const url = new URL(`http://${host}/api/status`);
    url.searchParams.set('filter', fields.join(','));
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), this.#timeoutMs);

    try {
      const response = await this.#fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: abortController.signal,
        headers: { accept: 'application/json' },
      });

      if (!response.ok) {
        // Do not follow redirects: a redirect target could have side effects even with GET.
        abortController.abort();
        return failure('ConnectionError', `Status request returned HTTP ${response.status}.`);
      }

      // Keep timeout active while the response body is being received.
      const body = await response.text();
      try {
        const payload: unknown = JSON.parse(body);
        return success(payload);
      } catch {
        return failure('InvalidResponseError', 'Status response is not valid JSON.');
      }
    } catch {
      if (abortController.signal.aborted) {
        return failure('TimeoutError', `Status request timed out after ${this.#timeoutMs} ms.`);
      }
      // Never expose native exception messages, device payloads, or credentials.
      return failure('ConnectionError', 'Unable to read device status. Check network connectivity and the device HTTP API.');
    } finally {
      clearTimeout(timer);
    }
  }
}
