import type { LearningCheckpoint } from './checkpoint';
import type { LearningEvent } from './events';
import type { LocalizedMessage } from './messages';

/** The amount of context a resume card should restore. */
export type ResumeVariant = 'short' | 'medium' | 'long';

/**
 * Deterministic resume thresholds. Gap boundaries are inclusive for the more
 * detailed variant: 15 minutes is medium, and 24 hours is long.
 */
export interface ResumePolicyConfig {
  /** Gaps below this value use the short card. */
  readonly shortThresholdMs: number;
  /** Gaps at or above this value use the long card. */
  readonly longThresholdMs: number;
  /** Time after acceptance in which task evidence can prove a successful resume. */
  readonly successWindowMs: number;
}

export type ResumePolicyOverrides = Partial<ResumePolicyConfig>;

export const DEFAULT_RESUME_POLICY_CONFIG: ResumePolicyConfig = {
  shortThresholdMs: 15 * 60 * 1000,
  longThresholdMs: 24 * 60 * 60 * 1000,
  successWindowMs: 5 * 60 * 1000,
};

/**
 * What the learner sees when FocusLoop offers to bring them back in.
 *
 * The three prose fields are message descriptors rather than strings, so the
 * card reads in the learner's language. `completed` and `unresolved` hold the
 * learner's own content (task and concept titles) and are never translated.
 */
export interface ResumeCard {
  readonly variant: ResumeVariant;
  /** Derived interruption duration; null when the event timestamps were invalid. */
  readonly gapMs: number | null;
  /** Only long cards need a fixed, 30-second refresher. */
  readonly refresher: LocalizedMessage | null;
  readonly title: LocalizedMessage;
  readonly lastContext: LocalizedMessage;
  readonly completed: readonly string[];
  readonly unresolved: readonly string[];
  readonly nextAction: LocalizedMessage;
  readonly estimatedMinutes: number;
}

export interface ResumeCardTiming {
  readonly checkpointId: string;
  readonly shownAt: string;
  readonly acceptedAt?: string;
  readonly dismissedAt?: string;
  /** Milliseconds between `shownAt` and `acceptedAt`. */
  readonly resumeLatencyMs?: number;
}

export interface ResumeCardView {
  readonly card: ResumeCard;
  readonly timing: ResumeCardTiming;
}

export type ResumeSuccessStatus = 'pending' | 'succeeded' | 'expired' | 'dismissed';

export interface EvaluateResumeSuccessInput {
  readonly checkpoint: LearningCheckpoint;
  readonly timing: ResumeCardTiming;
  readonly events: readonly LearningEvent[];
  readonly now: string;
  readonly config?: ResumePolicyConfig;
}

export interface ResumeSuccessResult {
  readonly status: ResumeSuccessStatus;
  /** Unique event ids that proved the learner resumed the checkpoint task. */
  readonly evidenceEventIds: readonly string[];
  readonly acceptedAt: string | null;
  readonly windowEndsAt: string | null;
}
