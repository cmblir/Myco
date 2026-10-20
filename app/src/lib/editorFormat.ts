// Notion's formatting keys over the markdown source: ⌘B **bold**, ⌘I
// *italic*, ⌘⇧H ==highlight==, ⌘E `code`, ⌘K [[link]]. A key wraps the
// selection (each line's text past its block marks), or takes the mark off
// where the selection is already that mark — a part of a span splits it.
// At the caret, bold/italic/highlight open an empty pair to type into
// (pressed again, the pair goes) or step out of the span the caret ends;
// code and link need a selection, so ⌘K keeps its app meaning (the command
// palette) at the caret, and ⌘E does nothing there. One transaction, one undo step.
// Fenced code, raw HTML and frontmatter are never touched. Pure over
// EditorState (vitest, node); formatKeymap binds the keys.

import {
  EditorSelection,
  StateEffect,
  StateField,
  type ChangeSet,
  type ChangeSpec,
  type EditorState,
  type Extension,
  type SelectionRange,
  type Transaction,
} from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common";
import {
  insertCompletionText,
  pickedCompletion,
  startCompletion,
  type Completion,
} from "@codemirror/autocomplete";
import {
  APART,
  FOOTNOTE_RE,
  hasText,
  inCode,
  isBlank,
  lineMarks,
  prefixEnd,
  PROSE,
} from "./editorMarks";
import { PUNCT } from "./editorBlocks";
import { parseCalloutHead } from "./blocks/callout";
import { paragraphBlock } from "./blocks/live";
import { matchWikilinkAt } from "./wikilinks";

export interface Format {
  open: string;
  close: string;
  /** The Lezer node a span of it parses as; none for a wikilink. */
  node?: string;
  /** The key means only this mark in the editor: it opens a pair at the
   *  caret, and is held where no mark can go. */
  own: boolean;
}

export const BOLD: Format = {
  open: "**",
  close: "**",
  node: "StrongEmphasis",
  own: true,
};
export const ITALIC: Format = {
  open: "*",
  close: "*",
  node: "Emphasis",
  own: true,
};
export const HIGHLIGHT: Format = {
  open: "==",
  close: "==",
  node: "Highlight",
  own: true,
};
export const CODE: Format = {
  open: "`",
  close: "`",
  node: "InlineCode",
  own: false,
};
export const LINK: Format = { open: "[[", close: "]]", own: false };

/** A marked span: [from, open) its opening mark, [close, to) its closing one. */
interface Span {
  from: number;
  open: number;
  close: number;
  to: number;
  /** A wikilink's shown text (alias or target). */
  text?: string;
  /** `![[…]]`: `from` is at its `!`. */
  embed?: true;
}

function spanOf(n: SyntaxNodeRef): Span | null {
  const o = n.node.firstChild;
  const c = n.node.lastChild;
  if (!o || !c || o === c) return null;
  return { from: n.from, open: o.to, close: c.from, to: n.to };
}

/** The `f` spans that overlap [a, b] (touching counts). */
function spansAround(
  state: EditorState,
  f: Format,
  a: number,
  b: number,
): Span[] {
  const out: Span[] = [];
  if (!f.node) {
    const line = state.doc.lineAt(a);
    for (
      let i = line.text.indexOf("[[");
      i >= 0;
      i = line.text.indexOf("[[", i + 1)
    ) {
      const m = matchWikilinkAt(line.text, i);
      const embed = line.text[i - 1] === "!";
      const from = line.from + i - (embed ? 1 : 0);
      const to = line.from + (m?.end ?? 0);
      if (m && from <= b && to >= a)
        out.push({
          from,
          open: line.from + i + 2,
          close: to - 2,
          to,
          text: m.display,
          ...(embed && { embed }),
        });
    }
    return out;
  }
  syntaxTree(state).iterate({
    from: a,
    to: b,
    enter: (n) => {
      if (n.name !== f.node) return;
      const s = spanOf(n);
      if (s && s.from <= b && s.to >= a) out.push(s);
    },
  });
  return out;
}

/** Where a selection's edge `p` may take `f`'s mark: `p` itself, the edge
 *  of the code span or link it is inside (`side` -1: its start, 1: its
 *  end) — bold, italic and highlight take them whole, as Notion marks a
 *  whole link — or null where no mark can go: a URL, and code text or a
 *  link target for a key that would change what they say. */
