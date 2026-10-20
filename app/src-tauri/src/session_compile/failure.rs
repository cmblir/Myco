//! Error cleanup owns only an issued running attempt, never content authority.

use super::state::{CompilerProgress, WorkState};
use super::{grants, identity, now, same_context, SessionCompileContext};
use crate::importers::wikify::{import_lock, source_revision, Pending};
use crate::vault_session::{AgentVaultSession, VaultRoot};
use serde::Serialize;
use std::sync::Mutex;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Reason {
    ModelPreparationUnavailable,
    CustodyRetirementPending,
    ModelHostFailed,
    ProcessingFailed,
    SemanticReviewUnavailable,
    TaskFailed,
    Cancelled,
}

impl Reason {
    fn state(self) -> WorkState {
        match self {
            Self::ModelPreparationUnavailable | Self::CustodyRetirementPending => {
                WorkState::Pending
            }
            Self::Cancelled => WorkState::Stopped,
            Self::SemanticReviewUnavailable => WorkState::Partial,
            Self::ModelHostFailed | Self::ProcessingFailed | Self::TaskFailed => WorkState::Failed,
        }
    }

    pub(super) fn code(self) -> &'static str {
        match self {
            Self::ModelPreparationUnavailable => "model_preparation_unavailable",
            Self::CustodyRetirementPending => "custody_retirement_pending",
            Self::ModelHostFailed => "model_host_failed",
            Self::ProcessingFailed => "processing_failed",
            Self::SemanticReviewUnavailable => "semantic_review_unavailable",
            Self::TaskFailed => "task_failed",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FailureOutcome {
    pub attempt_id: String,
    pub source_revision: String,
    pub compile_signature: String,
    pub origin: AgentVaultSession,
    pub role_snapshot_id: String,
    pub request_id: Option<String>,
    pub state: WorkState,
    pub reason: Reason,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompileFailure {
    version: &'static str,
    pub message: String,
    pub outcome: Option<Box<FailureOutcome>>,
    pub finalization_error: Option<String>,
}

impl From<String> for CompileFailure {
    fn from(message: String) -> Self {
        Self {
            version: "SessionCompileFailureV1",
            message,
            outcome: None,
            finalization_error: None,
        }
    }
}

impl From<&str> for CompileFailure {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}

impl std::fmt::Display for CompileFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)?;
        if let Some(error) = &self.finalization_error {
            write!(
                f,
                "; native failure finalization could not be confirmed: {error}"
            )?;
        }
        Ok(())
    }
}

/// Not serializable or caller-constructible. Issued only while acquiring the
/// request or packet lease; its checkpoint follows this owner's successful save.
pub(crate) struct Owner {
    context: SessionCompileContext,
    request_id: Option<String>,
    checkpoint: Mutex<String>,
}

pub(super) fn progress_revision(progress: &Option<CompilerProgress>) -> Result<String, String> {
    serde_json::to_string(progress)
        .map(|text| source_revision(&text))
        .map_err(|error| format!("serialize compiler checkpoint: {error}"))
}

impl Owner {
    pub(super) fn issue(
        context: &SessionCompileContext,
        request_id: Option<String>,
        progress: &Option<CompilerProgress>,
    ) -> Result<Self, String> {
        Ok(Self {
            context: context.clone(),
            request_id,
            checkpoint: Mutex::new(progress_revision(progress)?),
        })
    }

    pub(super) fn same_context(&self, context: &SessionCompileContext) -> Result<bool, String> {
        same_context(&self.context, context)
    }

    pub(super) fn matches(
        &self,
        context: &SessionCompileContext,
        request: Option<&str>,
    ) -> Result<bool, String> {
        Ok(same_context(&self.context, context)? && self.request_id.as_deref() == request)
    }

    pub(super) fn checkpoint(&self) -> Result<String, String> {
        self.checkpoint
            .lock()
            .map(|revision| revision.clone())
            .map_err(|_| "compiler checkpoint owner lock poisoned".into())
    }

    pub(super) fn saved(&self, progress: &Option<CompilerProgress>) -> Result<(), String> {
        let revision = progress_revision(progress)?;
        *self
            .checkpoint
            .lock()
            .map_err(|_| "compiler checkpoint owner lock poisoned")? = revision;
        Ok(())
    }
}

/// A failed worker may lose persistence without losing its live grant. Expire
/// only that exact owner's runtime authority; this is not a saved state or a
/// worker-drain receipt. Take no opening/role/queue locks under this guard.
fn retire_unconfirmed_owner(owner: &Owner, expected_busy: bool) -> Result<(), String> {
    let mut registry = grants()
        .lock()
        .map_err(|_| "compiler failure retirement issuer lock poisoned")?;
    let should_remove = match registry.get(&owner.context.attempt_id) {
        Some(grant) => {
            owner.matches(&grant.context, grant.compiler_request.as_deref())?
                && grant.compiler_busy == expected_busy
                && (owner.request_id.is_some() || grant.compiler_busy)
        }
        None => false,
    };
    if should_remove {
        registry.remove(&owner.context.attempt_id);
    }
    Ok(())
}

