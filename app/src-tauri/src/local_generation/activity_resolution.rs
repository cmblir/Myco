//! Native opening guards around bounded resolution IO; never around inference.

use super::Request;
use crate::activity_recall::{ResolutionRead, ResolutionSources, ResolutionTaskKey};
use crate::retrieval::Bm25Index;
use crate::wiki_claims::SourceSet;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use tauri::Manager;

pub(super) fn read(
    app: &tauri::AppHandle,
    root: &Path,
    index: &Bm25Index,
    request: &Request,
    initial: &SourceSet,
    keys: &[ResolutionTaskKey],
    cancelled: &AtomicBool,
) -> Result<ResolutionSources, String> {
    let origin = request
        .origin
        .as_ref()
        .ok_or("activity resolution requires its native opening")?;
    let resolution = request
        .resolution
        .as_ref()
        .ok_or("activity resolution was not requested")?;
    let range = request
        .range
        .as_ref()
        .ok_or("activity resolution requires the claimed period")?;
    let window = resolution.checked_window(range, super::clock() as i64)?;
    super::with_ask_role(
        &app.state::<crate::commands::VaultRoot>(),
        origin,
        request.role_snapshot.as_ref(),
        request.model_id.as_deref(),
        |current, _| {
            if current != root {
                return Err("active vault changed".into());
            }
            crate::activity_recall::read_resolution(
                ResolutionRead {
                    root: current,
                    index,
                    origin,
                    scope: request.scope,
                    paths: request.paths.as_deref(),
                    window: &window,
                    task_keys: keys,
                    initial,
                    include_archived: crate::settings::search_archived_sessions(),
                },
                cancelled,
            )
        },
    )
}

pub(super) fn recheck(
    app: &tauri::AppHandle,
    root: &Path,
    request: &Request,
    sources: &ResolutionSources,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    let origin = request
        .origin
        .as_ref()
        .ok_or("activity resolution requires its native opening")?;
    super::with_ask_role(
        &app.state::<crate::commands::VaultRoot>(),
        origin,
        request.role_snapshot.as_ref(),
        request.model_id.as_deref(),
        |current, _| {
            if current != root {
                return Err("active vault changed".into());
            }
            crate::activity_recall::recheck_resolution(current, &sources.revisions, cancelled)
        },
    )
}
