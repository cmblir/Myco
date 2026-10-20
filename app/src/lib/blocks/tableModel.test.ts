import { describe, expect, it } from "vitest";
import {
  backspaceRemovesRow,
  cellMove,
  deleteColumn,
  deleteRow,
  emptyGrid,
  gridEdit,
  gridMarkdown,
  insertColumn,
  insertRow,
  parseGrid,
  setAlign,
  setCell,
  type Grid,
} from "./tableModel";
import { markdownRenderer } from "../markdown";

/** Each rendered row's cells as markdown-it reads them, the header first. */
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

const grid = (src: string): Grid => {
  const g = parseGrid(src);
  expect(g).not.toBeNull();
  return g!;
};
/** The cells a reader sees: each row cut to the table's width. */
const seen = (g: Grid) => g.rows.map((r) => r.slice(0, g.aligns.length));

describe("parseGrid", () => {
  it.each([
    "| a | b |\n| --- | :-: |\n| 1 | `x\\|y` |\n| only |",
    "a | b\n--- | ---\n1 | 2 | 3",
    "|  | b |\n|-|-|\n|  |  |",
    "| **bold** | [[note]] |\n| :-- | --: |\n| x |  y  |",
    "| a \\\\| b |\n| - |",
  ])("%j: a cell's text is markdown-it's", (src) => {
    expect(seen(grid(src))).toEqual(mditCells(src));
  });

  it("reads each column's alignment from the delimiter row", () => {
    expect(grid("| a | b | c | d |\n| --- | :-- | :-: | --: |").aligns).toEqual(
      ["", "left", "center", "right"],
    );
  });

  it("keeps the container marks the first line starts with", () => {
    expect(grid("> | a |\n> | - |\n> | 1 |")).toEqual({
      lead: "> ",
      rows: [["a"], ["1"]],
      aligns: [""],
    });
    expect(grid("  | a |\n  | - |").lead).toBe("  ");
    expect(grid(">   | a |\n>   | - |").lead).toBe(">   ");
  });

  it("pads a short row and keeps the cells past the header's width", () => {
    // markdown-it draws neither, but a write must not lose the text.
    expect(grid("| a | b |\n| - | - |\n| 1 |\n| 1 | 2 | 3 |").rows).toEqual([
      ["a", "b"],
      ["1", ""],
      ["1", "2", "3"],
    ]);
  });

  it("is null for fewer than two lines", () => {
    expect(parseGrid("| a |")).toBeNull();
  });
});

describe("gridMarkdown", () => {
  it("writes a GFM pipe table with single spaces", () => {
    expect(gridMarkdown(grid("a|b\n-|-\n1|2"))).toBe(
      "| a | b |\n| --- | --- |\n| 1 | 2 |",
    );
  });

  it("round-trips a written table byte for byte", () => {
    for (const src of [
      "| a | b |\n| --- | --- |\n| 1 | 2 |",
      "|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |",
      "| x | y |\n| :--- | ---: |\n| a \\| b | `c\\|d` |",
      "> | 이름 | 값 |\n> | :---: | --- |\n> | 가 | 1 |",
      "  | a |\n  | --- |",
    ])
      expect(gridMarkdown(grid(src))).toBe(src);
  });

  it("writes `|` typed in a cell as `\\|`, and a newline as a space", () => {
    const g = setCell(grid("| a |\n| - |\n| 1 |"), 1, 0, "x | y\nz");
    const md = gridMarkdown(g);
    expect(md).toBe("| a |\n| --- |\n| x \\| y z |");
    expect(mditCells(md)[1]).toEqual(["x | y z"]);
    expect(grid(md).rows[1][0]).toBe("x | y z");
  });

  it("keeps inline markdown typed in a cell as typed", () => {
    const g = setCell(emptyGrid(2, 2), 0, 0, "**굵게** [[링크]]");
    expect(gridMarkdown(g).split("\n")[0]).toBe("| **굵게** [[링크]] |  |");
  });

  it("keeps a quote's or list item's marks on every line, new ones too", () => {
    const g = insertRow(grid("> | a |\n> | - |\n> | 1 |"), 2);
    expect(gridMarkdown(g)).toBe("> | a |\n> | --- |\n> | 1 |\n> |  |");
    const item = insertColumn(grid("  | a |\n  | :-: |"), 1);
    expect(gridMarkdown(item)).toBe("  | a |  |\n  | :---: | --- |");
  });

  it("writes the cells past the header's width as they were", () => {
    const g = setCell(grid("| a |\n| - |\n| 1 | hidden |"), 1, 0, "2");
    expect(gridMarkdown(g)).toBe("| a |\n| --- |\n| 2 | hidden |");
  });
});

describe("gridEdit: only a change is written", () => {
  const src = "a|b\n-|-\n1|2"; // not in the written form
  it("is null while the cells say what they said", () => {
    const g = grid(src);
    expect(gridEdit(g, setCell(g, 1, 0, "1"))).toBeNull();
    expect(gridEdit(g, setCell(g, 1, 0, " 1 "))).toBeNull();
  });
  it("is the whole table, written out, once a cell changes", () => {
    const g = grid(src);
    expect(gridEdit(g, setCell(g, 1, 1, "3"))).toBe(
      "| a | b |\n| --- | --- |\n| 1 | 3 |",
    );
  });
});

