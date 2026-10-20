// Where a popover opened at the caret goes (the `/recall` and on-this-day
// pickers): pure, so vitest covers it without a DOM.

const MARGIN = 8;

export interface PopoverPlace {
  left: number;
  /** Set when the box hangs under the caret's line… */
  top: number | null;
  /** …or when it sits above the line, anchored by its bottom edge. */
  bottom: number | null;
  /** The room on that side: rows arriving later scroll inside the box. */
  maxHeight: number;
}

/** Under the caret's line (`below` = just under it) while the box's tallest
 *  self (`cap`, its CSS max-height) fits there or there is no more room
 *  above; otherwise above the line (`above` = its top), growing upward.
 *  Never over the line it inserts at, and decided by the room — not by the
 *  content, so it does not jump as results arrive. */
export function popoverPlace(o: {
  x: number;
  above: number;
  below: number;
  width: number;
  cap: number;
  vw: number;
  vh: number;
}): PopoverPlace {
  const left = Math.max(MARGIN, Math.min(o.x, o.vw - o.width - MARGIN));
  // A line scrolled out of the window (the block menu's Ask on a block off
  // screen) pins the box to the nearer edge instead of placing it off it.
  const inside = (y: number): number =>
    Math.min(Math.max(y, MARGIN), o.vh - MARGIN);
  const above = inside(o.above);
  const below = inside(o.below);
  const down = o.vh - below - MARGIN;
  const up = above - MARGIN;
  if (down < o.cap && up > down)
    return {
      left,
      top: null,
      bottom: o.vh - above,
      maxHeight: Math.min(o.cap, up),
    };
  return {
    left,
    top: below,
    bottom: null,
    maxHeight: Math.max(0, Math.min(o.cap, down)),
  };
}
