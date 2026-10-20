//! Child-only native checkpoint stages. An OS kill skips all graceful cleanup;
//! synthetic reviews test authority plumbing, not real model meaning.

use super::*;
use crate::session_compile as session;

#[test]
#[ignore = "only spawned with explicit synthetic paths by the OS process recovery regression"]
fn synthetic_checkpoint_recovery_child() {
    let root = PathBuf::from(
        std::env::var_os(ROOT_ENV)
            .expect("synthetic recovery root is required; no private vault fallback"),
    );
    assert!(root.is_absolute());
    assert_eq!(root.canonicalize().unwrap(), root);
    assert!(root
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("myco-compiler-execution-synthetic-"));
    assert_eq!(
        std::fs::read_to_string(root.join("process-recovery.marker")).unwrap(),
        MARKER
    );
    let registration: Registration =
        serde_json::from_slice(&std::fs::read(root.join("process-registration.json")).unwrap())
            .unwrap();
    assert_eq!(registration.version, 1);
    assert_eq!(registration.vault, root);
    let data = PathBuf::from(
        std::env::var_os("MYCO_DATA_DIR")
            .expect("shared synthetic app data is required; no real app-data fallback"),
    );
    assert!(data.is_absolute());
    assert_eq!(data.canonicalize().unwrap(), registration.data);
    assert!(std::env::var_os("MEMEX_DATA_DIR").is_none());
    assert_eq!(
        crate::settings::settings_dir()
            .unwrap()
            .canonicalize()
            .unwrap(),
        registration.data
    );
    assert!(!registration.data.join("models").exists());
    match std::env::var(PHASE_ENV).unwrap().as_str() {
        "prepare" => prepare_checkpoint(&registration),
        "recover" => recover_checkpoint(&registration),
        "complete-r1" => complete_first_revision(&registration),
        "append-r2" => refresh_appended_revision(&registration),
        phase => panic!("unknown synthetic recovery phase: {phase}"),
    }
}

fn open_native(root: &Path) -> VaultRoot {
    let vault = VaultRoot::default();
    reopen(&vault, root);
    vault
}

fn prepare_checkpoint(registration: &Registration) {
    let root = &registration.vault;
    let vault = open_native(root);
    let context = session::begin(
        &vault,
        &vault.snapshot().unwrap(),
        registration.source.clone(),
        registration.usage,
    )
    .unwrap();
    assert_eq!(context.summary_path, "wiki/session.md");
    let first = step(
        &vault,
        &context,
        "en",
        &AtomicBool::new(false),
        |_, _| Ok(800),
        |_, user, _, _, schema| model(schema, user, false),
    )
    .unwrap();
    assert_eq!(first.state, WorkState::Running);
    assert_eq!(first.next_packet, 1);
    assert!(first.eligible_windows > 1);
    assert!(first.step.unwrap().review_accepted);
    assert!(first.publication.is_none());
    let pending = Pending::try_load(root).unwrap();
    let attempt = &pending.compile_jobs[0].attempts[0];
    let progress = attempt.compiler_progress.as_ref().unwrap();
    assert_eq!(progress.next_packet, 1);
    assert_eq!(progress.batches.len(), 1);
    assert!(progress.batches[0].review_output.is_some());
    assert!(attempt.outputs.is_empty());
    assert!(attempt.prepared_outputs.is_empty());
    assert!(pending.compile_jobs[0].receipts.is_empty());
    let original = std::fs::read_to_string(root.join(&context.source.raw_path)).unwrap();
    let human = std::fs::read_to_string(root.join(&context.summary_path)).unwrap();
    let request = format!("synthetic-process-crash-{}", context.attempt_id);
    let owner = bind_request(&vault, &context, &request, "en").unwrap();
    let result = step_for_request(
        &vault,
        &context,
        "en",
        &AtomicBool::new(false),
        &owner,
        |_, _| Ok(800),
        |_, _, _, _, schema| {
            assert_eq!(schema, CompilerSchema::Claims);
            assert_eq!(
                vault.snapshot().unwrap().opening_token,
                context.origin.opening_token
            );
            let registry = grants().lock().unwrap();
            let grant = registry.get(&context.attempt_id).unwrap();
            assert!(grant.compiler_busy);
            assert_eq!(grant.compiler_request.as_deref(), Some(request.as_str()));
            drop(registry);
            let queue = std::fs::read_to_string(Pending::path(root)).unwrap();
            let ready = CheckpointReady {
                version: 1,
                child_pid: std::process::id(),
                context: context.clone(),
                queue_sha256: source_revision(&queue),
                old_attempt: serde_json::to_value(attempt).unwrap(),
                original_sha256: source_revision(&original),
                human_sha256: source_revision(&human),
                bound_request: request.clone(),
                compiler_busy: true,
            };
            crate::settings::atomic_write(
                &root.join("checkpoint-ready.json"),
                &serde_json::to_vec(&ready).unwrap(),
            )
            .unwrap();
            // Parent observes this process alive and kills it while its actual
            // packet lease/request owner remain active. No Drop path is run.
            loop {
                std::thread::park();
            }
        },
    );
    match result {
        Ok(_) => panic!("parent OS kill did not interrupt the active synthetic packet"),
        Err(error) => panic!("synthetic crash packet failed before OS kill: {error}"),
    }
}

