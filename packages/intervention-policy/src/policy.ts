import type {
  Intervention,
  InterventionAction,
  InterventionDecision,
  InterventionReasonCode,
  LearningEvent,
  LearningState,
  MessageParams,
  MicroTask,
  StuckReason,
} from '@focusloop/shared-types';
import { isStuckReason, message } from '@focusloop/shared-types';
import type { StateEngineState } from '@focusloop/learning-state';
import type { InterventionPolicyConfig } from './config';
import { resolvePolicyConfig } from './config';

export interface DecideInterventionInput {
  readonly engineState: StateEngineState;
  readonly recentEvents: readonly LearningEvent[];
  /** Interventions already shown in this session. */
  readonly shownInterventions: readonly Intervention[];
  readonly currentTask: MicroTask | null;
  readonly now: string;
}

const ACTION_MINUTES: Record<InterventionAction, number> = {
  NO_ACTION: 0,
  MICRO_START: 5,
  SIMPLIFY: 3,
  HINT: 2,
  EXAMPLE: 4,
  QUESTION: 2,
  BREAK: 5,
  RESUME: 5,
};

/**
 * Urgency ranking. A more urgent action may interrupt the cooldown; an equally
 * or less urgent one may not. This is what keeps the agent quiet without making
 * it useless when the learner is genuinely stuck.
 */
export const ACTION_PRIORITY: Record<InterventionAction, number> = {
  NO_ACTION: 0,
  QUESTION: 1,
  HINT: 2,
  MICRO_START: 3,
  SIMPLIFY: 3,
  EXAMPLE: 4,
  BREAK: 5,
  RESUME: 6,
};

function decision(
  reasonCode: InterventionReasonCode,
  action: InterventionAction,
  state: LearningState,
  params: MessageParams = {},
  confidence = 1,
  estimatedMinutes = ACTION_MINUTES[action],
): InterventionDecision {
  return { action, state, reason: message(reasonCode, params), confidence, estimatedMinutes };
}

function msSince(iso: string | undefined, now: string): number | null {
  if (iso === undefined) return null;
  const delta = Date.parse(now) - Date.parse(iso);
  return Number.isFinite(delta) ? delta : null;
}

function lastEventOfType(
  events: readonly LearningEvent[],
  type: LearningEvent['type'],
): LearningEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && event.type === type) return event;
  }
  return null;
}

/**
 * The action a stated reason asks for (AG2).
 *
 * A table, not a model call, for the same reason `decideIntervention` is rule-based: the learner has
 * just told us something specific, and turning that into a decision about what happens next is
 * exactly the kind of choice they have to be able to predict and trust.
 *
 * Two reasons share an action deliberately. `went-wrong` and `cannot-recall` both land on HINT: in
 * both, the learner has most of it and needs the missing piece — not a smaller task, and not a rest.
 * They stay separate reasons because the *content* of the help differs, which is later work, not
 * because the choice of action does.
 *
 * `do-not-understand` lands on EXAMPLE rather than HINT. A hint is for somebody who nearly has it;
 * this learner has said that reading it is not producing understanding, and a worked example is the
 * form that most reliably does. Offering all three is the learner's own choice to make in the
 * interface, not something to guess at here.
 */
export const ACTION_FOR_STUCK_REASON: Record<StuckReason, InterventionAction> = {
  'cannot-start': 'MICRO_START',
  'do-not-understand': 'EXAMPLE',
  'too-big': 'SIMPLIFY',
  'went-wrong': 'HINT',
  'cannot-recall': 'HINT',
  tired: 'BREAK',
};

/**
 * The reason from a help request the learner has made and that has not been answered yet, or null.
 *
 * `null` covers three different situations on purpose, because the caller treats them the same:
 * nobody asked; somebody asked without saying why; somebody asked and has already had an answer. Each
 * falls through to the state-based rules, which is the right answer in all three.
 *
 * The "already answered" test is what stops this repeating for ever. An intervention is persisted as an
 * intervention, not as an event, so a help request stays the most recent event after it has been
 * answered — without this, the same request would be answered again on every tick.
 */
function unansweredStuckReason(
  events: readonly LearningEvent[],
  shownInterventions: readonly Intervention[],
): StuckReason | null {
  const asked = lastEventOfType(events, 'HELP_REQUESTED');
  if (asked === null || asked.type !== 'HELP_REQUESTED') return null;

  /*
   * At-or-after, and the choice is a trade-off rather than a detail.
   *
   * Strictly-after looks more correct — "answered" should mean an intervention shown *after* the
   * request — and it is worse. The answer to a request lands in the same millisecond as the request,
   * because both come from the same clock, so strictly-after reads a request that has just been
   * answered as unanswered and answers it again on every dispatch, for ever. `engine.spec.ts` has the
   * test that catches this.
   *
   * At-or-after can instead swallow a genuine request that shares a millisecond with an unrelated
   * intervention. That costs the learner one unanswered press; the other costs an unbounded loop.
   *
   * Neither is right, because "was this request answered" is being inferred from timestamps rather
   * than recorded. The fix is for an intervention to carry the id of the request it answered; that is
   * a schema change across `shared-types` and the store, and it is not this change.
   */
  const answered = shownInterventions.some((shown) => shown.shownAt >= asked.at);
  if (answered) return null;

  const { reason } = asked.payload;
  // Validated rather than trusted: events come back out of the store, and a hand-edited row should not
  // be able to name a reason this build has never heard of.
  return isStuckReason(reason) ? reason : null;
}

