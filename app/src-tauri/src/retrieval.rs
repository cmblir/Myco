//! BM25 lexical retrieval + Reciprocal Rank Fusion (Phase 1b).
//!
//! Dense (bge-m3 cosine) retrieval alone misses exact-token matches — acronyms,
//! identifiers, rare proper nouns — that a lexical index finds trivially. This
//! module is the self-contained core for the lexical arm: a dependency-free,
//! script-aware tokenizer, an in-memory BM25 index keyed on the same
//! `(page, section)` chunk identity the vector store uses, and RRF fusion that
//! combines a dense `Hit` list with a lexical `Bm25Hit` list into the single
//! `Hit` type the rest of the app already consumes.

use std::collections::{HashMap, HashSet};

use crate::vector_index::Hit;

/// BM25 term-frequency saturation parameter.
const K1: f32 = 1.2;
/// BM25 length-normalization parameter.
const B: f32 = 0.75;
/// Reciprocal Rank Fusion constant — dampens the influence of any single
/// list's exact rank so that agreement between lists (not one list's
/// confidence) drives the fused order.
const RRF_K: f32 = 60.0;

/// Split text into search tokens. Script-aware and dependency-free:
/// Latin/ASCII-alphanumeric runs become one lowercased token (`"QLoRA"` ->
/// `"qlora"`), CJK runs (Hangul syllables/Jamo, CJK ideographs, Hiragana,
/// Katakana) are emitted as character bigrams since these scripts do not
/// whitespace-delimit words (a run of length 1 is emitted as-is). Everything
/// else is a boundary and is dropped.
pub fn tokenize(text: &str) -> Vec<String> {
    fn is_cjk(c: char) -> bool {
        matches!(c,
            '\u{AC00}'..='\u{D7A3}' // Hangul syllables
            | '\u{1100}'..='\u{11FF}' // Hangul Jamo
            | '\u{3130}'..='\u{318F}' // Hangul compatibility Jamo
            | '\u{4E00}'..='\u{9FFF}' // CJK ideographs
            | '\u{3040}'..='\u{309F}' // Hiragana
            | '\u{30A0}'..='\u{30FF}' // Katakana
        )
    }
    let mut tokens = Vec::new();
    let mut latin_run = String::new();
    let mut cjk_run: Vec<char> = Vec::new();

    fn flush_latin(run: &mut String, tokens: &mut Vec<String>) {
        if !run.is_empty() {
            tokens.push(std::mem::take(run));
        }
    }
    fn flush_cjk(run: &mut Vec<char>, tokens: &mut Vec<String>) {
        if run.len() <= 1 {
            tokens.extend(run.iter().map(|c| c.to_string()));
        } else {
            for w in run.windows(2) {
                tokens.push(w.iter().collect());
            }
        }
        run.clear();
    }

    for c in text.chars() {
        if c.is_ascii_alphanumeric() {
            flush_cjk(&mut cjk_run, &mut tokens);
            latin_run.extend(c.to_lowercase());
        } else if is_cjk(c) {
            flush_latin(&mut latin_run, &mut tokens);
            cjk_run.push(c);
        } else {
            flush_latin(&mut latin_run, &mut tokens);
            flush_cjk(&mut cjk_run, &mut tokens);
        }
    }
    flush_latin(&mut latin_run, &mut tokens);
    flush_cjk(&mut cjk_run, &mut tokens);
    tokens
}

/// One indexed chunk: identity is `(page, section)`, mirroring
/// `VectorStore::Record` so lexical and dense hits refer to the same chunk.
struct Bm25Doc {
    page: String,
    stem: String,
    section: usize,
    len: u32,
}

/// A lexical search hit. Field-compatible with `vector_index::Hit`, kept
/// distinct because `score` here is a BM25 score, not a cosine similarity.
#[derive(Clone)]
pub struct Bm25Hit {
    pub page: String,
    pub stem: String,
    pub section: usize,
    pub score: f32,
}

