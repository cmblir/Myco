// Whole-block edits behind the block menu (Mod-/ and the ⋮⋮ handle): Turn
// into, Duplicate, Delete, Move up/down, and what "Ask about this block"
// asks. A block is a list item with its children when it has siblings or is
// nested, otherwise its run of lines up to the blank lines around it (a
// fence never splits at its own blank lines). Pure over EditorState, like
// the planners in editorBlocks.

import type {
  ChangeSpec,
  EditorState,
  Line,
  Transaction,
} from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import type { Strings } from "./i18n";
import { calloutOf } from "./blocks/calloutLive";
import { queryRank, slashBlockEdit, slashItems } from "./editorCompletions";
import {
  APART,
  CODE_BLOCKS,
  FOOTNOTE_RE,
  QUOTE_LEAD_RE,
  ancestors,
  bodyText,
  fmEnd,
  fullTree,
  hasText,
  inCode,
  inFrontmatter,
  lineMarks,
  prefixEnd,
  tr,
} from "./editorMarks";
import {
  indentItems,
  outdentItems,
  restartAfter,
  withRenumber,
} from "./editorLists";
import { tagEnd } from "./blocks/live";
import { fenceBlock } from "./blocks/index";

/** Turn-into target that wraps the lines in a code fence. */
export const CODE_FENCE = "```";

export interface BlockUnit {
  /** 1-based, inclusive line numbers. */
  first: number;
  last: number;
  /** Set when the block is a list item among siblings. */
  item?: SyntaxNode;
}

/** Nodes a block always covers whole, blank lines inside them included. */
const WHOLE = new Set([...CODE_BLOCKS, "ListItem"]);

/** The run of text lines around line `n`, grown over any fence or list item
 *  it cuts into. Null on a blank line and in frontmatter. */
function runAt(state: EditorState, n: number): BlockUnit | null {
  const { doc } = state;
  const fm = fmEnd(state);
  const top = fm > 0 ? doc.lineAt(fm - 1).number : 0; // last frontmatter line
  const line = doc.line(n);
  if (n <= top || (!hasText(line.text) && !inCode(state, line.from)))
    return null;
  let a = n;
  let b = n;
  for (;;) {
    while (a - 1 > top && hasText(doc.line(a - 1).text)) a--;
    while (b < doc.lines && hasText(doc.line(b + 1).text)) b++;
    let na = a;
    let nb = b;
    fullTree(state).iterate({
      from: doc.line(a).from,
      to: doc.line(b).to,
      enter: (node) => {
        // A table and the `^id` line tagging it, which Live draws as
        // nothing, are one block (live.ts tagEnd).
        const tag = node.name === "Table" && tagEnd(node.node, doc);
        if (tag) nb = Math.max(nb, doc.lineAt(tag).number);
        let table = node.node.prevSibling;
        while (table?.name === "QuoteMark") table = table.prevSibling;
        if (
          node.name === "Paragraph" &&
          table?.name === "Table" &&
          tagEnd(table, doc)
        )
          na = Math.min(na, doc.lineAt(table.from).number);
        if (!WHOLE.has(node.name)) return;
        na = Math.min(na, doc.lineAt(node.from).number);
        nb = Math.max(nb, doc.lineAt(node.to).number);
      },
    });
    na = Math.max(na, top + 1);
    if (na === a && nb === b) return { first: a, last: b };
    a = na;
    b = nb;
  }
}

/** The previous (`dir` -1) or next list item beside `item` in its list. */
function sibling(item: SyntaxNode, dir: 1 | -1): SyntaxNode | null {
  let n = dir < 0 ? item.prevSibling : item.nextSibling;
  // Inside a quote each item line's `>` sits between the items.
  while (n && n.name === "QuoteMark") n = dir < 0 ? n.prevSibling : n.nextSibling;
  return n && n.name === "ListItem" ? n : null;
}

