// Abstention is a first-class Ask answer: when nothing clears the relevance
// floor the app says so, shows what came closest, and never quotes the
// least-bad chunk as if it were evidence. Pure — the store decides, the page
// renders.

import { hitTier, sourceTier } from "./extractive";
import type { NearMiss, ScoredChunk } from "./ipc";

/** No hit carries a dense cosine at or above `floor`. A lexical-only hit
 * (no cosine) keeps its place in an answer that has dense evidence, but on
 * its own it is a keyword coincidence, not grounds — so it does not rescue
 * an otherwise empty result. */
export function shouldAbstain(hits: ScoredChunk[], floor: number): boolean {
  return !hits.some((h) => h.similarity != null && h.similarity >= floor);
}

/** Near-miss rows for the abstention card: the rejected hits plus any
 * keyword-only hits (shown as "keywords only"), deduped by page, best cosine
 * first, keyword-only last, at most `max`. */
export function nearMissesOf(
  hits: ScoredChunk[],
  rejected: NearMiss[],
  max = 4,
): NearMiss[] {
  const lexical: NearMiss[] = hits
    .filter((h) => h.similarity == null)
    .map((h) => ({
      page: h.page,
      tier: hitTier(sourceTier(h.page)),
      score_final: h.score_final ?? h.score,
      similarity: null,
    }));
  // A server triple without a cosine (`undefined`) is unknown, not
  // keyword-only — it sorts after the numbers but before the nulls.
  const rank = (m: NearMiss): number =>
    typeof m.similarity === "number" ? m.similarity : m.similarity === undefined ? -1 : -2;
  const seen = new Set<string>();
  const out: NearMiss[] = [];
  for (const m of [...rejected, ...lexical].sort((a, b) => rank(b) - rank(a))) {
    if (seen.has(m.page)) continue;
    seen.add(m.page);
    out.push(m);
  }
  return out.slice(0, max);
}
