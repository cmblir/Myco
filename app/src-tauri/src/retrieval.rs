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
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::vector_index::Hit;

/// Magic + format-version byte for the `.mxb` sidecar. Unlike `.mxv`
/// (`vector_index::MAGIC`), there is no embedding model baked into the
/// format: BM25 is purely lexical, so it survives an embed-model swap that
/// would otherwise wipe the vector index.
const MXB_MAGIC: &[u8; 4] = b"MXB1";
const MXB_VERSION: u8 = 1;

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

    /// Index file path for a given vault root, under `<app-data>/embeddings/`.
    /// Same settings dir and hash scheme as `VectorStore::path_for`, so the
    /// lexical and dense sidecars for one vault sit next to each other —
    /// just a different extension.
    pub fn path_for(vault_root: &str) -> Result<PathBuf, String> {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        vault_root.hash(&mut h);
        let dir = crate::settings::settings_dir()?.join("embeddings");
        std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir embeddings: {e}"))?;
        Ok(dir.join(format!("{:016x}.mxb", h.finish())))
    }

    /// Read the index, or return an empty one. A missing, truncated, or
    /// corrupt file is never fatal: the index is derived state that a
    /// reindex rebuilds, so a bad read just degrades to "not indexed yet".
    pub fn load(path: &Path) -> Self {
        std::fs::read(path)
            .ok()
            .and_then(|bytes| Self::decode(&bytes))
            .unwrap_or_default()
    }

    /// Atomic temp-file-plus-rename save, mirroring `VectorStore::save`: a
    /// unique per-save temp name so two overlapping saves each publish a
    /// whole file rather than racing on a shared `.tmp` path.
    pub fn save(&self, path: &Path) -> Result<(), String> {
        let bytes = self.encode();
        let tmp = path.with_extension(format!("{}.mxb.tmp", unique_suffix()));
        std::fs::write(&tmp, &bytes).map_err(|e| format!("write index: {e}"))?;
        if let Err(e) = std::fs::rename(&tmp, path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("rename index: {e}"));
        }
        Ok(())
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
        let mut out = Vec::with_capacity(16 + self.docs.len() * 64);
        out.extend_from_slice(MXB_MAGIC);
        out.push(MXB_VERSION);
        out.extend_from_slice(&(self.docs.len() as u32).to_le_bytes());
        for (doc, terms) in self.docs.iter().zip(self.doc_terms.iter()) {
            put_str(&mut out, &doc.page);
            put_str(&mut out, &doc.stem);
            out.extend_from_slice(&(doc.section as u32).to_le_bytes());
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
        let mut docs = Vec::with_capacity(n_docs);
        let mut doc_terms = Vec::with_capacity(n_docs);
        for _ in 0..n_docs {
            let page = c.string()?;
            let stem = c.string()?;
            let section = c.u32()? as usize;
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
            docs.push(Bm25Doc { page, stem, section, len });
            doc_terms.push(terms);
        }

        let mut index = Bm25Index {
            docs,
            doc_terms,
            postings: HashMap::new(),
            df: HashMap::new(),
            total_len: 0,
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

/// Identity of the index file as it is right now: modified time and length.
/// Cheap (one `stat`) next to the parse it guards. Mirrors
/// `vector_index::fingerprint`.
fn fingerprint(path: &Path) -> Option<(std::time::SystemTime, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

struct CacheEntry {
    path: PathBuf,
    fingerprint: (std::time::SystemTime, u64),
    index: Arc<Bm25Index>,
}

/// Replace the entry unless it already holds this exact revision of `path`.
/// Returns `None` when there is no index file to key freshness on.
fn ensure_fresh<'a>(slot: &'a mut Option<CacheEntry>, path: &Path) -> Option<&'a mut CacheEntry> {
    let fp = fingerprint(path)?;
    let hit = slot.as_ref().is_some_and(|e| e.path == *path && e.fingerprint == fp);
    if !hit {
        *slot = Some(CacheEntry {
            path: path.to_path_buf(),
            fingerprint: fp,
            index: Arc::new(Bm25Index::load(path)),
        });
    }
    slot.as_mut()
}

/// Keeps the parsed BM25 index in memory across commands, mirroring
/// `vector_index::VectorCache` exactly: without it, every lexical-search
/// command would re-read and re-parse the whole `.mxb` file from disk on
/// every call, the same cost `VectorCache` already eliminated for the dense
/// side. Freshness is keyed on the file's mtime+length rather than trusted,
/// so a rewrite from outside this cache is picked up instead of served stale.
#[derive(Default)]
pub struct Bm25Cache {
    inner: Mutex<Option<CacheEntry>>,
}

impl Bm25Cache {
    /// The index for `path`, parsed at most once per on-disk revision.
    pub fn get(&self, path: &Path) -> Arc<Bm25Index> {
        // Held across the load: the parse is the expensive thing being cached,
        // and serializing concurrent first-callers is better than having each
        // of them parse the same file.
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match ensure_fresh(&mut guard, path) {
            Some(entry) => Arc::clone(&entry.index),
            // No file on disk: return an empty index *uncached*, since there is
            // nothing to key freshness on. Caching it would pin "empty" past the
            // first reindex.
            None => Arc::new(Bm25Index::default()),
        }
    }

    /// Adopt an index this process just wrote, so the writer's own work is
    /// reused instead of being re-read from the file it came from.
    pub fn put(&self, path: &Path, index: Bm25Index) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        *guard = fingerprint(path).map(|fp| CacheEntry {
            path: path.to_path_buf(),
            fingerprint: fp,
            index: Arc::new(index),
        });
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
    fn mxb_roundtrip_preserves_search() {
        let mut ix = Bm25Index::new();
        ix.upsert_page("wiki/rlhf.md", "rlhf", &["policy optimized with PPO".into()]);
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
            &["policy optimized with PPO".into(), "reward model training".into()],
        );
        ix.upsert_page("wiki/lora.md", "lora", &["low rank adapters".into()]);
        ix.upsert_page(
            "wiki/common.md",
            "common",
            &["policy gradient methods are common".into()],
        );
        let before = ix.search("policy", 10);
        let bytes = ix.encode();
        let after = Bm25Index::decode(&bytes).expect("decode").search("policy", 10);
        assert_eq!(before.len(), after.len());
        for (b, a) in before.iter().zip(after.iter()) {
            assert_eq!(b.page, a.page);
            assert_eq!(b.section, a.section);
            assert!((b.score - a.score).abs() < 1e-6, "{} vs {}", b.score, a.score);
        }
        assert_eq!(after[0].stem, "rlhf");
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
        ix.upsert_page("wiki/rlhf.md", "rlhf", &["policy optimized with PPO".into()]);
        ix.save(&path).unwrap();
        let loaded = Bm25Index::load(&path);
        assert_eq!(loaded.search("PPO", 5)[0].stem, "rlhf");
        // Path scheme mirrors VectorStore's: same settings dir, .mxb extension.
        let p2 = Bm25Index::path_for("some/vault/root").unwrap();
        assert_eq!(p2.extension().unwrap(), "mxb");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bm25_cache_get_miss_yields_empty_index() {
        let dir = std::env::temp_dir()
            .join(format!("memex-bm25-cache-test-miss-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("idx.mxb");
        let cache = Bm25Cache::default();
        assert!(cache.get(&path).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bm25_cache_reuses_parse_and_notices_a_rewrite() {
        let dir = std::env::temp_dir()
            .join(format!("memex-bm25-cache-test-reuse-{}", std::process::id()));
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
        let dir = std::env::temp_dir()
            .join(format!("memex-bm25-cache-test-put-{}", std::process::id()));
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