function itemUnit(state: EditorState, item: SyntaxNode): BlockUnit {
  const { doc } = state;
  return {
    first: doc.lineAt(item.from).number,
    last: doc.lineAt(item.to).number,
    item,
  };
}

/** The block the line at `pos` belongs to, or null (blank line, frontmatter). */
export function blockUnit(state: EditorState, pos: number): BlockUnit | null {
  const line = state.doc.lineAt(pos);
  if (inFrontmatter(state, line.from)) return null;
  if (hasText(line.text)) {
    const item = ancestors(state, line.to).find((n) => n.name === "ListItem");
    // A nested only child is still its own block: its run is the whole list.
    if (
      item &&
      (sibling(item, -1) ||
        sibling(item, 1) ||
        item.parent?.parent?.name === "ListItem")
    )
      return itemUnit(state, item);
  }
  return runAt(state, line.number);
}

/** The block before (`dir` -1) or after `u`: a sibling item, or the next run. */
function neighbour(
  state: EditorState,
  u: BlockUnit,
  dir: 1 | -1,
): BlockUnit | null {
  if (u.item) {
    const s = sibling(u.item, dir);
    return s ? itemUnit(state, s) : null;
  }
  const { doc } = state;
  let k = dir < 0 ? u.first - 1 : u.last + 1;
  while (k >= 1 && k <= doc.lines && !hasText(doc.line(k).text)) k += dir;
  return k >= 1 && k <= doc.lines ? runAt(state, k) : null;
}

const fromOf = (state: EditorState, u: BlockUnit): number =>
  state.doc.line(u.first).from;
const toOf = (state: EditorState, u: BlockUnit): number =>
  state.doc.line(u.last).to;
const textOf = (state: EditorState, u: BlockUnit): string =>
  state.doc.sliceString(fromOf(state, u), toOf(state, u));

const ORDINAL_RE = /^([ \t>]*)(\d+)([.)])/;

/** `text` (an ordered item) numbered as `slot` was: a moved item takes the
 *  number of the place it moves into. */
function numberedAs(text: string, slot: string): string {
  const m = ORDINAL_RE.exec(slot);
  return m ? text.replace(ORDINAL_RE, (_, lead, _n, d) => lead + m[2] + d) : text;
}

/** Move the block at `pos` above (-1) or below (1) its neighbour; the text
 *  between them stays between them. Null at an edge. */
export function moveBlockTr(
  state: EditorState,
  pos: number,
  dir: 1 | -1,
): Transaction | null {
  const u = blockUnit(state, pos);
  const n = u && neighbour(state, u, dir);
  if (!u || !n) return null;
  const [a, b] = dir < 0 ? [n, u] : [u, n];
  let ta = textOf(state, a);
  let tb = textOf(state, b);
  if (u.item) [ta, tb] = [numberedAs(ta, tb), numberedAs(tb, ta)];
  const gap = state.doc.sliceString(toOf(state, a), fromOf(state, b));
  const from = fromOf(state, a);
  const start = dir < 0 ? from : from + tb.length + gap.length;
  // Renumbering can change the moved item's width (9 → 10): past its
  // number the caret shifts with it.
  let off = pos - fromOf(state, u);
  const old = textOf(state, u);
  const m = ORDINAL_RE.exec(old);
  if (m && off >= m[1].length + m[2].length)
    off += (dir < 0 ? tb : ta).length - old.length;
  return tr(
    state,
    { from, to: toOf(state, b), insert: tb + gap + ta },
    start + off,
    "move.line",
  );
}

/** Copy the block right below itself (a blank line apart; the next item for
 *  a list item), the caret in the copy. */
