// Live preview for the CodeMirror editor, Notion-style: block marks (`## `,
// `- `, `> `, `- [ ] `) are hidden the moment their trigger space is typed and
// stay hidden on the caret's line too; inline marks (`**`, `[..](..)`) show
// only while the caret is inside that span. Bullets, task checkboxes, rules
// and heading sizes render in place and frontmatter becomes a one-line block
// widget. `liveSpecs` is the pure walker over the Lezer tree (vitest, node);
// `liveExtension` wires it to the view.

import type { SyntaxNode, SyntaxNodeRef, Tree } from "@lezer/common";
import {
  type EditorSelection,
  Prec,
  StateField,
  type Extension,
  type Range,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { matchWikilinkAt } from "./wikilinks";
import { EXTERNAL_RE, frontmatterLength } from "./markdown";
import { FOOTNOTE_RE, bodyText, hasText } from "./editorMarks";
import { drawMath, mathHtml } from "./blocks/math";
import { composeEndRefresh } from "./blocks/calloutLive";

export type LiveSpec =
  /** `block`: a line's own block mark — atomic, so the caret never enters it. */
  | { kind: "hide"; from: number; to: number; block?: true }
  | { kind: "line"; from: number; cls: string }
  | { kind: "mark"; from: number; to: number; cls: string }
  | { kind: "bullet"; from: number; to: number }
  | { kind: "task"; from: number; to: number; checked: boolean }
  | { kind: "hr"; from: number; to: number }
  /** A nested item's indent (the blanks before its marker), drawn 1.5em per
   *  `level` — Notion's nesting — whatever the file's spaces measure. */
  | { kind: "indent"; from: number; to: number; level: number }
  /** An empty heading's line: shows its placeholder (`Heading 2`); `level`
   *  0 is the caret's empty line, whose placeholder offers `/`. */
  | { kind: "empty"; from: number; level: number }
  /** `$…$` with no caret on it, typeset (lib/blocks/math). */
  | { kind: "math"; from: number; to: number; tex: string }
  /** A footnote reference with no caret on it, as its number; `title` is
   *  its source's name (UX S31). */
  | { kind: "fnref"; from: number; to: number; n: number; title: string }
  /** A definition's `[^label]: ` off the caret's line, as `n.`. */
  | { kind: "fndef"; from: number; to: number; n: number }
  /** The first definition's line, under a "Sources" heading. */
  | { kind: "sources"; from: number };

const HEADING_RE = /^ATXHeading([1-6])$/;
/** A footnote reference, as markdown-it-footnote reads its label. */
const FNREF_RE = /\[\^[^\]\s]+\]/g;
/** A footnote definition's `[^label]: `, the label and its text captured. */
const FNDEF_RE = /^\s*\[\^([^\]\s]+)\]:[ \t]*(.*)/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
/** A line that opens a block of its own, so it is no lazy line of the
 *  definition above it (a heading, list item, quote, fence or rule). */
const BLOCK_START_RE =
  /^ {0,3}(?:#{1,6}(?:[ \t]|$)|[-*+][ \t]|\d{1,9}[.)][ \t]|>|`{3,}|~{3,}|(?:[-*_][ \t]*){3,}$)/;

export interface FootnoteDefs {
  /** Labels a `[^label]:` defines outside code, each to its first
   *  definition's line start: only these are references (Preview leaves an
   *  undefined `[^x]` as text). */
  labels: ReadonlyMap<string, number>;
  /** Line numbers inside a definition, as markdown-it-footnote reads its
   *  extent: the `[^id]:` line, the lines directly under it (lazy ones too)
   *  and, past a blank line, lines indented 4 columns or more. */
  lines: ReadonlySet<number>;
  /** Each label's number: references in first-appearance order, then
   *  definitions nothing cites, in their order (UX S31). */
  order: ReadonlyMap<string, number>;
  /** Each label's first definition line, past `[^label]: `. */
  text: ReadonlyMap<string, string>;
}

/** Pure: what a definition's text cites — the note its first wikilink
 *  names, if any — and the source's name as read (`[[a|b]]` reads b). */
export function footnoteSource(text: string): {
  target: string | null;
  title: string;
} {
  const i = text.indexOf("[[");
  const m = i >= 0 ? matchWikilinkAt(text, i) : null;
  const title = text
    .replace(/\[\[([^\]|]*)\|?([^\]]*)\]\]/g, (_, a: string, b: string) => b || a)
    .trim();
  return { target: m?.target ?? null, title };
}

/** Pure: one line-based pass over the whole doc — definitions usually sit
 *  at the end of a note, outside the drawn window, and the syntax tree may
 *  not reach them yet. Lezer parses a definition as a paragraph or a link
 *  reference, and its indented continuation as code: lines, not nodes. */
