// Math: `$…$` inline and `$$…$$` display, by GitHub's rules, typeset by KaTeX
// (loaded with import() on the first formula shown, its CSS and fonts from
// the app bundle). Inline (Pandoc's rule, which GitHub follows): the opening
// `$` has a non-space after it, the closing one a non-space before it and no
// digit after it — `$5 and $10` stays text — and it stays on one line. A
// `$$` line opens a display block, even right under a paragraph (GitHub's
// own example), running to the first line that ends with `$$`; a blank line
// or its container's end first leaves it unclosed, read as its text by both
// views. The scan is one function per construct, shared by the editor's
// Lezer parser (MATH_SYNTAX) and Preview's markdown-it (mathPlugin), so the
// two read the same math. KaTeX runs with throwOnError off (a bad formula
// shows its source in red) and trust off: no \href, \url, \includegraphics
// or \html* from vault TeX.

import type { MarkdownConfig } from "@lezer/markdown";
import type MarkdownIt from "markdown-it";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import type Token from "markdown-it/lib/token.mjs";
import type katexApi from "katex";
import { escapeHtml, matchWikilinkAt } from "../wikilinks";
import type { BlockSpec } from "./index";
import { fenced, textForm } from "./fencePanel";
import { mathSource, stripLead } from "./fenceSource";

/** The last scan that found no closer: from the `$` at `from` of `s`, it
 *  stopped at `stop` — a line break (`nl`) or its `end`. */
let failed = { s: "", from: -1, stop: -1, nl: false };

/** Pure: where the inline math opened by the `$` at `pos` of `s` closes
 *  (the closing `$`'s index), or -1. `\$` inside is TeX's dollar.
 *  Linear per line: both parsers try a line's openers left to right, and
 *  whether a `$` closes depends only on its neighbours — a scan from a
 *  later opener inside a failed scan walks that scan's own tail (from the
 *  opener's next character on, a skipped `$` or not), so it fails too, up
 *  to where that scan stopped. Without this, `$12 … $15 …` rescanned the
 *  line's rest per `$`. */
export function inlineMathEnd(s: string, pos: number, end = s.length): number {
  if (s[pos - 1] === "$" || pos + 1 >= end || /[\s$]/.test(s[pos + 1]))
    return -1;
  if (
    failed.s === s &&
    failed.from < pos &&
    pos < failed.stop &&
    (failed.nl || end <= failed.stop)
  ) {
    // The same text again (a new string each parse): compare by reference
    // from here on.
    failed.s = s;
    return -1;
  }
  for (let i = pos + 1; i < end; i++) {
    const c = s[i];
    if (c === "\n") {
      failed = { s, from: pos, stop: i, nl: true };
      return -1;
    }
    if (c === "\\") i++;
    else if (c === "$" && !/\s/.test(s[i - 1]) && !/\d/.test(s[i + 1] ?? ""))
      return i;
  }
  failed = { s, from: pos, stop: end, nl: false };
  return -1;
}

/** The `$` at `at` of `s` sits inside a `[[…]]`: Preview's wikilink rule
 *  reads the link before its math rule sees the `$`, which is link text —
 *  unless a `\` escapes the `[` (Preview then draws no link). Lezer has no
 *  wikilink rule, so its InlineMath asks. ponytail: the nearest `[[` only,
 *  and a backward search per formula found; walk a line's links once if a
 *  line with thousands of formulas lags. */
function inWikilink(s: string, at: number): boolean {
  const i = s.lastIndexOf("[[", at);
  if (i < 0) return false;
  let k = i;
  while (k > 0 && s[k - 1] === "\\") k--;
  return (i - k) % 2 === 0 && (matchWikilinkAt(s, i)?.end ?? 0) > at;
}

/** A line's end closing a display block (on the opening line: past `$$`). */
export const CLOSE_RE = /\$\$[ \t]*$/;
/** A display block's lines past their container marks → its TeX. */
const DISPLAY_RE = /^[ \t]*\$\$([\s\S]*)\$\$[ \t]*$/;