fn assert_old_context_refused(
    vault: &VaultRoot,
    root: &Path,
    old: &SessionCompileContext,
    expected_queue: &[u8],
) {
    assert!(session::read(vault, old, &old.source.raw_path).is_err());
    assert!(session::publish(
        vault,
        old,
        &old.summary_path,
        "Synthetic refused old-process replacement",
        None
    )
    .is_err());
    assert!(session::complete(vault, old, std::slice::from_ref(&old.summary_path)).is_err());
    let error = step(
        vault,
        old,
        "en",
        &AtomicBool::new(false),
        |_, _| panic!("old process context must not tokenize"),
        |_, _, _, _, _| panic!("old process context must not generate"),
    )
    .err()
    .expect("old process context must be rejected before owner acquisition");
    assert!(error.outcome.is_none());
    assert!(error.finalization_error.is_none());
    assert_eq!(std::fs::read(Pending::path(root)).unwrap(), expected_queue);
}

fn recover_checkpoint(registration: &Registration) {
    let root = &registration.vault;
    let ready: CheckpointReady =
        serde_json::from_slice(&std::fs::read(root.join("checkpoint-ready.json")).unwrap())
            .unwrap();
    let old = &ready.context;
    let queue_before = std::fs::read(Pending::path(root)).unwrap();
    assert_eq!(
        source_revision(std::str::from_utf8(&queue_before).unwrap()),
        ready.queue_sha256
    );
    let crashed = Pending::try_load(root).unwrap();
    assert_eq!(crashed.compile_jobs[0].state, WorkState::Running);
    assert_eq!(
        serde_json::to_value(&crashed.compile_jobs[0].attempts[0]).unwrap(),
        ready.old_attempt
    );
    let vault = open_native(root);
    let origin = vault.snapshot().unwrap();
    assert_ne!(origin.opening_token, old.origin.opening_token);
    assert_eq!(origin.vault_path, old.origin.vault_path);
    let view = session::list_at(root, &origin, 3).unwrap();
    assert_eq!(view.pending_total, 1);
    assert_eq!(view.items[0].compilation_state, WorkState::Pending);
    assert_eq!(
        view.items[0].compilation_reason.as_deref(),
        Some("compiler_runtime_revalidation_required")
    );
    assert_eq!(view.items[0].key, old.source.key);
    assert_eq!(std::fs::read(Pending::path(root)).unwrap(), queue_before);
    assert_old_context_refused(&vault, root, old, &queue_before);

    let fresh = session::begin(
        &vault,
        &origin,
        registration.source.clone(),
        registration.usage,
    )
    .unwrap();
    assert_ne!(fresh.attempt_id, old.attempt_id);
    assert_ne!(
        fresh.role_snapshot.snapshot_id,
        old.role_snapshot.snapshot_id
    );
    assert_eq!(fresh.source, old.source);
    assert_eq!(fresh.compile_signature, old.compile_signature);
    assert_eq!(fresh.origin.opening_token, origin.opening_token);
    let begun = Pending::try_load(root).unwrap();
    let job = &begun.compile_jobs[0];
    assert_eq!(job.attempts.len(), 2);
    assert_eq!(job.attempts[0].state, WorkState::Stopped);
    assert_eq!(
        job.attempts[0].reason.as_deref(),
        Some("expired_origin_or_role_requires_new_attempt")
    );
    let mut retained = serde_json::to_value(&job.attempts[0]).unwrap();
    for field in ["state", "reason", "updated"] {
        retained[field] = ready.old_attempt[field].clone();
    }
    assert_eq!(retained, ready.old_attempt);
    assert_eq!(job.attempts[1].state, WorkState::Running);
    assert_eq!(
        serde_json::to_value(&job.attempts[1].compiler_progress).unwrap(),
        ready.old_attempt["compilerProgress"]
    );
    assert_eq!(job.attempts[1].checks, ProcessingChecks::default());
    assert!(job.attempts[1].outputs.is_empty());
    assert!(job.attempts[1].prepared_outputs.is_empty());
    let begun_bytes = std::fs::read(Pending::path(root)).unwrap();
    assert_old_context_refused(&vault, root, old, &begun_bytes);
    assert!(session::complete(&vault, &fresh, std::slice::from_ref(&fresh.summary_path)).is_err());
    assert_eq!(std::fs::read(Pending::path(root)).unwrap(), begun_bytes);
    assert_eq!(
        session::list_at(root, &origin, 3).unwrap().items[0].compilation_state,
        WorkState::Running
    );

    let request = format!("synthetic-process-recover-{}", fresh.attempt_id);
    let owner = bind_request(&vault, &fresh, &request, "en").unwrap();
    let mut calls = Vec::new();
    let outcome = step_for_request(
        &vault,
        &fresh,
        "en",
        &AtomicBool::new(false),
        &owner,
        |_, _| Ok(800),
        |_, user, _, _, schema| {
            calls.push(schema);
            assert_eq!(
                schema,
                CompilerSchema::Review,
                "a new runtime must review the stored first packet before visiting the next packet"
            );
            model(schema, user, true)
        },
    )
    .unwrap();
    release_request(&fresh, &request);
    assert_eq!(calls, vec![CompilerSchema::Review]);
    let review = outcome.step.as_ref().unwrap();
    assert_eq!(review.packet_index, 0);
    assert!(!review.review_accepted);
    assert_eq!(outcome.next_packet, 1);
    assert_eq!(outcome.state, WorkState::Running);
    assert!(outcome.publication.is_none());
    let recovered = Pending::try_load(root).unwrap();
    let new_attempt = &recovered.compile_jobs[0].attempts[1];
    let fresh_progress = new_attempt.compiler_progress.as_ref().unwrap();
    assert_ne!(
        fresh_progress.batches[0].review_output,
        crashed.compile_jobs[0].attempts[0]
            .compiler_progress
            .as_ref()
            .unwrap()
            .batches[0]
            .review_output
    );
    assert!(new_attempt.outputs.is_empty());
    assert!(new_attempt.prepared_outputs.is_empty());
    assert_eq!(new_attempt.checks, ProcessingChecks::default());
    assert_eq!(
        serde_json::to_value(&recovered.compile_jobs[0].attempts[0]).unwrap(),
        serde_json::to_value(&begun.compile_jobs[0].attempts[0]).unwrap()
    );
    assert!(recovered.compile_jobs[0].receipts.is_empty());
    assert_eq!(recovered.pending, crashed.pending);
    assert_eq!(recovered.receipts, crashed.receipts);
    assert_eq!(recovered.done_count, crashed.done_count);
    assert_eq!(
        source_revision(&std::fs::read_to_string(root.join(&old.source.raw_path)).unwrap()),
        ready.original_sha256
    );
    assert_eq!(
        source_revision(&std::fs::read_to_string(root.join(&old.summary_path)).unwrap()),
        ready.human_sha256
    );
    assert!(!registration.data.join("models").exists());
    let reviewed_bytes = std::fs::read(Pending::path(root)).unwrap();
    assert_old_context_refused(&vault, root, old, &reviewed_bytes);
    assert!(session::complete(&vault, &fresh, std::slice::from_ref(&fresh.summary_path)).is_err());
    assert_eq!(std::fs::read(Pending::path(root)).unwrap(), reviewed_bytes);
    let result = json!({"version":1,"childPid":std::process::id(),"usage":registration.usage,
        "oldOpening":old.origin.opening_token,"freshOpening":origin.opening_token,
        "oldAttempt":old.attempt_id,"freshAttempt":fresh.attempt_id,
        "viewStateBeforeBegin":view.items[0].compilation_state,
        "viewReasonBeforeBegin":view.items[0].compilation_reason,
        "freshReviewCalls":calls.len(),"freshReviewAccepted":review.review_accepted,
        "freshReviewPacket":review.packet_index,"stateAfterFreshReview":outcome.state,
        "modelInference":false,"generationCallbacks":"synthetic","publicWry":false,
        "installedApp":false,"egressObserved":false,"powerLossTested":false});
    crate::settings::atomic_write(
        &root.join("recovery-result.json"),
        &serde_json::to_vec(&result).unwrap(),
    )
    .unwrap();
    println!("SYNTHETIC_CHECKPOINT_RECOVERED={result}");
}

