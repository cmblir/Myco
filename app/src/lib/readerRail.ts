// Pure derivations behind the reader's single rail (mockup "Manuscript"):
// the merged Connections list, this note's citation coverage, and the minimal
// range one text insertion covers. Kept out of the components so they are
// testable in the node environment.

import type { ProvenanceRow, SourceRef, TierWeights, VecHit } from "./ipc";
import { hitTier, sourceTier } from "./extractive";
import type { LinkSuggestion } from "./linkSuggestions";
import { stem } from "./graphData";

export interface ConnRow {
  /** Backlinks first, then semantic neighbours, then unaccepted suggestions. */
  kind: "backlink" | "related" | "suggested";
  /** Absolute vault path the row opens. */
  path: string;
  name: string;
  /** Similarity, 0..1 — semantic rows only. */
  score?: number;
  /** The suggestion this row stands for; `suggested` rows only. */
  suggestion?: LinkSuggestion;
}

/**
 * Backlinks + related + this page's link suggestions as ONE list, deduped by
 * target path with the strongest relationship winning (a page that links here
 * is a backlink, not a "similar note"). Suggestions are oriented so `path` is
 * always the OTHER page — accepting one appends the wikilink to THIS note.
 */
export function connectionRows(args: {
  filePath: string;
  /** adjacency.backward[filePath]. */
  backward: readonly string[] | undefined;
  /** related_pages hits (vault-RELATIVE pages), or null while unknown. */
  related: readonly VecHit[] | null;
  vaultRoot: string;
  suggestions: readonly LinkSuggestion[];
}): ConnRow[] {
  const { filePath, backward, related, vaultRoot, suggestions } = args;
  const out: ConnRow[] = [];
  const seen = new Set<string>([filePath]);
  const push = (row: ConnRow): void => {
    if (seen.has(row.path)) return;
    seen.add(row.path);
    out.push(row);
  };
  for (const p of backward ?? []) push({ kind: "backlink", path: p, name: stem(p) });
  for (const h of related ?? []) {
    const abs = vaultRoot ? `${vaultRoot}/${h.page}` : h.page;
    push({ kind: "related", path: abs, name: h.stem, score: h.score });
  }
  for (const s of suggestions) {
    const other = s.source === filePath ? s.target : s.source;
    push({
      kind: "suggested",
      path: other,
      name: stem(other),
      score: s.score,
      // Oriented: acceptSuggestion writes to `source`, and the note being read
      // is the one that should gain the link.
      suggestion: { ...s, source: filePath, target: other },
    });
  }
  return out;
}

export interface SourceView {
  ref: SourceRef;
  /** The tier prior Ask applies to the layer this citation resolves into;
   *  null when no raw file backs it (a dangling citation has no trust). */
  weight: number | null;
}

export interface SourcesView {
  cited: number;
  total: number;
  uncited: number;
  /** Cited claims as a whole percent; 0 when the note makes no claims. */
  pct: number;
  sources: SourceView[];
}

/** This note's row out of the vault-wide provenance scan. `null` = not scanned
 *  yet, or the scan has no row for this path (a file with no claims at all). */
export function sourcesView(
  rows: readonly ProvenanceRow[] | null,
  filePath: string,
  weights: TierWeights,
): SourcesView | null {
  const row = rows?.find((r) => r.path === filePath);
  if (!row) return null;
  return {
    cited: row.cited,
    total: row.total,
    uncited: Math.max(0, row.total - row.cited),
    pct: row.total === 0 ? 0 : Math.round((row.cited / row.total) * 100),
    sources: row.sources.map((ref) => ({ ref, weight: sourceWeight(ref, weights) })),
  };
}

function sourceWeight(ref: SourceRef, weights: TierWeights): number | null {
  if (!ref.resolved) return null;
  return weights[hitTier(sourceTier(`raw/${ref.slug}.md`))];
}

/** The one changed range between two texts (common prefix / suffix trimmed),
 *  so an append can be dispatched into the open editor without replacing the
 *  whole document — which would drop the caret and swallow undo history. */
export function insertionRange(
  before: string,
  after: string,
): { from: number; to: number; insert: string } | null {
  if (before === after) return null;
  let from = 0;
  while (from < before.length && before[from] === after[from]) from++;
  let tail = 0;
  const max = Math.min(before.length, after.length) - from;
  while (
    tail < max &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++;
  return {
    from,
    to: before.length - tail,
    insert: after.slice(from, after.length - tail),
  };
}
