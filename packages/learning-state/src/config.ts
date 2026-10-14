/**
 * Tunable thresholds for the rule-based state engine.
 * Everything here is configuration, never a diagnosis.
 */
export interface StateEngineConfig {
  /** Away-from-task duration that turns DISTRACTED into INTERRUPTED — an *observed* departure. */
  readonly tabLeftThresholdMs: number;
  /**
   * Quiet duration after which the shell may remind the learner — how long "no input" runs before the
   * app says something. It does **not** drive a state transition: quiet is not away, or reading a paper
   * would file the learner as gone two minutes in. Only `tabLeftThresholdMs`, an observed departure,
   * escalates.
   */
  readonly idleThresholdMs: number;
  /**
   * How long an unobserved stretch — after the last event of a still-open session — may be credited to
   * a study state when the event log is replayed.
   *
   * A knob of the *replay*, not of the state machine: no transition reads it. It is here because the
   * replay was borrowing `idleThresholdMs` for this, which coupled "how long before we call a silent
   * learner idle" (a state decision) to "how much of an unwitnessed tail we will count as study time"
   * (a measurement decision). The two are allowed to differ now, which is the point.
   */
  readonly presenceTimeoutMs: number;
  /**
   * How long a session may go without a single observation before it is over.
   *
   * A session is not ended by closing the app, so one left open over a weekend kept a natural elapsed
   * time that grew to a fortnight. This is the rule that ends it: on the first tick after the gap, a
   * session whose last event is older than this is ended with reason `timeout`, so its elapsed time —
   * and a fresh one's — stop being ambiguous. Deliberately long, because a learner reading with no
   * input still produces one observation (the idle report) and must not have their session ended
   * underneath them mid-chapter.
   */
  readonly sessionIdleTimeoutMs: number;
  /** Time in READY with no task started before INITIATION_FRICTION. */
  readonly initiationFrictionThresholdMs: number;
  /** Consecutive incorrect quizzes before CONFUSED. */
  readonly consecutiveIncorrectThreshold: number;
  /** Help requests inside `helpRequestWindowMs` before OVERLOADED. */
  readonly helpRequestOverloadThreshold: number;
  readonly helpRequestWindowMs: number;
  /** Bounded ring of event ids kept for duplicate/race protection. */
  readonly dedupeWindowSize: number;
}

export const DEFAULT_STATE_ENGINE_CONFIG: StateEngineConfig = {
  tabLeftThresholdMs: 20_000,
  idleThresholdMs: 120_000,
  presenceTimeoutMs: 120_000,
  sessionIdleTimeoutMs: 4 * 60 * 60_000,
  initiationFrictionThresholdMs: 45_000,
  consecutiveIncorrectThreshold: 2,
  helpRequestOverloadThreshold: 3,
  helpRequestWindowMs: 300_000,
  dedupeWindowSize: 50,
};

export function resolveStateEngineConfig(
  overrides: Partial<StateEngineConfig> = {},
): StateEngineConfig {
  const merged: StateEngineConfig = { ...DEFAULT_STATE_ENGINE_CONFIG, ...overrides };
  for (const [key, value] of Object.entries(merged)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`StateEngineConfig.${key} must be a non-negative finite number`);
    }
  }
  return merged;
}