/// In-memory BM25 index over vault chunks. No persistence — Task 3 owns
/// saving/loading; this type is rebuilt from vault text like the vector store
/// used to be before it grew a binary format.
#[derive(Default)]
pub struct Bm25Index {
    docs: Vec<Bm25Doc>,
    /// Per-doc term frequency, parallel to `docs`.
    doc_terms: Vec<HashMap<String, u32>>,
    /// term -> [(doc idx, tf)], derived from `doc_terms` on every mutation.
    postings: HashMap<String, Vec<(usize, u32)>>,
    /// term -> document frequency, derived alongside `postings`.
    df: HashMap<String, u32>,
    total_len: u64,
}

impl Bm25Index {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.docs.is_empty()
    }

    /// Number of indexed chunks.
    pub fn len(&self) -> usize {
        self.docs.len()
    }

    /// Replace all chunks for one page with a fresh set, then rebuild the
    /// derived postings/df/total_len from the resulting `doc_terms`. Mirrors
    /// `VectorStore::upsert_page`'s retain-then-append shape so the two
    /// indexes stay in step chunk-for-chunk.
    pub fn upsert_page(&mut self, page: &str, stem: &str, chunk_texts: &[String]) {
        // Compact out the page's existing docs (and their parallel term maps)
        // before appending the fresh ones, so a re-indexed page never leaves
        // stale chunks behind.
        let mut kept_docs = Vec::with_capacity(self.docs.len());
        let mut kept_terms = Vec::with_capacity(self.doc_terms.len());
        for (doc, terms) in self.docs.drain(..).zip(self.doc_terms.drain(..)) {
            if doc.page != page {
                kept_docs.push(doc);
                kept_terms.push(terms);
            }
        }
        self.docs = kept_docs;
        self.doc_terms = kept_terms;

        for (i, text) in chunk_texts.iter().enumerate() {
            let tokens = tokenize(text);
            let mut terms: HashMap<String, u32> = HashMap::new();
            for t in &tokens {
                *terms.entry(t.clone()).or_insert(0) += 1;
            }
            self.docs.push(Bm25Doc {
                page: page.to_string(),
                stem: stem.to_string(),
                section: i,
                len: tokens.len() as u32,
            });
            self.doc_terms.push(terms);
        }

        self.rebuild_derived();
    }

    /// Drop chunks for pages no longer present in the vault. Returns how many
    /// chunks were dropped.
    pub fn prune(&mut self, existing: &HashSet<String>) -> usize {
        let before = self.docs.len();
        let mut kept_docs = Vec::with_capacity(self.docs.len());
        let mut kept_terms = Vec::with_capacity(self.doc_terms.len());
        for (doc, terms) in self.docs.drain(..).zip(self.doc_terms.drain(..)) {
            if existing.contains(&doc.page) {
                kept_docs.push(doc);
                kept_terms.push(terms);
            }
        }
        self.docs = kept_docs;
        self.doc_terms = kept_terms;
        self.rebuild_derived();
        before - self.docs.len()
    }

    /// Recompute `postings`, `df`, and `total_len` from `doc_terms`.
    fn rebuild_derived(&mut self) {
        self.postings.clear();
        self.df.clear();
        self.total_len = 0;
        for doc in &self.docs {
            self.total_len += doc.len as u64;
        }
        for (i, terms) in self.doc_terms.iter().enumerate() {
            for (term, tf) in terms {
                self.postings.entry(term.clone()).or_default().push((i, *tf));
                *self.df.entry(term.clone()).or_insert(0) += 1;
            }
        }
    }

    /// Top-`k` chunks by BM25 score against `query`.
    pub fn search(&self, query: &str, k: usize) -> Vec<Bm25Hit> {
        if self.docs.is_empty() {
            return Vec::new();
        }
        let n = self.docs.len() as f32;
        let avg_len = (self.total_len as f32 / n).max(1e-9);
        let query_terms: HashSet<String> = tokenize(query).into_iter().collect();

        let mut scores: HashMap<usize, f32> = HashMap::new();
        for term in &query_terms {
            let Some(postings) = self.postings.get(term) else {
                continue;
            };
            let df = *self.df.get(term).unwrap_or(&0) as f32;
            let idf = ((1.0 + (n - df + 0.5) / (df + 0.5)) as f32).ln();
            for &(doc_idx, tf) in postings {
                let doc_len = self.docs[doc_idx].len as f32;
                let tf = tf as f32;
                let denom = tf + K1 * (1.0 - B + B * doc_len / avg_len);
                let score = idf * (tf * (K1 + 1.0)) / denom;
                *scores.entry(doc_idx).or_insert(0.0) += score;
            }
        }

        let mut hits: Vec<Bm25Hit> = scores
            .into_iter()
            .map(|(doc_idx, score)| {
                let doc = &self.docs[doc_idx];
                Bm25Hit {
                    page: doc.page.clone(),
                    stem: doc.stem.clone(),
                    section: doc.section,
                    score,
                }
            })
            .collect();
        hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        hits.truncate(k);
        hits
    }
}

