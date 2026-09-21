import type {
  Course,
  DashboardSummary,
  InterventionOutcome,
  Intervention,
  LearningCheckpoint,
  LearningEvent,
  LearningSession,
  ResumeCardTiming,
  ResumePolicyConfig,
} from '@focusloop/shared-types';
import { evaluateResumeSuccess, resolveResumePolicyConfig } from '@focusloop/continuity';
import { averageResumeLatencyMs, summarizeOutcomes } from '@focusloop/intervention-policy';
import { buildRescuePlan, evaluateRescueSuccess } from '@focusloop/intervention-policy';

export interface BuildDashboardInput {
  readonly session: LearningSession | null;
  readonly course: Course | null;
  readonly outcomes: readonly InterventionOutcome[];
  readonly interventions?: readonly Intervention[];
  /**
   * Number of checkpoints stored for the session.
   *
   * An interruption is counted as "a moment we had to help the learner resume
   * from", which is exactly one checkpoint. Counting it from the event log
   * instead would miss every interruption that was detected by the time-based
   * tick rather than by an incoming event.
   */
  readonly checkpointCount: number;
  /** Timings and source facts used to rebuild resume success after a restart. */
  readonly resumeTimings?: readonly ResumeCardTiming[];
  readonly checkpoints?: readonly LearningCheckpoint[];
  readonly events?: readonly LearningEvent[];
  readonly resumePolicyConfig?: Partial<ResumePolicyConfig>;
  readonly rescueSuccessWindowMs?: number;
  readonly now: string;
}

export function emptyResumeSuccessSummary(): DashboardSummary['resumeSuccess'] {
  return {
    accepted: 0,
    succeeded: 0,
    expired: 0,
    pending: 0,
    rate: null,
  };
}

export function emptyRescueSuccessSummary(): DashboardSummary['rescueSuccess'] {
  return {
    accepted: 0,
    succeeded: 0,
    expired: 0,
    repeatedHelp: 0,
    pending: 0,
    rate: null,
  };
}

/** Rebuilds AG2 effectiveness from persisted facts; no renderer flag is trusted. */
export function summarizeRescueSuccess(input: {
  readonly interventions: readonly Intervention[];
  readonly outcomes: readonly InterventionOutcome[];
  readonly events: readonly LearningEvent[];
  readonly now: string;
  readonly rescueSuccessWindowMs?: number;
}): DashboardSummary['rescueSuccess'] {
  const outcomes = new Map(input.outcomes.map((outcome) => [outcome.interventionId, outcome]));
  const events = new Map(input.events.map((event) => [event.id, event]));
  const seen = new Set<string>();
  let accepted = 0;
  let succeeded = 0;
  let expired = 0;
  let repeatedHelp = 0;
  let pending = 0;

  for (const intervention of input.interventions) {
    if (seen.has(intervention.id) || intervention.answersRequestId === undefined) continue;
    seen.add(intervention.id);
    const outcome = outcomes.get(intervention.id);
    if (outcome?.acceptedAt === undefined || outcome.dismissed) continue;
    const request = events.get(intervention.answersRequestId);
    const payload = request?.payload as Record<string, unknown> | undefined;
    const taskId = typeof payload?.['taskId'] === 'string' ? payload['taskId'] : null;
    const plan = buildRescuePlan({
      interventionId: intervention.id,
      sessionId: intervention.sessionId,
      taskId,
      action: intervention.action,
    });
    if (plan === null) continue;
    accepted += 1;
    const evaluation = evaluateRescueSuccess({
      plan,
      outcome,
      events: input.events,
      now: input.now,
      ...(input.rescueSuccessWindowMs === undefined
        ? {}
        : { rescueSuccessWindowMs: input.rescueSuccessWindowMs }),
    });
    if (evaluation.status === 'succeeded') succeeded += 1;
    else if (evaluation.status === 'expired') expired += 1;
    else if (evaluation.status === 'repeated-help') repeatedHelp += 1;
    else pending += 1;
  }

  const evaluated = succeeded + expired + repeatedHelp;
  return {
    accepted,
    succeeded,
    expired,
    repeatedHelp,
    pending,
    rate: evaluated === 0 ? null : succeeded / evaluated,
  };
}

