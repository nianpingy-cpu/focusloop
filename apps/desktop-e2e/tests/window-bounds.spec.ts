import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { hermeticEnv } from '../hermetic-env.mjs';

const MAIN = resolve(__dirname, '..', '..', 'desktop', 'dist', 'main', 'main.cjs');
const DEFAULT = { width: 1280, height: 840 };

async function launch(profile: string): Promise<ElectronApplication> {
  const app = await electron.launch({
    args: [MAIN, `--user-data-dir=${profile}`],
    env: hermeticEnv(),
  });
  await app.firstWindow();
  return app;
}

function windowBounds(
  app: ElectronApplication,
): Promise<{ x: number; y: number; width: number; height: number }> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
}

function normalBounds(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getNormalBounds());
}

function maximized(app: ElectronApplication) {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMaximized());
}

type Geometry = { x: number; y: number; width: number; height: number };

/**
 * Two observations of "the same" window can differ by a pixel or two: Windows reports the outer
 * rectangle and rounds it against the display's scale factor, so a size requested as 1100x700 comes
 * back as 1102x702 here. The tolerance is smaller than any real regression - restoring nothing at all
 * means opening at the default 1280x840, tens of pixels away - so this cannot hide a missing restore.
 */
function expectSameGeometry(actual: Geometry, expected: Geometry): void {
  for (const field of ['x', 'y', 'width', 'height'] as const) {
    expect(
      Math.abs(actual[field] - expected[field]),
      `${field} (${JSON.stringify(actual)})`,
    ).toBeLessThanOrEqual(2);
  }
}

/*
 * Window geometry, proven the only way it can be: by closing the app and opening it again. The
 * assertions compare against what the app itself reported *before* closing, so a different DPI or window
 * frame cannot make this fail for a reason that has nothing to do with remembering anything.
 */
test('the window reopens where it was closed, and maximised stays maximised', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'focusloop-window-state-'));
  try {
    const first = await launch(profile);
    const initial = await windowBounds(first);
    /*
     * A fresh profile has nothing stored, so the window is the default one. The tolerance is the window
     * frame: `getBounds` reports the outer rectangle and Windows rounds it against the display's scale
     * factor, so the app's own 1280x840 comes back a pixel larger on this machine. Asserting exact
     * equality would make this file fail on a different scale factor, for a reason that has nothing to
     * do with remembering anything.
     */
    expect(Math.abs(initial.width - DEFAULT.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(initial.height - DEFAULT.height)).toBeLessThanOrEqual(2);

    await first.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.setBounds({ x: 120, y: 90, width: 1100, height: 700 });
    });
    // The resize is applied by the window manager, and this suite runs on macOS as well as Windows:
    // read the geometry only once it has actually changed, or `moved` could still be the default and
    // the "did it move" assertion would fail for a reason that is not this app's.
    await expect.poll(() => windowBounds(first)).not.toEqual(initial);
    const moved = await windowBounds(first);
    await first.close();
    /*
     * The state has to land in *this* profile, not the real user-data directory. Without this the test
     * could pass by reading geometry some other run wrote, and would pollute the developer's own app
     * state while claiming to be hermetic.
     */
    const stateFile = join(profile, 'window-state.json');
    expect(existsSync(stateFile)).toBe(true);
    expectSameGeometry(JSON.parse(readFileSync(stateFile, 'utf8')) as Geometry, moved);

    const second = await launch(profile);
    expectSameGeometry(await windowBounds(second), moved);

    // Maximising, then closing, must remember both the flag and the size to return to - otherwise
    // un-maximising on the next launch springs the window to a size the learner never chose.
    await second.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.maximize();
    });
    await expect.poll(() => maximized(second)).toBe(true);
    expectSameGeometry(await normalBounds(second), moved);
    await second.close();

    const third = await launch(profile);
    await expect.poll(() => maximized(third)).toBe(true);
    expectSameGeometry(await normalBounds(third), moved);
    await third.close();
  } finally {
    /*
     * Windows keeps the profile locked for a moment after Electron exits, so removing it once races the
     * OS. Retry, and if the lock outlasts the retries, leave the directory: it is disposable scratch
     * space, and failing in this block would report a geometry bug where there is none.
     */
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
    } catch {
      console.warn(`left the temporary profile behind at ${profile}`);
    }
  }
});