export function footnoteDefs(doc: Text): FootnoteDefs {
  const labels = new Map<string, number>();
  const lines = new Set<number>();
  const text = new Map<string, string>();
  // ponytail: a `[^x]` inside inline code counts too; skip code spans if a
  // note ever numbers wrong.
  const cited: string[] = [];
  const fmEnd = fmEndOf(doc);
  let fence = "";
  let inDef = false;
  let blank = false;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (line.from < fmEnd) continue;
    const src = line.text;
    const f = FENCE_RE.exec(src);
    if (fence) {
      const close = f && f[1][0] === fence[0] && f[1].length >= fence.length;
      if (close && !src.slice(f[0].length).trim()) fence = "";
      continue;
    }
    const def = FNDEF_RE.exec(src);
    if (!f)
      for (const m of src.matchAll(FNREF_RE))
        if (!def || m.index !== src.indexOf("[^")) cited.push(m[0].slice(2, -1));
    if (def) {
      if (!labels.has(def[1])) {
        labels.set(def[1], line.from);
        text.set(def[1], def[2]);
      }
      lines.add(n);
      inDef = true;
      blank = false;
    } else if (!/\S/.test(src)) {
      blank = inDef;
    } else if (
      inDef &&
      (blank ? /^(?: {4}|\t)/.test(src) : !BLOCK_START_RE.test(src))
    ) {
      lines.add(n);
      blank = false;
    } else {
      inDef = blank = false;
      if (f) fence = f[1];
    }
  }
  const order = new Map<string, number>();
  for (const label of [...cited, ...labels.keys()])
    if (labels.has(label) && !order.has(label)) order.set(label, order.size + 1);
  return { labels, lines, order, text };
}

const defsCache = new WeakMap<Text, FootnoteDefs>();
/** footnoteDefs, once per doc version (selection-only updates reuse it).
 *  ponytail: a whole-doc scan per edit, ~3 ms at 10k lines; rescan from the
 *  changed line if long notes lag. */
function defsOf(doc: Text): FootnoteDefs {
  let d = defsCache.get(doc);
  if (!d) defsCache.set(doc, (d = footnoteDefs(doc)));
  return d;
}
const MARK_CLASS: Record<string, string> = {
  StrongEmphasis: "live-strong",
  Emphasis: "live-em",
  InlineCode: "live-code-inline",
  Strikethrough: "live-strike",
  Highlight: "live-highlight",
};

function fmEndOf(doc: Text): number {
  // ponytail: 32 KB frontmatter cap
  return frontmatterLength(doc.sliceString(0, Math.min(doc.length, 32768)));
}

const spaceAt = (doc: Text, pos: number): boolean => {
  const c = doc.sliceString(pos, pos + 1);
  return c === " " || c === "\t";
};

