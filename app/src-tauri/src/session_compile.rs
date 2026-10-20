//! Source-bound compiler jobs and checked output publication. The private
//! runtime issuer, rather than public SHA values, authenticates each attempt.

pub(crate) mod compiler;
pub(crate) mod execution;
pub(crate) mod failure;
pub(crate) mod materializer;
mod publication;
pub(crate) mod review;
pub(crate) mod review_decode;
#[cfg(feature = "native-index-probe")]
pub(crate) mod review_decode_qa;
pub(crate) mod schema;
pub(crate) mod sources;
mod state;
pub(crate) mod structure;
use crate::importers::wikify::{import_lock, source_revision, Pending};
use crate::role_authorization::{self, RoleId, RoleSnapshot, RoleUsage};
use crate::vault_session::{AgentVaultSession, VaultRoot};
use serde::{Deserialize, Serialize};
pub(crate) use state::{CompilationJob, SourceBinding, WorkState};
use state::{CompileIdentity, CompilerContract};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SessionCompileContext {
    pub job_id: String,
    pub attempt_id: String,
    pub origin: AgentVaultSession,
    pub role_snapshot: RoleSnapshot,
    pub source: SourceBinding,
    pub compile_signature: String,
    pub summary_path: String,
    pub index_path: String,
    pub log_path: String,
    pub report_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueueItem {
    pub key: String,
    pub title: String,
    pub raw_path: String,
    pub source_revision: String,
    pub src_slug: String,
    pub summary_path: Option<String>,
    pub compile_job_id: Option<String>,
    pub compilation_state: WorkState,
    pub compilation_reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QueueView {
    pub pending_total: usize,
    pub items: Vec<QueueItem>,
}

struct Grant {
    context: SessionCompileContext,
    outputs: BTreeMap<String, crate::vault::RecordedWriteReceipt>,
    compiler: Option<execution::Work>,
    compiler_busy: bool,
    compiler_request: Option<String>,
}

fn grants() -> &'static Mutex<BTreeMap<String, Grant>> {
    static GRANTS: OnceLock<Mutex<BTreeMap<String, Grant>>> = OnceLock::new();
    GRANTS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs())
}

fn nonce() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| format!("compiler attempt entropy: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn contract() -> CompilerContract {
    CompilerContract {
        compiler: "whole-session-compiler-v8".into(),
        schema: "SessionStructureV1".into(),
        prompt: "source-reading-layout-v1-structure-canonical-materialization-and-source-bound-review-v8"
            .into(),
    }
}

fn identity(context: &SessionCompileContext) -> CompileIdentity {
    CompileIdentity {
        source: context.source.clone(),
        contract: contract(),
        role_signature: context.role_snapshot.route_signature.signature().into(),
    }
}

fn signature(identity: &CompileIdentity) -> Result<String, String> {
    Ok(source_revision(
        &serde_json::to_string(identity).map_err(|error| error.to_string())?,
    ))
}

fn same_context(
    left: &SessionCompileContext,
    right: &SessionCompileContext,
) -> Result<bool, String> {
    // Compare every issued field, including source/schema/paths and role grant.
    Ok(
        serde_json::to_value(left).map_err(|error| error.to_string())?
            == serde_json::to_value(right).map_err(|error| error.to_string())?,
    )
}

pub(crate) fn bound_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.len() > 4096
        || !Path::new(rel)
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
    {
        return Err("invalid compiler path".into());
    }
    crate::vault::confine_delete_path(root, &root.join(rel).to_string_lossy())
}

