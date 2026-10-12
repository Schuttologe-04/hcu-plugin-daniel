/** Policy is infrastructure configuration, never an HCUweb write permission. */
export interface ActuatorPolicy {
  readonly maxStatusAgeMs: number;
  readonly tclRefreshMs: number;
  /** Retries apply to GETs only. An ambiguous device write is never retried. */
  readonly maxRetries: number;
  readonly retryDelayMs: number;
}

export interface ActuatorContext {
  readonly telemetryHealthy: boolean;
  /** Actual controller sample time; it is checked again immediately before sending. */
  readonly telemetrySampledAtMs: number | null;
  readonly recoveryAllowed: boolean;
  readonly overrideActive: boolean;
  readonly loadManagementEnabled: boolean;
}

export const DEFAULT_ACTUATOR_POLICY: ActuatorPolicy = Object.freeze({
  maxStatusAgeMs: 4_000,
  tclRefreshMs: 300_000,
  maxRetries: 2,
  retryDelayMs: 100,
});

export function resolveActuatorPolicy(input: Partial<ActuatorPolicy> = {}): ActuatorPolicy {
  const policy = { ...DEFAULT_ACTUATOR_POLICY, ...input };
  if (!Number.isInteger(policy.maxStatusAgeMs) || policy.maxStatusAgeMs <= 0 ||
      !Number.isInteger(policy.tclRefreshMs) || policy.tclRefreshMs <= 0 ||
      !Number.isInteger(policy.maxRetries) || policy.maxRetries < 0 || policy.maxRetries > 3 ||
      !Number.isInteger(policy.retryDelayMs) || policy.retryDelayMs < 0 || policy.retryDelayMs > 1_000) {
    throw new Error('Invalid actuator policy.');
  }
  return Object.freeze(policy);
}
