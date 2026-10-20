import { describe, expect, it, onTestFinished, vi } from "vitest";
import { EditorState, type Transaction } from "@codemirror/state";
import { history, undo } from "@codemirror/commands";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import MarkdownIt from "markdown-it";
import { applySlash, mycoMarkdown } from "./editorBlocks";
import { slashItems } from "./editorCompletions";
import { STRINGS } from "./i18n";
import {
  answerBlock,
  appendBlock,
  askSearch,
  blockInsertionResult,
  chunkSection,
  insertBlockTr,
  insertInlineTr,
  linkList,
  noteHeadings,
  onThisDay,
  quoteBlock,
  recallExcerpt,
  recallSearch,
  recallTarget,
} from "./editorRecall";
import type { RetrievedChunks } from "./chat";
import type { ScoredChunk } from "./ipc";
import { markdownRenderer } from "./markdown";

const CARET = "│";

function st(src: string): EditorState {
  const pos = src.indexOf(CARET);
  return EditorState.create({
    doc: src.replace(CARET, ""),
    selection: { anchor: pos },
    extensions: [mycoMarkdown(), history()],
  });
}

function show(tr: Transaction): string {
  const { doc, selection } = tr.state;
  const h = selection.main.head;
  return doc.sliceString(0, h) + CARET + doc.sliceString(h);
}

const hit = (text: string, over: Partial<ScoredChunk> = {}): ScoredChunk => ({
  page: "wiki/attention.md",
  stem: "attention",
  section: 0,
  text,
  score: 0.03,
  similarity: 0.61,
  ...over,
});

describe("chunkSection", () => {
  it("takes the heading a chunk opens with, as its visible text", () => {
    expect(chunkSection("## Why it works\n\nBecause.")).toBe("Why it works");
    expect(chunkSection("# **Bold** idea ##\nx")).toBe("Bold idea");
  });

  it("skips a leading frontmatter block", () => {
    expect(chunkSection("---\ntype: concept\n---\n# Title\n\nBody")).toBe(
      "Title",
    );
  });

  it("is null for a chunk that starts mid-section or with a #tag", () => {
    expect(chunkSection("Continued paragraph.")).toBeNull();
    expect(chunkSection("#tag line\n\ntext")).toBeNull();
  });

  it("drops the characters that end or split a wikilink target", () => {
    expect(chunkSection("## A | B [x] #c ^d")).toBe("A B x c d");
  });
});

describe("noteHeadings", () => {
  it("lists a note's headings once each, as link anchors, past its frontmatter", () => {
    const raw =
      "---\ntitle: x\n---\n# Title\n\n## A | B\n\n```\n# not one\n```\n\n## A | B\n";
    expect(noteHeadings(raw)).toEqual(["Title", "A B"]);
  });
});

describe("recallTarget", () => {
  it("is stem#Section, or the stem when the chunk has no heading", () => {
    expect(recallTarget(hit("## Scaling\n\nMore data."))).toBe(
      "attention#Scaling",
    );
    expect(recallTarget(hit("mid-section text"))).toBe("attention");
  });
});

describe("recallExcerpt", () => {
  it("quotes the chunk's own lines, without its heading", () => {
    expect(recallExcerpt(hit("## Scaling\n\nMore data helps.\nA lot."))).toBe(
      "More data helps.\nA lot.",
    );
  });

  it("never copies a footnote reference or its definition", () => {
    const text =
      "# Attention\n\nIt is core[^src-a]. See [[x]].\n\n[^src-a]: [[source-a]]\n";
    expect(recallExcerpt(hit(text))).toBe("It is core. See [[x]].");
  });

  it("is empty for a frontmatter-only chunk", () => {
    expect(recallExcerpt(hit("---\ntype: concept\n---"))).toBe("");
  });

  it("cuts a long chunk through quoteBody, marking the cut", () => {
    const long = "## H\n\n" + "word ".repeat(400).trim();
    const out = recallExcerpt(hit(long));
    expect(out.length).toBeLessThan(720);
    expect(out.endsWith("…")).toBe(true);
    expect(long).toContain(out.slice(0, -1).trim());
  });
});

describe("quoteBlock", () => {
  it("quotes every line and attributes the source below", () => {
    expect(quoteBlock("One.\n\nTwo.", "attention#Scaling")).toBe(
      "> One.\n>\n> Two.\n— [[attention#Scaling]]",
    );
  });
});

