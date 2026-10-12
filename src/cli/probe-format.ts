import type { ProbeReport } from '../diagnostics/probe-service.js';

const powerFormat = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
const currentFormat = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 2 });

function valueWithUnit(value: number | null, unit: string): string {
  return value === null ? 'none' : `${currentFormat.format(value)} ${unit}`;
}

/** Prevent untrusted device names or local strings from injecting terminal controls. */
function terminalText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

export function formatProbeReport(report: ProbeReport): string {
  const lines = ['go-e Controller', '---------------'];
  if (report.controller.ok) {
    const controller = report.controller.value;
    lines.push(
      'Status: reachable',
      `Grid: ${powerFormat.format(controller.gridPowerW)} W`,
      `Grid import: ${powerFormat.format(controller.gridImportW)} W`,
      `L1: ${valueWithUnit(controller.gridPhaseCurrentsA.l1, 'A')}`,
      `L2: ${valueWithUnit(controller.gridPhaseCurrentsA.l2, 'A')}`,
      `L3: ${valueWithUnit(controller.gridPhaseCurrentsA.l3, 'A')}`,
    );
  } else {
    lines.push('Status: unavailable', `Error: ${report.controller.error.code}: ${terminalText(report.controller.error.message)}`);
  }

  lines.push('', 'Chargers', '--------');
  for (const charger of report.chargers) {
    lines.push('', terminalText(charger.config.name));
    if (charger.status === 'disabled') {
      lines.push('Status: disabled');
      continue;
    }
    lines.push(`Host: ${terminalText(charger.config.host)}`, `Status: ${charger.status}`);
    if (charger.status === 'unavailable') {
      lines.push(`Error: ${charger.error.code}: ${terminalText(charger.error.message)}`);
      continue;
    }
    const status = charger.value;
    lines.push(
      `Reported name: ${status.reportedName === null ? 'none' : terminalText(status.reportedName)}`,
      `Firmware: ${status.firmwareVersion === null ? 'none' : terminalText(status.firmwareVersion)}`,
      `Car state: ${status.carState.label} (${status.carState.code ?? 'none'})`,
      `amp: ${valueWithUnit(status.configuredCurrentA, 'A')}`,
      `acu: ${valueWithUnit(status.effectiveCurrentA, 'A')}`,
      `tcl: ${valueWithUnit(status.temporaryCurrentLimitA, 'A')}`,
      `ama: ${valueWithUnit(status.maximumCurrentA, 'A')}`,
      `mca: ${valueWithUnit(status.minimumCurrentA, 'A')}`,
      `Charging allowed: ${status.chargingAllowed}`,
      `Force state: ${status.forceState}`,
      `Allow charging pause: ${status.allowChargingPause}`,
      `Minimum charging pause duration: ${valueWithUnit(status.minimumChargingPauseDuration, 'ms')}`,
      `Model status: ${status.modelStatus}`,
      `nrg (raw): ${status.rawNrg === null ? 'none' : JSON.stringify(status.rawNrg)}`,
    );
  }
  return `${lines.join('\n')}\n`;
}
