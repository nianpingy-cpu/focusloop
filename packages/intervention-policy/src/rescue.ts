import type {
  Intervention,
  InterventionAction,
  InterventionDecision,
  RescueAction,
  RescuePlan,
  RescueSuccessEvaluation,
  RescueView,
  EvaluateRescueSuccessInput,
} from '@focusloop/shared-types';
import { isRescueAction, message, RESCUE_ACTIONS } from '@focusloop/shared-types';
import { DEFAULT_POLICY_CONFIG } from './config';

/** The accepted input shape for constructing a rescue plan from a decision. */
export interface BuildRescuePlanInput {
  readonly interventionId: string;
  readonly sessionId: string;
  readonly taskId?: string | null;
  readonly action?: InterventionAction;
  readonly decision?: InterventionDecision;
  readonly intervention?: Pick<Intervention, 'id' | 'sessionId' | 'action'>;
}

export interface RescuePlanSeed {
  readonly interventionId: string;
  readonly sessionId: string;
  readonly taskId?: string | null;
}

const MINUTES: Record<RescueAction, number> = {
  MICRO_START: 5,
  SIMPLIFY: 3,
  HINT: 2,
  EXAMPLE: 4,
  BREAK: 5,
};

/**
 * Builds the small, offline rescue plan shown after a deterministic decision.
 * Unknown/non-rescue actions intentionally return null: QUESTION and RESUME are not AG2 plans.
 */
export function buildRescuePlan(input: BuildRescuePlanInput): RescuePlan | null;
export function buildRescuePlan(
  decision: InterventionDecision,
  seed: RescuePlanSeed,
): RescuePlan | null;
export function buildRescuePlan(
  inputOrDecision: BuildRescuePlanInput | InterventionDecision,
  seed?: RescuePlanSeed,
): RescuePlan | null {
  const input = isDecision(inputOrDecision)
    ? {
        interventionId: seed?.interventionId ?? '',
        sessionId: seed?.sessionId ?? '',
        taskId: seed?.taskId,
        action: inputOrDecision.action,
        decision: inputOrDecision,
      }
    : inputOrDecision;
  const action = input.action ?? input.decision?.action ?? input.intervention?.action;
  if (!isRescueAction(action)) return null;

  const steps = stepsFor(action);
  const interventionId = input.interventionId ?? input.intervention?.id;
  const sessionId = input.sessionId ?? input.intervention?.sessionId;
  // Empty identifiers are not usable seeds.  In particular, do not let an
  // explicitly empty primary id silently fall back to an embedded one.
  if (
    typeof interventionId !== 'string' ||
    interventionId.length === 0 ||
    typeof sessionId !== 'string' ||
    sessionId.length === 0
  ) {
    return null;
  }

  return {
    interventionId,
    sessionId,
    taskId: input.taskId ?? null,
    action,
    steps,
    estimatedMinutes: MINUTES[action],
    source: 'deterministic-local',
  };
}

/** Combines the normal policy decision with its optional local rescue plan. */
export function buildRescueView(
  decision: InterventionDecision,
  seed: RescuePlanSeed,
  phase: 'offered' | 'active' = 'offered',
): RescueView {
  return {
    interventionId: seed.interventionId,
    sessionId: seed.sessionId,
    decision,
    plan: phase === 'active' ? buildRescuePlan(decision, seed) : null,
    phase,
  };
}

/**
 * Evaluates one rescue attempt from immutable event-log facts.
 *
 * The observation window is `(acceptedAt, acceptedAt + rescueSuccessWindowMs]`. Events are accepted
 * only from the same session and task, are never allowed to come from the future, and duplicate ids
 * are ignored before classification. A second help request is deliberately reported separately from
 * progress evidence, and takes precedence because it means the rescue did not hold.
 */
