// The one modal focus contract. Every modal (DialogHost, the Tidy sheet, the
// onboarding wizard, a board widget's detail) moves focus in on open, keeps
// Tab inside, closes on Escape, and hands focus back to whatever had it
// before. Built on lib/focusTrap so the Tab rule stays in one place.

import { useEffect, useLayoutEffect, useRef } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { FOCUSABLE, trapTab } from "../lib/focusTrap";
import { isComposingKey } from "../lib/ime";

export interface ModalFocusOptions {
  /** Truthy while the modal shows. A new value (DialogHost's next request)
   *  counts as a fresh open: the opener is taken again. */
  open: unknown;
  onEscape: () => void;
  /** Where focus lands on open; the first focusable control when this is
   *  absent or returns null. */
  initial?: () => HTMLElement | null;
  /** When this changes (a wizard step, a sheet phase) and focus has fallen
   *  out of the modal — its button unmounted — focus goes back in. */
  shape?: unknown;
}

/** Focus `initial()`, else the first focusable control in `dialog`. */
export function focusInto(
  dialog: HTMLElement | null,
  initial?: () => HTMLElement | null,
): void {
  if (!dialog) return;
  (initial?.() ?? dialog.querySelector<HTMLElement>(FOCUSABLE))?.focus();
}

/** Give `opener` focus back when a close left it on <body>. A close that put
 *  focus somewhere already (a page or a modal took it) keeps that, and an
 *  opener the close removed (the route changed) is skipped. */
export function returnFocus(opener: HTMLElement | null): void {
  const active = document.activeElement;
  if (active && active !== document.body) return;
  if (opener?.isConnected) opener.focus();
}

/** Escape closes (and stops there); Tab and Shift+Tab stay inside. An
 *  Escape that cancels an IME candidate is the IME's, not a close. */
export function modalKeyDown(
  e: KeyboardEvent<HTMLElement>,
  dialog: HTMLElement | null,
  onEscape: () => void,
): void {
  if (e.key === "Escape" && isComposingKey(e)) return;
  if (e.key === "Escape") {
    e.stopPropagation();
    onEscape();
    return;
  }
  trapTab(e, dialog);
}

/**
 * Wire a modal to the contract. Put the returned `onKeyDown` on the element
 * `ref` points at, and give that element `tabIndex={-1}`: a click on its text
 * then focuses the modal instead of <body>, where no keydown reaches it and
 * Escape stopped closing it. `opener` is what had focus before the modal
 * opened: focus returns there on close, and a host that must restore it
 * earlier (DialogHost, before its caller's code resumes) reads it.
 */
export function useModalFocus(
  ref: RefObject<HTMLElement | null>,
  { open, onEscape, initial, shape }: ModalFocusOptions,
): { onKeyDown: (e: KeyboardEvent<HTMLElement>) => void; opener: RefObject<HTMLElement | null> } {
  const opener = useRef<HTMLElement | null>(null);
  const initialRef = useRef(initial);
  initialRef.current = initial;

  useLayoutEffect(() => {
    if (!open) return;
    opener.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // A text field takes focus in this commit, before the next keystroke: with
    // focus left where it was, a fast ⌘N + typing sent the first characters to
    // the page. A button waits for the timer below — focused inside the Enter
    // keydown that opened the modal (a palette row), it takes that key's click
    // and closes the modal again.
    const el = initialRef.current?.();
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.focus();
    return () => opener.current?.focus();
  }, [open, ref]);

  // After every effect of this commit has run (a closing menu hands focus
  // back to its trigger) and the opening key is done, and again whenever the
  // content changes shape: focus goes in unless it is already there.
  useEffect(() => {
    if (!open) return;
    const id = setTimeout(() => {
      const d = ref.current;
      if (d && !d.contains(document.activeElement)) focusInto(d, initialRef.current);
    }, 0);
    return () => clearTimeout(id);
  }, [open, shape, ref]);

  return { onKeyDown: (e) => modalKeyDown(e, ref.current, onEscape), opener };
}
