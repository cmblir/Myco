import { describe, expect, it } from "vitest";
import { EditorState, Text, type Transaction } from "@codemirror/state";
import type { DecorationSet, EditorView, ViewUpdate } from "@codemirror/view";
import {
  LiveDecorations,
  externalHrefAt,
  footnoteDefAt,
  footnoteDefs,
  liveSpecs,
  plainClickLink,
  plainPress,
  tapLink,
  wikilinkAtCursor,
  type LiveOptions,
  type LiveSpec,
} from "./editorLive";
import { composeEnded } from "./blocks/calloutLive";
import { mycoMarkdown } from "./editorBlocks";
import { markdownRenderer } from "./markdown";

// The editor's own parser: GFM with setext headings off.
const { parser } = mycoMarkdown().language;

function specs(
  src: string,
  carets: number[] = [],
  from?: number,
  to?: number,
): LiveSpec[] {
  const doc = Text.of(src.split("\n"));
  return liveSpecs(parser.parse(src), doc, carets, from, to);
}

/** The note's first content line: line 1 or the first after frontmatter. */
const FIRST: LiveSpec = { kind: "line", from: 0, cls: "live-first" };

function hidden(src: string, s: LiveSpec[]): string[] {
  return s.filter((x) => x.kind === "hide").map((x) => src.slice(x.from, x.to));
}

function kind<K extends LiveSpec["kind"]>(
  s: LiveSpec[],
  k: K,
): Extract<LiveSpec, { kind: K }>[] {
  return s.filter((x) => x.kind === k) as Extract<LiveSpec, { kind: K }>[];
}

