// How the block editor reads a markdown line: the Lezer nodes around a
// position, the block marks a line starts with (`## `, `> `, `- `, `- [ ] `,
// `1. `), which of them Live hides, and the frontmatter/code regions typing
// rules stay out of. Shared by editorBlocks (keys) and editorLists (nesting).

import type {
  ChangeSpec,
  EditorState,
  Line,
  Transaction,
} from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { SyntaxNode, Tree } from "@lezer/common";
import { frontmatterLength } from "./markdown";

export const CODE_BLOCKS = new Set([
  "FencedCode",
  // `$$…$$` (lib/blocks/math): TeX, not markdown; Enter breaks its line.
  "BlockMath",
  "CodeBlock",
  "HTMLBlock",
  "CommentBlock",
  "ProcessingInstructionBlock",
]);
/** Blocks whose text is prose: another paragraph may merge into them. */
export const PROSE = new Set([
  "Paragraph",
  "ATXHeading1",
  "ATXHeading2",
  "ATXHeading3",
  "ATXHeading4",
  "ATXHeading5",
  "ATXHeading6",
]);
/** Blocks that must stay apart from the text around them. */
export const APART = new Set(["Table", "HorizontalRule", "LinkReference"]);
const MARKS = new Set(["HeaderMark", "QuoteMark", "ListMark", "TaskMarker"]);
const FENCE_OPEN_RE = /^---[ \t]*\r?\n/;
/** A footnote definition, whatever its body parses as. */
export const FOOTNOTE_RE = /^\s*\[\^[^\]]+\]:/;
/** A line's quote marks (`> `, `> > `), before any indent or list marker. */
export const QUOTE_LEAD_RE = /^(?:[ \t]*>[ \t]?)*/;
export const TAB = 4; // Lezer markdown's tab stop

export const hasText = (s: string): boolean => /\S/.test(s);
export const isBlank = (c: string): boolean => c === " " || c === "\t";
/** A line's text past its quote marks: `> ` alone is an empty quote line. */
export const bodyText = (s: string): string =>
  s.slice(QUOTE_LEAD_RE.exec(s)?.[0].length ?? 0);

export function fmEnd(state: EditorState): number {
  // ponytail: 32 KB frontmatter cap (same as editorLive)
  return frontmatterLength(
    state.doc.sliceString(0, Math.min(state.doc.length, 32768)),
  );
}

/** Inside a frontmatter block, closed or still being typed. */
export function inFrontmatter(state: EditorState, pos: number): boolean {
  if (pos < fmEnd(state)) return true;
  const head = state.doc.sliceString(0, Math.min(pos, 32768));
  return FENCE_OPEN_RE.test(head) && frontmatterLength(head) === 0;
}

/** The syntax tree, parsed at least through `upto`. CM gives a new state's
 *  parse, and each edit's reparse, 20 ms of wall clock; on a busy machine it
 *  stops short of the caret and a key would read its line as plain text.
 *  Near the caret this costs nothing: the view has parsed its viewport. */
export function treeTo(state: EditorState, upto: number): Tree {
  return ensureSyntaxTree(state, upto, 50) ?? syntaxTree(state);
}

/** The note's whole tree. A state parses only its first 3000 chars (in
 *  20 ms) up front and the view parses the rest in the background, so
 *  `syntaxTree` can end short of a caret's block — or cut it in two. */
export function fullTree(state: EditorState): Tree {
  return treeTo(state, state.doc.length);
}

/** Syntax nodes around `pos`, innermost first. With only blanks before the
 *  caret on its line, the node to the right (the line's own block — a caret
 *  before a nested item's marker belongs to that item); otherwise the one
 *  ending at the caret. */
export function ancestors(state: EditorState, pos: number): SyntaxNode[] {
  const line = state.doc.lineAt(pos);
  const lead = state.doc.sliceString(line.from, pos);
  const right = pos === line.from || (/^[ \t]*$/.test(lead) && pos < line.to);
  const out: SyntaxNode[] = [];
  for (
    let n: SyntaxNode | null = fullTree(state).resolveInner(
      pos,
      right ? 1 : -1,
    );
    n;
    n = n.parent
  )
    out.push(n);
  return out;
}

/** A code or raw-HTML block (or frontmatter) owns `pos`: typing rules stay out. */
export function inCode(state: EditorState, pos: number): boolean {
  return (
    inFrontmatter(state, pos) ||
    ancestors(state, pos).some((n) => CODE_BLOCKS.has(n.name))
  );
}

export interface Mark {
  name: string;
  from: number;
  /** Past the mark's trigger space. */
  to: number;
  /** Live draws it hidden (a widget or nothing), so the caret stays out. */
  hidden: boolean;
}

/** The block marks a line starts with, outermost first. A `#` or `-` without
 *  its trigger space is not a mark yet — Notion converts on the space, and so
 *  does Live. `hidden` mirrors editorLive: an ordered number and a quote mark
 *  with no space after it stay visible. */
export function lineMarks(state: EditorState, line: Line): Mark[] {
  const tree = fullTree(state);
  const at = (p: number): string => line.text.charAt(p - line.from);
  const out: Mark[] = [];
  let pos = line.from;
  for (;;) {
    let p = pos;
    while (p < line.to && isBlank(at(p))) p++;
    if (p >= line.to) return out;
    const m = tree.resolveInner(p, 1);
    if (m.from !== p || !MARKS.has(m.name)) return out;
    const spaced = isBlank(at(m.to));
    if (!spaced && m.name !== "QuoteMark") return out;
    pos = spaced ? m.to + 1 : m.to;
    const ordered = m.name === "ListMark" && /\d/.test(at(m.from));
    out.push({
      name: m.name,
      from: m.from,
      to: pos,
      hidden: spaced && !ordered,
    });
  }
}

/** Where a line's text begins, past all its block marks; `line.from` if none. */
export function prefixEnd(state: EditorState, line: Line): number {
  const marks = lineMarks(state, line);
  return marks.length ? marks[marks.length - 1].to : line.from;
}

/** The spans at a line's start the caret must not rest in: runs of hidden
 *  marks, with the blanks between them and the indent before the first. A
 *  visible mark (an ordered `1.`, an unspaced `>`) splits the runs. */
export function hiddenRuns(
  state: EditorState,
  line: Line,
): { from: number; to: number }[] {
  const runs: { from: number; to: number }[] = [];
  let edge = line.from; // end of the text before the next mark
  let open = true; // only blanks since `edge`
  for (const m of lineMarks(state, line)) {
    const gapBlank = !hasText(state.doc.sliceString(edge, m.from));
    if (!m.hidden) {
      open = false;
    } else if (
      runs.length &&
      open &&
      gapBlank &&
      runs[runs.length - 1].to === edge
    ) {
      runs[runs.length - 1].to = m.to;
    } else {
      runs.push({ from: open && gapBlank ? edge : m.from, to: m.to });
    }
    if (m.hidden) open = true;
    edge = m.to;
  }
  return runs;
}

export function tr(
  state: EditorState,
  changes: ChangeSpec,
  anchor: number,
  userEvent: string,
): Transaction {
  return state.update({
    changes,
    selection: { anchor },
    scrollIntoView: true,
    userEvent,
  });
}

/** Consume a key with no change (the default would break the block). */
export function hold(state: EditorState): Transaction {
  return state.update({});
}
