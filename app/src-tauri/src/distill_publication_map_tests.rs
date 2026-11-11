//! Source-verifier callbacks model native grants; they do not mint public ones.

use super::*;
use std::cell::{Cell, RefCell};

const MAP_KEY: &str = "synthetic-topic";
const MAP_PATH: &str = "wiki/maps/synthetic-topic.md";
const MAP_CONTENT: &str = "Checked synthetic map.\n";

impl Fixture {
    fn publish_map(
        &self,
        operation: &str,
        snapshot: &str,
        verify_sources: &dyn Fn() -> Result<(), String>,
    ) -> Result<PublicationReceipt, String> {
        self.state.with_origin(&self.origin, |root| {
            crate::vault::with_root_mutation(root, |canonical, guard| {
                publish_map_locked(
                    canonical,
                    guard,
                    &self.registry,
                    &self.origin,
                    MapPublication {
                        operation,
                        key: MAP_KEY,
                        content: MAP_CONTENT,
                        source_snapshot_id: snapshot,
                        creation_store: None,
                    },
                    verify_sources,
                )
            })
        })
    }
}

#[test]
fn checked_map_creation_and_unchanged_retry_recheck_sources_under_writer_lock() {
    let fixture = Fixture::new();
    let checks = Cell::new(0);
    let verify = || {
        assert!(crate::vault::try_lock_file_mutation()?.is_none());
        checks.set(checks.get() + 1);
        Ok(())
    };
    let first = fixture
        .publish_map("map-create", "private-grant-a", &verify)
        .unwrap();
    assert_eq!(checks.get(), 3);
    assert_eq!(first.path, MAP_PATH);
    assert!(first.native_created);
    assert_eq!(first.state, PublicationPhase::Published);
    assert_eq!(
        std::fs::read_to_string(fixture.root.join(MAP_PATH)).unwrap(),
        MAP_CONTENT
    );
    let retry = fixture
        .publish_map("map-create", "private-grant-a", &verify)
        .unwrap();
    assert_eq!(checks.get(), 4);
    assert_eq!(retry.publication_id, first.publication_id);
    assert_eq!(retry.file_identity, first.file_identity);
    let public_receipt = serde_json::to_value(&first).unwrap();
    assert!(public_receipt.get("sourceSnapshotId").is_none());
    assert_eq!(
        fixture.registry.entries.lock().unwrap()[&first.publication_id]
            .source_snapshot_id
            .as_deref(),
        Some("private-grant-a")
    );
    assert!(
        fixture
            .validate("map-create", &first, claim(&first, false))
            .unwrap()[0]
            .created
    );
}

#[test]
fn source_failure_before_preparation_or_immediately_before_write_keeps_target_absent() {
    for failing_check in [1, 2] {
        let fixture = Fixture::new();
        let checks = Cell::new(0);
        let error = fixture
            .publish_map("map-source-change", "private-grant-a", &|| {
                checks.set(checks.get() + 1);
                if checks.get() == failing_check {
                    Err("source changed".into())
                } else {
                    Ok(())
                }
            })
            .unwrap_err();
        assert_eq!(error, "source changed");
        assert_eq!(checks.get(), failing_check);
        assert!(!fixture.root.join(MAP_PATH).exists());
        let entries = fixture.registry.entries.lock().unwrap();
        assert!(entries
            .values()
            .all(|entry| entry.phase == PublicationPhase::Prepared && entry.written.is_none()));
        if failing_check == 1 {
            assert!(entries.is_empty());
        }
    }
}

#[test]
fn postpersist_source_failure_retains_private_receipt_without_publication_authority() {
    let fixture = Fixture::new();
    let checks = Cell::new(0);
    let error = fixture
        .publish_map("map-postpersist", "private-grant-a", &|| {
            checks.set(checks.get() + 1);
            if checks.get() == 3 {
                Err("source changed after persist".into())
            } else {
                Ok(())
            }
        })
        .unwrap_err();
    assert_eq!(checks.get(), 3);
    assert!(error.contains("source changed after persist"));
    assert!(error.contains("output retained for manual recovery"));
    assert_eq!(
        std::fs::read_to_string(fixture.root.join(MAP_PATH)).unwrap(),
        MAP_CONTENT
    );
    let private_receipt = {
        let entries = fixture.registry.entries.lock().unwrap();
        let (id, entry) = entries.iter().next().unwrap();
        assert_eq!(entry.phase, PublicationPhase::Prepared);
        assert!(entry.written.as_ref().unwrap().native_created);
        receipt(id, entry).unwrap()
    };
    assert!(fixture
        .validate(
            "map-postpersist",
            &private_receipt,
            claim(&private_receipt, true)
        )
        .is_err());
    assert!(undo_created(
        &fixture.registry,
        &fixture.root,
        &fixture.origin,
        "map-postpersist",
        &[MAP_PATH.into()]
    )
    .is_err());
    let retry_error = fixture
        .publish_map("map-postpersist", "private-grant-a", &|| Ok(()))
        .unwrap_err();
    assert!(retry_error.contains("manual recovery"));
    assert!(fixture
        .publish_map("map-postpersist", "private-grant-b", &|| Ok(()))
        .unwrap_err()
        .contains("different source snapshot"));
    assert_eq!(
        std::fs::read_to_string(fixture.root.join(MAP_PATH)).unwrap(),
        MAP_CONTENT
    );
}

