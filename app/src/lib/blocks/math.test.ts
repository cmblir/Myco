import { beforeAll, describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import type Token from "markdown-it/lib/token.mjs";
import { MATH, inlineMathEnd, loadKatex, mathHtml } from "./math";
import { liveBlocks } from "./live";
import { cpuMs } from "../cpuMs";
import { mycoMarkdown } from "../editorBlocks";
import { liveSpecs } from "../editorLive";
import { markdownRenderer } from "../markdown";

const { parser } = mycoMarkdown().language;
const doc = (src: string) => Text.of(src.split("\n"));

/** The inline TeX each parser finds in `src`. */
function lezerInline(src: string): string[] {
  const out: string[] = [];
  parser.parse(src).iterate({
    enter(n) {
      if (n.name === "InlineMath") out.push(src.slice(n.from + 1, n.to - 1));
    },
  });
  return out;
}
function previewInline(src: string): string[] {
  const out: string[] = [];
  const walk = (tokens: Token[]) => {
    for (const t of tokens) {
      if (t.type === "math_inline") out.push(t.content);
      if (t.children) walk(t.children);
    }
  };
  walk(markdownRenderer.parse(src, {}));
  return out;
}

/** Each `$$` block's lines (0-based, end exclusive) and its TeX (null =
 *  not closed), as each parser reads it. */
function lezerDisplay(src: string): [number, number, string | null][] {
  const d = doc(src);
  const out: [number, number, string | null][] = [];
  parser.parse(src).iterate({
    enter(n) {
      if (n.name !== "BlockMath") return;
      const from = d.lineAt(n.from).number - 1;
      const to = d.lineAt(n.to).number;
      const drawn = liveBlocks(parser.parse(src), d).find(
        (b) => b.spec === MATH && d.lineAt(b.from).number - 1 === from,
      );
      out.push([from, to, drawn ? (drawn.parsed as string) : null]);
    },
  });
  return out;
}
function previewDisplay(src: string): [number, number, string | null][] {
  return markdownRenderer
    .parse(src, {})
    .filter((t) => t.type === "math_block")
    .map((t) => [t.map![0], t.map![1], MATH.fromToken!(t, "")]);
}

describe("inline $…$ (GitHub's rule)", () => {
  it.each([
    ["$x^2$ and $y$", ["x^2", "y"]],
    ["It costs $5 and $10 today.", []],
    ["US$5 or US$10", []],
    ["$ x $ and $x $", []],
    ["$a$b but not $a$1", ["a"]],
    ["\\$x$ is text, $\\$5$ is math", ["\\$5"]],
    ["see $$x$$ here", []],
    ["`$x$` is code", []],
    ["$a\nb$", []],
    ["**$x$** and [$y$](u)", ["x", "y"]],
    ["| $a$ | b |\n| - | - |\n| $c|d$ | e |", ["a"]],
    // A `$` in a wikilink is its text: Preview reads `[[…]]` first.
    ["see [[a$b]] and c$d end", []],
    ["[[a|x$y]] and c$d", []],
    ["![[a$b]] c$d", []],
    ["[[a]] $x$", ["x"]],
    ["\\[[a$b]] c$d", ["b]] c"]],
  ])("%j", (src, tex) => {
    expect(lezerInline(src)).toEqual(tex);
    expect(previewInline(src)).toEqual(tex);
  });

  it("finds the closer past a `\\$` and a digit-bound one", () => {
    expect(inlineMathEnd("$a\\$b$", 0)).toBe(5);
    expect(inlineMathEnd("$a$1 b$", 0)).toBe(6);
    expect(inlineMathEnd("$", 0)).toBe(-1);
  });

  it("a scan cut short by a narrower end never stands in for a full one", () => {
    const s = "$a $b c$d";
    // `$a` fails up to 5, then `$b` finds its closer past it.
    expect(inlineMathEnd(s, 0, 5)).toBe(-1);
    expect(inlineMathEnd(s, 3)).toBe(7);
    // A full scan that failed answers a narrower one at once, and rightly.
    const t = "$1 x $2 y $3 z";
    expect(inlineMathEnd(t, 0)).toBe(-1);
    expect(inlineMathEnd(t, 5, 9)).toBe(-1);
    expect(inlineMathEnd(t, 10)).toBe(-1);
  });

  it("stays linear in a line's `$` count (prices in a clipped article)", () => {
    const line = "about $12 million, ".repeat(4000);
    expect(previewInline(line)).toEqual([]);
    expect(cpuMs(() => previewInline(line))).toBeLessThan(200);
    expect(lezerInline(line)).toEqual([]);
    expect(cpuMs(() => lezerInline(line))).toBeLessThan(200);
  });
});

describe("display $$…$$", () => {
  it.each([
    ["$$\nx^2\n$$", [[0, 3, "x^2"]]],
    ["$$x^2$$", [[0, 1, "x^2"]]],
    // GitHub's own example: a `$$` line right under a paragraph.
    [
      "**Cauchy-Schwarz**\n$$\\left( a \\right)^2$$\nafter",
      [[1, 2, "\\left( a \\right)^2"]],
    ],
    // Lines a paragraph would read as markdown are TeX here.
    ["$$\na\n- b\n# c\n> d\n$$", [[0, 6, "a\n- b\n# c\n> d"]]],
    ["> $$\n> x\n> $$", [[0, 3, "x"]]],
    ["> [!note] Sum\n> $$\n> \\sum x\n> $$", [[1, 4, "\\sum x"]]],
    ["- item\n\n  $$\n  x\n  $$\n- next", [[2, 5, "x"]]],
    // Not closed: a blank line, the quote's end or the doc's end first.
    ["$$\nx\n\nrest", [[0, 2, null]]],
    ["> $$\n> x\nafter $$", [[0, 2, null]]],
    [
      "$$\na\n\nb\n$$",
      [
        [0, 2, null],
        [4, 5, null],
      ],
    ],
    ["- $$ a\n- b $$", [[0, 1, null]]],
    ["$$\n$$", [[0, 2, null]]],
  ])("%j: Lezer and markdown-it agree", (src, blocks) => {
    expect(lezerDisplay(src)).toEqual(blocks);
    expect(previewDisplay(src)).toEqual(blocks);
  });

  it("a block that is not closed reads as its text in Preview", () => {
    const out = markdownRenderer.render("$$\nx < y\n\nrest");
    expect(out).toBe("<p>$$\nx &lt; y</p>\n<p>rest</p>\n");
  });

  it("`$$` inside a paragraph line stays text", () => {
    expect(lezerDisplay("a $$\nb $$")).toEqual([]);
    expect(previewDisplay("a $$\nb $$")).toEqual([]);
  });
});

describe("before KaTeX loads", () => {
  it("both views hold the escaped source for the page to typeset", () => {
    expect(markdownRenderer.render("a $x<1$ b")).toBe(
      '<p>a <span class="md-math is-pending" data-tex="x&lt;1">$x&lt;1$</span> b</p>\n',
    );
    expect(markdownRenderer.render("$$\n<script>\n$$")).toBe(
      '<div class="md-math is-display is-pending" data-tex="&lt;script&gt;">&lt;script&gt;</div>\n',
    );
    expect(mathHtml("x", false)).toBe(
      '<span class="md-math is-pending" data-tex="x">$x$</span>',
    );
  });
});

describe("after KaTeX loads", () => {
  beforeAll(async () => {
    await loadKatex();
  });

  it("typesets inline and display math", () => {
    const inline = markdownRenderer.render("a $x^2$ b");
    expect(inline).toContain('<span class="md-math"><span class="katex">');
    expect(inline).toContain("<math");
    const display = markdownRenderer.render("$$\n\\frac{1}{2}\n$$");
    expect(display).toMatch(
      /^<div class="md-math is-display"><span class="katex-display">/,
    );
  });

  it("Live and Preview draw the same math from the same note", () => {
    const note = "# T\n\nSum $a_1$ here.\n\n$$\n\\sum_{k=1}^{n} k\n$$\n\nend";
    const html = markdownRenderer.render(note);
    const [block] = liveBlocks(parser.parse(note), doc(note));
    expect(block.spec).toBe(MATH);
    expect(html).toContain(
      MATH.renderStatic!(block.parsed as string, { headings: [] }),
    );
    for (const tex of lezerInline(note))
      expect(html).toContain(mathHtml(tex, false));
  });

  it("a bad formula shows its source, never throws", () => {
    expect(() => mathHtml("\\frac{", true)).not.toThrow();
    expect(mathHtml("\\frac{", true)).toContain("katex-error");
  });

  it("trust off: no link, class, id, style or image from vault TeX", () => {
    for (const tex of [
      "\\href{javascript:alert(1)}{x}",
      "\\url{javascript:alert(1)}",
      "\\includegraphics{x.png}",
      "\\htmlClass{evil}{x}",
      "\\htmlId{evil}{x}",
      "\\htmlStyle{color:red}{x}",
      "\\htmlData{onclick=alert(1)}{x}",
    ]) {
      const out = mathHtml(tex, false);
      // Attributes, not the TeX quoted as text in MathML's <annotation>.
      expect(out, tex).not.toMatch(
        /<a |href=|<img|class="evil"|id="evil"|style="color:red|\son\w+=|data-onclick/,
      );
    }
    expect(mathHtml("<script>alert(1)</script>", false)).not.toContain(
      "<script",
    );
  });
});

describe("Live inline math", () => {
  const specs = (src: string, caret: number) =>
    liveSpecs(parser.parse(src), doc(src), [caret]).filter(
      (s) =>
        s.kind === "math" || (s.kind === "mark" && s.cls === "live-math-src"),
    );

  it("draws the formula with the caret away, its source with the caret on it", () => {
    const src = "Area $\\pi r^2$ here";
    expect(specs(src, src.length)).toEqual([
      { kind: "math", from: 5, to: 14, tex: "\\pi r^2" },
    ]);
    expect(specs(src, 8)).toEqual([
      { kind: "mark", from: 5, to: 14, cls: "live-math-src" },
    ]);
    expect(specs(src, 14)).toEqual([
      { kind: "mark", from: 5, to: 14, cls: "live-math-src" },
    ]);
  });

  it("a `$` inside a wikilink leaves the link drawn", () => {
    const src = "[[a$b]] c$d";
    const all = liveSpecs(parser.parse(src), doc(src), [src.length]);
    expect(all).toContainEqual({
      kind: "mark",
      from: 0,
      to: 7,
      cls: "live-wikilink",
    });
    expect(all.filter((s) => s.kind === "math")).toEqual([]);
  });
});
