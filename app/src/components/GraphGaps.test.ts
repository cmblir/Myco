import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import GraphGaps from "./GraphGaps";
import { STRINGS } from "../lib/i18n";

describe("GraphGaps — the overflow line", () => {
  it("counts the hidden rows in the same '+N개 더' form the legend uses", () => {
    const ids = Array.from({ length: 11 }, (_, i) => `/v/wiki/note-${i}.md`);
    const html = renderToStaticMarkup(
      createElement(GraphGaps, {
        t: STRINGS.ko,
        groups: [{ key: "orphans", label: STRINGS.ko.gr_gap_orphans, ids, actions: ["open"] }],
        total: ids.length,
        selected: null,
        onSelect: vi.fn(),
        onAction: vi.fn(),
        closed: {},
        setClosed: vi.fn(),
      }),
    );
    expect(html).toContain(STRINGS.ko.gr_more.replace("{n}", "3"));
    expect(html).toContain("+3개 더");
  });
});

// UX S14 named the stats line's count 연결이 빠진 곳, the rail's own title,
// and the two disagreed on one screen (28 vs 26): the rail head left out
// the 아무도 참조 안 함 rows it lists. PageGraph is too heavy to render here,
// so this reads its source: the total is computed once, in surveyCounts,
// and the rail head and its folded tab show that one.
describe("GraphGaps — one total with the stats line", () => {
  const src = readFileSync(new URL("../pages/PageGraph.tsx", import.meta.url), "utf8");

  it("computes the gaps total once", () => {
    expect(src.match(/gapCount\(/g)).toHaveLength(1);
  });

  it("gives the rail head and its folded tab the stats line's number", () => {
    expect(src).toMatch(/<GraphGaps[^>]*total=\{surveyCounts\.gaps\}/);
    expect(src).toMatch(/rail="gaps"\s+count=\{surveyCounts\.gaps\}/);
  });
});

// UX S44: a row was four Tab stops (name + open / link / harvest), so the
// keyboard walked dozens of stops past the canvas. The name is the one stop;
// Enter selects the note, and the inspector it opens carries the same exits.
describe("GraphGaps — one Tab stop per row", () => {
  it("keeps the row's action buttons out of the Tab order", () => {
    const html = renderToStaticMarkup(
      createElement(GraphGaps, {
        t: STRINGS.ko,
        groups: [
          {
            key: "orphans",
            label: STRINGS.ko.gr_gap_orphans,
            ids: ["/v/wiki/a.md"],
            actions: ["open", "link", "want"],
          },
        ],
        total: 1,
        selected: null,
        onSelect: vi.fn(),
        onAction: vi.fn(),
        closed: {},
        setClosed: vi.fn(),
      }),
    );
    const acts = html.slice(html.indexOf("u-rail__acts"));
    expect(acts.match(/<button/g)).toHaveLength(3);
    expect(acts.match(/tabindex="-1"/g)).toHaveLength(3);
    expect(html).toMatch(/<button type="button" class="u-rail__label"(?![^>]*tabindex)/);
  });
});
