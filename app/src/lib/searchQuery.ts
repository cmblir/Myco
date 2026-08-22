// Query-operator parsing for ⌘K (Q4 item 4): "exact phrase", path:, tag:.
// The Rust side stays a dumb substring scan; operators are client-side.

export interface ParsedQuery {
  phrases: string[];
  path: string | null;
  tags: string[];
  terms: string;
}

const OP = /^(path|tag):(.*)$/;

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
  const terms: string[] = [];
  for (const tok of rest.split(/\s+/).filter(Boolean)) {
    const m = OP.exec(tok);
    if (m && m[2]) {
      if (m[1] === "path") path = m[2];
      else tags.push(m[2].toLowerCase());
    } else {
      terms.push(tok);
    }
  }
  return { phrases, path, tags, terms: terms.join(" ") };
}

export function hitPassesFilters(
  hitAbsPath: string,
  vaultRoot: string,
  parsed: ParsedQuery,
  tags: Record<string, string[]>,
): boolean {
  const rel = hitAbsPath.startsWith(vaultRoot)
    ? hitAbsPath.slice(vaultRoot.length).replace(/^\/+/, "")
    : hitAbsPath;
  if (parsed.path && !rel.startsWith(parsed.path)) return false;
  if (parsed.tags.length > 0) {
    const own = (tags[hitAbsPath] ?? []).map((t) => t.toLowerCase());
    if (!parsed.tags.every((t) => own.includes(t))) return false;
  }
  return true;
}
