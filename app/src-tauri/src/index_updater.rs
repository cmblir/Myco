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
use crate::retrieval::{Bm25Cache, Bm25Index};
use crate::vector_index::{is_cold, VectorCache, VectorStore};

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
            // A rebind's "*" full-reconcile batch waits much longer than an
            // edit's debounce. At launch it used to fire 500 ms in — walking
            // every wiki/sessions page and embedding any session backlog
            // (loading the 411 MB embed model) exactly while the webview,
            // shaders, and first render compete for the same cores and GPU.
            // The catch-up is not urgent: searches read the on-disk index
            // either way until it lands. The window also coalesces the two
            // launch rebinds (lib.rs pre-arm + the frontend's open_vault)
            // into one reconcile instead of two back-to-back full walks.
            // 180s, not 30: the catch-up loads the ~400 MB embed model, and on
            // a memory-pressed machine that landed exactly in the "app just
            // launched" window the owner felt as a system-wide swap storm.
            // A genuine search loads the model on demand regardless — this
            // delay only moves background catch-up work off the launch spike.
            const REBIND_CATCHUP_DELAY: std::time::Duration = std::time::Duration::from_secs(180);
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
                        tokio::time::sleep(batch_delay(&dirty, DEBOUNCE, REBIND_CATCHUP_DELAY))
                            .await
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
                            // Background embedding is deferrable by nature —
                            // searches read the on-disk index either way — so
                            // under system memory pressure the batch WAITS
                            // rather than adding a transient multi-hundred-MB
                            // compute buffer to a machine already evicting
                            // pages. Interactive query embeds do not come
                            // through this actor and are never gated.
                            if memory_pressured() {
                                eprintln!(
                                    "[index_updater] memory pressure — deferring {} dirty path(s)",
                                    dirty.len()
                                );
                                tokio::time::sleep(std::time::Duration::from_secs(120)).await;
                                continue;
                            }
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
/// the index is `stale` (wrong model, or none yet), `batch` carries the "*"
/// sentinel a `Rebind` inserts, or the lexical index is incomplete (empty or
/// short of the dense store's page count).
///
/// A rebind must reconcile in full even when the index is already
/// current — not just when it's stale — because the actor may have missed
/// on-disk changes while it wasn't watching this vault (edit-then-quit,
/// a non-active-project MCP write, an external/CLI edit made while the vault
/// was closed). Without this, the "*" sentinel fails `should_index` and a
/// rebind onto a fresh index would silently be a no-op.
///
/// `bm25_incomplete` exists because the incremental branch only visits
/// `batch`'s dirty paths. With a `.mxb` that has fewer indexed pages than the
/// `.mxv` next to it — absent entirely (fresh install, deleted/corrupt
/// sidecar), or partially built (a large-vault bootstrap that persisted a
/// checkpoint and then errored out before finishing) — an incremental batch
/// would upsert only the edited page on top of that shortfall, leaving the
/// lexical index permanently short. That is not benign: BM25's idf is
/// computed over however few pages it has, so its handful of indexed pages
/// can score at or above genuinely relevant pages that BM25 hasn't seen yet,
/// and RRF then lets them displace good dense hits at the top of the fused
/// list. Promoting such a batch to a reconcile makes it visit every page
/// instead, until the lexical index catches back up to the dense one.
fn reconcile_requested(batch: &[String], stale: bool, bm25_incomplete: bool) -> bool {
    stale || bm25_incomplete || batch.iter().any(|r| r == "*")
}

