//! Persisted native boundaries over synthetic vaults/settings. No generation or
//! semantic-pass test double is used by these fixtures.
use super::*;
use crate::settings::test_support::with_isolated_data;

#[path = "live_view_tests.rs"]
mod live_view_tests;

fn fixture() -> (
    tempfile::TempDir,
    VaultRoot,
    AgentVaultSession,
    SourceBinding,
) {
    let dir = tempfile::Builder::new()
        .prefix("myco-session-compiler-synthetic-")
        .tempdir()
        .unwrap();
    std::fs::create_dir_all(dir.path().join("wiki")).unwrap();
    let raw_path = "raw/conversations/codex/synthetic.md".to_string();
    let original = "---\nsource: codex\nconversation_id: synthetic\nvia: mcp\n---\n# Synthetic original\n\nA synthetic source decision remains immutable.\n";
    crate::importers::wikify::append_raw(dir.path(), &raw_path, original).unwrap();
    let source = SourceBinding {
        key: "codex:synthetic".into(),
        raw_path: raw_path.clone(),
        source_revision: source_revision(original),
    };
    let mut queue = Pending::default();
    queue.push(crate::importers::wikify::PendingItem {
        key: source.key.clone(),
        raw_path,
        source_revision: source.source_revision.clone(),
        src_slug: "src-synthetic".into(),
        title: "Synthetic source".into(),
        imported: "2026-10-09".into(),
        read_ranges: vec![],
    });
    queue.save(dir.path()).unwrap();
    let state = VaultRoot::default();
    reopen(&state, dir.path());
    let origin = state.snapshot().unwrap();
    (dir, state, origin, source)
}
fn reopen(state: &VaultRoot, root: &Path) {
    let generation = state.begin_open().unwrap();
    state
        .finish_open(generation, root.canonicalize().unwrap(), || ())
        .unwrap();
}
fn summary(context: &SessionCompileContext) -> String {
    format!("---\ntype: source-summary\ntitle: Human title\nsession_key: {}\nannotation: preserved\n---\n# Human title\n\nHuman annotation remains.\n\nSynthetic source decision.[^src-synthetic]\n\n[^src-synthetic]: {}\n", context.source.key,context.source.raw_path)
}
#[test]
fn admitted_missing_weights_job_is_pending_without_a_role_or_receipt() {
    let (dir, _, _, _) = fixture();
    let queue = Pending::try_load(dir.path()).unwrap();
    assert_eq!(queue.compile_jobs.len(), 1);
    assert_eq!(queue.compile_jobs[0].state, WorkState::Pending);
    assert!(queue.compile_jobs[0].attempts.is_empty());
    assert!(queue.compile_jobs[0].receipts.is_empty());
}
#[test]
fn list_never_migrates_legacy_or_mutates_its_loaded_bytes() {
    let (dir, _, origin, _) = fixture();
    let mut queue = Pending::try_load(dir.path()).unwrap();
    queue.compile_jobs.clear();
    queue.save(dir.path()).unwrap();
    let before = std::fs::read(Pending::path(dir.path())).unwrap();
    let view = list_at(dir.path(), &origin, 3).unwrap();
    assert_eq!(view.items.len(), 1);
    assert!(view.items[0].compile_job_id.is_none());
    assert_eq!(std::fs::read(Pending::path(dir.path())).unwrap(), before);
}
#[test]
fn duplicate_job_ids_do_not_share_runtime_revalidation() {
    with_isolated_data("compiler-live-view-duplicate-id", |_| {
        let (dir, state, origin, source) = fixture();
        let context = begin(&state, &origin, source.clone(), RoleUsage::Foreground).unwrap();
        let mut pending = Pending::try_load(dir.path()).unwrap();
        // Malformed durable IDs cannot let one row's stale binding relabel another.
        let mut stale = pending.compile_jobs[0].clone();
        stale.attempts.last_mut().unwrap().role_snapshot_id = "synthetic-stale-role".into();
        pending.compile_jobs.push(stale);
        pending.save(dir.path()).unwrap();
        let before = std::fs::read(Pending::path(dir.path())).unwrap();
        let raw_before = std::fs::read(dir.path().join(&source.raw_path)).unwrap();
        let view = list_at(dir.path(), &origin, 3).unwrap();
        assert_eq!(view.pending_total, 2);
        assert_eq!(view.items.len(), 2);
        assert_eq!(view.items[0].compilation_state, WorkState::Running);
        assert_eq!(view.items[0].compilation_reason, None);
        assert_eq!(view.items[1].compilation_state, WorkState::Pending);
        assert_eq!(
            view.items[1].compilation_reason.as_deref(),
            Some("compiler_runtime_revalidation_required")
        );
        let reused = begin(&state, &origin, source, RoleUsage::Foreground).unwrap();
        assert!(same_context(&context, &reused).unwrap());
        assert_eq!(std::fs::read(Pending::path(dir.path())).unwrap(), before);
        assert_eq!(
            std::fs::read(dir.path().join(&context.source.raw_path)).unwrap(),
            raw_before
        );
    });
}
#[test]
fn legacy_reminder_completion_does_not_delete_compiler_work() {
    let (dir, _, origin, source) = fixture();
    let mut queue = Pending::try_load(dir.path()).unwrap();
    queue
        .complete(crate::importers::wikify::Receipt {
            key: source.key.clone(),
            raw_path: source.raw_path.clone(),
            source_revision: source.source_revision.clone(),
            wiki_paths: vec!["wiki/synthetic.md".into()],
            completed: "2026-10-09".into(),
        })
        .unwrap();
    queue.save(dir.path()).unwrap();
    assert!(queue.pending.is_empty());
    assert_eq!(
        list_at(dir.path(), &origin, 3).unwrap().items[0].raw_path,
        source.raw_path
    );
    assert_eq!(queue.compile_jobs[0].state, WorkState::Pending);
}
#[test]
fn source_change_or_forged_binding_cannot_begin_an_attempt() {
    with_isolated_data("compiler-source-boundary", |_| {
        let (dir, state, origin, mut source) = fixture();
        let before = std::fs::read(Pending::path(dir.path())).unwrap();
        source.key = "codex:another-synthetic".into();
        assert!(begin(&state, &origin, source.clone(), RoleUsage::Foreground).is_err());
        source.key = "codex:synthetic".into();
        std::fs::write(
            dir.path().join(&source.raw_path),
            "Synthetic unexpected original replacement",
        )
        .unwrap();
        assert!(begin(&state, &origin, source, RoleUsage::Foreground).is_err());
        assert_eq!(std::fs::read(Pending::path(dir.path())).unwrap(), before);
    });
}
#[test]
fn issued_attempt_rejects_caller_path_signature_and_raw_write() {
    with_isolated_data("compiler-private-issuer", |_| {
        let (dir, state, origin, source) = fixture();
        let context = begin(&state, &origin, source.clone(), RoleUsage::Foreground).unwrap();
        let raw = std::fs::read(dir.path().join(&source.raw_path)).unwrap();
        assert!(publish(
            &state,
            &context,
            &source.raw_path,
            "replace",
            Some(&source.source_revision)
        )
        .is_err());
        let mut forged = context.clone();
        forged.summary_path = "wiki/human.md".into();
        assert!(publish(&state, &forged, "wiki/human.md", "replace", None).is_err());
        let mut forged = context.clone();
        forged.compile_signature = "0".repeat(64);
        assert!(read(&state, &forged, &source.raw_path).is_err());
        assert_eq!(
            std::fs::read(dir.path().join(&source.raw_path)).unwrap(),
            raw
        );
        assert!(!dir.path().join("wiki/human.md").exists());
    });
}
#[test]
fn concurrent_human_edit_fails_cas_without_losing_annotation_or_raw() {
    with_isolated_data("compiler-human-cas", |_| {
        let (dir, state, origin, source) = fixture();
        let context = begin(&state, &origin, source.clone(), RoleUsage::Foreground).unwrap();
        let original = summary(&context);
        publish(&state, &context, &context.summary_path, &original, None).unwrap();
        let human = original.clone() + "\nLater human annotation.\n";
        std::fs::write(dir.path().join(&context.summary_path), &human).unwrap();
        assert!(publish(
            &state,
            &context,
            &context.summary_path,
            &(original.clone() + "\nNew evidence.\n"),
            Some(&source_revision(&original))
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(dir.path().join(&context.summary_path)).unwrap(),
            human
        );
        assert_eq!(
            source_revision(&std::fs::read_to_string(dir.path().join(&source.raw_path)).unwrap()),
            source.source_revision
        );
        assert!(complete(
            &state,
            &context,
            std::slice::from_ref(&context.summary_path)
        )
        .is_err());
        assert!(Pending::try_load(dir.path()).unwrap().compile_jobs[0]
            .receipts
            .is_empty());
    });
}
#[test]
fn preview_and_quote_publication_stays_partial_without_semantic_authority() {
    with_isolated_data("compiler-preview-partial", |_| {
        let (dir, state, origin, source) = fixture();
        let context = begin(&state, &origin, source.clone(), RoleUsage::Foreground).unwrap();
        let content = summary(&context);
        publish(&state, &context, &context.summary_path, &content, None).unwrap();
        let outcome = complete(
            &state,
            &context,
            std::slice::from_ref(&context.summary_path),
        )
        .unwrap();
        assert_eq!(outcome["ok"], false);
        assert_eq!(outcome["state"], "partial");
        assert_eq!(outcome["checks"]["semanticReview"], "unavailable");
        let queue = Pending::try_load(dir.path()).unwrap();
        assert_eq!(queue.pending.len(), 1);
        assert_eq!(queue.compile_jobs[0].state, WorkState::Partial);
        assert!(queue.compile_jobs[0].receipts.is_empty());
        assert_eq!(queue.receipts.len(), 0);
        assert_eq!(
            std::fs::read_to_string(dir.path().join(&context.summary_path)).unwrap(),
            content
        );
    });
}
#[test]
fn same_path_reopen_expires_old_attempt_and_preserves_durable_output_history() {
    with_isolated_data("compiler-opening-history", |_| {
        let (dir, state, origin, source) = fixture();
        let old = begin(&state, &origin, source.clone(), RoleUsage::Foreground).unwrap();
        publish(&state, &old, &old.summary_path, &summary(&old), None).unwrap();
        let before = std::fs::read(Pending::path(dir.path())).unwrap();
        reopen(&state, dir.path());
        assert!(read(&state, &old, &source.raw_path).is_err());
        assert!(complete(&state, &old, std::slice::from_ref(&old.summary_path)).is_err());
        assert_eq!(std::fs::read(Pending::path(dir.path())).unwrap(), before);
        let new = begin(
            &state,
            &state.snapshot().unwrap(),
            source,
            RoleUsage::Foreground,
        )
        .unwrap();
        assert_ne!(new.attempt_id, old.attempt_id);
        let queue = Pending::try_load(dir.path()).unwrap();
        assert_eq!(queue.compile_jobs[0].attempts.len(), 2);
        assert_eq!(queue.compile_jobs[0].attempts[0].outputs.len(), 1);
        assert!(queue.compile_jobs[0].attempts[1].outputs.is_empty());
        assert!(complete(&state, &new, std::slice::from_ref(&new.summary_path)).is_err());
    });
}
#[test]
fn runtime_issuer_loss_requires_new_attempt_without_rebuilding_authority_from_sha() {
    with_isolated_data("compiler-restart-issuer", |_| {
        let (dir, state, origin, source) = fixture();
        let old = begin(&state, &origin, source.clone(), RoleUsage::Foreground).unwrap();
        publish(&state, &old, &old.summary_path, &summary(&old), None).unwrap();
        grants().lock().unwrap().remove(&old.attempt_id);
        assert!(complete(&state, &old, std::slice::from_ref(&old.summary_path)).is_err());
        let new = begin(&state, &origin, source, RoleUsage::Foreground).unwrap();
        assert!(complete(&state, &new, std::slice::from_ref(&new.summary_path)).is_err());
        assert_eq!(
            Pending::try_load(dir.path()).unwrap().compile_jobs[0].attempts[0]
                .outputs
                .len(),
            1
        );
    });
}

#[test]
fn final_queue_cas_failure_retains_artifact_and_intent_without_native_authority() {
    with_isolated_data("compiler-output-queue-failure", |_| {
        let (dir, state, origin, source) = fixture();
        let context = begin(&state, &origin, source, RoleUsage::Foreground).unwrap();
        let queue_path = Pending::path(dir.path());
        *publication::AFTER_OUTPUT.lock().unwrap() = Some(Box::new(move || {
            let mut value: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&queue_path).unwrap()).unwrap();
            value["done_count"] = serde_json::json!(999);
            std::fs::write(queue_path, serde_json::to_vec(&value).unwrap()).unwrap();
        }));
        let content = summary(&context);
        let result = publish(&state, &context, &context.summary_path, &content, None);
        assert!(result.is_err_and(|error| error.contains("artifact retained")));
        assert_eq!(
            std::fs::read_to_string(dir.path().join(&context.summary_path)).unwrap(),
            content
        );
        let queue = Pending::try_load(dir.path()).unwrap();
        assert_eq!(queue.done_count, 999);
        assert_eq!(queue.compile_jobs[0].attempts[0].prepared_outputs.len(), 1);
        assert!(queue.compile_jobs[0].attempts[0].outputs.is_empty());
        assert!(queue.compile_jobs[0].receipts.is_empty());
        assert!(complete(
            &state,
            &context,
            std::slice::from_ref(&context.summary_path)
        )
        .is_err());
        stop(&state, &context, "publication_incomplete").unwrap();
        assert_eq!(
            Pending::try_load(dir.path()).unwrap().compile_jobs[0].state,
            WorkState::Stopped
        );
    });
}

