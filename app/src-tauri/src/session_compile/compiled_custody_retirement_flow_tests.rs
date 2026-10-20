//! Actual native publication/preflight controls with synthetic compiler callbacks.
use super::*;
use std::cell::Cell;
use std::os::unix::fs::PermissionsExt;

fn next_source(
    root: &Path,
    previous: &session::SourceBinding,
    ordinal: usize,
) -> session::SourceBinding {
    let raw = std::fs::read_to_string(root.join(&previous.raw_path)).unwrap()
        + &format!("\n**User:**\nPlease request the synthetic report revision {ordinal}.\n");
    let next = session::SourceBinding {
        key: previous.key.clone(),
        raw_path: format!("raw/conversations/codex/synthetic-flow-r{ordinal}.md"),
        source_revision: source_revision(&raw),
    };
    append_raw(root, &next.raw_path, &raw).unwrap();
    admit(root, &next);
    next
}

fn head_value() -> Value {
    serde_json::from_slice(&std::fs::read(only_file(".head.json")).unwrap()).unwrap()
}

fn blocked_direct(
    vault: &VaultRoot,
    source: &session::SourceBinding,
    state: session::WorkState,
    reason: &str,
) {
    let request_context = session::begin(
        vault,
        &vault.snapshot().unwrap(),
        source.clone(),
        RoleUsage::Foreground,
    )
    .unwrap();
    let request = format!("synthetic-retirement-{}", request_context.attempt_id);
    let owner = session::execution::bind_request(vault, &request_context, &request, "en").unwrap();
    let accesses = Cell::new(0);
    let wrapper_error = crate::local_generation::run_preflighted_task(
        vault,
        &request_context,
        &owner,
        "en",
        &AtomicBool::new(false),
        || {
            accesses.set(accesses.get() + 1);
            Ok::<(), session::failure::CompileFailure>(())
        },
    )
    .expect_err("pending custody must stop the actual adapter before model access");
    assert_eq!(accesses.get(), 0);
    assert_eq!(wrapper_error.outcome.as_ref().unwrap().state, state);
    assert_eq!(
        serde_json::to_value(wrapper_error.outcome.as_ref().unwrap().reason).unwrap(),
        reason
    );
    assert!(
        wrapper_error.finalization_error.is_none(),
        "{wrapper_error}"
    );
    session::execution::release_request(&request_context, &request);
    let context = session::begin(
        vault,
        &vault.snapshot().unwrap(),
        source.clone(),
        RoleUsage::Foreground,
    )
    .unwrap();
    assert_ne!(context.attempt_id, request_context.attempt_id);
    let tokens = Cell::new(0);
    let generations = Cell::new(0);
    // Do not call the parent compile helper: its synthetic planning tokenizer is
    // intentionally outside the actual execution boundary under test here.
    let error = session::execution::step(
        vault,
        &context,
        "en",
        &AtomicBool::new(false),
        |_, _| {
            tokens.set(tokens.get() + 1);
            Ok(800)
        },
        |_, user, _, _, schema| {
            generations.set(generations.get() + 1);
            session::compiler::fixture_model(schema, user, false)
        },
    )
    .err()
    .expect("pending retirement must refuse the direct lease");
    assert_eq!(tokens.get(), 0);
    assert_eq!(generations.get(), 0);
    let outcome = error
        .outcome
        .as_ref()
        .expect("exact owned failure was saved");
    assert_eq!(outcome.state, state);
    assert_eq!(serde_json::to_value(outcome.reason).unwrap(), reason);
    assert!(error.finalization_error.is_none(), "{error}");
    let pending = Pending::try_load(Path::new(&context.origin.vault_path)).unwrap();
    let job = pending
        .compile_jobs
        .iter()
        .find(|job| job.id == context.job_id)
        .unwrap();
    assert_eq!(job.state, state);
    assert!(job.receipts.is_empty());
}

