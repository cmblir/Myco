// Markdown renderer. Adds a custom inline rule for [[wikilinks]] that emits
// `<a data-link="target">display</a>` so the renderer can hand off click
// resolution to the application layer.

import MarkdownIt from "markdown-it";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import type StateCore from "markdown-it/lib/rules_core/state_core.mjs";
import type Token from "markdown-it/lib/token.mjs";
import fence from "markdown-it/lib/rules_block/fence.mjs";
import footnote from "markdown-it-footnote";
import mark from "markdown-it-mark";
import { imageExtFor, type RenderEnv } from "./assets";
import { fenceBlock, nodeBlock, type BlockCtx } from "./blocks";
import { calloutPlugin } from "./blocks/callout";
import { tableTagAt, taggedTables, type TaggedTables } from "./blocks/chart";
import { EMBED } from "./blocks/embed";
import { inlineText, mathPlugin } from "./blocks/math";
import { displayName } from "./displayName";
import { escapeHtml, matchWikilinkAt } from "./wikilinks";

interface InlineState {
  src: string;
  pos: number;
  posMax: number;
  push(type: string, tag: string, nesting: number): InlineToken;
  Token: new (type: string, tag: string, nesting: -1 | 0 | 1) => InlineToken;
}

interface InlineToken {
  content: string;
  children: InlineToken[] | null;
  meta: unknown;
  attrSet(name: string, value: string): void;
}

// A leading YAML frontmatter fence: `---` on its own line, any body, a closing
// `---` line. Must start at the very beginning of the document (mirrors the
// gray_matter parse on the Rust side). Used to hide frontmatter in previews
// while the source editor still shows and round-trips it.
const FRONTMATTER_RE = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** Length of the leading frontmatter block, 0 if none. */
export function frontmatterLength(md: string): number {
  return FRONTMATTER_RE.exec(md)?.[0].length ?? 0;
}

/** Strip a leading YAML frontmatter block so previews render only the body. */
export function stripFrontmatter(md: string): string {
  return md.slice(frontmatterLength(md));
}

function wikilinkRule(state: InlineState, silent: boolean): boolean {
  // Delegate to the canonical matcher so the rendered viewer and the graph
  // agree on what is a link. Notably this rejects `[[a]b]]` (a `]` inside the
  // inner text), which the previous `indexOf("]]")` scan accepted.
  const match = matchWikilinkAt(state.src, state.pos);
  if (!match) return false;

  if (!silent) {
    const token = state.push("wikilink", "a", 0);
    token.attrSet("data-link", match.target);
    token.attrSet("class", "myco-wikilink");
    token.content = match.display || match.target;
  }

  state.pos = match.end;
  return true;
}

// Obsidian's `![[shot.png]]` embed → an image token for `assets/shot.png`.
// Anything else after `![[` falls through: `![[note]]` alone in a paragraph
// is a note embed (noteEmbedRule), inside text it stays `!` + wikilink.
function embedRule(state: InlineState, silent: boolean): boolean {
  if (!state.src.startsWith("![[", state.pos)) return false;
  const match = matchWikilinkAt(state.src, state.pos + 1);
  if (!match || !imageExtFor("", match.target)) return false;

  if (!silent) {
    const token = state.push("image", "img", 0);
    // `![[assets/shot.png]]` (Obsidian's path-style links) names its folder.
    token.attrSet(
      "src",
      /[\\/]/.test(match.target) ? match.target : `assets/${match.target}`,
    );
    token.attrSet("alt", "");
    const alt = new state.Token("text", "", 0);
    alt.content = match.display;
    token.children = [alt];
    // The source as written: Preview parses it as Live does (`|300` = width).
    token.meta = { embed: state.src.slice(state.pos, match.end) };
  }

  state.pos = match.end;
  return true;
}

// `![[note#Heading]]` alone in a paragraph is a note embed (lib/blocks/embed),
// as Live draws that line: the paragraph becomes one block token, so the
// embed's box never lands inside a <p>. After the callout rule, so a
// callout's body can hold one. Not on a list item's marker line (`- ![[n]]`):
// Live keeps that line text, since a widget would take the bullet with it.
function noteEmbedRule(state: StateCore): void {
  const tokens = state.tokens;
  for (let i = 1; i + 1 < tokens.length; i++) {
    const inline = tokens[i];
    const item = tokens[i - 2];
    if (
      inline.type !== "inline" ||
      tokens[i - 1].type !== "paragraph_open" ||
      tokens[i + 1].type !== "paragraph_close" ||
      !EMBED.parse(inline.content) ||
      (item?.type === "list_item_open" &&
        item.map?.[0] === tokens[i - 1].map?.[0])
    )
      continue;
    const embed = new state.Token("note_embed", "div", 0);
    embed.block = true;
    embed.map = tokens[i - 1].map;
    embed.meta = { embed: inline.content };
    tokens.splice(i - 1, 3, embed);
  }
}

