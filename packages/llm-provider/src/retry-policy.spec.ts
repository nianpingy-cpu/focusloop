import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderFailureReason } from '@focusloop/shared-types';
import { ExecutionAbortError, RuntimeDeadlineError } from './execution';
import {
  backoffDelayMs,
  isRetryableReason,
  pauseBeforeRetry,
  resolveRetryPolicy,
  RETRYABLE_REASONS,
  RETRY_POLICY,
} from './retry-policy';

const ALL_REASONS: readonly ProviderFailureReason[] = [
  'offline',
  'timeout',
  'unauthorized',
  'rate-limited',
  'bad-response',
  'not-configured',
];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('retryable versus terminal classification', () => {
  it('is a closed list: every failure reason is classified exactly once', () => {
    expect([...RETRYABLE_REASONS].sort()).toEqual(['offline', 'rate-limited', 'timeout']);
    for (const reason of ALL_REASONS) {
      expect(typeof isRetryableReason(reason)).toBe('boolean');
    }
    expect(ALL_REASONS.filter(isRetryableReason)).toEqual(['offline', 'timeout', 'rate-limited']);
  });

  it('treats configuration and malformed answers as terminal', () => {
    for (const reason of ['unauthorized', 'not-configured', 'bad-response'] as const) {
      expect(isRetryableReason(reason)).toBe(false);
    }
  });

  it('is frozen so a caller cannot widen the policy at runtime', () => {
    expect(Object.isFrozen(RETRYABLE_REASONS)).toBe(true);
    expect(Object.isFrozen(RETRY_POLICY)).toBe(true);
  });
});

describe('bounded attempts and deterministic backoff', () => {
  it('bounds one provider to two attempts and keeps the pause finite', () => {
    expect(RETRY_POLICY.maxAttemptsPerProvider).toBe(2);
    expect(RETRY_POLICY.baseDelayMs).toBeGreaterThan(0);
    expect(RETRY_POLICY.baseDelayMs).toBeLessThanOrEqual(RETRY_POLICY.maxDelayMs);
  });

  it('doubles the pause per attempt and caps it', () => {
    expect(backoffDelayMs(1)).toBe(RETRY_POLICY.baseDelayMs);
    expect(backoffDelayMs(2)).toBe(RETRY_POLICY.baseDelayMs * 2);
    expect(backoffDelayMs(3)).toBe(RETRY_POLICY.baseDelayMs * 4);
    expect(backoffDelayMs(9)).toBe(RETRY_POLICY.maxDelayMs);
    expect(backoffDelayMs(50)).toBe(RETRY_POLICY.maxDelayMs);
  });

  it('defaults to the policy bound and the injected sleep', async () => {
    const sleep = vi.fn(async () => {});
    expect(resolveRetryPolicy()).toMatchObject({
      maxAttempts: RETRY_POLICY.maxAttemptsPerProvider,
    });
    expect(resolveRetryPolicy({ sleep }).sleep).toBe(sleep);
  });

  it('tightens the bound but never widens it past the policy', () => {
    expect(resolveRetryPolicy({ maxAttemptsPerProvider: 1 }).maxAttempts).toBe(1);
    expect(resolveRetryPolicy({ maxAttemptsPerProvider: 100 }).maxAttempts).toBe(
      RETRY_POLICY.maxAttemptsPerProvider,
    );
  });

  it('rejects an attempt limit that is not a positive integer', () => {
    for (const value of [0, -1, 1.5, Number.NaN]) {
      expect(() => resolveRetryPolicy({ maxAttemptsPerProvider: value })).toThrow(RangeError);
    }
  });
});

describe('pause before a retry', () => {
  it('waits the backoff once, then lets the retry run', async () => {
    const sleep = vi.fn(async () => {});
    await pauseBeforeRetry(1, resolveRetryPolicy({ sleep }), undefined, 'primary');
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(RETRY_POLICY.baseDelayMs);
  });

  it('never starts a pause for an already cancelled call', async () => {
    const controller = new AbortController();
    controller.abort();
    const sleep = vi.fn(async () => {});
    await expect(
      pauseBeforeRetry(1, resolveRetryPolicy({ sleep }), { signal: controller.signal }, 'primary'),
    ).rejects.toBeInstanceOf(ExecutionAbortError);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('never starts a pause past the deadline', async () => {
    const sleep = vi.fn(async () => {});
    await expect(
      pauseBeforeRetry(1, resolveRetryPolicy({ sleep }), { deadlineMs: Date.now() - 1 }, 'primary'),
    ).rejects.toBeInstanceOf(RuntimeDeadlineError);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('ends the call when the deadline passes during the pause', async () => {
    vi.useFakeTimers();
    const deadlineMs = Date.now() + 1;
    const sleep = vi.fn(async (delayMs: number) => {
      vi.setSystemTime(Date.now() + delayMs);
    });
    await expect(
      pauseBeforeRetry(1, resolveRetryPolicy({ sleep }), { deadlineMs }, 'primary'),
    ).rejects.toBeInstanceOf(RuntimeDeadlineError);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
