//! Synthetic native custody controls; actual process restart is a separate test.
use super::*;
use crate::importers::wikify::{append_raw, PendingItem};
use crate::role_authorization::RoleUsage;
use crate::session_compile as session;
use crate::settings::test_support::with_isolated_data;
use crate::vault_session::VaultRoot;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;

const RAW: &str = "---\nsource: codex\nconversation_id: synthetic-custody\n---\n**User:**\nPlease request the synthetic report.\n";

fn fixture() -> (tempfile::TempDir, VaultRoot, session::SourceBinding) {
    let directory = tempfile::Builder::new()
        .prefix("myco-compiler-custody-synthetic-")
        .tempdir()
        .unwrap();
    let source = session::SourceBinding {
        key: "codex:synthetic-custody".into(),
        raw_path: "raw/conversations/codex/synthetic-custody-r1.md".into(),
        source_revision: source_revision(RAW),
    };
    append_raw(directory.path(), &source.raw_path, RAW).unwrap();
    admit(directory.path(), &source);
    let vault = VaultRoot::default();
    let opening = vault.begin_open().unwrap();
    vault
        .finish_open(opening, directory.path().canonicalize().unwrap(), || ())
        .unwrap();
    (directory, vault, source)
}

fn admit(root: &Path, source: &session::SourceBinding) {
    let mut pending = Pending::try_load(root).unwrap();
    pending.push(PendingItem {
        key: source.key.clone(),
        raw_path: source.raw_path.clone(),
        source_revision: source.source_revision.clone(),
        src_slug: "src-synthetic-custody".into(),
        title: "Synthetic custody".into(),
        imported: "2026-10-17".into(),
        read_ranges: vec![],
    });
    pending.save(root).unwrap();
}

fn compile(
    vault: &VaultRoot,
    source: &session::SourceBinding,
) -> (
    SessionCompileContext,
    Result<session::execution::StepOutcome, session::failure::CompileFailure>,
) {
    let origin = vault.snapshot().unwrap();
    let context = session::begin(vault, &origin, source.clone(), RoleUsage::Foreground).unwrap();
    let raw = session::checked_source(Path::new(&origin.vault_path), source).unwrap();
    let plan = session::sources::prepare(source, &raw, &origin, "en", |_, _| Ok(800)).unwrap();
    let mut last = None;
    for _ in &plan.windows {
        let outcome = session::execution::step(
            vault,
            &context,
            "en",
            &AtomicBool::new(false),
            |_, _| Ok(800),
            |_, user, _, _, schema| session::compiler::fixture_model(schema, user, false),
        );
        if outcome.is_err() {
            return (context, outcome);
        }
        last = Some(outcome);
    }
    (context, last.unwrap())
}

fn store_directory() -> PathBuf {
    crate::settings::settings_dir()
        .unwrap()
        .canonicalize()
        .unwrap()
        .join("session-compile-custody")
}

fn only_file(suffix: &str) -> PathBuf {
    let paths: Vec<_> = std::fs::read_dir(store_directory())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .ends_with(suffix)
        })
        .collect();
    assert_eq!(paths.len(), 1);
    paths[0].clone()
}

