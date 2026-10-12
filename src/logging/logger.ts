import { pino, type DestinationStream, type Logger } from 'pino';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function parseLogLevel(value: string | undefined): LogLevel {
  switch (value) {
    case 'debug':
    case 'info':
    case 'warn':
    case 'error':
      return value;
    default:
      return 'info';
  }
}

/** Structured JSON, stderr by default so stdout remains the diagnostic report. */
export function createLogger(level: LogLevel = 'info', destination?: DestinationStream): Logger {
  return pino({
    level,
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ['password', 'token', 'authtoken', 'authToken', 'clientId', 'activationKey', 'HCU_AUTHTOKEN', 'authorization', 'headers.authorization', 'headers.authtoken', 'config', 'rawResponse'],
      censor: '[REDACTED]',
    },
  }, destination ?? pino.destination(2));
}
