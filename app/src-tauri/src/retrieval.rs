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
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::vector_index::Hit;

#[cfg(test)]
#[path = "retrieval_cache_admission_tests.rs"]
mod cache_admission_tests;

/// Magic + format-version byte for the `.mxb` sidecar. Unlike `.mxv`
/// (`vector_index::MAGIC`), there is no embedding model baked into the
/// format: BM25 is purely lexical, so it survives an embed-model swap that
/// would otherwise wipe the vector index.
const MXB_MAGIC: &[u8; 4] = b"MXB1";
// v3: persist each chunk hash so a same-section body edit cannot return stale
// lexical evidence; rebuild old sidecars instead of trusting their positions.
const MXB_VERSION: u8 = 3;

/// BM25 term-frequency saturation parameter.
const K1: f32 = 1.2;
/// BM25 length-normalization parameter.
const B: f32 = 0.75;
/// Reciprocal Rank Fusion constant — dampens the influence of any single
/// list's exact rank so that agreement between lists (not one list's
/// confidence) drives the fused order.
// `pub(crate)` only so `pipeline`'s tests can assert that `fuse_chunk_matches`
// returns RRF rank scores while `dense_chunk_matches` returns cosines. Value
// and use are unchanged.
pub(crate) const RRF_K: f32 = 60.0;

/// Dense-cosine floor a chunk must clear to count as an answer at all; below
/// it Ask abstains instead of quoting the least-bad chunk. Mirror of
/// `RELEVANCE_FLOOR` in `app/src/lib/chat.ts` (the measurement and its
/// reasoning live there: e5-small-ko abstention probe, 0/15 off-corpus
/// accepts, 1/62 answerable rejected) — change both together. The Ask command
/// reports the value it used as `floor` so the UI never has to guess.
pub const RELEVANCE_FLOOR: f32 = 0.42;

