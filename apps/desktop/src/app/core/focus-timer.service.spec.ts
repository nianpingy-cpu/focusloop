import { describe, expect, it } from 'vitest';
import { start } from './focus-timer';
import { FocusTimerService } from './focus-timer.service';

describe('FocusTimerService', () => {
  it('keeps an active commitment when the focus page is recreated', () => {
    const service = new FocusTimerService();

    service.sync('session-1', 'task-1', 0);
    service.set(start(service.state(), 0));

    // A route change destroys FocusPage, but the root service is still alive.
    service.sync('session-1', 'task-1', 1_000);

    expect(service.state()).toMatchObject({
      phase: 'active',
      remainingMs: 179_000,
      endAtMs: 180_000,
    });
  });

  it('drops the local commitment when the session or task changes', () => {
    const service = new FocusTimerService();

    service.sync('session-1', 'task-1', 0);
    service.set(start(service.state(), 0));
    service.sync('session-2', 'task-1', 1_000);

    expect(service.state().phase).toBe('ready');
  });

  /** A `localStorage` for the Node test run, installed and removed around one case. */
  function withStorage(run: () => void): void {
    const store = new Map<string, string>();
    const previous = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key),
    };
    try {
      run();
    } finally {
      if (previous === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
      else (globalThis as { localStorage?: unknown }).localStorage = previous;
    }
  }

  it('restores an active commitment after a reload, recomputed from the clock', () => {
    withStorage(() => {
      const first = new FocusTimerService();
      first.sync('session-1', 'task-1', 1_000);
      first.set(start(first.state(), 1_000)); // ends at 1_000 + 180_000

      // A reload constructs a fresh service at a later clock; it must not hand back three minutes.
      const reloaded = new FocusTimerService();
      reloaded.sync('session-1', 'task-1', 121_000);

      expect(reloaded.state()).toMatchObject({ phase: 'active', remainingMs: 60_000 });
    });
  });

  it('comes back expired, not reset, if it ran out while the app was closed', () => {
    withStorage(() => {
      const first = new FocusTimerService();
      first.sync('session-1', 'task-1', 1_000);
      first.set(start(first.state(), 1_000)); // ends at 181_000

      const reloaded = new FocusTimerService();
      reloaded.sync('session-1', 'task-1', 400_000);

      expect(reloaded.state().phase).toBe('expired');
      expect(reloaded.state().remainingMs).toBe(0);
    });
  });

  it('does not carry a stored commitment onto a different task', () => {
    withStorage(() => {
      const first = new FocusTimerService();
      first.sync('session-1', 'task-1', 1_000);
      first.set(start(first.state(), 1_000));

      const other = new FocusTimerService();
      other.sync('session-1', 'task-2', 2_000);

      expect(other.state().phase).toBe('ready');
    });
  });
});
