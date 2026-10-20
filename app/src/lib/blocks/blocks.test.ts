import { afterEach, describe, expect, it } from "vitest";
import {
  EditorSelection,
  EditorState,
  type SelectionRange,
  Compartment,
  Text,
  Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { EditorView, type WidgetType } from "@codemirror/view";
import { history, redo, undo } from "@codemirror/commands";
import type Token from "markdown-it/lib/token.mjs";
import {
  BLOCKS,
  fenceBlock,
  nodeBlock,
  rendererBlock,
  setPluginFences,
} from "./index";
import { CHART } from "./chart";
import { IMAGE } from "./image";
import { MERMAID } from "./mermaid";
import { QUERY } from "./query";
import { TABLE } from "./table";
import { TOC } from "./toc";
import {
  apartTr,
  blockKeyTr,
  blockWidgets,
  leaveTr,
  liveBlocks,
  openBlockEditor,
  reconfigureLive,
  snapToBlocks,
  stepInto,
  undoneSnap,
  widgetEdit,
  type BlockKey,
} from "./live";
import { composeEnded } from "./calloutLive";
import { mycoMarkdown } from "../editorBlocks";
import { markdownRenderer } from "../markdown";
import { STRINGS } from "../i18n";

// The editor's own parser: GFM with setext headings off.
const { parser } = mycoMarkdown().language;

const lezer = (src: string) =>
  liveBlocks(parser.parse(src), Text.of(src.split("\n")));

/** Every registry block markdown-it finds in `src`, as [id, parsed]. */
function preview(src: string): [string, unknown][] {
  const out: [string, unknown][] = [];
  const lines = src.split("\n");
  const walk = (tokens: Token[]) => {
    for (const t of tokens) {
      if (t.type === "fence") {
        // As the fence renderer decides: a closed fence its block parses.
        const b = fenceBlock(t.info);
        const parsed = b && t.meta?.closed ? b.parse(t.content) : null;
        if (b && parsed != null) out.push([b.id, parsed]);
      } else {
        const b = nodeBlock(t.type);
        if (b?.fromToken) out.push([b.id, b.fromToken(t, text(t))]);
        // A block token read from its own lines (a table).
        else if (b && t.map)
          out.push([b.id, b.parse(lines.slice(...t.map).join("\n"))]);
      }
      if (t.children) walk(t.children);
    }
  };
  walk(markdownRenderer.parse(src, {}));
  return out;
}
const text = (t: Token): string =>
  (t.children ?? []).map((c) => c.content).join("");

describe("block registry parity", () => {
  // The contract: whatever a template is in Live (Lezer) it is in Preview
  // (markdown-it) — same block, same parsed value.
  const samples = [
    ...BLOCKS.map((b) => b.template),
    "![[x.png|300]]",
    "![[shot.png|cap]]",
    "![[shot.png|cap|120x80]]",
    '![a|300x200](assets/x.png "t")',
    "![](./rel.png)",
  ];
  it.each(samples)("%j: Lezer and markdown-it agree", (src) => {
    const live = lezer(src).map((b) => [b.spec.id, b.parsed]);
    expect(live).toHaveLength(1);
    expect(preview(src)).toEqual(live);
  });

  // Inside a callout, a quote or a list item's own lines (only container
  // marks before the block), as Obsidian and Notion nest them.
  const nested = [
    "> [!note] Callout with a table\n> | a | b |\n> | --- | --- |\n> | 1 | 2 |",
    "> [!tip] T\n>\n> ![[memex-q4#M1 — trust]]",
    "> [!tip] T\n> ![[note#H]]",
    "> [!tip]- Folded\n> ![[x.png|120]]",
    "> ![a](b.png)",
    "> > ![[note]]",
    "- item\n\n  ![[shot.png|120]]",
    "- item\n\n  ```toc\n  ```",
    "> ```toc\n>\n> ```",
    "> - a\n>\n>   | x | y |\n>   | - | - |\n>   | 1 | 2 |",
    "> ```chart\n> type: pie\n> labels: [a]\n> series:\n>   - data: [1]\n> ```",
  ];
  it.each(nested)("%j: nested, Lezer and markdown-it agree", (src) => {
    const live = lezer(src).map((b) => [b.spec.id, b.parsed]);
    expect(live).toHaveLength(1);
    expect(preview(src)).toEqual(live);
  });

  it("a note embed on a list item's own line stays text in both views", () => {
    // Drawn, the widget would take the bullet with the line.
    for (const src of ["- ![[note]]", "1. ![[note#H]]", "> - ![[note]]"]) {
      expect(lezer(src)).toEqual([]);
      expect(preview(src)).toEqual([]);
    }
  });

  it("covers the whole template's lines", () => {
    for (const b of BLOCKS) {
      const [hit] = lezer(b.template);
      expect(hit).toMatchObject({ from: 0, to: b.template.length });
    }
  });

  // A fence with no closing line runs to the end of its container in both
  // parsers: drawn as a block, it would hide every line after it.
  it.each([
    "# Plan\n\n```toc\n\n## Goals\n\nShip the editor.",
    "```toc\n# H\n\nrest of doc",
    "# T\n\n```toc",
  ])("%j: an unclosed fence stays code in both views", (src) => {
    expect(lezer(src)).toEqual([]);
    expect(preview(src)).toEqual([]);
    const html = markdownRenderer.render(src);
    expect(html).not.toContain("md-toc");
    expect(html).toContain("<pre>");
  });

  it("Preview reads a fence's closing line inside a quote or list too", () => {
    expect(markdownRenderer.render("> ```toc\n> ```")).toContain("md-toc");
    expect(markdownRenderer.render("- a\n\n  ```toc\n  ```")).toContain(
      "md-toc",
    );
    // The quote ends before any closing line: unclosed.
    expect(markdownRenderer.render("> ```toc\n\nafter")).not.toContain(
      "md-toc",
    );
    // A shorter or other marker does not close it.
    expect(markdownRenderer.render("````toc\n```")).not.toContain("md-toc");
    expect(markdownRenderer.render("```toc\n~~~")).not.toContain("md-toc");
  });

  it("a toc fence with text in it stays code, so no text is hidden", () => {
    const src = "```toc\nignored body\n```";
    expect(lezer(src)).toEqual([]);
    expect(preview(src)).toEqual([]);
    expect(markdownRenderer.render(src)).toContain("ignored body");
  });

  it("names each block once", () => {
    const ids = BLOCKS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("renderStatic escapes vault text", () => {
  const hostile = `<script>alert(1)</script>"'&`;
  it("image: alt, title and src", () => {
    const html = IMAGE.renderStatic!(
      { src: `x.png" onerror="alert(1)`, alt: hostile, title: hostile },
      { headings: [] },
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain('" onerror');
    expect(html).toContain("&lt;script&gt;");
  });

  it("toc: heading text in the label and the link", () => {
    const html = TOC.renderStatic!(
      {},
      { headings: [{ level: 2, text: hostile, line: 0 }] },
    );
    expect(html).not.toContain("<script");
    expect(html).toContain('data-link="#&lt;script&gt;');
  });

  it("through the renderer, a heading's markup never becomes a tag", () => {
    const html = markdownRenderer.render(
      "# <img src=x onerror=alert(1)>\n\n```toc\n```",
    );
    expect(html).not.toMatch(/<img/);
  });
});

// A plugin's fences (lib/plugins) dispatch through the same registry: a
// `builtin:<id>` renderer is the block of that id, `builtin:code` a plain
// code block, and a renderer this build lacks its body as code with a note.
describe("plugin fences", () => {
  afterEach(() => setPluginFences([]));

  it("builtin:code leaves the fence a plain code block", () => {
    setPluginFences([{ lang: "dataview", renderer: "builtin:code" }]);
    expect(fenceBlock("dataview")).toBeUndefined();
    expect(lezer("```dataview\nlist\n```")).toEqual([]);
    expect(markdownRenderer.render("```dataview\nlist\n```")).toBe(
      '<pre><code class="language-dataview">list\n</code></pre>\n',
    );
  });

  it("builtin:mermaid, builtin:chart and builtin:query draw with that block, in both views", () => {
    setPluginFences([
      { lang: "graph", renderer: "builtin:mermaid" },
      { lang: "plot", renderer: "builtin:chart" },
      { lang: "pages", renderer: "builtin:query" },
    ]);
    expect(fenceBlock("graph")).toBe(MERMAID);
    expect(fenceBlock("plot")).toBe(CHART);
    expect(fenceBlock("pages")).toBe(QUERY);
    // Each block's own template, under the plugin's fence name.
    const src = [
      MERMAID.template.replace("```mermaid", "```graph"),
      CHART.template.replace("```chart", "```plot"),
      QUERY.template.replace("```myco-query", "```pages"),
    ].join("\n\n");
    const live = lezer(src).map((b) => [b.spec.id, b.parsed]);
    expect(live.map(([id]) => id)).toEqual(["mermaid", "chart", "query"]);
    expect(preview(src)).toEqual(live);
    const html = markdownRenderer.render(src);
    expect(html).toContain('<div class="md-mermaid"><pre><code>flowchart LR');
    expect(html).toContain('<div class="md-chart" data-chart="bar"');
    expect(html).toContain(
      '<div class="md-query" data-query="path:wiki/ sort:modified limit:10">',
    );
    expect(html).not.toContain("md-plugin-note");
    expect(html).not.toContain("language-graph");
  });

  // Every renderer FENCE_RENDERERS names is in this build: the fallback is
  // reached with a registry that leaves the renderer's block out.
  it("a renderer this build lacks: the body as code plus a note, in both views", () => {
    setPluginFences(
      [{ lang: "graph", renderer: "builtin:mermaid" }],
      BLOCKS.filter((b) => b !== MERMAID),
    );
    const src = "```graph\nA --> B\n```";
    const live = lezer(src).map((b) => [b.spec.id, b.parsed]);
    expect(live).toEqual([["plugin-code", "A --> B\n"]]);
    expect(preview(src)).toEqual(live);
    const html = markdownRenderer.render(src);
    expect(html).toContain(
      '<pre><code class="language-graph">A --&gt; B\n</code></pre>',
    );
    expect(html).toContain('<p class="md-plugin-note">');
    expect(html).toContain("builtin:mermaid");
    // Nested, as other registry fences are.
    expect(lezer("> ```graph\n> x\n> ```")).toHaveLength(1);
  });

  it("the note reads in the UI's language, and vault text is escaped", () => {
    setPluginFences(
      [{ lang: "graph", renderer: "builtin:chart" }],
      BLOCKS.filter((b) => b !== CHART),
    );
    const html = markdownRenderer.render(
      "```graph\n<script>alert(1)</script>\n```",
      { strings: STRINGS.ko },
    );
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain(
      STRINGS.ko.pl_renderer_missing.replace("{renderer}", "builtin:chart"),
    );
  });

  it("builtin:<id> resolves to the registry block of that id", () => {
    const mermaid = { ...TOC, id: "mermaid", match: { fence: "mermaid" } };
    expect(rendererBlock("graph", "builtin:mermaid", [mermaid])).toBe(mermaid);
    expect(rendererBlock("graph", "builtin:code", [mermaid])).toBeNull();
    expect(rendererBlock("graph", "builtin:query", [mermaid])?.id).toBe(
      "plugin-code",
    );
  });

  it("a built-in fence stays built-in; the first plugin naming a fence keeps it", () => {
    setPluginFences([
      { lang: "toc", renderer: "builtin:mermaid" },
      { lang: "graph", renderer: "builtin:code" },
      { lang: "graph", renderer: "builtin:mermaid" },
    ]);
    expect(fenceBlock("toc")).toBe(TOC);
    expect(fenceBlock("graph")).toBeUndefined();
  });

  it("once the plugin is off the fence is code again", () => {
    setPluginFences([{ lang: "graph", renderer: "builtin:mermaid" }]);
    expect(fenceBlock("graph")).toBeDefined();
    setPluginFences([]);
    expect(fenceBlock("graph")).toBeUndefined();
    expect(lezer("```graph\nx\n```")).toEqual([]);
  });
});

describe("Preview through the registry", () => {
  it("```toc lists the page's headings as in-page links", () => {
    const html = markdownRenderer.render(
      "# Title\n\n```toc\n```\n\n## Two\n\n```\n# not a heading\n```\n### Three",
    );
    expect(html).toContain(
      '<li class="md-toc-1"><a data-link="#Title" data-heading-line="0" class="myco-wikilink" href="#">Title</a></li>',
    );
    expect(html).toContain('data-link="#Two"');
    expect(html).toContain('<li class="md-toc-3">');
    expect(html).not.toContain("not a heading</a>");
    // The fence is the outline, not a code block (the other fence stays one).
    expect(html).not.toContain("language-toc");
    expect(html).toContain("<pre><code># not a heading");
  });

  it("each TOC row carries its heading's line, so a repeated name goes to its own", () => {
    const html = markdownRenderer.render(
      "# D\n\n```toc\n```\n\n## Monday\n\n### Summary\n\n## Tuesday\n\n### Summary",
    );
    expect(html).toContain(
      '<a data-link="#Summary" data-heading-line="7" class="myco-wikilink" href="#">Summary</a>',
    );
    expect(html).toContain(
      '<a data-link="#Summary" data-heading-line="11" class="myco-wikilink" href="#">Summary</a>',
    );
    // A heading that moves redraws Live's widget (its key).
    const at = (line: number) =>
      TOC.key!({}, { headings: [{ level: 2, text: "S", line }] });
    expect(at(3)).not.toBe(at(4));
  });

  it("an empty TOC keeps its box, as Live's does (the Viewer fills the text)", () => {
    expect(markdownRenderer.render("```toc\n```\n\ntext only")).toContain(
      '<nav class="md-toc is-empty"></nav>',
    );
  });

  it("an unknown fence stays a code block", () => {
    expect(markdownRenderer.render("```js\nx\n```")).toContain(
      '<pre><code class="language-js">',
    );
  });

  it("honours |N (and |WxH) as the image width", () => {
    expect(markdownRenderer.render("![[x.png|300]]")).toContain(
      '<img src="assets/x.png" alt="x.png" width="300">',
    );
    expect(markdownRenderer.render("![a|120x80](assets/x.png)")).toContain(
      '<img src="assets/x.png" alt="a" width="120" height="80">',
    );
    // A bare number is alt text in a markdown image (Obsidian needs the `|`).
    expect(markdownRenderer.render("![300](assets/x.png)")).toContain(
      'alt="300">',
    );
  });

  it("keeps an image's title", () => {
    expect(markdownRenderer.render('![a](assets/x.png "t")')).toContain(
      '<img src="assets/x.png" alt="a" title="t">',
    );
  });
});

describe("liveBlocks", () => {
  it("finds a fenced block by its info word, anywhere in the doc", () => {
    const src = "# T\n\n```toc\n```\n\ntext";
    expect(lezer(src)).toMatchObject([
      { from: 5, to: 15, source: "```toc\n```" },
    ]);
    expect(lezer("```js\nx\n```")).toEqual([]);
    expect(lezer("```\nx\n```")).toEqual([]);
  });

  it("takes an image only when it is its line's whole content", () => {
    expect(lezer("![a](b.png)")).toHaveLength(1);
    expect(lezer("  ![a](b.png)  ")).toMatchObject([{ from: 0, to: 15 }]);
    expect(lezer("text ![a](b.png) more")).toEqual([]);
    expect(lezer("![a](b.png)\nsoft line")).toEqual([]);
  });

  it("draws a nested block over its whole lines, never over a list marker", () => {
    // The marker would vanish with the line.
    expect(lezer("- ![a](b.png)")).toEqual([]);
    expect(lezer("- ```toc\n  ```")).toEqual([]);
    // Only container marks before it: the lines are the block's.
    expect(lezer("> ![a](b.png)")).toMatchObject([
      { from: 0, to: 13, lead: "> " },
    ]);
    expect(lezer("- item\n\n  ```toc\n  ```")).toMatchObject([
      { from: 8, to: 22, lead: "  " },
    ]);
    // A soft line is still no line of its own, nested or not.
    expect(lezer("- item\n  ![a](b.png)")).toEqual([]);
    expect(lezer("> text\n> ![a](b.png)")).toEqual([]);
  });

  it("skips what is no image: a note embed, a script URL", () => {
    expect(lezer("![[note]]").map((b) => b.spec.id)).toEqual(["embed"]);
    expect(lezer("![a](javascript:alert(1))")).toEqual([]);
    expect(lezer("![a](data:text/html,x)")).toEqual([]);
    expect(lezer("![a](data:image/png;base64,AA)")).toHaveLength(1);
  });

  it("ignores the frontmatter", () => {
    expect(lezer("---\na: 1\n---\n![a](b.png)")).toMatchObject([{ from: 13 }]);
  });

  it("parses the image as written: path, alt, |N, title", () => {
    expect(lezer('![a|300](<assets/my x.png> "t")')[0].parsed).toEqual({
      src: "assets/my x.png",
      alt: "a",
      title: "t",
      width: 300,
    });
    expect(lezer("![[sub/x.png]]")[0].parsed).toEqual({
      src: "sub/x.png",
      alt: "sub/x.png",
    });
  });
});

// Decision 2 (2026-10-01): a block never shows its markdown in Live, so no
// caret may sit on its hidden source. A caret there selects the block whole
// (Notion's block selection); a range's end inside one grows to cover it.
describe("snapToBlocks", () => {
  const blocks = [
    { from: 10, to: 20 },
    { from: 30, to: 40 },
  ];
  const snap = (anchor: number, head = anchor) =>
    snapToBlocks(blocks, EditorSelection.single(anchor, head))?.main ?? null;
  const at = (anchor: number, head: number) => ({ anchor, head });

  it("a caret on a block, its edges too, selects the block", () => {
    for (const p of [10, 15, 20]) expect(snap(p)).toMatchObject(at(10, 20));
    expect(snap(9)).toBeNull();
    expect(snap(21)).toBeNull();
  });

  it("a range's end inside a block grows to the block's far edge", () => {
    expect(snap(5, 15)).toMatchObject(at(5, 20));
    expect(snap(15, 25)).toMatchObject(at(10, 25));
    expect(snap(25, 15)).toMatchObject(at(25, 10));
    expect(snap(12, 18)).toMatchObject(at(10, 20));
    expect(snap(18, 12)).toMatchObject(at(20, 10));
    expect(snap(15, 35)).toMatchObject(at(10, 40));
  });

  it("leaves a selection that is off every block's source alone", () => {
    expect(snap(10, 20)).toBeNull();
    expect(snap(5, 10)).toBeNull();
    expect(snap(5, 45)).toBeNull();
    expect(snapToBlocks([], EditorSelection.single(3))).toBeNull();
  });

  it("snaps every range and keeps the main one", () => {
    const sel = EditorSelection.create(
      [EditorSelection.cursor(2), EditorSelection.cursor(33)],
      1,
    );
    const out = snapToBlocks(blocks, sel)!;
    expect(out.ranges.map((r) => [r.from, r.to])).toEqual([
      [2, 2],
      [30, 40],
    ]);
    expect(out.mainIndex).toBe(1);
  });
});

/** `‹` anchor and `›` head of a selection, or `│` a caret, in and out. */
function marked(src: string): { doc: string; sel: EditorSelection } {
  const caret = src.indexOf("│");
  if (caret >= 0)
    return {
      doc: src.replace("│", ""),
      sel: EditorSelection.single(caret),
    };
  const a = src.indexOf("‹");
  const h = src.indexOf("›");
  return {
    doc: src.replace(/[‹›]/g, ""),
    sel: EditorSelection.single(a < h ? a : a - 1, h < a ? h : h - 1),
  };
}
function mark(doc: string, r: SelectionRange): string {
  if (r.empty) return doc.slice(0, r.head) + "│" + doc.slice(r.head);
  const [lo, hi] = r.anchor < r.head ? ["‹", "›"] : ["›", "‹"];
  return (
    doc.slice(0, r.from) + lo + doc.slice(r.from, r.to) + hi + doc.slice(r.to)
  );
}
/** `key` pressed on `src` (marked): the doc and selection after, or null
 *  when blockKeyTr leaves the key alone. */
function press(src: string, key: BlockKey): string | null {
  const { doc, sel } = marked(src);
  const s = EditorState.create({ doc, selection: sel });
  const spec = blockKeyTr(s, lezer(doc), key);
  if (!spec) return null;
  const t = s.update(spec);
  return mark(t.state.doc.toString(), t.state.selection.main);
}

describe("blockKeyTr — keys on a block selected whole", () => {
  const IMG = "![a](b.png)";
  const TOCB = "```toc\n```";

  it("Enter puts the caret on a new line under the block, set apart", () => {
    expect(press(`intro\n\n‹${IMG}›\n\nend`, "Enter")).toBe(
      `intro\n\n${IMG}\n\n│\n\nend`,
    );
    // Text right below: a blank line keeps it apart from the new line too.
    expect(press(`‹${TOCB}›\nend`, "Enter")).toBe(`${TOCB}\n\n│\n\nend`);
    expect(press(`intro\n\n‹${TOCB}›`, "Enter")).toBe(`intro\n\n${TOCB}\n\n│`);
    // In a quote the new line stays in it.
    expect(press(`‹> ${IMG}›`, "Enter")).toBe(`> ${IMG}\n>\n> │`);
  });

  it("Enter opens the block's own editor instead, when it has one", () => {
    const { doc, sel } = marked(`‹${TOCB}›`);
    const s = EditorState.create({ doc, selection: sel });
    const [b] = lezer(doc);
    const editable = { ...b, spec: { ...b.spec, openEditor: () => undefined } };
    expect(blockKeyTr(s, [editable], "Enter")).toBeNull();
    expect(blockKeyTr(s, [b], "Enter")).not.toBeNull();
  });

  it("Backspace and Delete take the block's lines out, tidily", () => {
    for (const key of ["Backspace", "Delete"] as const) {
      expect(press(`intro\n\n‹${IMG}›\n\nend`, key)).toBe("intro\n\n│end");
      expect(press(`intro\n\n‹${TOCB}›\nend`, key)).toBe("intro\n\n│end");
      expect(press(`intro\n\n‹${TOCB}›`, key)).toBe("intro│");
      expect(press(`‹${TOCB}›\n\nend`, key)).toBe("│end");
      expect(press(`‹${TOCB}›`, key)).toBe("│");
      // A block in a quote takes its quote's gap line with it.
      expect(press(`> a\n>\n‹> ${IMG}›\n>\n> c`, key)).toBe("> a\n>\n│> c");
    }
  });

  it("the removal is one undo step, which selects the block again", () => {
    const { doc, sel } = marked(`intro\n\n‹${TOCB}›\n\nend`);
    const view = {
      state: EditorState.create({
        doc,
        selection: sel,
        extensions: [history()],
      }),
      dispatch(tr: Transaction) {
        view.state = tr.state;
      },
    };
    view.dispatch(
      view.state.update(blockKeyTr(view.state, lezer(doc), "Backspace")!),
    );
    expect(view.state.doc.toString()).toBe("intro\n\nend");
    expect(undo(view)).toBe(true);
    expect(mark(view.state.doc.toString(), view.state.selection.main)).toBe(
      `intro\n\n‹${TOCB}›\n\nend`,
    );
    expect(undo(view)).toBe(false);
  });

  it("Backspace or Delete with the caret on a block's edge selects it", () => {
    // Typing that closes a fence leaves the caret there; CM's atomic delete
    // would take the whole block at once.
    expect(press(`intro\n\n${TOCB}│`, "Backspace")).toBe(`intro\n\n‹${TOCB}›`);
    expect(press(`intro\n\n${TOCB}│`, "Delete")).toBe(`intro\n\n‹${TOCB}›`);
    expect(press(`intro\n\n│${TOCB}`, "Delete")).toBe(`intro\n\n‹${TOCB}›`);
    expect(press(`intro│\n\n${TOCB}`, "Backspace")).toBeNull();
    expect(press(`intro\n\n${TOCB}\n│`, "Backspace")).toBeNull();
  });

  it("Escape puts the caret after the block", () => {
    expect(press(`intro\n\n‹${IMG}›\n\nend`, "Escape")).toBe(
      `intro\n\n${IMG}\n\n│end`,
    );
    // Nothing after it, or another block: a new line, as Enter makes.
    expect(press(`intro\n\n‹${TOCB}›`, "Escape")).toBe(`intro\n\n${TOCB}\n\n│`);
    expect(press(`‹${TOCB}›\n\n${TOCB}`, "Escape")).toBe(
      `${TOCB}\n\n│\n\n${TOCB}`,
    );
  });

  it("ArrowDown (and ArrowRight) go on to the text after the block", () => {
    for (const key of ["ArrowDown", "ArrowRight"] as const) {
      expect(press(`intro\n\n‹${IMG}›\n\nend`, key)).toBe(
        `intro\n\n${IMG}\n\n│end`,
      );
      expect(press(`‹${TOCB}›\nend`, key)).toBe(`${TOCB}\n│end`);
      // The next block: its edge, which the field's snap selects.
      expect(press(`‹${TOCB}›\n\n${TOCB}`, key)).toBe(`${TOCB}\n\n│${TOCB}`);
      // A last line set apart by a blank one is a place to type.
      expect(press(`‹${TOCB}›\n\n`, key)).toBe(`${TOCB}\n\n│`);
      // The note's last block: the blank line under it (typing there is
      // set apart, apartTyped), else a new line, as Escape makes.
      expect(press(`‹${IMG}›\n`, key)).toBe(`${IMG}\n│`);
      expect(press(`intro\n\n‹${TOCB}›`, key)).toBe(`intro\n\n${TOCB}\n\n│`);
      expect(press(`‹> ${IMG}›\n>`, key)).toBe(`> ${IMG}\n>│`);
    }
  });

  it("ArrowUp (and ArrowLeft) go on to the text before the block", () => {
    const fm = "---\na: 1\n---\n";
    for (const key of ["ArrowUp", "ArrowLeft"] as const) {
      expect(press(`intro\n\n‹${IMG}›\n\nend`, key)).toBe(
        `intro│\n\n${IMG}\n\nend`,
      );
      // Its first body line is fine.
      expect(press(`${fm}\n\n‹${TOCB}›`, key)).toBe(`${fm}│\n\n${TOCB}`);
    }
    // The note's first block, nothing before it but the hidden frontmatter:
    // ArrowUp opens a new line over it, as ArrowDown does under the last;
    // ArrowLeft holds.
    expect(press(`‹${TOCB}›\n\nend`, "ArrowUp")).toBe(`│\n\n${TOCB}\n\nend`);
    expect(press(`${fm}‹${TOCB}›`, "ArrowUp")).toBe(`${fm}│\n\n${TOCB}`);
    expect(press(`‹> ${IMG}›`, "ArrowUp")).toBe(`> │\n>\n> ${IMG}`);
    expect(press(`‹${TOCB}›\n\nend`, "ArrowLeft")).toBe(`‹${TOCB}›\n\nend`);
    expect(press(`\n‹${IMG}›`, "ArrowLeft")).toBe(`\n‹${IMG}›`);
    expect(press(`${fm}‹${TOCB}›`, "ArrowLeft")).toBe(`${fm}‹${TOCB}›`);
  });

  it("holds Tab and Shift-Tab: a selected block is never indented as text", () => {
    // Twice indented, a fence is a code block that shows its markdown.
    const M = "```mermaid\ngraph TD\n  A-->B\n```";
    for (const key of ["Tab", "Shift-Tab"] as const) {
      expect(press(`intro\n\n‹${M}›\n\nend`, key)).toBe(
        `intro\n\n‹${M}›\n\nend`,
      );
      expect(press(`‹${IMG}›`, key)).toBe(`‹${IMG}›`);
    }
  });

  it("leaves every key alone with no block selected", () => {
    for (const key of [
      "Enter",
      "Escape",
      "ArrowUp",
      "ArrowDown",
      "Tab",
      "Shift-Tab",
    ] as const) {
      expect(press(`int‹ro›\n\n${TOCB}`, key)).toBeNull();
      expect(press(`intro│\n\n${TOCB}`, key)).toBeNull();
    }
    // Two blocks selected together are a text selection.
    expect(press(`‹${TOCB}\n\n${TOCB}›`, "Backspace")).toBeNull();
  });
});

describe("leaveTr — a table cell hands the caret back to the note", () => {
  const T = "| a |\n| --- |\n| 1 |";
  const leave = (src: string, to: "select" | "up" | "down") => {
    const s = EditorState.create({ doc: src });
    const blocks = lezer(src);
    const spec = leaveTr(s, blocks, blocks[0].from, to);
    if (!spec) return null;
    const t = s.update(spec);
    return mark(t.state.doc.toString(), t.state.selection.main);
  };

  it("Escape selects the table whole", () => {
    expect(leave(`intro\n\n${T}\n\nend`, "select")).toBe(
      `intro\n\n‹${T}›\n\nend`,
    );
  });

  it("ArrowUp from the first row: the text before; none, a new line over it", () => {
    expect(leave(`intro\n\n${T}`, "up")).toBe(`intro│\n\n${T}`);
    expect(leave(T, "up")).toBe(`│\n\n${T}`);
    // In a quote the new line stays in it.
    const q = "> | a |\n> | --- |";
    expect(leave(q, "up")).toBe(`> │\n>\n${q}`);
  });

  it("ArrowDown from the last row: the text after; none, a new line under it", () => {
    expect(leave(`${T}\n\nend`, "down")).toBe(`${T}\n\n│end`);
    expect(leave(T, "down")).toBe(`${T}\n\n│`);
    // In a quote the new line stays in it.
    const q = "> | a |\n> | --- |";
    expect(leave(q, "down")).toBe(`${q}\n>\n> │`);
  });

  it("is null where no block starts", () => {
    const s = EditorState.create({ doc: T });
    expect(leaveTr(s, lezer(T), 3, "select")).toBeNull();
  });

  it("Enter on the selected table opens its first cell, not a new line", () => {
    const { doc, sel } = marked(`‹${T}›`);
    const s = EditorState.create({ doc, selection: sel });
    expect(TABLE.openEditor).toBeDefined();
    expect(blockKeyTr(s, lezer(doc), "Enter")).toBeNull();
  });
});

describe("stepInto", () => {
  // Vertical motion skips block widgets; the arrows land on the block's
  // near edge instead, which selects the block (snapToBlocks).
  const drawn = [
    { from: 10, to: 20 },
    { from: 30, to: 40 },
  ];
  it("down onto the first block the motion would jump over", () => {
    expect(stepInto(drawn, 5, 22, true)).toBe(10);
    expect(stepInto(drawn, 5, 45, true)).toBe(10);
    expect(stepInto(drawn, 21, 42, true)).toBe(30);
  });
  it("up onto the nearest block's end", () => {
    expect(stepInto(drawn, 45, 25, false)).toBe(40);
    expect(stepInto(drawn, 25, 2, false)).toBe(20);
  });
  it("leaves motion that passes no block alone", () => {
    expect(stepInto(drawn, 21, 25, true)).toBeNull();
    expect(stepInto(drawn, 5, 8, true)).toBeNull();
    expect(stepInto(drawn, 25, 22, false)).toBeNull();
    expect(stepInto([], 0, 9, true)).toBeNull();
  });
});

describe("blockWidgets field", () => {
  const src = "intro\n\n![a](b.png)\n\nend";
  const make = (anchor = 0) =>
    EditorState.create({
      doc: src,
      selection: { anchor },
      extensions: [mycoMarkdown(), blockWidgets({})],
    });
  /** [from, to, block?, selected?] of each decoration the field provides. */
  const widgets = (s: EditorState) =>
    s.facet(EditorView.decorations).flatMap((d) => {
      if (typeof d === "function") return [];
      const out: [number, number, boolean, boolean][] = [];
      d.between(0, s.doc.length, (from, to, v) => {
        const w = v.spec.widget as { selected?: boolean } | undefined;
        out.push([from, to, v.spec.block === true, w?.selected === true]);
      });
      return out;
    });
  const range = (s: EditorState) => [
    s.selection.main.anchor,
    s.selection.main.head,
  ];
  /** The note's one widget. */
  const widgetOf = (s: EditorState): WidgetType => {
    let w: WidgetType | null = null;
    for (const d of s.facet(EditorView.decorations))
      if (typeof d !== "function")
        d.between(0, s.doc.length, (_f, _t, v) => {
          w = v.spec.widget as WidgetType;
        });
    return w!;
  };

  it("replaces the image line with a block widget", () => {
    expect(widgets(make())).toEqual([[7, 18, true, false]]);
  });

  // Decision 2: never the source, whatever the caret; decision 3: a caret
  // on the block selects it whole, ringed.
  it("keeps the widget drawn with the caret on it: the block is selected", () => {
    for (const anchor of [7, 9, 18]) {
      const on = make().update({ selection: { anchor } }).state;
      expect(range(on)).toEqual([7, 18]);
      expect(widgets(on)).toEqual([[7, 18, true, true]]);
    }
    const off = make(9).update({ selection: { anchor: 0 } }).state;
    expect(widgets(off)).toEqual([[7, 18, true, false]]);
  });

  it("grows a selection's end inside the block to cover it, drawn", () => {
    // Drawn, the block is atomic: a delete of a selection ending inside it
    // would take its source, never selected, up to the far edge.
    const across = make().update({ selection: EditorSelection.single(9, 21) });
    expect(range(across.state)).toEqual([7, 21]);
    expect(widgets(across.state)).toEqual([[7, 18, true, true]]);
    const back = make().update({ selection: EditorSelection.single(9, 2) });
    expect(range(back.state)).toEqual([18, 2]);
    // Text around the block is selected with it, its ring on.
    const around = make().update({ selection: EditorSelection.single(2, 21) });
    expect(range(around.state)).toEqual([2, 21]);
    expect(widgets(around.state)).toEqual([[7, 18, true, true]]);
  });

  it("lets typing go on where it left the caret, on a block's edge", () => {
    // The last backtick of a fence typed by hand: the caret is at the new
    // block's end, and the next key must not replace the block.
    const typed = EditorState.create({
      doc: "```toc\n``",
      selection: { anchor: 9 },
      extensions: [mycoMarkdown(), blockWidgets({})],
    }).update({
      changes: { from: 9, insert: "`" },
      selection: { anchor: 10 },
      userEvent: "input.type",
    }).state;
    expect(range(typed)).toEqual([10, 10]);
    expect(widgets(typed)).toEqual([[0, 10, true, false]]);
    // Enter's own edits too: ```mermaid⏎ closes the fence with the caret
    // in its body, where the diagram is typed.
    const entered = EditorState.create({
      doc: "```mermaid",
      selection: { anchor: 10 },
      extensions: [mycoMarkdown(), blockWidgets({})],
    }).update({
      changes: { from: 10, insert: "\n\n```" },
      selection: { anchor: 11 },
      userEvent: "input",
    }).state;
    expect(range(entered)).toEqual([11, 11]);
  });

  it("text typed on the blank line under a block starts a paragraph apart", () => {
    // Glued under a table it would be the table's next row (a tag's
    // paragraph's, an image's soft line), the caret inside the block.
    const typed = (src: string, insert = "h", userEvent = "input.type") => {
      const { doc, sel } = marked(src);
      const at = sel.main.head;
      const s = EditorState.create({
        doc,
        selection: sel,
        extensions: [mycoMarkdown(), blockWidgets({})],
      }).update({
        changes: { from: at, insert },
        selection: { anchor: at + insert.length },
        userEvent,
      }).state;
      return mark(s.doc.toString(), s.selection.main);
    };
    const T = "| a |\n| - |\n| 1 |";
    expect(typed(`${T}\n│`)).toBe(`${T}\n\nh│`);
    // Text right below: a blank line on both sides.
    expect(typed(`${T}\n│\nend`)).toBe(`${T}\n\nh│\n\nend`);
    // The tag line is the table's: under it, not between them.
    expect(typed(`${T}\n\n^t\n│`)).toBe(`${T}\n\n^t\n\nh│`);
    expect(typed(`![a](b.png)\n│`)).toBe(`![a](b.png)\n\nh│`);
    // In a quote the paragraph stays in it.
    const q = "> | a |\n> | - |\n> | 1 |";
    expect(typed(`${q}\n>│`)).toBe(`${q}\n>\n> h│`);
    // Typed past the quote's end, or at an item's left edge, it stays there.
    expect(typed(`${q}\n│`)).toBe(`${q}\n\nh│`);
    expect(typed(`- a\n\n  ![a](b.png)\n│`)).toBe(`- a\n\n  ![a](b.png)\n\nh│`);
    expect(typed(`${T}\n│`, "a\nb", "input.paste")).toBe(`${T}\n\na\nb│`);
    // The block keeps its lines.
    const out = typed(`${T}\n│\nend`).replace("│", "");
    expect(lezer(out).map((b) => [b.from, b.to])).toEqual([[0, T.length]]);
    // Apart already, a new line, or mid-composition (keydown handles that):
    // left as typed.
    expect(typed(`${T}\n\n│`)).toBe(`${T}\n\nh│`);
    expect(typed(`${T}\n│`, "\n")).toBe(`${T}\n\n│`);
    expect(typed(`${T}\n│`, "ㅎ", "input.type.compose")).toBe(`${T}\nㅎ│`);
  });

  it("text with no keydown over a block selected whole goes under it", () => {
    // An emoji picker, dictation, a text replacement: an input replacing
    // the selection, with no key first to move the caret (keydown below).
    const over = (src: string, insert: string, userEvent = "input.type") => {
      const { doc, sel } = marked(src);
      const { from, to } = sel.main;
      const s = EditorState.create({
        doc,
        selection: sel,
        extensions: [mycoMarkdown(), blockWidgets({}), history()],
      }).update({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
        userEvent,
      }).state;
      return { s, out: mark(s.doc.toString(), s.selection.main) };
    };
    const T = "| a |\n| - |\n| 1 |";
    expect(over(`‹${T}›`, "👍").out).toBe(`${T}\n\n👍│`);
    expect(over(`intro\n\n‹${T}›\n\nend`, "다음").out).toBe(
      `intro\n\n${T}\n\n다음│\n\nend`,
    );
    const TOCB = "```toc\n```";
    expect(over(`‹${TOCB}›\nend`, "H").out).toBe(`${TOCB}\n\nH│\n\nend`);
    expect(over(`‹> ![a](b.png)›`, "x").out).toBe(`> ![a](b.png)\n>\n> x│`);
    // One undo step brings the note back as it was.
    const { s } = over(`‹${T}›`, "👍");
    const view = {
      state: s,
      dispatch(tr: Transaction) {
        view.state = tr.state;
      },
    };
    undo(view);
    expect(view.state.doc.toString()).toBe(T);
    // Text selected around the block, a composition (keydown moved its
    // caret first) and a paste are left as they are.
    expect(over(`‹intro\n\n${T}›`, "x").out).toBe("x│");
    expect(over(`‹${T}›`, "ㅎ", "input.type.compose").out).toBe("ㅎ│");
    expect(over(`‹${T}›`, "p", "input.paste").out).toBe("p│");
  });

  it("an IME's first keystroke there moves the caret apart first", () => {
    const T = "| a |\n| - |\n| 1 |";
    const apart = (src: string) => {
      const { doc, sel } = marked(src);
      const s = EditorState.create({ doc, selection: sel });
      const spec = apartTr(s, lezer(doc));
      if (!spec) return null;
      const t = s.update(spec).state;
      return mark(t.doc.toString(), t.selection.main);
    };
    expect(apart(`${T}\n│\nend`)).toBe(`${T}\n\n│\n\nend`);
    expect(apart(`${T}\n│`)).toBe(`${T}\n\n│`);
    expect(apart(`${T}\n\n│`)).toBeNull();
    expect(apart(`intro│\n\n${T}`)).toBeNull();
  });

  it("turning Live on selects the block the note opened its caret on", () => {
    // bodyStart on a first-line table: the snap filter was not there yet
    // for the transaction that turned Live on.
    const comp = new Compartment();
    const view = {
      state: EditorState.create({
        doc: "| a |\n| - |\n| 1 |\n\nend",
        selection: { anchor: 0 },
        extensions: [mycoMarkdown(), comp.of([])],
      }),
      dispatch(spec: TransactionSpec) {
        view.state = view.state.update(spec).state;
      },
    };
    reconfigureLive(view, comp, blockWidgets({}));
    expect(range(view.state)).toEqual([0, 17]);
    expect(widgets(view.state)).toEqual([[0, 17, true, true]]);
  });

  it("selects the block a delete leaves the caret on", () => {
    // Backspace on the empty line under a block (editorBlocks
    // collapseOnto): the caret lands on its end, which selects it.
    const s = EditorState.create({
      doc: "```toc\n```\n\n",
      selection: { anchor: 12 },
      extensions: [mycoMarkdown(), blockWidgets({})],
    }).update({
      changes: { from: 10, to: 12 },
      selection: { anchor: 10 },
      userEvent: "delete.backward",
    }).state;
    expect(range(s)).toEqual([0, 10]);
    expect(widgets(s)).toEqual([[0, 10, true, true]]);
  });

  it("selects the block an undo or redo leaves the caret on", () => {
    // CM's history dispatches its undo with filter: false, so snap never
    // sees it. A cell's write undone on a table that ends the note put the
    // caret back on the table's end, unselected: the next key landed on
    // the blank line above the table, glued to it.
    const doc = "Above\n\n| a |\n| - |\n| 1 |";
    const view = {
      state: EditorState.create({
        doc,
        selection: { anchor: doc.length },
        extensions: [mycoMarkdown(), blockWidgets({}), history()],
      }),
      trs: [] as Transaction[],
      dispatch(tr: Transaction) {
        view.trs.push(tr);
        view.state = tr.state;
      },
    };
    // A widget's write: no userEvent, the caret left where it was.
    const at = doc.length - 3;
    view.dispatch(
      view.state.update({ changes: { from: at, to: at + 1, insert: "2" } }),
    );
    undo(view);
    expect(view.state.selection.main.empty).toBe(true);
    const blocks = lezer(view.state.doc.toString());
    expect(undoneSnap(view.trs.slice(-1), blocks)?.main.from).toBe(7);
    expect(undoneSnap(view.trs.slice(-1), blocks)?.main.to).toBe(doc.length);
    redo(view);
    expect(undoneSnap(view.trs.slice(-1), blocks)?.main.to).toBe(doc.length);
    // Any other update: nothing to move.
    expect(undoneSnap(view.trs.slice(0, 1), blocks)).toBeNull();
    expect(undoneSnap(view.trs.slice(-1), null)).toBeNull();
  });

  it("redraws only the ring when the selection moves", () => {
    const s = make();
    const off = widgetOf(s);
    const on = widgetOf(s.update({ selection: { anchor: 9 } }).state);
    expect(on.eq(off)).toBe(false);
    // Same block, same content: CM keeps the DOM, only its class changes.
    const classes = new Set<string>();
    const el = {
      classList: {
        toggle: (c: string, yes: boolean) =>
          yes ? classes.add(c) : classes.delete(c),
      },
    } as unknown as HTMLElement;
    expect(on.updateDOM(el, {} as EditorView, off)).toBe(true);
    expect([...classes]).toEqual(["is-selected"]);
    // Another block's DOM is never taken over.
    const other = EditorState.create({
      doc: "intro\n\n![b](c.png)\n\nend",
      extensions: [mycoMarkdown(), blockWidgets({})],
    });
    expect(on.updateDOM(el, {} as EditorView, widgetOf(other))).toBe(false);
  });

  it("never rebuilds mid-composition: the set is only mapped", () => {
    const s = make();
    // The IME types into the image's source (its alt text).
    const composed = s.update({
      changes: { from: 9, insert: "한" },
      selection: EditorSelection.cursor(10),
      userEvent: "input.type.compose",
    }).state;
    // The same widget, shifted to the longer source; the caret stays.
    expect(widgets(composed)).toEqual([[7, 19, true, false]]);
    expect(widgetOf(composed)).toBe(widgetOf(s));
    expect(range(composed)).toEqual([10, 10]);
    // Autocomplete's effect-only transactions arrive mid-composition too:
    // still no rebuild (the Korean IME broke on one after a callout).
    expect(widgetOf(composed.update({}).state)).toBe(widgetOf(s));
    // The composition's end catches up, and so does a typed edit.
    const ended = composed.update({ effects: composeEnded.of(null) }).state;
    expect(widgetOf(ended)).not.toBe(widgetOf(s));
    expect(widgets(ended)).toEqual([[7, 19, true, false]]);
    const typed = composed.update({ changes: { from: 0, insert: " " } }).state;
    expect(widgetOf(typed)).not.toBe(widgetOf(s));
  });
});

// A bake button pressed while the note had no focus left focus on <body>,
// so the ⌘Z that should take the bake back did nothing.
describe("widgetEdit", () => {
  it("writes one undo step, then hands focus back to the note", () => {
    const calls: string[] = [];
    // undo() calls dispatch detached from the view: no `this`.
    const view = {
      state: EditorState.create({ doc: "abc", extensions: [history()] }),
      dispatch: (tr: Transaction | TransactionSpec) => {
        calls.push("dispatch");
        view.state = (
          tr instanceof Transaction ? tr : view.state.update(tr)
        ).state;
      },
      focus: () => calls.push("focus"),
    };
    const edit = widgetEdit(view, () => 1);
    edit((doc, from) => ({ from, to: from + 1, insert: doc.toUpperCase() }));
    expect(view.state.doc.toString()).toBe("aABCc");
    expect(calls).toEqual(["dispatch", "focus"]);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("abc");
    // Nothing to write: nothing dispatched, focus left where it is.
    calls.length = 0;
    edit(() => null);
    expect(calls).toEqual([]);
  });

  // A chart panel's "new table" writes a table above its fence: the
  // chart's panel opens again where the fence now starts, and keeps focus.
  it("opens the editor of the block `open` characters into the insert", () => {
    const opened: number[] = [];
    const calls: string[] = [];
    const view = {
      state: EditorState.create({
        doc: "ab\n\nchart",
        selection: { anchor: 4, head: 9 },
        extensions: [history()],
      }),
      dispatch: (tr: TransactionSpec) => {
        const t = view.state.update(tr);
        for (const e of t.effects)
          if (e.is(openBlockEditor)) opened.push(e.value);
        view.state = t.state;
      },
      focus: () => calls.push("focus"),
    };
    widgetEdit(
      view,
      () => 4,
    )((doc, from) => ({
      from,
      to: doc.length,
      insert: "table\n\nchart",
      open: 7,
    }));
    expect(view.state.doc.toString()).toBe("ab\n\ntable\n\nchart");
    expect(opened).toEqual([11]);
    expect(calls).toEqual([]);
    // No selection spans the new table and the chart: neither is ringed.
    expect(view.state.selection.main.empty).toBe(true);
  });
});