/** Pure: decoration specs for [from,to) given the tree, doc and the selection heads. */
export function liveSpecs(
  tree: Tree,
  doc: Text,
  carets: readonly number[],
  from = 0,
  to = doc.length,
  defs: FootnoteDefs = defsOf(doc),
): LiveSpec[] {
  const out: LiveSpec[] = [];
  const fmEnd = fmEndOf(doc);
  // Lines of code and raw blocks: a blank one there is no paragraph gap.
  const codeLines = new Set<number>();
  // A quote's lines of bare marks between two passages: a gap in its box.
  const quoteGaps = new Set<number>();
  // An inline span shows its raw marks while a caret touches it.
  const drawn = (a: number, b: number): boolean =>
    !carets.some((c) => c >= a && c <= b);
  // A plugin may not replace a line break (CM throws and stops drawing), and
  // a link or emphasis can span a soft break: such a range stays raw.
  const oneLine = (a: number, b: number): boolean =>
    !doc.sliceString(a, b).includes("\n");
  const hide = (a: number, b: number): void => {
    if (oneLine(a, b)) out.push({ kind: "hide", from: a, to: b });
  };
  // A block mark plus its trigger space.
  const hideMark = (a: number, b: number): void => {
    out.push({
      kind: "hide",
      from: a,
      to: b + (spaceAt(doc, b) ? 1 : 0),
      block: true,
    });
  };
  // One `line` spec per line the node covers, clamped to the window; a
  // footnote definition's lines are muted text instead (below).
  const lines = (n: SyntaxNodeRef, cls: string, notDefs = false): void => {
    const end = Math.min(n.to, to);
    let l = doc.lineAt(Math.max(n.from, from));
    for (;;) {
      if (!notDefs || !defs.lines.has(l.number))
        out.push({ kind: "line", from: l.from, cls });
      if (l.to >= end || l.number === doc.lines) break;
      l = doc.line(l.number + 1);
    }
  };
  // Drawn as a gap only with no caret on it: a caret shows the marks.
  const quoteGap = (n: number, a: number, b: number): boolean =>
    quoteGaps.has(n) && drawn(a, b);
  const raw = (n: SyntaxNodeRef): void => {
    const last = doc.lineAt(Math.min(n.to, to)).number;
    for (let k = doc.lineAt(Math.max(n.from, from)).number; k <= last; k++)
      codeLines.add(k);
  };
  // A closed fence drawn as a card: the backticks hide unless a caret is on
  // their line, the info word is a chip and the closing line shrinks to the
  // card's bottom padding. Unclosed, it stays source, so the gap is seen.
  const fence = (n: SyntaxNodeRef): void => {
    lines(n, "live-code");
    raw(n);
    const first = doc.lineAt(n.from);
    const last = doc.lineAt(n.to);
    if (first.from >= from)
      out.push({ kind: "line", from: first.from, cls: "live-code-first" });
    if (last.from <= to)
      out.push({ kind: "line", from: last.from, cls: "live-code-last" });
    const [open, close] = n.node.getChildren("CodeMark");
    const info = n.node.getChild("CodeInfo");
    if (!close) return;
    if (drawn(first.from, first.to)) {
      hide(open.from, info ? info.from : open.to);
      if (info)
        out.push({
          kind: "mark",
          from: info.from,
          to: info.to,
          cls: "live-lang",
        });
    }
    if (drawn(last.from, last.to)) {
      // From the line's start: a quote's `> ` there (never visited, the
      // walk skips the fence's children) would hang below the card.
      hide(last.from, close.to);
      out.push({ kind: "line", from: last.from, cls: "live-fence-end" });
    }
  };
  // `[[…]]` over [a,b): its brackets and alias target hide off the caret.
  const wikilink = (a: number, b: number): void => {
    out.push({ kind: "mark", from: a, to: b, cls: "live-wikilink" });
    if (!drawn(a, b)) return;
    hide(a, a + 2);
    const pipe = doc.sliceString(a + 2, b - 2).indexOf("|");
    if (pipe >= 0) hide(a + 2, a + 3 + pipe);
    hide(b - 2, b);
  };
  const link = (n: SyntaxNodeRef): false | undefined => {
    const line = doc.lineAt(n.from);
    const col = n.from - line.from;
    // `[[…]]`: Lezer sees the inner `[…]` as a bare Link between two brackets.
    const wl =
      line.text[col - 1] === "[" && line.text[n.to - line.from] === "]"
        ? matchWikilinkAt(line.text, col - 1)
        : null;
    if (wl && wl.end === n.to + 1 - line.from) {
      wikilink(n.from - 1, n.to + 1);
      return false;
    }
    const node = n.node;
    if (!node.getChild("URL")) {
      // Bare `[text]` stays raw; `[^id]` (Lezer: a Link, `[^a][^b]` one Link
      // with a label) gets a chip per reference.
      for (const m of doc.sliceString(n.from, n.to).matchAll(FNREF_RE)) {
        const a = n.from + m.index;
        const b = a + m[0].length;
        const line = doc.lineAt(a);
        // A definition's own `[^id]:` label is not a reference to it, and
        // a label nothing defines is plain text in Preview.
        if (FOOTNOTE_RE.exec(line.text)?.[0].length === b + 1 - line.from)
          continue;
        const label = m[0].slice(2, -1);
        if (!defs.labels.has(label)) continue;
        out.push({ kind: "mark", from: a, to: b, cls: "live-fnref" });
        if (drawn(a, b))
          out.push({
            kind: "fnref",
            from: a,
            to: b,
            n: defs.order.get(label) ?? 0,
            title: footnoteSource(defs.text.get(label) ?? "").title,
          });
      }
      return false;
    }
    out.push({ kind: "mark", from: n.from, to: n.to, cls: "live-link" });
    if (drawn(n.from, n.to)) {
      hide(n.from, n.from + 1);
      const close = node
        .getChildren("LinkMark")
        .find((m) => doc.sliceString(m.from, m.to) === "]");
      if (close) hide(close.from, n.to);
    }
    // Into the text: its math, emphasis and code draw as Preview's do.
    return undefined;
  };

  tree.iterate({
    from,
    to,
    enter(n) {
      if (n.from < fmEnd) return n.name === "Document";
      const h = HEADING_RE.exec(n.name);
      if (h) {
        const mark = n.node.firstChild;
        // `#` / `##` without the space are not a heading yet (nor `#tag`).
        if (!mark || mark.name !== "HeaderMark" || !spaceAt(doc, mark.to))
          return false;
        lines(n, `live-h${h[1]}`);
        if (!doc.sliceString(mark.to, n.to).trim())
          out.push({
            kind: "empty",
            from: doc.lineAt(n.from).from,
            level: +h[1],
          });
        return;
      }
      const cls = MARK_CLASS[n.name];
      if (cls) {
        out.push({ kind: "mark", from: n.from, to: n.to, cls });
        return;
      }
      switch (n.name) {
        // `$$…$$` (lib/blocks/math) with a caret in it: its source as a
        // code card, as a fence's.
        case "FencedCode":
        case "BlockMath":
          fence(n);
          return false;
        case "InlineMath":
          if (drawn(n.from, n.to) && oneLine(n.from, n.to))
            out.push({
              kind: "math",
              from: n.from,
              to: n.to,
              tex: doc.sliceString(n.from + 1, n.to - 1),
            });
          else
            out.push({
              kind: "mark",
              from: n.from,
              to: n.to,
              cls: "live-math-src",
            });
          return false;
        case "CodeBlock":
          // A definition's indented continuation parses as code.
          lines(n, "live-code", true);
          raw(n);
          return false;
        case "Image":
          return false;
        case "HTMLBlock":
          raw(n);
          return false;
        case "CommentBlock":
          lines(n, "live-comment");
          raw(n);
          return false;
        case "Comment":
          out.push({
            kind: "mark",
            from: n.from,
            to: n.to,
            cls: "live-comment",
          });
          return false;
        case "Blockquote": {
          lines(n, "live-quote");
          const last = doc.lineAt(n.to).number;
          const lo = doc.lineAt(Math.max(n.from, from)).number;
          const hi = Math.min(last - 1, doc.lineAt(Math.min(n.to, to)).number);
          for (
            let k = Math.max(lo, doc.lineAt(n.from).number + 1);
            k <= hi;
            k++
          )
            if (!hasText(bodyText(doc.line(k).text))) quoteGaps.add(k);
          return;
        }
        case "HorizontalRule":
          // A caret strictly inside is ⌘B's fresh `**│**` (arrows and clicks
          // stop at an atomic rule's edges): the pair stays text to type into.
          if (!carets.some((c) => c > n.from && c < n.to))
            out.push({ kind: "hr", from: n.from, to: n.to });
          return false;
        case "Link":
          return link(n);
        case "LinkReference": {
          // `[^src-a]: [[source-a]]` alone parses as a link reference whose
          // URL is the wikilink: drawn as one, as in a sentence (UX S31).
          const url = n.node.getChild("URL");
          const text = url ? doc.sliceString(url.from, url.to) : "";
          if (url && matchWikilinkAt(text, 0)?.end === text.length)
            wikilink(url.from, url.to);
          return false;
        }
        case "ListMark": {
          if (!spaceAt(doc, n.to)) return;
          let level = -1;
          for (let p = n.node.parent; p; p = p.parent)
            if (p.name === "ListItem") level++;
          let indent = n.from;
          const lineFrom = doc.lineAt(n.from).from;
          while (indent > lineFrom && spaceAt(doc, indent - 1)) indent--;
          if (level > 0 && indent < n.from)
            out.push({ kind: "indent", from: indent, to: n.from, level });
          if (!/^[-*+]$/.test(doc.sliceString(n.from, n.to))) {
            // An ordered number stays text, right-aligned in its box.
            out.push({ kind: "mark", from: n.from, to: n.to, cls: "live-num" });
            return;
          }
          // A to-do shows one checkbox, not a bullet and a checkbox.
          if (n.node.nextSibling?.name === "Task") hideMark(n.from, n.to);
          else out.push({ kind: "bullet", from: n.from, to: n.to + 1 });
          return;
        }
        case "TaskMarker":
          out.push({
            kind: "task",
            from: n.from,
            to: n.to + (spaceAt(doc, n.to) ? 1 : 0),
            checked: doc.sliceString(n.from, n.to) !== "[ ]",
          });
          return;
        case "HeaderMark":
          // The opening mark belongs to the block; a closing `##` is just hidden.
          // (and only while no caret touches it: `###` typed into an empty
          // `## ` parses as a closing mark and must not vanish as typed).
          if (!n.node.prevSibling) hideMark(n.from, n.to);
          else if (drawn(n.from, n.to)) hide(n.from, n.to);
          return;
        case "QuoteMark": {
          const line = doc.lineAt(n.from);
          if (spaceAt(doc, n.to) && !quoteGap(line.number, line.from, line.to))
            hideMark(n.from, n.to);
          return;
        }
        case "EmphasisMark":
        case "CodeMark":
        case "StrikethroughMark":
        case "HighlightMark": {
          const span = n.node.parent;
          if (span && drawn(span.from, span.to)) hide(n.from, n.to);
          return;
        }
      }
    },
  });
  // The note's first content line carries no heading padding.
  let first = doc.lineAt(fmEnd);
  while (!hasText(first.text) && first.number < doc.lines)
    first = doc.line(first.number + 1);
  if (hasText(first.text) && first.from >= from && first.from <= to)
    out.push({ kind: "line", from: first.from, cls: "live-first" });
  const firstDef = Math.min(...defs.labels.values());
  const last = doc.lineAt(to).number;
  for (let n = doc.lineAt(from).number; n <= last; n++) {
    const l = doc.line(n);
    if (defs.lines.has(n)) {
      out.push({ kind: "line", from: l.from, cls: "live-fndef" });
      if (l.from === firstDef) out.push({ kind: "sources", from: l.from });
      const def = FNDEF_RE.exec(l.text);
      if (def && drawn(l.from, l.to)) {
        const a = l.from + l.text.indexOf("[^");
        out.push({
          kind: "fndef",
          from: a,
          to: l.from + def[0].length - def[2].length,
          n: defs.order.get(def[1]) ?? 0,
        });
      }
    }
    if (l.from < fmEnd || codeLines.has(n)) continue;
    if (quoteGap(n, l.from, l.to)) {
      hide(l.from, l.to);
      out.push({ kind: "line", from: l.from, cls: "live-gap" });
      continue;
    }
    if (hasText(l.text)) continue;
    // A blank line is a paragraph gap, drawn short — except the caret's,
    // which keeps its height (Notion's fresh block) and offers `/`.
    if (drawn(l.from, l.to))
      out.push({ kind: "line", from: l.from, cls: "live-gap" });
    else if (l.length === 0)
      out.push({ kind: "empty", from: l.from, level: 0 });
  }
  return out;
}

