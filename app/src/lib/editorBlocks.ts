// Notion-style block editing over the markdown source. Enter starts a new
// block — a blank line in the file, so nothing typed below can turn the line
// above into a heading or glue onto it — Shift-Enter breaks the line inside
// the block, Backspace/Delete at a block's edge drop its type or merge prose
// (never gluing a fence, rule, table, image or embed block or frontmatter),
// Tab nests a list item.
// The planners are pure over EditorState (vitest, node) and return the
// transaction to dispatch, or null for "let the default key handling run";
// blockKeymap / liveEditing bind them to the view.

import {
  EditorSelection,
  EditorState,
  Prec,
  type ChangeSpec,
  type Extension,
  type Line,
  type Transaction,
} from "@codemirror/state";
import {
  type Decoration,
  EditorView,
  keymap,
  type KeyBinding,
} from "@codemirror/view";
import { type LanguageSupport } from "@codemirror/language";
import {
  acceptCompletion,
  completionStatus,
  snippet,
  startCompletion,
} from "@codemirror/autocomplete";
import {
  insertNewlineContinueMarkupCommand,
  markdown,
  markdownLanguage,
} from "@codemirror/lang-markdown";
import type { SyntaxNode } from "@lezer/common";
// Types only (erased): the package lang-markdown's `extensions` are typed by.
import type { MarkdownConfig } from "@lezer/markdown";
import type { Strings } from "./i18n";
import { frontmatterLength } from "./markdown";
import {
  filterSlash,
  slashBlockEdit,
  slashItems,
  slashQueryAt,
  type SlashItem,
  type SlashPicker,
} from "./editorCompletions";
import {
  APART,
  CODE_BLOCKS,
  FOOTNOTE_RE,
  PROSE,
  QUOTE_LEAD_RE,
  ancestors,
  bodyText,
  fmEnd,
  fullTree,
  hasText,
  hiddenRuns,
  hold,
  inCode,
  inFrontmatter,
  isBlank,
  lineMarks,
  prefixEnd,
  tr,
  treeTo,
  type Mark,
} from "./editorMarks";
import {
  nextMarker,
  outdentItems,
  restartAfter,
  tabTr,
  withRenumber,
} from "./editorLists";
import { CODE_FENCE, turnBlockTr } from "./editorBlockOps";
import { calloutOf, foldedEnd } from "./blocks/calloutLive";
import { fenceBlock } from "./blocks/index";
import { CLOSE_RE, MATH_SYNTAX } from "./blocks/math";
import { openBlockEditor, paragraphBlock, stepInto } from "./blocks/live";
import { liveSpecs } from "./editorLive";
import type { CalloutHead } from "./blocks/callout";

/** Setext headings are off: a `=`, `-` or `---` typed under a paragraph must
 *  never restyle the paragraph above it (Notion has no such rule either). */
const NO_SETEXT = { remove: ["SetextHeading"] };

// Lezer markdown's own test for a flanking delimiter's neighbours.
export const PUNCT = /[\p{S}|\p{P}]/u;
const HIGHLIGHT_DELIM = { resolve: "Highlight", mark: "HighlightMark" };

/** Obsidian's `==highlight==`: a Highlight node over HighlightMark `==`s,
 *  delimited exactly as GFM's `~~` (lezer's Strikethrough), so Live reads
 *  the spans Preview's markdown-it-mark reads. */
const HIGHLIGHT_SYNTAX: MarkdownConfig = {
  defineNodes: ["Highlight", "HighlightMark"],
  parseInline: [
    {
      name: "Highlight",
      parse(cx, next, pos) {
        if (next !== 61 || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61)
          return -1;
        const before = cx.slice(pos - 1, pos);
        const after = cx.slice(pos + 2, pos + 3);
        const sBefore = /\s|^$/.test(before);
        const sAfter = /\s|^$/.test(after);
        const pBefore = PUNCT.test(before);
        const pAfter = PUNCT.test(after);
        return cx.addDelimiter(
          HIGHLIGHT_DELIM,
          pos,
          pos + 2,
          !sAfter && (!pAfter || sBefore || pBefore),
          !sBefore && (!pBefore || sAfter || pAfter),
        );
      },
      after: "Emphasis",
    },
  ],
};

/** The editor's markdown language. GFM base: Task/Strikethrough/Table nodes
 *  exist only there (Live relies on them). No `codeLanguages`: a fence is a
 *  plain mono block, and the html/css/javascript grammars lang-markdown would
 *  otherwise carry are aliased away in vite.config.ts (see langHtmlStub.ts,
 *  -167 kB); `completeHTMLTags` is off because that path needs the real
 *  lang-html. Its own Enter/Backspace keymap is off: blockKeymap owns them.
 *  ponytail: to bring fence colours back, load `codeLanguages` lazily when a
 *  fence scrolls into the viewport and reconfigure — never at boot. */
export function mycoMarkdown(): LanguageSupport {
  return markdown({
    base: markdownLanguage,
    extensions: [NO_SETEXT, HIGHLIGHT_SYNTAX, MATH_SYNTAX],
    completeHTMLTags: false,
    addKeymap: false,
  });
}

const EMPTY_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])(?: +\[[ xX]\])?\s*$/;
/** Inline spans Enter may not cut: split after them instead. */
const INLINE_ATOM = new Set(["Link", "Image", "InlineCode", "URL", "Autolink"]);
/** Inline spans Enter closes before the break and reopens after it. */
const INLINE_WRAP = new Set([
  "Emphasis",
  "StrongEmphasis",
  "Strikethrough",
  "Highlight",
]);

const block = (nodes: SyntaxNode[], names: Set<string>): boolean =>
  nodes.some((n) => names.has(n.name));

/** The Paragraph `pos` sits in continues from a line above (a soft line). */
function softLine(state: EditorState, pos: number, line: Line): boolean {
  const para = ancestors(state, pos).find((n) => n.name === "Paragraph");
  return !!para && para.from < line.from;
}

/** `line` is an image or a note embed Live draws as a block widget: held
 *  apart like a table, or its source would glue onto the text beside it. */
function isBlockLine(state: EditorState, line: Line): boolean {
  const para = ancestors(state, line.to).find((n) => n.name === "Paragraph");
  return !!para && paragraphBlock(para, state.doc)?.from === line.from;
}

/** The block `line` (with text) belongs to is prose another may merge with. */
function isProse(state: EditorState, line: Line): boolean {
  if (FOOTNOTE_RE.test(line.text) || inFrontmatter(state, line.to))
    return false;
  const nodes = ancestors(state, line.to);
  if (block(nodes, CODE_BLOCKS) || block(nodes, APART)) return false;
  return block(nodes, PROSE) && !isBlockLine(state, line);
}

/** Clear the lines `first`..`line` to an empty paragraph line, a blank line
 *  away from the text around it. */