pub(crate) fn checked_source(root: &Path, source: &SourceBinding) -> Result<String, String> {
    let (vendor, id) = source
        .key
        .split_once(':')
        .ok_or("invalid compiler session key")?;
    if source.key.len() > 4096
        || id.is_empty()
        || id.trim() != id
        || source.key.chars().any(char::is_control)
        || !source
            .raw_path
            .starts_with(&format!("raw/conversations/{vendor}/"))
        || !source.raw_path.ends_with(".md")
        || source.source_revision.len() != 64
        || !source
            .source_revision
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("invalid compiler source binding".into());
    }
    let path = bound_path(root, &source.raw_path)?;
    let bytes =
        std::fs::metadata(&path).map_err(|error| format!("inspect compiler source: {error}"))?;
    if !bytes.is_file() || bytes.len() > 128 * 1024 * 1024 {
        return Err("compiler source is not a bounded regular file; source remains pending".into());
    }
    let content =
        std::fs::read_to_string(path).map_err(|error| format!("read compiler source: {error}"))?;
    if source_revision(&content) != source.source_revision {
        return Err("compiler source revision changed; reimport the original revision".into());
    }
    let parsed = gray_matter::Matter::<gray_matter::engine::YAML>::new()
        .parse::<serde_json::Value>(&content)
        .map_err(|_| "invalid compiler source frontmatter")?;
    let metadata = parsed
        .data
        .ok_or("compiler source lacks imported session identity")?;
    if metadata["source"].as_str() != Some(vendor)
        || metadata["conversation_id"].as_str() != Some(id)
    {
        return Err("compiler source metadata does not match its admitted session".into());
    }
    Ok(content)
}

fn inbox_original_binding(
    pending: &Pending,
    native_original: &str,
) -> Result<SourceBinding, String> {
    let unavailable =
        "inbox original lacks exact admitted imported lineage; source remains pending";
    if native_original.len() > 128 * 1024 * 1024 || !native_original.starts_with("---\n") {
        return Err(unavailable.into());
    }
    let metadata = gray_matter::Matter::<gray_matter::engine::YAML>::new()
        .parse::<serde_json::Value>(native_original)
        .map_err(|_| unavailable)?
        .data
        .ok_or(unavailable)?;
    let vendor = metadata["source"].as_str().ok_or(unavailable)?;
    let id = metadata["conversation_id"].as_str().ok_or(unavailable)?;
    if vendor.is_empty() || id.is_empty() {
        return Err(unavailable.into());
    }
    let key = format!("{vendor}:{id}");
    let revision = source_revision(native_original);
    let mut matches: Vec<SourceBinding> = pending
        .compile_jobs
        .iter()
        .filter(|job| job.superseded_by.is_none())
        .map(|job| job.source.clone())
        .chain(pending.pending.iter().map(|item| SourceBinding {
            key: item.key.clone(),
            raw_path: item.raw_path.clone(),
            source_revision: item.source_revision.clone(),
        }))
        .filter(|source| source.key == key && source.source_revision == revision)
        .collect();
    matches.sort_by(|left, right| left.raw_path.cmp(&right.raw_path));
    matches.dedup();
    if matches.len() != 1 {
        return Err(unavailable.into());
    }
    Ok(matches.remove(0))
}

/// Connect an actual inbox snapshot only to an identical admitted immutable
/// imported original. Projections and general sources still require a compiler.
pub(crate) fn begin_inbox_original(
    state: &VaultRoot,
    origin: &AgentVaultSession,
    native_original: &str,
    usage: RoleUsage,
) -> Result<SessionCompileContext, String> {
    let source = state.with_origin(origin, |root| {
        let _queue = import_lock()?;
        let pending = Pending::try_load(root)?;
        let source = inbox_original_binding(&pending, native_original)?;
        if checked_source(root, &source)? != native_original {
            return Err(
                "inbox bytes differ from their admitted original; source remains pending".into(),
            );
        }
        Ok(source)
    })?;
    // begin_checked revalidates admission under its own opening/role/queue
    // guards, so the discovery read cannot become a manual-admission fallback.
    begin_checked(state, origin, source, usage, Some(native_original))
}