/** A link at a position: what following it does, and its span (`to`
 *  exclusive), the range a caret inside shows the source of. */
export type LinkHit =
  | { kind: "wiki"; target: string; from: number; to: number }
  | { kind: "web"; href: string; from: number; to: number }
  /** A footnote reference; `def` is where its definition starts. */
  | {
      kind: "note";
      def: number;
      /** The note its definition cites, opened instead (UX S31). */
      source: string | null;
      from: number;
      to: number;
    };

/** Pure: target of the wikilink whose [[…]] span (inclusive) contains `col`,
 *  else null. Between two adjacent links the one starting at `col` wins. */
export function wikilinkAtCursor(lineText: string, col: number): string | null {
  return wikilinkSpanAt(lineText, col)?.target ?? null;
}

function wikilinkSpanAt(
  lineText: string,
  col: number,
): { target: string; from: number; to: number } | null {
  let endsHere: { target: string; from: number; to: number } | null = null;
  for (
    let i = lineText.indexOf("[[");
    i >= 0 && i <= col;
    i = lineText.indexOf("[[", i + 1)
  ) {
    const m = matchWikilinkAt(lineText, i);
    if (!m || col > m.end) continue;
    const span = { target: m.target, from: i, to: m.end };
    if (col < m.end) return span;
    endsHere = span;
  }
  return endsHere;
}

