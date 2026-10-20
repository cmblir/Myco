//! On-disk brute-force vector store for the semantic layer (Feature 1).
//!
//! A per-vault file of `{model, dim, records}` under the app data dir. Search is
//! a linear cosine scan — trivial for a personal vault (≤~10k pages) and keeps
//! the index a plain, rebuildable file (no lock-in, no heavy DB dependency). The
//! public surface is deliberately backend-agnostic so a LanceDB/ANN backend can
//! replace the internals later without touching callers.
//!
//! The file is a compact binary format rather than JSON. Vectors are ~99% of the
//! bytes and JSON renders every one of 1,152 f32s per record as decimal text,
//! which costs both size and parse time (`cargo bench --bench vector_store`, 10k
//! records x 1152d):
//!
//!   decode   json 287.4 ms  ->  binary   8.4 ms   (34x)
//!   encode   json 417.6 ms  ->  binary  26.7 ms   (16x)
//!   on disk  json 143.75 MB ->  binary  46.76 MB  (3.07x)
//!
//! Indexes written before this format are plain JSON; `load` still reads them, so
//! an existing vault keeps working and re-writes itself on the next reindex.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use crate::embeddings::{checked_cosine, checked_vector_norm, dot, CompensatedSum, EmbeddingSpace};

#[cfg(test)]
#[path = "vector_index_numeric_tests.rs"]
mod numeric_tests;

#[cfg(test)]
#[path = "vector_scoring_numeric_tests.rs"]
mod scoring_numeric_tests;

#[cfg(test)]
#[path = "vector_cache_admission_tests.rs"]
mod cache_admission_tests;

/// Magic + version. A version bump invalidates the file rather than attempting a
/// migration: the index is a derived cache and reindexing rebuilds it.
const MAGIC: &[u8; 4] = b"MXV2";

/// One embedded chunk. `id` = "<page>#<section>". `hash` is the chunk's content
/// hash so re-indexing can skip unchanged text.
#[derive(Clone, Serialize, Deserialize, PartialEq)]
pub struct Record {
    pub id: String,
    pub page: String, // vault-relative path
    pub stem: String, // page stem for citation/link
    pub section: usize,
    pub hash: u64,
    pub vector: Vec<f32>,
}

#[derive(Default, Serialize, Deserialize, PartialEq)]
pub struct VectorStore {
    pub model: String, // embedding model id; a change wipes the index (dim/geometry differ)
    #[serde(default)]
    pub signature: String,
    pub dim: usize,
    pub records: Vec<Record>,
}

/// An undirected similarity edge between two pages. `a` < `b` lexically, so a
/// pair has exactly one representation. Paths are vault-relative — the command
/// layer maps them to the absolute ids the graph uses.
#[derive(Clone)]
pub struct PageEdge {
    pub a: String,
    pub b: String,
    pub score: f32,
}

/// A ranked search hit.
#[derive(Clone, Serialize)]
pub struct Hit {
    pub page: String,
    pub stem: String,
    pub section: usize,
    pub score: f32,
}

/// True for a page the distillation gate's cold tier owns: archived sources
/// (`raw/archive/YYYY-MM/`), gate-quarantined inflow (`_inbox/quarantine/`),
/// digested sessions (`sessions/archive/YYYY-MM/`, Phase B's
/// `archive_digested_sessions`), rolled-up daily digests
/// (`daily/archive/YYYY-Www/`, ROADMAP P1's `archive_rolled_days` — the same
/// shape one compression layer up, where `weekly/<week>.md` is now the live
/// page carrying that knowledge), and internal cache/state (`.myco/`). These
/// are never indexed and any existing record for one is dropped on the next
/// prune — see `app/docs/specs/2026-08-13-ontology-distill-design.md`
/// ("Archive distilled sources ... drop from the active embedding index").
///
/// Distinct from `is_machine_written`: that one hides noisy-but-live pages
/// (raw/sessions/_inbox) from the link-suggestions panel while leaving them
/// fully indexed and searchable; this one says a page must not be in the
/// active index at all. Do not merge the two.
///
/// One exception is opt-in: with `Settings::search_archived_sessions` on,
/// `sessions/archive/**` is live again — the owner's own work history is
/// worth its index space to them — and the next reindex/reconcile picks it up
/// (`commands::collect_wiki_pages` dedups identical bodies there).
pub fn is_cold(page: &str) -> bool {
    is_cold_for(page, crate::settings::search_archived_sessions())
}

/// `is_cold` with the archived-sessions flag explicit (pure; the tests use
/// this so they never touch the process-wide setting).
pub fn is_cold_for(page: &str, search_archived_sessions: bool) -> bool {
    page.starts_with("raw/archive/")
        || page.starts_with("_inbox/quarantine/")
        || (page.starts_with("sessions/archive/") && !search_archived_sessions)
        || page.starts_with("daily/archive/")
        || page.starts_with("weekly/archive/")
        || page.starts_with(".myco/")
}

impl VectorStore {
    /// Index file path for a given vault root, under `<app-data>/embeddings/`.
    pub fn path_for(vault_root: &str) -> Result<PathBuf, String> {
        crate::index_publication::read_path_for(vault_root, "mxv")
    }

    /// Where this vault's index lived before the binary format.
    fn legacy_json_path(path: &Path) -> PathBuf {
        path.with_extension("json")
    }

