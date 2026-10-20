//! Opt-in QA process: real Wry AppHandle and native commands, synthetic vaults only.

use std::path::Path;
use tauri::{Listener, Manager};

#[derive(Default)]
struct IpcProbeState {
    ready: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    reply: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<Result<usize, String>>>>,
}

#[tauri::command]
fn probe_webview_ready(state: tauri::State<IpcProbeState>) {
    if let Some(reply) = state.ready.lock().unwrap().take() {
        let _ = reply.send(());
    }
}

#[tauri::command]
fn probe_ipc_reply(
    state: tauri::State<IpcProbeState>,
    value: Option<usize>,
    error: Option<String>,
) {
    if let Some(reply) = state.reply.lock().unwrap().take() {
        let _ = reply.send(error.map_or_else(|| value.ok_or("missing IPC value".into()), Err));
    }
}

fn require(condition: bool, message: &str) -> Result<(), String> {
    condition.then_some(()).ok_or_else(|| message.into())
}

fn read_dense(root: &Path) -> Result<Vec<u8>, String> {
    let path = crate::vector_index::VectorStore::path_for(&root.to_string_lossy())?;
    std::fs::read(path).map_err(|error| error.to_string())
}

async fn manual(app: &tauri::AppHandle) -> Result<usize, String> {
    crate::commands::reindex_embeddings(
        app.clone(),
        app.state(),
        app.state(),
        app.state(),
        app.state(),
        "builtin-local".into(),
        crate::local_llm::BUILTIN_EMBED_MODEL.into(),
    )
    .await
}

fn open(app: &tauri::AppHandle, root: &Path) -> Result<(), String> {
    crate::commands::open_vault(
        app.clone(),
        app.state(),
        root.to_string_lossy().into_owned(),
    )?;
    Ok(())
}

async fn automatic(app: &tauri::AppHandle, batch: Vec<String>) -> Result<usize, String> {
    let origin = app.state::<crate::commands::VaultRoot>().snapshot()?;
    crate::index_updater::process_batch(app, &origin, batch).await
}

fn verify_pair(root: &Path) -> Result<u64, String> {
    let pair = crate::index_publication::load(root)?;
    for (rel, _, content) in crate::commands::collect_wiki_pages_checked(root)? {
        let hashes = crate::embeddings::chunk_page(&content)
            .iter()
            .map(|chunk| crate::embeddings::content_hash(chunk))
            .collect::<Vec<_>>();
        require(
            pair.store.hashes_by_page().get(&rel) == Some(&hashes),
            "dense source hashes do not match the native fixture",
        )?;
        require(
            pair.lexical.page_hashes(&rel) == Some(hashes),
            "lexical source hashes do not match the same native generation",
        )?;
    }
    require(
        crate::vector_index::VectorStore::path_for(&root.to_string_lossy())?
            == crate::retrieval::Bm25Index::path_for(&root.to_string_lossy())?,
        "single-index readers have different publication paths",
    )?;
    Ok(pair.generation)
}

