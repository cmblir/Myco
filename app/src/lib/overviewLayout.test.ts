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
  moveOverviewItemToZone,
  OVERVIEW_BLOCKS,
  overviewPosition,
  sanitizeOverviewLayout,
  setOverviewSpan,
  zoneItems,
} from "./board";

const ids = (layout: { items: { id: string }[] }): string[] =>
  layout.items.map((i) => i.id);

describe("defaultOverviewLayout", () => {
  it("is the arrangement that shipped before: five in the column, four in the rail", () => {
    const d = defaultOverviewLayout();
    expect(zoneItems(d, "main").map((i) => i.id)).toEqual([
      "pulse",
      "harvest",
      "links",
      "recent",
      "board",
    ]);
    expect(zoneItems(d, "rail").map((i) => i.id)).toEqual([
      "since",
      "suspect",
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
    // The rail blocks it never mentioned keep their default zone.
    expect(zoneItems(s, "rail").map((i) => i.id)).toEqual([
      "since",
      "suspect",
      "contradictions",
      "reunions",
    ]);
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
    expect(s.items[0]).toEqual({ id: "pulse", zone: "rail", span: 4 });
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
      items: [{ id: "since", zone: "sidebar", span: 12 }],
    });
    expect(s.items[0].zone).toBe("main");
  });
});

describe("moveOverviewItem", () => {
  it("moves one step later inside a zone", () => {
    const m = moveOverviewItem(defaultOverviewLayout(), "pulse", 1);
    expect(zoneItems(m, "main").map((i) => i.id)).toEqual([
      "harvest",
      "pulse",
      "links",
      "recent",
      "board",
    ]);
  });

  it("moves one step earlier inside a zone", () => {
    const m = moveOverviewItem(defaultOverviewLayout(), "recent", -1);
    expect(zoneItems(m, "main").map((i) => i.id)).toEqual([
      "pulse",
      "harvest",
      "recent",
      "links",
      "board",
    ]);
  });

  it("walks a block out of the main column into the rail", () => {
    // "board" is last in main, "since" first in rail — one step later crosses.
    const m = moveOverviewItem(defaultOverviewLayout(), "board", 1);
    expect(m.items.find((i) => i.id === "board")?.zone).toBe("rail");
    expect(zoneItems(m, "main").map((i) => i.id)).toEqual([
      "pulse",
      "harvest",
      "links",
      "recent",
    ]);
    expect(zoneItems(m, "rail").map((i) => i.id)).toEqual([
      "since",
      "board",
      "suspect",
      "contradictions",
      "reunions",
    ]);
  });

  it("walks a rail block back into the main column", () => {
    const m = moveOverviewItem(defaultOverviewLayout(), "since", -1);
    expect(m.items.find((i) => i.id === "since")?.zone).toBe("main");
    expect(zoneItems(m, "main").map((i) => i.id)).toEqual([
      "pulse",
      "harvest",
      "links",
      "recent",
      "since",
      "board",
    ]);
  });

  it("keeps the span while crossing zones", () => {
    const wide = setOverviewSpan(defaultOverviewLayout(), "board", 6);
    const m = moveOverviewItem(wide, "board", 1);
    expect(m.items.find((i) => i.id === "board")?.span).toBe(6);
  });

  it("is a no-op at either end, and for a block that is not there", () => {
    const d = defaultOverviewLayout();
    expect(moveOverviewItem(d, "pulse", -1)).toBe(d);
    expect(moveOverviewItem(d, "reunions", 1)).toBe(d);
    expect(moveOverviewItem(d, "nope", 1)).toBe(d);
  });
});

describe("moveOverviewItemBefore (a drop)", () => {
  it("takes the target's place and zone", () => {
    const m = moveOverviewItemBefore(defaultOverviewLayout(), "board", "pulse");
    expect(zoneItems(m, "main").map((i) => i.id)).toEqual([
      "board",
      "pulse",
      "harvest",
      "links",
      "recent",
    ]);
    const rail = moveOverviewItemBefore(
      defaultOverviewLayout(),
      "pulse",
      "contradictions",
    );
    expect(rail.items.find((i) => i.id === "pulse")?.zone).toBe("rail");
    expect(zoneItems(rail, "rail").map((i) => i.id)).toEqual([
      "since",
      "suspect",
      "pulse",
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

describe("moveOverviewItemToZone (a drop on the trailing strip)", () => {
  it("appends to the end of that zone", () => {
    const m = moveOverviewItemToZone(defaultOverviewLayout(), "pulse", "rail");
    expect(zoneItems(m, "rail").map((i) => i.id)).toEqual([
      "since",
      "suspect",
      "contradictions",
      "reunions",
      "pulse",
    ]);
  });

  it("refills a rail the user emptied", () => {
    let l = defaultOverviewLayout();
    for (const id of ["since", "suspect", "contradictions", "reunions"])
      l = moveOverviewItemToZone(l, id, "main");
    expect(zoneItems(l, "rail")).toEqual([]);
    l = moveOverviewItemToZone(l, "suspect", "rail");
    expect(zoneItems(l, "rail").map((i) => i.id)).toEqual(["suspect"]);
  });

  it("is a no-op for a block already in that zone", () => {
    const d = defaultOverviewLayout();
    expect(moveOverviewItemToZone(d, "pulse", "main")).toBe(d);
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
  it("reports the 1-based place inside the block's own zone", () => {
    const d = defaultOverviewLayout();
    expect(overviewPosition(d, "links")).toEqual({
      index: 3,
      total: 5,
      zone: "main",
    });
    expect(overviewPosition(d, "reunions")).toEqual({
      index: 4,
      total: 4,
      zone: "rail",
    });
    expect(overviewPosition(d, "nope")).toBeNull();
  });
});
