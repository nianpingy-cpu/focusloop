# Bounded provider retry and fallback policy

Scope: [#145](https://github.com/nianpingy-cpu/focusloop/issues/145), fourth slice of
[#94](https://github.com/nianpingy-cpu/focusloop/issues/94), following the merged
[#142 cancellation/deadline](https://github.com/nianpingy-cpu/focusloop/issues/142),
[#143 budgets](runtime-budgets.md) and [#144 streams](runtime-streaming.md) slices. It extends the
existing primary-to-mock contract rather than replacing it: no new adapter, health-probing service,
persistent prompt log or unbounded retry. The deterministic local fallback stays required, and a
future multi-provider chain cannot remove it.

## The closed policy

`retry-policy.ts` holds the only list, so a reason is retried only when a repeated call has a real
chance of succeeding. Transient by nature:

| Reason                            | Class     | Why it is what it is                                     |
| --------------------------------- | --------- | -------------------------------------------------------- |
| `offline`                         | retryable | the transport is missing for a moment, not misconfigured |
| `timeout`                         | retryable | provider-local: runtime time may still remain            |
| `rate-limited`                    | retryable | a bounded pause is the honest answer to a `429`          |
| `unauthorized` / `not-configured` | terminal  | configuration; another call cannot create a key          |
| `bad-response`                    | terminal  | the answer was malformed, not late                       |

`RETRYABLE_REASONS` and `RETRY_POLICY` are frozen, and the classification is exhaustive over
`ProviderFailureReason`, so adding a reason forces a decision instead of defaulting to a retry.

Caller cancellation and the absolute deadline are **not** provider failures and never enter that
list. `ExecutionAbortError` and `RuntimeDeadlineError` end the call whether they are raised before
an attempt or discovered after the pause that precedes the next one: no retry and no sleep starts
after a stop. Because a pause is not interrupted early, a call cancelled mid-pause settles as soon
as that bounded pause elapses (at most `maxDelayMs`).

## Attempts, backoff and provenance

| Bound                                | Value                                     |
| ------------------------------------ | ----------------------------------------- |
| attempts per provider                | 2 (`RETRY_POLICY.maxAttemptsPerProvider`) |
| first pause                          | 200 ms (`RETRY_POLICY.baseDelayMs`)       |
| pause cap                            | 2000 ms (`RETRY_POLICY.maxDelayMs`)       |
| model calls per structured execution | at most 3 (2 primary, then 1 fallback)    |

The schema retry and the transport retry draw on that one bound, so nesting the two loops cannot
multiply calls: two malformed answers, a malformed answer followed by a transient failure, and two
transient failures each cost exactly two primary calls. Backoff is `base × 2^(attempt-1)`, capped,
with no jitter, so a test can predict the pause instead of measuring it.

The fallback is taken at most once, after the primary budget is spent, and is never re-entered. The
reported provenance stays the selected completion: a degraded result names the fallback provider and
carries the **last** primary failure (`reason`, `message`, `providerId`) — retries do not overwrite
that with an earlier attempt.

## Retry and the other boundaries

- **Budgets.** Every attempt receives the same frozen bounded snapshot from [#143](runtime-budgets.md),
  so a retry cannot spend more input or widen the token cap. The token cap is per completion, not an
  aggregate ceiling across attempts.
- **Cancellation and deadline.** Checked before an attempt, on both sides of the pause, and again
  before a structured commit. A deadline that passes during the pause ends the call with
  `RuntimeDeadlineError` rather than starting another provider call.
- **Streams.** [The #144 contract](runtime-streaming.md) is unchanged: failure before first text may
  select the fallback, failure after emitted text never splices another answer, and the stream path
  uses the same `maxAttemptsPerProvider` bound as the completion path.

## Injection

`RetryOptions` is process-local, like the rest of the execution controls: never serialized, put in
shared request data or sent over IPC. `sleep` keeps a test deterministic and `maxAttemptsPerProvider`
tightens the limit; it can lower the bound and can never widen it past `RETRY_POLICY`.

```ts
await runtime.executeStructured(data, request, {
  signal,
  deadlineMs,
  maxAttemptsPerProvider: 1,
  sleep: async () => {},
});
```

## Regression gates

`retry-policy.spec.ts` pins the closed classification, the attempt bounds, the deterministic backoff
and the stop-before-sleep rules. `provider.spec.ts` and `runtime.spec.ts` cover a transient retry, a
terminal reason that is not retried, the shared schema/transport budget and the reported provenance,
using fake providers, injected time and synthetic data only. `cancellation.spec.ts` covers the
deadline during the pause, and `execution.spec.ts` keeps the provider-local DeepSeek timeout path
honest. No real credentials are involved.

```sh
pnpm --filter @focusloop/llm-provider test
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm e2e
```