/// Authenticate completion from private native compiler/publication authority.
/// The commit must call recheck inside its existing file-mutation guard before
/// moving the inbox source; recheck never reacquires that guard.
pub(crate) fn with_verified_inbox_completion<T>(
    state: &VaultRoot,
    context: &SessionCompileContext,
    native_original: &str,
    commit: impl FnOnce(&Path, &dyn Fn() -> Result<(), String>) -> Result<T, String>,
) -> Result<T, String> {
    state.with_origin(&context.origin, |root| {
        role_authorization::with_current_role_at(
            &context.origin,
            &context.role_snapshot,
            RoleId::Compilation,
            context.role_snapshot.usage,
            || {
                let _queue = import_lock()?;
                let pending = Pending::try_load(root)?;
                let registry = grants()
                    .lock()
                    .map_err(|_| "compiler issuer lock poisoned")?;
                let grant = registry
                    .get(&context.attempt_id)
                    .ok_or("compiler attempt authority expired; begin a new attempt")?;
                if !same_context(&grant.context, context)?
                    || signature(&identity(context))? != context.compile_signature
                {
                    return Err("compiler context differs from its native issued attempt".into());
                }
                if context.role_snapshot.usage == RoleUsage::Automatic
                    && !crate::settings::read_checked()?.auto_ingest_enabled
                {
                    return Err(
                        "automatic session compilation is disabled; source remains pending".into(),
                    );
                }
                execution::with_verified_completion(root, &pending, grant, native_original, commit)
            },
        )
        .map_err(|error| error.to_string())
    })
}

fn with_attempt<T>(
    state: &VaultRoot,
    context: &SessionCompileContext,
    action: impl FnOnce(&Path, &mut Pending, &mut Grant) -> Result<T, String>,
) -> Result<T, String> {
    state.with_origin(&context.origin, |root| {
        role_authorization::with_current_role_at(
            &context.origin,
            &context.role_snapshot,
            RoleId::Compilation,
            context.role_snapshot.usage,
            || {
                let _queue = import_lock()?;
                let mut pending = Pending::try_load(root)?;
                let mut registry = grants()
                    .lock()
                    .map_err(|_| "compiler issuer lock poisoned")?;
                let grant = registry
                    .get_mut(&context.attempt_id)
                    .ok_or("compiler attempt authority expired; begin a new attempt")?;
                authenticate(root, &mut pending, context, grant)?;
                action(root, &mut pending, grant)
            },
        )
        .map_err(|error| error.to_string())
    })
}

fn authenticate(
    root: &Path,
    pending: &mut Pending,
    context: &SessionCompileContext,
    grant: &Grant,
) -> Result<(), String> {
    if !same_context(&grant.context, context)?
        || signature(&identity(context))? != context.compile_signature
    {
        return Err("compiler context differs from its native issued attempt".into());
    }
    if context.role_snapshot.usage == RoleUsage::Automatic
        && !crate::settings::read_checked()?.auto_ingest_enabled
    {
        return Err("automatic session compilation is disabled; source remains pending".into());
    }
    checked_source(root, &context.source)?;
    pending
        .compile_jobs
        .iter_mut()
        .find(|job| job.id == context.job_id)
        .ok_or("compiler job is no longer admitted")?
        .active(
            &context.attempt_id,
            &context.origin,
            &context.role_snapshot.snapshot_id,
            &identity(context),
        )?;
    Ok(())
}

/// Caller already holds opening -> current role guards. This function acquires
/// only the queue/issuer guards; it never reacquires the opening or role lock.
pub(crate) fn authorize_attempt_at(
    root: &Path,
    bound_origin: &AgentVaultSession,
    context: &SessionCompileContext,
) -> Result<(), String> {
    if bound_origin.vault_path != context.origin.vault_path
        || bound_origin.opening_token != context.origin.opening_token
    {
        return Err("compiler context belongs to a different native opening".into());
    }
    let _queue = import_lock()?;
    let mut pending = Pending::try_load(root)?;
    let registry = grants()
        .lock()
        .map_err(|_| "compiler issuer lock poisoned")?;
    let grant = registry
        .get(&context.attempt_id)
        .ok_or("compiler attempt authority expired; begin a new attempt")?;
    authenticate(root, &mut pending, context, grant)
}