async fn verify_automatic(app: &tauri::AppHandle, root: &Path) -> Result<(), String> {
    open(app, root)?;
    automatic(app, vec!["*".into()]).await?;
    let before = read_dense(root)?;
    let close_app = app.clone();
    crate::index_publication::probe_hooks::install_after_scan(move || async move {
        crate::commands::close_vault(close_app.state()).unwrap();
    });
    require(
        automatic(app, vec!["*".into()]).await.is_err(),
        "automatic build published after native close",
    )?;
    require(
        read_dense(root)? == before,
        "automatic close changed the prior pair",
    )?;
    open(app, root)?;

    let invalid = root.join("wiki/unreadable.md");
    std::fs::write(&invalid, [0xff]).map_err(|error| error.to_string())?;
    require(
        manual(app).await.is_err(),
        "manual read failure was treated as an empty scan",
    )?;
    require(
        automatic(app, vec!["*".into()]).await.is_err(),
        "automatic read failure was treated as an empty scan",
    )?;
    require(
        read_dense(root)? == before,
        "failed scan changed the persisted pair",
    )?;
    std::fs::remove_file(invalid).map_err(|error| error.to_string())?;
    automatic(app, vec!["*".into()]).await?;
    verify_pair(root)?;

    let snapshot = crate::index_publication::snapshot(root.to_path_buf()).await?;
    let old_hashes = snapshot.store.hashes_by_page();
    let old_lexical = snapshot.lexical.page_hashes("wiki/note.md");
    let (reached, ready) = tokio::sync::oneshot::channel();
    let (release, held) = tokio::sync::oneshot::channel();
    crate::index_publication::probe_hooks::install_after_scan(move || async move {
        let _ = reached.send(());
        tokio::time::timeout(std::time::Duration::from_secs(10), held)
            .await
            .unwrap()
            .unwrap();
    });
    let auto_app = app.clone();
    let automatic_task =
        tauri::async_runtime::spawn(async move { automatic(&auto_app, vec!["*".into()]).await });
    tokio::time::timeout(std::time::Duration::from_secs(10), ready)
        .await
        .map_err(|_| "automatic publisher barrier timed out")?
        .map_err(|_| "automatic publisher barrier stopped")?;
    let manual_app = app.clone();
    let mut manual_task = tauri::async_runtime::spawn(async move { manual(&manual_app).await });
    require(
        tokio::time::timeout(std::time::Duration::from_millis(50), &mut manual_task)
            .await
            .is_err(),
        "manual writer bypassed the automatic publisher lock",
    )?;
    std::fs::write(
        root.join("wiki/note.md"),
        "# Synthetic note\nThe concurrent human edit is the final source.",
    )
    .map_err(|error| error.to_string())?;
    release
        .send(())
        .map_err(|_| "automatic publisher barrier stopped")?;
    require(
        automatic_task
            .await
            .map_err(|error| error.to_string())?
            .is_err(),
        "stale automatic publisher did not reject the edit",
    )?;
    manual_task.await.map_err(|error| error.to_string())??;
    require(
        verify_pair(root)? > snapshot.generation,
        "queued manual publication did not advance generation",
    )?;
    require(
        snapshot.store.hashes_by_page() == old_hashes
            && snapshot.lexical.page_hashes("wiki/note.md") == old_lexical,
        "a held query snapshot changed during later publication",
    )?;
    Ok(())
}

