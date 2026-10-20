//! Native session compiler orchestration. Inference owns a detached runtime
//! lease and never holds the opening, role, queue or publication locks.

use super::compiler::{CompilerRun, CompilerSchema, StepReceipt};
use super::failure::progress_revision;
use super::failure::{self, CompileFailure, Owner, Reason};
use super::publication::{self, NativeSectionAuthority};
use super::review_decode::SessionReviewDecode;
use super::sources::{self, PacketPlan};
use super::state::{Attempt, CheckState, CompilerProgress, ProcessingChecks, WorkState};
use super::{grants, identity, now, with_attempt, Grant, SessionCompileContext};
use crate::importers::wikify::Pending;
use crate::local_model::{self, ModelManifest};
use crate::vault_session::VaultRoot;
use crate::wiki_claims::CompilationOriginal;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

pub(super) struct Work {
    run: CompilerRun,
    plan: Option<PacketPlan>,
    language: Option<String>,
}

impl Work {
    fn new(context: &SessionCompileContext) -> Self {
        Self {
            run: CompilerRun::new(&context.attempt_id, &context.compile_signature),
            plan: None,
            language: None,
        }
    }
}

struct Lease {
    attempt_id: String,
    work: Option<Work>,
}

impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut registry) = grants().lock() {
            if let Some(grant) = registry.get_mut(&self.attempt_id) {
                grant.compiler = self.work.take();
                grant.compiler_busy = false;
            }
        }
    }
}

type SectionKey = (PathBuf, String, String);
fn sections() -> &'static Mutex<BTreeMap<SectionKey, NativeSectionAuthority>> {
    static SECTIONS: OnceLock<Mutex<BTreeMap<SectionKey, NativeSectionAuthority>>> =
        OnceLock::new();
    SECTIONS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

fn completed_attempt<'a>(
    pending: &'a Pending,
    context: &SessionCompileContext,
) -> Result<&'a Attempt, String> {
    let mut jobs = pending
        .compile_jobs
        .iter()
        .filter(|job| job.id == context.job_id);
    let job = jobs.next().ok_or("compiler job is no longer admitted")?;
    if jobs.next().is_some()
        || job.source != context.source
        || job.superseded_by.is_some()
        || job.state != WorkState::Completed
    {
        return Err("inbox completion lacks its exact completed native job".into());
    }
    let attempt = job
        .attempts
        .last()
        .ok_or("completed compiler attempt is missing")?;
    if attempt.id != context.attempt_id
        || attempt.origin.vault_path != context.origin.vault_path
        || attempt.origin.opening_token != context.origin.opening_token
        || attempt.role_snapshot_id != context.role_snapshot.snapshot_id
        || attempt.identity != identity(context)
        || attempt.state != WorkState::Completed
        || !attempt.prepared_outputs.is_empty()
    {
        return Err("inbox completion differs from its issued native attempt".into());
    }
    let mut receipts = job
        .receipts
        .iter()
        .filter(|receipt| receipt.attempt_id == context.attempt_id);
    let receipt = receipts
        .next()
        .ok_or("native compiler completion receipt is missing")?;
    if receipts.next().is_some()
        || receipt.identity != attempt.identity
        || receipt.checks != attempt.checks
        || receipt.completed != attempt.updated
        || serde_json::to_value(&receipt.outputs).map_err(|error| error.to_string())?
            != serde_json::to_value(&attempt.outputs).map_err(|error| error.to_string())?
    {
        return Err("native compiler completion receipt differs from its exact attempt".into());
    }
    Ok(attempt)
}

fn verify_completion_at(
    root: &Path,
    pending: &Pending,
    grant: &Grant,
    native_original: &str,
    proof: &NativeSectionAuthority,
    verify_receipt: impl Fn(&crate::vault::RecordedWriteReceipt) -> Result<(), String>,
) -> Result<(), String> {
    let context = &grant.context;
    if context.role_snapshot.usage == crate::role_authorization::RoleUsage::Automatic
        && !crate::settings::read_checked()?.auto_ingest_enabled
    {
        return Err("automatic session compilation is disabled; source remains pending".into());
    }
    if super::checked_source(root, &context.source)? != native_original {
        return Err(
            "inbox bytes differ from the completed compiler original; source remains pending"
                .into(),
        );
    }
    let attempt = completed_attempt(pending, context)?;
    if grant.compiler_busy {
        return Err("native compiler runtime is still processing; source remains pending".into());
    }
    let work = grant
        .compiler
        .as_ref()
        .ok_or("fresh native compiler completion authority is unavailable")?;
    let plan = work
        .plan
        .as_ref()
        .ok_or("native compiler packet plan is unavailable")?;
    let progress = attempt
        .compiler_progress
        .as_ref()
        .ok_or("completed compiler progress is missing")?;
    let compilation = work
        .run
        .completed(plan, progress)?
        .ok_or("fresh native compiler reviews do not establish completion")?;
    if compilation.checks() != attempt.checks {
        return Err("durable completion checks differ from the native compiler artifact".into());
    }
    publication::verify_compiled(
        root,
        grant,
        &compilation,
        proof,
        &attempt.outputs,
        verify_receipt,
    )
}

