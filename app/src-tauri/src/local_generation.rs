//! Optional local Ask execution; model files and inference never run at startup.

mod activity_flow;
#[cfg(test)]
#[path = "local_generation/activity_originals_tests.rs"]
mod activity_originals_tests;
mod activity_resolution;
#[cfg(feature = "native-index-probe")]
mod activity_sampler_qa;
#[cfg(feature = "native-index-probe")]
pub mod answer_review_qualification_qa;
#[cfg(feature = "native-index-probe")]
pub mod direct_reading_qa;
mod ordinary_flow;
#[cfg(feature = "native-index-probe")]
pub mod ordinary_probe;
mod ordinary_sources;
#[cfg(test)]
mod package_status_tests;
#[cfg(feature = "native-index-probe")]
pub mod review_probe;
mod session_compiler;
#[cfg(test)]
pub(crate) use session_compiler::run_preflighted_task;
#[cfg(all(test, feature = "native-index-probe"))]
mod source_focus_flow_tests;
mod stage_guard;
pub use crate::activity_recall::{
    AdditionalSourceDeclaration, OriginalLineageDeclaration, OriginalSpanDeclaration,
    ResolutionCoverage, ResolutionIssue, ResolutionMode, ResolutionRequest, ResolutionSources,
    ResolutionTaskKey, ResolutionWindow,
};
pub use activity_flow::{
    activity_synthesis_steps, activity_synthesis_steps_with_resolution, ActivityFlowFailure,
    ActivityFlowOutput, ActivityReceipt,
};
pub(crate) use ordinary_flow::run as ordinary_synthesis_steps;
pub use ordinary_flow::OrdinaryReceipt;
pub(crate) use session_compiler::compile_session_packet;

use crate::local_llm::LocalLlm;
use crate::local_model;
use crate::local_synthesis::{self, Evidence};
use crate::retrieval::{Bm25Index, Scope};
use crate::role_authorization::{RoleId, RoleSnapshot, RoleUsage};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{Emitter, Manager};

#[derive(Default, Clone)]
pub struct LocalChatState {
    model: Arc<Mutex<Option<LocalLlm>>>,
    last_used: Arc<AtomicU64>,
}

#[cfg(feature = "native-index-probe")]
impl LocalChatState {
    /// Release QA weights only after request workers have drained.
    pub(crate) fn unload_probe_chat(&self) -> Result<(), String> {
        if busy() {
            return Err("native chat probe requests still running".into());
        }
        let mut model = self
            .model
            .try_lock()
            .map_err(|_| "native chat probe model still busy or poisoned")?;
        *model = None;
        Ok(())
    }
}

#[derive(Serialize)]
pub struct Status {
    pub model_id: &'static str,
    pub state: &'static str,
    pub bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub model_id: Option<String>,
    pub request_id: String,
    pub question: String,
    // Topic context only; answers and prior date constraints are never inherited.
    pub previous_question: Option<String>,
    pub lang: String,
    pub hits: Vec<Evidence>,
    pub expected_vault: String,
    #[serde(default)]
    pub origin: Option<crate::vault_session::AgentVaultSession>,
    #[serde(default)]
    pub role_snapshot: Option<crate::role_authorization::RoleSnapshot>,
    pub scope: Scope,
    pub range: Option<crate::commands::DateRange>,
    pub paths: Option<Vec<String>>,
    pub max_tokens: Option<i32>,
    #[serde(default)]
    pub activity_overview: bool,
    #[serde(default)]
    pub resolution: Option<ResolutionRequest>,
}

#[derive(Serialize)]
pub struct Answer {
    pub answer: String,
    pub model_id: &'static str,
    pub used_sources: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_chunks: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_receipt: Option<ActivityReceipt>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub activity_failure: Option<ActivityFlowFailure>,
    #[serde(rename = "answerReceipt", skip_serializing_if = "Option::is_none")]
    pub answer_receipt: Option<OrdinaryReceipt>,
}

impl Answer {
    fn fallback(reason: &str, model_id: &'static str) -> Self {
        Self {
            answer: String::new(),
            model_id,
            used_sources: Vec::new(),
            selected_chunks: None,
            fallback_reason: Some(reason.into()),
            activity_receipt: None,
            activity_failure: None,
            answer_receipt: None,
        }
    }
}

#[derive(Default)]
struct Registry {
    running: HashMap<String, Arc<AtomicBool>>,
    cancelled_early: VecDeque<String>,
}

impl Registry {
    fn begin(&mut self, id: &str) -> Result<Arc<AtomicBool>, String> {
        if !valid_id(id) || self.running.len() >= 4 || self.running.contains_key(id) {
            return Err("local synthesis request is invalid or already busy".into());
        }
        let cancelled = self
            .cancelled_early
            .iter()
            .position(|old| old == id)
            .map(|position| self.cancelled_early.remove(position).is_some())
            .unwrap_or(false);
        let flag = Arc::new(AtomicBool::new(cancelled));
        self.running.insert(id.into(), flag.clone());
        Ok(flag)
    }

    fn cancel(&mut self, id: &str) -> bool {
        if !valid_id(id) {
            return false;
        }
        if let Some(flag) = self.running.get(id) {
            flag.store(true, Ordering::Relaxed);
            return true;
        }
        if !self.cancelled_early.iter().any(|old| old == id) {
            self.cancelled_early.push_back(id.into());
            if self.cancelled_early.len() > 16 {
                self.cancelled_early.pop_front();
            }
        }
        false
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
}

fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(Registry::default()))
}

struct Run(String);
impl Drop for Run {
    fn drop(&mut self) {
        if let Ok(mut registry) = registry().lock() {
            registry.running.remove(&self.0);
        }
    }
}

/// Includes queued requests so background indexing can defer heavy batches.
pub(crate) fn busy() -> bool {
    registry()
        .lock()
        .map(|registry| !registry.running.is_empty())
        .unwrap_or(true)
}

/// QA observation must not block behind the registry it is diagnosing.
#[cfg(feature = "native-index-probe")]
pub(crate) fn probe_busy() -> Option<bool> {
    registry()
        .try_lock()
        .ok()
        .map(|registry| !registry.running.is_empty())
}

pub fn cancel(id: &str) -> bool {
    registry()
        .lock()
        .map(|mut registry| registry.cancel(id))
        .unwrap_or(false)
}

fn clock() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|time| time.as_secs())
        .unwrap_or(0)
}

/// Release optional chat weights independently of the small embedding host.
pub fn spawn_janitor(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            let state = app.state::<LocalChatState>();
            if clock().saturating_sub(state.last_used.load(Ordering::Relaxed)) < 180 {
                continue;
            }
            if let Ok(mut model) = state.model.try_lock() {
                *model = None;
            };
        }
    });
}

pub async fn status(model_id: Option<&str>) -> Result<Status, String> {
    let manifest = local_model::manifest_for(model_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let dir = local_model::model_dir()?;
        Ok(status_in_dir(&dir, manifest))
    })
    .await
    .map_err(|error| format!("local model status task: {error}"))?
}

fn status_in_dir(dir: &Path, manifest: &local_model::ModelManifest) -> Status {
    match local_model::resolve_verified_package(dir, manifest) {
        Ok(_) => Status {
            model_id: manifest.id,
            state: "ready",
            bytes: manifest.bytes,
            reason: None,
        },
        Err(_)
            if !dir.join(manifest.file).exists()
                || manifest
                    .adapter
                    .is_some_and(|adapter| !dir.join(adapter.file).exists()) =>
        {
            Status {
                model_id: manifest.id,
                state: "missing",
                bytes: 0,
                reason: None,
            }
        }
        Err(_) => Status {
            model_id: manifest.id,
            state: "error",
            bytes: 0,
            reason: Some(if manifest.adapter.is_some() {
                "model package verification failed; reinstall the qualified local package".into()
            } else {
                "model verification failed; download again".into()
            }),
        },
    }
}

static DOWNLOAD: OnceLock<Mutex<Option<Arc<AtomicBool>>>> = OnceLock::new();
fn download_cell() -> &'static Mutex<Option<Arc<AtomicBool>>> {
    DOWNLOAD.get_or_init(|| Mutex::new(None))
}
struct DownloadRun;
impl Drop for DownloadRun {
    fn drop(&mut self) {
        if let Ok(mut active) = download_cell().lock() {
            *active = None;
        }
    }
}

pub fn cancel_download() -> bool {
    download_cell()
        .lock()
        .ok()
        .and_then(|active| active.clone())
        .is_some_and(|flag| {
            flag.store(true, Ordering::Relaxed);
            true
        })
}

pub async fn download(app: tauri::AppHandle, model_id: Option<&str>) -> Result<Status, String> {
    let manifest = local_model::manifest_for(model_id)?;
    let flag = {
        let mut active = download_cell()
            .lock()
            .map_err(|_| "model download state poisoned")?;
        if active.is_some() {
            return Err("a local model download is already running".into());
        }
        let flag = Arc::new(AtomicBool::new(false));
        *active = Some(flag.clone());
        flag
    };
    let _run = DownloadRun;
    let dir = local_model::model_dir()?;
    local_model::download_verified_artifact(&dir, manifest, flag, move |progress| {
        // Window closure does not invalidate a verified artifact download.
        if app.emit("local-chat-model-progress", progress).is_err() {
            eprintln!("[local_model] progress receiver unavailable");
        }
    })
    .await?;
    status(Some(manifest.id)).await
}

fn still_open(app: &tauri::AppHandle, root: &Path) -> bool {
    app.state::<crate::commands::VaultRoot>()
        .current()
        .and_then(|path| path.canonicalize().ok())
        .is_some_and(|current| current == root)
}

