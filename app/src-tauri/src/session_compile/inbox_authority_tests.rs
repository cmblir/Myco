//! Synthetic native inbox authority fixtures. Model callbacks exercise the real
//! compiler/schema/review/publisher plumbing, not actual-model semantic quality.

use super::*;
use crate::settings::test_support::with_isolated_data;
use std::cell::Cell;
use std::sync::atomic::AtomicBool;

const ORIGINAL: &str = "---\nsource: codex\nconversation_id: synthetic-inbox\ncreated: 2026-10-01\n---\n# Synthetic inbox original\n\n**User:**\nPlease request the synthetic report.\n";

struct Fixture {
    dir: tempfile::TempDir,
    vault: VaultRoot,
    origin: AgentVaultSession,
    source: SourceBinding,
}

fn fixture() -> Fixture {
    let dir = tempfile::Builder::new()
        .prefix("myco-inbox-compiler-authority-synthetic-")
        .tempdir()
        .unwrap();
    let source = SourceBinding {
        key: "codex:synthetic-inbox".into(),
        raw_path: "raw/conversations/codex/synthetic-inbox.md".into(),
        source_revision: source_revision(ORIGINAL),
    };
    crate::importers::wikify::append_raw(dir.path(), &source.raw_path, ORIGINAL).unwrap();
    let mut pending = Pending::default();
    pending.push(crate::importers::wikify::PendingItem {
        key: source.key.clone(),
        raw_path: source.raw_path.clone(),
        source_revision: source.source_revision.clone(),
        src_slug: "src-synthetic-inbox".into(),
        title: "Synthetic inbox original".into(),
        imported: "2026-10-09".into(),
        read_ranges: Vec::new(),
    });
    pending.save(dir.path()).unwrap();
    let vault = VaultRoot::default();
    reopen(&vault, dir.path());
    let origin = vault.snapshot().unwrap();
    Fixture {
        dir,
        vault,
        origin,
        source,
    }
}

fn reopen(vault: &VaultRoot, root: &Path) {
    let generation = vault.begin_open().unwrap();
    vault
        .finish_open(generation, root.canonicalize().unwrap(), || ())
        .unwrap();
}

fn begin_fixture(fixture: &Fixture) -> SessionCompileContext {
    begin_inbox_original(
        &fixture.vault,
        &fixture.origin,
        ORIGINAL,
        RoleUsage::Foreground,
    )
    .unwrap()
}

fn run_fixture(
    fixture: &Fixture,
    context: &SessionCompileContext,
    rejected: bool,
) -> execution::StepOutcome {
    let mut previous = 0;
    loop {
        let outcome = execution::step(
            &fixture.vault,
            context,
            "en",
            &AtomicBool::new(false),
            |_, _| Ok(800),
            |_, user, _, _, schema| compiler::fixture_model(schema, user, rejected),
        )
        .unwrap();
        if outcome.state != WorkState::Running {
            return outcome;
        }
        assert!(outcome.next_packet > previous && outcome.next_packet <= outcome.eligible_windows);
        previous = outcome.next_packet;
    }
}

fn compiled(fixture: &Fixture) -> SessionCompileContext {
    let context = begin_fixture(fixture);
    let outcome = run_fixture(fixture, &context, false);
    assert_eq!(outcome.state, WorkState::Completed);
    assert_eq!(outcome.publication.unwrap()["ok"], true);
    context
}

fn verify(fixture: &Fixture, context: &SessionCompileContext) -> Result<bool, String> {
    with_verified_inbox_completion(&fixture.vault, context, ORIGINAL, |_, recheck| {
        let _writer = crate::vault::lock_file_mutation()?;
        recheck()?;
        Ok(true)
    })
}