/// Split text into search tokens. Script-aware and dependency-free:
/// Latin/ASCII-alphanumeric runs become one lowercased token (`"QLoRA"` ->
/// `"qlora"`), CJK runs (Hangul syllables/Jamo, CJK ideographs, Hiragana,
/// Katakana) are emitted as character bigrams since these scripts do not
/// whitespace-delimit words (a run of length 1 is emitted as-is). Everything
/// else is a boundary and is dropped.
pub fn tokenize(text: &str) -> Vec<String> {
    // NFC first: NFD Hangul (macOS filenames, some pasted text) is a jamo
    // sequence whose bigrams never match the NFC syllable bigrams the same
    // word produces when typed. Normalizing here covers both index and query
    // arms — they route through this one function.
    let text = crate::norm::nfc(text);
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

/// Korean particles (조사) worth stripping from the END of a query word,
/// longest first so `에서는` never half-strips as `는`. Deliberately short —
/// every entry is a common attachment whose removal leaves the content word
/// the writer indexed ("정책은" → "정책").
const KO_PARTICLES: [&str; 27] = [
    "에서는",
    "에서도",
    "으로는",
    "으로도",
    "까지는",
    "부터는",
    "에서",
    "에게",
    "한테",
    "부터",
    "까지",
    "조차",
    "마저",
    "처럼",
    "보다",
    "으로",
    "은",
    "는",
    "이",
    "가",
    "을",
    "를",
    "의",
    "에",
    "와",
    "과",
    "도",
];

/// QUERY-side only: strip one trailing particle from each all-Hangul word of
/// ≥3 syllables. Never applied to indexed text — the wikify experiment
/// already showed lexical noise on long Korean text hurts recall, so the
/// index keeps the writer's exact words and only the query normalizes toward
/// them. The ≥3-syllable guard (2 must remain) keeps real words intact:
/// "나이"/"높이" are 2 syllables and never touched, and a stripped remainder
/// is always ≥2 syllables so it still produces a bigram.
///
/// MEASURED AND REJECTED (2026-08-31, eval/BASELINE.md): with
/// `MYCO_KO_STRIP=1` the fused arm dropped across the board — MRR 0.917 →
/// 0.909, hit@1 83.9% → 82.3%, nDCG@10 0.933 → 0.927 on the 62-query
/// bilingual set. The bigram tokenizer already gives partial-match credit
/// ("정책은" shares the "정책" bigram), so stripping only removed signal.
/// NOT wired into the app; kept (with the harness's env hook) so the next
/// attempt reproduces the verdict instead of re-arguing it.
pub fn strip_ko_particles(query: &str) -> String {
    query
        .split_whitespace()
        .map(|w| {
            let all_hangul = w.chars().all(|c| matches!(c, '\u{AC00}'..='\u{D7A3}'));
            if !all_hangul || w.chars().count() < 3 {
                return w.to_string();
            }
            for p in KO_PARTICLES {
                if let Some(rest) = w.strip_suffix(p) {
                    if rest.chars().count() >= 2 {
                        return rest.to_string();
                    }
                }
            }
            w.to_string()
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Split `"quoted phrases"` out of a query. Returns (lowercased phrases,
/// query with the quote characters removed). An unclosed quote is treated
/// as plain text, not a phrase.
pub fn parse_phrases(query: &str) -> (Vec<String>, String) {
    let mut phrases = Vec::new();
    let mut rest = String::with_capacity(query.len());
    let mut buf = String::new();
    let mut in_quote = false;
    for c in query.chars() {
        match (c, in_quote) {
            ('"', false) => in_quote = true,
            ('"', true) => {
                let p = buf.trim();
                if !p.is_empty() {
                    // NFC so the phrase filter compares in the same form as
                    // reconstructed chunk text (chunk_page normalizes).
                    phrases.push(crate::norm::nfc(p).to_lowercase());
                    rest.push_str(p);
                    rest.push(' ');
                }
                buf.clear();
                in_quote = false;
            }
            (_, true) => buf.push(c),
            (_, false) => rest.push(c),
        }
    }
    if in_quote {
        rest.push_str(&buf); // unclosed: back into the plain query
    }
    let rest = rest.split_whitespace().collect::<Vec<_>>().join(" ");
    (phrases, rest)
}

/// True when `text` contains every phrase, case-insensitively.
pub fn text_matches_phrases(text: &str, phrases: &[String]) -> bool {
    if phrases.is_empty() {
        return true;
    }
    let lower = text.to_lowercase();
    phrases.iter().all(|p| lower.contains(p.as_str()))
}

/// Strong lexical evidence, never inferred from a positive BM25 score alone.
/// Explicit phrases, distinctive identifiers and complete substantive query
/// terms can ground a quote when an embedding model misses an exact name.
pub fn exact_lexical_match(query: &str, text: &str) -> bool {
    let (phrases, clean) = parse_phrases(query);
    if !phrases.is_empty() {
        return text_matches_phrases(text, &phrases);
    }
    let body = crate::norm::nfc(text).to_lowercase();
    let stop = [
        "what",
        "when",
        "where",
        "which",
        "why",
        "how",
        "the",
        "a",
        "an",
        "is",
        "are",
        "was",
        "were",
        "did",
        "do",
        "does",
        "my",
        "me",
        "i",
        "in",
        "on",
        "of",
        "to",
        "and",
        "for",
        "about",
        "show",
        "find",
        "tell",
        "this",
        "that",
        "it",
        "please",
        "지난",
        "어제",
        "오늘",
        "내가",
        "나는",
        "했던",
        "알려줘",
        "찾아줘",
        "무엇",
        "뭐야",
        "언제",
        "어디",
        "어떻게",
        "왜",
    ];
    let terms: Vec<String> = clean
        .split(|c: char| !c.is_alphanumeric() && !matches!(c, '_' | '-' | '/' | '.'))
        .map(|t| {
            t.trim_matches(|c: char| matches!(c, '-' | '/' | '.'))
                .to_lowercase()
        })
        .filter(|t| t.chars().count() >= 3 && !stop.contains(&t.as_str()))
        .collect();
    let identifier = |t: &str| {
        let acronym = t.chars().all(|c| c.is_ascii_alphanumeric())
            && clean.split_whitespace().any(|w| {
                w.trim_matches(|c: char| !c.is_alphanumeric())
                    .to_lowercase()
                    == t
                    && w.chars().filter(|c| c.is_ascii_uppercase()).count() >= 2
            });
        (t.chars().count() >= 4
            && (t.chars().any(|c| c.is_ascii_digit()) || t.contains(['_', '/', '.'])))
            || (t.chars().count() >= 3 && acronym)
    };
    let contains = |term: &str| {
        body.match_indices(term).any(|(i, _)| {
            // Latin IDs must match a whole token: PPO must not match PPOTrainer.
            if !term.is_ascii() {
                return true;
            }
            let left = body[..i].chars().next_back();
            let right = body[i + term.len()..].chars().next();
            !left.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
                && !right.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
        })
    };
    terms.iter().any(|t| identifier(t) && contains(t))
        || terms.len() >= 2 && terms.iter().all(|t| contains(t))
}

/// One indexed chunk: identity is `(page, section)`, mirroring
/// `VectorStore::Record` so lexical and dense hits refer to the same chunk.
#[derive(PartialEq, Eq)]
struct Bm25Doc {
    hash: u64,
    page: String,
    stem: String,
    section: usize,
    len: u32,
}

/// One occupied slot: a chunk plus its term->tf map. Slots live in a
/// `Vec<Option<Slot>>` whose indices are *stable* — see `Bm25Index`.
#[derive(PartialEq, Eq)]
struct Slot {
    doc: Bm25Doc,
    terms: HashMap<String, u32>,
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

/// In-memory BM25 index over vault chunks.
///
/// Doc slots are **stable**: a chunk keeps its slot index for as long as it is
/// indexed, and a removed chunk's slot is recycled rather than compacted away.
/// That is what lets `postings` (which keys on slot index) be maintained
/// *incrementally* on every mutation instead of recomputed from scratch —
/// compaction would renumber every surviving doc and invalidate every posting,
/// which is exactly why the original implementation had to rebuild all derived
/// state per `upsert_page` and made a per-page bootstrap loop O(pages²).
///
/// There is deliberately no "derived state is dirty" flag: `postings` and
/// `total_len` are corrected inside each mutation, so a caller cannot search a
/// stale index at all — `search` takes `&self` behind an `Arc`, so any deferred
/// rebuild would need interior mutability and could silently serve wrong
/// scores if a writer forgot to finish.
#[derive(Default)]
pub struct Bm25Index {
    /// Chunk slots. `None` is a recycled hole; `free` lists the holes.
    slots: Vec<Option<Slot>>,
    free: Vec<usize>,
    /// Occupied slot count — the BM25 `N`. Not `slots.len()`, which counts holes.
    n_live: usize,
    /// page -> its slot indices, so replacing a page is O(that page) rather
    /// than a scan of every slot.
    page_slots: HashMap<String, Vec<usize>>,
    /// term -> {slot idx -> tf}. A map (not a vec) so removing one doc's
    /// posting is O(1) rather than a scan of the term's whole posting list —
    /// with a vec, dropping a stop-word posting would be O(N) per doc and a
    /// full re-upsert of the vault would stay quadratic. Document frequency is
    /// `postings[term].len()`, so it needs no separate map.
    postings: HashMap<String, HashMap<usize, u32>>,
    total_len: u64,
}

impl Bm25Index {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.n_live == 0
    }

    /// Number of indexed chunks.
    pub fn len(&self) -> usize {
        self.n_live
    }

    /// Distinct pages currently indexed. Callers compute this once per batch
    /// (mirroring how `VectorStore::hashes_by_page` is snapshotted once) and
    /// check membership per page with `.contains`, rather than re-scanning
    /// `docs` from scratch for every page — this is what lets
    /// `embed_one_page` detect "BM25 doesn't have this page yet" (e.g. a
    /// bootstrap against an already-current dense store) without an O(n)
    /// scan per page.
    pub fn pages(&self) -> HashSet<String> {
        self.page_slots.keys().cloned().collect()
    }

    /// Borrow indexed identities for bounded read-only evidence scans.
    pub(crate) fn page_names(&self) -> impl Iterator<Item = &str> {
        self.page_slots.keys().map(String::as_str)
    }

    pub(crate) fn indexed_pages(&self) -> usize {
        self.page_slots.len()
    }

    pub fn chunk_hash(&self, page: &str, section: usize) -> Option<u64> {
        self.page_slots
            .get(page)?
            .iter()
            .filter_map(|&i| self.slots[i].as_ref())
            .find(|slot| slot.doc.section == section)
            .map(|slot| slot.doc.hash)
    }

    pub fn page_hashes(&self, page: &str) -> Option<Vec<u64>> {
        let slots = self.page_slots.get(page)?;
        let mut chunks: Vec<_> = slots
            .iter()
            .filter_map(|&i| self.slots[i].as_ref())
            .map(|s| (s.doc.section, s.doc.hash))
            .collect();
        // Recycled slots persist in physical order; source identity uses section order.
        chunks.sort_unstable_by_key(|(section, _)| *section);
        Some(chunks.into_iter().map(|(_, hash)| hash).collect())
    }

    /// Replace all chunks for one page with a fresh set, keeping the derived
    /// `postings`/`total_len` correct incrementally. Mirrors
    /// `VectorStore::upsert_page`'s replace-the-page shape so the two indexes
    /// stay in step chunk-for-chunk. Cost is O(this page's terms), independent
    /// of how much else is indexed — an empty-chunk call is therefore also the
    /// delete path (as the index updater uses it).
    pub fn upsert_page(&mut self, page: &str, stem: &str, chunk_texts: &[String]) {
        // Drop the page's existing chunks first, so a re-indexed page never
        // leaves stale ones behind.
        self.remove_page(page);

        let mut idxs = Vec::with_capacity(chunk_texts.len());
        for (i, text) in chunk_texts.iter().enumerate() {
            let tokens = tokenize(text);
            let mut terms: HashMap<String, u32> = HashMap::new();
            for t in &tokens {
                *terms.entry(t.clone()).or_insert(0) += 1;
            }
            let doc = Bm25Doc {
                hash: crate::embeddings::content_hash(text),
                page: page.to_string(),
                stem: stem.to_string(),
                section: i,
                len: tokens.len() as u32,
            };
            let idx = match self.free.pop() {
                Some(idx) => {
                    self.slots[idx] = Some(Slot { doc, terms });
                    idx
                }
                None => {
                    self.slots.push(Some(Slot { doc, terms }));
                    self.slots.len() - 1
                }
            };
            let slot = self.slots[idx].as_ref().expect("just filled");
            self.total_len += slot.doc.len as u64;
            self.n_live += 1;
            // Collected first, then inserted, to keep the borrow of `slot` out
            // of the `postings` mutation below.
            let terms: Vec<(String, u32)> =
                slot.terms.iter().map(|(t, tf)| (t.clone(), *tf)).collect();
            for (term, tf) in terms {
                self.postings.entry(term).or_default().insert(idx, tf);
            }
            idxs.push(idx);
        }
        if !idxs.is_empty() {
            self.page_slots.insert(page.to_string(), idxs);
        }
    }

    /// Drop one page's chunks and every trace of them in the derived state.
    /// O(that page's terms). No-op for a page that isn't indexed.
    fn remove_page(&mut self, page: &str) {
        let Some(idxs) = self.page_slots.remove(page) else {
            return;
        };
        for idx in idxs {
            let Some(slot) = self.slots[idx].take() else {
                continue;
            };
            self.total_len -= slot.doc.len as u64;
            self.n_live -= 1;
            for term in slot.terms.keys() {
                if let Some(p) = self.postings.get_mut(term) {
                    p.remove(&idx);
                    if p.is_empty() {
                        self.postings.remove(term);
                    }
                }
            }
            self.free.push(idx);
        }
    }

    /// Drop chunks for pages no longer present in the vault. Returns how many
    /// chunks were dropped.
    pub fn prune(&mut self, existing: &HashSet<String>) -> usize {
        let before = self.n_live;
        let gone: Vec<String> = self
            .page_slots
            .keys()
            .filter(|p| !existing.contains(*p))
            .cloned()
            .collect();
        for page in gone {
            self.remove_page(&page);
        }
        before - self.n_live
    }

    /// Recompute all derived state (`postings`, `page_slots`, `total_len`,
    /// `n_live`, `free`) from the occupied slots, preserving slot indices.
    /// Used by `decode` to derive what the format deliberately doesn't store —
    /// and by the tests as the reference the incremental maintenance above is
    /// checked against.
    fn rebuild_derived(&mut self) {
        self.postings.clear();
        self.page_slots.clear();
        self.free.clear();
        self.total_len = 0;
        self.n_live = 0;
        for idx in 0..self.slots.len() {
            let Some(slot) = self.slots[idx].as_ref() else {
                self.free.push(idx);
                continue;
            };
            self.total_len += slot.doc.len as u64;
            self.n_live += 1;
            let page = slot.doc.page.clone();
            let terms: Vec<(String, u32)> =
                slot.terms.iter().map(|(t, tf)| (t.clone(), *tf)).collect();
            self.page_slots.entry(page).or_default().push(idx);
            for (term, tf) in terms {
                self.postings.entry(term).or_default().insert(idx, tf);
            }
        }
    }

    /// Top-`k` chunks by BM25 score against `query`.
    pub fn search(&self, query: &str, k: usize) -> Vec<Bm25Hit> {
        self.search_where(query, k, |_, _| true)
    }

    /// Apply native scope/path predicates before Top-K truncation. Candidate
    /// scores are lexical hints, not semantic subject identity.
    pub(crate) fn search_where(
        &self,
        query: &str,
        k: usize,
        keep: impl Fn(&str, usize) -> bool,
    ) -> Vec<Bm25Hit> {
        if self.n_live == 0 || k == 0 {
            return Vec::new();
        }
        let n = self.n_live as f32;
        let avg_len = (self.total_len as f32 / n).max(1e-9);
        // Sorted + deduped (not a `HashSet`) so this list's iteration order is
        // fixed by term content alone, not by the process's random hash seed:
        // a document matching 3+ terms accumulates its score across multiple
        // `+=` below, and float addition is not associative, so hash-order
        // iteration could make a doc's score differ in its low bits between
        // processes — which would defeat the score-equality tie-break in
        // `rrf_fuse`/`Bm25Hit` ordering below.
        let mut query_terms: Vec<String> = tokenize(query).into_iter().collect();
        query_terms.sort_unstable();
        query_terms.dedup();

        let mut scores: HashMap<usize, f32> = HashMap::new();
        for term in &query_terms {
            let Some(postings) = self.postings.get(term) else {
                continue;
            };
            // Document frequency is the posting count for the term — there is
            // no separate `df` map to keep in sync.
            let df = postings.len() as f32;
            let idf = (1.0 + (n - df + 0.5) / (df + 0.5)).ln();
            // Iteration order over one term's postings does not affect any
            // score: each doc receives exactly ONE contribution per query
            // term, so a doc's accumulation order is fixed by the query-term
            // order alone, not by this inner loop.
            for (&doc_idx, &tf) in postings {
                let doc = self.slots[doc_idx]
                    .as_ref()
                    .expect("posting points at a live slot");
                if !keep(&doc.doc.page, doc.doc.section) {
                    continue;
                }
                let doc_len = doc.doc.len as f32;
                let tf = tf as f32;
                let denom = tf + K1 * (1.0 - B + B * doc_len / avg_len);
                let score = idf * (tf * (K1 + 1.0)) / denom;
                *scores.entry(doc_idx).or_insert(0.0) += score;
            }
        }

        let mut hits: Vec<Bm25Hit> = scores
            .into_iter()
            .map(|(doc_idx, score)| {
                let doc = &self.slots[doc_idx].as_ref().expect("live slot").doc;
                Bm25Hit {
                    page: doc.page.clone(),
                    stem: doc.stem.clone(),
                    section: doc.section,
                    score,
                }
            })
            .collect();
        // Score descending, then chunk identity ascending. Score alone is not
        // a total order — two chunks can score bit-identically — and
        // HashMap iteration order must not leak into the result, since
        // callers (RRF fusion, retrieval-quality measurement, Ask) depend on
        // identical inputs producing an identical ranking across processes.
        hits.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.page.cmp(&b.page))
                .then_with(|| a.section.cmp(&b.section))
        });
        hits.truncate(k);
        hits
    }

    /// Index file path for a given vault root, under `<app-data>/embeddings/`.
    /// Same settings dir and hash scheme as `VectorStore::path_for`, so the
    /// lexical and dense sidecars for one vault sit next to each other —
    /// just a different extension.
    pub fn path_for(vault_root: &str) -> Result<PathBuf, String> {
        crate::index_publication::read_path_for(vault_root, "mxb")
    }

    /// Read the index, or return an empty one. A missing, truncated, or
    /// corrupt file is never fatal: the index is derived state that a
    /// reindex rebuilds, so a bad read just degrades to "not indexed yet".
    pub fn load(path: &Path) -> Self {
        match Self::load_checked(path) {
            Ok(index) => index,
            Err(error) => {
                eprintln!("[bm25_index] compatibility read failed: {error}");
                Self::default()
            }
        }
    }

    /// Atomic temp-file-plus-rename save, mirroring `VectorStore::save`: a
    /// unique per-save temp name so two overlapping saves each publish a
    /// whole file rather than racing on a shared `.tmp` path.
    pub fn save(&self, path: &Path) -> Result<(), String> {
        if path.extension().and_then(|extension| extension.to_str()) == Some("mxp") {
            return Err("paired indexes must be saved through the index publisher".into());
        }
        let bytes = self.encode();
        let tmp = path.with_extension(format!("{}.mxb.tmp", unique_suffix()));
        std::fs::write(&tmp, &bytes).map_err(|e| format!("write index: {e}"))?;
        if let Err(e) = std::fs::rename(&tmp, path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("rename index: {e}"));
        }
        Ok(())
    }

    /// Authoritative publisher reads preserve existing read and decode failures.
    pub(crate) fn load_checked(path: &Path) -> Result<Self, String> {
        match crate::index_publication::read_snapshot(path)? {
            Some(snapshot) => decode_captured_index(path, &snapshot.bytes),
            None => Ok(Self::default()),
        }
    }

    /// Persisted live slots are ordered; free slots and term-map order are not.
    fn same_persisted_content(&self, other: &Self) -> bool {
        self.slots.iter().flatten().eq(other.slots.iter().flatten())
    }

    /// Serialize to the binary format. Only the per-doc identity (`page`,
    /// `stem`, `section`, `len`) and its term->tf map are persisted;
    /// `postings`/`df`/`total_len` are derived and rebuilt by `decode` via
    /// `rebuild_derived`, so there is nothing to keep in sync on disk.
    ///
    /// ```text
    /// "MXB1" | version u8 | n_docs u32
    /// per doc: page, stem (u32 len + utf8) | section u32 | len u32
    ///          | n_terms u32
    ///          per term: term (u32 len + utf8) | tf u32
    /// ```
    pub fn encode(&self) -> Vec<u8> {
        fn put_str(out: &mut Vec<u8>, s: &str) {
            out.extend_from_slice(&(s.len() as u32).to_le_bytes());
            out.extend_from_slice(s.as_bytes());
        }
        let mut out = Vec::with_capacity(16 + self.n_live * 64);
        out.extend_from_slice(MXB_MAGIC);
        out.push(MXB_VERSION);
        out.extend_from_slice(&(self.n_live as u32).to_le_bytes());
        // Live slots only, in slot order: recycled holes are not persisted, so
        // a reloaded index is always compact.
        for slot in self.slots.iter().flatten() {
            let (doc, terms) = (&slot.doc, &slot.terms);
            put_str(&mut out, &doc.page);
            put_str(&mut out, &doc.stem);
            out.extend_from_slice(&(doc.section as u32).to_le_bytes());
            out.extend_from_slice(&doc.hash.to_le_bytes());
            out.extend_from_slice(&doc.len.to_le_bytes());
            out.extend_from_slice(&(terms.len() as u32).to_le_bytes());
            for (term, tf) in terms {
                put_str(&mut out, term);
                out.extend_from_slice(&tf.to_le_bytes());
            }
        }
        out
    }

    /// Parse the binary format. Every read is bounds-checked and returns
    /// `None` on any inconsistency — a file on disk can be truncated,
    /// corrupted, or simply not this format, and none of that may panic.
    pub fn decode(bytes: &[u8]) -> Option<Self> {
        struct Cursor<'a> {
            b: &'a [u8],
            p: usize,
        }
        impl<'a> Cursor<'a> {
            fn take(&mut self, n: usize) -> Option<&'a [u8]> {
                let end = self.p.checked_add(n)?;
                let s = self.b.get(self.p..end)?;
                self.p = end;
                Some(s)
            }
            fn u32(&mut self) -> Option<u32> {
                Some(u32::from_le_bytes(self.take(4)?.try_into().ok()?))
            }
            fn u64(&mut self) -> Option<u64> {
                Some(u64::from_le_bytes(self.take(8)?.try_into().ok()?))
            }
            fn string(&mut self) -> Option<String> {
                let len = self.u32()? as usize;
                String::from_utf8(self.take(len)?.to_vec()).ok()
            }
        }

        let mut c = Cursor { b: bytes, p: 0 };
        if c.take(4)? != MXB_MAGIC {
            return None;
        }
        let version = *c.take(1)?.first()?;
        if version != MXB_VERSION {
            return None;
        }
        let n_docs = c.u32()? as usize;
        // Reject an impossible doc count before reserving for it, so a
        // corrupt length field cannot drive a huge allocation. Every doc
        // contributes at least 4 length-prefixed-empty-string fields plus
        // section/len/n_terms — 5 u32s minimum (20 bytes) even with empty
        // strings and no terms.
        if n_docs.checked_mul(20)? > bytes.len() {
            return None;
        }
        let mut slots = Vec::with_capacity(n_docs);
        for _ in 0..n_docs {
            let page = c.string()?;
            let stem = c.string()?;
            let section = c.u32()? as usize;
            let hash = c.u64()?;
            let len = c.u32()?;
            let n_terms = c.u32()? as usize;
            // Same guard, per-term: at least a 4-byte length prefix + 4-byte
            // tf per term (8 bytes minimum).
            if n_terms.checked_mul(8)? > bytes.len() {
                return None;
            }
            let mut terms = HashMap::with_capacity(n_terms);
            for _ in 0..n_terms {
                let term = c.string()?;
                let tf = c.u32()?;
                terms.insert(term, tf);
            }
            slots.push(Some(Slot {
                doc: Bm25Doc {
                    hash,
                    page,
                    stem,
                    section,
                    len,
                },
                terms,
            }));
        }

        let mut index = Bm25Index {
            slots,
            ..Default::default()
        };
        index.rebuild_derived();
        Some(index)
    }
}