describe("insertBlockTr", () => {
  it("replaces an empty line, set apart from the text around it", () => {
    const t = insertBlockTr(st("Above\n│\nBelow"), 6, "> q\n— [[n]]");
    expect(show(t)).toBe("Above\n\n> q\n— [[n]]│\n\nBelow");
  });

  it("takes the place of an empty block (nothing after its marks)", () => {
    for (const empty of ["- ", "- [ ] ", "## ", "> ", "1. "]) {
      const s = st("para\n\n" + empty + "│");
      const t = insertBlockTr(s, s.selection.main.head, "> q\n— [[n]]");
      expect(show(t), empty).toBe("para\n\n> q\n— [[n]]│");
    }
  });

  it("/recall in an empty bullet: the quote replaces it, one undo restores it", () => {
    let state = st("para\n\n- /recall│");
    const view = {
      get state() {
        return state;
      },
      dispatch: (t: Transaction) => {
        state = t.state;
      },
    };
    let at = -1;
    const recall = slashItems(STRINGS.en).find((i) => i.label === "recall")!;
    applySlash(view, recall, 8, 15, (_m, pos) => (at = pos));
    view.dispatch(insertBlockTr(state, at, quoteBlock("excerpt", "note#Sec")));
    expect(state.doc.toString()).toBe("para\n\n> excerpt\n— [[note#Sec]]");
    undo(view);
    expect(state.doc.toString()).toBe("para\n\n- ");
  });

  it("goes below the caret's block when the line has text", () => {
    const t = insertBlockTr(st("One li│ne\nsoft line\n\nNext"), 6, "B");
    expect(show(t)).toBe("One line\nsoft line\n\nB│\n\nNext");
  });

  it("goes below a whole fence, never inside it", () => {
    const src = "```\na\n│\nb\n```\n";
    const t = insertBlockTr(st(src), 6, "B");
    expect(t.state.doc.toString()).toBe("```\na\n\nb\n```\n\nB\n");
  });

  it("goes below the quote or top-level item it sits in, which stays whole", () => {
    const put = (src: string) => {
      const s = st(src);
      return insertBlockTr(s, s.selection.main.head, "B").state.doc.toString();
    };
    // A nested item's later siblings stay under their parent…
    const nested = put("- parent\n  - child o│ne\n  - child two\n- next");
    expect(nested).toBe("- parent\n  - child one\n  - child two\n\nB\n\n- next");
    expect(markdownRenderer.render(nested)).toContain(
      "<li>child one</li>\n<li>child two</li>\n</ul>\n</li>",
    );
    // …a callout's later items stay in the callout…
    expect(put("> [!note]- T\n> - a│\n> - b\n\nafter")).toBe(
      "> [!note]- T\n> - a\n> - b\n\nB\n\nafter",
    );
    // …and so do its lines after an empty one the block would have taken.
    expect(put("> [!note] T\n> a\n> │\n> b")).toBe(
      "> [!note] T\n> a\n> \n> b\n\nB",
    );
    expect(put("- p\n  - │\n  - c")).toBe("- p\n  - \n  - c\n\nB");
    // A top-level item is its own container: the list goes on after it.
    expect(put("- a\n- b│\n- c")).toBe("- a\n- b\n\nB\n\n- c");
  });

  it("keeps the list whole where the state's first parse stopped short", () => {
    // A loaded machine can exhaust both the initial 20 ms and the first
    // 50 ms lookup. Later lookups may finish, so all boundaries must come
    // from the same complete tree rather than the first partial one.
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 1000));
    onTestFinished(() => clock.mockRestore());
    const intro = "Filler paragraph text.\n\n".repeat(150);
    const s = st(intro + "- parent\n  - child o│ne\n  - child two\n- next");
    expect(syntaxTree(s).length).toBeLessThan(s.selection.main.head);
    let calls = 0;
    clock.mockImplementation(() => now + Math.min(++calls, 2) * 1000);
    expect(
      insertBlockTr(s, s.selection.main.head, "B").state.doc.toString(),
    ).toBe(intro + "- parent\n  - child one\n  - child two\n\nB\n\n- next");
  });

  it("preserves the note and caret with retry advice when parsing stays busy", () => {
    let now = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 1000));
    onTestFinished(() => clock.mockRestore());
    const intro = "Filler paragraph text.\n\n".repeat(150);
    const s = st(intro + "- parent\n  - child o│ne\n  - child two\n- next");
    const t = insertBlockTr(s, s.selection.main.head, "B");
    expect(t.docChanged).toBe(false);
    expect(t.newDoc.toString()).toBe(s.doc.toString());
    expect(t.newSelection.eq(s.selection)).toBe(true);
    expect(t.effects.find((effect) => effect.is(blockInsertionResult))?.value).toBe(
      false,
    );
    clock.mockImplementation(() => now);
    const retry = insertBlockTr(t.state, s.selection.main.head, "B");
    expect(retry.state.doc.toString()).toBe(
      intro + "- parent\n  - child one\n  - child two\n\nB\n\n- next",
    );
    expect(
      retry.effects.find((effect) => effect.is(blockInsertionResult))?.value,
    ).toBe(true);
  });

  it("lands at the body's top when the caret is in the frontmatter", () => {
    const t = insertBlockTr(st("---\na: │1\n---\n\nText"), 7, "B");
    expect(t.state.doc.toString()).toBe("---\na: 1\n---\n\nB\n\nText");
  });

  it("is one undo step", () => {
    let state = st("Above\n│");
    state = insertBlockTr(state, 6, "> q\n— [[n]]").state;
    const view = {
      get state() {
        return state;
      },
      dispatch: (t: Transaction) => {
        state = t.state;
      },
    };
    undo(view);
    expect(state.doc.toString()).toBe("Above\n");
  });
});

