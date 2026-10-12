import type { AppConfig } from '../../../../src/config/config-types.js';
import type { ProbeReport } from '../../../../src/diagnostics/probe-service.js';
import { success } from '../../../../src/domain/errors.js';
import { controller, makeCharger, makeConfig } from '../../load-management/helpers.js';

export function telemetry(config: AppConfig = makeConfig(), garagePower: number | null = 1000): ProbeReport {
  return {
    controller: success({ ...controller(4994.687988), homePowerW: 4985.463867, solarPowerW: -9.224525452 }),
    chargers: config.chargers.map(charger => !charger.enabled
      ? { status: 'disabled', reachable: false, config: charger }
      : { status: 'reachable', reachable: true, config: charger,
        value: makeCharger(charger.id, { host: charger.host, currentPowerW: charger.id === 'garage' ? garagePower : 0 }) }),
  };
}
