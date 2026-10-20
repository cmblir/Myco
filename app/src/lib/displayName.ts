// The name a page is SHOWN by. Extractive ingest of session transcripts left
// the vault full of `source-claude-code-<uuid>` stems (and `Source: <that>`
// titles) that all read alike; wherever a page is listed by stem, this turns
// such an id into `Claude Code · 064ddbe4`. Read path only — the stem stays
// the page's identity (links, routes, tooltips), nothing is renamed.

/** Vendor display names are proper nouns — shown as-is, not translated. Keyed
 *  by the importer's `source:` slug (importers/mod.rs `Source::slug`). */
export const VENDOR_LABEL: Record<string, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude.ai",
  "claude-code": "Claude Code",
  codex: "Codex",
};

// `<source>-<uuid>` (importers `doc_stem`), optionally `source-`-prefixed (the
// summary page) and `-N`-suffixed (a re-ingest's free raw/ path).
const OPAQUE =
  /^(?:source-)?((claude-code|codex|chatgpt|claude)-([0-9a-f]{8})(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:-\d+)?$/;
const STABLE_SESSION = /^(?:source-)?session-([a-z0-9][a-z0-9-]{0,31})-([a-f0-9]{16})$/;

function opaqueName(s: string): string | null {
  const name = s.replace(/^Source: /, "");
  const m = OPAQUE.exec(name);
  if (m) return `${VENDOR_LABEL[m[2]]} · ${m[3]}`;
  const stable = STABLE_SESSION.exec(name);
  return stable ? `${VENDOR_LABEL[stable[1]] ?? stable[1]} · ${stable[2].slice(0, 8)}` : null;
}

/** The `<agent>-<uuid>` an opaque stem or title names (the importer's
 *  `doc_stem`, which is also the transcript's stem), or null. */
export function sessionIdOf(s: string): string | null {
  return OPAQUE.exec(s.replace(/^Source: /, ""))?.[1] ?? null;
}

/** A readable frontmatter `title`, else `<Agent> · <first 8 hex>` for an
 *  opaque session id (stem or title), else the stem itself. */
export function displayName(stem: string, title?: string | null): string {
  const t = title?.trim();
  if (t && !opaqueName(t)) return t;
  return opaqueName(stem) ?? (t ? opaqueName(t) : null) ?? stem;
}

/** A page listed by file name (sidebar, graph, palette): its stem, except an
 *  opaque session stem, which takes its readable title once Tidy gave it one.
 *  A readable stem keeps showing the file name, as those lists always have. */
export function listedName(stem: string, title?: string | null): string {
  return displayName(stem, opaqueName(stem) ? title : null);
}

/** An ingest report's stem (`<date>[-<time>]-<slug>`, extractiveIngest
 *  `reportRel`) whose slug is an opaque session: `<date> · <Agent> · 8hex`.
 *  Any other report keeps its file name. */
export function reportName(stem: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}(?:-\d+)?)-(.+)$/.exec(stem);
  const name = m ? opaqueName(m[2]) : null;
  return m && name ? `${m[1]} · ${name}` : stem;
}
