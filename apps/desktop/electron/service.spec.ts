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
const openPath = vi.fn<(path: string) => Promise<string>>();

vi.mock('electron', () => ({
  app: { getPath: (): string => 'C:\\user-data-from-electron', isPackaged: true },
  shell: { openPath: (path: string) => openPath(path) },
}));

const { createService } = await import('./service');

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'focusloop-service-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  openPath.mockReset();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('createService', () => {
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
       * Windows-only in practice, so on POSIX this asserts the other half: whatever the platform says, the
       * report and the data have to agree. `ok: false` means the session is still there, and the store is
       * open and answering rather than closed behind a failure message.
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

  it('runs one deletion however many times it is asked at once', async () => {
    const directory = temporaryDirectory();
    const service = createService({ userDataPath: directory });
    try {
      const [first, second] = await Promise.all([service.deleteAllData(), service.deleteAllData()]);

      // The same answer, not a second deletion on a store the first had already closed. A second run
      // would have thrown on `close()` and surfaced as a rejected IPC call.
      expect(first).toEqual(second);
      expect(existsSync(join(directory, 'focusloop.sqlite'))).toBe(true);
    } finally {
      service.dispose();
    }
  });

  /*
   * Why the deletion finds one file and not three.
   *
   * The connection is in WAL mode while it is open �?the `-wal` and `-shm` are how SQLite shares the log,
   * and writing to them from anywhere else fails while the connection is live (measured: `writeFileSync` on
   * the `-shm` dies with `UNKNOWN: unknown error, open ...-shm`). `close()` checkpoints that log back into
   * the database and removes both files, which is exactly why the store is closed before anything is
   * unlinked. `data-files.spec.ts` covers the other half �?a database beside sidecars that are still there
   * �?because those are what a crash or another process leaves behind.
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