describe("liveSpecs", () => {
  it("1. headings: ATX hides `# `; no setext; `#` alone is not a heading yet", () => {
    const atx = "# Title";
    const a = specs(atx);
    expect(kind(a, "line")).toEqual([
      { kind: "line", from: 0, cls: "live-h1" },
      FIRST,
    ]);
    expect(hidden(atx, a)).toEqual(["# "]);

    // Setext is off in the editor: the paragraph keeps its size.
    expect(kind(specs("T\nU\n==="), "line")).toEqual([FIRST]);
    // Notion converts on the trigger space; before it the marks stay raw.
    expect(specs("#")).toEqual([FIRST]);
    expect(specs("##")).toEqual([FIRST]);
  });

  it("1c. a closing `##` shows while the caret touches it", () => {
    // `###` typed into an empty `## ` parses as its closing mark: it must
    // not vanish while typed.
    expect(hidden("## ###", specs("## ###", [6]))).toEqual(["## "]);
    expect(hidden("## T ##", specs("## T ##"))).toEqual(["## ", "##"]);
  });

  it("1b. an empty heading gets a placeholder line", () => {
    expect(kind(specs("## "), "empty")).toEqual([
      { kind: "empty", from: 0, level: 2 },
    ]);
    expect(kind(specs("## T"), "empty")).toEqual([]);
  });

  it("2. inline marks: strong/em/code/strike hidden, spans classed", () => {
    const src = "**b** *e* `c` ~~s~~";
    const s = specs(src);
    expect(hidden(src, s)).toEqual([
      "**",
      "**",
      "*",
      "*",
      "`",
      "`",
      "~~",
      "~~",
    ]);
    expect(kind(s, "mark")).toEqual([
      { kind: "mark", from: 0, to: 5, cls: "live-strong" },
      { kind: "mark", from: 6, to: 9, cls: "live-em" },
      { kind: "mark", from: 10, to: 13, cls: "live-code-inline" },
      { kind: "mark", from: 14, to: 19, cls: "live-strike" },
    ]);
  });

  it('3. markdown link: `[` and `](url "title")` hidden as two ranges', () => {
    const src = '[link](http://x.y "t")';
    const s = specs(src);
    expect(kind(s, "mark")).toEqual([
      { kind: "mark", from: 0, to: 22, cls: "live-link" },
    ]);
    expect(hidden(src, s)).toEqual(["[", '](http://x.y "t")']);
  });

  it("3b. a link's text draws its math, bold and code as Preview does", () => {
    const math = "c5 [$x$](https://e.com) 끝";
    const m = specs(math, [math.length]);
    expect(kind(m, "math")).toEqual([
      { kind: "math", from: 4, to: 7, tex: "x" },
    ]);
    expect(markdownRenderer.render(math)).toContain('data-tex="x"');
    // The caret on the link shows it all as source.
    expect(kind(specs(math, [5]), "math")).toEqual([]);
    const bold = "[**b** `c`](https://e.com)";
    const b = specs(bold);
    expect(kind(b, "mark").map((x) => x.cls)).toEqual([
      "live-link",
      "live-strong",
      "live-code-inline",
    ]);
    expect(hidden(bold, b)).toEqual([
      "[",
      "](https://e.com)",
      "**",
      "**",
      "`",
      "`",
    ]);
    expect(markdownRenderer.render(bold)).toContain(
      "<strong>b</strong> <code>c</code></a>",
    );
  });

  it("4. wikilinks: brackets and `target|` hidden; bare/broken stay raw", () => {
    const alias = "[[Wiki Page|alias]]";
    const a = specs(alias);
    expect(kind(a, "mark")).toEqual([
      { kind: "mark", from: 0, to: 19, cls: "live-wikilink" },
    ]);
    expect(hidden(alias, a)).toEqual(["[[", "Wiki Page|", "]]"]);

    const plain = "[[Plain]]";
    expect(hidden(plain, specs(plain))).toEqual(["[[", "]]"]);
    expect(specs("[bare]")).toEqual([FIRST]);
    expect(specs("[[a]b]]")).toEqual([FIRST]);
  });

  it("5. lists: bullet glyph over `- `, one checkbox for a to-do, ordered numbers boxed", () => {
    expect(specs("- item")).toEqual([
      { kind: "bullet", from: 0, to: 2 },
      FIRST,
    ]);
    expect(specs("- ")).toEqual([{ kind: "bullet", from: 0, to: 2 }, FIRST]);
    expect(specs("-")).toEqual([FIRST]);
    const todo = "- [ ] t";
    const s = specs(todo);
    expect(kind(s, "task")).toEqual([
      { kind: "task", from: 2, to: 6, checked: false },
    ]);
    // The to-do's `- ` is hidden, not drawn as a second glyph.
    expect(kind(s, "bullet")).toEqual([]);
    expect(hidden(todo, s)).toEqual(["- "]);
    expect(kind(specs("- [X] d"), "task")).toEqual([
      { kind: "task", from: 2, to: 6, checked: true },
    ]);
    // The number stays text (Live shows it), right-aligned in a box.
    expect(specs("1. one")).toEqual([
      { kind: "mark", from: 0, to: 2, cls: "live-num" },
      FIRST,
    ]);
    expect(specs("1) one")).toEqual([
      { kind: "mark", from: 0, to: 2, cls: "live-num" },
      FIRST,
    ]);
  });

  it("5b. a nested item's indent is drawn by level, 1.5em each", () => {
    const src = "- a\n  - b\n    1. c\n\n  para";
    const s = specs(src);
    expect(kind(s, "indent")).toEqual([
      { kind: "indent", from: 4, to: 6, level: 1 },
      { kind: "indent", from: 10, to: 14, level: 2 },
    ]);
    // A continuation paragraph's indent is not an item's: left as is.
    expect(kind(s, "indent").some((i) => i.from === 22)).toBe(false);
    // In a quote the indent sits after the quote mark; a tab is one level.
    expect(kind(specs("> - a\n>   - b"), "indent")).toEqual([
      { kind: "indent", from: 7, to: 10, level: 1 },
    ]);
    expect(kind(specs("- a\n\t- b"), "indent")).toEqual([
      { kind: "indent", from: 4, to: 5, level: 1 },
    ]);
    // A top-level item has no indent to draw.
    expect(kind(specs("- a\n- b"), "indent")).toEqual([]);
  });

  it("6. blockquote: every line classed, `> ` hidden per line", () => {
    const src = "> q\n> m";
    const s = specs(src);
    expect(kind(s, "line")).toEqual([
      { kind: "line", from: 0, cls: "live-quote" },
      { kind: "line", from: 4, cls: "live-quote" },
      FIRST,
    ]);
    expect(hidden(src, s)).toEqual(["> ", "> "]);
  });

  it("7. a caret reveals only the inline node it is in; block marks stay hidden", () => {
    const src = "# A\n**b** c\n- [ ] t";
    // Caret inside **b** (4..9): its marks show, the rest of the doc stays drawn.
    const s = specs(src, [6]);
    expect(kind(s, "hide").some((h) => h.from >= 4 && h.from <= 9)).toBe(false);
    expect(hidden(src, s)).toEqual(["# ", "- "]);
    expect(kind(s, "task")).toHaveLength(1);
    expect(kind(s, "mark")).toEqual([
      { kind: "mark", from: 4, to: 9, cls: "live-strong" },
    ]);
    // Caret elsewhere on that line: **b** stays drawn.
    expect(hidden(src, specs(src, [11]))).toEqual(["# ", "**", "**", "- "]);
    // Caret on the heading or the to-do line: their marks stay hidden (Notion).
    expect(hidden(src, specs(src, [3]))).toContain("# ");
    expect(kind(specs(src, [18]), "task")).toHaveLength(1);
  });

  it("7b. block marks carry the block flag (atomic); inline ones do not", () => {
    const s = specs("# A **b**");
    expect(kind(s, "hide").map((h) => !!h.block)).toEqual([true, false, false]);
  });

  it("7c. a divider is drawn as a rule", () => {
    expect(kind(specs("a\n\n---"), "hr")).toEqual([
      { kind: "hr", from: 3, to: 6 },
    ]);
  });

  it("7d. ⌘B's fresh `**│**` pair is text to type into, not a divider", () => {
    // `****` parses as a rule; a caret strictly inside it is the empty pair.
    expect(kind(specs("****", [2]), "hr")).toEqual([]);
    expect(kind(specs("- ****", [4]), "hr")).toEqual([]);
    // A caret at a rule's edge (arrows and clicks land there) keeps it drawn.
    expect(kind(specs("---", [0]), "hr")).toHaveLength(1);
    expect(kind(specs("---", [3]), "hr")).toHaveLength(1);
  });

  it("8. frontmatter: nothing decorated inside the leading block", () => {
    const src = "---\ntitle: x\ntags: [a]\n---\n# H";
    const fmEnd = 27;
    const s = specs(src);
    expect(s.length).toBeGreaterThan(0);
    expect(s.every((x) => x.from >= fmEnd)).toBe(true);
  });

  it("9. fenced code: its text stays raw, its lines make one card; images untouched", () => {
    const src = "```\n**no**\n```";
    const s = specs(src);
    // Only the fences hide (no caret on them); `**no**` is code, not bold.
    expect(hidden(src, s)).toEqual(["```", "```"]);
    expect(kind(s, "mark")).toEqual([]);
    expect(kind(s, "line")).toEqual([
      { kind: "line", from: 0, cls: "live-code" },
      { kind: "line", from: 4, cls: "live-code" },
      { kind: "line", from: 11, cls: "live-code" },
      { kind: "line", from: 0, cls: "live-code-first" },
      { kind: "line", from: 11, cls: "live-code-last" },
      { kind: "line", from: 11, cls: "live-fence-end" },
      FIRST,
    ]);
    expect(specs("![img](a.png)")).toEqual([FIRST]);
  });

  it("9b. a fence's info string is a chip; a caret on a fence line shows it raw", () => {
    const src = "```js\ncode\n```";
    const s = specs(src);
    expect(hidden(src, s)).toEqual(["```", "```"]);
    expect(kind(s, "mark")).toEqual([
      { kind: "mark", from: 3, to: 5, cls: "live-lang" },
    ]);
    // Blanks between the backticks and the word hide with the backticks.
    const spaced = "``` js title \ncode\n```";
    expect(hidden(spaced, specs(spaced))).toEqual(["``` ", "```"]);
    expect(kind(specs(spaced), "mark")).toEqual([
      { kind: "mark", from: 4, to: 12, cls: "live-lang" },
    ]);
    // Caret on the opening fence: it is source; the closing fence still hides.
    const open = specs(src, [5]);
    expect(hidden(src, open)).toEqual(["```"]);
    expect(kind(open, "mark")).toEqual([]);
    expect(kind(open, "line").map((l) => l.cls)).toContain("live-fence-end");
    // Caret on the closing fence: no short end line, the backticks show.
    const close = specs(src, [14]);
    expect(hidden(src, close)).toEqual(["```"]);
    expect(kind(close, "mark")).toHaveLength(1);
    expect(kind(close, "line").map((l) => l.cls)).not.toContain(
      "live-fence-end",
    );
    // Caret inside the code: both fences hide.
    expect(hidden(src, specs(src, [8]))).toEqual(["```", "```"]);
    // In a quote or callout the closing line's `> ` hides with its
    // backticks, or it hangs below the card (the review's report).
    const quoted = "> ```js\n> code\n> ```";
    expect(hidden(quoted, specs(quoted))).toEqual(["> ", "```", "> ```"]);
    const callout = "> [!note] Title\n> ```js\n> code\n> ```";
    expect(hidden(callout, specs(callout)).at(-1)).toBe("> ```");
    // An unclosed fence stays source, so the missing fence is seen.
    const unclosed = "```js\ncode";
    expect(hidden(unclosed, specs(unclosed))).toEqual([]);
    expect(kind(specs(unclosed), "mark")).toEqual([]);
  });

  it("9c. a widget's fence (```toc) is walked as any closed fence", () => {
    // Its lines are never seen, whatever the caret: blocks/live draws the
    // block over them (2026-10-01, decision 2), so no caret reveals them.
    const src = "```toc\n```";
    for (const carets of [[], [3], [10]])
      expect(specs(src, carets)).toEqual(specs("```abc\n```", carets));
  });

  it("10. range window limits the walk", () => {
    const src = "**b**\n".repeat(10);
    const s = specs(src, [], 0, 40);
    expect(s.length).toBeGreaterThan(0);
    expect(s.every((x) => x.from < 40)).toBe(true);
    // The first content line is classed only inside the window.
    expect(kind(specs("a\n\nb", [], 2, 3), "line")).toEqual([
      { kind: "line", from: 2, cls: "live-gap" },
    ]);
  });
});

