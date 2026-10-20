// Tab / Shift+Tab cycling inside a modal — DialogHost's lightweight focus
// trap, shared so every modal (the Tidy sheet too) keeps focus the same way.

import type { KeyboardEvent } from "react";

/** Elements that can receive keyboard focus inside a dialog. */
export const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Keep a Tab keydown inside `dialog`: wrap from last to first and back. */
export function trapTab(e: KeyboardEvent, dialog: HTMLElement | null): void {
  if (e.key !== "Tab" || !dialog) return;
  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>(FOCUSABLE),
  ).filter((el) => el.offsetParent !== null || el === document.activeElement);
  if (focusable.length === 0) {
    e.preventDefault();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;
  // The dialog itself (tabIndex -1, focused by a click on its text) counts as
  // outside: Shift+Tab from it would otherwise leave for the page behind.
  const inside = active !== dialog && dialog.contains(active);
  if (e.shiftKey) {
    if (active === first || !inside) {
      e.preventDefault();
      last.focus();
    }
  } else if (active === last || !inside) {
    e.preventDefault();
    first.focus();
  }
}
