// Source ladder under an extractive Ask answer: every retrieved page as one
// ranked row — tier, cosine, the quoted lines, and the arithmetic behind its
// place (RRF × tier prior = final, ▲▼ against the pure-RRF order). Pure: the
// backend ranks with the same formula (the request's tierWeights), and
// re-ranking here is what lets the prior sliders preview a change live
// without another query embedding.

import {
  groupByPage,
  hitTier,
  quoteBody,
  sourceTier,
  type SourceTier,
} from "./extractive";
import type { NearMiss, ScoredChunk, TierWeights } from "./ipc";

export interface LadderRow {
  /** VAULT-RELATIVE path, as `ScoredChunk.page` carries it. */
  page: string;
  stem: string;
  tier: SourceTier;
  /** Best dense cosine for the page; null = lexical-only, no cosine. */
  similarity: number | null;
  /** The page's quoted body — the same lines the answer renders. */
  quote: string;
  /** Best pure-RRF score among the page's chunks. */
  rrf: number;
  prior: number;
  /** `rrf × prior` — what the row is sorted by. */
  final: number;
  /** Positions moved by the prior vs. the pure-RRF order; positive = up. */
  rankChange: number;
  /** Lives under an `archive/` folder — the cold tier the index keeps out. */
  archived: boolean;
}

/** Rank the retrieved pages with `weights` applied. Ties keep arrival order
 * (stable sort), so with every weight at 1.00 the ladder is the backend's
 * own order and every `rankChange` is 0. */
export function ladderOf(
  hits: ScoredChunk[],
  weights: TierWeights,
  perPageChars?: number,
): LadderRow[] {
  const groups = groupByPage(hits, Number.POSITIVE_INFINITY);
  const base = [...groups].sort((a, b) => b.rrf - a.rrf);
  const rows = groups
    .map((g): LadderRow => {
      const tier = sourceTier(g.page);
      const prior = weights[hitTier(tier)];
      return {
        page: g.page,
        stem: g.stem,
        tier,
        similarity: g.best,
        quote: quoteBody(g.texts, perPageChars),
        rrf: g.rrf,
        prior,
        final: g.rrf * prior,
        rankChange: 0,
        archived: /(^|\/)archive\//.test(g.page),
      };
    })
    .sort((a, b) => b.final - a.final);
  rows.forEach((r, i) => {
    r.rankChange = base.findIndex((g) => g.page === r.page) - i;
  });
  return rows;
}

/** What the retrieval stepper can say truthfully from one response. Numbers
 * the client cannot see (the BM25 arm's full list, the pre-cap fusion size)
 * are not invented — each field names exactly what it counts. */
export interface RetrievalTrace {
  /** Pages in the index (`embeddings_status`) — the candidate pool; null when
   *  the status call did not answer. */
  indexedPages: number | null;
  /** Returned hits (kept or rejected) the lexical arm alone surfaced — no
   *  cosine. */
  lexicalOnly: number;
  /** Returned hits (kept or rejected) carrying a dense cosine. */
  dense: number;
  /** Everything fusion returned, kept or rejected. */
  fused: number;
  /** The per-query cap asked for (`k`). */
  cap: number;
  /** Hits that fell under the relevance floor. */
  rejected: number;
  floor: number;
}

export function traceOf(
  r: { hits: ScoredChunk[]; nearMisses: NearMiss[]; floor: number },
  indexedPages: number | null,
  cap: number,
): RetrievalTrace {
  const all = [...r.hits, ...r.nearMisses];
  const dense = all.filter((h) => typeof h.similarity === "number").length;
  return {
    indexedPages,
    lexicalOnly: all.filter((h) => h.similarity === null).length,
    dense,
    fused: all.length,
    cap,
    rejected: r.nearMisses.length,
    floor: r.floor,
  };
}
