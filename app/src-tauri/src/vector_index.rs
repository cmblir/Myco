//! On-disk brute-force vector store for the semantic layer (Feature 1).
//!
//! A per-vault JSON file of `{model, dim, records}` under the app data dir. Search
//! is a linear cosine scan — trivial for a personal vault (≤~10k pages) and keeps
//! the index a plain, rebuildable file (no lock-in, no heavy DB dependency). The
//! public surface is deliberately backend-agnostic so a LanceDB/ANN backend can
//! replace the internals later without touching callers.

use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;

use crate::embeddings::cosine;

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
        Ok(dir.join(format!("{:016x}.json", h.finish())))
    }

    pub fn load(path: &PathBuf) -> Self {
        std::fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, path: &PathBuf) -> Result<(), String> {
        let bytes = serde_json::to_vec(self).map_err(|e| format!("serialize index: {e}"))?;
        // Atomic-ish write: temp + rename.
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, &bytes).map_err(|e| format!("write index: {e}"))?;
        std::fs::rename(&tmp, path).map_err(|e| format!("rename index: {e}"))?;
        Ok(())
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

    /// Content hashes already stored for a page (so the caller can skip embedding
    /// chunks whose text is unchanged).
    pub fn hashes_for(&self, page: &str) -> Vec<u64> {
        self.records
            .iter()
            .filter(|r| r.page == page)
            .map(|r| r.hash)
            .collect()
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

    /// Drop records for pages no longer present in the vault.
    pub fn prune(&mut self, existing: &HashSet<String>) {
        self.records.retain(|r| existing.contains(&r.page));
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
    fn prune_drops_missing_pages() {
        let mut s = VectorStore::default();
        s.upsert_page("keep.md", "keep", vec![(1, vec![1.0])]);
        s.upsert_page("gone.md", "gone", vec![(2, vec![1.0])]);
        let keep: HashSet<String> = ["keep.md".to_string()].into_iter().collect();
        s.prune(&keep);
        assert_eq!(s.indexed_pages(), 1);
        assert!(s.records.iter().all(|r| r.page == "keep.md"));
    }

    #[test]
    fn roundtrip_save_load() {
        let mut s = VectorStore::default();
        s.ensure_model("m");
        s.upsert_page("p.md", "p", vec![(7, vec![0.1, 0.2, 0.3])]);
        let dir = std::env::temp_dir().join(format!("memex-vec-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("idx.json");
        s.save(&path).unwrap();
        let loaded = VectorStore::load(&path);
        assert_eq!(loaded.model, "m");
        assert_eq!(loaded.records.len(), 1);
        assert_eq!(loaded.records[0].hash, 7);
        std::fs::remove_dir_all(&dir).ok();
    }
}