/// Opening, role, queue and runtime-grant guards are held by the caller. Keep
/// section authority through commit; its recheck runs inside the caller's FILE
/// guard and must not reacquire opening/role/queue/issuer/section/FILE locks.
pub(super) fn with_verified_completion<T>(
    root: &Path,
    pending: &Pending,
    grant: &Grant,
    native_original: &str,
    commit: impl FnOnce(&Path, &dyn Fn() -> Result<(), String>) -> Result<T, String>,
) -> Result<T, String> {
    let owned = sections()
        .lock()
        .map_err(|_| "compiler section issuer lock poisoned")?;
    let key = (
        root.to_path_buf(),
        grant.context.source.key.clone(),
        grant.context.summary_path.clone(),
    );
    let proof = owned
        .get(&key)
        .ok_or("native compiled section authority is unavailable")?;
    verify_completion_at(
        root,
        pending,
        grant,
        native_original,
        proof,
        crate::vault::verify_recorded_file,
    )?;
    let recheck = || {
        let current = Pending::try_load(root)?;
        verify_completion_at(
            root,
            &current,
            grant,
            native_original,
            proof,
            crate::vault::verify_recorded_file_unlocked,
        )
    };
    commit(root, &recheck)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StepOutcome {
    pub attempt_id: String,
    pub source_revision: String,
    pub state: WorkState,
    pub step: Option<StepReceipt>,
    pub next_packet: usize,
    pub eligible_windows: usize,
    pub publication: Option<serde_json::Value>,
}

/// The captured Compilation route alone selects the local artifact. Neither
/// provider connection nor an Ask selection may replace this grant.
pub(crate) fn selected_manifest(
    vault: &VaultRoot,
    context: &SessionCompileContext,
) -> Result<&'static ModelManifest, String> {
    with_attempt(vault, context, |_, _, _| {
        if context.role_snapshot.route_signature.provider_id != "builtin-local" {
            return Err("selected external session compiler adapter is unavailable; choose an available Compilation route explicitly".into());
        }
        let route = &context.role_snapshot.route_signature;
        let manifest = local_model::manifest_for(Some(&route.model_id))?;
        if route.artifact_revision.as_deref() != Some(manifest.revision)
            || route.artifact_sha256.as_deref()
                != Some(local_model::artifact_identity(manifest).as_str())
            || route.runtime_contract != local_model::runtime_contract(manifest)
        {
            return Err("selected session compiler artifact identity changed".into());
        }
        Ok(manifest)
    })
}

pub(crate) fn authorize(vault: &VaultRoot, context: &SessionCompileContext) -> Result<(), String> {
    with_attempt(vault, context, |_, _, _| Ok(()))
}

pub(crate) fn bind_request(
    vault: &VaultRoot,
    context: &SessionCompileContext,
    request_id: &str,
    lang: &str,
) -> Result<Owner, String> {
    if !matches!(lang, "ko" | "en" | "ja") {
        return Err("unsupported compiler language".into());
    }
    with_attempt(vault, context, |_, pending, grant| {
        if grant
            .compiler
            .as_ref()
            .and_then(|work| work.language.as_deref())
            .is_some_and(|language| language != lang)
        {
            return Err("compiler language changed within an issued attempt".into());
        }
        if grant.compiler_request.is_some() || grant.compiler_busy {
            return Err("session compiler request is already running".into());
        }
        let progress = &pending
            .compile_jobs
            .iter()
            .find(|job| job.id == context.job_id)
            .ok_or("compiler job no longer admitted")?
            .attempts
            .last()
            .ok_or("compiler attempt missing")?
            .compiler_progress;
        let owner = Owner::issue(context, Some(request_id.into()), progress)?;
        grant.compiler_request = Some(request_id.into());
        Ok(owner)
    })
}

