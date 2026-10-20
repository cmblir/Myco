import { describe, expect, it } from "vitest";
import { popoverPlace } from "./popoverPlace";

// A caret line from `above` (its top) to `below` (just under it).
const at = (above: number, below: number, vh = 900) => ({
  x: 100,
  above,
  below,
  width: 360,
  cap: 420,
  vw: 1280,
  vh,
});

describe("popoverPlace", () => {
  it("opens under the caret's line when its tallest self fits there", () => {
    expect(popoverPlace(at(80, 104))).toEqual({
      left: 100,
      top: 104,
      bottom: null,
      maxHeight: 420,
    });
  });

  it("flips above the line near the bottom, growing upward, never over it", () => {
    // 800×600, the caret line at 427–452: 140 px below, 419 above.
    expect(popoverPlace(at(427, 452, 600))).toEqual({
      left: 100,
      top: null,
      bottom: 600 - 427,
      maxHeight: 419,
    });
  });

  it("stays below, shrunk to the room there, when above is no better", () => {
    expect(popoverPlace(at(140, 160, 300))).toEqual({
      left: 100,
      top: 160,
      bottom: null,
      maxHeight: 132,
    });
  });

  it("keeps the box in the window when the caret's line is scrolled out of it", () => {
    // The block menu's Ask on a block below the fold: its line at 1882–1890.
    expect(popoverPlace(at(1882, 1890, 700))).toEqual({
      left: 100,
      top: null,
      bottom: 8,
      maxHeight: 420,
    });
    expect(popoverPlace(at(-300, -280, 700))).toEqual({
      left: 100,
      top: 8,
      bottom: null,
      maxHeight: 420,
    });
  });

  it("keeps the box inside the window's width", () => {
    expect(popoverPlace({ ...at(80, 104), x: 1000 }).left).toBe(1280 - 360 - 8);
    expect(popoverPlace({ ...at(80, 104), x: -5 }).left).toBe(8);
  });
});
