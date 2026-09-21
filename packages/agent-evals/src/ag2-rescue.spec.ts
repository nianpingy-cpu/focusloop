import { describe, expect, it } from 'vitest';
import cannotStart from './scenarios/ag2/cannot-start.json';
import doNotUnderstand from './scenarios/ag2/do-not-understand.json';
import tooBig from './scenarios/ag2/too-big.json';
import wentWrong from './scenarios/ag2/went-wrong.json';
import cannotRecall from './scenarios/ag2/cannot-recall.json';
import tired from './scenarios/ag2/tired.json';
import success from './scenarios/ag2/success-continue.json';
import expired from './scenarios/ag2/expired.json';
import repeated from './scenarios/ag2/repeated-help.json';
import noReason from './scenarios/ag2/no-reason-edge.json';
import unknownReason from './scenarios/ag2/unknown-reason-adversarial.json';
import overloaded from './scenarios/ag2/overloaded-explicit-reason-edge.json';
import missingAcceptedAt from './scenarios/ag2/missing-accepted-at-edge.json';
import crossSession from './scenarios/ag2/cross-session-event-adversarial.json';
import crossTask from './scenarios/ag2/cross-task-event-adversarial.json';
import futureEvent from './scenarios/ag2/future-event-adversarial.json';
import duplicateEvent from './scenarios/ag2/duplicate-event-edge.json';
import repeatedHelpPrecedence from './scenarios/ag2/repeated-help-precedence-edge.json';
import { allScenariosPassed, parseScenario, runScenarios, type JsonValue } from './index';
import { runAg2Adapter } from './ag2';

const scenarios = [
  cannotStart,
  doNotUnderstand,
  tooBig,
  wentWrong,
  cannotRecall,
  tired,
  success,
  expired,
  repeated,
  noReason,
  unknownReason,
  overloaded,
  missingAcceptedAt,
  crossSession,
  crossTask,
  futureEvent,
  duplicateEvent,
  repeatedHelpPrecedence,
].map(parseScenario);

describe('AG2 deterministic rescue scenarios', () => {
  it('runs every reason and terminal success class through production policy', () => {
    const first = runScenarios(scenarios, (input: JsonValue) => runAg2Adapter(input));
    const second = runScenarios(scenarios, (input: JsonValue) => runAg2Adapter(input));
    expect(first).toEqual(second);
    expect(allScenariosPassed(first)).toBe(true);
    expect(first).toHaveLength(18);
  });

  it('asserts the serialised rescue contract for every production reason route', () => {
    const expected = [
      ['ag2-cannot-start', 'MICRO_START', ['rescue.microStart.first'], 5],
      ['ag2-do-not-understand', 'EXAMPLE', ['rescue.example.pattern', 'rescue.example.apply'], 4],
      [
        'ag2-too-big',
        'SIMPLIFY',
        ['rescue.simplify.identify', 'rescue.simplify.first', 'rescue.simplify.check'],
        3,
      ],
      ['ag2-went-wrong', 'HINT', ['rescue.hint.action', 'rescue.hint.condition'], 2],
      ['ag2-cannot-recall', 'HINT', ['rescue.hint.action', 'rescue.hint.condition'], 2],
      ['ag2-tired', 'BREAK', ['rescue.break.pause', 'rescue.break.return'], 5],
    ] as const;

    for (const [scenarioId, action, stepKeys, estimatedMinutes] of expected) {
      const input = scenarios.find((scenario) => scenario.id === scenarioId)?.input;
      expect(input).toBeDefined();
      const output = runAg2Adapter(input ?? null) as Record<string, unknown>;
      expect(output).toMatchObject({
        action,
        stepKeys,
        estimatedMinutes,
        source: 'deterministic-local',
      });
    }
  });
});