/** Pure: the http(s) or mailto href of the markdown link, `<autolink>` or
 *  bare URL at `pos` (either side), else null: what Preview opens in the OS
 *  browser. */
export function externalHrefAt(
  tree: Tree,
  doc: Text,
  pos: number,
): string | null {
  return externalLinkAt(tree, doc, pos)?.href ?? null;
}

function externalLinkAt(
  tree: Tree,
  doc: Text,
  pos: number,
): { href: string; from: number; to: number } | null {
  for (const side of [1, -1] as const)
    for (
      let n: SyntaxNode | null = tree.resolveInner(pos, side);
      n;
      n = n.parent
    ) {
      if (n.name !== "URL" && n.name !== "Link" && n.name !== "Autolink")
        continue;
      const url = n.name === "URL" ? n : n.getChild("URL");
      const href = url ? doc.sliceString(url.from, url.to) : "";
      return EXTERNAL_RE.test(href) ? { href, from: n.from, to: n.to } : null;
    }
  return null;
}

/** Pure: where the definition of the footnote reference `[^id]` at `pos`
 *  starts, else null (a label nothing defines is plain text). */
export function footnoteDefAt(doc: Text, pos: number): number | null {
  return footnoteRefAt(doc, pos)?.def ?? null;
}

function footnoteRefAt(
  doc: Text,
  pos: number,
): { def: number; from: number; to: number } | null {
  // A click on the left half of the second of `[^a][^b]` lands at its
  // start, where the first ends: the one starting at `pos` wins, and one
  // ending there only when nothing starts there (the caret just past it).
  const line = doc.lineAt(pos);
  let hit: { label: string; from: number; to: number } | null = null;
  for (const m of line.text.matchAll(FNREF_RE)) {
    const a = line.from + m.index;
    const b = a + m[0].length;
    if (pos < a || pos > b) continue;
    hit = { label: m[0].slice(2, -1), from: a, to: b };
    if (pos < b) break;
  }
  if (!hit) return null;
  const def = defsOf(doc).labels.get(hit.label);
  return def == null ? null : { def, from: hit.from, to: hit.to };
}

/** Pure: the wikilink, web link or footnote reference at `pos`, else null —
 *  what a click there may follow. */
export function linkAt(tree: Tree, doc: Text, pos: number): LinkHit | null {
  const line = doc.lineAt(pos);
  const wl = wikilinkSpanAt(line.text, pos - line.from);
  if (wl)
    return {
      kind: "wiki",
      target: wl.target,
      from: line.from + wl.from,
      to: line.from + wl.to,
    };
  const web = externalLinkAt(tree, doc, pos);
  if (web) return { kind: "web", ...web };
  const note = footnoteRefAt(doc, pos);
  if (!note) return null;
  const def = FNDEF_RE.exec(doc.lineAt(note.def).text);
  return {
    kind: "note",
    ...note,
    source: def ? footnoteSource(def[2]).target : null,
  };
}

