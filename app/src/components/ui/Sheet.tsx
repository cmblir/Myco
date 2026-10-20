// The one bottom sheet (UX S49). On a phone width or a touch screen, a menu
// or a picker rises from the thumb's edge instead of dropping from a button
// at the top. Same modal contract as every other (useModalFocus): focus in,
// Tab kept, Escape closes, focus back. A drag down on the head closes it too,
// and it rides above a soft keyboard (visualViewport).

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { JSX, PointerEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { FOCUSABLE } from "../../lib/focusTrap";
import { useModalFocus } from "../useModalFocus";

/** Where a menu becomes a sheet: the 44px rules' reach (UX S47). */
export const SHEET_QUERY = "(max-width: 768px), (any-pointer: coarse)";

/** Pixels of drag down on the head that close the sheet. */
const CLOSE_DRAG = 64;

export function sheetDragCloses(dy: number): boolean {
  return dy >= CLOSE_DRAG;
}

/** The sheet's bottom offset (above a soft keyboard) and its tallest height:
 *  85% of what is visible. */
export function sheetFrame(
  vv: { height: number; offsetTop: number } | null,
  innerHeight: number,
): { bottom: number; maxHeight: number } {
  const height = vv?.height ?? innerHeight;
  const bottom = vv ? Math.max(0, innerHeight - vv.height - vv.offsetTop) : 0;
  return { bottom, maxHeight: Math.round(height * 0.85) };
}

/** The phone shell's width (UX S50): the bottom bar, the short top bar. */
export const PHONE_QUERY = "(max-width: 768px)";

/** Whether `query` matches now; follows the window and the pointer. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** True where menus open as sheets. */
export function useSheetMode(): boolean {
  return useMediaQuery(SHEET_QUERY);
}

/** sheetFrame, kept current as the window and a soft keyboard move. */
export function useKeyboardFrame(): { bottom: number; maxHeight: number } {
  const read = () => sheetFrame(window.visualViewport ?? null, window.innerHeight);
  const [frame, setFrame] = useState(read);
  useEffect(() => {
    const vv = window.visualViewport;
    const update = (): void => setFrame(read());
    vv?.addEventListener("resize", update);
    vv?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      vv?.removeEventListener("resize", update);
      vv?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return frame;
}

export interface SheetProps {
  /** The sheet's name, read out and shown in its head (a note's name). */
  title: string;
  /** A quiet line under the title (when the note was last changed). */
  meta?: string;
  /** The head's close button. */
  closeLabel: string;
  onClose: () => void;
  children: ReactNode;
}

export function Sheet({ title, meta, closeLabel, onClose, children }: SheetProps): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const frame = useKeyboardFrame();
  const [dragY, setDragY] = useState(0);
  const dragFrom = useRef<number | null>(null);
  // Focus starts on the first item, not the head's close button.
  const { onKeyDown } = useModalFocus(ref, {
    open: true,
    onEscape: onClose,
    initial: () => bodyRef.current?.querySelector<HTMLElement>(FOCUSABLE) ?? null,
  });

  const onDown = (e: PointerEvent<HTMLDivElement>): void => {
    // Not from the close button: that is a tap, not a drag.
    if ((e.target as HTMLElement).closest("button")) return;
    dragFrom.current = e.clientY;
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>): void => {
    if (dragFrom.current !== null) setDragY(Math.max(0, e.clientY - dragFrom.current));
  };
  const onUp = (): void => {
    if (dragFrom.current === null) return;
    dragFrom.current = null;
    if (sheetDragCloses(dragY)) onClose();
    else setDragY(0);
  };

  return createPortal(
    <div className="u-sheet__backdrop" onClick={onClose}>
      <div
        ref={ref}
        className="u-sheet"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{
          bottom: frame.bottom,
          maxHeight: frame.maxHeight,
          transform: dragY ? `translateY(${dragY}px)` : undefined,
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div
          className="u-sheet__head"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          <span className="u-sheet__handle" aria-hidden="true" />
          <div className="u-sheet__titles">
            <h2 id={titleId} className="u-sheet__title">
              {title}
            </h2>
            {meta ? <p className="u-sheet__meta">{meta}</p> : null}
          </div>
          <button type="button" className="u-sheet__close" onClick={onClose}>
            {closeLabel}
          </button>
        </div>
        <div ref={bodyRef} className="u-sheet__body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export default Sheet;
