//! Opt-in editor CAS and Audio command checks through real isolated Wry IPC.
//! Synthetic Audio generation and recovery are protocol checks, not model/UI gates.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::{atomic::Ordering, Mutex};
use tauri::Manager;

mod audio;
mod privacy;
mod study;

const A: &str = "---\ntitle: Synthetic baseline A\n---\nSynthetic original human annotation A.\n";
const B: &str =
    "---\ntitle: Synthetic external B\n---\nSynthetic newer external annotation B; preserve it.\n";
const C: &str =
    "---\ntitle: Synthetic external C\n---\nSynthetic third external annotation C; preserve it.\n";
const DRAFT: &str = "---\ntitle: Synthetic unsaved draft\n---\nSynthetic unsaved draft; never silently replace B or C.\n";
const MERGED: &str = "---\ntitle: Synthetic manual merge\n---\nSynthetic third external annotation C; preserve it.\nSynthetic explicitly merged editor draft.\n";
const RAW: &str = "---\ntitle: Synthetic immutable raw\n---\nSynthetic immutable source bytes.\n";
const GATES: &[&str] = &[
    "isolated_qa_profile",
    "webview_ready",
    "native_first_opening",
    "full_raw_baseline_a",
    "external_b_written",
    "stale_sha_preserves_b",
    "durable_draft_preserves_full_a_after_external_b",
    "failed_cas_retains_durable_draft",
    "same_path_native_reopening",
    "unopened_checkpoint_blocks_reader_path_mutations",
    "reopened_discovery_preserves_original_origin",
    "stale_journal_retirement_refused",
    "explicit_journal_retirement_preserves_b",
    "completed_draft_payload_removed",
    "legacy_completed_raw_blocks_reader_path_mutations",
    "legacy_completion_exact_nonce_repair",
    "stale_opening_read_refused",
    "stale_opening_write_refused_with_current_sha",
    "explicit_reread_b",
    "external_c_written",
    "reread_b_sha_preserves_c",
    "explicit_reread_c",
    "manual_merge_persisted_receipt",
    "merged_native_reread",
    "immutable_raw_read_allowed",
    "immutable_raw_write_refused",
    "immutable_raw_draft_refused",
    "audio_begin_native_job",
    "audio_closed_context_refused",
    "audio_cancellation_rejects_generate",
    "audio_existing_human_preserved",
    "audio_source_edit_blocks_publish",
    "audio_absence_cas_and_competing_job",
    "audio_same_root_reopen_revokes_job",
    "native_study_absence_and_empty",
    "native_study_persisted_receipt",
    "native_study_competing_snapshot_conflict",
    "native_study_same_bytes_replacement_refused",
    "native_study_closed_context_refused",
    "native_study_reopening_refuses_old_snapshot",
    "native_study_discard_exact_snapshot",
    "native_study_direct_path_confined",
    "close_vault_null_reply",
    "closed_opening_read_refused",
    "webview_closed",
    "synthetic_sandbox_removed",
];

type NativeReply = Result<Value, String>;
type TransportReply = Result<NativeReply, String>;
type Reply = tokio::sync::oneshot::Sender<TransportReply>;

#[derive(Default)]
struct ProbeState {
    ready: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    reply: Mutex<Option<(String, Reply)>>,
}

#[tauri::command]
fn probe_webview_ready(state: tauri::State<ProbeState>) -> Result<(), String> {
    if let Some(reply) = state
        .ready
        .lock()
        .map_err(|_| "probe ready lock poisoned")?
        .take()
    {
        reply.send(()).map_err(|_| "probe ready receiver dropped")?;
    }
    Ok(())
}

