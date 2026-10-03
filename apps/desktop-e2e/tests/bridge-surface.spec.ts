import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import { hermeticEnv } from '../hermetic-env.mjs';

const MAIN = resolve(__dirname, '..', '..', 'desktop', 'dist', 'main', 'main.cjs');

/**
 * #135: the dashboard is the learner's own screen, and the bridge's address, protocol version,
 * connection count and token are machinery. They stay reachable, because connecting the browser
 * extension needs them - but behind a request, not in the body text of the numbers.
 */
test('the dashboard keeps the bridge behind an explicit request', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'focusloop-bridge-surface-'));
  const app = await electron.launch({
    args: [MAIN, `--user-data-dir=${profile}`],
    env: hermeticEnv(),
  });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByTestId('course-card').first().getByTestId('start-session').click();
    await page.evaluate(() => {
      location.hash = '#/dashboard';
    });
    await expect(page.getByTestId('insights-total')).toBeVisible();

    // Nothing from the machinery reaches a learner who has not asked for it.
    const body = page.locator('body');
    await expect(page.getByTestId('bridge-token')).toHaveCount(0);
    await expect(body).not.toContainText('ws://');
    await expect(body).not.toContainText('protocol v');
    await expect(body).not.toContainText('127.0.0.1:');

    // And it stays reachable: the bridge finds its port asynchronously, so wait for the control
    // rather than assuming the first frame already has it.
    const reveal = page.getByTestId('bridge-reveal');
    await expect(reveal).toBeVisible({ timeout: 15_000 });
    await expect(reveal).toHaveAttribute('aria-expanded', 'false');
    await reveal.click();

    await expect(page.getByTestId('bridge-token')).toBeVisible();
    await expect(body).toContainText('ws://');
    await expect(body).toContainText('protocol v');
    await expect(reveal).toHaveAttribute('aria-expanded', 'true');

    // Asking is a choice, and it can be taken back.
    await reveal.click();
    await expect(page.getByTestId('bridge-token')).toHaveCount(0);
    await expect(body).not.toContainText('ws://');
    await expect(reveal).toHaveAttribute('aria-expanded', 'false');
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
