import { describe, expect, it } from 'vitest';
import type {
  InterventionDecision,
  InterventionOutcome,
  LearningEvent,
  RescueAction,
} from '@focusloop/shared-types';
import { buildRescuePlan, buildRescueView, evaluateRescueSuccess } from './rescue';

const T0 = '2026-01-01T00:00:00.000Z';
const at = (ms: number): string => new Date(Date.parse(T0) + ms).toISOString();

function decision(action: RescueAction): InterventionDecision {
  return {
    action,
    state: 'CONFUSED',
    reason: { key: 'reason.stuck.went-wrong', params: {} },
    confidence: 1,
    estimatedMinutes: 2,
    answersRequestId: 'help-1',
  };
}

function outcome(overrides: Partial<InterventionOutcome> = {}): InterventionOutcome {
  return {
    id: 'outcome-1',
    interventionId: 'intervention-1',
    sessionId: 'session-1',
    at: T0,
    state: 'CONFUSED',
    action: 'HINT',
    accepted: true,
    dismissed: false,
    taskCompleted: false,
    resumeLatencyMs: null,
    quizOutcome: null,
    acceptedAt: T0,
    ...overrides,
  };
}

function event(
  id: string,
  type: LearningEvent['type'],
  atIso: string,
  taskId = 'task-1',
  sessionId = 'session-1',
): LearningEvent {
  return { id, type, at: atIso, sessionId, source: 'user', payload: { taskId } } as LearningEvent;
}

describe('AG2 deterministic rescue plans', () => {
  for (const action of ['MICRO_START', 'SIMPLIFY', 'HINT', 'EXAMPLE', 'BREAK'] as const) {
    it(`builds a bounded ${action} plan`, () => {
      const plan = buildRescuePlan(decision(action), {
        interventionId: 'intervention-1',
        sessionId: 'session-1',
        taskId: 'task-1',
      });
      expect(plan).toMatchObject({ action, source: 'deterministic-local', taskId: 'task-1' });
      expect(plan?.steps.length).toBeGreaterThanOrEqual(1);
      expect(plan?.steps.length).toBeLessThanOrEqual(3);
    });
  }

  it('does not turn QUESTION into a rescue plan', () => {
    expect(
      buildRescuePlan({
        interventionId: 'i1',
        sessionId: 's1',
        action: 'QUESTION',
      }),
    ).toBeNull();
  });

  it('rejects empty intervention and session identifiers', () => {
    expect(buildRescuePlan({ interventionId: '', sessionId: 's1', action: 'HINT' })).toBeNull();
    expect(buildRescuePlan({ interventionId: 'i1', sessionId: '', action: 'HINT' })).toBeNull();
    expect(
      buildRescuePlan(decision('HINT'), { interventionId: '', sessionId: 's1', taskId: null }),
    ).toBeNull();
  });

  it('reveals the plan only after acceptance', () => {
    const seed = { interventionId: 'i1', sessionId: 's1', taskId: 't1' };
    expect(buildRescueView(decision('HINT'), seed, 'offered').plan).toBeNull();
    expect(buildRescueView(decision('HINT'), seed, 'active').plan?.action).toBe('HINT');
  });
});

describe('AG2 rescue success', () => {
  const plan = buildRescuePlan(decision('HINT'), {
    interventionId: 'intervention-1',
    sessionId: 'session-1',
    taskId: 'task-1',
  })!;

  it('counts Continue inside the five-minute window', () => {
    expect(
      evaluateRescueSuccess({
        plan,
        outcome: outcome({ continuedAt: at(300_000) }),
        events: [],
        now: at(300_000),
      }).status,
    ).toBe('succeeded');
  });

  it('keeps the acceptance instant open and the end boundary closed', () => {
    expect(
      evaluateRescueSuccess({
        plan,
        outcome: outcome({ continuedAt: T0 }),
        events: [],
        now: at(300_000),
      }).status,
    ).toBe('expired');
    expect(
      evaluateRescueSuccess({
        plan,
        outcome: outcome({ continuedAt: at(300_000) }),
        events: [],
        now: at(300_000),
      }).status,
    ).toBe('succeeded');
  });

  it('accepts same-task completion and correct quiz evidence', () => {
    for (const type of ['TASK_COMPLETED', 'QUIZ_CORRECT'] as const) {
      expect(
        evaluateRescueSuccess({
          plan,
          outcome: outcome(),
          events: [event(type, type, at(1))],
          now: at(2),
        }).status,
      ).toBe('succeeded');
    }
  });

  it('classifies another same-task help request separately', () => {
    expect(
      evaluateRescueSuccess({
        plan,
        outcome: outcome(),
        events: [event('help-2', 'HELP_REQUESTED', at(1))],
        now: at(2),
      }).status,
    ).toBe('repeated-help');
  });

  it('ignores duplicate ids, other sessions, other tasks and future evidence', () => {
    const events = [
      event('same', 'TASK_COMPLETED', at(1), 'other-task'),
      event('same', 'TASK_COMPLETED', at(1)),
      event('other-session', 'QUIZ_CORRECT', at(1), 'task-1', 'session-2'),
      event('future', 'TASK_COMPLETED', at(10)),
    ];
    expect(evaluateRescueSuccess({ plan, outcome: outcome(), events, now: at(2) }).status).toBe(
      'pending',
    );
  });

  it('expires only after the window and rejects invalid configuration', () => {
    expect(
      evaluateRescueSuccess({ plan, outcome: outcome(), events: [], now: at(299_999) }).status,
    ).toBe('pending');
    expect(
      evaluateRescueSuccess({ plan, outcome: outcome(), events: [], now: at(300_000) }).status,
    ).toBe('expired');
    expect(() =>
      evaluateRescueSuccess({
        plan,
        outcome: outcome(),
        events: [],
        now: at(1),
        rescueSuccessWindowMs: -1,
      }),
    ).toThrow(RangeError);
  });
});