export function evaluateRescueSuccess(input: EvaluateRescueSuccessInput): RescueSuccessEvaluation {
  const windowMs = input.rescueSuccessWindowMs ?? DEFAULT_POLICY_CONFIG.rescueSuccessWindowMs;
  if (!Number.isFinite(windowMs) || windowMs < 0) {
    throw new RangeError('rescueSuccessWindowMs must be a non-negative finite number');
  }

  const acceptedAt = acceptedAtFor(input);
  const acceptedAtMs = Date.parse(acceptedAt ?? '');
  const nowMs = Date.parse(input.now);
  const windowEndsAt = Number.isFinite(acceptedAtMs)
    ? new Date(acceptedAtMs + windowMs).toISOString()
    : null;
  const empty = {
    interventionId: input.plan.interventionId,
    sessionId: input.plan.sessionId,
    taskId: input.plan.taskId,
    acceptedAt,
    windowEndsAt,
    evidenceEventIds: [] as readonly string[],
    repeatedHelpEventIds: [] as readonly string[],
  };

  if (!Number.isFinite(acceptedAtMs)) return { ...empty, status: 'pending' };

  const evidenceEventIds: string[] = [];
  const repeatedHelpEventIds: string[] = [];
  const seenIds = new Set<string>();
  const windowEndMs = acceptedAtMs + windowMs;

  for (const event of input.events) {
    if (seenIds.has(event.id)) continue;
    seenIds.add(event.id);
    if (event.sessionId !== input.plan.sessionId) continue;
    const eventMs = Date.parse(event.at);
    if (
      !Number.isFinite(eventMs) ||
      !Number.isFinite(nowMs) ||
      eventMs > nowMs ||
      eventMs <= acceptedAtMs ||
      eventMs > windowEndMs ||
      !matchesTask(event, input.plan.taskId)
    ) {
      continue;
    }

    if (event.type === 'HELP_REQUESTED') {
      repeatedHelpEventIds.push(event.id);
    } else if (isProgressEvent(event.type)) {
      evidenceEventIds.push(event.id);
    }
  }

  const continuedAtMs = Date.parse(input.outcome?.continuedAt ?? '');
  const continuedInWindow =
    Number.isFinite(continuedAtMs) &&
    Number.isFinite(nowMs) &&
    continuedAtMs <= nowMs &&
    continuedAtMs > acceptedAtMs &&
    continuedAtMs <= windowEndMs;
  const status =
    repeatedHelpEventIds.length > 0
      ? 'repeated-help'
      : continuedInWindow || evidenceEventIds.length > 0
        ? 'succeeded'
        : Number.isFinite(nowMs) && nowMs >= windowEndMs
          ? 'expired'
          : 'pending';
  return { ...empty, status, evidenceEventIds, repeatedHelpEventIds };
}

/** Alias retained for callers that use the shorter policy verb. */
export const evaluateRescue = evaluateRescueSuccess;

function isDecision(
  value: BuildRescuePlanInput | InterventionDecision,
): value is InterventionDecision {
  return 'state' in value && 'reason' in value && 'confidence' in value;
}

function stepsFor(action: RescueAction): readonly ReturnType<typeof message>[] {
  // Existing domain keys are intentionally reused. This contract can ship offline without requiring
  // a simultaneous renderer translation change; every descriptor remains a normal LocalizedMessage.
  switch (action) {
    case 'MICRO_START':
      return [message('rescue.microStart.first')];
    case 'SIMPLIFY':
      return [
        message('rescue.simplify.identify'),
        message('rescue.simplify.first'),
        message('rescue.simplify.check'),
      ];
    case 'HINT':
      return [message('rescue.hint.action'), message('rescue.hint.condition')];
    case 'EXAMPLE':
      return [message('rescue.example.pattern'), message('rescue.example.apply')];
    case 'BREAK':
      return [message('rescue.break.pause'), message('rescue.break.return')];
  }
}

function acceptedAtFor(input: EvaluateRescueSuccessInput): string | null {
  const outcome = input.outcome;
  const acceptedAt = input.acceptedAt ?? outcome?.acceptedAt;
  if (acceptedAt !== undefined) return acceptedAt;
  if (outcome?.accepted === true && outcome.dismissed !== true) return outcome.at;
  return null;
}

function isProgressEvent(type: string): boolean {
  return type === 'TASK_COMPLETED' || type === 'QUIZ_CORRECT';
}

function matchesTask(
  event: EvaluateRescueSuccessInput['events'][number],
  taskId: string | null,
): boolean {
  const eventTaskId = 'taskId' in event.payload ? event.payload.taskId : undefined;
  return taskId === null ? eventTaskId === undefined : eventTaskId === taskId;
}

// Keep this import-time assertion near the map so accidental action expansion cannot silently omit a
// local plan. It has no runtime side effects and is erased by TypeScript.
const _allRescueActions: readonly RescueAction[] = RESCUE_ACTIONS;
void _allRescueActions;
