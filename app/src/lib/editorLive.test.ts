import { describe, expect, it } from "vitest";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { Text } from "@codemirror/state";
import { liveSpecs, wikilinkAtCursor, type LiveSpec } from "./editorLive";

function specs(
  src: string,
  active: number[] = [],
  from?: number,
  to?: number,
): LiveSpec[] {
  const doc = Text.of(src.split("\n"));
  return liveSpecs(
    markdownLanguage.parser.parse(src),
    doc,
    new Set(active),
    from,
    to,
  );
}

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
  it("1. headings: ATX hides `# `, setext hides the underline", () => {
    const atx = "# Title";
    const a = specs(atx);
    expect(kind(a, "line")).toEqual([
      { kind: "line", from: 0, cls: "live-h1" },
    ]);
    expect(hidden(atx, a)).toEqual(["# "]);

    // Setext: every line of the heading paragraph (and the underline) classed.
    const setext = "T\nU\n===";
    const s = specs(setext);
    expect(kind(s, "line")).toEqual([
      { kind: "line", from: 0, cls: "live-h1" },
      { kind: "line", from: 2, cls: "live-h1" },
      { kind: "line", from: 4, cls: "live-h1" },
    ]);
    expect(hidden(setext, s)).toEqual(["==="]);
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

  it("4. wikilinks: brackets and `target|` hidden; bare/broken stay raw", () => {
    const alias = "[[Wiki Page|alias]]";
    const a = specs(alias);
    expect(kind(a, "mark")).toEqual([
      { kind: "mark", from: 0, to: 19, cls: "live-wikilink" },
    ]);
    expect(hidden(alias, a)).toEqual(["[[", "Wiki Page|", "]]"]);

    const plain = "[[Plain]]";
    expect(hidden(plain, specs(plain))).toEqual(["[[", "]]"]);
    expect(specs("[bare]")).toEqual([]);
    expect(specs("[[a]b]]")).toEqual([]);
  });

  it("5. lists: bullet glyph, task checkbox, ordered untouched", () => {
    expect(specs("- item")).toEqual([{ kind: "bullet", from: 0, to: 1 }]);
    expect(kind(specs("- [ ] t"), "task")).toEqual([
      { kind: "task", from: 2, to: 5, checked: false },
    ]);
    expect(kind(specs("- [X] d"), "task")).toEqual([
      { kind: "task", from: 2, to: 5, checked: true },
    ]);
    expect(specs("1. one")).toEqual([]);
  });

  it("6. blockquote: every line classed, `> ` hidden per line", () => {
    const src = "> q\n> m";
    const s = specs(src);
    expect(kind(s, "line")).toEqual([
      { kind: "line", from: 0, cls: "live-quote" },
      { kind: "line", from: 4, cls: "live-quote" },
    ]);
    expect(hidden(src, s)).toEqual(["> ", "> "]);
  });

  it("7. active line reveals its marks; other lines stay rendered", () => {
    const src = "# A\n**b**\n- [ ] t";
    const s = specs(src, [2]);
    // Line 2 spans [4, 9]: nothing hidden there, heading + task elsewhere.
    expect(kind(s, "hide").some((h) => h.from >= 4 && h.from <= 9)).toBe(false);
    expect(hidden(src, s)).toEqual(["# "]);
    expect(kind(s, "task")).toHaveLength(1);
    expect(kind(s, "mark")).toEqual([
      { kind: "mark", from: 4, to: 9, cls: "live-strong" },
    ]);
    expect(kind(specs(src, [3]), "task")).toEqual([]);
  });

  it("8. frontmatter: nothing decorated inside the leading block", () => {
    const src = "---\ntitle: x\ntags: [a]\n---\n# H";
    const fmEnd = 27;
    const s = specs(src);
    expect(s.length).toBeGreaterThan(0);
    expect(s.every((x) => x.from >= fmEnd)).toBe(true);
  });

  it("9. fenced code stays raw but classed; images untouched", () => {
    const src = "```\n**no**\n```";
    const s = specs(src);
    expect(kind(s, "hide")).toEqual([]);
    expect(kind(s, "line")).toEqual([
      { kind: "line", from: 0, cls: "live-code" },
      { kind: "line", from: 4, cls: "live-code" },
      { kind: "line", from: 11, cls: "live-code" },
    ]);
    expect(specs("![img](a.png)")).toEqual([]);
  });

  it("10. range window limits the walk", () => {
    const src = "**b**\n".repeat(10);
    const s = specs(src, [], 0, 40);
    expect(s.length).toBeGreaterThan(0);
    expect(s.every((x) => x.from < 40)).toBe(true);
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
});
