// Markdown renderer. Adds a custom inline rule for [[wikilinks]] that emits
// `<a data-link="target">display</a>` so the renderer can hand off click
// resolution to the application layer.

import MarkdownIt from "markdown-it";
import { imageExtFor, resolveImageSrc } from "./assets";
import { escapeHtml, matchWikilinkAt } from "./wikilinks";

interface InlineState {
  src: string;
  pos: number;
  push(type: string, tag: string, nesting: number): InlineToken;
  Token: new (type: string, tag: string, nesting: -1 | 0 | 1) => InlineToken;
}

interface InlineToken {
  content: string;
  children: InlineToken[] | null;
  attrSet(name: string, value: string): void;
}

/** Per-render context: lets the image rule map vault paths to webview URLs. */
export interface RenderEnv {
  vaultRoot?: string;
  /** Directory of the note being rendered; `./x` resolves against it. */
  noteDir?: string;
  /** Absolute vault path → URL the webview may load (Tauri's convertFileSrc). */
  toUrl?: (absPath: string) => string;
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
// Anything else after `![[` falls through, so `![[note]]` keeps rendering as
// `!` + wikilink.
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
  }

  state.pos = match.end;
  return true;
}

export function createRenderer(): MarkdownIt {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
    breaks: false,
  });

  md.inline.ruler.before("link", "wikilink", wikilinkRule);
  md.inline.ruler.before("image", "embed", embedRule);
  md.renderer.rules.wikilink = (tokens, idx) => {
    const token = tokens[idx];
    const target = token.attrGet("data-link") ?? "";
    const display = token.content;
    return `<a data-link="${escapeHtml(target)}" class="myco-wikilink" href="#">${escapeHtml(display)}</a>`;
  };

  // Mark external links (incl. linkified bare URLs) so the Viewer can open them
  // in the OS browser via ipc.openExternal instead of navigating the Tauri
  // webview away from the single-page app.
  md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
    const token = tokens[idx];
    const href = token.attrGet("href") ?? "";
    if (/^(https?:|mailto:)/i.test(href)) {
      token.attrSet("data-external", href);
      token.attrSet("rel", "noopener noreferrer");
      token.attrSet("target", "_blank");
    }
    return self.renderToken(tokens, idx, options);
  };

  // Source line on every heading so the outline can scroll the preview to it.
  md.renderer.rules.heading_open = (tokens, idx, options, _env, self) => {
    const token = tokens[idx];
    if (token.map) token.attrSet("data-line", String(token.map[0]));
    return self.renderToken(tokens, idx, options);
  };

  // Vault-relative image sources become asset-protocol URLs when the caller
  // supplies a RenderEnv; without one (tests, Ask previews) the src is left
  // as written. Then markdown-it's default image rule: alt from the children.
  md.renderer.rules.image = (
    tokens,
    idx,
    options,
    env: RenderEnv | undefined,
    self,
  ) => {
    const token = tokens[idx];
    const src = token.attrGet("src");
    if (src && env?.vaultRoot && env.toUrl) {
      const abs = resolveImageSrc(
        src,
        env.vaultRoot,
        env.noteDir ?? env.vaultRoot,
      );
      if (abs) token.attrSet("src", env.toUrl(abs));
    }
    token.attrSet(
      "alt",
      self.renderInlineAsText(token.children ?? [], options, env),
    );
    return self.renderToken(tokens, idx, options);
  };

  return md;
}

export const markdownRenderer = createRenderer();
