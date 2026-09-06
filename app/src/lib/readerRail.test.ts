import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ProvenanceRow, SourceRef, VecHit } from "./ipc";
import { DEFAULT_TIER_WEIGHTS } from "./extractive";
import type { LinkSuggestion } from "./linkSuggestions";
import { connectionRows, insertionRange, sourcesView } from "./readerRail";

const ROOT = "/v";
const HERE = "/v/wiki/a.md";

const hit = (page: string, score: number): VecHit => ({
  page,
  stem: page.split("/").pop()?.replace(/\.md$/, "") ?? page,
  section: 0,
  score,
});
const sug = (source: string, target: string, score = 0.8): LinkSuggestion => ({
  source,
  target,
  score,
  key: source < target ? `${source}|${target}` : `${target}|${source}`,
});

describe("connectionRows", () => {
  it("merges the three lists in order and keeps the strongest relationship per page", () => {
    const rows = connectionRows({
      filePath: HERE,
      backward: ["/v/wiki/b.md", "/v/wiki/c.md"],
      // c is both a backlink and a semantic neighbour: one row, still a backlink.
      related: [hit("wiki/c.md", 0.9), hit("wiki/d.md", 0.71)],
      vaultRoot: ROOT,
      suggestions: [sug("/v/wiki/e.md", HERE, 0.79)],
    });
    expect(rows.map((r) => [r.kind, r.path])).toEqual([
      ["backlink", "/v/wiki/b.md"],
      ["backlink", "/v/wiki/c.md"],
      ["related", "/v/wiki/d.md"],
      ["suggested", "/v/wiki/e.md"],
    ]);
    expect(rows[2].score).toBeCloseTo(0.71);
  });

  it("orients a suggestion so accepting it writes to the note being read", () => {
    // The pair arrives target-first; acceptSuggestion appends to `source`, so
    // the row has to flip it or the wikilink lands in the OTHER note.
    const [row] = connectionRows({
      filePath: HERE,
      backward: undefined,
      related: null,
      vaultRoot: ROOT,
      suggestions: [sug("/v/wiki/e.md", HERE)],
    });
    expect(row.suggestion?.source).toBe(HERE);
    expect(row.suggestion?.target).toBe("/v/wiki/e.md");
    // The dismissal key is order-independent, so flipping must not change it.
    expect(row.suggestion?.key).toBe(sug("/v/wiki/e.md", HERE).key);
  });

  it("is empty with nothing to show, and never lists the note itself", () => {
    expect(
      connectionRows({
        filePath: HERE,
        backward: [],
        related: [],
        vaultRoot: ROOT,
        suggestions: [],
      }),
    ).toEqual([]);
    // related_pages can return the page itself on some indexes.
    expect(
      connectionRows({
        filePath: HERE,
        backward: undefined,
        related: [hit("wiki/a.md", 1)],
        vaultRoot: ROOT,
        suggestions: [],
      }),
    ).toEqual([]);
  });
});

const ref = (slug: string, resolved: boolean): SourceRef => ({
  slug,
  kind: resolved ? "chatgpt" : "",
  title: resolved ? "A thread" : null,
  conversation_id: null,
  created: null,
  resolved,
});
const provRow = (
  path: string,
  cited: number,
  total: number,
  sources: SourceRef[],
): ProvenanceRow => ({
  path,
  name: path.split("/").pop() ?? path,
  cited,
  total,
  sources,
});

describe("sourcesView", () => {
  it("finds this note's row and reports coverage, uncited claims and trust", () => {
    const v = sourcesView(
      [
        provRow("/v/wiki/z.md", 1, 1, []),
        provRow(HERE, 2, 5, [ref("audit", true), ref("ghost", false)]),
      ],
      HERE,
      DEFAULT_TIER_WEIGHTS,
    );
    expect(v).not.toBeNull();
    expect(v?.cited).toBe(2);
    expect(v?.total).toBe(5);
    expect(v?.uncited).toBe(3);
    expect(v?.pct).toBe(40);
    // A resolved citation carries the tier prior Ask applies to raw/ imports;
    // a dangling one carries none — there is no trust behind a missing file.
    expect(v?.sources.map((s) => s.weight)).toEqual([DEFAULT_TIER_WEIGHTS.source, null]);
  });

  it("is null before the scan and for a page the scan has no row for", () => {
    expect(sourcesView(null, HERE, DEFAULT_TIER_WEIGHTS)).toBeNull();
    expect(sourcesView([provRow("/v/wiki/z.md", 0, 0, [])], HERE, DEFAULT_TIER_WEIGHTS)).toBeNull();
  });

  it("reports 0% rather than NaN for a note that makes no claims", () => {
    expect(sourcesView([provRow(HERE, 0, 0, [])], HERE, DEFAULT_TIER_WEIGHTS)?.pct).toBe(0);
  });
});

describe("insertionRange", () => {
  it("returns only the inserted span so the caret and undo survive", () => {
    const before = "# A\n\nbody\n";
    const after = "# A\n\nbody\n\n## Related\n\n- [[B]]\n";
    const r = insertionRange(before, after);
    expect(r).toEqual({ from: 10, to: 10, insert: "\n## Related\n\n- [[B]]\n" });
    expect(before.slice(0, r?.from) + r?.insert + before.slice(r?.to ?? 0)).toBe(after);
  });

  it("covers an insert in the middle and no-ops on an unchanged document", () => {
    const before = "a\n## Related\n\n- [[X]]\n";
    const after = "a\n## Related\n\n- [[B]]\n- [[X]]\n";
    const r = insertionRange(before, after);
    // A pure insert stays a pure insert (from === to): nothing is deleted, so
    // CodeMirror maps a caret elsewhere in the document unmoved.
    expect(r?.from).toBe(r?.to);
    expect(before.slice(0, r?.from) + r?.insert + before.slice(r?.to ?? 0)).toBe(after);
    expect(insertionRange("same", "same")).toBeNull();
  });
});

describe("ReaderRail", () => {
  it("stacks properties → outline → sources → connections", () => {
    // Order is the point of the rail (mockup "Manuscript"): properties first
    // because it is the note's own metadata, connections last because it is
    // the only block whose rows leave the page.
    const src = readFileSync(new URL("../components/ReaderRail.tsx", import.meta.url), "utf8");
    const at = (tag: string): number => {
      const i = src.indexOf(`<${tag}`);
      expect(i, `${tag} rendered`).toBeGreaterThan(-1);
      return i;
    };
    const order = ["PropertiesPanel", "OutlinePanel", "SourcesPanel", "ConnectionsPanel"].map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
