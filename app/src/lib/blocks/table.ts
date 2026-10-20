// GFM table, drawn in Live as a Notion simple table (docs/specs/2026-10-01,
// "Table"): always a grid, every cell a plain-text field. A cell shows
// Preview's HTML for itself (the note's renderer, vault text escaped)
// until it takes the caret; then its text as typed, `**굵게**` and all.
// Each input writes the whole table back (tableModel's written form) as
// one transaction over its own lines; a cell's editing session — until it
// loses the caret or 1 s passes without typing — is one undo step
// (BlockHost.write). The DOM a write comes back to is kept (update): a
// cell being typed in is never rebuilt, and nothing is written while an
// IME composes (Korean): compositionend writes. Preview needs nothing
// here: markdown-it's table rule draws the same table.

import type { BlockCtx, BlockHost, BlockSpec } from "./index";
import { drawMath } from "./math";
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
  type Align,
  type Grid,
} from "./tableModel";
import { caretOffset, cellKey, selectText, setCaret } from "./tableCaret";
import {
  focusMenu,
  popupMenu,
  type MenuGroup,
  type MenuItem,
} from "./tableMenu";

export interface TableModel {
  /** The table's lines as written, container marks included. */
  src: string;
  grid: Grid;
}

const ROW_PX = 40; // one row at Live's 17px/1.75, padding and border included
/** A typing pause this long ends the cell's undo step. */
const IDLE_MS = 1000;

/** The lines past each one's container marks, as Preview's renderer reads
 *  a table on its own. */
const body = (src: string): string => src.replace(/^[ \t>]*/gm, "");

/** Each row's cell HTML in Preview's rendering of the table. */
function cellHtml(html: string): string[][] {
  const tpl = document.createElement("template");
  // Preview's renderer output (vault text escaped, `html: false`).
  tpl.innerHTML = html;
  return [...tpl.content.querySelectorAll("tr")].map((tr) =>
    [...tr.children].map((cell) => cell.innerHTML),
  );
}

function button(cls: string, label: string, text: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = text;
  b.title = label;
  b.setAttribute("aria-label", label);
  // Out of the tab order: Tab moves between cells; ⌘/ opens the menu.
  b.tabIndex = -1;
  return b;
}

/** The live table in one widget element. */
class LiveTable {
  private src: string;
  private grid: Grid;
  private ctx: BlockCtx;
  /** Each cell's Preview HTML, as the note renders it now. */
  private html: string[][] = [];
  /** The HTML a cell shows; none while it holds its text as typed. */
  private readonly drawn = new WeakMap<HTMLElement, string>();
  private cells: HTMLElement[][] = [];
  private table = document.createElement("table");
  private readonly frame = document.createElement("div");
  private readonly handles: HTMLButtonElement[] = [];
  private menu: HTMLElement | null = null;
  /** This session's start (BlockHost.write), until the cell loses the
   *  caret or the typing pauses. */
  private session: number | undefined;
  private idle: ReturnType<typeof setTimeout> | undefined;
  private composing = false;
  /** The markdown this table last wrote: its update is our own. */
  private written: string | null = null;

