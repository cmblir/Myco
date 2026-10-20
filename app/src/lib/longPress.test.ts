// The secondary long-press path on a tree row (UX S49): one call after the
// hold, none when the finger moved past the drag threshold or lifted early.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LONG_PRESS_MS, createLongPress } from "./longPress";
import { DRAG_THRESHOLD } from "./pointerDrag";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createLongPress", () => {
  it("fires once after the hold, and the lift then says to swallow the click", () => {
    const onFire = vi.fn();
    const press = createLongPress(onFire);
    press.down(10, 10);
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(onFire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFire).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(LONG_PRESS_MS * 3);
    expect(onFire).toHaveBeenCalledOnce();
    expect(press.up()).toBe(true);
  });

  it("holds at 500ms", () => {
    expect(LONG_PRESS_MS).toBe(500);
  });

  it("does not fire when the finger moves past the drag threshold (a scroll)", () => {
    const onFire = vi.fn();
    const press = createLongPress(onFire);
    press.down(10, 10);
    press.move(10, 10 + DRAG_THRESHOLD);
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onFire).not.toHaveBeenCalled();
    expect(press.up()).toBe(false);
  });

  it("tolerates a wobble under the threshold", () => {
    const onFire = vi.fn();
    const press = createLongPress(onFire);
    press.down(10, 10);
    press.move(11, 12);
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(onFire).toHaveBeenCalledOnce();
  });

  it("does not fire on a short tap, nor after a cancel", () => {
    const onFire = vi.fn();
    const press = createLongPress(onFire);
    press.down(0, 0);
    vi.advanceTimersByTime(100);
    expect(press.up()).toBe(false);
    press.down(0, 0);
    press.cancel();
    vi.advanceTimersByTime(LONG_PRESS_MS * 2);
    expect(onFire).not.toHaveBeenCalled();
  });
});
