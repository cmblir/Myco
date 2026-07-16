// Query views — a Dataview-lite over the wiki's frontmatter. The Rust link
// scanner already ships every page's structured metadata to the client
// (Adjacency.meta: type / confidence / status / sourceCount, plus tags and the
// link maps), so a "view" is a pure, synchronous filter+sort over data that is
// in memory anyway — no backend, no query language, just typed filters that
// cover the questions people actually ask of their vault ("low-confidence
// techniques", "under-sourced claims", "untagged orphans").

import type { Adjacency } from "./ipc";
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
}

export type ViewSort = "name" | "sources" | "links" | "type";

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
}

function anyOf(value: string | undefined, wanted?: string[]): boolean {
  if (!wanted || wanted.length === 0) return true;
  return value != null && wanted.includes(value);
}

/** Run a view over the live adjacency. `files` = absolute markdown paths. */
export function runView(
  adj: Adjacency,
  files: string[],
  filter: ViewFilter,
  sort: ViewSort = "name",
  desc = false,
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
      default:
        return a.name.localeCompare(b.name) * dir;
    }
  });
  return rows;
}

/** Distinct values present in the vault for each filterable facet — drives the
 * filter dropdowns so they only offer values that exist. */
export function facetValues(adj: Adjacency, files: string[]): {
  types: string[];
  confidence: string[];
  status: string[];
  tags: string[];
} {
  const types = new Set<string>();
  const confidence = new Set<string>();
  const status = new Set<string>();
  const tags = new Set<string>();
  for (const path of files) {
    const m = adj.meta?.[path];
    if (m?.type) types.add(m.type);
    if (m?.confidence) confidence.add(m.confidence);
    if (m?.status) status.add(m.status);
    for (const t of adj.tags[path] ?? []) tags.add(t);
  }
  const sorted = (s: Set<string>): string[] => [...s].sort((a, b) => a.localeCompare(b));
  return { types: sorted(types), confidence: sorted(confidence), status: sorted(status), tags: sorted(tags) };
}

// --- persistence -----------------------------------------------------------

const KEY = "memex.queryViews.v1";

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