  constructor(
    private readonly el: HTMLElement,
    p: TableModel,
    ctx: BlockCtx,
    private readonly host?: BlockHost,
  ) {
    this.src = p.src;
    this.grid = p.grid;
    this.ctx = ctx;
    const scroll = document.createElement("div");
    scroll.className = "tbl-scroll";
    this.frame.className = "tbl-frame";
    scroll.append(this.frame);
    el.append(scroll);
    this.html = cellHtml(ctx.renderBlock?.(body(p.src)) ?? "");
    this.build();
    if (!this.editable) return;
    const t = ctx.t;
    const addCol = button(
      "tbl-add tbl-add-col",
      t?.tbl_add_col ?? "Add a column",
      "+",
    );
    const addRow = button(
      "tbl-add tbl-add-row",
      t?.tbl_add_row ?? "Add a row",
      "+",
    );
    addCol.addEventListener("click", () => {
      const cols = this.grid.aligns.length;
      this.change(insertColumn(this.grid, cols), [0, cols]);
    });
    addRow.addEventListener("click", () => {
      const rows = this.grid.rows.length;
      this.change(insertRow(this.grid, rows), [rows, 0]);
    });
    const rowH = button(
      "tbl-handle is-row",
      t?.tbl_row_menu ?? "Row menu",
      "⋮⋮",
    );
    const colH = button(
      "tbl-handle is-col",
      t?.tbl_col_menu ?? "Column menu",
      "⋯",
    );
    rowH.hidden = colH.hidden = true;
    rowH.addEventListener("click", () => this.openMenu(true, false, rowH));
    colH.addEventListener("click", () => this.openMenu(false, true, colH));
    this.handles.push(rowH, colH);
    this.frame.append(addCol, rowH, colH);
    el.append(addRow);
    // As wide as the table shows in its scroll box (whose left padding
    // its negative offset gives back), as the table grows or shrinks (a
    // cell typed in, a column added) and the column narrows. The frame,
    // not the table, which build() replaces.
    const fit = () => {
      const shown = scroll.clientWidth + scroll.offsetLeft;
      addRow.style.width = `${Math.min(this.table.offsetWidth, shown)}px`;
    };
    const resized = new ResizeObserver(fit);
    resized.observe(this.frame);
    resized.observe(scroll);
    scroll.addEventListener("scroll", () => this.closeMenu());
    el.addEventListener("pointerover", (e) => {
      const pos = this.cellOf(
        e.target instanceof Element ? e.target.closest("th, td") : null,
      );
      if (pos) this.point(...pos);
    });
    el.addEventListener("pointerleave", () => {
      const at = this.activeCell();
      if (at) this.point(...at);
      else if (!this.menu) this.point(null);
    });
    const tb = this.frame;
    tb.addEventListener("keydown", this.onKey);
    tb.addEventListener("input", this.onInput);
    tb.addEventListener("focusin", this.onFocusIn);
    tb.addEventListener("focusout", this.onFocusOut);
    tb.addEventListener("paste", this.onPaste);
    tb.addEventListener("mousedown", this.onPress);
    tb.addEventListener("compositionstart", () => (this.composing = true));
    tb.addEventListener("compositionend", (e) => {
      this.composing = false;
      const pos = this.cellOf(e.target);
      if (pos) this.typed(...pos);
    });
  }

  get editable(): boolean {
    return !!this.host && !this.host.readOnly;
  }

  /** The first paint's math, typeset. */
  get ready(): Promise<void> {
    return drawMath(this.table);
  }

  /** A new source for this element (live.ts updateDOM): our own write, an
   *  undo, an edit elsewhere in the note. The cell holding the caret keeps
   *  its DOM unless its text really changed, and never mid-composition. */
  update(p: TableModel, ctx: BlockCtx): boolean {
    const own = p.src === this.written;
    if (!own) this.endSession();
    const shape = (g: Grid) =>
      g.rows.map((r) => r.length).join() + "/" + g.aligns.length;
    const reshaped = shape(p.grid) !== shape(this.grid);
    this.src = p.src;
    this.grid = p.grid;
    this.ctx = ctx;
    this.html = cellHtml(ctx.renderBlock?.(body(p.src)) ?? "");
    if (reshaped) {
      const at = this.activeCell();
      this.build();
      if (at) this.focusCell(...this.clamp(at));
      return true;
    }
    const active = this.activeCell();
    this.grid.rows.forEach((row, r) =>
      this.grid.aligns.forEach((align, c) => {
        const cell = this.cells[r][c];
        cell.style.textAlign = align;
        if (!active || active[0] !== r || active[1] !== c)
          return this.paint(r, c);
        const text = row[c];
        cell.classList.toggle("is-empty", (cell.textContent ?? "") === "");
        if (own || this.composing) return;
        if ((cell.textContent ?? "").replace(/\n/g, " ").trim() !== text) {
          cell.textContent = text;
          setCaret(cell, text.length);
        }
      }),
    );
    void drawMath(this.table).then(() => this.host?.remeasure());
    return true;
  }

