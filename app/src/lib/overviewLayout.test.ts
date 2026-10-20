// The Overview's layout document (lib/board.ts, overview-layout section). The
// page reads a FILE the user can hand-edit, so the healing path matters as much
// as the moves: a bad document must degrade to a renderable page, because the
// alternative is a blank Overview and no way back to it.
import { describe, expect, it } from "vitest";
import {
  BOARD_COLS,
  defaultOverviewLayout,
  moveOverviewItem,
  moveOverviewItemBefore,
  OVERVIEW_BLOCKS,
  overviewPosition,
  sanitizeOverviewLayout,
  setOverviewSpan,
} from "./board";

const ids = (layout: { items: { id: string }[] }): string[] =>
  layout.items.map((i) => i.id);

describe("defaultOverviewLayout", () => {
  it("is one column: every block in the main zone", () => {
    const d = defaultOverviewLayout();
    expect(d.items.every((i) => i.zone === "main")).toBe(true);
    expect(ids(d)).toEqual([
      "pulse",
      "harvest",
      "links",
      "recent",
      "board",
      "contradictions",
      "reunions",
    ]);
  });

  it("gives every block a slot, full width", () => {
    const d = defaultOverviewLayout();
    expect(ids(d)).toEqual([...OVERVIEW_BLOCKS]);
    expect(d.items.every((i) => i.span === BOARD_COLS)).toBe(true);
  });
});

describe("sanitizeOverviewLayout", () => {
  it("keeps a stored arrangement", () => {
    const stored = {
      version: 1,
      items: [
        { id: "harvest", zone: "main", span: 6 },
        { id: "pulse", zone: "main", span: 6 },
      ],
    };
    const s = sanitizeOverviewLayout(stored);
    expect(ids(s).slice(0, 2)).toEqual(["harvest", "pulse"]);
    expect(s.items[0].span).toBe(6);
  });

  it("ignores an unknown id rather than crashing on it", () => {
    const s = sanitizeOverviewLayout({
      version: 1,
      items: [
        { id: "from-a-newer-build", zone: "main", span: 6 },
        { id: "harvest", zone: "main", span: 6 },
      ],
    });
    expect(ids(s)).not.toContain("from-a-newer-build");
    expect(ids(s)).toHaveLength(OVERVIEW_BLOCKS.length);
  });

  it("appends a block the file never mentioned, at its default position", () => {
    const s = sanitizeOverviewLayout({
      version: 1,
      items: [{ id: "board", zone: "main", span: 12 }],
    });
    expect(ids(s)[0]).toBe("board");
    expect(new Set(ids(s))).toEqual(new Set(OVERVIEW_BLOCKS));
    expect(s.items.every((i) => i.zone === "main")).toBe(true);
  });

  it("drops the since and suspect panels, which are Home's notices now", () => {
    const s = sanitizeOverviewLayout({
      version: 1,
      items: [
        { id: "since", zone: "rail", span: 12 },
        { id: "suspect", zone: "rail", span: 12 },
        { id: "pulse", zone: "main", span: 12 },
      ],
    });
    expect(ids(s)).not.toContain("since");
    expect(ids(s)).not.toContain("suspect");
    expect(ids(s)[0]).toBe("pulse");
  });

  it("clamps spans to the grid", () => {
    const s = sanitizeOverviewLayout({
      version: 1,
      items: [
        { id: "pulse", zone: "main", span: 99 },
        { id: "harvest", zone: "main", span: 0 },
        { id: "links", zone: "main", span: -4 },
        { id: "recent", zone: "main", span: "nonsense" },
      ],
    });
    const span = (id: string): number =>
      s.items.find((i) => i.id === id)?.span ?? -1;
    expect(span("pulse")).toBe(BOARD_COLS);
    expect(span("harvest")).toBe(1);
    expect(span("links")).toBe(1);
    expect(span("recent")).toBe(BOARD_COLS);
  });

  it("collapses a duplicated block to its first mention", () => {
    const s = sanitizeOverviewLayout({
      version: 1,
      items: [
        { id: "pulse", zone: "rail", span: 4 },
        { id: "pulse", zone: "main", span: 12 },
      ],
    });
    expect(ids(s).filter((i) => i === "pulse")).toHaveLength(1);
    // The old rail is gone: its blocks join the one column, width kept.
    expect(s.items[0]).toEqual({ id: "pulse", zone: "main", span: 4 });
  });

  it.each([null, undefined, 42, "a string", {}, { items: "no" }, []])(
    "falls back to the default for %p",
    (bad) => {
      expect(sanitizeOverviewLayout(bad)).toEqual(defaultOverviewLayout());
    },
  );

  it("treats an unknown zone as the main column", () => {
    const s = sanitizeOverviewLayout({
      version: 1,
      items: [{ id: "pulse", zone: "sidebar", span: 12 }],
    });
    expect(s.items[0].zone).toBe("main");
  });
});

describe("moveOverviewItem", () => {
  it("moves one step later inside a zone", () => {
    const m = moveOverviewItem(defaultOverviewLayout(), "pulse", 1);
    expect(ids(m)).toEqual([
      "harvest",
      "pulse",
      "links",
      "recent",
      "board",
      "contradictions",
      "reunions",
    ]);
  });

  it("moves one step earlier inside a zone", () => {
    const m = moveOverviewItem(defaultOverviewLayout(), "recent", -1);
    expect(ids(m)).toEqual([
      "pulse",
      "harvest",
      "recent",
      "links",
      "board",
      "contradictions",
      "reunions",
    ]);
  });

  it("is a no-op at either end, and for a block that is not there", () => {
    const d = defaultOverviewLayout();
    expect(moveOverviewItem(d, "pulse", -1)).toBe(d);
    expect(moveOverviewItem(d, "reunions", 1)).toBe(d);
    expect(moveOverviewItem(d, "nope", 1)).toBe(d);
  });
});

describe("moveOverviewItemBefore (a drop)", () => {
  it("takes the target's place", () => {
    const m = moveOverviewItemBefore(defaultOverviewLayout(), "board", "pulse");
    expect(ids(m)).toEqual([
      "board",
      "pulse",
      "harvest",
      "links",
      "recent",
      "contradictions",
      "reunions",
    ]);
  });

  it("does nothing when dropped on itself or on a stranger", () => {
    const d = defaultOverviewLayout();
    expect(moveOverviewItemBefore(d, "pulse", "pulse")).toBe(d);
    expect(moveOverviewItemBefore(d, "pulse", "nope")).toBe(d);
  });
});

describe("setOverviewSpan", () => {
  it("sets one block's span, clamped, leaving the others alone", () => {
    const m = setOverviewSpan(defaultOverviewLayout(), "pulse", 6);
    expect(m.items.find((i) => i.id === "pulse")?.span).toBe(6);
    expect(m.items.find((i) => i.id === "harvest")?.span).toBe(BOARD_COLS);
    expect(
      setOverviewSpan(m, "pulse", 40).items.find((i) => i.id === "pulse")?.span,
    ).toBe(BOARD_COLS);
  });
});

describe("overviewPosition", () => {
  it("reports the 1-based place in the column", () => {
    const d = defaultOverviewLayout();
    expect(overviewPosition(d, "links")).toEqual({ index: 3, total: 7 });
    expect(overviewPosition(d, "nope")).toBeNull();
  });
});
