import { describe, expect, it } from "vitest";
import type { Adjacency } from "./ipc";
import {
  BUILTIN_LENSES,
  facetValues,
  parseSavedView,
  runView,
  viewRel,
  wikiPagesOnly,
} from "./queryViews";

const A = "/v/alpha.md";
const B = "/v/beta.md";
const C = "/v/gamma.md";
const D = "/v/delta.md";

function adj(): Adjacency {
  return {
    forward: { [A]: [B] },
    backward: { [B]: [A] },
    unresolved: {},
    tags: { [A]: ["ml"], [B]: ["ml", "史"], [C]: [] },
    meta: {
      [A]: { type: "concept", confidence: "high", sourceCount: 3 },
      [B]: { type: "technique", confidence: "low", sourceCount: 0 },
      [C]: { type: "concept", status: "disputed", sourceCount: 1 },
      // D has no meta at all (older backend / plain note)
    },
  };
}

const FILES = [A, B, C, D];

describe("runView", () => {
  it("returns everything unfiltered, sorted by name", () => {
    const rows = runView(adj(), FILES, {});
    expect(rows.map((r) => r.name)).toEqual(["alpha", "beta", "delta", "gamma"]);
  });

  it("filters by type, confidence, tag, and text", () => {
    expect(runView(adj(), FILES, { types: ["concept"] }).map((r) => r.name)).toEqual([
      "alpha",
      "gamma",
    ]);
    expect(runView(adj(), FILES, { confidence: ["low"] }).map((r) => r.name)).toEqual(["beta"]);
    expect(runView(adj(), FILES, { tags: ["ml"] }).map((r) => r.name)).toEqual(["alpha", "beta"]);
    expect(runView(adj(), FILES, { text: "GAMM" }).map((r) => r.name)).toEqual(["gamma"]);
  });

  it("filters by minSources and orphansOnly", () => {
    expect(runView(adj(), FILES, { minSources: 2 }).map((r) => r.name)).toEqual(["alpha"]);
    // orphans: C and D have no links in either direction
    expect(runView(adj(), FILES, { orphansOnly: true }).map((r) => r.name)).toEqual([
      "delta",
      "gamma",
    ]);
  });

  it("sorts by sources descending with name tiebreak", () => {
    const rows = runView(adj(), FILES, {}, "sources", true);
    expect(rows[0].name).toBe("alpha"); // 3 sources
    expect(rows[rows.length - 1].sourceCount).toBe(0);
  });

  it("counts links in both directions", () => {
    const byName = new Map(runView(adj(), FILES, {}).map((r) => [r.name, r]));
    expect(byName.get("alpha")?.links).toBe(1);
    expect(byName.get("beta")?.links).toBe(1);
    expect(byName.get("gamma")?.links).toBe(0);
  });
});

describe("facetValues", () => {
  const names = (f: { value: string }[]): string[] => f.map((x) => x.value);

  it("collects only values that exist", () => {
    const f = facetValues(adj(), FILES);
    expect(names(f.types).sort()).toEqual(["concept", "technique"]);
    expect(names(f.confidence).sort()).toEqual(["high", "low"]);
    expect(names(f.status)).toEqual(["disputed"]);
    expect(names(f.tags)).toContain("ml");
  });

  it("counts each value, biggest bucket first", () => {
    // The dropdowns show the distribution, so a visitor can see where the
    // vault actually is instead of trying values one at a time.
    const f = facetValues(adj(), FILES);
    const concept = f.types.find((x) => x.value === "concept");
    expect(concept?.count).toBeGreaterThan(0);
    const counts = f.types.map((x) => x.count);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
  });
});

describe("wikiPagesOnly", () => {
  const files = [
    "/v/wiki/attention.md",
    "/v/wiki/maps/nlp.md",
    "/v/sessions/2026-08/claude-code-abc.md",
    "/v/daily/2026-08-28.md",
    "/v/raw/paper.md",
    "/v/CLAUDE.md",
  ];

  it("keeps only pages under wiki/", () => {
    // Every filter on the Views page reads wiki frontmatter, which nothing
    // outside wiki/ carries: the owner's vault rendered 1,647 rows for 92
    // real pages, the rest dashes and zeroes.
    expect(wikiPagesOnly(files, "/v")).toEqual([
      "/v/wiki/attention.md",
      "/v/wiki/maps/nlp.md",
    ]);
  });

  it("accepts a root with a trailing slash", () => {
    expect(wikiPagesOnly(files, "/v/")).toHaveLength(2);
  });

  it("passes everything through when no vault root is known", () => {
    // A caller without a root (tests, the mock browser) must not silently
    // end up with an empty table.
    expect(wikiPagesOnly(files)).toEqual(files);
  });

  it("does not match a directory that merely starts with wiki", () => {
    expect(wikiPagesOnly(["/v/wikipedia/x.md"], "/v")).toEqual([]);
  });
});

