// The Survey's two side rails — gaps on the left, legend on the right — fold to
// a thin edge tab so the stage can have their width. `[` and `]` are their
// keys; this is the guard that keeps those keys out of anything being typed.

export type GraphRail = "gaps" | "legend";

/**
 * The width at and under which the frame (styles/ui.css) stacks a wide page's
 * rails under the stage. There the graph's rails get a 0px row, so a fold has
 * nothing to show or bring back: the keys, the chevron and the tab are off.
 */
export const RAILS_STACKED_QUERY = "(max-width: 820px)";

const MODAL = '[aria-modal="true"]';

/**
 * The rail a keydown toggles — `[` the gaps rail, `]` the legend — or null for
 * any other key, an auto-repeat of a held key (it would re-toggle the rail for
 * as long as the key is held), a modified chord (⌘[ is Back), focus in a
 * field, where the bracket is text (the graph's own search box among them),
 * any open modal, which would otherwise fold a rail behind its backdrop (focus
 * need not be inside it: a click on a sheet's text drops focus to <body>), or
 * a window narrow enough to stack the rails (RAILS_STACKED_QUERY).
 */
export function railKey(
  e: Pick<KeyboardEvent, "key" | "repeat" | "metaKey" | "ctrlKey" | "altKey"> & {
    target: EventTarget | null;
  },
): GraphRail | null {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return null;
  const rail = e.key === "[" ? "gaps" : e.key === "]" ? "legend" : null;
  if (!rail) return null;
  const el = e.target as {
    tagName?: string;
    isContentEditable?: boolean;
    closest?: (selector: string) => unknown;
    ownerDocument?: Pick<Document, "querySelector" | "defaultView"> | null;
  } | null;
  const typing =
    !!el &&
    (el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.tagName === "SELECT" ||
      el.isContentEditable === true);
  const doc = el?.ownerDocument ?? globalThis.document;
  const inModal = !!el?.closest?.(MODAL) || !!doc?.querySelector(MODAL);
  const stacked = !!doc?.defaultView?.matchMedia(RAILS_STACKED_QUERY).matches;
  return typing || inModal || stacked ? null : rail;
}

/**
 * The narrowest split pane that keeps both rails open: two 216px rails, their
 * two 20px gaps and the pane's 16px side padding (504px in all) still leave the
 * stage half the pane. A 1280px window's pane is 520px, where the rails left
 * the stage 15px wide and its loading line ran down one letter a row (UX S42).
 */
export const PANE_RAILS_MIN_PX = 2 * (2 * 216 + 2 * 20 + 2 * 16);

/**
 * Whether the graph in a split pane of this width starts with both rails
 * folded to their edge tabs. `null` = not in a split pane: the saved fold
 * state (and the window-width rules in styles/ui.css) decide there.
 */
export function railsFoldInPane(paneWidth: number | null): boolean {
  return paneWidth !== null && paneWidth < PANE_RAILS_MIN_PX;
}

const GESTURE_HINT_KEY = "myco.graph.gestureHint.v1";

/** Whether the touch gesture hint (drag, pinch, tap a star) is still due: it
 *  shows on the first visit only (UX S53). Where storage is missing or throws
 *  it never shows, since nothing could keep it dismissed. */
export function gestureHintDue(store: Pick<Storage, "getItem"> | null): boolean {
  try {
    return store !== null && store.getItem(GESTURE_HINT_KEY) === null;
  } catch {
    return false;
  }
}

/** Record that the hint was shown. A throwing store is left alone: the hint
 *  is not due there anyway (gestureHintDue). */
export function markGestureHintSeen(store: Pick<Storage, "setItem"> | null): void {
  try {
    store?.setItem(GESTURE_HINT_KEY, "1");
  } catch {
    // Nothing to keep; gestureHintDue already answers false for this store.
  }
}
