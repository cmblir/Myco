//! Native-owned format attempts; no authority locks are held during inference.

use super::{script, AudioOverviewRegistry, Draft, DraftContext, Job, JobContext, StoredDraft};
use crate::local_generation::LocalChatState;
use crate::role_authorization::RoleSnapshot;
use crate::vault_session::VaultRoot;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Manager;

#[derive(Clone)]
pub(crate) struct GenerationInput {
    pub attempt: usize,
    pub system: String,
    pub user: String,
    pub role_snapshot: RoleSnapshot,
    pub request_id: String,
    pub cancelled: Arc<AtomicBool>,
}

pub(super) fn request_id(job: &Job, attempt: usize) -> String {
    format!("audio-{}-{attempt}", job.context.job_id)
}

struct ActiveOwner(Arc<AtomicBool>);
impl Drop for ActiveOwner {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

struct CancelOnDrop {
    registry: AudioOverviewRegistry,
    context: JobContext,
    armed: bool,
}

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        if self.armed {
            if let Err(error) = super::cancel(&self.registry, &self.context) {
                eprintln!("audio caller drop cancellation failed: {error}");
            }
        }
    }
}

fn postcheck(
    state: &VaultRoot,
    registry: &AudioOverviewRegistry,
    context: &JobContext,
) -> Result<(), String> {
    super::with_job_checked(state, registry, context, true, |root, job| {
        crate::vault::with_root_mutation(root, |root, _writer| {
            job.sources.verify(root)?;
            if job.cancelled.load(Ordering::Acquire) {
                return Err("audio generation cancelled".into());
            }
            Ok(())
        })
    })
}

/// The callback receives only native-captured, immutable inputs. Its result is
/// rechecked on success and failure before it can become a private draft.
pub(crate) async fn generate_with<F, Fut>(
    state: &VaultRoot,
    registry: &AudioOverviewRegistry,
    context: &JobContext,
    mut generate: F,
) -> Result<Draft, String>
where
    F: FnMut(GenerationInput) -> Fut,
    Fut: Future<Output = Result<String, String>>,
{
    let job = super::with_job(state, registry, context, |root, job| {
        crate::vault::with_root_mutation(root, |root, _writer| job.sources.verify(root))?;
        let lifecycle = job
            .lifecycle
            .lock()
            .map_err(|_| "audio lifecycle lock poisoned")?;
        if lifecycle.draft.is_some() || lifecycle.publication.is_some() {
            return Err("audio job already has a native draft".into());
        }
        job.active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "audio generation is already busy")?;
        Ok(job.clone())
    })?;
    let _active = ActiveOwner(job.active.clone());
    let mut drop_guard = CancelOnDrop {
        registry: registry.clone(),
        context: context.clone(),
        armed: true,
    };
    let system = script::system()?;
    let mut final_shape_error = String::new();
    for attempt in 0..2 {
        postcheck(state, registry, context)?;
        let input = GenerationInput {
            attempt,
            system: system.clone(),
            user: job.sources.user.as_ref().clone(),
            role_snapshot: job.role.clone(),
            request_id: request_id(&job, attempt),
            cancelled: job.cancelled.clone(),
        };
        // A callback can be an actual local worker. Revocation sets its flag
        // while retaining the owner until that worker reports terminal output.
        let future = generate(input);
        tokio::pin!(future);
        let mut ticker = tokio::time::interval(std::time::Duration::from_millis(25));
        ticker.tick().await;
        let mut authority_error = None;
        let result = loop {
            tokio::select! {
                result = &mut future => break result,
                _ = ticker.tick(), if authority_error.is_none() => {
                    if let Err(error) = super::with_job(state, registry, context, |_, _| Ok(())) {
                        super::signal_cancel(&job);
                        authority_error = Some(error);
                    }
                }
            }
        };
        // Do not use `result?` until all original sources and foreground
        // authority have been checked, including failed format/model calls.
        let checked = postcheck(state, registry, context);
        if let Some(error) = authority_error {
            return Err(error);
        }
        checked?;
        let raw = result?;
        match script::parse(&raw, &job.sources.cites) {
            Ok(turns) => {
                let draft = super::with_job(state, registry, context, |root, current| {
                    crate::vault::with_root_mutation(root, |root, _writer| {
                        current.sources.verify(root)?;
                        let mut lifecycle = current
                            .lifecycle
                            .lock()
                            .map_err(|_| "audio lifecycle lock poisoned")?;
                        if lifecycle.draft.is_some() || lifecycle.publication.is_some() {
                            return Err("audio job already has a native draft".into());
                        }
                        let draft = Draft {
                            title: current.title.clone(),
                            turns,
                            source_pages: current.sources.coverage.included_pages.clone(),
                            context: DraftContext {
                                job_id: context.job_id.clone(),
                                origin: context.origin.clone(),
                                draft_id: super::issued_id()?,
                            },
                            coverage: current.sources.coverage.clone(),
                        };
                        lifecycle.draft = Some(StoredDraft {
                            markdown: script::transcript(&draft, &current.date_iso),
                            draft: draft.clone(),
                        });
                        Ok(draft)
                    })
                })?;
                drop_guard.armed = false;
                return Ok(draft);
            }
            Err(error) => final_shape_error = error,
        }
    }
    Err(format!(
        "the model did not return a valid audio dialogue: {final_shape_error}"
    ))
}

/// Execute the selected route without fallback, download or filesystem tools.
/// The owned task survives an IPC future drop, cancelling its exact local run
/// and releasing its registry owner only when generation has actually ended.
pub(crate) async fn generate(
    app: tauri::AppHandle,
    local: LocalChatState,
    state: &VaultRoot,
    registry: &AudioOverviewRegistry,
    context: &JobContext,
) -> Result<Draft, String> {
    super::with_job(state, registry, context, |_, _| Ok(()))?;
    let registry = registry.clone();
    let context = context.clone();
    let mut drop_guard = CancelOnDrop {
        registry: registry.clone(),
        context: context.clone(),
        armed: true,
    };
    let task = tauri::async_runtime::spawn(async move {
        let vault = app.state::<VaultRoot>();
        generate_with(&vault, &registry, &context, |input| {
            let app = app.clone();
            let local = local.clone();
            async move {
                if input.cancelled.load(Ordering::Acquire) {
                    return Err("audio generation cancelled".into());
                }
                if input.attempt > 1 {
                    return Err("invalid native audio format attempt".into());
                }
                let route = &input.role_snapshot.route_signature;
                if route.provider_id == "builtin-local" {
                    crate::local_generation::generate_text(
                        app,
                        local,
                        &route.model_id,
                        &input.request_id,
                        &input.system,
                        &input.user,
                        768,
                    )
                    .await
                } else {
                    let vault = app.state::<VaultRoot>();
                    let request = crate::providers::ChatRequest {
                        provider_id: route.provider_id.clone(),
                        model: route.model_id.clone(),
                        messages: vec![
                            crate::providers::ChatMessage {
                                role: "system".into(),
                                content: input.system,
                            },
                            crate::providers::ChatMessage {
                                role: "user".into(),
                                content: input.user,
                            },
                        ],
                        temperature: None,
                        max_tokens: Some(768),
                    };
                    crate::commands::chat_complete_authorized(
                        &vault,
                        request,
                        Some(input.role_snapshot.origin.clone()),
                        Some(input.role_snapshot),
                    )
                    .await
                    .map(|response| response.content)
                }
            }
        })
        .await
    });
    let result = task
        .await
        .map_err(|error| format!("audio generation task failed: {error}"))?;
    drop_guard.armed = false;
    result
}