#[tauri::command]
fn probe_editor_reply(
    state: tauri::State<ProbeState>,
    request_id: String,
    value: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    let mut pending = state
        .reply
        .lock()
        .map_err(|_| "probe reply lock poisoned")?;
    if pending.as_ref().map(|(id, _)| id) != Some(&request_id) {
        return Err("unexpected native editor probe reply".into());
    }
    let outcome = match (value, error) {
        // Wrapping preserves a genuine successful native null (close_vault).
        (Some(value), None) => value
            .get("nativeValue")
            .cloned()
            .ok_or_else(|| "missing native editor reply value".to_owned())
            .map(Ok),
        (None, Some(error)) => Ok(Err(error)),
        _ => Err("invalid native editor reply envelope".into()),
    };
    if let Some((_, reply)) = pending.take() {
        reply
            .send(outcome)
            .map_err(|_| "native editor probe receiver dropped")?;
    }
    Ok(())
}

struct Report {
    gates: Vec<Value>,
    calls: Vec<Value>,
    lifecycle: Vec<&'static str>,
}

impl Report {
    fn new() -> Self {
        Self {
            gates: GATES
                .iter()
                .map(|name| json!({"gate":name,"result":"not_run"}))
                .collect(),
            calls: Vec::new(),
            lifecycle: Vec::new(),
        }
    }

    fn phase(&mut self, phase: &'static str) {
        self.lifecycle.push(phase);
        println!(
            "{}",
            json!({"probe":"native_editor","record":"lifecycle","phase":phase})
        );
    }

    fn gate(&mut self, name: &str, passed: bool, proof: Value) -> Result<(), String> {
        let gate = self
            .gates
            .iter_mut()
            .find(|gate| gate["gate"] == name)
            .ok_or("unknown native editor gate")?;
        *gate = json!({"gate":name,"result":if passed {"passed"} else {"failed"},"proof":proof});
        println!(
            "{}",
            json!({"probe":"native_editor","record":"gate","gate":gate})
        );
        passed.then_some(()).ok_or_else(|| name.to_owned())
    }

    fn terminal(&self, error: Option<&str>, teardown_error: Option<&str>, sandbox: &Path) -> i32 {
        let passed = error.is_none()
            && teardown_error.is_none()
            && self.gates.iter().all(|gate| gate["result"] == "passed");
        let exit = i32::from(!passed);
        println!(
            "{}",
            json!({"probe":"native_editor","record":"terminal",
            "protocol":"native_editor_audio_study_ipc_v5","transport":"real_wry_webview_invoke",
            "result":if passed {"passed"} else {"failed"},"exitCode":exit,
            "error":error,"teardownError":teardown_error,"syntheticSandbox":sandbox,
            "gates":self.gates,"calls":self.calls,"lifecycle":self.lifecycle,
            "modelInference":false,"privateVaultRead":false,"installedAppRead":false,
            "audioGeneration":"probe_only_synthetic_callback",
            "audioMeaning":"not_evaluated","audioUi":"not_run",
            "audioWithModelStopDrain":"not_run",
            "studyGeneratedMeaning":"not_evaluated","studyUi":"not_run",
            "installedUi":"not_run","manualRecoveryUi":"not_run",
            "externalWriter":"probe_owned_synthetic_filesystem_write",
            "concurrentExternalWriterRace":"not_run","runtimeZeroEgress":"not_observed",
            "semanticReleaseAccepted":false})
        );
        exit
    }
}