export function duplicateBlockTr(
  state: EditorState,
  pos: number,
): Transaction | null {
  const u = blockUnit(state, pos);
  if (!u) return null;
  const end = toOf(state, u);
  let gap = "\n\n";
  if (u.item) {
    const next = neighbour(state, u, 1);
    const prev = neighbour(state, u, -1);
    gap = next
      ? state.doc.sliceString(end, fromOf(state, next))
      : prev
        ? state.doc.sliceString(toOf(state, prev), fromOf(state, u))
        : "\n";
  }
  const changes = [{ from: end, insert: gap + textOf(state, u) }];
  const anchor = end + gap.length + (pos - fromOf(state, u));
  return u.item
    ? withRenumber(state, changes, u.item.parent ?? u.item, "input.copyline", anchor)
    : tr(state, changes, anchor, "input.copyline");
}

/** Remove the block and the gap after it (before it, for the last block;
 *  the line break before it, for a nested only child); the caret goes to
 *  where the next block now starts. */
export function deleteBlockTr(
  state: EditorState,
  pos: number,
): Transaction | null {
  const u = blockUnit(state, pos);
  if (!u) return null;
  const next = neighbour(state, u, 1);
  const prev = neighbour(state, u, -1);
  const alone = u.item && !next && !prev && u.first > 1;
  const from = alone
    ? state.doc.line(u.first - 1).to
    : next || !prev
      ? fromOf(state, u)
      : toOf(state, prev);
  const to = next ? fromOf(state, next) : toOf(state, u);
  const changes: ChangeSpec[] = [{ from, to }];
  // The list keeps its start number: the next item takes the first one's.
  const own = u.item && !prev && ordinal(state, u.item);
  const after = own && next?.item && ordinal(state, next.item);
  if (own && after) changes.push({ ...after, insert: own.text });
  return u.item
    ? withRenumber(state, changes, u.item.parent ?? u.item, "delete.line", from)
    : tr(state, changes, from, "delete.line");
}

/** A line Turn into may rewrite: prose, a heading, a list item or a quote —
 *  not code, a table, a rule, a link definition or a footnote. */
function turnable(state: EditorState, line: Line): boolean {
  if (FOOTNOTE_RE.test(line.text) || inCode(state, line.to)) return false;
  return !ancestors(state, line.to).some((n) => APART.has(n.name));
}

/** The lines Turn into rewrites: a list item's own line, every line of a
 *  paragraph (soft lines too), else the line itself. */
function turnLines(
  state: EditorState,
  pos: number,
): { first: number; last: number; item?: SyntaxNode } {
  const { doc } = state;
  const line = doc.lineAt(pos);
  const nodes = ancestors(state, line.to);
  const item = nodes.find((n) => n.name === "ListItem");
  if (item) {
    const n = doc.lineAt(item.from).number;
    return { first: n, last: n, item };
  }
  const para = nodes.find((n) => n.name === "Paragraph");
  return para
    ? { first: doc.lineAt(para.from).number, last: doc.lineAt(para.to).number }
    : { first: line.number, last: line.number };
}

/** Text on a list item: its line leaves the list as a paragraph of its own,
 *  as Backspace at its start does — set apart by blank lines (`>` ones in a
 *  quote), else it would read as a lazy line of the item above. A nested
 *  item's text stays under its parent; numbered items after it restart. */
function itemTextTr(
  state: EditorState,
  line: Line,
  item: SyntaxNode,
  pos: number,
): Transaction {
  const { doc } = state;
  const end = prefixEnd(state, line);
  const mark = lineMarks(state, line)
    .filter((m) => m.name === "ListMark")
    .pop();
  const quote = QUOTE_LEAD_RE.exec(line.text)?.[0] ?? "";
  const keep =
    mark && item.parent?.parent?.name === "ListItem"
      ? line.text.slice(0, mark.from - line.from)
      : quote;
  const gap = quote.trimEnd();
  const text = (n: number): boolean =>
    n >= 1 && n <= doc.lines && hasText(bodyText(doc.line(n).text));
  const changes: ChangeSpec[] = [
    {
      from: line.from,
      to: end,
      insert: (text(line.number - 1) ? gap + "\n" : "") + keep,
    },
  ];
  if (text(line.number + 1))
    changes.push({ from: line.to, insert: "\n" + gap });
  const anchor = state.changes(changes).mapPos(Math.max(pos, end), -1);
  return tr(state, [...changes, ...restartAfter(state, item)], anchor, "input");
}