/// A per-save token for the temp filename, mirroring
/// `vector_index::unique_suffix`: process id plus a monotonic counter, unique
/// between concurrent saves in this process and between processes.
fn unique_suffix() -> String {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{}-{n}", std::process::id())
}

fn decode_captured_index(path: &Path, bytes: &[u8]) -> Result<Bm25Index, String> {
    if path.extension().and_then(|extension| extension.to_str()) == Some("mxp") {
        crate::index_publication::decode(bytes)
            .map(|pair| pair.lexical)
            .ok_or_else(|| "published index pair is corrupt".into())
    } else {
        Bm25Index::decode(bytes).ok_or_else(|| "legacy lexical index is corrupt".into())
    }
}

struct CacheEntry {
    path: PathBuf,
    fingerprint: crate::index_publication::IndexFileRevision,
    index: Arc<Bm25Index>,
}

/// Replace the entry unless it already holds this exact revision of `path`.
/// Returns `None` when there is no index file to key freshness on.
fn ensure_fresh<'a>(
    slot: &'a mut Option<CacheEntry>,
    path: &Path,
) -> Result<Option<&'a mut CacheEntry>, String> {
    let Some(snapshot) = crate::index_publication::read_snapshot(path)? else {
        *slot = None;
        return Ok(None);
    };
    let hit = slot
        .as_ref()
        .is_some_and(|e| e.path == *path && e.fingerprint == snapshot.revision);
    if !hit {
        let index = decode_captured_index(path, &snapshot.bytes)?;
        if crate::index_publication::read_snapshot(path)?
            .map(|current| current.revision)
            .as_ref()
            != Some(&snapshot.revision)
        {
            return Err("lexical index revision changed during checked load".into());
        }
        *slot = Some(CacheEntry {
            path: path.to_path_buf(),
            fingerprint: snapshot.revision,
            index: Arc::new(index),
        });
    }
    Ok(slot.as_mut())
}

