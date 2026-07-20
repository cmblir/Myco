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

use crate::vector_index::Hit;
use serde::Serialize;
use std::collections::HashMap;

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
    fn knowledge_page_excludes_source_summaries_and_structure() {
        assert!(is_knowledge_page("attention-mechanism"));
        assert!(!is_knowledge_page("source-attention-is-all-you-need"));
        assert!(!is_knowledge_page("index"));
        assert!(!is_knowledge_page("log"));
    }
}
