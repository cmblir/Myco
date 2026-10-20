// Query-operator parsing for ⌘K (Q4 item 4): "exact phrase", path:, tag:, and
// the frontmatter facets the Views page used to filter on — type:, status:,
// confidence:. The Rust side stays a dumb substring scan; operators are
// client-side.

import type { NodeMeta } from "./ipc";
import { tagCandidates } from "./tagIndex";

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

/** What the box can offer for an operator value: the vault's tags, its
 *  folders (vault-relative, no trailing slash) and frontmatter. */
export interface SuggestSources {
  tags: Record<string, string[]>;
  meta?: Record<string, NodeMeta>;
  folders: readonly string[];
}

// The operator whose value is being typed at the end of the box.
const PENDING_OP = /(?:^|\s)(tag|path|type):(\S*)$/;

/** The values for the `tag:` / `path:` / `type:` being typed at the end of
 *  `q` (UX backlog S23): `head` is `q` up to the value, so a pick is
 *  `head + value + " "`. Null when no such operator is open (a space ended
 *  it) or nothing in the vault matches what was typed. */
export function operatorSuggestions(
  q: string,
  sources: SuggestSources,
  limit = 30,
): { op: "tag" | "path" | "type"; head: string; values: string[] } | null {
  const m = PENDING_OP.exec(q);
  if (!m) return null;
  const value = m[2];
  const op = m[1] as "tag" | "path" | "type";
  let values: string[];
  if (op === "tag") values = tagCandidates(sources.tags, value, limit);
  else if (op === "type") {
    const types: Record<string, string[]> = {};
    for (const [path, meta] of Object.entries(sources.meta ?? {}))
      if (meta.type) types[path] = [meta.type];
    values = tagCandidates(types, value, limit);
  } else {
    const v = value.toLowerCase();
    values = sources.folders
      .map((f) => `${f}/`)
      .filter((f) => f.toLowerCase().includes(v))
      .slice(0, limit);
  }
  return values.length > 0 ? { op, head: q.slice(0, q.length - value.length), values } : null;
}
