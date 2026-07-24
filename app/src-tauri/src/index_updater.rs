//! Background actor that keeps the vector index up to date as wiki pages
//! change, without making a write wait on re-embedding.
//!
//! A write calls `mark_dirty(rel)` — a non-blocking channel send, safe from
//! any thread (the Task 3 filesystem watcher runs on its own non-tokio
//! thread). The actor debounces a burst of dirty pages into one batch, then
//! either re-embeds just those pages or, when the on-disk index predates the
//! current embed model (first index, or a model migration), does a full
//! rebuild — the same policy `reindex_embeddings` uses, just triggered
//! automatically instead of by a button.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use tauri::Manager as _;

use crate::commands::LocalLlmState;
use crate::vector_index::{VectorCache, VectorStore};

/// A message for the actor. `Dirty` marks one vault-relative page path as
/// needing re-embedding; `Rebind` points the actor at a (possibly new) vault
/// root (e.g. on `open_vault`) and forces a batch so a stale/empty index gets
/// picked up immediately rather than waiting for the next write.
pub enum UpdateMsg {
    Dirty(String),
    Rebind(PathBuf),
}

/// Handle to the running actor. Cheap to clone: every call is a non-blocking
/// send over an unbounded channel, so callers — including the Task 3
/// filesystem watcher, which runs on its own non-tokio thread — never block
/// or drop a message.
#[derive(Clone)]
pub struct IndexUpdater {
    tx: tokio::sync::mpsc::UnboundedSender<UpdateMsg>,
}

impl IndexUpdater {
    /// Start the actor on the Tauri async runtime and return a handle to it.
    pub fn spawn(app: tauri::AppHandle) -> Self {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<UpdateMsg>();
        let watcher_tx = tx.clone();
        tauri::async_runtime::spawn(async move {
            const DEBOUNCE: std::time::Duration = std::time::Duration::from_millis(500);
            let mut root: Option<PathBuf> = None;
            // Held only for its Drop side effect: reassigning on `Rebind` stops
            // the previous vault's watch. Never read directly, so both
            // unused-variable lints are expected false positives here.
            #[allow(unused_variables, unused_assignments)]
            let mut watcher: Option<notify::RecommendedWatcher> = None;
            let mut dirty: HashSet<String> = Default::default();
            let mut consecutive_errors: u32 = 0;
            loop {
                // Never busy-loops: with nothing dirty the timer arm parks
                // forever and the select is driven purely by `rx.recv()`.
                let timer = async {
                    if dirty.is_empty() {
                        std::future::pending::<()>().await
                    } else {
                        tokio::time::sleep(DEBOUNCE).await
                    }
                };
                tokio::select! {
                    msg = rx.recv() => match msg {
                        None => break, // all senders dropped
                        Some(UpdateMsg::Dirty(rel)) => {
                            if should_index(&rel) {
                                dirty.insert(rel);
                            }
                        }
                        Some(UpdateMsg::Rebind(new_root)) => {
                            // Reassigning drops the old watcher (if any), which stops
                            // the previous vault's watch before the new one starts.
                            // `watcher` is held only for that Drop side effect and
                            // never read, hence the lint override.
                            #[allow(unused_assignments)]
                            {
                                watcher = start_watcher(&new_root, watcher_tx.clone());
                            }
                            root = Some(new_root);
                            dirty.insert("*".into()); // force a stale-check batch
                        }
                    },
                    _ = timer => {
                        if let Some(r) = root.clone() {
                            // Snapshot rather than drain: on failure we need to
                            // keep exactly these paths dirty for a retry. Any
                            // new `Dirty`/`Rebind` that arrives while this
                            // `.await` runs buffers in the unbounded channel
                            // (`rx.recv()` isn't polled until the next loop
                            // iteration) rather than landing in `dirty`, so
                            // removing exactly `batch` on success is correct.
                            let batch: Vec<String> = dirty.iter().cloned().collect();
                            match process_batch(&app, &r, batch.clone()).await {
                                Ok(()) => {
                                    for p in &batch {
                                        dirty.remove(p);
                                    }
                                    consecutive_errors = 0;
                                }
                                Err(e) => {
                                    consecutive_errors = (consecutive_errors + 1).min(6);
                                    eprintln!("[index_updater] batch failed (will retry): {e}");
                                    // Keep `dirty` so the batch is retried next
                                    // cycle; back off so a persistent error
                                    // (e.g. the embed model won't load) can't
                                    // spin every 500ms.
                                    tokio::time::sleep(std::time::Duration::from_millis(
                                        500u64 << consecutive_errors,
                                    ))
                                    .await;
                                }
                            }
                        } else {
                            dirty.clear(); // no vault bound yet — a `Dirty` before the
                                            // first `Rebind` is intentionally dropped
                        }
                    }
                }
            }
        });
        Self { tx }
    }

