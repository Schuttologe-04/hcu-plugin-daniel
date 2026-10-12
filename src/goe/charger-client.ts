import type { ChargerConfig } from '../config/config-types.js';
import type { ChargerStatus } from '../domain/charger.js';
import { failure, type Result } from '../domain/errors.js';
import { mapChargerStatus } from './charger-mapper.js';
import type { StatusReader } from './http-client.js';

export const CHARGER_STATUS_FIELDS = Object.freeze([
  'fna', 'fwv', 'car', 'amp', 'acu', 'ama', 'alw', 'frc', 'tcl', 'mca', 'acp', 'mcpd', 'modelStatus', 'nrg',
]);

/** Status-only client. All network access is delegated to the GET-only HTTP layer. */
export class GoEChargerClient {
  constructor(private readonly config: ChargerConfig, private readonly http: StatusReader) {}

  async readStatus(): Promise<Result<ChargerStatus>> {
    if (!this.config.enabled) {
      return failure('ConfigurationError', 'Disabled charger must not be queried.');
    }
    try {
      const response = await this.http.readStatus(this.config.host, CHARGER_STATUS_FIELDS);
      return response.ok ? mapChargerStatus(response.value, this.config) : response;
    } catch {
      // A custom StatusReader must not leak transport exceptions to callers either.
      return failure('ConnectionError', 'Charger status request failed.');
    }
  }
}
