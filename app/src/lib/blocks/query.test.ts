import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import type Token from "markdown-it/lib/token.mjs";
import type { Adjacency } from "../ipc";
import { liveBlocks } from "./live";
import { fenceBlock } from "./index";
import {
  QUERY,
  bakeEdit,
  bakeText,
  countGroups,
  onThisDayQuery,
  parseQuery,
} from "./query";
import { queryRows } from "../queryLoad";
import { mycoMarkdown } from "../editorBlocks";
import { markdownRenderer } from "../markdown";
import { filterSlash, slashItems } from "../editorCompletions";
import { STRINGS } from "../i18n";

const { parser } = mycoMarkdown().language;
const lezer = (src: string) =>
  liveBlocks(parser.parse(src), Text.of(src.split("\n")));

/** The query fences markdown-it finds in `src`, parsed as Preview does. */
function preview(src: string): unknown[] {
  const out: unknown[] = [];
  const walk = (tokens: Token[]) => {
    for (const t of tokens) {
      if (t.type === "fence" && t.meta?.closed && fenceBlock(t.info) === QUERY)
        out.push(QUERY.parse(t.content));
      if (t.children) walk(t.children);
    }
  };
  walk(markdownRenderer.parse(src, {}));
  return out;
}

const apply = (doc: string, e: { from: number; to: number; insert: string }) =>
  doc.slice(0, e.from) + e.insert + doc.slice(e.to);

describe("query block: parse", () => {
  it("reads ⌘K operators plus sort, limit and view", () => {
    expect(
      parseQuery(
        'type:concept tag:ML "exact words" attn sort:modified limit:5 view:table\n',
      ),
    ).toEqual({
      query:
        'type:concept tag:ML "exact words" attn sort:modified limit:5 view:table',
      search: {
        phrases: ["exact words"],
        path: null,
        tags: ["ml"],
        meta: [["type", "concept"]],
        terms: "attn",
      },
      sort: "modified",
      desc: true,
      limit: 5,
      view: "table",
      bad: null,
    });
  });

  it("defaults to a list by name, 50 rows", () => {
    expect(parseQuery("status:disputed\n")).toMatchObject({
      sort: "name",
      desc: false,
      limit: 50,
      view: "list",
      bad: null,
    });
  });

  it("sorts each key its natural way; a `-` reverses it", () => {
    const by = (s: string) => {
      const q = parseQuery(`sort:${s}`);
      return [q.sort, q.desc];
    };
    expect(by("name")).toEqual(["name", false]);
    expect(by("-name")).toEqual(["name", true]);
    expect(by("modified")).toEqual(["modified", true]);
    expect(by("updated")).toEqual(["modified", true]);
    expect(by("-modified")).toEqual(["modified", false]);
    expect(by("links")).toEqual(["links", true]);
    expect(by("sources")).toEqual(["sources", true]);
    expect(by("type")).toEqual(["type", false]);
  });

  it("joins a body written over several lines into one query", () => {
    expect(parseQuery("tag:a\n  view:count\n\n").query).toBe(
      "tag:a view:count",
    );
    expect(parseQuery("tag:a\n  view:count\n").view).toBe("count");
  });

  it("keeps an option word inside a quoted phrase as text", () => {
    expect(parseQuery('"sort:x limit:3"')).toMatchObject({
      search: { phrases: ["sort:x limit:3"] },
      sort: "name",
      limit: 50,
      bad: null,
    });
  });

  it("names the first option it cannot read", () => {
    expect(parseQuery("view:pie").bad).toBe("view:pie");
    expect(parseQuery("tag:a limit:0 sort:size").bad).toBe("limit:0");
    expect(parseQuery("limit:many").bad).toBe("limit:many");
    expect(parseQuery("sort:size").bad).toBe("sort:size");
    expect(parseQuery("view:").bad).toBe("view:");
  });

  it("an empty fence is still a query block (it asks for a query)", () => {
    expect(parseQuery("")).toMatchObject({ query: "", bad: null });
    expect(QUERY.parse("\n")).not.toBeNull();
  });
});