function leaveChanges(
  state: EditorState,
  line: Line,
  first: Line = line,
): { changes: ChangeSpec[]; anchor: number } {
  const { doc } = state;
  const above = first.number > 1 && hasText(doc.line(first.number - 1).text);
  const below =
    line.number < doc.lines && hasText(doc.line(line.number + 1).text);
  const insert = (above ? "\n" : "") + (below ? "\n" : "");
  return {
    changes: [{ from: first.from, to: line.to, insert }],
    anchor: first.from + (above ? 1 : 0),
  };
}

function leaveBlock(state: EditorState, line: Line): Transaction {
  // A bare `>` line above — the gap Enter leaves between a callout's
  // paragraphs — goes too, not left hanging at the quote's end.
  const prev = line.number > 1 ? state.doc.line(line.number - 1) : null;
  const bare = prev && hasText(prev.text) && !hasText(bodyText(prev.text));
  const { changes, anchor } = leaveChanges(state, line, bare ? prev : line);
  return tr(state, changes, anchor, "input");
}

/** End of an inline span that covers `pos` and must not be cut (a link, a
 *  `[[wikilink]]`, inline code), or `pos` itself. */
function pastAtoms(state: EditorState, pos: number): number {
  let at = pos;
  for (
    let n: SyntaxNode | null = fullTree(state).resolveInner(pos, 0);
    n;
    n = n.parent
  ) {
    if (n.from >= pos || n.to <= pos || !INLINE_ATOM.has(n.name)) continue;
    // `[[x]]` parses as a Link between two literal brackets.
    const wiki =
      n.name === "Link" &&
      state.sliceDoc(n.from - 1, n.from) === "[" &&
      state.sliceDoc(n.to, n.to + 1) === "]";
    at = Math.max(at, wiki ? n.to + 1 : n.to);
  }
  return at;
}

/** Split at `pos`: the text after the caret opens the next block. Bold and
 *  strike spans are closed and reopened; a link or code span moves whole.
 *  With a `lead` (a quote's `> `) the new block stays in that quote, set
 *  apart by a bare `>` line. */
function split(
  state: EditorState,
  line: Line,
  pos: number,
  lead = "",
): Transaction {
  const { doc } = state;
  const at = pastAtoms(state, pos);
  let closes = "";
  let opens = "";
  for (
    let n: SyntaxNode | null = fullTree(state).resolveInner(at, 0);
    n;
    n = n.parent
  ) {
    if (!INLINE_WRAP.has(n.name) || n.from >= at || n.to <= at) continue;
    const open = n.firstChild;
    const close = n.lastChild;
    if (!open || !close || open === close) continue;
    closes += doc.sliceString(close.from, close.to);
    opens = doc.sliceString(open.from, open.to) + opens;
  }
  let from = at;
  while (from > line.from && isBlank(doc.sliceString(from - 1, from))) from--;
  let to = at;
  while (to < line.to && isBlank(doc.sliceString(to, to + 1))) to++;
  // The caret's new line must not sit on the soft-broken line below either.
  const gapBelow =
    to === line.to &&
    line.number < doc.lines &&
    hasText(bodyText(doc.line(line.number + 1).text));
  const gap = lead.trimEnd();
  const head = closes + "\n" + gap + "\n" + lead + opens;
  return tr(
    state,
    { from, to, insert: head + (gapBelow ? "\n" + gap : "") },
    from + head.length,
    "input",
  );
}

/** `line`'s text up to `to` with its list markers blanked: the prefix a new
 *  line takes to stay in the same quotes and list item. */
function containerLead(state: EditorState, line: Line, to: number): string {
  let lead = line.text.slice(0, to - line.from);
  for (const m of lineMarks(state, line)) {
    if (m.name === "QuoteMark" || m.from >= to) continue;
    const a = m.from - line.from;
    const b = Math.min(m.to, to) - line.from;
    lead = lead.slice(0, a) + " ".repeat(b - a) + lead.slice(b);
  }
  return lead;
}

/** Enter in a callout keeps its content in it (Notion's toggle): from the
 *  title, the first body line; from a body line, a new paragraph in the
 *  callout; from a folded toggle's title end, a block after the whole
 *  toggle. Before the title's text the callout moves down, as blocks do. */
function calloutEnter(
  state: EditorState,
  quote: SyntaxNode,
  c: { head: CalloutHead; tagFrom: number },
  line: Line,
  pos: number,
  start: number,
): Transaction {
  const { doc } = state;
  const lead = containerLead(state, line, start);
  const gap = lead.trimEnd();
  if (doc.lineAt(quote.from).number !== line.number)
    return pos <= start
      ? tr(
          state,
          { from: line.from, insert: gap + "\n" },
          pos + gap.length + 1,
          "input",
        )
      : split(state, line, pos, lead);
  const tagTo = c.tagFrom + c.head.tagLen;
  if (pos < tagTo || (pos === tagTo && c.head.title))
    return pushDown(state, line, pos);
  const end = foldedEnd(state, line.from);
  if (end !== null && pos === line.to) {
    const outer = containerLead(state, line, quote.from);
    const insert = "\n" + outer.trimEnd() + "\n" + outer;
    return tr(state, { from: end, insert }, end + insert.length, "input");
  }
  // Both parsers take only the first line as the title: the next quote line
  // is the body's first. A body below stays a paragraph of its own.
  let from = pos;
  while (from > tagTo && isBlank(doc.sliceString(from - 1, from))) from--;
  let to = pos;
  while (to < line.to && isBlank(doc.sliceString(to, to + 1))) to++;
  const changes: ChangeSpec[] = [{ from, to, insert: "\n" + lead }];
  if (
    line.number < doc.lines &&
    hasText(bodyText(doc.line(line.number + 1).text))
  )
    changes.push({ from: line.to, insert: "\n" + gap });
  return tr(state, changes, from + 1 + lead.length, "input");
}

/** Enter at a block's start: push the block down, the caret stays with it. */
function pushDown(state: EditorState, line: Line, pos: number): Transaction {
  const { doc } = state;
  const above = line.number > 1 && hasText(doc.line(line.number - 1).text);
  const insert = above ? "\n\n" : "\n";
  return tr(state, { from: line.from, insert }, pos + insert.length, "input");
}

const continueMarkup = insertNewlineContinueMarkupCommand({
  nonTightLists: false,
});

function markupTr(state: EditorState): Transaction | null {
  // lang-markdown reads syntaxTree(state), which can stop short of the caret
  // (see treeTo): run it on a twin holding the parsed tree, then replay its
  // changes on `state` so the view can dispatch them.
  treeTo(state, state.doc.lineAt(state.selection.main.head).to);
  let out = null as Transaction | null;
  continueMarkup({ state: state.update({}).state, dispatch: (t) => (out = t) });
  return (
    out &&
    state.update({
      changes: out.changes,
      selection: out.selection,
      scrollIntoView: true,
      userEvent: "input",
    })
  );
}

