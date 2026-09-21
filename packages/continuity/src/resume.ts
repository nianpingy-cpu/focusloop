import type {
  Course,
  EvaluateResumeSuccessInput,
  LearningCheckpoint,
  LearningEvent,
  LearningSession,
  LocalizedMessage,
  MicroTask,
  ResumeCard,
  ResumePolicyConfig,
  ResumePolicyOverrides,
  ResumeSuccessResult,
  ResumeVariant,
} from '@focusloop/shared-types';
import { DEFAULT_RESUME_POLICY_CONFIG, message } from '@focusloop/shared-types';

export interface BuildResumeCardInput {
  readonly checkpoint: LearningCheckpoint;
  readonly session: LearningSession;
  readonly course: Course;
  readonly recentEvents: readonly LearningEvent[];
  readonly now: string;
  readonly config?: ResumePolicyOverrides;
}

const DEFAULT_ESTIMATED_MINUTES = 5;
const MAX_COMPLETED_ITEMS = 3;
const MAX_UNRESOLVED_ITEMS = 3;
const SHORT_CARD_ITEMS = 1;
const LONG_REFRESHER_SECONDS = '30s';

export function resolveResumePolicyConfig(
  overrides: ResumePolicyOverrides = {},
): ResumePolicyConfig {
  const config: ResumePolicyConfig = { ...DEFAULT_RESUME_POLICY_CONFIG, ...overrides };
  if (
    !Number.isFinite(config.shortThresholdMs) ||
    !Number.isFinite(config.longThresholdMs) ||
    !Number.isFinite(config.successWindowMs) ||
    config.shortThresholdMs < 0 ||
    config.longThresholdMs < 0 ||
    config.successWindowMs < 0
  ) {
    throw new RangeError('ResumePolicyConfig values must be non-negative finite numbers');
  }
  if (config.shortThresholdMs > config.longThresholdMs) {
    throw new RangeError('ResumePolicyConfig.shortThresholdMs must not exceed longThresholdMs');
  }
  return config;
}

/** Classifies a gap; an unknown gap conservatively receives the medium card. */
export function classifyResumeGap(
  gapMs: number | null,
  overrides: ResumePolicyOverrides = {},
): ResumeVariant {
  const config = resolveResumePolicyConfig(overrides);
  if (gapMs === null || !Number.isFinite(gapMs) || gapMs < 0) return 'medium';
  if (gapMs < config.shortThresholdMs) return 'short';
  if (gapMs >= config.longThresholdMs) return 'long';
  return 'medium';
}

/**
 * Computes the interruption gap without trusting array order or malformed payloads.
 * The latest interruption marker wins: a return/end supplies its recorded duration, while a newer
 * left/start marker is still open and is measured to now.
 */
export function deriveResumeGapMs(events: readonly LearningEvent[], now: string): number | null {
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return null;

  const completed = events
    .map((event, index) => ({ event, index, atMs: Date.parse(event.at) }))
    .filter(({ event, atMs }) => {
      if (!Number.isFinite(atMs) || atMs > nowMs) return false;
      if (event.type !== 'TAB_RETURNED' && event.type !== 'IDLE_ENDED') return false;
      const value = interruptionDuration(event);
      return Number.isFinite(value) && value >= 0;
    })
    .sort((a, b) => a.atMs - b.atMs || a.index - b.index);
  const latestCompleted = completed[completed.length - 1];

  const starts = events
    .map((event, index) => ({ event, index, atMs: Date.parse(event.at) }))
    .filter(
      ({ event, atMs }) =>
        Number.isFinite(atMs) &&
        atMs <= nowMs &&
        (event.type === 'TAB_LEFT' || event.type === 'IDLE_STARTED'),
    )
    .sort((a, b) => a.atMs - b.atMs || a.index - b.index);
  const latestStart = starts[starts.length - 1];
  if (
    latestCompleted !== undefined &&
    (latestStart === undefined ||
      latestCompleted.atMs > latestStart.atMs ||
      (latestCompleted.atMs === latestStart.atMs && latestCompleted.index > latestStart.index))
  ) {
    return interruptionDuration(latestCompleted.event);
  }
  if (latestStart === undefined) return null;
  const gapMs = nowMs - latestStart.atMs;
  return Number.isFinite(gapMs) && gapMs >= 0 ? gapMs : null;
}

function interruptionDuration(event: LearningEvent): number {
  if (event.type === 'TAB_RETURNED') return event.payload.awayMs;
  if (event.type === 'IDLE_ENDED') return event.payload.idleMs;
  return Number.NaN;
}

/**
 * Turns a checkpoint plus the events around the interruption into the small
 * card that gets the learner back to their cognitive position.
 *
 * Rule-based and deterministic on purpose — no LLM is involved in resume.
 */
export function buildResumeCard(input: BuildResumeCardInput): ResumeCard {
  const { checkpoint, course, recentEvents, session, now } = input;
  const config = resolveResumePolicyConfig(input.config);
  const gapMs = deriveResumeGapMs(recentEvents, now);
  const variant = classifyResumeGap(gapMs, config);
  const tasks = [...course.microTasks].sort((a, b) => a.order - b.order);
  const currentTask: MicroTask | null =
    tasks.find((task) => task.id === checkpoint.currentTaskId) ?? null;

  const completedSet = new Set(session.completedTaskIds);
  const completedTaskTitles = tasks
    .filter((task) => completedSet.has(task.id))
    .map((task) => task.title)
    .slice(-MAX_COMPLETED_ITEMS);

  const completed =
    completedTaskTitles.length > 0
      ? completedTaskTitles
      : [...checkpoint.mastered].slice(-MAX_COMPLETED_ITEMS);
  const itemLimit = variant === 'short' ? SHORT_CARD_ITEMS : MAX_COMPLETED_ITEMS;

  return {
    variant,
    gapMs,
    refresher:
      variant === 'long'
        ? message('resume.refresher.long', { seconds: LONG_REFRESHER_SECONDS.replace('s', '') })
        : null,
    title:
      currentTask === null
        ? message('resume.title.course', { course: course.title })
        : message('resume.title.task', { task: currentTask.title }),
    lastContext: describeLastContext(checkpoint, recentEvents, gapMs),
    completed: completed.slice(-itemLimit),
    unresolved: [...checkpoint.unresolved].slice(-Math.min(itemLimit, MAX_UNRESOLVED_ITEMS)),
    nextAction: checkpoint.nextBestAction,
    estimatedMinutes: clampMinutes(currentTask?.estimatedMinutes),
  };
}