#[test]
fn reopened_update_permit_preserves_human_edits_without_restoring_completion() {
    with_isolated_data("compiler-custody-update-only", |_| {
        let (directory, vault, source) = fixture();
        let (context, outcome) = compile(&vault, &source);
        assert_eq!(outcome.unwrap().state, session::WorkState::Completed);
        let path = directory.path().join(&context.summary_path);
        let human = std::fs::read_to_string(&path).unwrap().replacen(
            "title: \"Synthetic report\"\n",
            "title: \"Human chosen title\"\n",
            1,
        ) + "\nHuman postscript remains.\n";
        std::fs::write(&path, &human).unwrap();
        let before = std::fs::read(Pending::path(directory.path())).unwrap();
        let store = custody::Store::open(directory.path(), &context).unwrap();
        let guard = crate::vault::lock_file_mutation().unwrap();
        let permit = store.prior_locked(&guard, None).unwrap().unwrap();
        assert_eq!(
            crate::vault::read_compiler_prior_file_pin_locked(&guard, &permit.pin)
                .unwrap()
                .0,
            human
        );
        range(&human, &permit.ownership).unwrap();
        drop(guard);
        drop(store);
        assert_eq!(
            std::fs::read(Pending::path(directory.path())).unwrap(),
            before
        );
        assert!(session::complete(
            &vault,
            &context,
            std::slice::from_ref(&context.summary_path)
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(directory.path().join(&source.raw_path)).unwrap(),
            RAW
        );
    });
}

#[test]
fn corrupt_missing_and_unsafe_native_custody_records_fail_closed() {
    for fault in [
        "unknown_head_field",
        "changed_record",
        "changed_baseline",
        "missing_head",
        "unsafe_mode",
    ] {
        with_isolated_data("compiler-custody-corrupt", |_| {
            let (directory, vault, source) = fixture();
            let (context, outcome) = compile(&vault, &source);
            assert_eq!(outcome.unwrap().state, session::WorkState::Completed);
            let path = directory.path().join(&context.summary_path);
            let canonical = std::fs::read(&path).unwrap();
            let head = only_file(".head.json");
            match fault {
                "unknown_head_field" => {
                    let mut value: Value =
                        serde_json::from_slice(&std::fs::read(&head).unwrap()).unwrap();
                    value["callerAuthority"] = json!(true);
                    std::fs::write(&head, value.to_string()).unwrap();
                }
                "changed_record" => std::fs::write(only_file(".record.json"), "{}").unwrap(),
                "changed_baseline" => {
                    std::fs::write(only_file(".baseline.txt"), "Synthetic corruption").unwrap()
                }
                "missing_head" => std::fs::remove_file(&head).unwrap(),
                "unsafe_mode" => {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&head, std::fs::Permissions::from_mode(0o644))
                        .unwrap();
                }
                _ => unreachable!(),
            }
            assert!(
                custody::Store::open(directory.path(), &context).is_err(),
                "{fault}"
            );
            assert_eq!(std::fs::read(&path).unwrap(), canonical);
            assert_eq!(
                std::fs::read_to_string(directory.path().join(&source.raw_path)).unwrap(),
                RAW
            );
        });
    }
}

#[test]
fn stale_head_replay_cannot_reclaim_the_current_native_generation() {
    with_isolated_data("compiler-custody-stale-head", |_| {
        let (directory, vault, source) = fixture();
        let (first, outcome) = compile(&vault, &source);
        assert_eq!(outcome.unwrap().state, session::WorkState::Completed);
        let head = only_file(".head.json");
        let old_head = std::fs::read(&head).unwrap();
        let raw = RAW.to_string()
            + "\n**User:**\nThe synthetic report is withdrawn; do not treat it as completed.\n";
        let next = session::SourceBinding {
            key: source.key.clone(),
            raw_path: "raw/conversations/codex/synthetic-custody-r2.md".into(),
            source_revision: source_revision(&raw),
        };
        append_raw(directory.path(), &next.raw_path, &raw).unwrap();
        admit(directory.path(), &next);
        let (second, outcome) = compile(&vault, &next);
        assert_eq!(outcome.unwrap().state, session::WorkState::Completed);
        assert_eq!(second.summary_path, first.summary_path);
        let current = std::fs::read(directory.path().join(&second.summary_path)).unwrap();
        assert_ne!(std::fs::read(&head).unwrap(), old_head);
        std::fs::write(&head, &old_head).unwrap();
        // Eligible predecessor files are now retired. Replaying their old head
        // must fail at open, before any prior-section permit can be requested.
        let error = custody::Store::open(directory.path(), &second)
            .err()
            .expect("a retired head cannot reclaim native custody");
        assert!(error.contains("head record is missing"), "{error}");
        assert_eq!(
            std::fs::read(directory.path().join(&second.summary_path)).unwrap(),
            current
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join(&source.raw_path)).unwrap(),
            RAW
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join(&next.raw_path)).unwrap(),
            raw
        );
    });
}

