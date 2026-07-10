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

// --- PDF pinpoint links (Feature 6) ----------------------------------------
// A pinpoint citation into a source PDF, resolvable like a wikilink but routed
// to the in-app PDF viewer + a specific highlight anchor. Canonical form:
//   [[pdf::<raw-stem>#p<page>:<anchorId>|label]]
// e.g. [[pdf::attention-is-all-you-need#p3:a1b2|scaled attention]].

export interface PdfLink {
  /** Raw PDF file stem (under raw/), e.g. "attention-is-all-you-need". */
  stem: string;
  /** 1-based page number. */
  page: number;
  /** Sidecar anchor id (empty when linking to a page without an anchor). */
  anchorId: string;
}

const PDF_TARGET_RE = /^pdf::([^#\n]+)#p(\d+)(?::([^|\]\n]+))?$/;

/** Parse a `pdf::<stem>#p<page>:<anchorId>` wikilink target. Null if not one. */
export function parsePdfTarget(target: string): PdfLink | null {
  const m = PDF_TARGET_RE.exec(target.trim());
  if (!m) return null;
  const page = Number(m[2]);
  if (!Number.isInteger(page) || page < 1) return null;
  return { stem: m[1].trim(), page, anchorId: (m[3] ?? "").trim() };
}

/** Build a `[[pdf::…|label]]` pinpoint link. */
export function formatPdfLink(link: PdfLink, label?: string): string {
  const anchor = link.anchorId ? `:${link.anchorId}` : "";
  const target = `pdf::${link.stem}#p${link.page}${anchor}`;
  return label ? `[[${target}|${label}]]` : `[[${target}]]`;
}

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