/** The editor's Lezer extension: InlineMath and BlockMath nodes. */
export const MATH_SYNTAX: MarkdownConfig = {
  defineNodes: [{ name: "BlockMath", block: true }, "InlineMath"],
  parseInline: [
    {
      name: "InlineMath",
      parse(cx, next, pos) {
        if (next !== 36) return -1;
        const at = pos - cx.offset;
        const end = inlineMathEnd(cx.text, at, cx.end - cx.offset);
        return end < 0 || inWikilink(cx.text, at)
          ? -1
          : cx.addElement(cx.elt("InlineMath", pos, cx.offset + end + 1));
      },
    },
  ],
  parseBlock: [
    {
      name: "BlockMath",
      parse(cx, line) {
        if (
          line.indent - line.baseIndent >= 4 ||
          !line.text.startsWith("$$", line.pos)
        )
          return false;
        // ponytail: a line's baseIndent stands in for its container depth
        // (Lezer keeps that internal): a line whose quote or item does not
        // continue has less. `>x` (no space) under `> $$` reads as ended
        // here, as a quote line in markdown-it.
        const base = line.baseIndent;
        const from = cx.lineStart + line.pos;
        let to = cx.lineStart + line.text.length;
        let closed = CLOSE_RE.test(line.text.slice(line.pos + 2));
        while (cx.nextLine()) {
          if (closed || line.baseIndent < base || line.pos === line.text.length)
            break;
          to = cx.lineStart + line.text.length;
          closed = CLOSE_RE.test(line.text);
        }
        cx.addElement(cx.elt("BlockMath", from, to));
        return true;
      },
      endLeaf: (_, line) => line.text.startsWith("$$", line.pos),
      before: "FencedCode",
    },
  ],
};

function inlineRule(state: StateInline, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 36) return false;
  const end = inlineMathEnd(state.src, state.pos, state.posMax);
  if (end < 0) return false;
  if (!silent)
    state.push("math_inline", "math", 0).content = state.src.slice(
      state.pos + 1,
      end,
    );
  state.pos = end + 1;
  return true;
}

function blockRule(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  const text = (l: number) =>
    state.src.slice(state.bMarks[l] + state.tShift[l], state.eMarks[l]);
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const first = text(startLine);
  if (!first.startsWith("$$")) return false;
  if (silent) return true;
  let last = startLine;
  let closed = CLOSE_RE.test(first.slice(2));
  while (
    !closed &&
    last + 1 < endLine &&
    !state.isEmpty(last + 1) &&
    state.sCount[last + 1] >= state.blkIndent
  )
    closed = CLOSE_RE.test(text(++last));
  state.line = last + 1;
  const token = state.push("math_block", "div", 0);
  token.block = true;
  token.map = [startLine, state.line];
  token.content = state.getLines(startLine, state.line, state.blkIndent, false);
  token.markup = "$$";
  return true;
}

// Inline children whose `content` is text the reader sees; markup tokens
// (strong_open, link_close, …) carry none.
const TEXT_TOKENS = new Set(["text", "code_inline", "wikilink"]);

/** Pure: an inline child token's text as written — text, code, a wikilink's
 *  label, and math as its `$…$` source (the token holds the exact slice
 *  between the delimiters) — "" for markup. A heading's outline text and a
 *  table cell's read through it, so a `[[note#…]]` to a heading with math
 *  still matches. */
export const inlineText = (c: Token): string =>
  c.type === "math_inline"
    ? `$${c.content}$`
    : TEXT_TOKENS.has(c.type)
      ? c.content
      : "";

