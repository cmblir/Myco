//! Synthetic durable failure regressions, without model or installed UI claims.

use super::*;

#[test]
fn malformed_review_finalizes_failed_without_publishing_or_removing_original() {
    with_isolated_data("compiler-malformed-review-finalization", |_| {
        let (dir, vault, origin, source) = fixture();
        let original = super::super::super::checked_source(dir.path(), &source).unwrap();
        let context =
            super::super::super::begin(&vault, &origin, source, RoleUsage::Foreground).unwrap();
        let error = step(
            &vault,
            &context,
            "en",
            &AtomicBool::new(false),
            |_, _| Ok(800),
            |_, user, _, _, schema| {
                if schema == CompilerSchema::Review {
                    Ok("{malformed review".into())
                } else {
                    model(schema, user, false)
                }
            },
        )
        .err()
        .unwrap();
        assert!(!error.to_string().is_empty());
        let pending = Pending::try_load(dir.path()).unwrap();
        let job = &pending.compile_jobs[0];
        assert_eq!(job.state, WorkState::Failed);
        assert_eq!(job.attempts[0].state, WorkState::Failed);
        assert_eq!(job.reason.as_deref(), Some("processing_failed"));
        assert!(job.attempts[0].compiler_progress.is_none());
        assert!(job.attempts[0].outputs.is_empty());
        assert!(job.receipts.is_empty());
        assert!(!dir.path().join(&context.summary_path).exists());
        assert_eq!(
            super::super::super::checked_source(dir.path(), &context.source).unwrap(),
            original
        );
    });
}

#[test]
fn generator_failure_preserves_previous_verified_checkpoint() {
    with_isolated_data("compiler-failure-previous-checkpoint", |_| {
        let (dir, vault, origin, source) = fixture();
        let context =
            super::super::super::begin(&vault, &origin, source, RoleUsage::Foreground).unwrap();
        step(
            &vault,
            &context,
            "en",
            &AtomicBool::new(false),
            |_, _| Ok(800),
            |_, user, _, _, schema| model(schema, user, false),
        )
        .unwrap();
        let before = serde_json::to_value(
            Pending::try_load(dir.path()).unwrap().compile_jobs[0].attempts[0]
                .compiler_progress
                .clone(),
        )
        .unwrap();
        let error = step(
            &vault,
            &context,
            "en",
            &AtomicBool::new(false),
            |_, _| Ok(800),
            |_, _, _, _, _| Err("synthetic generator failed".into()),
        )
        .err()
        .unwrap();
        assert!(error.to_string().contains("synthetic generator failed"));
        let pending = Pending::try_load(dir.path()).unwrap();
        let job = &pending.compile_jobs[0];
        assert_eq!(job.state, WorkState::Failed);
        assert_eq!(
            serde_json::to_value(&job.attempts[0].compiler_progress).unwrap(),
            before
        );
        assert!(job.receipts.is_empty());
        assert!(job.attempts[0].outputs.is_empty());
    });
}

use crate::session_compile as session;

#[test]
fn each_owned_processing_stage_records_exact_failure_without_a_completion_receipt() {
    for target in [
        None,
        Some(CompilerSchema::Claims),
        Some(CompilerSchema::Compilation),
        Some(CompilerSchema::Review),
    ] {
        with_isolated_data("compiler-stage-failures", |_| {
            let (dir, vault, origin, source) = fixture();
            let context = session::begin(&vault, &origin, source, RoleUsage::Foreground).unwrap();
            let mut failure = None;
            for _ in 0..3 {
                let result = step(
                    &vault,
                    &context,
                    "en",
                    &AtomicBool::new(false),
                    |_, _| {
                        if target.is_none() {
                            Err("synthetic tokenizer failure".into())
                        } else {
                            Ok(800)
                        }
                    },
                    |_, user, _, _, schema| {
                        if Some(schema) == target {
                            Err(format!("synthetic {schema:?} failure"))
                        } else {
                            session::compiler::fixture_model(schema, user, false)
                        }
                    },
                );
                if let Err(error) = result {
                    failure = Some(error);
                    break;
                }
            }
            let error = failure.expect("selected processing stage must be reached");
            let expected = if target == Some(CompilerSchema::Review) {
                WorkState::Partial
            } else {
                WorkState::Failed
            };
            assert_eq!(error.outcome.as_ref().unwrap().state, expected);
            assert!(error.finalization_error.is_none());
            let pending = Pending::try_load(dir.path()).unwrap();
            assert_eq!(pending.compile_jobs[0].state, expected);
            if target == Some(CompilerSchema::Review) {
                let attempt = &pending.compile_jobs[0].attempts[0];
                assert_eq!(
                    attempt.reason.as_deref(),
                    Some("semantic_review_unavailable")
                );
                assert_eq!(attempt.checks.semantic_review, CheckState::Unavailable);
                assert_eq!(attempt.checks.processed_units, 0);
                let progress = serde_json::to_value(&attempt.compiler_progress).unwrap();
                assert_eq!(progress["nextPacket"], 0);
                assert_eq!(progress["batches"], json!([]));
                assert!(progress["unreviewedBatch"].is_object());
                assert_eq!(progress["unreviewedBatch"]["reviewOutput"], Value::Null);
            }
            assert!(pending.compile_jobs[0].receipts.is_empty());
            assert!(pending.compile_jobs[0].attempts[0].outputs.is_empty());
            assert!(dir.path().join(&context.source.raw_path).exists());
        });
    }
}

