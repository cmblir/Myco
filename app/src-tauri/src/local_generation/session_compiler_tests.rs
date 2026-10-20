//! Synthetic adapter ownership and preparation checks. No weights are loaded;
//! these tests do not prove model meaning, public dispatch or installed quality.

use super::*;
use crate::importers::wikify::{source_revision, Pending, PendingItem};
use crate::role_authorization::RoleUsage;
use crate::session_compile::{SourceBinding, WorkState};
use crate::settings::test_support::with_isolated_data;
use crate::vault_session::VaultRoot;
use std::sync::mpsc;
use std::time::Duration;

fn bound_fixture() -> (
    tempfile::TempDir,
    Arc<VaultRoot>,
    Arc<BoundRun>,
    Arc<AtomicBool>,
) {
    let dir = tempfile::Builder::new()
        .prefix("myco-session-adapter-synthetic-")
        .tempdir()
        .unwrap();
    let raw_path = "raw/conversations/codex/synthetic-adapter.md".to_string();
    let raw = "---\nsource: codex\nconversation_id: synthetic-adapter\ncreated: 2026-10-01\n---\n# Synthetic conversation\n\n**User:**\nPlease request the synthetic report.\n\n**Assistant:**\nI plan to draft the synthetic report; no completion is recorded.\n";
    crate::importers::wikify::append_raw(dir.path(), &raw_path, raw).unwrap();
    let source = SourceBinding {
        key: "codex:synthetic-adapter".into(),
        raw_path: raw_path.clone(),
        source_revision: source_revision(raw),
    };
    let mut pending = Pending::default();
    pending.push(PendingItem {
        key: source.key.clone(),
        raw_path,
        source_revision: source.source_revision.clone(),
        src_slug: "src-synthetic-adapter".into(),
        title: "Synthetic adapter conversation".into(),
        imported: "2026-10-10".into(),
        read_ranges: vec![],
    });
    pending.save(dir.path()).unwrap();
    let vault = Arc::new(VaultRoot::default());
    let opening = vault.begin_open().unwrap();
    vault
        .finish_open(opening, dir.path().canonicalize().unwrap(), || ())
        .unwrap();
    let context = crate::session_compile::begin(
        &vault,
        &vault.snapshot().unwrap(),
        source,
        RoleUsage::Foreground,
    )
    .unwrap();
    let request_id = format!("session-adapter-{}", context.attempt_id);
    let flag = registry().lock().unwrap().begin(&request_id).unwrap();
    let run = Run(request_id.clone());
    let owner = execution::bind_request(&vault, &context, &request_id, "en").unwrap();
    (
        dir,
        vault,
        Arc::new(BoundRun {
            context,
            request_id,
            owner,
            _run: run,
        }),
        flag,
    )
}

#[test]
fn missing_artifact_reports_preparation_without_creating_host_or_calling_model() {
    with_isolated_data("session-adapter-missing-artifact", |data| {
        let models = crate::local_model::model_dir().unwrap();
        assert_eq!(models, data.join("models"));
        std::fs::create_dir_all(&models).unwrap();
        assert!(!models.join(crate::local_model::SMALL_MODEL.file).exists());
        let state = LocalChatState::default();
        let mut callback_calls = 0;
        let result = with_model_access(
            &state,
            &AtomicBool::new(false),
            &crate::local_model::SMALL_MODEL,
            |_| callback_calls += 1,
        );
        assert!(matches!(result, Err(ModelAccessFailure::Preparation(_))));
        assert_eq!(callback_calls, 0);
        assert!(state.model.lock().unwrap().is_none());
        assert_eq!(state.last_used.load(Ordering::Acquire), 0);
    });
}

#[test]
fn pre_cancelled_access_stops_before_artifact_resolution_or_callback() {
    with_isolated_data("session-adapter-pre-cancelled", |data| {
        let state = LocalChatState::default();
        let mut callback_calls = 0;
        let result = with_model_access(
            &state,
            &AtomicBool::new(true),
            &crate::local_model::SMALL_MODEL,
            |_| callback_calls += 1,
        );
        assert!(matches!(result, Err(ModelAccessFailure::Cancelled)));
        assert_eq!(callback_calls, 0);
        assert!(state.model.lock().unwrap().is_none());
        assert_eq!(state.last_used.load(Ordering::Acquire), 0);
        assert!(!data.join("models").exists());
    });
}

#[test]
fn duplicate_registry_admission_does_not_cancel_healthy_request() {
    let mut requests = super::super::Registry::default();
    let healthy = requests.begin("synthetic-healthy-request").unwrap();
    assert!(requests.begin("synthetic-healthy-request").is_err());
    assert!(!healthy.load(Ordering::Acquire));
    assert_eq!(requests.running.len(), 1);
    assert!(Arc::ptr_eq(
        requests.running.get("synthetic-healthy-request").unwrap(),
        &healthy,
    ));
}