/** An ordered item's number, as a span of the doc. */
function ordinal(
  state: EditorState,
  item: SyntaxNode,
): { from: number; to: number; text: string } | null {
  const mark = item.getChild("ListMark");
  const m = mark && /^\d+/.exec(state.sliceDoc(mark.from, mark.to));
  return mark && m
    ? { from: mark.from, to: mark.from + m[0].length, text: m[0] }
    : null;
}

const CALLOUT_TAG_RE = /^\[![\w-]+\][+-]?\s*/;

/** The prefix line `i` of a converted block gets: numbered lines count up, a
 *  callout's body lines are plain quote lines. */
function prefixFor(prefix: string, i: number): string {
  if (i === 0) return prefix;
  if (prefix === "1. ") return `${i + 1}. `;
  return prefix.startsWith("> [!") ? "> " : prefix;
}

/** A code fence into `prefix` blocks: its lines as they are — code, not
 *  markdown whose marks may be stripped — the caret kept on its line (a
 *  caret on a fence goes to the text). Null for a fence in a quote or list
 *  item, whose lines carry that container's prefix too. */
function unfenceTr(
  state: EditorState,
  fence: SyntaxNode,
  pos: number,
  prefix: string,
): Transaction | null {
  const { doc } = state;
  if (fence.parent?.name !== "Document") return null;
  const open = doc.lineAt(fence.from);
  const end = doc.lineAt(fence.to);
  const last =
    fence.getChildren("CodeMark").length > 1 ? end.number - 1 : end.number;
  // A quote stays one quote across the code's blank lines.
  const blank = prefix.startsWith(">") ? ">" : "";
  const out: string[] = [];
  let anchor = -1;
  let start = -1; // the first line's text: where a caret on a fence goes
  let at = open.from;
  for (let n = open.number + 1, k = 0; n <= last; n++) {
    const l = doc.line(n);
    const full = hasText(l.text);
    const p = full ? prefixFor(prefix, k++) : blank;
    const text = full ? p + l.text : p;
    if (start < 0) start = at + p.length;
    if (pos >= l.from && pos <= l.to)
      anchor = at + Math.min(p.length + pos - l.from, text.length);
    out.push(text);
    at += text.length + 1;
  }
  if (!out.length) out.push(prefix); // an empty fence: an empty block
  if (anchor < 0) anchor = start < 0 ? open.from + prefix.length : start;
  return tr(
    state,
    { from: open.from, to: end.to, insert: out.join("\n") },
    anchor,
    "input",
  );
}

/** Turn the block at `pos` into the `prefix` kind (`""` = text, CODE_FENCE =
 *  a code block), keeping its text and the caret's place in it. */
