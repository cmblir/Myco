// The shared bottom sheet (UX S49). The node env has no DOM, so the sheet's
// decisions are pure functions: where it sits over a soft keyboard, how tall
// it may grow, and how far a drag down closes it. Focus is useModalFocus's
// (its own tests); the drag and the keyboard are checked in the browser.

import { describe, expect, it } from "vitest";
import { SHEET_QUERY, sheetDragCloses, sheetFrame } from "./Sheet";

describe("sheetFrame", () => {
  it("sits on the bottom edge and takes up to 85% of the window with no keyboard", () => {
    expect(sheetFrame({ height: 800, offsetTop: 0 }, 800)).toEqual({ bottom: 0, maxHeight: 680 });
  });

  it("rides above a soft keyboard, sized to the visible part", () => {
    // A 300px keyboard leaves a 500px visual viewport.
    expect(sheetFrame({ height: 500, offsetTop: 0 }, 800)).toEqual({ bottom: 300, maxHeight: 425 });
  });

  it("follows a visual viewport the page has scrolled under the keyboard", () => {
    expect(sheetFrame({ height: 500, offsetTop: 100 }, 800).bottom).toBe(200);
  });

  it("falls back to the layout viewport where visualViewport is missing", () => {
    expect(sheetFrame(null, 640)).toEqual({ bottom: 0, maxHeight: 544 });
  });
});

describe("sheetDragCloses", () => {
  it("closes on a deliberate drag down, not on a nudge or an upward drag", () => {
    expect(sheetDragCloses(80)).toBe(true);
    expect(sheetDragCloses(20)).toBe(false);
    expect(sheetDragCloses(-200)).toBe(false);
  });
});

describe("SHEET_QUERY", () => {
  // The same reach as the 44px rules (UX S47): a phone width, or any touch
  // screen at any width. A desktop with a mouse keeps its dropdowns.
  it("is a narrow window or a coarse pointer", () => {
    expect(SHEET_QUERY).toBe("(max-width: 768px), (any-pointer: coarse)");
  });
});
