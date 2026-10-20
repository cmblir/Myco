// Pointer-event drag for the task board and calendar.
//
// HTML5 drag-and-drop is dead inside the macOS Tauri webview: tauri-runtime-wry
// registers a drag-drop handler that always claims the drag (so OS file drops
// reach `onDragDropEvent`), and wry only forwards draggingUpdated /
// performDragOperation to WebKit when that handler declines. The page therefore
// never sees `dragover`/`drop`. We cannot turn the handler off — Ingest and the
// notch rely on it for file drops — so in-page drags use pointer events instead.
//
// `createPointerDrag` is the pure state machine (tested in node);
// `usePointerDrag` is the thin React wiring around it.

import { useRef, useState } from "react";

export interface DragLive<T> {
  id: string;
  /** What is under the pointer right now; null while over nothing droppable. */
  target: T | null;
}

export interface PointerDragMachine {
  /** `held: false` (a finger) needs `hold()` before travel counts as a drag;
   *  travel before it is a scroll and lets the press go. */
  begin(id: string, x: number, y: number, held?: boolean): void;
  /** The finger held still long enough: the press may now drag. False when
   *  no press is pending (it was let go, or is already a drag). */
  hold(): boolean;
  move(x: number, y: number): void;
  /** Drops on the current target (if any). Returns whether a drag was live —
   *  the caller uses it to swallow the click that follows pointerup. */
  end(): boolean;
  /** Abandons the drag with no drop. Same return as `end`. */
  cancel(): boolean;
}

/** Pointer travel (px) before a press becomes a drag; below it, a click.
 *  A long press (lib/longPress) cancels on the same travel. */
export const DRAG_THRESHOLD = 4;

export function createPointerDrag<T>(opts: {
  /** Pointer travel (px) before a press becomes a drag; below it, a click. */
  threshold?: number;
  targetAt: (x: number, y: number) => T | null;
  onChange: (live: DragLive<T> | null) => void;
  onDrop: (id: string, target: T) => void;
}): PointerDragMachine {
  const threshold = opts.threshold ?? DRAG_THRESHOLD;
  let pending: { id: string; x: number; y: number; held: boolean } | null = null;
  let live: DragLive<T> | null = null;

  const finish = (): boolean => {
    const wasLive = live !== null;
    pending = null;
    live = null;
    if (wasLive) opts.onChange(null);
    return wasLive;
  };

  return {
    begin(id, x, y, held = true) {
      pending = { id, x, y, held };
      live = null;
    },
    hold() {
      if (!pending) return false;
      pending.held = true;
      return true;
    },
    move(x, y) {
      if (pending) {
        if (Math.hypot(x - pending.x, y - pending.y) < threshold) return;
        if (!pending.held) {
          pending = null;
          return;
        }
        live = { id: pending.id, target: null };
        pending = null;
        opts.onChange(live);
      }
      if (!live) return;
      const target = opts.targetAt(x, y);
      if (target === live.target) return;
      live = { id: live.id, target };
      opts.onChange(live);
    },
    end() {
      const dropped = live;
      const wasLive = finish();
      if (dropped && dropped.target !== null)
        opts.onDrop(dropped.id, dropped.target);
      return wasLive;
    },
    cancel: finish,
  };
}

/// The drop target under a point: the nearest ancestor carrying `data-drop`.
/// Elements with `pointer-events: none` are skipped by hit-testing, which is how
/// a dragged calendar bar lets the day cell beneath it be found.
export function dropTargetAt(x: number, y: number): string | null {
  return (
    document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop]")
      ?.dataset.drop ?? null
  );
}

/** How long a finger holds a card still before it lifts (UX S52). Shorter
 *  than a menu's long press: here the hold is the start of a gesture. */
export const HOLD_TO_DRAG_MS = 300;

/// Wires the machine to window pointer events. Spread `start(id)` onto a
/// draggable element's `onPointerDown`; mark drop zones with `data-drop`.
/// `live` drives the `.is-dragging` / `.is-over` classes; `consumeClick()` in the
/// source's onClick returns true when that click was really the end of a drag.
/// A finger drags only after holding still HOLD_TO_DRAG_MS; a swipe before
/// that scrolls the page. `held` names the card a finger holds, for its
/// `.is-held` look (and `touch-action: none`).
export function usePointerDrag(
  onDrop: (id: string, target: string) => void,
  enabled: boolean,
): {
  live: DragLive<string> | null;
  held: string | null;
  start: (id: string) => (e: React.PointerEvent) => void;
  consumeClick: () => boolean;
} {
  const [live, setLive] = useState<DragLive<string> | null>(null);
  const [held, setHeld] = useState<string | null>(null);
  const wasDrag = useRef(false);
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  const start = (id: string) => (e: React.PointerEvent) => {
    // Primary button only; a right-click or middle-click is never a drag.
    if (!enabled || e.button !== 0) return;
    wasDrag.current = false;
    const machine = createPointerDrag<string>({
      targetAt: dropTargetAt,
      onChange: setLive,
      onDrop: (dragId, target) => onDropRef.current(dragId, target),
    });
    const touch = e.pointerType === "touch";
    machine.begin(id, e.clientX, e.clientY, !touch);
    // Once held, the browser must not take the finger's travel as a scroll:
    // touch-action is fixed when the touch starts, so a held drag cancels
    // the scroll on touchmove instead.
    const noScroll = (ev: TouchEvent): void => ev.preventDefault();
    const holdTimer = touch
      ? setTimeout(() => {
          if (!machine.hold()) return;
          setHeld(id);
          window.addEventListener("touchmove", noScroll, { passive: false });
        }, HOLD_TO_DRAG_MS)
      : undefined;

    const off = (): void => {
      clearTimeout(holdTimer);
      setHeld(null);
      window.removeEventListener("touchmove", noScroll);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
    };
    const onMove = (ev: PointerEvent): void =>
      machine.move(ev.clientX, ev.clientY);
    const onUp = (): void => {
      off();
      wasDrag.current = machine.end();
    };
    const onCancel = (): void => {
      off();
      wasDrag.current = machine.cancel();
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === "Escape") onCancel();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
  };

  const consumeClick = (): boolean => {
    const was = wasDrag.current;
    wasDrag.current = false;
    return was;
  };

  return { live, held, start, consumeClick };
}
