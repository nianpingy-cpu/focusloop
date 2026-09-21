import type { LearningEvent } from './events';
import type { InterventionDecision, InterventionOutcome } from './intervention';
import type { LocalizedMessage } from './messages';
import type { StuckReason } from './stuck';

/** The five deterministic actions that can be rendered as a stuck rescue. */
export const RESCUE_ACTIONS = ['MICRO_START', 'SIMPLIFY', 'HINT', 'EXAMPLE', 'BREAK'] as const;

export type RescueAction = (typeof RESCUE_ACTIONS)[number];

export function isRescueAction(value: unknown): value is RescueAction {
  return typeof value === 'string' && (RESCUE_ACTIONS as readonly string[]).includes(value);
}

/** The point in the rescue card lifecycle, independent of persistence. */
export type RescuePhase = 'offered' | 'active';

/** A local, deterministic plan. It contains no model output or executable tool call. */
export interface RescuePlan {
  readonly interventionId: string;
  readonly sessionId: string;
  readonly taskId: string | null;
  readonly action: RescueAction;
  readonly steps: readonly LocalizedMessage[];
  readonly estimatedMinutes: number;
  readonly source: 'deterministic-local';
}

/** The complete view consumed by a rescue card. */
export interface RescueView {
  readonly interventionId: string;
  readonly sessionId: string;
  readonly decision: InterventionDecision;
  readonly plan: RescuePlan | null;
  readonly phase: RescuePhase;
}

export type RescueSuccessStatus = 'pending' | 'succeeded' | 'expired' | 'repeated-help';

/** The result for one rescue attempt, recomputed from the event log. */
export interface RescueSuccessEvaluation {
  readonly status: RescueSuccessStatus;
  readonly interventionId: string;
  readonly sessionId: string;
  readonly taskId: string | null;
  readonly acceptedAt: string | null;
  readonly windowEndsAt: string | null;
  /** Unique, in-window events that prove the learner continued the task. */
  readonly evidenceEventIds: readonly string[];
  /** Unique, in-window HELP_REQUESTED ids that indicate repeated help. */
  readonly repeatedHelpEventIds: readonly string[];
}

/** Session aggregate rebuilt from interventions, outcomes and learning events. */
export interface RescueSuccessSummary {
  readonly accepted: number;
  readonly succeeded: number;
  readonly expired: number;
  readonly repeatedHelp: number;
  readonly pending: number;
  readonly rate: number | null;
}

/** Inputs are kept in shared-types so callers can use the same evaluator contract. */
export interface EvaluateRescueSuccessInput {
  readonly plan: RescuePlan;
  readonly outcome?: Pick<
    InterventionOutcome,
    'accepted' | 'dismissed' | 'at' | 'acceptedAt' | 'dismissedAt' | 'continuedAt'
  > | null;
  /** Convenience for callers that have timing but not an outcome row yet. */
  readonly acceptedAt?: string;
  readonly events: readonly LearningEvent[];
  readonly now: string;
  readonly rescueSuccessWindowMs?: number;
}

/** Fixed learner-reason routing, shared by policy and plan construction. */
export type RescueReasonMap = Readonly<Record<StuckReason, RescueAction>>;
