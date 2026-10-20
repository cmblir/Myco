// Where the caret is in a Live table's cell (./table.ts), a plain-text
// contenteditable holding one text node: at its text's edge, on its first
// or last line, and which key of the table's (tableModel CellKey) a
// keydown is there.

import type { CellKey } from "./tableModel";

/** The caret's offset in `cell`'s text; null when the selection is a range
 *  or elsewhere. */
export function caretOffset(cell: HTMLElement): number | null {
  const sel = cell.ownerDocument.getSelection();
  if (!sel?.rangeCount || !sel.isCollapsed || !cell.contains(sel.anchorNode))
    return null;
  const r = cell.ownerDocument.createRange();
  r.selectNodeContents(cell);
  r.setEnd(sel.anchorNode!, sel.anchorOffset);
  return r.toString().length;
}

/** The caret `at` characters into `cell`'s text (its one text node). */
export function setCaret(cell: HTMLElement, at: number): void {
  const doc = cell.ownerDocument;
  const r = doc.createRange();
  const text = cell.firstChild;
  if (text?.nodeType === Node.TEXT_NODE)
    r.setStart(text, Math.min(at, text.textContent?.length ?? 0));
  else r.setStart(cell, 0);
  r.collapse(true);
  const sel = doc.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
}

/** The caret is on the cell's first (`up`) or last line: no rect to read
 *  (an empty cell) counts as both. */
function onEdgeLine(cell: HTMLElement, up: boolean): boolean {
  const sel = cell.ownerDocument.getSelection();
  if (!sel?.rangeCount) return true;
  const caret = sel.getRangeAt(0).getClientRects()[0];
  const all = cell.ownerDocument.createRange();
  all.selectNodeContents(cell);
  const lines = all.getClientRects();
  if (!caret || !lines.length) return true;
  return up
    ? caret.top < lines[0].bottom - 1
    : caret.bottom > lines[lines.length - 1].top + 1;
}

/** All of `cell`'s text, selected. */
export function selectText(cell: HTMLElement): void {
  const r = cell.ownerDocument.createRange();
  r.selectNodeContents(cell);
  const sel = cell.ownerDocument.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(r);
}

/** The key a cell answers, when it does: an arrow only from the text's
 *  edge, so it moves through the text first. ⌘A selects the cell's own
 *  text: the browser's select-all would reach the editor's root, the note. */
export function cellKey(
  e: KeyboardEvent,
  cell: HTMLElement,
): CellKey | "SelectAll" | null {
  if (e.altKey) return null;
  if (e.metaKey || e.ctrlKey)
    return !e.shiftKey && e.key.toLowerCase() === "a" ? "SelectAll" : null;
  const text = cell.textContent ?? "";
  switch (e.key) {
    case "Tab":
      return e.shiftKey ? "Shift-Tab" : "Tab";
    case "Enter":
      return "Enter";
  }
  if (e.shiftKey) return null;
  switch (e.key) {
    case "ArrowUp":
    case "ArrowDown":
      return onEdgeLine(cell, e.key === "ArrowUp") ? e.key : null;
    case "ArrowLeft":
      return caretOffset(cell) === 0 ? e.key : null;
    case "ArrowRight":
      return caretOffset(cell) === text.length ? e.key : null;
  }
  return null;
}
