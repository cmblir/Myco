// NotchMascot's one DOM-facing rule that a node test can hold: it hears
// prefers-reduced-motion change. Read once per render, a flip mid-clip left
// the strip loop running until something else re-rendered, which for a quiet
// idle notch dozing could be hours (decision 6: reduced motion, no clips).

import { afterEach, describe, expect, it, vi } from "vitest";
import { prefersReducedMotion, subscribeReducedMotion } from "./NotchMascot";

describe("NotchMascot's reduced-motion feed", () => {
  afterEach(() => void vi.unstubAllGlobals());

  it("tells its subscriber when the preference flips, and lets go after", () => {
    const listeners = new Set<() => void>();
    let matches = false;
    vi.stubGlobal("window", {
      matchMedia: (media: string) => ({
        media,
        get matches() {
          return media === "(prefers-reduced-motion: reduce)" && matches;
        },
        addEventListener: (type: string, cb: () => void) => {
          if (type === "change") listeners.add(cb);
        },
        removeEventListener: (type: string, cb: () => void) => {
          if (type === "change") listeners.delete(cb);
        },
      }),
    });
    const onChange = vi.fn();
    const stop = subscribeReducedMotion(onChange);
    expect(prefersReducedMotion()).toBe(false);

    matches = true;
    for (const cb of listeners) cb();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(prefersReducedMotion()).toBe(true);

    stop();
    expect(listeners.size).toBe(0);
  });
});