#[test]
fn exact_admitted_original_begins_without_accepting_projection_or_human_suffix() {
    with_isolated_data("inbox-original-admission", |_| {
        let fixture = fixture();
        let before = std::fs::read(Pending::path(fixture.dir.path())).unwrap();
        for text in [
            "# Ordinary synthetic inbox note\nNo imported lineage.\n".to_string(),
            ORIGINAL.replace("# Synthetic inbox original", "# Edited projection title"),
            format!("{ORIGINAL}\nHuman annotation outside the admitted original.\n"),
            ORIGINAL.replace(
                "conversation_id: synthetic-inbox",
                "conversation_id: another-synthetic",
            ),
        ] {
            assert!(begin_inbox_original(
                &fixture.vault,
                &fixture.origin,
                &text,
                RoleUsage::Foreground
            )
            .is_err());
            assert_eq!(
                std::fs::read(Pending::path(fixture.dir.path())).unwrap(),
                before
            );
        }
        let context = begin_fixture(&fixture);
        assert_eq!(context.source, fixture.source);
        assert_eq!(context.origin.opening_token, fixture.origin.opening_token);
        assert_eq!(context.role_snapshot.usage, RoleUsage::Foreground);
    });
}

#[test]
fn existing_raw_without_exact_native_admission_cannot_begin() {
    with_isolated_data("inbox-unadmitted-original", |_| {
        let fixture = fixture();
        let mut pending = Pending::try_load(fixture.dir.path()).unwrap();
        pending.pending.clear();
        pending.compile_jobs.clear();
        pending.save(fixture.dir.path()).unwrap();
        let before = std::fs::read(Pending::path(fixture.dir.path())).unwrap();
        assert!(begin_inbox_original(
            &fixture.vault,
            &fixture.origin,
            ORIGINAL,
            RoleUsage::Foreground
        )
        .is_err());
        assert_eq!(
            std::fs::read(Pending::path(fixture.dir.path())).unwrap(),
            before
        );
        assert_eq!(
            std::fs::read_to_string(fixture.dir.path().join(&fixture.source.raw_path)).unwrap(),
            ORIGINAL
        );
    });
}

#[test]
fn changed_original_and_same_path_reopen_reject_initial_inbox_admission() {
    with_isolated_data("inbox-origin-and-original", |_| {
        let fixture = fixture();
        let before = std::fs::read(Pending::path(fixture.dir.path())).unwrap();
        std::fs::write(
            fixture.dir.path().join(&fixture.source.raw_path),
            "Synthetic changed original",
        )
        .unwrap();
        assert!(begin_inbox_original(
            &fixture.vault,
            &fixture.origin,
            ORIGINAL,
            RoleUsage::Foreground
        )
        .is_err());
        std::fs::write(fixture.dir.path().join(&fixture.source.raw_path), ORIGINAL).unwrap();
        reopen(&fixture.vault, fixture.dir.path());
        assert!(begin_inbox_original(
            &fixture.vault,
            &fixture.origin,
            ORIGINAL,
            RoleUsage::Foreground
        )
        .is_err());
        assert_eq!(
            std::fs::read(Pending::path(fixture.dir.path())).unwrap(),
            before
        );
    });
}

#[test]
fn actual_compiler_publication_allows_writer_guarded_completion_recheck() {
    with_isolated_data("inbox-native-completion-positive", |_| {
        let fixture = fixture();
        let context = compiled(&fixture);
        let before = std::fs::read(Pending::path(fixture.dir.path())).unwrap();
        assert!(verify(&fixture, &context).unwrap());
        assert_eq!(
            std::fs::read(Pending::path(fixture.dir.path())).unwrap(),
            before
        );
        assert_eq!(
            std::fs::read_to_string(fixture.dir.path().join(&fixture.source.raw_path)).unwrap(),
            ORIGINAL
        );
    });
}

#[test]
fn quote_publication_and_forged_durable_passes_do_not_issue_completion_authority() {
    with_isolated_data("inbox-forged-durable-completion", |_| {
        let fixture = fixture();
        let context = begin_fixture(&fixture);
        let quote = format!("---\ntype: source-summary\nsession_key: {}\n---\n# Synthetic quote\n\n[^src-synthetic]: {}\n", context.source.key, context.source.raw_path);
        publish(
            &fixture.vault,
            &context,
            &context.summary_path,
            &quote,
            None,
        )
        .unwrap();
        let mut pending = Pending::try_load(fixture.dir.path()).unwrap();
        let job = &mut pending.compile_jobs[0];
        let outputs = job.attempts.last().unwrap().outputs.clone();
        assert!(job
            .finish(
                &context.attempt_id,
                state::ProcessingChecks {
                    original_source: state::CheckState::Passed,
                    source_schema: state::CheckState::Passed,
                    semantic_review: state::CheckState::Passed,
                    eligible_units: 1,
                    processed_units: 1,
                    omitted_units: 0,
                },
                outputs,
                now()
            )
            .unwrap());
        pending.save(fixture.dir.path()).unwrap();
        let called = Cell::new(false);
        assert!(
            with_verified_inbox_completion(&fixture.vault, &context, ORIGINAL, |_, _| {
                called.set(true);
                Ok(())
            })
            .is_err()
        );
        assert!(!called.get());
        assert_eq!(
            std::fs::read_to_string(fixture.dir.path().join(&context.summary_path)).unwrap(),
            quote
        );
    });
}