function closeFence(
  state: EditorState,
  fence: SyntaxNode,
  line: Line,
  pos: number,
): Transaction | null {
  const open = /^(\s*)(`{3,}|~{3,})/.exec(line.text);
  if (
    !open ||
    pos !== line.to ||
    state.doc.lineAt(fence.from).number !== line.number ||
    fence.getChildren("CodeMark").length > 1
  )
    return null;
  const indent = open[1];
  return tr(
    state,
    { from: pos, insert: "\n" + indent + "\n" + indent + open[2] },
    pos + 1 + indent.length,
    "input",
  );
}

/** Enter in a table: a new empty row below (below the delimiter from the
 *  header), or out of the table from the end of its last row. */
function tableEnter(
  state: EditorState,
  table: SyntaxNode,
  line: Line,
  pos: number,
): Transaction {
  const { doc } = state;
  if (line.number === doc.lineAt(table.to).number && pos === line.to)
    return split(state, line, pos);
  const head = doc.lineAt(table.from);
  const delim = doc.line(Math.min(head.number + 1, doc.lines));
  const cols = Math.max(
    1,
    delim.text.split("|").filter((c) => /-/.test(c)).length,
  );
  const row = line.number <= delim.number ? delim : line;
  return tr(
    state,
    { from: row.to, insert: "\n|" + " |".repeat(cols) },
    row.to + 3,
    "input",
  );
}

/** Enter inside a list item. */
function listEnter(
  state: EditorState,
  item: SyntaxNode,
  line: Line,
  pos: number,
  inQuote: boolean,
): Transaction | null {
  const { doc } = state;
  const list = item.parent ?? item;
  if (doc.lineAt(item.from).number !== line.number) {
    // A continuation line (after Shift-Enter): Enter opens the next item.
    const marker = nextMarker(state, item);
    let from = pos;
    while (from > line.from && isBlank(doc.sliceString(from - 1, from))) from--;
    let to = pos;
    while (to < line.to && isBlank(doc.sliceString(to, to + 1))) to++;
    return withRenumber(
      state,
      [{ from, to, insert: "\n" + marker }],
      list,
      "input",
      from + 1 + marker.length,
    );
  }
  const nested = list.parent?.name === "ListItem";
  const empty = EMPTY_ITEM_RE.test(line.text) && pos === line.to;
  if (empty && !nested && !inQuote) {
    const { changes, anchor } = leaveChanges(state, line);
    return tr(
      state,
      [...changes, ...restartAfter(state, item)],
      anchor,
      "input",
    );
  }
  if (empty && nested && !inQuote) {
    // Step out one level (upstream), and the siblings left hanging under the
    // lifted item restart at 1.
    const t = markupTr(state);
    const restart = state.changes(restartAfter(state, item));
    if (!t || restart.empty) return t;
    const mapped = restart.map(t.changes);
    return state.update({
      changes: t.changes.compose(mapped),
      selection: t.selection?.map(mapped),
      scrollIntoView: true,
      userEvent: "input",
    });
  }
  const start = prefixEnd(state, line);
  if (start > line.from && pos <= start && start < line.to) {
    // At (or before) the item's text: an empty item of the same kind goes
    // above, the caret stays with the text.
    const marker = line.text
      .slice(0, start - line.from)
      .replace(/\[[xX]\]/, "[ ]");
    return withRenumber(
      state,
      [{ from: line.from, insert: marker + "\n" }],
      list,
      "input",
      start + marker.length + 1,
    );
  }
  return markupTr(state);
}

/** Enter in a `$$` block: a line break keeping the line's container — a
 *  quote's `> `, an item's indent (under an item's own marker too). */
function mathBreak(state: EditorState, line: Line, pos: number): Transaction {
  const quote = QUOTE_LEAD_RE.exec(line.text)?.[0] ?? "";
  const marks = prefixEnd(state, line) - line.from;
  const lead =
    marks > quote.length
      ? quote + " ".repeat(marks - quote.length)
      : (/^(?:[ \t]*>[ \t]?)*[ \t]*/.exec(line.text)?.[0] ?? "");
  return tr(
    state,
    { from: pos, insert: "\n" + lead },
    pos + 1 + lead.length,
    "input",
  );
}

/** Enter. */
export function enterTr(state: EditorState): Transaction | null {
  const { main } = state.selection;
  if (state.selection.ranges.length > 1) return null;
  if (!main.empty) {
    // Replace the selection, then Enter as usual — one undo step.
    const cut = state.update({
      changes: { from: main.from, to: main.to },
      selection: { anchor: main.from },
    });
    const t = enterTr(cut.state);
    return t
      ? state.update({
          changes: cut.changes.compose(t.changes),
          selection: t.selection,
          scrollIntoView: true,
          userEvent: "input",
        })
      : null;
  }
  const pos = main.head;
  const { doc } = state;
  const line = doc.lineAt(pos);
  if (inFrontmatter(state, pos)) return null;
  if (!hasText(bodyText(line.text))) {
    // Blanks (or bare `>`) under an item — a Shift-Enter continuation left
    // empty: the next item. Never inside code.
    if (line.text && line.number > 1 && !inCode(state, pos)) {
      const above = ancestors(state, doc.line(line.number - 1).to).find(
        (n) => n.name === "ListItem",
      );
      if (above) {
        const marker = nextMarker(state, above);
        return withRenumber(
          state,
          [{ from: line.from, to: line.to, insert: marker }],
          above.parent ?? above,
          "input",
          line.from + marker.length,
        );
      }
    }
    if (!hasText(line.text)) return null;
  }
  const nodes = ancestors(state, pos);
  const fence = nodes.find((n) => n.name === "FencedCode");
  if (fence) return closeFence(state, fence, line, pos);
  // `$$…$$` (lib/blocks/math): inside, a line break under the line's own
  // container; right past a one-line formula, Enter as past any text — a
  // bare `$$` (no closer after it yet) is an opener, not a formula.
  const math = nodes.find((n) => n.name === "BlockMath");
  const pastMath =
    !!math &&
    pos === math.to &&
    doc.lineAt(math.from).number === line.number &&
    CLOSE_RE.test(doc.sliceString(math.from + 2, math.to));
  if (math && !pastMath) return mathBreak(state, line, pos);
  if (!pastMath && block(nodes, CODE_BLOCKS)) return null;
  const table = nodes.find((n) => n.name === "Table");
  if (table) return tableEnter(state, table, line, pos);
  const inner = nodes.find(
    (n) => n.name === "ListItem" || n.name === "Blockquote",
  );
  const ownItem =
    inner?.name === "ListItem" && doc.lineAt(inner.from).number === line.number;
  if (EMPTY_ITEM_RE.test(bodyText(line.text)) && pos === line.to && !ownItem) {
    // An empty marker the parser reads as text (it cannot interrupt a
    // paragraph): step out to the enclosing item's level, or leave.
    if (inner?.name !== "ListItem") return leaveBlock(state, line);
    const marker = nextMarker(state, inner);
    return withRenumber(
      state,
      [{ from: line.from, to: line.to, insert: marker }],
      inner.parent ?? inner,
      "input",
      line.from + marker.length,
    );
  }
  if (inner?.name === "ListItem")
    return listEnter(
      state,
      inner,
      line,
      pos,
      nodes.some((n) => n.name === "Blockquote"),
    );
  const start = prefixEnd(state, line);
  // An empty heading or quote leaves its block, like an empty list item.
  if (start > line.from && !hasText(doc.sliceString(start, line.to)))
    return leaveBlock(state, line);
  for (const n of nodes) {
    const c = n.name === "Blockquote" ? calloutOf(n, doc) : null;
    if (c) return calloutEnter(state, n, c, line, pos, start);
  }
  if (pos <= start) return pushDown(state, line, pos);
  return split(state, line, pos);
}

/** Shift-Enter: a line break that stays inside the block. */
export function shiftEnterTr(state: EditorState): Transaction | null {
  const { main } = state.selection;
  if (state.selection.ranges.length > 1 || !main.empty) return null;
  const pos = main.head;
  if (inCode(state, pos)) return null;
  const line = state.doc.lineAt(pos);
  const nodes = ancestors(state, pos);
  const item = nodes.find((n) => n.name === "ListItem");
  let lead = "";
  if (item) {
    const first = state.doc.lineAt(item.from);
    const quote = QUOTE_LEAD_RE.exec(first.text)?.[0] ?? "";
    lead =
      quote + " ".repeat(prefixEnd(state, first) - first.from - quote.length);
  } else if (nodes.some((n) => n.name === "Blockquote")) {
    lead = /^\s*(?:>\s?)+/.exec(line.text)?.[0] ?? "";
  }
  return tr(
    state,
    { from: pos, insert: "\n" + lead },
    pos + 1 + lead.length,
    "input",
  );
}

/** Backspace (Live): at a block's text start drop its innermost type; at a
 *  paragraph's start merge it into the prose above. A fence, rule, table,
 *  definition or frontmatter is never glued onto — the key is held. */
export function backspaceTr(state: EditorState): Transaction | null {
  const { main } = state.selection;
  if (state.selection.ranges.length > 1 || !main.empty) return null;
  const pos = main.head;
  const { doc } = state;
  const fm = fmEnd(state);
  // Right after the frontmatter the default would delete the whole (atomic)
  // block or join the text onto its closing fence.
  if (fm > 0 && pos > 0 && pos <= fm) return hold(state);
  if (inCode(state, pos)) return null;
  const line = doc.lineAt(pos);
  if (!hasText(line.text) && line.number > 1)
    return blankBackspace(state, line, fm);
  const marks = lineMarks(state, line);
  const last = marks[marks.length - 1];
  // At the text start — or at column 0 before a visible number (Home on an
  // ordered item), where the default would join `2. ` into the item above.
  if (last && (pos === last.to || (pos === line.from && !marks[0].hidden)))
    return dropMark(state, line, marks, last.to);
  if (pos !== line.from || line.number === 1) return null;
  if (softLine(state, pos, line)) return null; // the default joins the lines
  let prev = doc.line(line.number - 1);
  let blanks = 0;
  while (!hasText(prev.text) && prev.number > 1) {
    blanks++;
    prev = doc.line(prev.number - 1);
  }
  if (!hasText(prev.text)) return null; // only blank lines above
  if (fm > 0 && prev.to < fm)
    // Blank lines under the frontmatter go; the fence itself stays.
    return tr(state, { from: fm, to: pos }, fm, "delete.backward");
  const here = ancestors(state, pos);
  if (
    here.some((n) => n.name === "Paragraph") &&
    !FOOTNOTE_RE.test(line.text) &&
    !isBlockLine(state, line) &&
    isProse(state, prev)
  )
    return tr(state, { from: prev.to, to: pos }, prev.to, "delete.backward");
  // Must stay apart: a spare blank line may go, never the last one.
  return blanks >= 2 ? null : hold(state);
}

/** The callout `line` is the title of (the innermost), or null. */
function calloutTitledBy(
  state: EditorState,
  line: Line,
): { quote: SyntaxNode; c: { head: CalloutHead; tagFrom: number } } | null {
  for (const n of ancestors(state, line.to)) {
    if (n.name !== "Blockquote") continue;
    if (state.doc.lineAt(n.from).number !== line.number) return null;
    const c = calloutOf(n, state.doc);
    if (c) return { quote: n, c };
  }
  return null;
}

/** Take a callout out of its quote, one level — its tag, and on each of its
 *  lines its own quote mark — so its text stays text, as Cmd+Opt+0 leaves
 *  it: never `[!tip] Title` in the prose, never its body a plain quote. */
function unwrapCalloutTr(
  state: EditorState,
  quote: SyntaxNode,
  c: { head: CalloutHead; tagFrom: number },
  pos: number,
): Transaction {
  const { doc } = state;
  let depth = 0;
  for (let n: SyntaxNode | null = quote; n; n = n.parent)
    if (n.name === "Blockquote") depth++;
  const first = doc.lineAt(quote.from).number;
  const changes: ChangeSpec[] = [];
  for (let k = first; k <= doc.lineAt(quote.to).number; k++) {
    const l = doc.line(k);
    const mark = lineMarks(state, l).filter((m) => m.name === "QuoteMark")[
      depth - 1
    ];
    // A lazy line has no mark of its own.
    if (mark)
      changes.push({
        from: mark.from,
        to: k === first ? c.tagFrom + c.head.tagLen : mark.to,
      });
  }
  const set = state.changes(changes);
  return tr(state, set, set.mapPos(pos, -1), "delete.backward");
}

/** Backspace on an empty line undoes one Enter: it takes this line out (and
 *  the blank line Enter put above it) and puts the caret at the end of the
 *  block above — one press per Enter, so text is never reached. The blank
 *  line two blocks need between them stays. After a code block the caret goes
 *  to its last code line and after a divider to the line right below it
 *  (typing at the end of either would break the block). */
function blankBackspace(
  state: EditorState,
  line: Line,
  fm: number,
): Transaction | null {
  const { doc } = state;
  const prev = doc.line(line.number - 1);
  const textBelow =
    line.number < doc.lines && hasText(doc.line(line.number + 1).text);
  if (!hasText(prev.text)) {
    const before = prev.number > 1 ? doc.line(prev.number - 1) : null;
    // One of several empty lines, or text right below: just this line goes.
    if (textBelow || !before || !hasText(before.text))
      return tr(
        state,
        { from: prev.to, to: line.to },
        prev.to,
        "delete.backward",
      );
    return collapseOnto(state, before, line, fm);
  }
  // The only blank line between two blocks: keep it, step up.
  if (textBelow)
    return state.update({
      selection: { anchor: prev.to },
      scrollIntoView: true,
      userEvent: "select",
    });
  return collapseOnto(state, prev, line, fm);
}

/** Remove the lines from the end of block `a` through `line`. */
function collapseOnto(
  state: EditorState,
  a: Line,
  line: Line,
  fm: number,
): Transaction {
  const { doc } = state;
  // Under the frontmatter the body starts right below the closing fence.
  if (fm > 0 && a.to < fm)
    return tr(state, { from: fm, to: line.to }, fm, "delete.backward");
  const nodes = ancestors(state, a.to);
  if (nodes.some((n) => n.name === "HorizontalRule"))
    return tr(
      state,
      { from: a.to, to: line.to, insert: "\n" },
      a.to + 1,
      "delete.backward",
    );
  const fence = nodes.find((n) => n.name === "FencedCode");
  // A registry fence (```toc) is a widget, not code: the caret at its end,
  // where ArrowUp lands too, selects the block (blocks/live).
  const info = fence?.getChild("CodeInfo");
  const widget = !!info && !!fenceBlock(doc.sliceString(info.from, info.to));
  const caret =
    fence && !widget && a.number > doc.lineAt(fence.from).number
      ? doc.line(a.number - 1).to
      : a.to;
  return tr(state, { from: a.to, to: line.to }, caret, "delete.backward");
}