#[test]
fn foreign_owner_busy_and_changed_language_are_admission_errors_without_mutation() {
    with_isolated_data("compiler-owner-admission", |_| {
        let (dir, vault, origin, source) = fixture();
        let context = session::begin(&vault, &origin, source, RoleUsage::Foreground).unwrap();
        let owner = bind_request(&vault, &context, "synthetic-owned-request", "en").unwrap();
        let before = std::fs::read(Pending::path(dir.path())).unwrap();
        let mut foreign = context.clone();
        foreign.attempt_id = "synthetic-foreign-attempt".into();
        let error = step_for_request(
            &vault,
            &foreign,
            "en",
            &AtomicBool::new(false),
            &owner,
            |_, _| panic!("foreign owner cannot tokenize"),
            |_, _, _, _, _| panic!("foreign owner cannot generate"),
        )
        .err()
        .unwrap();
        assert!(error.outcome.is_none());
        assert!(error.finalization_error.is_none());
        grants()
            .lock()
            .unwrap()
            .get_mut(&context.attempt_id)
            .unwrap()
            .compiler_busy = true;
        let error = step_for_request(
            &vault,
            &context,
            "en",
            &AtomicBool::new(false),
            &owner,
            |_, _| panic!("busy request cannot tokenize"),
            |_, _, _, _, _| panic!("busy request cannot generate"),
        )
        .err()
        .unwrap();
        assert!(error.outcome.is_none());
        assert!(error.finalization_error.is_none());
        grants()
            .lock()
            .unwrap()
            .get_mut(&context.attempt_id)
            .unwrap()
            .compiler_busy = false;
        assert!(bind_request(&vault, &context, "synthetic-duplicate-request", "en").is_err());
        assert_eq!(std::fs::read(Pending::path(dir.path())).unwrap(), before);
        release_request(&context, "synthetic-owned-request");
        step(
            &vault,
            &context,
            "en",
            &AtomicBool::new(false),
            |_, _| Ok(800),
            |_, user, _, _, schema| model(schema, user, false),
        )
        .unwrap();
        let before = std::fs::read(Pending::path(dir.path())).unwrap();
        assert!(bind_request(&vault, &context, "synthetic-changed-language", "ko").is_err());
        let error = step(
            &vault,
            &context,
            "ko",
            &AtomicBool::new(false),
            |_, _| panic!("changed language cannot tokenize"),
            |_, _, _, _, _| panic!("changed language cannot generate"),
        )
        .err()
        .unwrap();
        assert!(error.outcome.is_none());
        assert!(error.finalization_error.is_none());
        assert_eq!(std::fs::read(Pending::path(dir.path())).unwrap(), before);
    });
}

