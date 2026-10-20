// The graph toolbar's "더 보기" (UX S44). The toolbar was eight unnamed icons;
// zoom out / fit / zoom in stay as icons, and the rest (timelapse, record,
// spaceship, settings, help) are named items here.

import { useEffect, useRef, useState } from "react";
import type { JSX, KeyboardEvent, MutableRefObject } from "react";
import type { Strings } from "../lib/i18n";

export interface MoreItem {
  key: string;
  label: string;
  onSelect: () => void;
  /** A toggle: shown checked while on. */
  pressed?: boolean;
  disabled?: boolean;
}

/** What a key does inside the open menu: the item index to focus, "close"
 *  (Esc), "leave" (Tab: close and let focus move on), or null. */
export function menuKey(
  key: string,
  i: number,
  len: number,
): number | "close" | "leave" | null {
  if (key === "Escape") return "close";
  if (key === "Tab") return "leave";
  if (key === "ArrowDown") return (i + 1) % len;
  if (key === "ArrowUp") return (i - 1 + len) % len;
  return null;
}

export default function GraphMoreMenu({
  t,
  items,
  buttonRef,
}: {
  t: Strings;
  items: MoreItem[];
  /** The page hands focus back here when the settings drawer closes. */
  buttonRef?: MutableRefObject<HTMLButtonElement | null>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const ownRef = useRef<HTMLButtonElement | null>(null);
  const btnRef = buttonRef ?? ownRef;

  // A click anywhere else closes it, like any menu.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const close = (): void => {
    setOpen(false);
    btnRef.current?.focus();
  };

  function onKey(e: KeyboardEvent<HTMLUListElement>): void {
    const all = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>(
        "button:not(:disabled)",
      ),
    );
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    const act = menuKey(e.key, i, all.length);
    if (act === null) return;
    if (act === "leave") {
      // Focus goes home and the browser's Tab moves on from there.
      close();
      return;
    }
    e.preventDefault();
    if (act === "close") {
      // The page spends Esc on the inspector or a focus level otherwise.
      e.stopPropagation();
      close();
      return;
    }
    all[act]?.focus();
  }

  return (
    <div className="graph-more" ref={rootRef}>
      <button
        ref={btnRef}
        type="button"
        className="u-btn u-btn--quiet graph-more__btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {t.gr_more_menu}
        <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <ul
          className="myco-menu graph-more__menu"
          role="menu"
          aria-label={t.gr_more_menu}
          onKeyDown={onKey}
        >
          {items.map((it, i) => (
            <li key={it.key} role="none">
              <button
                type="button"
                role={
                  it.pressed === undefined ? "menuitem" : "menuitemcheckbox"
                }
                aria-checked={it.pressed}
                disabled={it.disabled}
                // Arrows walk the items; Tab leaves the menu.
                tabIndex={-1}
                autoFocus={i === 0}
                onClick={() => {
                  // Focus goes home first, so a panel the item opens
                  // (help, settings) hands it back to this button.
                  close();
                  it.onSelect();
                }}
              >
                <span className="graph-more__check" aria-hidden="true">
                  {it.pressed ? "✓" : ""}
                </span>
                {it.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