pub(crate) fn release_request(context: &SessionCompileContext, request_id: &str) {
    if let Ok(mut registry) = grants().lock() {
        if let Some(grant) = registry.get_mut(&context.attempt_id) {
            if grant.compiler_request.as_deref() == Some(request_id) {
                grant.compiler_request = None;
            }
        }
    }
}

pub(crate) fn cancel_current_request(
    vault: &VaultRoot,
    context: &SessionCompileContext,
) -> Result<(), String> {
    with_attempt(vault, context, |_, _, grant| {
        if let Some(request) = &grant.compiler_request {
            crate::local_generation::cancel(request);
        }
        Ok(())
    })
}

/// Process one exact-source packet and checkpoint it. Actual tokenizer/model
/// callbacks come from the selected native host; test callbacks prove plumbing.
#[cfg(test)]
pub(crate) fn step(
    vault: &VaultRoot,
    context: &SessionCompileContext,
    lang: &str,
    cancelled: &AtomicBool,
    token_count: impl FnMut(&str, &str) -> Result<usize, String>,
    mut generate: impl FnMut(&str, &str, i32, u32, CompilerSchema) -> Result<String, String>,
) -> Result<StepOutcome, CompileFailure> {
    step_with_decode(
        vault,
        context,
        lang,
        cancelled,
        token_count,
        |system, user, output, window, schema, _| generate(system, user, output, window, schema),
    )
}

/// Actual-model QA uses the same borrowed contract as the public local adapter.
#[cfg(test)]
pub(crate) fn step_with_decode(
    vault: &VaultRoot,
    context: &SessionCompileContext,
    lang: &str,
    cancelled: &AtomicBool,
    token_count: impl FnMut(&str, &str) -> Result<usize, String>,
    generate: impl FnMut(
        &str,
        &str,
        i32,
        u32,
        CompilerSchema,
        Option<&SessionReviewDecode>,
    ) -> Result<String, String>,
) -> Result<StepOutcome, CompileFailure> {
    step_inner(vault, context, lang, cancelled, None, token_count, generate)
}

#[cfg(test)]
pub(crate) fn step_for_request(
    vault: &VaultRoot,
    context: &SessionCompileContext,
    lang: &str,
    cancelled: &AtomicBool,
    owner: &Owner,
    token_count: impl FnMut(&str, &str) -> Result<usize, String>,
    mut generate: impl FnMut(&str, &str, i32, u32, CompilerSchema) -> Result<String, String>,
) -> Result<StepOutcome, CompileFailure> {
    step_for_request_with_decode(
        vault,
        context,
        lang,
        cancelled,
        owner,
        token_count,
        |system, user, output, window, schema, _| generate(system, user, output, window, schema),
    )
}

pub(crate) fn step_for_request_with_decode(
    vault: &VaultRoot,
    context: &SessionCompileContext,
    lang: &str,
    cancelled: &AtomicBool,
    owner: &Owner,
    token_count: impl FnMut(&str, &str) -> Result<usize, String>,
    generate: impl FnMut(
        &str,
        &str,
        i32,
        u32,
        CompilerSchema,
        Option<&SessionReviewDecode>,
    ) -> Result<String, String>,
) -> Result<StepOutcome, CompileFailure> {
    if !owner.same_context(context)? {
        return Err("compiler packet differs from its acquired request owner".into());
    }
    step_inner(
        vault,
        context,
        lang,
        cancelled,
        Some(owner),
        token_count,
        generate,
    )
}