/// Keep native opening and foreground Ask authority through bounded source IO.
/// Model preparation and inference must run outside this transaction.
pub(crate) fn with_ask_role<T>(
    vault: &crate::vault_session::VaultRoot,
    origin: &crate::vault_session::AgentVaultSession,
    snapshot: Option<&RoleSnapshot>,
    requested_model: Option<&str>,
    dispatch: impl FnOnce(&Path, &'static local_model::ModelManifest) -> Result<T, String>,
) -> Result<T, String> {
    let snapshot = snapshot.ok_or("local Ask requires a native foreground role snapshot")?;
    vault.with_origin(origin, |root| {
        crate::role_authorization::with_current_role_at(
            origin,
            snapshot,
            RoleId::Ask,
            RoleUsage::Foreground,
            || {
                if snapshot.route_signature.provider_id != "builtin-local" {
                    return Err("request_route_mismatch: local Ask is not selected".into());
                }
                let selected = snapshot.route_signature.model_id.as_str();
                if requested_model.is_some_and(|model| model != selected) {
                    return Err(
                        "request_route_mismatch: Ask model differs from its native selection"
                            .into(),
                    );
                }
                let manifest = local_model::manifest_for(Some(selected))?;
                dispatch(root, manifest)
            },
        )
        .map_err(|error| error.to_string())
    })
}

fn with_request_role<T>(
    app: &tauri::AppHandle,
    request: &Request,
    dispatch: impl FnOnce(&Path, &'static local_model::ModelManifest) -> Result<T, String>,
) -> Result<T, String> {
    let origin = request
        .origin
        .as_ref()
        .ok_or("local Ask requires a native opening")?;
    with_ask_role(
        &app.state::<crate::commands::VaultRoot>(),
        origin,
        request.role_snapshot.as_ref(),
        request.model_id.as_deref(),
        dispatch,
    )
}

fn request_still_open(app: &tauri::AppHandle, root: &Path, request: &Request) -> bool {
    with_request_role(app, request, |current, _| Ok(current == root)).unwrap_or(false)
}

fn checked_request_evidence(
    app: &tauri::AppHandle,
    root: &Path,
    index: &Bm25Index,
    request: &Request,
) -> Result<CheckedEvidence, String> {
    with_request_role(app, request, |current, _| {
        if current != root {
            return Err("active vault changed".into());
        }
        checked_evidence(current, index, request)
    })
}

fn recheck_stage_evidence(
    app: &tauri::AppHandle,
    root: &Path,
    index: &Bm25Index,
    request: &Request,
    revisions: &HashMap<String, String>,
    later_revisions: Option<&std::collections::BTreeMap<String, String>>,
    cancelled: &AtomicBool,
) -> Result<(), String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("local generation cancelled".into());
    }
    let current = checked_request_evidence(app, root, index, request)?;
    if &current.revisions != revisions {
        return Err("source_changed_during_generation: original revisions changed".into());
    }
    if let Some(later) = later_revisions {
        with_request_role(app, request, |current, _| {
            if current != root {
                return Err("Ask opening or execution authority changed".into());
            }
            crate::activity_recall::recheck_resolution(current, later, cancelled)
        })?;
    }
    Ok(())
}

#[derive(Debug)]
struct CheckedEvidence {
    evidence: Vec<Evidence>,
    revisions: HashMap<String, String>,
    originals: Option<crate::wiki_claims::SourceSet>,
    original_inputs_incomplete: bool,
}

fn checked_evidence(
    root: &Path,
    index: &Bm25Index,
    request: &Request,
) -> Result<CheckedEvidence, String> {
    use std::io::Read;
    let canonical_root = root
        .canonicalize()
        .map_err(|_| "synthesis vault unavailable")?;
    let root = canonical_root.as_path();
    if let Some(resolution) = &request.resolution {
        if !request.activity_overview {
            return Err("resolution requires activity synthesis".into());
        }
        resolution.checked_window(
            request
                .range
                .as_ref()
                .ok_or("resolution requires its activity period")?,
            clock() as i64,
        )?;
    }
    {
        let origin = request
            .origin
            .as_ref()
            .ok_or(if request.activity_overview {
                "activity synthesis requires a native opening origin"
            } else {
                "synthesis requires a native opening origin"
            })?;
        if origin.opening_token.is_empty() || Path::new(&origin.vault_path) != root {
            return Err("synthesis opening origin does not match its vault".into());
        }
    }
    if request.hits.is_empty()
        || request.hits.len() > 12
        || request.question.trim().is_empty()
        || request.question.chars().count() > 2000
        || !matches!(request.lang.as_str(), "en" | "ko" | "ja")
        || request
            .previous_question
            .as_ref()
            .is_some_and(|question| question.chars().count() > 2000)
    {
        return Err("invalid synthesis evidence budget".into());
    }
    let mut pages = HashMap::new();
    let mut revisions = HashMap::new();
    let mut bytes = 0usize;
    let mut checked = Vec::new();
    let mut original_documents = Vec::new();
    let mut original_inputs_incomplete = false;
    for hit in &request.hits {
        if hit.page.len() > 1024
            || hit.stem.chars().count() > 256
            || hit.text.len() > 32768
            || hit.text.chars().count() > 8192
            || hit.page.contains(['[', ']', '|', '\r', '\n'])
            || !Path::new(&hit.page)
                .components()
                .all(|part| matches!(part, std::path::Component::Normal(_)))
            || !request.scope.keeps(&hit.page)
            || request
                .paths
                .as_ref()
                .is_some_and(|paths| !paths.contains(&hit.page))
            || crate::vector_index::is_cold_for(
                &hit.page,
                crate::settings::search_archived_sessions(),
            )
        {
            return Err("synthesis evidence is outside the requested scope".into());
        }
        if !pages.contains_key(&hit.page) {
            let path = crate::vault::confine_path(root, &root.join(&hit.page).to_string_lossy())?;
            let resolved = path
                .strip_prefix(root)
                .ok()
                .and_then(Path::to_str)
                .ok_or("invalid source path")?;
            if !request.scope.keeps(resolved)
                || request
                    .paths
                    .as_ref()
                    .is_some_and(|paths| !paths.iter().any(|path| path == resolved))
                || crate::vector_index::is_cold_for(
                    resolved,
                    crate::settings::search_archived_sessions(),
                )
            {
                return Err("resolved synthesis source is outside scope".into());
            }
            let metadata = std::fs::metadata(&path).map_err(|_| "synthesis source unavailable")?;
            if !metadata.is_file()
                || crate::vault::is_dataless(&metadata)
                || metadata.len() > 2 * 1024 * 1024
                || bytes + metadata.len() as usize > 8 * 1024 * 1024
            {
                return Err("synthesis source exceeds the local read budget".into());
            }
            let mut content = String::new();
            std::fs::File::open(path)
                .map_err(|_| "synthesis source unavailable")?
                .take(2 * 1024 * 1024 + 1)
                .read_to_string(&mut content)
                .map_err(|_| "synthesis source unreadable")?;
            bytes += content.len();
            if content.len() > 2 * 1024 * 1024 || bytes > 8 * 1024 * 1024 {
                return Err("synthesis source grew beyond the read budget".into());
            }
            let chunks = crate::embeddings::chunk_page(&content);
            // An unchanged selected excerpt does not make a changed page current.
            let hashes: Vec<_> = chunks
                .iter()
                .map(|chunk| crate::embeddings::content_hash(chunk))
                .collect();
            if index.page_hashes(&hit.page).as_ref() != Some(&hashes) {
                return Err("synthesis source changed after retrieval".into());
            }
            revisions.insert(
                hit.page.clone(),
                format!("{:x}", Sha256::digest(content.as_bytes())),
            );
            let requested_sections: Vec<_> = if request.activity_overview {
                request
                    .hits
                    .iter()
                    .filter(|selected| selected.page == hit.page)
                    .map(|selected| selected.section)
                    .collect()
            } else {
                (0..chunks.len()).collect()
            };
            let (activity_sections, section_times) = {
                let bound = crate::activity_recall::original_activity_inputs(
                    root,
                    &hit.page,
                    &content,
                    &chunks,
                    &requested_sections,
                    &mut bytes,
                    crate::settings::search_archived_sessions(),
                )?;
                if !request.activity_overview && bound.unavailable_inputs {
                    return Err("ordinary original inputs are missing or invalid".into());
                }
                for (path, revision) in bound.guard_revisions {
                    if revisions
                        .get(&path)
                        .is_some_and(|existing| existing != &revision)
                    {
                        return Err(
                            "original activity lineage changed between selected pages".into()
                        );
                    }
                    revisions.insert(path, revision);
                }
                original_inputs_incomplete |= bound.incomplete;
                original_documents.extend(bound.documents);
                (bound.sections, bound.section_times)
            };
            let compiled = activity_sections
                .as_ref()
                .zip(request.range.as_ref())
                .and_then(|(sections, range)| {
                    crate::activity_recall::compiled_session(
                        &content,
                        &chunks,
                        sections,
                        range,
                        &requested_sections,
                    )
                });
            pages.insert(
                hit.page.clone(),
                (content, chunks, activity_sections, section_times, compiled),
            );
        }
        let (content, chunks, activity_sections, section_times, compiled) = &pages[&hit.page];
        let text = chunks
            .get(hit.section)
            .ok_or("synthesis source section changed")?;
        if text != &crate::norm::nfc(&hit.text)
            || index.chunk_hash(&hit.page, hit.section)
                != Some(crate::embeddings::content_hash(text))
        {
            return Err("synthesis source changed after retrieval".into());
        }
        if request.activity_overview && request.range.is_none() {
            return Err("activity synthesis requires a period".into());
        }
        if request.activity_overview
            && activity_sections
                .as_ref()
                .is_some_and(|sections| !sections.get(hit.section).copied().unwrap_or(false))
        {
            return Err("activity source proof changed or passage was not verified".into());
        }
        if request.range.as_ref().is_some_and(|range| {
            if request.activity_overview {
                !crate::activity_recall::original_section_in_range(
                    section_times.as_deref(),
                    hit.section,
                    range,
                )
                .unwrap_or_else(|| {
                    crate::activity_recall::chunk_date_in_range(
                        &hit.page,
                        content,
                        chunks,
                        hit.section,
                        range,
                    )
                })
            } else {
                !crate::commands::chunk_in_date_range(
                    &hit.page,
                    content,
                    chunks,
                    hit.section,
                    range,
                )
            }
        }) {
            return Err("synthesis source is outside the requested period".into());
        }
        let stem = Path::new(&hit.page)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .ok_or("invalid source filename")?;
        checked.push(Evidence {
            title: crate::activity_recall::source_title(content),
            compiled: compiled.clone(),
            page: hit.page.clone(),
            stem: stem.into(),
            section: hit.section,
            text: text.clone(),
        });
    }
    let originals = {
        let origin = request
            .origin
            .clone()
            .ok_or("synthesis requires a native opening origin")?;
        let mut sources = crate::wiki_claims::SourceSet::new(
            origin.clone(),
            request.scope,
            original_documents,
            vec![],
        )?;
        if request.activity_overview {
            let backing = ordinary_sources::complete_backing(
                root,
                &sources,
                &origin,
                request.scope,
                request.paths.as_deref(),
                &mut bytes,
            )?;
            // Keep every selected coordinate/ID, including partial-turn quotes.
            // Full context must not replace the original admission provenance.
            let additional = backing.retained(|incoming| {
                !sources.spans().any(|selected| {
                    selected.same_original_turn(incoming)
                        && selected.start() == incoming.start()
                        && selected.end() == incoming.end()
                        && selected.span_sha256() == incoming.span_sha256()
                        && selected.speaker() == incoming.speaker()
                        && selected.turn_time() == incoming.turn_time()
                        && selected.record_time() == incoming.record_time()
                        && selected.source_phase() == incoming.source_phase()
                })
            })?;
            sources = sources.merged(&additional)?;
        } else {
            let selected_pages = pages
                .iter()
                .map(|(page, (content, ..))| (page.clone(), content.clone()))
                .collect();
            sources = ordinary_sources::complete(
                root,
                &sources,
                &origin,
                request.scope,
                request.paths.as_deref(),
                &selected_pages,
                &mut bytes,
            )?;
        }
        for span in sources.spans() {
            if revisions
                .get(span.source_path())
                .is_some_and(|revision| revision != span.source_revision())
            {
                return Err("original activity source changed between selected pages".into());
            }
            revisions.insert(span.source_path().into(), span.source_revision().into());
        }
        Some(sources)
    };
    Ok(CheckedEvidence {
        evidence: checked,
        revisions,
        originals,
        original_inputs_incomplete,
    })
}

