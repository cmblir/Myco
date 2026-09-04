// Section focus targets. The activity surfaces (topbar chip popover, tray
// panel) list rows that name a THING — "4 suggested links", "3 reflect
// suggestions" — but several of those things are sections far down the
// Overview page, below OverviewBoard and the recent/distill bands. Routing
// alone therefore landed the user at the TOP of Overview with the named
// section off screen, and did literally nothing when Overview was already the
// route (setRoute to the current route is a no-op). uiStore.focusSection(id)
// names the section; this module makes the section itself react.

import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { Strings } from "./i18n";
import { notice } from "./notice";
import { useUIStore } from "../stores/uiStore";

/** Flash duration — matches `.is-focus-flash` in styles.css. */
const FLASH_MS = 1200;

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Ref for a section a chip/tray row can point at. When focusSection(id)
 *  fires, the element scrolls into view, flashes once, takes keyboard focus
 *  (give it tabIndex={-1}) and consumes the target. */
export function useFocusTarget<T extends HTMLElement>(
  id: string,
): RefObject<T> {
  const ref = useRef<T>(null);
  const target = useUIStore((s) => s.focusTarget);
  useEffect(() => {
    const el = ref.current;
    if (!el || target?.id !== id) return;
    // Consume first: clearing tells useFocusMiss below that this section
    // claimed the target, so no "it's gone" toast fires.
    useUIStore.getState().clearFocusTarget();
    el.scrollIntoView({
      block: "center",
      behavior: reducedMotion() ? "auto" : "smooth",
    });
    // preventScroll: focus() would otherwise fight the smooth scroll above.
    el.focus({ preventScroll: true });
    el.classList.add("is-focus-flash");
    const to = window.setTimeout(
      () => el.classList.remove("is-focus-flash"),
      FLASH_MS,
    );
    return () => window.clearTimeout(to);
  }, [target, id]);
  return ref;
}

/** Mounted once (App): a target no section claimed means the thing the row
 *  named is gone — the count went stale because it was accepted/applied
 *  elsewhere. Say so instead of leaving the user staring at the page top.
 *  Two frames of grace: rAF runs before paint, passive effects after it, so
 *  the second callback lands after any anchor mounted by the route change has
 *  had its effect flushed. */
export function useFocusMiss(t: Strings): void {
  const target = useUIStore((s) => s.focusTarget);
  useEffect(() => {
    if (!target) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        if (useUIStore.getState().focusTarget !== target) return;
        useUIStore.getState().clearFocusTarget();
        notice.info(t.tb_activity_gone ?? "That item is no longer there.");
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [target, t]);
}
