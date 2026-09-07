// The control kit. vitest runs in the `node` environment with no DOM testing
// library in the repo (see vitest.config.ts), so these tests do two things
// instead of driving a live DOM:
//
//   1. render each part to static markup with react-dom/server — enough to
//      assert the real element, the ARIA wiring and the tab order, which is
//      what "keyboard reachable" means before any event fires;
//   2. cover the interactive decision as a pure function — nextSegmentIndex,
//      which is the whole of Segment's arrow-key behaviour including the
//      "report the value once" guard.
//
// Dispatching an actual keydown would need jsdom, which is not installed.

import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button, Check, Chip, IconButton, Segment, nextSegmentIndex } from "./index";

type View = "list" | "board" | "calendar";
const VIEWS = [
  { value: "list" as View, label: "List" },
  { value: "board" as View, label: "Board", count: 12 },
  { value: "calendar" as View, label: "Calendar" },
];

const noop = (): void => undefined;

describe("Button", () => {
  it("renders a real button that does not submit a surrounding form", () => {
    const html = renderToStaticMarkup(h(Button, {}, "Run lint"));
    expect(html).toContain("<button");
    expect(html).toContain('type="button"');
    expect(html).toContain("Run lint");
  });

  it("gives each variant one class, and the default variant no modifier", () => {
    expect(renderToStaticMarkup(h(Button, {}, "x"))).toContain('class="u-btn"');
    expect(renderToStaticMarkup(h(Button, { variant: "primary" }, "x"))).toContain(
      "u-btn u-btn--primary",
    );
    expect(renderToStaticMarkup(h(Button, { variant: "quiet" }, "x"))).toContain(
      "u-btn u-btn--quiet",
    );
  });

  it("is keyboard reachable — never taken out of the tab order", () => {
    const html = renderToStaticMarkup(h(Button, { onClick: noop }, "x"));
    expect(html).not.toContain("tabindex");
  });

  it("keeps a caller's className and disabled state", () => {
    const html = renderToStaticMarkup(h(Button, { disabled: true, className: "mine" }, "x"));
    expect(html).toContain("mine");
    expect(html).toContain("disabled");
  });
});

describe("IconButton", () => {
  it("renders a labelled button — the label is the only way it is announced", () => {
    const html = renderToStaticMarkup(
      h(IconButton, { "aria-label": "Close", onClick: noop }, "×"),
    );
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain("u-iconbtn");
    expect(html).toContain('type="button"');
  });

  it("is keyboard reachable", () => {
    const html = renderToStaticMarkup(h(IconButton, { "aria-label": "Close" }, "×"));
    expect(html).not.toContain("tabindex");
  });
});

describe("Segment", () => {
  it("renders one group with a name and one pressed option", () => {
    const html = renderToStaticMarkup(
      h(Segment<View>, { options: VIEWS, value: "board", onChange: noop, label: "View" }),
    );
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="View"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(2);
  });

  it("renders an optional count and omits it otherwise", () => {
    const html = renderToStaticMarkup(
      h(Segment<View>, { options: VIEWS, value: "list", onChange: noop, label: "View" }),
    );
    expect(html).toContain("12");
    expect(html.match(/u-segment__count/g)).toHaveLength(1);
  });

  it("is one tab stop — roving tabindex, so Tab skips past the group", () => {
    const html = renderToStaticMarkup(
      h(Segment<View>, { options: VIEWS, value: "calendar", onChange: noop, label: "View" }),
    );
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/tabindex="-1"/g)).toHaveLength(2);
  });

  it("keeps the first option reachable when nothing matches the value", () => {
    const html = renderToStaticMarkup(
      h(Segment<View>, {
        options: VIEWS,
        value: "nope" as View,
        onChange: noop,
        label: "View",
      }),
    );
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).not.toContain('aria-pressed="true"');
  });
});

describe("nextSegmentIndex", () => {
  it("moves right and left by one", () => {
    expect(nextSegmentIndex("ArrowRight", 0, 3)).toBe(1);
    expect(nextSegmentIndex("ArrowLeft", 2, 3)).toBe(1);
  });

  it("wraps at both ends like a native radio group", () => {
    expect(nextSegmentIndex("ArrowRight", 2, 3)).toBe(0);
    expect(nextSegmentIndex("ArrowLeft", 0, 3)).toBe(2);
  });

  it("jumps to the ends with Home and End", () => {
    expect(nextSegmentIndex("Home", 2, 3)).toBe(0);
    expect(nextSegmentIndex("End", 0, 3)).toBe(2);
  });

  it("treats Up/Down as Left/Right, for a segment stacked in a narrow rail", () => {
    expect(nextSegmentIndex("ArrowDown", 0, 3)).toBe(1);
    expect(nextSegmentIndex("ArrowUp", 0, 3)).toBe(2);
  });

  // These four are the "reports the chosen value once" guarantee: Segment
  // calls onChange only when this returns a number, so a no-op keypress
  // reports nothing at all rather than re-reporting the current value.
  it("reports nothing for a key that is not navigation", () => {
    for (const key of ["Tab", "Enter", " ", "a", "Escape"]) {
      expect(nextSegmentIndex(key, 1, 3)).toBeNull();
    }
  });

  it("reports nothing when the move lands back on the current option", () => {
    expect(nextSegmentIndex("ArrowRight", 0, 1)).toBeNull();
    expect(nextSegmentIndex("ArrowLeft", 0, 1)).toBeNull();
    expect(nextSegmentIndex("Home", 0, 3)).toBeNull();
    expect(nextSegmentIndex("End", 2, 3)).toBeNull();
  });

  it("reports nothing for an empty group", () => {
    expect(nextSegmentIndex("ArrowRight", 0, 0)).toBeNull();
  });
});

describe("Chip", () => {
  it("renders a label, and a mono value only when given one", () => {
    expect(renderToStaticMarkup(h(Chip, { label: "Cited" }))).not.toContain("u-chip__value");
    const withValue = renderToStaticMarkup(h(Chip, { label: "Cited", value: "38/41" }));
    expect(withValue).toContain("38/41");
    expect(withValue).toContain("u-chip__value");
  });

  it("carries a dot with every tone, so the tone is never colour-only", () => {
    expect(renderToStaticMarkup(h(Chip, { label: "x" }))).not.toContain("u-chip__dot");
    for (const tone of ["live", "ok", "warn"] as const) {
      const html = renderToStaticMarkup(h(Chip, { label: "x", tone }));
      expect(html).toContain(`u-chip--${tone}`);
      expect(html).toContain("u-chip__dot");
    }
  });
});

describe("Check", () => {
  it("renders real checkbox semantics inside its own label", () => {
    const html = renderToStaticMarkup(
      h(Check, { checked: true, onChange: noop, label: "Only open" }),
    );
    expect(html).toContain("<label");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
    expect(html).toContain("Only open");
    // Keyboard reachable: an <input> is focusable by default, and nothing here
    // removes it from the tab order.
    expect(html).not.toContain("tabindex");
  });

  it("reflects unchecked and disabled in the wrapper's state classes", () => {
    const off = renderToStaticMarkup(h(Check, { checked: false, onChange: noop, label: "x" }));
    expect(off).not.toContain("is-on");
    const off2 = renderToStaticMarkup(
      h(Check, { checked: false, onChange: noop, label: "x", disabled: true }),
    );
    expect(off2).toContain("is-disabled");
    expect(off2).toContain("disabled");
  });
});