/// Keeps the parsed BM25 index in memory across commands, mirroring
/// `vector_index::VectorCache` exactly: without it, every lexical-search
/// command would re-read and re-parse the whole `.mxb` file from disk on
/// every call, the same cost `VectorCache` already eliminated for the dense
/// side. Freshness is keyed on captured file content rather than trusted,
/// so a rewrite from outside this cache is picked up instead of served stale.
#[derive(Clone, Default)]
pub struct Bm25Cache {
    inner: Arc<Mutex<Option<CacheEntry>>>,
}

impl Bm25Cache {
    /// Load the lexical index off-thread, including cache-lock and cold-parse waits.
    pub async fn get_async(&self, path: PathBuf) -> Result<Arc<Bm25Index>, String> {
        let cache = self.clone();
        tauri::async_runtime::spawn_blocking(move || cache.get_checked(&path))
            .await
            .map_err(|e| format!("BM25 cache load task failed: {e}"))?
    }

    /// Compatibility reader returns an uncached empty index after logging failures.
    pub fn get(&self, path: &Path) -> Arc<Bm25Index> {
        match self.get_checked(path) {
            Ok(index) => index,
            Err(error) => {
                eprintln!("[bm25_cache] compatibility read failed: {error}");
                Arc::new(Bm25Index::default())
            }
        }
    }

    /// Native readers preserve existing file, decode, and cache-lock failures.
    pub(crate) fn get_checked(&self, path: &Path) -> Result<Arc<Bm25Index>, String> {
        // Held across the load: the parse is the expensive thing being cached,
        // and serializing concurrent first-callers is better than having each
        // of them parse the same file.
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "BM25 cache lock poisoned".to_string())?;
        Ok(match ensure_fresh(&mut guard, path)? {
            Some(entry) => Arc::clone(&entry.index),
            // No file on disk: return an empty index *uncached*, since there is
            // nothing to key freshness on. Caching it would pin "empty" past the
            // first reindex.
            None => Arc::new(Bm25Index::default()),
        })
    }

    /// Compatibility adoption logs checked publication failures without replacing the cache.
    pub fn put(&self, path: &Path, index: Bm25Index) {
        if let Err(error) = self.put_checked(path, index) {
            eprintln!("[bm25_cache] compatibility adoption failed: {error}");
        }
    }

    /// Adopt only the parsed bytes whose content matches the supplied live slots.
    pub(crate) fn put_checked(&self, path: &Path, index: Bm25Index) -> Result<(), String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "BM25 cache lock poisoned".to_string())?;
        let snapshot = crate::index_publication::read_snapshot(path)?
            .ok_or_else(|| "published lexical index is missing".to_string())?;
        let persisted = decode_captured_index(path, &snapshot.bytes)?;
        if crate::index_publication::read_snapshot(path)?
            .map(|current| current.revision)
            .as_ref()
            != Some(&snapshot.revision)
        {
            return Err("lexical index revision changed during checked adoption".into());
        }
        if !index.same_persisted_content(&persisted) {
            return Err("supplied lexical index does not match the published file".into());
        }
        *guard = Some(CacheEntry {
            path: path.to_path_buf(),
            fingerprint: snapshot.revision,
            index: Arc::new(persisted),
        });
        Ok(())
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

/// Cap how many chunks any ONE page may occupy, then truncate to `k`.
///
/// Fusion ranks chunks, not documents, so a single long note whose sections all
/// match can take most of a top-k on its own. Measured on a real 14.5k-chunk
/// vault (`examples/corpus_mix_probe.rs`): one session transcript held three of
/// twelve slots, and on a Korean query two chunks of the same transcript
/// outranked the wiki page that actually answered it. The budget `k` exists to
/// buy DISTINCT sources; without a cap it buys near-duplicates.
///
/// Order-preserving: hits stay in fused order, the over-quota ones are dropped.
/// Applied AFTER fusion rather than inside it so `rrf_fuse` stays a pure fusion
/// primitive and the recorded retrieval baselines keep meaning what they did.
pub fn cap_per_page(hits: Vec<Hit>, max_per_page: usize, k: usize) -> Vec<Hit> {
    // A cap of 0 would silently return nothing; treat it as "no cap" instead of
    // making a bad config empty every answer.
    if max_per_page == 0 {
        return hits.into_iter().take(k).collect();
    }
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut out = Vec::with_capacity(k);
    for h in hits {
        let n = seen.entry(h.page.clone()).or_insert(0);
        if *n >= max_per_page {
            continue;
        }
        *n += 1;
        out.push(h);
        if out.len() == k {
            break;
        }
    }
    out
}

/// Which layer of the vault a page belongs to, derived from its path.
///
/// Rust port of `sourceTier()` in `app/src/lib/extractive.ts` — same folder
/// table, same `wiki/maps/` exception, same string names on the wire
/// (`serde` lowercase). The TS side keeps this as a citation label; here it
/// also drives ranking (`TierWeights`) and scoping (`Scope`). The table test
/// `source_tier_mirrors_the_ts_classifier` below lists the same paths as the
/// TS file's own cases: change one, change both.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Note,
    Map,
    Digest,
    Rollup,
    Monthly,
    Session,
    Source,
}

/// `page` is VAULT-RELATIVE (`wiki/x.md`, `sessions/2026-08/y.md`).
pub fn source_tier(page: &str) -> Tier {
    if page.starts_with("wiki/maps/") {
        return Tier::Map;
    }
    match page.split('/').next().unwrap_or("") {
        "daily" => Tier::Digest,
        "weekly" => Tier::Rollup,
        "monthly" => Tier::Monthly,
        "sessions" => Tier::Session,
        "raw" | "_inbox" | "ingest-reports" => Tier::Source,
        _ => Tier::Note,
    }
}

/// Multiplicative prior per tier, applied to the fused (RRF) score AFTER
/// fusion — `rrf_fuse` stays a pure rank-fusion primitive (see
/// `rrf_fuse_score_is_rank_based_not_a_confidence`), and the prior is the one
/// place the app says "a hand-written note outranks a transcript that scored
/// the same". Motivation, measured on the owner's vault: 4,451 indexed
/// chunks, 76 % from `sessions/`, 21 % wiki — 41 session files occupy 3.5x
/// the search surface of 100 wiki pages, and without this the two compete on
/// raw cosine alone.
///
/// Field names are the wire names (the Ask IPC arg `tierWeights` and the
/// mockup's sliders). `Monthly` has no knob of its own: it is the third
/// compression layer, the same kind of page as a weekly rollup, and takes
/// `rollup`. A missing field deserializes to its default.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct TierWeights {
    pub note: f32,
    pub map: f32,
    pub digest: f32,
    pub rollup: f32,
    pub session: f32,
    pub source: f32,
}

impl Default for TierWeights {
    fn default() -> Self {
        Self {
            note: 1.0,
            map: 0.9,
            digest: 0.8,
            rollup: 0.8,
            session: 0.6,
            source: 0.5,
        }
    }
}

impl TierWeights {
    /// Every tier at 1.0 — the prior as a no-op, i.e. the pre-prior ranking.
    pub const FLAT: TierWeights = TierWeights {
        note: 1.0,
        map: 1.0,
        digest: 1.0,
        rollup: 1.0,
        session: 1.0,
        source: 1.0,
    };

    pub fn prior(&self, tier: Tier) -> f32 {
        match tier {
            Tier::Note => self.note,
            Tier::Map => self.map,
            Tier::Digest => self.digest,
            Tier::Rollup | Tier::Monthly => self.rollup,
            Tier::Session => self.session,
            Tier::Source => self.source,
        }
    }
}

