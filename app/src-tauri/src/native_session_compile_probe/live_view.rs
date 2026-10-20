//! Public queue projection checks; no model weights or generation are used.

use super::{gate, invoke, require};
use crate::importers::wikify::{Pending, PendingItem};
use crate::vault_session::AgentVaultSession;
use serde_json::{json, Value};
use std::path::Path;
use tauri::Manager;

async fn list(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    root: &Path,
    origin: &AgentVaultSession,
) -> Result<Value, String> {
    invoke(
        app,
        window,
        "list_wikify_pending",
        json!({"expectedVault":root,"origin":origin,"limit":3}),
    )
    .await?
    .reply
}

async fn begin(
    app: &tauri::AppHandle,
    window: &tauri::WebviewWindow,
    item: &PendingItem,
    usage: &str,
) -> Result<Value, String> {
    let origin = app.state::<crate::commands::VaultRoot>().snapshot()?;
    invoke(
        app,
        window,
        "session_compile_begin",
        json!({"origin":origin,"usage":usage,"source":{"key":item.key,
            "rawPath":item.raw_path,"sourceRevision":item.source_revision}}),
    )
    .await?
    .reply
}

fn row<'a>(view: &'a Value, item: &PendingItem) -> Result<&'a Value, String> {
    view["items"]
        .as_array()
        .and_then(|rows| rows.iter().find(|row| row["key"] == item.key))
        .ok_or("public queue lost the synthetic source".into())
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
        .ok_or("live view fixture lacks projection lineage")?;
    let paths = [
        root.join(&item.raw_path),
        root.join("wiki/session.md"),
        crate::vault_dir::dir(root).join("ledger.json"),
        root.join(projection),
    ];
    let protected = paths
        .iter()
        .map(std::fs::read)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let context = begin(app, window, item, "foreground").await?;
    let old_origin = app.state::<crate::commands::VaultRoot>().snapshot()?;
    let current = list(app, window, root, &old_origin).await?;
    let current_row = row(&current, item)?;
    gate(
        "live_view_current_idle_issuer_is_running_without_weights",
        current_row["compilationState"] == "running" && current_row["compilationReason"].is_null(),
    )?;
    let queue = std::fs::read(Pending::path(root)).map_err(|error| error.to_string())?;
    super::open(app, root)?;
    let new_origin = app.state::<crate::commands::VaultRoot>().snapshot()?;
    let reopened = list(app, window, root, &new_origin).await?;
    let reopened_row = row(&reopened, item)?;
    gate(
        "live_view_reopened_origin_is_pending_without_queue_write",
        new_origin.opening_token != old_origin.opening_token
            && reopened_row["compilationState"] == "pending"
            && reopened_row["compilationReason"] == "compiler_runtime_revalidation_required"
            && std::fs::read(Pending::path(root)).map_err(|error| error.to_string())? == queue,
    )?;
    let old_list = list(app, window, root, &old_origin).await;
    gate(
        "live_view_old_origin_list_is_rejected",
        old_list
            .as_ref()
            .err()
            .is_some_and(|error| error.contains("active vault changed"))
            && std::fs::read(Pending::path(root)).map_err(|error| error.to_string())? == queue,
    )?;
    let manual = begin(app, window, item, "foreground").await?;
    let after_manual = Pending::try_load(root)?;
    let old_attempt = after_manual
        .compile_jobs
        .iter()
        .flat_map(|job| &job.attempts)
        .find(|attempt| context["attemptId"] == attempt.id)
        .ok_or("manual retry lost its previous attempt")?;
    let manual_view = list(app, window, root, &new_origin).await?;
    gate(
        "live_view_fresh_manual_begin_retires_stale_history_and_is_running",
        manual["attemptId"] != context["attemptId"]
            && manual["origin"]["openingToken"] == new_origin.opening_token
            && old_attempt.state == crate::session_compile::WorkState::Stopped
            && row(&manual_view, item)?["compilationState"] == "running",
    )?;
    let manual_bytes = std::fs::read(Pending::path(root)).map_err(|error| error.to_string())?;
    super::open(app, root)?;
    let automatic_origin = app.state::<crate::commands::VaultRoot>().snapshot()?;
    let automatic_pending = list(app, window, root, &automatic_origin).await?;
    gate(
        "live_view_second_reopen_retains_manual_disk_state_before_automatic_retry",
        row(&automatic_pending, item)?["compilationState"] == "pending"
            && row(&automatic_pending, item)?["compilationReason"]
                == "compiler_runtime_revalidation_required"
            && std::fs::read(Pending::path(root)).map_err(|error| error.to_string())?
                == manual_bytes,
    )?;
    let automatic = begin(app, window, item, "automatic").await?;
    let automatic_view = list(app, window, root, &automatic_origin).await?;
    gate(
        "live_view_fresh_automatic_begin_after_reopen_is_running",
        automatic["attemptId"] != manual["attemptId"]
            && automatic["roleSnapshot"]["usage"] == "automatic"
            && automatic["origin"]["openingToken"] == automatic_origin.opening_token
            && row(&automatic_view, item)?["compilationState"] == "running",
    )?;
    let final_queue = Pending::try_load(root)?;
    let mut history_preserved = true;
    for previous in &initial.compile_jobs {
        let current = final_queue
            .compile_jobs
            .iter()
            .find(|job| job.id == previous.id)
            .ok_or("live view lost existing compiler history")?;
        history_preserved &= serde_json::to_value(&current.receipts)
            .map_err(|error| error.to_string())?
            == serde_json::to_value(&previous.receipts).map_err(|error| error.to_string())?;
        for old in &previous.attempts {
            let kept = current
                .attempts
                .iter()
                .find(|attempt| attempt.id == old.id)
                .ok_or("live view lost an existing attempt")?;
            history_preserved &= serde_json::to_value(kept).map_err(|error| error.to_string())?
                == serde_json::to_value(old).map_err(|error| error.to_string())?;
        }
    }
    let preserved = paths
        .iter()
        .zip(protected.iter())
        .try_fold(true, |kept, (path, bytes)| {
            std::fs::read(path).map(|current| kept && current == *bytes)
        })
        .map_err(|error| error.to_string())?;
    require(
        automatic["roleSnapshot"]["routeSignature"]["providerId"] == "builtin-local",
        "live view did not retain its local route",
    )?;
    gate(
        "live_view_revalidation_preserves_raw_human_ledger_projection_and_reminders",
        preserved
            && history_preserved
            && final_queue.pending == initial.pending
            && final_queue.receipts == initial.receipts
            && final_queue.done_count == initial.done_count,
    )
}
