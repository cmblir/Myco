//! Background actor that keeps the vector index up to date as wiki pages
//! change, without making a write wait on re-embedding.
//!
//! A write calls `mark_dirty(root, rel)` — a non-blocking channel send, safe from
//! any thread (the Task 3 filesystem watcher runs on its own non-tokio
//! thread). The actor debounces a burst of dirty pages into one batch, then
//! either re-embeds just those pages or, when the on-disk index predates the
//! current embed model (first index, or a model migration), does a full
//! rebuild — the same policy `reindex_embeddings` uses, just triggered
//! automatically instead of by a button.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::commands::AgentVaultSession;

use tauri::Manager as _;

use crate::commands::LocalLlmState;
use crate::retrieval::Bm25Cache;
#[cfg(test)]
use crate::retrieval::Bm25Index;
#[cfg(test)]
use crate::vector_index::VectorStore;
use crate::vector_index::{is_cold, VectorCache};

/// A message for the actor. `Dirty` marks one vault-relative page path as
/// needing re-embedding; `Rebind` points the actor at a (possibly new) vault
/// root (e.g. on `open_vault`) and forces a batch so a stale/empty index gets
/// picked up immediately rather than waiting for the next write.
pub enum UpdateMsg {
    Dirty(AgentVaultSession, String),
    Rebind(AgentVaultSession),
    Unbind,
    Reconciled(AgentVaultSession),
    #[cfg(feature = "native-index-probe")]
    Probe(tokio::sync::oneshot::Sender<(Option<AgentVaultSession>, HashSet<String>)>),
}

fn same_origin(first: &AgentVaultSession, second: &AgentVaultSession) -> bool {
    first.vault_path == second.vault_path && first.opening_token == second.opening_token
}

fn is_bound(binding: &Mutex<Option<AgentVaultSession>>, origin: &AgentVaultSession) -> bool {
    binding.lock().is_ok_and(|current| {
        current
            .as_ref()
            .is_some_and(|current| same_origin(current, origin))
    })
}

/// Every queued path carries the root and opening that produced it.
#[derive(Clone)]
pub struct IndexUpdater {
    tx: tokio::sync::mpsc::UnboundedSender<UpdateMsg>,
    binding: Arc<Mutex<Option<AgentVaultSession>>>,
    watcher: Arc<Mutex<Option<notify::RecommendedWatcher>>>,
}