#[test]
fn changed_source_and_revoked_role_end_only_owned_attempt_without_publication() {
    for revoke in [false, true] {
        with_isolated_data("compiler-owned-revocation-cleanup", |_| {
            let (dir, vault, origin, source) = fixture();
            let context = session::begin(&vault, &origin, source, RoleUsage::Foreground).unwrap();
            let original = std::fs::read(dir.path().join(&context.source.raw_path)).unwrap();
            let error = step(
                &vault,
                &context,
                "en",
                &AtomicBool::new(false),
                |_, _| Ok(800),
                |_, _, _, _, _| {
                    if revoke {
                        crate::role_authorization::with_credential_change(|| Ok(())).unwrap();
                    } else {
                        std::fs::write(
                            dir.path().join(&context.source.raw_path),
                            "Synthetic changed original",
                        )
                        .unwrap();
                    }
                    Err("synthetic original generator failure".into())
                },
            )
            .err()
            .unwrap();
            assert!(error
                .message
                .contains("synthetic original generator failure"));
            assert!(error.message.contains("post-generation check"));
            assert_eq!(error.outcome.as_ref().unwrap().state, WorkState::Failed);
            let pending = Pending::try_load(dir.path()).unwrap();
            assert_eq!(pending.compile_jobs[0].state, WorkState::Failed);
            assert!(pending.compile_jobs[0].receipts.is_empty());
            assert!(pending.compile_jobs[0].attempts[0]
                .compiler_progress
                .is_none());
            if revoke {
                assert_eq!(
                    std::fs::read(dir.path().join(&context.source.raw_path)).unwrap(),
                    original
                );
            } else {
                assert_eq!(
                    std::fs::read_to_string(dir.path().join(&context.source.raw_path)).unwrap(),
                    "Synthetic changed original"
                );
            }
        });
    }
}

#[test]
fn intervening_checkpoint_stop_and_new_attempt_are_not_overwritten() {
    for new_attempt in [false, true] {
        with_isolated_data("compiler-stop-new-attempt-finalization", |_| {
            let (dir, vault, origin, source) = fixture();
            let context =
                session::begin(&vault, &origin, source.clone(), RoleUsage::Foreground).unwrap();
            let mut fresh = None;
            let error = step(
                &vault,
                &context,
                "en",
                &AtomicBool::new(false),
                |_, _| Ok(800),
                |_, _, _, _, _| {
                    session::stop(&vault, &context, "stopped").unwrap();
                    if new_attempt {
                        fresh = Some(
                            session::begin(&vault, &origin, source.clone(), RoleUsage::Foreground)
                                .unwrap(),
                        );
                    }
                    Err("synthetic late generator failure".into())
                },
            )
            .err()
            .unwrap();
            assert!(error.message.contains("synthetic late generator failure"));
            assert!(error.outcome.is_none());
            assert!(error.finalization_error.is_some());
            let pending = Pending::try_load(dir.path()).unwrap();
            let job = &pending.compile_jobs[0];
            assert_eq!(job.attempts[0].state, WorkState::Stopped);
            assert_eq!(job.attempts[0].reason.as_deref(), Some("stopped"));
            if let Some(fresh) = fresh {
                assert_eq!(job.attempts.last().unwrap().id, fresh.attempt_id);
                assert_eq!(job.state, WorkState::Running);
            } else {
                assert_eq!(job.state, WorkState::Stopped);
            }
            assert!(job.receipts.is_empty());
        });
    }
    with_isolated_data("compiler-progress-cas-finalization", |_| {
        let (dir, vault, origin, source) = fixture();
        let context = session::begin(&vault, &origin, source, RoleUsage::Foreground).unwrap();
        step(
            &vault,
            &context,
            "en",
            &AtomicBool::new(false),
            |_, _| Ok(800),
            |_, user, _, _, schema| model(schema, user, false),
        )
        .unwrap();
        let error = step(
            &vault,
            &context,
            "en",
            &AtomicBool::new(false),
            |_, _| Ok(800),
            |_, _, _, _, _| {
                let _queue = crate::importers::wikify::import_lock().unwrap();
                let mut pending = Pending::try_load(dir.path()).unwrap();
                pending.compile_jobs[0].attempts[0]
                    .compiler_progress
                    .as_mut()
                    .unwrap()
                    .next_packet = 77;
                pending.save(dir.path()).unwrap();
                Err("synthetic concurrent generator failure".into())
            },
        )
        .err()
        .unwrap();
        assert!(error.outcome.is_none());
        assert!(error
            .finalization_error
            .as_ref()
            .unwrap()
            .contains("checkpoint changed"));
        let pending = Pending::try_load(dir.path()).unwrap();
        assert_eq!(pending.compile_jobs[0].state, WorkState::Running);
        assert_eq!(
            pending.compile_jobs[0].attempts[0]
                .compiler_progress
                .as_ref()
                .unwrap()
                .next_packet,
            77
        );
    });
}