/**
 * Rebuilds resume success from facts in the store. No aggregate is persisted,
 * so this remains correct after a process restart and for a changed `now`.
 */
export function summarizeResumeSuccess(input: {
  readonly timings: readonly ResumeCardTiming[];
  readonly checkpoints: readonly LearningCheckpoint[];
  readonly events: readonly LearningEvent[];
  readonly now: string;
  readonly config?: Partial<ResumePolicyConfig>;
}): DashboardSummary['resumeSuccess'] {
  const config = resolveResumePolicyConfig(input.config);
  const checkpointsById = new Map(
    input.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]),
  );
  const seenCards = new Set<string>();
  let accepted = 0;
  let succeeded = 0;
  let expired = 0;
  let pending = 0;

  for (const timing of input.timings) {
    if (seenCards.has(timing.checkpointId)) continue;
    seenCards.add(timing.checkpointId);
    // A card that was only shown is still eligible for a future decision, but
    // it must not enter the accepted denominator (or be labelled pending).
    if (timing.acceptedAt === undefined || timing.dismissedAt !== undefined) continue;
    const checkpoint = checkpointsById.get(timing.checkpointId);
    if (checkpoint === undefined) continue;

    const result = evaluateResumeSuccess({
      checkpoint,
      timing,
      events: input.events,
      now: input.now,
      config,
    });
    if (result.status === 'succeeded') {
      accepted += 1;
      succeeded += 1;
    } else if (result.status === 'expired') {
      accepted += 1;
      expired += 1;
    } else if (result.status === 'pending') {
      accepted += 1;
      pending += 1;
    }
  }

  return {
    accepted,
    succeeded,
    expired,
    pending,
    // Pending cards have not reached a terminal outcome yet, so they are not
    // failures and must not dilute the observed success rate.
    rate: succeeded + expired === 0 ? null : succeeded / (succeeded + expired),
  };
}

export function buildDashboardSummary(input: BuildDashboardInput): DashboardSummary {
  const { session, course, outcomes, now } = input;

  if (session === null) {
    return {
      sessionId: null,
      courseTitle: null,
      sessionDurationMs: 0,
      tasksCompleted: 0,
      tasksTotal: 0,
      interruptCount: 0,
      averageResumeLatencyMs: null,
      resumeSuccess: emptyResumeSuccessSummary(),
      rescueSuccess: emptyRescueSuccessSummary(),
      interventionOutcomes: summarizeOutcomes([]),
    };
  }

  const startedMs = Date.parse(session.startedAt);
  const endedMs = session.endedAt === undefined ? Date.parse(now) : Date.parse(session.endedAt);
  const durationMs =
    Number.isFinite(startedMs) && Number.isFinite(endedMs) ? Math.max(0, endedMs - startedMs) : 0;

  return {
    sessionId: session.id,
    courseTitle: course?.title ?? null,
    sessionDurationMs: durationMs,
    tasksCompleted: session.completedTaskIds.length,
    tasksTotal: course?.microTasks.length ?? 0,
    interruptCount: Math.max(0, input.checkpointCount),
    averageResumeLatencyMs: averageResumeLatencyMs(outcomes),
    resumeSuccess: summarizeResumeSuccess({
      timings: input.resumeTimings ?? [],
      checkpoints: input.checkpoints ?? [],
      events: input.events ?? [],
      now,
      config: input.resumePolicyConfig,
    }),
    rescueSuccess: summarizeRescueSuccess({
      interventions: input.interventions ?? [],
      outcomes,
      events: input.events ?? [],
      now,
      rescueSuccessWindowMs: input.rescueSuccessWindowMs,
    }),
    interventionOutcomes: summarizeOutcomes(outcomes),
  };
}

/** Milliseconds as `m:ss`, used by the dashboard and the focus workspace. */
export function formatDuration(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const totalSeconds = Math.floor(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function formatLatency(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
