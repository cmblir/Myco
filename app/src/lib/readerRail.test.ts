import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ProvenanceRow, SourceRef, VecHit } from "./ipc";
import { DEFAULT_TIER_WEIGHTS } from "./extractive";
import type { LinkSuggestion } from "./linkSuggestions";
import {
  connectionRows,
  insertionRange,
  linkContext,
  railFoldsSidebar,
  railIsSheet,
  sourcesView,
  sourceCreated,
} from "./readerRail";

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

describe("connectionRows + linking sentences", () => {
  it("attaches a sentence only to backlink rows whose path has one", () => {
    const ctx = { before: "uses ", link: "[[a]]", after: " daily." };
    const rows = connectionRows({
      filePath: HERE,
      backward: ["/v/wiki/b.md", "/v/wiki/c.md"],
      related: [hit("wiki/d.md", 0.7)],
      vaultRoot: ROOT,
      suggestions: [sug("/v/wiki/e.md", HERE)],
      // d and e are in the map too: related and suggested rows stay as they were.
      contexts: new Map([
        ["/v/wiki/b.md", ctx],
        ["/v/wiki/d.md", ctx],
        ["/v/wiki/e.md", ctx],
      ]),
    });
    expect(rows.map((r) => [r.path, r.context ?? null])).toEqual([
      ["/v/wiki/b.md", ctx],
      ["/v/wiki/c.md", null],
      ["/v/wiki/d.md", null],
      ["/v/wiki/e.md", null],
    ]);
  });
});