async fn invoke(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    command: &str,
    arguments: Value,
    report: &mut Report,
) -> TransportReply {
    let ordinal = report.calls.len() + 1;
    let id = format!("native-editor-reply-{ordinal}");
    let (sender, receiver) = tokio::sync::oneshot::channel();
    {
        let state = app.state::<ProbeState>();
        let mut pending = state
            .reply
            .lock()
            .map_err(|_| "probe reply lock poisoned")?;
        if pending.is_some() {
            return Err("native editor invocation already pending".into());
        }
        *pending = Some((id.clone(), sender));
    }
    let encoded_command = serde_json::to_string(command).map_err(|error| error.to_string())?;
    let correlation = serde_json::to_string(&id).map_err(|error| error.to_string())?;
    let script = format!("(async()=>{{let envelope;try{{const value=await window.__TAURI_INTERNALS__.invoke({encoded_command},{arguments});envelope={{requestId:{correlation},value:{{nativeValue:value}},error:null}};}}catch(error){{envelope={{requestId:{correlation},value:null,error:String(error)}};}}await window.__TAURI_INTERNALS__.invoke('probe_editor_reply',envelope);}})()");
    report.phase("invoke_dispatch");
    let outcome = match window.eval(script) {
        Ok(()) => match tokio::time::timeout(std::time::Duration::from_secs(20), receiver).await {
            Ok(received) => {
                received.unwrap_or_else(|_| Err("native editor reply channel dropped".into()))
            }
            Err(_) => Err("native editor WebView invocation timed out".into()),
        },
        Err(error) => Err(format!("native editor WebView dispatch failed: {error}")),
    };
    if outcome.is_err() {
        let state = app.state::<ProbeState>();
        let mut pending = state
            .reply
            .lock()
            .map_err(|_| "probe reply lock poisoned")?;
        if pending.as_ref().map(|(pending_id, _)| pending_id) == Some(&id) {
            pending.take();
        }
    }
    let record = match &outcome {
        Ok(Ok(value)) => {
            json!({"ordinal":ordinal,"command":command,"outcome":"native_success","value":value})
        }
        Ok(Err(error)) => {
            json!({"ordinal":ordinal,"command":command,"outcome":"native_error","error":error})
        }
        Err(error) => {
            json!({"ordinal":ordinal,"command":command,"outcome":"transport_error","error":error})
        }
    };
    println!(
        "{}",
        json!({"probe":"native_editor","record":"invoke_reply","call":record})
    );
    report.calls.push(record);
    outcome
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn disk(path: &Path) -> Result<Value, String> {
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    let raw = std::str::from_utf8(&bytes).map_err(|error| error.to_string())?;
    Ok(json!({"path":path,"raw":raw,"sha256":sha(&bytes)}))
}

fn read_matches(read: &Value, path: &Path, origin: &Value, expected: &str) -> bool {
    read["file"]["path"] == path.to_string_lossy().as_ref()
        && read["file"]["raw"] == expected
        && read["origin"] == *origin
        && read["revision"] == sha(expected.as_bytes())
        && read.get("mockOnly").is_none()
}

fn rejected(reply: &NativeReply, message: &str) -> bool {
    reply.as_ref().is_err_and(|error| error.contains(message))
}

async fn verify(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    root: &Path,
    report: &mut Report,
) -> Result<(), String> {
    let path = root.join("wiki/synthetic-note.md");
    let raw_path = root.join("raw/synthetic-source.md");
    let opened = invoke(app, window, "open_vault", json!({"path":root}), report).await??;
    let origin = invoke(app, window, "agent_vault_session", json!({}), report).await??;
    report.gate(
        "native_first_opening",
        opened["path"] == root.to_string_lossy().as_ref()
            && origin["vaultPath"] == opened["path"]
            && origin["openingToken"]
                .as_str()
                .is_some_and(|token| !token.is_empty()),
        origin.clone(),
    )?;
    let first = invoke(
        app,
        window,
        "read_editor_file",
        json!({"path":path,"origin":origin}),
        report,
    )
    .await??;
    report.gate(
        "full_raw_baseline_a",
        read_matches(&first, &path, &origin, A)
            && first["file"]["frontmatter"]["title"] == "Synthetic baseline A"
            && first["file"]["content"] != first["file"]["raw"]
            && disk(&path)?["raw"] == A,
        json!({"receipt":first,"disk":disk(&path)?}),
    )?;

    // This actual external write bypasses the app's FILE lock, as a human writer would.
    std::fs::write(&path, B).map_err(|error| error.to_string())?;
    report.gate("external_b_written", disk(&path)?["raw"] == B, disk(&path)?)?;
    let checkpoint = invoke(app, window, "stage_editor_draft",
        json!({"path":path,"draft":DRAFT,"expectedSha256":first["revision"],"origin":origin,"expectedJournalRevision":null}), report).await??;
    report.gate(
        "durable_draft_preserves_full_a_after_external_b",
        checkpoint["baselineRaw"] == A
            && checkpoint["baselineRevision"] == first["revision"]
            && checkpoint["draftRaw"] == DRAFT
            && checkpoint["origin"] == origin
            && checkpoint["revision"]
                .as_str()
                .is_some_and(|revision| !revision.is_empty())
            && disk(&path)?["raw"] == B,
        json!({"checkpoint":checkpoint,"disk":disk(&path)?}),
    )?;
    let privacy_snapshot = privacy::capture(root, &path, &checkpoint)?;
    let stale = invoke(app, window, "write_editor_file",
        json!({"path":path,"content":DRAFT,"expectedSha256":first["revision"],"origin":first["origin"]}), report).await?;
    report.gate(
        "stale_sha_preserves_b",
        rejected(&stale, "write conflict:") && disk(&path)?["raw"] == B,
        json!({"nativeError":stale.err(),"disk":disk(&path)?}),
    )?;
    let retained = invoke(
        app,
        window,
        "read_editor_draft",
        json!({"path":path,"origin":origin}),
        report,
    )
    .await??;
    report.gate(
        "failed_cas_retains_durable_draft",
        retained == checkpoint && disk(&path)?["raw"] == B,
        json!({"checkpoint":retained,"disk":disk(&path)?}),
    )?;

    invoke(app, window, "open_vault", json!({"path":root}), report).await??;
    let reopened = invoke(app, window, "agent_vault_session", json!({}), report).await??;
    report.gate(
        "same_path_native_reopening",
        reopened["vaultPath"] == origin["vaultPath"]
            && reopened["openingToken"]
                .as_str()
                .is_some_and(|token| !token.is_empty())
            && reopened["openingToken"] != origin["openingToken"],
        json!({"first":origin,"reopened":reopened}),
    )?;
    let destination = root.join("moved");
    std::fs::create_dir(&destination).map_err(|error| error.to_string())?;
    let mutations = [
        (
            "rename_path",
            json!({"from":path,"toName":"synthetic-renamed.md"}),
        ),
        ("move_path", json!({"from":path,"toDir":destination})),
        ("delete_path", json!({"path":path,"expectedPermanent":null})),
        (
            "trash_paths",
            json!({"paths":[root.join("wiki")],"expectedPermanent":null}),
        ),
    ];
    let mut mutation_errors = Vec::new();
    for (command, arguments) in mutations {
        let reply = invoke(app, window, command, arguments, report).await?;
        let admitted = rejected(&reply, "pending editor recovery");
        mutation_errors.push(json!({"command":command,"refused":admitted,"error":reply.err()}));
    }
    report.gate(
        "unopened_checkpoint_blocks_reader_path_mutations",
        mutation_errors.iter().all(|entry| entry["refused"] == true)
            && disk(&path)?["raw"] == B
            && destination
                .read_dir()
                .map_err(|error| error.to_string())?
                .next()
                .is_none(),
        json!({"mutations":mutation_errors,"disk":disk(&path)?}),
    )?;
    let discovered = invoke(
        app,
        window,
        "read_editor_draft",
        json!({"path":path,"origin":reopened}),
        report,
    )
    .await??;
    report.gate(
        "reopened_discovery_preserves_original_origin",
        discovered == checkpoint
            && discovered["origin"]["openingToken"] != reopened["openingToken"]
            && disk(&path)?["raw"] == B,
        json!({"checkpoint":discovered,"currentOrigin":reopened,"disk":disk(&path)?}),
    )?;
    let wrong_retirement = invoke(
        app,
        window,
        "retire_editor_draft",
        json!({"path":path,"origin":reopened,"expectedJournalRevision":"synthetic-wrong-revision"}),
        report,
    )
    .await?;
    let after_wrong_retirement = invoke(
        app,
        window,
        "read_editor_draft",
        json!({"path":path,"origin":reopened}),
        report,
    )
    .await??;
    report.gate("stale_journal_retirement_refused", wrong_retirement.is_err()
        && after_wrong_retirement == checkpoint && disk(&path)?["raw"] == B,
        json!({"nativeError":wrong_retirement.err(),"checkpoint":after_wrong_retirement,"disk":disk(&path)?}))?;
    let stale_read = invoke(
        app,
        window,
        "read_editor_file",
        json!({"path":path,"origin":origin}),
        report,
    )
    .await?;
    report.gate(
        "stale_opening_read_refused",
        rejected(&stale_read, "active vault changed") && disk(&path)?["raw"] == B,
        json!({"nativeError":stale_read.err(),"disk":disk(&path)?}),
    )?;
    // Use the exact current B SHA so this rejection cannot be explained by stale content.
    let stale_write = invoke(
        app,
        window,
        "write_editor_file",
        json!({"path":path,"content":DRAFT,"expectedSha256":sha(B.as_bytes()),"origin":origin}),
        report,
    )
    .await?;
    report.gate("stale_opening_write_refused_with_current_sha", rejected(&stale_write, "active vault changed")
        && disk(&path)?["raw"] == B, json!({"nativeError":stale_write.err(),"expectedSha256":sha(B.as_bytes()),"disk":disk(&path)?}))?;
    let retired = invoke(
        app,
        window,
        "retire_editor_draft",
        json!({"path":path,"origin":reopened,"expectedJournalRevision":checkpoint["revision"]}),
        report,
    )
    .await??;
    let absent = invoke(
        app,
        window,
        "read_editor_draft",
        json!({"path":path,"origin":reopened}),
        report,
    )
    .await??;
    let retired_replay = invoke(
        app,
        window,
        "retire_editor_draft",
        json!({"path":path,"origin":reopened,"expectedJournalRevision":checkpoint["revision"]}),
        report,
    )
    .await??;
    report.gate(
        "explicit_journal_retirement_preserves_b",
        retired.is_null() && retired_replay.is_null() && absent.is_null() && disk(&path)?["raw"] == B,
        json!({"retirement":retired,"sameNonceAcknowledgement":retired_replay,"discovery":absent,"disk":disk(&path)?}),
    )?;
    privacy::verify(
        app,
        window,
        root,
        report,
        &reopened,
        &checkpoint,
        privacy_snapshot,
    )
    .await?;

    // Explicitly accepted rereads are separate actions; no automatic SHA rebase is performed.
    let read_b = invoke(
        app,
        window,
        "read_editor_file",
        json!({"path":path,"origin":reopened}),
        report,
    )
    .await??;
    report.gate(
        "explicit_reread_b",
        read_matches(&read_b, &path, &reopened, B) && disk(&path)?["raw"] == B,
        json!({"receipt":read_b,"disk":disk(&path)?}),
    )?;
    std::fs::write(&path, C).map_err(|error| error.to_string())?;
    report.gate("external_c_written", disk(&path)?["raw"] == C, disk(&path)?)?;
    let third_conflict = invoke(app, window, "write_editor_file",
        json!({"path":path,"content":MERGED,"expectedSha256":read_b["revision"],"origin":read_b["origin"]}), report).await?;
    report.gate(
        "reread_b_sha_preserves_c",
        rejected(&third_conflict, "write conflict:") && disk(&path)?["raw"] == C,
        json!({"nativeError":third_conflict.err(),"disk":disk(&path)?}),
    )?;
    let read_c = invoke(
        app,
        window,
        "read_editor_file",
        json!({"path":path,"origin":reopened}),
        report,
    )
    .await??;
    report.gate(
        "explicit_reread_c",
        read_matches(&read_c, &path, &reopened, C) && disk(&path)?["raw"] == C,
        json!({"receipt":read_c,"disk":disk(&path)?}),
    )?;
    let merged = invoke(app, window, "write_editor_file",
        json!({"path":path,"content":MERGED,"expectedSha256":read_c["revision"],"origin":read_c["origin"]}), report).await??;
    let persisted = disk(&path)?;
    report.gate(
        "manual_merge_persisted_receipt",
        persisted["raw"] == MERGED
            && merged["path"] == persisted["path"]
            && merged["origin"] == reopened
            && merged["revision"] == persisted["sha256"]
            && merged["revision"] == sha(MERGED.as_bytes())
            && merged.get("mockOnly").is_none(),
        json!({"receipt":merged,"disk":persisted}),
    )?;
    let reread = invoke(
        app,
        window,
        "read_editor_file",
        json!({"path":path,"origin":reopened}),
        report,
    )
    .await??;
    report.gate(
        "merged_native_reread",
        read_matches(&reread, &path, &reopened, MERGED) && reread["revision"] == merged["revision"],
        json!({"receipt":reread,"disk":disk(&path)?}),
    )?;

    let raw = invoke(
        app,
        window,
        "read_editor_file",
        json!({"path":raw_path,"origin":reopened}),
        report,
    )
    .await??;
    report.gate(
        "immutable_raw_read_allowed",
        read_matches(&raw, &raw_path, &reopened, RAW) && disk(&raw_path)?["raw"] == RAW,
        json!({"receipt":raw,"disk":disk(&raw_path)?}),
    )?;
    let raw_write = invoke(app, window, "write_editor_file",
        json!({"path":raw_path,"content":DRAFT,"expectedSha256":raw["revision"],"origin":raw["origin"]}), report).await?;
    report.gate("immutable_raw_write_refused", rejected(&raw_write, "raw/ is immutable")
        && disk(&raw_path)?["raw"] == RAW && disk(&path)?["raw"] == MERGED,
        json!({"nativeError":raw_write.err(),"rawDisk":disk(&raw_path)?,"derivedDisk":disk(&path)?}))?;
    let raw_draft = invoke(app, window, "stage_editor_draft",
        json!({"path":raw_path,"draft":DRAFT,"expectedSha256":raw["revision"],"origin":reopened,"expectedJournalRevision":null}), report).await?;
    report.gate("immutable_raw_draft_refused", rejected(&raw_draft, "raw/ is immutable")
        && disk(&raw_path)?["raw"] == RAW && disk(&path)?["raw"] == MERGED,
        json!({"nativeError":raw_draft.err(),"rawDisk":disk(&raw_path)?,"derivedDisk":disk(&path)?}))?;
    audio::verify(app, window, root, report).await?;
    study::verify(app, window, root, report).await
}

async fn exercise(
    app: &tauri::AppHandle,
    sandbox: &Path,
    report: &mut Report,
) -> (Result<(), String>, Option<tauri::WebviewWindow>) {
    let mut window = None;
    let result = async {
        report.gate("isolated_qa_profile", app.config().identifier == "dev.cmblir.myco.native-index-qa"
            && crate::settings::settings_dir()? == sandbox.join("data")
            && crate::INDEX_UPDATER.get().is_none(), json!({"identifier":app.config().identifier,"settingsDir":crate::settings::settings_dir()?}))?;
        let root = sandbox.join("vault");
        std::fs::create_dir_all(root.join("wiki")).map_err(|error| error.to_string())?;
        std::fs::create_dir_all(root.join("raw")).map_err(|error| error.to_string())?;
        std::fs::write(root.join("wiki/synthetic-note.md"), A).map_err(|error| error.to_string())?;
        std::fs::write(root.join("raw/synthetic-source.md"), RAW).map_err(|error| error.to_string())?;
        let root = root.canonicalize().map_err(|error| error.to_string())?;
        let (ready, received) = tokio::sync::oneshot::channel();
        *app.state::<ProbeState>().ready.lock().map_err(|_| "probe ready lock poisoned")? = Some(ready);
        report.phase("hidden_webview_create");
        window = Some(tauri::WebviewWindowBuilder::new(app, "native-editor-probe", tauri::WebviewUrl::App("index.html".into()))
            .visible(false).build().map_err(|error| error.to_string())?);
        tokio::time::timeout(std::time::Duration::from_secs(20), received).await
            .map_err(|_| "native editor WebView ready timeout")?.map_err(|_| "native editor ready channel dropped")?;
        report.gate("webview_ready", true, json!({"visible":false,"source":"QA_embedded_local_index.html"}))?;
        verify(app, window.as_ref().ok_or("native editor WebView missing")?, &root, report).await
    }.await;
    (result, window)
}

async fn teardown(
    app: &tauri::AppHandle,
    window: Option<&tauri::WebviewWindow>,
    sandbox: tempfile::TempDir,
    report: &mut Report,
) -> Result<(), String> {
    report.phase("teardown_started");
    let mut errors = Vec::new();
    let mut closing_origin = None;
    if app
        .state::<crate::commands::VaultRoot>()
        .current()
        .is_some()
    {
        if let Some(window) = window {
            match invoke(app, window, "agent_vault_session", json!({}), report).await {
                Ok(Ok(origin)) => closing_origin = Some(origin),
                other => errors.push(format!("native closing opening capture failed: {other:?}")),
            }
        }
    }
    let closed = match window {
        Some(window) => match invoke(app, window, "close_vault", json!({}), report).await {
            Ok(Ok(value)) => {
                let closed = value.is_null()
                    && app
                        .state::<crate::commands::VaultRoot>()
                        .current()
                        .is_none();
                if let Err(error) = report.gate(
                    "close_vault_null_reply",
                    closed,
                    json!({"nativeValue":value,"nativeRootClosed":closed}),
                ) {
                    errors.push(error);
                }
                closed
            }
            other => {
                errors.push(format!("close_vault teardown failed: {other:?}"));
                false
            }
        },
        None => {
            errors.push("no native editor WebView available for close_vault teardown".into());
            false
        }
    };
    if closed {
        if let (Some(window), Some(origin)) = (window, closing_origin) {
            let path = sandbox.path().join("vault/wiki/synthetic-note.md");
            // Retry the genuine last issued opening through the production editor read.
            match invoke(
                app,
                window,
                "read_editor_file",
                json!({"path":path,"origin":origin}),
                report,
            )
            .await
            {
                Ok(reply) => match disk(&path) {
                    Ok(persisted) => {
                        if let Err(error) = report.gate(
                            "closed_opening_read_refused",
                            rejected(&reply, "no vault is open"),
                            json!({"nativeError":reply.err(),"disk":persisted}),
                        ) {
                            errors.push(error);
                        }
                    }
                    Err(error) => errors.push(error),
                },
                Err(error) => errors.push(error),
            }
        }
    }
    if let Some(window) = window {
        let (destroyed, received) = tokio::sync::oneshot::channel();
        let destroyed = std::sync::Arc::new(Mutex::new(Some(destroyed)));
        window.on_window_event(move |event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                match destroyed.lock() {
                    Ok(mut sender) => {
                        if let Some(sender) = sender.take() {
                            if sender.send(()).is_err() {
                                eprintln!("native editor destroyed event receiver dropped");
                            }
                        }
                    }
                    Err(_) => eprintln!("native editor destroyed event lock poisoned"),
                }
            }
        });
        let close = match window.close() {
            Ok(()) => tokio::time::timeout(std::time::Duration::from_secs(20), received)
                .await
                .map_err(|_| "native editor WebView destroy event timeout".to_owned())
                .and_then(|result| {
                    result.map_err(|_| "native editor destroy event channel dropped".to_owned())
                }),
            Err(error) => Err(error.to_string()),
        };
        if let Err(error) = report.gate(
            "webview_closed",
            close.is_ok(),
            json!({"destroyEventObserved":close.is_ok(),"error":close.err()}),
        ) {
            errors.push(error);
        }
    }
    if closed {
        let path = sandbox.path().to_path_buf();
        let removed = sandbox.close().map_err(|error| error.to_string());
        if let Err(error) = report.gate(
            "synthetic_sandbox_removed",
            removed.is_ok() && !path.exists(),
            json!({"path":path,"error":removed.err(),"existsAfterClose":path.exists()}),
        ) {
            errors.push(error);
        }
    } else {
        // Without the native closing barrier, a timed-out blocking save might still own work.
        // Retain only this probe-owned synthetic root for the runner to inspect after exit.
        let retained = sandbox.keep();
        errors.push(format!(
            "synthetic sandbox retained after unconfirmed native close: {}",
            retained.display()
        ));
    }
    report.phase("teardown_terminal");
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

