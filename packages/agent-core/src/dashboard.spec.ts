import { describe, expect, it } from 'vitest';
import {
  message,
  type LearningCheckpoint,
  type LearningEvent,
  type LearningSession,
  type Intervention,
  type InterventionOutcome,
} from '@focusloop/shared-types';
import { buildDashboardSummary, formatDuration, formatLatency } from './dashboard';
import { demoCourse } from './demo-course';

const T0 = '2026-01-01T00:00:00.000Z';

function session(overrides: Partial<LearningSession> = {}): LearningSession {
  return {
    id: 's1',
    courseId: 'course-red-black-trees',
    startedAt: T0,
    state: 'FOCUSED',
    completedTaskIds: [],
    updatedAt: T0,
    ...overrides,
  };
}

function checkpoint(id: string, taskId = 't1'): LearningCheckpoint {
  return {
    id,
    sessionId: 's1',
    conceptId: 'c1',
    conceptTitle: 'Concept',
    goal: 'Goal',
    mastered: [],
    unresolved: ['Question'],
    currentTaskId: taskId,
    currentTaskTitle: 'Task',
    currentStep: 0,
    frictionState: 'INTERRUPTED',
    nextBestAction: message('action.start.next'),
    createdAt: T0,
  };
}

function taskStarted(id: string, at: string, taskId = 't1'): LearningEvent {
  return {
    id,
    sessionId: 's1',
    at,
    type: 'TASK_STARTED',
    source: 'user',
    payload: { taskId },
  };
}

function rescueIntervention(id: string, requestId: string): Intervention {
  return {
    id,
    sessionId: 's1',
    at: T0,
    shownAt: T0,
    state: 'CONFUSED',
    action: 'HINT',
    reason: message('reason.stuck.went-wrong'),
    answersRequestId: requestId,
  };
}

function rescueOutcome(
  interventionId: string,
  acceptedAt: string,
  continuedAt?: string,
): InterventionOutcome {
  return {
    id: `outcome:${interventionId}`,
    interventionId,
    sessionId: 's1',
    at: acceptedAt,
    acceptedAt,
    ...(continuedAt === undefined ? {} : { continuedAt }),
    state: 'CONFUSED',
    action: 'HINT',
    accepted: true,
    dismissed: false,
    taskCompleted: false,
    resumeLatencyMs: null,
    quizOutcome: null,
  };
}