describe("query block: Live and Preview read it the same", () => {
  it.each([
    QUERY.template,
    "```myco-query\ntype:concept view:count\n```",
    "```myco-query\n```",
    "```myco-query\ntag:a\nsort:-name\n```",
    "> [!note] Pages\n> ```myco-query\n> status:disputed\n> ```",
    "- item\n\n  ```myco-query\n  path:daily/ view:table\n  ```",
  ])("%j", (src) => {
    const live = lezer(src)
      .filter((b) => b.spec === QUERY)
      .map((b) => b.parsed);
    expect(live).toHaveLength(1);
    expect(preview(src)).toEqual(live);
  });

  it("an unclosed query fence stays code in both views", () => {
    const src = "```myco-query\ntag:a\n\nrest of the note";
    expect(lezer(src)).toEqual([]);
    expect(preview(src)).toEqual([]);
    expect(markdownRenderer.render(src)).toContain("<pre>");
  });

  it("Preview draws a placeholder carrying the query, escaped", () => {
    const html = markdownRenderer.render(
      '```myco-query\n"<img src=x onerror=alert(1)>" tag:a\n```',
    );
    expect(html).toBe(
      '<div class="md-query" data-query="&quot;&lt;img src=x onerror=alert(1)&gt;&quot; tag:a"></div>\n',
    );
    // The Viewer reads it back into the same query.
    const back = /data-query="([^"]*)"/.exec(html)?.[1] ?? "";
    const unescaped = back
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    expect(QUERY.parse(unescaped)).toEqual(
      QUERY.parse('"<img src=x onerror=alert(1)>" tag:a\n'),
    );
  });
});

const V = "/v";
const A = `${V}/wiki/attention.md`;
const B = `${V}/wiki/beam-search.md`;
const C = `${V}/wiki/chinchilla.md`;
const S = `${V}/wiki/source-claude-code-064ddbe4-1111-2222-3333-444455556666.md`;
const D1 = `${V}/daily/2024-09-30.md`;
const D2 = `${V}/daily/archive/2025-W40/2025-09-30.md`;
const D3 = `${V}/daily/2025-10-01.md`;
const FILES = [A, B, C, S, D1, D2, D3];
const ADJ: Adjacency = {
  forward: { [A]: [B, C], [B]: [A] },
  backward: { [B]: [A], [C]: [A], [A]: [B] },
  unresolved: {},
  tags: { [A]: ["ml", "llm"], [B]: ["ml"], [C]: ["scaling"] },
  meta: {
    [A]: {
      type: "concept",
      status: "active",
      confidence: "high",
      sourceCount: 3,
    },
    [B]: {
      type: "technique",
      status: "disputed",
      confidence: "low",
      sourceCount: 1,
    },
    [C]: {
      type: "concept",
      status: "active",
      confidence: "high",
      sourceCount: 0,
    },
    [S]: { type: "source", title: "Planning the editor" },
  },
};
const index = (over: Partial<Parameters<typeof queryRows>[1]> = {}) => ({
  adj: ADJ,
  files: FILES,
  vaultRoot: V,
  ...over,
});
const names = (q: string, over?: Partial<Parameters<typeof queryRows>[1]>) =>
  queryRows(parseQuery(q), index(over)).map((r) => r.name);

describe("query block: rows", () => {
  it("filters as ⌘K does: every tag, the frontmatter facets, a path prefix", () => {
    expect(names("tag:ml")).toEqual(["attention", "beam-search"]);
    expect(names("tag:ml tag:llm")).toEqual(["attention"]);
    expect(names("type:concept")).toEqual(["attention", "chinchilla"]);
    expect(names("type:concept status:active confidence:high")).toEqual([
      "attention",
      "chinchilla",
    ]);
    expect(names("path:daily/")).toEqual([
      "2024-09-30",
      "2025-09-30",
      "2025-10-01",
    ]);
  });

  it("matches free words in page names and phrases in the page text", () => {
    expect(names("chin")).toEqual(["chinchilla"]);
    // The phrase scan's files (ipc.searchVault), per phrase: all must hold.
    const phraseHits = [new Set([A, C]), new Set([C, B])];
    expect(names('"scaling law" "compute"', { phraseHits })).toEqual([
      "chinchilla",
    ]);
  });

  it("leaves the page it is written on out", () => {
    expect(names("type:concept", { current: A })).toEqual(["chinchilla"]);
  });

  it("sorts; mtimes date the rows", () => {
    const mtimes = new Map([
      [A, 100],
      [B, 300],
      [C, 200],
    ]);
    expect(names("path:wiki/ sort:modified", { mtimes })).toEqual([
      "beam-search",
      "chinchilla",
      "attention",
      expect.stringMatching(/^source-/),
    ]);
    expect(names("path:wiki/ sort:links")[0]).toBe("attention");
    expect(names("path:daily/ -09-30 sort:-name")).toEqual([
      "2025-09-30",
      "2024-09-30",
    ]);
    expect(queryRows(parseQuery("tag:ml"), index({ mtimes }))[1].modified).toBe(
      300,
    );
  });

  it("shows an opaque session page by its readable name", () => {
    const [row] = queryRows(parseQuery("type:source"), index());
    expect(row.name).toBe(
      "source-claude-code-064ddbe4-1111-2222-3333-444455556666",
    );
    expect(row.label).toBe("Planning the editor");
    expect(queryRows(parseQuery("tag:ml"), index())[0].label).toBe("attention");
  });

  it("counts the rows by type, biggest first, the untyped together", () => {
    const rows = queryRows(parseQuery(""), index());
    expect(countGroups(rows, "No type")).toEqual([
      { label: "No type", count: 3 },
      { label: "concept", count: 2, color: "var(--c-concept)" },
      { label: "source", count: 1, color: "var(--c-source)" },
      { label: "technique", count: 1, color: "var(--c-technique)" },
    ]);
  });
});

