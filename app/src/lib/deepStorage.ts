// Deep-storage row under an extractive Ask answer (Q4 item 12): retrieval
// often finds a strong match in the cold layers (sessions, raw sources,
// rollups) that the answer's wiki-first citations never show. Surface exactly
// one — the user's own history resurfacing, not a second answer. Pure
// function — all IO stays with the caller.

import { sourceTier, type SourceTier } from "./extractive";
import type { ScoredChunk } from "./ipc";

const COLD_TIERS: ReadonlySet<SourceTier> = new Set([
  "session",
  "source",
  "rollup",
  "monthly",
]);

export interface DeepStorageHit {
  /** VAULT-RELATIVE path, as `ScoredChunk.page` carries it. */
  page: string;
  stem: string;
  similarity: number | null;
}

/** Highest-similarity hit whose sourceTier is a cold tier
 * (session|source|rollup|monthly) and whose page is not among the cited
 * pages. `null` when none clears `minSim` — 0.55, the measured band boundary
 * below which the bottom ~7% of real hits live (see confidenceBand). Hits
 * without a cosine (lexical-only) are skipped: a "deep echo" claim needs a
 * real number behind it. */
export function pickDeepStorage(
  hits: ScoredChunk[],
  citedPages: ReadonlySet<string>,
  minSim = 0.55,
): DeepStorageHit | null {
  let best: ScoredChunk | null = null;
  for (const h of hits) {
    if (h.similarity === null || h.similarity < minSim) continue;
    if (citedPages.has(h.page)) continue;
    if (!COLD_TIERS.has(sourceTier(h.page))) continue;
    if (best === null || h.similarity > (best.similarity as number)) best = h;
  }
  return best
    ? { page: best.page, stem: best.stem, similarity: best.similarity }
    : null;
}
