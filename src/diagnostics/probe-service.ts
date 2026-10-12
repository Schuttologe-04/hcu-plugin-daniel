import type { Logger } from 'pino';
import type { AppConfig, ChargerConfig } from '../config/config-types.js';
import type { ChargerStatus } from '../domain/charger.js';
import type { ControllerStatus } from '../domain/controller.js';
import { failure, type AppError, type Result } from '../domain/errors.js';
import { GoEChargerClient } from '../goe/charger-client.js';
import { GoEControllerClient } from '../goe/controller-client.js';
import { GoEHttpClient, type StatusReader } from '../goe/http-client.js';

export type ChargerProbeResult =
  | { readonly status: 'disabled'; readonly reachable: false; readonly config: ChargerConfig }
  | { readonly status: 'reachable'; readonly reachable: true; readonly config: ChargerConfig; readonly value: ChargerStatus }
  | { readonly status: 'unavailable'; readonly reachable: false; readonly config: ChargerConfig; readonly error: AppError };

export interface ProbeReport {
  readonly controller: Result<ControllerStatus>;
  readonly chargers: readonly ChargerProbeResult[];
}

export interface ProbeOptions {
  readonly http?: StatusReader;
  readonly logger?: Logger;
}

async function readSafely<T>(read: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await read();
  } catch {
    // Also isolate a future adapter's unexpected rejection at the device boundary.
    return failure('ConnectionError', 'The device status reader failed unexpectedly.');
  }
}

/** One diagnostic snapshot; never schedules polling or makes control decisions. */
export async function probeDevices(config: AppConfig, options: ProbeOptions = {}): Promise<ProbeReport> {
  const http = options.http ?? new GoEHttpClient({ timeoutMs: config.http.timeoutMs });
  const logger = options.logger;
  const controllerRequest = readSafely(() => new GoEControllerClient(config.controller.host, http).readStatus());
  const chargerRequests = config.chargers.map(async (charger): Promise<ChargerProbeResult> => {
    if (!charger.enabled) {
      return { status: 'disabled', reachable: false, config: charger };
    }
    const result = await readSafely(() => new GoEChargerClient(charger, http).readStatus());
    if (!result.ok) {
      logger?.warn({ device: 'charger', chargerId: charger.id, errorCode: result.error.code }, 'Charger unavailable');
      return { status: 'unavailable', reachable: false, config: charger, error: result.error };
    }
    logger?.info({ device: 'charger', chargerId: charger.id }, 'Charger reachable');
    logger?.debug({ chargerId: charger.id, configuredCurrentA: result.value.configuredCurrentA, effectiveCurrentA: result.value.effectiveCurrentA }, 'Charger current snapshot');
    return { status: 'reachable', reachable: true, config: charger, value: result.value };
  });

  const [controller, chargers] = await Promise.all([controllerRequest, Promise.all(chargerRequests)]);
  if (controller.ok) {
    logger?.info({ device: 'controller' }, 'Controller connected');
    logger?.debug({ gridPowerW: controller.value.gridPowerW, gridImportW: controller.value.gridImportW }, 'Controller measurement snapshot');
  } else if (controller.error.code === 'InvalidResponseError') {
    logger?.error({ device: 'controller', errorCode: controller.error.code }, 'Invalid controller response');
  } else {
    logger?.warn({ device: 'controller', errorCode: controller.error.code }, 'Controller unavailable');
  }
  return { controller, chargers };
}
