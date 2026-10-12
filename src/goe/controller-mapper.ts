import type { ControllerStatus } from '../domain/controller.js';
import { failure, success, type Result } from '../domain/errors.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullableMeasurement(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isPhaseRow(value: unknown): value is (number | null)[] {
  return Array.isArray(value) && value.length >= 3 && value.every(isNullableMeasurement);
}

function isAuxiliaryCategory(name: unknown): boolean {
  return name === 'Home' || name === 'Solar';
}

/** Auxiliary measurements are optional and must never make a valid Grid unavailable. */
function auxiliaryPower(names: readonly unknown[], powers: readonly unknown[], category: 'Home' | 'Solar'): number | null {
  const index = names.indexOf(category);
  if (index === -1 || names.lastIndexOf(category) !== index) return null;
  const value: unknown = powers[index];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Decode untrusted HTTP JSON; category positions are determined by ccn. */
export function mapControllerStatus(payload: unknown, host: string): Result<ControllerStatus> {
  if (!isRecord(payload)) {
    return failure('InvalidResponseError', 'Controller status must be a JSON object.');
  }

  const { ccn, ccp, cpc } = payload;
  if (!Array.isArray(ccn) || !Array.isArray(ccp) || !Array.isArray(cpc)) {
    return failure('InvalidResponseError', 'Controller status requires ccn, ccp and cpc arrays.');
  }
  if (ccn.length !== ccp.length || ccn.length !== cpc.length) {
    return failure('InvalidResponseError', 'Controller category arrays have different lengths.');
  }
  if (!ccn.every((name: unknown) => typeof name === 'string')) {
    return failure('InvalidResponseError', 'Controller category names must be strings.');
  }
  if (!ccp.every((value: unknown, index: number) => isAuxiliaryCategory(ccn[index]) || isNullableMeasurement(value))
    || !cpc.every((value: unknown, index: number) => isAuxiliaryCategory(ccn[index]) || isPhaseRow(value))) {
    return failure('InvalidResponseError', 'Controller power or phase-current measurements are malformed.');
  }

  const gridIndex = ccn.indexOf('Grid');
  if (gridIndex === -1) {
    return failure('MissingMeasurementError', 'Controller category "Grid" is missing.');
  }
  if (ccn.lastIndexOf('Grid') !== gridIndex) {
    return failure('InvalidResponseError', 'Controller category "Grid" is ambiguous.');
  }

  const gridPowerW: unknown = ccp[gridIndex];
  if (gridPowerW === null || gridPowerW === undefined) {
    return failure('MissingMeasurementError', 'Controller grid-power measurement is unavailable.');
  }
  if (typeof gridPowerW !== 'number' || !Number.isFinite(gridPowerW)) {
    return failure('InvalidResponseError', 'Controller grid-power measurement must be a finite number.');
  }

  const gridPhaseCurrents: unknown = cpc[gridIndex];
  if (!isPhaseRow(gridPhaseCurrents)) {
    return failure('InvalidResponseError', 'Controller grid phase-current measurement is malformed.');
  }

  return success({
    host,
    reachable: true,
    gridPowerW,
    gridImportW: Math.max(gridPowerW, 0),
    homePowerW: auxiliaryPower(ccn, ccp, 'Home'),
    solarPowerW: auxiliaryPower(ccn, ccp, 'Solar'),
    gridPhaseCurrentsA: {
      l1: gridPhaseCurrents[0] ?? null,
      l2: gridPhaseCurrents[1] ?? null,
      l3: gridPhaseCurrents[2] ?? null,
    },
  });
}