describe("query block: bake", () => {
  const doc = "# T\n\n```myco-query\ntag:ml\n```\n\nafter";
  const at = doc.indexOf("```");

  it("writes links only, between the query's markers", () => {
    expect(bakeText("tag:ml", ["a", "b"])).toBe(
      "<!-- myco:query tag:ml -->\n- [[a]]\n- [[b]]\n<!-- /myco:query -->",
    );
    expect(bakeText("tag:ml", [])).toBe(
      "<!-- myco:query tag:ml -->\n<!-- /myco:query -->",
    );
    // A `-->` in the query would end the marker early.
    expect(bakeText('"a-->b" tag:x', [])).toBe(
      '<!-- myco:query "a->b" tag:x -->\n<!-- /myco:query -->',
    );
  });

  it("goes a blank line below the fence the first time", () => {
    expect(apply(doc, bakeEdit(doc, at, "tag:ml", ["a"])!)).toBe(
      "# T\n\n```myco-query\ntag:ml\n```\n\n<!-- myco:query tag:ml -->\n- [[a]]\n<!-- /myco:query -->\n\nafter",
    );
    const tight = "```myco-query\ntag:ml\n```\nnext";
    expect(apply(tight, bakeEdit(tight, 0, "tag:ml", ["a"])!)).toBe(
      "```myco-query\ntag:ml\n```\n\n<!-- myco:query tag:ml -->\n- [[a]]\n<!-- /myco:query -->\n\nnext",
    );
    const last = "```myco-query\ntag:ml\n```";
    expect(apply(last, bakeEdit(last, 0, "tag:ml", [])!)).toBe(
      "```myco-query\ntag:ml\n```\n\n<!-- myco:query tag:ml -->\n<!-- /myco:query -->",
    );
  });

  it("replaces its own previous bake in place, nothing else", () => {
    const baked =
      "```myco-query\ntag:ml\n```\n\nkept\n\n<!-- myco:query other -->\n- [[z]]\n<!-- /myco:query -->\n\n<!-- myco:query tag:ml -->\n- [[old]]\n<!-- /myco:query -->\n\ntail";
    expect(apply(baked, bakeEdit(baked, 0, "tag:ml", ["a", "b"])!)).toBe(
      "```myco-query\ntag:ml\n```\n\nkept\n\n<!-- myco:query other -->\n- [[z]]\n<!-- /myco:query -->\n\n<!-- myco:query tag:ml -->\n- [[a]]\n- [[b]]\n<!-- /myco:query -->\n\ntail",
    );
  });

  it("prefers the bake below the fence when the query repeats", () => {
    const two =
      "<!-- myco:query q -->\n- [[x]]\n<!-- /myco:query -->\n\n```myco-query\nq\n```\n\n<!-- myco:query q -->\n- [[y]]\n<!-- /myco:query -->";
    const e = bakeEdit(two, two.indexOf("```"), "q", ["n"])!;
    expect(apply(two, e)).toBe(
      "<!-- myco:query q -->\n- [[x]]\n<!-- /myco:query -->\n\n```myco-query\nq\n```\n\n<!-- myco:query q -->\n- [[n]]\n<!-- /myco:query -->",
    );
  });

  it("after the query is edited, baking again replaces the bake under its fence", () => {
    const edited =
      "```myco-query\ntype:concept limit:3\n```\n\n<!-- myco:query type:concept limit:2 -->\n- [[a]]\n- [[b]]\n<!-- /myco:query -->\n\nend";
    expect(
      apply(
        edited,
        bakeEdit(edited, 0, "type:concept limit:3", ["a", "b", "c"])!,
      ),
    ).toBe(
      "```myco-query\ntype:concept limit:3\n```\n\n<!-- myco:query type:concept limit:3 -->\n- [[a]]\n- [[b]]\n- [[c]]\n<!-- /myco:query -->\n\nend",
    );
  });

  it("the bake under its fence stays another block's when that block's query names it", () => {
    const moved =
      "```myco-query\nnew\n```\n\n<!-- myco:query old -->\n- [[x]]\n<!-- /myco:query -->\n\n```myco-query\nold\n```";
    expect(apply(moved, bakeEdit(moved, 0, "new", ["n"])!)).toBe(
      moved.replace(
        "```\n\n",
        "```\n\n<!-- myco:query new -->\n- [[n]]\n<!-- /myco:query -->\n\n",
      ),
    );
  });

  it("a bake whose closing marker was deleted is left alone", () => {
    const open = "```myco-query\nq\n```\n\n<!-- myco:query q -->\n- [[x]]";
    expect(apply(open, bakeEdit(open, 0, "q", ["n"])!)).toBe(
      "```myco-query\nq\n```\n\n<!-- myco:query q -->\n- [[n]]\n<!-- /myco:query -->\n\n<!-- myco:query q -->\n- [[x]]",
    );
  });

  // A bake whose close is gone must not run on to another bake's close: the
  // text in between (the user's, another query block) was deleted.
  it("an opening marker without its own close is no bake, whatever comes later", () => {
    const below = [
      "```myco-query\nq\n```",
      "<!-- myco:query q -->\n- [[x]]",
      "## My notes\nA paragraph the user wrote.",
      "```myco-query\nr\n```",
      "<!-- myco:query r -->\n- [[y]]\n<!-- /myco:query -->",
      "tail",
    ].join("\n\n");
    const fresh = "<!-- myco:query q -->\n- [[n]]\n<!-- /myco:query -->";
    expect(apply(below, bakeEdit(below, 0, "q", ["n"])!)).toBe(
      below.replace("```\n\n", "```\n\n" + fresh + "\n\n"),
    );
    // The orphan above the fence: the clicked fence itself was deleted.
    const above = [
      "<!-- myco:query q -->\n- [[x]]",
      "```myco-query\nq\n```",
      "Kept text.",
      "```myco-query\nr\n```",
      "<!-- myco:query r -->\n- [[y]]\n<!-- /myco:query -->",
    ].join("\n\n");
    const at = above.indexOf("```");
    expect(apply(above, bakeEdit(above, at, "q", ["n"])!)).toBe(
      above.replace("q\n```\n\n", "q\n```\n\n" + fresh + "\n\n"),
    );
  });

  it("markers quoted in a code block are text, not a bake", () => {
    const quoted =
      "```myco-query\ntag:ml\n```\n\nA bake looks like:\n\n````markdown\n<!-- myco:query tag:ml -->\n- [[example]]\n<!-- /myco:query -->\n````";
    expect(apply(quoted, bakeEdit(quoted, 0, "tag:ml", ["a"])!)).toBe(
      quoted.replace(
        "```\n\nA bake",
        "```\n\n<!-- myco:query tag:ml -->\n- [[a]]\n<!-- /myco:query -->\n\nA bake",
      ),
    );
  });

  // Live draws a query inside a callout, a quote or a list item; its bake
  // must stay in there, or the container ends at the query.
  describe("inside a container", () => {
    const outline = (src: string) =>
      markdownRenderer
        .parse(src, {})
        .filter((t) => t.level === 0)
        .map((t) => t.type);
    it.each([
      [
        "a callout",
        "> [!note] Pages\n> ```myco-query\n> tag:ml\n> ```\n> more callout text\n\nend",
        "> [!note] Pages\n> ```myco-query\n> tag:ml\n> ```\n>\n> <!-- myco:query tag:ml -->\n> - [[a]]\n> - [[b]]\n> <!-- /myco:query -->\n>\n> more callout text\n\nend",
      ],
      [
        "a quote",
        "> ```myco-query\n> tag:ml\n> ```\n\nend",
        "> ```myco-query\n> tag:ml\n> ```\n>\n> <!-- myco:query tag:ml -->\n> - [[a]]\n> - [[b]]\n> <!-- /myco:query -->\n\nend",
      ],
      [
        "a numbered item",
        "1. first\n\n   ```myco-query\n   tag:ml\n   ```\n2. second",
        "1. first\n\n   ```myco-query\n   tag:ml\n   ```\n\n   <!-- myco:query tag:ml -->\n   - [[a]]\n   - [[b]]\n   <!-- /myco:query -->\n\n2. second",
      ],
    ])("in %s", (_, src, baked) => {
      const at = src.indexOf("```");
      const once = apply(src, bakeEdit(src, at, "tag:ml", ["a", "b"])!);
      expect(once).toBe(baked);
      expect(outline(once)).toEqual(outline(src));
      const html = markdownRenderer.render(once);
      expect(html).not.toContain("myco:query");
      expect(html).toContain('data-link="b"');
      // Baking again replaces that bake, container marks and all.
      const twice = apply(once, bakeEdit(once, at, "tag:ml", ["c"])!);
      expect(twice).toBe(
        baked.replace(/(\n[ >]*)- \[\[a\]\]\n[ >]*- \[\[b\]\]/, "$1- [[c]]"),
      );
    });
  });

  it("Preview hides the markers and shows the links", () => {
    const html = markdownRenderer.render(
      "```myco-query\ntag:ml\n```\n\n" + bakeText("tag:ml", ["a", "b"]),
    );
    expect(html).not.toContain("myco:query");
    expect(html).toContain(
      '<ul>\n<li><a data-link="a" class="myco-wikilink" href="#">a</a></li>',
    );
  });
});