describe("insertInlineTr", () => {
  it("inserts at the caret with a space against a word", () => {
    expect(show(insertInlineTr(st("see│"), "[[a]]"))).toBe("see [[a]]│");
    expect(show(insertInlineTr(st("│x"), "[[a]]"))).toBe("[[a]] │x");
    expect(show(insertInlineTr(st("a │ b"), "[[a]]"))).toBe("a [[a]]│ b");
  });

  it("replaces a selection", () => {
    const s = EditorState.create({
      doc: "a word b",
      selection: { anchor: 2, head: 6 },
      extensions: [mycoMarkdown()],
    });
    expect(show(insertInlineTr(s, "[[w]]"))).toBe("a [[w]]│ b");
  });

  it("never lands in the frontmatter", () => {
    const t = insertInlineTr(st("---\na: │1\n---\nText"), "[[a]]");
    expect(t.state.doc.toString()).toBe("---\na: 1\n---\nText\n\n[[a]]");
  });
});

describe("appendBlock", () => {
  it("adds the block as the note's last block", () => {
    expect(appendBlock("Text", "B")).toBe("Text\n\nB\n");
    expect(appendBlock("Text\n", "B")).toBe("Text\n\nB\n");
    expect(appendBlock("Text\n\n", "B")).toBe("Text\n\nB\n");
    expect(appendBlock("", "B")).toBe("B\n");
  });
});

describe("onThisDay", () => {
  const root = "/v";
  const now = new Date(2026, 8, 25);
  it("lists past years' daily notes of the same month-day, newest first", () => {
    const paths = [
      "/v/daily/2024-09-25.md",
      "/v/daily/archive/2025-W39/2025-09-25.md",
      "/v/daily/2026-09-25.md", // today, not the past
      "/v/daily/2025-09-24.md",
      "/v/wiki/2023-09-25.md", // not a daily note
      "/v/daily/archive/2022-09-25.md",
    ];
    expect(onThisDay(paths, root, now)).toEqual([
      "2025-09-25",
      "2024-09-25",
      "2022-09-25",
    ]);
  });

  it("is empty when there are none", () => {
    expect(onThisDay(["/v/daily/2026-09-24.md"], root, now)).toEqual([]);
  });

  it("reads Windows paths too", () => {
    const paths = [
      "C:\\v\\daily\\2024-09-25.md",
      "C:\\v\\daily\\archive\\2023-09-25.md",
      "C:\\v2\\daily\\2022-09-25.md", // a sibling folder is not the vault
    ];
    const both = ["2024-09-25", "2023-09-25"];
    expect(onThisDay(paths, "C:\\v", now)).toEqual(both);
    expect(onThisDay(paths, "C:\\v\\", now)).toEqual(both);
  });

  it("links them as a list", () => {
    expect(linkList(["2025-09-25", "2024-09-25"])).toBe(
      "- [[2025-09-25]]\n- [[2024-09-25]]",
    );
  });
});