/// Chunk identity shared with the dense side: `"{page}#{section}"`.
fn chunk_id(page: &str, section: usize) -> String {
    format!("{page}#{section}")
}

/// Fuse a dense (`Hit`) and lexical (`Bm25Hit`) ranking via Reciprocal Rank
/// Fusion. Rank is each list's 0-based position; a chunk's fused score is the
/// sum of `1/(RRF_K + rank)` over every list it appears in, so a chunk both
/// arms agree on outranks one only one arm liked strongly. Returns `Hit` (the
/// dense type) carrying the fused score, so downstream code that already
/// consumes `Vec<Hit>` needs no changes.
pub fn rrf_fuse(dense: &[Hit], lexical: &[Bm25Hit], k: usize) -> Vec<Hit> {
    let mut scores: HashMap<String, f32> = HashMap::new();
    // Preserve enough of one representative hit per id to build the output.
    let mut rep: HashMap<String, Hit> = HashMap::new();

    for (rank, hit) in dense.iter().enumerate() {
        let id = chunk_id(&hit.page, hit.section);
        *scores.entry(id.clone()).or_insert(0.0) += 1.0 / (RRF_K + rank as f32);
        rep.entry(id).or_insert_with(|| hit.clone());
    }
    for (rank, hit) in lexical.iter().enumerate() {
        let id = chunk_id(&hit.page, hit.section);
        *scores.entry(id.clone()).or_insert(0.0) += 1.0 / (RRF_K + rank as f32);
        rep.entry(id).or_insert_with(|| Hit {
            page: hit.page.clone(),
            stem: hit.stem.clone(),
            section: hit.section,
            score: hit.score,
        });
    }

    let mut fused: Vec<Hit> = rep
        .into_iter()
        .map(|(id, mut h)| {
            h.score = scores[&id];
            h
        })
        .collect();
    // Fused score descending, then chunk identity ascending. The score alone
    // is not a total order — two chunks can tie exactly (e.g. each appearing
    // only at rank 0 of its own list) — and HashMap iteration order must not
    // leak into the result, since callers (retrieval-quality measurement,
    // Ask) depend on identical inputs producing an identical ranking.
    fused.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.page.cmp(&b.page))
            .then_with(|| a.section.cmp(&b.section))
    });
    fused.truncate(k);
    fused
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenize_latin_lowercases_and_splits() {
        assert_eq!(tokenize("QLoRA and PPO!"), vec!["qlora", "and", "ppo"]);
    }
    #[test]
    fn tokenize_cjk_emits_bigrams() {
        // 정책 최적화 -> 정책 | 최적, 적화
        assert_eq!(tokenize("정책 최적화"), vec!["정책", "최적", "적화"]);
    }
    #[test]
    fn tokenize_mixed_and_single_cjk() {
        assert_eq!(tokenize("KV 캐시"), vec!["kv", "캐시"]); // 캐시 is a 2-char run -> one bigram
        assert_eq!(tokenize("A"), vec!["a"]);
    }
    #[test]
    fn bm25_retrieves_exact_token_page() {
        let mut ix = Bm25Index::new();
        ix.upsert_page("wiki/rlhf.md", "rlhf", &["policy optimized with PPO".into()]);
        ix.upsert_page("wiki/lora.md", "lora", &["low rank adapters".into()]);
        let hits = ix.search("PPO", 5);
        assert_eq!(hits[0].stem, "rlhf");
    }
    #[test]
    fn bm25_upsert_replaces_not_appends() {
        let mut ix = Bm25Index::new();
        ix.upsert_page("p.md", "p", &["alpha alpha".into(), "beta".into()]);
        assert_eq!(ix.len(), 2);
        ix.upsert_page("p.md", "p", &["gamma".into()]);
        assert_eq!(ix.len(), 1);
        assert!(ix.search("alpha", 5).is_empty());
    }
    #[test]
    fn bm25_prune_drops_absent_pages() {
        let mut ix = Bm25Index::new();
        ix.upsert_page("a.md", "a", &["x".into()]);
        ix.upsert_page("b.md", "b", &["y".into()]);
        let keep: std::collections::HashSet<String> = ["a.md".to_string()].into_iter().collect();
        assert_eq!(ix.prune(&keep), 1);
        assert!(ix.search("y", 5).is_empty());
    }
    #[test]
    fn rrf_fuse_empty_lexical_preserves_dense_order() {
        use crate::vector_index::Hit;
        let dense = vec![
            Hit { page: "a.md".into(), stem: "a".into(), section: 0, score: 0.9 },
            Hit { page: "b.md".into(), stem: "b".into(), section: 0, score: 0.8 },
        ];
        let fused = rrf_fuse(&dense, &[], 10);
        assert_eq!(fused.iter().map(|h| h.stem.clone()).collect::<Vec<_>>(), vec!["a", "b"]);
    }
    #[test]
    fn rrf_fuse_lifts_agreed_chunk() {
        use crate::vector_index::Hit;
        let dense = vec![
            Hit { page: "a.md".into(), stem: "a".into(), section: 0, score: 0.9 },
            Hit { page: "b.md".into(), stem: "b".into(), section: 0, score: 0.8 },
        ];
        let lex = vec![
            Bm25Hit { page: "b.md".into(), stem: "b".into(), section: 0, score: 5.0 },
        ];
        let fused = rrf_fuse(&dense, &lex, 10);
        assert_eq!(fused[0].stem, "b"); // b in both lists -> higher RRF than a
    }
    #[test]
    fn rrf_fuse_breaks_ties_deterministically_by_chunk_identity() {
        use crate::vector_index::Hit;
        // Chunk "b.md#0" appears only in dense at rank 0, chunk "a.md#0" only
        // in lexical at rank 0 -> both score exactly 1/(RRF_K+0). The score
        // alone cannot order them; the tie-break (page asc, then section asc)
        // must, and must do so the same way every time.
        let dense = vec![Hit { page: "b.md".into(), stem: "b".into(), section: 0, score: 0.5 }];
        let lex = vec![Bm25Hit { page: "a.md".into(), stem: "a".into(), section: 0, score: 1.0 }];
        let expected = vec!["a.md".to_string(), "b.md".to_string()];
        for _ in 0..5 {
            let fused = rrf_fuse(&dense, &lex, 10);
            assert_eq!(
                fused.iter().map(|h| h.page.clone()).collect::<Vec<_>>(),
                expected,
                "tied chunks must order by page asc, then section asc, every run"
            );
        }
    }
}