#[test]
fn retained_predecessor_keeps_real_r2_completed_blocks_r3_before_tokens_and_allows_other_scope() {
    with_isolated_data("compiler-retirement-flow-retained", |_| {
        let (directory, vault, source) = fixture();
        let root = directory.path();
        let (first, result) = compile(&vault, &source);
        assert_eq!(result.unwrap().state, session::WorkState::Completed);
        let old_anchor = only_file(".anchor");
        let late_anchor = old_anchor.clone();
        *custody::AFTER_ANCHORED_WRITE.lock().unwrap() = Some(Box::new(move |_| {
            let original =
                std::fs::read_to_string(&late_anchor).map_err(|error| error.to_string())?;
            std::fs::write(
                &late_anchor,
                original + "\nUnique human bytes after successor publication.\n",
            )
            .map_err(|error| error.to_string())
        }));
        let second_source = next_source(root, &source, 2);
        let (second, result) = compile(&vault, &second_source);
        let second_result = result.unwrap();
        assert_eq!(second_result.state, session::WorkState::Completed);
        assert_eq!(second.summary_path, first.summary_path);
        let diagnostic = &second_result.publication.as_ref().unwrap()["custodyRetirement"];
        assert_eq!(diagnostic["state"], "retained");
        assert_eq!(diagnostic["step"], 0);
        assert_eq!(diagnostic["reason"], "unique_human_bytes");
        let head = head_value();
        assert_eq!(head["retirementState"], "retained");
        assert_eq!(head["retirementStep"], 0);
        assert_eq!(head["retirementReason"], "unique_human_bytes");
        let late = std::fs::read(&old_anchor).unwrap();
        let current = std::fs::read(root.join(&second.summary_path)).unwrap();
        assert!(!String::from_utf8(current.clone())
            .unwrap()
            .contains("Unique human bytes"));
        let pending = Pending::try_load(root).unwrap();
        let completed = pending
            .compile_jobs
            .iter()
            .find(|job| job.id == second.job_id)
            .unwrap();
        assert_eq!(completed.receipts.len(), 1);
        assert_eq!(completed.state, session::WorkState::Completed);
        let third = next_source(root, &second_source, 3);
        blocked_direct(
            &vault,
            &third,
            session::WorkState::Pending,
            "custody_retirement_pending",
        );
        assert_eq!(std::fs::read(&old_anchor).unwrap(), late);
        assert_eq!(
            std::fs::read(root.join(&second.summary_path)).unwrap(),
            current
        );
        assert_eq!(
            std::fs::read_to_string(root.join(&source.raw_path)).unwrap(),
            RAW
        );

        let before: Vec<_> = std::fs::read_dir(store_directory())
            .unwrap()
            .map(|entry| {
                let path = entry.unwrap().path();
                (path.clone(), std::fs::read(path).unwrap())
            })
            .collect();
        let other_raw = RAW.replace("synthetic-custody", "synthetic-independent");
        let other = session::SourceBinding {
            key: "codex:synthetic-independent".into(),
            raw_path: "raw/conversations/codex/synthetic-independent.md".into(),
            source_revision: source_revision(&other_raw),
        };
        append_raw(root, &other.raw_path, &other_raw).unwrap();
        admit(root, &other);
        let (other_context, other_result) = compile(&vault, &other);
        assert_eq!(other_result.unwrap().state, session::WorkState::Completed);
        assert_ne!(other_context.summary_path, second.summary_path);
        for (path, bytes) in before {
            assert_eq!(std::fs::read(path).unwrap(), bytes);
        }
    });
}

#[test]
fn unsafe_or_missing_retired_capture_keeps_r2_receipt_and_records_bounded_native_cause() {
    for fault in ["unsafe_mode", "missing"] {
        with_isolated_data("compiler-retirement-flow-capture", |_| {
            let (directory, vault, source) = fixture();
            let (_, result) = compile(&vault, &source);
            assert_eq!(result.unwrap().state, session::WorkState::Completed);
            let old_anchor = only_file(".anchor");
            *custody::AFTER_ANCHORED_WRITE.lock().unwrap() = Some(Box::new(move |_| {
                if fault == "unsafe_mode" {
                    std::fs::set_permissions(&old_anchor, std::fs::Permissions::from_mode(0o644))
                } else {
                    std::fs::remove_file(&old_anchor)
                }
                .map_err(|error| error.to_string())
            }));
            let second_source = next_source(directory.path(), &source, 2);
            let (second, result) = compile(&vault, &second_source);
            let outcome = result.unwrap();
            assert_eq!(outcome.state, session::WorkState::Completed);
            let diagnostic = &outcome.publication.as_ref().unwrap()["custodyRetirement"];
            assert_eq!(diagnostic["state"], "failed");
            assert_eq!(diagnostic["reason"], "capture_failed");
            assert_eq!(diagnostic["step"], 0);
            let detail = diagnostic["detail"].as_str().unwrap();
            assert!(detail.contains(if fault == "unsafe_mode" {
                "mode"
            } else {
                "missing"
            }));
            assert!(!detail.contains(&second.origin.vault_path));
            let head = head_value();
            assert_eq!(head["retirementState"], "failed");
            assert_eq!(head["retirementStep"], 0);
            let record = store_directory().join(format!(
                "{}.{}.record.json",
                only_file(".head.json")
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .strip_suffix(".head.json")
                    .unwrap(),
                head["generation"].as_str().unwrap()
            ));
            let record: Value = serde_json::from_slice(&std::fs::read(record).unwrap()).unwrap();
            assert!(record["retirement"]["anchor"]["snapshot"].is_null());
            let errors = record["retirement"]["captureErrors"].as_array().unwrap();
            assert_eq!(errors.len(), 1);
            assert_eq!(errors[0]["target"], "anchor");
            assert_eq!(errors[0]["phase"], "capture");
            assert!(errors[0]["detail"].as_str().unwrap().chars().count() <= 512);
            let pending = Pending::try_load(directory.path()).unwrap();
            assert_eq!(
                pending
                    .compile_jobs
                    .iter()
                    .find(|job| job.id == second.job_id)
                    .unwrap()
                    .receipts
                    .len(),
                1
            );
            let third = next_source(directory.path(), &second_source, 3);
            blocked_direct(
                &vault,
                &third,
                session::WorkState::Failed,
                "processing_failed",
            );
            assert_eq!(
                std::fs::read_to_string(directory.path().join(&source.raw_path)).unwrap(),
                RAW
            );
        });
    }
}

