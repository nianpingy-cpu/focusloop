import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '@focusloop/persistence';

/*
 * The only spec in this package that stands in for Electron.
 *
 * `createService` reads `app.getPath('userData')` and `app.isPackaged`, and `openDataFolder` shells out �? * three things a test cannot have. Mocking the module is the alternative to not testing the orchestration
 * at all, and the orchestration is where "did the data actually go" is decided.
 */
const getPath = vi.hoisted(() => vi.fn<() => string>());
const openPath = vi.hoisted(() => vi.fn<(path: string) => Promise<string>>());

vi.mock('electron', () => ({
  app: { getPath, isPackaged: true },
  shell: { openPath },
}));

const { createService } = await import('./service');

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'focusloop-service-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  getPath.mockReset();
  openPath.mockReset();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('createService', () => {
  /*
   * The acceptance criterion, at the only level where it can be pinned: the directory the UI shows is the one
   * Electron resolved. The e2e makes the same comparison against `--user-data-dir`, which is the same claim
   * through a real profile; this one cannot be satisfied by a hand-written string, because the value exists
   * only in this mock. `getPath` has no default, so a service built without `userDataPath` reads it — which
   * is the path the app itself takes.
   */
  it('takes the data directory from Electron rather than deciding it', () => {
    const directory = temporaryDirectory();
    getPath.mockReturnValue(directory);
    const service = createService();
    try {
      expect(getPath).toHaveBeenCalledWith('userData');
      expect(service.getDataInfo().directory).toBe(directory);
    } finally {
      service.dispose();
    }
  });

  it('reports the directory Electron gave it, and the file it actually opened', () => {
    const directory = temporaryDirectory();
    const service = createService({ userDataPath: directory });
    try {
      expect(service.getDataInfo()).toEqual({
        directory,
        databasePath: join(directory, 'focusloop.sqlite'),
      });
    } finally {
      service.dispose();
    }
  });

  it('says the folder did not open when the OS refuses to open it', async () => {
    openPath.mockResolvedValue('the file manager is not available');
    const service = createService({ userDataPath: temporaryDirectory() });
    try {
      expect(await service.openDataFolder()).toEqual({ opened: false });
      expect(openPath).toHaveBeenCalledWith(service.getDataInfo().directory);
    } finally {
      service.dispose();
    }
  });

  it('deletes the database and leaves a working first-run database behind', async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, 'focusloop.sqlite');
    const service = createService({ userDataPath: directory });
    try {
      const courseId = service.engine.listCourses()[0]!.id;
      const before = service.engine.startSession(courseId).session.id;
      expect(service.engine.getCurrentSession()).not.toBeNull();

      const outcome = await service.deleteAllData();

      expect(outcome).toEqual({ ok: true, reason: null, removed: [databasePath] });
      expect(existsSync(databasePath)).toBe(true);
      expect(service.engine.getCurrentSession()).toBeNull();
      // The built-in course is the product's own content rather than the learner's, so it comes back.
      expect(service.engine.listCourses().map((course) => course.id)).toEqual([courseId]);
      expect(service.engine.getSettings().locale).toBe('en');

      /*
       * And a new session runs on the database that is there now. A different id is the proof that this is
       * a new file rather than the deleted one still open: the store keeps its identity while the
       * connection underneath it is replaced, which is the whole reason the app needs no restart.
       */
      expect(service.engine.startSession(courseId).session.id).not.toBe(before);
    } finally {
      service.dispose();
    }
  });

  it('reports a locked database honestly and keeps working on the data that survived', async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, 'focusloop.sqlite');
    const service = createService({ userDataPath: directory });
    const other = openDatabase(databasePath);
    try {
      const courseId = service.engine.listCourses()[0]!.id;
      service.engine.startSession(courseId);

      const outcome = await service.deleteAllData();

      /*
       * Windows-only in practice, so the maintainer's machine runs the first branch and CI's other
       * platforms run the second. Both are the same claim — the report and the data have to agree — read
       * through the only answer the platform can give.
       */
      if (process.platform === 'win32') {
        expect(outcome.ok).toBe(false);
        expect(outcome.reason).toBe('locked');
        expect(service.engine.getCurrentSession()).not.toBeNull();
        expect(service.engine.listCourses().map((course) => course.id)).toContain(courseId);
      } else {
        expect(outcome.ok).toBe(true);
        expect(service.engine.getCurrentSession()).toBeNull();
      }
    } finally {
      other.close();
      service.dispose();
    }
  });

  /*
   * Identity, not equality, and that is the whole assertion.
   *
   * With the guard, both calls are handed the one promise, so both resolve to the same object. Without it,
   * each call runs a full deletion of its own and the two answers are equal but distinct objects — a
   * `toEqual` would pass in both worlds, which is the shape of a check that cannot fail. `toBe` is also the
   * honest statement of the claim: one deletion, one answer, handed to however many callers asked.
   *
   * The body is synchronous today, so this cannot happen through the IPC boundary (each `invoke` is its own
   * task) and the guard is there for the version with an `await` in it.
   */
  it('hands every caller the same deletion, rather than running one each', async () => {
    const directory = temporaryDirectory();
    const service = createService({ userDataPath: directory });
    try {
      const [first, second] = await Promise.all([service.deleteAllData(), service.deleteAllData()]);

      expect(first).toBe(second);
      expect(existsSync(join(directory, 'focusloop.sqlite'))).toBe(true);
    } finally {
      service.dispose();
    }
  });

  /*
   * Why the deletion finds one file and not three.
   *
   * The connection is in WAL mode while it is open, so a `-shm` sits beside the database then, and
   * `close()` checkpoints the log back into the database and removes it. That is why the store is closed
   * before anything is unlinked, and why a clean deletion has one file left to remove.
   *
   * Nothing is asserted about the disk afterwards, because the success path reopens the database and seeds
   * the built-in course, and that fresh connection creates sidecars of its own which nothing here can tell
   * apart from leftovers. `data-files.spec.ts` covers the case this one cannot: a database beside sidecars
   * that are still there, which is what a crash or another process leaves behind.
   */
  it('closes the database before deleting it, so SQLite has folded its WAL away first', async () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, 'focusloop.sqlite');
    const service = createService({ userDataPath: directory });
    try {
      /*
       * One file, and that is what closing first buys: this call's `close()` checkpointed the log into the
       * database, so the `-wal` and `-shm` that were there a moment ago are gone and one file is left to
       * unlink. Nothing is asserted about the disk afterwards, because the success path reopens the database
       * and seeds the built-in course, and that fresh connection creates sidecars of its own which nothing
       * here can tell apart from leftovers.
       */
      expect(await service.deleteAllData()).toMatchObject({ ok: true, removed: [databasePath] });
    } finally {
      service.dispose();
    }
  });
});