impl IndexUpdater {
    pub fn spawn(app: tauri::AppHandle) -> Self {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<UpdateMsg>();
        let binding = Arc::new(Mutex::new(None));
        let watcher = Arc::new(Mutex::new(None));
        let actor_binding = binding.clone();
        let actor_watcher = watcher.clone();
        let watcher_tx = tx.clone();
        tauri::async_runtime::spawn(async move {
            const DEBOUNCE: std::time::Duration = std::time::Duration::from_millis(500);
            // Defer launch catch-up while rendering and initial model work settle.
            const REBIND_CATCHUP_DELAY: std::time::Duration = std::time::Duration::from_secs(180);
            let mut origin: Option<AgentVaultSession> = None;
            let mut dirty: HashSet<String> = Default::default();
            let mut consecutive_errors: u32 = 0;
            loop {
                let timer = async {
                    if dirty.is_empty() {
                        std::future::pending::<()>().await
                    } else {
                        tokio::time::sleep(batch_delay(
                            &dirty,
                            origin.as_ref().map(|origin| Path::new(&origin.vault_path)),
                            DEBOUNCE,
                            REBIND_CATCHUP_DELAY,
                        ))
                        .await
                    }
                };
                tokio::select! {
                    message = rx.recv() => match message {
                        None => break,
                        Some(UpdateMsg::Dirty(message_origin, rel)) => {
                            if is_bound(&actor_binding, &message_origin)
                                && origin.as_ref().is_some_and(|current| same_origin(current, &message_origin))
                                && should_index(&rel)
                            {
                                dirty.insert(rel);
                            }
                        }
                        Some(UpdateMsg::Rebind(new_origin)) => {
                            if !is_bound(&actor_binding, &new_origin) { continue; }
                            let next = start_watcher(&new_origin, watcher_tx.clone(), actor_binding.clone());
                            if let Ok(mut watcher) = actor_watcher.lock() { *watcher = next; }
                            dirty.clear();
                            origin = Some(new_origin);
                            dirty.insert("*".into());
                            consecutive_errors = 0;
                        }
                        Some(UpdateMsg::Unbind) => {
                            if actor_binding.lock().is_ok_and(|binding| binding.is_none()) {
                                origin = None;
                                dirty.clear();
                                consecutive_errors = 0;
                            }
                        }
                        Some(UpdateMsg::Reconciled(message_origin)) => {
                            if is_bound(&actor_binding, &message_origin)
                                && origin.as_ref().is_some_and(|current| same_origin(current, &message_origin))
                            { dirty.remove("*"); }
                        }
                        #[cfg(feature = "native-index-probe")]
                        Some(UpdateMsg::Probe(reply)) => { let _ = reply.send((origin.clone(), dirty.clone())); }
                    },
                    _ = timer => {
                        let Some(current) = origin.as_ref() else { dirty.clear(); continue; };
                        if !is_bound(&actor_binding, current) { dirty.clear(); continue; }
                        if crate::local_generation::busy() {
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                            continue;
                        }
                        if tauri::async_runtime::spawn_blocking(memory_pressured).await.unwrap_or(false) {
                            eprintln!("[index_updater] memory pressure — deferring {} dirty path(s)", dirty.len());
                            tokio::time::sleep(std::time::Duration::from_secs(120)).await;
                            continue;
                        }
                        let batch: Vec<String> = dirty.iter().cloned().collect();
                        match process_batch(&app, current, batch.clone()).await {
                            Ok(_) => {
                                for path in &batch { dirty.remove(path); }
                                consecutive_errors = 0;
                            }
                            Err(error) => {
                                consecutive_errors = (consecutive_errors + 1).min(6);
                                eprintln!("[index_updater] batch failed (will retry): {error}");
                                tokio::time::sleep(std::time::Duration::from_millis(500u64 << consecutive_errors)).await;
                            }
                        }
                    }
                }
            }
        });
        Self {
            tx,
            binding,
            watcher,
        }
    }

    /// The caller's root is required; a write to a closed or other vault is ignored.
    pub fn mark_dirty(&self, root: &Path, rel: impl Into<String>) {
        let origin = self.binding.lock().ok().and_then(|binding| {
            binding
                .as_ref()
                .filter(|origin| Path::new(&origin.vault_path) == root)
                .cloned()
        });
        if let Some(origin) = origin {
            let _ = self.tx.send(UpdateMsg::Dirty(origin, rel.into()));
        }
    }

    pub fn rebind(&self, origin: AgentVaultSession) {
        if let Ok(mut binding) = self.binding.lock() {
            *binding = Some(origin.clone());
        }
        // Stop old callbacks now, even while a model batch or backoff is pending.
        if let Ok(mut watcher) = self.watcher.lock() {
            watcher.take();
        }
        let _ = self.tx.send(UpdateMsg::Rebind(origin));
    }

    pub fn unbind(&self) {
        if let Ok(mut binding) = self.binding.lock() {
            *binding = None;
        }
        if let Ok(mut watcher) = self.watcher.lock() {
            watcher.take();
        }
        let _ = self.tx.send(UpdateMsg::Unbind);
    }

    #[cfg(feature = "native-index-probe")]
    pub(crate) fn enqueue_probe_dirty(&self, origin: AgentVaultSession, rel: &str) {
        let _ = self.tx.send(UpdateMsg::Dirty(origin, rel.into()));
    }

