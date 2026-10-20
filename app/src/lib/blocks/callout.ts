// Callouts: a quote whose first line names its kind, `> [!tip] Title`
// (Obsidian's callouts and GitHub's alerts). `> [!type]- Title` is a toggle,
// folded by default; `+` starts it open. Preview: calloutPlugin rewrites
// markdown-it's blockquote tokens; Live draws the same box (./calloutLive).
// Both read the first line through parseCalloutHead, so they agree. No CM
// imports here: markdown.ts (Preview, Ask) loads this without the editor.

import type MarkdownIt from "markdown-it";
import type StateCore from "markdown-it/lib/rules_core/state_core.mjs";
import type Token from "markdown-it/lib/token.mjs";
import type { RenderEnv } from "../assets";
import type { Strings } from "../i18n";
import { escapeHtml } from "../wikilinks";

export const CALLOUT_TYPES = [
  "note",
  "tip",
  "info",
  "warning",
  "danger",
  "success",
  "quote",
  "important",
  "caution",
  "question",
] as const;
export type CalloutType = (typeof CALLOUT_TYPES)[number];

export interface CalloutHead {
  type: CalloutType;
  /** `-` folded by default, `+` open, "" not foldable. */
  fold: "" | "-" | "+";
  title: string;
  /** Length of `[!type]-` and the blanks after it. */
  tagLen: number;
}

const HEAD_RE = /^\[!([A-Za-z]+)\]([+-]?)[ \t]*/;

/** A callout's first line (past its `> `), or null for a plain quote. Kinds
 *  outside CALLOUT_TYPES stay quotes, as GitHub keeps them. */
export function parseCalloutHead(line: string): CalloutHead | null {
  const m = HEAD_RE.exec(line);
  const type = m?.[1].toLowerCase() as CalloutType | undefined;
  if (!m || !type || !CALLOUT_TYPES.includes(type)) return null;
  return {
    type,
    fold: m[2] as CalloutHead["fold"],
    title: line.slice(m[0].length).trim(),
    tagLen: m[0].length,
  };
}

/** An untitled callout's title: its kind, as GitHub and Obsidian show it —
 *  in the UI's language when there are strings, else the English word. */
export const kindTitle = (type: CalloutType, t?: Strings): string =>
  t?.[`callout_kind_${type}`] ?? type.charAt(0).toUpperCase() + type.slice(1);

/** A blockquote whose first paragraph opens on its first line with a
 *  callout head becomes callout_open / title / callout_title_close / body /
 *  callout_close; the head's line leaves the paragraph (an empty one goes). */
function calloutRule(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i];
    const para = tokens[i + 1];
    const inline = tokens[i + 2];
    if (
      open.type !== "blockquote_open" ||
      para?.type !== "paragraph_open" ||
      inline?.type !== "inline" ||
      !open.map ||
      para.map?.[0] !== open.map[0]
    )
      continue;
    const nl = inline.content.indexOf("\n");
    const head = parseCalloutHead(
      nl < 0 ? inline.content : inline.content.slice(0, nl),
    );
    if (!head) continue;
    let depth = 0;
    let close = i;
    for (; close < tokens.length; close++) {
      if (tokens[close].type === "blockquote_open") depth++;
      else if (tokens[close].type === "blockquote_close" && --depth === 0)
        break;
    }
    open.type = "callout_open";
    open.meta = head;
    tokens[close].type = "callout_close";
    tokens[close].meta = head;
    const title: Token = new state.Token("inline", "", 0);
    title.content =
      head.title || kindTitle(head.type, (state.env as RenderEnv).strings);
    title.children = [];
    title.map = [open.map[0], open.map[0] + 1];
    const titleClose: Token = new state.Token("callout_title_close", "", 0);
    titleClose.meta = head;
    if (nl < 0) {
      tokens.splice(i + 1, 3, title, titleClose);
    } else {
      inline.content = inline.content.slice(nl + 1);
      para.map = [para.map[0] + 1, para.map[1]];
      tokens.splice(i + 1, 0, title, titleClose);
    }
  }
}

/** A toggle is a <details>, so Preview folds with no script. */
export function calloutPlugin(md: MarkdownIt): void {
  // Before `inline`: the title token is parsed as the body is.
  md.core.ruler.after("block", "callout", calloutRule);
  const head = (tokens: Token[], idx: number) =>
    tokens[idx].meta as CalloutHead;
  md.renderer.rules.callout_open = (tokens, idx) => {
    const { type, fold } = head(tokens, idx);
    const attrs = `class="callout" data-callout="${escapeHtml(type)}"`;
    return fold
      ? `<details ${attrs}${fold === "+" ? " open" : ""}><summary class="callout-title">`
      : `<div ${attrs}><div class="callout-title">`;
  };
  md.renderer.rules.callout_title_close = (tokens, idx) =>
    head(tokens, idx).fold ? "</summary>\n" : "</div>\n";
  md.renderer.rules.callout_close = (tokens, idx) =>
    head(tokens, idx).fold ? "</details>\n" : "</div>\n";
}