#[test]
fn persisted_registration_hook_keeps_maps_prepared_and_quarantined() {
    let fixture = Fixture::new();
    fixture
        .registry
        .fail_after_persist
        .store(true, std::sync::atomic::Ordering::SeqCst);
    assert!(fixture
        .publish_map("map-hook", "private-grant-a", &|| Ok(()))
        .unwrap_err()
        .contains("bytes persisted"));
    let entries = fixture.registry.entries.lock().unwrap();
    let entry = entries.values().next().unwrap();
    assert_eq!(entry.phase, PublicationPhase::Prepared);
    assert!(entry.written.is_some());
    drop(entries);
    assert!(fixture
        .publish_map("map-hook", "private-grant-a", &|| Ok(()))
        .unwrap_err()
        .contains("manual recovery"));
    assert_eq!(
        std::fs::read_to_string(fixture.root.join(MAP_PATH)).unwrap(),
        MAP_CONTENT
    );
}

#[test]
fn operation_keeps_each_target_grant_bound_and_allows_a_shared_multimap_manifest() {
    let fixture = Fixture::new();
    let first = fixture
        .publish_map("map-bound", "private-grant-a", &|| Ok(()))
        .unwrap();
    assert!(fixture
        .publish_map("map-bound", "private-grant-b", &|| Ok(()))
        .unwrap_err()
        .contains("different source snapshot"));
    let second = crate::vault::with_root_mutation(&fixture.root, |root, guard| {
        publish_map_locked(
            root,
            guard,
            &fixture.registry,
            &fixture.origin,
            MapPublication {
                operation: "map-bound",
                key: "different-topic",
                content: MAP_CONTENT,
                source_snapshot_id: "private-grant-b",
                creation_store: None,
            },
            &|| Ok(()),
        )
    })
    .unwrap();
    assert_ne!(first.publication_id, second.publication_id);
    assert_eq!(
        std::fs::read_to_string(fixture.root.join(&second.path)).unwrap(),
        MAP_CONTENT
    );
    assert_eq!(fixture.registry.entries.lock().unwrap().len(), 2);
    let claims = validate(
        &fixture.registry,
        &fixture.root,
        &fixture.origin,
        "map-bound",
        &[first.publication_id.clone(), second.publication_id.clone()],
        &[claim(&first, false), claim(&second, false)],
    )
    .unwrap();
    assert!(claims.iter().all(|claim| claim.created));
    assert_eq!(
        undo_created(
            &fixture.registry,
            &fixture.root,
            &fixture.origin,
            "map-bound",
            &[first.path, second.path]
        )
        .unwrap(),
        2
    );
}

#[test]
fn checked_map_cannot_overwrite_an_existing_human_target() {
    let fixture = Fixture::new();
    std::fs::create_dir_all(fixture.root.join("wiki/maps")).unwrap();
    std::fs::write(fixture.root.join(MAP_PATH), "Human map with annotations.\n").unwrap();
    assert!(fixture
        .publish_map("map-existing", "private-grant-a", &|| Ok(()))
        .unwrap_err()
        .contains("write conflict"));
    assert_eq!(
        std::fs::read_to_string(fixture.root.join(MAP_PATH)).unwrap(),
        "Human map with annotations.\n"
    );
    assert!(fixture
        .registry
        .entries
        .lock()
        .unwrap()
        .values()
        .all(|entry| entry.phase == PublicationPhase::Prepared
            && entry.written.is_none()
            && entry.expected_revision.is_none()));
}

#[cfg(unix)]
#[test]
fn published_map_retry_rejects_changed_sources_and_same_bytes_replacement_inode() {
    let fixture = Fixture::new();
    let first = fixture
        .publish_map("map-retry", "private-grant-a", &|| Ok(()))
        .unwrap();
    assert_eq!(
        fixture
            .publish_map("map-retry", "private-grant-a", &|| Err(
                "source changed".into()
            ))
            .unwrap_err(),
        "source changed"
    );
    let replacement = fixture.root.join("replacement.md");
    std::fs::write(&replacement, MAP_CONTENT).unwrap();
    std::fs::rename(replacement, fixture.root.join(MAP_PATH)).unwrap();
    assert!(fixture
        .publish_map("map-retry", "private-grant-a", &|| Ok(()))
        .is_err());
    assert!(fixture
        .validate("map-retry", &first, claim(&first, true))
        .is_err());
    assert_eq!(
        std::fs::read_to_string(fixture.root.join(MAP_PATH)).unwrap(),
        MAP_CONTENT
    );
}