/// Runtime visibility and begin reuse share exact durable/issued bindings.
/// An idle issuer remains live between packets; busy/request flags are not
/// proof of expiry. This check neither creates nor restores authority.
fn current_running_context<'a>(
    job: &CompilationJob,
    origin: &AgentVaultSession,
    registry: &'a BTreeMap<String, Grant>,
) -> Result<Option<&'a SessionCompileContext>, String> {
    if job.superseded_by.is_some() || job.state != WorkState::Running {
        return Ok(None);
    }
    let Some(attempt) = job.attempts.last() else {
        return Ok(None);
    };
    let Some(grant) = registry.get(&attempt.id) else {
        return Ok(None);
    };
    let context = &grant.context;
    let expected_identity = identity(context);
    let matches = attempt.state == WorkState::Running
        && context.job_id == job.id
        && context.attempt_id == attempt.id
        && context.source == job.source
        && attempt.identity == expected_identity
        && attempt.role_snapshot_id == context.role_snapshot.snapshot_id
        && attempt.origin.vault_path == origin.vault_path
        && attempt.origin.opening_token == origin.opening_token
        && context.origin.vault_path == origin.vault_path
        && context.origin.opening_token == origin.opening_token
        && context.role_snapshot.origin.vault_path == origin.vault_path
        && context.role_snapshot.origin.opening_token == origin.opening_token
        && context.role_snapshot.role == RoleId::Compilation
        && context.role_snapshot.route_signature.role == RoleId::Compilation;
    Ok((matches && signature(&expected_identity)? == context.compile_signature).then_some(context))
}

pub(crate) fn list_at(
    root: &Path,
    origin: &AgentVaultSession,
    limit: usize,
) -> Result<QueueView, String> {
    let _queue = import_lock()?;
    let pending = Pending::try_load(root)?;
    // Caller holds the actual opening guard. Snapshot the issuer under the
    // queue guard, then release it before file reads. Listing is observational;
    // begin and each execution still recheck role/source/issuer authority.
    let runtime_revalidation = {
        let registry = grants()
            .lock()
            .map_err(|_| "compiler issuer lock poisoned")?;
        let mut stale = BTreeSet::new();
        for (index, job) in pending.compile_jobs.iter().enumerate() {
            if job.state == WorkState::Running
                && current_running_context(job, origin, &registry)?.is_none()
            {
                stale.insert(index);
            }
        }
        stale
    };
    // Read-only route inspection cannot restore native attempt authority. A
    // later begin rechecks selection and permissions under the actual guards.
    let current_route = pending
        .compile_jobs
        .iter()
        .any(|job| job.superseded_by.is_none() && job.state == WorkState::Completed)
        .then(|| {
            crate::settings::read_checked().and_then(|settings| {
                role_authorization::route_for(&settings, RoleId::Compilation, RoleUsage::Foreground)
            })
        });
    let current_signature = current_route
        .as_ref()
        .and_then(|route| route.as_ref().ok())
        .map(|route| route.signature());
    let mut bindings: Vec<(SourceBinding, Option<&CompilationJob>, bool)> = pending
        .compile_jobs
        .iter()
        .enumerate()
        .filter(|(_, job)| {
            job.superseded_by.is_none()
                && (job.state != WorkState::Completed
                    || completion_revalidation_reason(job, current_signature).is_some())
        })
        .map(|(index, job)| {
            (
                job.source.clone(),
                Some(job),
                runtime_revalidation.contains(&index),
            )
        })
        .collect();
    for item in &pending.pending {
        let source = SourceBinding {
            key: item.key.clone(),
            raw_path: item.raw_path.clone(),
            source_revision: item.source_revision.clone(),
        };
        if pending.compile_jobs.iter().any(|job| {
            job.source == source
                && job.superseded_by.is_none()
                && job.state == WorkState::Completed
                && completion_revalidation_reason(job, current_signature).is_none()
        }) {
            continue;
        }
        if !bindings.iter().any(|entry| entry.0 == source) {
            bindings.push((source, None, false));
        }
    }
    let pending_total = bindings.len();
    let mut items = Vec::new();
    for (source, job, requires_runtime_revalidation) in bindings.into_iter().take(limit.clamp(1, 3))
    {
        let original = checked_source(root, &source)?;
        let legacy = pending
            .pending
            .iter()
            .find(|item| item.key == source.key && item.source_revision == source.source_revision);
        let title = legacy.map(|item| item.title.clone()).unwrap_or_else(|| {
            original
                .lines()
                .find_map(|line| line.strip_prefix("# ").map(str::to_string))
                .unwrap_or_else(|| "Imported session".into())
        });
        let stem = Path::new(&source.raw_path)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .ok_or("invalid compiler source path")?;
        let revalidation = job.and_then(|job| {
            if requires_runtime_revalidation {
                Some("compiler_runtime_revalidation_required")
            } else {
                completion_revalidation_reason(job, current_signature)
            }
        });
        let reason = revalidation.map(|reason| {
            match current_route
                .as_ref()
                .and_then(|route| route.as_ref().err())
            {
                Some(error) if reason == "compiler_role_revalidation_required" => {
                    format!("{reason}: {error}")
                }
                _ => reason.into(),
            }
        });
        items.push(QueueItem {
            summary_path: crate::mcp_native::summary_path_from_pending(
                root,
                &source.key,
                &pending,
            )?,
            compile_job_id: job.map(|job| job.id.clone()),
            compilation_state: if revalidation.is_some() {
                WorkState::Pending
            } else {
                job.map_or(WorkState::Pending, |job| job.state)
            },
            compilation_reason: reason.or_else(|| job.and_then(|job| job.reason.clone())),
            title,
            src_slug: format!("src-{}", stem.replace('.', "-")),
            key: source.key,
            raw_path: source.raw_path,
            source_revision: source.source_revision,
        });
    }
    Ok(QueueView {
        pending_total,
        items,
    })
}

