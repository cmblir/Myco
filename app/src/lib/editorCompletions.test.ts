import { describe, expect, it } from "vitest";
import {
  bodyTagQueryAt,
  filterSlash,
  qwertyOf,
  slashBlockEdit,
  slashItems,
  slashQueryAt,
  tagQueryAt,
  wikilinkOptions,
  wikilinkQueryAt,
} from "./editorCompletions";
import { STRINGS } from "./i18n";
import type { FileNode } from "./ipc";

describe("tagQueryAt", () => {
  it("completes the last inline tag (comma or flow-list form)", () => {
    expect(tagQueryAt("---\ntags: a, b")).toEqual({ from: 13, query: "b" });
    expect(tagQueryAt("---\ntags: [x, y")).toMatchObject({ query: "y" });
  });

  it("completes a block-list item under tags:", () => {
    expect(tagQueryAt("---\ntags:\n  - fo")).toEqual({ from: 14, query: "fo" });
    expect(tagQueryAt("---\ntags:\n  - my ta")).toMatchObject({ query: "my ta" });
  });

  it("ignores list items under another key", () => {
    expect(tagQueryAt("---\ntitle: t\n  - fo")).toBeNull();
  });

  it("never triggers in the body or without an opening fence", () => {
    expect(tagQueryAt("---\na: 1\n---\nbody #ta")).toBeNull();
    expect(tagQueryAt("tags: a")).toBeNull();
  });
});

describe("bodyTagQueryAt", () => {
  it("matches # at line start or after whitespace, query without the #", () => {
    expect(bodyTagQueryAt("#")).toEqual({ from: 1, query: "" });
    expect(bodyTagQueryAt("x #fo")).toEqual({ from: 3, query: "fo" });
    expect(bodyTagQueryAt("---\na: 1\n---\nbody #ta")).toMatchObject({
      query: "ta",
    });
  });

  it("ignores headings, glued hashes and open frontmatter", () => {
    expect(bodyTagQueryAt("# ")).toBeNull();
    expect(bodyTagQueryAt("## x")).toBeNull();
    expect(bodyTagQueryAt("a#b")).toBeNull();
    expect(bodyTagQueryAt("---\ntags: #fo")).toBeNull();
  });
});

describe("slashQueryAt", () => {
  it("matches / at line start or after whitespace", () => {
    expect(slashQueryAt("/")).toEqual({ from: 0, query: "" });
    expect(slashQueryAt("  /tab")).toEqual({ from: 2, query: "tab" });
    expect(slashQueryAt("a /x")).toEqual({ from: 2, query: "x" });
  });

  it("ignores slashes inside words and URLs, and a closed word", () => {
    expect(slashQueryAt("9/2")).toBeNull();
    expect(slashQueryAt("http://x")).toBeNull();
    expect(slashQueryAt("/x ")).toBeNull();
  });

  it("keeps words after a space in the query (`/오늘의 과거`)", () => {
    expect(slashQueryAt("/오늘의 과거")).toEqual({ from: 0, query: "오늘의 과거" });
    expect(slashQueryAt("a /제목 4")).toEqual({ from: 2, query: "제목 4" });
    expect(slashQueryAt("/오늘의 과거 ")).toBeNull();
  });
});

describe("wikilinkQueryAt", () => {
  it("reads an unclosed [[query, from = its first character", () => {
    expect(wikilinkQueryAt("see [[atten")).toEqual({
      from: 6,
      query: "atten",
      note: null,
    });
    expect(wikilinkQueryAt("![[")).toEqual({ from: 3, query: "", note: null });
  });

  it("after `#`, the note and the heading typed so far", () => {
    expect(wikilinkQueryAt("[[attention#Sca")).toEqual({
      from: 12,
      query: "Sca",
      note: "attention",
    });
    // `[[#…` = this note's own headings.
    expect(wikilinkQueryAt("[[#")).toEqual({ from: 3, query: "", note: "" });
  });

  it("ignores a closed link and an alias being typed", () => {
    expect(wikilinkQueryAt("[[a]] b")).toBeNull();
    expect(wikilinkQueryAt("[[a|b")).toBeNull();
    expect(wikilinkQueryAt("no link")).toBeNull();
  });
});