#[test]
fn explicit_manual_begin_admits_archive_only_lineage_without_automatic_reminder() {
    with_isolated_data("compiler-manual-admission", |_| {
        let dir = tempfile::Builder::new()
            .prefix("myco-compiler-manual-synthetic-")
            .tempdir()
            .unwrap();
        std::fs::create_dir_all(dir.path().join("wiki")).unwrap();
        let input = dir.path().join("synthetic-session.jsonl");
        std::fs::write(&input,serde_json::json!({"type":"user","sessionId":"manual-synthetic",
            "message":{"role":"user","content":"A synthetic archived source records one explicit bounded decision. ".repeat(40)}}).to_string()).unwrap();
        let outcome = crate::commands::run_import(dir.path(), &[input], "sessions", |_| {});
        assert_eq!(outcome.imported, 1);
        assert!(outcome.failed.is_empty());
        assert!(!Pending::path(dir.path()).exists());
        let ledger = crate::importers::ledger::Ledger::load(dir.path()).unwrap();
        let rel = ledger
            .location("sessions", "claude-code:manual-synthetic")
            .unwrap();
        let projection = std::fs::read_to_string(dir.path().join(rel)).unwrap();
        let parsed = gray_matter::Matter::<gray_matter::engine::YAML>::new()
            .parse::<serde_json::Value>(&projection)
            .unwrap();
        let metadata = parsed.data.unwrap();
        let source = SourceBinding {
            key: "claude-code:manual-synthetic".into(),
            raw_path: metadata["raw_path"].as_str().unwrap().into(),
            source_revision: metadata["source_revision"].as_str().unwrap().into(),
        };
        let raw_before = std::fs::read(dir.path().join(&source.raw_path)).unwrap();
        let ledger_before =
            std::fs::read(crate::vault_dir::dir(dir.path()).join("ledger.json")).unwrap();
        let state = VaultRoot::default();
        reopen(&state, dir.path());
        let origin = state.snapshot().unwrap();
        assert!(begin(&state, &origin, source.clone(), RoleUsage::Automatic).is_err());
        assert!(!Pending::path(dir.path()).exists());
        // The imported human-editable heading repeats the first user line.
        // Mutate the actual owned transcript, not that earlier heading.
        let marker_start = projection.find("<!-- myco:import-transcript:v1 ").unwrap();
        let transcript_start = marker_start + projection[marker_start..].find('\n').unwrap() + 1;
        let transcript_end = projection.find("<!-- /myco:import-transcript -->").unwrap();
        assert!(projection.find("A synthetic archived source").unwrap() < marker_start);
        let altered_transcript = projection[transcript_start..transcript_end].replacen(
            "A synthetic archived source",
            "A synthetic edited owned source",
            1,
        );
        assert_ne!(
            altered_transcript,
            projection[transcript_start..transcript_end]
        );
        let altered = format!(
            "{}{}{}",
            &projection[..transcript_start],
            altered_transcript,
            &projection[transcript_end..]
        );
        assert_eq!(
            &altered[..transcript_start],
            &projection[..transcript_start]
        );
        assert_ne!(altered, projection);
        std::fs::write(dir.path().join(rel), &altered).unwrap();
        assert!(begin(&state, &origin, source.clone(), RoleUsage::Foreground).is_err());
        assert!(!Pending::path(dir.path()).exists());
        assert_eq!(
            std::fs::read_to_string(dir.path().join(rel)).unwrap(),
            altered
        );
        std::fs::write(dir.path().join(rel), &projection).unwrap();
        let context = begin(&state, &origin, source.clone(), RoleUsage::Foreground).unwrap();
        let before = std::fs::read(Pending::path(dir.path())).unwrap();
        let repeated = begin(&state, &origin, source.clone(), RoleUsage::Foreground).unwrap();
        assert_eq!(context.attempt_id, repeated.attempt_id);
        assert_eq!(std::fs::read(Pending::path(dir.path())).unwrap(), before);
        let pending = Pending::try_load(dir.path()).unwrap();
        assert!(pending.pending.is_empty());
        assert_eq!(pending.compile_jobs.len(), 1);
        assert_eq!(pending.compile_jobs[0].attempts.len(), 1);
        assert_eq!(
            std::fs::read(dir.path().join(&source.raw_path)).unwrap(),
            raw_before
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join(rel)).unwrap(),
            projection
        );
        assert_eq!(
            std::fs::read(crate::vault_dir::dir(dir.path()).join("ledger.json")).unwrap(),
            ledger_before
        );
    });
}