#[test]
fn partial_model_review_cannot_authorize_commit() {
    with_isolated_data("inbox-partial-compiler", |_| {
        let fixture = fixture();
        let context = begin_fixture(&fixture);
        let outcome = run_fixture(&fixture, &context, true);
        assert_eq!(outcome.state, WorkState::Partial);
        assert!(verify(&fixture, &context).is_err());
        assert!(!fixture.dir.path().join(&context.summary_path).exists());
    });
}

#[test]
fn caller_context_changes_and_runtime_authority_loss_reject_completed_output() {
    with_isolated_data("inbox-native-context-and-issuer", |_| {
        let fixture = fixture();
        let context = compiled(&fixture);
        let mut forged = context.clone();
        forged.compile_signature = "0".repeat(64);
        assert!(verify(&fixture, &forged).is_err());
        assert!(with_verified_inbox_completion(
            &fixture.vault,
            &context,
            &(ORIGINAL.to_string() + "\nOther input\n"),
            |_, _| Ok(())
        )
        .is_err());
        grants()
            .lock()
            .unwrap()
            .get_mut(&context.attempt_id)
            .unwrap()
            .compiler = None;
        assert!(verify(&fixture, &context).is_err());
    });
}

#[test]
fn source_output_and_completed_queue_changes_inside_commit_fail_recheck() {
    for change in ["output", "source", "queue"] {
        with_isolated_data(&format!("inbox-commit-{change}"), |_| {
            let fixture = fixture();
            let context = compiled(&fixture);
            let completed = Cell::new(false);
            let result = with_verified_inbox_completion(
                &fixture.vault,
                &context,
                ORIGINAL,
                |root, recheck| {
                    match change {
                        "output" => std::fs::write(
                            root.join(&context.summary_path),
                            "Synthetic later human edit",
                        )
                        .unwrap(),
                        "source" => std::fs::write(
                            root.join(&context.source.raw_path),
                            "Synthetic later source edit",
                        )
                        .unwrap(),
                        _ => std::fs::write(Pending::path(root), "{ synthetic corrupt queue")
                            .unwrap(),
                    }
                    let _writer = crate::vault::lock_file_mutation()?;
                    recheck()?;
                    completed.set(true);
                    Ok(())
                },
            );
            assert!(result.is_err(), "{change}");
            assert!(!completed.get());
        });
    }
}

