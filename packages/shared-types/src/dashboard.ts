import type { InterventionAction } from './intervention';
import type { RescueSuccessSummary } from './rescue';

/**
 * Recomputed resume outcomes for the cards shown in a session.
 *
 * `dismissed` cards are intentionally not represented: the rate answers
 * "when the learner accepted, how often did they produce task evidence in the
 * success window?", rather than treating a refusal as a failed resume.
 */
export interface ResumeSuccessSummary {
  readonly accepted: number;
  readonly succeeded: number;
  readonly expired: number;
  readonly pending: number;
  /** A ratio in [0, 1], or null when no card has been accepted yet. */
  readonly rate: number | null;
}

export interface InterventionOutcomeSummary {
  readonly action: InterventionAction;
  readonly total: number;
  readonly accepted: number;
  readonly dismissed: number;
  readonly tasksCompleted: number;
}

export interface DashboardSummary {
  readonly sessionId: string | null;
  readonly courseTitle: string | null;
  readonly sessionDurationMs: number;
  readonly tasksCompleted: number;
  readonly tasksTotal: number;
  readonly interruptCount: number;
  readonly averageResumeLatencyMs: number | null;
  readonly resumeSuccess: ResumeSuccessSummary;
  readonly rescueSuccess: RescueSuccessSummary;
  readonly interventionOutcomes: readonly InterventionOutcomeSummary[];
}