enum ModelAccessFailure {
    Preparation(String),
    Host(String),
    Cancelled,
}

impl ModelAccessFailure {
    fn message(self) -> String {
        match self {
            Self::Preparation(message) | Self::Host(message) => message,
            Self::Cancelled => "cancelled".into(),
        }
    }
}

fn with_model<T>(
    state: &LocalChatState,
    flag: &AtomicBool,
    manifest: &local_model::ModelManifest,
    run: impl FnOnce(&LocalLlm) -> Result<T, String>,
) -> Result<T, String> {
    with_model_access(state, flag, manifest, run).map_err(ModelAccessFailure::message)?
}

/// One host serializes all local roles; loading another artifact replaces the old one.
fn with_model_access<T>(
    state: &LocalChatState,
    flag: &AtomicBool,
    manifest: &local_model::ModelManifest,
    run: impl FnOnce(&LocalLlm) -> T,
) -> Result<T, ModelAccessFailure> {
    let check_cancelled = || {
        if flag.load(Ordering::Acquire) {
            Err(ModelAccessFailure::Cancelled)
        } else {
            Ok(())
        }
    };
    check_cancelled()?;
    let dir = local_model::model_dir().map_err(ModelAccessFailure::Preparation)?;
    let package = local_model::resolve_verified_package(&dir, manifest)
        .map_err(ModelAccessFailure::Preparation)?;
    let mut host = loop {
        check_cancelled()?;
        match state.model.try_lock() {
            Ok(host) => break host,
            Err(std::sync::TryLockError::WouldBlock) => {
                std::thread::sleep(std::time::Duration::from_millis(20))
            }
            Err(_) => return Err(ModelAccessFailure::Host("local chat state poisoned".into())),
        }
    };
    package
        .check_unchanged()
        .map_err(ModelAccessFailure::Preparation)?;
    state.last_used.store(clock(), Ordering::Relaxed);
    if host.is_none() {
        *host = Some(LocalLlm::load_embed_host().map_err(ModelAccessFailure::Host)?);
    }
    let model = host.as_mut().expect("local chat host initialized");
    model
        .ensure_chat_package(&package)
        .map_err(ModelAccessFailure::Host)?;
    check_cancelled()?;
    let result = run(model);
    state.last_used.store(clock(), Ordering::Relaxed);
    Ok(result)
}

#[cfg(test)]
type SynthesisResult = Result<(String, Vec<String>, usize), &'static str>;

#[cfg(test)]
fn synthesis_steps(
    request: &Request,
    evidence: &[Evidence],
    token_count: impl Fn(&str, &str) -> Result<usize, String>,
    generate: impl FnOnce(&str, &str, i32) -> Result<String, String>,
) -> SynthesisResult {
    let output_limit = if request.activity_overview { 768 } else { 192 };
    let max_tokens = request
        .max_tokens
        .unwrap_or(output_limit)
        .clamp(1, output_limit);
    let context_tokens = if request.activity_overview {
        4096
    } else {
        2048
    };
    let fits = |system: &str, user: &str| {
        token_count(system, user).map(|count| count <= context_tokens - max_tokens as usize - 8)
    };
    let prompt = if request.activity_overview {
        let range = request.range.as_ref().ok_or("prompt_unavailable")?;
        local_synthesis::prepare_activity(&request.question, &request.lang, evidence, range, fits)
    } else {
        local_synthesis::prepare(
            &request.question,
            request.previous_question.as_deref(),
            &request.lang,
            evidence,
            fits,
        )
    }
    .map_err(|_| "prompt_unavailable")?;
    let output =
        generate(&prompt.system, &prompt.user, max_tokens).map_err(|_| "generation_failed")?;
    local_synthesis::validate_answer(&output, &prompt, &request.lang)
        .map(|(answer, sources)| (answer, sources, prompt.evidence.len()))
        .map_err(|error| {
            if error == local_synthesis::INCOMPLETE_ANSWER {
                "answer_incomplete"
            } else {
                "answer_rejected"
            }
        })
}

#[cfg(test)]
fn synthesis_model_result(result: Result<SynthesisResult, String>) -> SynthesisResult {
    result.unwrap_or(Err("model_unavailable"))
}

/// The same verified local model chooses an activity period before recall.
pub async fn plan_recall(
    app: tauri::AppHandle,
    state: LocalChatState,
    root: PathBuf,
    index: Arc<Bm25Index>,
    request: crate::local_query_plan::Request,
) -> Result<crate::local_query_plan::Plan, String> {
    let manifest = with_ask_role(
        &app.state::<crate::commands::VaultRoot>(),
        &request.origin,
        request.role_snapshot.as_ref(),
        request.model_id.as_deref(),
        |current, manifest| {
            if current != root {
                return Err("active vault changed".into());
            }
            Ok(manifest)
        },
    )?;
    crate::local_query_plan::validate_request(&request, clock() as i64)?;
    let flag = registry()
        .lock()
        .map_err(|_| "local synthesis state poisoned")?
        .begin(&request.request_id)?;
    let run = Run(request.request_id.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let _run = run;
        let root = root
            .canonicalize()
            .map_err(|_| "recall planning vault unavailable")?;
        let expected = Path::new(&request.expected_vault)
            .canonicalize()
            .map_err(|_| "recall planning vault unavailable")?;
        let vault = app.state::<crate::commands::VaultRoot>();
        let origin_matches = || {
            with_ask_role(
                &vault,
                &request.origin,
                request.role_snapshot.as_ref(),
                request.model_id.as_deref(),
                |current, _| Ok(current == root),
            )
            .unwrap_or(false)
        };
        if root != expected || !origin_matches() {
            return Err("active vault changed".into());
        }
        let include_archived = crate::settings::search_archived_sessions();
        let catalog = crate::local_query_plan::checked_catalog(
            &vault,
            &root,
            &index,
            &request,
            &flag,
            include_archived,
        )?;
        let (system, user) = crate::local_query_plan::prepare(&request, &catalog)?;
        if !origin_matches() {
            return Err("Ask opening or execution authority changed".into());
        }
        let output = with_model(&state, &flag, manifest, |model| {
            if !origin_matches() {
                return Err("active vault changed".into());
            }
            if model.chat_token_count(system, &user)? > 2048 - 64 - 8 {
                return Err("recall planning prompt exceeds the context".into());
            }
            #[cfg(feature = "native-index-probe")]
            crate::native_ask_probe::generation_started(&app);
            #[cfg(feature = "native-index-probe")]
            let (result, telemetry) = if activity_sampler_qa::gemma12b_ordinal_profile(
                manifest.id,
                crate::native_ask_probe::ordinal_activity_enabled(&app),
                crate::local_llm::GenerationSchema::AskAnswerV1,
            ) {
                let attempt = model.generate_gemma12b_ordinal_cancellable_measured_qa(
                    system,
                    &user,
                    64,
                    2048,
                    crate::local_llm::GenerationSchema::AskAnswerV1,
                    &flag,
                );
                let telemetry = attempt.telemetry().clone();
                (attempt.into_result(), Some(telemetry))
            } else {
                (
                    model.generate_bounded_cancellable(system, &user, 64, &flag),
                    None,
                )
            };
            #[cfg(not(feature = "native-index-probe"))]
            let result = model.generate_bounded_cancellable(system, &user, 64, &flag);
            #[cfg(feature = "native-index-probe")]
            let _ = crate::native_ask_probe::observe_generation(
                &app,
                &request.request_id,
                system,
                &user,
                &result,
                telemetry.as_ref(),
            );
            result
        })?;
        if flag.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        if !origin_matches() {
            return Err("active vault changed".into());
        }
        if crate::local_query_plan::checked_catalog(
            &vault,
            &root,
            &index,
            &request,
            &flag,
            include_archived,
        )? != catalog
        {
            return Err("recall planning records changed during generation".into());
        }
        crate::local_query_plan::validate(&output, &request.today, manifest.id)
    })
    .await
    .map_err(|error| format!("local recall planning task: {error}"))?
}

fn deadline(
    flag: Arc<AtomicBool>,
    expired: Arc<AtomicBool>,
    timeout_seconds: u64,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(timeout_seconds)).await;
        expired.store(true, Ordering::Relaxed);
        flag.store(true, Ordering::Relaxed);
    })
}