export function turnBlockTr(
  state: EditorState,
  pos: number,
  prefix: string,
): Transaction | null {
  const { doc } = state;
  if (inFrontmatter(state, pos)) return null;
  const code = prefix === CODE_FENCE;
  const fenced = ancestors(state, pos).find((n) => n.name === "FencedCode");
  if (fenced) {
    // A chart, a diagram, a query or a plugin's fence is a block, not code:
    // its source never turns into text (decision 2), as a table's never does.
    const info = fenced.getChild("CodeInfo");
    const block = info && fenceBlock(state.sliceDoc(info.from, info.to));
    return code || block ? null : unfenceTr(state, fenced, pos, prefix);
  }
  const { first, last, item } = turnLines(state, pos);
  const lines: Line[] = [];
  for (let n = first; n <= last; n++) lines.push(doc.line(n));
  if (!lines.every((l) => turnable(state, l))) return null;
  if (item && prefix === "") return itemTextTr(state, lines[0], item, pos);
  const indent = /^\s*/.exec(lines[0].text)?.[0] ?? "";
  // A fence keeps the line's container — a nested item's indent, a quote's
  // marks before a list — or it would close the list and take the indent in.
  const mark =
    item &&
    lineMarks(state, lines[0])
      .filter((m) => m.name === "ListMark")
      .pop();
  const lead = !code
    ? ""
    : mark
      ? lines[0].text.slice(0, mark.from - lines[0].from)
      : indent;
  const own = lines.findIndex((l) => pos >= l.from && pos <= l.to);
  const out = lines.map((l, i) => {
    // A soft line's own indent means nothing to markdown: use the first's.
    const text = i === 0 ? l.text : indent + l.text.trimStart();
    const shift = text.length - l.text.length;
    // Only the line's real marks go (Lezer's, plus a callout's `[!type]`,
    // which Lezer does not mark): a soft line's `2024. ` is prose.
    let cap = Math.max(indent.length, prefixEnd(state, l) - l.from + shift);
    cap += CALLOUT_TAG_RE.exec(text.slice(cap))?.[0].length ?? 0;
    const e = code
      ? { text: lead + text.slice(cap), caret: lead.length }
      : slashBlockEdit(text, cap, cap, prefixFor(prefix, i));
    if (i !== own) return e;
    const col = Math.max(cap, pos - l.from + shift);
    return {
      text: e.text,
      caret: Math.min(e.text.length, e.caret + col - cap),
    };
  });
  const body = out.map((o) => o.text).join("\n");
  const fence = lead + CODE_FENCE;
  const insert = code ? `${fence}\n${body}\n${fence}` : body;
  const from = lines[0].from;
  const to = lines[lines.length - 1].to;
  if (insert === doc.sliceString(from, to)) return null;
  // The caret keeps its place in its line's text; off the rewritten lines
  // (a list item's continuation) it maps through the change.
  let anchor = from + (code ? fence.length + 1 : 0);
  if (own < 0) anchor = state.changes({ from, to, insert }).mapPos(pos);
  else
    for (let i = 0; i <= own; i++)
      anchor += i === own ? out[i].caret : out[i].text.length + 1;
  // A numbered item turned into another kind splits its list: the items
  // after it open a list of their own, which restarts at 1.
  const restart =
    item && ordinal(state, item) && prefix !== "1. "
      ? restartAfter(state, item)
      : [];
  return tr(state, [{ from, to, insert }, ...restart], anchor, "input");
}

export interface BlockAction {
  /** English keyword the search matches by prefix (`h2`, `duplicate`). */
  id: string;
  /** Localized name. */
  label: string;
  icon: string;
  aliases: readonly string[];
  /** Turn-into target (a line prefix or CODE_FENCE); unset for the actions. */
  turn?: string;
}

const TURN_INTO = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "bullet",
  "numbered",
  "todo",
  "quote",
  "callout",
  "toggle",
  "code",
]);

/** The block menu: Turn into (Text, then the slash blocks), then actions.
 *  `nest`: Indent and Outdent too, for touch, where no Tab key nests a list
 *  item (UX S51); keyboards keep Tab. */
