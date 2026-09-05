// Extractive Ask answer (builtin-local provider): render what retrieval found
// instead of asking the 1B model to paraphrase it. Retrieval is the measured
// strength of the stack (hit@1 82.3%, src-tauri/eval/BASELINE.md); 1B
// synthesis on top of it only added echo loops and confabulation. Pure
// function — all IO stays with the caller.

import type { HitTier, ScoredChunk, TierWeights } from "./ipc";

export interface ExtractiveOptions {
  /** Max distinct pages to render (rank order). */
  maxPages?: number;
  /** Max quoted characters per page; excess is cut at the limit with "…". */
  perPageChars?: number;
}

/** Cut `text` to at most `limit` chars on a LINE boundary, and never inside a
 * fenced code block: a mid-fence cut leaves an unterminated ``` that swallows
 * the rest of the answer into one code block when the markdown renders. Drops
 * whole trailing lines until any fence count is even, so the quote stays valid
 * markdown at the cost of a little content. */
function truncateWholeLines(text: string, limit: number): string {
  const lines = text.slice(0, limit).split("\n");
  // A partial last line is dropped rather than shown mid-word — unless it is
  // the only line, where dropping it would leave nothing at all.
  if (lines.length > 1 && text.length > limit) lines.pop();
  const fenced = (ls: string[]): number =>
    ls.filter((l) => l.trimStart().startsWith("```")).length;
  while (lines.length > 0 && fenced(lines) % 2 !== 0) lines.pop();
  return lines.join("\n");
}

export interface PageGroup {
  page: string;
  stem: string;
  texts: string[];
  /** Best dense cosine among the page's chunks; null when every chunk that
   *  represents it came from the lexical arm only. */
  best: number | null;
  /** Best pure-RRF score among the page's chunks (`score_rrf`, or `score` on
   *  a backend that predates the split) — the page's rank before any prior. */
  rrf: number;
}

/** Group hits by page, preserving the ranked order of first appearance and
 * capping at `maxPages`. Shared by the rendered answer, the citation ladder
 * and the coverage row so they describe exactly the pages the answer quotes. */
export function groupByPage(hits: ScoredChunk[], maxPages: number): PageGroup[] {
  const order: PageGroup[] = [];
  const byPage = new Map<string, PageGroup>();
  for (const h of hits) {
    if (!h.text) continue;
    const rrf = h.score_rrf ?? h.score;
    let entry = byPage.get(h.page);
    if (!entry) {
      if (order.length >= maxPages) continue;
      entry = { page: h.page, stem: h.stem, texts: [], best: h.similarity, rrf };
      byPage.set(h.page, entry);
      order.push(entry);
    }
    entry.texts.push(h.text);
    // A page's strongest chunk represents it: later chunks append under the
    // same header, so showing the best match is what the header labels.
    if (h.similarity !== null && (entry.best === null || h.similarity > entry.best)) {
      entry.best = h.similarity;
    }
    if (rrf > entry.rrf) entry.rrf = rrf;
  }
  return order;
}

/** A page's quoted body: its chunks joined, cut at `perPageChars` on a line
 * boundary with "…". Shared by the markdown answer and the ladder so both
 * quote the same lines. */
export function quoteBody(texts: string[], perPageChars = 700): string {
  const body = texts.join("\n\n");
  return body.length > perPageChars
    ? `${truncateWholeLines(body, perPageChars).trimEnd()}…`
    : body;
}

/** One cited page as the chips under an answer show it. */
export interface Citation {
  /** VAULT-RELATIVE path, as `ScoredChunk.page` carries it. */
  page: string;
  stem: string;
  /** Best dense cosine for this page; null = lexical-only hit, no cosine. */
  similarity: number | null;
}

export function citationsOf(
  hits: ScoredChunk[],
  opts: ExtractiveOptions = {},
): Citation[] {
  return groupByPage(hits, opts.maxPages ?? 5).map(({ page, stem, best }) => ({
    page,
    stem,
    similarity: best,
  }));
}

/** Pages retrieval surfaced that the answer does NOT show: everything past
 * the citation cap and the deep-storage pick. Grounded answers' most common
 * failure is omission — confidently answering while skipping a relevant
 * source — and citations can only ever show "what backs the said"; this is
 * the complement that shows "what was considered and left out", so the
 * reader can judge coverage instead of trusting silence.
 *
 * Shares groupByPage with citationsOf so the split is exact: every retrieved
 * page is in the citations, the deep-storage row, or here — never two of
 * them, never dropped. `shownPages` is the union of cited pages and the
 * deep-storage page. */
export function uncitedOf(hits: ScoredChunk[], shownPages: ReadonlySet<string>): Citation[] {
  return groupByPage(hits, Number.POSITIVE_INFINITY)
    .filter((g) => !shownPages.has(g.page))
    .map(({ page, stem, best }) => ({ page, stem, similarity: best }));
}

export type ConfidenceBand = "high" | "medium" | "low" | "lexical";