const CLOSE_FENCE_RE = /^(`{3,}|~{3,})[ \t]*$/;

// markdown-it's fence, which records whether a closing line ended it
// (`meta.closed`): an unclosed fence runs to the end of its container, and
// only a closed one may draw as a registry block (Live reads Lezer's closing
// mark the same way, blocks/live.ts). The last line it took closes it only
// when it reads as a closing fence — else the scan would have stopped there.
function fenceRule(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  if (!fence(state, startLine, endLine, silent)) return false;
  if (silent) return true;
  const token = state.tokens[state.tokens.length - 1];
  const l = state.line - 1;
  const m = CLOSE_FENCE_RE.exec(
    state.src.slice(state.bMarks[l] + state.tShift[l], state.eMarks[l]),
  );
  if (
    l > startLine &&
    m &&
    m[1][0] === token.markup[0] &&
    m[1].length >= token.markup.length &&
    state.sCount[l] - state.blkIndent < 4
  )
    token.meta = { closed: true };
  return true;
}

// `<!-- … -->` reads as nothing (`html: false` would print it as text). Block
// form = CommonMark HTML block type 2, as Lezer reads it: from a line starting
// `<!--` through the line holding `-->` (or the container's end). Text after
// the close on that line is still visible in any HTML reader, so it stays.
function commentBlockRule(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  const lineText = (l: number): string =>
    state.src.slice(state.bMarks[l] + state.tShift[l], state.eMarks[l]);
  const first = lineText(startLine);
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  if (!first.startsWith("<!--")) return false;
  if (silent) return true;
  let next = startLine + 1;
  let last = first.slice(4);
  // A blank line never ends a comment, whatever its indent (markdown-it's
  // html_block): only an outdented line with text leaves the container.
  if (!last.includes("-->"))
    for (
      ;
      next < endLine &&
      (state.isEmpty(next) || state.sCount[next] >= state.blkIndent);
      next++
    ) {
      last = lineText(next);
      if (last.includes("-->")) {
        next++;
        break;
      }
    }
  const close = last.indexOf("-->");
  state.line = next;
  const token = state.push("html_comment", "", 0);
  token.map = [startLine, next];
  token.content =
    close < 0
      ? ""
      : last
          .slice(close + 3)
          .replace(/<!--[\s\S]*?-->/g, "")
          .trim();
  return true;
}

// The first `-->` past the last `<!--` looked up, per inline state (its
// `src` never changes): a paragraph of unclosed `<!--` scanned to its end at
// each one, O(n²). Still the first close past a later `<!--` while it lies
// beyond it, and posMax (narrowed inside a link label) is checked after.
const commentClose = new WeakMap<object, number>();

function commentInlineRule(state: InlineState): boolean {
  if (!state.src.startsWith("<!--", state.pos)) return false;
  let end = commentClose.get(state);
  if (end === undefined || (end >= 0 && end < state.pos + 4)) {
    end = state.src.indexOf("-->", state.pos + 4);
    commentClose.set(state, end);
  }
  if (end < 0 || end + 3 > state.posMax) return false;
  // No token (silent or not): the text on both sides joins as if the comment
  // were not there.
  state.pos = end + 3;
  return true;
}

// GFM to-dos as Lezer reads them (editor Live draws the same items): `[ ]`,
// `[x]` or `[X]` opening a list item's first paragraph, followed by a blank.
const TASK_RE = /^\[([ xX])\](?=[ \t]|$)/;

function taskListRule(state: StateCore): void {
  const tokens = state.tokens;
  // Split once, only if a bare to-do needs its source line (split per item
  // re-scanned the note from the top each time).
  let lines: string[] | undefined;
  for (let i = 2; i < tokens.length; i++) {
    const inline = tokens[i];
    if (
      inline.type !== "inline" ||
      tokens[i - 1].type !== "paragraph_open" ||
      tokens[i - 2].type !== "list_item_open"
    )
      continue;
    const m = TASK_RE.exec(inline.content);
    const text = inline.children?.[0];
    if (!m || text?.type !== "text" || !inline.map) continue;
    // markdown-it trims the blank after a bare `- [ ] `; Lezer needs it.
    if (inline.content.length === 3) {
      const line = (lines ??= state.src.split("\n"))[inline.map[0]];
      if (!/\[[ xX]\][ \t]/.test(line ?? "")) continue;
    }
    text.content = text.content.slice(3);
    const box = new state.Token("task_checkbox", "input", 0);
    box.meta = { checked: m[1] !== " ", line: inline.map[0] };
    inline.children?.unshift(box);
    tokens[i - 2].attrJoin("class", "task-list-item");
  }
}

export interface OutlineHeading {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  /** 0-based line in the BODY (frontmatter stripped); + bodyLineOffset = editor line. */
  line: number;
}

/** The headings of a parsed document, in order (outline.extractHeadings). */
export function headingsOf(tokens: readonly Token[]): OutlineHeading[] {
  const out: OutlineHeading[] = [];
  tokens.forEach((token, i) => {
    if (token.type !== "heading_open" || !token.map) return;
    const text = (tokens[i + 1]?.children ?? [])
      .map(inlineText)
      .join("")
      .trim();
    out.push({
      level: Number(token.tag[1]) as OutlineHeading["level"],
      text,
      line: token.map[0],
    });
  });
  return out;
}

// A block's render context, once per rendered document: a TOC reads the
// outline, a chart its tagged tables, from the same token stream it is drawn
// from.
const ctxCache = new WeakMap<readonly Token[], BlockCtx>();
function blockCtx(tokens: readonly Token[], env?: RenderEnv): BlockCtx {
  let ctx = ctxCache.get(tokens);
  if (!ctx || ctx.env !== env) {
    let headings: OutlineHeading[] | undefined;
    let tables: TaggedTables | undefined;
    ctx = {
      env,
      get headings() {
        return (headings ??= headingsOf(tokens));
      },
      get tables() {
        return (tables ??= taggedTables(tokens));
      },
    };
    ctxCache.set(tokens, ctx);
  }
  return ctx;
}

/** A link the app opens in the OS browser, never in its own webview. */
export const EXTERNAL_RE = /^(https?:|mailto:)/i;

export function createRenderer(): MarkdownIt {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
    breaks: false,
  });
  // No setext headings, same as the editor (editorBlocks NO_SETEXT): a `=` or
  // `-` line under a paragraph must not make it a heading here either.
  md.disable("lheading");
  md.block.ruler.at("fence", fenceRule, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });

  md.inline.ruler.before("link", "wikilink", wikilinkRule);
  md.inline.ruler.before("image", "embed", embedRule);
  // `[^id]` citations and their `[^id]: …` definitions. The plugin's `^[…]`
  // inline notes stay off: the editor has no Live rendering for them.
  md.use(footnote);
  md.inline.ruler.disable("footnote_inline");
  // `==highlight==` → <mark> (Obsidian's), as Live reads it (editorBlocks).
  md.use(mark);
  // `$…$` / `$$…$$` (lib/blocks/math), as Live reads them (MATH_SYNTAX).
  md.use(mathPlugin);
  // One number per note however often it is cited: the plugin's `[1:1]` for
  // a repeat reads as a different note.
  md.renderer.rules.footnote_caption = (tokens, idx) =>
    `[${Number(tokens[idx].meta.id) + 1}]`;
  md.block.ruler.before("html_block", "html_comment", commentBlockRule, {
    alt: ["paragraph", "reference", "blockquote"],
  });
  md.inline.ruler.before("html_inline", "html_comment", commentInlineRule);
  md.renderer.rules.html_comment = (tokens, idx) =>
    tokens[idx].content ? `<p>${escapeHtml(tokens[idx].content)}</p>\n` : "";
  md.core.ruler.after("inline", "task_list", taskListRule);
  // A table's `^id` tag (a chart's data, chart.ts) is metadata, drawn as
  // nothing (Live's table block takes its line). Its tokens stay, so the
  // chart still finds the table (taggedTables).
  md.core.ruler.push("table_tag", (state) => {
    state.tokens.forEach((t, i) => {
      if (tableTagAt(state.tokens, i) === null) return;
      t.hidden = true;
      state.tokens[i + 1].children = [];
      state.tokens[i + 2].hidden = true;
    });
  });
  // `> [!tip] Title` callouts and `> [!note]- ` toggles (lib/blocks/callout).
  md.use(calloutPlugin);
  md.core.ruler.before("inline", "note_embed", noteEmbedRule);
  // Disabled unless the caller writes ticks back (RenderEnv.tasks).
  md.renderer.rules.task_checkbox = (tokens, idx, _o, env: RenderEnv | undefined) => {
    const { checked, line } = tokens[idx].meta;
    // Named by its task, so a screen reader tells the boxes apart; the role
    // and checked state say what it does. A <label> would make a click on
    // the text tick it.
    const text = tokens
      .slice(idx + 1)
      .map((c) => (/break$/.test(c.type) ? " " : inlineText(c)))
      .join("")
      .trim();
    const label = escapeHtml(text || (env?.strings?.rd_task_toggle ?? "Toggle task"));
    // Not `data-line`: that is a block's line, and a citation lights the
    // innermost block holding one (PageReader showPassage) — the item.
    const live = env?.tasks ? ` data-task-line="${line}" aria-label="${label}"` : " disabled";
    return `<input type="checkbox"${live}${checked ? " checked" : ""}>`;
  };
  md.renderer.rules.wikilink = (tokens, idx, _options, env: RenderEnv | undefined) => {
    const token = tokens[idx];
    const target = token.attrGet("data-link") ?? "";
    // Where the caller asks (env.displayNames), an unaliased link to an opaque
    // session id reads as `Claude Code · …`, the real stem kept as its tooltip.
    const shown =
      env?.displayNames && token.content === target ? displayName(target) : token.content;
    const tip = shown === token.content ? "" : ` title="${escapeHtml(target)}"`;
    return `<a data-link="${escapeHtml(target)}" class="myco-wikilink" href="#"${tip}>${escapeHtml(shown)}</a>`;
  };

  // Mark external links (incl. linkified bare URLs) so the Viewer can open them
  // in the OS browser via ipc.openExternal instead of navigating the Tauri
  // webview away from the single-page app.
  md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
    const token = tokens[idx];
    const href = token.attrGet("href") ?? "";
    if (EXTERNAL_RE.test(href)) {
      token.attrSet("data-external", href);
      token.attrSet("rel", "noopener noreferrer");
      token.attrSet("target", "_blank");
    }
    return self.renderToken(tokens, idx, options);
  };

  // The reader's Preview asks for every block's source line, so a citation
  // from Ask can light the quoted paragraphs (PageReader showPassage). Off
  // for every other render, whose HTML stays as it was.
  md.core.ruler.push("source_lines", (state) => {
    if (!(state.env as RenderEnv | undefined)?.sourceLines) return;
    for (const token of state.tokens)
      if (token.block && token.map && token.nesting >= 0)
        token.attrSet("data-line", String(token.map[0]));
  });
  // Source line on every heading so the outline can scroll the preview to it.
  md.renderer.rules.heading_open = (tokens, idx, options, _env, self) => {
    const token = tokens[idx];
    if (token.map) token.attrSet("data-line", String(token.map[0]));
    return self.renderToken(tokens, idx, options);
  };

  // Registry blocks (lib/blocks) draw as Live draws them: a fence by its
  // info word, an image through the image block, which maps vault-relative
  // sources to asset-protocol URLs when the caller supplies a RenderEnv
  // (without one — tests, Ask previews — the src is left as written).
  const codeFence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, options, env: RenderEnv, self) => {
    const token = tokens[idx];
    const block = token.meta?.closed ? fenceBlock(token.info) : undefined;
    const parsed = block?.parse(token.content);
    if (block?.renderStatic && parsed != null)
      return block.renderStatic(parsed, blockCtx(tokens, env));
    return codeFence
      ? codeFence(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options);
  };
  md.renderer.rules.note_embed = (tokens, idx, _options, env: RenderEnv) => {
    const parsed = EMBED.fromToken?.(tokens[idx], "");
    return parsed ? (EMBED.renderStatic?.(parsed, blockCtx(tokens, env)) ?? "") : "";
  };
  md.renderer.rules.image = (tokens, idx, options, env: RenderEnv, self) => {
    const token = tokens[idx];
    const block = nodeBlock(token.type);
    const text = self.renderInlineAsText(token.children ?? [], options, env);
    const parsed = block?.fromToken?.(token, text);
    if (block?.renderStatic && parsed != null)
      return block.renderStatic(parsed, blockCtx(tokens, env));
    return self.renderToken(tokens, idx, options);
  };

  return md;
}

export const markdownRenderer = createRenderer();