describe("slashItems / filterSlash", () => {
  const ko = slashItems(STRINGS.ko, new Date(2026, 0, 5));

  it("has 26 items and today's local date", () => {
    expect(ko).toHaveLength(26);
    expect(ko.find((i) => i.label === "date")?.template).toBe("2026-01-05");
  });

  it("groups the items by section, in section order, each with an icon", () => {
    const order = ["basic", "media", "records", "advanced"];
    const ranks = ko.map((i) => order.indexOf(i.section));
    expect(ranks.every((r) => r >= 0)).toBe(true);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(ko.every((i) => i.icon.length > 0)).toBe(true);
    expect(ko.find((i) => i.label === "code")?.section).toBe("media");
    expect(ko.find((i) => i.label === "link")?.section).toBe("records");
  });

  it("adds callout, toggle and link to note as text", () => {
    const by = (l: string) => ko.find((i) => i.label === l);
    expect(by("callout")?.block).toBe("> [!note] ");
    expect(by("toggle")?.block).toBe("> [!note]- ");
    // Inline `[[`: the wikilink completion takes over from there.
    expect(by("link")).toMatchObject({ template: "[[${}", inline: true });
    expect(by("link")?.detail).toBe("노트 링크");
  });

  it("offers image as a Media picker (the file dialog), on any UI language", () => {
    expect(ko.find((i) => i.label === "image")).toMatchObject({
      section: "media",
      picker: "image",
      detail: "이미지",
    });
    const en = slashItems(STRINGS.en);
    for (const q of ["image", "img", "picture", "이미지", "画像"])
      expect(filterSlash(en, q)[0]?.label, q).toBe("image");
  });

  it("offers embed as a Records block that opens the `[[` note list", () => {
    expect(ko.find((i) => i.label === "embed")).toMatchObject({
      section: "records",
      template: "![[${}",
      reopen: true,
      apart: true,
      detail: "노트 임베드",
    });
    const en = slashItems(STRINGS.en);
    for (const q of ["embed", "transclude", "임베드", "埋め込み"])
      expect(filterSlash(en, q)[0]?.label, q).toBe("embed");
    expect(filterSlash(ko, "임베드")[0].label).toBe("embed");
  });

  it("offers recall as a Records picker, found as /기록 and /recall", () => {
    const recall = ko.find((i) => i.label === "recall");
    expect(recall).toMatchObject({ section: "records", picker: "recall" });
    expect(filterSlash(ko, "기록")[0].label).toBe("recall");
    expect(filterSlash(ko, "recall")[0].label).toBe("recall");
    for (const q of ["검색", "찾기", "불러오기"])
      expect(filterSlash(ko, q)[0]?.label, q).toBe("recall");
  });

  it("offers ask as a Records picker, found as /질문 and /ask", () => {
    const ask = ko.find((i) => i.label === "ask");
    expect(ask).toMatchObject({
      section: "records",
      picker: "ask",
      icon: "?",
      detail: "볼트에 질문",
    });
    for (const q of ["질문", "물어보기", "답", "ask", "question", "answer"])
      expect(filterSlash(ko, q)[0]?.label, q).toBe("ask");
    expect(slashItems(STRINGS.en).find((i) => i.label === "ask")?.detail).toBe(
      "Ask the vault",
    );
  });

  it("offers on-this-day as a Records picker, spaces and all", () => {
    const otd = ko.find((i) => i.label === "onthisday");
    expect(otd).toMatchObject({ section: "records", picker: "onthisday" });
    expect(filterSlash(ko, "오늘의 과거").map((i) => i.label)).toEqual([
      "onthisday",
    ]);
    expect(filterSlash(ko, "오늘의")[0].label).toBe("onthisday");
    expect(filterSlash(ko, "오늘")[0].label).toBe("date");
    const ja = slashItems(STRINGS.ja);
    expect(filterSlash(ja, "今日")[0].label).toBe("date");
  });

  it("matches aliases by prefix", () => {
    expect(filterSlash(ko, "checkbox").map((i) => i.label)).toEqual(["todo"]);
    expect(filterSlash(ko, "separator").map((i) => i.label)).toEqual([
      "divider",
    ]);
    expect(filterSlash(ko, "wikilink").map((i) => i.label)).toEqual(["link"]);
  });

  it("matches a query typed on a Korean 2-beolsik layout", () => {
    // `/h1` with the Korean input source on: `h` is ㅗ.
    expect(filterSlash(ko, "ㅗ1").map((i) => i.label)).toEqual(["h1"]);
    // The IME composes `todo` into syllables: 새애 = ㅅㅐㅇㅐ = t o d o.
    expect(filterSlash(ko, "새애")[0].label).toBe("todo");
    expect(filterSlash(ko, "챙ㄷ")[0].label).toBe("code");
    // Composed Korean still matches the localized names.
    expect(filterSlash(ko, "표").map((i) => i.label)).toEqual(["table"]);
  });

  it("returns nothing for an unknown query", () => {
    expect(filterSlash(ko, "zzz")).toEqual([]);
  });

  it("filters by label prefix or localized description", () => {
    expect(filterSlash(ko, "표").map((i) => i.label)).toEqual(["table"]);
    expect(filterSlash(ko, "h").map((i) => i.label)).toEqual([
      "h1",
      "h2",
      "h3",
      "h4",
    ]);
    expect(filterSlash(ko, "")).toHaveLength(26);
  });

  it("ranks label-prefix matches before description matches", () => {
    const en = slashItems(STRINGS.en);
    expect(filterSlash(en, "d")[0].label).toBe("divider");
    expect(filterSlash(en, "t")[0].label).toBe("todo");
    expect(filterSlash(en, "n")[0].label).toBe("numbered");
  });

  it("offers H4 as a block, found by its Korean name too", () => {
    expect(filterSlash(ko, "제목 4").map((i) => [i.label, i.block])).toEqual([
      ["h4", "#### "],
    ]);
  });

  it("offers registry blocks: /toc (/목차) inserts the fence, caret below", () => {
    const toc = ko.find((i) => i.label === "toc");
    expect(toc).toMatchObject({
      section: "advanced",
      detail: "목차",
      template: "```toc\n```\n${}",
    });
    expect(filterSlash(ko, "목차")[0].label).toBe("toc");
    expect(filterSlash(ko, "toc")[0].label).toBe("toc");
    expect(filterSlash(ko, "outline")[0].label).toBe("toc");
    expect(filterSlash(slashItems(STRINGS.en), "목차")[0].label).toBe("toc");
  });

  it("offers /chart (/차트): a sample table, its ^id and the fence, apart", () => {
    const chart = ko.find((i) => i.label === "chart");
    expect(chart).toMatchObject({ section: "advanced", detail: "차트", apart: true });
    expect(chart?.template).toBe(
      "|  | A | B |\n| --- | --- | --- |\n| Q1 | 12 | 8 |\n| Q2 | 19 | 11 |\n| Q3 | 15 | 9 |\n\n^chart-data\n\n```chart\ntype: bar\nid: chart-data\ntitle: 예시 차트\n```\n${}",
    );
    expect(filterSlash(ko, "차트")[0].label).toBe("chart");
    expect(filterSlash(ko, "그래프")[0].label).toBe("chart");
    expect(filterSlash(slashItems(STRINGS.en), "graph")[0].label).toBe("chart");
  });

  it("offers /mermaid (/다이어그램): a sample flowchart in the UI's language", () => {
    const item = ko.find((i) => i.label === "mermaid");
    expect(item).toMatchObject({ section: "advanced", detail: "다이어그램" });
    expect(item?.template).toBe(
      "```mermaid\nflowchart LR\n  A[아이디어] --> B{남길 만한가?}\n  B -->|예| C[노트로 쓰기]\n  B -->|아니요| D[흘려보내기]\n```\n${}",
    );
    const en = slashItems(STRINGS.en);
    expect(filterSlash(ko, "다이어그램")[0].label).toBe("mermaid");
    expect(filterSlash(en, "다이어그램")[0].label).toBe("mermaid");
    expect(filterSlash(en, "diagram")[0].label).toBe("mermaid");
    expect(filterSlash(en, "flowchart")[0].label).toBe("mermaid");
  });

  it("offers /math (/수식): a display formula, the caret below", () => {
    const item = ko.find((i) => i.label === "math");
    expect(item).toMatchObject({ section: "advanced", detail: "수식" });
    expect(item?.template).toBe(
      "$$\n\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}\n$$\n${}",
    );
    const en = slashItems(STRINGS.en);
    expect(filterSlash(ko, "수식")[0].label).toBe("math");
    expect(filterSlash(en, "수식")[0].label).toBe("math");
    expect(filterSlash(en, "equation")[0].label).toBe("math");
    expect(filterSlash(en, "latex")[0].label).toBe("math");
    expect(filterSlash(en, "ma")[0].label).toBe("math");
  });

  it("opens a code block with the caret in its body", () => {
    expect(ko.find((i) => i.label === "code")?.template).toBe("```\n${}\n```");
  });
});

