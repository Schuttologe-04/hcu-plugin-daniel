import type { ControllerStatus } from '../domain/controller.js';
import { failure, type Result } from '../domain/errors.js';
import type { StatusReader } from './http-client.js';
import { mapControllerStatus } from './controller-mapper.js';

export const CONTROLLER_STATUS_FIELDS = ['ccn', 'ccp', 'cpc'] as const;

/** Read-only controller access: the only operation is a filtered status GET. */
export class GoEControllerClient {
  constructor(
    private readonly host: string,
    private readonly http: StatusReader,
  ) {}

  async readStatus(): Promise<Result<ControllerStatus>> {
    try {
      const response = await this.http.readStatus(this.host, CONTROLLER_STATUS_FIELDS);
      return response.ok ? mapControllerStatus(response.value, this.host) : response;
    } catch {
      // Keep exceptions from an injected transport inside the device boundary.
      return failure('ConnectionError', 'Controller status request failed.');
    }
  }
}
