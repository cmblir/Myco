//! Opening-bound Audio drafts. Returned text and context DTOs are not write authority.

mod generation;
mod publication;
mod script;
mod sources;

#[cfg(test)]
mod tests;

pub(crate) use generation::generate;
#[cfg(any(test, feature = "native-index-probe"))]
pub(crate) use generation::generate_with;
pub(crate) use publication::publish;
#[cfg(test)]
pub(crate) use publication::publish_with;

use crate::role_authorization::{self, RoleId, RoleSnapshot, RoleUsage};
use crate::vault_session::{AgentVaultSession, VaultRoot};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct JobContext {
    pub job_id: String,
    pub origin: AgentVaultSession,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DraftContext {
    pub job_id: String,
    pub origin: AgentVaultSession,
    pub draft_id: String,
}

impl DraftContext {
    fn job(&self) -> JobContext {
        JobContext {
            job_id: self.job_id.clone(),
            origin: self.origin.clone(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DialogueTurn {
    pub speaker: Speaker,
    pub text: String,
    pub cites: Vec<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) enum Speaker {
    A,
    B,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BodyRange {
    pub path: String,
    pub start_byte: usize,
    pub end_byte: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Coverage {
    pub selected_pages: Vec<String>,
    pub included_pages: Vec<String>,
    pub omitted_pages: Vec<String>,
    pub included_body_ranges: Vec<BodyRange>,
    pub budget_bytes: usize,
    pub included_bodies_only: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Draft {
    pub title: String,
    pub turns: Vec<DialogueTurn>,
    pub source_pages: Vec<String>,
    pub context: DraftContext,
    pub coverage: Coverage,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum PublicationState {
    Persisted,
    Partial,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Publication {
    pub job_id: String,
    pub draft_id: String,
    pub origin: AgentVaultSession,
    pub path: String,
    pub revision: Option<String>,
    pub state: PublicationState,
    pub error: Option<String>,
}

#[derive(Clone)]
struct StoredDraft {
    draft: Draft,
    markdown: String,
}

#[derive(Default)]
struct Lifecycle {
    draft: Option<StoredDraft>,
    publication: Option<Publication>,
    // A receipt is private and retains the actual persisted file handle.
    receipt: Option<crate::vault::RecordedWriteReceipt>,
}

#[derive(Clone)]
struct Job {
    context: JobContext,
    role: RoleSnapshot,
    title: String,
    date_iso: String,
    target_rel: String,
    sources: Arc<sources::Sources>,
    cancelled: Arc<AtomicBool>,
    active: Arc<AtomicBool>,
    lifecycle: Arc<Mutex<Lifecycle>>,
}

#[derive(Clone, Default)]
pub(crate) struct AudioOverviewRegistry {
    jobs: Arc<Mutex<BTreeMap<String, Job>>>,
}

fn same_origin(left: &AgentVaultSession, right: &AgentVaultSession) -> bool {
    left.vault_path == right.vault_path && left.opening_token == right.opening_token
}

fn issued_id() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|error| format!("audio job entropy failed: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn authenticate(context: &JobContext, job: &Job) -> Result<(), String> {
    if context.job_id != job.context.job_id || !same_origin(&context.origin, &job.context.origin) {
        return Err("audio job differs from its native issued opening".into());
    }
    Ok(())
}

fn lookup(registry: &AudioOverviewRegistry, context: &JobContext) -> Result<Job, String> {
    let jobs = registry
        .jobs
        .lock()
        .map_err(|_| "audio registry lock poisoned")?;
    let job = jobs
        .get(&context.job_id)
        .ok_or("native audio job expired")?;
    authenticate(context, job)?;
    Ok(job.clone())
}

fn with_job<T>(
    state: &VaultRoot,
    registry: &AudioOverviewRegistry,
    context: &JobContext,
    operation: impl FnOnce(&Path, &Job) -> Result<T, String>,
) -> Result<T, String> {
    with_job_checked(state, registry, context, false, operation)
}

fn with_job_checked<T>(
    state: &VaultRoot,
    registry: &AudioOverviewRegistry,
    context: &JobContext,
    allow_cancelled_postcheck: bool,
    operation: impl FnOnce(&Path, &Job) -> Result<T, String>,
) -> Result<T, String> {
    // Copy the private grant before acquiring earlier locks; never hold this
    // lookup lock while waiting for the opening or role authority.
    let issued = lookup(registry, context)?;
    state.with_origin(&context.origin, |root| {
        role_authorization::with_current_role_at(
            &context.origin,
            &issued.role,
            RoleId::Audio,
            RoleUsage::Foreground,
            || {
                let jobs = registry
                    .jobs
                    .lock()
                    .map_err(|_| "audio registry lock poisoned")?;
                let job = jobs
                    .get(&context.job_id)
                    .ok_or("native audio job expired")?;
                authenticate(context, job)?;
                if job.role.snapshot_id != issued.role.snapshot_id {
                    return Err("native audio role changed".into());
                }
                if !allow_cancelled_postcheck && job.cancelled.load(Ordering::Acquire) {
                    return Err("audio generation cancelled".into());
                }
                operation(root, job)
            },
        )
        .map_err(|error| error.to_string())
    })
}

/// Capture all selected originals and a fixed foreground Audio grant.
pub(crate) fn begin(
    state: &VaultRoot,
    registry: &AudioOverviewRegistry,
    origin: &AgentVaultSession,
    paths: &[String],
    title: &str,
    date_iso: &str,
) -> Result<JobContext, String> {
    if title.trim().is_empty()
        || title.len() > 1024
        || title.chars().any(char::is_control)
        || date_iso.len() > 128
        || crate::importers::parse_iso8601(date_iso).is_none()
    {
        return Err("invalid audio overview title or date".into());
    }
    state.with_origin(origin, |root| {
        let role =
            role_authorization::capture_role_at(origin, RoleId::Audio, RoleUsage::Foreground)
                .map_err(|error| error.to_string())?;
        role_authorization::with_current_role_at(
            origin,
            &role,
            RoleId::Audio,
            RoleUsage::Foreground,
            || {
                let mut jobs = registry
                    .jobs
                    .lock()
                    .map_err(|_| "audio registry lock poisoned")?;
                let mut expired = Vec::new();
                for (job_id, job) in jobs.iter() {
                    let stale = !same_origin(&job.context.origin, origin);
                    if stale {
                        signal_cancel(job);
                    }
                    let life = job
                        .lifecycle
                        .lock()
                        .map_err(|_| "audio lifecycle lock poisoned")?;
                    let persisted = life
                        .publication
                        .as_ref()
                        .is_some_and(|receipt| receipt.state == PublicationState::Persisted);
                    if !job.active.load(Ordering::Acquire)
                        && (stale || job.cancelled.load(Ordering::Acquire) || persisted)
                    {
                        expired.push(job_id.clone());
                    }
                }
                for job_id in expired {
                    jobs.remove(&job_id);
                }
                if jobs.len() >= 4 {
                    return Err(
                        "audio job capacity is occupied; finish or cancel existing work".into(),
                    );
                }
                crate::vault::with_root_mutation(root, |root, _writer| {
                    let sources = sources::capture(root, paths)?;
                    let job_id = issued_id()?;
                    let context = JobContext {
                        job_id: job_id.clone(),
                        origin: origin.clone(),
                    };
                    let target_rel =
                        format!("audio/{}-{}.md", script::slug(title), &date_iso[..10]);
                    jobs.insert(
                        job_id,
                        Job {
                            context: context.clone(),
                            role: role.clone(),
                            title: title.trim().to_owned(),
                            date_iso: date_iso.to_owned(),
                            target_rel,
                            sources: Arc::new(sources),
                            cancelled: Arc::new(AtomicBool::new(false)),
                            active: Arc::new(AtomicBool::new(false)),
                            lifecycle: Arc::new(Mutex::new(Lifecycle::default())),
                        },
                    );
                    Ok(context)
                })
            },
        )
        .map_err(|error| error.to_string())
    })
}

fn signal_cancel(job: &Job) {
    job.cancelled.store(true, Ordering::Release);
    if job.role.route_signature.provider_id == "builtin-local" {
        for attempt in 0..2 {
            crate::local_generation::cancel(&generation::request_id(job, attempt));
        }
    }
}

/// Cancel only an issued job, including one whose opening has since closed.
/// Receipt publication already inside the writer transaction cannot be recalled.
pub(crate) fn cancel(
    registry: &AudioOverviewRegistry,
    context: &JobContext,
) -> Result<bool, String> {
    let jobs = registry
        .jobs
        .lock()
        .map_err(|_| "audio registry lock poisoned")?;
    let job = jobs
        .get(&context.job_id)
        .ok_or("native audio job expired")?;
    authenticate(context, job)?;
    signal_cancel(job);
    Ok(true)
}

#[cfg(test)]
impl AudioOverviewRegistry {
    pub(crate) fn len(&self) -> usize {
        self.jobs.lock().unwrap().len()
    }
    pub(crate) fn active_count(&self) -> usize {
        self.jobs
            .lock()
            .unwrap()
            .values()
            .filter(|job| job.active.load(Ordering::Acquire))
            .count()
    }
    pub(crate) fn draft_for_test(&self, context: &JobContext) -> Result<Option<Draft>, String> {
        let job = lookup(self, context)?;
        let lifecycle = job
            .lifecycle
            .lock()
            .map_err(|_| "audio lifecycle lock poisoned")?;
        Ok(lifecycle.draft.as_ref().map(|stored| stored.draft.clone()))
    }
    pub(crate) fn replace_role_snapshot_for_test(
        &self,
        context: &JobContext,
        role: RoleSnapshot,
    ) -> Result<(), String> {
        let mut jobs = self
            .jobs
            .lock()
            .map_err(|_| "audio registry lock poisoned")?;
        let job = jobs
            .get_mut(&context.job_id)
            .ok_or("native audio job expired")?;
        authenticate(context, job)?;
        job.role = role;
        Ok(())
    }
}