    /// Read the index, or return an empty store. A missing, truncated, or corrupt
    /// file is never fatal — the index is derived state and reindexing rebuilds
    /// it, so a bad read degrades to "not indexed yet" rather than an error.
    pub fn load(path: &Path) -> Self {
        if let Ok(bytes) = std::fs::read(path) {
            if path.extension().and_then(|extension| extension.to_str()) == Some("mxp") {
                return crate::index_publication::decode(&bytes)
                    .map(|pair| pair.store)
                    .unwrap_or_default();
            }
            if let Some(store) = Self::decode(&bytes) {
                return store;
            }
        }
        // Pre-binary indexes are JSON at the same stem. Read it so an existing
        // vault does not silently lose its index on upgrade; the next save
        // rewrites it in binary and removes the JSON.
        let legacy = Self::legacy_json_path(path);
        if legacy != *path {
            if let Ok(bytes) = std::fs::read(legacy) {
                if let Ok(store) = serde_json::from_slice::<Self>(&bytes) {
                    if store.validate_geometry().is_ok() {
                        return store;
                    }
                }
            }
        }
        Self::default()
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        if path.extension().and_then(|extension| extension.to_str()) == Some("mxp") {
            return Err("paired indexes must be saved through the index publisher".into());
        }
        self.validate_geometry()?;
        let bytes = self.encode();
        // Atomic-ish write: temp + rename, so a crash mid-write cannot leave a
        // half-written index in place.
        //
        // The temp name is unique per save, not a fixed `<stem>.mxv.tmp`. Two
        // saves can genuinely overlap — reindex checkpoints every 30 s, and
        // until the UI serialised runs, navigating away and back started a
        // second one — and on a shared name they fight: both write the same
        // file, then the first rename moves it away and the second fails with
        // ENOENT, so a save that did all its work reports failure and the
        // caller loses the whole reindex. (Reproduced with two barrier-synced
        // savers.) Worse in principle, the interleaved writes mean the winning
        // rename can publish a mixture of both.
        //
        // With a private temp per save, each writer renames its own complete
        // file: last writer wins, both succeed, and what lands is always one
        // whole index.
        let tmp = path.with_extension(format!("{}.mxv.tmp", unique_suffix()));
        std::fs::write(&tmp, &bytes).map_err(|e| format!("write index: {e}"))?;
        if let Err(e) = std::fs::rename(&tmp, path) {
            // Don't leave the temp behind on a failed publish.
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("rename index: {e}"));
        }
        // The binary file is now authoritative; drop any superseded JSON rather
        // than leaving a stale copy behind (at 10k records that is 143 MB of
        // dead weight). Best-effort: failing to remove it is not worth failing
        // an otherwise-successful save. The guard matters — a caller that names
        // its index "*.json" would otherwise delete the file just written.
        let legacy = Self::legacy_json_path(path);
        if legacy != *path {
            let _ = std::fs::remove_file(legacy);
        }
        Ok(())
    }

    /// Authoritative readers preserve existing read and decode failures.
    pub(crate) fn load_checked(path: &Path) -> Result<Self, String> {
        match read_store_snapshot(path)? {
            Some((revision, bytes)) => decode_store_snapshot(path, &revision, &bytes),
            None => Ok(Self::default()),
        }
    }

    /// Complete declared embedding identity after validating every stored vector.
    pub fn embedding_space(&self) -> Result<EmbeddingSpace, String> {
        self.validate_geometry()?;
        let space = EmbeddingSpace {
            model: self.model.clone(),
            signature: self.signature.clone(),
            dim: self.dim,
        };
        space.validate()?;
        Ok(space)
    }

    /// Validate persisted geometry without imposing a normalization convention.
    pub(crate) fn validate_geometry(&self) -> Result<(), String> {
        u32::try_from(self.dim)
            .map_err(|_| "dense index dimension exceeds codec width".to_string())?;
        for (index, record) in self.records.iter().enumerate() {
            checked_vector_norm(&record.vector, Some(self.dim))
                .map_err(|error| format!("invalid dense vector record {index}: {error}"))?;
        }
        Ok(())
    }

    /// Serialize to the binary format. Public so `benches/vector_store.rs`
    /// measures the shipped codec rather than a copy of it. Layout:
    ///
    /// ```text
    /// "MXV1" | dim u32 | n_records u32 | model (u32 len + utf8)
    /// per record: id, page, stem (u32 len + utf8) | section u32 | hash u64
    ///             | dim * f32 little-endian
    /// ```
    pub fn encode(&self) -> Vec<u8> {
        fn put_str(out: &mut Vec<u8>, s: &str) {
            out.extend_from_slice(&(s.len() as u32).to_le_bytes());
            out.extend_from_slice(s.as_bytes());
        }
        // Reserve from actual payload sizes, not untrusted declared geometry.
        // The reservation is only a hint; overflow skips it without changing
        // the unchecked codec API or treating its output as validated state.
        let capacity = self
            .model
            .len()
            .checked_add(self.signature.len())
            .and_then(|length| length.checked_add(20))
            .and_then(|header| {
                self.records.iter().try_fold(header, |capacity, record| {
                    let bytes = 24usize
                        .checked_add(record.id.len())?
                        .checked_add(record.page.len())?
                        .checked_add(record.stem.len())?
                        .checked_add(record.vector.len().checked_mul(4)?)?;
                    capacity.checked_add(bytes)
                })
            });
        let mut out = Vec::with_capacity(
            capacity
                .filter(|capacity| *capacity <= isize::MAX as usize)
                .unwrap_or(0),
        );
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&(self.dim as u32).to_le_bytes());
        out.extend_from_slice(&(self.records.len() as u32).to_le_bytes());
        put_str(&mut out, &self.model);
        put_str(&mut out, &self.signature);
        for r in &self.records {
            put_str(&mut out, &r.id);
            put_str(&mut out, &r.page);
            put_str(&mut out, &r.stem);
            out.extend_from_slice(&(r.section as u32).to_le_bytes());
            out.extend_from_slice(&r.hash.to_le_bytes());
            for x in &r.vector {
                out.extend_from_slice(&x.to_le_bytes());
            }
        }
        out
    }

    /// Parse the binary format. Every read is bounds-checked and returns `None`
    /// on any inconsistency: this parses a file on disk, which may be truncated
    /// by a full volume, corrupted, or simply be a different format — none of
    /// which may panic the app.
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
        let magic = c.take(4)?;
        if magic != MAGIC && magic != b"MXV1" {
            return None;
        }
        let dim = c.u32()? as usize;
        let n = c.u32()? as usize;
        let model = c.string()?;
        let signature = if magic == MAGIC {
            c.string()?
        } else {
            String::new()
        };
        // Every record needs three string lengths, a section, a hash and its
        // vector. Include metadata so a zero width cannot bypass this bound.
        let minimum_record_bytes = 24usize.checked_add(dim.checked_mul(4)?)?;
        if (n > 0 && dim == 0)
            || n.checked_mul(minimum_record_bytes)? > bytes.len().checked_sub(c.p)?
        {
            return None;
        }
        let mut records = Vec::with_capacity(n);
        for _ in 0..n {
            let id = c.string()?;
            let page = c.string()?;
            let stem = c.string()?;
            let section = c.u32()? as usize;
            let hash = c.u64()?;
            let raw = c.take(dim.checked_mul(4)?)?;
            let vector: Vec<f32> = raw
                .chunks_exact(4)
                .map(|w| f32::from_le_bytes([w[0], w[1], w[2], w[3]]))
                .collect();
            checked_vector_norm(&vector, Some(dim)).ok()?;
            records.push(Record {
                id,
                page,
                stem,
                section,
                hash,
                vector,
            });
        }
        if c.p != bytes.len() {
            return None;
        }
        Some(VectorStore {
            model,
            signature,
            dim,
            records,
        })
    }

    /// Switch embedding model — a different model means incompatible vectors, so
    /// wipe everything and start fresh. No-op when the model is unchanged.
    pub fn ensure_model(&mut self, model: &str) {
        if self.model != model {
            self.model = model.to_string();
            self.signature.clear();
            self.dim = 0;
            self.records.clear();
        }
    }

    /// A model name alone does not identify pooling, weights or chunk semantics.
    pub fn ensure_signature(&mut self, model: &str, signature: &str) -> bool {
        if self.model == model && self.signature == signature {
            return false;
        }
        self.model = model.to_string();
        self.signature = signature.to_string();
        self.dim = 0;
        self.records.clear();
        true
    }

    /// Replace sparse sections during a checkpoint without changing chunk IDs.
    /// Invalid incoming geometry returns an error before any record is replaced.
    pub fn upsert_page_sections(
        &mut self,
        page: &str,
        stem: &str,
        chunks: Vec<(usize, u64, Vec<f32>)>,
    ) -> Result<(), String> {
        let mut dim = self.dim;
        for (_, _, vector) in &chunks {
            if dim == 0 {
                dim = vector.len();
            }
            checked_vector_norm(vector, Some(dim))?;
        }
        self.records.retain(|r| r.page != page);
        self.dim = dim;
        for (section, hash, vector) in chunks {
            self.records.push(Record {
                id: format!("{page}#{section}"),
                page: page.to_string(),
                stem: stem.to_string(),
                section,
                hash,
                vector,
            });
        }
        Ok(())
    }

    /// Content hashes already stored, grouped by page and in section order, so a
    /// caller can skip embedding chunks whose text is unchanged.
    ///
    /// Grouped rather than per-page on purpose: reindex asks about every page,
    /// and answering one page at a time meant re-scanning every record for each
    /// one — O(pages × records) to extract what a single pass yields.
    ///
    /// Keys are owned so the caller can go on mutating the store (reindex reads
    /// this map while upserting into it); one short string per record is nothing
    /// against the scan it replaces.
    pub fn hashes_by_page(&self) -> std::collections::HashMap<String, Vec<u64>> {
        let mut out: std::collections::HashMap<String, Vec<u64>> = std::collections::HashMap::new();
        for r in &self.records {
            out.entry(r.page.clone()).or_default().push(r.hash);
        }
        out
    }

    /// This page's stored vectors, keyed by chunk content hash, so a re-index
    /// can reuse the ones whose text did not change instead of re-embedding
    /// the whole page (see `commands::chunks_needing_embed`). Duplicate chunks
    /// within a page collapse to one entry — they embed identically anyway.
    pub fn page_vectors(&self, page: &str) -> std::collections::HashMap<u64, Vec<f32>> {
        self.records
            .iter()
            .filter(|r| r.page == page)
            .map(|r| (r.hash, r.vector.clone()))
            .collect()
    }

    /// Replace all records for one page with a fresh set.
    /// An empty batch deletes that page; an invalid batch leaves the store intact.
    pub fn upsert_page(
        &mut self,
        page: &str,
        stem: &str,
        chunks: Vec<(u64, Vec<f32>)>,
    ) -> Result<(), String> {
        self.upsert_page_sections(
            page,
            stem,
            chunks
                .into_iter()
                .enumerate()
                .map(|(section, (hash, vector))| (section, hash, vector))
                .collect(),
        )
    }

    /// Drop records for pages no longer present in the vault. Returns how many
    /// records were dropped, so a caller can tell whether a save is warranted.
    pub fn prune(&mut self, existing: &HashSet<String>) -> usize {
        let before = self.records.len();
        self.records.retain(|r| existing.contains(&r.page));
        before - self.records.len()
    }

    pub fn indexed_pages(&self) -> usize {
        self.records
            .iter()
            .map(|r| r.page.as_str())
            .collect::<HashSet<_>>()
            .len()
    }

    /// Top-`k` chunks by cosine similarity to `query`.
    pub fn search(&self, query: &[f32], k: usize) -> Result<Vec<Hit>, String> {
        self.validate_geometry()?;
        checked_vector_norm(query, (self.dim != 0).then_some(self.dim))?;
        let mut scored: Vec<Hit> = self
            .records
            .iter()
            .map(|r| {
                Ok(Hit {
                    page: r.page.clone(),
                    stem: r.stem.clone(),
                    section: r.section,
                    score: checked_cosine(query, &r.vector)?,
                })
            })
            .collect::<Result<_, String>>()?;
        scored.sort_by(|a, b| b.score.total_cmp(&a.score));
        scored.truncate(k);
        Ok(scored)
    }

    /// One unit vector per page: the mean of its chunk vectors, renormalized.
    /// Sorted by page so everything derived from it is deterministic.
    pub fn page_centroids(&self) -> Result<Vec<(String, Vec<f32>)>, String> {
        use std::collections::HashMap;
        self.validate_geometry()?;
        let mut acc: HashMap<&str, Vec<CompensatedSum>> = HashMap::new();
        for r in &self.records {
            let e = acc
                .entry(r.page.as_str())
                .or_insert_with(|| vec![CompensatedSum::default(); self.dim]);
            for (i, x) in r.vector.iter().enumerate() {
                e[i].add(f64::from(*x));
            }
        }
        let mut out: Vec<(String, Vec<f32>)> = acc
            .into_iter()
            .map(|(page, sum)| {
                let sum: Vec<f64> = sum.into_iter().map(CompensatedSum::total).collect();
                // A positive count changes magnitude, not direction. Normalize
                // the f64 sum before narrowing, retaining subnormal raw means.
                let norm = sum.iter().map(|value| value * value).sum::<f64>().sqrt();
                if !norm.is_finite() || norm == 0.0 {
                    return Err("page chunks have no finite nonzero aggregate direction".into());
                }
                let vector: Vec<f32> = sum.into_iter().map(|v| (v / norm) as f32).collect();
                checked_vector_norm(&vector, Some(self.dim))?;
                Ok((page.to_string(), vector))
            })
            .collect::<Result<_, String>>()?;
        out.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(out)
    }

    /// Top-`k` similar pages for every page, as undirected deduplicated edges —
    /// the graph's "semantic links" overlay.
    ///
    /// Compares one centroid per page rather than every chunk against every chunk
    /// (which is what `related` does). That drops a factor of chunks² from the
    /// inner loop: 300 pages goes from 1.016 s to 114 ms, ~9x (`cargo bench
    /// --bench vector_store`). It also *changes which edges appear*, on purpose —
    /// a whole-page centroid expresses "these two notes are about the same thing",
    /// while best-chunk-vs-best-chunk fires whenever any one paragraph matches,
    /// so a shared boilerplate section is enough to link two unrelated pages. The
    /// Reader's related-notes panel keeps `related`: there, surfacing the single
    /// passage that matches is the point.
    /// Folders whose pages are machine-written, so a "you might link these"
    /// suggestion over them is noise the user cannot act on.
    ///
    /// Without this the panel offered pairs of session transcripts by their
    /// UUID filenames — on the real vault 98% of indexed chunks are swept
    /// sessions, so every suggestion was `codex-019fdc04-… ↔ codex-019fdc05-…`
    /// and not one row named something a person had written.
    fn is_machine_written(page: &str) -> bool {
        // `daily/` digests are machine-written session summaries (searchable
        // since `collect_wiki_pages` started walking `daily/` — see its doc
        // comment), and letting them into link suggestions would close a
        // self-reinforcement loop.
        matches!(
            page.split('/').next().unwrap_or(""),
            "sessions" | "_inbox" | "raw" | "ingest-reports" | "daily" | "weekly" | "monthly"
        )
    }

    pub fn centroid_edges(&self, k: usize) -> Result<Vec<PageEdge>, String> {
        let cents: Vec<(String, Vec<f32>)> = self
            .page_centroids()?
            .into_iter()
            .filter(|(page, _)| !Self::is_machine_written(page))
            .collect();
        let k = k.min(cents.len().saturating_sub(1));
        if k == 0 {
            return Ok(Vec::new());
        }
        // Compute each symmetric cosine once. Keep only each page's k best
        // candidates, rather than sorting N-1 hits for every page. Equal
        // scores retain lexical page order, matching the former stable sort.
        let mut nearest: Vec<Vec<(usize, f32)>> = (0..cents.len())
            .map(|_| Vec::with_capacity(k + 1))
            .collect();
        let insert = |hits: &mut Vec<(usize, f32)>, other: usize, score: f32| {
            let at = hits.partition_point(|(index, current)| {
                *current > score || (*current == score && *index < other)
            });
            if at < k {
                hits.insert(at, (other, score));
                hits.truncate(k);
            }
        };
        for i in 0..cents.len() {
            for j in (i + 1)..cents.len() {
                let score = dot(&cents[i].1, &cents[j].1);
                if !score.is_finite() {
                    return Err("page centroid edge score is not finite".into());
                }
                insert(&mut nearest[i], j, score);
                insert(&mut nearest[j], i, score);
            }
        }
        let mut seen: HashSet<(&str, &str)> = HashSet::new();
        let mut out = Vec::new();
        for (i, (page, _)) in cents.iter().enumerate() {
            for &(other, score) in &nearest[i] {
                let other = cents[other].0.as_str();
                // Undirected de-dup: order the pair lexically.
                let pair = if page.as_str() < other {
                    (page.as_str(), other)
                } else {
                    (other, page.as_str())
                };
                if seen.insert(pair) {
                    out.push(PageEdge {
                        a: pair.0.to_string(),
                        b: pair.1.to_string(),
                        score,
                    });
                }
            }
        }
        Ok(out)
    }

    /// Pages most similar to `page`, best-chunk-vs-best-chunk, excluding itself.
    /// Returns one hit per page, ranked.
    pub fn related(&self, page: &str, k: usize) -> Result<Vec<Hit>, String> {
        self.validate_geometry()?;
        let self_vecs: Vec<&Vec<f32>> = self
            .records
            .iter()
            .filter(|r| r.page == page)
            .map(|r| &r.vector)
            .collect();
        if self_vecs.is_empty() {
            return Ok(Vec::new());
        }
        use std::collections::HashMap;
        let mut best: HashMap<&str, Hit> = HashMap::new();
        for r in &self.records {
            if r.page == page {
                continue;
            }
            let score = self_vecs
                .iter()
                .map(|sv| checked_cosine(sv, &r.vector))
                .collect::<Result<Vec<_>, _>>()?
                .into_iter()
                .fold(f32::NEG_INFINITY, f32::max);
            let e = best.entry(r.page.as_str()).or_insert(Hit {
                page: r.page.clone(),
                stem: r.stem.clone(),
                section: r.section,
                score: f32::MIN,
            });
            if score > e.score {
                e.score = score;
                e.section = r.section;
            }
        }
        let mut hits: Vec<Hit> = best.into_values().collect();
        hits.sort_by(|a, b| b.score.total_cmp(&a.score));
        hits.truncate(k);
        Ok(hits)
    }
}