describe("linkContext", () => {
  const joined = (c: ReturnType<typeof linkContext>): string | null =>
    c ? c.before + c.link + c.after : null;

  it("returns the one sentence holding the link, verbatim, the link apart", () => {
    const md = "# B\n\nFirst sentence. It connects to [[a]] and more. Last one.\n";
    expect(linkContext(md, "a")).toEqual({
      before: "It connects to ",
      link: "[[a]]",
      after: " and more.",
    });
  });

  it("splits Korean sentences and keeps the particle after the link", () => {
    const md = "첫 문장입니다. 이 노트는 [[트랜스포머]]를 설명한다. 끝.";
    expect(linkContext(md, "트랜스포머")).toEqual({
      before: "이 노트는 ",
      link: "[[트랜스포머]]",
      after: "를 설명한다.",
    });
  });

  it("matches aliases, headings and paths the way the link graph resolves them", () => {
    expect(linkContext("See [[a|the A note]] here.", "a")?.link).toBe("[[a|the A note]]");
    expect(linkContext("See [[A#Intro|intro]] here.", "a")?.link).toBe("[[A#Intro|intro]]");
    expect(linkContext("See [[wiki/a.md]] here.", "a")?.link).toBe("[[wiki/a.md]]");
    expect(linkContext("See ![[a#Intro]] here.", "a")?.link).toBe("[[a#Intro]]");
    // A decomposed (NFD) Hangul link still names the NFC stem.
    expect(linkContext("본문 [[트랜스포머]] 끝".normalize("NFD"), "트랜스포머")).not.toBeNull();
    // A longer name that merely starts with the stem is another note.
    expect(linkContext("See [[ab]] and [[a-b]].", "a")).toBeNull();
    expect(linkContext("Only [[#a]] here.", "a")).toBeNull();
  });

  it("resolves escaped links the way the graph does (parser.rs trims the backslash)", () => {
    // Obsidian needs `\|` for an aliased link inside a table.
    expect(joined(linkContext("| x | uses [[a\\|the A]] here | y |", "a"))).toBe(
      "uses [[a\\|the A]] here",
    );
    expect(joined(linkContext("See [[a\\]] here.", "a"))).toBe("See [[a\\]] here.");
  });

  it("handles a link at the start and at the end of a paragraph", () => {
    expect(linkContext("[[a]] is the base. Next.", "a")).toEqual({
      before: "",
      link: "[[a]]",
      after: " is the base.",
    });
    expect(linkContext("Prior. Built on [[a]]", "a")).toEqual({
      before: "Built on ",
      link: "[[a]]",
      after: "",
    });
  });

  it("drops the list, quote, task and heading markers, and takes one table cell", () => {
    expect(joined(linkContext("- depends on [[a]] heavily", "a"))).toBe("depends on [[a]] heavily");
    expect(joined(linkContext("  1. step [[a]] first", "a"))).toBe("step [[a]] first");
    expect(joined(linkContext("- [ ] read [[a]] again", "a"))).toBe("read [[a]] again");
    expect(joined(linkContext("> as [[a]] says. Then more.", "a"))).toBe("as [[a]] says.");
    expect(joined(linkContext("## Why [[a]] matters", "a"))).toBe("Why [[a]] matters");
    expect(joined(linkContext("| x | uses [[a]] here | y |", "a"))).toBe("uses [[a]] here");
  });

  it("finds sentence ends in linear time, even in a long run of terminal marks", () => {
    // Quadratic before: 2.7 s at 32k dots, run for up to 50 notes per open.
    const md = `x${".".repeat(50_000)}y see [[a]] here.`;
    const t0 = performance.now();
    expect(joined(linkContext(md, "a"))).toMatch(/see \[\[a\]\] here\.$/);
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it("never splits a sentence on a period inside a link, or before a citation", () => {
    expect(joined(linkContext("Read [[Dr. A]] now. Next.", "Dr. A"))).toBe("Read [[Dr. A]] now.");
    expect(joined(linkContext("A claim.[^s] Uses [[a]] too. End.", "a"))).toBe("Uses [[a]] too.");
  });

  it("skips frontmatter and code, and a bare link with nothing around it", () => {
    const md = [
      "---",
      'related: "[[a]]"',
      "---",
      "```",
      "call([[a]])",
      "```",
      "## Related",
      "- [[a]]",
      "",
      "Later [[a]] is explained.",
    ].join("\n");
    expect(joined(linkContext(md, "a"))).toBe("Later [[a]] is explained.");
    expect(linkContext("## Related\n\n- [[a]]\n", "a")).toBeNull();
    expect(linkContext("No link here.", "a")).toBeNull();
  });

  it("skips exactly the fenced code Preview shows as code (CommonMark)", () => {
    // A backtick "fence" whose info string holds a backtick is inline code.
    expect(joined(linkContext("```x``` is inline code.\n\nLater [[a]] is explained.", "a"))).toBe(
      "Later [[a]] is explained.",
    );
    // Only a fence as long as the opener closes it.
    const nested = ["````md", "```", "call [[a]] here.", "```", "````", "Real [[a]] use."];
    expect(joined(linkContext(nested.join("\n"), "a"))).toBe("Real [[a]] use.");
    // A fence line with an info string does not close; nor does the other fence char.
    const info = ["```", "x", "```js", "call [[a]] here.", "~~~", "still [[a]] code.", "```", "Real [[a]] use."];
    expect(joined(linkContext(info.join("\n"), "a"))).toBe("Real [[a]] use.");
  });

  it("skips a line whose only text around the link is marks, and moves on to a real sentence", () => {
    const later = "\n\nWe extend [[a]] with a memory.";
    // The app's own formats: a /recall quote's attribution, an /ask answer's
    // source line, an embed.
    const recall = "> Attention maps a query to an output.\n— [[a#Scaled attention]]";
    const ask = "> [!question] What is attention?\n> **[[a#Overview]]** · 68%\n>\n> Quote.";
    for (const md of [recall, ask, "![[a#Intro]]"]) {
      expect(linkContext(md, "a")).toBeNull();
      expect(joined(linkContext(md + later, "a"))).toBe("We extend [[a]] with a memory.");
    }
    expect(linkContext("— [[a]]", "a")).toBeNull();
    expect(linkContext("~~[[a]]~~", "a")).toBeNull();
    expect(linkContext("→ ==[[a]]==", "a")).toBeNull();
    // Words in any script still count.
    expect(joined(linkContext("[[a]] 참고", "a"))).toBe("[[a]] 참고");
  });

  it("drops a callout marker like the other block markers", () => {
    expect(linkContext("> [!tip] See [[a]] for the full stack.", "a")?.before).toBe("See ");
    expect(linkContext("> [!note]- See [[a]] folded.", "a")?.before).toBe("See ");
  });

  it("for a link held by a footnote, returns the sentence that cites it", () => {
    const md = "Intro. A verbatim claim[^s1] stands. Other.\n\n[^s1]: [[a]]\n";
    expect(linkContext(md, "a")).toEqual({
      before: "A verbatim claim",
      link: "[^s1]",
      after: " stands.",
    });
    // Cited after its period, the reference closes the sentence it cites.
    const after = "Scores are summed.[^s1] Next [[b]] follows.\n\n[^s1]: [[a]]\n";
    expect(linkContext(after, "a")).toEqual({
      before: "Scores are summed.",
      link: "[^s1]",
      after: "",
    });
  });

  it("trims a long sentence on word boundaries, the link always whole", () => {
    const words = (n: number, w: string): string => Array.from({ length: n }, () => w).join(" ");
    const md = `${words(30, "alpha")} [[a]] ${words(30, "omega")}.`;
    const c = linkContext(md, "a");
    expect(c?.link).toBe("[[a]]");
    expect(c?.before.startsWith("…alpha ")).toBe(true);
    expect(c?.after.endsWith(" omega…")).toBe(true);
    expect((c?.before.length ?? 0) + (c?.after.length ?? 0)).toBeLessThanOrEqual(102);
    // Korean words are cut whole too (word-break: keep-all shows the rest).
    const ko = `${words(30, "가나다")} [[a]] ${words(30, "라마바")}.`;
    const k = linkContext(ko, "a");
    expect(k?.before.startsWith("…가나다 ")).toBe(true);
    expect(k?.after.endsWith(" 라마바…")).toBe(true);
    // Spaceless text is cut at a code point, never inside a surrogate pair.
    const ja = `${"😀".repeat(150)}[[a]]`;
    expect(linkContext(ja, "a")?.before).toBe(`…${"😀".repeat(15)}`);
  });

  it("keeps the link on the rail's first lines: the lead-in is budgeted by display width", () => {
    // The 3-line clamp hid a link late in a long Korean sentence. The side
    // before the link never takes the after side's unused room, and a wide
    // (CJK, emoji) char counts two Latin cells.
    expect(linkContext(`${"x".repeat(100)}[[a]]`, "a")?.before).toBe(`…${"x".repeat(30)}`);
    expect(linkContext(`${"가".repeat(100)}[[a]]에서 나왔다.`, "a")?.before).toBe(`…${"가".repeat(15)}`);
    expect(linkContext(`${"自".repeat(100)}[[a]]から。`, "a")?.before).toBe(`…${"自".repeat(15)}`);
    // The link's own width is part of the budget: a long link leaves less before it.
    const long = `[[a#${"s".repeat(60)}]]`;
    expect(linkContext(`${"x".repeat(100)}${long}`, "a")?.before).toBe(`…${"x".repeat(14)}`);
    // The other way the rollover stays: a short lead-in hands its room to the after side.
    const after = linkContext(`Built on [[a]] ${"y".repeat(200)}`, "a")?.after ?? "";
    expect(Array.from(after).length).toBeGreaterThan(90);
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

// Pixel widths measured on ?mock=1 (16px rem): the reader body is 455px in a
// 1280px window split beside Ask, 682px at 1024 with no split, 912px at 1280.
describe("rail layout", () => {
  const REM = 16;
  it("opens the rail as a sheet when the pane cannot hold both columns", () => {
    expect(railIsSheet(455, 1280, REM)).toBe(true);
    expect(railIsSheet(663, 1280, REM)).toBe(true);
    // 22rem note + 18rem rail + 1.5rem gap.
    expect(railIsSheet(664, 1280, REM)).toBe(false);
    expect(railIsSheet(912, 1280, REM)).toBe(false);
  });

  it("opens the rail as a sheet in a window under 960px, however wide the pane", () => {
    expect(railIsSheet(700, 959, REM)).toBe(true);
    expect(railIsSheet(700, 960, REM)).toBe(false);
  });

  it("folds the sidebar only when that puts the rail beside a cramped note", () => {
    // 1024, no split: the note would get 365px beside the rail, 545px folded.
    expect(railFoldsSidebar(682, 240, REM)).toBe(true);
    // Split beside Ask at 1280: the pane gets back half the sidebar, 575px.
    expect(railFoldsSidebar(455, 120, REM)).toBe(false);
    // Roomy already (1280, no split), or nothing left to fold.
    expect(railFoldsSidebar(912, 240, REM)).toBe(false);
    expect(railFoldsSidebar(700, 0, REM)).toBe(false);
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

// S29: an importer's epoch stamp reads as a date; a date string stays.
// 10:00 UTC, the same calendar day in every zone from -10 to +13.
describe("sourceCreated", () => {
  it("turns epoch seconds into a date in the app's language", () => {
    expect(sourceCreated("1699956000", "ko")).toBe("2023년 11월 14일");
    expect(sourceCreated("1699956000", "en")).toBe("Nov 14, 2023");
  });

  it("keeps a date string as written", () => {
    expect(sourceCreated("2026-02-01", "ko")).toBe("2026-02-01");
  });
});
