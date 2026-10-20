//! Opt-in real Wry import checks, using isolated synthetic sources and vaults.

use std::path::{Path, PathBuf};
use tauri::{Listener, Manager};

type Reply = tokio::sync::oneshot::Sender<Result<serde_json::Value, String>>;

#[derive(Default)]
struct ProbeState {
    ready: std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    reply: std::sync::Mutex<Option<(String, Reply)>>,
}

#[tauri::command]
fn probe_webview_ready(state: tauri::State<ProbeState>) {
    if let Some(reply) = state.ready.lock().unwrap().take() {
        let _ = reply.send(());
    }
}

#[tauri::command]
fn probe_import_reply(
    state: tauri::State<ProbeState>,
    request_id: String,
    value: Option<serde_json::Value>,
    error: Option<String>,
) -> Result<(), String> {
    let mut pending = state
        .reply
        .lock()
        .map_err(|_| "probe reply lock poisoned")?;
    if pending.as_ref().map(|(id, _)| id) != Some(&request_id) {
        return Err("unexpected native import probe reply".into());
    }
    if let Some((_, reply)) = pending.take() {
        let _ =
            reply.send(error.map_or_else(|| value.ok_or("missing import IPC reply".into()), Err));
    }
    Ok(())
}

fn require(condition: bool, error: &str) -> Result<(), String> {
    condition.then_some(()).ok_or_else(|| error.into())
}

fn open(app: &tauri::AppHandle, root: &Path) -> Result<(), String> {
    crate::commands::open_vault(
        app.clone(),
        app.state(),
        root.to_string_lossy().into_owned(),
    )?;
    Ok(())
}

fn source(directory: &Path, id: &str, codex: bool) -> Result<PathBuf, String> {
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let path = directory.join(format!("{id}.jsonl"));
    let text = format!("A synthetic person researched the {id} design decision. ").repeat(24);
    let body = if codex {
        let meta = serde_json::json!({"type":"session_meta", "timestamp":"2026-10-09T12:00:00Z", "payload":{"id":id}});
        let turn = serde_json::json!({"type":"response_item", "timestamp":"2026-10-09T12:00:00Z", "payload":{"type":"message", "id":"turn-1", "role":"user", "content":[{"type":"input_text", "text":text}]}});
        format!("{meta}\n{turn}\n")
    } else {
        let turn = serde_json::json!({"type":"user", "uuid":"turn-1", "sessionId":id,
            "timestamp":"2026-10-09T12:00:00Z", "message":{"role":"user", "content":text}});
        format!("{turn}\n")
    };
    std::fs::write(&path, body).map_err(|error| error.to_string())?;
    Ok(path)
}

fn no_publication(root: &Path) -> Result<(), String> {
    require(
        !root.join("raw").exists()
            && !root.join("sessions").exists()
            && !root.join("_inbox").exists()
            && !root.join(".myco/ledger.json").exists()
            && !crate::importers::wikify::Pending::path(root).exists(),
        "stale native import mutated a synthetic vault",
    )
}

#[derive(Clone, Copy)]
struct Entry {
    name: &'static str,
    command: &'static str,
    kind: Option<&'static str>,
    dest: &'static str,
}

impl Entry {
    fn arguments(self, path: &Path, request_id: &str) -> serde_json::Value {
        match self.command {
            "import_conversations" => {
                serde_json::json!({"sourcePath":path, "requestId":request_id})
            }
            "import_paths" => {
                serde_json::json!({"paths":[path], "dest":self.dest, "requestId":request_id})
            }
            "import_session_sweep" => serde_json::json!({"kind":self.kind, "requestId":request_id}),
            _ => unreachable!("fixed native probe command"),
        }
    }
}

struct Invocation {
    reply: Result<serde_json::Value, String>,
    progress: Vec<serde_json::Value>,
}

