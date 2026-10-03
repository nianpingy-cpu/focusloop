import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { hermeticEnv } from '../hermetic-env.mjs';

const MAIN = resolve(__dirname, '..', '..', 'desktop', 'dist', 'main', 'main.cjs');
const DEFAULT = { width: 1280, height: 840 };

interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

const profiles: string[] = [];

/**
 * A profile directory, optionally with the record the app should find when it opens.
 *
 * Seeding the file is what makes these tests hermetic for the *recovery* rules as well as the happy
 * path: a stored position can only be shown to be unusable by putting one there. It also proves
 * `--user-data-dir` is honoured - the app reads the file from this directory and nowhere else.
 */
function newProfile(state?: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'focusloop-window-state-'));
  profiles.push(directory);
  if (state !== undefined) {
    writeFileSync(
      join(directory, 'window-state.json'),
      typeof state === 'string' ? state : `${JSON.stringify(state)}\n`,
    );
  }
  return directory;
}

async function launch(profile: string): Promise<ElectronApplication> {
  const app = await electron.launch({
    args: [MAIN, `--user-data-dir=${profile}`],
    env: hermeticEnv(),
  });
  await app.firstWindow();
  return app;
}

function windowBounds(app: ElectronApplication): Promise<Geometry> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds());
}

function normalBounds(app: ElectronApplication): Promise<Geometry> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getNormalBounds());
}

function maximized(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isMaximized());
}

/*
 * The usable rectangle of each display, not the whole screen: "wholly on a display" is the guarantee the
 * size clamp provides, and the work area is the region that has to hold for a title bar to be grabbable.
 */
function workAreas(app: ElectronApplication): Promise<Geometry[]> {
  return app.evaluate(({ screen }) => screen.getAllDisplays().map((display) => display.workArea));
}

/**
 * Compares two observations of "the same" window. The tolerance is the window frame: the platform reports
 * the outer rectangle and rounds it against the display's scale factor, so a size requested as 1100x700 is
 * observed as 1102x702. Asserting exact equality would make this fail on a scale factor other than the one
 * it was written against, for a reason unrelated to remembering anything - and the tolerance is far
 * smaller than any real regression: failing to restore at all means the default 1280x840, tens of pixels
 * away.
 */
function expectSameGeometry(actual: Geometry, expected: Geometry): void {
  for (const field of ['x', 'y', 'width', 'height'] as const) {
    expect(
      Math.abs(actual[field] - expected[field]),
      `${field} of ${JSON.stringify(actual)}`,
    ).toBeLessThanOrEqual(2);
  }
}

/**
 * The whole window has to be inside a work area, not merely overlapping one.
 *
 * This has teeth because the app decides whether the stored position is kept: with an unusable position it
 * omits `x`/`y` and the window opens centred, so a fitting size lands wholly inside; a window that kept the
 * position would sit at (20000, 20000) and fail here. It is *not* used to assert that an oversized size is
 * fitted - that is the app's clamp in `window-bounds.ts`, and it is covered by the unit spec, because
 * Windows constrains an oversized window by itself, so no end-to-end run can tell the clamp's removal from
 * its presence.
 *
 * The 2px slack is the frame rounding `expectSameGeometry` documents, not a weakening: a window clamped to
 * exactly its display's work area is observed a pixel larger.
 */
function expectWhollyOnSomeWorkArea(actual: Geometry, areas: Geometry[]): void {
  const slack = 2;
  const inside = areas.some(
    (area) =>
      actual.x >= area.x - slack &&
      actual.y >= area.y - slack &&
      actual.x + actual.width <= area.x + area.width + slack &&
      actual.y + actual.height <= area.y + area.height + slack,
  );
  expect(
    inside,
    `the window ${JSON.stringify(actual)} is not wholly inside any work area ${JSON.stringify(areas)}`,
  ).toBe(true);
}

test.afterAll(() => {
  /*
   * Windows keeps a profile locked for a moment after Electron exits, so removing it immediately races
   * the OS. Retry, and if the lock outlasts the retries leave the directory: it is disposable scratch
   * space, and failing here would report a geometry bug where there is none.
   */
  for (const profile of profiles) {
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
    } catch {
      console.warn(`left the temporary profile behind at ${profile}`);
    }
  }
});

