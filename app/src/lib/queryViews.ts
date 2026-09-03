// Query views — a Dataview-lite over the wiki's frontmatter. The Rust link
// scanner already ships every page's structured metadata to the client
// (Adjacency.meta: type / confidence / status / sourceCount, plus tags and the
// link maps), so a "view" is a pure, synchronous filter+sort over data that is
// in memory anyway — no backend, no query language, just typed filters that
// cover the questions people actually ask of their vault ("low-confidence
// techniques", "under-sourced claims", "untagged orphans").

import { ipc, type Adjacency } from "./ipc";
import { stem } from "./graphData";

export interface ViewFilter {
  /** Any-of matches; empty/undefined = no constraint. */
  types?: string[];
  confidence?: string[];
  status?: string[];
  tags?: string[];
  /** Substring match on the page name (case-insensitive). */
  text?: string;
  minSources?: number;
  /** Only pages with zero wikilinks in either direction. */
  orphansOnly?: boolean;
  /** Only pages citing nothing — a claim with no source behind it. */
  unsourcedOnly?: boolean;
}

export type ViewSort = "name" | "sources" | "links" | "type" | "modified";

export interface SavedView {
  id: string;
  name: string;
  filter: ViewFilter;
  sort: ViewSort;
  desc: boolean;
}

export interface ViewRow {
  path: string;
  name: string;
  type?: string;
  confidence?: string;
  status?: string;
  sourceCount: number;
  tags: string[];
  links: number;
  /** Unix seconds; 0 when the vault's mtimes have not loaded (or the file
   *  vanished between the scan and the read). */
  modified: number;
}

/** Pages that exist to organise the wiki rather than to claim anything:
 *  the table of contents and the changelog. Mirrors contradictions.ts's
 *  SKIP_NAMES (and mcp_native::LINT_SKIP_NAMES) — every scan that judges a
 *  page's substance has to agree on which pages are not making claims. */
const STRUCTURAL_NAMES = new Set(["index.md", "log.md"]);

function isStructural(path: string): boolean {
  return STRUCTURAL_NAMES.has(path.slice(path.lastIndexOf("/") + 1));
}

function anyOf(value: string | undefined, wanted?: string[]): boolean {
  if (!wanted || wanted.length === 0) return true;
  return value != null && wanted.includes(value);
}

/** Run a view over the live adjacency. `files` = absolute markdown paths. */
/** Wiki pages only, out of every markdown file in the vault.
 *
 *  The page filters on wiki frontmatter (type / confidence / status / tags /
 *  sources), which nothing outside `wiki/` carries — so handing it the whole
 *  tree buried the 92 real pages of the owner's vault under 1,428 session
 *  transcripts and a pile of daily notes, every one of them rendering as a
 *  row of dashes and zeroes. Same scope rule the lint and the contradiction
 *  scan already use.
 *
 *  `vaultRoot` is optional so a caller without one (tests, the mock browser)
 *  keeps the old unfiltered behaviour rather than silently emptying. */
export function wikiPagesOnly(files: string[], vaultRoot?: string): string[] {
  if (!vaultRoot) return files;
  const prefix = vaultRoot.endsWith("/") ? vaultRoot : `${vaultRoot}/`;
  return files.filter((f) => f.startsWith(`${prefix}wiki/`));
}

export function runView(
  adj: Adjacency,
  files: string[],
  filter: ViewFilter,
  sort: ViewSort = "name",
  desc = false,
  /** path → unix seconds. Absent until `file_mtimes` resolves; rows then read
   *  0 and the "modified" sort degrades to name order rather than erroring. */
  mtimes?: Map<string, number>,
): ViewRow[] {
  const text = filter.text?.trim().toLowerCase();
  const rows: ViewRow[] = [];
  for (const path of files) {
    const meta = adj.meta?.[path];
    const tags = adj.tags[path] ?? [];
    const links = (adj.forward[path]?.length ?? 0) + (adj.backward[path]?.length ?? 0);
    if (!anyOf(meta?.type, filter.types)) continue;
    if (!anyOf(meta?.confidence, filter.confidence)) continue;
    if (!anyOf(meta?.status, filter.status)) continue;
    if (filter.tags && filter.tags.length > 0 && !filter.tags.some((t) => tags.includes(t)))
      continue;
    if (filter.minSources != null && (meta?.sourceCount ?? 0) < filter.minSources) continue;
    if (filter.orphansOnly && links > 0) continue;
    // "No sources" asks which CLAIMS are unbacked, so index.md and log.md —
    // which cite nothing by design — are not answers to it. They stay in the
    // unfiltered table; only this lens skips them.
    if (filter.unsourcedOnly && ((meta?.sourceCount ?? 0) > 0 || isStructural(path)))
      continue;
    const name = stem(path);
    if (text && !name.toLowerCase().includes(text)) continue;
    rows.push({
      path,
      name,
      type: meta?.type,
      confidence: meta?.confidence,
      status: meta?.status,
      sourceCount: meta?.sourceCount ?? 0,
      tags,
      links,
      modified: mtimes?.get(path) ?? 0,
    });
  }
  const dir = desc ? -1 : 1;
  rows.sort((a, b) => {
    switch (sort) {
      case "sources":
        return (a.sourceCount - b.sourceCount) * dir || a.name.localeCompare(b.name);
      case "links":
        return (a.links - b.links) * dir || a.name.localeCompare(b.name);
      case "type":
        return (a.type ?? "").localeCompare(b.type ?? "") * dir || a.name.localeCompare(b.name);
      case "modified":
        return (a.modified - b.modified) * dir || a.name.localeCompare(b.name);
      default:
        return a.name.localeCompare(b.name) * dir;
    }
  });
  return rows;
}