pub async fn synthesize(
    app: tauri::AppHandle,
    state: LocalChatState,
    root: PathBuf,
    index: Arc<Bm25Index>,
    request: Request,
) -> Result<Answer, String> {
    let manifest = with_request_role(&app, &request, |current, manifest| {
        if current != root {
            return Err("active vault changed".into());
        }
        Ok(manifest)
    })?;
    let flag = registry()
        .lock()
        .map_err(|_| "local synthesis state poisoned")?
        .begin(&request.request_id)?;
    let run = Run(request.request_id.clone());
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _run = run;
        let root = root
            .canonicalize()
            .map_err(|_| "synthesis vault unavailable")?;
        let expected = Path::new(&request.expected_vault)
            .canonicalize()
            .map_err(|_| "synthesis vault unavailable")?;
        if root != expected || !request_still_open(&app, &root, &request) {
            return Err("active vault changed".into());
        }
        if flag.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let checked = match checked_request_evidence(&app, &root, &index, &request) {
            Ok(checked) => checked,
            Err(detail) => {
                if !request_still_open(&app, &root, &request) {
                    return Err("Ask opening or execution authority changed".into());
                }
                let mut answer = Answer::fallback("source_verification_failed", manifest.id);
                answer.activity_failure = Some(ActivityFlowFailure {
                    code: "source_verification_failed",
                    detail,
                });
                return Ok(answer);
            }
        };
        if !request_still_open(&app, &root, &request) {
            return Err("Ask opening or execution authority changed".into());
        }
        let generated = with_model(&state, &flag, manifest, |model| {
            if !request_still_open(&app, &root, &request) {
                return Err("active vault changed".into());
            }
            if request.activity_overview {
                let originals = checked
                    .originals
                    .as_ref()
                    .ok_or("original activity bindings unavailable")?;
                let later_revisions = std::cell::RefCell::new(None);
                let origin = request
                    .origin
                    .as_ref()
                    .ok_or("activity opening origin unavailable")?;
                #[cfg(feature = "native-index-probe")]
                let source_focus_qa = crate::native_ask_probe::source_focus_claims_enabled(&app);
                #[cfg(feature = "native-index-probe")]
                let review_correction_qa = crate::native_ask_probe::reviewed_activity_correction_enabled(&app);
                #[cfg(feature = "native-index-probe")]
                let named_source_focus_qa = crate::native_ask_probe::named_source_focus_claims_enabled(&app);
                #[cfg(feature = "native-index-probe")]
                let ordinal_activity_qa = crate::native_ask_probe::ordinal_activity_enabled(&app);
                #[cfg(not(feature = "native-index-probe"))]
                let source_focus_qa = false;
                #[cfg(feature = "native-index-probe")]
                crate::native_ask_probe::observe_activity_backing(&app, &request.request_id, originals);
                #[cfg(feature = "native-index-probe")]
                let observe_focus_input = |phase, system: &str, user: &str, counted: &Result<usize, String>, budget| {
                    crate::native_ask_probe::observe_focus_tokens(
                        &app, &request.request_id, phase, system, user, counted, budget,
                    );
                };
                #[cfg(feature = "native-index-probe")]
                let focus_observer = source_focus_qa.then_some(
                    &observe_focus_input as &activity_flow::FocusTokenObserverQa<'_>,
                );
                #[cfg(feature = "native-index-probe")]
                use activity_flow::activity_synthesis_steps_with_resolution_mode_observed as synthesis_mode;
                #[cfg(not(feature = "native-index-probe"))]
                use activity_flow::activity_synthesis_steps_with_resolution_mode as synthesis_mode;
                Ok(synthesis_mode(
                    &request,
                    &checked.evidence,
                    originals,
                    origin,
                    |system, user| {
                        #[cfg(feature = "native-index-probe")]
                        if review_correction_qa {
                            // The exact corrective count uses the same fresh source/role/Stop
                            // boundary as generation. Existing modes retain their callback.
                            return stage_guard::run(
                                &flag,
                                || recheck_stage_evidence(&app, &root, &index, &request,
                                    &checked.revisions, later_revisions.borrow().as_ref(), &flag),
                                || {
                                    let counted = model.chat_token_count(system, user);
                                    crate::native_ask_probe::observe_focus_review_tokens(
                                        &app, &request.request_id, system, user, &counted,
                                    );
                                    crate::native_ask_probe::observe_focus_initial_correction_tokens(
                                        &app, &request.request_id, system, user, &counted,
                                        crate::native_ask_probe::FocusTokenBudgetQa {
                                            context_tokens: 4096, output_tokens: 768, reserve: 8,
                                        },
                                    );
                                    counted
                                },
                            );
                        }
                        #[cfg(feature = "native-index-probe")]
                        if let Some(packet) = crate::native_ask_probe::compact_extraction_packet(&app, system, user)? {
                            return model.chat_token_count(packet.system(), packet.user());
                        }
                        let counted = model.chat_token_count(system, user);
                        #[cfg(feature = "native-index-probe")]
                        crate::native_ask_probe::observe_focus_review_tokens(
                            &app, &request.request_id, system, user, &counted,
                        );
                        counted
                    },
                    |system, user, output, context, schema| {
                        stage_guard::run(
                            &flag,
                            || {
                                recheck_stage_evidence(
                                    &app,
                                    &root,
                                    &index,
                                    &request,
                                    &checked.revisions,
                                    later_revisions.borrow().as_ref(),
                                    &flag,
                                )
                            },
                            || {
                                #[cfg(feature = "native-index-probe")]
                                {
                                    let compact = if schema == crate::local_llm::GenerationSchema::WikiClaimsV1
                                    {
                                        crate::native_ask_probe::compact_extraction_packet(&app, system, user)?
                                    } else {
                                        None
                                    };
                                    let (system, user, schema) = compact.as_ref().map_or(
                                        (system, user, schema),
                                        |packet| (packet.system(), packet.user(), crate::local_llm::GenerationSchema::WikiClaimsCompactQaV1(packet.decoder())),
                                    );
                                    crate::native_ask_probe::generation_started(&app);
                                    let attempt = if activity_sampler_qa::gemma12b_ordinal_profile(
                                        manifest.id, ordinal_activity_qa, schema,
                                    ) {
                                        model.generate_gemma12b_ordinal_cancellable_measured_qa(
                                            system, user, output, context, schema, &flag,
                                        )
                                    } else {
                                        match activity_sampler_qa::gemma_activity_decoder(
                                            manifest.id, ordinal_activity_qa, schema,
                                        ) {
                                            Some(decoder) => model.generate_gemma_activity_types_cancellable_measured_qa(
                                                system, user, output, context, decoder, &flag,
                                            ),
                                            None => model.generate_structured_cancellable_measured(
                                                system, user, output, context, schema, &flag,
                                            ),
                                        }
                                    };
                                    let telemetry = attempt.telemetry().clone();
                                    let result = attempt.into_result();
                                    let generation_ordinal = crate::native_ask_probe::observe_generation(
                                        &app,
                                        &request.request_id,
                                        system,
                                        user,
                                        &result,
                                        Some(&telemetry),
                                    );
                                    match compact {
                                        Some(packet) => {
                                            let result = result.and_then(|raw| packet.expand(&raw));
                                            crate::native_ask_probe::observe_compact_expansion(
                                                &app, &request.request_id, &packet.decoder().packet_sha256(), generation_ordinal, &result,
                                            );
                                            result
                                        }
                                        None => result,
                                    }
                                }
                                #[cfg(not(feature = "native-index-probe"))]
                                model.generate_structured_cancellable(
                                    system, user, output, context, schema, &flag,
                                )
                            },
                        )
                    },
                    |initial, keys| {
                        let sources = activity_resolution::read(
                            &app, &root, &index, &request, initial, keys, &flag,
                        )?;
                        *later_revisions.borrow_mut() = Some(sources.revisions.clone());
                        Ok(sources)
                    },
                    |sources| activity_resolution::recheck(&app, &root, &request, sources, &flag),
                    source_focus_qa,
                    #[cfg(feature = "native-index-probe")]
                    named_source_focus_qa,
                    #[cfg(feature = "native-index-probe")]
                    ordinal_activity_qa,
                    #[cfg(feature = "native-index-probe")]
                    review_correction_qa,
                    #[cfg(feature = "native-index-probe")]
                    focus_observer,
                )
                .map(|mut generated| {
                    generated.receipt.original_inputs_incomplete |=
                        checked.original_inputs_incomplete;
                    Answer {
                        answer: generated.answer,
                        used_sources: generated.used_sources,
                        selected_chunks: Some(generated.selected_chunks),
                        model_id: manifest.id,
                        fallback_reason: None,
                        activity_receipt: Some(generated.receipt),
                        activity_failure: None,
                        answer_receipt: None,
                    }
                }))
            } else {
                let originals = checked
                    .originals
                    .as_ref()
                    .ok_or("ordinary originals unavailable")?;
                let origin = request
                    .origin
                    .as_ref()
                    .ok_or("ordinary opening origin unavailable")?;
                Ok(ordinary_synthesis_steps(
                    &request,
                    &checked.evidence,
                    originals,
                    origin,
                    |system, user| model.chat_token_count(system, user),
                    |system, user, max_tokens, context, schema| {
                        stage_guard::run(
                            &flag,
                            || {
                                recheck_stage_evidence(
                                    &app,
                                    &root,
                                    &index,
                                    &request,
                                    &checked.revisions,
                                    None,
                                    &flag,
                                )
                            },
                            || {
                                model.generate_structured_cancellable(
                                    system, user, max_tokens, context, schema, &flag,
                                )
                            },
                        )
                    },
                )
                .map(|generated| Answer {
                    answer: generated.answer,
                    used_sources: generated.used_sources,
                    selected_chunks: Some(generated.selected_chunks),
                    model_id: manifest.id,
                    fallback_reason: None,
                    activity_receipt: None,
                    activity_failure: None,
                    answer_receipt: Some(generated.receipt),
                }))
            }
        })
        .unwrap_or_else(|detail| {
            Err(ActivityFlowFailure {
                code: "model_unavailable",
                detail,
            })
        });
        // Recheck even when inference, loading, cancellation or output validation failed.
        let changed = match checked_request_evidence(&app, &root, &index, &request) {
            Ok(current) if current.revisions == checked.revisions => None,
            Ok(_) => Some("frozen original source revisions changed".to_string()),
            Err(detail) => Some(detail),
        };
        if !request_still_open(&app, &root, &request) {
            return Err("Ask opening or execution authority changed".into());
        }
        if let Some(detail) = changed {
            let mut answer = Answer::fallback("source_changed_during_generation", manifest.id);
            answer.activity_failure = Some(ActivityFlowFailure {
                code: "source_changed_during_generation",
                detail,
            });
            return Ok(answer);
        }
        if flag.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        match generated {
            Ok(answer) => Ok(answer),
            Err(failure) => {
                eprintln!(
                    "[local_generation] answer unavailable or rejected for {} ({})",
                    manifest.id, failure.code
                );
                let mut answer = Answer::fallback(failure.code, manifest.id);
                answer.activity_failure = Some(failure);
                Ok(answer)
            }
        }
    })
    .await;
    result.map_err(|error| format!("local synthesis task: {error}"))?
}

/// Text-only local previews use the exact selected manifest, with no wallclock cutoff.
#[allow(clippy::too_many_arguments)] // Flat native adapter mirrors the bounded request contract.
pub async fn generate_text(
    _app: tauri::AppHandle,
    state: LocalChatState,
    model_id: &str,
    request_id: &str,
    system: &str,
    user: &str,
    max_tokens: i32,
) -> Result<String, String> {
    let manifest = local_model::manifest_for(Some(model_id))?;
    if !(1..=768).contains(&max_tokens)
        || system.len() + user.len() > 65536
        || user.trim().is_empty()
    {
        return Err("invalid local text preview budget".into());
    }
    let flag = registry()
        .lock()
        .map_err(|_| "local synthesis state poisoned")?
        .begin(request_id)?;
    let run = Run(request_id.to_owned());
    let system = system.to_owned();
    let user = user.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let _run = run;
        with_model(&state, &flag, manifest, |model| {
            model.generate_text_cancellable(&system, &user, max_tokens, &flag)
        })
    })
    .await
    .map_err(|error| format!("local text preview task failed: {error}"))?
}