/** The state rules, in priority order. First match wins. */
function candidateFor(
  engineState: StateEngineState,
  currentTask: MicroTask | null,
  now: string,
  config: InterventionPolicyConfig,
): InterventionDecision {
  const state = engineState.state;

  if (state === 'OVERLOADED') {
    return decision('reason.overloaded', 'BREAK', state, {}, 0.9);
  }

  if (state === 'CONFUSED') {
    if (engineState.consecutiveIncorrect >= 2) {
      return decision(
        'reason.confused.example',
        'EXAMPLE',
        state,
        { count: String(engineState.consecutiveIncorrect) },
        0.85,
      );
    }
    return decision('reason.confused.hint', 'HINT', state, {}, 0.7);
  }

  if (state === 'INITIATION_FRICTION') {
    return decision('reason.initiation', 'MICRO_START', state, {}, 0.8);
  }

  if (state === 'FOCUSED' && currentTask !== null) {
    const elapsed = msSince(engineState.taskStartedAt ?? undefined, now);
    const estimateMs = currentTask.estimatedMinutes * 60_000;
    if (elapsed !== null && estimateMs > 0 && elapsed > estimateMs * config.simplifyAfterRatio) {
      return decision('reason.simplify', 'SIMPLIFY', state, {}, 0.75);
    }
  }

  if (state === 'FOCUSED' && engineState.consecutiveIncorrect === 1) {
    return decision('reason.question', 'QUESTION', state, {}, 0.6);
  }

  if (state === 'DISTRACTED') {
    return decision('reason.distracted', 'NO_ACTION', state);
  }

  return decision('reason.none', 'NO_ACTION', state);
}

/**
 * Intervention policy v1 — deterministic, rule-based, explainable.
 *
 * Deliberately NOT a model call: the learner must be able to predict and trust
 * the agent. `NO_ACTION` is a first-class answer and is the default.
 */
export function decideIntervention(
  input: DecideInterventionInput,
  configOverrides: Partial<InterventionPolicyConfig> = {},
): InterventionDecision {
  const config: InterventionPolicyConfig = resolvePolicyConfig(configOverrides);
  const { engineState, shownInterventions, now, recentEvents } = input;
  const state = engineState.state;

  // 1. Never become the distraction.
  if (shownInterventions.length >= config.maxInterventionsPerSession) {
    return decision('reason.budget', 'NO_ACTION', state);
  }

  // 2. A dismissed resume means the learner wants to be left alone.
  const lastDismissed = lastEventOfType(recentEvents, 'RESUME_DISMISSED');
  const sinceDismissed = msSince(lastDismissed?.at, now);
  const resumeIsPending = state === 'INTERRUPTED' && engineState.awaitingResume;
  if (
    sinceDismissed !== null &&
    sinceDismissed < config.dismissedResumeCooldownMs &&
    !resumeIsPending
  ) {
    return decision('reason.resume.dismissed', 'NO_ACTION', state);
  }

  // 3. The one interruption that always matters, and is never rate limited.
  if (resumeIsPending) {
    return decision('reason.resume.interruption', 'RESUME', state);
  }

  /*
   * 4. The learner asked. A request is not an interruption.
   *
   * The cooldown below exists to stop the agent speaking up unasked; this is the opposite of that, and
   * answering it late — because something unrelated was shown recently — is how a help button stops
   * being worth pressing. The budget in step 1 still applies, so asking repeatedly is not a way to be
   * shown something every few seconds.
   *
   * With no reason given this falls through to the state rules below: "they did not say" is not one of
   * the reasons and must not be answered as though it were.
   */
  const askedReason = unansweredStuckReason(recentEvents, shownInterventions);
  if (askedReason !== null) {
    return decision('reason.stuck', ACTION_FOR_STUCK_REASON[askedReason], state);
  }

  const candidate = candidateFor(engineState, input.currentTask, now, config);
  if (candidate.action === 'NO_ACTION') return candidate;

  // 5. Cooldown, except when the situation has become more urgent.
  const lastShown = shownInterventions[shownInterventions.length - 1];
  const sinceLastShown = msSince(lastShown?.shownAt, now);
  if (sinceLastShown !== null && sinceLastShown < config.cooldownMs && lastShown !== undefined) {
    const escalated = ACTION_PRIORITY[candidate.action] > ACTION_PRIORITY[lastShown.action];
    if (!escalated) {
      return decision('reason.cooldown', 'NO_ACTION', state);
    }
  }

  return candidate;
}

/** Converts a decision into a persisted intervention record. */
export function createIntervention(
  seed: { id: string; sessionId: string; at: string },
  decision: InterventionDecision,
): Intervention {
  return {
    id: seed.id,
    sessionId: seed.sessionId,
    at: seed.at,
    state: decision.state,
    action: decision.action,
    reason: decision.reason,
    shownAt: seed.at,
  };
}

export function estimatedMinutesFor(action: InterventionAction): number {
  return ACTION_MINUTES[action];
}
