//! Actual local model adapter for one source-bound session compilation packet.

use super::{registry, with_model_access, LocalChatState, ModelAccessFailure, Run};
use crate::local_llm::GenerationSchema;
use crate::session_compile::compiler::CompilerSchema;
use crate::session_compile::failure::{self, CompileFailure, Owner, Reason};
use crate::session_compile::{execution, SessionCompileContext};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Manager;

struct BoundRun {
    context: SessionCompileContext,
    request_id: String,
    owner: Owner,
    _run: Run,
}
impl Drop for BoundRun {
    fn drop(&mut self) {
        execution::release_request(&self.context, &self.request_id);
    }
}

/// Dropping the transport cancels only its actually acquired flag. The worker
/// retains BoundRun until it drains, including when the await side is revoked.
struct CancelOnDrop {
    flag: Arc<AtomicBool>,
    armed: bool,
}
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if self.armed {
            self.flag.store(true, Ordering::Release);
        }
    }
}

pub(crate) async fn compile_session_packet(
    app: tauri::AppHandle,
    state: LocalChatState,
    context: SessionCompileContext,
    request_id: String,
    lang: String,
) -> Result<execution::StepOutcome, CompileFailure> {
    let manifest =
        execution::selected_manifest(&app.state::<crate::vault_session::VaultRoot>(), &context)?;
    if !matches!(lang.as_str(), "ko" | "en" | "ja") {
        return Err("unsupported compiler language".into());
    }
    let flag = registry()
        .lock()
        .map_err(|_| "local synthesis state poisoned")?
        .begin(&request_id)?;
    let run = Run(request_id.clone());
    let owner = execution::bind_request(
        &app.state::<crate::vault_session::VaultRoot>(),
        &context,
        &request_id,
        &lang,
    )?;
    let bound = Arc::new(BoundRun {
        context,
        request_id,
        owner,
        _run: run,
    });
    let mut cancel_on_drop = CancelOnDrop {
        flag: flag.clone(),
        armed: true,
    };
    let worker = bound.clone();
    let worker_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let vault = worker_app.state::<crate::vault_session::VaultRoot>();
        run_preflighted_task(&vault, &worker.context, &worker.owner, &lang, &flag, || {
            let result = with_model_access(&state, &flag, manifest, |model| {
                execution::step_for_request_with_decode(
                    &vault,
                    &worker.context,
                    &lang,
                    &flag,
                    &worker.owner,
                    |system, user| {
                        if flag.load(Ordering::Acquire) {
                            return Err("session compilation cancelled".into());
                        }
                        model.chat_token_count(system, user)
                    },
                    |system, user, output, window, schema, decode| match (schema, decode) {
                        (CompilerSchema::Review, Some(contract)) => model
                            .generate_session_review_cancellable(
                                system, user, output, window, contract, &flag,
                            ),
                        (CompilerSchema::Claims, None) => model.generate_structured_cancellable(
                            system,
                            user,
                            output,
                            window,
                            GenerationSchema::WikiClaimsV1,
                            &flag,
                        ),
                        (CompilerSchema::Compilation, None) => model
                            .generate_structured_cancellable(
                                system,
                                user,
                                output,
                                window,
                                GenerationSchema::SessionStructureV1,
                                &flag,
                            ),
                        _ => Err("compiler decode contract does not match generation stage".into()),
                    },
                )
            });
            match result {
                Ok(result) => result,
                Err(error) => {
                    let reason = if flag.load(Ordering::Acquire) {
                        Reason::Cancelled
                    } else {
                        match &error {
                            ModelAccessFailure::Preparation(_) => {
                                Reason::ModelPreparationUnavailable
                            }
                            ModelAccessFailure::Host(_) => Reason::ModelHostFailed,
                            ModelAccessFailure::Cancelled => Reason::Cancelled,
                        }
                    };
                    Err(failure::finalize_idle(
                        &vault,
                        &worker.owner,
                        reason,
                        error.message(),
                    ))
                }
            }
        })
    })
    .await;
    cancel_on_drop.armed = false;
    match result {
        Ok(result) => result,
        Err(error) => Err(failure::finalize_idle(
            &app.state::<crate::vault_session::VaultRoot>(),
            &bound.owner,
            Reason::TaskFailed,
            format!("local session compilation task: {error}"),
        )),
    }
}

/// This is the actual model-access boundary, also exercised with a synthetic
/// access closure. A pending predecessor never prepares or loads a model.
pub(crate) fn run_preflighted_task<T>(
    vault: &crate::vault_session::VaultRoot,
    context: &SessionCompileContext,
    owner: &Owner,
    lang: &str,
    flag: &AtomicBool,
    access: impl FnOnce() -> Result<T, CompileFailure>,
) -> Result<T, CompileFailure> {
    run_owned_task(vault, owner, || {
        execution::preflight_request_retirement(vault, context, lang, flag, owner)?;
        access()
    })
}

/// Catch inside the worker so detached transports still finalize task failure
/// while their private request owner remains alive. No panic text is persisted.
fn run_owned_task<T>(
    vault: &crate::vault_session::VaultRoot,
    owner: &Owner,
    run: impl FnOnce() -> Result<T, CompileFailure>,
) -> Result<T, CompileFailure> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(run)).unwrap_or_else(|_| {
        Err(failure::finalize_idle(
            vault,
            owner,
            Reason::TaskFailed,
            "local session compilation task panicked".into(),
        ))
    })
}

#[cfg(test)]
#[path = "session_compiler_tests.rs"]
mod tests;