describe("query block: slash items", () => {
  const ko = slashItems(STRINGS.ko, new Date(2026, 8, 30));

  it("/쿼리 and /query insert the sample query, drawn at once", () => {
    for (const q of ["쿼리", "query", "dataview"])
      expect(filterSlash(ko, q)[0]?.label, q).toBe("query");
    expect(ko.find((i) => i.label === "query")?.template).toBe(
      QUERY.template + "\n${}",
    );
    expect(filterSlash(slashItems(STRINGS.ja), "クエリ")[0]?.label).toBe(
      "query",
    );
  });

  it("on this day as a query: daily/ pages named with today's month-day, newest first", () => {
    expect(onThisDayQuery(new Date(2026, 8, 30))).toBe(
      "```myco-query\npath:daily/ -09-30 sort:-name\n```",
    );
    const otd = ko.find((i) => i.label === "onthisday-query");
    expect(otd).toMatchObject({
      section: "records",
      template: onThisDayQuery(new Date(2026, 8, 30)) + "\n${}",
    });
    expect(filterSlash(ko, "과거의 오늘")[0]?.label).toBe("onthisday-query");
    // Found on any UI language, as /목차 is.
    expect(filterSlash(slashItems(STRINGS.en), "과거의 오늘")[0]?.label).toBe(
      "onthisday-query",
    );
    // The picker keeps its own name.
    expect(filterSlash(ko, "오늘의 과거").map((i) => i.label)).toEqual([
      "onthisday",
    ]);
    const q = parseQuery(onThisDayQuery(new Date(2026, 8, 30)).split("\n")[1]);
    expect(queryRows(q, index()).map((r) => r.name)).toEqual([
      "2025-09-30",
      "2024-09-30",
    ]);
    // The name holds -09-30: this year's note and a suffixed one too (not
    // the picker's past years only); on today's note, that note is left out.
    const now = `${V}/daily/2026-09-30.md`;
    const files = [...FILES, now, `${V}/daily/2025-09-30-standup.md`];
    expect(queryRows(q, index({ files })).map((r) => r.name)).toEqual([
      "2026-09-30",
      "2025-09-30-standup",
      "2025-09-30",
      "2024-09-30",
    ]);
    expect(
      queryRows(q, index({ files, current: now })).map((r) => r.name),
    ).toEqual(["2025-09-30-standup", "2025-09-30", "2024-09-30"]);
  });
});
