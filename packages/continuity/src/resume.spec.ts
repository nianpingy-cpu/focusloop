import { describe, expect, it } from 'vitest';
import type { LearningEvent, ResumeCardTiming } from '@focusloop/shared-types';
import { createInitialState, type StateEngineState } from '@focusloop/learning-state';
import { buildCheckpoint } from './checkpoint';
import {
  buildResumeCard,
  classifyResumeGap,
  computeResumeLatencyMs,
  deriveResumeGapMs,
  evaluateResumeSuccess,
  sessionTitle,
} from './resume';
import { detectInterruption, isAwayOrIdle, shouldOfferResume } from './interruption';
import { tinyCourse, tinySession } from './fixtures';

const T0 = '2026-01-01T00:00:00.000Z';
const T1 = '2026-01-01T00:05:00.000Z';

function tabReturned(awayMs: number): LearningEvent {
  return {
    id: 'e-return',
    sessionId: 'session-tiny',
    at: T1,
    type: 'TAB_RETURNED',
    source: 'extension',
    payload: { awayMs },
  };
}

function checkpointFor(engineState: StateEngineState) {
  return buildCheckpoint({
    session: tinySession(),
    course: tinyCourse(),
    engineState,
    now: T1,
  });
}

describe('buildResumeCard', () => {
  it('summarises where the learner was and what comes next', () => {
    const engineState: StateEngineState = {
      ...createInitialState(T0),
      state: 'INTERRUPTED',
      currentTaskId: 't2',
      lastActiveTaskId: 't2',
      completedTaskIds: ['t1'],
      awaitingResume: true,
    };
    const card = buildResumeCard({
      checkpoint: checkpointFor(engineState),
      session: tinySession({ completedTaskIds: ['t1'] }),
      course: tinyCourse(),
      recentEvents: [tabReturned(30_000)],
      now: T1,
    });

    expect(card.title).toEqual({ key: 'resume.title.task', params: { task: 'Practise one' } });
    expect(card.completed).toEqual(['Read one']);
    expect(card.unresolved).toEqual(['Concept one']);
    expect(card.nextAction).toEqual({
      key: 'action.practice.example',
      params: { title: 'Practise one' },
    });
    expect(card.estimatedMinutes).toBe(6);
    expect(card.lastContext.key).toBe('resume.context.away');
    expect(card.lastContext.params).toMatchObject({
      concept: 'Concept one',
      goal: 'Practise one',
      duration: '30s',
    });
  });

  it('reports idle-based interruptions too', () => {
    const engineState: StateEngineState = {
      ...createInitialState(T0),
      state: 'INTERRUPTED',
      currentTaskId: 't2',
      completedTaskIds: ['t1'],
    };
    const card = buildResumeCard({
      checkpoint: checkpointFor(engineState),
      session: tinySession({ completedTaskIds: ['t1'] }),
      course: tinyCourse(),
      recentEvents: [
        {
          id: 'e-idle',
          sessionId: 'session-tiny',
          at: T1,
          type: 'IDLE_ENDED',
          source: 'extension',
          payload: { idleMs: 180_000 },
        },
      ],
      now: T1,
    });
    expect(card.lastContext.params['duration']).toBe('3 min');
  });

  it('works when no interruption event is present', () => {
    const card = buildResumeCard({
      checkpoint: checkpointFor(createInitialState(T0)),
      session: tinySession(),
      course: tinyCourse(),
      recentEvents: [],
      now: T1,
    });
    expect(card.lastContext.key).toBe('resume.context.plain');
    expect(card.lastContext.params['goal']).toBeDefined();
    expect(card.completed).toEqual([]);
  });

  it('falls back to a sane estimate when the task has no duration', () => {
    const course = tinyCourse();
    const card = buildResumeCard({
      checkpoint: checkpointFor(createInitialState(T0)),
      session: tinySession(),
      course: {
        ...course,
        microTasks: course.microTasks.map((task) => ({ ...task, estimatedMinutes: 0 })),
      },
      recentEvents: [],
      now: T1,
    });
    expect(card.estimatedMinutes).toBe(5);
  });

  it('never reports more than three completed items', () => {
    const course = tinyCourse();
    const card = buildResumeCard({
      checkpoint: checkpointFor({
        ...createInitialState(T0),
        completedTaskIds: ['t1', 't2', 't3'],
      }),
      session: tinySession({ completedTaskIds: ['t1', 't2', 't3'] }),
      course,
      recentEvents: [],
      now: T1,
    });
    expect(card.completed.length).toBeLessThanOrEqual(3);
  });

  it('is deterministic', () => {
    const checkpoint = checkpointFor(createInitialState(T0));
    const args = {
      checkpoint,
      session: tinySession(),
      course: tinyCourse(),
      recentEvents: [tabReturned(1_000)],
      now: T1,
    };
    expect(buildResumeCard(args)).toEqual(buildResumeCard(args));
  });

  it('adds a short variant for a recent interruption and keeps only one item', () => {
    const checkpoint = checkpointFor(createInitialState(T0));
    const card = buildResumeCard({
      checkpoint: {
        ...checkpoint,
        mastered: ['one', 'two', 'three'],
        unresolved: ['open one', 'open two'],
      },
      session: tinySession(),
      course: tinyCourse(),
      recentEvents: [tabReturned(60_000)],
      now: T1,
    });
    expect(card.variant).toBe('short');
    expect(card.gapMs).toBe(60_000);
    expect(card.refresher).toBeNull();
    expect(card.completed).toHaveLength(1);
    expect(card.unresolved).toHaveLength(1);
  });

  it('uses a fixed 30-second refresher for long gaps', () => {
    const now = '2026-01-02T00:00:00.000Z';
    const card = buildResumeCard({
      checkpoint: checkpointFor(createInitialState(T0)),
      session: tinySession(),
      course: tinyCourse(),
      recentEvents: [
        {
          ...tabReturned(24 * 60 * 60 * 1000),
          at: now,
        },
      ],
      now,
    });
    expect(card.variant).toBe('long');
    expect(card.refresher).toEqual({
      key: 'resume.refresher.long',
      params: { seconds: '30' },
    });
  });
});