    #[cfg(feature = "native-index-probe")]
    pub(crate) fn watcher_is_stopped_for_probe(&self) -> bool {
        self.watcher.lock().unwrap().is_none()
    }

    #[cfg(feature = "native-index-probe")]
    pub(crate) async fn probe_state(
        &self,
    ) -> Result<(Option<AgentVaultSession>, HashSet<String>), String> {
        let (reply, result) = tokio::sync::oneshot::channel();
        self.tx
            .send(UpdateMsg::Probe(reply))
            .map_err(|_| "index actor stopped")?;
        tokio::time::timeout(std::time::Duration::from_secs(10), result)
            .await
            .map_err(|_| "index actor probe timed out")?
            .map_err(|_| "index actor stopped".into())
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

/// Byte size at which a dirty page is treated as an actively-appended
/// transcript rather than a note someone is typing. Size, not chunk count, is
/// the signal here because it costs one `stat` instead of reading and chunking
/// the file on the actor's own thread. ~256 KB is roughly where a page reaches
/// `commands::MAX_PAGE_CHUNKS` for English prose (320 tokens/chunk at ~4
/// chars/token) — the owner's three worst session logs are 645, 770 and 626 KB.
const LONG_PAGE_BYTES: u64 = 256 * 1024;

/// Debounce for such a page. An ingest agent appends to a session mirror
/// repeatedly over a run, and each append used to start an embed pass that the
/// next append invalidated before it finished — it never converged.
///
/// 30 s was the guess when that pass was the whole file. It no longer is:
/// `commands::MAX_PAGE_CHUNKS` indexes only the head of a page, so an append
/// past that point re-embeds nothing at all, and any page big enough to reach
/// LONG_PAGE_BYTES is already past it. What is left to coalesce is one capped
/// first index, measured at 4.26 s (`examples/bench_embed`, 21 ms/chunk × 200)
/// — a delay 30 s postpones without making cheaper. 5 s still swallows the
/// burst of appends inside an ingest turn while making a new transcript
/// searchable within seconds. Wiki pages stay on the 500 ms debounce.
const LONG_PAGE_DEBOUNCE: std::time::Duration = std::time::Duration::from_secs(5);

/// Pure decision behind the debounce choice: the largest dirty page's size
/// picks the delay.
fn size_debounce(
    max_bytes: u64,
    debounce: std::time::Duration,
    long: std::time::Duration,
) -> std::time::Duration {
    if max_bytes >= LONG_PAGE_BYTES {
        long
    } else {
        debounce
    }
}

/// How long the actor waits before processing the pending dirty set: the
/// short edit debounce, unless the set holds the "*" rebind sentinel — a full
/// reconcile (every page walked, session backlog embedded) that must not
/// launch 500 ms into app boot (see `REBIND_CATCHUP_DELAY` in `spawn`) — or
/// holds a page big enough to be an append-in-progress transcript, which waits
/// `LONG_PAGE_DEBOUNCE`.
fn batch_delay(
    dirty: &HashSet<String>,
    root: Option<&Path>,
    debounce: std::time::Duration,
    catchup: std::time::Duration,
) -> std::time::Duration {
    if dirty.contains("*") {
        return catchup;
    }
    // One `stat` per dirty path per timer arm — microseconds, and the dirty
    // set is a handful of paths.
    let max_bytes = root
        .map(|r| {
            dirty
                .iter()
                .filter_map(|rel| std::fs::metadata(r.join(rel)).ok().map(|m| m.len()))
                .max()
                .unwrap_or(0)
        })
        .unwrap_or(0);
    size_debounce(max_bytes, debounce, LONG_PAGE_DEBOUNCE)
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

/// Read the entire dirty batch before any embedding checkpoint can publish.
fn read_dirty_pages(
    root: &Path,
    batch: Vec<String>,
) -> Result<Vec<(String, Option<String>)>, String> {
    // A missing/unreadable vault is never proof that all dirty pages were
    // deleted. Confirm the root before classifying individual missing paths.
    crate::vault::vault_entries_checked(root)
        .map_err(|error| format!("read index vault: {error}"))?;
    batch
        .into_iter()
        .filter(|rel| should_index(rel))
        .map(|rel| {
            let abs = crate::vault::confine_delete_path(root, &root.join(&rel).to_string_lossy())
                .map_err(|error| format!("inspect index page {rel}: {error}"))?;
            let content = match std::fs::metadata(&abs) {
                Ok(metadata) if metadata.is_file() => Some(
                    std::fs::read_to_string(&abs)
                        .map_err(|e| format!("read index page {rel}: {e}"))?,
                ),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(format!("inspect index page {rel}: {error}")),
                Ok(_) => return Err(format!("index page is not a regular file: {rel}")),
            };
            Ok((rel, content))
        })
        .collect()
}

/// Top-level trees the watcher attaches to and the incremental path accepts —
/// kept in lockstep with `collect_wiki_pages`'s walk (`wiki/`, `sessions/`,
/// `daily/`, `weekly/`, `monthly/`, `raw/conversations/`) so a change the
/// reindex would pick up is also caught by the fast incremental path.
/// Conversation originals are read only; the rest of `raw/` is not indexed.
const WATCHED_TREES: [&str; 6] = [
    "wiki",
    "sessions",
    "daily",
    "weekly",
    "monthly",
    "raw/conversations",
];

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

/// Start watching `root`'s `WATCHED_TREES`
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
    origin: &AgentVaultSession,
    tx: tokio::sync::mpsc::UnboundedSender<UpdateMsg>,
    binding: Arc<Mutex<Option<AgentVaultSession>>>,
) -> Option<notify::RecommendedWatcher> {
    use notify::{RecursiveMode, Watcher};
    let origin = origin.clone();
    let root = PathBuf::from(&origin.vault_path);
    let callback_root = root.clone();
    let mut watcher =
        match notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
            if !is_bound(&binding, &origin) {
                return;
            }
            match result {
                Ok(event) => {
                    for path in event.paths {
                        if let Some(rel) = wiki_rel_of(&callback_root, &path) {
                            let _ = tx.send(UpdateMsg::Dirty(origin.clone(), rel));
                        }
                    }
                }
                Err(error) => eprintln!("[index_updater] watch error: {error}"),
            }
        }) {
            Ok(watcher) => watcher,
            Err(error) => {
                eprintln!("[index_updater] cannot create watcher: {error}");
                return None;
            }
        };
    // Watch the root so optional trees created after binding are observed too.
    if let Err(error) = watcher.watch(&root, RecursiveMode::Recursive) {
        eprintln!("[index_updater] cannot watch vault: {error}");
        return None;
    }
    Some(watcher)
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
pub(crate) async fn process_batch(
    app: &tauri::AppHandle,
    origin: &AgentVaultSession,
    batch: Vec<String>,
) -> Result<usize, String> {
    build_index(
        app,
        origin,
        batch,
        "builtin-local",
        crate::local_llm::BUILTIN_EMBED_MODEL,
        false,
    )
    .await
}

pub(crate) async fn reindex(
    app: &tauri::AppHandle,
    origin: &AgentVaultSession,
    provider: &str,
    model: &str,
) -> Result<usize, String> {
    build_index(app, origin, vec!["*".into()], provider, model, true).await
}

async fn build_index(
    app: &tauri::AppHandle,
    origin: &AgentVaultSession,
    batch: Vec<String>,
    provider: &str,
    model: &str,
    progress: bool,
) -> Result<usize, String> {
    let _publisher = crate::index_publication::PUBLISHER.lock().await;
    let vault = app.state::<crate::commands::VaultRoot>();
    vault.with_origin(origin, |_| Ok(()))?;
    let root = PathBuf::from(&origin.vault_path);
    let load_root = root.clone();
    let mut pair =
        tauri::async_runtime::spawn_blocking(move || crate::index_publication::load(&load_root))
            .await
            .map_err(|error| format!("index load join: {error}"))??;
    let signature = crate::commands::embedding_index_signature(app, provider, model).await?;
    let model_id = crate::commands::embedding_model_id(provider, model)?;
    let stale_model =
        if provider == "builtin-local" && model == crate::local_llm::BUILTIN_EMBED_MODEL {
            index_is_stale(&pair.store.model)
        } else {
            pair.store.model != model_id
        };
    let stale = stale_model || pair.store.signature != signature;
    let bm25_pages = pair.lexical.pages();
    let reconcile = reconcile_requested(
        &batch,
        stale,
        bm25_is_incomplete(pair.store.indexed_pages(), bm25_pages.len()),
    );
    if stale {
        pair.store.ensure_signature(&model_id, &signature);
    }
    let pages = if reconcile {
        crate::commands::collect_wiki_pages_checked(&root)?
            .into_iter()
            .map(|(rel, stem, content)| (rel, stem, Some(content)))
            .collect::<Vec<_>>()
    } else {
        read_dirty_pages(&root, batch.clone())?
            .into_iter()
            .map(|(rel, content)| {
                let stem = Path::new(&rel)
                    .file_stem()
                    .and_then(|stem| stem.to_str())
                    .unwrap_or("")
                    .to_string();
                (rel, stem, content)
            })
            .collect()
    };
    #[cfg(feature = "native-index-probe")]
    crate::index_publication::probe_hooks::after_scan(&root).await;
    let existing = pair.store.hashes_by_page();
    let mut changed = stale || pair.generation == 0;
    let mut embedded = 0;
    let started = std::time::Instant::now();
    for (position, (rel, stem, content)) in pages.iter().enumerate() {
        vault.with_origin(origin, |_| Ok(()))?;
        emit_progress(app, progress, position, pages.len(), rel, false);
        if let Some(content) = content {
            let outcome = crate::commands::embed_one_page(
                app,
                &app.state::<LocalLlmState>(),
                provider,
                model,
                rel,
                stem,
                content,
                &existing,
                &mut pair.store,
                &mut pair.lexical,
                &bm25_pages,
                origin,
            )
            .await?;
            changed |= outcome.changed;
            embedded += usize::from(outcome.embedded);
            emit_progress(
                app,
                progress,
                position + 1,
                pages.len(),
                rel,
                outcome.embedded,
            );
        } else {
            pair.store.upsert_page(rel, "", Vec::new())?;
            pair.lexical.upsert_page(rel, "", &[]);
            changed = true;
        }
    }
    if reconcile {
        let present = pages
            .iter()
            .map(|(rel, _, _)| rel.clone())
            .collect::<HashSet<_>>();
        changed |= pair.store.prune(&present) > 0;
        changed |= pair.lexical.prune(&present) > 0;
    }
    let indexed = pair.store.indexed_pages();
    if crate::commands::embedding_index_signature(app, provider, model).await? != signature {
        return Err("embedding representation changed before index publication".into());
    }
    if changed {
        pair.generation = pair
            .generation
            .checked_add(1)
            .ok_or("index generation exhausted")?;
        let prepare_root = root.clone();
        let (pair, prepared) = tauri::async_runtime::spawn_blocking(move || {
            let prepared = crate::index_publication::PreparedPair::prepare(&prepare_root, &pair)?;
            Ok::<_, String>((pair, prepared))
        })
        .await
        .map_err(|error| format!("index stage join: {error}"))??;
        if crate::commands::embedding_index_signature(app, provider, model).await? != signature {
            return Err("embedding representation changed while staging index publication".into());
        }
        let path = vault.with_origin(origin, |_| {
            validate_snapshot(&root, &pages, reconcile, &batch)?;
            prepared.commit()
        })?;
        app.state::<VectorCache>().put(&path, pair.store)?;
        app.state::<Bm25Cache>().put_checked(&path, pair.lexical)?;
    } else {
        vault.with_origin(origin, |_| {
            validate_snapshot(&root, &pages, reconcile, &batch)
        })?;
    }
    crate::perf::log(
        "index_batch",
        &[
            ("total_ms", crate::perf::ms(started.elapsed())),
            ("pages", pages.len() as f64),
            ("embedded_pages", embedded as f64),
            ("indexed_pages", indexed as f64),
        ],
    );
    if reconcile {
        if let Some(updater) = crate::INDEX_UPDATER.get() {
            let _ = updater.tx.send(UpdateMsg::Reconciled(origin.clone()));
        }
    }
    Ok(indexed)
}

fn validate_snapshot(
    root: &Path,
    pages: &[(String, String, Option<String>)],
    reconcile: bool,
    batch: &[String],
) -> Result<(), String> {
    let mut current = if reconcile {
        crate::commands::collect_wiki_pages_checked(root)?
            .into_iter()
            .map(|(rel, _, content)| (rel, Some(content)))
            .collect::<Vec<_>>()
    } else {
        read_dirty_pages(root, batch.to_vec())?
    };
    current.sort_by(|first, second| first.0.cmp(&second.0));
    let mut captured = pages
        .iter()
        .map(|(rel, _, content)| (rel.clone(), content.clone()))
        .collect::<Vec<_>>();
    captured.sort_by(|first, second| first.0.cmp(&second.0));
    if current != captured {
        return Err("indexed sources changed during the build; retry required".into());
    }
    Ok(())
}

fn emit_progress(
    app: &tauri::AppHandle,
    enabled: bool,
    done: usize,
    total: usize,
    page: &str,
    embedded: bool,
) {
    if enabled {
        use tauri::Emitter;
        if let Err(error) = app.emit(
            "reindex-progress",
            crate::commands::ReindexProgress {
                done,
                total,
                page: page.into(),
                embedded,
            },
        ) {
            eprintln!("[index_updater] progress event failed: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checked_dirty_batch_distinguishes_content_from_confirmed_missing_page() {
        let vault = tempfile::tempdir().unwrap();
        std::fs::create_dir(vault.path().join("wiki")).unwrap();
        std::fs::write(vault.path().join("wiki/note.md"), "synthetic note").unwrap();
        let pages = read_dirty_pages(
            vault.path(),
            vec!["wiki/note.md".into(), "wiki/deleted.md".into()],
        )
        .unwrap();
        assert_eq!(pages[0].1.as_deref(), Some("synthetic note"));
        assert_eq!(pages[1].1, None);
    }

    #[test]
    fn checked_dirty_batch_rejects_a_missing_vault_root() {
        let vault = tempfile::tempdir().unwrap();
        let result = read_dirty_pages(&vault.path().join("missing"), vec!["wiki/note.md".into()]);
        assert!(result.is_err(), "a missing vault is not a deleted page");
    }

    #[test]
    fn checked_dirty_batch_rejects_a_directory_in_place_of_a_page() {
        let vault = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(vault.path().join("wiki/note.md")).unwrap();
        assert!(read_dirty_pages(vault.path(), vec!["wiki/note.md".into()]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn checked_dirty_batch_stat_failure_preserves_the_indexed_page() {
        let vault = tempfile::tempdir().unwrap();
        let wiki = vault.path().join("wiki");
        std::fs::create_dir(&wiki).unwrap();
        std::fs::write(wiki.join("note.md"), "synthetic note").unwrap();
        let mut store = VectorStore::default();
        store
            .upsert_page("wiki/note.md", "note", vec![(1, vec![1.0, 0.0])])
            .unwrap();
        let mut bm25 = Bm25Index::new();
        bm25.upsert_page("wiki/note.md", "note", &["synthetic note".into()]);
        let denied = crate::vault::scan_tests::DeniedDirectory::new(&wiki);
        let result = read_dirty_pages(vault.path(), vec!["wiki/note.md".into()]);
        if let Ok(pages) = &result {
            for (rel, content) in pages {
                if content.is_none() {
                    store.upsert_page(rel, "", Vec::new()).unwrap();
                    bm25.upsert_page(rel, "", &[]);
                }
            }
        }
        drop(denied);
        assert!(
            result.is_err(),
            "stat denial must not authorize index deletion"
        );
        assert_eq!(store.indexed_pages(), 1);
        assert!(bm25.pages().contains("wiki/note.md"));
    }

    #[test]
    fn checked_dirty_batch_read_failure_aborts_before_any_publication() {
        let vault = tempfile::tempdir().unwrap();
        std::fs::create_dir(vault.path().join("wiki")).unwrap();
        std::fs::write(vault.path().join("wiki/good.md"), "synthetic note").unwrap();
        std::fs::write(vault.path().join("wiki/bad.md"), [0xff]).unwrap();
        assert!(read_dirty_pages(
            vault.path(),
            vec!["wiki/good.md".into(), "wiki/bad.md".into()],
        )
        .is_err());
    }

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
        assert_eq!(batch_delay(&edits, None, debounce, catchup), debounce);
        let rebind: HashSet<String> = ["*".to_string(), "wiki/a.md".to_string()].into();
        assert_eq!(batch_delay(&rebind, None, debounce, catchup), catchup);
    }

    #[test]
    fn size_debounce_holds_big_pages_back_and_lets_small_ones_through() {
        let short = std::time::Duration::from_millis(500);
        assert_eq!(size_debounce(0, short, LONG_PAGE_DEBOUNCE), short);
        assert_eq!(
            size_debounce(LONG_PAGE_BYTES - 1, short, LONG_PAGE_DEBOUNCE),
            short
        );
        assert_eq!(
            size_debounce(LONG_PAGE_BYTES, short, LONG_PAGE_DEBOUNCE),
            LONG_PAGE_DEBOUNCE
        );
        // A real session log from the owner's vault (645 KB).
        assert_eq!(
            size_debounce(645 * 1024, short, LONG_PAGE_DEBOUNCE),
            LONG_PAGE_DEBOUNCE
        );
    }

    #[test]
    fn an_actively_appended_session_log_gets_the_long_debounce() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let debounce = std::time::Duration::from_millis(500);
        let catchup = std::time::Duration::from_secs(180);

        std::fs::create_dir_all(root.join("wiki")).unwrap();
        std::fs::write(root.join("wiki/note.md"), "a short note").unwrap();
        std::fs::create_dir_all(root.join("sessions/2026-08")).unwrap();
        std::fs::write(
            root.join("sessions/2026-08/claude-code.md"),
            "x".repeat((LONG_PAGE_BYTES + 1) as usize),
        )
        .unwrap();

        let small: HashSet<String> = ["wiki/note.md".to_string()].into();
        assert_eq!(
            batch_delay(&small, Some(root), debounce, catchup),
            debounce,
            "an ordinary wiki edit must keep the short debounce"
        );

        // The mixed batch is what a real ingest run produces: the transcript
        // decides, so the whole batch waits for it to settle.
        let mixed: HashSet<String> = [
            "wiki/note.md".to_string(),
            "sessions/2026-08/claude-code.md".to_string(),
        ]
        .into();
        assert_eq!(
            batch_delay(&mixed, Some(root), debounce, catchup),
            LONG_PAGE_DEBOUNCE
        );

        // The rebind sentinel still outranks everything.
        let rebind: HashSet<String> = ["*".to_string()].into();
        assert_eq!(batch_delay(&rebind, Some(root), debounce, catchup), catchup);
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
            [
                "wiki",
                "sessions",
                "daily",
                "weekly",
                "monthly",
                "raw/conversations"
            ]
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