describe("rows and columns", () => {
  const g = grid("| a | b |\n| :-- | --: |\n| 1 | 2 |\n| 3 | 4 |");

  it("adds an empty row above or below any row", () => {
    expect(insertRow(g, 1).rows).toEqual([
      ["a", "b"],
      ["", ""],
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(insertRow(g, 3).rows.at(-1)).toEqual(["", ""]);
    // Above the header: the new row is the header.
    expect(insertRow(g, 0).rows.slice(0, 2)).toEqual([
      ["", ""],
      ["a", "b"],
    ]);
  });

  it("adds an empty, unaligned column left or right of any column", () => {
    const left = insertColumn(g, 0);
    expect(left.rows[0]).toEqual(["", "a", "b"]);
    expect(left.aligns).toEqual(["", "left", "right"]);
    const right = insertColumn(g, 2);
    expect(right.rows[2]).toEqual(["3", "4", ""]);
    expect(right.aligns).toEqual(["left", "right", ""]);
  });

  it("deletes a row or a column, never the last one", () => {
    expect(deleteRow(g, 1)!.rows).toEqual([
      ["a", "b"],
      ["3", "4"],
    ]);
    // The header goes: the next row is the header now.
    expect(deleteRow(g, 0)!.rows[0]).toEqual(["1", "2"]);
    expect(deleteRow(grid("| a |\n| - |"), 0)).toBeNull();
    const one = deleteColumn(g, 0)!;
    expect(one.rows).toEqual([["b"], ["2"], ["4"]]);
    expect(one.aligns).toEqual(["right"]);
    expect(deleteColumn(one, 0)).toBeNull();
  });

  it("aligns a column: `:---`, `:---:`, `---:`", () => {
    const md = (a: Grid) => gridMarkdown(a).split("\n")[1];
    expect(md(setAlign(g, 0, "center"))).toBe("| :---: | ---: |");
    expect(md(setAlign(g, 1, "left"))).toBe("| :--- | :--- |");
    expect(md(setAlign(g, 0, "right"))).toBe("| ---: | ---: |");
  });

  it("makes /table's grid: 3 columns, 3 rows with the header, all empty", () => {
    expect(gridMarkdown(emptyGrid(3, 3))).toBe(
      "|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |",
    );
  });
});

describe("cellMove — the keys in a cell", () => {
  const g = emptyGrid(2, 3); // rows 0..2, columns 0..1

  it("Tab and Shift+Tab go to the next and previous cell", () => {
    expect(cellMove(g, 0, 0, "Tab")).toEqual({ to: [0, 1] });
    expect(cellMove(g, 0, 1, "Tab")).toEqual({ to: [1, 0] });
    expect(cellMove(g, 1, 0, "Shift-Tab")).toEqual({ to: [0, 1] });
    expect(cellMove(g, 0, 0, "Shift-Tab")).toBeNull();
  });

  it("Tab in the last cell adds a row", () => {
    expect(cellMove(g, 2, 1, "Tab")).toEqual({ to: [3, 0], addRow: true });
  });

  it("Enter goes down, and adds a row in the last one", () => {
    expect(cellMove(g, 0, 1, "Enter")).toEqual({ to: [1, 1] });
    expect(cellMove(g, 2, 1, "Enter")).toEqual({ to: [3, 1], addRow: true });
  });

  it("the arrows go to the cell beside, and Up/Down leave at the edge rows", () => {
    expect(cellMove(g, 1, 0, "ArrowUp")).toEqual({ to: [0, 0] });
    expect(cellMove(g, 1, 0, "ArrowDown")).toEqual({ to: [2, 0] });
    expect(cellMove(g, 0, 1, "ArrowUp")).toEqual({ leave: "up" });
    expect(cellMove(g, 2, 0, "ArrowDown")).toEqual({ leave: "down" });
    expect(cellMove(g, 1, 0, "ArrowRight")).toEqual({
      to: [1, 1],
      start: true,
    });
    expect(cellMove(g, 1, 0, "ArrowLeft")).toEqual({ to: [0, 1] });
    expect(cellMove(g, 1, 1, "ArrowRight")).toEqual({
      to: [2, 0],
      start: true,
    });
    expect(cellMove(g, 0, 0, "ArrowLeft")).toBeNull();
    expect(cellMove(g, 2, 1, "ArrowRight")).toBeNull();
  });
});

describe("backspaceRemovesRow", () => {
  const g = grid("| a | b |\n| - | - |\n|  |  |\n| x |  |");
  it("is true in a body row whose every cell is empty", () => {
    expect(backspaceRemovesRow(g, 1)).toBe(true);
    expect(backspaceRemovesRow(g, 2)).toBe(false);
  });
  it("never takes the header: the table menu deletes that row", () => {
    expect(backspaceRemovesRow(emptyGrid(2, 2), 0)).toBe(false);
  });
});