#[test]
fn cooperating_writer_cannot_run_between_map_source_checks_and_publication() {
    let fixture = Fixture::new();
    let source = fixture.root.join("source.md");
    std::fs::write(&source, "Original source.").unwrap();
    let writer = RefCell::new(None);
    let checks = Cell::new(0);
    let result = fixture.publish_map("map-transaction", "private-grant-a", &|| {
        assert!(crate::vault::try_lock_file_mutation()?.is_none());
        checks.set(checks.get() + 1);
        if checks.get() == 1 {
            let source = source.clone();
            let (started, ready) = std::sync::mpsc::channel();
            *writer.borrow_mut() = Some(std::thread::spawn(move || {
                started.send(()).unwrap();
                crate::vault::write_file(&source.to_string_lossy(), "Later cooperating edit.")
            }));
            // Start notification never waits for the held mutation lock.
            ready
                .recv_timeout(std::time::Duration::from_secs(2))
                .unwrap();
        }
        assert_eq!(
            std::fs::read_to_string(&source).unwrap(),
            "Original source."
        );
        Ok(())
    });
    writer.into_inner().unwrap().join().unwrap().unwrap();
    assert_eq!(result.unwrap().state, PublicationPhase::Published);
    assert_eq!(checks.get(), 3);
    assert_eq!(
        std::fs::read_to_string(source).unwrap(),
        "Later cooperating edit."
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root.join(MAP_PATH)).unwrap(),
        MAP_CONTENT
    );
}

#[cfg(unix)]
#[test]
fn map_custody_record_conflict_preserves_output_without_publication_authority() {
    crate::settings::test_support::with_isolated_data("map-custody-conflict", |data| {
        let fixture = Fixture::new();
        let store = crate::map_custody::MapCreationStore::open(&fixture.root, MAP_PATH).unwrap();
        let record_path = RefCell::new(None);
        let result = crate::vault::with_root_mutation(&fixture.root, |root, guard| {
            publish_map_locked(
                root,
                guard,
                &fixture.registry,
                &fixture.origin,
                MapPublication {
                    operation: "map-custody-conflict",
                    key: MAP_KEY,
                    content: MAP_CONTENT,
                    source_snapshot_id: "private-grant",
                    creation_store: Some(&store),
                },
                &|| {
                    if root.join(MAP_PATH).exists() && record_path.borrow().is_none() {
                        let anchor = std::fs::read_dir(data.join("map-creation-custody"))
                            .unwrap()
                            .map(|entry| entry.unwrap().path())
                            .find(|path| path.extension().is_some_and(|ext| ext == "anchor"))
                            .unwrap();
                        let record = anchor.with_extension("json");
                        std::fs::write(&record, "Synthetic pre-existing custody record.").unwrap();
                        *record_path.borrow_mut() = Some(record);
                    }
                    Ok(())
                },
            )
        });
        assert!(result
            .unwrap_err()
            .contains("output retained for manual recovery"));
        assert_eq!(
            std::fs::read_to_string(fixture.root.join(MAP_PATH)).unwrap(),
            MAP_CONTENT
        );
        assert_eq!(
            std::fs::read_to_string(record_path.borrow().as_ref().unwrap()).unwrap(),
            "Synthetic pre-existing custody record."
        );
        let entries = fixture.registry.entries.lock().unwrap();
        assert_eq!(entries.len(), 1);
        let entry = entries.values().next().unwrap();
        assert_eq!(entry.phase, PublicationPhase::Prepared);
        assert!(entry.written.is_some());
        drop(entries);
        assert!(fixture
            .publish_map("map-custody-conflict", "private-grant", &|| Ok(()))
            .is_err());
    });
}

#[cfg(unix)]
#[test]
fn map_custody_rejects_unsafe_store_and_non_map_targets() {
    crate::settings::test_support::with_isolated_data("map-custody-unsafe", |data| {
        let fixture = Fixture::new();
        for invalid in ["raw/source.md", "wiki/maps/../raw.md", "wiki/maps/Upper.md"] {
            assert!(crate::map_custody::MapCreationStore::open(&fixture.root, invalid).is_err());
        }
        let redirect = data.join("synthetic-redirect");
        std::fs::create_dir(&redirect).unwrap();
        std::os::unix::fs::symlink(&redirect, data.join("map-creation-custody")).unwrap();
        assert!(crate::map_custody::MapCreationStore::open(&fixture.root, MAP_PATH).is_err());
        assert_eq!(std::fs::read_dir(&redirect).unwrap().count(), 0);
        assert!(!fixture.root.join(MAP_PATH).exists());
    });
}