/// A per-save token for the temp filename. Process id plus a monotonic counter:
/// unique between concurrent saves in this process, and between processes.
/// Nothing depends on it being unpredictable — only on two savers never picking
/// the same one.
fn unique_suffix() -> String {
    static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    format!("{}-{n}", std::process::id())
}

/// Content revision of the selected binary, pair, or legacy JSON file.
#[derive(PartialEq, Eq)]
struct FileRevision {
    source: PathBuf,
    file: crate::index_publication::IndexFileRevision,
}

/// Hash and decode use one captured read; only an absent primary selects JSON.
fn read_store_snapshot(path: &Path) -> Result<Option<(FileRevision, Vec<u8>)>, String> {
    let (source, snapshot) = match crate::index_publication::read_snapshot(path)? {
        Some(snapshot) => (path.to_path_buf(), snapshot),
        None if path.extension().and_then(|extension| extension.to_str()) == Some("mxp") => {
            return Ok(None);
        }
        None => {
            let source = VectorStore::legacy_json_path(path);
            let Some(snapshot) = crate::index_publication::read_snapshot(&source)? else {
                return Ok(None);
            };
            if crate::index_publication::read_snapshot(path)?.is_some() {
                return Err("vector index primary appeared during legacy selection".into());
            }
            (source, snapshot)
        }
    };
    Ok(Some((
        FileRevision {
            source,
            file: snapshot.revision,
        },
        snapshot.bytes,
    )))
}

fn decode_store_snapshot(
    path: &Path,
    revision: &FileRevision,
    bytes: &[u8],
) -> Result<VectorStore, String> {
    if path.extension().and_then(|extension| extension.to_str()) == Some("mxp") {
        return crate::index_publication::decode(bytes)
            .map(|pair| pair.store)
            .ok_or_else(|| "published index pair is corrupt".into());
    }
    if revision.source != path {
        let store: VectorStore = serde_json::from_slice(bytes)
            .map_err(|_| "legacy dense JSON index is corrupt".to_string())?;
        store.validate_geometry()?;
        return Ok(store);
    }
    VectorStore::decode(bytes).ok_or_else(|| "legacy dense index is corrupt".into())
}

struct CacheEntry {
    path: PathBuf,
    fingerprint: FileRevision,
    store: Arc<VectorStore>,
    /// Edge lists derived from `store`, keyed by `k`. Tied to this entry's
    /// lifetime, so they cannot outlive the index revision they came from.
    // Native callers clamp k to 1..=10, bounding this table to ten lists.
    edges: std::collections::HashMap<usize, Arc<EdgeCell>>,
}

type EdgeCell = OnceLock<Result<Arc<Vec<PageEdge>>, String>>;

/// Replace the entry unless it already holds this exact revision of `path`.
/// Returns `None` when there is no index file to key freshness on.
fn ensure_fresh<'a>(
    slot: &'a mut Option<CacheEntry>,
    path: &Path,
) -> Result<Option<&'a mut CacheEntry>, String> {
    let Some((fp, bytes)) = read_store_snapshot(path)? else {
        *slot = None;
        return Ok(None);
    };
    let hit = slot
        .as_ref()
        .is_some_and(|e| e.path == *path && e.fingerprint == fp);
    if !hit {
        let store = decode_store_snapshot(path, &fp, &bytes)?;
        if read_store_snapshot(path)?
            .map(|(revision, _)| revision)
            .as_ref()
            != Some(&fp)
        {
            return Err("vector index revision changed during checked load".into());
        }
        *slot = Some(CacheEntry {
            path: path.to_path_buf(),
            fingerprint: fp,
            store: Arc::new(store),
            edges: std::collections::HashMap::new(),
        });
    }
    Ok(slot.as_mut())
}

/// Keeps the parsed index in memory across commands.
///
/// Every semantic command used to re-read and re-parse the whole index from
/// disk. That dwarfed the work it was setting up for: at 10k records a
/// `semantic_search` spent 287 ms deserializing to run a 12 ms scan — 24x more
/// time rebuilding the index than searching it (`cargo bench --bench
/// vector_store`). The store is a few tens of MB and one vault is open at a
/// time, so a single entry is held.
///
/// Freshness is checked against captured file content rather than trusted, so
/// an index rewritten by anything other than this cache — a future sidecar, a
/// restored backup, the user deleting the file — is picked up rather than served
/// stale. A paired index additionally supplies its publication generation.
/// `reindex_embeddings` checks its owned store against the published bytes
/// before adoption; identical stores retain their existing derived edge cells.
/// What a caller needs to answer "top-`k` edges for this index".
///
/// Not just the edges, because computing them is a quadratic pass (114 ms at 300
/// pages, and it grows with the square of the page count) and must not happen
/// while the cache's lock is held — every other semantic command wants that
/// lock. The caller gets either the finished list or shared work to run on a
/// blocking thread. Concurrent requests initialize the same cell once.
pub enum EdgeLookup {
    /// Already computed for this index revision.
    Ready(Arc<Vec<PageEdge>>),
    /// Not computed yet — run this shared work off-thread.
    Compute(EdgeWork),
    /// No index on disk.
    Empty,
}

/// One immutable index revision's shared edge pass. Its private lock never
/// blocks `VectorCache::get`, so unrelated searches can continue during it.
pub struct EdgeWork {
    store: Arc<VectorStore>,
    k: usize,
    edges: Arc<EdgeCell>,
}

impl EdgeWork {
    /// Return the shared list and whether this caller performed its pass.
    /// A panicking initializer leaves the cell empty, allowing a later retry.
    pub fn compute(self) -> Result<(Arc<Vec<PageEdge>>, bool), String> {
        let mut computed = false;
        let edges = self.edges.get_or_init(|| {
            computed = true;
            self.store.centroid_edges(self.k).map(Arc::new)
        });
        edges.clone().map(|edges| (edges, computed))
    }
}

#[derive(Clone, Default)]
pub struct VectorCache {
    inner: Arc<Mutex<Option<CacheEntry>>>,
}

impl VectorCache {
    /// Load the current index off-thread, including cache-lock and cold-parse waits.
    pub async fn get_async(&self, path: PathBuf) -> Result<Arc<VectorStore>, String> {
        let cache = self.clone();
        tauri::async_runtime::spawn_blocking(move || cache.get(&path))
            .await
            .map_err(|e| format!("vector cache load task failed: {e}"))?
    }

    /// Look up shared edge work off-thread; the caller still owns its computation.
    pub async fn lookup_edges_async(&self, path: PathBuf, k: usize) -> Result<EdgeLookup, String> {
        let cache = self.clone();
        tauri::async_runtime::spawn_blocking(move || cache.lookup_edges(&path, k))
            .await
            .map_err(|e| format!("vector edge lookup task failed: {e}"))?
    }