describe("liveSpecs: Notion-look lines (stage 2.5b)", () => {
  const lines = (
    src: string,
    carets: number[] = [],
    from?: number,
    to?: number,
  ) => kind(specs(src, carets, from, to), "line").map((l) => [l.from, l.cls]);

  it("18. a blank line is a gap, except the caret's, code's and frontmatter's", () => {
    expect(lines("a\n\nb")).toEqual([
      [0, "live-first"],
      [2, "live-gap"],
    ]);
    // Every blank line, whitespace-only too; the caret's keeps full height.
    expect(lines("a\n\n  \nb")).toEqual([
      [0, "live-first"],
      [2, "live-gap"],
      [3, "live-gap"],
    ]);
    expect(lines("a\n\nb", [2])).toEqual([[0, "live-first"]]);
    // A blank line inside a fence or an indented code block is code.
    expect(lines("```\n\nx\n```").filter((l) => l[1] === "live-gap")).toEqual(
      [],
    );
    expect(lines("    a\n\n    b").filter((l) => l[1] === "live-gap")).toEqual(
      [],
    );
    // Nothing inside the frontmatter; the blank line under it is a gap.
    expect(lines("---\na: 1\n---\n\n# H")).toEqual([
      [14, "live-h1"],
      [14, "live-first"],
      [13, "live-gap"],
    ]);
    // A loose list's blank line is a gap like any other.
    expect(lines("- a\n\n- b")).toEqual([
      [0, "live-first"],
      [4, "live-gap"],
    ]);
  });

  it("19. the first content line: line 1, or the first with text after frontmatter", () => {
    expect(lines("\n\n# T")).toEqual([
      [2, "live-h1"],
      [2, "live-first"],
      [0, "live-gap"],
      [1, "live-gap"],
    ]);
    // An empty note has no content line; its one line is a gap.
    expect(lines("")).toEqual([[0, "live-gap"]]);
    expect(lines("\n\n")).toEqual([
      [0, "live-gap"],
      [1, "live-gap"],
      [2, "live-gap"],
    ]);
  });

  it("20. the caret's empty line gets the block placeholder", () => {
    expect(kind(specs("a\n\nb", [2]), "empty")).toEqual([
      { kind: "empty", from: 2, level: 0 },
    ]);
    expect(kind(specs("", [0]), "empty")).toEqual([
      { kind: "empty", from: 0, level: 0 },
    ]);
    // Not on a line with text (a bare `- `, blanks), in code, or without a caret.
    expect(kind(specs("- ", [2]), "empty")).toEqual([]);
    expect(kind(specs("  ", [2]), "empty")).toEqual([]);
    expect(kind(specs("```\n\n```", [4]), "empty")).toEqual([]);
    expect(kind(specs("a\n\nb"), "empty")).toEqual([]);
    // The heading placeholder is unchanged.
    expect(kind(specs("## ", [3]), "empty")).toEqual([
      { kind: "empty", from: 0, level: 2 },
    ]);
  });

  it("21. a bare `>` between two passages of a quote is a gap in its box", () => {
    // `/ask`'s answer: passages apart by a bare `>` inside the callout.
    const src = "> [!note] T\n> a\n>\n> b";
    expect(lines(src)).toContainEqual([16, "live-gap"]);
    expect(hidden(src, specs(src))).toEqual(["> ", "> ", "> ", ">"]);
    // A caret on it: the `>` shows, full height.
    const on = specs(src, [17]);
    expect(kind(on, "line").some((l) => l.cls === "live-gap")).toBe(false);
    expect(hidden(src, on)).toEqual(["> ", "> ", "> "]);
    // `> ` with its space hides once; nested marks hide together.
    expect(hidden("> a\n> \n> b", specs("> a\n> \n> b"))).toEqual([
      "> ",
      "> ",
      "> ",
    ]);
    const nested = "> > a\n> >\n> > b";
    expect(lines(nested).filter((l) => l[1] === "live-gap")).toEqual([
      [6, "live-gap"],
    ]);
    expect(hidden(nested, specs(nested))).toContain("> >");
    // A quote's first or last line is not between passages (a `>` being
    // typed), and a blank code line in a quote is code.
    const gaps = (s: string) => lines(s).filter((l) => l[1] === "live-gap");
    expect(gaps(">")).toEqual([]);
    expect(gaps("> a\n>")).toEqual([]);
    expect(gaps("> ```\n>\n> ```")).toEqual([]);
  });
});

