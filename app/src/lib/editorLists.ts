// List structure edits for the block editor: nesting and lifting items (Tab /
// Shift-Tab, in columns so tab indents and quotes work), the marker a new
// sibling gets, and keeping ordered lists numbered. Pure over EditorState.

import {
  countColumn,
  type ChangeSpec,
  type EditorState,
  type Line,
  type Transaction,
} from "@codemirror/state";
import { indentLess, indentMore } from "@codemirror/commands";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import {
  TAB,
  ancestors,
  fullTree,
  hasText,
  inFrontmatter,
  isBlank,
  prefixEnd,
} from "./editorMarks";

const ORDERED_RE = /^(\d+)([.)])$/;

/** Changes renumbering every ordered list in [from,to] from its first item. */
function renumber(state: EditorState, from: number, to: number): ChangeSpec[] {
  const tree = ensureSyntaxTree(state, to, 50) ?? syntaxTree(state);
  const out: ChangeSpec[] = [];
  tree.iterate({
    from,
    to,
    enter(n) {
      if (n.name !== "OrderedList") return;
      let next = -1;
      for (let item = n.node.firstChild; item; item = item.nextSibling) {
        const mark =
          item.name === "ListItem" ? item.getChild("ListMark") : null;
        const m = mark && ORDERED_RE.exec(state.sliceDoc(mark.from, mark.to));
        if (!mark || !m) continue;
        if (next < 0) next = Number(m[1]);
        else if (Number(m[1]) !== next)
          out.push({
            from: mark.from,
            to: mark.from + m[1].length,
            insert: String(next),
          });
        next++;
      }
    },
  });
  return out;
}

/** Apply `changes` (caret at `anchor` in the new doc, else mapped), then
 *  renumber the ordered lists in `list`'s range — one undo step. Null when
 *  nothing would change, so the key falls through instead of vanishing. */
export function withRenumber(
  state: EditorState,
  changes: ChangeSpec[],
  list: SyntaxNode,
  userEvent: string,
  anchor?: number,
): Transaction | null {
  const first = state.update(
    anchor === undefined ? { changes } : { changes, selection: { anchor } },
  );
  if (first.changes.empty) return null;
  const next = first.state;
  const from = first.changes.mapPos(list.from, -1);
  const to = first.changes.mapPos(list.to, 1);
  const fix = next.changes(renumber(next, from, to));
  return state.update({
    changes: first.changes.compose(fix),
    selection: next.selection.map(fix),
    scrollIntoView: true,
    userEvent,
  });
}

/** The ordered items after `item` restart at 1: they open a list of their
 *  own once the line between them has text. Numbered here, not by a re-parse —
 *  until then the parser still reads one list across the blank lines. */
export function restartAfter(
  state: EditorState,
  item: SyntaxNode,
): ChangeSpec[] {
  const out: ChangeSpec[] = [];
  let n = 1;
  for (let next = item.nextSibling; next; next = next.nextSibling) {
    if (next.name === "QuoteMark") continue;
    const mark = next.name === "ListItem" ? next.getChild("ListMark") : null;
    const m = mark && ORDERED_RE.exec(state.sliceDoc(mark.from, mark.to));
    if (!mark || !m) break;
    if (Number(m[1]) !== n)
      out.push({
        from: mark.from,
        to: mark.from + m[1].length,
        insert: String(n),
      });
    n++;
  }
  return out;
}

/** Marker text for a new sibling after `item`: its first line's prefix
 *  (quote marks and indent included), numbered on, to-do unchecked. */
export function nextMarker(state: EditorState, item: SyntaxNode): string {
  const first = state.doc.lineAt(item.from);
  return first.text
    .slice(0, prefixEnd(state, first) - first.from)
    .replace(/(\d+)([.)])/, (_, n: string, d: string) => String(+n + 1) + d)
    .replace(/\[[xX]\]/, "[ ]");
}

/** Width from a list item's line start to its text — where children nest. */
function contentColumn(state: EditorState, item: SyntaxNode): number {
  const line = state.doc.lineAt(item.from);
  const mark = item.getChild("ListMark");
  if (!mark) return item.from - line.from;
  let p = mark.to;
  while (
    p < line.to &&
    p - mark.to < 4 &&
    isBlank(line.text.charAt(p - line.from))
  )
    p++;
  return p - line.from;
}

function itemLines(state: EditorState, item: SyntaxNode): Line[] {
  const out: Line[] = [];
  const last = state.doc.lineAt(item.to).number;
  for (let n = state.doc.lineAt(item.from).number; n <= last; n++) {
    const l = state.doc.line(n);
    if (hasText(l.text)) out.push(l);
  }
  return out;
}

/** Quotes the item sits in: that many `>` on each of its lines belong to the
 *  container, and any after them to its own content (a child quote). */
function quoteDepth(item: SyntaxNode): number {
  let d = 0;
  for (let n = item.parent; n; n = n.parent) if (n.name === "Blockquote") d++;
  return d;
}

/** A line's indent, past at most `depth` quote marks. */
function indentSpan(text: string, depth: number): { from: number; to: number } {
  let from = 0;
  for (let d = 0; d < depth; d++) {
    const m = /^[ \t]*>[ \t]?/.exec(text.slice(from));
    if (!m) break;
    from += m[0].length;
  }
  let to = from;
  while (to < text.length && isBlank(text.charAt(to))) to++;
  return { from, to };
}

const markerColumn = (state: EditorState, item: SyntaxNode): number => {
  const line = state.doc.lineAt(item.from);
  return countColumn(line.text, TAB, item.from - line.from);
};

