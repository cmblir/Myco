// Live block widgets: ONE StateField turns every registry block (./index) in
// the doc into a Decoration.replace({ block: true }) widget — CM 6.42 throws
// for block or line-break-replacing decorations from a ViewPlugin. A block
// never shows its markdown (docs/specs 2026-10-01, decisions 2 and 3): no
// caret rests on its hidden source. A caret there, a click on the block or
// an arrow onto it selects the block whole, ringed, as Notion does, and the
// keys act on it (blockKeyTr). The widgets are atomic for caret motion, and
// ArrowUp/Down stop on a block instead of skipping it. `liveBlocks` /
// `snapToBlocks` / `stepInto` / `blockKeyTr` are the pure part (vitest, node).

import type { SyntaxNode, Tree } from "@lezer/common";
import {
  type Compartment,
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
  StateField,
  Transaction,
  type ChangeSpec,
  type Extension,
  type Text,
  type TransactionSpec,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
  keymap,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { isolateHistory, redo, undo } from "@codemirror/commands";
import type { RenderEnv } from "../assets";
import type { Strings } from "../i18n";
import type Token from "markdown-it/lib/token.mjs";
import {
  frontmatterLength,
  headingsOf,
  markdownRenderer,
  type OutlineHeading,
} from "../markdown";
import {
  fenceBlock,
  nodeBlocks,
  type BlockCtx,
  type BlockEdit,
  type BlockHost,
  type BlockSpec,
} from "./index";
import { bodyText, hasText } from "../editorMarks";
import { headingLine } from "./toc";
import { tableTag, taggedTables, type TaggedTables } from "./chart";
import { calloutOf, composeEndRefresh, staysStale } from "./calloutLive";
import { stripLead } from "./fenceSource";

export interface LiveBlock {
  /** Whole lines: the first line's start to the last line's end — a
   *  table's `^id` tag line included, which Live draws as nothing
   *  (decision 6). */
  from: number;
  to: number;
  spec: BlockSpec;
  parsed: unknown;
  source: string;
  /** The container marks before the block on its first line (`> `, an
   *  item's indent), which the widget stands in for. */
  lead: string;
}

/** The nodes a block can sit in. */
const CONTAINERS = new Set([
  "Document",
  "Blockquote",
  "BulletList",
  "OrderedList",
  "ListItem",
]);
/** Before a nested block on its line: container marks only. A list marker
 *  there would vanish with the line the widget replaces. */
const LEAD_RE = /^[ \t>]*$/;

/** The first of `specs` that reads `src` as itself, over [from, to). */
function readBlock(
  doc: Text,
  specs: readonly BlockSpec[],
  from: number,
  to: number,
  src: string,
  lead: string,
): LiveBlock | null {
  for (const spec of specs) {
    const parsed = spec.parse(src);
    if (parsed != null)
      return {
        from,
        to,
        spec,
        parsed,
        source: doc.sliceString(from, to),
        lead,
      };
  }
  return null;
}

/** Pure: the block a paragraph is drawn as — an image or a note embed that
 *  is its line's whole content (container marks before it) — or null. A
 *  callout's title line is not part of it: both parsers read the line under
 *  the title as the body's own paragraph. A soft line never counts. */
export function paragraphBlock(para: SyntaxNode, doc: Text): LiveBlock | null {
  let line = doc.lineAt(para.from);
  const quote = para.parent;
  if (
    quote?.name === "Blockquote" &&
    doc.lineAt(quote.from).number === line.number &&
    calloutOf(quote, doc)
  ) {
    if (line.to >= para.to) return null;
    line = doc.line(line.number + 1);
  }
  if (doc.lineAt(para.to).number !== line.number) return null;
  const nodes: SyntaxNode[] = [];
  for (let n = para.firstChild; n; n = n.nextSibling)
    if (n.from >= line.from && n.name !== "QuoteMark") nodes.push(n);
  const [node] = nodes;
  if (nodes.length !== 1) return null;
  const lead = doc.sliceString(line.from, node.from);
  if (!LEAD_RE.test(lead) || /\S/.test(doc.sliceString(node.to, line.to)))
    return null;
  return readBlock(
    doc,
    nodeBlocks(node.name),
    line.from,
    line.to,
    doc.sliceString(node.from, node.to),
    lead,
  );
}

/** Lines `from`..`to` as markdown-it reads them in their containers: past
 *  a `>` and one blank per quote level in `lead`, then up to its indent. */
function contentLines(doc: Text, from: number, to: number, lead: string) {
  const strip = stripLead(lead);
  const out: string[] = [];
  for (let n = from; n <= to; n++) out.push(strip(doc.line(n).text));
  return out;
}

/** A delimiter row, roughly; markdown-it has the last word. */
const DELIM_RE = /^[ \t|:-]*-[ \t|:-]*$/;

/** Pure: a table Lezer reads as a paragraph — in a quote or list item it
 *  does not end a paragraph before a table, where markdown-it does (under a
 *  callout's title, say) — asked of markdown-it itself, over the lines past
 *  a callout's title. Null when there is none. */
function nestedTable(para: SyntaxNode, doc: Text): LiveBlock | null {
  let line = doc.lineAt(para.from);
  const last = doc.lineAt(para.to);
  const quote = para.parent;
  if (
    quote?.name === "Blockquote" &&
    doc.lineAt(quote.from).number === line.number &&
    calloutOf(quote, doc)
  )
    line = doc.line(Math.min(line.number + 1, doc.lines));
  if (line.number >= last.number) return null;
  const lead = /^[ \t>]*/.exec(line.text)?.[0] ?? "";
  const text = contentLines(doc, line.number, last.number, lead);
  if (!DELIM_RE.test(text[1])) return null;
  const [open] = markdownRenderer.parse(text.join("\n"), {});
  if (open?.type !== "table_open" || !open.map) return null;
  const end = doc.line(line.number + open.map[1] - 1);
  return readBlock(
    doc,
    nodeBlocks("Table"),
    line.from,
    end.to,
    doc.sliceString(line.from, end.to),
    lead,
  );
}

/** Where the `^id` line tagging the table node `n` ends — the one-line
 *  paragraph right after it in its container (chart.ts tableTag), as
 *  markdown-it's tableTagAt reads it — else null. The block menu takes
 *  the two as one block too (editorBlockOps). */
export function tagEnd(n: SyntaxNode, doc: Text): number | null {
  let next = n.nextSibling;
  while (next?.name === "QuoteMark") next = next.nextSibling;
  return next?.name === "Paragraph" &&
    tableTag(doc.sliceString(next.from, next.to)) !== null
    ? doc.lineAt(next.to).to
    : null;
}

// ponytail: 32 KB frontmatter cap (same as editorLive)
const fmEndOf = (doc: Text): number =>
  frontmatterLength(doc.sliceString(0, Math.min(doc.length, 32768)));

/** Pure: the registry blocks in the document — top-level, or inside a quote,
 *  a callout or a list item where only container marks precede them on
 *  their line (the widget replaces whole lines; the box around a callout
 *  and the quote's bar stay the widget's). An image or a note embed counts
 *  when it is its line's whole content; a block node (a table, a closed
 *  fence) covers its lines. */
export function liveBlocks(tree: Tree, doc: Text): LiveBlock[] {
  const out: LiveBlock[] = [];
  const fmEnd = fmEndOf(doc);
  tree.iterate({
    enter(n) {
      if (CONTAINERS.has(n.name)) return;
      if (n.from < fmEnd) return false;
      const first = doc.lineAt(n.from);
      const lead = doc.sliceString(first.from, n.from);
      let b: LiveBlock | null = null;
      if (n.name === "Paragraph")
        b =
          paragraphBlock(n.node, doc) ??
          (n.node.parent?.name === "Document"
            ? null
            : nestedTable(n.node, doc));
      else if (!LEAD_RE.test(lead)) b = null;
      else if (n.name === "FencedCode") {
        const info = n.node.getChild("CodeInfo");
        const spec = info && fenceBlock(doc.sliceString(info.from, info.to));
        // Unclosed, it runs to its container's end: a block would hide it.
        if (spec && n.node.getChildren("CodeMark").length > 1) {
          const last = doc.lineAt(n.to);
          // The body as markdown-it's token.content has it.
          const body = contentLines(
            doc,
            first.number + 1,
            last.number - 1,
            lead,
          );
          b = readBlock(
            doc,
            [spec],
            first.from,
            last.to,
            body.map((l) => l + "\n").join(""),
            lead,
          );
        }
      } else if (n.name === "BlockMath") {
        // Its lines as markdown-it's token.content has them.
        const last = doc.lineAt(n.to);
        b = readBlock(
          doc,
          nodeBlocks(n.name),
          first.from,
          last.to,
          contentLines(doc, first.number, last.number, lead).join("\n"),
          lead,
        );
      } else {
        const last = doc.lineAt(n.to);
        b = readBlock(
          doc,
          nodeBlocks(n.name),
          first.from,
          last.to,
          doc.sliceString(first.from, last.to),
          lead,
        );
      }
      // The tag under a table that runs to the node's end is the table's.
      if (b?.spec.id === "table" && doc.lineAt(n.to).to === b.to) {
        const tag = tagEnd(n.node, doc);
        if (tag !== null)
          b = { ...b, to: tag, source: doc.sliceString(b.from, tag) };
      }
      if (b) out.push(b);
      return false;
    },
  });
  return out;
}

interface Span {
  from: number;
  to: number;
}

/** Pure: `sel` off the blocks' hidden source. A caret on a block, its
 *  edges too, selects the block whole; a range's end inside one grows to
 *  the block's far edge — drawn, a block is atomic, and a delete of a range
 *  ending inside it would take source that was never selected. Null when
 *  nothing moves. */
export function snapToBlocks(
  blocks: readonly Span[],
  sel: EditorSelection,
): EditorSelection | null {
  const inside = (p: number) => blocks.find((b) => p > b.from && p < b.to);
  let moved = false;
  const ranges = sel.ranges.map((r) => {
    if (r.empty) {
      const b = blocks.find((b) => r.head >= b.from && r.head <= b.to);
      if (!b) return r;
      moved = true;
      return EditorSelection.range(b.from, b.to);
    }
    let { anchor, head } = r;
    const a = inside(anchor);
    if (a) anchor = head > anchor ? a.from : a.to;
    const h = inside(head);
    if (h) head = head > anchor ? h.to : h.from;
    if (anchor === r.anchor && head === r.head) return r;
    moved = true;
    return EditorSelection.range(anchor, head);
  });
  return moved ? EditorSelection.create(ranges, sel.mainIndex) : null;
}

/** Pure: the selection an undo or redo among `trs` leaves on the blocks'
 *  hidden source, snapped (snapToBlocks). CM's history dispatches those
 *  with filter: false, so the snap filter never sees them. Null for any
 *  other update, or where nothing moves. */
export function undoneSnap(
  trs: readonly Transaction[],
  blocks: readonly Span[] | null,
): EditorSelection | null {
  const last = trs[trs.length - 1];
  if (
    !blocks ||
    !trs.some((t) => t.isUserEvent("undo") || t.isUserEvent("redo"))
  )
    return null;
  return snapToBlocks(blocks, last.state.selection);
}

/** Pure: the block `sel` selects whole — one range over exactly its
 *  lines — or null. */
function selectedBlock<B extends Span>(
  blocks: readonly B[],
  sel: EditorSelection,
): B | null {
  const { from, to } = sel.main;
  if (sel.ranges.length > 1 || from === to) return null;
  return blocks.find((b) => b.from === from && b.to === to) ?? null;
}

/** The keys a block selected whole answers (decision 3). */
export type BlockKey =
  | "Enter"
  | "Backspace"
  | "Delete"
  | "Escape"
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowLeft"
  | "ArrowRight"
  | "Tab"
  | "Shift-Tab";

const blank = (doc: Text, n: number): boolean =>
  !hasText(bodyText(doc.line(n).text));

/** Where the caret goes past `b` (`forward`) or before it: the nearest line
 *  with text past blank ones — its start, or its end before the block — or
 *  the note's first or last line when a blank line sets it apart from the
 *  block. Null where typing would glue onto the block (the blank line right
 *  beside it), in the hidden frontmatter, or past the note's edge. */
function pastBlock(doc: Text, b: Span, forward: boolean): number | null {
  const near = forward
    ? doc.lineAt(b.to).number + 1
    : doc.lineAt(b.from).number - 1;
  if (near < 1 || near > doc.lines) return null;
  const fm = fmEndOf(doc);
  let n = near;
  if (forward) while (n < doc.lines && blank(doc, n)) n++;
  else while (n > 1 && doc.line(n).from > fm && blank(doc, n)) n--;
  const line = doc.line(n);
  if (line.from < fm || (n === near && blank(doc, n))) return null;
  return forward ? line.from : line.to;
}

/** A new empty line under `b` (`typed` on it), a blank line (in its
 *  container) between it and the block, and between it and any text right
 *  below. */
function lineAfter(doc: Text, b: LiveBlock, typed = ""): TransactionSpec {
  const gap = b.lead.trimEnd();
  const last = doc.lineAt(b.to).number;
  const below = last < doc.lines && !blank(doc, last + 1);
  const head = "\n" + gap + "\n" + b.lead + typed;
  return {
    changes: { from: b.to, insert: head + (below ? "\n" + gap : "") },
    selection: { anchor: b.to + head.length },
    scrollIntoView: true,
    userEvent: typed ? "input.type" : "input",
  };
}

/** A new empty line over `b`, a blank line (in its container) between it
 *  and the block: ArrowUp on the note's first block, as ArrowDown makes
 *  one under its last. */
function lineBefore(b: LiveBlock): TransactionSpec {
  return {
    changes: { from: b.from, insert: b.lead + "\n" + b.lead.trimEnd() + "\n" },
    selection: { anchor: b.from + b.lead.length },
    scrollIntoView: true,
    userEvent: "input",
  };
}

/** Pure: text that came with no keydown (an emoji picker, dictation, a
 *  text replacement) over a block selected whole goes on as a typed key
 *  does (keydown below): on a new line under the block, which stays. Null
 *  for any other transaction; a composition's caret was moved first. */
function typedOver(
  tr: Transaction,
  blocks: readonly LiveBlock[],
): TransactionSpec | null {
  if (
    !tr.isUserEvent("input.type") ||
    tr.isUserEvent("input.type.compose") ||
    tr.startState.readOnly
  )
    return null;
  const b = selectedBlock(blocks, tr.startState.selection);
  if (!b) return null;
  const at: number[] = [];
  tr.changes.iterChanges(
    (fromA, toA, fromB, toB) => void at.push(fromA, toA, fromB, toB),
  );
  const [fromA, toA, fromB, toB] = at;
  if (at.length !== 4 || fromA !== b.from || toA !== b.to) return null;
  const typed = tr.newDoc.sliceString(fromB, toB);
  return typed ? lineAfter(tr.startState.doc, b, typed) : null;
}

/** Line `n` is blank and right under a block: text typed there would
 *  join it (a table's next row, its tag's paragraph, an image's soft
 *  line). */
const underBlock = (doc: Text, blocks: readonly Span[], n: number): boolean =>
  blank(doc, n) && blocks.some((b) => doc.lineAt(b.to).number + 1 === n);

/** Text typed at `pos` on a blank line, as a paragraph of its own: `head`
 *  before it (the line's marks up to `pos` kept as a blank line, then a
 *  new line with the same marks: a quote's `> `, none past the quote's end
 *  or at an item's left edge, where the caret was), `tail` after it (a
 *  blank line before text right below). */
function apartParts(doc: Text, pos: number): { head: string; tail: string } {
  const line = doc.lineAt(pos);
  const marks = doc.sliceString(line.from, pos);
  const gap = marks.trimEnd();
  const below = line.number < doc.lines && !blank(doc, line.number + 1);
  return {
    head: gap + "\n" + marks.replace(/>$/, "> "),
    tail: below ? "\n" + gap : "",
  };
}

/** Pure: text typed or pasted (`tr`) on the blank line right under a block
 *  (underBlock) set apart from it, as Enter on the selected block sets a
 *  new line apart (lineAfter). The changes to apply after `tr`, or null.
 *  Mid-composition nothing is rewritten: keydown moves the caret first
 *  (apartTr). */
export function apartTyped(
  tr: Transaction,
  blocks: readonly LiveBlock[],
): ChangeSpec | null {
  if (
    !["input.type", "input.paste", "input.drop"].some((e) =>
      tr.isUserEvent(e),
    ) ||
    tr.isUserEvent("input.type.compose")
  )
    return null;
  const at: number[] = [];
  tr.changes.iterChanges(
    (fromA, toA, fromB, toB) => void at.push(fromA, toA, fromB, toB),
  );
  if (at.length !== 4) return null;
  const [fromA, toA, fromB, toB] = at;
  const doc = tr.startState.doc;
  const line = doc.lineAt(fromA);
  const typed = tr.newDoc.sliceString(fromB, toB);
  const glued =
    toA <= line.to &&
    !!typed &&
    !typed.startsWith("\n") &&
    underBlock(doc, blocks, line.number);
  if (!glued) return null;
  const { head, tail } = apartParts(doc, fromA);
  return [
    { from: line.from, to: fromB, insert: head },
    { from: toB, to: tr.newDoc.lineAt(toB).to, insert: tail },
  ];
}

/** Pure: the caret on the blank line right under a block moved onto a new
 *  line apart from it (apartTyped), before an IME composes there. Null
 *  elsewhere. */
export function apartTr(
  state: EditorState,
  blocks: readonly LiveBlock[],
): TransactionSpec | null {
  const { doc, selection } = state;
  if (selection.ranges.length > 1 || !selection.main.empty) return null;
  const line = doc.lineAt(selection.main.head);
  if (!underBlock(doc, blocks, line.number)) return null;
  const { head, tail } = apartParts(doc, selection.main.head);
  return {
    changes: { from: line.from, to: line.to, insert: head + tail },
    selection: { anchor: line.from + head.length },
    userEvent: "input",
  };
}

/** `b`'s lines out, with one blank line beside them, so the text around
 *  keeps the one blank line between it — one undo step. */
function removeBlock(doc: Text, b: Span, userEvent: string): TransactionSpec {
  const first = doc.lineAt(b.from).number;
  const last = doc.lineAt(b.to).number;
  let { from, to } = b;
  if (last < doc.lines)
    to = doc.line(
      last + 1 < doc.lines && blank(doc, last + 1) ? last + 2 : last + 1,
    ).from;
  else if (first > 1)
    from = doc.line(
      first > 2 && blank(doc, first - 1) ? first - 2 : first - 1,
    ).to;
  return {
    changes: { from, to },
    selection: { anchor: from },
    scrollIntoView: true,
    userEvent,
    annotations: isolateHistory.of("full"),
  };
}

/** Pure: what `key` does to the block the selection holds whole (Notion's
 *  block selection), as one transaction; `{}` holds the key. Enter on a
 *  block with an editor of its own is null: the view opens it. With no
 *  block selected, Backspace or Delete with the caret on a block's edge
 *  selects it — typing that closed a fence leaves the caret there, and
 *  CM's atomic delete would take the whole block at once. Null leaves the
 *  key to the keymaps below. */
export function blockKeyTr(
  state: EditorState,
  blocks: readonly LiveBlock[],
  key: BlockKey,
): TransactionSpec | null {
  const { doc, selection } = state;
  const select = (x: Span): TransactionSpec => ({
    selection: EditorSelection.single(x.from, x.to),
    scrollIntoView: true,
    userEvent: "select",
  });
  const b = selectedBlock(blocks, selection);
  if (!b) {
    const { main } = selection;
    if (selection.ranges.length > 1 || !main.empty) return null;
    if (key !== "Backspace" && key !== "Delete") return null;
    const edge = blocks.find((x) => x.from === main.head || x.to === main.head);
    return edge ? select(edge) : null;
  }
  const caret = (pos: number | null): TransactionSpec =>
    pos === null
      ? { scrollIntoView: true }
      : {
          selection: { anchor: pos },
          scrollIntoView: true,
          userEvent: "select",
        };
  switch (key) {
    case "Enter":
      return b.spec.openEditor ? null : lineAfter(doc, b);
    case "Backspace":
      return removeBlock(doc, b, "delete.backward");
    case "Delete":
      return removeBlock(doc, b, "delete.forward");
    case "Escape": {
      // Out of the selection: never onto the next block's edge, which
      // would select that block.
      const pos = pastBlock(doc, b, true);
      return pos === null || blocks.some((x) => x.from === pos)
        ? lineAfter(doc, b)
        : caret(pos);
    }
    case "ArrowDown":
    case "ArrowRight": {
      const pos = pastBlock(doc, b, true);
      if (pos !== null) return caret(pos);
      // The note's last block: the blank line under it (typing there is
      // set apart, apartTyped), else a new line, as Escape makes.
      const last = doc.lineAt(b.to).number;
      return last < doc.lines
        ? caret(doc.line(last + 1).to)
        : lineAfter(doc, b);
    }
    case "ArrowUp": {
      // The note's first block: a new line over it.
      const pos = pastBlock(doc, b, false);
      return pos === null ? lineBefore(b) : caret(pos);
    }
    case "ArrowLeft":
      return caret(pastBlock(doc, b, false));
    // Held: indented as text, twice, a fence is a code block showing its
    // markdown. Escape and the arrows still leave the block.
    case "Tab":
    case "Shift-Tab":
      return {};
  }
}

/** Pure: where ArrowDown (`forward`) / ArrowUp lands when its natural
 *  `target` jumps over a drawn block — CM's vertical motion skips block
 *  widgets — namely that block's near edge, which selects the block
 *  (snapToBlocks); null when the motion passes no block. `drawn` is in
 *  document order. */
export function stepInto(
  drawn: readonly { from: number; to: number }[],
  head: number,
  target: number,
  forward: boolean,
): number | null {
  if (forward) {
    for (const b of drawn) if (b.from > head && b.from <= target) return b.from;
    return null;
  }
  for (let i = drawn.length - 1; i >= 0; i--)
    if (drawn[i].to < head && drawn[i].to >= target) return drawn[i].to;
  return null;
}

/** Pure: an in-place editor (a table's cell) hands the caret back to the
 *  note — the block starting at `from` selected whole (`select`), or the
 *  text before it (`up`, as ArrowUp on the selected block: a new line when
 *  there is none) or after it (`down`, as Escape: a new line when there is
 *  none). Null when no block starts there. */
export function leaveTr(
  state: EditorState,
  blocks: readonly LiveBlock[],
  from: number,
  to: "select" | "up" | "down",
): TransactionSpec | null {
  const b = blocks.find((x) => x.from === from);
  if (!b) return null;
  const selected: TransactionSpec = {
    selection: EditorSelection.single(b.from, b.to),
    scrollIntoView: true,
    userEvent: "select",
  };
  if (to === "select") return selected;
  const s = state.update({ selection: EditorSelection.single(b.from, b.to) });
  const key = to === "up" ? "ArrowUp" : "Escape";
  return { ...selected, ...blockKeyTr(s.state, blocks, key) };
}

/** Open the in-place editor of the block that starts here (`/table` puts
 *  the caret in its first cell), once the view has drawn it. */
export const openBlockEditor = StateEffect.define<number>();

export interface BlockWidgetOptions {
  env?: RenderEnv;
  t?: Strings;
  /** A link inside a widget (a TOC row: `#Heading` and its body line). */
  onLinkClick?: (target: string, line?: number) => void;
  /** An external link inside a widget (a table cell's URL): never followed
   *  in the webview. */
  onExternalLink?: (href: string) => void;
  /** A note embed's section (lib/embedLoad.ts). */
  loadEmbed?: BlockCtx["loadEmbed"];
  /** A query block's pages (lib/queryLoad.ts). */
  runQuery?: BlockCtx["runQuery"];
}

interface NoteParse {
  base: RenderEnv | undefined;
  tokens: Token[];
  /** The parse's own env: its footnotes and references. */
  env: RenderEnv;
  /** Frontmatter lines above the body the tokens' maps count from. */
  fmLines: number;
  headings?: readonly OutlineHeading[];
  tables?: TaggedTables;
}

// ponytail: one markdown-it parse of the whole note per edit, and only while
// a block reads it (a TOC's outline, a table's cells, a chart's tagged
// table); derive the outline from the Lezer tree if long notes with a table
// or a TOC lag.
const notes = new WeakMap<Text, NoteParse>();

/** The note's body as Preview parses it, once per doc (and env). */
function noteParse(doc: Text, base?: RenderEnv): NoteParse {
  let n = notes.get(doc);
  if (!n || n.base !== base) {
    const raw = doc.toString();
    const fm = frontmatterLength(raw);
    const env = { ...base };
    n = {
      base,
      tokens: markdownRenderer.parse(raw.slice(fm), env),
      env,
      fmLines: fm ? doc.lineAt(fm).number - 1 : 0,
    };
    notes.set(doc, n);
  }
  return n;
}

/** Pure: Preview's HTML for the table whose first line starts at `from`,
 *  rendered within the whole note — its `[^1]` numbered and its `[x][ref]`
 *  resolved as Preview does, no footnote list under it. Null when
 *  markdown-it reads no table there. */
export function noteTableHtml(
  doc: Text,
  from: number,
  base?: RenderEnv,
): string | null {
  const { tokens, env, fmLines } = noteParse(doc, base);
  const line = doc.lineAt(from).number - 1 - fmLines;
  const i = tokens.findIndex(
    (t) => t.type === "table_open" && t.map?.[0] === line,
  );
  if (i < 0) return null;
  const j = tokens.findIndex((t, k) => k > i && t.type === "table_close");
  return markdownRenderer.renderer.render(
    tokens.slice(i, j + 1),
    markdownRenderer.options,
    env,
  );
}

/** One block's render context. */
function liveCtx(doc: Text, opts: BlockWidgetOptions, b: LiveBlock): BlockCtx {
  return {
    env: opts.env,
    t: opts.t,
    block: { source: b.source, lead: b.lead },
    renderBlock: (src) =>
      noteTableHtml(doc, b.from, opts.env) ??
      markdownRenderer.render(src, opts.env),
    loadEmbed: opts.loadEmbed,
    runQuery: opts.runQuery,
    get headings() {
      const n = noteParse(doc, opts.env);
      return (n.headings ??= headingsOf(n.tokens));
    },
    get tables() {
      const n = noteParse(doc, opts.env);
      return (n.tables ??= taggedTables(n.tokens));
    },
  };
}

/** A widget's BlockEdit: `change` reads the note as it is now and where the
 *  block starts now (`at`), and its rewrite is one undo step. Focus goes
 *  back to the note, so ⌘Z reaches that step after a press that left it on
 *  the page (or on the widget's button) — unless the write opens a block's
 *  editor (`open`), which takes it. */
export function widgetEdit(
  view: {
    state: EditorState;
    dispatch(tr: TransactionSpec): void;
    focus(): void;
  },
  at: () => number,
): BlockEdit {
  return (change) => {
    const c = change(view.state.doc.toString(), at());
    if (!c) return;
    const { from, to, insert, open } = c;
    view.dispatch({
      changes: { from, to, insert },
      userEvent: "input",
      annotations: isolateHistory.of("full"),
      ...(open === undefined
        ? {}
        : {
            // The caret where that block starts: a selection mapped over
            // the insert would ring every block in it.
            selection: { anchor: from + open },
            effects: openBlockEditor.of(from + open),
          }),
    });
    if (open === undefined) view.focus();
  };
}

/** Live's extensions (`ext`, or none) into `comp`, then the selection once
 *  more through them: the filters a transaction runs are its start
 *  state's, so a caret the note opened with on a block's hidden source
 *  (bodyStart on a first-line table) is only now snapped — the block
 *  selected, where typing starts a paragraph under it. */
export function reconfigureLive(
  view: { readonly state: EditorState; dispatch(tr: TransactionSpec): void },
  comp: Compartment,
  ext: Extension,
): void {
  view.dispatch({ effects: comp.reconfigure(ext) });
  view.dispatch({ selection: view.state.selection });
}

/** The blocks the field holds for `state` (null while stale). */
type BlocksOf = (state: EditorState) => readonly LiveBlock[] | null;

/** What a widget's in-place editor drives (BlockHost) for the block drawn
 *  in `el`. A session's writes share its start as their time, so CM's
 *  history joins them into one undo step whatever the pauses (it joins
 *  edits within newGroupDelay of the last); they carry no userEvent, which
 *  history joins and no completion source reacts to. The first write of a
 *  session starts a step of its own. */
function blockHost(
  view: EditorView,
  el: HTMLElement,
  blocksOf: BlocksOf,
): BlockHost {
  let joined: number | undefined;
  const at = () => view.posAtDOM(el);
  return {
    write(length, insert, session) {
      const from = at();
      const first = session === undefined || session !== joined;
      joined = session;
      view.dispatch({
        changes: { from, to: from + length, insert },
        userEvent: session === undefined ? "input" : undefined,
        annotations:
          session === undefined
            ? isolateHistory.of("full")
            : [
                Transaction.time.of(session),
                ...(first ? [isolateHistory.of("before")] : []),
              ],
      });
    },
    leave(to) {
      const blocks = blocksOf(view.state);
      const spec = blocks && leaveTr(view.state, blocks, at(), to);
      if (spec) view.dispatch(spec);
      view.focus();
    },
    undo(again) {
      (again ? redo : undo)(view);
      // The undo took the block itself out: the note keeps the keys.
      if (!el.isConnected) view.focus();
    },
    remove() {
      const b = blocksOf(view.state)?.find((x) => x.from === at());
      if (b && !view.state.readOnly)
        view.dispatch(removeBlock(view.state.doc, b, "delete"));
      view.focus();
    },
    remeasure: () => view.requestMeasure(),
    get readOnly() {
      return view.state.readOnly;
    },
  };
}

/** A press here is the field's own: its caret, not the block's selection. */
const FIELDS =
  'input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]';

/** The widget a block's element draws now: updateDOM hands an element on
 *  to the widget of the block's new source. */
const drawnBy = new WeakMap<HTMLElement, BlockWidget>();

class BlockWidget extends WidgetType {
  private readonly key: string;
  constructor(
    private readonly block: LiveBlock,
    private readonly ctx: BlockCtx,
    private readonly opts: BlockWidgetOptions,
    /** A selection covers the block whole: it is ringed. */
    readonly selected: boolean,
    private readonly blocksOf: BlocksOf,
  ) {
    super();
    this.key = block.spec.key?.(block.parsed, ctx) ?? "";
  }

  /** The registry block this draws (editorBlockHandle stands clear of a
   *  table's row handles). */
  get blockId(): string {
    return this.block.spec.id;
  }

  /** `w` draws what this draws: the same block, the same content. */
  private same(w: BlockWidget): boolean {
    return (
      w.block.spec === this.block.spec &&
      w.block.source === this.block.source &&
      w.key === this.key
    );
  }

  override eq(w: BlockWidget): boolean {
    return this.same(w) && w.selected === this.selected;
  }

  // A selection that moves only rings or unrings the block: its DOM stays,
  // and with it any field the IME may be composing in. A new source keeps
  // it too where the block redraws in place (a table's own write).
  override updateDOM(
    dom: HTMLElement,
    _view: EditorView,
    from: BlockWidget,
  ): boolean {
    if (!this.same(from)) {
      const { spec, parsed, lead } = this.block;
      if (spec !== from.block.spec || lead !== from.block.lead) return false;
      if (!spec.update?.(dom, parsed, this.ctx)) return false;
    }
    drawnBy.set(dom, this);
    dom.classList.toggle("is-selected", this.selected);
    return true;
  }

  override get estimatedHeight(): number {
    return this.block.spec.estimatedHeight(this.block.parsed, this.ctx);
  }

  toDOM(view: EditorView): HTMLElement {
    const { spec, parsed, source } = this.block;
    const el = document.createElement("div");
    el.className = `cm-block-widget live-block-${spec.id}`;
    drawnBy.set(el, this);
    if (this.selected) el.classList.add("is-selected");
    // Nested, it stands in for its container marks: a quote's bar, an
    // item's indent.
    const { lead } = this.block;
    if (lead.includes(">")) el.classList.add("in-quote");
    const indent = /^[ \t]*/.exec(lead)?.[0].length ?? 0;
    if (indent) el.style.marginLeft = `${indent}ch`;
    // The widget ignores events for CodeMirror (WidgetType default), so these
    // run alone: a press selects the block whole; a link inside follows on
    // click instead, and no link ever navigates the webview. A button inside
    // (a query's bake) acts on its click alone.
    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      const at = e.target instanceof Element ? e.target : null;
      const { block } = drawnBy.get(el) ?? this;
      const from = view.posAtDOM(el);
      const whole = EditorSelection.single(from, from + block.to - block.from);
      // A field of the widget's own, not the editor around it: it takes the
      // caret, and the note's selection goes onto this block, as Enter on
      // it does, so a block selected before keeps no ring (one block looks
      // active; this one's is off while its field holds the caret).
      const field = at?.closest(FIELDS);
      if (field && el.contains(field)) {
        if (!view.state.selection.eq(whole))
          view.dispatch({ selection: whole, userEvent: "select.pointer" });
        return;
      }
      e.preventDefault();
      // A link, a button, or anywhere in a fence's open panel (its fields
      // keep the caret): no block selection.
      if (at?.closest("[data-link], [data-external], button, [data-panel]"))
        return;
      view.dispatch({ selection: whole, userEvent: "select.pointer" });
      view.focus();
    });
    el.addEventListener("click", (e) => {
      const link =
        e.target instanceof Element ? e.target.closest("a") : null;
      if (!link) return;
      e.preventDefault();
      const { link: target, external } = link.dataset;
      if (target) this.opts.onLinkClick?.(target, headingLine(link));
      else if (external) this.opts.onExternalLink?.(external);
    });
    // An async render changes the widget's height after CM measured it.
    const remeasure = () => {
      if (el.isConnected) view.requestMeasure();
    };
    const failed = (err: unknown) => {
      console.error(`block widget "${spec.id}" failed`, err);
      el.classList.add("is-error");
      el.replaceChildren(source);
      remeasure();
    };
    // The block's lines start where the widget is now, not where it was drawn.
    const edit = widgetEdit(view, () => view.posAtDOM(el));
    const host = blockHost(view, el, this.blocksOf);
    try {
      const done = spec.mount(el, parsed, this.ctx, edit, host);
      if (done) done.then(remeasure, failed);
    } catch (err) {
      failed(err);
    }
    return el;
  }
}

