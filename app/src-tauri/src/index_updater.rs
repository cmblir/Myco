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
                            dirty.clear(); // drop paths queued for the OLD vault — the
                                           // "*" sentinel below reconciles the NEW one
                                           // in full regardless
                            root = Some(new_root);
                            dirty.insert("*".into()); // force a full-reconcile batch
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

/// Whether `process_batch` should reconcile the *whole* vault against disk
/// (walk every wiki page) rather than touch only `batch`'s dirty paths:
/// either the index is `stale` (wrong model, or none yet), or `batch` carries
/// the "*" sentinel a `Rebind` inserts.
///
/// A rebind must reconcile in full even when the index is already
/// current — not just when it's stale — because the actor may have missed
/// on-disk changes while it wasn't watching this vault (edit-then-quit,
/// a non-active-project MCP write, an external/CLI edit made while the vault
/// was closed). Without this, the "*" sentinel fails `should_index` and a
/// rebind onto a fresh index would silently be a no-op.
fn reconcile_requested(batch: &[String], stale: bool) -> bool {
    stale || batch.iter().any(|r| r == "*")
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
/// markdown page dirty via `tx`. Returns `None` only if the watch backend
/// itself couldn't be created, or (when `root/wiki` exists) couldn't attach
/// to it. If `root/wiki` doesn't exist yet (e.g. an empty/new vault), the
/// watcher is still created and returned `Some` — it just has nothing
/// attached, so it silently watches nothing until the next `Rebind` replaces
/// it.
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
        match res {
            Ok(ev) => {
                for p in ev.paths {
                    if let Some(rel) = wiki_rel_of(&root_buf, &p) {
                        let _ = tx.send(UpdateMsg::Dirty(rel));
                    }
                }
            }
            Err(e) => eprintln!("[index_updater] watch error: {e}"),
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
/// dirty since the last run) — or, whenever `reconcile_requested` says so,
/// with the *whole* vault regardless of `batch`'s other contents.
///
/// A stale/missing index (wrong model, or none yet) is wiped via
/// `ensure_model`, same as `reindex_embeddings`. A reconcile pass — run when
/// the index is stale, or `batch` carries the "*" `Rebind` sentinel — then
/// walks every wiki page and re-embeds it; `embed_one_page`'s content-hash
/// skip makes pages that are already current in the index free, so this
/// stays cheap except where content actually changed. This is what makes
/// opening/rebinding a vault always reconcile its index to disk: without it,
/// a rebind onto an already-current index would be a no-op (the sentinel
/// fails `should_index`), silently leaving on-disk edits unindexed — e.g. an
/// edit made just before the actor was killed mid-debounce, a
/// non-active-project MCP write, or an external/CLI edit made while the
/// vault was closed.
///
/// Otherwise (not stale, not a rebind) only the dirty paths in `batch` are
/// re-embedded, or — if the file no longer exists — dropped from the index:
/// the fast incremental path this actor exists for.
///
/// Only saves the index (and updates `VectorCache`) if something actually
/// changed, so a rebind onto an already-current index costs a walk plus a
/// hash check per page but never forces a save or resets the
/// semantic-edge cache.
async fn process_batch(
    app: &tauri::AppHandle,
    root: &Path,
    batch: Vec<String>,
) -> Result<(), String> {
    let index_path = VectorStore::path_for(&root.to_string_lossy())?;
    let mut store = VectorStore::load(&index_path);
    let model_id = format!("builtin-local:{}", crate::local_llm::BUILTIN_EMBED_MODEL);

    let stale = index_is_stale(&store.model);
    let reconcile = reconcile_requested(&batch, stale);
    if stale {
        // First index, or a migration to the current model: wipe so the
        // reconcile pass below re-embeds against the new geometry rather
        // than trying to reconcile a batch against records that no longer
        // match it.
        store.ensure_model(&model_id);
    }

    let mut changed = false;
    if reconcile {
        let existing = store.hashes_by_page(); // empty right after a wipe
        let pages = crate::commands::collect_wiki_pages(root);
        for (rel, stem, content) in &pages {
            let llm = app.state::<LocalLlmState>();
            let embedded = crate::commands::embed_one_page(
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
            changed |= embedded;
        }
        let present: HashSet<String> = pages.into_iter().map(|(r, _, _)| r).collect();
        changed |= store.prune(&present) > 0;
    } else {
        let to_process: Vec<String> = batch.into_iter().filter(|r| should_index(r)).collect();
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
                let embedded = crate::commands::embed_one_page(
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
                changed |= embedded;
            } else {
                store.upsert_page(&rel, "", Vec::new()); // deleted → drop its records
                changed = true;
            }
        }
    }

    // `VectorCache::put` resets the semantic-edge cache, so only pay for a
    // save (and that reset) when something actually changed — a rebind onto
    // an already-current index should walk + hash-check every page for
    // free, not force every `open_vault` to needlessly recompute edges.
    if changed {
        store.save(&index_path)?;
        app.state::<VectorCache>().put(&index_path, store);
    }
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
    fn reconcile_requested_covers_rebind_and_stale_but_not_normal_batch() {
        assert!(reconcile_requested(&["*".to_string()], false)); // rebind sentinel
        assert!(reconcile_requested(&[], true)); // stale index, even w/ an empty batch
        assert!(reconcile_requested(&["wiki/a.md".to_string()], true)); // stale + dirty
        assert!(!reconcile_requested(&["wiki/a.md".to_string()], false)); // normal incremental batch
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