fn compile_revision(
    vault: &VaultRoot,
    context: &SessionCompileContext,
    calls: &mut Vec<String>,
) -> Result<StepOutcome, CompileFailure> {
    let raw = session::checked_source(&PathBuf::from(&context.origin.vault_path), &context.source)
        .unwrap();
    let plan =
        session::sources::prepare(&context.source, &raw, &context.origin, "en", |_, _| Ok(800))
            .unwrap();
    assert!(!plan.windows.is_empty());
    let mut last = None;
    for index in 0..plan.windows.len() {
        let outcome = step(
            vault,
            context,
            "en",
            &AtomicBool::new(false),
            |_, _| Ok(800),
            |_, user, _, _, schema| {
                calls.push(format!("{schema:?}"));
                session::compiler::fixture_model(schema, user, false)
            },
        )?;
        assert_eq!(outcome.next_packet, index + 1);
        assert!(outcome.step.as_ref().unwrap().review_accepted);
        last = Some(outcome);
    }
    Ok(last.unwrap())
}

fn complete_first_revision(registration: &Registration) {
    let root = &registration.vault;
    let vault = open_native(root);
    let context = session::begin(
        &vault,
        &vault.snapshot().unwrap(),
        registration.source.clone(),
        registration.usage,
    )
    .unwrap();
    assert_eq!(context.role_snapshot.usage, registration.usage);
    assert!(!root.join(&context.summary_path).exists());
    let mut calls = Vec::new();
    let outcome = compile_revision(&vault, &context, &mut calls).unwrap();
    assert_eq!(outcome.state, WorkState::Completed);
    assert!(outcome.publication.is_some());
    assert!(sections().lock().unwrap().contains_key(&(
        root.to_path_buf(),
        context.source.key.clone(),
        context.summary_path.clone()
    )));
    let pending = Pending::try_load(root).unwrap();
    let job = pending
        .compile_jobs
        .iter()
        .find(|job| job.id == context.job_id)
        .unwrap();
    assert_eq!(job.state, WorkState::Completed);
    assert_eq!(job.receipts.len(), 1);
    assert!(job.attempts.last().unwrap().checks.completed_compilation());
    let ready = CompletedRevisionReady {
        child_pid: std::process::id(),
        canonical_sha256: source_revision(
            &std::fs::read_to_string(root.join(&context.summary_path)).unwrap(),
        ),
        original_sha256: source_revision(
            &std::fs::read_to_string(root.join(&context.source.raw_path)).unwrap(),
        ),
        reviewed_packets: outcome.eligible_windows,
        context,
    };
    crate::settings::atomic_write(
        &root.join("completed-revision-ready.json"),
        &serde_json::to_vec(&ready).unwrap(),
    )
    .unwrap();
    println!(
        "SYNTHETIC_R1_NATIVE_COMPLETED={}",
        json!({"childPid":ready.child_pid,
        "context":ready.context,"reviewedPackets":ready.reviewed_packets,"stages":calls,
        "modelInference":false,"generationCallbacks":"synthetic"})
    );
}