#[test]
fn uncertain_cursor_ack_keeps_valid_r2_completed_and_resumes_without_deleting_another_leaf() {
    with_isolated_data("compiler-retirement-flow-ack", |_| {
        let (directory, vault, source) = fixture();
        let (_, result) = compile(&vault, &source);
        assert_eq!(result.unwrap().state, session::WorkState::Completed);
        let old_baseline = only_file(".baseline.txt");
        let old_record = only_file(".record.json");
        let old_anchor = only_file(".anchor");
        *custody::AFTER_UNLINK.lock().unwrap() = Some(Box::new(move |_| {
            *custody::AFTER_HEAD_PERSIST.lock().unwrap() = Some(Box::new(|| {
                Err("synthetic cursor readback failure after actual persist".into())
            }));
            Ok(())
        }));
        let second_source = next_source(directory.path(), &source, 2);
        let (context, result) = compile(&vault, &second_source);
        let outcome = result.unwrap();
        assert_eq!(outcome.state, session::WorkState::Completed);
        let diagnostic = &outcome.publication.as_ref().unwrap()["custodyRetirement"];
        assert_eq!(diagnostic["state"], "failed");
        assert_eq!(diagnostic["step"], 1);
        assert!(diagnostic["diagnosticPersistenceError"]
            .as_str()
            .unwrap()
            .contains("synthetic cursor readback"));
        assert_eq!(head_value()["retirementStep"], 1);
        assert!(!old_anchor.exists());
        assert!(
            old_baseline.exists() && old_record.exists(),
            "ack failure must stop further cleanup"
        );
        let before = std::fs::read(directory.path().join(&context.summary_path)).unwrap();
        let diagnostic = session::with_attempt(&vault, &context, |root, _, _| {
            session::publication::maintain_custody(root, &context)
        });
        // Completed attempts cannot reacquire a running grant merely to repair
        // custody. The next fresh attempt must provide a current role/opening.
        assert!(diagnostic.is_err());
        let third = next_source(directory.path(), &second_source, 3);
        let fresh = session::begin(
            &vault,
            &vault.snapshot().unwrap(),
            third,
            RoleUsage::Foreground,
        )
        .unwrap();
        let resumed = session::with_attempt(&vault, &fresh, |root, _, _| {
            session::publication::maintain_custody(root, &fresh)
        })
        .unwrap();
        assert!(resumed.is_complete());
        assert!(!old_baseline.exists() && !old_record.exists());
        assert_eq!(
            std::fs::read(directory.path().join(&context.summary_path)).unwrap(),
            before
        );
        assert_eq!(std::fs::read_dir(store_directory()).unwrap().count(), 4);
    });
}