    /// The index for `path`, parsed at most once per on-disk revision.
    pub fn get(&self, path: &Path) -> Result<Arc<VectorStore>, String> {
        // Held across the load: the parse is the expensive thing being cached,
        // and serializing concurrent first-callers is better than having each
        // of them parse the same file. No await happens under this guard.
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "vector cache lock poisoned".to_string())?;
        Ok(match ensure_fresh(&mut guard, path)? {
            Some(entry) => Arc::clone(&entry.store),
            // No file on disk: return an empty store *uncached*, since there is
            // nothing to key freshness on. Caching it would pin "empty" past the
            // first reindex.
            None => Arc::new(VectorStore::default()),
        })
    }

    /// Cached edges for `(path, k)`, or one shared pass to compute them.
    ///
    /// The graph asks on mount and on every toggle of the semantic overlay, and
    /// the link-suggestions panel asks for the same `k` — so the answer is
    /// cached per index revision and they share one computation.
    pub fn lookup_edges(&self, path: &Path, k: usize) -> Result<EdgeLookup, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "vector cache lock poisoned".to_string())?;
        let Some(entry) = ensure_fresh(&mut guard, path)? else {
            return Ok(EdgeLookup::Empty);
        };
        let edges = entry.edges.entry(k).or_default();
        Ok(match edges.get() {
            Some(cached) => EdgeLookup::Ready(cached.clone()?),
            None => EdgeLookup::Compute(EdgeWork {
                store: Arc::clone(&entry.store),
                k,
                edges: Arc::clone(edges),
            }),
        })
    }

    /// Adopt a valid store only when it matches the current checked publication.
    /// Failed validation, reads, and observed rewrites preserve the old entry.
    pub fn put(&self, path: &Path, store: VectorStore) -> Result<(), String> {
        store.validate_geometry()?;
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "vector cache lock poisoned".to_string())?;
        let (fp, bytes) = read_store_snapshot(path)?
            .ok_or_else(|| "published vector index is missing".to_string())?;
        let persisted = decode_store_snapshot(path, &fp, &bytes)?;
        if read_store_snapshot(path)?
            .map(|(revision, _)| revision)
            .as_ref()
            != Some(&fp)
        {
            return Err("vector index revision changed during checked adoption".into());
        }
        if persisted != store {
            return Err("supplied vector store does not match the published file".into());
        }
        // No-op reindex still publishes an owned store. Compare complete
        // records/model identity once here (O(records * dim)), retaining both
        // finished and in-flight edge cells when nothing actually changed.
        if let Some(entry) = guard.as_mut() {
            if entry.path == path && entry.store.as_ref() == &store {
                entry.fingerprint = fp;
                return Ok(());
            }
        }
        *guard = Some(CacheEntry {
            path: path.to_path_buf(),
            fingerprint: fp,
            store: Arc::new(store),
            // The new store invalidates anything derived from the old one.
            edges: std::collections::HashMap::new(),
        });
        Ok(())
    }
}

