//! Opt-in real Wry consumer baselines over isolated admitted sources.
//! Source citations and quoted previews are not semantic compiler completion.

use std::path::Path;
use tauri::{Listener, Manager};

mod failure;
mod live_view;

type Reply = tokio::sync::oneshot::Sender<Result<serde_json::Value, serde_json::Value>>;

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
    value: serde_json::Value,
    error: Option<serde_json::Value>,
) -> Result<(), String> {
    let mut pending = state
        .reply
        .lock()
        .map_err(|_| "probe reply lock poisoned")?;
    if pending.as_ref().map(|(id, _)| id) != Some(&request_id) {
        return Err("unexpected native import probe reply".into());
    }
    if let Some((_, reply)) = pending.take() {
        // Unit-returning commands serialize a successful null value. Keep it
        // distinct from an error instead of treating it as a missing reply.
        let _ = reply.send(error.map_or(Ok(value), Err));
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

struct Invocation {
    reply: Result<serde_json::Value, String>,
    progress: Vec<serde_json::Value>,
}

struct WireInvocation {
    reply: Result<serde_json::Value, serde_json::Value>,
    progress: Vec<serde_json::Value>,
}

async fn invoke_raw(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    command: &str,
    arguments: serde_json::Value,
) -> Result<WireInvocation, String> {
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
    let dispatch = window.eval(format!("(async()=>{{try{{const value=await window.__TAURI_INTERNALS__.invoke({command},{arguments});await window.__TAURI_INTERNALS__.invoke('probe_import_reply',{{requestId:{probe_id},value,error:null}});}}catch(error){{await window.__TAURI_INTERNALS__.invoke('probe_import_reply',{{requestId:{probe_id},value:null,error}});}}}})()"));
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
    Ok(WireInvocation { reply, progress })
}

async fn invoke(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    command: &str,
    arguments: serde_json::Value,
) -> Result<Invocation, String> {
    let result = invoke_raw(app, window, command, arguments).await?;
    Ok(Invocation {
        reply: result.reply.map_err(|error| {
            error
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| error.to_string())
        }),
        progress: result.progress,
    })
}

fn gate(name: &str, passed: bool) -> Result<(), String> {
    println!(
        "{}",
        serde_json::json!({"probe":"native_session_consumer","gate":name,
        "result":if passed {"passed"} else {"failed"},"transport":"real_wry_webview_invoke","model_inference":false})
    );
    require(passed, name)
}

async fn verify_attempts(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    root: &Path,
    item: &crate::importers::wikify::PendingItem,
) -> Result<(), String> {
    let origin = app.state::<crate::commands::VaultRoot>().snapshot()?;
    let begin=invoke(app,window,"session_compile_begin",serde_json::json!({"origin":origin,
        "source":{"key":item.key,"rawPath":item.raw_path,"sourceRevision":item.source_revision},"usage":"foreground"})).await?;
    let context = begin.reply?;
    gate(
        "native_attempt_positive_control_without_weights",
        context["attemptId"].is_string()
            && context["roleSnapshot"]["routeSignature"]["providerId"] == "builtin-local",
    )?;
    let attempt = context["attemptId"]
        .as_str()
        .ok_or("attempt issuer missing")?;
    let summary = context["summaryPath"]
        .as_str()
        .ok_or("summary issuer missing")?;
    gate(
        "canonical_summary_reuses_human_annotated_path",
        summary == "wiki/session.md",
    )?;
    let raw = invoke(
        app,
        window,
        "session_compile_read",
        serde_json::json!({"context":context,"path":item.raw_path}),
    )
    .await?;
    gate(
        "source_read_uses_issued_current_attempt",
        raw.reply
            .as_ref()
            .is_ok_and(|value| value["revision"] == item.source_revision),
    )?;
    let raw_before = std::fs::read(root.join(&item.raw_path)).map_err(|error| error.to_string())?;
    let denied=invoke(app,window,"session_compile_publish",serde_json::json!({"context":context,"path":item.raw_path,"content":"Synthetic rejected raw overwrite","expectedRevision":item.source_revision})).await?;
    gate(
        "publisher_rejects_immutable_raw_target",
        denied.reply.is_err()
            && std::fs::read(root.join(&item.raw_path)).map_err(|error| error.to_string())?
                == raw_before,
    )?;
    let mut forged = context.clone();
    forged["compileSignature"] = serde_json::json!("0".repeat(64));
    let denied = invoke(
        app,
        window,
        "session_compile_read",
        serde_json::json!({"context":forged,"path":item.raw_path}),
    )
    .await?;
    gate(
        "caller_compile_signature_cannot_restore_native_authority",
        denied.reply.is_err(),
    )?;
    let read = invoke(
        app,
        window,
        "session_compile_read",
        serde_json::json!({"context":context,"path":summary}),
    )
    .await?
    .reply?;
    let content = read["raw"]
        .as_str()
        .ok_or("summary read omitted original")?;
    let edited = format!("{content}\nLater human annotation remains.\n");
    std::fs::write(root.join(summary), &edited).map_err(|error| error.to_string())?;
    let denied=invoke(app,window,"session_compile_publish",serde_json::json!({"context":context,"path":summary,
        "content":format!("{content}\nSynthetic new source evidence.\n"),"expectedRevision":read["revision"]})).await?;
    gate(
        "publisher_conflict_preserves_later_human_edit",
        denied.reply.is_err()
            && std::fs::read_to_string(root.join(summary)).map_err(|error| error.to_string())?
                == edited,
    )?;
    let current = invoke(
        app,
        window,
        "session_compile_read",
        serde_json::json!({"context":context,"path":summary}),
    )
    .await?
    .reply?;
    let appended = format!("{edited}\nSynthetic quoted preview.[^src-synthetic]\n");
    let published = invoke(
        app,
        window,
        "session_compile_publish",
        serde_json::json!({"context":context,"path":summary,
        "content":appended,"expectedRevision":current["revision"]}),
    )
    .await?
    .reply?;
    gate(
        "checked_publisher_retains_human_title_and_annotations",
        published["attemptId"] == attempt
            && std::fs::read_to_string(root.join(summary))
                .map_err(|error| error.to_string())?
                .starts_with(&edited),
    )?;
    let outcome=invoke(app,window,"wikify_complete_source",serde_json::json!({"vault":root,"origin":origin,
        "rawPath":item.raw_path,"sourceRevision":item.source_revision,"wikiPaths":[summary],"sessionCompile":context})).await?.reply?;
    gate(
        "quote_preview_is_partial_without_semantic_authority",
        outcome["ok"] == false && outcome["state"] == "partial",
    )?;
    let queue = crate::importers::wikify::Pending::try_load(root)?;
    gate(
        "partial_keeps_reminder_and_compiler_job_without_success_receipt",
        queue.pending.len() == 1
            && queue.compile_jobs.len() == 1
            && queue.compile_jobs[0].receipts.is_empty()
            && queue.compile_jobs[0]
                .attempts
                .last()
                .is_some_and(|attempt| attempt.outputs.len() == 1),
    )?;
    let before = std::fs::read(crate::importers::wikify::Pending::path(root))
        .map_err(|error| error.to_string())?;
    open(app, root)?;
    let denied = invoke(
        app,
        window,
        "session_compile_read",
        serde_json::json!({"context":context,"path":summary}),
    )
    .await?;
    gate(
        "reopened_path_rejects_old_publisher_attempt",
        denied.reply.is_err()
            && std::fs::read(crate::importers::wikify::Pending::path(root))
                .map_err(|error| error.to_string())?
                == before,
    )?;
    let current_origin = app.state::<crate::commands::VaultRoot>().snapshot()?;
    let current=invoke(app,window,"session_compile_begin",serde_json::json!({"origin":current_origin,
        "source":{"key":item.key,"rawPath":item.raw_path,"sourceRevision":item.source_revision},"usage":"foreground"})).await?.reply?;
    gate(
        "reopen_issues_new_attempt_and_retains_prior_outputs",
        current["attemptId"] != context["attemptId"]
            && crate::importers::wikify::Pending::try_load(root)?.compile_jobs[0].attempts[0]
                .outputs
                .len()
                == 1,
    )?;
    let denied=invoke(app,window,"wikify_complete_source",serde_json::json!({"vault":root,"origin":current_origin,
        "rawPath":item.raw_path,"sourceRevision":item.source_revision,"wikiPaths":[summary],"sessionCompile":current})).await?;
    gate(
        "prior_attempt_output_cannot_complete_new_attempt",
        denied.reply.is_err(),
    )?;
    invoke(
        app,
        window,
        "session_compile_stop",
        serde_json::json!({"context":current,"reason":"preparation_required"}),
    )
    .await?
    .reply?;
    gate(
        "missing_adapter_retry_state_is_pending_not_completed",
        crate::importers::wikify::Pending::try_load(root)?.compile_jobs[0].state
            == crate::session_compile::WorkState::Pending,
    )?;
    gate(
        "attempt_wave_preserves_exact_immutable_raw",
        std::fs::read(root.join(&item.raw_path)).map_err(|error| error.to_string())? == raw_before,
    )
}

async fn verify(app: tauri::AppHandle, sandbox: &Path) -> Result<(), String> {
    use crate::importers::wikify::{source_revision, Pending};
    let root = sandbox.join("vault");
    std::fs::create_dir_all(root.join("wiki")).map_err(|e| e.to_string())?;
    crate::settings::save(&crate::settings::Settings {
        auto_ingest_enabled: true,
        ..Default::default()
    })?;
    open(&app, &root)?;
    let old = app.state::<crate::commands::VaultRoot>().snapshot()?;
    let input = sandbox.join("synthetic.jsonl");
    let source = serde_json::json!({"type":"user","sessionId":"consumer-synthetic","message":{"role":"user","content":"A synthetic person recorded a bounded source decision. ".repeat(40)}});
    std::fs::write(&input, source.to_string()).map_err(|e| e.to_string())?;
    let imported = crate::commands::run_import_admitted(&root, &[input], "sessions");
    require(
        imported.imported == 1 && imported.failed.is_empty(),
        "synthetic admitted source fixture failed",
    )?;
    let queue = Pending::try_load(&root)?;
    require(
        queue.pending.len() == 1,
        "synthetic fixture has no unique pending source",
    )?;
    let item = &queue.pending[0];
    let raw = std::fs::read_to_string(root.join(&item.raw_path)).map_err(|e| e.to_string())?;
    require(
        source_revision(&raw) == item.source_revision,
        "synthetic fixture SHA mismatch",
    )?;
    std::fs::write(
        root.join("wiki/session.md"),
        format!(
            "---\ntype: source-summary\nsession_key: {}\n---\n# A human title\n\nHuman annotation remains.\n\nSynthetic source decision.[^src-synthetic]\n\n[^src-synthetic]: {}\n",
            serde_json::to_string(&item.key).map_err(|e| e.to_string())?,
            item.raw_path,
        ),
    )
    .map_err(|e| e.to_string())?;
    let summary_path = root.join("wiki/session.md");
    let summary_before = std::fs::read(&summary_path).map_err(|e| e.to_string())?;
    let ledger_path = crate::vault_dir::dir(&root).join("ledger.json");
    let ledger_before = std::fs::read(&ledger_path).map_err(|e| e.to_string())?;
    let ledger = crate::importers::ledger::Ledger::load(&root)?;
    let projection_rel = ledger
        .location("sessions", &item.key)
        .ok_or("synthetic projection lacks native lineage")?;
    let projection_path = root.join(projection_rel);
    let projection = std::fs::read_to_string(&projection_path).map_err(|e| e.to_string())?;
    let heading = projection
        .lines()
        .find(|line| line.starts_with("# "))
        .ok_or("synthetic projection has no heading")?;
    let edited = projection
        .replacen(heading, "# A human projection title", 1)
        .replacen("---\n", "---\ncustom_annotation: preserved\n", 1)
        + "\nHuman projection annotation remains.\n";
    std::fs::write(&projection_path, &edited).map_err(|e| e.to_string())?;
    let projection_before = std::fs::read(&projection_path).map_err(|e| e.to_string())?;
    let before = std::fs::read(Pending::path(&root)).map_err(|e| e.to_string())?;
    let (ready, result) = tokio::sync::oneshot::channel();
    *app.state::<ProbeState>().ready.lock().unwrap() = Some(ready);
    let window = tauri::WebviewWindowBuilder::new(
        &app,
        "native-session-consumer-probe",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .visible(false)
    .build()
    .map_err(|e| e.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(20), result)
        .await
        .map_err(|_| "consumer WebView ready timeout")?
        .map_err(|_| "consumer ready dropped")?;
    // Positive controls prove that existing commands and fixture metadata are
    // valid before testing stale-origin rejection through the same transport.
    let current_list = invoke(
        &app,
        &window,
        "list_wikify_pending",
        serde_json::json!({"expectedVault":root,"origin":old,"limit":1}),
    )
    .await?;
    require(
        current_list
            .reply
            .as_ref()
            .is_ok_and(|value| value["pendingTotal"] == 1),
        "current native list fixture did not pass",
    )?;
    require(
        current_list.progress.is_empty(),
        "consumer list emitted import progress",
    )?;
    let current_summary = invoke(
        &app,
        &window,
        "session_summary_path",
        serde_json::json!({"expectedVault":root,"origin":old,"key":item.key,"sourceRevision":item.source_revision}),
    )
    .await?;
    require(
        current_summary
            .reply
            .as_ref()
            .is_ok_and(|value| value == "wiki/session.md"),
        "current native summary fixture did not pass",
    )?;
    require(
        current_summary.progress.is_empty(),
        "consumer summary emitted import progress",
    )?;
    println!(
        "{}",
        serde_json::json!({"probe":"native_session_consumer","gate":"current_command_positive_controls","result":"passed","transport":"real_wry_webview_invoke","model_inference":false})
    );
    // Same-path reopen must invalidate the captured opening despite equal path.
    open(&app, &root)?;
    let cases = [
        (
            "list_wikify_pending",
            serde_json::json!({"expectedVault":root,"origin":old,"limit":1}),
        ),
        (
            "session_summary_path",
            serde_json::json!({"expectedVault":root,"origin":old,"key":item.key,"sourceRevision":item.source_revision}),
        ),
        (
            "wikify_complete_source",
            serde_json::json!({"vault":root,"origin":old,"rawPath":item.raw_path,"sourceRevision":item.source_revision,"wikiPaths":["wiki/session.md"],"attemptId":"expired-attempt"}),
        ),
    ];
    let mut failures = Vec::new();
    for (command, args) in cases {
        let answer = invoke(&app, &window, command, args).await?;
        require(
            answer.progress.is_empty(),
            "consumer command emitted import progress",
        )?;
        let passed = answer.reply.as_ref().is_err_and(|e| {
            e.contains("origin")
                || e.contains("vault changed")
                || e.contains("active vault changed")
                || e.contains("attempt")
        });
        println!(
            "{}",
            serde_json::json!({"probe":"native_session_consumer","command":command,"gate":"same_path_reopen_rejects_old_origin","result":if passed{"passed"}else{"failed"},"actual_reply":answer.reply,"model_inference":false})
        );
        if !passed {
            failures.push(command)
        }
    }
    let after = std::fs::read(Pending::path(&root)).map_err(|e| e.to_string())?;
    let source_and_human_preserved =
        std::fs::read_to_string(root.join(&item.raw_path)).map_err(|e| e.to_string())? == raw
            && std::fs::read(&summary_path).map_err(|e| e.to_string())? == summary_before
            && std::fs::read(&projection_path).map_err(|e| e.to_string())? == projection_before
            && std::fs::read(&ledger_path).map_err(|e| e.to_string())? == ledger_before;
    println!(
        "{}",
        serde_json::json!({"probe":"native_session_consumer","gate":"raw_human_title_annotations_and_ledger_unchanged","result":if source_and_human_preserved{"passed"}else{"failed"},"model_inference":false})
    );
    require(
        source_and_human_preserved,
        "consumer altered immutable raw or human annotations/title/ledger",
    )?;
    let preserved = before == after;
    println!(
        "{}",
        serde_json::json!({"probe":"native_session_consumer","gate":"old_attempt_retains_pending_source","result":if preserved{"passed"}else{"failed"},"model_inference":false})
    );
    if !preserved {
        failures.push("old_attempt_retains_pending_source")
    }
    require(
        failures.is_empty(),
        &format!("consumer boundary failures: {failures:?}"),
    )?;
    verify_attempts(&app, &window, &root, item).await?;
    let final_summary =
        std::fs::read_to_string(&summary_path).map_err(|error| error.to_string())?;
    gate(
        "attempt_wave_preserves_projection_ledger_and_human_summary_annotations",
        std::fs::read(&projection_path).map_err(|error| error.to_string())? == projection_before
            && std::fs::read(&ledger_path).map_err(|error| error.to_string())? == ledger_before
            && final_summary.contains("# A human title")
            && final_summary.contains("Human annotation remains.")
            && final_summary.contains("Later human annotation remains."),
    )?;
    failure::verify(&app, &window, &root, item).await?;
    live_view::verify(&app, &window, &root, item).await?;
    window.close().map_err(|e| e.to_string())?;
    crate::commands::close_vault(app.state())?;
    require(
        failures.is_empty(),
        &format!("consumer boundary failures: {failures:?}"),
    )
}

pub fn run() -> i32 {
    let sandbox = tempfile::Builder::new()
        .prefix("myco-native-session-consumer-qa-")
        .tempdir()
        .unwrap();
    std::env::set_var("MYCO_DATA_DIR", sandbox.path().join("data"));
    std::env::remove_var("MEMEX_DATA_DIR");
    let root = sandbox.path().to_path_buf();
    let code = std::sync::Arc::new(std::sync::atomic::AtomicI32::new(2));
    let task_code = code.clone();
    tauri::Builder::default()
        .manage(crate::commands::VaultRoot::default())
        .manage(crate::local_generation::LocalChatState::default())
        .manage(ProbeState::default())
        .invoke_handler(tauri::generate_handler![
            crate::commands::list_wikify_pending,
            crate::commands::session_summary_path,
            crate::commands::wikify_complete_source,
            crate::commands::session_compile_begin,
            crate::commands::session_compile_step,
            crate::commands::session_compile_read,
            crate::commands::session_compile_publish,
            crate::commands::session_compile_stop,
            crate::commands::cancel_local_synthesis,
            probe_webview_ready,
            probe_import_reply
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            let code = task_code.clone();
            tauri::async_runtime::spawn(async move {
                let result = verify(handle.clone(), &root).await;
                if let Err(error) = &result {
                    eprintln!("native_session_consumer_probe failed: {error}");
                }
                let exit = if result.is_ok() { 0 } else { 1 };
                code.store(exit, std::sync::atomic::Ordering::SeqCst);
                handle.exit(exit);
            });
            Ok(())
        })
        .build(crate::app_context())
        .expect("native consumer QA app build failed")
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