/// Historical consistency controls queue visibility, never live publication.
fn completion_revalidation_reason(
    job: &CompilationJob,
    current_role_signature: Option<&str>,
) -> Option<&'static str> {
    if job.state != WorkState::Completed {
        return None;
    }
    let contract_reason = Some("compiler_contract_revalidation_required");
    let Some(attempt) = job.attempts.last() else {
        return contract_reason;
    };
    if attempt.state != WorkState::Completed
        || attempt.identity.source != job.source
        || attempt.identity.contract != contract()
        || !attempt.checks.completed_compilation()
        || attempt.outputs.is_empty()
        || attempt
            .outputs
            .iter()
            .any(|output| output.attempt_id != attempt.id)
    {
        return contract_reason;
    }
    let mut receipts = job
        .receipts
        .iter()
        .filter(|receipt| receipt.attempt_id == attempt.id);
    let Some(receipt) = receipts.next() else {
        return contract_reason;
    };
    if receipts.next().is_some()
        || receipt.identity != attempt.identity
        || receipt.checks != attempt.checks
        || receipt.outputs != attempt.outputs
    {
        return contract_reason;
    }
    if current_role_signature != Some(attempt.identity.role_signature.as_str()) {
        return Some("compiler_role_revalidation_required");
    }
    None
}

pub(crate) fn summary_at(root: &Path, key: &str, revision: &str) -> Result<Option<String>, String> {
    let _queue = import_lock()?;
    let pending = Pending::try_load(root)?;
    let source = pending
        .compile_jobs
        .iter()
        .find(|job| {
            job.source.key == key
                && job.source.source_revision == revision
                && job.superseded_by.is_none()
        })
        .map(|job| job.source.clone())
        .or_else(|| {
            pending
                .pending
                .iter()
                .find(|item| item.key == key && item.source_revision == revision)
                .map(|item| SourceBinding {
                    key: item.key.clone(),
                    raw_path: item.raw_path.clone(),
                    source_revision: item.source_revision.clone(),
                })
        })
        .ok_or("source revision is no longer admitted")?;
    checked_source(root, &source)?;
    crate::mcp_native::summary_path_from_pending(root, key, &pending)
}