/// Multiply each hit's fused score by its tier's prior and re-sort. The sort
/// is stable and the input arrives in `rrf_fuse`'s deterministic order, so
/// two hits that still tie keep their fused order, and `TierWeights::FLAT`
/// leaves the list exactly as it was.
pub fn apply_tier_prior(hits: &mut [Hit], weights: &TierWeights) {
    for h in hits.iter_mut() {
        h.score *= weights.prior(source_tier(&h.page));
    }
    hits.sort_by(|a, b| b.score.total_cmp(&a.score));
}

/// Which part of the index a query is ranked against. Applied to BOTH arms
/// before their candidate-pool cut, so a narrow scope on a session-heavy
/// vault is not starved by it. Defined in tiers, not folders, so it and the
/// prior cannot disagree about what a page is:
///   `Wiki`     — everything the user or the distiller wrote: notes, maps,
///                daily/weekly/monthly digests. NOT sessions, NOT sources.
///   `Sessions` — transcripts only (`sessions/**`).
///   `All`      — the whole index (raw/ is never indexed anyway).
///   `Pages`    — notes and maps (`wiki/**`) only: a code plugin's recall.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    #[default]
    Wiki,
    Sessions,
    All,
    Pages,
}

impl Scope {
    pub fn keeps(self, page: &str) -> bool {
        match self {
            Scope::All => !page.starts_with("raw/") || page.starts_with("raw/conversations/"),
            Scope::Sessions => source_tier(page) == Tier::Session,
            Scope::Wiki => !matches!(source_tier(page), Tier::Session | Tier::Source),
            Scope::Pages => matches!(source_tier(page), Tier::Note | Tier::Map),
        }
    }
}

/// The MCP `search` tool takes the scope as a plain string.
impl std::str::FromStr for Scope {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "wiki" => Ok(Scope::Wiki),
            "sessions" => Ok(Scope::Sessions),
            "all" => Ok(Scope::All),
            other => Err(format!(
                "unknown scope: {other} — use wiki, sessions or all"
            )),
        }
    }
}

#[cfg(test)]
mod lexical_evidence_tests {
    use super::exact_lexical_match;
    #[test]
    fn only_distinctive_or_complete_lexical_evidence_is_grounded() {
        assert!(!exact_lexical_match(
            "what is the reward model",
            "the model was mentioned"
        ));
        assert!(!exact_lexical_match("PPO", "PPOTrainer is unrelated"));
        assert!(exact_lexical_match(
            "PPO",
            "The policy is updated with PPO."
        ));
        assert!(!exact_lexical_match(
            "ppo",
            "The policy is updated with PPO."
        ));
        assert!(exact_lexical_match(
            "where is ID_8F27",
            "The request ID_8F27 failed."
        ));
        assert!(exact_lexical_match(
            "what reward model",
            "the reward model decision"
        ));
        assert!(exact_lexical_match(
            "why \"keep exact quotes\"",
            "We keep exact quotes in memory."
        ));
        assert!(!exact_lexical_match(
            "\"keep exact quotes\"",
            "Keep unrelated quotes."
        ));
    }
    #[test]
    fn hashes_survive_lexical_codec_and_changed_bodies_replace_them() {
        let mut index = super::Bm25Index::new();
        index.upsert_page("wiki/a.md", "a", &["alpha".into()]);
        let reloaded = super::Bm25Index::decode(&index.encode()).unwrap();
        assert_eq!(
            reloaded.chunk_hash("wiki/a.md", 0),
            Some(crate::embeddings::content_hash("alpha"))
        );
        index.upsert_page("wiki/a.md", "a", &["beta".into()]);
        assert_ne!(
            index.chunk_hash("wiki/a.md", 0),
            reloaded.chunk_hash("wiki/a.md", 0)
        );
    }
}

#[cfg(test)]
mod tier_tests {
    use super::*;

    fn hit(page: &str, score: f32) -> Hit {
        Hit {
            page: page.into(),
            stem: page.into(),
            section: 0,
            score,
        }
    }

    // Mirrors `sourceTier()`'s cases in app/src/lib/extractive.ts — the two
    // classifiers must agree path for path.
    #[test]
    fn source_tier_mirrors_the_ts_classifier() {
        let cases = [
            ("wiki/scaling-laws.md", Tier::Note),
            ("wiki/concepts/attention.md", Tier::Note),
            ("wiki/maps/scaling.md", Tier::Map),
            ("wiki/map-scaling.md", Tier::Note), // only the maps/ FOLDER is a map
            ("daily/2026-08-21.md", Tier::Digest),
            ("daily/archive/2026-W34/2026-08-21.md", Tier::Digest),
            ("weekly/2026-W34.md", Tier::Rollup),
            ("monthly/2026-08.md", Tier::Monthly),
            ("sessions/2026-08/codex-019fdc04.md", Tier::Session),
            ("sessions/archive/2026-08/codex-019f9a12.md", Tier::Session),
            ("raw/kaplan-2020-scaling.md", Tier::Source),
            ("raw/archive/2026-07/hoffmann.md", Tier::Source),
            ("_inbox/clip.md", Tier::Source),
            ("ingest-reports/2026-08-21.md", Tier::Source),
            ("profile.md", Tier::Note), // no folder: the TS default arm
            ("ko-corpus/ko-rag.md", Tier::Note),
        ];
        for (page, want) in cases {
            assert_eq!(source_tier(page), want, "{page}");
        }
    }

    #[test]
    fn tier_names_on_the_wire_are_the_ts_source_tier_strings() {
        for (tier, name) in [
            (Tier::Note, "\"note\""),
            (Tier::Map, "\"map\""),
            (Tier::Digest, "\"digest\""),
            (Tier::Rollup, "\"rollup\""),
            (Tier::Monthly, "\"monthly\""),
            (Tier::Session, "\"session\""),
            (Tier::Source, "\"source\""),
        ] {
            assert_eq!(serde_json::to_string(&tier).unwrap(), name);
        }
        assert_eq!(serde_json::to_string(&Scope::Wiki).unwrap(), "\"wiki\"");
        assert_eq!(
            serde_json::from_str::<Scope>("\"sessions\"").unwrap(),
            Scope::Sessions
        );
        // A partial weights object fills the rest from the defaults.
        let w: TierWeights = serde_json::from_str("{\"session\":1.0}").unwrap();
        assert_eq!(w.session, 1.0);
        assert_eq!(w.note, 1.0);
        assert_eq!(w.source, 0.5);
    }

    // The mockup's claim: a transcript that fuses at rank 2 lands below the
    // wiki notes with the default prior, and stays put with a flat one.
    #[test]
    fn default_prior_drops_a_session_below_the_notes_flat_prior_does_not() {
        let fused = || {
            vec![
                hit("wiki/scaling-laws.md", 0.0328),
                hit("sessions/2026-08/codex-019fdc04.md", 0.0325),
                hit("wiki/compute-budget.md", 0.0320),
                hit("wiki/analysis-scaling-vs-data.md", 0.0315),
                hit("wiki/maps/scaling.md", 0.0164),
                hit("daily/2026-08-21.md", 0.0161),
            ]
        };
        let mut hits = fused();
        apply_tier_prior(&mut hits, &TierWeights::default());
        let order: Vec<&str> = hits.iter().map(|h| h.page.as_str()).collect();
        assert_eq!(
            order,
            vec![
                "wiki/scaling-laws.md",
                "wiki/compute-budget.md",
                "wiki/analysis-scaling-vs-data.md",
                "sessions/2026-08/codex-019fdc04.md",
                "wiki/maps/scaling.md",
                "daily/2026-08-21.md",
            ]
        );
        assert!((hits[3].score - 0.0325 * 0.6).abs() < 1e-6);

        let mut flat = fused();
        apply_tier_prior(&mut flat, &TierWeights::FLAT);
        assert_eq!(
            flat.iter().map(|h| h.page.as_str()).collect::<Vec<_>>(),
            fused().iter().map(|h| h.page.as_str()).collect::<Vec<_>>(),
            "all-1.0 weights must not move anything"
        );
        assert_eq!(flat[1].page, "sessions/2026-08/codex-019fdc04.md");
    }

    #[test]
    fn a_session_far_ahead_on_fused_score_keeps_its_place() {
        // The prior is a tilt, not a filter: 0.6 x a clear winner still wins.
        let mut hits = vec![
            hit("sessions/2026-08/a.md", 0.0328),
            hit("wiki/b.md", 0.0164),
        ];
        apply_tier_prior(&mut hits, &TierWeights::default());
        assert_eq!(hits[0].page, "sessions/2026-08/a.md");
    }

    #[test]
    fn scope_is_defined_by_tier() {
        let wiki = [
            "wiki/a.md",
            "wiki/maps/m.md",
            "daily/2026-08-21.md",
            "weekly/2026-W34.md",
            "monthly/2026-08.md",
        ];
        let sessions = ["sessions/2026-08/a.md", "sessions/archive/2026-07/b.md"];
        let sources = ["raw/conversations/fixture/x.md", "_inbox/y.md"];
        for p in wiki {
            assert!(Scope::Wiki.keeps(p), "{p}");
            assert!(!Scope::Sessions.keeps(p), "{p}");
            assert!(Scope::All.keeps(p), "{p}");
        }
        for p in sessions {
            assert!(!Scope::Wiki.keeps(p), "{p}");
            assert!(Scope::Sessions.keeps(p), "{p}");
            assert!(Scope::All.keeps(p), "{p}");
        }
        for p in sources {
            assert!(!Scope::Wiki.keeps(p), "{p}");
            assert!(!Scope::Sessions.keeps(p), "{p}");
            assert!(Scope::All.keeps(p), "{p}");
        }
        assert!(!Scope::All.keeps("raw/x.md"));
        assert!(!Scope::All.keeps("raw/conversations-other/x.md"));
        assert_eq!(Scope::default(), Scope::Wiki);
        assert_eq!("all".parse::<Scope>(), Ok(Scope::All));
        assert!("everything".parse::<Scope>().is_err());
    }