async fn invoke(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    command: &str,
    arguments: serde_json::Value,
) -> Result<Invocation, String> {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let probe_id = format!(
        "native-probe-{}",
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    );
    let (reply, result) = tokio::sync::oneshot::channel();
    *app.state::<ProbeState>().reply.lock().unwrap() = Some((probe_id.clone(), reply));
    let progress = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let events = progress.clone();
    let listener = app.listen("import-progress", move |event| {
        events
            .lock()
            .unwrap()
            .push(serde_json::from_str::<serde_json::Value>(event.payload()));
    });
    let command = serde_json::to_string(command).map_err(|error| error.to_string())?;
    let probe_id = serde_json::to_string(&probe_id).map_err(|error| error.to_string())?;
    let dispatch = window.eval(format!("(async()=>{{try{{const value=await window.__TAURI_INTERNALS__.invoke({command},{arguments});await window.__TAURI_INTERNALS__.invoke('probe_import_reply',{{requestId:{probe_id},value,error:null}});}}catch(error){{await window.__TAURI_INTERNALS__.invoke('probe_import_reply',{{requestId:{probe_id},value:null,error:String(error)}});}}}})()"));
    let received = match dispatch {
        Ok(()) => match tokio::time::timeout(std::time::Duration::from_secs(20), result).await {
            Ok(reply) => reply.map_err(|_| "native import WebView reply dropped".to_string()),
            Err(_) => Err("native import WebView invocation timed out".into()),
        },
        Err(error) => Err(error.to_string()),
    };
    app.unlisten(listener);
    let reply = received?;
    let progress = progress
        .lock()
        .unwrap()
        .drain(..)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("invalid native progress payload: {error}"))?;
    Ok(Invocation { reply, progress })
}

fn progress_identity(
    progress: &[serde_json::Value],
    origin: &crate::commands::AgentVaultSession,
    request_id: &str,
) -> Result<(), String> {
    let origin = serde_json::to_value(origin).map_err(|error| error.to_string())?;
    require(!progress.is_empty(), "native command emitted no progress")?;
    require(
        progress
            .iter()
            .all(|event| event["origin"] == origin && event["requestId"] == request_id),
        "native progress escaped the captured opening or request identity",
    )
}

fn publication(root: &Path, input: &Path, entry: Entry) -> Result<serde_json::Value, String> {
    use crate::importers::{
        ledger::Ledger,
        wikify::{source_revision, Pending},
    };
    let text = std::fs::read_to_string(input).map_err(|error| error.to_string())?;
    let plan = crate::importers::plan_import(&input.to_string_lossy(), &text, &Ledger::default())?;
    require(
        plan.docs.len() == 1,
        "synthetic source did not yield one admitted document",
    )?;
    let doc = &plan.docs[0];
    let vendor = doc
        .key
        .split_once(':')
        .ok_or("invalid synthetic source key")?
        .0;
    let raw_path = format!(
        "raw/conversations/{vendor}/{}-{}.md",
        doc.stem, doc.fingerprint
    );
    let raw = std::fs::read_to_string(root.join(&raw_path)).map_err(|error| error.to_string())?;
    require(
        raw == doc.body,
        "immutable normalized source differs from admitted bytes",
    )?;
    let original_path = raw_path.trim_end_matches(".md").to_owned() + ".jsonl";
    let original =
        std::fs::read_to_string(root.join(&original_path)).map_err(|error| error.to_string())?;
    require(
        original == format!("{}\n", doc.original_records),
        "recorded original turns differ from admitted source",
    )?;
    let ledger = Ledger::load(root)?;
    require(
        ledger.seen(&doc.key, &doc.fingerprint),
        "native ledger lost admitted source lineage",
    )?;
    let projection_path = ledger
        .location(entry.dest, &doc.key)
        .ok_or("native ledger has no projection location")?;
    let projection =
        std::fs::read_to_string(root.join(projection_path)).map_err(|error| error.to_string())?;
    let queued = entry.dest == "sessions";
    let queue = Pending::try_load(root)?;
    require(
        queue.receipts.is_empty(),
        "source admission was incorrectly marked compiled",
    )?;
    if queued {
        require(
            queue.pending.len() == 1,
            "native source admission did not persist one pending revision",
        )?;
        let item = &queue.pending[0];
        require(
            item.key == doc.key
                && item.raw_path == raw_path
                && item.source_revision == source_revision(&raw),
            "native queue revision differs from immutable admitted bytes",
        )?;
    } else {
        require(
            queue.pending.is_empty() && !Pending::path(root).exists(),
            "manual inbox import unexpectedly queued session organization",
        )?;
    }
    Ok(
        serde_json::json!({"raw_path":raw_path, "raw_sha256":source_revision(&raw),
        "original_path":original_path, "original_sha256":source_revision(&original),
        "projection_path":projection_path, "projection_sha256":source_revision(&projection),
        "queue_pending":queue.pending.len(), "compiled_receipts":queue.receipts.len()}),
    )
}

fn log_gate(entry: Entry, gate: &str, proof: serde_json::Value) {
    println!(
        "{}",
        serde_json::json!({"probe":"native_import", "command":entry.command,
        "case":entry.name, "gate":gate, "result":"passed", "proof":proof})
    );
}