/** Preview's markdown-it rules for the same syntax. */
export function mathPlugin(md: MarkdownIt): void {
  md.inline.ruler.after("escape", "math_inline", inlineRule);
  // Ends a paragraph, a quote's or an item's lazy lines, as a fence does.
  md.block.ruler.before("fence", "math_block", blockRule, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
  md.renderer.rules.math_inline = (tokens, idx) =>
    mathHtml(tokens[idx].content, false);
  md.renderer.rules.math_block = (tokens, idx) => {
    const tex = MATH.fromToken!(tokens[idx], "");
    return tex === null
      ? `<p>${escapeHtml(tokens[idx].content)}</p>\n`
      : MATH.renderStatic!(tex, { headings: [] });
  };
}

type Katex = typeof katexApi;
let katex: Katex | null = null;
let loading: Promise<Katex> | undefined;

/** KaTeX with its stylesheet, once; each call after the first resolves at
 *  once. */
export function loadKatex(): Promise<Katex> {
  return (loading ??= Promise.all([
    import("katex"),
    import("katex/dist/katex.min.css"),
  ]).then(([m]) => (katex = m.default)));
}

/** Pure: a formula's HTML — KaTeX's once loaded, else its escaped source
 *  for drawMath to typeset. */
export function mathHtml(tex: string, display: boolean): string {
  const tag = display ? "div" : "span";
  const cls = display ? "md-math is-display" : "md-math";
  if (!katex)
    return `<${tag} class="${cls} is-pending" data-tex="${escapeHtml(tex)}">${escapeHtml(display ? tex : `$${tex}$`)}</${tag}>`;
  let out: string;
  try {
    out = katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      trust: false,
      // Korean or Japanese text in math mode is fine here, not a warning.
      strict: "ignore",
    });
  } catch (err) {
    console.warn("KaTeX could not typeset", tex, err);
    out = `<span class="katex-error">${escapeHtml(tex)}</span>`;
  }
  return `<${tag} class="${cls}">${out}</${tag}>`;
}

/** Typeset the math placeholders under `root` (mathHtml before KaTeX was
 *  in), loading KaTeX first. Never rejects. */
export async function drawMath(root: ParentNode): Promise<void> {
  const pending = [
    ...root.querySelectorAll<HTMLElement>(".md-math.is-pending"),
  ];
  if (!pending.length) return;
  try {
    await loadKatex();
  } catch (err) {
    console.error("KaTeX failed to load", err);
    return;
  }
  for (const el of pending)
    if (el.parentNode)
      // KaTeX's HTML (trust off, vault text escaped), not vault text itself.
      el.outerHTML = mathHtml(
        el.dataset.tex ?? "",
        el.classList.contains("is-display"),
      );
}

export const MATH: BlockSpec<string> = {
  id: "math",
  match: { node: "BlockMath", token: "math_block" },
  slash: {
    label: "math",
    name: "sl_math",
    icon: "∑",
    aliases: [
      "equation",
      "formula",
      "latex",
      "tex",
      "katex",
      "수식",
      "수학",
      "공식",
      "数式",
    ],
    section: "advanced",
    open: true,
  },
  // A formula to edit, not an empty block (which reads as text).
  template: "$$\n\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}\n$$",
  // null: not closed, or nothing in it — the lines stay text.
  parse: (src) => DISPLAY_RE.exec(src)?.[1].trim() || null,
  fromToken: (token) => MATH.parse(token.content),
  renderStatic: (tex) => mathHtml(tex, true) + "\n",
  // One TeX field, the formula above it its live preview, as Notion's
  // equation block. An emptied field writes nothing: an empty `$$` block
  // would read as its text.
  ...fenced<string>({
    name: (t) => t?.sl_math ?? "Math block",
    draw(box, tex) {
      // mathHtml's output — KaTeX's or the escaped source — as Preview sets it.
      box.innerHTML = mathHtml(tex, true);
      return drawMath(box);
    },
    form: (tex, ctx) =>
      textForm(ctx.t?.mt_f_tex ?? "Formula (TeX)", tex, {
        rows: 2,
        keep: (v) => !v.trim(),
      }),
    read: (source, lead) =>
      MATH.parse(source.split("\n").map(stripLead(lead)).join("\n")) ?? "",
    write: (_source, lead, tex) => mathSource(lead, tex),
  }),
  // One row, and one more per `\\`.
  estimatedHeight: (tex) => 64 + 28 * (tex.match(/\\\\/g)?.length ?? 0),
};