function describeLastContext(
  checkpoint: LearningCheckpoint,
  recentEvents: readonly LearningEvent[],
  gapMs: number | null,
): LocalizedMessage {
  const base = { concept: checkpoint.conceptTitle, goal: checkpoint.goal };
  const interruption = findLastInterruption(recentEvents);
  if (interruption === null) return message('resume.context.plain', base);

  const awayMs = gapMs ?? interruption.awayMs;
  if (awayMs === null || awayMs <= 0) return message('resume.context.moment', base);

  return message('resume.context.away', { ...base, duration: formatDuration(awayMs) });
}

const SUCCESS_EVENT_TYPES = new Set<LearningEvent['type']>([
  'TASK_STARTED',
  'TASK_COMPLETED',
  'QUIZ_CORRECT',
  'QUIZ_INCORRECT',
  'HELP_REQUESTED',
]);

/**
 * Evaluates resume success over a bounded, inclusive window. Dismissed cards are intentionally
 * outside the success denominator, while duplicate event ids are counted only once.
 */
export function evaluateResumeSuccess(input: EvaluateResumeSuccessInput): ResumeSuccessResult {
  const config = resolveResumePolicyConfig(input.config);
  const acceptedAtMs = Date.parse(input.timing.acceptedAt ?? '');
  const nowMs = Date.parse(input.now);
  const dismissed = input.timing.dismissedAt !== undefined;
  if (dismissed) {
    return {
      status: 'dismissed',
      evidenceEventIds: [],
      acceptedAt: input.timing.acceptedAt ?? null,
      windowEndsAt: validWindowEnd(acceptedAtMs, config.successWindowMs),
    };
  }
  if (!Number.isFinite(acceptedAtMs)) {
    return {
      status: 'pending',
      evidenceEventIds: [],
      acceptedAt: null,
      windowEndsAt: null,
    };
  }

  const windowEndMs = acceptedAtMs + config.successWindowMs;
  const evidenceEventIds: string[] = [];
  const seenIds = new Set<string>();
  for (const event of input.events) {
    if (seenIds.has(event.id)) continue;
    if (!SUCCESS_EVENT_TYPES.has(event.type) || event.sessionId !== input.checkpoint.sessionId)
      continue;
    const eventMs = Date.parse(event.at);
    if (
      !Number.isFinite(eventMs) ||
      !Number.isFinite(nowMs) ||
      eventMs > nowMs ||
      eventMs <= acceptedAtMs ||
      eventMs > windowEndMs
    )
      continue;
    if (!isCurrentTaskEvidence(event, input.checkpoint.currentTaskId)) continue;
    seenIds.add(event.id);
    evidenceEventIds.push(event.id);
  }

  const status =
    evidenceEventIds.length > 0
      ? 'succeeded'
      : Number.isFinite(nowMs) && nowMs >= windowEndMs
        ? 'expired'
        : 'pending';
  return {
    status,
    evidenceEventIds,
    acceptedAt: input.timing.acceptedAt ?? null,
    windowEndsAt: new Date(windowEndMs).toISOString(),
  };
}

function validWindowEnd(acceptedAtMs: number, windowMs: number): string | null {
  return Number.isFinite(acceptedAtMs) ? new Date(acceptedAtMs + windowMs).toISOString() : null;
}

function isCurrentTaskEvidence(event: LearningEvent, taskId: string): boolean {
  if (
    event.type !== 'TASK_STARTED' &&
    event.type !== 'TASK_COMPLETED' &&
    event.type !== 'QUIZ_CORRECT' &&
    event.type !== 'QUIZ_INCORRECT' &&
    event.type !== 'HELP_REQUESTED'
  ) {
    return false;
  }
  return event.payload.taskId === taskId;
}

function findLastInterruption(
  recentEvents: readonly LearningEvent[],
): { awayMs: number | null } | null {
  for (let index = recentEvents.length - 1; index >= 0; index -= 1) {
    const event = recentEvents[index];
    if (event === undefined) continue;
    if (event.type === 'TAB_RETURNED') return { awayMs: event.payload.awayMs };
    if (event.type === 'IDLE_ENDED') return { awayMs: event.payload.idleMs };
  }
  return null;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.round(totalSeconds / 60);
  return `${minutes} min`;
}

function clampMinutes(minutes: number | undefined): number {
  if (minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) {
    return DEFAULT_ESTIMATED_MINUTES;
  }
  return Math.min(60, Math.round(minutes));
}

/** Milliseconds between the card being shown and accepted, or null. */
export function computeResumeLatencyMs(
  shownAt: string,
  acceptedAt: string | undefined,
): number | null {
  if (acceptedAt === undefined) return null;
  const delta = Date.parse(acceptedAt) - Date.parse(shownAt);
  return Number.isFinite(delta) && delta >= 0 ? delta : null;
}

export function sessionTitle(session: LearningSession, course: Course): string {
  return `${course.title} · ${new Date(session.startedAt).toISOString().slice(0, 10)}`;
}