export function blockActions(
  t: Strings,
  { nest = false }: { nest?: boolean } = {},
): BlockAction[] {
  return [
    {
      id: "text",
      label: t.sl_text ?? "Text",
      icon: "Aa",
      aliases: ["paragraph", "plain"],
      turn: "",
    },
    ...slashItems(t)
      .filter((i) => TURN_INTO.has(i.label))
      .map((i) => ({
        id: i.label,
        label: i.detail,
        icon: i.icon,
        aliases: i.aliases,
        // Code is the one turn-into target without a line prefix.
        turn: i.block ?? CODE_FENCE,
      })),
    {
      id: "duplicate",
      label: t.bm_duplicate ?? "Duplicate",
      icon: "⧉",
      aliases: ["copy", "clone"],
    },
    {
      id: "delete",
      label: t.bm_delete ?? "Delete",
      icon: "✕",
      aliases: ["remove"],
    },
    { id: "up", label: t.bm_move_up ?? "Move up", icon: "↑", aliases: ["move"] },
    {
      id: "down",
      label: t.bm_move_down ?? "Move down",
      icon: "↓",
      aliases: ["move"],
    },
    ...(nest
      ? [
          { id: "indent", label: t.bm_indent, icon: "⇥", aliases: ["nest", "tab"] },
          { id: "outdent", label: t.bm_outdent, icon: "⇤", aliases: ["lift", "unnest"] },
        ]
      : []),
    // Opens the ask picker with the block's text (askPrefill); no edit here.
    { id: "ask", label: t.bm_ask, icon: "?", aliases: ["question"] },
  ];
}

/** Same matching as the slash menu, best match first. */
export function filterActions(
  actions: readonly BlockAction[],
  query: string,
): BlockAction[] {
  return actions
    .map((a) => ({ a, r: queryRank(query, a.id, a.aliases, [a.label]) }))
    .filter((x) => x.r > 0)
    .sort((x, y) => y.r - x.r)
    .map((x) => x.a);
}

/** The transaction `action` makes on the block at `pos`, or null when it
 *  cannot apply there (the menu shows it disabled). */
export function blockActionTr(
  state: EditorState,
  pos: number,
  action: BlockAction,
): Transaction | null {
  if (action.turn !== undefined) return turnBlockTr(state, pos, action.turn);
  switch (action.id) {
    case "duplicate":
      return duplicateBlockTr(state, pos);
    case "delete":
      return deleteBlockTr(state, pos);
    case "up":
      return moveBlockTr(state, pos, -1);
    case "down":
      return moveBlockTr(state, pos, 1);
    case "indent":
    case "outdent": {
      const item = ancestors(state, pos).find((n) => n.name === "ListItem");
      if (!item) return null;
      return action.id === "indent"
        ? indentItems(state, [item])
        : outdentItems(state, [item]);
    }
  }
  return null;
}

/** What "Ask about this block" asks, and where the answer goes: the block's
 *  text past its marks — a list item's own line, a callout's title, a
 *  paragraph's soft lines joined — and the block's end (insertBlockTr puts
 *  the answer below it; a callout's end, asked by its title). Null on an
 *  empty block, a blank line, and in fenced code or frontmatter. */
export function askPrefill(
  state: EditorState,
  pos: number,
): { question: string; pos: number } | null {
  const u = blockUnit(state, pos);
  if (!u || inCode(state, pos)) return null;
  const { doc } = state;
  const quote = ancestors(state, doc.lineAt(pos).to).find(
    (n) => n.name === "Blockquote",
  );
  // Read as Live reads a callout (a list item's `- ` may come before `>`).
  const head = quote && calloutOf(quote, doc)?.head;
  let question: string;
  if (head) question = head.title;
  else {
    const { first, last } = turnLines(state, pos);
    const parts: string[] = [];
    for (let n = first; n <= last; n++) {
      const l = doc.line(n);
      parts.push(
        n === first ? doc.sliceString(prefixEnd(state, l), l.to) : bodyText(l.text),
      );
    }
    question = parts.map((s) => s.trim()).join(" ");
  }
  question = question.trim();
  const end = head ? doc.lineAt(quote.to).to : doc.line(u.last).to;
  return question ? { question, pos: end } : null;
}

/** Whether `action` applies to the block at `pos`: `ask` opens a picker
 *  (askPrefill) instead of editing; the rest have a transaction. */
export function blockActionOk(
  state: EditorState,
  pos: number,
  action: BlockAction,
): boolean {
  return action.id === "ask"
    ? askPrefill(state, pos) !== null
    : blockActionTr(state, pos, action) !== null;
}