describe("slashBlockEdit", () => {
  it("turns an empty line into the block", () => {
    expect(slashBlockEdit("/h2", 0, 3, "## ")).toEqual({ text: "## ", caret: 3 });
  });

  it("turns the whole line into the block when called mid-line", () => {
    expect(slashBlockEdit("Idea /h2", 5, 8, "## ")).toEqual({
      text: "## Idea",
      caret: 7,
    });
    expect(slashBlockEdit("ab /h2 cd", 3, 6, "## ")).toEqual({
      text: "## ab cd",
      caret: 6,
    });
  });

  it("replaces the line's old block marks and keeps its indent", () => {
    expect(slashBlockEdit("- item /h1", 7, 10, "# ").text).toBe("# item");
    expect(slashBlockEdit("## Old /todo", 7, 12, "- [ ] ")).toEqual({
      text: "- [ ] Old",
      caret: 9,
    });
    expect(slashBlockEdit("> q /h2", 4, 7, "## ").text).toBe("## q");
    expect(slashBlockEdit("  - n /todo", 6, 11, "- [ ] ").text).toBe(
      "  - [ ] n",
    );
  });

  it("trims the spaces around a removed /query only", () => {
    // No query (Turn into): the line's own spaces, a hard break too, stay.
    expect(slashBlockEdit("line one  ", 10, 10, "> ").text).toBe(
      "> line one  ",
    );
  });

  it("drops a callout's [!type] marker with its quote marks", () => {
    expect(slashBlockEdit("> [!note] Tip", 13, 13, "").text).toBe("Tip");
    expect(slashBlockEdit("> [!warning]- Fold", 18, 18, "## ").text).toBe(
      "## Fold",
    );
    expect(slashBlockEdit("> [!note]", 9, 9, "").text).toBe("");
  });
});