  /** The table for the current grid, every cell painted. */
  private build(): void {
    const t = this.ctx.t;
    const table = document.createElement("table");
    const head = table.createTHead().insertRow();
    const tbody = table.createTBody();
    this.cells = this.grid.rows.map((_, r) => {
      const tr = r === 0 ? head : tbody.insertRow();
      return this.grid.aligns.map((align, c) => {
        const cell = document.createElement(r === 0 ? "th" : "td");
        cell.dataset.r = String(r);
        cell.dataset.c = String(c);
        cell.style.textAlign = align;
        if (r === 0)
          cell.dataset.ph = (t?.tbl_col_ph ?? "Column {n}").replace(
            "{n}",
            String(c + 1),
          );
        if (this.editable) {
          // Plain text only: a paste or a drop brings no markup in.
          cell.setAttribute("contenteditable", "plaintext-only");
          cell.spellcheck = false;
        }
        tr.append(cell);
        return cell;
      });
    });
    if (this.table.isConnected) this.table.replaceWith(table);
    else this.frame.prepend(table);
    this.table = table;
    this.grid.rows.forEach((row, r) =>
      row.slice(0, this.grid.aligns.length).forEach((_, c) => this.paint(r, c)),
    );
  }

  /** Cell [r, c] as Preview draws it (its text, before a render). */
  private paint(r: number, c: number): void {
    const cell = this.cells[r][c];
    const text = this.grid.rows[r][c];
    const html = this.html[r]?.[c];
    cell.classList.toggle("is-empty", text === "");
    if (html === undefined) {
      this.drawn.delete(cell);
      if (cell.textContent !== text) cell.textContent = text;
      return;
    }
    if (this.drawn.get(cell) === html) return;
    cell.innerHTML = html;
    this.drawn.set(cell, html);
  }

  private cellOf(target: EventTarget | null): [number, number] | null {
    if (!(target instanceof HTMLElement)) return null;
    const r = Number(target.dataset.r);
    const c = Number(target.dataset.c);
    return this.cells[r]?.[c] === target ? [r, c] : null;
  }

  private activeCell(): [number, number] | null {
    return this.cellOf(this.el.ownerDocument.activeElement);
  }

  private clamp([r, c]: [number, number]): [number, number] {
    return [
      Math.min(r, this.grid.rows.length - 1),
      Math.min(c, this.grid.aligns.length - 1),
    ];
  }

  /** The caret in cell [r, c], at its text's end (or start). */
  focusCell(r: number, c: number, start = false): void {
    const cell = this.cells[r]?.[c];
    if (!cell || !this.editable) return;
    cell.focus();
    setCaret(cell, start ? 0 : (cell.textContent ?? "").length);
  }

  private endSession(): void {
    clearTimeout(this.idle);
    this.session = undefined;
  }