describe("liveSpecs: footnotes and comments", () => {
  it("12. `[^id]` references get a chip, text kept; adjacent ones both", () => {
    const src = "see [^a] and [^a][^b].\n\n[^a]: A\n[^b]: B";
    const s = specs(src);
    expect(kind(s, "mark")).toEqual([
      { kind: "mark", from: 4, to: 8, cls: "live-fnref" },
      { kind: "mark", from: 13, to: 17, cls: "live-fnref" },
      { kind: "mark", from: 17, to: 21, cls: "live-fnref" },
    ]);
    expect(kind(s, "hide")).toEqual([]);
    // A bare `[text]` and a link label are no footnote.
    expect(specs("[bare] [x][y]")).toEqual([FIRST]);
  });

  it("12b. only a defined label is a reference, wherever its definition is", () => {
    const chips = (src: string, from?: number, to?: number) =>
      kind(specs(src, [], from, to), "mark").filter(
        (m) => m.cls === "live-fnref",
      ).length;
    expect(chips("x[^nope] y")).toBe(0);
    expect(chips("x[^a] [^nope]\n\n[^a]: A")).toBe(1);
    // Labels match exactly; a definition in code defines nothing.
    expect(chips("x[^A]\n\n[^a]: A")).toBe(0);
    expect(chips("x[^a]\n\n```\n[^a]: A\n```")).toBe(0);
    // The definition far below the drawn window still counts.
    const long = "x[^a] y\n\n" + "filler\n\n".repeat(50) + "[^a]: A";
    expect(chips(long, 0, 10)).toBe(1);
  });

  it("13. definition lines are muted; their label is no chip", () => {
    const src = "para\n[^a]: from [[x]]\n[^b]: y";
    const s = specs(src);
    expect(kind(s, "line")).toEqual([
      FIRST,
      { kind: "line", from: 5, cls: "live-fndef" },
      { kind: "line", from: 22, cls: "live-fndef" },
    ]);
    const marks = kind(s, "mark").map((m) => m.cls);
    expect(marks).toEqual(["live-wikilink"]);
  });

  it("14. HTML comments are dimmed, inline and block", () => {
    expect(kind(specs("a <!-- c --> b"), "mark")).toEqual([
      { kind: "mark", from: 2, to: 12, cls: "live-comment" },
    ]);
    expect(kind(specs("<!-- c\nd -->\n\ntext"), "line")).toEqual([
      { kind: "line", from: 0, cls: "live-comment" },
      { kind: "line", from: 7, cls: "live-comment" },
      FIRST,
      { kind: "line", from: 13, cls: "live-gap" },
    ]);
  });
});

