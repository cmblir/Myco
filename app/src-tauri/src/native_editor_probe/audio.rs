//! Real Wry command boundaries with a marked synthetic generation callback.
//! No weight loading, model meaning, Audio UI or installed acceptance is claimed.

use super::{invoke, rejected, sha, Report};
use crate::audio_overview::{AudioOverviewRegistry, Draft, JobContext};
use crate::vault_session::VaultRoot;
use serde_json::{json, Value};
use std::path::Path;

const ORIGINAL: &str = "# Audio synthetic note\nThe synthetic copper valve is a planned draft.\n";
const EDITED: &str = "# Audio synthetic note\nA newer human annotation supersedes the draft.\n";
const HUMAN: &str = "Human audio transcript; do not overwrite.\n";
const DATE: &str = "2026-10-11T12:00:00.000Z";

/// Registered only by this isolated probe, never by the product command builder.
#[tauri::command]
pub(super) async fn probe_audio_draft(
    app: tauri::AppHandle,
    vault: tauri::State<'_, VaultRoot>,
    registry: tauri::State<'_, AudioOverviewRegistry>,
    context: JobContext,
) -> Result<Draft, String> {
    let root = vault.current().ok_or("no synthetic Audio vault")?;
    let sandbox = root.parent().ok_or("synthetic Audio sandbox missing")?;
    if app.config().identifier != "dev.cmblir.myco.native-index-qa"
        || !sandbox
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with("myco-native-editor-qa-"))
        || crate::settings::settings_dir()? != sandbox.join("data")
        || std::fs::read(root.join("wiki/audio-note.md")).map_err(|error| error.to_string())?
            != ORIGINAL.as_bytes()
    {
        return Err("Audio generation fixture requires the exact isolated synthetic source".into());
    }
    crate::audio_overview::generate_with(&vault, &registry, &context, |input| async move {
        if !input.user.contains(ORIGINAL.trim()) || input.user.len() > 1024 {
            return Err("Audio generation fixture received another source packet".into());
        }
        Ok(json!([
            {"speaker":"A","text":"What is the synthetic valve's recorded state?","cites":["[[audio-note]]"]},
            {"speaker":"B","text":"It is a planned draft.","cites":["[[audio-note]]"]}
        ]).to_string())
    }).await
}

async fn begin(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    path: &Path,
    origin: &Value,
    title: &str,
    report: &mut Report,
) -> Result<Value, String> {
    invoke(
        app,
        window,
        "audio_overview_begin",
        json!({"origin":origin,"pagePaths":[path],"title":title,"dateIso":DATE}),
        report,
    )
    .await?
}

async fn draft(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    context: &Value,
    report: &mut Report,
) -> Result<Value, String> {
    invoke(
        app,
        window,
        "probe_audio_draft",
        json!({"context":context}),
        report,
    )
    .await?
}

async fn cancel(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    context: &Value,
    report: &mut Report,
) -> Result<(), String> {
    let acknowledgement = invoke(
        app,
        window,
        "audio_overview_cancel",
        json!({"context":context}),
        report,
    )
    .await??;
    if acknowledgement != Value::Bool(true) {
        return Err("native Audio cancellation was not confirmed".into());
    }
    Ok(())
}