const found = (over: Partial<RetrievedChunks>): RetrievedChunks => ({
  hits: [],
  nearMisses: [],
  floor: 0.42,
  indexedPages: 10,
  stale: false,
  retrievalFailed: false,
  ...over,
});

describe("answerBlock", () => {
  const answerText = (q: string, hits: ScoredChunk[]) =>
    answerBlock(q, hits)?.block ?? null;
  const scaling = hit("## Scaling\n\nMore data helps.\nA lot.", {
    similarity: 0.684,
  });
  const cache = hit("Mid-section text.", {
    page: "wiki/kv-cache.md",
    stem: "kv-cache",
    similarity: 0.52,
  });

  it("is one [!question] callout: the question, then each page's link, similarity and verbatim lines", () => {
    expect(answerText("Why scale?", [scaling, cache])).toBe(
      "> [!question] Why scale?\n" +
        "> **[[attention#Scaling]]** · 68%\n" +
        ">\n" +
        "> More data helps.\n" +
        "> A lot.\n" +
        ">\n" +
        "> **[[kv-cache]]** · 52%\n" +
        ">\n" +
        "> Mid-section text.",
    );
  });

  it("gives a lexical-only page (no cosine) no percentage", () => {
    expect(answerText("q", [hit("Plain.", { similarity: null })])).toBe(
      "> [!question] q\n> **[[attention]]**\n>\n> Plain.",
    );
  });

  it("groups a page's hits under one header, its best similarity; two sections link the page", () => {
    const later = hit("## Later\n\nTwo.", { similarity: 0.7 });
    expect(answerText("q", [scaling, later])).toBe(
      "> [!question] q\n> **[[attention]]** · 70%\n>\n> More data helps.\n> A lot.\n>\n> Two.",
    );
    const again = hit("## Scaling\n\nMore.", { similarity: 0.7 });
    expect(answerText("q", [scaling, again])).toContain(
      "> **[[attention#Scaling]]** · 70%\n",
    );
  });

  it("gives the best similarity of the pages it quotes, not of every hit", () => {
    const at = (s: string, similarity: number | null, text = `${s} body.`) =>
      hit(text, { page: `wiki/${s}.md`, stem: s, similarity });
    // d is past the three-page cap; e has nothing quotable.
    const hits = [at("a", 0.51), at("b", 0.52), at("c", 0.5), at("d", 0.71)];
    expect(answerBlock("q", hits)?.best).toBe(0.52);
    const fm = at("e", 0.8, "---\na: 1\n---");
    expect(answerBlock("q", [fm, at("b", 0.51)])?.best).toBe(0.51);
    expect(answerBlock("q", [at("a", null)])?.best).toBeNull();
  });

  it("escapes a quoted line that starts with `>` or `#`, so the callout round-trips", () => {
    const tricky = hit("## H\n\n# Not a heading\n> not a quote\n  #tag line\nplain");
    const block = answerText("q", [tricky])!;
    expect(block).toBe(
      "> [!question] q\n> **[[attention#H]]** · 61%\n>\n> \\# Not a heading\n> \\> not a quote\n>   \\#tag line\n> plain",
    );
    const html = markdownRenderer.render(block);
    expect(html).toContain('data-callout="question"');
    expect(html).toContain("# Not a heading");
    expect(html).toContain("&gt; not a quote");
    expect(html).not.toMatch(/<h1|<blockquote/);
  });

  it("quotes code byte-exact: `#` and `>` are literal in a fence and in indented code", () => {
    const vault = [
      "```sh\n# install deps\nnpm i\n> not a prompt\n```",
      "~~~py\n# comment\n>>> prompt\n```\n~~~",
      "Text.",
      "    # indented code",
    ].join("\n\n");
    const block = answerText("How?", [hit("## Install\n\n" + vault)])!;
    expect(block).toContain("\n> # install deps\n> npm i\n> > not a prompt\n");
    const code = [
      ...markdownRenderer.render(block).matchAll(/<code[^>]*>([^<]*)<\/code>/g),
    ].map((m) => m[1].replace(/&gt;/g, ">"));
    expect(code).toEqual([
      "# install deps\nnpm i\n> not a prompt\n",
      "# comment\n>>> prompt\n```\n",
      "# indented code\n",
    ]);
  });

  it("closes every fence inside its page, so the next page's link stays a link", () => {
    const b = hit("Other page text.", {
      page: "wiki/b.md",
      stem: "b",
      similarity: 0.55,
    });
    const long = "```sh\nnpm i\n```\n" + "Long paragraph ".repeat(40);
    // The index splits a page at every `#` line, a fence's comments too:
    // a chunk can end inside a fence it opened.
    for (const a of [long, "Intro.\n\n```sh"]) {
      const html = markdownRenderer.render(
        answerText("q", [hit("## Install\n\n" + a), b])!,
      );
      const prose = html.replace(/<pre>[\s\S]*?<\/pre>/g, "");
      expect(prose, a).toContain('<a data-link="b"');
      expect(prose, a).toContain("Other page text.");
    }
  });

  it("sets the quote apart from its link line, so a table or `---` opens a block", () => {
    const table = answerText("Compare?", [
      hit("## Comparison\n\n| a | b |\n|---|---|\n| 1 | 2 |"),
    ])!;
    expect(markdownRenderer.render(table)).toContain("<table>");
    const s = EditorState.create({ doc: table, extensions: [mycoMarkdown()] });
    const names: string[] = [];
    ensureSyntaxTree(s, s.doc.length, 5000)!.iterate({
      enter: (n) => void names.push(n.name),
    });
    expect(names).toContain("Table"); // what Live draws a table from
    // A stock CommonMark reader (GitHub, Obsidian's export) reads `---`
    // under a text line as a setext heading of the whole paragraph.
    const rule = answerText("Why?", [hit("## Setup\n\n---\n\nStep one.")])!;
    const html = new MarkdownIt().render(rule);
    expect(html).toContain("<hr>");
    expect(html).not.toContain("<h2>");
  });

  it("quotes at most three pages, at most 400 characters each", () => {
    const long = hit("## H\n\n" + "word ".repeat(200).trim());
    const pages = ["a", "b", "c", "d"].map((s) =>
      hit(`Text of ${s}.`, { page: `wiki/${s}.md`, stem: s }),
    );
    const block = answerText("q", [long, ...pages])!;
    expect(block.match(/\*\*\[\[/g)).toHaveLength(3);
    expect(block).not.toContain("[[c]]");
    const quoted = block.split("\n")[3];
    expect(quoted.length).toBeLessThanOrEqual("> ".length + 400 + "…".length);
    expect(quoted.endsWith("…")).toBe(true);
    expect(block).toContain("\n> Text of b.");
  });

  it("drops footnotes and is null with nothing quotable", () => {
    const fn = hit("# A\n\nCore[^src-a].\n\n[^src-a]: [[source-a]]\n");
    expect(answerText("q", [fn])).toBe(
      "> [!question] q\n> **[[attention#A]]** · 61%\n>\n> Core.",
    );
    expect(answerText("q", [hit("---\na: 1\n---")])).toBeNull();
    expect(answerText("q", [])).toBeNull();
  });

  it("inserts as one block after the text, one undo takes it all back", () => {
    let state = st("Above│\n\nBelow");
    state = insertBlockTr(state, 5, answerText("q", [cache])!).state;
    expect(state.doc.toString()).toBe(
      "Above\n\n> [!question] q\n> **[[kv-cache]]** · 52%\n>\n> Mid-section text.\n\nBelow",
    );
    const view = {
      get state() {
        return state;
      },
      dispatch: (t: Transaction) => {
        state = t.state;
      },
    };
    undo(view);
    expect(state.doc.toString()).toBe("Above\n\nBelow");
  });
});

describe("askSearch", () => {
  const now = new Date(2026, 8, 25);

  it("searches the cleaned question in its time window; the callout keeps the question as typed", async () => {
    const calls: unknown[][] = [];
    const v = await askSearch("지난주 회의", "sessions", now, "ko", (...a) => {
      calls.push(a);
      return Promise.resolve(
        found({ hits: [hit("## 회의\n\n결정했다.", { similarity: 0.66 })] }),
      );
    });
    expect(calls[0].slice(0, 2)).toEqual(["회의", 12]);
    expect(calls[0][3]).toEqual({ start: "2026-09-14", end: "2026-09-20" });
    expect(calls[0][4]).toBe("sessions");
    expect(v).toEqual({
      kind: "answer",
      block: "> [!question] 지난주 회의\n> **[[attention#회의]]** · 66%\n>\n> 결정했다.",
      best: 0.66,
      range: { start: "2026-09-14", end: "2026-09-20" },
    });
  });

  it("bands the pages the answer quotes, not a page past the cap", async () => {
    const hits = ["a", "b", "c", "d"].map((s, i) =>
      hit(`${s} body.`, {
        page: `wiki/${s}.md`,
        stem: s,
        similarity: [0.51, 0.52, 0.5, 0.71][i],
      }),
    );
    const v = await askSearch("q", "all", now, "en", () =>
      Promise.resolve(found({ hits })),
    );
    expect(v).toMatchObject({ kind: "answer", best: 0.52 });
  });

  it("has no best similarity when every hit is lexical-only", async () => {
    const v = await askSearch("q", "all", now, "en", () =>
      Promise.resolve(found({ hits: [hit("Plain.", { similarity: null })] })),
    );
    expect(v).toMatchObject({ kind: "answer", best: null });
  });

  it("abstains with the closest below-floor hits, and on nothing quotable", async () => {
    const near = [{ page: "wiki/x.md", tier: "note" as const, score_final: 0.1, similarity: 0.3 }];
    const v = await askSearch("zzz", "all", now, "en", () =>
      Promise.resolve(found({ nearMisses: near })),
    );
    expect(v).toEqual({ kind: "none", near, floor: 0.42, range: null });
    const fm = await askSearch("q", "all", now, "en", () =>
      Promise.resolve(found({ hits: [hit("---\na: 1\n---")] })),
    );
    expect(fm).toMatchObject({ kind: "none" });
  });

  it("says why nothing could be searched", async () => {
    const run = (over: Partial<RetrievedChunks>) =>
      askSearch("q", "all", now, "en", () => Promise.resolve(found(over)));
    expect(await run({ stale: true })).toEqual({ kind: "stale" });
    expect(await run({ retrievalFailed: true })).toEqual({ kind: "failed" });
    expect(await run({ indexedPages: null })).toEqual({ kind: "no-index" });
    expect(await run({ indexedPages: 0 })).toEqual({ kind: "no-index" });
  });
});

describe("recallSearch", () => {
  const now = new Date(2026, 8, 25);

  it("searches the cleaned query in the time phrase's window and scope", async () => {
    const calls: unknown[][] = [];
    const v = await recallSearch("지난주 회의", "sessions", now, "ko", (...a) => {
      calls.push(a);
      return Promise.resolve(found({ hits: [hit("## 회의\n\n결정했다.")] }));
    });
    expect(calls[0][0]).toBe("회의");
    expect(calls[0][3]).toEqual({ start: "2026-09-14", end: "2026-09-20" });
    expect(calls[0][4]).toBe("sessions");
    expect(v).toMatchObject({
      kind: "hits",
      range: { start: "2026-09-14", end: "2026-09-20" },
      rows: [{ target: "attention#회의", excerpt: "결정했다." }],
    });
  });

  it("abstains with the closest below-floor hits", async () => {
    const near = [{ page: "wiki/x.md", tier: "note" as const, score_final: 0.1, similarity: 0.3 }];
    const v = await recallSearch("zzz", "all", now, "en", () =>
      Promise.resolve(found({ nearMisses: near })),
    );
    expect(v).toEqual({ kind: "none", near, floor: 0.42, range: null });
  });

  it("drops a hit with nothing quotable", async () => {
    const v = await recallSearch("q", "all", now, "en", () =>
      Promise.resolve(found({ hits: [hit("---\na: 1\n---")] })),
    );
    expect(v).toMatchObject({ kind: "none" });
  });

  it("says why nothing could be searched", async () => {
    const run = (over: Partial<RetrievedChunks>) =>
      recallSearch("q", "all", now, "en", () => Promise.resolve(found(over)));
    expect(await run({ stale: true })).toEqual({ kind: "stale" });
    expect(await run({ retrievalFailed: true })).toEqual({ kind: "failed" });
    // retrieveChunks reports an empty index as null pages, not 0.
    expect(await run({ indexedPages: null })).toEqual({ kind: "no-index" });
    expect(await run({ indexedPages: 0 })).toEqual({ kind: "no-index" });
  });
});