/// Run a separate QA identity; never initialize the production app or providers.
pub fn run() -> i32 {
    let sandbox = match tempfile::Builder::new()
        .prefix("myco-native-editor-qa-")
        .tempdir()
    {
        Ok(sandbox) => sandbox,
        Err(error) => {
            return Report::new().terminal(
                Some(&format!("native editor sandbox failed: {error}")),
                None,
                Path::new("unavailable"),
            )
        }
    };
    let path = match sandbox.path().canonicalize() {
        Ok(path) => path,
        Err(error) => {
            return Report::new().terminal(
                Some(&format!(
                    "native editor sandbox canonicalization failed: {error}"
                )),
                None,
                sandbox.path(),
            )
        }
    };
    std::env::set_var("MYCO_DATA_DIR", path.join("data"));
    std::env::remove_var("MEMEX_DATA_DIR");
    let exit = std::sync::Arc::new(std::sync::atomic::AtomicI32::new(1));
    let task_exit = exit.clone();
    let terminal = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let task_terminal = terminal.clone();
    let runtime = tauri::Builder::default()
        .manage(crate::commands::VaultRoot::default())
        .manage(crate::audio_overview::AudioOverviewRegistry::default())
        .manage(crate::study_deck_io::StudyDeckRegistry::default())
        .manage(crate::local_generation::LocalChatState::default())
        .manage(ProbeState::default())
        .invoke_handler(tauri::generate_handler![
            crate::commands::open_vault,
            crate::commands::close_vault,
            crate::commands::agent_vault_session,
            crate::commands::read_editor_file,
            crate::commands::write_editor_file,
            crate::commands::stage_editor_draft,
            crate::commands::editor_recovery_supported,
            crate::commands::read_editor_draft,
            crate::commands::retire_editor_draft,
            crate::commands::rename_path,
            crate::commands::move_path,
            crate::commands::delete_path,
            crate::commands::trash_paths,
            crate::study_deck_commands::read_study_deck,
            crate::study_deck_commands::write_study_deck,
            crate::study_deck_commands::discard_study_deck_snapshot,
            crate::audio_overview_commands::audio_overview_begin,
            crate::audio_overview_commands::audio_overview_generate,
            crate::audio_overview_commands::audio_overview_publish,
            crate::audio_overview_commands::audio_overview_cancel,
            audio::probe_audio_draft,
            probe_webview_ready,
            probe_editor_reply
        ])
        .setup(move |app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut report = Report::new();
                report.phase("qa_setup_started");
                let (result, window) = exercise(&handle, &path, &mut report).await;
                let teardown = teardown(&handle, window.as_ref(), sandbox, &mut report).await;
                report.phase("coded_exit_requested");
                let code = report.terminal(
                    result.as_ref().err().map(String::as_str),
                    teardown.as_ref().err().map(String::as_str),
                    &path,
                );
                task_exit.store(code, Ordering::SeqCst);
                task_terminal.store(true, Ordering::SeqCst);
                handle.exit(code);
            });
            Ok(())
        })
        .build(crate::app_context());
    match runtime {
        Ok(app) => {
            app.run_return(|_, event| {
                if let tauri::RunEvent::ExitRequested {
                    code: None, api, ..
                } = event
                {
                    api.prevent_exit();
                }
            });
        }
        Err(error) => {
            return Report::new().terminal(
                Some(&format!("native editor QA runtime build failed: {error}")),
                None,
                Path::new("setup_not_started"),
            );
        }
    }
    if !terminal.load(Ordering::SeqCst) {
        return Report::new().terminal(
            Some("native editor runtime ended before its owned QA terminal receipt"),
            None,
            Path::new("setup_terminal_missing"),
        );
    }
    // run_return's own return value cannot turn a failed QA task into success.
    exit.load(Ordering::SeqCst)
}
