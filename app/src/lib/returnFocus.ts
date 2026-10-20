// Focus return for panels that open over a page (the graph's inspector and
// gesture help). Every way such a panel closes (Esc, its ×, a void click, a
// rebuild that unmounts it) removes the element holding focus, and the
// browser then drops focus to <body>: a keyboard user loses their place.

import { useLayoutEffect, type RefObject } from "react";

interface Focusable {
  isConnected: boolean;
  focus(): void;
}

/**
 * Where focus goes as a panel closes: back to the control that held it when
 * the panel opened, if the panel holds focus now (otherwise the user already
 * moved on) and that control is still on the page.
 */
export function focusReturnTarget<N, T extends Focusable>(
  panel: { contains(node: N): boolean } | null,
  active: N,
  opener: T | null,
): T | null {
  if (!panel?.contains(active)) return null;
  return opener?.isConnected ? opener : null;
}

/**
 * Hand focus back to the panel's opener when the panel unmounts. A layout
 * cleanup runs before React removes the panel's node, so it can still see
 * whether focus is inside. Re-rendering the panel (the inspector moving to
 * another note) keeps the first opener.
 */
export function useReturnFocus(ref: RefObject<HTMLElement>): void {
  useLayoutEffect(() => {
    const panel = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => focusReturnTarget(panel, document.activeElement, opener)?.focus();
  }, [ref]);
}