fn confirmed_failure(owner: &Owner, reason: Reason, message: String) -> CompileFailure {
    let context = &owner.context;
    let mut error = CompileFailure::from(message);
    error.outcome = Some(Box::new(FailureOutcome {
        attempt_id: context.attempt_id.clone(),
        source_revision: context.source.source_revision.clone(),
        compile_signature: context.compile_signature.clone(),
        origin: context.origin.clone(),
        role_snapshot_id: context.role_snapshot.snapshot_id.clone(),
        request_id: owner.request_id.clone(),
        state: reason.state(),
        reason,
    }));
    error
}

fn unconfirmed_failure(
    owner: &Owner,
    message: String,
    finalization_error: String,
    expected_busy: bool,
) -> CompileFailure {
    let mut error = CompileFailure::from(message);
    error.finalization_error = Some(match retire_unconfirmed_owner(owner, expected_busy) {
        Ok(()) => finalization_error,
        Err(retirement_error) => format!("{finalization_error}; {retirement_error}"),
    });
    error
}

/// The executor calls this only after saving the draft/checks/Partial together
/// and advancing its exact owner's checkpoint. No second state save is needed.
pub(super) fn confirmed_review_unavailable(owner: &Owner, message: String) -> CompileFailure {
    confirmed_failure(owner, Reason::SemanticReviewUnavailable, message)
}

/// A failed draft save must not retry persistence through ordinary finalization.
pub(super) fn unconfirmed_leased(
    owner: &Owner,
    message: String,
    finalization_error: String,
) -> CompileFailure {
    unconfirmed_failure(owner, message, finalization_error, true)
}

/// Revocation or source changes forbid processing/publication, but do not grant
/// a dead worker indefinite Running status. This private cleanup changes only
/// state/reason under the current opening and exact issued owner/attempt/CAS.
fn finalize_with_state(
    vault: &VaultRoot,
    owner: &Owner,
    reason: Reason,
    message: String,
    expected_busy: bool,
) -> CompileFailure {
    let context = &owner.context;
    let result = owner.checkpoint().and_then(|expected| {
        vault.with_origin(&context.origin, |root| {
            let _queue = import_lock()?;
            let mut pending = Pending::try_load(root)?;
            let registry = grants()
                .lock()
                .map_err(|_| "compiler issuer lock poisoned")?;
            let grant = registry
                .get(&context.attempt_id)
                .ok_or("compiler failure owner expired")?;
            if !owner.matches(&grant.context, grant.compiler_request.as_deref())?
                || grant.compiler_busy != expected_busy
                || (owner.request_id.is_none() && !grant.compiler_busy)
            {
                return Err("compiler failure no longer owns its issued request or lease".into());
            }
            let mut jobs = pending
                .compile_jobs
                .iter_mut()
                .filter(|job| job.id == context.job_id);
            let job = jobs
                .next()
                .ok_or("compiler failure job no longer admitted")?;
            if jobs.next().is_some() || job.state != WorkState::Running {
                return Err("compiler failure job no longer has its unique running attempt".into());
            }
            let attempt = job.active(
                &context.attempt_id,
                &context.origin,
                &context.role_snapshot.snapshot_id,
                &identity(context),
            )?;
            if progress_revision(&attempt.compiler_progress)? != expected {
                return Err("compiler checkpoint changed before failure finalization".into());
            }
            job.stop(
                &context.attempt_id,
                reason.state(),
                reason.code().into(),
                now(),
            )?;
            pending.save(root)?;
            Ok(())
        })
    });
    match result {
        Ok(()) => confirmed_failure(owner, reason, message),
        Err(finalization_error) => {
            // The failed processing closure has returned and its guards are
            // released. Do not leave a dead issuer blocking a fresh begin, or
            // allow Lease::drop to restore its unconfirmed runtime work.
            unconfirmed_failure(owner, message, finalization_error, expected_busy)
        }
    }
}

/// Preparation and drained-worker failures must not terminate an active packet.
pub(crate) fn finalize_idle(
    vault: &VaultRoot,
    owner: &Owner,
    reason: Reason,
    message: String,
) -> CompileFailure {
    finalize_with_state(vault, owner, reason, message, false)
}

pub(super) fn finalize_leased(
    vault: &VaultRoot,
    owner: &Owner,
    reason: Reason,
    message: String,
) -> CompileFailure {
    finalize_with_state(vault, owner, reason, message, true)
}
