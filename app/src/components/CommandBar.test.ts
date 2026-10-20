import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  chipQuery,
  folderOf,
  folderPaths,
  footCount,
  HitText,
  missQuery,
  pageNote,
  rowAt,
  splitRecentByDay,
} from "./CommandBar";
import type { FileNode } from "../lib/ipc";
import { STRINGS } from "../lib/i18n";

describe("folderOf", () => {
  it("is the vault-relative folder of a note, empty at the root", () => {
    expect(folderOf("/v/wiki/concepts/a.md", "/v")).toBe("wiki/concepts");
    expect(folderOf("/v/wiki/a.md", "/v")).toBe("wiki");
    expect(folderOf("/v/a.md", "/v")).toBe("");
    // A vault whose name prefixes a sibling's must not eat that sibling's name.
    expect(folderOf("/vault2/wiki/a.md", "/vault")).toBe("/vault2/wiki");
  });
});

// UX backlog S15: the line under a page row says where it lives, or what it is
// when myco keeps it, and marks a page the agent committed.
describe("pageNote", () => {
  const ko = STRINGS.ko;
  const index = { "wiki/attention-mechanism.md": true, "wiki/self-attention.md": false };

  it("names a managed result by its kind instead of its folder", () => {
    expect(pageNote("/v/cards/attention-mechanism.md", "/v", index, ko)).toBe("학습 카드");
    expect(pageNote("/v/ingest-reports/2026-07-15-attention.md", "/v", index, ko)).toBe(
      "자료 추가 보고서",
    );
    expect(pageNote("/v/work/feedback/2026-08-12-map-candidate-attention.md", "/v", index, ko)).toBe(
      "정리 후보",
    );
    expect(pageNote("/v/CLAUDE.md", "/v", index, ko)).toBe("에이전트 지침");
  });

  it("marks a page myco wrote, and only that one", () => {
    expect(pageNote("/v/wiki/attention-mechanism.md", "/v", index, ko)).toBe("wiki · myco가 씀");
    expect(pageNote("/v/wiki/self-attention.md", "/v", index, ko)).toBe("wiki");
    // No history row: unknown, so no claim either way.
    expect(pageNote("/v/wiki/attention-mechanism.md", "/v", {}, ko)).toBe("wiki");
    expect(pageNote("/v/welcome.md", "/v", index, ko)).toBe("");
  });
});

// The exact and body rows carry the same line, so a same-named cards/ deck,
// ingest report and wiki/ page are told apart there too.
describe("HitText", () => {
  const index = { "wiki/attention-mechanism.md": true };
  const html = (path: string): string =>
    renderToStaticMarkup(
      h(HitText, {
        hit: { path, name: path.slice(path.lastIndexOf("/") + 1), line: 4, snippet: "softmax" },
        root: "/v",
        index,
        t: STRINGS.ko,
      }),
    );

  it("names what a managed hit is and marks a page myco wrote", () => {
    expect(html("/v/cards/attention-mechanism.md")).toContain("학습 카드");
    expect(html("/v/ingest-reports/2026-07-15-attention.md")).toContain("자료 추가 보고서");
    expect(html("/v/wiki/attention-mechanism.md")).toContain("wiki · myco가 씀");
  });

  it("adds no empty line for a note at the vault root", () => {
    expect(html("/v/welcome.md").match(/cmd-content-snippet/g)).toHaveLength(1);
  });
});

describe("missQuery", () => {
  it("offers create / ask when no name matched or the query is a question", () => {
    expect(missQuery("zzzq", 0, false)).toBe("zzzq");
    expect(missQuery("attention", 3, false)).toBeNull();
    expect(missQuery("what is attention?", 3, false)).toBe("what is attention?");
    expect(missQuery("어텐션이 뭐야？", 1, false)).toBe("어텐션이 뭐야？");
    expect(missQuery("   ", 0, false)).toBeNull();
    // Under a lens or operators the box filters; it names nothing.
    expect(missQuery("zzzq", 0, true)).toBeNull();
  });

  it("never names a note after a quoted phrase: that is an exact search", () => {
    expect(missQuery('"starter content"', 0, false)).toBeNull();
    expect(missQuery('"core topic" why?', 0, false)).toBeNull();
    // An unclosed quote is plain text, and its mark is not part of the name.
    expect(missQuery('"starter', 0, false)).toBe("starter");
  });
});