/// Preview original source chunks without requiring them to be indexed already.
pub async fn transform(
    app: tauri::AppHandle,
    state: LocalChatState,
    root: PathBuf,
    request: crate::local_transform::Request,
) -> Result<Answer, String> {
    let manifest = local_model::manifest_for(request.model_id.as_deref())?;
    let flag = registry()
        .lock()
        .map_err(|_| "local synthesis state poisoned")?
        .begin(&request.request_id)?;
    let run = Run(request.request_id.clone());
    let expired = Arc::new(AtomicBool::new(false));
    let timer = deadline(flag.clone(), expired.clone(), 45);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _run = run;
        let root = root
            .canonicalize()
            .map_err(|_| "preview vault unavailable")?;
        let expected = Path::new(&request.expected_vault)
            .canonicalize()
            .map_err(|_| "preview vault unavailable")?;
        if root != expected || !still_open(&app, &root) {
            return Err("active vault changed".into());
        }
        if flag.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let checked = match crate::local_transform::checked_sources(&root, &request.sources) {
            Ok(checked) => checked,
            Err(_) => return Ok(Answer::fallback("source_verification_failed", manifest.id)),
        };
        let generated = with_model(&state, &flag, manifest, |model| {
            if !still_open(&app, &root) {
                return Err("active vault changed".into());
            }
            let prompt = crate::local_transform::prepare(
                request.kind,
                &request.lang,
                &checked.evidence,
                |system, user| {
                    model
                        .chat_token_count(system, user)
                        .map(|count| count <= 2048 - 192 - 8)
                },
            )?;
            let output =
                model.generate_bounded_cancellable(&prompt.system, &prompt.user, 192, &flag)?;
            local_synthesis::validate_answer(&output, &prompt, &request.lang)
                .map(|(answer, sources)| (answer, sources, prompt.evidence.len()))
        });
        if !matches!(crate::local_transform::checked_sources(&root, &request.sources),
            Ok(current) if current.revisions == checked.revisions)
        {
            return Ok(Answer::fallback(
                "source_changed_during_generation",
                manifest.id,
            ));
        }
        if !still_open(&app, &root) {
            return Err("active vault changed".into());
        }
        if expired.load(Ordering::Relaxed) {
            return Ok(Answer::fallback("time_budget", manifest.id));
        }
        if flag.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        match generated {
            Ok((answer, used_sources, selected_chunks)) => Ok(Answer {
                answer,
                used_sources,
                selected_chunks: Some(selected_chunks),
                model_id: manifest.id,
                fallback_reason: None,
                activity_receipt: None,
                activity_failure: None,
                answer_receipt: None,
            }),
            Err(_) => {
                eprintln!(
                    "[local_generation] preview unavailable or rejected for {}",
                    manifest.id
                );
                Ok(Answer::fallback(
                    "generation_unavailable_or_rejected",
                    manifest.id,
                ))
            }
        }
    })
    .await;
    timer.abort();
    result.map_err(|error| format!("local preview task: {error}"))?
}