#[test]
fn cancel_on_drop_changes_only_acquired_flag_and_respects_disarming() {
    let mut requests = super::super::Registry::default();
    let healthy = requests.begin("synthetic-unrelated-request").unwrap();
    let acquired = requests.begin("synthetic-acquired-request").unwrap();
    drop(CancelOnDrop {
        flag: acquired.clone(),
        armed: true,
    });
    assert!(acquired.load(Ordering::Acquire));
    assert!(!healthy.load(Ordering::Acquire));
    drop(CancelOnDrop {
        flag: healthy.clone(),
        armed: false,
    });
    assert!(!healthy.load(Ordering::Acquire));
}

#[test]
fn worker_retains_binding_after_caller_drop_and_releases_it_when_drained() {
    with_isolated_data("session-adapter-worker-owner", |_| {
        let (dir, vault, bound, flag) = bound_fixture();
        let context = bound.context.clone();
        let request_id = bound.request_id.clone();
        let worker_bound = bound.clone();
        let worker_vault = vault.clone();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (drain_tx, drain_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            ready_tx.send(()).unwrap();
            drain_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            run_owned_task(&worker_vault, &worker_bound.owner, || {
                Ok::<(), CompileFailure>(())
            })
        });
        ready_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        drop(bound);
        assert!(registry().lock().unwrap().running.contains_key(&request_id));
        assert!(!flag.load(Ordering::Acquire));
        let retry_id = format!("session-rebind-{}", context.attempt_id);
        assert!(execution::bind_request(&vault, &context, &retry_id, "en").is_err());
        drain_tx.send(()).unwrap();
        worker.join().unwrap().unwrap();
        assert!(!registry().lock().unwrap().running.contains_key(&request_id));
        assert_eq!(
            Pending::try_load(dir.path()).unwrap().compile_jobs[0].state,
            WorkState::Running,
        );
        let _fresh_owner = execution::bind_request(&vault, &context, &retry_id, "en").unwrap();
        execution::release_request(&context, &retry_id);
    });
}

#[test]
fn detached_worker_panic_finalizes_task_failure_before_releasing_request() {
    with_isolated_data("session-adapter-worker-panic", |_| {
        let (dir, vault, bound, flag) = bound_fixture();
        let context = bound.context.clone();
        let request_id = bound.request_id.clone();
        let original = std::fs::read(dir.path().join(&context.source.raw_path)).unwrap();
        let before = Pending::try_load(dir.path()).unwrap();
        let checks = serde_json::to_value(&before.compile_jobs[0].attempts[0].checks).unwrap();
        let worker_bound = bound.clone();
        let worker_vault = vault.clone();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (panic_tx, panic_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            ready_tx.send(()).unwrap();
            panic_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            run_owned_task(
                &worker_vault,
                &worker_bound.owner,
                || -> Result<(), CompileFailure> {
                    panic!("synthetic panic detail must not be persisted");
                },
            )
        });
        ready_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        drop(bound);
        assert!(registry().lock().unwrap().running.contains_key(&request_id));
        assert!(!flag.load(Ordering::Acquire));
        assert!(execution::bind_request(&vault, &context, "synthetic-duplicate", "en").is_err());
        panic_tx.send(()).unwrap();
        let error = worker.join().unwrap().unwrap_err();
        assert_eq!(error.message, "local session compilation task panicked");
        assert!(error.finalization_error.is_none());
        let outcome = error.outcome.unwrap();
        assert_eq!(outcome.attempt_id, context.attempt_id);
        assert_eq!(outcome.source_revision, context.source.source_revision);
        assert_eq!(outcome.compile_signature, context.compile_signature);
        assert_eq!(outcome.request_id.as_deref(), Some(request_id.as_str()));
        assert_eq!(outcome.state, WorkState::Failed);
        assert!(matches!(outcome.reason, Reason::TaskFailed));
        assert!(!registry().lock().unwrap().running.contains_key(&request_id));
        let pending = Pending::try_load(dir.path()).unwrap();
        let job = &pending.compile_jobs[0];
        let attempt = job.attempts.last().unwrap();
        assert_eq!(job.state, WorkState::Failed);
        assert_eq!(attempt.state, WorkState::Failed);
        assert_eq!(job.reason.as_deref(), Some("task_failed"));
        assert_eq!(attempt.reason.as_deref(), Some("task_failed"));
        assert_eq!(serde_json::to_value(&attempt.checks).unwrap(), checks);
        assert!(attempt.compiler_progress.is_none());
        assert!(attempt.outputs.is_empty());
        assert!(attempt.prepared_outputs.is_empty());
        assert!(job.receipts.is_empty());
        assert!(pending
            .pending
            .iter()
            .any(|item| item.key == context.source.key));
        assert!(!dir.path().join(&context.summary_path).exists());
        assert_eq!(
            std::fs::read(dir.path().join(&context.source.raw_path)).unwrap(),
            original,
        );
    });
}