describe("qwertyOf", () => {
  it("maps jamo and syllables to the keys pressed; other text stays", () => {
    expect(qwertyOf("ㅗ1")).toBe("h1");
    expect(qwertyOf("새애")).toBe("todo");
    expect(qwertyOf("줘")).toBe("wnj"); // ㅝ is two keys
    expect(qwertyOf("ㅘ")).toBe("hk");
    expect(qwertyOf("값")).toBe("rkqt"); // ㅄ = qt
    expect(qwertyOf("h1 x")).toBe("h1 x");
  });
});

// UX backlog S17: one row per stem (links resolve by stem), its detail the
// folder of the note the link opens, the link written as the stem.
describe("wikilinkOptions", () => {
  const tree: FileNode[] = [
    {
      kind: "directory",
      name: "templates",
      path: "/v/templates",
      children: [{ kind: "file", name: "attention.md", path: "/v/templates/attention.md" }],
    },
    {
      kind: "directory",
      name: "wiki",
      path: "/v/wiki",
      children: [
        { kind: "file", name: "attention.md", path: "/v/wiki/attention.md" },
        { kind: "file", name: "rope.md", path: "/v/wiki/rope.md" },
      ],
    },
    {
      kind: "directory",
      name: "daily",
      path: "/v/daily",
      children: [{ kind: "file", name: "attention.md", path: "/v/daily/attention.md" }],
    },
    { kind: "file", name: "welcome.md", path: "/v/welcome.md" },
  ];

  it("lists a stem once, with the folder its link opens", () => {
    const { options } = wikilinkOptions(tree, "/v", "att");
    expect(options).toEqual([{ label: "attention", detail: "wiki" }]);
  });

  it("gives no folder for a note at the vault root", () => {
    expect(wikilinkOptions(tree, "/v", "wel").options).toEqual([{ label: "welcome" }]);
  });

  it("says when the list was cut", () => {
    expect(wikilinkOptions(tree, "/v", "", 2)).toMatchObject({ cut: true });
    expect(wikilinkOptions(tree, "/v", "")).toMatchObject({ cut: false });
  });
});

// S29: the two pairs that read alike by name get a one-line hint each.
describe("slash hints", () => {
  it("tells recall from query and on-this-day from its query block", () => {
    const items = slashItems(STRINGS.ko);
    const hint = (label: string) => items.find((i) => i.label === label)?.hint;
    for (const label of ["recall", "query", "onthisday", "onthisday-query"]) {
      expect(hint(label), label).toBeTruthy();
    }
    expect(new Set(["recall", "query", "onthisday", "onthisday-query"].map(hint)).size).toBe(4);
    expect(hint("h1")).toBeUndefined();
  });
});
