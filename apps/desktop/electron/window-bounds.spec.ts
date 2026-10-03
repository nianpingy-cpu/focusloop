import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WINDOW_MINIMUM,
  intersectsAnyWorkArea,
  parseWindowState,
  readWindowState,
  restoreWindowBounds,
  writeWindowState,
} from './window-bounds';

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1040 };
/** A second display to the left of the primary, which is what gives work areas negative coordinates. */
const LEFT_HAND = { x: -1280, y: 0, width: 1280, height: 1024 };
const FALLBACK = { width: 1280, height: 840 };

const validState = { x: 100, y: 60, width: 1440, height: 900, maximized: false };

const temporaryDirectories: string[] = [];
function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'focusloop-window-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe('parseWindowState', () => {
  it('accepts a record this app wrote', () => {
    expect(parseWindowState(validState)).toEqual(validState);
    expect(parseWindowState({ ...validState, maximized: true })).toEqual({
      ...validState,
      maximized: true,
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', '1280x840'],
    ['a number', 840],
    ['an empty object', {}],
    ['a missing position', { width: 1280, height: 840, maximized: false }],
    ['a missing flag', { x: 0, y: 0, width: 1280, height: 840 }],
    ['a fractional coordinate', { ...validState, x: 10.5 }],
    ['a fractional size', { ...validState, width: 1440.25 }],
    ['NaN', { ...validState, width: Number.NaN }],
    ['Infinity', { ...validState, height: Number.POSITIVE_INFINITY }],
    ['a zero width', { ...validState, width: 0 }],
    ['a zero height', { ...validState, height: 0 }],
    ['a negative width', { ...validState, width: -1440 }],
    ['a size below the window minimum', { ...validState, width: WINDOW_MINIMUM.width - 1 }],
    ['an absurd size', { ...validState, width: 100_000 }],
    ['a stringified flag', { ...validState, maximized: 'true' }],
    ['a stringified size', { ...validState, width: '1440' }],
  ])('rejects %s rather than half-trusting it', (_label, value) => {
    expect(parseWindowState(value)).toBeNull();
  });
});

describe('intersectsAnyWorkArea', () => {
  it('accepts a rectangle inside, overlapping, or on a display to the left', () => {
    expect(intersectsAnyWorkArea({ x: 0, y: 0, width: 1280, height: 840 }, [PRIMARY])).toBe(true);
    expect(
      intersectsAnyWorkArea({ x: 1900, y: 1000, width: 1280, height: 840 }, [PRIMARY, LEFT_HAND]),
    ).toBe(true);
    expect(intersectsAnyWorkArea({ x: -800, y: 100, width: 1200, height: 800 }, [PRIMARY])).toBe(
      true,
    );
    expect(
      intersectsAnyWorkArea({ x: -1200, y: 0, width: 1280, height: 1024 }, [PRIMARY, LEFT_HAND]),
    ).toBe(true);
  });

  it('rejects a rectangle that no longer touches any display', () => {
    // The second monitor was detached, and the coordinates it used to occupy are now empty space.
    expect(intersectsAnyWorkArea({ x: 2400, y: 0, width: 1280, height: 840 }, [PRIMARY])).toBe(
      false,
    );
    expect(intersectsAnyWorkArea({ x: 0, y: -5000, width: 1280, height: 840 }, [PRIMARY])).toBe(
      false,
    );
  });

  it('does not count a rectangle that only touches an edge, because that is zero visible pixels', () => {
    expect(intersectsAnyWorkArea({ x: 1920, y: 0, width: 1280, height: 840 }, [PRIMARY])).toBe(
      false,
    );
  });

  it('has nothing to intersect when no display is reported', () => {
    expect(intersectsAnyWorkArea({ x: 0, y: 0, width: 1280, height: 840 }, [])).toBe(false);
  });
});

describe('restoreWindowBounds', () => {
  it('centres at the default size when nothing was stored', () => {
    expect(restoreWindowBounds(null, [PRIMARY], FALLBACK)).toEqual({
      width: FALLBACK.width,
      height: FALLBACK.height,
      maximized: false,
    });
  });

  it('keeps a size and position that are still on a display', () => {
    expect(restoreWindowBounds(validState, [PRIMARY], FALLBACK)).toEqual({
      width: 1440,
      height: 900,
      x: 100,
      y: 60,
      maximized: false,
    });
  });

  it('drops only the position when the display it was on is gone', () => {
    const away = { x: 2400, y: 200, width: 1440, height: 900, maximized: false };
    expect(restoreWindowBounds(away, [PRIMARY], FALLBACK)).toEqual({
      width: 1440,
      height: 900,
      maximized: false,
    });
  });

  it('keeps a position on a display that is still attached, including negative coordinates', () => {
    const leftHand = { x: -1200, y: 0, width: 1280, height: 1024, maximized: false };
    expect(restoreWindowBounds(leftHand, [PRIMARY, LEFT_HAND], FALLBACK)).toEqual({
      width: 1280,
      height: 1024,
      x: -1200,
      y: 0,
      maximized: false,
    });
  });

  it('carries the maximised flag through, with the size to return to', () => {
    expect(restoreWindowBounds({ ...validState, maximized: true }, [PRIMARY], FALLBACK)).toEqual({
      width: 1440,
      height: 900,
      x: 100,
      y: 60,
      maximized: true,
    });
  });
});

describe('the stored file', () => {
  it('round-trips, and treats anything unreadable as "no stored state"', () => {
    const path = join(temporaryDirectory(), 'window-state.json');
    expect(readWindowState(path)).toBeNull();

    writeWindowState(path, { ...validState, maximized: true });
    expect(readWindowState(path)).toEqual({ ...validState, maximized: true });

    writeFileSync(path, '{ this is not json');
    expect(readWindowState(path)).toBeNull();

    writeFileSync(path, JSON.stringify({ width: 0, height: 0, maximized: true }));
    expect(readWindowState(path)).toBeNull();
  });

  it('creates the directory it needs and never throws when it cannot write', () => {
    const nested = join(temporaryDirectory(), 'nested', 'deeper', 'window-state.json');
    writeWindowState(nested, validState);
    expect(readWindowState(nested)).toEqual(validState);

    // A directory where the file should be is unwritable; closing a window must still succeed.
    expect(() => writeWindowState(temporaryDirectory(), validState)).not.toThrow();
  });
});