describe('resume gap policy', () => {
  it('uses the latest valid completed interruption before open starts', () => {
    const events: LearningEvent[] = [
      {
        id: 'left',
        sessionId: 'session-tiny',
        at: '2026-01-01T00:01:00.000Z',
        type: 'TAB_LEFT',
        source: 'extension',
        payload: {},
      },
      {
        id: 'bad-return',
        sessionId: 'session-tiny',
        at: '2026-01-01T00:02:00.000Z',
        type: 'TAB_RETURNED',
        source: 'extension',
        payload: { awayMs: -1 },
      },
      {
        id: 'return',
        sessionId: 'session-tiny',
        at: '2026-01-01T00:03:00.000Z',
        type: 'TAB_RETURNED',
        source: 'extension',
        payload: { awayMs: 42_000 },
      },
    ];
    expect(deriveResumeGapMs(events, '2026-01-01T00:10:00.000Z')).toBe(42_000);
  });

  it('measures the latest valid open interruption to now', () => {
    const events: LearningEvent[] = [
      {
        id: 'left',
        sessionId: 'session-tiny',
        at: '2026-01-01T00:05:00.000Z',
        type: 'TAB_LEFT',
        source: 'extension',
        payload: {},
      },
    ];
    expect(deriveResumeGapMs(events, T1)).toBe(0);
    expect(deriveResumeGapMs(events, '2026-01-01T00:06:00.000Z')).toBe(60_000);
  });

  it('uses a newer open interruption instead of an older completed gap', () => {
    const events: LearningEvent[] = [
      tabReturned(42_000),
      {
        id: 'left-again',
        sessionId: 'session-tiny',
        at: '2026-01-01T01:00:00.000Z',
        type: 'TAB_LEFT',
        source: 'extension',
        payload: {},
      },
    ];

    expect(deriveResumeGapMs(events, '2026-01-01T02:00:00.000Z')).toBe(60 * 60_000);
  });

  it('maps exact boundaries to the more detailed variant and invalid gaps to medium', () => {
    expect(classifyResumeGap(15 * 60_000)).toBe('medium');
    expect(classifyResumeGap(24 * 60 * 60_000)).toBe('long');
    expect(classifyResumeGap(null)).toBe('medium');
    expect(classifyResumeGap(-1)).toBe('medium');
  });
});

describe('evaluateResumeSuccess', () => {
  const timing: ResumeCardTiming = {
    checkpointId: 'cp-1',
    shownAt: T0,
    acceptedAt: T1,
  };
  const checkpoint = checkpointFor(createInitialState(T0));

  function taskEvent(
    id: string,
    type: 'TASK_STARTED' | 'TASK_COMPLETED' | 'HELP_REQUESTED',
    at: string,
    taskId = checkpoint.currentTaskId,
  ): LearningEvent {
    return {
      id,
      sessionId: checkpoint.sessionId,
      at,
      type,
      source: 'user',
      payload: type === 'HELP_REQUESTED' ? { taskId } : { taskId },
    } as LearningEvent;
  }

  it('succeeds on one current-task evidence event inside the exclusive/inclusive window', () => {
    const result = evaluateResumeSuccess({
      checkpoint,
      timing,
      events: [
        taskEvent('at-accepted', 'TASK_STARTED', T1),
        taskEvent('at-window-end', 'TASK_COMPLETED', '2026-01-01T00:10:00.000Z'),
      ],
      now: '2026-01-01T00:10:00.000Z',
    });
    expect(result).toMatchObject({ status: 'succeeded', evidenceEventIds: ['at-window-end'] });
  });

  it('does not count duplicates, other tasks, other sessions, or out-of-window events', () => {
    const otherTask = taskEvent(
      'other-task',
      'TASK_COMPLETED',
      '2026-01-01T00:06:00.000Z',
      'not-current',
    );
    const otherSession = {
      ...taskEvent('other-session', 'TASK_STARTED', '2026-01-01T00:06:01.000Z'),
      sessionId: 'other',
    };
    const duplicate = taskEvent('same', 'TASK_STARTED', T0);
    const result = evaluateResumeSuccess({
      checkpoint,
      timing,
      events: [
        taskEvent('before', 'TASK_STARTED', T0),
        taskEvent('after-window', 'TASK_STARTED', '2026-01-01T00:10:01.000Z'),
        otherTask,
        otherSession,
        duplicate,
        duplicate,
      ],
      now: '2026-01-01T00:10:01.000Z',
    });
    expect(result.status).toBe('expired');
    expect(result.evidenceEventIds).toEqual([]);
  });

  it('returns pending before the window closes, expired after it, and excludes dismissed cards', () => {
    const base = { checkpoint, timing, events: [] as LearningEvent[] };
    expect(evaluateResumeSuccess({ ...base, now: '2026-01-01T00:09:59.999Z' }).status).toBe(
      'pending',
    );
    expect(evaluateResumeSuccess({ ...base, now: '2026-01-01T00:10:00.000Z' }).status).toBe(
      'expired',
    );
    expect(
      evaluateResumeSuccess({
        ...base,
        timing: { ...timing, dismissedAt: '2026-01-01T00:05:01.000Z' },
        now: '2026-01-01T00:10:01.000Z',
      }).status,
    ).toBe('dismissed');
  });

  it('does not use evidence dated after now', () => {
    const result = evaluateResumeSuccess({
      checkpoint,
      timing,
      events: [taskEvent('future', 'TASK_STARTED', '2026-01-01T00:09:00.000Z')],
      now: '2026-01-01T00:08:00.000Z',
    });

    expect(result).toMatchObject({ status: 'pending', evidenceEventIds: [] });
  });
});

