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
use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::embeddings::{cosine, dot, normalize};

/// Magic + version. A version bump invalidates the file rather than attempting a
/// migration: the index is a derived cache and reindexing rebuilds it.
const MAGIC: &[u8; 4] = b"MXV1";

/// One embedded chunk. `id` = "<page>#<section>". `hash` is the chunk's content
/// hash so re-indexing can skip unchanged text.
#[derive(Clone, Serialize, Deserialize)]
pub struct Record {
    pub id: String,
    pub page: String, // vault-relative path
    pub stem: String, // page stem for citation/link
    pub section: usize,
    pub hash: u64,
    pub vector: Vec<f32>,
}

#[derive(Default, Serialize, Deserialize)]
pub struct VectorStore {
    pub model: String, // embedding model id; a change wipes the index (dim/geometry differ)
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

impl VectorStore {
    /// Index file path for a given vault root, under `<app-data>/embeddings/`.
    pub fn path_for(vault_root: &str) -> Result<PathBuf, String> {
        let mut h = DefaultHasher::new();
        vault_root.hash(&mut h);
        let dir = crate::settings::settings_dir()?.join("embeddings");
        std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir embeddings: {e}"))?;
        Ok(dir.join(format!("{:016x}.mxv", h.finish())))
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
                    return store;
                }
            }
        }
        Self::default()
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        let bytes = self.encode();
        // Atomic-ish write: temp + rename, so a crash mid-write cannot leave a
        // half-written index in place.
        let tmp = path.with_extension("mxv.tmp");
        std::fs::write(&tmp, &bytes).map_err(|e| format!("write index: {e}"))?;
        std::fs::rename(&tmp, path).map_err(|e| format!("rename index: {e}"))?;
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
        let mut out = Vec::with_capacity(16 + self.records.len() * (self.dim * 4 + 64));
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&(self.dim as u32).to_le_bytes());
        out.extend_from_slice(&(self.records.len() as u32).to_le_bytes());
        put_str(&mut out, &self.model);
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
        if c.take(4)? != MAGIC {
            return None;
        }
        let dim = c.u32()? as usize;
        let n = c.u32()? as usize;
        let model = c.string()?;
        // Reject an impossible record count before reserving for it, so a
        // corrupt length field cannot drive a huge allocation.
        if n.checked_mul(dim.checked_mul(4)?)? > bytes.len() {
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
            records.push(Record { id, page, stem, section, hash, vector });
        }
        Some(VectorStore { model, dim, records })
    }

    /// Switch embedding model — a different model means incompatible vectors, so
    /// wipe everything and start fresh. No-op when the model is unchanged.
    pub fn ensure_model(&mut self, model: &str) {
        if self.model != model {
            self.model = model.to_string();
            self.dim = 0;
            self.records.clear();
        }
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
        let mut out: std::collections::HashMap<String, Vec<u64>> =
            std::collections::HashMap::new();
        for r in &self.records {
            out.entry(r.page.clone()).or_default().push(r.hash);
        }
        out
    }

    /// Replace all records for one page with a fresh set.
    pub fn upsert_page(&mut self, page: &str, stem: &str, chunks: Vec<(u64, Vec<f32>)>) {
        self.records.retain(|r| r.page != page);
        for (i, (hash, vector)) in chunks.into_iter().enumerate() {
            if self.dim == 0 {
                self.dim = vector.len();
            }
            self.records.push(Record {
                id: format!("{page}#{i}"),
                page: page.to_string(),
                stem: stem.to_string(),
                section: i,
                hash,
                vector,
            });
        }
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
    pub fn search(&self, query: &[f32], k: usize) -> Vec<Hit> {
        let mut scored: Vec<Hit> = self
            .records
            .iter()
            .map(|r| Hit {
                page: r.page.clone(),
                stem: r.stem.clone(),
                section: r.section,
                score: cosine(query, &r.vector),
            })
            .collect();
        scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        scored.truncate(k);
        scored
    }

    /// One unit vector per page: the mean of its chunk vectors, renormalized.
    /// Sorted by page so everything derived from it is deterministic.
    pub fn page_centroids(&self) -> Vec<(String, Vec<f32>)> {
        use std::collections::HashMap;
        if self.dim == 0 {
            return Vec::new();
        }
        let mut acc: HashMap<&str, (Vec<f32>, usize)> = HashMap::new();
        for r in &self.records {
            // A width that disagrees with the index would corrupt the running
            // mean. Nothing on today's write paths produces one — the tokenizer
            // always emits at least a BOS — but the index is a file on disk, and
            // a stale record must not silently skew a centroid.
            if r.vector.len() != self.dim {
                continue;
            }
            let e = acc
                .entry(r.page.as_str())
                .or_insert_with(|| (vec![0.0; self.dim], 0));
            for (i, x) in r.vector.iter().enumerate() {
                e.0[i] += x;
            }
            e.1 += 1;
        }
        let mut out: Vec<(String, Vec<f32>)> = acc
            .into_iter()
            .map(|(page, (mut v, n))| {
                for x in v.iter_mut() {
                    *x /= n as f32;
                }
                // The mean of unit vectors is not itself a unit vector; renormalize
                // so a plain dot product is the cosine between two pages.
                normalize(&mut v);
                (page.to_string(), v)
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
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
    pub fn centroid_edges(&self, k: usize) -> Vec<PageEdge> {
        let cents = self.page_centroids();
        let mut seen: HashSet<(&str, &str)> = HashSet::new();
        let mut out = Vec::new();
        for (i, (page, a)) in cents.iter().enumerate() {
            let mut hits: Vec<(&str, f32)> = cents
                .iter()
                .enumerate()
                .filter(|(j, _)| *j != i)
                .map(|(_, (other, b))| (other.as_str(), dot(a, b)))
                .collect();
            hits.sort_by(|x, y| y.1.partial_cmp(&x.1).unwrap_or(std::cmp::Ordering::Equal));
            hits.truncate(k);
            for (other, score) in hits {
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
        out
    }

    /// Pages most similar to `page`, best-chunk-vs-best-chunk, excluding itself.
    /// Returns one hit per page, ranked.
    pub fn related(&self, page: &str, k: usize) -> Vec<Hit> {
        let self_vecs: Vec<&Vec<f32>> = self
            .records
            .iter()
            .filter(|r| r.page == page)
            .map(|r| &r.vector)
            .collect();
        if self_vecs.is_empty() {
            return Vec::new();
        }
        use std::collections::HashMap;
        let mut best: HashMap<&str, Hit> = HashMap::new();
        for r in &self.records {
            if r.page == page {
                continue;
            }
            let score = self_vecs
                .iter()
                .map(|sv| cosine(sv, &r.vector))
                .fold(0.0f32, f32::max);
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
        hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        hits.truncate(k);
        hits
    }
}

/// Identity of the index file as it is right now: modified time and length.
/// Cheap (one `stat`) next to the parse it guards.
fn fingerprint(path: &Path) -> Option<(std::time::SystemTime, u64)> {
    let meta = std::fs::metadata(path)
        .or_else(|_| std::fs::metadata(VectorStore::legacy_json_path(path)))
        .ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

struct CacheEntry {
    path: PathBuf,
    fingerprint: (std::time::SystemTime, u64),
    store: Arc<VectorStore>,
    /// Edge lists derived from `store`, keyed by `k`. Tied to this entry's
    /// lifetime, so they cannot outlive the index revision they came from.
    edges: std::collections::HashMap<usize, Arc<Vec<PageEdge>>>,
}

/// Replace the entry unless it already holds this exact revision of `path`.
/// Returns `None` when there is no index file to key freshness on.
fn ensure_fresh<'a>(
    slot: &'a mut Option<CacheEntry>,
    path: &Path,
) -> Option<&'a mut CacheEntry> {
    let fp = fingerprint(path)?;
    let hit = slot
        .as_ref()
        .is_some_and(|e| e.path == *path && e.fingerprint == fp);
    if !hit {
        *slot = Some(CacheEntry {
            path: path.to_path_buf(),
            fingerprint: fp,
            store: Arc::new(VectorStore::load(path)),
            edges: std::collections::HashMap::new(),
        });
    }
    slot.as_mut()
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
/// Freshness is checked against the file's mtime+length rather than trusted, so
/// an index rewritten by anything other than this cache — a future sidecar, a
/// restored backup, the user deleting the file — is picked up rather than served
/// stale. `reindex_embeddings` additionally seeds the entry with the store it
/// just built, so the rebuild never pays a reload.
#[derive(Default)]
pub struct VectorCache {
    inner: Mutex<Option<CacheEntry>>,
}

impl VectorCache {
    /// The index for `path`, parsed at most once per on-disk revision.
    pub fn get(&self, path: &Path) -> Arc<VectorStore> {
        // Held across the load: the parse is the expensive thing being cached,
        // and serializing concurrent first-callers is better than having each
        // of them parse the same file. No await happens under this guard.
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        match ensure_fresh(&mut guard, path) {
            Some(entry) => Arc::clone(&entry.store),
            // No file on disk: return an empty store *uncached*, since there is
            // nothing to key freshness on. Caching it would pin "empty" past the
            // first reindex.
            None => Arc::new(VectorStore::default()),
        }
    }

    /// Top-`k` semantic edges for `path`, computed once per index revision.
    ///
    /// The graph builds these on mount and again on every toggle of the semantic
    /// overlay, and the link-suggestions panel asks for the same `k` — all of
    /// which would otherwise redo a quadratic pass over the vault (114 ms at 300
    /// pages, and it grows with the square of the page count).
    pub fn edges(&self, path: &Path, k: usize) -> Arc<Vec<PageEdge>> {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let Some(entry) = ensure_fresh(&mut guard, path) else {
            return Arc::new(Vec::new());
        };
        if let Some(cached) = entry.edges.get(&k) {
            return Arc::clone(cached);
        }
        let edges = Arc::new(entry.store.centroid_edges(k));
        entry.edges.insert(k, Arc::clone(&edges));
        edges
    }

    /// Adopt a store this process just wrote, so the writer's own work is reused
    /// instead of being re-read from the file it came from.
    pub fn put(&self, path: &Path, store: VectorStore) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        *guard = fingerprint(path).map(|fp| CacheEntry {
            path: path.to_path_buf(),
            fingerprint: fp,
            store: Arc::new(store),
            // The new store invalidates anything derived from the old one.
            edges: std::collections::HashMap::new(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        s.upsert_page("p.md", "p", vec![(1, vec![1.0, 0.0]), (2, vec![0.0, 1.0])]);
        assert_eq!(s.records.len(), 2);
        s.upsert_page("p.md", "p", vec![(3, vec![1.0, 1.0])]);
        assert_eq!(s.records.len(), 1);
        assert_eq!(s.dim, 2);
    }

    #[test]
    fn search_ranks_by_cosine() {
        let mut s = VectorStore::default();
        s.upsert_page("near.md", "near", vec![(1, vec![1.0, 0.0, 0.0])]);
        s.upsert_page("far.md", "far", vec![(2, vec![0.0, 1.0, 0.0])]);
        let hits = s.search(&[0.9, 0.1, 0.0], 2);
        assert_eq!(hits[0].page, "near.md");
        assert!(hits[0].score > hits[1].score);
    }

    #[test]
    fn related_excludes_self_and_ranks() {
        let mut s = VectorStore::default();
        s.upsert_page("a.md", "a", vec![(1, vec![1.0, 0.0])]);
        s.upsert_page("b.md", "b", vec![(2, vec![0.9, 0.1])]); // close to a
        s.upsert_page("c.md", "c", vec![(3, vec![0.0, 1.0])]); // far from a
        let rel = s.related("a.md", 5);
        assert_eq!(rel.len(), 2);
        assert_eq!(rel[0].page, "b.md");
        assert!(rel.iter().all(|h| h.page != "a.md"));
    }

    #[test]
    fn centroid_edges_link_similar_pages_undirected() {
        let mut s = VectorStore::default();
        s.upsert_page("a.md", "a", vec![(1, vec![1.0, 0.0])]);
        s.upsert_page("b.md", "b", vec![(2, vec![0.96, 0.28])]); // close to a
        s.upsert_page("c.md", "c", vec![(3, vec![0.0, 1.0])]); // far from a

        let edges = s.centroid_edges(1);
        // Each page's single best match, deduplicated: a-b (mutual) and b-c
        // (c's best is b, since b leans toward c more than a does).
        assert!(edges.iter().all(|e| e.a < e.b), "pairs are ordered lexically");
        let pairs: Vec<(&str, &str)> =
            edges.iter().map(|e| (e.a.as_str(), e.b.as_str())).collect();
        assert!(pairs.contains(&("a.md", "b.md")));
        // No pair appears twice in either direction.
        let mut uniq = pairs.clone();
        uniq.sort_unstable();
        uniq.dedup();
        assert_eq!(uniq.len(), pairs.len());
        // Scores are cosines of unit centroids.
        let ab = edges.iter().find(|e| e.a == "a.md" && e.b == "b.md").unwrap();
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
            );
        }
        let first = s.centroid_edges(3);
        for _ in 0..5 {
            let again = s.centroid_edges(3);
            assert_eq!(first.len(), again.len());
            for (x, y) in first.iter().zip(again.iter()) {
                assert_eq!((&x.a, &x.b), (&y.a, &y.b));
            }
        }
    }

    #[test]
    fn page_centroid_averages_chunks_and_ignores_bad_widths() {
        let mut s = VectorStore::default();
        // Two chunks either side of the x axis average back onto it.
        s.upsert_page("a.md", "a", vec![(1, vec![1.0, 1.0]), (2, vec![1.0, -1.0])]);
        // A record whose width disagrees with the index (a stale or
        // hand-edited file) must not corrupt the mean or panic.
        s.records.push(rec("a.md", 2, Vec::new()));
        let cents = s.page_centroids();
        assert_eq!(cents.len(), 1);
        let (page, v) = &cents[0];
        assert_eq!(page, "a.md");
        assert!((v[0] - 1.0).abs() < 1e-6, "centroid was {v:?}");
        assert!(v[1].abs() < 1e-6);
    }

    #[test]
    fn centroid_edges_empty_for_empty_store() {
        assert!(VectorStore::default().centroid_edges(4).is_empty());
    }

    #[test]
    fn cache_reuses_edges_and_drops_them_on_rewrite() {
        let dir = scratch("cache-edges");
        let path = dir.join("idx.mxv");
        let mut s = VectorStore::default();
        s.ensure_model("m");
        s.upsert_page("a.md", "a", vec![(1, vec![1.0, 0.0])]);
        s.upsert_page("b.md", "b", vec![(2, vec![0.9, 0.1])]);
        s.save(&path).unwrap();

        let cache = VectorCache::default();
        let first = cache.edges(&path, 4);
        assert_eq!(first.len(), 1); // a-b, deduplicated
        // Same allocation — the quadratic pass ran once.
        assert!(Arc::ptr_eq(&first, &cache.edges(&path, 4)));
        // A different k is a different question, so it is computed separately.
        assert!(!Arc::ptr_eq(&first, &cache.edges(&path, 1).clone()));

        // A rewritten index invalidates everything derived from the old one.
        let mut next = VectorStore::default();
        next.ensure_model("m");
        next.upsert_page("a.md", "a", vec![(1, vec![1.0, 0.0])]);
        next.upsert_page("b.md", "b", vec![(2, vec![0.9, 0.1])]);
        next.upsert_page("c.md", "c", vec![(3, vec![0.0, 1.0])]);
        next.save(&path).unwrap();
        assert!(cache.edges(&path, 4).len() > first.len());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn hashes_by_page_groups_in_section_order() {
        // Reindex compares this against freshly computed chunk hashes to decide
        // whether a page changed, so both grouping and order have to hold.
        let mut s = VectorStore::default();
        s.upsert_page("a.md", "a", vec![(11, vec![1.0]), (22, vec![0.0])]);
        s.upsert_page("b.md", "b", vec![(33, vec![1.0])]);
        let by_page = s.hashes_by_page();
        assert_eq!(by_page.len(), 2);
        assert_eq!(by_page["a.md"], vec![11, 22]);
        assert_eq!(by_page["b.md"], vec![33]);
        assert!(!by_page.contains_key("never-indexed.md"));
        assert!(VectorStore::default().hashes_by_page().is_empty());
    }

    #[test]
    fn prune_reports_how_many_records_it_dropped() {
        // reindex uses the count to decide whether a final save is warranted.
        let mut s = VectorStore::default();
        s.upsert_page("keep.md", "keep", vec![(1, vec![1.0])]);
        s.upsert_page("gone.md", "gone", vec![(2, vec![1.0]), (3, vec![1.0])]);
        let keep: HashSet<String> = ["keep.md".to_string()].into_iter().collect();
        assert_eq!(s.prune(&keep), 2);
        // Nothing left to drop the second time.
        assert_eq!(s.prune(&keep), 0);
    }

    #[test]
    fn prune_drops_missing_pages() {
        let mut s = VectorStore::default();
        s.upsert_page("keep.md", "keep", vec![(1, vec![1.0])]);
        s.upsert_page("gone.md", "gone", vec![(2, vec![1.0])]);
        let keep: HashSet<String> = ["keep.md".to_string()].into_iter().collect();
        s.prune(&keep);
        assert_eq!(s.indexed_pages(), 1);
        assert!(s.records.iter().all(|r| r.page == "keep.md"));
    }

    /// A unique scratch dir per test — these touch the filesystem and run in
    /// parallel with each other.
    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("memex-vec-test-{}-{tag}", std::process::id()));
        std::fs::remove_dir_all(&dir).ok();
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn roundtrip_save_load() {
        let mut s = VectorStore::default();
        s.ensure_model("m");
        s.upsert_page("p.md", "p", vec![(7, vec![0.1, 0.2, 0.3])]);
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
        s.upsert_page("p.md", "p", vec![(1, vec![1.0, 0.0])]);
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
        old.upsert_page("p.md", "p", vec![(9, vec![0.5, 0.5])]);
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
        s.upsert_page("p.md", "p", vec![(1, vec![1.0, 0.0, 0.0])]);
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
        s.upsert_page("a.md", "a", vec![(1, vec![1.0, 0.0])]);
        s.save(&path).unwrap();

        let cache = VectorCache::default();
        let first = cache.get(&path);
        let second = cache.get(&path);
        assert_eq!(first.records.len(), 1);
        // Same allocation — the second call did not re-parse the file.
        assert!(Arc::ptr_eq(&first, &second));

        // A rewrite behind the cache's back is picked up, not served stale.
        let mut next = VectorStore::default();
        next.ensure_model("m");
        next.upsert_page("a.md", "a", vec![(1, vec![1.0, 0.0])]);
        next.upsert_page("b.md", "b", vec![(2, vec![0.0, 1.0])]);
        // mtime has second-or-better granularity but is not guaranteed to tick
        // between two writes this close together; the length differs, which the
        // fingerprint also covers.
        next.save(&path).unwrap();
        assert_eq!(cache.get(&path).records.len(), 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cache_does_not_pin_empty_before_the_index_exists() {
        // Regression: keying freshness on "no file" would cache the empty store
        // and keep serving it after the first reindex wrote one.
        let dir = scratch("cache-empty");
        let path = dir.join("idx.mxv");
        let cache = VectorCache::default();
        assert!(cache.get(&path).records.is_empty());

        let mut s = VectorStore::default();
        s.ensure_model("m");
        s.upsert_page("a.md", "a", vec![(1, vec![1.0, 0.0])]);
        s.save(&path).unwrap();
        assert_eq!(cache.get(&path).records.len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cache_put_adopts_a_freshly_written_store() {
        let dir = scratch("cache-put");
        let path = dir.join("idx.mxv");
        let mut s = VectorStore::default();
        s.ensure_model("m");
        s.upsert_page("a.md", "a", vec![(1, vec![1.0, 0.0])]);
        s.save(&path).unwrap();

        let cache = VectorCache::default();
        cache.put(&path, s);
        let got = cache.get(&path);
        assert_eq!(got.records.len(), 1);
        // The adopted entry is fresh, so get() served it rather than re-reading.
        assert!(Arc::ptr_eq(&got, &cache.get(&path)));
        std::fs::remove_dir_all(&dir).ok();
    }
}