/// One page's position on the 3D semantic map (see `semantic_map_points`).
#[derive(Debug, Clone, serde::Serialize)]
pub struct SemanticPoint {
    pub page: String,
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

/// Project page centroids onto their top-3 principal components — the layout
/// coordinates for the "semantic map" (notes cluster by MEANING, not links),
/// a 3D meaning-nebula rather than a flat chart.
/// PCA by power iteration with deflation: never materialises the d×d
/// covariance (d = 1152), just streams Σᵢ(xᵢ·v)xᵢ over the centred data.
/// Deterministic (fixed seed vector, fixed iteration count) and pure, so the
/// same index always draws the same map. Output is normalised to [-1, 1] per
/// axis. O(iters · n · d) — ~1s for 10k pages in release, run it off-thread.
pub fn semantic_map_points(centroids: &[(String, Vec<f32>)]) -> Vec<SemanticPoint> {
    let n = centroids.len();
    if n < 2 {
        return centroids
            .iter()
            .map(|(p, _)| SemanticPoint {
                page: p.clone(),
                x: 0.0,
                y: 0.0,
                z: 0.0,
            })
            .collect();
    }
    let d = centroids[0].1.len();
    if d == 0 {
        return Vec::new();
    }
    let mut mean = vec![0f32; d];
    for (_, v) in centroids {
        for i in 0..d.min(v.len()) {
            mean[i] += v[i];
        }
    }
    for m in &mut mean {
        *m /= n as f32;
    }
    // Centre once — 10k × 1152 f32 is ~46 MB transient, cheaper than paying the
    // subtraction inside every power iteration.
    let centred: Vec<Vec<f32>> = centroids
        .iter()
        .map(|(_, v)| {
            let mut c = vec![0f32; d];
            for i in 0..d.min(v.len()) {
                c[i] = v[i] - mean[i];
            }
            c
        })
        .collect();
    let dot = |a: &[f32], b: &[f32]| -> f32 { a.iter().zip(b).map(|(x, y)| x * y).sum() };

    let mut comps: Vec<Vec<f32>> = Vec::new();
    for c in 0..3 {
        // Fixed pseudo-random seed vector — determinism over elegance.
        let mut v: Vec<f32> = (0..d)
            .map(|i| (((i * 2_654_435_761 + c * 97) % 1000) as f32) / 1000.0 - 0.5)
            .collect();
        for _ in 0..30 {
            let mut next = vec![0f32; d];
            for x in &centred {
                let s = dot(x, &v);
                for i in 0..d {
                    next[i] += s * x[i];
                }
            }
            // Deflate: keep the second component orthogonal to the first.
            for pc in &comps {
                let pr = dot(&next, pc);
                for i in 0..d {
                    next[i] -= pr * pc[i];
                }
            }
            let norm = dot(&next, &next).sqrt().max(1e-9);
            for i in 0..d {
                v[i] = next[i] / norm;
            }
        }
        comps.push(v);
    }

    let mut xs: Vec<f32> = Vec::with_capacity(n);
    let mut ys: Vec<f32> = Vec::with_capacity(n);
    let mut zs: Vec<f32> = Vec::with_capacity(n);
    for x in &centred {
        xs.push(dot(x, &comps[0]));
        ys.push(dot(x, &comps[1]));
        zs.push(dot(x, &comps[2]));
    }
    let span = |vals: &[f32]| -> (f32, f32) {
        let mut lo = f32::MAX;
        let mut hi = f32::MIN;
        for &v in vals {
            lo = lo.min(v);
            hi = hi.max(v);
        }
        (lo, (hi - lo).max(1e-9))
    };
    let (x0, xw) = span(&xs);
    let (y0, yw) = span(&ys);
    let (z0, zw) = span(&zs);
    centroids
        .iter()
        .enumerate()
        .map(|(i, (p, _))| SemanticPoint {
            page: p.clone(),
            x: ((xs[i] - x0) / xw) * 2.0 - 1.0,
            y: ((ys[i] - y0) / yw) * 2.0 - 1.0,
            z: ((zs[i] - z0) / zw) * 2.0 - 1.0,
        })
        .collect()
}

#[cfg(test)]
mod signature_tests {
    use super::VectorStore;
    #[test]
    fn changing_signature_rebuilds_same_named_model_and_codec_keeps_identity() {
        let mut store = VectorStore::default();
        store.ensure_signature("builtin-local:e5-small-ko", "weights-a/mean/v1");
        store
            .upsert_page("wiki/a.md", "a", vec![(1, vec![1.0, 0.0])])
            .unwrap();
        assert!(!store.ensure_signature("builtin-local:e5-small-ko", "weights-a/mean/v1"));
        let decoded = VectorStore::decode(&store.encode()).unwrap();
        assert_eq!(decoded.signature, store.signature);
        assert!(store.ensure_signature("builtin-local:e5-small-ko", "weights-b/mean/v1"));
        assert!(store.records.is_empty());
    }
    #[test]
    fn partial_sections_survive_restart_and_preserve_tail_identity() {
        let mut store = VectorStore::default();
        store
            .upsert_page_sections(
                "sessions/log.md",
                "log",
                vec![(0, 11, vec![1.0, 0.0]), (299, 22, vec![0.0, 1.0])],
            )
            .unwrap();
        let reloaded = VectorStore::decode(&store.encode()).unwrap();
        assert!(reloaded
            .records
            .iter()
            .any(|record| record.page == "sessions/log.md"
                && record.section == 299
                && record.hash == 22));
        assert_eq!(reloaded.page_vectors("sessions/log.md").len(), 2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn async_vector_cache_calls_do_not_stall_heartbeat() {
        for edges in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("idx.mxv");
            let mut store = VectorStore::default();
            store.ensure_model("synthetic-model");
            store
                .upsert_page("wiki/a.md", "a", vec![(1, vec![1.0, 0.0])])
                .unwrap();
            store.save(&path).unwrap();
            let cache = Arc::new(VectorCache::default());
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
            let load = async {
                if edges {
                    assert!(matches!(
                        cache.lookup_edges_async(path, 4).await.unwrap(),
                        EdgeLookup::Compute(_)
                    ));
                } else {
                    assert_eq!(cache.get_async(path).await.unwrap().records.len(), 1);
                }
            };
            let heartbeat = async {
                tokio::task::yield_now().await;
                release_tx.send(()).unwrap();
            };
            tokio::pin!(load, heartbeat);
            let heartbeat_first = tokio::select! {
                biased;
                _ = &mut load => false,
                _ = &mut heartbeat => true,
            };
            if heartbeat_first {
                load.await;
            }
            let released_by_heartbeat = holder.join().unwrap();
            assert!(
                heartbeat_first,
                "cache call blocked the current-thread heartbeat (edges={edges})"
            );
            assert!(released_by_heartbeat, "cache lock outlived the heartbeat");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn async_vector_cache_cold_callers_share_parse_and_notice_rewrite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("idx.mxv");
        let mut store = VectorStore {
            model: "synthetic-model".into(),
            dim: 384,
            ..Default::default()
        };
        store.records = (0..10_000)
            .map(|i| {
                let page = format!("wiki/p{i:05}.md");
                let mut vector = vec![0.0; 384];
                vector[i % 384] = 1.0;
                Record {
                    id: format!("{page}#0"),
                    page,
                    stem: format!("p{i:05}"),
                    section: 0,
                    hash: i as u64,
                    vector,
                }
            })
            .collect();
        store.save(&path).unwrap();
        drop(store);
        let cache = VectorCache::default();
        let bytes = std::fs::metadata(&path).unwrap().len();
        let started = std::time::Instant::now();
        let (first, second) =
            tokio::join!(cache.get_async(path.clone()), cache.get_async(path.clone()));
        let (first, second) = (first.unwrap(), second.unwrap());
        eprintln!(
            "synthetic_vector_cache_cold_callers records=10000 dim=384 bytes={bytes} elapsed_ms={:.3}",
            started.elapsed().as_secs_f64() * 1000.0
        );
        assert_eq!(first.records.len(), 10_000);
        assert_eq!(first.dim, 384);
        assert!(
            Arc::ptr_eq(&first, &second),
            "cold callers parsed separate stores"
        );
        assert!(Arc::ptr_eq(&first, &cache.get(&path).unwrap()));

        let mut next = VectorStore::default();
        next.ensure_model("replacement-model");
        next.upsert_page("wiki/new.md", "new", vec![(9, vec![0.0, 1.0])])
            .unwrap();
        next.save(&path).unwrap();
        let replaced = cache.get_async(path.clone()).await.unwrap();
        assert!(!Arc::ptr_eq(&first, &replaced));
        assert_eq!(replaced.model, "replacement-model");
        assert_eq!(replaced.records.len(), 1);
        std::fs::remove_file(&path).unwrap();
        assert!(cache.get_async(path).await.unwrap().records.is_empty());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn async_edge_lookups_share_work_and_keep_revision_identity() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("idx.mxv");
        let mut store = VectorStore::default();
        store.ensure_model("synthetic-model");
        store
            .upsert_page("wiki/a.md", "a", vec![(1, vec![1.0, 0.0])])
            .unwrap();
        store
            .upsert_page("wiki/b.md", "b", vec![(2, vec![1.0, 0.0])])
            .unwrap();
        store.save(&path).unwrap();
        let cache = VectorCache::default();
        let (first, second) = tokio::join!(
            cache.lookup_edges_async(path.clone(), 4),
            cache.lookup_edges_async(path.clone(), 4)
        );
        let (EdgeLookup::Compute(first), EdgeLookup::Compute(second)) =
            (first.unwrap(), second.unwrap())
        else {
            panic!("cold edge lookups must return shared work");
        };
        assert!(Arc::ptr_eq(&first.store, &second.store));
        assert!(Arc::ptr_eq(&first.edges, &second.edges));
        let (first, second) = tokio::join!(
            tauri::async_runtime::spawn_blocking(move || first.compute().unwrap()),
            tauri::async_runtime::spawn_blocking(move || second.compute().unwrap())
        );
        let ((first, built_first), (second, built_second)) = (first.unwrap(), second.unwrap());
        assert_ne!(
            built_first, built_second,
            "one revision computed edges twice"
        );
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(first.len(), 1);
        let EdgeLookup::Ready(warm) = cache.lookup_edges_async(path.clone(), 4).await.unwrap()
        else {
            panic!("computed edge result was not cached");
        };
        assert!(Arc::ptr_eq(&first, &warm));

        store
            .upsert_page("wiki/c.md", "c", vec![(3, vec![1.0, 0.0])])
            .unwrap();
        store.save(&path).unwrap();
        let EdgeLookup::Compute(next) = cache.lookup_edges_async(path, 4).await.unwrap() else {
            panic!("a rewritten revision reused old edge work");
        };
        let (next, built) = tauri::async_runtime::spawn_blocking(move || next.compute().unwrap())
            .await
            .unwrap();
        assert!(built);
        assert!(!Arc::ptr_eq(&first, &next));
        assert_eq!(next.len(), 3);
    }

    #[test]
    fn semantic_map_separates_clusters_and_is_deterministic() {
        // Two tight clusters along one axis + one along another, in 8-dim.
        let mk = |base: [f32; 8], jit: f32, name: &str| {
            (
                name.to_string(),
                base.iter().map(|b| b + jit).collect::<Vec<f32>>(),
            )
        };
        let cents = vec![
            mk([5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], 0.01, "a1"),
            mk([5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], -0.02, "a2"),
            mk([-5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], 0.015, "b1"),
            mk([-5.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], -0.01, "b2"),
            mk([0.0, 4.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], 0.02, "c1"),
            mk([0.0, 4.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], -0.015, "c2"),
        ];
        let pts = semantic_map_points(&cents);
        assert_eq!(pts.len(), 6);
        let at = |n: &str| pts.iter().find(|p| p.page == n).unwrap();
        let d = |a: &SemanticPoint, b: &SemanticPoint| {
            ((a.x - b.x).powi(2) + (a.y - b.y).powi(2)).sqrt()
        };
        // Intra-cluster pairs sit close; inter-cluster pairs sit far.
        assert!(d(at("a1"), at("a2")) < 0.2);
        assert!(d(at("b1"), at("b2")) < 0.2);
        assert!(d(at("a1"), at("b1")) > 0.8);
        assert!(d(at("a1"), at("c1")) > 0.5);
        // Deterministic: a second run produces identical coordinates.
        let pts2 = semantic_map_points(&cents);
        for (p, q) in pts.iter().zip(&pts2) {
            assert_eq!((p.x, p.y, p.z), (q.x, q.y, q.z));
        }
        // Normalised into [-1, 1].
        for p in &pts {
            assert!(p.x >= -1.0 && p.x <= 1.0 && p.y >= -1.0 && p.y <= 1.0);
        }
    }

    #[test]
    fn semantic_map_handles_tiny_inputs() {
        assert!(semantic_map_points(&[]).is_empty());
        let one = semantic_map_points(&[("solo".into(), vec![1.0, 2.0])]);
        assert_eq!(one.len(), 1);
        assert_eq!((one[0].x, one[0].y, one[0].z), (0.0, 0.0, 0.0));
    }

    fn rec(page: &str, sec: usize, v: Vec<f32>) -> Record {
        Record {
            id: format!("{page}#{sec}"),
            page: page.into(),
            stem: page.into(),
            section: sec,
            hash: 0,
            vector: v,
        }
    }

    #[test]
    fn ensure_model_wipes_on_change() {
        let mut s = VectorStore::default();
        s.ensure_model("a");
        s.records.push(rec("p", 0, vec![1.0]));
        s.dim = 1;
        s.ensure_model("a"); // unchanged → keep
        assert_eq!(s.records.len(), 1);
        s.ensure_model("b"); // changed → wipe
        assert!(s.records.is_empty());
        assert_eq!(s.dim, 0);
    }

    #[test]
    fn upsert_replaces_page() {
        let mut s = VectorStore::default();
        s.upsert_page("p.md", "p", vec![(1, vec![1.0, 0.0]), (2, vec![0.0, 1.0])])
            .unwrap();
        assert_eq!(s.records.len(), 2);
        s.upsert_page("p.md", "p", vec![(3, vec![1.0, 1.0])])
            .unwrap();
        assert_eq!(s.records.len(), 1);
        assert_eq!(s.dim, 2);
    }

    #[test]
    fn search_ranks_by_cosine() {
        let mut s = VectorStore::default();
        s.upsert_page("near.md", "near", vec![(1, vec![1.0, 0.0, 0.0])])
            .unwrap();
        s.upsert_page("far.md", "far", vec![(2, vec![0.0, 1.0, 0.0])])
            .unwrap();
        let hits = s.search(&[0.9, 0.1, 0.0], 2).unwrap();
        assert_eq!(hits[0].page, "near.md");
        assert!(hits[0].score > hits[1].score);
    }

    #[test]
    fn related_excludes_self_and_ranks() {
        let mut s = VectorStore::default();
        s.upsert_page("a.md", "a", vec![(1, vec![1.0, 0.0])])
            .unwrap();
        s.upsert_page("b.md", "b", vec![(2, vec![0.9, 0.1])])
            .unwrap(); // close to a
        s.upsert_page("c.md", "c", vec![(3, vec![0.0, 1.0])])
            .unwrap(); // far from a
        let rel = s.related("a.md", 5).unwrap();
        assert_eq!(rel.len(), 2);
        assert_eq!(rel[0].page, "b.md");
        assert!(rel.iter().all(|h| h.page != "a.md"));
    }

    #[test]
    fn centroid_edges_link_similar_pages_undirected() {
        let mut s = VectorStore::default();
        s.upsert_page("a.md", "a", vec![(1, vec![1.0, 0.0])])
            .unwrap();
        s.upsert_page("b.md", "b", vec![(2, vec![0.96, 0.28])])
            .unwrap(); // close to a
        s.upsert_page("c.md", "c", vec![(3, vec![0.0, 1.0])])
            .unwrap(); // far from a

        let edges = s.centroid_edges(1).unwrap();
        // Each page's single best match, deduplicated: a-b (mutual) and b-c
        // (c's best is b, since b leans toward c more than a does).
        assert!(
            edges.iter().all(|e| e.a < e.b),
            "pairs are ordered lexically"
        );
        let pairs: Vec<(&str, &str)> = edges.iter().map(|e| (e.a.as_str(), e.b.as_str())).collect();
        assert!(pairs.contains(&("a.md", "b.md")));
        // No pair appears twice in either direction.
        let mut uniq = pairs.clone();
        uniq.sort_unstable();
        uniq.dedup();
        assert_eq!(uniq.len(), pairs.len());
        // Scores are cosines of unit centroids.
        let ab = edges
            .iter()
            .find(|e| e.a == "a.md" && e.b == "b.md")
            .unwrap();
        assert!((ab.score - 0.96).abs() < 1e-2, "score was {}", ab.score);
    }

    #[test]
    fn centroid_edges_are_deterministic() {
        // HashMap iteration order is not stable across runs; the edge list that
        // reaches the graph must be.
        let mut s = VectorStore::default();
        for i in 0..12 {
            let f = i as f32;
            s.upsert_page(
                &format!("p{i}.md"),
                &format!("p{i}"),
                vec![(i as u64, vec![f.cos(), f.sin()])],
            )
            .unwrap();
        }
        let first = s.centroid_edges(3).unwrap();
        for _ in 0..5 {
            let again = s.centroid_edges(3).unwrap();
            assert_eq!(first.len(), again.len());
            for (x, y) in first.iter().zip(again.iter()) {
                assert_eq!((&x.a, &x.b), (&y.a, &y.b));
            }
        }
    }

    // Original full-sort algorithm, retained only as a ranking oracle/bench.
    fn centroid_edges_reference(store: &VectorStore, k: usize) -> Vec<PageEdge> {
        let cents: Vec<_> = store
            .page_centroids()
            .unwrap()
            .into_iter()
            .filter(|(page, _)| !VectorStore::is_machine_written(page))
            .collect();
        let mut seen = HashSet::new();
        let mut edges = Vec::new();
        for (i, (page, a)) in cents.iter().enumerate() {
            let mut hits: Vec<_> = cents
                .iter()
                .enumerate()
                .filter(|(j, _)| *j != i)
                .map(|(_, (other, b))| (other.as_str(), dot(a, b)))
                .collect();
            hits.sort_by(|x, y| y.1.partial_cmp(&x.1).unwrap_or(std::cmp::Ordering::Equal));
            hits.truncate(k);
            for (other, score) in hits {
                let pair = if page.as_str() < other {
                    (page.as_str(), other)
                } else {
                    (other, page.as_str())
                };
                if seen.insert(pair) {
                    edges.push(PageEdge {
                        a: pair.0.into(),
                        b: pair.1.into(),
                        score,
                    });
                }
            }
        }
        edges
    }

    #[test]
    fn centroid_edges_match_full_sort_including_equal_scores() {
        let mut store = VectorStore::default();
        for i in 0..32 {
            let vector = if i % 3 == 0 {
                vec![1.0, 0.0, 0.0]
            } else {
                vec![(i as f32).sin(), (i as f32).cos(), 0.3]
            };
            store
                .upsert_page(&format!("wiki/p{i:03}.md"), "note", vec![(i, vector)])
                .unwrap();
        }
        for k in [0, 1, 4, 10, 100] {
            let expected = centroid_edges_reference(&store, k);
            let actual = store.centroid_edges(k).unwrap();
            assert_eq!(actual.len(), expected.len(), "k={k}");
            for (a, b) in actual.iter().zip(expected.iter()) {
                assert_eq!((&a.a, &a.b), (&b.a, &b.b), "k={k}");
                assert_eq!(a.score, b.score);
            }
        }
    }

    #[test]
    #[ignore = "synthetic CPU benchmark; run explicitly with --ignored --nocapture"]
    fn centroid_edges_synthetic_benchmark() {
        let mut store = VectorStore::default();
        for i in 0..1_000 {
            let vector = (0..384)
                .map(|d| ((i * 397 + d * 31) as f32).sin())
                .collect();
            store
                .upsert_page(
                    &format!("wiki/p{i:04}.md"),
                    "note",
                    vec![(i as u64, vector)],
                )
                .unwrap();
        }
        let start = std::time::Instant::now();
        let expected = centroid_edges_reference(&store, 4);
        let baseline = start.elapsed();
        let start = std::time::Instant::now();
        let actual = store.centroid_edges(4).unwrap();
        let optimized = start.elapsed();
        assert_eq!(actual.len(), expected.len());
        for (a, b) in actual.iter().zip(expected.iter()) {
            assert_eq!((&a.a, &a.b, a.score), (&b.a, &b.b, b.score));
        }
        eprintln!("synthetic_centroid_edges pages=1000 dim=384 k=4 edges={} baseline_ms={:.2} optimized_ms={:.2}", actual.len(), baseline.as_secs_f64() * 1000.0, optimized.as_secs_f64() * 1000.0);
    }

    #[test]
    fn page_centroid_averages_chunks_and_rejects_bad_widths() {
        let mut s = VectorStore::default();
        // Two chunks either side of the x axis average back onto it.
        s.upsert_page("a.md", "a", vec![(1, vec![1.0, 1.0]), (2, vec![1.0, -1.0])])
            .unwrap();
        let cents = s.page_centroids().unwrap();
        assert_eq!(cents.len(), 1);
        let (page, v) = &cents[0];
        assert_eq!(page, "a.md");
        assert!((v[0] - 1.0).abs() < 1e-6, "centroid was {v:?}");
        assert!(v[1].abs() < 1e-6);
        // A stale malformed record makes the aggregate unavailable; it must
        // not silently change the set of chunks being averaged.
        s.records.push(rec("a.md", 2, Vec::new()));
        assert!(s.page_centroids().is_err());
    }

    #[test]
    fn centroid_edges_empty_for_empty_store() {
        assert!(VectorStore::default().centroid_edges(4).unwrap().is_empty());
    }

    /// What a command does with shared work: compute on a miss, reuse on a
    /// hit. Mirrors semantic_edges so the test exercises the real
    /// shape rather than a convenience wrapper.
    fn edges_via_cache(cache: &VectorCache, path: &Path, k: usize) -> Arc<Vec<PageEdge>> {
        match cache.lookup_edges(path, k).unwrap() {
            EdgeLookup::Ready(e) => e,
            EdgeLookup::Empty => Arc::new(Vec::new()),
            EdgeLookup::Compute(work) => work.compute().unwrap().0,
        }
    }

    #[test]
    fn cache_reuses_edges_and_drops_them_on_rewrite() {
        let dir = scratch("cache-edges");
        let path = dir.join("idx.mxv");
        let mut s = VectorStore::default();
        s.ensure_model("m");
        s.upsert_page("a.md", "a", vec![(1, vec![1.0, 0.0])])
            .unwrap();
        s.upsert_page("b.md", "b", vec![(2, vec![0.9, 0.1])])
            .unwrap();
        s.save(&path).unwrap();

        let cache = VectorCache::default();
        let first = edges_via_cache(&cache, &path, 4);
        assert_eq!(first.len(), 1); // a-b, deduplicated
                                    // Same allocation — the quadratic pass ran once.
        assert!(Arc::ptr_eq(&first, &edges_via_cache(&cache, &path, 4)));
        // A different k is a different question, so it is computed separately.
        assert!(!Arc::ptr_eq(&first, &edges_via_cache(&cache, &path, 1)));

        // A rewritten index invalidates everything derived from the old one.
        let mut next = VectorStore::default();
        next.ensure_model("m");
        next.upsert_page("a.md", "a", vec![(1, vec![1.0, 0.0])])
            .unwrap();
        next.upsert_page("b.md", "b", vec![(2, vec![0.9, 0.1])])
            .unwrap();
        next.upsert_page("c.md", "c", vec![(3, vec![0.0, 1.0])])
            .unwrap();
        next.save(&path).unwrap();
        assert!(edges_via_cache(&cache, &path, 4).len() > first.len());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cache_edges_overlapping_requests_build_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let dir = scratch("cache-edges-overlap");
        let path = dir.join("idx.mxv");
        let mut store = VectorStore::default();
        store.ensure_model("synthetic-model");
        for i in 0..64 {
            store
                .upsert_page(
                    &format!("wiki/p{i:03}.md"),
                    "note",
                    vec![(i, vec![1.0, i as f32])],
                )
                .unwrap();
        }
        store.save(&path).unwrap();
        let cache = Arc::new(VectorCache::default());
        let start = Arc::new(std::sync::Barrier::new(2));
        let builds = Arc::new(AtomicUsize::new(0));
        let workers: Vec<_> = (0..2)
            .map(|_| {
                let (cache, start, builds, path) = (
                    Arc::clone(&cache),
                    Arc::clone(&start),
                    Arc::clone(&builds),
                    path.clone(),
                );
                std::thread::spawn(move || {
                    let found = cache.lookup_edges(&path, 4).unwrap();
                    // Both callers observe the cold revision before either starts
                    // its pass, as Graph and suggestions can do on app startup.
                    start.wait();
                    match found {
                        EdgeLookup::Ready(edges) => edges,
                        EdgeLookup::Empty => panic!("synthetic index should exist"),
                        EdgeLookup::Compute(work) => {
                            let (edges, computed) = work.compute().unwrap();
                            if computed {
                                builds.fetch_add(1, Ordering::SeqCst);
                            }
                            edges
                        }
                    }
                })
            })
            .collect();
        let mut results = workers.into_iter().map(|worker| worker.join().unwrap());
        let first = results.next().unwrap();
        let second = results.next().unwrap();
        assert_eq!(
            builds.load(Ordering::SeqCst),
            1,
            "one unchanged revision must have one quadratic pass"
        );
        assert!(
            Arc::ptr_eq(&first, &second),
            "overlapping requests should share the same derived result"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cache_edges_identical_publication_keeps_derived_result() {
        let dir = scratch("cache-edges-identical-put");
        let path = dir.join("idx.mxv");
        let mut store = VectorStore::default();
        store.ensure_model("synthetic-model");
        store
            .upsert_page("wiki/a.md", "a", vec![(1, vec![1.0, 0.0])])
            .unwrap();
        store
            .upsert_page("wiki/b.md", "b", vec![(2, vec![0.0, 1.0])])
            .unwrap();
        store.save(&path).unwrap();
        let cache = VectorCache::default();
        let first = edges_via_cache(&cache, &path, 4);
        // A no-op reindex publishes an owned copy even when every model,
        // signature and vector record is byte-for-byte unchanged.
        cache.put(&path, VectorStore::load(&path)).unwrap();
        let second = edges_via_cache(&cache, &path, 4);
        assert!(
            Arc::ptr_eq(&first, &second),
            "identical publication forced a quadratic recompute"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cache_edges_vector_and_model_identity_changes_invalidate() {
        let dir = scratch("cache-edges-mutation");
        let path = dir.join("idx.mxv");
        let mut store = VectorStore::default();
        store.ensure_signature("synthetic-model", "weights-v1");
        store
            .upsert_page("wiki/a.md", "a", vec![(1, vec![1.0, 0.0])])
            .unwrap();
        store
            .upsert_page("wiki/b.md", "b", vec![(2, vec![0.0, 1.0])])
            .unwrap();
        store.save(&path).unwrap();
        let cache = VectorCache::default();
        let first = edges_via_cache(&cache, &path, 4);

        // Same paths and content hashes, but changed actual vector geometry.
        store
            .upsert_page("wiki/b.md", "b", vec![(2, vec![1.0, 0.0])])
            .unwrap();
        store.save(&path).unwrap();
        cache.put(&path, VectorStore::load(&path)).unwrap();
        let changed = edges_via_cache(&cache, &path, 4);
        assert!(!Arc::ptr_eq(&first, &changed));
        assert_eq!(first[0].score, 0.0);
        assert_eq!(changed[0].score, 1.0);

        // Identical replacement vectors under a different model signature
        // still belong to a new revision and may not reuse old work.
        store.ensure_signature("synthetic-model", "weights-v2");
        store
            .upsert_page("wiki/a.md", "a", vec![(1, vec![1.0, 0.0])])
            .unwrap();
        store
            .upsert_page("wiki/b.md", "b", vec![(2, vec![1.0, 0.0])])
            .unwrap();
        store.save(&path).unwrap();
        cache.put(&path, VectorStore::load(&path)).unwrap();
        let reloaded = edges_via_cache(&cache, &path, 4);
        assert!(!Arc::ptr_eq(&changed, &reloaded));
        assert_eq!(changed[0].score, reloaded[0].score);

        store.prune(&HashSet::from(["wiki/a.md".to_string()]));
        store.save(&path).unwrap();
        cache.put(&path, store).unwrap();
        assert!(edges_via_cache(&cache, &path, 4).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    #[ignore = "synthetic cache benchmark; run explicitly with --ignored --nocapture"]
    fn cache_edges_repeated_request_benchmark() {
        let dir = scratch("cache-edges-repeat-bench");
        let path = dir.join("idx.mxv");
        let mut store = VectorStore::default();
        store.ensure_model("synthetic-model");
        for i in 0..1_000 {
            let vector = (0..384)
                .map(|d| ((i * 397 + d * 31) as f32).sin())
                .collect();
            store
                .upsert_page(
                    &format!("wiki/p{i:04}.md"),
                    "note",
                    vec![(i as u64, vector)],
                )
                .unwrap();
        }
        store.save(&path).unwrap();
        let encoded = store.encode();
        let cache = VectorCache::default();
        cache.put(&path, store).unwrap();
        let start = std::time::Instant::now();
        let first = edges_via_cache(&cache, &path, 4);
        let cold = start.elapsed();
        let start = std::time::Instant::now();
        for _ in 0..10 {
            assert!(Arc::ptr_eq(&first, &edges_via_cache(&cache, &path, 4)));
        }
        let warm = start.elapsed();
        let start = std::time::Instant::now();
        let mut derived_allocations = 1;
        for _ in 0..3 {
            cache
                .put(&path, VectorStore::decode(&encoded).unwrap())
                .unwrap();
            let next = edges_via_cache(&cache, &path, 4);
            if !Arc::ptr_eq(&first, &next) {
                derived_allocations += 1;
            }
            assert_eq!(next.len(), first.len());
            for (a, b) in next.iter().zip(first.iter()) {
                assert_eq!((&a.a, &a.b, a.score), (&b.a, &b.b, b.score));
            }
        }
        eprintln!("synthetic_edge_cache pages=1000 dim=384 k=4 cold_ms={:.2} warm_10_ms={:.3} identical_put_3_ms={:.2} derived_allocations={derived_allocations}", cold.as_secs_f64() * 1000.0, warm.as_secs_f64() * 1000.0, start.elapsed().as_secs_f64() * 1000.0);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The reason the compute happens outside the lock: edges built from an
    /// index that has since been reindexed must not be filed against the new
    /// one. The pass takes seconds on a large vault, so this window is real.
    #[test]
    fn edges_computed_from_a_superseded_store_are_discarded() {
        let dir = scratch("cache-edges-stale");
        let path = dir.join("idx.mxv");
        let mut s = VectorStore::default();
        s.ensure_model("m");
        s.upsert_page("a.md", "a", vec![(1, vec![1.0, 0.0])])
            .unwrap();
        s.upsert_page("b.md", "b", vec![(2, vec![0.9, 0.1])])
            .unwrap();
        s.save(&path).unwrap();

        let cache = VectorCache::default();
        // A command starts a pass against the store as it is now...
        let EdgeLookup::Compute(old_work) = cache.lookup_edges(&path, 4).unwrap() else {
            panic!("expected a cache miss");
        };

        // ...and a reindex lands before it finishes.
        let mut next = VectorStore::default();
        next.ensure_model("m");
        for i in 0..4 {
            next.upsert_page(
                &format!("n{i}.md"),
                "n",
                vec![(i as u64, vec![1.0, i as f32])],
            )
            .unwrap();
        }
        next.save(&path).unwrap();
        // Fault the new revision in, so the cache is holding a different store.
        let _ = cache.get(&path).unwrap();

        // The old work can finish, but its OnceLock belongs to the superseded
        // entry and must never initialize the new revision's edge cell.
        let (stale, computed) = old_work.compute().unwrap();
        assert!(computed);
        assert_eq!(stale.len(), 1);
        // The stale list must not be served for the new index.
        let fresh = edges_via_cache(&cache, &path, 4);
        assert!(
            fresh
                .iter()
                .all(|e| e.a.starts_with('n') && e.b.starts_with('n')),
            "edges from the superseded index leaked: {:?}",
            fresh.iter().map(|e| (&e.a, &e.b)).collect::<Vec<_>>()
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn hashes_by_page_groups_in_section_order() {
        // Reindex compares this against freshly computed chunk hashes to decide
        // whether a page changed, so both grouping and order have to hold.
        let mut s = VectorStore::default();
        // Metadata fixtures still need admissible, nonzero vectors.
        s.upsert_page("a.md", "a", vec![(11, vec![1.0]), (22, vec![0.5])])
            .unwrap();
        s.upsert_page("b.md", "b", vec![(33, vec![1.0])]).unwrap();
        let by_page = s.hashes_by_page();
        assert_eq!(by_page.len(), 2);
        assert_eq!(by_page["a.md"], vec![11, 22]);
        assert_eq!(by_page["b.md"], vec![33]);
        assert!(!by_page.contains_key("never-indexed.md"));
        assert!(VectorStore::default().hashes_by_page().is_empty());
    }

    #[test]
    fn page_vectors_hands_back_this_pages_vectors_by_hash() {
        // The reuse map behind the chunk-level re-embed skip: only this page's
        // records, keyed by content hash.
        let mut s = VectorStore::default();
        s.upsert_page("a.md", "a", vec![(11, vec![1.0]), (22, vec![0.5])])
            .unwrap();
        s.upsert_page("b.md", "b", vec![(33, vec![0.5])]).unwrap();
        let v = s.page_vectors("a.md");
        assert_eq!(v.len(), 2);
        assert_eq!(v[&11], vec![1.0]);
        assert_eq!(v[&22], vec![0.5]);
        assert!(!v.contains_key(&33));
        assert!(s.page_vectors("never-indexed.md").is_empty());
    }

    #[test]
    fn prune_reports_how_many_records_it_dropped() {
        // reindex uses the count to decide whether a final save is warranted.
        let mut s = VectorStore::default();
        s.upsert_page("keep.md", "keep", vec![(1, vec![1.0])])
            .unwrap();
        s.upsert_page("gone.md", "gone", vec![(2, vec![1.0]), (3, vec![1.0])])
            .unwrap();
        let keep: HashSet<String> = ["keep.md".to_string()].into_iter().collect();
        assert_eq!(s.prune(&keep), 2);
        // Nothing left to drop the second time.
        assert_eq!(s.prune(&keep), 0);
    }

    #[test]
    fn prune_drops_missing_pages() {
        let mut s = VectorStore::default();
        s.upsert_page("keep.md", "keep", vec![(1, vec![1.0])])
            .unwrap();
        s.upsert_page("gone.md", "gone", vec![(2, vec![1.0])])
            .unwrap();
        let keep: HashSet<String> = ["keep.md".to_string()].into_iter().collect();
        s.prune(&keep);
        assert_eq!(s.indexed_pages(), 1);
        assert!(s.records.iter().all(|r| r.page == "keep.md"));
    }

    /// A unique scratch dir per test — these touch the filesystem and run in
    /// parallel with each other.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("memex-vec-test-{}-{tag}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Two saves racing on the same index must never leave a torn file: the
    /// temp path used to be a fixed `<stem>.mxv.tmp`, so one writer could rename
    /// the other writer's half-written bytes into place.
    #[test]
    fn concurrent_saves_never_leave_a_torn_index() {
        let dir = scratch("save-race");
        let path = dir.join("idx.mxv");

        // Two stores big enough that a write is not one syscall's worth of
        // bytes, and distinguishable by their record count.
        // Sized so a write is many megabytes — the race window is however long
        // fs::write takes, and a small payload closes it before the other thread
        // is scheduled.
        let build = |n: usize, tag: u64| {
            let mut s = VectorStore::default();
            s.ensure_model("m");
            for i in 0..n {
                s.upsert_page(&format!("p{i}.md"), "p", vec![(tag, vec![0.5; 1152])])
                    .unwrap();
            }
            s
        };
        let a = build(2_000, 1);
        let b = build(4_000, 2);

        // Tuned so this actually catches the bug rather than decorating it:
        // with 2 writers it passes against the broken code in a debug build
        // (the threads stagger and never overlap) and only fails under
        // --release, which `cargo test` does not run. 8 writers x 4 rounds
        // fails 5/5 against the broken code in a plain debug `cargo test`.
        for _ in 0..4 {
            // A barrier so every writer really is inside save() at once —
            // without it each thread finishes before the next is scheduled and
            // the race never happens.
            const WRITERS: usize = 8;
            let gate = std::sync::Barrier::new(WRITERS);
            let results: Vec<Result<(), String>> = std::thread::scope(|sc| {
                let handles: Vec<_> = (0..WRITERS)
                    .map(|i| {
                        let store = if i % 2 == 0 { &a } else { &b };
                        let gate = &gate;
                        let path = &path;
                        sc.spawn(move || {
                            gate.wait();
                            store.save(path)
                        })
                    })
                    .collect();
                handles.into_iter().map(|h| h.join().unwrap()).collect()
            });
            // A save that did all its work must not report failure — the caller
            // (reindex) treats that as losing the whole run.
            for r in &results {
                assert!(
                    r.is_ok(),
                    "a save failed while another was in flight: {r:?}"
                );
            }
            // Whoever won, the file on disk must be a COMPLETE index — one of
            // the two, never a mixture.
            let loaded = VectorStore::load(&path);
            assert!(
                loaded.records.len() == 2_000 || loaded.records.len() == 4_000,
                "torn index: {} records (expected one writer's whole store)",
                loaded.records.len()
            );
        }
        // No temp files left behind.
        let strays: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("tmp"))
            .collect();
        assert!(strays.is_empty(), "left temp files behind: {strays:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn roundtrip_save_load() {
        let mut s = VectorStore::default();
        s.ensure_model("m");
        s.upsert_page("p.md", "p", vec![(7, vec![0.1, 0.2, 0.3])])
            .unwrap();
        let dir = scratch("roundtrip");
        let path = dir.join("idx.mxv");
        s.save(&path).unwrap();
        let loaded = VectorStore::load(&path);
        assert_eq!(loaded.model, "m");
        assert_eq!(loaded.dim, 3);
        assert_eq!(loaded.records.len(), 1);
        assert_eq!(loaded.records[0].hash, 7);
        assert_eq!(loaded.records[0].id, "p.md#0");
        assert_eq!(loaded.records[0].page, "p.md");
        assert_eq!(loaded.records[0].stem, "p");
        // f32s survive the binary format exactly — no decimal-text rounding.
        assert_eq!(loaded.records[0].vector, vec![0.1, 0.2, 0.3]);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn save_writes_binary_not_json() {
        let mut s = VectorStore::default();
        s.ensure_model("m");
        s.upsert_page("p.md", "p", vec![(1, vec![1.0, 0.0])])
            .unwrap();
        let dir = scratch("format");
        let path = dir.join("idx.mxv");
        s.save(&path).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(&bytes[..4], MAGIC);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_reads_legacy_json_index_and_save_replaces_it() {
        // An index written before the binary format must survive the upgrade
        // rather than silently reading as "not indexed yet".
        let dir = scratch("legacy");
        let path = dir.join("idx.mxv");
        let legacy = dir.join("idx.json");
        let mut old = VectorStore::default();
        old.ensure_model("m");
        old.upsert_page("p.md", "p", vec![(9, vec![0.5, 0.5])])
            .unwrap();
        std::fs::write(&legacy, serde_json::to_vec(&old).unwrap()).unwrap();

        let loaded = VectorStore::load(&path);
        assert_eq!(loaded.records.len(), 1);
        assert_eq!(loaded.records[0].hash, 9);

        // Saving rewrites in binary and clears the superseded JSON.
        loaded.save(&path).unwrap();
        assert!(path.is_file());
        assert!(!legacy.exists(), "stale JSON index must not be left behind");
        assert_eq!(VectorStore::load(&path).records[0].hash, 9);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn decode_rejects_corrupt_input_without_panicking() {
        // The index is a file on disk: it can be truncated by a full volume,
        // corrupted, or be something else entirely. None of that may panic.
        assert!(VectorStore::decode(b"").is_none());
        assert!(VectorStore::decode(b"XXXX").is_none()); // bad magic
        assert!(VectorStore::decode(b"MXV1").is_none()); // header cut short
        assert!(VectorStore::decode(b"{\"model\":\"m\"}").is_none()); // JSON, not binary

        let mut s = VectorStore::default();
        s.ensure_model("m");
        s.upsert_page("p.md", "p", vec![(1, vec![1.0, 0.0, 0.0])])
            .unwrap();
        let good = s.encode();
        assert!(VectorStore::decode(&good).is_some());
        // Every truncation of a valid file is rejected, never partially read.
        for cut in 1..good.len() {
            assert!(
                VectorStore::decode(&good[..cut]).is_none(),
                "truncation at {cut} must not decode"
            );
        }
        // A record count that would outrun the buffer must not drive a huge
        // allocation before it is caught.
        let mut bogus = good.clone();
        bogus[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(VectorStore::decode(&bogus).is_none());
    }

    #[test]
    fn load_falls_back_to_empty_for_unreadable_index() {
        let dir = scratch("garbage");
        let path = dir.join("idx.mxv");
        std::fs::write(&path, b"not an index at all").unwrap();
        // Degrades to "not indexed yet" — reindexing rebuilds it.
        assert!(VectorStore::load(&path).records.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cache_reuses_parse_and_notices_a_rewrite() {
        let dir = scratch("cache");
        let path = dir.join("idx.mxv");
        let mut s = VectorStore::default();
        s.ensure_model("m");
        s.upsert_page("a.md", "a", vec![(1, vec![1.0, 0.0])])
            .unwrap();
        s.save(&path).unwrap();

        let cache = VectorCache::default();
        let first = cache.get(&path).unwrap();
        let second = cache.get(&path).unwrap();
        assert_eq!(first.records.len(), 1);
        // Same allocation — the second call did not re-parse the file.
        assert!(Arc::ptr_eq(&first, &second));

        // A rewrite behind the cache's back is picked up, not served stale.
        let mut next = VectorStore::default();
        next.ensure_model("m");
        next.upsert_page("a.md", "a", vec![(1, vec![1.0, 0.0])])
            .unwrap();
        next.upsert_page("b.md", "b", vec![(2, vec![0.0, 1.0])])
            .unwrap();
        // mtime has second-or-better granularity but is not guaranteed to tick
        // between two writes this close together; the length differs, which the
        // fingerprint also covers.
        next.save(&path).unwrap();
        assert_eq!(cache.get(&path).unwrap().records.len(), 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cache_does_not_pin_empty_before_the_index_exists() {
        // Regression: keying freshness on "no file" would cache the empty store
        // and keep serving it after the first reindex wrote one.
        let dir = scratch("cache-empty");
        let path = dir.join("idx.mxv");
        let cache = VectorCache::default();
        assert!(cache.get(&path).unwrap().records.is_empty());

        let mut s = VectorStore::default();
        s.ensure_model("m");
        s.upsert_page("a.md", "a", vec![(1, vec![1.0, 0.0])])
            .unwrap();
        s.save(&path).unwrap();
        assert_eq!(cache.get(&path).unwrap().records.len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cache_put_adopts_a_freshly_written_store() {
        let dir = scratch("cache-put");
        let path = dir.join("idx.mxv");
        let mut s = VectorStore::default();
        s.ensure_model("m");
        s.upsert_page("a.md", "a", vec![(1, vec![1.0, 0.0])])
            .unwrap();
        s.save(&path).unwrap();

        let cache = VectorCache::default();
        cache.put(&path, s).unwrap();
        let got = cache.get(&path).unwrap();
        assert_eq!(got.records.len(), 1);
        // The adopted entry is fresh, so get() served it rather than re-reading.
        assert!(Arc::ptr_eq(&got, &cache.get(&path).unwrap()));
        std::fs::remove_dir_all(&dir).ok();
    }
}

#[cfg(test)]
mod suggestion_scope_tests {
    use super::*;

    fn store_with(pages: &[&str]) -> VectorStore {
        let mut s = VectorStore {
            dim: 2,
            ..Default::default()
        };
        for (i, p) in pages.iter().enumerate() {
            s.records.push(Record {
                id: format!("{p}#0"),
                page: (*p).to_string(),
                stem: p.rsplit('/').next().unwrap_or(p).to_string(),
                section: 0,
                hash: i as u64,
                vector: vec![1.0, i as f32 * 0.01],
            });
        }
        s
    }

    #[test]
    fn link_suggestions_never_offer_machine_written_pages() {
        // The real vault is 98% swept sessions, so before this every suggestion
        // was a pair of UUID filenames the user could not act on.
        let s = store_with(&[
            "wiki/attention.md",
            "wiki/transformers.md",
            "sessions/codex-019fdc04.md",
            "sessions/codex-019fdc05.md",
            "_inbox/dropped.md",
            "raw/paper.md",
            "ingest-reports/2026-08-01.md",
            "daily/2026-08-10.md",
        ]);
        let edges = s.centroid_edges(4).unwrap();
        assert!(!edges.is_empty(), "the two wiki pages should still pair up");
        for e in &edges {
            for p in [&e.a, &e.b] {
                assert!(
                    p.starts_with("wiki/"),
                    "machine-written page leaked into a suggestion: {p}"
                );
            }
        }
    }

    #[test]
    fn a_vault_of_only_machine_pages_suggests_nothing_rather_than_noise() {
        let s = store_with(&["sessions/a.md", "sessions/b.md", "raw/c.md"]);
        assert!(s.centroid_edges(4).unwrap().is_empty());
    }

    #[test]
    fn cold_pages_are_excluded_and_pruned() {
        assert!(is_cold("raw/archive/2026-08/x.md"));
        assert!(is_cold("_inbox/quarantine/y.md"));
        assert!(is_cold(".myco/ontology.json"));
        assert!(is_cold("sessions/archive/2026-08/x.md"));
        assert!(is_cold("daily/archive/2026-W33/2026-08-10.md"));
        assert!(!is_cold("raw/x.md"));
        assert!(!is_cold("_inbox/y.md"));
        assert!(!is_cold("wiki/a.md"));
        assert!(!is_cold("sessions/2026-08/x.md"));
        assert!(!is_cold("daily/2026-08-10.md"));
        assert!(!is_cold("weekly/2026-W33.md"));

        // Opt-in archived sessions: only that one prefix thaws.
        assert!(is_cold_for("sessions/archive/2026-08/x.md", false));
        assert!(!is_cold_for("sessions/archive/2026-08/x.md", true));
        assert!(is_cold_for("raw/archive/2026-08/x.md", true));
        assert!(is_cold_for("daily/archive/2026-W33/2026-08-10.md", true));
        assert!(is_cold_for("_inbox/quarantine/y.md", true));
        assert!(!is_cold_for("sessions/2026-08/x.md", true));

        let mut s = store_with(&["wiki/a.md", "raw/archive/2026-08/x.md"]);
        let existing: HashSet<String> = ["wiki/a.md", "raw/archive/2026-08/x.md"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let live: HashSet<String> = existing.iter().filter(|p| !is_cold(p)).cloned().collect();
        s.prune(&live);
        assert!(s.records.iter().all(|r| r.page == "wiki/a.md"));
    }
}