describe('computeResumeLatencyMs', () => {
  it('measures the delay between shown and accepted', () => {
    expect(computeResumeLatencyMs(T0, '2026-01-01T00:00:04.000Z')).toBe(4_000);
  });

  it('returns null when the card was never accepted', () => {
    expect(computeResumeLatencyMs(T0, undefined)).toBeNull();
  });

  it('returns null for an invalid timestamp', () => {
    expect(computeResumeLatencyMs(T0, 'not-a-date')).toBeNull();
  });

  it('returns null when accepted before being shown (clock skew)', () => {
    expect(computeResumeLatencyMs(T1, T0)).toBeNull();
  });
});

describe('sessionTitle', () => {
  it('combines the course title with the session date', () => {
    expect(sessionTitle(tinySession(), tinyCourse())).toBe('Tiny course · 2026-01-01');
  });
});

describe('interruption detection', () => {
  it('flags a tab-left interruption past the threshold', () => {
    const state: StateEngineState = {
      ...createInitialState(T0),
      awaySince: T0,
      state: 'DISTRACTED',
    };
    const status = detectInterruption(state, T1, { tabLeftThresholdMs: 60_000 });
    expect(status).toMatchObject({ interrupted: true, kind: 'tab-left' });
    expect(status.elapsedMs).toBe(300_000);
  });

  it('flags an idle interruption past the threshold', () => {
    const state: StateEngineState = {
      ...createInitialState(T0),
      idleSince: T0,
      state: 'DISTRACTED',
    };
    const status = detectInterruption(state, T1, { idleThresholdMs: 60_000 });
    expect(status).toMatchObject({ interrupted: true, kind: 'idle' });
  });

  it('does not flag anything below the threshold', () => {
    const state: StateEngineState = {
      ...createInitialState(T0),
      awaySince: T1,
      state: 'DISTRACTED',
    };
    const status = detectInterruption(state, T1);
    expect(status.interrupted).toBe(false);
    expect(status.kind).toBe('none');
  });

  it('reports an existing interruption without re-deriving it', () => {
    const state: StateEngineState = { ...createInitialState(T0), state: 'INTERRUPTED' };
    const status = detectInterruption(state, T1);
    expect(status.interrupted).toBe(true);
    expect(status.reason).toBe('already interrupted');
  });

  it('is inclusive of the configured threshold', () => {
    const state: StateEngineState = {
      ...createInitialState(T0),
      awaySince: T0,
      state: 'DISTRACTED',
    };
    const status = detectInterruption(state, T1, { tabLeftThresholdMs: 300_000 });
    expect(status.interrupted).toBe(true);
  });

  it('shouldOfferResume only when interrupted and unanswered', () => {
    const interrupted = {
      ...createInitialState(T0),
      state: 'INTERRUPTED' as const,
      awaitingResume: true,
    };
    expect(shouldOfferResume(interrupted)).toBe(true);
    expect(shouldOfferResume({ ...interrupted, awaitingResume: false })).toBe(false);
    expect(shouldOfferResume({ ...interrupted, state: 'FOCUSED' })).toBe(false);
  });

  it('isAwayOrIdle reflects the pending markers', () => {
    expect(isAwayOrIdle(createInitialState(T0))).toBe(false);
    expect(isAwayOrIdle({ ...createInitialState(T0), awaySince: T0 })).toBe(true);
    expect(isAwayOrIdle({ ...createInitialState(T0), idleSince: T0 })).toBe(true);
  });
});