#[test]
fn failed_queue_read_preserves_original_error_without_claiming_durable_outcome() {
    with_isolated_data("compiler-unconfirmed-finalization", |_| {
        let (dir, vault, origin, source) = fixture();
        let context = session::begin(&vault, &origin, source, RoleUsage::Foreground).unwrap();
        let error = step(
            &vault,
            &context,
            "en",
            &AtomicBool::new(false),
            |_, _| Ok(800),
            |_, _, _, _, _| {
                std::fs::write(Pending::path(dir.path()), "{synthetic corrupt queue").unwrap();
                Err("synthetic original generator failure".into())
            },
        )
        .err()
        .unwrap();
        assert!(error
            .message
            .contains("synthetic original generator failure"));
        assert!(error.outcome.is_none());
        assert!(error.finalization_error.is_some());
        assert!(error
            .to_string()
            .contains("finalization could not be confirmed"));
        assert_eq!(
            std::fs::read_to_string(Pending::path(dir.path())).unwrap(),
            "{synthetic corrupt queue"
        );
        assert!(dir.path().join(&context.source.raw_path).exists());
        assert!(!dir.path().join(&context.summary_path).exists());
    });
}

#[cfg(unix)]
#[test]
fn denied_queue_save_preserves_disk_state_and_allows_fresh_manual_retry() {
    denied_queue_save_retry(RoleUsage::Foreground);
}

#[test]
fn unconfirmed_cleanup_cannot_retire_changed_request_or_active_packet() {
    for active_packet in [false, true] {
        with_isolated_data("compiler-unconfirmed-retirement-owner", |_| {
            let (dir, vault, origin, source) = fixture();
            let context = session::begin(&vault, &origin, source, RoleUsage::Foreground).unwrap();
            let owner = bind_request(&vault, &context, "synthetic-owned-request", "en").unwrap();
            let before = std::fs::read(Pending::path(dir.path())).unwrap();
            {
                let mut registry = grants().lock().unwrap();
                let grant = registry.get_mut(&context.attempt_id).unwrap();
                if active_packet {
                    grant.compiler_busy = true;
                } else {
                    grant.compiler_request = Some("synthetic-different-request".into());
                }
            }
            let error = failure::finalize_idle(
                &vault,
                &owner,
                Reason::ProcessingFailed,
                "synthetic stale preparation failure".into(),
            );
            assert!(error.outcome.is_none());
            assert!(error.finalization_error.is_some());
            assert_eq!(std::fs::read(Pending::path(dir.path())).unwrap(), before);
            let retained = {
                let registry = grants().lock().unwrap();
                registry
                    .get(&context.attempt_id)
                    .map(|grant| (grant.compiler_busy, grant.compiler_request.clone()))
            };
            assert_eq!(
                retained,
                Some((
                    active_packet,
                    Some(if active_packet {
                        "synthetic-owned-request".into()
                    } else {
                        "synthetic-different-request".into()
                    })
                ))
            );
            {
                let mut registry = grants().lock().unwrap();
                let grant = registry.get_mut(&context.attempt_id).unwrap();
                grant.compiler_busy = false;
                grant.compiler_request = Some("synthetic-owned-request".into());
            }
            let result = step_for_request(
                &vault,
                &context,
                "en",
                &AtomicBool::new(false),
                &owner,
                |_, _| Ok(800),
                |_, user, _, _, schema| model(schema, user, false),
            )
            .unwrap();
            assert_eq!(result.state, WorkState::Running);
            release_request(&context, "synthetic-owned-request");
        });
    }
}

#[cfg(unix)]
#[test]
fn denied_queue_save_preserves_disk_state_and_allows_fresh_automatic_retry() {
    denied_queue_save_retry(RoleUsage::Automatic);
}

