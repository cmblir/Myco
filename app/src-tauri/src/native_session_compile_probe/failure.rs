//! Real public command errors over synthetic sources and absent model weights.
//! Early cancellation is not evidence of mid-generation cancellation or drain.

use super::{gate, invoke_raw};
use crate::importers::wikify::{Pending, PendingItem};
use crate::session_compile::{CompilationJob, SessionCompileContext, WorkState};
use serde_json::{json, Value};
use std::path::Path;
use tauri::Manager;

async fn call(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    command: &str,
    arguments: Value,
) -> Result<Result<Value, Value>, String> {
    let invocation = invoke_raw(app, window, command, arguments).await?;
    super::require(
        invocation.progress.is_empty(),
        "compiler failure command emitted unrelated import progress",
    )?;
    Ok(invocation.reply)
}

async fn begin(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    item: &PendingItem,
) -> Result<SessionCompileContext, String> {
    let origin = app.state::<crate::commands::VaultRoot>().snapshot()?;
    let value = call(
        app,
        window,
        "session_compile_begin",
        json!({"origin":origin,"source":{"key":item.key,"rawPath":item.raw_path,
            "sourceRevision":item.source_revision},"usage":"foreground"}),
    )
    .await?
    .map_err(|error| format!("public compiler begin failed: {error}"))?;
    serde_json::from_value(value).map_err(|error| format!("public compiler context: {error}"))
}

fn job<'a>(
    pending: &'a Pending,
    context: &SessionCompileContext,
) -> Result<&'a CompilationJob, String> {
    let mut matches = pending
        .compile_jobs
        .iter()
        .filter(|job| job.id == context.job_id);
    let job = matches.next().ok_or("public compiler job missing")?;
    super::require(matches.next().is_none(), "public compiler job is ambiguous")?;
    Ok(job)
}

fn durable_state(
    pending: &Pending,
    context: &SessionCompileContext,
    state: WorkState,
    reason: Option<&str>,
) -> Result<bool, String> {
    let job = job(pending, context)?;
    Ok(job.source == context.source
        && job.state == state
        && job.reason.as_deref() == reason
        && job.attempts.last().is_some_and(|attempt| {
            attempt.id == context.attempt_id
                && attempt.origin.vault_path == context.origin.vault_path
                && attempt.origin.opening_token == context.origin.opening_token
                && attempt.role_snapshot_id == context.role_snapshot.snapshot_id
                && attempt.identity.source == context.source
                && attempt.identity.role_signature
                    == context.role_snapshot.route_signature.signature()
                && attempt.state == state
                && attempt.reason.as_deref() == reason
        }))
}

fn ownerless(error: &Value) -> bool {
    error["version"] == "SessionCompileFailureV1"
        && error["message"]
            .as_str()
            .is_some_and(|text| !text.is_empty())
        && error.get("outcome").is_some_and(Value::is_null)
        && error.get("finalizationError").is_some_and(Value::is_null)
}

fn confirmed(
    error: &Value,
    context: &SessionCompileContext,
    request_id: &str,
    state: &str,
    reason: &str,
) -> Result<bool, String> {
    let outcome = &error["outcome"];
    Ok(error["version"] == "SessionCompileFailureV1"
        && error["message"]
            .as_str()
            .is_some_and(|text| !text.is_empty())
        && error.get("finalizationError").is_some_and(Value::is_null)
        && outcome["attemptId"] == context.attempt_id
        && outcome["sourceRevision"] == context.source.source_revision
        && outcome["compileSignature"] == context.compile_signature
        && outcome["origin"]
            == serde_json::to_value(&context.origin).map_err(|error| error.to_string())?
        && outcome["roleSnapshotId"] == context.role_snapshot.snapshot_id
        && outcome["requestId"] == request_id
        && outcome["state"] == state
        && outcome["reason"] == reason)
}

fn rejected(reply: Result<Value, Value>) -> Result<Value, String> {
    reply
        .err()
        .ok_or("public compiler unexpectedly succeeded".into())
}