async fn verify_entry(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    sandbox: &Path,
    entry: Entry,
    input: &Path,
) -> Result<(), String> {
    let root = sandbox.join(entry.name);
    std::fs::create_dir_all(root.join("wiki")).map_err(|error| error.to_string())?;
    open(app, &root)?;
    let origin = app.state::<crate::commands::VaultRoot>().snapshot()?;
    let request_id = format!("native-{}", entry.name);
    let absent = invoke(
        app,
        window,
        entry.command,
        entry.arguments(input, &request_id),
    )
    .await?;
    require(
        absent
            .reply
            .as_ref()
            .is_err_and(|error| error.contains("origin")),
        "public native import did not reject missing opening identity",
    )?;
    require(
        absent.progress.is_empty(),
        "invalid import request emitted progress",
    )?;
    no_publication(&root)?;
    log_gate(
        entry,
        "missing_origin",
        serde_json::json!({"publication":"absent"}),
    );

    open(app, &root)?;
    let mut arguments = entry.arguments(input, &request_id);
    arguments["origin"] = serde_json::to_value(&origin).map_err(|error| error.to_string())?;
    let stale = invoke(app, window, entry.command, arguments).await?;
    require(
        stale
            .reply
            .as_ref()
            .is_err_and(|error| error.contains("active vault changed")),
        "public native import did not reject stale same-path opening",
    )?;
    require(
        stale.progress.is_empty(),
        "stale import request emitted progress",
    )?;
    no_publication(&root)?;
    log_gate(
        entry,
        "stale_origin",
        serde_json::json!({"publication":"absent"}),
    );

    let current = app.state::<crate::commands::VaultRoot>().snapshot()?;
    let mut arguments = entry.arguments(input, &request_id);
    arguments["origin"] = serde_json::to_value(&current).map_err(|error| error.to_string())?;
    let admitted = invoke(app, window, entry.command, arguments).await?;
    progress_identity(&admitted.progress, &current, &request_id)?;
    let outcome = admitted.reply?;
    require(
        outcome["imported"] == 1
            && outcome["failed"].as_array().is_some_and(Vec::is_empty)
            && outcome["quarantined"].as_array().is_some_and(Vec::is_empty),
        "public native import did not admit the current synthetic source",
    )?;
    log_gate(
        entry,
        "current_admission",
        publication(&root, input, entry)?,
    );

    for (gate, close) in [
        ("close_after_parse", true),
        ("same_path_reopen_after_parse", false),
    ] {
        let root = sandbox.join(format!("{}-{gate}", entry.name));
        std::fs::create_dir_all(root.join("wiki")).map_err(|error| error.to_string())?;
        open(app, &root)?;
        let origin = app.state::<crate::commands::VaultRoot>().snapshot()?;
        let changed_app = app.clone();
        let changed_root = root.clone();
        crate::commands::import_admission::probe_hooks::install_after_parse(move || {
            if close {
                crate::commands::close_vault(changed_app.state()).unwrap();
            } else {
                open(&changed_app, &changed_root).unwrap();
            }
        });
        let mut arguments = entry.arguments(input, &request_id);
        arguments["origin"] = serde_json::to_value(&origin).map_err(|error| error.to_string())?;
        let rejected = invoke(app, window, entry.command, arguments).await?;
        progress_identity(&rejected.progress, &origin, &request_id)?;
        let outcome = rejected.reply?;
        require(
            outcome["imported"] == 0
                && outcome["failed"]
                    .as_array()
                    .is_some_and(|failed| failed.len() == 1),
            "public import accepted opening invalidated after source parsing",
        )?;
        no_publication(&root)?;
        log_gate(
            entry,
            gate,
            serde_json::json!({"publication":"absent", "progress_bound_to_original_request":true}),
        );
    }
    Ok(())
}