function edgeOut(
  state: EditorState,
  f: Format,
  p: number,
  side: -1 | 1,
): number | null {
  for (
    let x: SyntaxNode | null = syntaxTree(state).resolveInner(p, 1);
    x;
    x = x.parent
  ) {
    if (x.from >= p || x.to <= p) continue;
    if (x.name === "URL" || x.name === "Autolink") return null;
    // `[text](url)`: past the text's `]` is the destination.
    if (x.name === "Link" || x.name === "Image") {
      const close = x
        .getChildren("LinkMark")
        .find((m) => state.doc.sliceString(m.from, m.to) === "]");
      if (close && p > close.from && x.getChild("URL")) return null;
    }
    if (x.name === "InlineCode" && f !== CODE)
      return f.own ? (side < 0 ? x.from : x.to) : null;
  }
  const link = spansAround(state, LINK, p, p).find(
    (s) => s.from < p && p < s.to,
  );
  if (link && f !== LINK)
    return f.own ? (side < 0 ? link.from : link.to) : null;
  return p;
}

/** Nodes whose own characters are a line's text, no mark's, code's or
 *  link's. */
const TEXT_NODES = new Set([...PROSE, "Task", "TableCell"]);

/** Where `f`'s marks around [lo, hi] render, by CommonMark's flanking rule
 *  (Lezer's and markdown-it's): a mark between punctuation and a letter,
 *  as before a Korean particle (`)는`, `는"`), is no mark. The text's own
 *  punctuation stays outside the marks; null when that leaves no text, or
 *  the punctuation is a link's or code's (`[[note]]는`). */
function flanked(
  state: EditorState,
  f: Format,
  lo: number,
  hi: number,
): { lo: number; hi: number } | null {
  const { doc } = state;
  const ch = (p: number) => (p < 0 ? "" : doc.sliceString(p, p + 1));
  const loose = (c: string) => !c || /\s/.test(c) || PUNCT.test(c);
  const text = (p: number) =>
    TEXT_NODES.has(syntaxTree(state).resolveInner(p, 1).name) &&
    !spansAround(state, LINK, p, p).some((s) => s.from <= p && p < s.to);
  const stuck = (punct: string, other: string) =>
    PUNCT.test(punct) && !loose(other);
  while (hi > lo && stuck(ch(hi - 1), ch(hi)) && text(hi - 1)) hi--;
  while (lo < hi && stuck(ch(lo), ch(lo - 1)) && text(lo)) lo++;
  // A run of the same mark char next to ours is one run with it (`***a***`).
  let q = hi;
  while (q > lo && ch(q - 1) === f.close[0]) q--;
  let r = lo;
  while (r < hi && ch(r) === f.open[0]) r++;
  if (lo >= hi || stuck(ch(q - 1), ch(hi)) || stuck(ch(r), ch(lo - 1)))
    return null;
  return { lo, hi };
}

/** Each line's prose in [from, to], blanks trimmed: past its block marks,
 *  a footnote's `[^id]:` and a callout's `[!type]`; a table's cells, never
 *  its pipes. A rule, a link reference and a line drawn as a block (an
 *  image, an embed) give none — a mark there would unmake them. */
function segments(
  state: EditorState,
  from: number,
  to: number,
): { a: number; b: number }[] {
  const { doc } = state;
  const tree = syntaxTree(state);
  const out: { a: number; b: number }[] = [];
  const push = (a: number, b: number): void => {
    while (a < b && isBlank(doc.sliceString(a, a + 1))) a++;
    while (b > a && isBlank(doc.sliceString(b - 1, b))) b--;
    if (a < b) out.push({ a, b });
  };
  for (let n = doc.lineAt(from).number; n <= doc.lineAt(to).number; n++) {
    const line = doc.line(n);
    const marks = lineMarks(state, line);
    let start = marks.length ? marks[marks.length - 1].to : line.from;
    const note = FOOTNOTE_RE.exec(line.text);
    const head =
      marks[marks.length - 1]?.name === "QuoteMark" &&
      parseCalloutHead(doc.sliceString(start, line.to));
    if (note) start = line.from + note[0].length;
    else if (head) start += head.tagLen;
    const a = Math.max(from, start);
    const b = Math.min(to, line.to);
    if (!hasText(doc.sliceString(a, b))) continue;
    const at = a + doc.sliceString(a, b).search(/\S/);
    let table = false;
    let skip = false;
    for (let x: SyntaxNode | null = tree.resolveInner(at, 1); x; x = x.parent)
      if (x.name === "Table") table = true;
      else if (APART.has(x.name)) skip = !note;
      else if (x.name === "Paragraph")
        skip ||= paragraphBlock(x, doc)?.from === line.from;
    if (table)
      tree.iterate({
        from: a,
        to: b,
        enter: (c) => {
          if (c.name === "TableCell")
            push(Math.max(a, c.from), Math.min(b, c.to));
        },
      });
    else if (!skip) push(a, b);
  }
  return out;
}