function dropMark(
  state: EditorState,
  line: Line,
  marks: Mark[],
  pos: number,
): Transaction | null {
  const { doc } = state;
  const last = marks[marks.length - 1];
  const prev = line.number > 1 ? doc.line(line.number - 1) : null;
  const nodes = ancestors(state, pos);
  const item = nodes.find((n) => n.name === "ListItem");
  if (last.name === "QuoteMark") {
    // A quote's soft line (after Shift-Enter): take the break back.
    if (prev && softLine(state, pos, line))
      return tr(state, { from: prev.to, to: pos }, prev.to, "delete.backward");
    const titled = calloutTitledBy(state, line);
    if (titled && pos === titled.c.tagFrom)
      return unwrapCalloutTr(state, titled.quote, titled.c, pos);
    return tr(
      state,
      { from: last.from, to: pos },
      last.from,
      "delete.backward",
    );
  }
  // A heading inside a list item stays in its item: only the mark goes.
  if (last.name === "HeaderMark" && item)
    return tr(
      state,
      { from: last.from, to: pos },
      last.from,
      "delete.backward",
    );
  const before = marks[marks.length - 2];
  // A to-do's `- [ ] ` goes as one: Notion turns a to-do into text, not a bullet.
  const from =
    last.name === "TaskMarker" && before?.name === "ListMark"
      ? before.from
      : last.from;
  if (item && item.parent?.parent?.name === "ListItem")
    return outdentItems(state, [item]);
  // The line leaves its list or heading; inside a quote it stays quoted, set
  // apart by `>` lines so it neither joins its neighbours nor splits the quote.
  const gap = (
    QUOTE_LEAD_RE.exec(line.text.slice(0, from - line.from))?.[0] ?? ""
  ).trimEnd();
  const next = line.number < doc.lines ? doc.line(line.number + 1) : null;
  const changes: ChangeSpec[] = [];
  if (prev && hasText(bodyText(prev.text)))
    changes.push({ from: line.from, insert: gap + "\n" });
  changes.push({ from, to: pos });
  if (next && hasText(bodyText(next.text)))
    changes.push({ from: line.to, insert: "\n" + gap });
  const anchor = state.changes(changes).mapPos(pos, -1);
  if (item) changes.push(...restartAfter(state, item));
  return tr(state, changes, anchor, "delete.backward");
}

