/**
 * Which way an anchored panel opens.
 *
 * One rule, and it exists because CSS could not express it: below the control when the panel fits there,
 * above it when it does not. The tutor panel was pinned below (`top: calc(100% + 8px)`), and the focus
 * screen puts that control in a row near the bottom edge — so the panel opened into the ~100px left under
 * it and ran off the window, with its question box half outside the screen. Whether it fits depends on
 * where the control is at the moment it opens and on the panel's own height, and there is no selector for
 * either.
 *
 * Geometry in, one word out, so the rule is falsifiable without a window (this app's tests run in node
 * with no TestBed, which is why it is not a method on the component).
 */

export type PanelPlacement = 'above' | 'below';

/** The anchor's box, in viewport coordinates — the two edges that decide the answer. */
export interface AnchorBox {
  /** Distance from the viewport's top edge to the anchor's top edge. */
  readonly top: number;
  /** Distance from the viewport's top edge to the anchor's bottom edge. */
  readonly bottom: number;
}

/**
 * Where the panel should open.
 *
 * `panelHeight` is the panel's measured height and `gap` the distance the stylesheet keeps between it and
 * its anchor. Below wins ties: it is the direction the panel has always opened in, so the common case
 * stays visually unchanged and only the cramped case moves.
 */
export function resolvePanelPlacement(
  anchor: AnchorBox,
  panelHeight: number,
  viewportHeight: number,
  gap: number,
): PanelPlacement {
  const below = viewportHeight - anchor.bottom - gap;
  if (below >= panelHeight) return 'below';

  const above = anchor.top - gap;
  if (above >= panelHeight) return 'above';

  /*
   * Neither side holds the whole panel, so it will be cut off somewhere: it opens where more of it is
   * left. The panel's height is capped in the stylesheet, so this is the "tall panel, short window" case
   * rather than a stand-in for "we could not measure it" — that case is `panelHeight === 0`, which the
   * first test sends below, where it opened before.
   */
  return above > below ? 'above' : 'below';
}
