import { buildResumeCard, classifyResumeGap, evaluateResumeSuccess } from '@focusloop/continuity';
import type {
  Course,
  LearningCheckpoint,
  LearningEvent,
  LearningSession,
  LocalizedMessage,
  ResumeSuccessStatus,
} from '@focusloop/shared-types';
import type { JsonObject, JsonValue } from './scenario';

/** The serialisable contract implemented by the AG5 continuity policy. */
export type ResumeVariant = 'short' | 'medium' | 'long';
export type ResumeStatus = Exclude<ResumeSuccessStatus, 'dismissed'>;

export interface ResumeSummary {
  readonly title: string;
  readonly detail: string;
  readonly nextAction: string;
}

export interface Ag5ResumeOutput {
  readonly variant: ResumeVariant;
  readonly gapMs: number | null;
  readonly refresherRequired: boolean;
  readonly status: ResumeStatus;
  readonly summary: ResumeSummary;
}

/** JSON input contract for the pure AG5 policy. Unknown fields must be ignored by adapters. */
export interface Ag5ResumeInput {
  readonly gapMs: number | null;
  readonly now: string;
  readonly checkpoint: {
    readonly conceptTitle: string;
    readonly currentTaskTitle: string;
    readonly currentStep: number;
    readonly nextAction: string;
  };
  readonly interruptionEvents: readonly {
    readonly id: string;
    readonly type: 'INTERRUPTION_DETECTED' | 'RESUME_OFFERED';
  }[];
  readonly evidenceEvents: readonly {
    readonly id: string;
    readonly type:
      'TASK_STARTED' | 'TASK_COMPLETED' | 'QUIZ_CORRECT' | 'QUIZ_INCORRECT' | 'HELP_REQUESTED';
    readonly at: string;
    readonly taskId: string;
  }[];
  readonly success: {
    readonly shownAt: string;
    readonly acceptedAt?: string;
  };
}

/** Adapter seam for the continuity implementation. */
export type Ag5ResumeAdapter = (input: Ag5ResumeInput) => Ag5ResumeOutput;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: JsonValue | undefined, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`AG5 fixture ${field} must be a string`);
  }
  return value;
}

function numberValue(value: JsonValue | undefined, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`AG5 fixture ${field} must be a number`);
  }
  return value;
}

function optionalString(value: JsonValue | undefined, field: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, field);
}

/** Decode a version-one JSON fixture into the adapter contract. */
export function parseAg5Input(input: JsonValue): Ag5ResumeInput {
  if (!isRecord(input)) throw new Error('AG5 fixture input must be an object');
  const checkpointValue = input['checkpoint'];
  if (!isRecord(checkpointValue)) throw new Error('AG5 fixture checkpoint must be an object');
  const successValue = input['success'];
  if (!isRecord(successValue)) throw new Error('AG5 fixture success must be an object');
  const eventsValue = input['interruptionEvents'];
  if (!Array.isArray(eventsValue))
    throw new Error('AG5 fixture interruptionEvents must be an array');
  const evidenceValue = input['evidenceEvents'];
  if (!Array.isArray(evidenceValue)) throw new Error('AG5 fixture evidenceEvents must be an array');

  const interruptionEvents = eventsValue.map((event, index) => {
    if (!isRecord(event)) throw new Error(`AG5 fixture event ${index} must be an object`);
    const type = stringValue(event['type'], `event ${index}.type`);
    if (type !== 'INTERRUPTION_DETECTED' && type !== 'RESUME_OFFERED') {
      throw new Error(`AG5 fixture event ${index}.type is unsupported`);
    }
    const eventType: 'INTERRUPTION_DETECTED' | 'RESUME_OFFERED' = type;
    return { id: stringValue(event['id'], `event ${index}.id`), type: eventType };
  });

  const evidenceEvents = evidenceValue.map((event, index) => {
    if (!isRecord(event)) throw new Error(`AG5 fixture evidence event ${index} must be an object`);
    const type = stringValue(event['type'], `evidence event ${index}.type`);
    if (
      type !== 'TASK_STARTED' &&
      type !== 'TASK_COMPLETED' &&
      type !== 'QUIZ_CORRECT' &&
      type !== 'QUIZ_INCORRECT' &&
      type !== 'HELP_REQUESTED'
    ) {
      throw new Error(`AG5 fixture evidence event ${index}.type is unsupported`);
    }
    const eventType:
      'TASK_STARTED' | 'TASK_COMPLETED' | 'QUIZ_CORRECT' | 'QUIZ_INCORRECT' | 'HELP_REQUESTED' =
      type;
    return {
      id: stringValue(event['id'], `evidence event ${index}.id`),
      type: eventType,
      at: stringValue(event['at'], `evidence event ${index}.at`),
      taskId: stringValue(event['taskId'], `evidence event ${index}.taskId`),
    };
  });

  const gapValue = input['gapMs'];
  const gapMs = gapValue === null ? null : numberValue(gapValue, 'gapMs');
  if (gapMs !== null && gapMs < 0) throw new Error('AG5 fixture gapMs must be non-negative');
  const acceptedAt = optionalString(successValue['acceptedAt'], 'success.acceptedAt');

  return {
    gapMs,
    now: stringValue(input['now'], 'now'),
    checkpoint: {
      conceptTitle: stringValue(checkpointValue['conceptTitle'], 'checkpoint.conceptTitle'),
      currentTaskTitle: stringValue(
        checkpointValue['currentTaskTitle'],
        'checkpoint.currentTaskTitle',
      ),
      currentStep: numberValue(checkpointValue['currentStep'], 'checkpoint.currentStep'),
      nextAction: stringValue(checkpointValue['nextAction'], 'checkpoint.nextAction'),
    },
    interruptionEvents,
    evidenceEvents,
    success: {
      shownAt: stringValue(successValue['shownAt'], 'success.shownAt'),
      ...(acceptedAt === undefined ? {} : { acceptedAt }),
    },
  };
}

