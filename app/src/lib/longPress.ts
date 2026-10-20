// Long press: the secondary way to open a tree row's menu by touch (UX S49).
// The visible ⋯ button is the primary one; this only saves a reach. A mouse
// never long-presses (desktop keeps its right-click), and iOS WebKit sends no
// `contextmenu` for a held finger, so the hold is timed here.
//
// `createLongPress` is the pure machine (tested in node); `useLongPress` wires
// it to a row's pointer events.

import { useEffect, useRef } from "react";
import type { PointerEvent } from "react";
import { DRAG_THRESHOLD } from "./pointerDrag";

export const LONG_PRESS_MS = 500;

export interface LongPress {
  down(x: number, y: number): void;
  /** Travel past the drag threshold is a scroll or a drag: no press. */
  move(x: number, y: number): void;
  /** Ends the press. True when it fired, so the click that follows is swallowed. */
  up(): boolean;
  cancel(): void;
}

export function createLongPress(onFire: () => void): LongPress {
  let start: { x: number; y: number } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired = false;
  const stop = (): void => {
    clearTimeout(timer);
    start = null;
  };
  return {
    down(x, y) {
      stop();
      fired = false;
      start = { x, y };
      timer = setTimeout(() => {
        start = null;
        fired = true;
        onFire();
      }, LONG_PRESS_MS);
    },
    move(x, y) {
      if (start && Math.hypot(x - start.x, y - start.y) >= DRAG_THRESHOLD) stop();
    },
    up() {
      stop();
      return fired;
    },
    cancel() {
      stop();
      fired = false;
    },
  };
}

/** The click a lifted finger sends after a fired press lands on whatever now
 *  sits under it — the row, or an item of the sheet that just rose there.
 *  Swallow that one click, wherever it lands. */
function swallowNextClick(): void {
  const swallow = (e: Event): void => {
    e.preventDefault();
    e.stopPropagation();
    off();
  };
  const off = (): void => {
    clearTimeout(timer);
    window.removeEventListener("click", swallow, true);
  };
  const timer = setTimeout(off, 600);
  window.addEventListener("click", swallow, true);
}

/** Pointer handlers for an element that opens something on a held finger or
 *  pen. Spread them on the element. */
export function useLongPress(onFire: (el: HTMLElement) => void): {
  onPointerDown: (e: PointerEvent<HTMLElement>) => void;
  onPointerMove: (e: PointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
} {
  const target = useRef<HTMLElement | null>(null);
  const fire = useRef(onFire);
  fire.current = onFire;
  const press = useRef<LongPress | null>(null);
  press.current ??= createLongPress(() => {
    if (target.current) fire.current(target.current);
  });
  useEffect(() => () => press.current?.cancel(), []);
  return {
    onPointerDown: (e) => {
      if (e.pointerType === "mouse" || !e.isPrimary) return;
      target.current = e.currentTarget;
      press.current?.down(e.clientX, e.clientY);
    },
    onPointerMove: (e) => press.current?.move(e.clientX, e.clientY),
    onPointerUp: () => {
      if (press.current?.up()) swallowNextClick();
    },
    onPointerCancel: () => press.current?.cancel(),
  };
}