pub(super) async fn verify(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    root: &Path,
    item: &PendingItem,
) -> Result<(), String> {
    let initial = Pending::try_load(root)?;
    let ledger = crate::importers::ledger::Ledger::load(root)?;
    let projection = ledger
        .location("sessions", &item.key)
        .ok_or("failure probe lacks imported projection lineage")?;
    let preserved_paths = [
        root.join(&item.raw_path),
        root.join("wiki/session.md"),
        crate::vault_dir::dir(root).join("ledger.json"),
        root.join(projection),
    ];
    let preserved = preserved_paths
        .iter()
        .map(std::fs::read)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let models = crate::local_model::model_dir()?;
    std::fs::create_dir_all(&models).map_err(|error| error.to_string())?;
    super::require(
        std::fs::read_dir(&models)
            .map_err(|error| error.to_string())?
            .next()
            .is_none(),
        "failure probe requires an empty isolated model directory",
    )?;

    let context = begin(app, window, item).await?;
    let started = Pending::try_load(root)?;
    gate(
        "failure_public_begin_issues_current_running_local_attempt",
        context.role_snapshot.route_signature.provider_id == "builtin-local"
            && context.summary_path == "wiki/session.md"
            && context.source.key == item.key
            && context.source.raw_path == item.raw_path
            && context.source.source_revision == item.source_revision
            && durable_state(&started, &context, WorkState::Running, None)?,
    )?;
    let request = format!("failure-missing-{}", context.attempt_id);
    let error = rejected(
        call(
            app,
            window,
            "session_compile_step",
            json!({"context":context,
            "requestId":request,"lang":"en"}),
        )
        .await?,
    )?;
    gate(
        "failure_missing_artifact_preserves_structured_exact_bound_pending_reply",
        confirmed(
            &error,
            &context,
            &request,
            "pending",
            "model_preparation_unavailable",
        )? && error["message"]
            .as_str()
            .is_some_and(|text| text.contains("local model is not installed or readable")),
    )?;
    let pending = Pending::try_load(root)?;
    let before_attempt = job(&started, &context)?
        .attempts
        .last()
        .ok_or("public compiler started attempt missing")?;
    let pending_attempt = job(&pending, &context)?
        .attempts
        .last()
        .ok_or("public compiler pending attempt missing")?;
    gate(
        "failure_missing_artifact_persists_pending_without_processing_or_publication",
        durable_state(
            &pending,
            &context,
            WorkState::Pending,
            Some("model_preparation_unavailable"),
        )? && pending_attempt.checks == before_attempt.checks
            && pending_attempt.compiler_progress.is_none()
            && pending_attempt.outputs.is_empty()
            && pending_attempt.prepared_outputs.is_empty()
            && serde_json::to_value(&job(&pending, &context)?.receipts)
                .map_err(|error| error.to_string())?
                == serde_json::to_value(&job(&started, &context)?.receipts)
                    .map_err(|error| error.to_string())?,
    )?;

    let retry = begin(app, window, item).await?;
    let retried = Pending::try_load(root)?;
    gate(
        "failure_public_retry_issues_new_attempt_and_retains_pending_history",
        retry.attempt_id != context.attempt_id
            && durable_state(&retried, &retry, WorkState::Running, None)?
            && serde_json::to_value(
                job(&retried, &retry)?
                    .attempts
                    .iter()
                    .find(|attempt| attempt.id == context.attempt_id)
                    .ok_or("public compiler retry lost prior pending attempt")?,
            )
            .map_err(|error| error.to_string())?
                == serde_json::to_value(pending_attempt).map_err(|error| error.to_string())?,
    )?;
    let running_bytes = std::fs::read(Pending::path(root)).map_err(|error| error.to_string())?;
    let language_error = rejected(
        call(
            app,
            window,
            "session_compile_step",
            json!({"context":retry,"requestId":"failure-language","lang":"invalid"}),
        )
        .await?,
    )?;
    gate(
        "failure_unsupported_language_is_ownerless_and_preserves_running_attempt",
        ownerless(&language_error)
            && language_error["message"] == "unsupported compiler language"
            && std::fs::read(Pending::path(root)).map_err(|error| error.to_string())?
                == running_bytes,
    )?;
    let mut forged = serde_json::to_value(&retry).map_err(|error| error.to_string())?;
    forged["compileSignature"] = json!("0".repeat(64));
    let forged_error = rejected(
        call(
            app,
            window,
            "session_compile_step",
            json!({"context":forged,"requestId":"failure-forged","lang":"en"}),
        )
        .await?,
    )?;
    gate(
        "failure_forged_context_is_ownerless_and_preserves_healthy_attempt",
        ownerless(&forged_error)
            && std::fs::read(Pending::path(root)).map_err(|error| error.to_string())?
                == running_bytes,
    )?;
    call(
        app,
        window,
        "session_compile_stop",
        json!({"context":retry,"reason":"stopped"}),
    )
    .await?
    .map_err(|error| format!("public compiler Stop failed: {error}"))?;
    gate(
        "failure_explicit_public_stop_persists_current_attempt_stopped",
        durable_state(
            &Pending::try_load(root)?,
            &retry,
            WorkState::Stopped,
            Some("stopped"),
        )?,
    )?;

    let cancelled = begin(app, window, item).await?;
    let cancelled_request = format!("failure-cancelled-{}", cancelled.attempt_id);
    let early = call(
        app,
        window,
        "cancel_local_synthesis",
        json!({"requestId":cancelled_request}),
    )
    .await?;
    let cancelled_error = rejected(
        call(
            app,
            window,
            "session_compile_step",
            json!({"context":cancelled,"requestId":cancelled_request,"lang":"en"}),
        )
        .await?,
    )?;
    gate(
        "failure_public_early_cancel_finalizes_only_acquired_request_without_weights",
        early == Ok(json!(false))
            && confirmed(
                &cancelled_error,
                &cancelled,
                &cancelled_request,
                "stopped",
                "cancelled",
            )?
            && durable_state(
                &Pending::try_load(root)?,
                &cancelled,
                WorkState::Stopped,
                Some("cancelled"),
            )?,
    )?;

    let before_reopen = std::fs::read(Pending::path(root)).map_err(|error| error.to_string())?;
    super::open(app, root)?;
    let stale_error = rejected(
        call(
            app,
            window,
            "session_compile_step",
            json!({"context":cancelled,"requestId":"failure-stale-opening","lang":"en"}),
        )
        .await?,
    )?;
    gate(
        "failure_same_path_reopen_rejects_stale_step_without_queue_mutation",
        ownerless(&stale_error)
            && app
                .state::<crate::commands::VaultRoot>()
                .snapshot()?
                .opening_token
                != cancelled.origin.opening_token
            && std::fs::read(Pending::path(root)).map_err(|error| error.to_string())?
                == before_reopen,
    )?;
    let final_queue = Pending::try_load(root)?;
    let unchanged = preserved_paths
        .iter()
        .zip(preserved.iter())
        .try_fold(true, |unchanged, (path, bytes)| {
            std::fs::read(path).map(|current| unchanged && current == *bytes)
        })
        .map_err(|error| error.to_string())?;
    // The preceding public publication controls may have retained real outputs.
    // Their serialized attempt values remain identical; only this
    // failure wave's newly issued attempts must have no generated artifacts.
    let mut history_preserved = true;
    for previous_job in &initial.compile_jobs {
        let current_job = final_queue
            .compile_jobs
            .iter()
            .find(|job| job.id == previous_job.id)
            .ok_or("failure wave lost a pre-existing compiler job")?;
        history_preserved &= serde_json::to_value(&current_job.receipts)
            .map_err(|error| error.to_string())?
            == serde_json::to_value(&previous_job.receipts).map_err(|error| error.to_string())?;
        for previous_attempt in &previous_job.attempts {
            let current_attempt = current_job
                .attempts
                .iter()
                .find(|attempt| attempt.id == previous_attempt.id)
                .ok_or("failure wave lost a pre-existing compiler attempt")?;
            history_preserved &= serde_json::to_value(current_attempt)
                .map_err(|error| error.to_string())?
                == serde_json::to_value(previous_attempt).map_err(|error| error.to_string())?;
        }
    }
    let mut no_new_artifacts = true;
    for current_job in &final_queue.compile_jobs {
        let previous_job = initial
            .compile_jobs
            .iter()
            .find(|job| job.id == current_job.id);
        if previous_job.is_none() {
            no_new_artifacts &= current_job.receipts.is_empty();
        }
        no_new_artifacts &= current_job
            .attempts
            .iter()
            .filter(|attempt| {
                !previous_job.is_some_and(|previous| {
                    previous.attempts.iter().any(|old| old.id == attempt.id)
                })
            })
            .all(|attempt| {
                attempt.outputs.is_empty()
                    && attempt.prepared_outputs.is_empty()
                    && attempt.compiler_progress.is_none()
            });
    }
    gate(
        "failure_wave_preserves_raw_human_projection_ledger_and_reminders_without_artifacts",
        unchanged
            && final_queue.pending == initial.pending
            && final_queue.done_count == initial.done_count
            && final_queue.receipts == initial.receipts
            && history_preserved
            && no_new_artifacts
            && std::fs::read_dir(&models)
                .map_err(|error| error.to_string())?
                .next()
                .is_none()
            && crate::local_generation::probe_busy() == Some(false),
    )
}