    /// Mark one vault-relative path dirty. Non-blocking; safe from any thread.
    pub fn mark_dirty(&self, rel: impl Into<String>) {
        let _ = self.tx.send(UpdateMsg::Dirty(rel.into()));
    }

    /// Point the actor at a (possibly new) vault root.
    pub fn rebind(&self, root: PathBuf) {
        let _ = self.tx.send(UpdateMsg::Rebind(root));
    }
}

/// True unless `store_model` is exactly the current builtin embed model's id
/// — i.e. a first-ever index (empty string), a leftover id from a prior
/// model, or a non-builtin provider. A stale index gets a full rebuild rather
/// than an incremental patch, same as a model migration in
/// `reindex_embeddings`.
fn index_is_stale(store_model: &str) -> bool {
    store_model != format!("builtin-local:{}", crate::local_llm::BUILTIN_EMBED_MODEL)
}

/// The vault-relative path for `abs`, iff it is a markdown file under
/// `root/wiki` — `raw/` (immutable) and everything else is never indexed.
fn wiki_rel_of(root: &Path, abs: &Path) -> Option<String> {
    if abs.extension().and_then(|e| e.to_str()) != Some("md") {
        return None;
    }
    let rel = abs.strip_prefix(root).ok()?.to_string_lossy().replace('\\', "/");
    rel.starts_with("wiki/").then_some(rel)
}

/// Whether a vault-relative path is eligible for indexing at all — the same
/// check as `wiki_rel_of`, but for a path already known to be vault-relative
/// (as dirty paths and rebind's "*" sentinel are).
fn should_index(rel: &str) -> bool {
    rel.starts_with("wiki/") && rel.ends_with(".md")
}

/// Start watching `root/wiki` for filesystem changes, marking each changed
/// markdown page dirty via `tx`. Returns `None` if the watcher couldn't be
/// created or `root/wiki` doesn't exist (e.g. an empty/new vault) — the
/// caller is left without a watcher for that root rather than failing.
///
/// The callback runs on `notify`'s own (non-tokio) thread; `tx.send` is an
/// unbounded, non-blocking, thread-safe send, so it never blocks that thread
/// or drops an event.
fn start_watcher(
    root: &Path,
    tx: tokio::sync::mpsc::UnboundedSender<UpdateMsg>,
) -> Option<notify::RecommendedWatcher> {
    use notify::{RecursiveMode, Watcher};
    let root_buf = root.to_path_buf();
    let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            for p in ev.paths {
                if let Some(rel) = wiki_rel_of(&root_buf, &p) {
                    let _ = tx.send(UpdateMsg::Dirty(rel));
                }
            }
        }
    })
    .ok()?;
    let wiki = root.join("wiki");
    if wiki.is_dir() {
        w.watch(&wiki, RecursiveMode::Recursive).ok()?;
    }
    Some(w)
}

