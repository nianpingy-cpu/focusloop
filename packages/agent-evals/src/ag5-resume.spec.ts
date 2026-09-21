import { describe, expect, it } from 'vitest';
import mediumScenario from './scenarios/ag5/medium-15m-boundary.json';
import duplicateScenario from './scenarios/ag5/duplicate-events-deterministic.json';
import longScenario from './scenarios/ag5/long-24h-boundary.json';
import missingGapScenario from './scenarios/ag5/missing-gap-conservative-medium.json';
import shortScenario from './scenarios/ag5/short-1m-happy.json';
import shortThresholdScenario from './scenarios/ag5/short-10m-threshold.json';
import successScenario from './scenarios/ag5/success-within-window.json';
import expiredScenario from './scenarios/ag5/success-window-expired.json';
import pendingScenario from './scenarios/ag5/success-window-pending.json';
import { allScenariosPassed, parseScenario, runScenarios, type JsonValue } from './index';
import { runAg5Adapter } from './ag5';

const scenarios = [
  shortScenario,
  shortThresholdScenario,
  mediumScenario,
  longScenario,
  missingGapScenario,
  successScenario,
  expiredScenario,
  pendingScenario,
  duplicateScenario,
].map(parseScenario);

describe('AG5 deterministic resume scenarios', () => {
  it('covers all gap bands and success-window states with stable output', () => {
    const first = runScenarios(scenarios, executeAg5Fixture);
    const second = runScenarios(scenarios, executeAg5Fixture);

    expect(first).toEqual(second);
    expect(allScenariosPassed(first)).toBe(true);
    expect(first.map((result) => result.scenarioId)).toEqual([
      'ag5-short-1m-happy',
      'ag5-short-10m-threshold',
      'ag5-medium-15m-boundary',
      'ag5-long-24h-boundary',
      'ag5-missing-gap-conservative-medium',
      'ag5-success-within-window',
      'ag5-success-window-expired',
      'ag5-success-window-pending',
      'ag5-duplicate-events-deterministic',
    ]);
  });

  it('keeps duplicate events idempotent at the adapter boundary', () => {
    const input = duplicateScenario.input as JsonValue;
    const first = runAg5Adapter(input);
    const second = runAg5Adapter(input);
    expect(first).toEqual(second);
  });
});

function executeAg5Fixture(input: JsonValue): JsonValue {
  return runAg5Adapter(input);
}