#[cfg(test)]
#[path = "local_generation_probe.rs"]
mod private_probe;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn early_cancel_reaches_only_its_own_later_request() {
        let mut registry = Registry::default();
        assert!(!registry.cancel("stopped-first"));
        assert!(registry
            .begin("stopped-first")
            .unwrap()
            .load(Ordering::Relaxed));
        assert!(!registry.begin("other-run").unwrap().load(Ordering::Relaxed));
        assert!(registry.cancel("other-run"));
        assert!(registry.running["other-run"].load(Ordering::Relaxed));
    }
    #[test]
    fn registry_bounds_pending_cancellation_and_rejects_duplicate_runs() {
        let mut registry = Registry::default();
        for index in 0..100 {
            registry.cancel(&format!("early-{index}"));
        }
        assert_eq!(registry.cancelled_early.len(), 16);
        assert!(registry.begin("first").is_ok());
        assert!(registry.begin("first").is_err());
        assert!(registry.begin("invalid id").is_err());
        for id in ["second", "third", "fourth"] {
            registry.begin(id).unwrap();
        }
        assert!(registry.begin("fifth").is_err());
    }

    fn source_fixture() -> (tempfile::TempDir, Bm25Index, Request) {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("wiki")).unwrap();
        let content = "# Synthetic source\n\nSYNTHETIC_ONLY_FACT original evidence.";
        std::fs::write(dir.path().join("wiki/a.md"), content).unwrap();
        let chunks = crate::embeddings::chunk_page(content);
        let mut index = Bm25Index::new();
        index.upsert_page("wiki/a.md", "a", &chunks);
        let request = Request {
            model_id: None,
            request_id: "synthetic-run".into(),
            question: "합성 자료를 정리해줘".into(),
            previous_question: None,
            role_snapshot: None,
            lang: "ko".into(),
            hits: vec![Evidence {
                title: None,
                compiled: None,
                page: "wiki/a.md".into(),
                stem: "Synthetic source".into(),
                section: 0,
                text: chunks[0].clone(),
            }],
            expected_vault: dir.path().to_string_lossy().into_owned(),
            origin: Some(crate::vault_session::AgentVaultSession {
                vault_path: dir
                    .path()
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned(),
                opening_token: "7".into(),
            }),
            scope: Scope::Wiki,
            range: None,
            paths: None,
            max_tokens: Some(256),
            activity_overview: false,
            resolution: None,
        };
        (dir, index, request)
    }

    #[test]
    fn synthesis_project_title_comes_from_the_current_page_not_the_request() {
        let (dir, mut index, mut request) = source_fixture();
        request.hits[0].title = Some("Injected unrelated project".into());
        let path = dir.path().join("wiki/a.md");
        let body = std::fs::read_to_string(&path).unwrap();
        let content = format!("---\ntitle: Synthetic reader\n---\n\n{body}");
        std::fs::write(&path, &content).unwrap();
        index.upsert_page("wiki/a.md", "a", &crate::embeddings::chunk_page(&content));
        let checked = checked_evidence(dir.path(), &index, &request).unwrap();
        assert_eq!(
            checked.evidence[0].title.as_deref(),
            Some("Synthetic reader")
        );
        assert_eq!(checked.evidence[0].text, request.hits[0].text);
    }

    pub(super) fn compiled_activity_fixture() -> (
        crate::activity_recall::compiled_source_tests::Fixture,
        Bm25Index,
        Request,
    ) {
        let source = crate::activity_recall::compiled_source_tests::fixture();
        let chunks = crate::embeddings::chunk_page(&source.summary);
        let mut index = Bm25Index::new();
        index.upsert_page(&source.page, "Synthetic compiled source", &chunks);
        let origin = crate::vault_session::AgentVaultSession {
            vault_path: source.root.to_string_lossy().into_owned(),
            opening_token: "synthetic-opening".into(),
        };
        let request = Request {
            model_id: None,
            role_snapshot: None,
            request_id: "synthetic-compiled-host".into(),
            question: "Summarize synthetic work".into(),
            previous_question: None,
            lang: "en".into(),
            hits: chunks
                .iter()
                .enumerate()
                .filter(|(_, text)| text.contains("myco:claim-metadata"))
                .map(|(section, text)| Evidence {
                    page: source.page.clone(),
                    stem: "Synthetic compiled source".into(),
                    section,
                    text: text.clone(),
                    title: None,
                    compiled: None,
                })
                .collect(),
            expected_vault: origin.vault_path.clone(),
            origin: Some(origin),
            scope: Scope::Wiki,
            range: Some(crate::commands::DateRange {
                start: "2026-10-03".into(),
                end: "2026-10-03".into(),
                start_epoch: None,
                end_epoch: None,
            }),
            paths: None,
            max_tokens: Some(768),
            activity_overview: true,
            resolution: None,
        };
        (source, index, request)
    }

    #[test]
    fn compiled_activity_host_binds_raw_roles_dates_and_native_lineage_guards() {
        let (source, index, request) = compiled_activity_fixture();
        let checked = checked_evidence(&source.root, &index, &request).unwrap();
        let originals = checked.originals.as_ref().unwrap();
        let spans: Vec<_> = originals
            .spans()
            .filter(|span| span.speaker() != crate::wiki_claims::ActorRole::Unknown)
            .collect();
        assert_eq!(spans.len(), 3);
        assert_eq!(originals.spans().count(), 4);
        assert!(originals.spans().any(|span| {
            span.speaker() == crate::wiki_claims::ActorRole::Unknown
                && span.turn_time().is_none()
                && span.text().contains("Synthetic imported transcript")
        }));
        assert_eq!(
            spans
                .iter()
                .filter(|span| span.speaker() == crate::wiki_claims::ActorRole::User)
                .count(),
            2
        );
        assert!(spans.iter().all(|span| span
            .turn_time()
            .is_some_and(|time| time.starts_with("2026-10-03"))));
        assert!(spans
            .iter()
            .all(|span| span.selection_path() == source.page
                && span.source_path() == source.raw_path));
        assert!(!spans.iter().any(|span| span
            .text()
            .contains("independently verified completed work")));
        assert!(checked.revisions.contains_key(&source.page));
        assert!(checked.revisions.contains_key(&source.raw_path));
        assert!(checked.revisions.len() >= 4);
        assert!(!checked.original_inputs_incomplete);
    }

    #[test]
    fn compiled_activity_host_rejects_generated_event_date_outside_original_period() {
        let (source, index, mut request) = compiled_activity_fixture();
        request.range.as_mut().unwrap().start = "2026-10-07".into();
        request.range.as_mut().unwrap().end = "2026-10-07".into();
        assert_eq!(
            checked_evidence(&source.root, &index, &request).unwrap_err(),
            "synthesis source is outside the requested period"
        );
    }

    #[test]
    fn compiled_activity_host_rechecks_projection_changes_after_failed_generation() {
        let (source, index, request) = compiled_activity_fixture();
        let before = checked_evidence(&source.root, &index, &request).unwrap();
        let projection = source
            .root
            .join("sessions/2026-10/codex-synthetic-compiled-reader.md");
        let result: Result<(), _> = stage_guard::run(
            &AtomicBool::new(false),
            || {
                let current = checked_evidence(&source.root, &index, &request)?;
                if current.revisions != before.revisions {
                    Err("bound projection changed".into())
                } else {
                    Ok(())
                }
            },
            || {
                let text = std::fs::read_to_string(&projection).unwrap();
                std::fs::write(
                    &projection,
                    text.replace("Human annotation retained.", "Human annotation updated."),
                )
                .unwrap();
                Err("synthetic inference failed".into())
            },
        );
        assert_eq!(result.unwrap_err(), "bound projection changed");
        assert!(std::fs::read_to_string(&projection)
            .unwrap()
            .contains("Human annotation updated."));
        assert_eq!(
            std::fs::read_to_string(source.root.join(&source.raw_path)).unwrap(),
            source.original
        );
    }

    #[test]
    fn ordinary_ask_business_binds_originals_without_inventing_a_period() {
        let (dir, index, request) = source_fixture();
        assert!(!request.activity_overview && request.range.is_none());
        let checked = checked_evidence(dir.path(), &index, &request).unwrap();
        let originals = checked.originals.as_ref().expect(
            "ordinary generation must capture current original evidence, including undated notes",
        );
        assert!(originals
            .spans()
            .any(|span| span.text().contains("SYNTHETIC_ONLY_FACT")));
        assert!(originals.spans().all(|span| span.turn_time().is_none()));
    }

    #[test]
    fn ordinary_ask_business_rejects_missing_compiled_original_despite_unchanged_wiki() {
        let (source, index, mut request) = compiled_activity_fixture();
        request.activity_overview = false;
        request.range = None;
        std::fs::remove_file(source.root.join(&source.raw_path)).unwrap();
        assert!(
            checked_evidence(&source.root, &index, &request).is_err(),
            "an unchanged generated page cannot replace its unavailable original",
        );
    }

    #[test]
    fn ordinary_ask_business_reviews_before_rendering_a_generated_answer() {
        let (dir, index, mut request) = source_fixture();
        let origin = request.origin.clone().unwrap();
        // DTO shape only; this fixture never issues a native execution grant.
        request.role_snapshot = Some(serde_json::from_value(serde_json::json!({
            "snapshotId":"synthetic-ordinary-role", "origin":origin,
            "role":"ask", "usage":"foreground", "authorizationRevision":"synthetic-revision",
            "routeSignature":{"role":"ask", "providerId":"builtin-local", "modelId":local_model::MODEL.id,
            "effort":"(default)", "executionLocation":"in-process", "artifactRevision":null,
            "artifactSha256":null, "runtimeContract":"synthetic-only", "signature":"synthetic-signature"}
        })).unwrap());
        let checked = checked_evidence(dir.path(), &index, &request).unwrap();
        let calls = std::cell::Cell::new(0);
        let result = ordinary_synthesis_steps(
            &request,
            &checked.evidence,
            checked.originals.as_ref().unwrap(),
            &origin,
            |_, _| Ok(100),
            |_, user, _, _, schema| {
                calls.set(calls.get() + 1);
                if schema == crate::local_llm::GenerationSchema::AskAnswerV1 {
                    assert!(user.contains("SYNTHETIC_ONLY_FACT"));
                    Ok(
                        r#"{"answer":"합성 원문에 사실이 기록되어 있습니다.","sources":["S1"]}"#
                            .into(),
                    )
                } else {
                    assert_eq!(
                        schema,
                        crate::local_llm::GenerationSchema::AskAnswerReviewV1
                    );
                    let payload: serde_json::Value = serde_json::from_str(user).unwrap();
                    assert!(payload["context"]["requestedPeriod"].is_null());
                    assert!(payload["originalSpans"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|span| span["text"]
                            .as_str()
                            .unwrap()
                            .contains("SYNTHETIC_ONLY_FACT")));
                    Ok(r#"{"version":"AskAnswerReviewV1","answerDisposition":"supported","taskResponse":"adequate","sourceCoverage":"covered","missingSpanIds":[],"reason":"Synthetic plumbing verdict, not semantic acceptance."}"#.into())
                }
            },
        );
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(calls.get(), 2, "generation alone cannot authorize rendering; a separate original-source review must run");
    }

    #[test]
    fn ordinary_ask_closure_retains_unselected_late_retraction_in_an_original_session() {
        let (dir, mut index, mut request) = source_fixture();
        let source = "**User:**\n\nPlease publish the synthetic export.\n\n**Assistant:**\n\nI plan to publish it.\n\n**User:**\n\nCancel that export; it must not be published.\n";
        std::fs::write(dir.path().join("wiki/a.md"), source).unwrap();
        let chunks = crate::embeddings::chunk_page(source);
        index.upsert_page("wiki/a.md", "a", &chunks);
        request.hits[0].text = chunks[0].clone();
        let checked = checked_evidence(dir.path(), &index, &request).unwrap();
        let originals = checked.originals.unwrap();
        assert_eq!(originals.spans().count(), 3);
        assert!(originals
            .spans()
            .any(|span| span.text().contains("Cancel that export")
                && span.speaker() == crate::wiki_claims::ActorRole::User));
        assert!(request.range.is_none());
    }

    #[test]
    fn ordinary_ask_compiled_closure_ignores_generated_hint_subset_as_a_coverage_receipt() {
        let (mut source, mut index, mut request) = compiled_activity_fixture();
        let prefix = "<!-- myco:claim-metadata ";
        let start = source.summary.find(prefix).unwrap() + prefix.len();
        let end = start + source.summary[start..].find(" -->").unwrap();
        let mut hint: serde_json::Value =
            serde_json::from_str(&source.summary[start..end]).unwrap();
        hint["sourceSpans"].as_array_mut().unwrap().truncate(1);
        source.summary.replace_range(start..end, &hint.to_string());
        std::fs::write(source.root.join(&source.page), &source.summary).unwrap();
        let chunks = crate::embeddings::chunk_page(&source.summary);
        index.upsert_page(&source.page, "Synthetic compiled source", &chunks);
        request.activity_overview = false;
        request.range = None;
        request.hits.truncate(1);
        let selected = chunks
            .iter()
            .position(|chunk| chunk.contains("myco:claim-metadata"))
            .unwrap();
        request.hits[0].section = selected;
        request.hits[0].text = chunks[selected].clone();
        let checked = checked_evidence(&source.root, &index, &request).unwrap();
        let originals = checked.originals.unwrap();
        assert_eq!(
            originals
                .spans()
                .filter(|span| span.source_path() == source.raw_path
                    && span.speaker() != crate::wiki_claims::ActorRole::Unknown)
                .count(),
            3,
            "one generated coordinate cannot hide another original transcript turn"
        );
        assert!(
            originals.spans().all(|span| !span
                .text()
                .contains("independently verified completed work")),
            "generated block prose never becomes original evidence"
        );
        assert_eq!(
            std::fs::read_to_string(source.root.join(&source.raw_path)).unwrap(),
            source.original
        );
    }

    #[test]
    fn ordinary_ask_closure_business_keeps_human_retraction_outside_a_generated_block() {
        let (source, mut index, mut request) = compiled_activity_fixture();
        let summary = format!(
            "{}\n\n## Human annotation\n\nCancel synthetic_export_widget; do not publish.\n",
            source.summary
        );
        std::fs::write(source.root.join(&source.page), &summary).unwrap();
        let chunks = crate::embeddings::chunk_page(&summary);
        index.upsert_page(&source.page, "Synthetic compiled source", &chunks);
        request.activity_overview = false;
        request.range = None;
        request.hits.truncate(1);
        let selected = chunks
            .iter()
            .position(|chunk| chunk.contains("myco:claim-metadata"))
            .unwrap();
        request.hits[0].section = selected;
        request.hits[0].text = chunks[selected].clone();
        let checked = checked_evidence(&source.root, &index, &request).unwrap();
        assert!(checked.originals.unwrap().spans().any(|span| span.text().contains("Cancel synthetic_export_widget") && span.speaker() == crate::wiki_claims::ActorRole::Unknown), "the selected page's human text must reach draft and review without inventing its author");
    }

    #[test]
    fn ordinary_ask_closure_business_does_not_certify_a_partial_source_copy() {
        let (dir, mut index, mut request) = curated_activity_fixture();
        let raw = dir.path().join("raw/synthetic.md");
        let old = std::fs::read_to_string(&raw).unwrap();
        let source = old.replacen(
            "---\n",
            "---\noriginal_source: 'raw/complete-synthetic.md'\n",
            1,
        );
        let wiki = dir.path().join("wiki/a.md");
        let mut content = std::fs::read_to_string(&wiki).unwrap();
        let prefix = "<!-- myco:codex-session-proof ";
        let start = content.find(prefix).unwrap() + prefix.len();
        let end = start + content[start..].find(" -->").unwrap();
        let mut proof: serde_json::Value = serde_json::from_str(&content[start..end]).unwrap();
        let quote = &old[proof["quotes"][0]["start"].as_u64().unwrap() as usize
            ..proof["quotes"][0]["end"].as_u64().unwrap() as usize];
        let at = source.find(quote).unwrap();
        proof["quotes"][0]["start"] = serde_json::json!(at);
        proof["quotes"][0]["end"] = serde_json::json!(at + quote.len());
        proof["quotes"][0]["source_sha256"] =
            serde_json::json!(format!("{:x}", Sha256::digest(source.as_bytes())));
        content.replace_range(start..end, &proof.to_string());
        std::fs::write(raw, source).unwrap();
        std::fs::write(wiki, &content).unwrap();
        let chunks = crate::embeddings::chunk_page(&content);
        index.upsert_page("wiki/a.md", "a", &chunks);
        request.activity_overview = false;
        request.range = None;
        request.hits[0].section = chunks
            .iter()
            .position(|chunk| chunk.contains(quote))
            .unwrap();
        request.hits[0].text = chunks[request.hits[0].section].clone();
        assert!(checked_evidence(dir.path(), &index, &request).is_err(), "a copy with canonical originals unavailable cannot certify full contrary-state coverage");
    }

    fn curated_activity_fixture() -> (tempfile::TempDir, Bm25Index, Request) {
        let (dir, mut index, mut request) = source_fixture();
        std::fs::create_dir(dir.path().join("raw")).unwrap();
        let quote =
            "Reported completing synthetic duplicate-result repair with twelve passing checks.";
        let source = format!("---\nturn_metadata: [{{\"timestamp\":\"2026-10-03T12:00:00Z\",\"original_role\":\"assistant\"}}]\n---\n\n**Assistant:**\n\n{quote}\n");
        std::fs::write(dir.path().join("raw/synthetic.md"), &source).unwrap();
        let start = source.find(quote).unwrap();
        let proof = serde_json::json!({"version":1,"kind":"work","session_key":"codex:synthetic","records":["synthetic-record"],"quotes":[{
            "id":"q-synthetic","event":"E-synthetic","source":"raw/synthetic.md",
            "source_sha256":format!("{:x}",Sha256::digest(source.as_bytes())),"start":start,"end":start+quote.len(),
            "quote_sha256":format!("{:x}",Sha256::digest(quote.as_bytes())),"role":"Assistant","date":"2026-10-03T12:00:00Z","purpose":"work"
        }]});
        let content = format!("---\ntype: source-summary\nsession_kind: work\nsession_activity_days: [2026-10-03]\nsession_record_start: 2026-10-03\nsession_record_end: 2026-10-03\n---\n\n# Synthetic curated work\n\n<!-- myco:codex-session-summary:start -->\n\n## Generated overview\nAn unsupported synthetic deployment happened.\n\n#### Original outcome\n<!-- myco:codex-quote {{\"id\":\"q-synthetic\",\"role\":\"Assistant\",\"date\":\"2026-10-03T12:00:00Z\"}} -->\n2026-10-03T12:00:00Z · Assistant\n\n> {quote}\n\n### Verification\n<!-- myco:codex-session-proof {proof} -->\n<!-- myco:codex-session-summary:end -->\n");
        std::fs::write(dir.path().join("wiki/a.md"), &content).unwrap();
        let chunks = crate::embeddings::chunk_page(&content);
        index.upsert_page("wiki/a.md", "a", &chunks);
        let section = chunks.iter().position(|text| text.contains(quote)).unwrap();
        request.hits[0].section = section;
        request.hits[0].text = chunks[section].clone();
        request.activity_overview = true;
        request.range = Some(crate::commands::DateRange {
            start: "2026-10-03".into(),
            end: "2026-10-03".into(),
            start_epoch: None,
            end_epoch: None,
        });
        (dir, index, request)
    }

    #[test]
    fn curated_activity_revalidation_rejects_generated_leads_without_changing_facts() {
        let (dir, index, mut request) = curated_activity_fixture();
        assert!(checked_evidence(dir.path(), &index, &request).is_ok());
        let content = std::fs::read_to_string(dir.path().join("wiki/a.md")).unwrap();
        let chunks = crate::embeddings::chunk_page(&content);
        let section = chunks
            .iter()
            .position(|text| text.contains("unsupported synthetic deployment"))
            .unwrap();
        request.hits[0].section = section;
        request.hits[0].text = chunks[section].clone();
        assert!(
            checked_evidence(dir.path(), &index, &request).is_err(),
            "a current indexed generated overview is not original activity evidence"
        );
        request.activity_overview = false;
        request.range = None;
        assert!(
            checked_evidence(dir.path(), &index, &request).is_ok(),
            "ordinary factual source behavior must stay unchanged"
        );
    }

    #[test]
    fn curated_activity_rechecks_original_bytes_before_and_after_generation() {
        let (dir, index, request) = curated_activity_fixture();
        let first = checked_evidence(dir.path(), &index, &request).unwrap();
        assert_eq!(first.evidence.len(), 1);
        let path = dir.path().join("raw/synthetic.md");
        let source = std::fs::read_to_string(&path).unwrap();
        for changed in [
            format!("{source}\nUnselected original revision changed.\n"),
            source.replace("12:00:00Z", "13:00:00Z"),
            source.replace("**Assistant:**", "**User:**"),
        ] {
            std::fs::write(&path, changed).unwrap();
            assert!(
                checked_evidence(dir.path(), &index, &request).is_err(),
                "unchanged Wiki citations cannot certify a changed raw source"
            );
        }
    }

    #[test]
    fn curated_activity_revalidation_ignores_unselected_proof_sources() {
        let (dir, mut index, request) = curated_activity_fixture();
        let path = dir.path().join("wiki/a.md");
        let mut content = std::fs::read_to_string(&path).unwrap();
        let prefix = "<!-- myco:codex-session-proof ";
        let start = content.find(prefix).unwrap() + prefix.len();
        let end = start + content[start..].find(" -->").unwrap();
        let mut proof: serde_json::Value = serde_json::from_str(&content[start..end]).unwrap();
        let mut unselected = proof["quotes"][0].clone();
        unselected["id"] = serde_json::json!("q-unselected");
        unselected["source"] = serde_json::json!("raw/unavailable-unselected.md");
        proof["quotes"].as_array_mut().unwrap().push(unselected);
        content.replace_range(start..end, &proof.to_string());
        let footer = content.find("### Verification").unwrap();
        content.insert_str(footer,"#### Unselected original report\n<!-- myco:codex-quote {\"id\":\"q-unselected\",\"role\":\"Assistant\",\"date\":\"2026-10-03T12:00:00Z\"} -->\n2026-10-03T12:00:00Z · Assistant\n\n> A separate unselected synthetic report.\n\n");
        std::fs::write(&path, &content).unwrap();
        index.upsert_page("wiki/a.md", "a", &crate::embeddings::chunk_page(&content));
        assert!(checked_evidence(dir.path(), &index, &request).is_ok(), "unselected proof sources must not spend or invalidate the selected-evidence read budget");
    }

    #[test]
    fn synthesis_stage_model_failure_is_static_and_preserves_inner_results() {
        let result = synthesis_model_result(Err("synthetic artifact load failure".into()));
        assert_eq!(result, Err("model_unavailable"));
        let fallback = Answer::fallback(result.unwrap_err(), local_model::MODEL.id);
        assert_eq!(
            fallback.fallback_reason.as_deref(),
            Some("model_unavailable")
        );
        assert!(fallback.answer.is_empty());
        assert!(fallback.used_sources.is_empty());
        assert!(fallback.selected_chunks.is_none());

        for reason in ["prompt_unavailable", "generation_failed", "answer_rejected"] {
            assert_eq!(synthesis_model_result(Ok(Err(reason))), Err(reason));
        }
        let success = ("Synthetic answer".into(), vec!["wiki/a.md".into()], 1);
        assert_eq!(synthesis_model_result(Ok(Ok(success.clone()))), Ok(success));
    }

    #[test]
    fn synthesis_stage_prompt_failure_does_not_invoke_generation() {
        let (dir, index, request) = source_fixture();
        let checked = checked_evidence(dir.path(), &index, &request).unwrap();
        for instructions_fit in [false, true] {
            let result = synthesis_steps(
                &request,
                &checked.evidence,
                |_, user| {
                    let payload: serde_json::Value = serde_json::from_str(user).unwrap();
                    Ok(
                        if instructions_fit && payload["sources"].as_array().unwrap().is_empty() {
                            1848
                        } else {
                            1849
                        },
                    )
                },
                |_, _, _| panic!("a rejected prompt must not reach generation"),
            );
            assert_eq!(result, Err("prompt_unavailable"));
        }
        assert_eq!(
            synthesis_steps(
                &request,
                &checked.evidence,
                |_, _| Err("synthetic tokenizer failure".into()),
                |_, _, _| panic!("token counting failure must not reach generation"),
            ),
            Err("prompt_unavailable")
        );
    }

    #[test]
    fn activity_synthesis_keeps_complete_sources_beyond_the_short_fact_context() {
        let (_, _, mut request) = source_fixture();
        request.max_tokens = Some(192);
        request.activity_overview = true;
        request.range = Some(crate::commands::DateRange {
            start: "2026-10-01".into(),
            end: "2026-10-07".into(),
            start_epoch: None,
            end_epoch: None,
        });
        let token_count = |_: &str, user: &str| {
            let payload: serde_json::Value = serde_json::from_str(user).unwrap();
            Ok(if payload["sources"].as_array().unwrap().is_empty() {
                700
            } else {
                2500
            })
        };
        let result = synthesis_steps(&request, &request.hits, token_count, |_, user, output| {
            assert_eq!(output, 192);
            assert!(user.contains("SYNTHETIC_ONLY_FACT original evidence"));
            Ok(r#"{"answer":"합성 원문에 사실이 기록되어 있습니다.","sources":["S1"]}"#.into())
        });
        assert!(result.is_ok(), "{result:?}");
        request.activity_overview = false;
        assert_eq!(
            synthesis_steps(&request, &request.hits, token_count, |_, _, _| panic!(
                "oversized factual evidence must not reach inference"
            )),
            Err("prompt_unavailable")
        );
    }

    #[test]
    fn synthesis_stage_decode_failure_keeps_the_existing_token_limits() {
        let (dir, index, request) = source_fixture();
        let checked = checked_evidence(dir.path(), &index, &request).unwrap();
        let result = synthesis_steps(
            &request,
            &checked.evidence,
            |_, _| Ok(1848),
            |_, user, max_tokens| {
                assert_eq!(max_tokens, 192);
                let payload: serde_json::Value = serde_json::from_str(user).unwrap();
                assert_eq!(payload["allowed_source_ids"], serde_json::json!(["S1"]));
                Err("synthetic decode failure".into())
            },
        );
        assert_eq!(result, Err("generation_failed"));
    }

    #[test]
    fn synthesis_stage_answer_failure_uses_the_real_validator() {
        let (dir, index, request) = source_fixture();
        let checked = checked_evidence(dir.path(), &index, &request).unwrap();
        for raw in [
            "{}",
            r#"{"answer":"합성 자료의 사실입니다.","sources":["S2"]}"#,
        ] {
            let result = synthesis_steps(
                &request,
                &checked.evidence,
                |_, _| Ok(1848),
                |_, _, _| Ok(raw.into()),
            );
            assert_eq!(result, Err("answer_rejected"));
        }
    }

    #[test]
    fn synthesis_stage_incomplete_json_is_distinct_from_other_rejections() {
        let (dir, index, request) = source_fixture();
        let checked = checked_evidence(dir.path(), &index, &request).unwrap();
        for (raw, expected) in [
            (
                r#"{"answer":"합성 답변","sources":["S1"]"#,
                "answer_incomplete",
            ),
            ("{}", "answer_rejected"),
            (
                r#"{"answer":"합성 답변" "sources":["S1"]}"#,
                "answer_rejected",
            ),
            (
                r#"{"answer":"합성 답변","sources":["S1"],"extra":true}"#,
                "answer_rejected",
            ),
            (r#"{"answer":"","sources":[]}"#, "answer_rejected"),
        ] {
            let result = synthesis_steps(
                &request,
                &checked.evidence,
                |_, _| Ok(1848),
                |_, _, max_tokens| {
                    assert_eq!(max_tokens, 192);
                    Ok(raw.into())
                },
            );
            assert_eq!(result, Err(expected));
        }
    }

    #[test]
    fn synthesis_stage_success_keeps_verified_citations_and_context_budget() {
        let (dir, index, request) = source_fixture();
        let checked = checked_evidence(dir.path(), &index, &request).unwrap();
        let (answer, sources, selected_chunks) = synthesis_steps(
            &request,
            &checked.evidence,
            |_, _| Ok(1848),
            |_, _, max_tokens| {
                assert_eq!(max_tokens, 192);
                Ok(r#"{"answer":"합성 자료의 사실입니다.","sources":["S1"]}"#.into())
            },
        )
        .unwrap();
        assert_eq!(answer, "합성 자료의 사실입니다.\n\n[[wiki/a|a]]");
        assert_eq!(sources, vec!["wiki/a.md"]);
        assert_eq!(selected_chunks, 1);
    }

    #[test]
    fn follow_up_context_deserializes_as_an_optional_camel_case_question() {
        let payload = serde_json::json!({
            "requestId":"synthetic-context", "question":"그건 왜?", "lang":"ko", "hits":[],
            "expectedVault":"/synthetic", "scope":"wiki", "previousQuestion":"합성 주제를 설명해줘",
        });
        let request: Request = serde_json::from_value(payload.clone()).unwrap();
        assert!(!request.activity_overview);
        assert_eq!(
            request.previous_question.as_deref(),
            Some("합성 주제를 설명해줘")
        );
        assert_eq!(request.question, "그건 왜?");
        let mut absent = payload;
        absent.as_object_mut().unwrap().remove("previousQuestion");
        assert!(serde_json::from_value::<Request>(absent)
            .unwrap()
            .previous_question
            .is_none());
    }

    #[test]
    fn follow_up_topic_cannot_change_verified_sources_or_the_requested_period() {
        let (dir, index, mut request) = source_fixture();
        request.previous_question = Some("SYNTHETIC_TOPIC dated 2020-01-01 wiki/outside.md".into());
        let checked = checked_evidence(dir.path(), &index, &request).unwrap();
        assert_eq!(checked.evidence.len(), 1);
        assert_eq!(checked.evidence[0].page, "wiki/a.md");
        assert!(request.range.is_none());
        request.range = Some(crate::commands::DateRange {
            start: "2026-10-04".into(),
            end: "2026-10-04".into(),
            start_epoch: None,
            end_epoch: None,
        });
        assert!(checked_evidence(dir.path(), &index, &request).is_err());
    }

    #[test]
    fn oversized_follow_up_context_is_rejected_before_model_preparation() {
        let (dir, index, mut request) = source_fixture();
        request.previous_question = Some("가".repeat(2001));
        assert!(checked_evidence(dir.path(), &index, &request).is_err());
        request.previous_question = Some("가".repeat(2000));
        assert!(checked_evidence(dir.path(), &index, &request).is_ok());
    }

    #[test]
    fn blank_questions_and_unsupported_languages_cannot_reach_model_preparation() {
        let (dir, index, mut request) = source_fixture();
        for question in ["", " \n\t ", "\u{2003}"] {
            request.question = question.into();
            assert_eq!(
                checked_evidence(dir.path(), &index, &request).unwrap_err(),
                "invalid synthesis evidence budget"
            );
        }
        request.question = "SYNTHETIC valid question".into();
        for lang in ["", "unknown", "en-US", "KO"] {
            request.lang = lang.into();
            assert_eq!(
                checked_evidence(dir.path(), &index, &request).unwrap_err(),
                "invalid synthesis evidence budget"
            );
        }
        for lang in ["en", "ko", "ja"] {
            request.lang = lang.into();
            assert!(checked_evidence(dir.path(), &index, &request).is_ok());
        }
    }

    #[test]
    fn only_current_indexed_source_text_can_reach_the_generator() {
        let (dir, index, mut request) = source_fixture();
        let checked = checked_evidence(dir.path(), &index, &request).unwrap();
        assert_eq!(checked.evidence.len(), 1);
        assert_eq!(checked.evidence[0].stem, "a");
        request.hits[0].text.push_str(" fabricated fact");
        assert!(checked_evidence(dir.path(), &index, &request).is_err());
        request.hits[0].text.pop();
        std::fs::write(
            dir.path().join("wiki/a.md"),
            "# Synthetic changed source\n\nCHANGED_FACT",
        )
        .unwrap();
        assert!(checked_evidence(dir.path(), &index, &request).is_err());
        assert!(checked_evidence(dir.path(), &Bm25Index::new(), &request).is_err());
    }

    #[test]
    fn synthesis_rejects_source_changes_outside_the_selected_chunk() {
        let (dir, mut index, mut request) = source_fixture();
        let original = "# Synthetic source\n\nThe connector was reported completed.\n\n# Latest status\n\nThe connector was rolled back.";
        let chunks = crate::embeddings::chunk_page(original);
        assert_eq!(chunks.len(), 2);
        std::fs::write(dir.path().join("wiki/a.md"), original).unwrap();
        index.upsert_page("wiki/a.md", "a", &chunks);
        request.hits[0].text = chunks[0].clone();
        assert!(checked_evidence(dir.path(), &index, &request).is_ok());

        for changed in [
            original.replace("was rolled back", "is explicitly unfinished"),
            format!("{original}\n\n# New decision\n\nThe connector is disabled."),
            chunks[0].clone(),
        ] {
            assert_eq!(
                crate::embeddings::chunk_page(&changed)[0],
                request.hits[0].text,
                "the selected excerpt must remain unchanged"
            );
            std::fs::write(dir.path().join("wiki/a.md"), changed).unwrap();
            assert!(
                checked_evidence(dir.path(), &index, &request).is_err(),
                "a stale page must not pass because its selected excerpt still matches"
            );
        }
    }

    #[test]
    fn synthesis_snapshots_include_frontmatter_and_unchunked_whitespace() {
        let (dir, index, request) = source_fixture();
        let path = dir.path().join("wiki/a.md");
        let original = std::fs::read_to_string(&path).unwrap();
        let checked = checked_evidence(dir.path(), &index, &request).unwrap();
        let unchanged = checked_evidence(dir.path(), &index, &request).unwrap();
        assert_eq!(checked.revisions, unchanged.revisions);

        for changed in [
            format!("---\ncreated: '2026-10-06'\n---\n\n{original}"),
            format!("{original}\n\n"),
        ] {
            std::fs::write(&path, changed).unwrap();
            let current = checked_evidence(dir.path(), &index, &request).unwrap();
            assert_eq!(current.evidence[0].text, checked.evidence[0].text);
            assert_eq!(current.revisions.len(), 1);
            assert_ne!(
                current.revisions, checked.revisions,
                "source changes removed by chunking must still invalidate generation"
            );
        }
    }

    #[test]
    fn synthesis_rechecks_scope_paths_period_and_path_confinement() {
        let (dir, index, mut request) = source_fixture();
        request.scope = Scope::Sessions;
        assert!(checked_evidence(dir.path(), &index, &request).is_err());
        request.scope = Scope::Wiki;
        request.paths = Some(vec!["wiki/other.md".into()]);
        assert!(checked_evidence(dir.path(), &index, &request).is_err());
        request.paths = Some(vec!["wiki/a.md".into()]);
        assert!(checked_evidence(dir.path(), &index, &request).is_ok());
        request.range = Some(crate::commands::DateRange {
            start: "2026-10-04".into(),
            end: "2026-10-04".into(),
            start_epoch: None,
            end_epoch: None,
        });
        assert!(checked_evidence(dir.path(), &index, &request).is_err());
        request.range = None;
        request.hits[0].page = "../outside.md".into();
        assert!(checked_evidence(dir.path(), &index, &request).is_err());
    }

    #[test]
    fn activity_source_binding_requires_native_origin() {
        let (dir, mut index, mut request) = source_fixture();
        let content = "---\ncreated: '2026-10-06'\n---\n\n# Synthetic source\n\nSYNTHETIC_REPORTED_WORK was completed.";
        std::fs::write(dir.path().join("wiki/a.md"), content).unwrap();
        let chunks = crate::embeddings::chunk_page(content);
        index.upsert_page("wiki/a.md", "a", &chunks);
        request.hits[0].text = chunks[0].clone();
        request.activity_overview = true;
        request.origin = None;
        request.range = Some(crate::commands::DateRange {
            start: "2026-10-06".into(),
            end: "2026-10-07".into(),
            start_epoch: None,
            end_epoch: None,
        });
        assert_eq!(
            checked_evidence(dir.path(), &index, &request).unwrap_err(),
            "activity synthesis requires a native opening origin"
        );
    }

    #[test]
    fn activity_synthesis_requires_its_period_and_uses_record_date_validation_only_when_requested()
    {
        let (dir, mut index, mut request) = source_fixture();
        let content = "---\ncreated: '2026-10-06'\n---\n\n# Synthetic source\n\nSYNTHETIC_REPORTED_WORK was completed.";
        std::fs::write(dir.path().join("wiki/a.md"), content).unwrap();
        let chunks = crate::embeddings::chunk_page(content);
        index.upsert_page("wiki/a.md", "a", &chunks);
        request.hits[0].text = chunks[0].clone();
        request.activity_overview = true;
        assert!(checked_evidence(dir.path(), &index, &request).is_err());
        request.range = Some(crate::commands::DateRange {
            start: "2026-10-06".into(),
            end: "2026-10-07".into(),
            start_epoch: None,
            end_epoch: None,
        });
        assert!(checked_evidence(dir.path(), &index, &request).is_ok());
        request.activity_overview = false;
        assert!(checked_evidence(dir.path(), &index, &request).is_err());
        request.activity_overview = true;
        request.range.as_mut().unwrap().start = "2026-10-07".into();
        assert!(checked_evidence(dir.path(), &index, &request).is_err());
    }

    #[test]
    fn activity_synthesis_prepares_the_dated_task_without_inheriting_prior_question() {
        let (_, _, mut request) = source_fixture();
        request.activity_overview = true;
        request.previous_question = Some("SYNTHETIC_PREVIOUS_TOPIC".into());
        request.range = Some(crate::commands::DateRange {
            start: "2026-10-06".into(),
            end: "2026-10-07".into(),
            start_epoch: None,
            end_epoch: None,
        });
        let _ = synthesis_steps(
            &request,
            &request.hits,
            |_, _| Ok(100),
            |_, user, max_tokens| {
                assert_eq!(max_tokens, 256);
                let payload: serde_json::Value = serde_json::from_str(user).unwrap();
                assert!(payload.get("activity_period").is_some());
                assert!(payload.get("previous_question").is_none());
                Err("synthetic decode failure".into())
            },
        );
    }

    #[cfg(unix)]
    #[test]
    fn synthesis_rejects_resolved_sources_outside_the_explicit_path_allowlist() {
        let (dir, mut index, mut request) = source_fixture();
        let content = std::fs::read_to_string(dir.path().join("wiki/a.md")).unwrap();
        std::fs::write(dir.path().join("wiki/other.md"), &content).unwrap();
        let chunks = crate::embeddings::chunk_page(&content);
        index.upsert_page("wiki/link.md", "link", &chunks);
        std::os::unix::fs::symlink("other.md", dir.path().join("wiki/link.md")).unwrap();
        request.hits[0].page = "wiki/link.md".into();
        request.paths = Some(vec!["wiki/link.md".into()]);
        assert!(checked_evidence(dir.path(), &index, &request).is_err());
        request.paths.as_mut().unwrap().push("wiki/other.md".into());
        assert!(checked_evidence(dir.path(), &index, &request).is_ok());
    }
}