pub(super) async fn verify(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    root: &Path,
    report: &mut Report,
) -> Result<(), String> {
    let source = root.join("wiki/audio-note.md");
    std::fs::write(&source, ORIGINAL).map_err(|error| error.to_string())?;
    let origin = invoke(app, window, "agent_vault_session", json!({}), report).await??;
    let job = begin(
        app,
        window,
        &source,
        &origin,
        "Native audio boundary",
        report,
    )
    .await?;
    report.gate(
        "audio_begin_native_job",
        job["origin"] == origin
            && job["jobId"].as_str().is_some_and(|id| !id.is_empty())
            && !root.join("audio").exists(),
        json!({"context":job,"modelInference":false}),
    )?;
    let mut forged = job.clone();
    forged["content"] = json!("Caller content cannot become a native draft.");
    let refusal = invoke(
        app,
        window,
        "audio_overview_generate",
        json!({"context":forged}),
        report,
    )
    .await?;
    report.gate(
        "audio_closed_context_refused",
        rejected(&refusal, "unknown field")
            && std::fs::read(&source).map_err(|error| error.to_string())? == ORIGINAL.as_bytes(),
        json!({"nativeError":refusal.err(),"modelInference":false}),
    )?;
    cancel(app, window, &job, report).await?;
    let stopped = invoke(
        app,
        window,
        "audio_overview_generate",
        json!({"context":job}),
        report,
    )
    .await?;
    report.gate(
        "audio_cancellation_rejects_generate",
        stopped.is_err() && !root.join("audio").exists(),
        json!({"nativeError":stopped.err(),"modelInference":false}),
    )?;

    std::fs::create_dir(root.join("audio")).map_err(|error| error.to_string())?;
    let human = root.join("audio/human-collision-2026-10-11.md");
    std::fs::write(&human, HUMAN).map_err(|error| error.to_string())?;
    let collision_job = begin(app, window, &source, &origin, "Human collision", report).await?;
    let collision_draft = draft(app, window, &collision_job, report).await?;
    let refusal = invoke(
        app,
        window,
        "audio_overview_publish",
        json!({"context":collision_draft["context"]}),
        report,
    )
    .await?;
    report.gate("audio_existing_human_preserved", refusal.is_err()
        && std::fs::read(&human).map_err(|error| error.to_string())? == HUMAN.as_bytes(),
        json!({"nativeError":refusal.err(),"humanSha256":sha(HUMAN.as_bytes()),"generation":"synthetic_callback"}))?;
    cancel(app, window, &collision_job, report).await?;

    let changed_job = begin(app, window, &source, &origin, "Changed source", report).await?;
    let changed_draft = draft(app, window, &changed_job, report).await?;
    let edited = invoke(app, window, "write_editor_file",
        json!({"path":source,"origin":origin,"content":EDITED,"expectedSha256":sha(ORIGINAL.as_bytes())}), report).await??;
    let refusal = invoke(
        app,
        window,
        "audio_overview_publish",
        json!({"context":changed_draft["context"]}),
        report,
    )
    .await?;
    report.gate("audio_source_edit_blocks_publish", refusal.is_err()
        && edited["revision"] == sha(EDITED.as_bytes())
        && std::fs::read(&source).map_err(|error| error.to_string())? == EDITED.as_bytes()
        && !root.join("audio/changed-source-2026-10-11.md").exists(),
        json!({"nativeError":refusal.err(),"editorReceipt":edited,"generation":"synthetic_callback"}))?;
    cancel(app, window, &changed_job, report).await?;
    invoke(app, window, "write_editor_file",
        json!({"path":source,"origin":origin,"content":ORIGINAL,"expectedSha256":sha(EDITED.as_bytes())}), report).await??;

    let first_job = begin(app, window, &source, &origin, "Competing audio", report).await?;
    let second_job = begin(app, window, &source, &origin, "Competing audio", report).await?;
    let first_draft = draft(app, window, &first_job, report).await?;
    let second_draft = draft(app, window, &second_job, report).await?;
    let published = invoke(
        app,
        window,
        "audio_overview_publish",
        json!({"context":first_draft["context"]}),
        report,
    )
    .await??;
    let target = root.join("audio/competing-audio-2026-10-11.md");
    let original_publication = std::fs::read(&target).map_err(|error| error.to_string())?;
    let competing = invoke(
        app,
        window,
        "audio_overview_publish",
        json!({"context":second_draft["context"]}),
        report,
    )
    .await?;
    report.gate("audio_absence_cas_and_competing_job", published["state"] == "persisted"
        && published["jobId"] == first_job["jobId"]
        && published["draftId"] == first_draft["context"]["draftId"]
        && published["origin"] == origin
        && published["path"] == target.to_string_lossy().as_ref()
        && published["revision"] == sha(&original_publication)
        && competing.is_err()
        && std::fs::read(&target).map_err(|error| error.to_string())? == original_publication,
        json!({"receipt":published,"competingError":competing.err(),"generation":"synthetic_callback",
            "race":"sequential_public_creation","simultaneousRace":"native_unit_test_only"}))?;
    cancel(app, window, &first_job, report).await?;
    cancel(app, window, &second_job, report).await?;

    let stale_job = begin(app, window, &source, &origin, "Reopened audio", report).await?;
    let stale_draft = draft(app, window, &stale_job, report).await?;
    invoke(app, window, "open_vault", json!({"path":root}), report).await??;
    let reopened = invoke(app, window, "agent_vault_session", json!({}), report).await??;
    let refusal = invoke(
        app,
        window,
        "audio_overview_publish",
        json!({"context":stale_draft["context"]}),
        report,
    )
    .await?;
    report.gate("audio_same_root_reopen_revokes_job", reopened["vaultPath"] == origin["vaultPath"]
        && reopened["openingToken"] != origin["openingToken"] && refusal.is_err()
        && !root.join("audio/reopened-audio-2026-10-11.md").exists(),
        json!({"firstOrigin":origin,"reopenedOrigin":reopened,"nativeError":refusal.err(),"generation":"synthetic_callback"}))?;
    // Cancellation can release its old job after the native opening was replaced.
    cancel(app, window, &stale_job, report).await?;
    Ok(())
}
