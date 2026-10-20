import { describe, expect, it } from "vitest";
import { Text } from "@codemirror/state";
import { TABLE, type TableModel } from "./table";
import { liveBlocks, noteTableHtml } from "./live";
import { mycoMarkdown } from "../editorBlocks";
import { markdownRenderer } from "../markdown";

// The editor's own parser: GFM with setext headings off.
const { parser } = mycoMarkdown().language;
const lezer = (src: string) =>
  liveBlocks(parser.parse(src), Text.of(src.split("\n")));

const samples = [
  // Padded row, an escaped pipe in code, a pipe-less row (still a row).
  "| a | b |\n| --- | :-: |\n| 1 | `x\\|y` |\n| only |\nplain",
  // No outer pipes; the extra cell is dropped.
  "a | b\n--- | ---\n1 | 2 | 3",
  // Empty cells.
  "|  | b |\n|-|-|\n|  |  |",
  "| **bold** | [[note]] |\n| :-- | --: |\n| x |  y  |",
];

/** Each rendered row's cells as markdown-it reads them. */
function mditCells(src: string): string[][] {
  const rows: string[][] = [];
  const tokens = markdownRenderer.parse(src, {});
  tokens.forEach((t, i) => {
    if (t.type === "tr_open") rows.push([]);
    const prev = tokens[i - 1]?.type;
    if (t.type === "inline" && (prev === "th_open" || prev === "td_open"))
      rows[rows.length - 1].push(t.content);
  });
  return rows;
}

const model = (src: string): TableModel => {
  const [block] = lezer(src);
  expect(block?.spec.id).toBe("table");
  return block.parsed as TableModel;
};

describe("table block", () => {
  it("is one widget over a top-level table's whole lines", () => {
    const src = "intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nend";
    expect(lezer(src)).toMatchObject([
      { from: 7, to: 36, source: "| a | b |\n| - | - |\n| 1 | 2 |" },
    ]);
    // A table right under a paragraph is still a table in both parsers.
    expect(lezer("text\n| a |\n| - |").map((b) => b.spec.id)).toEqual([
      "table",
    ]);
  });

  it("reads a table in a quote or list item past its container marks", () => {
    const quoted = "> | a | b |\n> | - | - |\n> | 1 | 2 |";
    const q = model(quoted);
    expect(q.src).toBe(quoted);
    expect(q.grid).toMatchObject({
      lead: "> ",
      rows: [
        ["a", "b"],
        ["1", "2"],
      ],
    });
    const listed = "- item\n\n  | a |\n  | - |\n  | 1 |";
    const [block] = lezer(listed);
    expect(block).toMatchObject({ from: 8, to: listed.length });
    expect((block.parsed as TableModel).grid).toMatchObject({
      lead: "  ",
      rows: [["a"], ["1"]],
    });
    expect(markdownRenderer.render(quoted)).toContain("<table>");
  });

  // What a cell holds while it is edited is the text markdown-it draws it
  // from, in the lines Lezer reads as the table.
  it.each(samples)("%j: a cell's text is markdown-it's cell", (src) => {
    const { grid } = model(src);
    const want = mditCells(src);
    expect(grid.rows.map((r) => r.slice(0, grid.aligns.length))).toEqual(want);
  });

  it.each(samples)("%j: a row's cells are Lezer's TableCell nodes", (src) => {
    const { grid } = model(src);
    const rows: string[][] = [];
    parser.parse(src).iterate({
      enter: (n) => {
        if (n.name === "TableHeader" || n.name === "TableRow") rows.push([]);
        if (n.name === "TableCell")
          rows[rows.length - 1].push(
            src.slice(n.from, n.to).trim().replace(/\\\|/g, "|"),
          );
      },
    });
    const filled = grid.rows.map((r) => r.filter((x) => x !== ""));
    expect(filled).toEqual(rows.map((r) => r.filter((x) => x !== "")));
  });

  it("reads an empty cell and a cell the row lacks as empty", () => {
    const src = "| a | b |\n| - | - |\n|  | x |\n| y |";
    expect(model(src).grid.rows.slice(1)).toEqual([
      ["", "x"],
      ["y", ""],
    ]);
  });

  it("keeps the source for Live to draw through Preview's renderer", () => {
    const src = "| a |\n| - |\n| <b>x</b> |";
    expect(model(src).src).toBe(src);
    const html = markdownRenderer.render(src);
    expect(html).toContain("<table>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
  });

  it("has no Preview renderer of its own: markdown-it draws the table", () => {
    expect(TABLE.renderStatic).toBeUndefined();
  });
});

describe("table widget in its note", () => {
  const note =
    "| claim | source |\n| - | - |\n| fast [^1] | [paper][p] |\n\n[^1]: measured\n\n[p]: https://example.com/paper";
  const tableOf = (html: string) =>
    html.slice(html.indexOf("<table>"), html.indexOf("</table>\n") + 9);

  it("draws Preview's cells: footnote citations and reference links resolve", () => {
    for (const fm of ["", "---\ntype: x\n---\n"]) {
      const doc = Text.of((fm + note).split("\n"));
      const html = noteTableHtml(doc, fm.length);
      expect(html).toBe(tableOf(markdownRenderer.render(note)));
      expect(html).toContain('<a href="#fn1" id="fnref1">[1]</a>');
      expect(html).toContain('href="https://example.com/paper"');
      // Only the table: no footnote list under it.
      expect(html).not.toContain("footnotes");
    }
  });

  it("finds a table nested in a callout; none where there is no table", () => {
    const src = "> [!note] T\n> | a |\n> | - |\n> | b [^1] |\n\n[^1]: x";
    const doc = Text.of(src.split("\n"));
    expect(noteTableHtml(doc, src.indexOf("> | a"))).toContain("[1]</a>");
    expect(noteTableHtml(doc, 0)).toBeNull();
  });
});
