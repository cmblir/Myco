//! Wikification pipeline — retrieval grounding (v2, phase 1).
//!
//! Before the ingest agent runs, find which EXISTING wiki pages a new source
//! most likely relates to, so the prompt can tell the agent to UPDATE those
//! pages (with citations) instead of creating near-duplicates. This is the
//! roadmap's "dedup across hundreds of sessions" core: today the agent guesses
//! affected pages from `index.md`, which does not scale past a few dozen pages.
//!
//! The mechanism reuses the existing semantic layer — chunk the source
//! (`embeddings::chunk_page`), embed the chunks with the SAME model the vector
//! index was built with, retrieve per-chunk hits (`VectorStore::search`), and
//! fold them here into one ranked, per-page candidate list. Grounding is
//! best-effort: no index, an empty one, or a model-space mismatch yields no
//! candidates and ingest proceeds exactly as it did before.

use crate::retrieval::{rrf_fuse, Bm25Hit};
use crate::vector_index::Hit;
use serde::Serialize;
use std::collections::HashMap;

/// Retrieval depth per arm. Also the dense-only search depth `wikify_candidates`
/// requests directly (no lexical arm), and the pool `rrf_fuse` folds both arms
/// into when the harness measures fusion. Wider than the final `MAX_MATCHES`
/// so the knowledge-page filter below still has enough candidates left to
/// fill it, dense-only included.
pub const FUSE_POOL: usize = 50;

/// Chunk matches kept per source chunk, after filtering, before `rank_candidates`.
const MAX_MATCHES: usize = 16;

/// Source chunks embedded per wikify call. Caps the cost: a long transcript
/// would otherwise take seconds, and the leading chunks capture the source's
/// subject matter well enough to retrieve its candidate pages.
pub const MAX_CHUNKS: usize = 8;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CandidatePage {
    /// Vault-relative path, e.g. `wiki/attention-mechanism.md`.
    pub page: String,
    /// Filename stem, e.g. `attention-mechanism` (what a `[[wikilink]]` uses).
    pub stem: String,
    /// Best chunk-vs-source cosine similarity across the whole source.
    pub score: f32,
}

/// Pages that are knowledge to be updated — not the structural or source-summary
/// pages an ingest always rewrites anyway. A source-summary (`source-<slug>.md`)
/// belongs 1:1 to some OTHER source, so surfacing it as an "update this" target
/// would be wrong; `index.md`/`log.md` are handled by the workflow regardless.
pub fn is_knowledge_page(stem: &str) -> bool {
    stem != "index" && stem != "log" && !stem.starts_with("source-")
}

/// Per-source-chunk match list for the shipped **dense-only** wikify path: keep
/// only knowledge pages, THEN cap at `MAX_MATCHES`. Filtering after truncating
/// would let source-summary/index/log chunks consume the cap and evict
/// knowledge pages a dense-only search would have surfaced.
///
/// Deliberately does NOT route through `rrf_fuse`. RRF preserves the dense
/// *order*, but it overwrites every hit's score with `1/(RRF_K + rank)`, which
/// would collapse all candidates into a near-constant ~0.017..0.012 band. The
/// scores on this path are consumed as cosine similarities: `rank_candidates`
/// folds a page's chunks by max score (max cosine, not "best rank"), the
/// ingest planner prompt puts `(similarity 0.xx)` in front of the LLM, and the
/// Ingest panel renders the value. So the raw cosine from `VectorStore::search`
/// must survive to `CandidatePage.score`.
///
/// Lives here rather than in `retrieval.rs` because the policy it encodes (the
/// knowledge-page filter, the cap) is wikify-specific, while `retrieval.rs`
/// stays the generic lexical/fusion layer shared with Ask.
pub fn dense_chunk_matches(dense: &[Hit]) -> Vec<Hit> {
    let mut kept: Vec<Hit> = dense
        .iter()
        .filter(|h| is_knowledge_page(&h.stem))
        .cloned()
        .collect();
    kept.truncate(MAX_MATCHES);
    kept
}