#[test]
fn explicit_manual_begin_refuses_raw_sha_without_native_ledger_lineage() {
    with_isolated_data("compiler-manual-reject", |_| {
        let (dir, state, origin, source) = fixture();
        std::fs::remove_file(Pending::path(dir.path())).unwrap();
        let raw_before = std::fs::read(dir.path().join(&source.raw_path)).unwrap();
        assert!(
            begin(&state, &origin, source.clone(), RoleUsage::Foreground)
                .is_err_and(|error| error.contains("lineage"))
        );
        assert!(!Pending::path(dir.path()).exists());
        assert_eq!(
            std::fs::read(dir.path().join(&source.raw_path)).unwrap(),
            raw_before
        );
    });
}

#[test]
fn automatic_partial_preview_does_not_generate_repeated_identical_attempts() {
    with_isolated_data("compiler-auto-partial", |_| {
        crate::settings::save(&crate::settings::Settings {
            auto_ingest_enabled: true,
            ..Default::default()
        })
        .unwrap();
        let (dir, state, origin, source) = fixture();
        let context = begin(&state, &origin, source.clone(), RoleUsage::Automatic).unwrap();
        publish(
            &state,
            &context,
            &context.summary_path,
            &summary(&context),
            None,
        )
        .unwrap();
        complete(
            &state,
            &context,
            std::slice::from_ref(&context.summary_path),
        )
        .unwrap();
        let before = std::fs::read(Pending::path(dir.path())).unwrap();
        assert!(begin(&state, &origin, source, RoleUsage::Automatic)
            .is_err_and(|error| error.contains("SEMANTIC_ADAPTER_REQUIRED")));
        assert_eq!(std::fs::read(Pending::path(dir.path())).unwrap(), before);
    });
}