#[test]
fn same_byte_human_replacement_and_same_path_reopen_preserve_without_commit() {
    with_isolated_data("inbox-native-replacement", |_| {
        let fixture = fixture();
        let context = compiled(&fixture);
        let path = fixture.dir.path().join(&context.summary_path);
        let before = std::fs::read(&path).unwrap();
        let replacement = path.with_extension("synthetic-replacement");
        std::fs::write(&replacement, &before).unwrap();
        std::fs::rename(&replacement, &path).unwrap();
        assert!(verify(&fixture, &context).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        reopen(&fixture.vault, fixture.dir.path());
        assert!(verify(&fixture, &context).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    });
}

#[test]
fn automatic_original_requires_enablement_and_completion_rejects_revocation() {
    with_isolated_data("inbox-automatic-native-completion", |_| {
        let fixture = fixture();
        let before = std::fs::read(Pending::path(fixture.dir.path())).unwrap();
        assert!(begin_inbox_original(
            &fixture.vault,
            &fixture.origin,
            ORIGINAL,
            RoleUsage::Automatic
        )
        .is_err());
        assert_eq!(
            std::fs::read(Pending::path(fixture.dir.path())).unwrap(),
            before
        );
        crate::settings::save(&crate::settings::Settings {
            auto_ingest_enabled: true,
            ..Default::default()
        })
        .unwrap();
        let context = begin_inbox_original(
            &fixture.vault,
            &fixture.origin,
            ORIGINAL,
            RoleUsage::Automatic,
        )
        .unwrap();
        assert_eq!(
            run_fixture(&fixture, &context, false).state,
            WorkState::Completed
        );
        assert!(verify(&fixture, &context).unwrap());
        let before = std::fs::read(Pending::path(fixture.dir.path())).unwrap();
        let mut settings = crate::settings::read_checked().unwrap();
        settings.auto_ingest_enabled = false;
        crate::settings::save(&settings).unwrap();
        let called = Cell::new(false);
        assert!(
            with_verified_inbox_completion(&fixture.vault, &context, ORIGINAL, |_, _| {
                called.set(true);
                Ok(())
            })
            .is_err()
        );
        assert!(!called.get());
        assert_eq!(
            std::fs::read(Pending::path(fixture.dir.path())).unwrap(),
            before
        );
    });
}

#[test]
fn completed_output_rejects_a_changed_compilation_role() {
    with_isolated_data("inbox-completed-role-change", |_| {
        let fixture = fixture();
        let context = compiled(&fixture);
        let before = std::fs::read(Pending::path(fixture.dir.path())).unwrap();
        crate::role_authorization::select_role(crate::role_authorization::RoleSelectionRequest {
            role: RoleId::Compilation,
            provider_id: "builtin-local".into(),
            model_id: crate::local_model::SMALL_MODEL.id.into(),
            effort: "(default)".into(),
            expected_authorization_revision: crate::role_authorization::settings_snapshot()
                .unwrap()
                .role_authorization_revision,
        })
        .unwrap();
        assert!(verify(&fixture, &context).is_err());
        assert_eq!(
            std::fs::read(Pending::path(fixture.dir.path())).unwrap(),
            before
        );
    });
}

fn promoted_inbox(fixture: &Fixture, shared: bool) -> crate::inbox_source::Snapshot {
    let root = fixture.dir.path();
    std::fs::create_dir_all(root.join("sessions")).unwrap();
    std::fs::create_dir_all(root.join("_inbox")).unwrap();
    std::fs::create_dir_all(root.join(".myco")).unwrap();
    std::fs::write(root.join("_inbox/synthetic.md"), ORIGINAL).unwrap();
    let mut state = crate::backfill::BackfillState::default();
    let sources = if shared {
        vec!["sessions/synthetic.md", "sessions/shared-synthetic.md"]
    } else {
        vec!["sessions/synthetic.md"]
    };
    for rel in sources {
        std::fs::write(root.join(rel), ORIGINAL).unwrap();
        state.pending.insert(
            rel.into(),
            crate::backfill::PendingCopy {
                inbox_rel: "_inbox/synthetic.md".into(),
                source_revision: fixture.source.source_revision.clone(),
            },
        );
    }
    std::fs::write(
        root.join(".myco/backfill.json"),
        serde_json::to_vec(&state).unwrap(),
    )
    .unwrap();
    crate::inbox_source::capture(
        &fixture.vault,
        &fixture.origin,
        "_inbox/synthetic.md",
        Some(&fixture.source.source_revision),
    )
    .unwrap()
}

#[test]
fn native_snapshot_to_compiler_to_actual_archive_records_exact_completion() {
    with_isolated_data("inbox-full-archive-native-completion", |_| {
        let fixture = fixture();
        let snapshot = promoted_inbox(&fixture, false);
        let context =
            crate::inbox_source::begin(&fixture.vault, &snapshot, RoleUsage::Foreground).unwrap();
        assert_eq!(
            run_fixture(&fixture, &context, false).state,
            WorkState::Completed
        );
        let receipt =
            crate::inbox_source::archive(&fixture.vault, &snapshot, Some(&context)).unwrap();
        assert!(receipt.harvest_completed);
        assert_eq!(receipt.source_revision, fixture.source.source_revision);
        assert_eq!(
            std::fs::read_to_string(&receipt.archived_path).unwrap(),
            ORIGINAL
        );
        assert!(!fixture.dir.path().join(&snapshot.inbox_rel).exists());
        let state: crate::backfill::BackfillState = serde_json::from_slice(
            &std::fs::read(fixture.dir.path().join(".myco/backfill.json")).unwrap(),
        )
        .unwrap();
        assert!(state.pending.is_empty());
        assert_eq!(state.completed.len(), 1);
        assert_eq!(
            state.completed["sessions/synthetic.md"].source_revision,
            fixture.source.source_revision
        );
        assert_eq!(
            std::fs::read_to_string(fixture.dir.path().join("sessions/synthetic.md")).unwrap(),
            ORIGINAL
        );
        assert_eq!(
            std::fs::read_to_string(fixture.dir.path().join(&fixture.source.raw_path)).unwrap(),
            ORIGINAL
        );
        crate::inbox_source::release(&snapshot).unwrap();
    });
}

#[test]
fn changed_shared_session_after_native_compilation_prevents_archive_and_completion() {
    with_isolated_data("inbox-full-archive-shared-source-change", |_| {
        let fixture = fixture();
        let snapshot = promoted_inbox(&fixture, true);
        let context =
            crate::inbox_source::begin(&fixture.vault, &snapshot, RoleUsage::Foreground).unwrap();
        assert_eq!(
            run_fixture(&fixture, &context, false).state,
            WorkState::Completed
        );
        let before = std::fs::read(fixture.dir.path().join(".myco/backfill.json")).unwrap();
        let changed = format!("{ORIGINAL}\nSynthetic later human annotation.\n");
        std::fs::write(
            fixture.dir.path().join("sessions/shared-synthetic.md"),
            &changed,
        )
        .unwrap();
        assert!(crate::inbox_source::archive(&fixture.vault, &snapshot, Some(&context)).is_err());
        assert_eq!(
            std::fs::read(fixture.dir.path().join(".myco/backfill.json")).unwrap(),
            before
        );
        assert_eq!(
            std::fs::read_to_string(fixture.dir.path().join(&snapshot.inbox_rel)).unwrap(),
            ORIGINAL
        );
        assert!(!fixture.dir.path().join("_inbox/.archived").exists());
        assert_eq!(
            std::fs::read_to_string(fixture.dir.path().join("sessions/shared-synthetic.md"))
                .unwrap(),
            changed
        );
        assert_eq!(
            std::fs::read_to_string(fixture.dir.path().join("sessions/synthetic.md")).unwrap(),
            ORIGINAL
        );
        assert_eq!(
            std::fs::read_to_string(fixture.dir.path().join(&fixture.source.raw_path)).unwrap(),
            ORIGINAL
        );
        let state: crate::backfill::BackfillState = serde_json::from_slice(&before).unwrap();
        assert_eq!(state.pending.len(), 2);
        assert!(state.completed.is_empty());
        crate::inbox_source::release(&snapshot).unwrap();
    });
}

#[test]
fn matching_forged_durable_checks_cannot_archive_a_native_completed_original() {
    with_isolated_data("inbox-full-archive-forged-native-checks", |_| {
        let fixture = fixture();
        let snapshot = promoted_inbox(&fixture, false);
        let context =
            crate::inbox_source::begin(&fixture.vault, &snapshot, RoleUsage::Foreground).unwrap();
        assert_eq!(
            run_fixture(&fixture, &context, false).state,
            WorkState::Completed
        );
        let mut pending = Pending::try_load(fixture.dir.path()).unwrap();
        let job = &mut pending.compile_jobs[0];
        let attempt = job.attempts.last_mut().unwrap();
        attempt.checks.eligible_units += 1;
        attempt.checks.processed_units += 1;
        job.receipts.last_mut().unwrap().checks = attempt.checks.clone();
        pending.save(fixture.dir.path()).unwrap();
        let queue_before = std::fs::read(Pending::path(fixture.dir.path())).unwrap();
        let backfill_before =
            std::fs::read(fixture.dir.path().join(".myco/backfill.json")).unwrap();
        let error =
            crate::inbox_source::archive(&fixture.vault, &snapshot, Some(&context)).unwrap_err();
        assert!(
            error.contains("checks differ from the native compiler artifact"),
            "{error}"
        );
        assert_eq!(
            std::fs::read(Pending::path(fixture.dir.path())).unwrap(),
            queue_before
        );
        assert_eq!(
            std::fs::read(fixture.dir.path().join(".myco/backfill.json")).unwrap(),
            backfill_before
        );
        assert_eq!(
            std::fs::read_to_string(fixture.dir.path().join(&snapshot.inbox_rel)).unwrap(),
            ORIGINAL
        );
        assert!(!fixture.dir.path().join("_inbox/.archived").exists());
        assert_eq!(
            std::fs::read_to_string(fixture.dir.path().join(&fixture.source.raw_path)).unwrap(),
            ORIGINAL
        );
        crate::inbox_source::release(&snapshot).unwrap();
    });
}

#[test]
fn failed_automatic_attempt_finalizes_natively_before_fresh_retry() {
    // This calls production native functions directly with mocked generation;
    // it proves checkpoint/retry authority, not the frontend/native IPC E2E.
    with_isolated_data("inbox-automatic-failure-native-retry", |_| {
        crate::settings::save(&crate::settings::Settings {
            auto_ingest_enabled: true,
            ..Default::default()
        })
        .unwrap();
        let fixture = fixture();
        let snapshot = promoted_inbox(&fixture, false);
        let original_raw =
            std::fs::read(fixture.dir.path().join(&fixture.source.raw_path)).unwrap();
        let original_session =
            std::fs::read(fixture.dir.path().join("sessions/synthetic.md")).unwrap();
        let first =
            crate::inbox_source::begin(&fixture.vault, &snapshot, RoleUsage::Automatic).unwrap();
        let error = execution::step(
            &fixture.vault,
            &first,
            "en",
            &AtomicBool::new(false),
            |_, _| Ok(800),
            |_, _, _, _, _| Err("Synthetic generator unavailable".into()),
        )
        .err()
        .unwrap();
        assert_eq!(error.message, "Synthetic generator unavailable");
        let failed = Pending::try_load(fixture.dir.path()).unwrap();
        let job = &failed.compile_jobs[0];
        assert_eq!(job.state, WorkState::Failed);
        assert_eq!(job.attempts.len(), 1);
        assert_eq!(job.attempts[0].id, first.attempt_id);
        assert_eq!(job.attempts[0].state, WorkState::Failed);
        assert!(job.receipts.is_empty());
        assert_eq!(error.outcome.as_ref().unwrap().state, WorkState::Failed);
        assert!(verify(&fixture, &first).is_err());
        // The native failure is already durable; a generic preparation Stop
        // must not relabel it or supply new review authority.
        assert!(stop(&fixture.vault, &first, "preparation_required").is_err());
        let previous_attempt = serde_json::to_value(&job.attempts[0]).unwrap();
        let retry =
            crate::inbox_source::begin(&fixture.vault, &snapshot, RoleUsage::Automatic).unwrap();
        assert_ne!(retry.attempt_id, first.attempt_id);
        assert_eq!(retry.source, first.source);
        assert_eq!(
            run_fixture(&fixture, &retry, false).state,
            WorkState::Completed
        );
        assert!(verify(&fixture, &retry).unwrap());
        assert!(verify(&fixture, &first).is_err());
        let completed = Pending::try_load(fixture.dir.path()).unwrap();
        let job = &completed.compile_jobs[0];
        assert_eq!(job.state, WorkState::Completed);
        assert_eq!(job.attempts.len(), 2);
        assert_eq!(
            serde_json::to_value(&job.attempts[0]).unwrap(),
            previous_attempt
        );
        assert_eq!(job.attempts[1].id, retry.attempt_id);
        assert_eq!(job.attempts[1].state, WorkState::Completed);
        assert_eq!(job.receipts.len(), 1);
        assert_eq!(job.receipts[0].attempt_id, retry.attempt_id);
        assert_eq!(
            std::fs::read(fixture.dir.path().join(&fixture.source.raw_path)).unwrap(),
            original_raw
        );
        assert_eq!(
            std::fs::read(fixture.dir.path().join("sessions/synthetic.md")).unwrap(),
            original_session
        );
        assert_eq!(
            std::fs::read_to_string(fixture.dir.path().join(&snapshot.inbox_rel)).unwrap(),
            ORIGINAL
        );
        assert!(!fixture.dir.path().join("_inbox/.archived").exists());
        crate::inbox_source::release(&snapshot).unwrap();
    });
}