/** Which confidence band a citation's dense cosine falls in.
 *
 * Boundaries are measured on the CURRENT embed model — re-measured 2026-08-31
 * for e5-small-ko (`examples/abstention_probe.rs`, bilingual eval corpus,
 * 71 pages / 146 chunks, 62 labeled queries), replacing the bge-m3 numbers
 * this shipped with:
 *
 *   0.60  median top-1 cosine of the 52 correctly-answered queries is 0.603,
 *         so at/above it a hit is as strong as a typical real match. (bge-m3
 *         measured 0.65 here — the swap moved the whole geometry down.)
 *   0.55  4/52 correct hits (7.7%) sit between 0.50 and 0.55 — the same
 *         bottom-of-the-real-distribution band bge-m3 showed, so this
 *         boundary survives the model swap unchanged.
 *   0.42  RELEVANCE_FLOOR (chat.ts, same probe). chat.ts already drops
 *         everything below it, so "low" is the floor band, not a reject band.
 *
 * What is NOT measured is the split into three buckets or the words attached
 * to them — that is presentation over one measured distribution. */
export function confidenceBand(similarity: number | null): ConfidenceBand {
  // A lexical-only hit has no cosine at all (see chat.ts's isRelevant): it
  // gets its own honest label instead of a band it never earned.
  if (similarity == null) return "lexical";
  if (similarity >= 0.6) return "high";
  if (similarity >= 0.55) return "medium";
  return "low";
}

export type SourceTier =
  | "note"
  | "map"
  | "digest"
  | "rollup"
  | "monthly"
  | "session"
  | "source";

/** Which layer of the vault a citation came from, so an answer assembled out
 * of machine-written digests is not presented as the user's own writing.
 *
 * The folder names are the ones the existing classifiers already agree on —
 * `NON_KNOWLEDGE_FOLDERS` (graphData.ts) and `is_machine_written`
 * (src-tauri/src/vector_index.rs); this splits that single "not knowledge"
 * bucket into the layers the user can act on instead of merging them.
 * `raw`/`_inbox`/`ingest-reports` collapse into one "imported source" tier:
 * all three are material that was brought in, not written.
 *
 * `wiki/maps/*` is the one place this classifier deliberately DISAGREES with
 * the graph's `isNonKnowledgePath` / vector_index's `is_machine_written`, and
 * it should: those two answer "is this a knowledge page?" — and a drafted map
 * is one, it is a wiki page with real links and belongs in the graph and the
 * index. This one answers a different question, "who wrote the words being
 * quoted back at you?" — and maps.ts drafts them with the query model
 * (`status: draft` frontmatter, a human has not signed off). Same file, two
 * honest answers; the folder set above is not forked, only extended here.
 * Mirrored in Rust as `retrieval::source_tier` (src-tauri/src/retrieval.rs), where it also drives ranking; its table test `source_tier_mirrors_the_ts_classifier` lists these same cases — change both together.
 * `page` is VAULT-RELATIVE. */
export function sourceTier(page: string): SourceTier {
  if (page.startsWith("wiki/maps/")) return "map";
  switch (page.split("/")[0]) {
    case "daily":
      return "digest";
    case "weekly":
      return "rollup";
    case "monthly":
      return "monthly";
    case "sessions":
      return "session";
    case "raw":
    case "_inbox":
    case "ingest-reports":
      return "source";
    default:
      return "note";
  }
}

/** Tier priors the ladder proposes (mockup "Strata"): the user's own notes
 * rank first, drafted maps and machine digests below, session logs and raw
 * imports last. `rollup` shares the digest value until it is measured. All
 * 1.00 reproduces the app's pre-prior ranking exactly. */
export const DEFAULT_TIER_WEIGHTS: TierWeights = {
  note: 1,
  map: 0.9,
  digest: 0.8,
  rollup: 0.8,
  session: 0.6,
  source: 0.5,
};

/** The backend's tier for a `SourceTier`: `monthly` rolls up like `weekly`. */
export function hitTier(tier: SourceTier): HitTier {
  return tier === "monthly" ? "rollup" : tier;
}

/** Category colour token for a tier chip — the app's fixed `--c-*` meanings:
 * violet concept = the user's notes, blue overview = maps, teal analysis =
 * machine digests/rollups, amber source = imports; sessions are dim (a log,
 * not a category). Returns a CSS `var(...)` expression. */
export function tierColor(tier: SourceTier): string {
  switch (hitTier(tier)) {
    case "note":
      return "var(--c-concept)";
    case "map":
      return "var(--c-overview)";
    case "digest":
    case "rollup":
      return "var(--c-analysis)";
    case "session":
      return "var(--ink-4)";
    case "source":
      return "var(--c-source)";
  }
}

export function formatExtractiveAnswer(
  hits: ScoredChunk[],
  opts: ExtractiveOptions = {},
): string {
  const sections: string[] = [];
  for (const { stem, texts, best } of groupByPage(hits, opts.maxPages ?? 5)) {
    const body = quoteBody(texts, opts.perPageChars);
    const quoted = body
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    // Relevance is shown because it is now a REAL number: `similarity` is the
    // dense cosine, so 68% and 52% mean something to compare. (The `score`
    // field next to it is a rank-fusion value that would look like a
    // confidence and behave like noise.) A lexical-only hit has no cosine and
    // gets no percentage rather than a fabricated one.
    const relevance = best === null ? "" : ` · ${Math.round(best * 100)}%`;
    sections.push(`**[[${stem}]]**${relevance}\n\n${quoted}`);
  }
  return sections.join("\n\n");
}
