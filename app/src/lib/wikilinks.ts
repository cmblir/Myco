// Wikilink parsing helpers. The canonical wikilink form is `[[target]]` or
// `[[target|display]]`. Targets are matched case-insensitively against file
// stems to mirror Obsidian's resolution behavior.

import type { FileNode } from "./ipc";

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

/**
 * Note a followed wikilink points at: `Note#Heading` → `Note`; a bare
 * `#Heading` → `""` (same note). Only for link targets — a typed title
 * such as `C# basics` keeps its `#`. The anchor itself is handled by the
 * reader (see lib/pendingAnchor.ts).
 */
export function wikilinkBase(target: string): string {
  return target.split("#")[0].trim();
}

/**
 * The file a link to `target` opens: the first file in tree order whose name
 * without its extension is `target`, case-insensitively. Top-level templates/
 * holds scaffolds, not notes (index.rs is_staging_dir skips it too): a note
 * titled "note" must not resolve to templates/note.md. cards/ likewise: a
 * deck is saved under its note's own name.
 */
export function resolveStem(tree: FileNode[], target: string): string | null {
  if (target.includes("/")) {
    const parts = target.normalize("NFC").split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) return null;
    return findFileByPath(tree, parts.map((part) => part.toLowerCase()));
  }
  return findFileByStem(
    tree.filter((n) => !(n.kind === "directory" && (n.name === "templates" || n.name === "cards"))),
    target.toLowerCase(),
  );
}

function findFileByPath(nodes: FileNode[], parts: string[]): string | null {
  for (const node of nodes) {
    const name = node.name.normalize("NFC").toLowerCase();
    if (parts.length === 1 && node.kind === "file" &&
        (name === parts[0] || name.replace(/\.md$/, "") === parts[0])) return node.path;
    if (node.kind === "directory" && name === parts[0] && parts.length > 1) {
      return findFileByPath(node.children, parts.slice(1));
    }
  }
  return null;
}

function findFileByStem(nodes: FileNode[], lowerStem: string): string | null {
  for (const node of nodes) {
    if (node.kind === "file") {
      const dot = node.name.lastIndexOf(".");
      const stem = (dot > 0 ? node.name.slice(0, dot) : node.name).toLowerCase();
      if (stem === lowerStem) return node.path;
    } else {
      const found = findFileByStem(node.children, lowerStem);
      if (found) return found;
    }
  }
  return null;
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