/// Same filter → cap policy as `dense_chunk_matches`, but over the RRF fusion
/// of a chunk's dense and lexical rankings.
///
/// **No production caller.** BM25+RRF fusion WAS wired into `wikify_candidates`
/// (retrieval 1b) but `examples/wikify_eval.rs` measured it worse than
/// dense-only on this path (k=10 recall -15-16pp on Korean cases) — see
/// eval/BASELINE.md — so the command ships `dense_chunk_matches` instead. This
/// stays as the harness's `fused` arm so a future, smarter fusion attempt for
/// wikify can be measured against the same recorded baseline rather than a
/// fresh re-implementation. Note the returned scores are RRF rank scores, not
/// cosines: any future production use must first fix the downstream consumers
/// that read `CandidatePage.score` as a similarity.
///
/// `semantic_search` (Ask) does NOT call this function — it fuses inline with
/// `retrieval::rrf_fuse` directly, unaffected by this decision.
pub fn fuse_chunk_matches(dense: &[Hit], lexical: &[Bm25Hit]) -> Vec<Hit> {
    let mut fused: Vec<Hit> = rrf_fuse(dense, lexical, FUSE_POOL)
        .into_iter()
        .filter(|h| is_knowledge_page(&h.stem))
        .collect();
    fused.truncate(MAX_MATCHES);
    fused
}