function decorate(
  state: EditorState,
  blocks: readonly LiveBlock[],
  opts: BlockWidgetOptions,
  blocksOf: BlocksOf,
): DecorationSet {
  const { ranges } = state.selection;
  return Decoration.set(
    blocks.map((b) =>
      Decoration.replace({
        block: true,
        widget: new BlockWidget(
          b,
          liveCtx(state.doc, opts, b),
          opts,
          // On its own, or with text around it.
          ranges.some((r) => !r.empty && r.from <= b.from && r.to >= b.to),
          blocksOf,
        ),
      }).range(b.from, b.to),
    ),
  );
}

/** The block widget drawn for the block starting at `from`, if in view. */
function widgetAt(view: EditorView, from: number): HTMLElement | undefined {
  return [
    ...view.contentDOM.querySelectorAll<HTMLElement>(".cm-block-widget"),
  ].find((el) => view.posAtDOM(el) === from);
}

interface FieldValue {
  /** null = stale (after a composition step): rebuilt on the next typed
   *  edit or at the composition's end (calloutLive's staysStale). */
  blocks: LiveBlock[] | null;
  deco: DecorationSet;
}

export function blockWidgets(opts: BlockWidgetOptions): Extension {
  const blocksOf: BlocksOf = (state) => state.field(field).blocks;
  const field = StateField.define<FieldValue>({
    create(state) {
      const blocks = liveBlocks(syntaxTree(state), state.doc);
      return { blocks, deco: decorate(state, blocks, opts, blocksOf) };
    },
    update(v, tr) {
      // Mid-composition (Korean IME) nothing near the composed text may be
      // redrawn: only map the widgets along.
      if (tr.isUserEvent("input.type.compose"))
        return { blocks: null, deco: v.deco.map(tr.changes) };
      if (v.blocks === null && staysStale(tr)) return v;
      const tree = syntaxTree(tr.state);
      if (
        v.blocks === null ||
        tr.docChanged ||
        tree !== syntaxTree(tr.startState)
      ) {
        const blocks = liveBlocks(tree, tr.state.doc);
        return { blocks, deco: decorate(tr.state, blocks, opts, blocksOf) };
      }
      return tr.selection
        ? {
            blocks: v.blocks,
            deco: decorate(tr.state, v.blocks, opts, blocksOf),
          }
        : v;
    },
    provide: (f) => [
      EditorView.decorations.from(f, (v) => v.deco),
      // The caret steps over a drawn block; landing on its edge selects it.
      EditorView.atomicRanges.of((view) => view.state.field(f).deco),
    ],
  });
  // Last of the filters (caretSnap's included): a selection moved onto a
  // block's hidden source — a click, a key, a search, an undo — or a
  // delete's caret left there selects the block. Input leaves its caret
  // where it is: typing that closes a block (a fence's last backtick, ⏎
  // after ```mermaid, a paste) goes on there, or the next key would
  // replace the block. Typed on the blank line under a block, it is set
  // apart from it (apartTyped).
  const snap = Prec.highest(
    EditorState.transactionFilter.of((tr) => {
      const before = tr.docChanged && tr.startState.field(field).blocks;
      const over = before && typedOver(tr, before);
      if (over) return over;
      const apart = before && apartTyped(tr, before);
      if (apart) return [tr, { changes: apart, sequential: true }];
      if (
        tr.docChanged
          ? !["delete", "undo", "redo"].some((e) => tr.isUserEvent(e))
          : !tr.selection
      )
        return tr;
      const { blocks } = tr.state.field(field);
      const sel = blocks && snapToBlocks(blocks, tr.state.selection);
      return sel ? [tr, { selection: sel, sequential: true }] : tr;
    }),
  );
  const press =
    (key: BlockKey) =>
    (view: EditorView): boolean => {
      const { blocks } = view.state.field(field);
      if (view.composing || !blocks) return false;
      const b = key === "Enter" && selectedBlock(blocks, view.state.selection);
      if (b && b.spec.openEditor) {
        const el = widgetAt(view, b.from);
        if (el) b.spec.openEditor(el);
        return !!el;
      }
      const spec = blockKeyTr(view.state, blocks, key);
      if (!spec) return false;
      view.dispatch(spec);
      return true;
    };
  const keys: BlockKey[] = [
    "Enter",
    "Backspace",
    "Delete",
    "Escape",
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Tab",
    "Shift-Tab",
  ];
  const arrow =
    (forward: boolean) =>
    (view: EditorView): boolean => {
      const { selection } = view.state;
      const range = selection.main;
      if (view.composing || selection.ranges.length > 1 || !range.empty)
        return false;
      const target = view.moveVertically(range, forward).head;
      const drawn: { from: number; to: number }[] = [];
      view.state
        .field(field)
        .deco.between(
          Math.min(range.head, target),
          Math.max(range.head, target),
          (from, to) => void drawn.push({ from, to }),
        );
      const pos = stepInto(drawn, range.head, target, forward);
      if (pos === null) return false;
      view.dispatch({
        selection: { anchor: pos },
        scrollIntoView: true,
        userEvent: "select",
      });
      return true;
    };
  return [
    field,
    snap,
    composeEndRefresh,
    EditorView.updateListener.of((u) => {
      for (const tr of u.transactions)
        for (const e of tr.effects) {
          if (!e.is(openBlockEditor)) continue;
          const b = blocksOf(u.state)?.find((x) => x.from === e.value);
          const el = b?.spec.openEditor && widgetAt(u.view, b.from);
          if (el) b.spec.openEditor?.(el);
        }
      // An undo or redo, which skipped snap: its caret on a block selects it.
      const sel = undoneSnap(u.transactions, blocksOf(u.state));
      if (sel) u.view.dispatch({ selection: sel });
    }),
    // Above blockKeymap's Enter and liveEditing's Backspace, which would
    // replace or delete the selection as text.
    Prec.highest(keymap.of(keys.map((key) => ({ key, run: press(key) })))),
    Prec.high(
      keymap.of([
        { key: "ArrowDown", run: arrow(true) },
        { key: "ArrowUp", run: arrow(false) },
      ]),
    ),
    // ⌘X takes the block's lines out as Backspace does; ⌘C is CM's own copy
    // of the selection, the block's markdown.
    EditorView.domEventHandlers({
      // A key that types (an IME's first keystroke too: 229) on a block
      // selected whole starts a paragraph under it, and goes on into it:
      // replacing the block's DOM, a Korean composition left its first
      // jamo behind on a line of its own (Chromium). An IME's first
      // keystroke on the blank line under a block moves the caret apart
      // from it first: the composition is never rewritten (apartTyped).
      keydown(e, view) {
        if (e.metaKey || e.ctrlKey) return false;
        const ime = e.key === "Process" || e.keyCode === 229;
        if (e.key.length !== 1 && !ime) return false;
        const { blocks } = view.state.field(field);
        if (!blocks || view.state.readOnly) return false;
        const b = selectedBlock(blocks, view.state.selection);
        const spec = b
          ? lineAfter(view.state.doc, b)
          : ime && apartTr(view.state, blocks);
        if (spec) view.dispatch(spec);
        return false;
      },
      // A press below the block that ends the note (a widget's own presses
      // never get here) starts a line under it, as Notion does: CM would
      // put the caret on the block's end, which selects it.
      mousedown(e, view) {
        if (e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey)
          return false;
        const { blocks } = view.state.field(field);
        const { doc } = view.state;
        const b = blocks?.find((x) => x.to === doc.length);
        const el = b && !view.state.readOnly && widgetAt(view, b.from);
        if (!el || e.clientY <= el.getBoundingClientRect().bottom) return false;
        e.preventDefault();
        view.dispatch(lineAfter(doc, b));
        view.focus();
        return true;
      },
      cut(e, view) {
        const { blocks } = view.state.field(field);
        const b = blocks && selectedBlock(blocks, view.state.selection);
        if (!b || !e.clipboardData || view.state.readOnly) return false;
        e.preventDefault();
        e.clipboardData.setData(
          "text/plain",
          view.state.sliceDoc(b.from, b.to),
        );
        view.dispatch(removeBlock(view.state.doc, b, "delete.cut"));
        return true;
      },
    }),
  ];
}
