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
// `pub(crate)` only so `pipeline`'s tests can assert that `fuse_chunk_matches`
// returns RRF rank scores while `dense_chunk_matches` returns cosines. Value
// and use are unchanged.
pub(crate) const RRF_K: f32 = 60.0;

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
                    phrases.push(p.to_lowercase());
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

/// One indexed chunk: identity is `(page, section)`, mirroring
/// `VectorStore::Record` so lexical and dense hits refer to the same chunk.
struct Bm25Doc {
    page: String,
    stem: String,
    section: usize,
    len: u32,
}

/// One occupied slot: a chunk plus its term->tf map. Slots live in a
/// `Vec<Option<Slot>>` whose indices are *stable* — see `Bm25Index`.
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
        if self.n_live == 0 {
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
        let mut slots = Vec::with_capacity(n_docs);
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
            slots.push(Some(Slot {
                doc: Bm25Doc {
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
    let hit = slot
        .as_ref()
        .is_some_and(|e| e.path == *path && e.fingerprint == fp);
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