#[test]
fn unanchored_public_marker_never_enrolls_as_native_section_custody() {
    with_isolated_data("compiler-custody-forged-marker", |_| {
        let (directory, vault, source) = fixture();
        let context = session::begin(
            &vault,
            &vault.snapshot().unwrap(),
            source.clone(),
            RoleUsage::Foreground,
        )
        .unwrap();
        let path = directory.path().join(&context.summary_path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let forged = format!("---\ntype: source-summary\nsession_key: {}\n---\n{START}{{\"passed\":true}} -->\nCaller body\n{END}\n", serde_json::to_string(&source.key).unwrap());
        std::fs::write(&path, &forged).unwrap();
        let (_, outcome) = compile(&vault, &source);
        assert!(outcome
            .err()
            .unwrap()
            .to_string()
            .contains("ownership or original lineage is unresolved"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), forged);
        assert_eq!(std::fs::read_dir(store_directory()).unwrap().count(), 0);
        let pending = Pending::try_load(directory.path()).unwrap();
        assert!(pending.compile_jobs[0].receipts.is_empty());
        assert!(pending.compile_jobs[0]
            .attempts
            .last()
            .unwrap()
            .outputs
            .is_empty());
        assert_eq!(
            std::fs::read_to_string(directory.path().join(&source.raw_path)).unwrap(),
            RAW
        );
    });
}

#[test]
fn initial_nonregular_page_is_rejected_before_any_blocking_read() {
    with_isolated_data("compiler-custody-initial-fifo", |_| {
        let (directory, _, _) = fixture();
        let path = directory.path().join("synthetic-fifo");
        let name = std::ffi::CString::new(path.to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let guard = crate::vault::lock_file_mutation().unwrap();
        assert!(custody::read_initial(&path).is_err());
        drop(guard);
    });
}

#[test]
fn real_anchored_write_failure_before_journal_commit_retains_without_completion() {
    with_isolated_data("compiler-custody-after-anchor", |_| {
        let (directory, vault, source) = fixture();
        *custody::AFTER_ANCHORED_WRITE.lock().unwrap() = Some(Box::new(|path| {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(std::fs::metadata(path).unwrap().nlink(), 2);
            assert!(std::fs::read_to_string(path).unwrap().contains(START));
            Err("synthetic failure after real canonical and anchor publication".into())
        }));
        let (context, outcome) = compile(&vault, &source);
        assert!(outcome
            .err()
            .unwrap()
            .to_string()
            .contains("after real canonical and anchor publication"));
        let retained = std::fs::read(directory.path().join(&context.summary_path)).unwrap();
        assert!(only_file(".anchor").exists());
        assert!(custody::Store::open(directory.path(), &context).is_err());
        let pending = Pending::try_load(directory.path()).unwrap();
        let job = &pending.compile_jobs[0];
        let attempt = job.attempts.last().unwrap();
        assert!(job.receipts.is_empty());
        assert!(attempt.outputs.is_empty());
        assert!(!attempt.prepared_outputs.is_empty());
        assert_eq!(
            std::fs::read(directory.path().join(&context.summary_path)).unwrap(),
            retained
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join(&source.raw_path)).unwrap(),
            RAW
        );
    });
}

#[test]
fn app_data_inside_the_vault_cannot_become_private_custody() {
    with_isolated_data("compiler-custody-in-vault-data", |data| {
        let (directory, vault, source) = fixture();
        let context = session::begin(
            &vault,
            &vault.snapshot().unwrap(),
            source.clone(),
            RoleUsage::Foreground,
        )
        .unwrap();
        let inside = directory.path().join("synthetic-app-data");
        std::fs::create_dir_all(&inside).unwrap();
        // The existing isolated-data harness owns its process-global env lock.
        unsafe {
            std::env::set_var("MYCO_DATA_DIR", &inside);
        }
        let refused = custody::Store::open(directory.path(), &context).is_err();
        unsafe {
            std::env::set_var("MYCO_DATA_DIR", data);
        }
        assert!(refused);
        assert!(!inside.join("session-compile-custody").exists());
        assert_eq!(
            std::fs::read_to_string(directory.path().join(&source.raw_path)).unwrap(),
            RAW
        );
    });
}

#[path = "compiled_custody_retirement_tests.rs"]
mod retirement_tests;

#[path = "compiled_custody_retirement_flow_tests.rs"]
mod retirement_flow_tests;
#[path = "compiled_custody_retirement_process_tests.rs"]
mod retirement_process_tests;