/** Forward Delete at a block's end (Live): pull the next prose block's text
 *  up without its marks (Notion's merge); a fence, rule, table, definition
 *  or callout below is never pulled up — the key is held. A quote's soft
 *  line joins without its `> `. */
export function deleteTr(state: EditorState): Transaction | null {
  const { main } = state.selection;
  if (state.selection.ranges.length > 1 || !main.empty) return null;
  const pos = main.head;
  const { doc } = state;
  const line = doc.lineAt(pos);
  if (pos !== line.to || !hasText(line.text) || inCode(state, pos)) return null;
  // A folded toggle's body is out of sight: nothing of it comes up; an
  // image or embed block takes no text into its line.
  if (foldedEnd(state, line.from) !== null) return hold(state);
  let next = line;
  let blanks = 0;
  do {
    if (next.number === doc.lines) return null;
    next = doc.line(next.number + 1);
    if (!hasText(next.text)) blanks++;
  } while (!hasText(next.text));
  if (isBlockLine(state, line)) return blanks >= 2 ? null : hold(state);
  // The same paragraph continues below: the default joins the soft line —
  // in a quote, without the line's quote marks.
  if (blanks === 0 && softLine(state, next.from, next)) {
    if (!ancestors(state, next.from).some((n) => n.name === "Blockquote"))
      return null;
    let to = prefixEnd(state, next);
    while (to < next.to && isBlank(doc.sliceString(to, to + 1))) to++;
    return tr(state, { from: pos, to }, pos, "delete.forward");
  }
  if (
    isProse(state, line) ||
    ancestors(state, pos).some(
      (n) => n.name === "ListItem" || n.name === "Blockquote",
    )
  ) {
    const nextNodes = ancestors(state, next.from);
    const nextProse =
      !FOOTNOTE_RE.test(next.text) &&
      !block(nextNodes, CODE_BLOCKS) &&
      !block(nextNodes, APART) &&
      !isBlockLine(state, next) &&
      (block(nextNodes, PROSE) ||
        nextNodes.some(
          (n) => n.name === "ListItem" || n.name === "Blockquote",
        ));
    // A callout's title would come up with its `[!type]`, its body left a
    // plain quote: held.
    if (nextProse && !calloutTitledBy(state, next))
      return tr(
        state,
        { from: pos, to: prefixEnd(state, next) },
        pos,
        "delete.forward",
      );
  }
  return blanks >= 2 ? null : hold(state);
}

