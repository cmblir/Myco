import { describe, expect, it } from "vitest";
import type { HarvestCandidate, HarvestExcluded, ProvenanceRow } from "./ipc";
import {
  EXCLUDED_ORDER,
  clusterColorVar,
  distinctCitations,
  excludedRows,
  formatKb,
  harvestLabel,
  junkExcluded,
  selectionTotals,
} from "./harvest";

function cand(path: string, size_bytes: number, est_citations: number): HarvestCandidate {
  return {
    path,
    rel: path.replace("/v/", ""),
    size_bytes,
    mtime: 0,
    title: path,
    preview: [],
    cluster: null,
    est_citations,
    kind: "session",
  };
}

const ITEMS = [
  cand("/v/sessions/a.md", 42_000, 4),
  cand("/v/sessions/b.md", 18_000, 3),
  cand("/v/sessions/c.md", 96_000, 5),
];

describe("selectionTotals", () => {
  it("sums count, bytes and estimated citations over the selected paths only", () => {
    const sel = new Set(["/v/sessions/a.md", "/v/sessions/c.md"]);
    expect(selectionTotals(ITEMS, sel)).toEqual({
      count: 2,
      bytes: 138_000,
      citations: 9,
    });
  });

  it("is all zeros for an empty selection", () => {
    expect(selectionTotals(ITEMS, new Set())).toEqual({ count: 0, bytes: 0, citations: 0 });
  });

  it("ignores selected paths that are no longer in the queue", () => {
    const sel = new Set(["/v/sessions/gone.md", "/v/sessions/b.md"]);
    expect(selectionTotals(ITEMS, sel).citations).toBe(3);
  });
});

describe("harvestLabel", () => {
  it("fills the count into the locale template", () => {
    expect(harvestLabel("{n}개 수확", 12)).toBe("12개 수확");
    expect(harvestLabel("Harvest {n}", 0)).toBe("Harvest 0");
  });
});

describe("excluded buckets", () => {
  const ex: HarvestExcluded = {
    already_harvested: 0,
    too_large: 3,
    duplicate: 754,
    too_small: 1231,
    boilerplate: 60,
  };

  it("renders in the fixed design order regardless of object key order or count", () => {
    expect(excludedRows(ex).map((r) => r.key)).toEqual([...EXCLUDED_ORDER]);
    expect(excludedRows(ex).map((r) => r.count)).toEqual([754, 60, 1231, 3, 0]);
  });

  it("counts only the junk buckets in the one-line total", () => {
    // 754 + 60 — the size buckets are held/below-floor, not thrown away.
    expect(junkExcluded(ex)).toBe(814);
  });
});

describe("formatKb", () => {
  it("shows bytes under 1 KB, one decimal under 100 KB, whole KB above", () => {
    expect(formatKb(5)).toBe("5 B");
    expect(formatKb(42.1 * 1024)).toBe("42.1 KB");
    expect(formatKb(204_800)).toBe("200 KB");
  });
});

describe("distinctCitations", () => {
  it("counts each source slug once across all pages", () => {
    const row = (slugs: string[]): ProvenanceRow => ({
      path: "p",
      name: "p",
      cited: slugs.length,
      total: slugs.length,
      sources: slugs.map((slug) => ({
        slug,
        kind: "",
        title: null,
        conversation_id: null,
        created: null,
        resolved: true,
      })),
    });
    expect(distinctCitations([row(["a", "b"]), row(["b", "c"]), row([])])).toBe(3);
  });
});

describe("clusterColorVar", () => {
  it("maps frontmatter types to the category tokens, untyped to concept", () => {
    expect(clusterColorVar("source-summary")).toBe("var(--c-source)");
    expect(clusterColorVar("analysis")).toBe("var(--c-analysis)");
    expect(clusterColorVar(undefined)).toBe("var(--c-concept)");
  });
});
