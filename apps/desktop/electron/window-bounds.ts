import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Window geometry, kept away from Electron so the rules can be tested without launching anything.
 *
 * Two jobs live here: validating what was stored (a hand-edited or truncated record must not produce a
 * zero-sized or unreachable window), and deciding whether a stored position is still worth honouring
 * (a second monitor that is no longer attached must not park the window off every display).
 */

export interface WindowBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WindowState extends WindowBounds {
  readonly maximized: boolean;
}

/** A display's usable rectangle, in the shape Electron reports it (`Display.workArea`). */
export interface WorkArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Matches the window's own minimums, so a stored size can never ask for something smaller. */
export const WINDOW_MINIMUM = { width: 960, height: 640 } as const;

/**
 * A ceiling for a *stored* value, not a policy on what a user may resize to: anything larger is a
 * hand-edited record, and Electron's own limits are around 2^15.
 */
const MAXIMUM_PLAUSIBLE = 32_000;

function plausibleInteger(value: unknown, minimum: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= MAXIMUM_PLAUSIBLE
  );
}

/**
 * A stored state, or `null` when any part of it is unusable. Rejecting the whole record rather than
 * salvaging fields is deliberate: a half-trusted rectangle is how a window ends up 0×0 in a corner.
 */
export function parseWindowState(value: unknown): WindowState | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const { x, y, width, height, maximized } = record;
  if (typeof maximized !== 'boolean') return null;
  if (!plausibleInteger(width, WINDOW_MINIMUM.width)) return null;
  if (!plausibleInteger(height, WINDOW_MINIMUM.height)) return null;
  // A position may be negative - a display left of the primary has negative coordinates - but never
  // further out than the size ceiling, and never fractional.
  if (!plausibleInteger(x, -MAXIMUM_PLAUSIBLE)) return null;
  if (!plausibleInteger(y, -MAXIMUM_PLAUSIBLE)) return null;
  return { x, y, width, height, maximized };
}

/** Whether any part of the rectangle lands inside a display's usable area. */
export function intersectsAnyWorkArea(
  bounds: WindowBounds,
  workAreas: readonly WorkArea[],
): boolean {
  return workAreas.some(
    (area) =>
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y,
  );
}

export interface RestoredWindow {
  readonly width: number;
  readonly height: number;
  /** Absent when the stored position is unusable, which is what makes Electron centre the window. */
  readonly x?: number;
  readonly y?: number;
  readonly maximized: boolean;
}

/**
 * What to open with.
 *
 * A size is kept whenever it is plausible; a position is kept only while it still lands on an attached
 * display. When it does not, the position is dropped rather than clamped, so the window opens centred
 * on the primary display instead of pinned to an edge of one that is gone.
 */
export function restoreWindowBounds(
  stored: WindowState | null,
  workAreas: readonly WorkArea[],
  fallback: { readonly width: number; readonly height: number },
): RestoredWindow {
  if (stored === null) {
    return { width: fallback.width, height: fallback.height, maximized: false };
  }
  const onScreen = intersectsAnyWorkArea(stored, workAreas);
  return {
    width: stored.width,
    height: stored.height,
    ...(onScreen ? { x: stored.x, y: stored.y } : {}),
    maximized: stored.maximized,
  };
}

/** A missing, unreadable or malformed file is simply "no stored state". */
export function readWindowState(path: string): WindowState | null {
  try {
    return parseWindowState(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

/** Best effort: a window that cannot record its geometry must still close. */
export function writeWindowState(path: string, state: WindowState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state)}\n`);
  } catch {
    // Nothing to do and nothing to tell the user: the next launch just opens at the default size.
  }
}