/// Bring the index for `root` up to date with `batch` (the paths that went
/// dirty since the last run — or the "*" rebind sentinel).
///
/// A stale/missing index (wrong model, or none yet) gets a full rebuild over
/// every wiki page, same as `reindex_embeddings`; `batch` is ignored in that
/// case since the whole vault is being walked anyway. Otherwise each dirty
/// path is re-embedded (or, if the file no longer exists, dropped from the
/// index) — the fast path this actor exists for.
async fn process_batch(
    app: &tauri::AppHandle,
    root: &Path,
    batch: Vec<String>,
) -> Result<(), String> {
    let index_path = VectorStore::path_for(&root.to_string_lossy())?;
    let mut store = VectorStore::load(&index_path);
    let model_id = format!("builtin-local:{}", crate::local_llm::BUILTIN_EMBED_MODEL);

    if index_is_stale(&store.model) {
        // First index, or a migration to the current model: wipe and rebuild
        // over every wiki page rather than trying to reconcile a batch
        // against geometry that no longer matches.
        store.ensure_model(&model_id);
        let existing = store.hashes_by_page(); // empty right after the wipe
        let pages = crate::commands::collect_wiki_pages(root);
        for (rel, stem, content) in &pages {
            let llm = app.state::<LocalLlmState>();
            let _ = crate::commands::embed_one_page(
                app,
                &llm,
                "builtin-local",
                crate::local_llm::BUILTIN_EMBED_MODEL,
                rel,
                stem,
                content,
                &existing,
                &mut store,
            )
            .await?;
        }
        let present: HashSet<String> = pages.into_iter().map(|(r, _, _)| r).collect();
        store.prune(&present);
    } else {
        // `batch` may carry the "*" sentinel from a rebind of an already-fresh
        // index; it fails `should_index` and is filtered out here, so a rebind
        // onto a fresh index is a no-op incremental pass. Bail out before
        // touching the store at all in that case: `VectorCache::put` resets
        // the semantic-edge cache, so saving on a genuine no-op would force
        // every `open_vault` on a current index to needlessly wipe and
        // recompute edges.
        let to_process: Vec<String> = batch.into_iter().filter(|r| should_index(r)).collect();
        if to_process.is_empty() {
            return Ok(());
        }
        let existing = store.hashes_by_page();
        for rel in to_process {
            let abs = root.join(&rel);
            if abs.is_file() {
                let content = std::fs::read_to_string(&abs).unwrap_or_default();
                let stem = Path::new(&rel)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_string();
                let llm = app.state::<LocalLlmState>();
                let _ = crate::commands::embed_one_page(
                    app,
                    &llm,
                    "builtin-local",
                    crate::local_llm::BUILTIN_EMBED_MODEL,
                    &rel,
                    &stem,
                    &content,
                    &existing,
                    &mut store,
                )
                .await?;
            } else {
                store.upsert_page(&rel, "", Vec::new()); // deleted → drop its records
            }
        }
    }

    store.save(&index_path)?;
    app.state::<VectorCache>().put(&index_path, store);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_detection_matches_current_model() {
        assert!(!index_is_stale("builtin-local:bge-m3"));
        assert!(index_is_stale("builtin-local:gemma-3-1b"));
        assert!(index_is_stale("")); // empty/new index
        assert!(index_is_stale("ollama:nomic-embed-text"));
    }

    #[test]
    fn wiki_rel_only_accepts_wiki_markdown() {
        let root = std::path::Path::new("/v");
        assert_eq!(
            wiki_rel_of(root, std::path::Path::new("/v/wiki/a.md")).as_deref(),
            Some("wiki/a.md")
        );
        assert_eq!(wiki_rel_of(root, std::path::Path::new("/v/raw/a.md")), None); // raw/ never
        assert_eq!(wiki_rel_of(root, std::path::Path::new("/v/wiki/a.txt")), None); // non-md
        assert!(should_index("wiki/a.md") && !should_index("raw/a.md") && !should_index("wiki/a.tmp"));
    }
}
