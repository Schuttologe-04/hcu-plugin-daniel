import { describe, expect, it } from 'vitest';
import type { ChargerConfig } from '../../../src/config/config-types.js';
import type { ProbeReport } from '../../../src/diagnostics/probe-service.js';
import { mapCarState, type ChargerStatus } from '../../../src/domain/charger.js';
import { failure, success } from '../../../src/domain/errors.js';
import { formatProbeReport } from '../../../src/cli/probe-format.js';

const config: ChargerConfig = { id: 'garage', name: 'Garage', host: 'garage.test', enabled: true, priority: 1 };
const status: ChargerStatus = {
  id: config.id, configuredName: config.name, reportedName: 'go-eCharger Garage', host: config.host, reachable: true,
  firmwareVersion: '59.4', carState: mapCarState(1), configuredCurrentA: 14, effectiveCurrentA: 14,
  temporaryCurrentLimitA: null, maximumCurrentA: null, minimumCurrentA: 6, chargingAllowed: true,
  forceState: 0, allowChargingPause: true, minimumChargingPauseDuration: 0, modelStatus: 15, rawNrg: null,
};

function report(snapshot: ChargerStatus = status): ProbeReport {
  return {
    controller: success({
      host: 'controller.test', reachable: true, gridPowerW: 18430.77734, gridImportW: 18430.77734,
      gridPhaseCurrentsA: { l1: 28.45207596, l2: 31.58973694, l3: 20.83134842 },
    }),
    chargers: [
      { status: 'reachable', reachable: true, config, value: snapshot },
      { status: 'disabled', reachable: false, config: { ...config, id: 'rechts', name: 'Rechts', host: '', enabled: false } },
    ],
  };
}

describe('formatProbeReport', () => {
  it('formats a readable controller and charger snapshot with explicit disabled status', () => {
    const output = formatProbeReport(report());
    expect(output).toContain('Grid: 18.431 W\nGrid import: 18.431 W');
    expect(output).toContain('L1: 28,45 A');
    expect(output).toContain('Firmware: 59.4');
    expect(output).toContain('Car state: idle (1)');
    expect(output).toContain('amp: 14 A');
    expect(output).toContain('acu: 14 A');
    expect(output).toContain('tcl: none');
    expect(output).toContain('mca: 6 A');
    expect(output).toContain('\nRechts\nStatus: disabled\n');
    expect(output.endsWith('\n')).toBe(true);
  });

  it('preserves absent currents, firmware, maximum current and nrg as none', () => {
    const current = report({ ...status, firmwareVersion: null, effectiveCurrentA: null, carState: mapCarState(null) });
    if (!current.controller.ok) throw new Error('Controller fixture failed');
    const output = formatProbeReport({
      ...current, controller: success({ ...current.controller.value, gridPhaseCurrentsA: { l1: null, l2: null, l3: null } }),
    });
    expect(output).toContain('L1: none\nL2: none\nL3: none');
    expect(output).toContain('Firmware: none');
    expect(output).toContain('Car state: unavailable (none)');
    expect(output).toContain('acu: none');
    expect(output).toContain('ama: none');
    expect(output).toContain('nrg (raw): none');
    expect(output).not.toContain('acu: 0 A');
  });

  it('renders an unavailable controller as an error without fabricating zero grid power', () => {
    const output = formatProbeReport({ ...report(), controller: failure('MissingMeasurementError', 'Grid power is unavailable.') });
    expect(output).toContain('Status: unavailable\nError: MissingMeasurementError: Grid power is unavailable.');
    expect(output).not.toContain('Grid:');
    expect(output).not.toContain('Grid import:');
    expect(output).toContain('Firmware: 59.4');
  });

  it('reports per-charger errors without printing fictional measurement values', () => {
    const output = formatProbeReport({
      ...report(),
      chargers: [{ status: 'unavailable', reachable: false, config, error: { code: 'TimeoutError', message: 'Status request timed out.' } }],
    });
    expect(output).toContain('Garage\nHost: garage.test\nStatus: unavailable\nError: TimeoutError: Status request timed out.');
    expect(output).not.toContain('amp:');
  });

  it.each([[2, 'charging'], [4, 'complete'], [77, 'unknown']] as const)('prints documented or future car state %i as %s', (code, label) => {
    expect(formatProbeReport(report({ ...status, carState: mapCarState(code) }))).toContain(`Car state: ${label} (${code})`);
  });

  it('prints raw nrg without altering its numeric values or null entries', () => {
    expect(formatProbeReport(report({ ...status, rawNrg: [230.1, null, 14, 3500] }))).toContain('nrg (raw): [230.1,null,14,3500]');
  });

  it('replaces terminal controls in device and configuration text and error details', () => {
    const unsafe = '\u001b[31mDanger\n\u0007\u009b';
    const output = formatProbeReport({
      controller: failure('ConnectionError', unsafe),
      chargers: [
        { status: 'reachable', reachable: true, config: { ...config, name: unsafe, host: unsafe }, value: { ...status, reportedName: unsafe, firmwareVersion: unsafe } },
        { status: 'unavailable', reachable: false, config, error: { code: 'ConnectionError', message: unsafe } },
        { status: 'disabled', reachable: false, config: { ...config, name: unsafe, enabled: false } },
      ],
    });
    expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);
    expect(output).toContain(' [31mDanger   ');
    expect(output).not.toContain('Danger\n');
  });
});