fn manual_admission(
    root: &Path,
    source: &SourceBinding,
    original: &str,
) -> Result<crate::importers::wikify::PendingItem, String> {
    let ledger = crate::importers::ledger::Ledger::load(root)?;
    let fingerprint = crate::importers::ledger::fingerprint(original);
    if ledger.entry(&source.key) != Some(&fingerprint) {
        return Err("manual compiler source lacks current admitted ledger lineage; reimport the original source".into());
    }
    let mut lineage = false;
    for destination in ["sessions", "_inbox"] {
        if let Some(rel) = ledger.location(destination, &source.key) {
            let projection = std::fs::read_to_string(bound_path(root, rel)?)
                .map_err(|error| format!("read manual source lineage: {error}"))?;
            let parsed = gray_matter::Matter::<gray_matter::engine::YAML>::new()
                .parse::<serde_json::Value>(&projection)
                .map_err(|_| "invalid manual source lineage")?;
            let metadata = parsed
                .data
                .ok_or("manual source lineage lacks provenance")?;
            if metadata["raw_path"].as_str() == Some(source.raw_path.as_str())
                && metadata["source_revision"].as_str() == Some(source.source_revision.as_str())
            {
                crate::commands::validate_manual_compiler_projection(
                    root,
                    source,
                    original,
                    &projection,
                    &fingerprint,
                )?;
                lineage = true;
            }
        }
    }
    if !lineage {
        return Err("manual compiler source has no exact native raw/projection lineage; reimport for review".into());
    }
    let stem = Path::new(&source.raw_path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or("invalid manual compiler source name")?;
    let title = original
        .lines()
        .find_map(|line| line.strip_prefix("# ").map(str::to_string))
        .unwrap_or_else(|| "Imported session".into());
    Ok(crate::importers::wikify::PendingItem {
        key: source.key.clone(),
        raw_path: source.raw_path.clone(),
        source_revision: source.source_revision.clone(),
        src_slug: format!("src-{}", stem.replace('.', "-")),
        title,
        imported: crate::registry::today_utc(),
        read_ranges: Vec::new(),
    })
}

pub(crate) fn begin(
    state: &VaultRoot,
    origin: &AgentVaultSession,
    source: SourceBinding,
    usage: RoleUsage,
) -> Result<SessionCompileContext, String> {
    begin_checked(state, origin, source, usage, None)
}

fn begin_checked(
    state: &VaultRoot,
    origin: &AgentVaultSession,
    source: SourceBinding,
    usage: RoleUsage,
    native_original: Option<&str>,
) -> Result<SessionCompileContext, String> {
    state.with_origin(origin, |root| {
        let role = role_authorization::capture_role_at(origin, RoleId::Compilation, usage)
            .map_err(|error| error.to_string())?;
        role_authorization::with_current_role_at(origin, &role, RoleId::Compilation, usage, || {
            let _queue = import_lock()?;
            let mut pending = Pending::try_load(root)?;
            if usage == RoleUsage::Automatic
                && !crate::settings::read_checked()?.auto_ingest_enabled
            {
                return Err(
                    "automatic session compilation is disabled; source remains pending".into(),
                );
            }
            let original = checked_source(root, &source)?;
            if let Some(native_original) = native_original {
                if original != native_original
                    || inbox_original_binding(&pending, native_original)? != source
                {
                    return Err("inbox original admission changed; source remains pending".into());
                }
            }
            // Only an explicit begin can add a typed job for an existing legacy
            // source. Reading/listing never performs silent migration.
            if !pending.compile_jobs.iter().any(|job| job.source == source) {
                let item = pending
                    .pending
                    .iter()
                    .find(|item| {
                        item.key == source.key
                            && item.raw_path == source.raw_path
                            && item.source_revision == source.source_revision
                    })
                    .cloned();
                let item = match item {
                    Some(item) => item,
                    None if usage == RoleUsage::Foreground => {
                        manual_admission(root, &source, &original)?
                    }
                    None => {
                        return Err(
                            "source revision is not admitted for automatic compilation".into()
                        )
                    }
                };
                pending.admit_compile_job(&item);
            }
            let summary_path =
                crate::mcp_native::summary_path_from_pending(root, &source.key, &pending)?
                    .unwrap_or_else(|| {
                        format!(
                            "wiki/source-session-{}-{}.md",
                            source.key.split(':').next().unwrap_or("session"),
                            &source_revision(&source.key)[..16]
                        )
                    });
            let attempt_id = nonce()?;
            let job = pending
                .compile_jobs
                .iter_mut()
                .find(|job| job.source == source)
                .ok_or("source revision is not admitted for compilation")?;
            if usage == RoleUsage::Automatic && job.state == WorkState::Completed
                && completion_revalidation_reason(job, Some(role.route_signature.signature())).is_none()
            {
                return Err("this source revision is already compiled under the current contract".into());
            }
            if usage == RoleUsage::Automatic && job.attempts.last().is_some_and(|attempt| {
                attempt.state == WorkState::Partial
                    && attempt.checks.semantic_review == state::CheckState::Unavailable
                    && attempt.identity.contract == contract()
                    && attempt.identity.role_signature == role.route_signature.signature()
            }) {
                return Err("SEMANTIC_ADAPTER_REQUIRED: unchanged preview remains partial; explicit retry or a new compiler/model contract is required".into());
            }
            let mut registry = grants()
                .lock()
                .map_err(|_| "compiler issuer lock poisoned")?;
            if let Some(previous) = current_running_context(job, origin, &registry)?
                .filter(|context| {
                    context.role_snapshot.authorization_revision
                        == role.authorization_revision
                        && context.role_snapshot.route_signature.signature()
                            == role.route_signature.signature()
                })
            {
                if usage == RoleUsage::Foreground && previous.role_snapshot.usage == usage {
                    return Ok(previous.clone());
                }
                return Err("this source compilation attempt is already running".into());
            }
            let mut context = SessionCompileContext {
                job_id: job.id.clone(),
                attempt_id: attempt_id.clone(),
                origin: origin.clone(),
                role_snapshot: role.clone(),
                source: source.clone(),
                compile_signature: String::new(),
                summary_path,
                index_path: "wiki/index.md".into(),
                log_path: "wiki/log.md".into(),
                report_path: format!("ingest-reports/session-{attempt_id}.md"),
            };
            context.compile_signature = signature(&identity(&context))?;
            // Stored model drafts are resumable work data, never authority.
            // The new runtime rebinds every batch and generates fresh reviews.
            let checkpoint = job.attempts.last()
                .filter(|attempt| attempt.identity == identity(&context))
                .and_then(|attempt| attempt.compiler_progress.clone())
                .filter(|progress| progress.compile_signature == context.compile_signature);
            job.begin(
                attempt_id.clone(),
                origin.clone(),
                role.snapshot_id.clone(),
                identity(&context),
                now(),
            )?;
            job.attempts.last_mut().ok_or("compiler attempt was not created")?
                .compiler_progress = checkpoint;
            pending.save(root)?;
            registry.insert(
                attempt_id,
                Grant {
                    context: context.clone(),
                    outputs: BTreeMap::new(),
                    compiler: None,
                    compiler_busy: false,
                    compiler_request: None,
                },
            );
            Ok(context)
        })
        .map_err(|error| error.to_string())
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BoundRead {
    pub raw: String,
    pub revision: String,
}

pub(crate) fn read(
    state: &VaultRoot,
    context: &SessionCompileContext,
    rel: &str,
) -> Result<BoundRead, String> {
    with_attempt(state, context, |root, _, _| {
        publication::allowed(context, rel, false)?;
        let raw = std::fs::read_to_string(bound_path(root, rel)?)
            .map_err(|error| format!("read compiler file: {error}"))?;
        Ok(BoundRead {
            revision: source_revision(&raw),
            raw,
        })
    })
}

pub(crate) fn publish(
    state: &VaultRoot,
    context: &SessionCompileContext,
    rel: &str,
    content: &str,
    expected_revision: Option<&str>,
) -> Result<serde_json::Value, String> {
    with_attempt(state, context, |root, pending, grant| {
        publication::publish(root, pending, grant, rel, content, expected_revision)
    })
}

pub(crate) fn complete(
    state: &VaultRoot,
    context: &SessionCompileContext,
    wiki_paths: &[String],
) -> Result<serde_json::Value, String> {
    with_attempt(state, context, |root, pending, grant| {
        publication::finish(root, pending, grant, wiki_paths)
    })
}

pub(crate) fn stop(
    state: &VaultRoot,
    context: &SessionCompileContext,
    reason: &str,
) -> Result<(), String> {
    with_attempt(state, context, |root, pending, _| {
        let job = pending
            .compile_jobs
            .iter_mut()
            .find(|job| job.id == context.job_id)
            .ok_or("compiler job no longer admitted")?;
        let outcome = if reason == "preparation_required" {
            WorkState::Pending
        } else {
            WorkState::Stopped
        };
        job.stop(
            &context.attempt_id,
            outcome,
            reason.chars().take(256).collect(),
            now(),
        )?;
        pending.save(root)
    })
}

#[cfg(test)]
mod native_tests;

#[cfg(test)]
mod contract_revalidation_tests;

#[cfg(test)]
mod inbox_authority_tests;
