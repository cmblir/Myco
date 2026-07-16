// Zotero import — turns a Zotero/reference-manager export into markdown
// source documents for the `_inbox/` ingest pipeline. Two formats cover the
// real-world exports: CSL-JSON (Zotero's native JSON export; an array of items
// with title/author/issued) and BibTeX (@article{key, title={..}, ...}).
// Items that carry an `annotations` array (Zotero API / plugin exports) get
// their highlights as quoted bullets, so the eventual wiki page can cite the
// exact passages. Parsing is tolerant: anything unrecognized is skipped, never
// thrown — an import should salvage what it can.

export interface ZoteroItem {
  title: string;
  authors: string[];
  year?: string;
  doi?: string;
  url?: string;
  annotations: { text: string; comment?: string; page?: string }[];
}

interface CslName {
  family?: string;
  given?: string;
  literal?: string;
}

// --- CSL-JSON ---------------------------------------------------------------

function cslName(n: CslName): string {
  if (n.literal) return n.literal;
  return [n.given, n.family].filter(Boolean).join(" ");
}

function fromCslItem(raw: Record<string, unknown>): ZoteroItem | null {
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return null;
  const authors = Array.isArray(raw.author)
    ? (raw.author as CslName[]).map(cslName).filter(Boolean)
    : [];
  let year: string | undefined;
  const issued = raw.issued as { "date-parts"?: unknown[][] } | undefined;
  const part = issued?.["date-parts"]?.[0]?.[0];
  if (part != null) year = String(part);
  const annotations: ZoteroItem["annotations"] = [];
  if (Array.isArray(raw.annotations)) {
    for (const a of raw.annotations as Record<string, unknown>[]) {
      const text =
        typeof a.text === "string" ? a.text : typeof a.annotationText === "string" ? a.annotationText : "";
      if (!text.trim()) continue;
      annotations.push({
        text: text.trim(),
        comment:
          typeof a.comment === "string" && a.comment.trim() ? a.comment.trim() : undefined,
        page:
          a.pageLabel != null ? String(a.pageLabel) : a.page != null ? String(a.page) : undefined,
      });
    }
  }
  return {
    title,
    authors,
    year,
    doi: typeof raw.DOI === "string" ? raw.DOI : undefined,
    url: typeof raw.URL === "string" ? raw.URL : undefined,
    annotations,
  };
}

// --- BibTeX ------------------------------------------------------------------

function bibField(body: string, field: string): string | undefined {
  const re = new RegExp(`${field}\\s*=\\s*[{"]([^}"]*)[}"]`, "i");
  return re.exec(body)?.[1]?.trim() || undefined;
}

function fromBibtex(src: string): ZoteroItem[] {
  const items: ZoteroItem[] = [];
  const entries = src.split(/@\w+\s*\{/).slice(1);
  for (const body of entries) {
    const title = bibField(body, "title");
    if (!title) continue;
    const authors = (bibField(body, "author") ?? "")
      .split(/\s+and\s+/i)
      .map((a) => a.replace(/,\s*/, " ").trim()) // "Last, First" → "Last First" (readable)
      .filter(Boolean);
    items.push({
      title,
      authors,
      year: bibField(body, "year"),
      doi: bibField(body, "doi"),
      url: bibField(body, "url"),
      annotations: [],
    });
  }
  return items;
}

// --- entry point -------------------------------------------------------------

/** Parse a Zotero export (CSL-JSON text or BibTeX text) into items. */
export function parseZoteroExport(text: string): ZoteroItem[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const arr = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { items?: unknown[] }).items)
          ? (parsed as { items: unknown[] }).items
          : [];
      return arr
        .filter((x): x is Record<string, unknown> => typeof x === "object" && x != null)
        .map(fromCslItem)
        .filter((x): x is ZoteroItem => x != null);
    } catch {
      return [];
    }
  }
  if (trimmed.startsWith("@")) return fromBibtex(trimmed);
  return [];
}

/** Safe `_inbox/` filename for an item. */
export function inboxFilename(item: ZoteroItem): string {
  const slug = item.title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `zotero-${slug || "item"}.md`;
}

/** Render one item as a markdown source doc for the ingest pipeline. */
export function toSourceMarkdown(item: ZoteroItem): string {
  const lines: string[] = [`# ${item.title}`, ""];
  const meta: string[] = [];
  if (item.authors.length > 0) meta.push(`Authors: ${item.authors.join(", ")}`);
  if (item.year) meta.push(`Year: ${item.year}`);
  if (item.doi) meta.push(`DOI: ${item.doi}`);
  if (item.url) meta.push(`URL: ${item.url}`);
  if (meta.length > 0) lines.push(meta.join("  \n"), "");
  if (item.annotations.length > 0) {
    lines.push("## Highlights", "");
    for (const a of item.annotations) {
      lines.push(`> ${a.text}${a.page ? ` (p. ${a.page})` : ""}`);
      if (a.comment) lines.push(`> — ${a.comment}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}