/// Whether the kernel reports elevated memory pressure
/// (`kern.memorystatus_vm_pressure_level`: 1 normal, 2 warn, 4 critical).
/// One `sysctl` spawn per BATCH — batches are debounced to at most one every
/// few hundred ms and usually far rarer, so the spawn cost is nil and it
/// avoids both an unsafe block and a direct libc dependency. Any failure
/// (non-macOS, missing key) counts as "not pressured": the gate must never
/// be able to wedge indexing off. Decision split out for the test below.
fn memory_pressured() -> bool {
    let level = std::process::Command::new("sysctl")
        .args(["-n", "kern.memorystatus_vm_pressure_level"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse::<i32>().ok());
    pressure_gates(level)
}

/// 2 (warn) and above defer; unknown never defers.
fn pressure_gates(level: Option<i32>) -> bool {
    matches!(level, Some(l) if l >= 2)
}

/// How long the actor waits before processing the pending dirty set: the
/// short edit debounce, unless the set holds the "*" rebind sentinel — a full
/// reconcile (every page walked, session backlog embedded) that must not
/// launch 500 ms into app boot. See `REBIND_CATCHUP_DELAY` in `spawn`.
fn batch_delay(
    dirty: &HashSet<String>,
    debounce: std::time::Duration,
    catchup: std::time::Duration,
) -> std::time::Duration {
    if dirty.contains("*") {
        catchup
    } else {
        debounce
    }
}

/// Whether the lexical index is missing pages the dense store already has —
/// the case a plain `is_empty()` check misses: a `.mxb` that is non-empty but
/// still short of `.mxv`'s page count (e.g. a bootstrap that checkpointed
/// partway through and then errored out, per the comment on
/// `reconcile_requested`). An empty dense store (`dense_page_count == 0`)
/// never counts as incomplete — there is nothing yet to bootstrap from.
fn bm25_is_incomplete(dense_page_count: usize, bm25_page_count: usize) -> bool {
    dense_page_count > 0 && bm25_page_count < dense_page_count
}

/// Top-level trees the watcher attaches to and the incremental path accepts —
/// kept in lockstep with `collect_wiki_pages`'s walk (`wiki/`, `sessions/`,
/// `daily/`, `weekly/`, `monthly/`) so a change the reindex would pick up is also caught by the
/// fast incremental path instead of waiting for the next reconcile. `raw/`
/// (immutable) and everything else is never indexed.
const WATCHED_TREES: [&str; 5] = ["wiki", "sessions", "daily", "weekly", "monthly"];

/// Whether vault-relative `rel` falls under one of `WATCHED_TREES`.
fn in_watched_tree(rel: &str) -> bool {
    WATCHED_TREES
        .iter()
        .any(|t| rel.starts_with(t) && rel[t.len()..].starts_with('/'))
}

/// The vault-relative path for `abs`, iff it is a markdown file under one of
/// `WATCHED_TREES`.
fn wiki_rel_of(root: &Path, abs: &Path) -> Option<String> {
    if abs.extension().and_then(|e| e.to_str()) != Some("md") {
        return None;
    }
    let rel = abs
        .strip_prefix(root)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");
    in_watched_tree(&rel).then_some(rel)
}

/// Whether a vault-relative path is eligible for indexing at all — the same
/// check as `wiki_rel_of`, but for a path already known to be vault-relative
/// (as dirty paths and rebind's "*" sentinel are). Unlike `wiki_rel_of`, the
/// `is_cold` check here is load-bearing: `sessions/` is a watched tree but
/// `sessions/archive/` is cold, so a session's archive move (a create event
/// under the archive subtree) must not re-embed it — this is what keeps that
/// a cheap drop-from-index instead of live churn.
fn should_index(rel: &str) -> bool {
    rel.ends_with(".md") && in_watched_tree(rel) && !is_cold(rel)
}

/// Start watching `root`'s `WATCHED_TREES` (`wiki/`, `sessions/`, `daily/`,
/// `weekly/`)
/// for filesystem changes, marking each changed markdown page dirty via
/// `tx`. Returns `None` only if the watch backend itself couldn't be
/// created. A tree that doesn't exist under this vault root is skipped
/// rather than failing the whole watcher — it silently watches nothing under
/// that tree until the next `Rebind` replaces it.
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
    let mut w = notify::recommended_watcher(move |res: notify::Result<notify::Event>| match res {
        Ok(ev) => {
            for p in ev.paths {
                if let Some(rel) = wiki_rel_of(&root_buf, &p) {
                    let _ = tx.send(UpdateMsg::Dirty(rel));
                }
            }
        }
        Err(e) => eprintln!("[index_updater] watch error: {e}"),
    })
    .ok()?;
    for tree in WATCHED_TREES {
        let dir = root.join(tree);
        if dir.is_dir() {
            w.watch(&dir, RecursiveMode::Recursive).ok()?;
        }
    }
    Some(w)
}