/** Convert a JSON fixture to the real continuity package's pure resume outputs. */
export function buildContinuityResume(input: Ag5ResumeInput): Ag5ResumeOutput {
  const checkpoint = makeCheckpoint(input);
  const course = makeCourse(input);
  const session = makeSession();
  const recentEvents = makeInterruptionEvents(input);
  const card = buildResumeCard({ checkpoint, course, session, recentEvents, now: input.now });
  const variant = classifyResumeGap(card.gapMs);
  // Success is intentionally based only on actual learning evidence events. There is no
  // completedAt shortcut in the fixture contract.
  const success = evaluateResumeSuccess({
    checkpoint,
    timing: {
      checkpointId: checkpoint.id,
      shownAt: input.success.shownAt,
      ...(input.success.acceptedAt === undefined ? {} : { acceptedAt: input.success.acceptedAt }),
    },
    events: makeEvidenceEvents(input),
    now: input.now,
  });

  return {
    variant,
    gapMs: card.gapMs,
    refresherRequired: card.refresher !== null,
    status: success.status as ResumeStatus,
    summary: {
      title: card.title.key,
      detail: card.lastContext.key,
      nextAction: card.nextAction.key,
    },
  };
}

/** Run an adapter against a JSON fixture while keeping the boundary pure and synchronous. */
export function runAg5Adapter(
  input: JsonValue,
  adapter: Ag5ResumeAdapter = buildContinuityResume,
): JsonValue {
  return adapter(parseAg5Input(input)) as unknown as JsonValue;
}

function makeCheckpoint(input: Ag5ResumeInput): LearningCheckpoint {
  return {
    id: 'cp-ag5',
    sessionId: 'session-ag5',
    conceptId: 'concept-ag5',
    conceptTitle: input.checkpoint.conceptTitle,
    goal: input.checkpoint.currentTaskTitle,
    mastered: [],
    unresolved: [input.checkpoint.conceptTitle],
    currentTaskId: 'task-ag5',
    currentTaskTitle: input.checkpoint.currentTaskTitle,
    currentStep: input.checkpoint.currentStep,
    frictionState: 'FOCUSED',
    nextBestAction: messageFor(input.checkpoint.nextAction),
    createdAt: '2026-09-21T00:00:00.000Z',
  };
}

function makeCourse(input: Ag5ResumeInput): Course {
  return {
    id: 'course-ag5',
    title: input.checkpoint.conceptTitle,
    description: '',
    concepts: [
      {
        id: 'concept-ag5',
        title: input.checkpoint.conceptTitle,
        summary: '',
        order: 0,
        keyPoints: [],
      },
    ],
    microTasks: [
      {
        id: 'task-ag5',
        courseId: 'course-ag5',
        conceptId: 'concept-ag5',
        title: input.checkpoint.currentTaskTitle,
        instructions: '',
        kind: 'read',
        estimatedMinutes: 3,
        order: 0,
      },
    ],
    quizzes: [],
  };
}

function makeSession(): LearningSession {
  return {
    id: 'session-ag5',
    courseId: 'course-ag5',
    startedAt: '2026-09-21T00:00:00.000Z',
    state: 'FOCUSED',
    completedTaskIds: [],
    updatedAt: '2026-09-21T00:00:00.000Z',
  };
}

function makeInterruptionEvents(input: Ag5ResumeInput): LearningEvent[] {
  if (input.gapMs === null) return [];
  return input.interruptionEvents.map((event, index) => ({
    id: event.id,
    sessionId: 'session-ag5',
    at: `2026-09-21T00:0${index}:00.000Z`,
    type: 'TAB_RETURNED',
    source: 'system',
    payload: { awayMs: input.gapMs },
  })) as LearningEvent[];
}

function makeEvidenceEvents(input: Ag5ResumeInput): LearningEvent[] {
  return input.evidenceEvents.map((event) => ({
    id: event.id,
    sessionId: 'session-ag5',
    at: event.at,
    type: event.type,
    source: 'user',
    payload: { taskId: event.taskId },
  })) as LearningEvent[];
}

function messageFor(value: string): LocalizedMessage {
  return { key: 'action.read.summarise', params: { title: value } };
}