/// Recheck the request/lease and native custody before model preparation or
/// tokenizer access. Queue finalization happens only after every guard drops.
fn preflight_retirement(
    vault: &VaultRoot,
    context: &SessionCompileContext,
    lang: &str,
    cancelled: &AtomicBool,
    owner: &Owner,
    leased: bool,
) -> Result<(), CompileFailure> {
    if !matches!(lang, "ko" | "en" | "ja") || !owner.same_context(context)? {
        return Err("compiler retirement preflight differs from its request context".into());
    }
    let mut owns_failure = true;
    let result = with_attempt(vault, context, |root, pending, grant| {
        if grant.compiler_busy != leased
            || !owner.matches(context, grant.compiler_request.as_deref())?
            || grant
                .compiler
                .as_ref()
                .and_then(|work| work.language.as_deref())
                .is_some_and(|language| language != lang)
        {
            owns_failure = false;
            return Err("compiler retirement preflight does not own this request or lease".into());
        }
        if cancelled.load(Ordering::Acquire) {
            return Err("session compilation cancelled".into());
        }
        let progress = &pending
            .compile_jobs
            .iter_mut()
            .find(|job| job.id == context.job_id)
            .ok_or("compiler job no longer admitted")?
            .active(
                &context.attempt_id,
                &context.origin,
                &context.role_snapshot.snapshot_id,
                &identity(context),
            )?
            .compiler_progress;
        if owner.checkpoint()? != progress_revision(progress)? {
            return Err("compiler checkpoint changed before custody maintenance".into());
        }
        let diagnostic = publication::maintain_custody(root, context)?;
        if cancelled.load(Ordering::Acquire) {
            return Err("session compilation cancelled".into());
        }
        Ok(diagnostic)
    });
    let failure = match result {
        Ok(diagnostic) if diagnostic.is_complete() => return Ok(()),
        Ok(diagnostic) => (
            if diagnostic.is_failed() {
                Reason::ProcessingFailed
            } else {
                Reason::CustodyRetirementPending
            },
            diagnostic.message(),
        ),
        Err(message) if !owns_failure => return Err(message.into()),
        Err(message) => (failure_reason(cancelled), message),
    };
    Err(if leased {
        failure::finalize_leased(vault, owner, failure.0, failure.1)
    } else {
        failure::finalize_idle(vault, owner, failure.0, failure.1)
    })
}

pub(crate) fn preflight_request_retirement(
    vault: &VaultRoot,
    context: &SessionCompileContext,
    lang: &str,
    cancelled: &AtomicBool,
    owner: &Owner,
) -> Result<(), CompileFailure> {
    preflight_retirement(vault, context, lang, cancelled, owner, false)
}

fn failure_reason(cancelled: &AtomicBool) -> Reason {
    if cancelled.load(Ordering::Acquire) {
        Reason::Cancelled
    } else {
        Reason::ProcessingFailed
    }
}

enum StepError {
    Unfinalized(String),
    Finalized(CompileFailure),
}

impl From<String> for StepError {
    fn from(message: String) -> Self {
        Self::Unfinalized(message)
    }
}

impl From<&str> for StepError {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}

fn preserve_unavailable_review(
    vault: &VaultRoot,
    context: &SessionCompileContext,
    cancelled: &AtomicBool,
    owner: &Owner,
    baseline: &str,
    draft: (CompilerProgress, ProcessingChecks),
    message: String,
) -> CompileFailure {
    let (progress, checks) = draft;
    let mut save_attempted = false;
    let check_cancelled = || {
        if cancelled.load(Ordering::Acquire) {
            Err("session compilation cancelled".to_string())
        } else {
            Ok(())
        }
    };
    let result = with_attempt(vault, context, |root, pending, grant| {
        check_cancelled()?;
        if !grant.compiler_busy || !owner.matches(context, grant.compiler_request.as_deref())? {
            return Err(
                "unreviewed compiler draft does not own its running request or lease".into(),
            );
        }
        if owner.checkpoint()? != baseline {
            return Err("compiler owner checkpoint changed during inference".into());
        }
        let mut jobs = pending
            .compile_jobs
            .iter_mut()
            .filter(|job| job.id == context.job_id);
        let job = jobs.next().ok_or("compiler job no longer admitted")?;
        if jobs.next().is_some() || job.state != WorkState::Running {
            return Err("unreviewed compiler draft lacks its unique running job".into());
        }
        let attempt = job.active(
            &context.attempt_id,
            &context.origin,
            &context.role_snapshot.snapshot_id,
            &identity(context),
        )?;
        if progress_revision(&attempt.compiler_progress)? != baseline {
            return Err(
                "compiler checkpoint changed during inference; unreviewed draft was not saved"
                    .into(),
            );
        }
        attempt.compiler_progress = Some(progress.clone());
        attempt.checks = checks;
        job.stop(
            &context.attempt_id,
            WorkState::Partial,
            Reason::SemanticReviewUnavailable.code().into(),
            now(),
        )?;
        check_cancelled()?;
        save_attempted = true;
        pending.save(root)?;
        owner.saved(&Some(progress))?;
        Ok(())
    });
    match result {
        Ok(()) => failure::confirmed_review_unavailable(owner, message),
        Err(error) if save_attempted => failure::unconfirmed_leased(owner, message, error),
        Err(error) => failure::finalize_leased(
            vault,
            owner,
            failure_reason(cancelled),
            format!("{message}; compiler draft adoption check: {error}"),
        ),
    }
}