// Live and Preview must read the same syntax the same way (spec invariant).
describe("Live ↔ Preview parity", () => {
  const count = (re: RegExp, html: string): number =>
    (html.match(re) ?? []).length;

  it("15. to-dos: one Live checkbox per Preview checkbox", () => {
    for (const src of [
      "- [ ] a\n- [x] b",
      "- [ ] ",
      "- [x]",
      "1. [X] one",
      "> - [ ] q",
      "- [ ]x\n[ ] no list",
      "- a\n\n  - [x] nested",
    ])
      expect(kind(specs(src), "task").length, src).toBe(
        count(/type="checkbox"/g, markdownRenderer.render(src)),
      );
  });

  it("16. footnotes: one Live chip per Preview reference", () => {
    for (const src of [
      "x[^a]\n\n[^a]: A",
      "x[^a][^b] y[^a]\n\n[^a]: A\n[^b]: B",
      "para\n[^a]: def [^a]",
      "x[^nope] y",
      "x[^a] [^nope]\n\n[^a]: A",
      "x[^A]\n\n[^a]: A",
      "x[^a]\n\n```\n[^a]: A\n```",
    ])
      expect(
        kind(specs(src), "mark").filter((m) => m.cls === "live-fnref").length,
        src,
      ).toBe(count(/class="footnote-ref"/g, markdownRenderer.render(src)));
  });

  it("16b. a definition's continuation lines: muted in Live, in the footnote in Preview", () => {
    const lastLine = (src: string) => {
      const doc = Text.of(src.split("\n"));
      const from = doc.line(doc.lines).from;
      const cls = kind(specs(src), "line")
        .filter((l) => l.from === from)
        .map((l) => l.cls);
      const html = markdownRenderer.render(src);
      const notes = html.slice(html.indexOf('<section class="footnotes'));
      const text = doc.line(doc.lines).text.trim();
      return {
        cls,
        inNote: html.includes("footnotes") && notes.includes(text),
      };
    };
    for (const src of [
      // Indented line right under a definition Lezer reads as a link reference.
      "Claim[^src-a].\n\n[^src-a]: [[source-a]]\n    p. 12, second paragraph",
      // A second paragraph, indented after a blank line.
      "Claim[^a].\n\n[^a]: first\n\n    second para",
      // A lazy line under a link-reference-shaped definition.
      "Claim[^a].\n\n[^a]: [[s]]\nlazy line",
    ])
      expect(lastLine(src), src).toEqual({ cls: ["live-fndef"], inNote: true });
    for (const src of [
      "Claim[^a].\n\n[^a]: first\n\nnext para",
      "Claim[^a].\n\n[^a]: first\n# Heading",
    ])
      expect(
        lastLine(src).inNote || lastLine(src).cls.includes("live-fndef"),
        src,
      ).toBe(false);
  });

  it("18. highlights: one Live span per Preview <mark>", () => {
    for (const src of [
      "==a==",
      "x ==a b== y",
      "==a== and ==b==",
      "==a",
      "a == b == c",
      "`==a==`",
      "**==a==**",
      "==**a**==",
      "- [ ] ==todo==",
    ])
      expect(
        kind(specs(src), "mark").filter((m) => m.cls === "live-highlight")
          .length,
        src,
      ).toBe(count(/<mark>/g, markdownRenderer.render(src)));
  });

  it("18b. a highlight's `==` hide off the caret and show on it", () => {
    const src = "x ==a== y";
    expect(hidden(src, specs(src))).toEqual(["==", "=="]);
    expect(hidden(src, specs(src, [4]))).toEqual([]);
  });

  it("17. comments: dimmed in Live, gone from Preview", () => {
    for (const src of ["a <!-- c --> b", "<!-- c\nd -->", "> <!-- q -->"]) {
      const s = specs(src);
      expect(
        s.some((x) => "cls" in x && x.cls === "live-comment"),
        src,
      ).toBe(true);
      expect(markdownRenderer.render(src), src).not.toMatch(/<!--|&lt;!--/);
    }
  });

  it("17b. a comment in a list item runs on over its blank line in both", () => {
    // Lezer reads `<!-- c\n\n  d -->` as one CommentBlock; Preview stopped at
    // the blank line and showed `d -->`.
    const src = "- a\n  <!-- c\n\n  d -->\n  b";
    const dim = kind(specs(src), "line").filter(
      (l) => l.cls === "live-comment",
    );
    expect(dim.map((l) => l.from)).toEqual([4, 13, 14]);
    // Nothing of the comment (`c`, `d -->`) shows; `a` and `b` stay.
    const html = markdownRenderer.render(src);
    expect(html).not.toMatch(/c|d|--&gt;/);
    expect(html).toMatch(/a[\s\S]*b/);
  });
});