function prevItem(item: SyntaxNode): SyntaxNode | null {
  let prev = item.prevSibling;
  // Inside a quote each continuation line's `>` sits between the items.
  while (prev && prev.name === "QuoteMark") prev = prev.prevSibling;
  return prev && prev.name === "ListItem" ? prev : null;
}

/** Columns `item` must move right to nest under its previous sibling. */
function nestDelta(state: EditorState, item: SyntaxNode): number {
  const prev = prevItem(item);
  if (!prev) return 0;
  const prevLine = state.doc.lineAt(prev.from);
  // In columns, not characters: a tab-indented list nests only past its tab stop.
  const target = countColumn(prevLine.text, TAB, contentColumn(state, prev));
  return target - markerColumn(state, item);
}

function padItem(
  state: EditorState,
  item: SyntaxNode,
  delta: number,
): ChangeSpec[] {
  const depth = quoteDepth(item);
  return itemLines(state, item).map((l) => ({
    from: l.from + indentSpan(l.text, depth).to,
    insert: " ".repeat(delta),
  }));
}

function unpadItem(
  state: EditorState,
  item: SyntaxNode,
  delta: number,
): ChangeSpec[] {
  const depth = quoteDepth(item);
  return itemLines(state, item).map((l) => {
    const { from, to } = indentSpan(l.text, depth);
    const start = countColumn(l.text, TAB, from);
    const end = countColumn(l.text, TAB, to);
    const width = Math.max(start, end - delta) - start;
    const ws = l.text.slice(from, to);
    // Keep a tab-indented list in tabs when the columns allow it.
    const insert =
      /^\t+$/.test(ws) && start % TAB === 0 && width % TAB === 0
        ? "\t".repeat(width / TAB)
        : " ".repeat(width);
    return { from: l.from + from, to: l.from + to, insert };
  });
}

/** A moved ordered item that opens a new sublist starts it at 1. */
function restartMoved(state: EditorState, item: SyntaxNode): ChangeSpec[] {
  const prev = prevItem(item);
  const mark = item.getChild("ListMark");
  const m = mark && ORDERED_RE.exec(state.sliceDoc(mark.from, mark.to));
  return mark && m && prev?.lastChild?.name !== "OrderedList"
    ? [{ from: mark.from, to: mark.from + m[1].length, insert: "1" }]
    : [];
}

function liftable(item: SyntaxNode): SyntaxNode | null {
  const parent = item.parent?.parent;
  return parent && parent.name === "ListItem" ? parent : null;
}

function liftDelta(state: EditorState, item: SyntaxNode): number {
  const parent = liftable(item);
  return parent ? markerColumn(state, item) - markerColumn(state, parent) : 0;
}

/** Nest `items` (siblings, in order) under the first one's previous sibling. */
export function indentItems(
  state: EditorState,
  items: SyntaxNode[],
): Transaction | null {
  const delta = nestDelta(state, items[0]);
  if (delta <= 0) return null;
  const changes = [
    ...items.flatMap((it) => padItem(state, it, delta)),
    ...restartMoved(state, items[0]),
  ];
  const list = items[0].parent;
  return list ? withRenumber(state, changes, list, "input.indent") : null;
}

/** Lift each of `items` one level; siblings left behind hang under the last
 *  and restart at 1. */
export function outdentItems(
  state: EditorState,
  items: SyntaxNode[],
): Transaction | null {
  const lifted = items.filter((it) => liftDelta(state, it) > 0);
  if (!lifted.length) return null;
  const changes = lifted.flatMap((it) =>
    unpadItem(state, it, liftDelta(state, it)),
  );
  changes.push(...restartAfter(state, lifted[lifted.length - 1]));
  const outer = liftable(lifted[0])?.parent ?? lifted[0];
  return withRenumber(state, changes, outer, "input.indent");
}

/** The top-most list items a selection covers (the caret's own item when
 *  the selection is empty). */
function selectedItems(state: EditorState): SyntaxNode[] {
  const { main } = state.selection;
  const own = ancestors(state, main.head).find((n) => n.name === "ListItem");
  if (main.empty) return own ? [own] : [];
  const { doc } = state;
  const first = doc.lineAt(main.from).number;
  const last = doc.lineAt(main.to).number;
  const out: SyntaxNode[] = [];
  fullTree(state).iterate({
    from: main.from,
    to: main.to,
    enter(n) {
      if (n.name !== "ListItem") return;
      const line = doc.lineAt(n.from).number;
      if (line < first || line > last) return;
      out.push(n.node);
      return false; // its children move with it
    },
  });
  return out.length ? out : own ? [own] : [];
}

/** Tab (dir 1) / Shift-Tab (dir -1). Null = nothing to do (the key binding,
 *  editorBlocks' tabKey, decides whether the key is held or goes on). */
export function tabTr(state: EditorState, dir: 1 | -1): Transaction | null {
  const { main } = state.selection;
  const pos = main.head;
  if (inFrontmatter(state, pos)) return null;
  const nodes = ancestors(state, pos);
  if (nodes.some((n) => n.name === "FencedCode" || n.name === "CodeBlock")) {
    const multi = state.selection.ranges.some((r) => !r.empty);
    if (dir < 0 || multi) {
      // A selection indents its lines instead of being replaced by spaces.
      let out: Transaction | null = null;
      (dir < 0 ? indentLess : indentMore)({
        state,
        dispatch: (t) => (out = t),
      });
      return out;
    }
    return state.update(state.replaceSelection("  "), {
      scrollIntoView: true,
      userEvent: "input",
    });
  }
  const items = selectedItems(state);
  if (!items.length) return null;
  return dir > 0 ? indentItems(state, items) : outdentItems(state, items);
}