#[cfg(unix)]
fn denied_queue_save_retry(usage: RoleUsage) {
    use std::os::unix::fs::PermissionsExt;

    struct RestorePermissions {
        directory: std::path::PathBuf,
        permissions: std::fs::Permissions,
    }

    impl Drop for RestorePermissions {
        fn drop(&mut self) {
            if let Err(error) = std::fs::set_permissions(&self.directory, self.permissions.clone())
            {
                if std::thread::panicking() {
                    eprintln!("restore synthetic queue directory permissions: {error}");
                } else {
                    panic!("restore synthetic queue directory permissions: {error}");
                }
            }
        }
    }

    with_isolated_data("compiler-denied-queue-save-retry", |_| {
        crate::settings::save(&crate::settings::Settings {
            auto_ingest_enabled: true,
            ..Default::default()
        })
        .unwrap();
        let (dir, vault, origin, source) = fixture();
        let context = session::begin(&vault, &origin, source.clone(), usage).unwrap();
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
        let human_path = dir.path().join(&context.summary_path);
        std::fs::create_dir_all(human_path.parent().unwrap()).unwrap();
        let human: &[u8] = b"# Synthetic human title\nHuman annotation remains.\n";
        std::fs::write(&human_path, human).unwrap();
        let raw_path = dir.path().join(&source.raw_path);
        let original = std::fs::read(&raw_path).unwrap();
        let queue_path = Pending::path(dir.path());
        let queue_parent = queue_path.parent().unwrap().to_path_buf();
        let queue_before = std::fs::read(&queue_path).unwrap();
        let before = Pending::try_load(dir.path()).unwrap();
        let old_attempt = serde_json::to_value(&before.compile_jobs[0].attempts[0]).unwrap();
        assert!(old_attempt["compilerProgress"].is_object());
        let request_id = format!("synthetic-denied-save-{}", context.attempt_id);
        let owner = bind_request(&vault, &context, &request_id, "en").unwrap();
        let saved_permissions = std::fs::metadata(&queue_parent).unwrap().permissions();
        let saved_mode = saved_permissions.mode();
        let mut restore = None;
        let mut generator_calls = 0;
        let error = step_for_request(
            &vault,
            &context,
            "en",
            &AtomicBool::new(false),
            &owner,
            |_, _| Ok(800),
            |_, _, _, _, _| {
                generator_calls += 1;
                restore = Some(RestorePermissions {
                    directory: queue_parent.clone(),
                    permissions: saved_permissions.clone(),
                });
                std::fs::set_permissions(
                    &queue_parent,
                    std::fs::Permissions::from_mode(saved_mode & !0o222),
                )
                .unwrap();
                let probe = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(queue_parent.join("synthetic-denied-write-probe"));
                assert!(
                    matches!(&probe, Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied),
                    "the filesystem must actually deny writes; elevated privileges cannot satisfy this regression: {probe:?}"
                );
                Err("synthetic original generator failure after write denial".into())
            },
        )
        .err()
        .expect("the actual generator failure must reach native finalization");
        assert_eq!(generator_calls, 1);
        assert!(error
            .message
            .contains("synthetic original generator failure after write denial"));
        assert!(error.outcome.is_none());
        let finalization = error.finalization_error.as_ref().unwrap();
        assert!(finalization.contains("publish wikify queue"));
        assert!(finalization.contains("tempfile create failed"));
        assert!(error.to_string().contains(&error.message));
        assert!(error.to_string().contains(finalization));
        assert_eq!(std::fs::read(&queue_path).unwrap(), queue_before);
        assert_eq!(std::fs::read(&raw_path).unwrap(), original);
        assert_eq!(std::fs::read(&human_path).unwrap(), human);
        let unconfirmed = Pending::try_load(dir.path()).unwrap();
        assert_eq!(unconfirmed.compile_jobs[0].state, WorkState::Running);
        assert_eq!(
            serde_json::to_value(&unconfirmed.compile_jobs[0].attempts[0]).unwrap(),
            old_attempt
        );
        assert!(unconfirmed.compile_jobs[0].receipts.is_empty());
        assert!(unconfirmed.receipts.is_empty());
        assert_eq!(unconfirmed.pending.len(), 1);

        release_request(&context, &request_id);
        drop(restore.take());
        assert_eq!(
            std::fs::metadata(&queue_parent)
                .unwrap()
                .permissions()
                .mode(),
            saved_mode
        );
        assert_eq!(std::fs::read(&queue_path).unwrap(), queue_before);
        let retry = session::begin(&vault, &origin, source.clone(), usage)
            .expect("a drained failed owner must allow a fresh attempt after write access returns");
        assert_ne!(retry.attempt_id, context.attempt_id);
        assert_ne!(
            retry.role_snapshot.snapshot_id,
            context.role_snapshot.snapshot_id
        );
        assert_eq!(retry.source, context.source);
        assert_eq!(retry.compile_signature, context.compile_signature);
        let recovered = Pending::try_load(dir.path()).unwrap();
        let job = &recovered.compile_jobs[0];
        assert_eq!(job.attempts.len(), 2);
        assert_eq!(job.attempts[0].state, WorkState::Stopped);
        assert_eq!(
            job.attempts[0].reason.as_deref(),
            Some("expired_origin_or_role_requires_new_attempt")
        );
        let mut retained = serde_json::to_value(&job.attempts[0]).unwrap();
        for field in ["state", "reason", "updated"] {
            retained[field] = old_attempt[field].clone();
        }
        assert_eq!(retained, old_attempt);
        assert_eq!(job.attempts[1].id, retry.attempt_id);
        assert_eq!(job.attempts[1].state, WorkState::Running);
        assert_eq!(
            serde_json::to_value(&job.attempts[1].compiler_progress).unwrap(),
            old_attempt["compilerProgress"]
        );
        assert!(job.attempts[1].outputs.is_empty());
        assert!(job.attempts[1].prepared_outputs.is_empty());
        assert_eq!(job.attempts[1].checks, ProcessingChecks::default());
        assert!(job.receipts.is_empty());
        assert!(recovered.receipts.is_empty());
        assert!(authorize(&vault, &context).is_err());
        let mut fresh_calls = Vec::new();
        let outcome = step(
            &vault,
            &retry,
            "en",
            &AtomicBool::new(false),
            |_, _| Ok(800),
            |_, user, _, _, schema| {
                fresh_calls.push(schema);
                model(schema, user, false)
            },
        )
        .unwrap();
        assert_eq!(fresh_calls, vec![CompilerSchema::Review]);
        assert_eq!(outcome.state, WorkState::Running);
        assert!(outcome.publication.is_none());
        assert_eq!(std::fs::read(&raw_path).unwrap(), original);
        assert_eq!(std::fs::read(&human_path).unwrap(), human);
    });
}