    /// A plugin's recall: wiki/ pages only, so digests that rank first
    /// cannot use up its `k` before the app drops them.
    #[test]
    fn pages_scope_keeps_notes_and_maps_only() {
        for p in ["wiki/a.md", "wiki/maps/m.md"] {
            assert!(Scope::Pages.keeps(p), "{p}");
        }
        for p in [
            "daily/2026-08-21.md",
            "weekly/2026-W34.md",
            "monthly/2026-08.md",
            "sessions/2026-08/a.md",
            "raw/x.md",
        ] {
            assert!(!Scope::Pages.keeps(p), "{p}");
        }
        assert_eq!(
            serde_json::from_str::<Scope>("\"pages\"").unwrap(),
            Scope::Pages
        );
    }
}

#[cfg(test)]
mod cap_tests {
    use super::*;

    fn hit(page: &str, section: usize, score: f32) -> Hit {
        Hit {
            page: page.into(),
            stem: page.into(),
            section,
            score,
        }
    }

    #[test]
    fn keeps_fused_order_while_dropping_a_page_over_quota() {
        let hits = vec![
            hit("sessions/a.md", 0, 0.9),
            hit("sessions/a.md", 1, 0.8),
            hit("sessions/a.md", 2, 0.7),
            hit("wiki/self-attention.md", 0, 0.6),
        ];
        let out = cap_per_page(hits, 2, 4);
        assert_eq!(
            out.iter()
                .map(|h| (h.page.as_str(), h.section))
                .collect::<Vec<_>>(),
            vec![
                ("sessions/a.md", 0),
                ("sessions/a.md", 1),
                ("wiki/self-attention.md", 0)
            ],
        );
    }

    #[test]
    fn promotes_a_distinct_page_into_the_slot_a_duplicate_would_have_taken() {
        // The point of the cap: within the same k, a third source appears.
        let hits = vec![
            hit("sessions/a.md", 0, 0.9),
            hit("sessions/a.md", 1, 0.8),
            hit("wiki/b.md", 0, 0.5),
        ];
        assert_eq!(cap_per_page(hits, 1, 2).len(), 2);
    }

    #[test]
    fn truncates_to_k_and_never_exceeds_it() {
        let hits: Vec<Hit> = (0..10).map(|i| hit(&format!("p{i}.md"), 0, 1.0)).collect();
        assert_eq!(cap_per_page(hits, 2, 3).len(), 3);
    }

    #[test]
    fn a_zero_cap_means_no_cap_rather_than_an_empty_answer() {
        let hits = vec![hit("a.md", 0, 0.9), hit("a.md", 1, 0.8)];
        assert_eq!(cap_per_page(hits, 0, 5).len(), 2);
    }

    #[test]
    fn a_shorter_list_than_k_is_returned_whole() {
        let hits = vec![hit("a.md", 0, 0.9), hit("b.md", 0, 0.8)];
        assert_eq!(cap_per_page(hits, 2, 12).len(), 2);
    }
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
    fn particle_strip_takes_one_trailing_josa_and_guards_short_words() {
        assert_eq!(strip_ko_particles("정책은 최적화를"), "정책 최적화");
        assert_eq!(strip_ko_particles("회의에서는 결정"), "회의 결정");
        // 2-syllable words never touched: 나이/높이 are words, not stems+josa.
        assert_eq!(strip_ko_particles("나이 높이"), "나이 높이");
        // Mixed-script and Latin words pass through untouched.
        assert_eq!(strip_ko_particles("KV캐시는 rrf"), "KV캐시는 rrf");
        // Longest particle wins — no half-strip of 에서는 into ...에서 + 는.
        assert_eq!(strip_ko_particles("서울에서는"), "서울");
    }