describe("LiveDecorations", () => {
  const OPTS: LiveOptions = {
    onLinkClick: () => undefined,
    onExternalLink: () => undefined,
    taskLabel: "",
    fmLabel: "",
    headingLabels: [],
    sourcesLabel: "",
    blockLabel: "",
  };
  // Stand-ins for the view and its updates (node env, no DOM).
  const viewOf = (state: EditorState, composing: boolean) =>
    ({
      state,
      composing,
      hasFocus: true,
      visibleRanges: [{ from: 0, to: state.doc.length }],
    }) as unknown as EditorView;
  const step = (
    plugin: LiveDecorations,
    tr: Transaction,
    composing: boolean,
  ): void =>
    plugin.update({
      view: viewOf(tr.state, composing),
      state: tr.state,
      startState: tr.startState,
      changes: tr.changes,
      transactions: [tr],
      docChanged: tr.docChanged,
      selectionSet: !!tr.selection,
      viewportChanged: false,
      focusChanged: false,
    } as unknown as ViewUpdate);
  const drawnMath = (d: DecorationSet, len: number): number => {
    let n = 0;
    d.between(0, len, (_f, _t, v) => {
      if (v.spec.widget?.constructor.name === "MathWidget") n++;
    });
    return n;
  };

  it("10. mid-composition nothing is swapped beside the composed text", () => {
    // The caret at the end of `$x^2$` shows its source; the first Korean
    // syllable after it moved the caret off and drew the formula next to
    // the composing text node, which still held `$x^2$`: both showed.
    const src = "# T\n\nabc $x^2$";
    let state = EditorState.create({
      doc: src,
      selection: { anchor: src.length },
      extensions: [mycoMarkdown()],
    });
    const plugin = new LiveDecorations(viewOf(state, false), OPTS);
    expect(drawnMath(plugin.decorations, src.length)).toBe(0);
    for (const ch of ["ㄱ", "가", "각"]) {
      const at = state.doc.length - (ch === "ㄱ" ? 0 : 1);
      const tr = state.update({
        changes: { from: at, to: state.doc.length, insert: ch },
        selection: { anchor: at + 1 },
        userEvent: "input.type.compose",
      });
      step(plugin, tr, true);
      state = tr.state;
      expect(drawnMath(plugin.decorations, state.doc.length), ch).toBe(0);
    }
    // The composition's end draws it.
    const end = state.update({ effects: composeEnded.of(null) });
    step(plugin, end, false);
    expect(drawnMath(plugin.decorations, state.doc.length)).toBe(1);
  });
});