// A block marker as typed at a block's text start, before its trigger space.
const MARKER_RE = /^(?:#{1,6}|[-*+]|\d+[.)]|>|\[ ?\])$/;

/** A marker typed at the text start of a block that already has one turns the
 *  block into that kind (Notion): `### ` at an H2's start makes an H3, `1. `
 *  in a bullet makes it numbered — instead of text inside the old block. */
function retypeTr(
  state: EditorState,
  line: Line,
  pos: number,
): Transaction | null {
  const marks = lineMarks(state, line);
  if (!marks.length) return null;
  const typed = state.doc.sliceString(marks[marks.length - 1].to, pos);
  if (!MARKER_RE.test(typed)) return null;
  const heading = marks.some((k) => k.name === "HeaderMark");
  // `## 1. Overview` is a numbered heading, not a list.
  if (heading && /^\d/.test(typed)) return null;
  const listish = /^[-*+\d[]/.test(typed);
  const item = marks.find((k) => k.name === "ListMark");
  if (!listish && item) {
    // A heading or quote out of a nested item would strand its children as
    // an indented code block: leave that as typed text.
    const node = ancestors(state, pos).find((n) => n.name === "ListItem");
    if (node?.parent?.parent?.name === "ListItem") return null;
  }
  // A list marker swaps only the item's own mark, or goes after the line's
  // quote marks (the quote stays); a heading or quote replaces the prefix.
  const lead = line.from + (QUOTE_LEAD_RE.exec(line.text)?.[0].length ?? 0);
  const from = listish ? (item ? item.from : lead) : line.from;
  const insert = (typed.startsWith("[") ? "- [ ]" : typed) + " ";
  return tr(
    state,
    { from, to: pos, insert },
    from + insert.length,
    "input.type",
  );
}

/** Notion input rules (Live): `[] ` → to-do; a marker at a block's text start
 *  changes its type; `---` under text → a divider set apart, so no markdown
 *  reader takes it for a setext heading. */
export function inputRuleTr(
  state: EditorState,
  from: number,
  to: number,
  text: string,
): Transaction | null {
  if (from !== to || inCode(state, from)) return null;
  const { doc } = state;
  const line = doc.lineAt(from);
  const before = doc.sliceString(line.from, from);
  if (text === " ") {
    const m = /^(\s*)(?:[-*+] )?\[ ?\]$/.exec(before);
    if (!m) return retypeTr(state, line, from);
    const insert = m[1] + "- [ ] ";
    return tr(
      state,
      { from: line.from, to: from, insert },
      line.from + insert.length,
      "input.type",
    );
  }
  if (
    text === "-" &&
    before === "--" &&
    from === line.to &&
    line.number > 1 &&
    hasText(doc.line(line.number - 1).text)
  )
    return tr(
      state,
      { from: line.from, to: from, insert: "\n---" },
      line.from + 4,
      "input.type",
    );
  return null;
}

/** Turn the caret's block into the `prefix` kind (`""` = plain text), keeping
 *  its text and the caret's place in it — Notion's Cmd+Opt+0..8. The block
 *  menu's Turn into, so a paragraph's soft lines all convert. */
export function turnIntoTr(
  state: EditorState,
  prefix: string,
): Transaction | null {
  const { main } = state.selection;
  if (state.selection.ranges.length > 1 || !main.empty) return null;
  if (inCode(state, main.head)) return null;
  return turnBlockTr(state, main.head, prefix);
}

// Notion's turn-into keys: Cmd+Opt+0 text, 1-3 headings, 4 to-do, 5 bullet,
// 6 numbered, 7 toggle, 8 code.
export const TURN_INTO = [
  "",
  "# ",
  "## ",
  "### ",
  "- [ ] ",
  "- ",
  "1. ",
  "> [!note]- ",
  CODE_FENCE,
];

/**
 * Where the caret lands when a note opens: after the frontmatter and, for a
 * note that holds nothing but its seed `# Title`, at the end so typing starts
 * the body. Otherwise at the first line's text (past `## ` etc.). Counted in
 * CodeMirror's text, where every `\r\n` is one `\n` — a raw offset overshoots
 * a CRLF file and the view refuses the selection.
 */
export function bodyStart(raw: string): number {
  const doc = raw.replace(/\r\n?/g, "\n");
  let pos = frontmatterLength(doc);
  pos += /^(?:[ \t]*\n)*/.exec(doc.slice(pos))?.[0].length ?? 0;
  const rest = doc.slice(pos);
  if (/^# [^\n]*\s*$/.test(rest)) return doc.length;
  return (
    pos + (/^(?:#{1,6} |> |[-*+] (?:\[[ xX]\] )?)/.exec(rest)?.[0].length ?? 0)
  );
}

/** Opens a slash item's picker at `pos` (components/RecallPicker). */
export type OpenPicker = (mode: SlashPicker, pos: number) => void;

/** Apply a `/` item over [from,to) (the typed `/query`). Block items turn the
 *  whole line into that block, wherever on the line they were called; a
 *  picker item drops only the query and opens there, so a picker closed
 *  without a choice leaves the text as it was before the `/` (what it
 *  inserts goes in as a block of its own, insertBlockTr). A block item
 *  called mid-line drops the blanks before it too, stopping at the line's
 *  block marks: `- /table` keeps `- `. */
export function applySlash(
  view: { state: EditorState; dispatch: (tr: Transaction) => void },
  item: SlashItem,
  from: number,
  to: number,
  openPicker?: OpenPicker,
): void {
  const { state } = view;
  const { doc } = state;
  const line = doc.lineAt(from);
  const marks = prefixEnd(state, line);
  if (item.picker) {
    view.dispatch(tr(state, { from, to }, from, "input.complete"));
    openPicker?.(item.picker, from);
    return;
  }
  // A plugin's command (lib/pluginRuntime) acts on the note as the
  // `/query` leaves it, like a picker; what it inserts is its own edit.
  if (item.run) {
    view.dispatch(tr(state, { from, to }, from, "input.complete"));
    item.run(view as EditorView);
    return;
  }
  if (item.block !== undefined) {
    const e = slashBlockEdit(
      line.text,
      from - line.from,
      to - line.from,
      item.block,
    );
    view.dispatch(
      state.update({
        changes: { from: line.from, to: line.to, insert: e.text },
        selection: { anchor: line.from + e.caret },
        scrollIntoView: true,
        userEvent: "input.complete",
      }),
    );
    return;
  }
  // A Completion, so the insert is its own undo step ("input.complete"), not
  // folded into the typing before it.
  const picked = { label: item.label };
  const template = item.templateFor?.(doc.toString()) ?? item.template;
  // `pre` + the item + `post` over [a, b): a snippet, or a plain-text item
  // with its caret.
  const put = (pre: string, post: string, a: number, b: number): void => {
    if (item.caret === undefined) {
      snippet(pre + template + post)(view, picked, a, b);
      if (!item.open) return;
      // The last block of the snippet — past its last blank line, ending
      // on the line above the caret's `${}` — opens its editor.
      const gap = template.lastIndexOf("\n\n");
      const last = gap < 0 ? template : template.slice(gap + 2);
      const at = view.state.selection.main.head - (last.length - "${}".length);
      view.dispatch(view.state.update({ effects: openBlockEditor.of(at) }));
      return;
    }
    view.dispatch(
      state.update({
        changes: { from: a, to: b, insert: pre + template + post },
        selection: { anchor: a + pre.length + item.caret },
        scrollIntoView: true,
        userEvent: "input.complete",
        effects: item.open ? openBlockEditor.of(a + pre.length) : [],
      }),
    );
  };
  const rest =
    line.text.slice(0, from - line.from) + line.text.slice(to - line.from);
  const textBelow =
    line.number < doc.lines && hasText(doc.line(line.number + 1).text);
  if (item.inline || !hasText(rest)) {
    const above =
      item.apart && line.number > 1 && hasText(doc.line(line.number - 1).text);
    const below = item.apart && textBelow;
    put(above ? "\n" : "", below ? "\n" : "", from, to);
    // startCompletion only reads `state` and dispatches; a view without the
    // completion extension (tests) makes it a no-op.
    if (item.reopen) startCompletion(view as EditorView);
    return;
  }
  // A block called mid-line opens on its own line below, the line kept — as
  // one change, so one undo takes it all back. Into a snippet the kept text
  // goes escaped: `${` / `#{` in it would read as snippet fields.
  let cut = from;
  while (cut > marks && isBlank(doc.sliceString(cut - 1, cut))) cut--;
  const tail = doc.sliceString(to, line.to);
  put(
    (item.caret === undefined ? tail.replace(/([#$])\{/g, "$1\\{") : tail) +
      "\n\n",
    textBelow ? "\n" : "",
    cut,
    line.to,
  );
  if (item.reopen) startCompletion(view as EditorView);
}

/** `/h2⏎` typed faster than the menu opens still applies the first match —
 *  but not once the menu was dismissed (Escape): then `/h2` is meant as text.
 *  A match from `more` (a vault template) while the menu is still reading
 *  is applied once `refresh` has read the files again: the last read may
 *  hold an older body. */
function slashOnEnter(
  view: EditorView,
  t: Strings,
  openPicker?: (view: EditorView, mode: SlashPicker, pos: number) => void,
  more?: () => readonly SlashItem[],
  refresh?: () => Promise<void>,
): boolean {
  const { state } = view;
  const { main } = state.selection;
  const status = completionStatus(state);
  if (!main.empty || status === null) return false;
  if (inCode(state, main.head)) return false;
  const line = state.doc.lineAt(main.head);
  const m = slashQueryAt(line.text.slice(0, main.head - line.from));
  if (!m?.query) return false;
  const query = m.query;
  const extra = more?.() ?? [];
  const item = filterSlash([...slashItems(t), ...extra], query)[0];
  if (!item) return false;
  const apply = (it: SlashItem): void =>
    applySlash(
      view,
      it,
      line.from + m.from,
      main.head,
      openPicker && ((mode, pos) => openPicker(view, mode, pos)),
    );
  if (!refresh || status !== "pending" || !extra.includes(item)) {
    apply(item);
    return true;
  }
  const { doc } = state;
  void refresh().then(() => {
    // Typed on or moved meanwhile: this Enter no longer applies.
    if (view.state.doc !== doc || !view.state.selection.eq(state.selection))
      return;
    const now = filterSlash([...slashItems(t), ...(more?.() ?? [])], query)[0];
    // The template is gone: the key is a plain Enter after all.
    if (now) apply(now);
    else run(enterTr)(view);
  });
  return true;
}

const run =
  (plan: (state: EditorState) => Transaction | null) =>
  (view: EditorView): boolean => {
    // Mid-composition (Korean IME) the key belongs to the IME.
    if (view.composing) return false;
    const t = plan(view.state);
    if (!t) return false;
    view.dispatch(t);
    return true;
  };

/** Tab (dir 1) / Shift-Tab: take the completion, else nest or lift list
 *  items. In an item that cannot move the key is held (Notion); anywhere
 *  else it goes on, so Tab leaves the editor for the next control (WCAG
 *  2.1.2 — no keyboard trap). */
export function tabKey(dir: 1 | -1) {
  return (view: EditorView): boolean =>
    (dir > 0 && acceptCompletion(view)) ||
    run((s) => tabTr(s, dir))(view) ||
    (!view.composing &&
      ancestors(view.state, view.state.selection.main.head).some(
        (n) => n.name === "ListItem",
      ));
}

/** Enter / Shift-Enter / Tab / Shift-Tab / Cmd+Opt+0..8, above the default
 *  keymap and below the completion popup's own Enter. Both Source and Live.
 *  `openPicker` opens a picker item's picker (`/recall⏎` typed fast);
 *  `more` = the menu's items past slashItems (the vault's `slash:` templates),
 *  as last read — `refresh` reads them again. */
export function blockKeymap(
  t: Strings,
  openPicker?: (view: EditorView, mode: SlashPicker, pos: number) => void,
  more?: () => readonly SlashItem[],
  refresh?: () => Promise<void>,
): Extension {
  const enter = run(enterTr);
  const bindings: KeyBinding[] = [
    {
      key: "Enter",
      run: (view) =>
        (!view.composing && slashOnEnter(view, t, openPicker, more, refresh)) ||
        enter(view),
    },
    { key: "Shift-Enter", run: run(shiftEnterTr) },
    { key: "Tab", run: tabKey(1) },
    { key: "Shift-Tab", run: tabKey(-1) },
    ...TURN_INTO.map((prefix, n) => ({
      key: `Mod-Alt-${n}`,
      run: run((s) => turnIntoTr(s, prefix)),
      preventDefault: true,
    })),
  ];
  return Prec.high(keymap.of(bindings));
}

/** The end of the hidden run `pos` sits in, else null. */
function runEnd(state: EditorState, pos: number): number | null {
  for (const r of hiddenRuns(state, state.doc.lineAt(pos)))
    if (pos >= r.from && pos < r.to) return r.to;
  return null;
}

/**
 * The caret never rests inside the block marks Live hides (`## `, `- `,
 * `> `, a to-do's box): it snaps to the text. A pointer selection (a drag, a
 * click in the left padding that selects the zero-width marks, a triple-click)
 * drops them too, and a triple-click stops at the line's end so the blank
 * line below survives retyping; a keyboard selection's head stops at the text
 * start (Shift-ArrowLeft steps past it, see stepLeft).
 */
const caretSnap = EditorState.transactionFilter.of((t) => {
  if (!t.selection) return t;
  const { state } = t;
  const { doc } = state;
  const pointer = t.isUserEvent("select.pointer");
  let moved = false;
  const ranges = t.selection.ranges.map((r) => {
    if (r.empty) {
      const to = runEnd(state, r.head);
      if (to === null) return r;
      moved = true;
      return EditorSelection.cursor(to);
    }
    if (!pointer) {
      const head = runEnd(state, r.head);
      if (head === null) return r;
      moved = true;
      return EditorSelection.range(r.anchor, head);
    }
    const lo = runEnd(state, r.from) ?? r.from;
    let hi = runEnd(state, r.to) ?? r.to;
    const hiLine = doc.lineAt(hi);
    if (hi === hiLine.from && hiLine.number > doc.lineAt(lo).number)
      hi = doc.line(hiLine.number - 1).to;
    if (hi < lo) hi = lo;
    if (lo === r.from && hi === r.to) return r;
    moved = true;
    if (lo === hi) return EditorSelection.cursor(lo);
    const forward = r.head >= r.anchor;
    return EditorSelection.range(forward ? lo : hi, forward ? hi : lo);
  });
  return moved
    ? [
        t,
        {
          selection: EditorSelection.create(ranges, t.selection.mainIndex),
          sequential: true,
        },
      ]
    : t;
});

/** ArrowLeft (or Shift-ArrowLeft, extending) from a hidden run's end steps
 *  past the run — to the visible mark before it, or the end of the line
 *  above — where the snap would otherwise hold it. Not into frontmatter: a
 *  character typed there would land after the hidden block. */
function stepLeft(extend: boolean) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const { main } = state.selection;
    if (state.selection.ranges.length > 1 || (!extend && !main.empty))
      return false;
    const line = state.doc.lineAt(main.head);
    const run = hiddenRuns(state, line).find((r) => r.to === main.head);
    if (!run) return false;
    let target = run.from - 1;
    if (run.from === line.from) {
      if (line.number === 1 || line.from - 1 < fmEnd(state)) return true;
      target = line.from - 1;
    }
    view.dispatch({
      selection: extend
        ? EditorSelection.range(main.anchor, target)
        : { anchor: target },
      scrollIntoView: true,
      userEvent: "select",
    });
    return true;
  };
}

/** Pure: a line Live draws short (`live-gap`) with no caret on it — asked
 *  of liveSpecs itself, so the keys skip exactly the lines drawn as gaps. */
export function isGapLine(state: EditorState, lineNumber: number): boolean {
  const { from, to } = state.doc.line(lineNumber);
  return liveSpecs(treeTo(state, to), state.doc, [], from, to).some(
    (s) => s.kind === "line" && s.cls === "live-gap" && s.from === from,
  );
}

/** Pure: the line ArrowUp/ArrowDown ends on once CM's vertical move put the
 *  head at `head` — its line, or from a gap line the first line past the
 *  gap run (the note's first or last line stops the walk, gap or not). By
 *  line number, not pixels: CM's half-line step from a short gap line
 *  overshoots a short line beside it (a closed fence's end line). Null
 *  inside the hidden frontmatter, where the key holds the caret instead:
 *  one Delete or Enter there wipes it or pushes it off line 1. The line
 *  after it is the note's first. */
export function verticalStop(
  state: EditorState,
  head: number,
  forward: boolean,
): number | null {
  const fm = fmEnd(state);
  if (head < fm) return null;
  const { doc } = state;
  let n = doc.lineAt(head).number;
  while (doc.line(n).from > fm && n < doc.lines && isGapLine(state, n))
    n += forward ? 1 : -1;
  return n;
}

/** The block widgets drawn over [lo, hi], by the atomic ranges the blocks
 *  field (blocks/live.ts) publishes for them — the only block-replacing
 *  atomic ranges besides the frontmatter's, which is left to CM's own atomic
 *  skip (a caret at its edge would type onto the closing `---`). */
function drawnBlocks(
  view: EditorView,
  lo: number,
  hi: number,
): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  const fm = fmEnd(view.state);
  for (const ranges of view.state.facet(EditorView.atomicRanges))
    ranges(view).between(lo, hi, (from, to, value: Decoration) => {
      if (value.spec.block === true && from >= fm) out.push({ from, to });
    });
  return out.sort((a, b) => a.from - b.from);
}

/** ArrowUp / ArrowDown (Live): CM's vertical move; landed on a gap line
 *  that is not the note's first or last, the caret goes on past the gap
 *  run (verticalStop) at CM's goal column — it passes over paragraph
 *  spacing as in Notion. A drawn block on the way stops it at the block's
 *  near edge, which selects the block (blocks/live's stepInto). From a
 *  block selected whole, blocks/live's own keys move on. Shift-selection
 *  is untouched. */
function skipGaps(forward: boolean) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const { main } = state.selection;
    if (view.composing || state.selection.ranges.length > 1 || !main.empty)
      return false;
    const { doc } = state;
    let range = view.moveVertically(main, forward);
    if (range.head === main.head) return false; // the default's line-boundary move
    const edge = stepInto(
      drawnBlocks(
        view,
        Math.min(main.head, range.head),
        Math.max(main.head, range.head),
      ),
      main.head,
      range.head,
      forward,
    );
    const stop = verticalStop(state, range.head, forward);
    if (edge !== null) range = EditorSelection.cursor(edge);
    // Held off the hidden frontmatter.
    else if (stop === null) return true;
    else if (stop !== doc.lineAt(range.head).number) {
      // 1px past the gap run's far edge: whatever is drawn there takes the
      // caret — a wrapped paragraph's near row, a folded toggle's title, a
      // widget's near edge. (CM's half-line step from a short gap line
      // overshoots a short line beside it.)
      const gap = view.lineBlockAt(doc.line(stop + (forward ? -1 : 1)).from);
      const goal = range.goalColumn ?? 0;
      const at = view.posAndSideAtCoords(
        {
          x: view.contentDOM.getBoundingClientRect().left + goal,
          y: view.documentTop + (forward ? gap.bottom + 1 : gap.top - 1),
        },
        false,
      );
      range = EditorSelection.cursor(at.pos, at.assoc, undefined, goal);
    }
    view.dispatch({
      selection: EditorSelection.create([range]),
      scrollIntoView: true,
      userEvent: "select",
    });
    return true;
  };
}

/** Live-only editing: Backspace/Delete at a block edge, input rules, caret snap. */
export function liveEditing(): Extension {
  return [
    Prec.high(
      keymap.of([
        { key: "Backspace", run: run(backspaceTr) },
        { key: "Delete", run: run(deleteTr) },
        { key: "ArrowLeft", run: stepLeft(false) },
        { key: "Shift-ArrowLeft", run: stepLeft(true) },
        { key: "ArrowUp", run: skipGaps(false) },
        { key: "ArrowDown", run: skipGaps(true) },
      ]),
    ),
    EditorView.inputHandler.of((view, from, to, text) => {
      if (view.composing) return false;
      const t = inputRuleTr(view.state, from, to, text);
      if (!t) return false;
      view.dispatch(t);
      return true;
    }),
    caretSnap,
  ];
}