    #[test]
    fn tokenize_nfd_hangul_matches_nfc() {
        // "정책" decomposed to jamo, as macOS file APIs hand it back. Without
        // NFC the jamo run bigrams to garbage that never matches typed text.
        let nfd = "\u{110C}\u{1165}\u{11BC}\u{110E}\u{1162}\u{11A8}";
        assert_eq!(tokenize(nfd), tokenize("정책"));
    }
    #[test]
    fn parse_phrases_extracts_quoted_and_keeps_remainder() {
        let (phrases, rest) = parse_phrases(r#"deadlock "connection reset by peer" tokio"#);
        assert_eq!(phrases, vec!["connection reset by peer"]);
        assert_eq!(rest, "deadlock connection reset by peer tokio");
    }
    #[test]
    fn parse_phrases_handles_no_quotes_and_unclosed_quote() {
        assert_eq!(parse_phrases("plain query").0.len(), 0);
        let (phrases, rest) = parse_phrases(r#"start "unclosed tail"#);
        assert!(phrases.is_empty(), "unclosed quote is not a phrase");
        assert_eq!(rest, "start unclosed tail");
    }
    #[test]
    fn text_matches_phrases_is_case_insensitive_and_conjunctive() {
        let text = "Retry loop hit Connection Reset By Peer after 30s.";
        assert!(text_matches_phrases(
            text,
            &["connection reset by peer".into()]
        ));
        assert!(!text_matches_phrases(
            text,
            &["connection reset by peer".into(), "kernel panic".into()]
        ));
        assert!(text_matches_phrases(text, &[]));
    }
    #[test]
    fn bm25_retrieves_exact_token_page() {
        let mut ix = Bm25Index::new();
        ix.upsert_page(
            "wiki/rlhf.md",
            "rlhf",
            &["policy optimized with PPO".into()],
        );
        ix.upsert_page("wiki/lora.md", "lora", &["low rank adapters".into()]);
        let hits = ix.search("PPO", 5);
        assert_eq!(hits[0].stem, "rlhf");
    }
    #[test]
    fn bm25_search_breaks_ties_by_page_then_section_not_hashmap_order() {
        // Two docs in different pages, same single query term, equal doc
        // length -> bit-identical BM25 scores. Without a tie-break on
        // document identity, relative order depends on HashMap iteration
        // order and flips between processes (the bug this test pins).
        let mut ix = Bm25Index::new();
        ix.upsert_page("wiki/zzz.md", "zzz", &["qlora".into()]);
        ix.upsert_page("wiki/aaa.md", "aaa", &["qlora".into()]);
        let hits = ix.search("qlora", 5);
        assert_eq!(hits.len(), 2);
        assert_eq!(
            hits[0].score, hits[1].score,
            "scores must be bit-identical for this test to pin the tie-break"
        );
        // Deterministic total order: score desc, then page asc, then section asc.
        assert_eq!(hits[0].page, "wiki/aaa.md");
        assert_eq!(hits[1].page, "wiki/zzz.md");
        // Repeating in-process must be stable too (necessary but not sufficient
        // on its own — see the explicit page assertions above).
        for _ in 0..20 {
            let repeat = ix.search("qlora", 5);
            assert_eq!(repeat[0].page, "wiki/aaa.md");
            assert_eq!(repeat[1].page, "wiki/zzz.md");
        }
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
    /// Corpus used by the two equivalence tests below: enough pages, chunks,
    /// shared terms (so `df` matters) and scripts to make a wrong `postings` /
    /// `total_len` / `n_live` show up in the scores.
    fn equivalence_corpus() -> Vec<(String, String, Vec<String>)> {
        (0..40)
            .map(|i| {
                let page = format!("wiki/p{i}.md");
                let stem = format!("p{i}");
                let chunks = vec![
                    format!("the policy is optimized with PPO and a reward model page{i}"),
                    format!("정책 최적화 그리고 보상 모델 {i} shared common tokens here"),
                    format!("rare{i} token appears only on this page along with common words"),
                ];
                (page, stem, chunks)
            })
            .collect()
    }

    const EQUIVALENCE_QUERIES: [&str; 6] = [
        "PPO",
        "reward model",
        "정책 최적화",
        "rare7",
        "the common words page3",
        "nothing matches this query at all",
    ];

    fn ranked(ix: &Bm25Index, q: &str) -> Vec<(String, usize, u32)> {
        ix.search(q, 40)
            .into_iter()
            .map(|h| (h.page, h.section, h.score.to_bits()))
            .collect()
    }

    #[test]
    fn bm25_incremental_derived_state_matches_a_full_rebuild() {
        // `upsert_page`/`prune` maintain postings/total_len/n_live/page_slots
        // incrementally instead of recomputing them (the O(pages²) fix). This
        // pins the equivalence: after churn — inserts, replacements that
        // change a page's chunk count, deletes, a prune, and re-inserts that
        // recycle freed slots — the incrementally maintained state must score
        // BIT-identically to `rebuild_derived`'s from-scratch recomputation.
        let mut ix = Bm25Index::new();
        for (page, stem, chunks) in equivalence_corpus() {
            ix.upsert_page(&page, &stem, &chunks);
        }
        // Replace a page with fewer chunks, delete two, prune a third away,
        // then add a fresh page that must land in the recycled slots.
        ix.upsert_page("wiki/p5.md", "p5", &["the policy only now".to_string()]);
        ix.upsert_page("wiki/p9.md", "p9", &[]); // delete path
        ix.upsert_page("wiki/p11.md", "p11", &[]);
        let keep: HashSet<String> = (0..40)
            .filter(|i| *i != 13)
            .map(|i| format!("wiki/p{i}.md"))
            .collect();
        ix.prune(&keep);
        ix.upsert_page(
            "wiki/late.md",
            "late",
            &[
                "a late page with PPO and 정책 최적화 and rare7".to_string(),
                "second chunk".to_string(),
            ],
        );

        let before: Vec<Vec<_>> = EQUIVALENCE_QUERIES.iter().map(|q| ranked(&ix, q)).collect();
        let (len_before, pages_before) = (ix.len(), ix.pages());
        ix.rebuild_derived();
        let after: Vec<Vec<_>> = EQUIVALENCE_QUERIES.iter().map(|q| ranked(&ix, q)).collect();

        assert_eq!(ix.len(), len_before);
        assert_eq!(ix.pages(), pages_before);
        for (qi, q) in EQUIVALENCE_QUERIES.iter().enumerate() {
            assert_eq!(
                before[qi], after[qi],
                "query {q:?} differs from a full rebuild"
            );
        }
    }

    #[test]
    fn bm25_same_corpus_built_two_ways_searches_identically() {
        // Search output must depend only on the index's CONTENT, never on the
        // order the pages were upserted in or on how many intermediate states
        // it passed through — otherwise slot recycling would leak into scores.
        let corpus = equivalence_corpus();

        let mut a = Bm25Index::new();
        for (page, stem, chunks) in &corpus {
            a.upsert_page(page, stem, chunks);
        }

        let mut b = Bm25Index::new();
        // Reverse order, with a throwaway page upserted and deleted between
        // every real one so `b` is riddled with recycled slots.
        for (i, (page, stem, chunks)) in corpus.iter().enumerate().rev() {
            b.upsert_page(
                "wiki/scratch.md",
                "scratch",
                &[format!("scratch {i} PPO 정책")],
            );
            b.upsert_page(page, stem, chunks);
            b.upsert_page("wiki/scratch.md", "scratch", &[]);
        }

        assert_eq!(a.len(), b.len());
        assert_eq!(a.pages(), b.pages());
        for q in EQUIVALENCE_QUERIES {
            assert_eq!(
                ranked(&a, q),
                ranked(&b, q),
                "query {q:?} depends on build order"
            );
        }
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
            Hit {
                page: "a.md".into(),
                stem: "a".into(),
                section: 0,
                score: 0.9,
            },
            Hit {
                page: "b.md".into(),
                stem: "b".into(),
                section: 0,
                score: 0.8,
            },
        ];
        let fused = rrf_fuse(&dense, &[], 10);
        assert_eq!(
            fused.iter().map(|h| h.stem.clone()).collect::<Vec<_>>(),
            vec!["a", "b"]
        );
    }
    #[test]
    fn rrf_fuse_score_is_rank_based_not_a_confidence() {
        use crate::vector_index::Hit;
        // The reason `semantic_search` carries the dense cosine separately: RRF
        // scores a rank, so a top hit scores identically whether its cosine was
        // 0.95 (a real answer) or 0.31 (nothing in the vault matched). Anything
        // thresholding or displaying confidence must use the cosine instead —
        // this test pins the property so that never silently changes.
        let strong = vec![Hit {
            page: "a.md".into(),
            stem: "a".into(),
            section: 0,
            score: 0.95,
        }];
        let weak = vec![Hit {
            page: "a.md".into(),
            stem: "a".into(),
            section: 0,
            score: 0.31,
        }];
        let fused_strong = rrf_fuse(&strong, &[], 10);
        let fused_weak = rrf_fuse(&weak, &[], 10);
        assert_eq!(fused_strong[0].score, fused_weak[0].score);
    }
    #[test]
    fn rrf_fuse_lifts_agreed_chunk() {
        use crate::vector_index::Hit;
        let dense = vec![
            Hit {
                page: "a.md".into(),
                stem: "a".into(),
                section: 0,
                score: 0.9,
            },
            Hit {
                page: "b.md".into(),
                stem: "b".into(),
                section: 0,
                score: 0.8,
            },
        ];
        let lex = vec![Bm25Hit {
            page: "b.md".into(),
            stem: "b".into(),
            section: 0,
            score: 5.0,
        }];
        let fused = rrf_fuse(&dense, &lex, 10);
        assert_eq!(fused[0].stem, "b"); // b in both lists -> higher RRF than a
    }
    #[test]
    fn mxb_roundtrip_preserves_search() {
        let mut ix = Bm25Index::new();
        ix.upsert_page(
            "wiki/rlhf.md",
            "rlhf",
            &["policy optimized with PPO".into()],
        );
        let bytes = ix.encode();
        let ix2 = Bm25Index::decode(&bytes).expect("decode");
        assert_eq!(ix2.search("PPO", 5)[0].stem, "rlhf");
    }
    #[test]
    fn mxb_load_missing_is_empty() {
        let ix = Bm25Index::load(std::path::Path::new("/tmp/memex-nonexistent.mxb"));
        assert!(ix.is_empty());
    }
    #[test]
    fn mxb_roundtrip_multi_page_preserves_scoring() {
        // A single-doc round trip can pass while df rebuilding is broken —
        // this exercises multiple pages/chunks so document frequency actually
        // has to be reconstructed correctly.
        let mut ix = Bm25Index::new();
        ix.upsert_page(
            "wiki/rlhf.md",
            "rlhf",
            &[
                "policy optimized with PPO".into(),
                "reward model training".into(),
            ],
        );
        ix.upsert_page("wiki/lora.md", "lora", &["low rank adapters".into()]);
        ix.upsert_page(
            "wiki/common.md",
            "common",
            &["policy gradient methods are common".into()],
        );
        let before = ix.search("policy", 10);
        let bytes = ix.encode();
        let after = Bm25Index::decode(&bytes)
            .expect("decode")
            .search("policy", 10);
        assert_eq!(before.len(), after.len());
        for (b, a) in before.iter().zip(after.iter()) {
            assert_eq!(b.page, a.page);
            assert_eq!(b.section, a.section);
            assert!(
                (b.score - a.score).abs() < 1e-6,
                "{} vs {}",
                b.score,
                a.score
            );
        }
        assert_eq!(after[0].stem, "rlhf");
    }

    #[test]
    fn mxb_recycled_slots_preserve_page_hash_section_order_after_persistence() {
        let pages = [
            (
                "wiki/synthetic-a.md",
                vec![
                    "synthetic alpha first section".to_string(),
                    "synthetic beta second section".to_string(),
                    "synthetic gamma third section".to_string(),
                ],
            ),
            (
                "wiki/synthetic-b.md",
                vec![
                    "synthetic delta first section".to_string(),
                    "synthetic epsilon second section".to_string(),
                ],
            ),
        ];
        let mut index = Bm25Index::new();
        for (page, chunks) in &pages {
            index.upsert_page(page, "Synthetic", chunks);
        }
        // Replacing each page reuses its freed slots in reverse physical order.
        for (page, chunks) in &pages {
            index.upsert_page(page, "Synthetic", chunks);
            let hashes: Vec<_> = chunks
                .iter()
                .map(|c| crate::embeddings::content_hash(c))
                .collect();
            assert!(index.page_hashes(page).as_ref() == Some(&hashes));
        }
        let before = ranked(&index, "synthetic");
        let decoded = Bm25Index::decode(&index.encode()).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("synthetic.mxb");
        index.save(&path).unwrap();
        let reloaded = Bm25Index::load(&path);

        for persisted in [&decoded, &reloaded] {
            assert_eq!(ranked(persisted, "synthetic"), before);
            for (page, chunks) in &pages {
                let hashes: Vec<_> = chunks
                    .iter()
                    .map(|c| crate::embeddings::content_hash(c))
                    .collect();
                for (section, hash) in hashes.iter().enumerate() {
                    assert!(
                        persisted.chunk_hash(page, section) == Some(*hash),
                        "individual synthetic chunk hashes must remain current"
                    );
                }
                assert!(
                    persisted.page_hashes(page).as_ref() == Some(&hashes),
                    "page hash arrays must preserve section order after persistence"
                );
            }
        }
    }

    #[test]
    fn mxb_decode_rejects_corrupt_input_without_panicking() {
        assert!(Bm25Index::decode(b"").is_none());
        assert!(Bm25Index::decode(b"XXXX").is_none()); // bad magic
        assert!(Bm25Index::decode(b"MXB1").is_none()); // header cut short beyond magic+version

        let mut ix = Bm25Index::new();
        ix.upsert_page("p.md", "p", &["alpha beta".into()]);
        let good = ix.encode();
        assert!(Bm25Index::decode(&good).is_some());
        for cut in 1..good.len() {
            assert!(
                Bm25Index::decode(&good[..cut]).is_none(),
                "truncation at {cut} must not decode"
            );
        }
    }
    #[test]
    fn mxb_decode_rejects_garbage_bytes() {
        assert!(Bm25Index::decode(b"not an index at all, just garbage bytes here").is_none());
    }
    #[test]
    fn mxb_decode_rejects_huge_length_prefix_without_huge_alloc() {
        let mut ix = Bm25Index::new();
        ix.upsert_page("p.md", "p", &["alpha beta".into()]);
        let good = ix.encode();
        // Corrupt the doc-count field (right after magic+version) to a huge
        // value; must be rejected rather than driving a giant allocation.
        let mut bogus = good.clone();
        bogus[5..9].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(Bm25Index::decode(&bogus).is_none());
    }
    #[test]
    fn mxb_load_falls_back_to_empty_for_unreadable_index() {
        let dir = std::env::temp_dir().join(format!("memex-bm25-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("idx.mxb");
        std::fs::write(&path, b"not an index at all").unwrap();
        assert!(Bm25Index::load(&path).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }
    #[test]
    fn mxb_save_load_roundtrip_via_files() {
        let dir = std::env::temp_dir().join(format!("memex-bm25-test-save-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("idx.mxb");
        let mut ix = Bm25Index::new();
        ix.upsert_page(
            "wiki/rlhf.md",
            "rlhf",
            &["policy optimized with PPO".into()],
        );
        ix.save(&path).unwrap();
        let loaded = Bm25Index::load(&path);
        assert_eq!(loaded.search("PPO", 5)[0].stem, "rlhf");
        // Path scheme mirrors VectorStore's: same settings dir, .mxb extension.
        // path_for() resolves (and CREATES) the app-data dir, so it must run
        // against an isolated one — unisolated it migrated and wrote to the
        // developer's real ~/Library/Application Support.
        crate::settings::test_support::with_isolated_data("bm25-path-for", |data| {
            let p2 = Bm25Index::path_for("some/vault/root").unwrap();
            assert_eq!(p2.extension().unwrap(), "mxb");
            assert!(p2.starts_with(data), "index path escaped the test data dir");
        });
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn async_bm25_cache_does_not_stall_heartbeat() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("idx.mxb");
        let mut index = Bm25Index::new();
        index.upsert_page("wiki/a.md", "a", &["synthetic policy PPO".into()]);
        index.save(&path).unwrap();
        let cache = Arc::new(Bm25Cache::default());
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let worker_cache = Arc::clone(&cache);
        let holder = std::thread::spawn(move || {
            let _guard = worker_cache.inner.lock().unwrap();
            held_tx.send(()).unwrap();
            // A broken inline loader eventually returns, so red never hangs.
            release_rx
                .recv_timeout(std::time::Duration::from_secs(1))
                .is_ok()
        });
        held_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let load = cache.get_async(path);
        let heartbeat = async {
            tokio::task::yield_now().await;
            release_tx.send(()).unwrap();
        };
        tokio::pin!(load, heartbeat);
        let heartbeat_first = tokio::select! {
            biased;
            loaded = &mut load => {
                assert_eq!(loaded.unwrap().len(), 1);
                false
            },
            _ = &mut heartbeat => true,
        };
        if heartbeat_first {
            assert_eq!(load.await.unwrap().len(), 1);
        }
        let released_by_heartbeat = holder.join().unwrap();
        assert!(
            heartbeat_first,
            "BM25 cache blocked the current-thread heartbeat"
        );
        assert!(
            released_by_heartbeat,
            "BM25 cache lock outlived the heartbeat"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn async_bm25_cache_cold_callers_share_parse_and_notice_rewrite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("idx.mxb");
        let cache = Bm25Cache::default();
        assert!(cache.get_async(path.clone()).await.unwrap().is_empty());
        let mut index = Bm25Index::new();
        index.upsert_page("wiki/a.md", "a", &["synthetic policy PPO".into()]);
        index.save(&path).unwrap();
        let (first, second) =
            tokio::join!(cache.get_async(path.clone()), cache.get_async(path.clone()));
        let (first, second) = (first.unwrap(), second.unwrap());
        assert!(
            Arc::ptr_eq(&first, &second),
            "cold callers parsed separate indexes"
        );
        assert!(Arc::ptr_eq(&first, &cache.get(&path)));
        assert_eq!(first.search("PPO", 1)[0].page, "wiki/a.md");

        index.upsert_page("wiki/b.md", "b", &["synthetic revision marker".into()]);
        index.save(&path).unwrap();
        let replaced = cache.get_async(path.clone()).await.unwrap();
        assert!(!Arc::ptr_eq(&first, &replaced));
        assert_eq!(replaced.len(), 2);
        std::fs::remove_file(&path).unwrap();
        assert!(cache.get_async(path).await.unwrap().is_empty());
    }

    #[test]
    fn bm25_cache_get_miss_yields_empty_index() {
        let dir =
            std::env::temp_dir().join(format!("memex-bm25-cache-test-miss-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("idx.mxb");
        let cache = Bm25Cache::default();
        assert!(cache.get(&path).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bm25_cache_reuses_parse_and_notices_a_rewrite() {
        let dir = std::env::temp_dir().join(format!(
            "memex-bm25-cache-test-reuse-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("idx.mxb");
        let mut ix = Bm25Index::new();
        ix.upsert_page("a.md", "a", &["alpha".into()]);
        ix.save(&path).unwrap();

        let cache = Bm25Cache::default();
        let first = cache.get(&path);
        let second = cache.get(&path);
        assert_eq!(first.len(), 1);
        // Same allocation — the second call did not re-parse the file.
        assert!(Arc::ptr_eq(&first, &second));

        let mut next = Bm25Index::new();
        next.upsert_page("a.md", "a", &["alpha".into()]);
        next.upsert_page("b.md", "b", &["beta".into()]);
        next.save(&path).unwrap();
        assert_eq!(cache.get(&path).len(), 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bm25_cache_put_adopts_a_freshly_written_index() {
        let dir =
            std::env::temp_dir().join(format!("memex-bm25-cache-test-put-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("idx.mxb");
        let mut ix = Bm25Index::new();
        ix.upsert_page("a.md", "a", &["alpha".into()]);
        ix.save(&path).unwrap();

        let cache = Bm25Cache::default();
        cache.put(&path, ix);
        let got = cache.get(&path);
        assert_eq!(got.len(), 1);
        // The adopted entry is fresh, so get() served it rather than re-reading.
        assert!(Arc::ptr_eq(&got, &cache.get(&path)));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rrf_fuse_breaks_ties_deterministically_by_chunk_identity() {
        use crate::vector_index::Hit;
        // Chunk "b.md#0" appears only in dense at rank 0, chunk "a.md#0" only
        // in lexical at rank 0 -> both score exactly 1/(RRF_K+0). The score
        // alone cannot order them; the tie-break (page asc, then section asc)
        // must, and must do so the same way every time.
        let dense = vec![Hit {
            page: "b.md".into(),
            stem: "b".into(),
            section: 0,
            score: 0.5,
        }];
        let lex = vec![Bm25Hit {
            page: "a.md".into(),
            stem: "a".into(),
            section: 0,
            score: 1.0,
        }];
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

#[cfg(test)]
mod scoped_resolution_tests {
    use super::*;

    #[test]
    fn bm25_scope_is_applied_before_top_k_not_after_global_noise_wins() {
        let mut index = Bm25Index::new();
        for i in 0..64 {
            index.upsert_page(
                &format!("wiki/noise-{i}.md"),
                "Synthetic noise",
                &["synthetic_export_btn".into()],
            );
        }
        index.upsert_page("sessions/later.md","Synthetic later outcome",&["The assistant reported synthetic_export_btn completed; a later user rejection follows.".into()]);
        assert!(index.search("synthetic_export_btn", 1)[0]
            .page
            .starts_with("wiki/"));
        let scoped = index.search_where("synthetic_export_btn", 1, |page, _| {
            Scope::Sessions.keeps(page)
        });
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].page, "sessions/later.md");
    }

    #[test]
    fn bm25_explicit_paths_and_chunk_predicates_cannot_consume_the_result_budget() {
        let mut index = Bm25Index::new();
        index.upsert_page(
            "sessions/a.md",
            "Synthetic A",
            &[
                "synthetic_export_btn".into(),
                "synthetic_export_btn has a later state.".into(),
            ],
        );
        index.upsert_page(
            "sessions/b.md",
            "Synthetic B",
            &["synthetic_export_btn".into()],
        );
        let matches = index.search_where("synthetic_export_btn", 1, |page, section| {
            page == "sessions/a.md" && section == 1
        });
        assert_eq!(matches.len(), 1);
        assert_eq!(
            (matches[0].page.as_str(), matches[0].section),
            ("sessions/a.md", 1)
        );
        assert!(index
            .search_where("synthetic_export_btn", 0, |_, _| true)
            .is_empty());
        assert!(index
            .search_where("synthetic_export_btn", 1, |_, _| false)
            .is_empty());
    }
}