fn step_inner(
    vault: &VaultRoot,
    context: &SessionCompileContext,
    lang: &str,
    cancelled: &AtomicBool,
    request_owner: Option<&Owner>,
    mut token_count: impl FnMut(&str, &str) -> Result<usize, String>,
    mut generate: impl FnMut(
        &str,
        &str,
        i32,
        u32,
        CompilerSchema,
        Option<&SessionReviewDecode>,
    ) -> Result<String, String>,
) -> Result<StepOutcome, CompileFailure> {
    let check_cancelled = || {
        if cancelled.load(Ordering::Acquire) {
            Err("session compilation cancelled".to_string())
        } else {
            Ok(())
        }
    };
    if !matches!(lang, "ko" | "en" | "ja") {
        return Err("unsupported compiler language".into());
    }
    let mut owned_admission_failure = true;
    let acquisition = check_cancelled().and_then(|()| {
        with_attempt(vault, context, |root, pending, grant| {
            if grant.compiler_busy {
                owned_admission_failure = false;
                return Err("session compiler packet is already running".into());
            }
            if grant
                .compiler
                .as_ref()
                .and_then(|work| work.language.as_deref())
                .is_some_and(|language| language != lang)
            {
                owned_admission_failure = false;
                return Err("compiler language changed within an issued attempt".into());
            }
            if match request_owner {
                Some(owner) => !owner.matches(context, grant.compiler_request.as_deref())?,
                None => grant.compiler_request.is_some(),
            } {
                owned_admission_failure = false;
                return Err("compiler packet does not own its bound request".into());
            }
            let original = super::checked_source(root, &context.source)?;
            let stored = pending
                .compile_jobs
                .iter_mut()
                .find(|job| job.id == context.job_id)
                .ok_or("compiler job no longer admitted")?
                .active(
                    &context.attempt_id,
                    &context.origin,
                    &context.role_snapshot.snapshot_id,
                    &identity(context),
                )?
                .compiler_progress
                .clone();
            let direct_owner = if let Some(owner) = request_owner {
                if owner.checkpoint()? != progress_revision(&stored)? {
                    return Err("compiler checkpoint changed before request execution".into());
                }
                None
            } else {
                Some(Owner::issue(context, None, &stored)?)
            };
            grant.compiler_busy = true;
            let work = grant.compiler.take().unwrap_or_else(|| Work::new(context));
            Ok((
                Lease {
                    attempt_id: context.attempt_id.clone(),
                    work: Some(work),
                },
                original,
                stored,
                direct_owner,
            ))
        })
    });
    let (mut lease, original, stored, direct_owner) =
        acquisition.map_err(|message| match request_owner {
            Some(owner) if owned_admission_failure => {
                failure::finalize_idle(vault, owner, failure_reason(cancelled), message)
            }
            _ => CompileFailure::from(message),
        })?;
    let owner = request_owner
        .or(direct_owner.as_ref())
        .expect("acquired compiler lease has an owner");
    preflight_retirement(vault, context, lang, cancelled, owner, true)?;
    let result = (|| -> Result<StepOutcome, StepError> {
        let baseline = progress_revision(&stored)?;
        let work = lease
            .work
            .as_mut()
            .ok_or("native compiler runtime is unavailable")?;
        let is_new_run = work.language.is_none();
        if work
            .language
            .as_deref()
            .is_some_and(|language| language != lang)
        {
            return Err("compiler language changed within an issued attempt".into());
        }
        work.language = Some(lang.into());
        if work.plan.is_none() {
            work.plan = Some(sources::prepare(
                &context.source,
                &original,
                &context.origin,
                lang,
                |system, user| token_count(system, user),
            )?);
        }
        let plan = work
            .plan
            .as_ref()
            .ok_or("compiler packet plan is unavailable")?;
        let verified = CompilationOriginal::verify(&original, &context.source.source_revision)?;
        let mut progress = match stored {
            Some(progress) if is_new_run && progress.language != lang => {
                work.run.initial_progress(plan)
            }
            Some(progress) => progress,
            None => work.run.initial_progress(plan),
        };
        let ready = work.run.completed(plan, &progress)?;
        let receipt = if ready.is_some() {
            None
        } else {
            let step = work.run.step_with_decode(
                plan,
                &verified,
                &context.origin,
                lang,
                &mut progress,
                |system, user| token_count(system, user),
                |system, user, output, window, schema, decode| {
                    check_cancelled()?;
                    authorize(vault, context)?;
                    let result = generate(system, user, output, window, schema, decode);
                    // Preserve both the model failure and a concurrent authority
                    // change rather than replacing the original error.
                    let recheck = authorize(vault, context).and_then(|()| check_cancelled());
                    match (result, recheck) {
                        (Err(error), Err(changed)) => Err(format!(
                            "{error}; compiler post-generation check: {changed}"
                        )),
                        (_, Err(changed)) => Err(changed),
                        (result, Ok(())) => result,
                    }
                },
            );
            match step {
                Ok(receipt) => Some(receipt),
                Err(message) => {
                    if let Some(checkpoint) = work.run.unavailable_checkpoint(plan, &progress)? {
                        let checks = work
                            .run
                            .unavailable_checks(plan)
                            .ok_or("unreviewed compiler draft lacks native processing checks")?;
                        return Err(StepError::Finalized(preserve_unavailable_review(
                            vault,
                            context,
                            cancelled,
                            owner,
                            &baseline,
                            (checkpoint, checks),
                            message,
                        )));
                    }
                    return Err(message.into());
                }
            }
        };
        let native = work.run.completed(plan, &progress)?;
        check_cancelled()?;
        with_attempt(vault, context, |root, pending, grant| {
            check_cancelled()?;
            let attempt = pending
                .compile_jobs
                .iter_mut()
                .find(|job| job.id == context.job_id)
                .ok_or("compiler job no longer admitted")?
                .active(
                    &context.attempt_id,
                    &context.origin,
                    &context.role_snapshot.snapshot_id,
                    &identity(context),
                )?;
            if progress_revision(&attempt.compiler_progress)? != baseline {
                return Err(
                    "compiler checkpoint changed during inference; results were not published"
                        .into(),
                );
            }
            attempt.compiler_progress = Some(progress.clone());
            attempt.updated = now();
            pending.save(root)?;
            owner.saved(&Some(progress.clone()))?;
            let (state, publication) = if let Some(native) = native {
                let mut owned = sections()
                    .lock()
                    .map_err(|_| "compiler section issuer lock poisoned")?;
                let key = (
                    root.to_path_buf(),
                    context.source.key.clone(),
                    context.summary_path.clone(),
                );
                // A missing live section can recover only update custody. The
                // publisher still requires this run's fresh native artifact;
                // durable records never restore old review/completion grants.
                let authority =
                    publication::publish_compiled(root, pending, grant, &native, owned.get(&key))?;
                owned.insert(key.clone(), authority);
                if let Some(error) = owned
                    .get(&key)
                    .and_then(|authority| authority.publication_error())
                {
                    return Err(error.to_string());
                }
                let result = publication::finish_compiled(
                    root,
                    pending,
                    grant,
                    &native,
                    owned
                        .get(&key)
                        .ok_or("native compiler section authority was not retained")?,
                )?;
                if result["ok"] != true {
                    return Err("native compiler publication did not establish completion".into());
                }
                (WorkState::Completed, Some(result))
            } else if receipt
                .as_ref()
                .is_some_and(|receipt| receipt.all_packets_seen)
            {
                let job = pending
                    .compile_jobs
                    .iter_mut()
                    .find(|job| job.id == context.job_id)
                    .ok_or("compiler job no longer admitted")?;
                let outputs = job
                    .active(
                        &context.attempt_id,
                        &context.origin,
                        &context.role_snapshot.snapshot_id,
                        &identity(context),
                    )?
                    .outputs
                    .clone();
                job.finish(
                    &context.attempt_id,
                    ProcessingChecks {
                        original_source: CheckState::Passed,
                        source_schema: CheckState::Passed,
                        semantic_review: CheckState::Rejected,
                        eligible_units: plan.windows.len(),
                        processed_units: plan.windows.len(),
                        omitted_units: 0,
                    },
                    outputs,
                    now(),
                )?;
                pending.save(root)?;
                (WorkState::Partial, None)
            } else {
                (WorkState::Running, None)
            };
            Ok(StepOutcome {
                attempt_id: context.attempt_id.clone(),
                source_revision: context.source.source_revision.clone(),
                state,
                step: receipt,
                next_packet: progress.next_packet,
                eligible_windows: plan.windows.len(),
                publication,
            })
        })
        .map_err(StepError::Unfinalized)
    })();
    match result {
        Ok(outcome) => Ok(outcome),
        Err(StepError::Unfinalized(message)) => Err(failure::finalize_leased(
            vault,
            owner,
            failure_reason(cancelled),
            message,
        )),
        Err(StepError::Finalized(error)) => Err(error),
    }
}

#[cfg(test)]
#[path = "execution_tests.rs"]
mod tests;