describe('buildDashboardSummary', () => {
  it('returns an empty summary with the full action list when there is no session', () => {
    const summary = buildDashboardSummary({
      session: null,
      course: null,
      outcomes: [],
      checkpointCount: 0,
      now: T0,
    });
    expect(summary.sessionId).toBeNull();
    expect(summary.interventionOutcomes.length).toBeGreaterThan(0);
    expect(summary.averageResumeLatencyMs).toBeNull();
  });

  it('measures the running duration while the session is open', () => {
    const summary = buildDashboardSummary({
      session: session(),
      course: demoCourse(),
      outcomes: [],
      checkpointCount: 0,
      now: '2026-01-01T00:03:00.000Z',
    });
    expect(summary.sessionDurationMs).toBe(180_000);
  });

  it('freezes the duration once the session ended', () => {
    const summary = buildDashboardSummary({
      session: session({ endedAt: '2026-01-01T00:02:00.000Z' }),
      course: demoCourse(),
      outcomes: [],
      checkpointCount: 0,
      now: '2026-01-01T09:00:00.000Z',
    });
    expect(summary.sessionDurationMs).toBe(120_000);
  });

  it('reports task progress against the course', () => {
    const summary = buildDashboardSummary({
      session: session({ completedTaskIds: ['rbt-t1', 'rbt-t2'] }),
      course: demoCourse(),
      outcomes: [],
      checkpointCount: 0,
      now: T0,
    });
    expect(summary).toMatchObject({ tasksCompleted: 2, tasksTotal: 5 });
  });

  it('counts one interruption per checkpoint, however the interruption was detected', () => {
    const summary = buildDashboardSummary({
      session: session(),
      course: demoCourse(),
      outcomes: [],
      checkpointCount: 3,
      now: T0,
    });
    expect(summary.interruptCount).toBe(3);
  });

  it('never reports a negative interruption count', () => {
    const summary = buildDashboardSummary({
      session: session(),
      course: demoCourse(),
      outcomes: [],
      checkpointCount: -5,
      now: T0,
    });
    expect(summary.interruptCount).toBe(0);
  });

  it('reports a null course title when the course is missing', () => {
    const summary = buildDashboardSummary({
      session: session(),
      course: null,
      outcomes: [],
      checkpointCount: 0,
      now: T0,
    });
    expect(summary.courseTitle).toBeNull();
    expect(summary.tasksTotal).toBe(0);
  });

  it('never reports a negative duration when the clock is behind', () => {
    const summary = buildDashboardSummary({
      session: session({ startedAt: '2026-01-02T00:00:00.000Z' }),
      course: demoCourse(),
      outcomes: [],
      checkpointCount: 0,
      now: T0,
    });
    expect(summary.sessionDurationMs).toBe(0);
  });

  it('rebuilds resume success with accepted denominator and excludes dismissals', () => {
    const summary = buildDashboardSummary({
      session: session(),
      course: demoCourse(),
      outcomes: [],
      checkpointCount: 4,
      now: '2026-01-01T00:10:00.000Z',
      resumePolicyConfig: { successWindowMs: 1_000 },
      checkpoints: [
        checkpoint('success'),
        checkpoint('expired', 't2'),
        checkpoint('pending'),
        checkpoint('dismissed'),
        checkpoint('shown-only'),
      ],
      resumeTimings: [
        {
          checkpointId: 'success',
          shownAt: T0,
          acceptedAt: '2026-01-01T00:01:00.000Z',
        },
        {
          checkpointId: 'expired',
          shownAt: T0,
          acceptedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          checkpointId: 'pending',
          shownAt: T0,
          acceptedAt: '2026-01-01T00:09:59.500Z',
        },
        {
          checkpointId: 'dismissed',
          shownAt: T0,
          dismissedAt: '2026-01-01T00:01:00.000Z',
        },
        { checkpointId: 'shown-only', shownAt: T0 },
      ],
      events: [
        taskStarted('e-success', '2026-01-01T00:01:01.000Z'),
        // Replayed event ids must not inflate success evidence.
        taskStarted('e-success', '2026-01-01T00:01:02.000Z'),
        // A different task is not evidence for this checkpoint.
        taskStarted('e-other-task', '2026-01-01T00:01:03.000Z', 't2'),
      ],
    });

    expect(summary.resumeSuccess).toEqual({
      accepted: 3,
      succeeded: 1,
      expired: 1,
      pending: 1,
      rate: 1 / 2,
    });
  });

  it('returns no rate when every accepted card is still pending', () => {
    const summary = buildDashboardSummary({
      session: session(),
      course: demoCourse(),
      outcomes: [],
      checkpointCount: 1,
      now: '2026-01-01T00:01:00.000Z',
      checkpoints: [checkpoint('pending-only')],
      resumeTimings: [
        {
          checkpointId: 'pending-only',
          shownAt: T0,
          acceptedAt: '2026-01-01T00:00:59.000Z',
        },
      ],
      events: [],
    });
    expect(summary.resumeSuccess).toEqual({
      accepted: 1,
      succeeded: 0,
      expired: 0,
      pending: 1,
      rate: null,
    });
  });

  it('rebuilds explicit rescue success and excludes proactive interventions', () => {
    const interventions = [
      rescueIntervention('success', 'help-success'),
      rescueIntervention('repeat', 'help-repeat'),
      rescueIntervention('pending', 'help-pending'),
      { ...rescueIntervention('proactive', 'unused'), answersRequestId: undefined },
    ];
    const outcomes = [
      rescueOutcome('success', T0, '2026-01-01T00:01:00.000Z'),
      rescueOutcome('repeat', T0),
      rescueOutcome('pending', '2026-01-01T00:09:59.500Z'),
      rescueOutcome('proactive', T0, '2026-01-01T00:01:00.000Z'),
    ];
    const request = (id: string, taskId: string, at: string): LearningEvent => ({
      id,
      sessionId: 's1',
      at,
      type: 'HELP_REQUESTED',
      source: 'user',
      payload: { taskId, reason: 'went-wrong' },
    });
    const events: LearningEvent[] = [
      request('help-success', 'success-task', T0),
      request('help-repeat', 'repeat-task', T0),
      request('help-pending', 'pending-task', '2026-01-01T00:09:59.000Z'),
      {
        id: 'asked-again',
        sessionId: 's1',
        at: '2026-01-01T00:01:00.000Z',
        type: 'HELP_REQUESTED',
        source: 'user',
        payload: { taskId: 'repeat-task', reason: 'went-wrong' },
      },
    ];
    const summary = buildDashboardSummary({
      session: session(),
      course: demoCourse(),
      outcomes,
      interventions,
      events,
      checkpointCount: 0,
      now: '2026-01-01T00:10:00.000Z',
    });

    expect(summary.rescueSuccess).toEqual({
      accepted: 3,
      succeeded: 1,
      expired: 0,
      repeatedHelp: 1,
      pending: 1,
      rate: 1 / 2,
    });
  });
});

describe('formatting helpers', () => {
  it('formats durations as m:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(65_000)).toBe('1:05');
    expect(formatDuration(Number.NaN)).toBe('0:00');
  });

  it('formats latencies for humans', () => {
    expect(formatLatency(null)).toBe('—');
    expect(formatLatency(250)).toBe('250 ms');
    expect(formatLatency(2_500)).toBe('2.5 s');
  });
});
