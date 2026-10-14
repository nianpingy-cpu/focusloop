import { expect, test } from '@playwright/test';
import { hermeticEnv } from '../hermetic-env.mjs';

test('removes provider credentials regardless of environment-key casing', () => {
  const env = hermeticEnv({
    FOCUSLOOP_DEEPSEEK_API_KEY: 'upper-secret',
    focusloop_deepseek_api_key: 'lower-secret',
    FocusLoop_DeepSeek_Api_Key: 'mixed-secret',
    FOCUSLOOP_OPENAI_API_KEY: 'openai-secret',
    focusloop_openai_api_key: 'openai-lower-secret',
  });

  expect(Object.keys(env).some((key) => key.toUpperCase() === 'FOCUSLOOP_DEEPSEEK_API_KEY')).toBe(
    false,
  );
  expect(Object.keys(env).some((key) => key.toUpperCase() === 'FOCUSLOOP_OPENAI_API_KEY')).toBe(
    false,
  );
  expect(env.FOCUSLOOP_DEV).toBe('1');
});

test('turns the distraction sensor off unless a spec asks for it', () => {
  /*
   * Asserted rather than assumed, because it is the switch every other spec's determinism rests on:
   * a suite that asserts a focused session cannot have the machine's window focus deciding
   * otherwise, and the default has to be off for the suite even when the developer has the sensor
   * on in their own shell.
   */
  expect(hermeticEnv({ FOCUSLOOP_DISTRACTION_SENSOR: '1' }).FOCUSLOOP_DISTRACTION_SENSOR).toBe('0');
  expect(hermeticEnv({}).FOCUSLOOP_DISTRACTION_SENSOR).toBe('0');
});

test('drops the variable that turns Electron into a plain node runtime', () => {
  /*
   * Regression: running the suite by pointing `ELECTRON_RUN_AS_NODE` at the Electron binary (the
   * way a machine without `node` on PATH has to) used to hand that variable to the app, and the
   * launch died with "bad option: --remote-debugging-port=0" before any app code ran. The rest of
   * the host environment still has to survive.
   */
  const env = hermeticEnv({ ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin' });

  expect(Object.keys(env).some((key) => key.toUpperCase() === 'ELECTRON_RUN_AS_NODE')).toBe(false);
  expect(env.PATH).toBe('/usr/bin');
});