async fn verify_actor(app: &tauri::AppHandle, root: &Path, sandbox: &Path) -> Result<(), String> {
    let updater = crate::index_updater::IndexUpdater::spawn(app.clone());
    crate::INDEX_UPDATER
        .set(updater.clone())
        .map_err(|_| "native QA actor was already configured")?;
    open(app, root)?;
    manual(app).await?;
    let old = app.state::<crate::commands::VaultRoot>().snapshot()?;
    let _ = updater.probe_state().await?;
    let other = sandbox.join("other-vault");
    std::fs::create_dir_all(other.join("wiki")).map_err(|error| error.to_string())?;
    let other = other.canonicalize().map_err(|error| error.to_string())?;
    std::fs::write(
        other.join("wiki/note.md"),
        "# Other synthetic vault\nThe other source stays independent.",
    )
    .map_err(|error| error.to_string())?;
    open(app, &other)?;
    manual(app).await?;
    let _ = updater.probe_state().await?;
    updater.enqueue_probe_dirty(old.clone(), "wiki/late.md");
    updater.mark_dirty(root, "wiki/wrong-root.md");
    let (active, dirty) = updater.probe_state().await?;
    require(
        active.is_some_and(|origin| origin.vault_path == other.to_string_lossy()),
        "actor did not bind the native opening",
    )?;
    require(
        !dirty.contains("wiki/late.md") && !dirty.contains("wiki/wrong-root.md"),
        "old callback dirtied the new vault",
    )?;
    crate::commands::close_vault(app.state())?;
    updater.enqueue_probe_dirty(old, "wiki/late.md");
    let (active, dirty) = updater.probe_state().await?;
    require(
        active.is_none() && dirty.is_empty(),
        "native close left the actor or old watcher bound",
    )?;
    require(
        updater.watcher_is_stopped_for_probe(),
        "native close retained its filesystem watcher",
    )?;

    open(app, root)?;
    manual(app).await?;
    let _ = updater.probe_state().await?;
    // This optional tree did not exist when the root watcher was attached.
    std::fs::create_dir_all(root.join("monthly")).map_err(|error| error.to_string())?;
    std::fs::write(
        root.join("monthly/synthetic-new-tree.md"),
        "# Synthetic monthly note\nThe newly created watched tree must be indexed.",
    )
    .map_err(|error| error.to_string())?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        let pair = crate::index_publication::load(root)?;
        if pair
            .store
            .hashes_by_page()
            .contains_key("monthly/synthetic-new-tree.md")
            && pair
                .lexical
                .pages()
                .contains("monthly/synthetic-new-tree.md")
        {
            break;
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("real root watcher missed a tree created after binding".into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    verify_pair(root)?;
    crate::commands::close_vault(app.state())?;
    let _ = updater.probe_state().await?;
    Ok(())
}

async fn verify_webview_dispatch(app: &tauri::AppHandle, root: &Path) -> Result<(), String> {
    open(app, root)?;
    let (ready, ready_result) = tokio::sync::oneshot::channel();
    *app.state::<IpcProbeState>().ready.lock().unwrap() = Some(ready);
    let window = tauri::WebviewWindowBuilder::new(
        app,
        "native-index-probe",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .visible(false)
    .build()
    .map_err(|error| error.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(20), ready_result)
        .await
        .map_err(|_| "native QA webview did not establish IPC")?
        .map_err(|_| "native QA webview ready callback dropped")?;
    let (reply, result) = tokio::sync::oneshot::channel();
    *app.state::<IpcProbeState>().reply.lock().unwrap() = Some(reply);
    let model = serde_json::to_string(crate::local_llm::BUILTIN_EMBED_MODEL)
        .map_err(|error| error.to_string())?;
    window.eval(format!("(async()=>{{try{{const value=await window.__TAURI_INTERNALS__.invoke('reindex_embeddings',{{provider:'builtin-local',model:{model}}});await window.__TAURI_INTERNALS__.invoke('probe_ipc_reply',{{value,error:null}});}}catch(error){{await window.__TAURI_INTERNALS__.invoke('probe_ipc_reply',{{value:null,error:String(error)}});}}}})()"))
        .map_err(|error| error.to_string())?;
    let indexed = tokio::time::timeout(std::time::Duration::from_secs(30), result)
        .await
        .map_err(|_| "native QA reindex IPC timed out")?
        .map_err(|_| "native QA reindex IPC reply dropped")??;
    require(
        indexed == 2,
        "actual webview invoke returned an unexpected native index count",
    )?;
    verify_pair(root)?;
    window.close().map_err(|error| error.to_string())?;
    crate::commands::close_vault(app.state())?;
    let _ = crate::INDEX_UPDATER.get().unwrap().probe_state().await?;
    Ok(())
}

async fn verify(app: tauri::AppHandle, sandbox: &Path) -> Result<(), String> {
    require(
        app.config().identifier == "dev.cmblir.myco.native-index-qa",
        "native QA identity required",
    )?;
    require(
        crate::settings::settings_dir()? == sandbox.join("data"),
        "native QA data directory escaped isolation",
    )?;
    let root = sandbox.join("vault");
    std::fs::create_dir_all(root.join("wiki")).map_err(|error| error.to_string())?;
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let note = root.join("wiki/note.md");
    std::fs::write(
        &note,
        "# Synthetic note\nThe synthetic release remains pending.",
    )
    .map_err(|error| error.to_string())?;
    crate::commands::open_vault(
        app.clone(),
        app.state(),
        root.to_string_lossy().into_owned(),
    )?;
    require(
        manual(&app).await? == 1,
        "initial native index missing a page",
    )?;
    let before = read_dense(&root)?;
    let mut failures = Vec::new();
    std::fs::write(
        &note,
        "# Synthetic note\nThe scanned edit is already outdated.",
    )
    .map_err(|error| error.to_string())?;

    // The real native progress event is a deterministic barrier after the scan.
    let fired = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let fired_listener = fired.clone();
    let listener_note = note.clone();
    let listener = app.listen("reindex-progress", move |_event| {
        if !fired_listener.swap(true, std::sync::atomic::Ordering::SeqCst) {
            std::fs::write(
                &listener_note,
                "# Synthetic note\nA later human edit must survive.",
            )
            .unwrap();
        }
    });
    let result = manual(&app).await;
    app.unlisten(listener);
    require(
        fired.load(std::sync::atomic::Ordering::SeqCst),
        "native progress barrier did not fire",
    )?;
    if result.is_ok() {
        failures.push("native rebuild published a stale source snapshot");
    }
    if read_dense(&root)? != before {
        failures.push("stale source replaced the prior index");
    }
    require(
        manual(&app).await? == 1,
        "native rebuild did not recover after the edit",
    )?;
    let before_close = read_dense(&root)?;
    std::fs::write(
        &note,
        "# Synthetic note\nA queued build must not publish after close.",
    )
    .map_err(|error| error.to_string())?;

    let close_app = app.clone();
    let fired = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let fired_listener = fired.clone();
    let listener = app.listen("reindex-progress", move |_event| {
        if !fired_listener.swap(true, std::sync::atomic::Ordering::SeqCst) {
            crate::commands::close_vault(close_app.state()).unwrap();
        }
    });
    let result = manual(&app).await;
    app.unlisten(listener);
    require(
        fired.load(std::sync::atomic::Ordering::SeqCst),
        "native close barrier did not fire",
    )?;
    if result.is_ok() {
        failures.push("native rebuild published after close");
    }
    if read_dense(&root)? != before_close {
        failures.push("late rebuild changed the closed vault index");
    }
    if !failures.is_empty() {
        return Err(failures.join("; "));
    }
    verify_automatic(&app, &root).await?;
    verify_actor(&app, &root, sandbox).await?;
    verify_webview_dispatch(&app, &root).await?;
    println!(
        "{}",
        serde_json::json!({"probe":"native_index","transport":"real_wry_webview_invoke_and_native_commands","model":crate::local_llm::BUILTIN_EMBED_MODEL,"source_edit_barrier":"passed","close_barrier":"passed","automatic_close":"passed","scan_failure_recovery":"passed","single_publisher_barrier":"passed","held_snapshot":"passed","root_bound_dirty":"passed","watcher_new_tree":"passed","webview_reindex_invoke":"passed"})
    );
    Ok(())
}

/// Launch a separate QA identity without the production setup, providers or vault.
pub fn run() -> i32 {
    let sandbox = tempfile::Builder::new()
        .prefix("myco-native-index-qa-")
        .tempdir()
        .unwrap();
    std::env::set_var("MYCO_DATA_DIR", sandbox.path().join("data"));
    std::env::remove_var("MEMEX_DATA_DIR");
    let root = sandbox.path().to_path_buf();
    let result_code = std::sync::Arc::new(std::sync::atomic::AtomicI32::new(2));
    let task_result_code = result_code.clone();
    let _runtime_code = tauri::Builder::default()
        .manage(crate::commands::VaultRoot::default())
        .manage(crate::commands::LocalLlmState::default())
        .manage(crate::vector_index::VectorCache::default())
        .manage(crate::retrieval::Bm25Cache::default())
        .manage(IpcProbeState::default())
        .invoke_handler(tauri::generate_handler![
            crate::commands::reindex_embeddings,
            crate::commands::open_vault,
            crate::commands::close_vault,
            probe_webview_ready,
            probe_ipc_reply
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let result_code = task_result_code.clone();
            tauri::async_runtime::spawn(async move {
                let result = verify(handle.clone(), &root).await;
                if let Err(error) = &result {
                    eprintln!("native_index_probe failed: {error}");
                }
                if let Err(error) = handle
                    .state::<crate::commands::LocalLlmState>()
                    .unload_probe_embedding()
                {
                    eprintln!("native_index_probe teardown failed: {error}");
                    result_code.store(1, std::sync::atomic::Ordering::SeqCst);
                    handle.exit(1);
                    return;
                }
                let code = if result.is_ok() { 0 } else { 1 };
                result_code.store(code, std::sync::atomic::Ordering::SeqCst);
                handle.exit(code);
            });
            Ok(())
        })
        .build(crate::app_context())
        .expect("native index QA app build failed")
        .run_return(|_, event| {
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
                api.prevent_exit();
            }
        });
    drop(sandbox);
    result_code.load(std::sync::atomic::Ordering::SeqCst)
}