#[test]
fn checkpoint_before_publication_error_retains_intent_file_and_human_bytes() {
    for human in [false, true] {
        with_isolated_data("compiler-publication-failure-finalization", |_| {
            let (dir, vault, origin, source) = fixture();
            let context = session::begin(&vault, &origin, source, RoleUsage::Foreground).unwrap();
            if human {
                std::fs::create_dir_all(dir.path().join("wiki")).unwrap();
                std::fs::write(
                    dir.path().join(&context.summary_path),
                    "# Synthetic human title\nHuman annotation remains.\n",
                )
                .unwrap();
            } else {
                let queue_path = Pending::path(dir.path());
                *session::publication::AFTER_OUTPUT.lock().unwrap() = Some(Box::new(move || {
                    let mut value: Value =
                        serde_json::from_slice(&std::fs::read(&queue_path).unwrap()).unwrap();
                    value["done_count"] = json!(987);
                    std::fs::write(&queue_path, serde_json::to_vec(&value).unwrap()).unwrap();
                }));
            }
            let mut error = None;
            for _ in 0..3 {
                match step(
                    &vault,
                    &context,
                    "en",
                    &AtomicBool::new(false),
                    |_, _| Ok(800),
                    |_, user, _, _, schema| session::compiler::fixture_model(schema, user, false),
                ) {
                    Ok(outcome) => assert_eq!(outcome.state, WorkState::Running),
                    Err(failure) => {
                        error = Some(failure);
                        break;
                    }
                }
            }
            let error = error.expect("actual final publication must fail");
            assert_eq!(error.outcome.as_ref().unwrap().state, WorkState::Failed);
            assert!(error.finalization_error.is_none());
            let pending = Pending::try_load(dir.path()).unwrap();
            let attempt = &pending.compile_jobs[0].attempts[0];
            assert_eq!(attempt.state, WorkState::Failed);
            assert_eq!(attempt.compiler_progress.as_ref().unwrap().next_packet, 3);
            assert!(pending.compile_jobs[0].receipts.is_empty());
            assert!(pending.receipts.is_empty());
            assert_eq!(pending.pending.len(), 1);
            assert!(attempt.outputs.is_empty());
            assert!(dir.path().join(&context.source.raw_path).exists());
            if human {
                assert_eq!(
                    std::fs::read_to_string(dir.path().join(&context.summary_path)).unwrap(),
                    "# Synthetic human title\nHuman annotation remains.\n"
                );
            } else {
                assert_eq!(pending.done_count, 987);
                assert_eq!(attempt.prepared_outputs.len(), 1);
                assert!(dir.path().join(&context.summary_path).exists());
            }
        });
    }
}
