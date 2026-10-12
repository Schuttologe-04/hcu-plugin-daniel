import type { ChargerConfig } from '../config/config-types.js';
import { mapCarState, type ChargerStatus } from '../domain/charger.js';
import { failure, success, type Result } from '../domain/errors.js';

interface RawChargerStatus {
  readonly fna: string;
  readonly fwv?: string | null;
  readonly car: number | null;
  readonly amp: number;
  readonly acu: number | null;
  readonly ama?: number | null;
  readonly alw: boolean;
  readonly frc: number;
  readonly tcl: number | null;
  readonly mca: number;
  readonly acp: boolean;
  readonly mcpd: number;
  readonly modelStatus: number;
  readonly nrg?: readonly (number | null)[] | null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNullableInteger(value: unknown): value is number | null {
  return value === null || isNonNegativeInteger(value);
}

function isRawNrg(value: unknown): value is readonly (number | null)[] | null | undefined {
  return value === undefined || value === null || (
    Array.isArray(value)
    && value.every((entry: unknown) => entry === null || (
      typeof entry === 'number' && Number.isFinite(entry)
    ))
  );
}

/** Validates external JSON before exposing it as a typed device response. */
function isRawChargerStatus(payload: unknown): payload is RawChargerStatus {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return false;
  const raw = payload as Record<string, unknown>;
  return typeof raw['fna'] === 'string'
    && (raw['fwv'] === undefined || raw['fwv'] === null || typeof raw['fwv'] === 'string')
    && isNullableInteger(raw['car'])
    && isNonNegativeInteger(raw['amp'])
    && isNullableInteger(raw['acu'])
    && (raw['ama'] === undefined || isNullableInteger(raw['ama']))
    && typeof raw['alw'] === 'boolean'
    && isNonNegativeInteger(raw['frc'])
    && isNullableInteger(raw['tcl'])
    && isNonNegativeInteger(raw['mca'])
    && typeof raw['acp'] === 'boolean'
    && isNonNegativeInteger(raw['mcpd'])
    && isNonNegativeInteger(raw['modelStatus'])
    && isRawNrg(raw['nrg']);
}

export function mapChargerStatus(payload: unknown, config: ChargerConfig): Result<ChargerStatus> {
  if (!isRawChargerStatus(payload)) {
    return failure('InvalidResponseError', 'Charger status contains missing or invalid fields.');
  }

  return success({
    id: config.id,
    configuredName: config.name,
    reportedName: payload.fna,
    host: config.host,
    reachable: true,
    firmwareVersion: payload.fwv ?? null,
    carState: mapCarState(payload.car),
    configuredCurrentA: payload.amp,
    effectiveCurrentA: payload.acu,
    temporaryCurrentLimitA: payload.tcl,
    maximumCurrentA: payload.ama ?? null,
    minimumCurrentA: payload.mca,
    chargingAllowed: payload.alw,
    forceState: payload.frc,
    allowChargingPause: payload.acp,
    minimumChargingPauseDuration: payload.mcpd,
    modelStatus: payload.modelStatus,
    rawNrg: payload.nrg === undefined || payload.nrg === null ? null : Object.freeze([...payload.nrg]),
  });
}