#[test]
fn changed_current_head_after_cleanup_is_fatal_instead_of_a_completed_diagnostic() {
    with_isolated_data("compiler-retirement-flow-fatal-head", |_| {
        let (directory, vault, source) = fixture();
        let (_, result) = compile(&vault, &source);
        assert_eq!(result.unwrap().state, session::WorkState::Completed);
        let head_path = only_file(".head.json");
        *custody::AFTER_UNLINK.lock().unwrap() = Some(Box::new(move |_| {
            *custody::AFTER_HEAD_PERSIST.lock().unwrap() = Some(Box::new(move || {
                std::fs::write(&head_path, "{}").map_err(|error| error.to_string())?;
                Err("synthetic actual current head corruption".into())
            }));
            Ok(())
        }));
        let second_source = next_source(directory.path(), &source, 2);
        let (context, result) = compile(&vault, &second_source);
        let error = result
            .err()
            .expect("invalid live head cannot be downgraded to a cleanup diagnostic");
        assert!(error.message.contains("current head"), "{error}");
        let pending = Pending::try_load(directory.path()).unwrap();
        let job = pending
            .compile_jobs
            .iter()
            .find(|job| job.id == context.job_id)
            .unwrap();
        assert_ne!(job.state, session::WorkState::Completed);
        assert!(job.receipts.is_empty());
        assert_eq!(
            std::fs::read_to_string(directory.path().join(&source.raw_path)).unwrap(),
            RAW
        );
    });
}

#[test]
fn active_v1_compatibility_requires_fresh_native_successor_and_never_sweeps_unwitnessed_history() {
    with_isolated_data("compiler-retirement-flow-v1", |_| {
        let (directory, vault, source) = fixture();
        let (_, result) = compile(&vault, &source);
        assert_eq!(result.unwrap().state, session::WorkState::Completed);
        let head_path = only_file(".head.json");
        let old_record_path = only_file(".record.json");
        let old_baseline = only_file(".baseline.txt");
        let old_anchor = only_file(".anchor");
        // Synthetic format compatibility only: retain the actual native R1
        // physical pair/source/ownership and remove fields absent in v1.
        let mut record: Value =
            serde_json::from_slice(&std::fs::read(&old_record_path).unwrap()).unwrap();
        record["version"] = json!(1);
        record.as_object_mut().unwrap().remove("retirement");
        let text = record.to_string();
        std::fs::write(&old_record_path, &text).unwrap();
        let mut head = head_value();
        head["version"] = json!(1);
        head["recordSha256"] = json!(source_revision(&text));
        for field in ["retirementStep", "retirementState", "retirementReason"] {
            head.as_object_mut().unwrap().remove(field);
        }
        std::fs::write(&head_path, head.to_string()).unwrap();
        let key = head_path
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .strip_suffix(".head.json")
            .unwrap();
        let unknown = store_directory().join(format!("{key}.{}.record.json", "f".repeat(32)));
        let unknown_bytes = b"Unwitnessed inactive legacy history must be preserved.";
        std::fs::write(&unknown, unknown_bytes).unwrap();
        std::fs::set_permissions(&unknown, std::fs::Permissions::from_mode(0o600)).unwrap();
        let next = next_source(directory.path(), &source, 2);
        let fresh = session::begin(
            &vault,
            &vault.snapshot().unwrap(),
            next.clone(),
            RoleUsage::Foreground,
        )
        .unwrap();
        let before = std::fs::read(&old_anchor).unwrap();
        let diagnostic = session::with_attempt(&vault, &fresh, |root, _, _| {
            session::publication::maintain_custody(root, &fresh)
        })
        .unwrap();
        assert!(diagnostic.is_complete());
        assert_eq!(std::fs::read(&old_anchor).unwrap(), before);
        assert!(
            old_record_path.exists() && old_baseline.exists(),
            "v1 read alone does not enroll old history for cleanup"
        );
        let raw = session::checked_source(directory.path(), &next).unwrap();
        let plan =
            session::sources::prepare(&next, &raw, &fresh.origin, "en", |_, _| Ok(800)).unwrap();
        let mut reviews = 0;
        let mut completed = None;
        for _ in &plan.windows {
            completed = Some(
                session::execution::step(
                    &vault,
                    &fresh,
                    "en",
                    &AtomicBool::new(false),
                    |_, _| Ok(800),
                    |_, user, _, _, schema| {
                        if schema == session::compiler::CompilerSchema::Review {
                            reviews += 1;
                        }
                        session::compiler::fixture_model(schema, user, false)
                    },
                )
                .unwrap(),
            );
        }
        assert_eq!(completed.unwrap().state, session::WorkState::Completed);
        assert_eq!(reviews, plan.windows.len());
        assert!(!old_record_path.exists() && !old_baseline.exists() && !old_anchor.exists());
        assert_eq!(std::fs::read(&unknown).unwrap(), unknown_bytes);
        assert_eq!(
            std::fs::read_dir(store_directory()).unwrap().count(),
            5,
            "current four plus unowned history"
        );
        assert_eq!(head_value()["version"], 2);
        assert_eq!(
            std::fs::read_to_string(directory.path().join(&source.raw_path)).unwrap(),
            RAW
        );
    });
}