const done = (
  state: EditorState,
  changes: ChangeSpec[],
  select: (set: ChangeSet) => SelectionRange,
  effect?: (set: ChangeSet) => StateEffect<unknown>,
): Transaction => {
  const set = state.changes(changes);
  return state.update({
    changes: set,
    selection: EditorSelection.create([select(set)]),
    effects: effect?.(set),
    scrollIntoView: true,
    userEvent: "input.format",
  });
};

/** Only blanks and inline marks: a nested span's `**` is no text of its own. */
const bare = (s: string): boolean => !/[^\s*_=~`]/.test(s);

/** Take [a, b] (inside span `s`'s text) out of the span: a mark goes where
 *  the text reaches the span's edge, else the span closes before `a` and
 *  reopens after `b` — past the blanks and a soft line's break and block
 *  marks, which a mark may not touch. */
function unwrapChanges(
  state: EditorState,
  s: Span,
  a: number,
  b: number,
): ChangeSpec[] {
  const { doc } = state;
  if (s.text !== undefined) return [{ from: s.from, to: s.to, insert: s.text }];
  // Out of a mark the text sits in (`**a *b* c**`): ours go around it, or
  // the word would stay marked between them.
  const tree = syntaxTree(state);
  for (let x: SyntaxNode | null = tree.resolveInner(a, 1); x; x = x.parent)
    if (x.from >= s.open && x.from < a && x.to <= s.close) a = x.from;
  for (let x: SyntaxNode | null = tree.resolveInner(b, -1); x; x = x.parent)
    if (x.from >= s.open && x.to > b && x.to <= s.close) b = x.to;
  const blank = (p: number) => isBlank(doc.sliceString(p, p + 1));
  const out: ChangeSpec[] = [];
  if (bare(doc.sliceString(s.open, a))) out.push({ from: s.from, to: s.open });
  else {
    let p = a;
    for (;;) {
      const line = doc.lineAt(p);
      const start = Math.max(s.open, prefixEnd(state, line));
      while (p > start && blank(p - 1)) p--;
      if (p > start || line.from <= s.open) break;
      p = line.from - 1; // the line above's end
    }
    out.push({ from: p, insert: doc.sliceString(s.close, s.to) });
  }
  if (bare(doc.sliceString(b, s.close))) out.push({ from: s.close, to: s.to });
  else {
    let p = b;
    for (;;) {
      const line = doc.lineAt(p);
      while (p < Math.min(s.close, line.to) && blank(p)) p++;
      if (p < line.to || line.to >= s.close) break;
      p = prefixEnd(state, doc.line(line.number + 1));
    }
    out.push({ from: p, insert: doc.sliceString(s.from, s.open) });
  }
  return out;
}

/** The text part of [a, b] a covering span holds, or the span's whole text
 *  when only its marks were selected. */
function clamp(s: Span, a: number, b: number): { a: number; b: number } {
  const lo = Math.max(a, s.open);
  const hi = Math.min(b, s.close);
  return lo < hi ? { a: lo, b: hi } : { a: s.open, b: s.close };
}

function caretTr(
  state: EditorState,
  f: Format,
  pos: number,
): Transaction | null {
  if (!f.own) return null;
  const { doc } = state;
  const at = (p: number) => (p < 0 ? "" : doc.sliceString(p, p + 1));
  const cursor = (p: number) => () => EditorSelection.cursor(p);
  // An empty pair (the last press's) goes — not one mark of a longer run.
  if (
    doc.sliceString(pos - f.open.length, pos) === f.open &&
    doc.sliceString(pos, pos + f.close.length) === f.close &&
    at(pos - f.open.length - 1) !== f.open[0] &&
    at(pos + f.close.length) !== f.close[0]
  )
    return done(
      state,
      [{ from: pos - f.open.length, to: pos + f.close.length }],
      cursor(pos - f.open.length),
    );
  const s = spansAround(state, f, pos, pos).find(
    (x) => x.open <= pos && pos <= x.close,
  );
  if (s && pos === s.close)
    return state.update({ selection: { anchor: s.to }, userEvent: "select" });
  if (s && pos === s.open)
    return state.update({ selection: { anchor: s.from }, userEvent: "select" });
  // Mid-span: typing goes on unmarked between a closed and a reopened span.
  const insert = s
    ? doc.sliceString(s.close, s.to) + doc.sliceString(s.from, s.open)
    : f.open + f.close;
  const mid = s ? s.to - s.close : f.open.length;
  return done(state, [{ from: pos, insert }], cursor(pos + mid));
}

/** The key's edit for the main selection, or null where it does nothing:
 *  several selections, code or frontmatter, ⌘E/⌘K at a bare caret, a link
 *  across lines or around another link. */
export function formatTr(state: EditorState, f: Format): Transaction | null {
  const { main } = state.selection;
  if (state.selection.ranges.length > 1) return null;
  const { doc } = state;
  for (
    let n = doc.lineAt(main.from).number;
    n <= doc.lineAt(main.to).number;
    n++
  ) {
    const l = doc.line(n);
    if (
      inCode(state, Math.max(main.from, l.from)) ||
      inCode(state, Math.min(main.to, l.to))
    )
      return null;
  }
  if (main.empty)
    return edgeOut(state, f, main.head, -1) === main.head
      ? caretTr(state, f, main.head)
      : null;
  const segs = segments(state, main.from, main.to);
  if (!segs.length || (!f.node && segs.length > 1)) return null;
  // Where the marks go: out of a code span or link an edge is inside.
  const wide: { a: number; b: number }[] = [];
  for (const seg of segs) {
    const a = edgeOut(state, f, seg.a, -1);
    const b = edgeOut(state, f, seg.b, 1);
    if (a === null || b === null) return null;
    // ⌘K never unmakes an embed, nor wraps one into a link.
    if (f === LINK && spansAround(state, f, a, b).some((s) => s.embed))
      return null;
    wide.push({ a, b });
  }
  const covered = wide.map(({ a, b }) =>
    spansAround(state, f, a, b).find((s) => s.from <= a && b <= s.to),
  );
  // The selected text stays selected, its marks outside the selection.
  const edges = segs.map((seg, i) => {
    const s = covered[i];
    return s ? clamp(s, seg.a, seg.b) : seg;
  });
  const select = (set: ChangeSet) => {
    const from = set.mapPos(edges[0].a, 1);
    const to = set.mapPos(edges[edges.length - 1].b, -1);
    return main.head < main.anchor
      ? EditorSelection.range(to, from)
      : EditorSelection.range(from, to);
  };
  if (covered.every(Boolean)) {
    // A link goes whole: its shown text stays, selected.
    const { from, to, text } = covered[0] as Span;
    if (text !== undefined)
      return done(state, [{ from, to, insert: text }], () =>
        EditorSelection.range(from, from + text.length),
      );
    // One take-off per span: a span across soft lines covers several.
    const bySpan = new Map<number, { s: Span; a: number; b: number }>();
    wide.forEach((w, i) => {
      const s = covered[i] as Span;
      const { a, b } = clamp(s, w.a, w.b);
      const g = bySpan.get(s.from);
      if (g) g.b = b;
      else bySpan.set(s.from, { s, a, b });
    });
    return done(
      state,
      [...bySpan.values()].flatMap(({ s, a, b }) =>
        unwrapChanges(state, s, a, b),
      ),
      select,
    );
  }
  const changes: ChangeSpec[] = [];
  for (const [i, { a, b }] of wide.entries()) {
    if (covered[i]) continue;
    // Spans it overlaps join the new one: their marks go, the wrap takes
    // in their text.
    const inside = spansAround(state, f, a, b).filter(
      (s) => s.to > a && s.from < b,
    );
    if (!f.node && inside.length) return null;
    let lo = a;
    let hi = b;
    for (const s of inside) {
      lo = Math.min(lo, s.from);
      hi = Math.max(hi, s.to);
      changes.push({ from: s.from, to: s.open }, { from: s.close, to: s.to });
    }
    const edge = f.own ? flanked(state, f, lo, hi) : { lo, hi };
    if (!edge) return null;
    changes.push(
      { from: edge.lo, insert: f.open },
      { from: edge.hi, insert: f.close },
    );
  }
  // ⌘K: the caret before `]]`, where the `[[` note list picks the target;
  // the words stay the link's text (linkWrap).
  if (!f.node) {
    const { a, b } = wide[0];
    return done(
      state,
      changes,
      (set) => EditorSelection.cursor(set.mapPos(b, -1)),
      (set) =>
        setLinkWrap.of({ from: set.mapPos(a, 1), text: doc.sliceString(a, b) }),
    );
  }
  return done(state, changes, select);
}

interface LinkWrap {
  /** Just past the link's `[[`. */
  from: number;
  /** The words ⌘K wrapped. */
  text: string;
}

const setLinkWrap = StateEffect.define<LinkWrap>();

/** The words ⌘K just made a link of, while the caret stays in it (typing
 *  the query too): a note picked for it keeps them as its shown text, as
 *  Notion's ⌘K does. Gone once the caret leaves or an edit lands outside. */
const linkWrap = StateField.define<LinkWrap | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setLinkWrap)) return e.value;
    if (!v) return null;
    const old = tr.startState.doc;
    const close = old.sliceString(v.from, old.lineAt(v.from).to).indexOf("]]");
    const end = close < 0 ? old.lineAt(v.from).to : v.from + close;
    let outside = false;
    tr.changes.iterChangedRanges((a, b) => {
      outside ||= a < v.from || b > end;
    });
    const from = tr.changes.mapPos(v.from, -1);
    const { doc, selection } = tr.state;
    const head = selection.main.head;
    const typed = doc.sliceString(from, Math.max(from, head));
    const inLink =
      !outside &&
      selection.ranges.length === 1 &&
      head >= from &&
      doc.sliceString(from - 2, from) === "[[" &&
      !/\]\]|\n/.test(typed);
    return inLink ? { ...v, from } : null;
  },
});

/** A `[[` completion's apply: `text` (its `…]]`) goes over the query and a
 *  `]]` right after it — the one ⌘K wrote, or an edited link's own — so a
 *  picked note never leaves `]]]]`. Over the words ⌘K wrapped, the target
 *  goes in front of them: `[[target|words]]`, or `[[words]]` for a note of
 *  that name. */
export function linkApply(text: string) {
  return (
    view: EditorView,
    completion: Completion,
    from: number,
    to: number,
  ): void => {
    const end = view.state.sliceDoc(to, to + 2) === "]]" ? to + 2 : to;
    const words = view.state.field(linkWrap, false);
    const target = text.replace(/\]\]$/, "");
    const insert =
      words?.from !== from || !/^[^[\]|\n]+$/.test(words.text)
        ? text
        : words.text.toLowerCase() === target.toLowerCase()
          ? `${words.text}]]`
          : `${target}|${words.text}]]`;
    view.dispatch({
      ...insertCompletionText(view.state, insert, from, end),
      annotations: pickedCompletion.of(completion),
    });
  };
}

function formatKey(f: Format) {
  return (view: EditorView): boolean => {
    // Mid-composition (Korean IME) the key belongs to the IME.
    if (view.composing) return false;
    const t = formatTr(view.state, f);
    if (!t) return f.own;
    view.dispatch(t);
    if (f === LINK && t.state.selection.main.empty) startCompletion(view);
    return true;
  };
}

/** The format keys, for the editor's keymap ahead of defaultKeymap (which
 *  owns Mod-i otherwise). A key that returns false (⌘E/⌘K with no
 *  selection) is left to the page: ⌘K opens the command palette. */
export function formatKeymap(): Extension {
  return [
    linkWrap,
    keymap.of([
      { key: "Mod-b", run: formatKey(BOLD) },
      { key: "Mod-i", run: formatKey(ITALIC) },
      { key: "Mod-Shift-h", run: formatKey(HIGHLIGHT) },
      { key: "Mod-e", run: formatKey(CODE) },
      { key: "Mod-k", run: formatKey(LINK) },
    ]),
  ];
}