  /** Cell [r, c]'s text, as typed, into the note: one write per input. */
  private typed(r: number, c: number): void {
    const cell = this.cells[r][c];
    const text = (cell.textContent ?? "").replace(/\r?\n/g, " ");
    cell.classList.toggle("is-empty", text === "");
    const next = setCell(this.grid, r, c, text);
    const md = gridEdit(this.grid, next);
    this.grid = next;
    this.host?.remeasure();
    if (md === null || !this.host) return;
    this.session ??= Date.now();
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.endSession(), IDLE_MS);
    this.written = md;
    this.host.write(this.src.length, md, this.session);
  }

  /** A change of shape (a row, a column, an alignment): its own undo step,
   *  then the caret in cell `to`. */
  private change(
    next: Grid | null,
    to?: [number, number],
    start?: boolean,
  ): void {
    if (!next || !this.host) return;
    this.endSession();
    const md = gridEdit(this.grid, next);
    if (md !== null) {
      this.written = md;
      this.host.write(this.src.length, md);
    }
    if (to) this.focusCell(...this.clamp(to), start);
  }

  private leave(to: "select" | "up" | "down"): void {
    this.endSession();
    this.point(null);
    this.host?.leave(to);
  }

  private onInput = (e: Event): void => {
    const pos = this.cellOf(e.target);
    if (!pos) return;
    // compositionend writes the composed text.
    if ((e as InputEvent).isComposing || this.composing) {
      this.host?.remeasure();
      return;
    }
    this.typed(...pos);
  };

  private onKey = (e: KeyboardEvent): void => {
    const pos = this.cellOf(e.target);
    if (!pos || !this.host) return;
    // The IME owns its keys (Enter commits a syllable, not a move).
    if (e.isComposing || e.keyCode === 229 || this.composing) return;
    const [r, c] = pos;
    const cell = this.cells[r][c];
    const done = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (mod && !e.altKey && (k === "z" || k === "y")) {
      done();
      this.endSession();
      this.host.undo(k === "y" || e.shiftKey);
      return;
    }
    if (mod && e.key === "/") {
      done();
      this.openMenu(true, true, cell);
      return;
    }
    if (e.key === "Escape") {
      done();
      this.leave("select");
      return;
    }
    if (
      e.key === "Backspace" &&
      !mod &&
      (cell.textContent ?? "") === "" &&
      backspaceRemovesRow(this.grid, r)
    ) {
      done();
      this.change(deleteRow(this.grid, r), [r - 1, c]);
      return;
    }
    const key = cellKey(e, cell);
    if (key === "SelectAll") {
      done();
      selectText(cell);
      return;
    }
    // Never a tab out of the note, never a newline in a cell.
    if (e.key === "Tab" || e.key === "Enter") done();
    const mv = key && cellMove(this.grid, r, c, key);
    if (!mv) return;
    done();
    if ("leave" in mv) this.leave(mv.leave);
    else if (mv.addRow)
      this.change(insertRow(this.grid, this.grid.rows.length), mv.to, mv.start);
    else this.focusCell(...mv.to, mv.start);
  };

  /** Mod-click on a link in a cell follows it (live.ts's click handler);
   *  any other press puts the caret in the cell. */
  private onPress = (e: MouseEvent): void => {
    const link = e.target instanceof Element ? e.target.closest("a") : null;
    if (link && (e.metaKey || e.ctrlKey) && !this.activeCell())
      e.preventDefault();
  };

  /** The cell takes the caret: its text as typed in place of its HTML,
   *  the caret about where it was. */
  private onFocusIn = (e: FocusEvent): void => {
    const pos = this.cellOf(e.target);
    if (!pos) return;
    const [r, c] = pos;
    const cell = this.cells[r][c];
    const text = this.grid.rows[r][c];
    this.drawn.delete(cell);
    if (cell.textContent !== text || cell.childElementCount) {
      const at = caretOffset(cell);
      cell.textContent = text;
      setCaret(cell, at ?? text.length);
    }
    this.point(r, c);
  };

  /** The cell gives the caret up: its session ends, and it draws again. */
  private onFocusOut = (e: FocusEvent): void => {
    const pos = this.cellOf(e.target);
    if (!pos) return;
    this.endSession();
    this.composing = false;
    this.paint(...pos);
    void drawMath(this.cells[pos[0]][pos[1]]).then(() =>
      this.host?.remeasure(),
    );
    const to = e.relatedTarget;
    if (!(to instanceof Node && this.el.contains(to))) this.point(null);
  };

  /** A paste is one line of plain text. */
  private onPaste = (e: ClipboardEvent): void => {
    const pos = this.cellOf(e.target);
    if (!pos) return;
    e.preventDefault();
    const text = (e.clipboardData?.getData("text/plain") ?? "").replace(
      /\s*\r?\n\s*/g,
      " ",
    );
    const sel = this.el.ownerDocument.getSelection();
    if (!sel?.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = this.el.ownerDocument.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    this.typed(...pos);
  };

  /** The row and column handles beside cell [r, c]; null hides them. */
  private point(r: number | null, c = 0): void {
    const [rowH, colH] = this.handles;
    if (!rowH || this.menu) return;
    rowH.hidden = colH.hidden = r === null;
    if (r === null) return;
    const tr = this.cells[r][0].parentElement!;
    const th = this.cells[0][c];
    const top = this.table.offsetTop;
    rowH.dataset.r = String(r);
    rowH.style.top = `${top + tr.offsetTop + tr.offsetHeight / 2}px`;
    colH.dataset.c = String(c);
    colH.style.left = `${this.table.offsetLeft + th.offsetLeft + th.offsetWidth / 2}px`;
    colH.style.top = `${top}px`;
  }

  /** The row (and/or column) menu for the cell the handles point at, or
   *  the cell holding the caret, under `anchor`. */
  private openMenu(rows: boolean, cols: boolean, anchor: HTMLElement): void {
    this.closeMenu();
    const t = this.ctx.t;
    const [rowH, colH] = this.handles;
    const fromCell = anchor.tagName !== "BUTTON" && this.activeCell();
    const [r, c] = fromCell || [
      Number(rowH.dataset.r ?? 0),
      Number(colH.dataset.c ?? 0),
    ];
    const back = this.el.ownerDocument.activeElement;
    // Each item reads the grid as it is when it runs.
    const run = (next: () => Grid | null, to: [number, number]) => () =>
      this.change(next(), to);
    const g = this.grid;
    const items: MenuItem[] = [];
    if (rows)
      items.push(
        {
          label: t?.tbl_row_above ?? "Add row above",
          run: run(() => insertRow(this.grid, r), [r, c]),
        },
        {
          label: t?.tbl_row_below ?? "Add row below",
          run: run(() => insertRow(this.grid, r + 1), [r + 1, c]),
        },
      );
    if (cols)
      items.push(
        {
          label: t?.tbl_col_left ?? "Add column left",
          run: run(() => insertColumn(this.grid, c), [r, c]),
        },
        {
          label: t?.tbl_col_right ?? "Add column right",
          run: run(() => insertColumn(this.grid, c + 1), [r, c + 1]),
        },
      );
    if (rows)
      items.push({
        label: t?.tbl_row_delete ?? "Delete row",
        run: run(() => deleteRow(this.grid, r), [r, c]),
        off: g.rows.length < 2,
      });
    if (cols)
      items.push({
        label: t?.tbl_col_delete ?? "Delete column",
        run: run(() => deleteColumn(this.grid, c), [r, c]),
        off: g.aligns.length < 2,
      });
    const groups: MenuGroup[] = [{ items }];
    if (cols) {
      const aligns: [Align, string][] = [
        ["left", t?.tbl_align_left ?? "Left"],
        ["center", t?.tbl_align_center ?? "Center"],
        ["right", t?.tbl_align_right ?? "Right"],
      ];
      groups.push({
        label: t?.tbl_align ?? "Align",
        items: aligns.map(([a, label]) => ({
          label,
          run: run(() => setAlign(this.grid, c, a), [r, c]),
          // An unaligned column reads as left-aligned.
          checked: (g.aligns[c] || "left") === a,
        })),
      });
    }
    const label =
      rows && cols
        ? (t?.tbl_menu ?? "Table menu")
        : rows
          ? (t?.tbl_row_menu ?? "Row menu")
          : (t?.tbl_col_menu ?? "Column menu");
    const menu = popupMenu(label, groups, (refocus) => {
      this.closeMenu();
      if (!refocus) return;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
      else this.focusCell(r, c);
    });
    this.el.append(menu);
    const box = this.el.getBoundingClientRect();
    const at = anchor.getBoundingClientRect();
    // Inside the column: the editor's scroller clips past its edge.
    const room = box.width - menu.offsetWidth;
    menu.style.left = `${Math.max(0, Math.min(at.left - box.left, room))}px`;
    menu.style.top = `${at.bottom - box.top + 4}px`;
    // Opened near the editor's bottom edge, it scrolls into view whole.
    menu.scrollIntoView({ block: "nearest" });
    this.menu = menu;
    focusMenu(menu);
  }

  private closeMenu(): void {
    const m = this.menu;
    this.menu = null;
    m?.remove();
  }
}

/** The live tables, by the widget element `mount` filled. */
const tables = new WeakMap<HTMLElement, LiveTable>();

export const TABLE: BlockSpec<TableModel> = {
  id: "table",
  match: { node: "Table", token: "table_open" },
  // `/table`: 3 columns × 3 rows, the header included, every cell empty.
  template: gridMarkdown(emptyGrid(3, 3)),
  parse(src) {
    const grid = parseGrid(src);
    return grid && { src, grid };
  },
  mount(el, p, ctx, _edit, host) {
    const t = new LiveTable(el, p, ctx, host);
    tables.set(el, t);
    // A cell's `$…$` before KaTeX is in.
    return t.ready;
  },
  update: (el, p, ctx) => tables.get(el)?.update(p, ctx) ?? false,
  openEditor: (el) => tables.get(el)?.focusCell(0, 0),
  estimatedHeight: (p) => p.grid.rows.length * ROW_PX + 8,
  // A footnote or link definition elsewhere in the note changes the cells.
  key: (p, { renderBlock }) => renderBlock?.(body(p.src)) ?? "",
};
