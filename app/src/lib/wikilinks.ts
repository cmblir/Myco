// Wikilink parsing helpers. The canonical wikilink form is `[[target]]` or
// `[[target|display]]`. Targets are matched case-insensitively against file
// stems to mirror Obsidian's resolution behavior.

export interface ParsedWikilink {
  target: string;
  display: string;
}

export interface MatchedWikilink extends ParsedWikilink {
  /** Index just past the closing `]]`, suitable for advancing a scanner. */
  end: number;
}

const WIKILINK_AT_RE = /^\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]/;

/**
 * Canonical anchored matcher. Attempts to match a wikilink that begins exactly
 * at `pos` in `src`, using the same semantics as the Rust parser: the inner
 * text may not contain `]` or a newline, so `[[a]b]]` yields no match. Returns
 * the parsed link plus the offset just past the closing `]]`, or `null` if no
 * link starts at `pos`. Shared so the markdown renderer and the graph agree on
 * what constitutes a link.
 */
export function matchWikilinkAt(
  src: string,
  pos: number,
): MatchedWikilink | null {
  const match = WIKILINK_AT_RE.exec(src.slice(pos));
  if (!match) return null;
  const target = match[1].trim();
  if (!target) return null;
  return {
    target,
    display: (match[2] ?? target).trim(),
    end: pos + match[0].length,
  };
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