/// Fold chunk-level hits (each source chunk yields several, and a page can be hit
/// by many chunks) into one list of pages, each scored by its single best chunk
/// match, ranked high-to-low and truncated to `k`. Pure over the hits so it is
/// unit-testable without the model or a vector store.
pub fn rank_candidates(hits_per_chunk: &[Vec<Hit>], k: usize) -> Vec<CandidatePage> {
    let mut best: HashMap<String, (String, f32)> = HashMap::new();
    for hits in hits_per_chunk {
        for h in hits {
            let e = best
                .entry(h.page.clone())
                .or_insert_with(|| (h.stem.clone(), f32::MIN));
            if h.score > e.1 {
                e.1 = h.score;
            }
        }
    }
    let mut out: Vec<CandidatePage> = best
        .into_iter()
        .map(|(page, (stem, score))| CandidatePage { page, stem, score })
        .collect();
    // Highest similarity first; a stable tiebreak by stem keeps output
    // deterministic when two pages match equally well.
    out.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.stem.cmp(&b.stem))
    });
    out.truncate(k);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(page: &str, stem: &str, score: f32) -> Hit {
        Hit {
            page: page.into(),
            stem: stem.into(),
            section: 0,
            score,
        }
    }

    #[test]
    fn folds_chunk_hits_to_best_score_per_page() {
        // Two chunks; page A appears in both (0.4 then 0.9 → keep 0.9), page B once.
        let per_chunk = vec![
            vec![hit("wiki/a.md", "a", 0.4), hit("wiki/b.md", "b", 0.7)],
            vec![hit("wiki/a.md", "a", 0.9)],
        ];
        let out = rank_candidates(&per_chunk, 10);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].stem, "a"); // 0.9 ranks first
        assert!((out[0].score - 0.9).abs() < 1e-6);
        assert_eq!(out[1].stem, "b");
    }

    #[test]
    fn truncates_to_k_by_score() {
        let per_chunk = vec![vec![
            hit("wiki/a.md", "a", 0.1),
            hit("wiki/b.md", "b", 0.9),
            hit("wiki/c.md", "c", 0.5),
        ]];
        let out = rank_candidates(&per_chunk, 2);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].stem, "b");
        assert_eq!(out[1].stem, "c");
    }

    #[test]
    fn empty_input_is_empty() {
        assert!(rank_candidates(&[], 5).is_empty());
        assert!(rank_candidates(&[vec![]], 5).is_empty());
    }

    #[test]
    fn fuse_chunk_matches_filters_before_capping() {
        // MAX_MATCHES + 1 source-summary chunks ranked ahead of one knowledge
        // page. Capping before filtering would return nothing; filtering first
        // must keep the knowledge page.
        let mut dense: Vec<Hit> = (0..=MAX_MATCHES)
            .map(|i| hit(&format!("wiki/source-s{i}.md"), &format!("source-s{i}"), 0.9))
            .collect();
        dense.push(hit("wiki/a.md", "a", 0.1));
        let out = fuse_chunk_matches(&dense, &[]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].stem, "a");
    }

    #[test]
    fn fuse_chunk_matches_respects_cap() {
        let dense: Vec<Hit> = (0..MAX_MATCHES + 5)
            .map(|i| hit(&format!("wiki/p{i:02}.md"), &format!("p{i:02}"), 1.0 - i as f32 * 0.01))
            .collect();
        let out = fuse_chunk_matches(&dense, &[]);
        assert_eq!(out.len(), MAX_MATCHES);
    }

    #[test]
    fn fuse_chunk_matches_empty_lexical_keeps_dense_order() {
        let dense = vec![
            hit("wiki/b.md", "b", 0.9),
            hit("wiki/a.md", "a", 0.5),
            hit("wiki/c.md", "c", 0.1),
        ];
        let out = fuse_chunk_matches(&dense, &[]);
        // RRF over a single arm is rank-monotonic, so the dense order survives
        // (and is NOT re-sorted alphabetically by the identity tie-break).
        let stems: Vec<&str> = out.iter().map(|h| h.stem.as_str()).collect();
        assert_eq!(stems, vec!["b", "a", "c"]);
    }

    #[test]
    fn dense_chunk_matches_filters_before_capping() {
        // Same order-of-operations assertion as the fused variant, on the path
        // production actually ships.
        let mut dense: Vec<Hit> = (0..=MAX_MATCHES)
            .map(|i| hit(&format!("wiki/source-s{i}.md"), &format!("source-s{i}"), 0.9))
            .collect();
        dense.push(hit("wiki/a.md", "a", 0.1));
        let out = dense_chunk_matches(&dense);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].stem, "a");
    }

    #[test]
    fn dense_chunk_matches_respects_cap() {
        let dense: Vec<Hit> = (0..MAX_MATCHES + 5)
            .map(|i| hit(&format!("wiki/p{i:02}.md"), &format!("p{i:02}"), 1.0 - i as f32 * 0.01))
            .collect();
        assert_eq!(dense_chunk_matches(&dense).len(), MAX_MATCHES);
    }

    #[test]
    fn dense_chunk_matches_keeps_cosine_scores_where_fuse_replaces_them_with_rrf() {
        // The distinction this whole helper exists for. Downstream consumers
        // (`rank_candidates`'s max-score fold, the ingest planner prompt, the
        // Ingest panel) read `CandidatePage.score` as a cosine similarity, so
        // the dense path must return the INPUT scores verbatim. Routing through
        // `rrf_fuse` preserves order but overwrites each score with
        // `1/(RRF_K + rank)`, collapsing them into a near-constant band.
        let dense = vec![
            hit("wiki/b.md", "b", 0.91),
            hit("wiki/a.md", "a", 0.52),
            hit("wiki/c.md", "c", 0.13),
        ];

        let out = dense_chunk_matches(&dense);
        let stems: Vec<&str> = out.iter().map(|h| h.stem.as_str()).collect();
        assert_eq!(stems, vec!["b", "a", "c"]);
        let scores: Vec<f32> = out.iter().map(|h| h.score).collect();
        for (got, want) in scores.iter().zip([0.91f32, 0.52, 0.13]) {
            assert!((got - want).abs() < 1e-6, "expected cosine {want}, got {got}");
        }

        // Contrast: the fused helper returns RRF rank scores for the same input.
        let fused = fuse_chunk_matches(&dense, &[]);
        for (rank, h) in fused.iter().enumerate() {
            let rrf = 1.0 / (crate::retrieval::RRF_K + rank as f32);
            assert!(
                (h.score - rrf).abs() < 1e-6,
                "fused score should be the RRF rank score {rrf}, got {}",
                h.score
            );
            // And it is NOT the cosine it came in with.
            assert!((h.score - dense[rank].score).abs() > 1e-3);
        }
    }

    #[test]
    fn knowledge_page_excludes_source_summaries_and_structure() {
        assert!(is_knowledge_page("attention-mechanism"));
        assert!(!is_knowledge_page("source-attention-is-all-you-need"));
        assert!(!is_knowledge_page("index"));
        assert!(!is_knowledge_page("log"));
    }
}
