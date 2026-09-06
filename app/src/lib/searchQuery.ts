// Query-operator parsing for ⌘K (Q4 item 4): "exact phrase", path:, tag:, and
// the frontmatter facets the Views page used to filter on — type:, status:,
// confidence:. The Rust side stays a dumb substring scan; operators are
// client-side.

import type { NodeMeta } from "./ipc";

/** The frontmatter facets a query can pin, all string-valued in NodeMeta. */
export type MetaKey = "type" | "status" | "confidence";

export interface ParsedQuery {
  phrases: string[];
  path: string | null;
  tags: string[];
  /** `type:concept` → ["type", "concept"]; several may stack. */
  meta: [MetaKey, string][];
  terms: string;
}

const OP = /^(path|tag|type|status|confidence):(.*)$/;

export function parseSearchQuery(raw: string): ParsedQuery {
  const phrases: string[] = [];
  let rest = "";
  let buf = "";
  let inQuote = false;
  for (const c of raw) {
    if (c === '"') {
      if (inQuote) {
        if (buf.trim()) phrases.push(buf.trim().toLowerCase());
        buf = "";
        inQuote = false;
      } else {
        inQuote = true;
      }
    } else if (inQuote) {
      buf += c;
    } else {
      rest += c;
    }
  }
  if (inQuote) rest += buf; // unclosed quote: plain text

  let path: string | null = null;
  const tags: string[] = [];
  const meta: [MetaKey, string][] = [];
  const terms: string[] = [];
  for (const tok of rest.split(/\s+/).filter(Boolean)) {
    const m = OP.exec(tok);
    if (m && m[2]) {
      if (m[1] === "path") path = m[2];
      else if (m[1] === "tag") tags.push(m[2].toLowerCase());
      else meta.push([m[1] as MetaKey, m[2].toLowerCase()]);
    } else {
      terms.push(tok);
    }
  }
  return { phrases, path, tags, meta, terms: terms.join(" ") };
}

/** True when the query pins anything beyond free text. */
export function hasOperators(parsed: ParsedQuery): boolean {
  return parsed.path !== null || parsed.tags.length > 0 || parsed.meta.length > 0;
}

export function hitPassesFilters(
  hitAbsPath: string,
  vaultRoot: string,
  parsed: ParsedQuery,
  tags: Record<string, string[]>,
  meta?: Record<string, NodeMeta>,
): boolean {
  const rel = hitAbsPath.startsWith(vaultRoot)
    ? hitAbsPath.slice(vaultRoot.length).replace(/^\/+/, "")
    : hitAbsPath;
  if (parsed.path && !rel.startsWith(parsed.path)) return false;
  if (parsed.tags.length > 0) {
    const own = (tags[hitAbsPath] ?? []).map((t) => t.toLowerCase());
    if (!parsed.tags.every((t) => own.includes(t))) return false;
  }
  for (const [key, want] of parsed.meta) {
    if ((meta?.[hitAbsPath]?.[key] ?? "").toLowerCase() !== want) return false;
  }
  return true;
}