/** One filter-dropdown entry: the value and how many pages carry it. */
export interface Facet {
  value: string;
  count: number;
}

/** Values present in the vault for each filterable facet, WITH counts — the
 * dropdowns then say how the vault is actually distributed ("concept (34)")
 * instead of listing bare labels you have to try one by one. Only values that
 * exist are offered, so no filter can return an empty table by construction.
 *
 * Counts sort first (descending), then the label: the biggest bucket is the
 * one worth looking at, and a stable tiebreak keeps the list from reshuffling
 * between renders. */
export function facetValues(
  adj: Adjacency,
  files: string[],
): {
  types: Facet[];
  confidence: Facet[];
  status: Facet[];
  tags: Facet[];
} {
  const types = new Map<string, number>();
  const confidence = new Map<string, number>();
  const status = new Map<string, number>();
  const tags = new Map<string, number>();
  const bump = (m: Map<string, number>, k?: string): void => {
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  };
  for (const path of files) {
    const m = adj.meta?.[path];
    bump(types, m?.type);
    bump(confidence, m?.confidence);
    bump(status, m?.status);
    for (const t of adj.tags[path] ?? []) bump(tags, t);
  }
  const ranked = (m: Map<string, number>): Facet[] =>
    [...m.entries()]
      .map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  return {
    types: ranked(types),
    confidence: ranked(confidence),
    status: ranked(status),
    tags: ranked(tags),
  };
}

/** Lenses the page opens with, so the first click asks a real question
 *  instead of leaving the visitor to invent one against five dropdowns.
 *  Each is a question the vault can only answer through this table:
 *
 *  - unsourced: a wiki claim with nothing behind it (the trust question)
 *  - orphans:   written, then never linked from anywhere (the lost-page one)
 *  - disputed:  flagged as contradicting another page, awaiting a decision
 *  - recent:    what changed lately, newest first
 *
 *  Built-ins are not saved views: they carry no id, cannot be deleted, and
 *  do not touch localStorage. Saving one after tweaking it makes a real
 *  saved view, which is the intended path from "browse" to "my lens".
 */
export interface BuiltinLens {
  key: string;
  /** i18n key for the chip label; the page falls back to `fallback`. */
  labelKey: string;
  fallback: string;
  filter: ViewFilter;
  sort: ViewSort;
  desc: boolean;
}

export const BUILTIN_LENSES: BuiltinLens[] = [
  {
    key: "unsourced",
    labelKey: "vw_lens_unsourced",
    fallback: "No sources",
    filter: { unsourcedOnly: true },
    sort: "name",
    desc: false,
  },
  {
    key: "orphans",
    labelKey: "vw_lens_orphans",
    fallback: "Orphans",
    filter: { orphansOnly: true },
    sort: "name",
    desc: false,
  },
  {
    key: "disputed",
    labelKey: "vw_lens_disputed",
    fallback: "Disputed",
    filter: { status: ["disputed"] },
    sort: "name",
    desc: false,
  },
  {
    key: "recent",
    labelKey: "vw_lens_recent",
    fallback: "Recently changed",
    filter: {},
    sort: "modified",
    desc: true,
  },
];

// --- persistence -----------------------------------------------------------

/** Vault-relative path of a saved view — the stem IS the view's id and name. */
export function viewRel(name: string): string {
  return `.myco/views/${name}.json`;
}

const SORTS: ViewSort[] = ["name", "sources", "links", "type", "modified"];

/** Stem is authoritative for id AND name; tolerant of hand-written files: an
 *  object with an object `filter`, sort ∈ SORTS else "name", desc === true. */
export function parseSavedView(raw: string, stem: string): SavedView | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed == null) return null;
  const v = parsed as Partial<SavedView>;
  if (typeof v.filter !== "object" || v.filter == null) return null;
  return {
    id: stem,
    name: stem,
    filter: v.filter,
    sort: SORTS.includes(v.sort as ViewSort) ? (v.sort as ViewSort) : "name",
    desc: v.desc === true,
  };
}

export function saveVaultView(v: SavedView): Promise<void> {
  return ipc.saveView(v.name, JSON.stringify(v, null, 2));
}

/** Every `.myco/views/*.json` the vault holds, corrupt files skipped. */
export async function loadVaultViews(vaultRoot: string): Promise<SavedView[]> {
  const names = await ipc.listViews();
  const files = await Promise.all(names.map((n) => ipc.readFile(`${vaultRoot}/${viewRel(n)}`)));
  return files.flatMap((f, i) => parseSavedView(f.raw, names[i]) ?? []);
}

const KEY = "myco.queryViews.v1";

export function loadViews(): SavedView[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (v): v is SavedView =>
        typeof v === "object" && v != null && typeof (v as SavedView).id === "string",
    );
  } catch {
    return [];
  }
}

export function saveViews(views: SavedView[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(views));
  } catch {
    /* localStorage unavailable — views just don't persist */
  }
}
