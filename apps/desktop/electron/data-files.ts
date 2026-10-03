import { existsSync, unlinkSync } from 'node:fs';

/**
 * The files a FocusLoop database consists of on disk.
 *
 * SQLite writes a `-wal` and a `-shm` beside the database when it is in WAL mode, so "delete my data"
 * is three files rather than one: removing only the database leaves the write-ahead log behind, and a
 * future open that finds it has rows to replay. The order matters too — the database file is first,
 * because the caller reads the first failure as the answer about the database itself.
 */
export function databaseFiles(databasePath: string): readonly string[] {
  return [databasePath, `${databasePath}-wal`, `${databasePath}-shm`];
}

/** Why a file could not be removed. `locked` is the one the learner can act on. */
export type DeleteFailureReason = 'locked' | 'failed';

export interface DeleteFilesOutcome {
  readonly removed: readonly string[];
  readonly remaining: readonly string[];
  /** Null when every file that was there is gone. Otherwise the reason for the first failure. */
  readonly reason: DeleteFailureReason | null;
}

/**
 * Which reason a failed unlink is reported with.
 *
 * `EBUSY` is a lock everywhere. Windows, though, answers an unlink of a file another process has open
 * with `EPERM` or `EACCES` instead, which is why the platform is part of the rule rather than an
 * implementation detail: on POSIX those two codes mean a permission problem, and telling that learner to
 * close another program would be advice that cannot work.
 *
 * `platform` is a parameter for the same reason it is not read from the environment here — one machine
 * cannot otherwise test the answer the other platform's users get.
 */
export function deleteFailureReason(
  code: string | undefined,
  platform: string,
): DeleteFailureReason {
  if (code === 'EBUSY') return 'locked';
  if (platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) return 'locked';
  return 'failed';
}

function errorCode(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Removes each file that is there, and reports what it did.
 *
 * Nothing is thrown: a file the OS will not let go of is a normal outcome of this operation, not an
 * exception — the caller has to be able to say "it is still there" to the learner, and it cannot do that
 * from a stack trace. A file that is already absent is not a failure: the job was to have it not exist.
 */
export function deleteFiles(paths: readonly string[]): DeleteFilesOutcome {
  const removed: string[] = [];
  const remaining: string[] = [];
  let reason: DeleteFailureReason | null = null;

  for (const path of paths) {
    if (!existsSync(path)) continue;
    try {
      unlinkSync(path);
      removed.push(path);
    } catch (error) {
      remaining.push(path);
      reason ??= deleteFailureReason(errorCode(error), process.platform);
    }
  }

  return { removed, remaining, reason };
}
