/** Safe, explicit failures at configuration and device boundaries. */
export type ErrorCode =
  | 'ConnectionError'
  | 'TimeoutError'
  | 'InvalidResponseError'
  | 'MissingMeasurementError'
  | 'ConfigurationError';

export interface AppError {
  readonly code: ErrorCode;
  readonly message: string;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AppError };

export function success<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function failure(code: ErrorCode, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}