fn refresh_appended_revision(registration: &Registration) {
    let root = &registration.vault;
    let first: CompletedRevisionReady =
        serde_json::from_slice(&std::fs::read(root.join("completed-revision-ready.json")).unwrap())
            .unwrap();
    assert_ne!(std::process::id(), first.child_pid);
    let previous_private_authority = sections().lock().unwrap().contains_key(&(
        root.to_path_buf(),
        first.context.source.key.clone(),
        first.context.summary_path.clone(),
    ));
    assert!(!previous_private_authority);
    let vault = open_native(root);
    let origin = vault.snapshot().unwrap();
    assert_ne!(origin.opening_token, first.context.origin.opening_token);
    let old_context_refused = authorize(&vault, &first.context).is_err();
    assert!(old_context_refused);
    let original = std::fs::read_to_string(root.join(&registration.source.raw_path)).unwrap();
    assert_eq!(source_revision(&original), first.original_sha256);
    let before = std::fs::read_to_string(root.join(&first.context.summary_path)).unwrap();
    assert!(before.ends_with(HUMAN_POSTSCRIPT));
    let next_raw = original.clone() + APPENDED_REVISION_TURN;
    let source = SourceBinding {
        key: registration.source.key.clone(),
        raw_path: APPENDED_REVISION_PATH.into(),
        source_revision: source_revision(&next_raw),
    };
    crate::importers::wikify::append_raw(root, &source.raw_path, &next_raw).unwrap();
    let mut pending = Pending::try_load(root).unwrap();
    pending.push(PendingItem {
        key: source.key.clone(),
        raw_path: source.raw_path.clone(),
        source_revision: source.source_revision.clone(),
        src_slug: "src-synthetic-native".into(),
        title: "Synthetic conversation R2".into(),
        imported: "2026-10-09".into(),
        read_ranges: vec![],
    });
    pending.save(root).unwrap();
    let context = session::begin(&vault, &origin, source.clone(), registration.usage).unwrap();
    assert_eq!(context.role_snapshot.usage, registration.usage);
    assert_eq!(context.summary_path, first.context.summary_path);
    assert_ne!(context.attempt_id, first.context.attempt_id);
    assert_ne!(
        context.role_snapshot.snapshot_id,
        first.context.role_snapshot.snapshot_id
    );
    let mut calls = Vec::new();
    let outcome = compile_revision(&vault, &context, &mut calls);
    let completed = outcome.as_ref().is_ok_and(|outcome| {
        outcome.state == WorkState::Completed && outcome.publication.is_some()
    });
    let failure = outcome
        .as_ref()
        .err()
        .map(|error| serde_json::to_value(error).unwrap());
    if let Some(error) = outcome.as_ref().err() {
        eprintln!("SYNTHETIC_R2_NATIVE_REFRESH_REFUSED={error}");
        assert_eq!(
            std::fs::read_to_string(root.join(&context.summary_path)).unwrap(),
            before
        );
    }
    assert_eq!(
        std::fs::read_to_string(root.join(&registration.source.raw_path)).unwrap(),
        original
    );
    assert_eq!(
        std::fs::read_to_string(root.join(&source.raw_path)).unwrap(),
        next_raw
    );
    let pending = Pending::try_load(root).unwrap();
    let job = pending
        .compile_jobs
        .iter()
        .find(|job| job.id == context.job_id)
        .unwrap();
    let progress = job
        .attempts
        .last()
        .unwrap()
        .compiler_progress
        .as_ref()
        .unwrap();
    let result = json!({"childPid":std::process::id(),"completed":completed,"failure":failure,
        "freshOpening":origin.opening_token,"freshAttempt":context.attempt_id,
        "canonicalPath":context.summary_path,"source":source,"usage":context.role_snapshot.usage,
        "previousPrivateAuthorityPresent":previous_private_authority,"oldContextRefused":old_context_refused,
        "reviewedPackets":progress.batches.iter().filter(|batch|batch.review_output.is_some()).count(),
        "nextPacket":progress.next_packet,"state":job.state,"stages":calls,
        "modelInference":false,"generationCallbacks":"synthetic","publicWry":false,
        "installedApp":false,"egressObserved":false,"powerLossTested":false});
    crate::settings::atomic_write(
        &root.join("completed-revision-result.json"),
        &serde_json::to_vec(&result).unwrap(),
    )
    .unwrap();
    println!("SYNTHETIC_R2_NATIVE_REFRESH={result}");
}
