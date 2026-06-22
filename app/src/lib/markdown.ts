// Markdown renderer. Adds a custom inline rule for [[wikilinks]] that emits
// `<a data-link="target">display</a>` so the renderer can hand off click
// resolution to the application layer.

import MarkdownIt from "markdown-it";
import { escapeHtml, matchWikilinkAt } from "./wikilinks";

interface InlineState {
  src: string;
  pos: number;
  push(type: string, tag: string, nesting: number): InlineToken;
}

interface InlineToken {
  content: string;
  attrSet(name: string, value: string): void;
}

// A leading YAML frontmatter fence: `---` on its own line, any body, a closing
// `---` line. Must start at the very beginning of the document (mirrors the
// gray_matter parse on the Rust side). Used to hide frontmatter in previews
// while the source editor still shows and round-trips it.
const FRONTMATTER_RE = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** Strip a leading YAML frontmatter block so previews render only the body. */
export function stripFrontmatter(md: string): string {
  const match = FRONTMATTER_RE.exec(md);
  return match ? md.slice(match[0].length) : md;
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
    token.attrSet("class", "memex-wikilink");
    token.content = match.display || match.target;
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
  md.renderer.rules.wikilink = (tokens, idx) => {
    const token = tokens[idx];
    const target = token.attrGet("data-link") ?? "";
    const display = token.content;
    return `<a data-link="${escapeHtml(target)}" class="memex-wikilink" href="#">${escapeHtml(display)}</a>`;
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

  return md;
}

export const markdownRenderer = createRenderer();