/** Pure: whether a press may follow a drawn link on release. Shift (extend
 *  the selection), Alt (rectangle) and a double-click (select a word) stay
 *  CodeMirror's, on a link as anywhere else. */
export function plainPress(
  e: Pick<MouseEvent, "shiftKey" | "altKey" | "detail">,
): boolean {
  return !e.shiftKey && !e.altKey && e.detail <= 1;
}

/** Pure: the link a plain (unmodified) click at `pos` follows — only one
 *  drawn as a link, with no caret in its span. A caret there shows its
 *  source, and a click places the caret to edit it (UX S55). */
export function plainClickLink(
  tree: Tree,
  doc: Text,
  pos: number,
  carets: readonly number[],
): LinkHit | null {
  const hit = linkAt(tree, doc, pos);
  return hit && !carets.some((c) => c >= hit.from && c <= hit.to) ? hit : null;
}

/** Pure: the link a touch tap at `pos` follows (UX S46). A finger has no
 *  modifier key, so the caret does not hold it: a tap on a drawn link, or
 *  inside a link's shown source, follows it. A tap at the source's very
 *  edge places the caret beside it, the touch way into editing it. */
export function tapLink(
  tree: Tree,
  doc: Text,
  pos: number,
  onDrawnLink: boolean,
): LinkHit | null {
  const hit = linkAt(tree, doc, pos);
  if (!hit) return null;
  return onDrawnLink || (pos > hit.from && pos < hit.to) ? hit : null;
}

export interface LiveOptions {
  onLinkClick: (target: string) => void;
  /** An http(s) or mailto link: never followed in the webview. */
  onExternalLink: (href: string) => void;
  taskLabel: string;
  fmLabel: string;
  /** Placeholder of an empty heading, by level (index 0 = H1). */
  headingLabels: readonly string[];
  /** Placeholder of the caret's empty line (`Type '/' for blocks`). */
  blockLabel: string;
  /** Heading over a note's footnote definitions. */
  sourcesLabel: string;
}

class GlyphWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly cls: string,
  ) {
    super();
  }
  override eq(w: GlyphWidget): boolean {
    return w.text === this.text;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = this.cls;
    el.textContent = this.text;
    return el;
  }
}