describe("wikilinkAtCursor", () => {
  const line = "see [[Foo|bar]] and [[Baz]]";
  it("11. resolves the link whose span contains the column, inclusive", () => {
    expect(wikilinkAtCursor(line, 6)).toBe("Foo");
    expect(wikilinkAtCursor(line, 20)).toBe("Baz");
    expect(wikilinkAtCursor(line, 0)).toBeNull();
    expect(wikilinkAtCursor(line, 14)).toBe("Foo");
  });
  it("11b. between two adjacent links, the one starting there wins", () => {
    const l = "[[A]][[B]]";
    expect(wikilinkAtCursor(l, 5)).toBe("B");
    expect(wikilinkAtCursor(l, 10)).toBe("B");
  });
});

describe("externalHrefAt", () => {
  // What Preview opened in the OS browser (markdown.ts link_open): with one
  // editor left, Live's ⌘-click has to reach the same links.
  const src =
    "See [the docs](https://example.com/docs) and https://example.com/bare " +
    "here, <https://a.example/c>, [mail](mailto:x@example.com), " +
    "[note](notes/a.md) and plain text.";
  const doc = Text.of([src]);
  const tree = parser.parse(src);
  const at = (needle: string, d = 1) =>
    externalHrefAt(tree, doc, src.indexOf(needle) + d);
  it("12. resolves a markdown link, an autolink, a bare URL and mailto", () => {
    expect(at("the docs")).toBe("https://example.com/docs");
    expect(at("example.com/docs")).toBe("https://example.com/docs");
    expect(at("https://example.com/bare")).toBe("https://example.com/bare");
    // The bare URL's last character's right half: the caret past it.
    expect(at(" here", 0)).toBe("https://example.com/bare");
    expect(at("a.example")).toBe("https://a.example/c");
    expect(at("mail]")).toBe("mailto:x@example.com");
  });
  it("12b. a relative link and plain text are nothing to open outside", () => {
    expect(at("note]")).toBeNull();
    expect(at("plain")).toBeNull();
    expect(at("See", 0)).toBeNull();
  });
});

describe("footnoteDefAt", () => {
  const src = "Ref[^1] and [^nope].\n\n[^1]: The footnote.";
  const doc = Text.of(src.split("\n"));
  it("13. a reference resolves to its definition's line; others to null", () => {
    expect(footnoteDefAt(doc, src.indexOf("[^1]") + 1)).toBe(
      src.indexOf("[^1]:"),
    );
    expect(footnoteDefAt(doc, src.indexOf("[^nope]") + 2)).toBeNull();
    expect(footnoteDefAt(doc, src.indexOf("and"))).toBeNull();
  });
  it("13b. between two stacked references, the one starting there wins", () => {
    // posAtCoords puts a click on the left half of the second number at
    // its start, which is also where the first reference ends.
    const s = "Claim[^a][^b] end.\n\n[^a]: A\n[^b]: B";
    const d = Text.of(s.split("\n"));
    expect(footnoteDefAt(d, s.indexOf("[^b]"))).toBe(s.indexOf("[^b]:"));
    // The caret just past the last one still reads it.
    expect(footnoteDefAt(d, s.indexOf(" end"))).toBe(s.indexOf("[^b]:"));
  });
});

describe("plainClickLink (UX S55)", () => {
  // A plain click follows a link drawn as a link; with a caret in it the
  // source shows, and a click there places the caret to edit.
  const src =
    "See [[Foo|bar]] and [docs](https://example.com) or ref[^a].\n\n[^a]: A";
  const doc = Text.of(src.split("\n"));
  const tree = parser.parse(src);
  const at = (needle: string, carets: number[] = []) =>
    plainClickLink(tree, doc, src.indexOf(needle) + 1, carets);
  it("17. follows a wikilink, a web link and a reference with no caret in them", () => {
    expect(at("Foo")).toMatchObject({ kind: "wiki", target: "Foo" });
    expect(at("docs")).toMatchObject({ kind: "web", href: "https://example.com" });
    expect(at("[^a].")).toMatchObject({ kind: "note", def: src.indexOf("[^a]:") });
    expect(at("See", [0])).toBeNull();
  });
  it("17b. a caret inside the link (its source shown) means edit, not follow", () => {
    const wl = src.indexOf("[[");
    expect(at("Foo", [wl])).toBeNull();
    expect(at("Foo", [src.indexOf("]] and") + 2])).toBeNull();
    expect(at("docs", [src.indexOf("example")])).toBeNull();
    expect(at("[^a].", [src.indexOf("[^a].") + 2])).toBeNull();
    // A caret elsewhere, or in another link, does not hold this one.
    expect(at("Foo", [src.indexOf("docs")])).toMatchObject({ target: "Foo" });
    expect(at("Foo", [src.length])).toMatchObject({ target: "Foo" });
  });
});