describe("rowAt", () => {
  const none = { names: 0, exact: 0, content: 0, semantic: 0, miss: 0 };

  it("puts Create / Ask after every hit, so Enter (row 0) opens the top hit", () => {
    // `starter`: no note is named so, every body holds it.
    const bodyOnly = { ...none, content: 20, semantic: 6, miss: 2 };
    expect(rowAt(0, bodyOnly)).toEqual({ list: "content", i: 0 });
    expect(rowAt(26, bodyOnly)).toEqual({ list: "miss", i: 0 });
    expect(rowAt(1, { ...none, exact: 1, miss: 1 })).toEqual({ list: "miss", i: 0 });
    // Name rows lead; a question keeps them first.
    expect(rowAt(0, { ...none, names: 2, semantic: 1, miss: 2 })).toEqual({ list: "names", i: 0 });
  });

  it("is the Create row at row 0 only when nothing matched", () => {
    expect(rowAt(0, { ...none, miss: 2 })).toEqual({ list: "miss", i: 0 });
    expect(rowAt(2, { ...none, miss: 2 })).toBeNull();
    expect(rowAt(0, none)).toBeNull();
  });
});

describe("footCount", () => {
  const none = { names: 0, exact: 0, content: 0, semantic: 0, miss: 0 };

  it("counts what the vault returned, not the Create / Ask rows", () => {
    expect(footCount("zzzq", false, { ...none, miss: 2 })).toBe(0);
    expect(footCount("starter", false, { ...none, content: 20, semantic: 6, miss: 2 })).toBe(26);
  });

  it("says nothing for the empty box; a lens's rows are its results", () => {
    expect(footCount("", false, { ...none, names: 17 })).toBeNull();
    expect(footCount("  ", false, { ...none, names: 17 })).toBeNull();
    expect(footCount("", true, { ...none, names: 12 })).toBe(12);
  });
});

// UX backlog S23: the chips write an operator into the box; path: offers the
// vault's folders.
describe("chipQuery", () => {
  it("adds the operator after what is typed", () => {
    expect(chipQuery("", "tag")).toBe("tag:");
    expect(chipQuery("attention  ", "path")).toBe("attention path:");
  });
});

describe("folderPaths", () => {
  it("lists every folder vault-relative, in name order", () => {
    const tree: FileNode[] = [
      {
        kind: "directory",
        name: "wiki",
        path: "/v/wiki",
        children: [
          { kind: "directory", name: "concepts", path: "/v/wiki/concepts", children: [] },
          { kind: "file", name: "a.md", path: "/v/wiki/a.md" },
        ],
      },
      { kind: "directory", name: "daily", path: "/v/daily", children: [] },
      { kind: "file", name: "b.md", path: "/v/b.md" },
    ];
    expect(folderPaths(tree, "/v")).toEqual(["daily", "wiki", "wiki/concepts"]);
  });
});

// On a phone the empty palette groups the recent notes by when they were
// last changed (UX S50): today, the seven days before, then the rest.
describe("splitRecentByDay", () => {
  const now = new Date(2026, 9, 3, 15, 0); // local 2026-10-03 15:00
  const sec = (d: Date): number => Math.floor(d.getTime() / 1000);
  const row = (p: string) => ({ to: `page:${p}` });
  const mtimes = new Map([
    ["/v/a.md", sec(new Date(2026, 9, 3, 0, 5))],
    ["/v/b.md", sec(new Date(2026, 9, 2, 23, 59))],
    ["/v/c.md", sec(new Date(2026, 8, 25, 12, 0))],
  ]);

  it("splits at local midnight and at seven days back, order kept", () => {
    const out = splitRecentByDay([row("/v/c.md"), row("/v/b.md"), row("/v/a.md")], mtimes, now);
    expect(out.today.map((r) => r.to)).toEqual(["page:/v/a.md"]);
    expect(out.week.map((r) => r.to)).toEqual(["page:/v/b.md"]);
    expect(out.earlier.map((r) => r.to)).toEqual(["page:/v/c.md"]);
  });

  it("keeps a note with no date (mtimes not loaded) under the rest", () => {
    const out = splitRecentByDay([row("/v/a.md")], null, now);
    expect([out.today, out.week, out.earlier.length]).toEqual([[], [], 1]);
  });
});
