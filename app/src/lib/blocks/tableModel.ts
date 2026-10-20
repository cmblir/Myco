// A GFM table as a Notion simple table edits it (./table.ts): a grid of
// cell texts, as typed (`\|` read as `|`), and each column's alignment.
// The split is markdown-it's (escapedSplit): an unescaped `|` ends a cell,
// even inside code. A write is the whole table in one written form — `| a |`
// with single spaces, `|` escaped, every line led by the container marks of
// the first (a quote's `> `, an item's indent) — and only once a cell says
// something else (gridEdit): an untouched table stays as written. Pure
// (vitest, node).

export type Align = "" | "left" | "center" | "right";

export interface Grid {
  /** The container marks the first line starts with; every line is
   *  written with them. */
  lead: string;
  /** The header first. A row holds at least one cell per column; cells
   *  past the header's width (markdown-it draws none) are kept as written. */
  rows: string[][];
  /** One per column: the table's width. */
  aligns: Align[];
}

const LEAD_RE = /^[ \t>]*/;

/** One row's cells, as markdown-it's escapedSplit cuts them: past the
 *  outer pipes, trimmed, `\|` read as `|`. */
function splitRow(line: string): string[] {
  const s = line.trim();
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "|") cur += s[i];
    else if (s[i - 1] === "\\") cur = cur.slice(0, -1) + "|";
    else {
      cells.push(cur);
      cur = "";
    }
  }
  cells.push(cur);
  if (cells.length && cells[0] === "") cells.shift();
  if (cells.length && cells[cells.length - 1] === "") cells.pop();
  return cells.map((c) => c.trim());
}

/** The delimiter row's alignments, as markdown-it reads them. */
function splitAligns(line: string): Align[] {
  const out: Align[] = [];
  line.split("|").forEach((raw) => {
    const t = raw.trim();
    if (!t) return;
    const l = t.startsWith(":");
    const r = t.endsWith(":");
    out.push(l && r ? "center" : r ? "right" : l ? "left" : "");
  });
  return out;
}

/** `src`: the table's lines as written, container marks included. */
export function parseGrid(src: string): Grid | null {
  const lines = src.split("\n");
  if (lines.length < 2) return null;
  const lead = LEAD_RE.exec(lines[0])?.[0] ?? "";
  const body = lines.map((l) => l.slice(LEAD_RE.exec(l)?.[0].length ?? 0));
  const head = splitRow(body[0]);
  const width = head.length;
  const aligns = splitAligns(body[1]).slice(0, width);
  while (aligns.length < width) aligns.push("");
  const rows = [head, ...body.slice(2).map(splitRow)].map((r) => {
    while (r.length < width) r.push("");
    return r;
  });
  return { lead, rows, aligns };
}

const DELIM: Record<Align, string> = {
  "": "---",
  left: ":---",
  center: ":---:",
  right: "---:",
};

/** A cell's text as written: one line, trimmed, `|` escaped. */
const written = (text: string): string =>
  text.replace(/\r?\n/g, " ").trim().replace(/\|/g, "\\|");

const line = (cells: readonly string[]): string =>
  "| " + cells.join(" | ") + " |";

export function gridMarkdown(g: Grid): string {
  const [head, ...body] = g.rows;
  return [
    line(head.map(written)),
    line(g.aligns.map((a) => DELIM[a])),
    ...body.map((r) => line(r.map(written))),
  ]
    .map((l) => g.lead + l)
    .join("\n");
}

/** What a write of `next` over the table `now` puts in the note: null
 *  while every cell says what it said, so an untouched table keeps its
 *  bytes. */
export function gridEdit(now: Grid, next: Grid): string | null {
  const md = gridMarkdown(next);
  return md === gridMarkdown(now) ? null : md;
}

/** `cols` × `rows` empty cells, the header row included. */
export function emptyGrid(cols: number, rows: number, lead = ""): Grid {
  return {
    lead,
    rows: Array.from({ length: rows }, () => Array<string>(cols).fill("")),
    aligns: Array<Align>(cols).fill(""),
  };
}

export function setCell(g: Grid, r: number, c: number, text: string): Grid {
  const rows = g.rows.map((row, i) =>
    i === r ? row.map((x, j) => (j === c ? text : x)) : row,
  );
  return { ...g, rows };
}

/** An empty row at index `at` (0: a new header). */
export function insertRow(g: Grid, at: number): Grid {
  const rows = [...g.rows];
  rows.splice(at, 0, Array<string>(g.aligns.length).fill(""));
  return { ...g, rows };
}

/** Null for the last row: deleting the table is the block's own delete. */
export function deleteRow(g: Grid, r: number): Grid | null {
  if (g.rows.length < 2) return null;
  return { ...g, rows: g.rows.filter((_, i) => i !== r) };
}

/** An empty, unaligned column at index `at`. */
export function insertColumn(g: Grid, at: number): Grid {
  const ins = <T>(xs: readonly T[], x: T): T[] => {
    const out = [...xs];
    out.splice(at, 0, x);
    return out;
  };
  return {
    ...g,
    rows: g.rows.map((r) => ins(r, "")),
    aligns: ins(g.aligns, ""),
  };
}

/** Null for the last column. */
export function deleteColumn(g: Grid, c: number): Grid | null {
  if (g.aligns.length < 2) return null;
  return {
    ...g,
    rows: g.rows.map((r) => r.filter((_, j) => j !== c)),
    aligns: g.aligns.filter((_, j) => j !== c),
  };
}

export function setAlign(g: Grid, c: number, a: Align): Grid {
  return { ...g, aligns: g.aligns.map((x, j) => (j === c ? a : x)) };
}

/** The keys a cell answers (ArrowLeft/Right only at the text's edge). */
export type CellKey =
  | "Tab"
  | "Shift-Tab"
  | "Enter"
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight";

/** Where a key goes from cell [r, c]: another cell (the caret at its end,
 *  or its start with `start`), first adding a row at the end (`addRow`),
 *  or out of the table. Null: the key does nothing. */
export type CellMove =
  | { to: [number, number]; start?: true; addRow?: true }
  | { leave: "up" | "down" }
  | null;

export function cellMove(
  g: Grid,
  r: number,
  c: number,
  key: CellKey,
): CellMove {
  const rows = g.rows.length;
  const cols = g.aligns.length;
  const last = r === rows - 1;
  switch (key) {
    case "Tab":
      if (c < cols - 1) return { to: [r, c + 1] };
      return last ? { to: [rows, 0], addRow: true } : { to: [r + 1, 0] };
    case "Shift-Tab":
      if (c > 0) return { to: [r, c - 1] };
      return r > 0 ? { to: [r - 1, cols - 1] } : null;
    case "Enter":
      return last ? { to: [rows, c], addRow: true } : { to: [r + 1, c] };
    case "ArrowUp":
      return r > 0 ? { to: [r - 1, c] } : { leave: "up" };
    case "ArrowDown":
      return last ? { leave: "down" } : { to: [r + 1, c] };
    case "ArrowLeft":
      if (c > 0) return { to: [r, c - 1] };
      return r > 0 ? { to: [r - 1, cols - 1] } : null;
    case "ArrowRight":
      if (c < cols - 1) return { to: [r, c + 1], start: true };
      return last ? null : { to: [r + 1, 0], start: true };
  }
}

/** Backspace in an empty cell of row `r` removes the row: a body row whose
 *  every cell is empty. The header goes only from the table menu. */
export function backspaceRemovesRow(g: Grid, r: number): boolean {
  return r > 0 && g.rows[r].every((x) => x.trim() === "");
}