class TaskWidget extends WidgetType {
  constructor(
    private readonly checked: boolean,
    private readonly label: string,
  ) {
    super();
  }
  override eq(w: TaskWidget): boolean {
    return w.checked === this.checked;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("input");
    el.type = "checkbox";
    el.className = "live-task";
    el.checked = this.checked;
    el.setAttribute("aria-label", this.label);
    return el;
  }
  // Keep the same DOM node across a toggle so keyboard focus stays on it.
  override updateDOM(dom: HTMLElement): boolean {
    (dom as HTMLInputElement).checked = this.checked;
    return true;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

/** Inline `$…$`, typeset: KaTeX's HTML, or its escaped source until KaTeX
 *  is in. A click lands the caret beside it, which shows the source. */
class MathWidget extends WidgetType {
  constructor(private readonly tex: string) {
    super();
  }
  override eq(w: MathWidget): boolean {
    return w.tex === this.tex;
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("span");
    el.className = "live-math";
    // mathHtml's output: KaTeX's (trust off) or the escaped source.
    el.innerHTML = mathHtml(this.tex, false);
    void drawMath(el).then(() => view.requestMeasure());
    return el;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

/** A footnote's number: a reference's (with its source's name to hover) or
 *  a definition's `n.`. Clicks reach the editor, which follows it. */
class FootnoteWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly cls: string,
    private readonly title = "",
  ) {
    super();
  }
  override eq(w: FootnoteWidget): boolean {
    return w.text === this.text && w.title === this.title;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = this.cls;
    el.textContent = this.text;
    if (this.title) el.title = this.title;
    return el;
  }
  override ignoreEvent(): boolean {
    return false;
  }
}

const HIDE = Decoration.replace({});
const BULLET = Decoration.replace({
  widget: new GlyphWidget("•", "live-bullet"),
});
const RULE = Decoration.replace({ widget: new GlyphWidget("", "live-hr") });

function toRange(s: LiveSpec, opts: LiveOptions): Range<Decoration> {
  switch (s.kind) {
    case "hide":
      return HIDE.range(s.from, s.to);
    case "hr":
      return RULE.range(s.from, s.to);
    case "empty":
      // A line attribute, not a widget: nothing enters the DOM next to the
      // caret, so an IME composition starting there is left alone.
      return Decoration.line({
        class: s.level ? "live-empty" : "live-empty live-empty-caret",
        attributes: {
          "data-placeholder": s.level
            ? (opts.headingLabels[s.level - 1] ?? `Heading ${s.level}`)
            : opts.blockLabel,
        },
      }).range(s.from);
    case "indent":
      // The width is the span's own style: one class, any depth.
      return Decoration.mark({
        class: "live-indent",
        attributes: { style: `width:${s.level * 1.5}em` },
      }).range(s.from, s.to);
    case "line":
      return Decoration.line({ class: s.cls }).range(s.from);
    case "mark":
      return Decoration.mark({ class: s.cls }).range(s.from, s.to);
    case "bullet":
      return BULLET.range(s.from, s.to);
    case "task":
      return Decoration.replace({
        widget: new TaskWidget(s.checked, opts.taskLabel),
      }).range(s.from, s.to);
    case "math":
      return Decoration.replace({ widget: new MathWidget(s.tex) }).range(
        s.from,
        s.to,
      );
    case "fnref":
      return Decoration.replace({
        widget: new FootnoteWidget(String(s.n), "live-fnum", s.title),
      }).range(s.from, s.to);
    case "fndef":
      return Decoration.replace({
        widget: new FootnoteWidget(`${s.n}.`, "live-fnum-def"),
      }).range(s.from, s.to);
    case "sources":
      return Decoration.line({
        class: "live-sources",
        attributes: { "data-label": opts.sourcesLabel },
      }).range(s.from);
  }
}

function build(
  view: EditorView,
  opts: LiveOptions,
): { decorations: DecorationSet; atomic: DecorationSet } {
  const { doc, selection } = view.state;
  const carets = selection.ranges.map((r) => r.head);
  const tree = syntaxTree(view.state);
  const defs = defsOf(doc);
  const ranges: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges)
    for (const s of liveSpecs(tree, doc, carets, from, to, defs)) {
      // The block placeholder is an invitation to type: focused only.
      if (s.kind === "empty" && !s.level && !view.hasFocus) continue;
      ranges.push(toRange(s, opts));
      if (
        (s.kind === "hide" && s.block) ||
        s.kind === "bullet" ||
        s.kind === "task" ||
        s.kind === "hr"
      )
        atomic.push(HIDE.range(s.from, s.to));
    }
  return {
    decorations: Decoration.set(ranges, true),
    atomic: Decoration.set(atomic, true),
  };
}

/** What Live draws as a link a plain click follows (UX S55). */
const DRAWN_LINK = ".live-wikilink, .live-link, .live-fnref, .live-fnum";
/** Pointer travel, in px, under which a press and release are one click. */
const CLICK_SLOP = 4;

function isTaskBox(el: EventTarget | null): el is HTMLInputElement {
  return el instanceof HTMLInputElement && el.classList.contains("live-task");
}

/** Flip the `[ ]`/`[x]` the checkbox widget stands in for; no-op when stale. */
function toggleTask(view: EditorView, box: HTMLInputElement): boolean {
  const pos = view.posAtDOM(box);
  const cur = view.state.sliceDoc(pos, pos + 3);
  if (!/^\[[ xX]\]$/.test(cur)) return false;
  view.dispatch({
    changes: { from: pos, to: pos + 3, insert: cur === "[ ]" ? "[x]" : "[ ]" },
  });
  return true;
}

/** The Live plugin's value: its decorations and the atomic block marks. */
export class LiveDecorations {
  decorations: DecorationSet;
  atomic: DecorationSet;
  /** Mapped, not rebuilt, since a composition step. */
  private stale = false;
  constructor(
    view: EditorView,
    private readonly opts: LiveOptions,
  ) {
    const b = build(view, opts);
    this.decorations = b.decorations;
    this.atomic = b.atomic;
  }
  update(u: ViewUpdate): void {
    // Mid-composition (Korean IME) nothing beside the composed text may be
    // swapped: `$x$` turning into its formula as a syllable starts after it
    // showed both, the composing text node still holding `$x$`. Only map
    // along, and rebuild once it ends (composeEnded comes then).
    if (u.view.composing) {
      this.decorations = this.decorations.map(u.changes);
      this.atomic = this.atomic.map(u.changes);
      this.stale = true;
      return;
    }
    if (
      this.stale ||
      u.docChanged ||
      u.viewportChanged ||
      u.selectionSet ||
      u.focusChanged ||
      syntaxTree(u.state) !== syntaxTree(u.startState)
    ) {
      const b = build(u.view, this.opts);
      this.decorations = b.decorations;
      this.atomic = b.atomic;
      this.stale = false;
    }
  }
}

export function liveExtension(opts: LiveOptions): Extension {
  const fmDeco = (doc: Text): DecorationSet => {
    const end = fmEndOf(doc);
    if (end === 0) return Decoration.none;
    return Decoration.set(
      Decoration.replace({
        widget: new GlyphWidget(opts.fmLabel, "live-fm"),
        block: true,
      }).range(0, doc.lineAt(end - 1).to),
    );
  };
  // A StateField (not a fold) so PropertiesPanel's replace of [0,end) keeps
  // the frontmatter hidden.
  const frontmatterField = StateField.define<DecorationSet>({
    create: (s) => fmDeco(s.doc),
    update: (v, tr) => (tr.docChanged ? fmDeco(tr.state.doc) : v),
    provide: (f) => EditorView.decorations.from(f),
  });
  // Preview's links, now that Live is the one editor: a wikilink, a web link
  // (in the OS browser) or a footnote's source note, else its definition.
  const follow = (view: EditorView, hit: LinkHit): void => {
    if (hit.kind === "wiki") return opts.onLinkClick(hit.target);
    if (hit.kind === "web") return opts.onExternalLink(hit.href);
    if (hit.source) return opts.onLinkClick(hit.source);
    // To the top, as the outline jumps (scrollEditorToLine): the reader
    // scrolls the window, and `scrollIntoView: true` or a centred target
    // left a definition far below it (?mock=1, Chromium).
    view.dispatch({
      selection: { anchor: hit.def },
      effects: EditorView.scrollIntoView(hit.def, { y: "start" }),
    });
    view.focus();
  };
  // A plain press on a drawn link, followed on release in the same spot (a
  // drag selects instead). CM has moved the caret into the link by then,
  // so the selection before the press is put back first. A release, not
  // `click`: the press redraws the link as source under the pointer.
  let pressed: {
    hit: LinkHit;
    x: number;
    y: number;
    selection: EditorSelection;
  } | null = null;
  // MouseEvent has no pointerType: the pointerdown before a press says
  // whether it was a finger (UX S46).
  let lastPointer = "";
  const plugin = ViewPlugin.define((view) => new LiveDecorations(view, opts), {
    decorations: (v) => v.decorations,
    eventHandlers: {
      pointerdown(e) {
        lastPointer = e.pointerType;
        return false;
      },
      mousedown(e, view) {
        pressed = null;
        if (e.button !== 0) return false;
        // Only keep CM from moving the caret; `click` does the toggle so the
        // browser's own check flip and the doc agree.
        if (isTaskBox(e.target)) return true;
        // A footnote number is a widget: posAtCoords puts a click on its
        // right half at its end, where `[^b]` of `[^a][^b]` starts, so
        // it resolves to the reference it draws instead.
        const fnum =
          e.target instanceof Element ? e.target.closest(".live-fnum") : null;
        const pos = fnum
          ? view.posAtDOM(fnum)
          : view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return false;
        const { state } = view;
        if (lastPointer === "touch") {
          // Tap compatibility events come only for a tap, never a scroll or
          // a long press, so this follows at once.
          const drawn = e.target instanceof Element && !!e.target.closest(DRAWN_LINK);
          const hit = tapLink(syntaxTree(state), state.doc, pos, drawn);
          if (!hit) return false;
          follow(view, hit);
          return true;
        }
        if (e.metaKey || e.ctrlKey) {
          const hit = linkAt(syntaxTree(state), state.doc, pos);
          if (!hit) return false;
          follow(view, hit);
          return true;
        }
        if (!plainPress(e)) return false;
        // Only on what is drawn as a link: a click just past one, which
        // `pos` alone cannot tell apart, places the caret beside it.
        if (!(e.target instanceof Element && e.target.closest(DRAWN_LINK)))
          return false;
        const carets = state.selection.ranges.map((r) => r.head);
        const hit = plainClickLink(syntaxTree(state), state.doc, pos, carets);
        if (hit)
          pressed = { hit, x: e.clientX, y: e.clientY, selection: state.selection };
        return false;
      },
      mouseup(e, view) {
        const p = pressed;
        pressed = null;
        if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_SLOP)
          return false;
        // After CM's own mouseup (on the document, so later), which sets the
        // caret where the press was.
        setTimeout(() => {
          view.dispatch({ selection: p.selection });
          follow(view, p.hit);
        });
        return false;
      },
      click(e, view) {
        if (isTaskBox(e.target)) toggleTask(view, e.target);
        return false; // cancelling `click` would revert the native check
      },
      keydown(e, view) {
        return (
          isTaskBox(e.target) &&
          (e.key === " " || e.key === "Enter") &&
          toggleTask(view, e.target)
        );
      },
    },
  });
  return [
    frontmatterField,
    // Caret motion skips the hidden block instead of walking into the YAML,
    // and steps over a line's hidden block marks as one unit.
    EditorView.atomicRanges.of((v) => v.state.field(frontmatterField)),
    EditorView.atomicRanges.of(
      (v) => v.plugin(plugin)?.atomic ?? Decoration.none,
    ),
    // Above the keymaps so Enter on a checkbox toggles instead of inserting.
    Prec.high(plugin),
    // An update once a composition ends, for the mapped decorations.
    composeEndRefresh,
  ];
}
