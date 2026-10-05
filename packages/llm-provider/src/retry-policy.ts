import type { ProviderFailureReason } from '@focusloop/shared-types';
import { assertExecutionActive, type ExecutionOptions } from './execution';

/**
 * Which provider failures may be retried, in one closed list.
 *
 * The three here are transient by nature: the same request has a real chance of succeeding a moment
 * later. Everything else is terminal, and retrying it spends the learner's deadline on a call that
 * will fail the same way:
 *
 * - `unauthorized` / `not-configured` are configuration. A retry cannot fix a missing key.
 * - `bad-response` is the provider answering with something malformed. The request is not what
 *   changed; the deterministic offline fallback is the honest answer, not another round trip.
 *
 * Caller cancellation and the total deadline never reach this list: they are checked before every
 * retry and every pause, so a stopped call cannot buy itself another attempt.
 */
export const RETRYABLE_REASONS: readonly ProviderFailureReason[] = Object.freeze([
  'offline',
  'timeout',
  'rate-limited',
]);

export function isRetryableReason(reason: ProviderFailureReason): boolean {
  return RETRYABLE_REASONS.includes(reason);
}

export const RETRY_POLICY = Object.freeze({
  /**
   * Provider calls one provider gets for a single invocation, schema retry included.
   *
   * This is the combined bound: a schema retry and a transport retry draw on the same two attempts,
   * so nesting the two loops cannot multiply model calls. Two primary attempts plus one fallback is
   * the most any one skill invocation can cost.
   */
  maxAttemptsPerProvider: 2,
  /** First pause before a transport retry; doubled per attempt and capped. */
  baseDelayMs: 200,
  maxDelayMs: 2_000,
});

export interface RetryOptions {
  /** Injected so a retry test is deterministic; the default is a real timer. */
  readonly sleep?: (delayMs: number) => Promise<void>;
  /** Tightens the attempt limit for tests; never widens it past `RETRY_POLICY`. */
  readonly maxAttemptsPerProvider?: number;
}

export interface ResolvedRetryPolicy {
  readonly maxAttempts: number;
  readonly sleep: (delayMs: number) => Promise<void>;
}

function realSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export function resolveRetryPolicy(options?: RetryOptions): ResolvedRetryPolicy {
  const requested = options?.maxAttemptsPerProvider ?? RETRY_POLICY.maxAttemptsPerProvider;
  if (!Number.isInteger(requested) || requested < 1)
    throw new RangeError('maxAttemptsPerProvider must be an integer of at least 1');
  return {
    maxAttempts: Math.min(requested, RETRY_POLICY.maxAttemptsPerProvider),
    sleep: options?.sleep ?? realSleep,
  };
}

/** `base * 2^(attempt-1)`, capped. Deterministic on purpose: no jitter to make a test flaky. */
export function backoffDelayMs(attempt: number): number {
  const delay = RETRY_POLICY.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(delay, RETRY_POLICY.maxDelayMs);
}

/**
 * Pause before a retry, but only while the call is still allowed to run.
 *
 * The check is either side of the pause: a signal that aborts or a deadline that passes *during* the
 * pause must not be followed by another provider call.
 */
export async function pauseBeforeRetry(
  attempt: number,
  policy: ResolvedRetryPolicy,
  controls: ExecutionOptions | undefined,
  providerId: string,
): Promise<void> {
  assertExecutionActive(controls, providerId);
  await policy.sleep(backoffDelayMs(attempt));
  assertExecutionActive(controls, providerId);
}
