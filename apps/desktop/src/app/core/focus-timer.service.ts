import { Injectable, signal } from '@angular/core';
import { createFocusTimer, tick, type FocusTimerState } from './focus-timer';

interface FocusTimerOwner {
  readonly sessionId: string;
  readonly taskId: string;
}

interface StoredFocusTimer {
  readonly owner: FocusTimerOwner;
  readonly state: FocusTimerState;
}

/** One key, so a restore is a single read and a reset a single remove. */
const STORAGE_KEY = 'focusloop.focus-timer';

/**
 * Reads the stored commitment, if this renderer has any storage at all.
 *
 * Guarded rather than assumed: the desktop spec runs under Node, where `localStorage` does not exist,
 * and a timer that threw on construction would take the whole shell down. A malformed entry — a
 * half-written record from a killed process — is discarded rather than allowed to poison the timer.
 */
function readStored(): StoredFocusTimer | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<StoredFocusTimer>;
    const owner = parsed.owner;
    const state = parsed.state;
    if (
      owner === undefined ||
      typeof owner.sessionId !== 'string' ||
      typeof owner.taskId !== 'string' ||
      state === undefined ||
      typeof state.durationMs !== 'number' ||
      typeof state.remainingMs !== 'number'
    ) {
      return null;
    }
    return { owner, state };
  } catch {
    return null;
  }
}

function writeRaw(value: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (value === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // A full quota or a private window is not a reason to stop the learner's timer working.
  }
}

/**
 * Keeps the renderer-local focus commitment alive while the learner changes routes, and across a
 * reload or restart.
 *
 * The commitment is deliberately not a domain event: it is a UI promise with a clock attached, and
 * losing it on every refresh meant a learner who reloaded at 2:50 was handed a fresh three minutes.
 * It is stored under this window's own key for the same reason — it belongs to the shell, not the
 * session's event log — and `sync` drops it whenever the session or current task changes, so a stored
 * timer can never be carried onto work it was not started for.
 *
 * The stored value keeps the *absolute* `endAtMs`, so a restore recomputes what is left from the
 * wall clock rather than trusting a remaining-milliseconds field that stopped moving while the app was
 * closed. A timer that ran out while the app was closed comes back expired, which is the truth.
 */
@Injectable({ providedIn: 'root' })
export class FocusTimerService {
  readonly state = signal<FocusTimerState>(createFocusTimer());
  private owner: FocusTimerOwner | null = null;
  /** What is already on disk, so a `sync` that changes nothing does not rewrite the entry. */
  private persisted: string | null = null;

  /** Reconcile the local commitment with the session currently published by the main process. */
  sync(sessionId: string | undefined, taskId: string | undefined, now: number): void {
    if (sessionId === undefined || taskId === undefined) {
      this.owner = null;
      this.state.set(createFocusTimer());
      this.persist();
      return;
    }

    const nextOwner = { sessionId, taskId };
    if (
      this.owner === null ||
      this.owner.sessionId !== nextOwner.sessionId ||
      this.owner.taskId !== nextOwner.taskId
    ) {
      this.owner = nextOwner;
      const stored = readStored();
      const restored =
        stored !== null &&
        stored.owner.sessionId === nextOwner.sessionId &&
        stored.owner.taskId === nextOwner.taskId
          ? // Recomputed from `endAtMs`, never trusting the stored remainder.
            tick(stored.state, now)
          : createFocusTimer();
      this.state.set(restored);
      this.persist();
      return;
    }

    this.state.update((value) => tick(value, now));
    this.persist();
  }

  /** Replace the local state after an explicit timer transition. */
  set(value: FocusTimerState): void {
    this.state.set(value);
    this.persist();
  }

  /** Apply an explicit timer transition without exposing the signal to the page. */
  update(update: (value: FocusTimerState) => FocusTimerState): void {
    this.state.update(update);
    this.persist();
  }

  private persist(): void {
    const value =
      this.owner === null ? null : JSON.stringify({ owner: this.owner, state: this.state() });
    if (value === this.persisted) return;
    this.persisted = value;
    writeRaw(value);
  }
}
