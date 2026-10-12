import { describe, expect, it } from 'vitest';
import { createLogger, parseLogLevel } from '../../../src/logging/logger.js';

describe('structured logging', () => {
  it('emits JSON at all required levels and hides sensitive fields', () => {
    const lines: string[] = [];
    const logger = createLogger('debug', { write: (line: string) => { lines.push(line); } });
    logger.debug({ gridPowerW: 18430.77734 }, 'Controller snapshot');
    logger.info('Configuration loaded');
    logger.warn({ chargerId: 'links' }, 'Charger unavailable');
    logger.error({ token: 'secret-token', password: 'secret-password', headers: { authorization: 'secret-header' }, config: { secret: 'secret-config' }, rawResponse: 'secret-body' }, 'Invalid response');
    expect(lines).toHaveLength(4);
    const entries: unknown[] = lines.map((line): unknown => JSON.parse(line));
    expect(entries[0]).toMatchObject({ level: 20, gridPowerW: 18430.77734 });
    expect(entries[1]).toMatchObject({ level: 30, msg: 'Configuration loaded' });
    expect(entries[2]).toMatchObject({ level: 40, chargerId: 'links' });
    expect(entries[3]).toMatchObject({ level: 50, token: '[REDACTED]', password: '[REDACTED]' });
    expect(lines.join('')).not.toContain('secret-');
  });

  it('suppresses measurement details at the default info level', () => {
    const lines: string[] = [];
    const logger = createLogger('info', { write: (line: string) => { lines.push(line); } });
    logger.debug({ gridPowerW: 123 }, 'snapshot');
    logger.info('connected');
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('gridPowerW');
  });

  it.each(['debug', 'info', 'warn', 'error'] as const)('accepts %s', (level) => {
    expect(parseLogLevel(level)).toBe(level);
  });

  it.each([undefined, '', 'verbose', 'secret'])('falls back to info for invalid environment input %s', (level) => {
    expect(parseLogLevel(level)).toBe('info');
  });
});