/// Bring the index for `root` up to date with `batch` (the paths that went
/// dirty since the last run) — or, whenever `reconcile_requested` says so,
/// with the *whole* vault regardless of `batch`'s other contents.
///
/// A stale/missing index (wrong model, or none yet) is wiped via
/// `ensure_model`, same as `reindex_embeddings`. A reconcile pass — run when
/// the index is stale, when `batch` carries the "*" `Rebind` sentinel, or when
/// the lexical index is incomplete (see `reconcile_requested`) —
/// then walks every wiki page and re-embeds it; `embed_one_page`'s content-hash
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
    let bm25_path = Bm25Index::path_for(&root.to_string_lossy())?;
    // BM25 has no model field and is never wiped by `ensure_model` below: it
    // is derived from raw chunk text, not embedding geometry, so it stays
    // valid across an embed-model migration. Re-upserting every page during
    // the reconcile pass a stale store forces is what keeps it correct then
    // — not a wipe.
    let mut bm25 = Bm25Index::load(&bm25_path);
    // Snapshot once, same spirit as `store.hashes_by_page()` below: lets
    // `embed_one_page` detect "BM25 doesn't have this page yet" (e.g.
    // bootstrapping a fresh/dropped `.mxb` against an already-current
    // `.mxv`, where every page's dense side skips via the content-hash
    // match) without an O(n) scan per page.
    let bm25_pages = bm25.pages();
    let model_id = format!("builtin-local:{}", crate::local_llm::BUILTIN_EMBED_MODEL);

    let stale = index_is_stale(&store.model);
    // A lexical index with fewer pages than the dense store — empty (never
    // built) or partial (a checkpointed-then-aborted bootstrap) — cannot be
    // trusted: see `bm25_is_incomplete` and the comment on
    // `reconcile_requested` for why a partial `.mxb` is actively harmful,
    // not just incomplete.
    let bm25_incomplete = bm25_is_incomplete(store.indexed_pages(), bm25_pages.len());
    let reconcile = reconcile_requested(&batch, stale, bm25_incomplete);
    if stale {
        // First index, or a migration to the current model: wipe so the
        // reconcile pass below re-embeds against the new geometry rather
        // than trying to reconcile a batch against records that no longer
        // match it. BM25 is deliberately NOT wiped here (see the comment on
        // `bm25` above) — only the vector store is model-specific.
        store.ensure_model(&model_id);
    }

    let mut changed = false;
    if reconcile {
        let existing = store.hashes_by_page(); // empty right after a wipe
        let pages = crate::commands::collect_wiki_pages(root);
        for (rel, stem, content) in &pages {
            let llm = app.state::<LocalLlmState>();
            let outcome = crate::commands::embed_one_page(
                app,
                &llm,
                "builtin-local",
                crate::local_llm::BUILTIN_EMBED_MODEL,
                rel,
                stem,
                content,
                &existing,
                &mut store,
                &mut bm25,
                &bm25_pages,
            )
            .await?;
            changed |= outcome.changed;
        }
        let present: HashSet<String> = pages.into_iter().map(|(r, _, _)| r).collect();
        changed |= store.prune(&present) > 0;
        changed |= bm25.prune(&present) > 0;
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
                let outcome = crate::commands::embed_one_page(
                    app,
                    &llm,
                    "builtin-local",
                    crate::local_llm::BUILTIN_EMBED_MODEL,
                    &rel,
                    &stem,
                    &content,
                    &existing,
                    &mut store,
                    &mut bm25,
                    &bm25_pages,
                )
                .await?;
                changed |= outcome.changed;
            } else {
                store.upsert_page(&rel, "", Vec::new()); // deleted → drop its records
                bm25.upsert_page(&rel, "", &[]); // upsert with no chunks == delete, same as store
                changed = true;
            }
        }
    }

    // `VectorCache::put` resets the semantic-edge cache, so only pay for a
    // save (and that reset) when something actually changed — a rebind onto
    // an already-current index should walk + hash-check every page for
    // free, not force every `open_vault` to needlessly recompute edges.
    //
    // Both `.mxv` and `.mxb` are saved under this one `changed` flag, which
    // either index can set alone above — `changed` covers a BM25-only
    // bootstrap update (dense already current, lexical catching up) just as
    // much as a normal lockstep re-embed of both. `bm25.save` runs FIRST and
    // `store.save` second — deliberately, not arbitrarily: the retry
    // decision on the next batch is gated on `store`'s on-disk content
    // hashes (`hashes_by_page`), not on bm25's. If `.mxv` were saved first
    // and `.mxb` then failed, a retry would see the new hashes already on
    // disk, skip re-embedding those pages entirely, and never re-upsert
    // BM25 for them — a permanent drift. Saving `.mxb` first means any
    // failure there aborts via `?` before `.mxv` is written, so the next
    // retry still sees stale hashes, re-embeds, and re-upserts both indexes.
    // A failed `.mxb` save surfaces as a batch error, retried with backoff
    // by the caller, exactly like a failed `store.save` already does.
    if changed {
        bm25.save(&bm25_path)?;
        store.save(&index_path)?;
        app.state::<Bm25Cache>().put(&bm25_path, bm25);
        app.state::<VectorCache>().put(&index_path, store);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stale_detection_matches_current_model() {
        assert!(!index_is_stale(&format!(
            "builtin-local:{}",
            crate::local_llm::BUILTIN_EMBED_MODEL
        )));
        // Every retired builtin, newest first (bge-m3 lost the 2026-08
        // bake-off to e5-small-ko; gemma-3-1b predates both).
        assert!(index_is_stale("builtin-local:bge-m3"));
        assert!(index_is_stale("builtin-local:gemma-3-1b"));
        assert!(index_is_stale("")); // empty/new index
        assert!(index_is_stale("ollama:nomic-embed-text"));
    }

    #[test]
    fn reconcile_requested_covers_rebind_and_stale_but_not_normal_batch() {
        assert!(reconcile_requested(&["*".to_string()], false, false)); // rebind sentinel
        assert!(reconcile_requested(&[], true, false)); // stale index, even w/ an empty batch
        assert!(reconcile_requested(&["wiki/a.md".to_string()], true, false)); // stale + dirty
        assert!(!reconcile_requested(
            &["wiki/a.md".to_string()],
            false,
            false
        )); // normal incremental batch
    }

    #[test]
    fn rebind_sentinel_batches_wait_longer_than_edit_debounce() {
        let debounce = std::time::Duration::from_millis(500);
        let catchup = std::time::Duration::from_secs(30);
        let edits: HashSet<String> = ["wiki/a.md".to_string()].into();
        assert_eq!(batch_delay(&edits, debounce, catchup), debounce);
        let rebind: HashSet<String> = ["*".to_string(), "wiki/a.md".to_string()].into();
        assert_eq!(batch_delay(&rebind, debounce, catchup), catchup);
    }

    #[test]
    fn a_dirty_page_with_an_unbootstrapped_bm25_is_promoted_to_a_reconcile() {
        // The decision this pins: one dirty page, a current dense index (not
        // stale), no rebind sentinel — but no lexical index yet. Without the
        // `bm25_incomplete` term this returns false, the incremental
        // branch runs, and it persists a ONE-PAGE `.mxb` whose lone rank-0
        // lexical hit then ties the dense rank-0 hit at 1/RRF_K at the top of
        // the fused list (see the test below for that damage).
        assert!(reconcile_requested(&["wiki/a.md".to_string()], false, true));
    }

    #[test]
    fn bm25_is_incomplete_widens_the_guard_from_empty_to_short_of_the_dense_store() {
        // Complete: lexical index has caught up to the dense store (equal
        // page counts) — no promotion, or every batch would force a full
        // reconcile forever, undoing the incremental fast path.
        assert!(!bm25_is_incomplete(10, 10));
        // Partial: a checkpointed-then-aborted bootstrap left `.mxb` non-empty
        // but short of `.mxv` — this is the case a plain `is_empty()` check
        // misses, and the one this fix adds.
        assert!(bm25_is_incomplete(10, 4));
        // Empty: no lexical index at all yet — already covered before this
        // fix, must stay covered.
        assert!(bm25_is_incomplete(10, 0));
        // Empty dense store: nothing indexed yet on either side, so there is
        // nothing to bootstrap from — no promotion.
        assert!(!bm25_is_incomplete(0, 0));
    }

    /// Demonstrates the damage the promotion above prevents, at the exact
    /// mutation the incremental branch performs (`process_batch` itself needs a
    /// live `AppHandle` + loaded embed model, so it cannot be called here):
    /// upserting one dirty page into an empty index and saving yields a
    /// one-page `.mxb`, and that single lexical hit lands level with the page
    /// the dense arm ranked first — top-of-list placement decided by nothing
    /// but the tie-break.
    #[test]
    fn a_one_page_bm25_pollutes_the_top_of_the_fused_list() {
        use crate::retrieval::rrf_fuse;
        use crate::vector_index::Hit;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.mxb");

        // The incremental branch's mutation with an absent `.mxb`: load (empty)
        // → upsert the one dirty page → save.
        let mut bm25 = Bm25Index::load(&path);
        assert!(bm25.is_empty());
        bm25.upsert_page(
            "wiki/shopping-list.md",
            "shopping-list",
            &["milk eggs and the bread".to_string()],
        );
        bm25.save(&path).unwrap();
        let persisted = Bm25Index::load(&path);
        assert_eq!(
            persisted.len(),
            1,
            "this is the partial index that must never be saved"
        );

        // A query the dense arm answers correctly, matching the stray page on
        // nothing but the stop-word "the".
        let dense = vec![Hit {
            page: "wiki/rlhf.md".into(),
            stem: "rlhf".into(),
            section: 0,
            score: 0.8,
        }];
        let lexical = persisted.search("what is the reward model in rlhf", 40);
        assert_eq!(lexical.len(), 1);
        let fused = rrf_fuse(&dense, &lexical, 10);
        assert_eq!(fused.len(), 2);
        assert_eq!(
            fused[0].score.to_bits(),
            fused[1].score.to_bits(),
            "a one-page .mxb puts a stop-word match level with the relevant page"
        );
        assert!(fused.iter().any(|h| h.page == "wiki/shopping-list.md"));
    }

    #[test]
    fn wiki_rel_only_accepts_wiki_markdown() {
        let root = std::path::Path::new("/v");
        assert_eq!(
            wiki_rel_of(root, std::path::Path::new("/v/wiki/a.md")).as_deref(),
            Some("wiki/a.md")
        );
        assert_eq!(wiki_rel_of(root, std::path::Path::new("/v/raw/a.md")), None); // raw/ never
        assert_eq!(
            wiki_rel_of(root, std::path::Path::new("/v/wiki/a.txt")),
            None
        ); // non-md
        assert!(
            should_index("wiki/a.md") && !should_index("raw/a.md") && !should_index("wiki/a.tmp")
        );
    }

    // `process_batch` needs a live `tauri::AppHandle` + a loaded embed model to
    // call end-to-end, which this crate has no test harness for. The tests
    // below instead exercise the real `Bm25Index` API at the three exact
    // mutation points `process_batch` performs it at — upsert-then-save
    // (incremental/reconcile re-embed), delete-then-save (incremental delete:
    // `bm25.upsert_page(&rel, "", &[])`), and prune-then-save (reconcile) —
    // against a real on-disk `.mxb`, so each would fail if that seam were
    // wired wrong. What they do NOT cover: that `process_batch` actually
    // reaches these calls at the right branch, and that the chunk texts
    // handed to `bm25.upsert_page` are identical to what `store.upsert_page`
    // received — those are verified by code inspection only (see the task
    // report), since a real embed call is out of reach for a unit test here.

    #[test]
    fn bm25_upsert_then_save_makes_a_page_searchable_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.mxb");

        let mut bm25 = Bm25Index::load(&path); // missing file → empty, as process_batch does
        bm25.upsert_page(
            "wiki/attention.md",
            "attention",
            &["transformers use self attention to weigh tokens".to_string()],
        );
        bm25.save(&path).unwrap();

        let reloaded = Bm25Index::load(&path);
        let hits = reloaded.search("self attention tokens", 10);
        assert!(
            hits.iter().any(|h| h.page == "wiki/attention.md"),
            "expected the upserted page to be searchable after a reload, got {:?}",
            hits.iter().map(|h| &h.page).collect::<Vec<_>>()
        );
    }

    #[test]
    fn bm25_delete_path_removes_the_page_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.mxb");

        let mut bm25 = Bm25Index::load(&path);
        bm25.upsert_page(
            "wiki/gone.md",
            "gone",
            &["a page that will be deleted next".to_string()],
        );
        bm25.save(&path).unwrap();
        assert!(Bm25Index::load(&path)
            .search("deleted next", 10)
            .iter()
            .any(|h| h.page == "wiki/gone.md"));

        // Mirrors process_batch's incremental delete path exactly.
        let mut bm25 = Bm25Index::load(&path);
        bm25.upsert_page("wiki/gone.md", "", &[]);
        bm25.save(&path).unwrap();

        let reloaded = Bm25Index::load(&path);
        assert!(
            !reloaded
                .search("deleted next", 10)
                .iter()
                .any(|h| h.page == "wiki/gone.md"),
            "deleted page must not be searchable after save+reload"
        );
        assert!(reloaded.is_empty());
    }

    #[test]
    fn bm25_reconcile_prune_drops_a_page_missing_from_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.mxb");

        let mut bm25 = Bm25Index::load(&path);
        bm25.upsert_page(
            "wiki/kept.md",
            "kept",
            &["this page still exists on disk".to_string()],
        );
        bm25.upsert_page(
            "wiki/removed.md",
            "removed",
            &["this page was deleted outside the app".to_string()],
        );
        bm25.save(&path).unwrap();

        // Mirrors process_batch's reconcile-branch prune: `present` is the set
        // of pages `collect_wiki_pages` actually found on disk.
        let mut bm25 = Bm25Index::load(&path);
        let present: HashSet<String> = ["wiki/kept.md".to_string()].into_iter().collect();
        let pruned = bm25.prune(&present);
        assert_eq!(pruned, 1);
        bm25.save(&path).unwrap();

        let reloaded = Bm25Index::load(&path);
        assert!(reloaded
            .search("still exists", 10)
            .iter()
            .any(|h| h.page == "wiki/kept.md"));
        assert!(!reloaded
            .search("deleted outside", 10)
            .iter()
            .any(|h| h.page == "wiki/removed.md"));
    }

    // Defect B: the watcher used to attach only to `root/wiki`, so new/changed
    // `sessions/` and `daily/` files never marked the index dirty until a
    // manual reindex or vault rebind.

    #[test]
    fn watched_trees_cover_wiki_sessions_and_both_digest_layers() {
        assert_eq!(
            WATCHED_TREES,
            ["wiki", "sessions", "daily", "weekly", "monthly"]
        );
    }

    #[test]
    fn wiki_rel_of_resolves_every_watched_tree_but_not_others() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for (sub, expect_indexed) in [
            ("wiki/a.md", true),
            ("sessions/2026-08/s.md", true),
            ("daily/2026-08-10.md", true),
            ("raw/a.md", false),
        ] {
            let abs = root.join(sub);
            std::fs::create_dir_all(abs.parent().unwrap()).unwrap();
            std::fs::write(&abs, "x").unwrap();
            assert_eq!(wiki_rel_of(root, &abs).is_some(), expect_indexed, "{sub}");
        }
    }

    #[test]
    fn should_index_ignores_archived_and_quarantined_paths() {
        assert!(should_index("wiki/a.md"));
        assert!(should_index("sessions/2026-08/a.md"));
        assert!(should_index("daily/2026-08-10.md"));
        assert!(should_index("weekly/2026-W33.md"));
        // Cold subtrees stay out even though their parent tree is watched —
        // this is what keeps an archive move a cheap drop instead of churn.
        assert!(!should_index("sessions/archive/2026-08/a.md"));
        assert!(!should_index("daily/archive/2026-W33/2026-08-10.md"));
        assert!(!should_index("_inbox/quarantine/a.md"));
        assert!(!should_index("raw/a.md")); // never a watched tree
        assert!(!should_index("wiki/a.txt")); // not markdown
    }
}

#[cfg(test)]
mod pressure_tests {
    use super::pressure_gates;

    #[test]
    fn warn_and_critical_defer_normal_and_unknown_do_not() {
        assert!(!pressure_gates(Some(1)));
        assert!(pressure_gates(Some(2)));
        assert!(pressure_gates(Some(4)));
        assert!(!pressure_gates(None));
    }
}
