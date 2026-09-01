import { describe, expect, it } from "vitest";
import {
  appendWidget,
  duplicateWidget,
  emptyBoard,
  migrateLegacy,
  minSize,
  removeWidget,
  ruleColor,
  runBoardQuery,
  statValue,
  type BoardData,
  type BoardWidget,
} from "./board";
import type { Adjacency, InflowDay, TaskItem } from "./ipc";

const NOW = new Date(2026, 7, 31, 12).getTime();
const day = (offset: number): string => {
  const d = new Date(NOW - offset * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const inflow: InflowDay[] = [
  { day: day(2), mcp: 3, clipper: 1, voice: 0, import: 0 },
  { day: day(1), mcp: 0, clipper: 0, voice: 2, import: 118 },
  { day: day(0), mcp: 5, clipper: 0, voice: 0, import: 0 },
];

const adj = {
  forward: {},
  backward: {},
  unresolved: {},
  tags: { "wiki/a.md": ["llm"], "wiki/b.md": ["llm", "infra"] },
  meta: {
    "wiki/a.md": { type: "concept", confidence: "low", sourceCount: 0 },
    "wiki/b.md": { type: "concept", confidence: "high", sourceCount: 2 },
    "wiki/c.md": { type: "entity", confidence: "high", sourceCount: 1 },
  },
} as unknown as Adjacency;

const data: BoardData = {
  adjacency: adj,
  files: ["wiki/a.md", "wiki/b.md", "wiki/c.md"],
  mtimes: new Map([
    ["wiki/a.md", Math.floor(NOW / 1000)],
    ["wiki/b.md", Math.floor(NOW / 1000) - 86_400],
    ["wiki/c.md", Math.floor(NOW / 1000) - 40 * 86_400], // outside 30d
  ]),
  tasks: [
    { page: "p", stem: "p", line: 1, text: "t", done: false, status: "todo" },
    { page: "p", stem: "p", line: 2, text: "t", done: true, status: "done" },
  ] as TaskItem[],
  inflow,
};

describe("runBoardQuery · inflow", () => {
  it("day series with a channel filter reads that channel only", () => {
    const r = runBoardQuery(
      data,
      { source: "inflow", groupBy: "day", filters: [{ field: "channel", value: "mcp" }] },
      "7d",
      NOW,
    );
    if (r.kind !== "series") throw new Error("expected series");
    expect(r.days).toHaveLength(7);
    expect(r.days[r.days.length - 1]).toMatchObject({ total: 5 });
    expect(r.days[r.days.length - 3]).toMatchObject({ total: 3 });
    // single-channel series never stacks
    expect(r.days.every((d) => !d.parts)).toBe(true);
  });

  it("unfiltered day series carries channel parts for stacking", () => {
    const r = runBoardQuery(
      data,
      { source: "inflow", groupBy: "day", filters: [] },
      "7d",
      NOW,
    );
    if (r.kind !== "series") throw new Error("expected series");
    const yesterday = r.days[r.days.length - 2];
    expect(yesterday.total).toBe(120);
    expect(yesterday.parts?.find((p) => p.channel === "import")?.value).toBe(118);
  });

  it("groupBy channel sums the window per channel", () => {
    const r = runBoardQuery(
      data,
      { source: "inflow", groupBy: "channel", filters: [] },
      "7d",
      NOW,
    );
    if (r.kind !== "cat") throw new Error("expected cat");
    expect(r.rows).toEqual([
      { label: "mcp", value: 8 },
      { label: "clipper", value: 1 },
      { label: "voice", value: 2 },
      { label: "import", value: 118 },
    ]);
  });
});

describe("runBoardQuery · notes", () => {
  it("filters by frontmatter equality and groups by dimension", () => {
    const r = runBoardQuery(
      data,
      { source: "notes", groupBy: "type", filters: [{ field: "confidence", value: "high" }] },
      "all",
      NOW,
    );
    if (r.kind !== "cat") throw new Error("expected cat");
    expect(r.rows).toEqual([
      { label: "concept", value: 1 },
      { label: "entity", value: 1 },
    ]);
  });

  it("the time range trims by mtime; sourceCount filter matches numerically", () => {
    const in30 = runBoardQuery(
      data,
      { source: "notes", groupBy: "type", filters: [] },
      "30d",
      NOW,
    );
    if (in30.kind !== "cat") throw new Error("expected cat");
    // wiki/c.md is 40 days old — outside the window.
    expect(in30.rows).toEqual([{ label: "concept", value: 2 }]);

    const unsourced = runBoardQuery(
      data,
      { source: "notes", groupBy: "type", filters: [{ field: "sourceCount", value: "0" }] },
      "all",
      NOW,
    );
    expect(statValue(unsourced)).toBe(1);
  });

  it("groupBy tag counts tag occurrences", () => {
    const r = runBoardQuery(
      data,
      { source: "notes", groupBy: "tag", filters: [], limit: 1 },
      "all",
      NOW,
    );
    if (r.kind !== "cat") throw new Error("expected cat");
    expect(r.rows).toEqual([{ label: "llm", value: 2 }]);
  });
});

describe("rules and board ops", () => {
  it("first matching color rule wins, in order", () => {
    expect(ruleColor([{ op: ">=", value: 10, color: "risk" }], 12)).toBe("risk");
    expect(ruleColor([{ op: ">=", value: 10, color: "risk" }], 9)).toBeNull();
    expect(
      ruleColor(
        [
          { op: "<", value: 5, color: "ok" },
          { op: ">=", value: 0, color: "risk" },
        ],
        3,
      ),
    ).toBe("ok");
  });

  it("append places below, duplicate deep-copies with a fresh id", () => {
    let doc = emptyBoard();
    const w: BoardWidget = {
      id: "a",
      kind: "query",
      query: { source: "inflow", groupBy: "day", filters: [] },
      view: "bar",
    };
    doc = appendWidget(doc, w);
    doc = duplicateWidget(doc, "a");
    expect(doc.widgets).toHaveLength(2);
    expect(doc.widgets[1].id).not.toBe("a");
    expect(doc.widgets[1].query).toEqual(w.query);
    // Below, not overlapping: second item starts under the first.
    expect(doc.layout[1].y).toBeGreaterThanOrEqual(doc.layout[0].h);
    doc = removeWidget(doc, "a");
    expect(doc.widgets).toHaveLength(1);
    expect(doc.layout).toHaveLength(1);
  });

  it("minSize keeps a stat tile smaller than a chart's floor", () => {
    const stat: BoardWidget = { id: "s", kind: "query", view: "stat" };
    const bar: BoardWidget = { id: "b", kind: "query", view: "bar" };
    expect(minSize(stat).minW).toBeLessThan(minSize(bar).minW);
  });

  it("legacy localStorage widgets migrate onto preset questions", () => {
    const doc = migrateLegacy(
      JSON.stringify([
        { id: "x", kind: "tags", topN: 12 },
        { id: "y", kind: "tasks" },
        { id: "z", kind: "stats" }, // no preset equivalent — dropped
      ]),
    );
    expect(doc).not.toBeNull();
    expect(doc?.widgets).toHaveLength(2);
    expect(doc?.widgets[0].query).toMatchObject({ groupBy: "tag", limit: 12 });
    expect(migrateLegacy(null)).toBeNull();
    expect(migrateLegacy("not json")).toBeNull();
  });
});

describe("sanitizeBoard / aliases", () => {
  it("clamps off-grid layout items back onto the 12 columns", async () => {
    const { sanitizeBoard, aliasLabel } = await import("./board");
    const w: BoardWidget = { id: "a", kind: "query", view: "bar" };
    const doc = {
      version: 1 as const,
      range: "30d" as const,
      compact: "vertical" as const,
      widgets: [w, { id: "lost", kind: "text" as const, text: "" }],
      layout: [{ i: "a", x: 10, y: -2, w: 8, h: 0 }, { i: "ghost", x: 0, y: 0, w: 2, h: 2 }],
    };
    const out = sanitizeBoard(doc);
    const a = out.layout.find((l) => l.i === "a")!;
    expect(a.x + a.w).toBeLessThanOrEqual(12);
    expect(a.y).toBeGreaterThanOrEqual(0);
    expect(a.h).toBeGreaterThanOrEqual(1);
    // Ghost entries drop; a widget the layout lost gets parked at the bottom.
    expect(out.layout.some((l) => l.i === "ghost")).toBe(false);
    expect(out.layout.some((l) => l.i === "lost")).toBe(true);
    // Aliases rename at render only.
    expect(aliasLabel({ ...w, aliases: { x: "엑스" } }, "x")).toBe("엑스");
    expect(aliasLabel(w, "x")).toBe("x");
  });
});

describe("bucketWeekly", () => {
  it("folds the all-range's daily series into Monday weeks, parts included", async () => {
    const { bucketWeekly, runBoardQuery: run } = await import("./board");
    // 2026-08-31 is a Monday; the prior Mon is 08-24.
    const daily = [
      { day: "2026-08-28", total: 2, parts: [{ channel: "mcp" as const, value: 2 }] },
      { day: "2026-08-30", total: 1, parts: [{ channel: "voice" as const, value: 1 }] },
      { day: "2026-08-31", total: 5, parts: [{ channel: "mcp" as const, value: 5 }] },
    ];
    const weeks = bucketWeekly(daily);
    expect(weeks.map((w) => w.day)).toEqual(["2026-08-24", "2026-08-31"]);
    expect(weeks[0].total).toBe(3);
    expect(weeks[0].parts?.find((p) => p.channel === "mcp")?.value).toBe(2);
    expect(weeks[1].total).toBe(5);
    // The engine buckets automatically past 120 days.
    const r = run(data, { source: "inflow", groupBy: "day", filters: [] }, "all", NOW);
    if (r.kind !== "series") throw new Error("expected series");
    expect(r.days.length).toBeLessThan(60);
  });
});