describe("built-in lenses", () => {
  it("each one narrows the table to a question the page exists to answer", () => {
    const a = adj();
    const byKey = Object.fromEntries(BUILTIN_LENSES.map((l) => [l.key, l]));

    // Unsourced: a wiki claim with nothing behind it.
    const unsourced = runView(a, FILES, byKey.unsourced.filter);
    expect(unsourced.every((r) => r.sourceCount === 0)).toBe(true);

    // Orphans: written, never linked from anywhere.
    const orphans = runView(a, FILES, byKey.orphans.filter);
    expect(orphans.every((r) => r.links === 0)).toBe(true);

    // Disputed: flagged as contradicting another page.
    const disputed = runView(a, FILES, byKey.disputed.filter);
    expect(disputed.every((r) => r.status === "disputed")).toBe(true);

    // Recent: no filter, newest first — the ordering IS the lens.
    expect(byKey.recent.filter).toEqual({});
    expect(byKey.recent.sort).toBe("modified");
    expect(byKey.recent.desc).toBe(true);
  });

  it("sorts by modified date when the mtime map is supplied", () => {
    const mtimes = new Map([
      [A, 300],
      [B, 100],
      [C, 200],
      [D, 400],
    ]);
    const rows = runView(adj(), FILES, {}, "modified", true, mtimes);
    expect(rows.map((r) => r.modified)).toEqual([400, 300, 200, 100]);
  });

  it("degrades to name order when no mtimes have loaded", () => {
    // Every row reads 0, so the tiebreak (name) decides — an empty column,
    // never a scrambled table.
    const rows = runView(adj(), FILES, {}, "modified", true);
    expect(rows.map((r) => r.modified)).toEqual([0, 0, 0, 0]);
    expect(rows.map((r) => r.name)).toEqual([...rows.map((r) => r.name)].sort());
  });
});

describe("the unsourced lens judges claims, not scaffolding", () => {
  it("skips index.md and log.md, which cite nothing by design", () => {
    const files = ["/v/wiki/index.md", "/v/wiki/log.md", "/v/wiki/claim.md"];
    const a: Adjacency = {
      forward: {},
      backward: {},
      unresolved: {},
      tags: {},
      meta: {
        "/v/wiki/index.md": { sourceCount: 0 },
        "/v/wiki/log.md": { sourceCount: 0 },
        "/v/wiki/claim.md": { sourceCount: 0 },
      },
    };
    expect(runView(a, files, { unsourcedOnly: true }).map((r) => r.name)).toEqual([
      "claim",
    ]);
    // They are still ordinary rows in an unfiltered table.
    expect(runView(a, files, {})).toHaveLength(3);
  });
});

describe("saved view files", () => {
  it("live under .myco/views by name", () => {
    expect(viewRel("x")).toBe(".myco/views/x.json");
  });

  it("takes id and name from the stem, not the file", () => {
    const raw = JSON.stringify({
      id: "old",
      name: "Old",
      filter: { types: ["concept"] },
      sort: "links",
      desc: true,
    });
    expect(parseSavedView(raw, "mine")).toEqual({
      id: "mine",
      name: "mine",
      filter: { types: ["concept"] },
      sort: "links",
      desc: true,
    });
  });

  it("rejects invalid JSON and a missing filter", () => {
    expect(parseSavedView("{nope", "a")).toBeNull();
    expect(parseSavedView(JSON.stringify({ sort: "name" }), "a")).toBeNull();
  });

  it("falls back on an unknown sort and a non-boolean desc", () => {
    const v = parseSavedView(JSON.stringify({ filter: {}, sort: "bogus", desc: "yes" }), "a");
    expect(v?.sort).toBe("name");
    expect(v?.desc).toBe(false);
  });
});