test('the window reopens where it was closed, and maximised stays maximised', async () => {
  const profile = newProfile();
  /*
   * The three launches are tracked so a failure part-way through still closes the one left running;
   * otherwise the afterAll cleanup spends its whole retry budget on a profile a live process holds. A bare
   * `close()` is enough here because `app.close()` already awaits the child's exit: the fuller
   * `closeAndWait` in `golden-path.spec.ts` adds a *named* failure for the single-instance lock, and
   * nothing is launched here until the previous app is gone.
   */
  let open: ElectronApplication | undefined;
  const start = async (): Promise<ElectronApplication> => {
    open = await launch(profile);
    return open;
  };
  const stop = async (): Promise<void> => {
    const app = open;
    open = undefined;
    if (app !== undefined) await app.close();
  };

  try {
    const first = await start();
    const initial = await windowBounds(first);
    // A fresh profile has nothing stored, so the window is the default one.
    expect(Math.abs(initial.width - DEFAULT.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(initial.height - DEFAULT.height)).toBeLessThanOrEqual(2);

    await first.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.setBounds({ x: 120, y: 90, width: 1100, height: 700 });
    });
    /*
     * The resize is applied by the window manager, and this suite runs on macOS as well as Windows: read
     * the geometry only once it has actually changed, or `moved` could still be the default and the "did it
     * move" assertion would fail for a reason that is not this app's.
     */
    await expect.poll(() => windowBounds(first)).not.toEqual(initial);
    const moved = await windowBounds(first);
    await stop();

    /*
     * Compared exactly, unlike every other geometry check here. The reason is not that it avoids the window
     * manager - `moved` is the window manager's own answer to `setBounds`, read back over CDP - but that both
     * numbers come from the same Electron API for the same window in the same state, which their
     * documentation says are equal outside of a maximise, a minimise or fullscreen. A tolerance here would
     * only hide an off-by-one write. It also pins that the state lands in *this* profile rather than the real
     * user-data directory, which is what makes every other assertion here hermetic.
     */
    const stateFile = join(profile, 'window-state.json');
    expect(existsSync(stateFile)).toBe(true);
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toEqual({ ...moved, maximized: false });

    const second = await start();
    expectSameGeometry(await windowBounds(second), moved);

    // Maximising, then closing, must remember both the flag and the size to return to - otherwise
    // un-maximising on the next launch springs the window to a size the learner never chose.
    await second.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]!.maximize();
    });
    await expect.poll(() => maximized(second)).toBe(true);
    expectSameGeometry(await normalBounds(second), moved);
    await stop();

    const third = await start();
    await expect.poll(() => maximized(third)).toBe(true);
    expectSameGeometry(await normalBounds(third), moved);
    await stop();
  } finally {
    if (open !== undefined) await open.close();
  }
});

test('a position on a display that is gone is dropped, and the size is kept', async () => {
  // Far enough out that no display holds it, and still inside what the validator calls plausible - which
  // is the whole reason the on-screen check exists rather than a range check.
  const profile = newProfile({ x: 20_000, y: 20_000, width: 1100, height: 700, maximized: false });
  const app = await launch(profile);
  try {
    const bounds = await windowBounds(app);
    expectWhollyOnSomeWorkArea(bounds, await workAreas(app));
    // The size is still honoured; only the position was unusable.
    expect(Math.abs(bounds.width - 1100)).toBeLessThanOrEqual(2);
    expect(Math.abs(bounds.height - 700)).toBeLessThanOrEqual(2);
  } finally {
    await app.close();
  }
});

test('a record that cannot be trusted opens at the default size', async () => {
  /*
   * Both ways a record can be unusable: JSON that does not parse at all, and JSON that parses into
   * something the validator has to reject. The second is the one the all-or-nothing rule is about, and it
   * is the case a "salvage what you can" implementation would open a 0-wide window for.
   */
  const corrupt: readonly (readonly [string, string])[] = [
    ['json that does not parse', '{"width": 0, "height": 700, "maximized": false'],
    [
      'a record with a zero width',
      JSON.stringify({ x: 0, y: 0, width: 0, height: 700, maximized: false }),
    ],
    ['a record with no position', JSON.stringify({ width: 1100, height: 700, maximized: false })],
  ];

  for (const [label, record] of corrupt) {
    const profile = newProfile(record);
    const app = await launch(profile);
    try {
      const bounds = await windowBounds(app);
      expectWhollyOnSomeWorkArea(bounds, await workAreas(app));
      expect(
        Math.abs(bounds.width - DEFAULT.width),
        `${label}: expected the default width, got ${bounds.width}`,
      ).toBeLessThanOrEqual(2);
      expect(Math.abs(bounds.height - DEFAULT.height), label).toBeLessThanOrEqual(2);
    } finally {
      await app.close();
    }
  }
});

test('a stored size too large for the display is fitted rather than left unusable', async () => {
  /*
   * A plausible record whose size no longer fits, from a display that is gone. The position is dropped and
   * the size is clamped by `restoreWindowBounds`, so the window opens centred and whole.
   *
   * Only the outcome is asserted here; the clamp itself is asserted where it lives (the unit spec), because
   * this platform constrains an oversized window even without it - measured: removing the clamp leaves this
   * case green. Keeping the assertion means a change that leaves the window *not* fitting is still caught;
   * it just cannot be the evidence for the clamp.
   */
  const profile = newProfile({ x: 20_000, y: 20_000, width: 3000, height: 1900, maximized: false });
  const app = await launch(profile);
  try {
    const areas = await workAreas(app);
    const bounds = await windowBounds(app);
    expectWhollyOnSomeWorkArea(bounds, areas);
    const tightest = areas.reduce((tight, area) =>
      area.width * area.height < tight.width * tight.height ? area : tight,
    );
    expect(bounds.width).toBeLessThanOrEqual(tightest.width + 2);
    expect(bounds.height).toBeLessThanOrEqual(tightest.height + 2);
  } finally {
    await app.close();
  }
});