describe("tapLink (UX S46)", () => {
  // A finger has no modifier key: a tap on a link follows it, caret or not.
  const src = "See [[Foo|bar]] and [docs](https://example.com) or ref[^a].\n\n[^a]: A";
  const doc = Text.of(src.split("\n"));
  const tree = parser.parse(src);
  it("17d. a tap follows a link even with the caret in it (its source shown)", () => {
    const foo = src.indexOf("Foo");
    expect(tapLink(tree, doc, foo, false)).toMatchObject({ kind: "wiki", target: "Foo" });
    expect(tapLink(tree, doc, src.indexOf("docs") + 1, false)).toMatchObject({
      kind: "web",
      href: "https://example.com",
    });
  });
  it("17e. a tap just beside a link's source places the caret there", () => {
    expect(tapLink(tree, doc, src.indexOf("[["), false)).toBeNull();
    expect(tapLink(tree, doc, src.indexOf(" and"), false)).toBeNull();
    expect(tapLink(tree, doc, 1, false)).toBeNull();
    // On a drawn link the whole of it follows, edges included.
    expect(tapLink(tree, doc, src.indexOf("[["), true)).toMatchObject({ target: "Foo" });
  });
});

describe("plainPress (UX S55)", () => {
  const press = { shiftKey: false, altKey: false, detail: 1 };
  it("17c. only a single unmodified press may follow a link", () => {
    expect(plainPress(press)).toBe(true);
    // Shift extends the selection, Alt draws a rectangle, a double-click
    // selects a word: CodeMirror's own, on a link as anywhere else.
    expect(plainPress({ ...press, shiftKey: true })).toBe(false);
    expect(plainPress({ ...press, altKey: true })).toBe(false);
    expect(plainPress({ ...press, detail: 2 })).toBe(false);
  });
});

describe("footnotes as numbers (UX S31)", () => {
  const src =
    "A[^src-b] then[^src-a] again[^src-b].\n\n[^src-a]: [[source-a|Paper A]]\n[^src-b]: [[source-b]]\n[^c]: unused";
  it("18. references number in first-appearance order; one label, one number", () => {
    const s = kind(specs(src), "fnref");
    expect(s.map((x) => [src.slice(x.from, x.to), x.n])).toEqual([
      ["[^src-b]", 1],
      ["[^src-a]", 2],
      ["[^src-b]", 1],
    ]);
    // The source's name is the number's tooltip.
    expect(s[1].title).toBe("Paper A");
    expect(s[0].title).toBe("source-b");
    // A definition nothing cites numbers after the cited ones.
    const doc = Text.of(src.split("\n"));
    expect([...footnoteDefs(doc).order]).toEqual([
      ["src-b", 1],
      ["src-a", 2],
      ["c", 3],
    ]);
  });
  it("18b. a caret in a reference shows its source text", () => {
    const at = src.indexOf("[^src-a]") + 3;
    const s = kind(specs(src, [at]), "fnref");
    expect(s.map((x) => src.slice(x.from, x.to))).toEqual(["[^src-b]", "[^src-b]"]);
  });
  it("18c. definitions draw as a numbered sources list under one heading", () => {
    const s = specs(src);
    expect(kind(s, "fndef").map((x) => [src.slice(x.from, x.to), x.n])).toEqual([
      ["[^src-a]: ", 2],
      ["[^src-b]: ", 1],
      ["[^c]: ", 3],
    ]);
    expect(kind(s, "sources")).toEqual([
      { kind: "sources", from: src.indexOf("[^src-a]:") },
    ]);
    // A definition that is one wikilink draws it as a link.
    expect(hidden(src, s).filter((h) => h.includes("[") || h.includes("]") || h.includes("|"))).toEqual([
      "[[", "source-a|", "]]", "[[", "]]",
    ]);
    // The caret's definition line shows its label.
    const line = src.indexOf("[^src-b]:");
    expect(kind(specs(src, [line + 4]), "fndef").map((x) => x.n)).toEqual([2, 3]);
  });
  it("18d. clicking a number opens its source note, else the definition", () => {
    const doc = Text.of(src.split("\n"));
    const tree = parser.parse(src);
    expect(plainClickLink(tree, doc, 3, [])).toMatchObject({
      kind: "note",
      source: "source-b",
    });
    const plain = "x[^n]\n\n[^n]: just text";
    expect(
      plainClickLink(parser.parse(plain), Text.of(plain.split("\n")), 2, []),
    ).toMatchObject({ kind: "note", source: null, def: plain.indexOf("[^n]:") });
  });
});