async fn verify(app: tauri::AppHandle, sandbox: &Path) -> Result<(), String> {
    require(
        app.config().identifier == "dev.cmblir.myco.native-index-qa",
        "isolated native QA identity required",
    )?;
    require(
        crate::settings::settings_dir()? == sandbox.join("data"),
        "native import QA settings escaped isolation",
    )?;
    let discovery = sandbox.join("discovery");
    let claude = source(&discovery.join("claude-code"), "native-sweep-claude", false)?;
    let codex = source(&discovery.join("codex"), "native-sweep-codex", true)?;
    require(
        crate::commands::install_probe_session_root(sandbox, sandbox).is_err(),
        "QA discovery accepted the sandbox root instead of a child",
    )?;
    let outside = tempfile::Builder::new()
        .prefix("myco-native-import-outside-")
        .tempdir()
        .map_err(|error| error.to_string())?;
    require(
        crate::commands::install_probe_session_root(sandbox, outside.path()).is_err(),
        "QA discovery accepted a directory outside its owned sandbox",
    )?;
    #[cfg(unix)]
    {
        let link = discovery.join("linked-input");
        std::os::unix::fs::symlink(outside.path(), &link).map_err(|error| error.to_string())?;
        require(
            crate::commands::install_probe_session_root(sandbox, &discovery).is_err(),
            "QA discovery followed a child symbolic link",
        )?;
        std::fs::remove_file(link).map_err(|error| error.to_string())?;
    }
    crate::commands::install_probe_session_root(sandbox, &discovery)?;
    require(
        crate::commands::install_probe_session_root(sandbox, &discovery).is_err(),
        "QA discovery was reconfigured after initialization",
    )?;
    println!(
        "{}",
        serde_json::json!({"probe":"native_import", "gate":"qa_discovery_guard",
        "result":"passed", "outside_rejected":true, "root_rejected":true,
        "child_link_rejected":cfg!(unix), "once_initialized":true})
    );
    let settings = crate::settings::Settings {
        auto_ingest_enabled: true,
        ..crate::settings::Settings::default()
    };
    crate::settings::save(&settings)?;
    let (ready, result) = tokio::sync::oneshot::channel();
    *app.state::<ProbeState>().ready.lock().unwrap() = Some(ready);
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        "native-import-probe",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .visible(false)
    .build()
    .map_err(|error| error.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(20), result)
        .await
        .map_err(|_| "native import QA WebView did not establish IPC")?
        .map_err(|_| "native import QA WebView ready callback dropped")?;
    let cases = [
        (
            Entry {
                name: "ipc-conversations",
                command: "import_conversations",
                kind: None,
                dest: "_inbox",
            },
            source(&sandbox.join("inputs"), "native-export", false)?,
        ),
        (
            Entry {
                name: "ipc-paths",
                command: "import_paths",
                kind: None,
                dest: "sessions",
            },
            source(&sandbox.join("inputs"), "native-retry", false)?,
        ),
        (
            Entry {
                name: "ipc-sweep-claude",
                command: "import_session_sweep",
                kind: Some("claude-code"),
                dest: "sessions",
            },
            claude,
        ),
        (
            Entry {
                name: "ipc-sweep-codex",
                command: "import_session_sweep",
                kind: Some("codex"),
                dest: "sessions",
            },
            codex,
        ),
    ];
    for (entry, input) in cases {
        verify_entry(&app, &window, sandbox, entry, &input).await?;
    }
    window.close().map_err(|error| error.to_string())?;
    crate::commands::close_vault(app.state())?;
    println!(
        "{}",
        serde_json::json!({"probe":"native_import", "result":"passed",
        "transport":"real_wry_webview_invoke", "commands":["import_conversations", "import_paths", "import_session_sweep"],
        "gates_per_case":5, "cases":4, "model_inference":false, "private_discovery":false,
        "discovery":"QA-only synthetic override", "installed_acceptance":false, "semantic_acceptance":false})
    );
    Ok(())
}

/// Use the separate QA runtime without production setup, providers, or a user vault.
pub fn run() -> i32 {
    let sandbox = tempfile::Builder::new()
        .prefix("myco-native-import-qa-")
        .tempdir()
        .unwrap();
    std::env::set_var("MYCO_DATA_DIR", sandbox.path().join("data"));
    std::env::remove_var("MEMEX_DATA_DIR");
    let root = sandbox.path().to_path_buf();
    let code = std::sync::Arc::new(std::sync::atomic::AtomicI32::new(2));
    let task_code = code.clone();
    tauri::Builder::default()
        .manage(crate::commands::VaultRoot::default())
        .manage(ProbeState::default())
        .invoke_handler(tauri::generate_handler![
            crate::commands::import_conversations,
            crate::commands::import_paths,
            crate::commands::import_session_sweep,
            probe_webview_ready,
            probe_import_reply
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let code = task_code.clone();
            tauri::async_runtime::spawn(async move {
                let result = verify(handle.clone(), &root).await;
                if let Err(error) = &result {
                    eprintln!("native_import_probe failed: {error}");
                }
                let exit = if result.is_ok() { 0 } else { 1 };
                code.store(exit, std::sync::atomic::Ordering::SeqCst);
                handle.exit(exit);
            });
            Ok(())
        })
        .build(crate::app_context())
        .expect("native import QA app build failed")
        .run_return(|_, event| {
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = event
            {
                api.prevent_exit();
            }
        });
    code.load(std::sync::atomic::Ordering::SeqCst)
}
