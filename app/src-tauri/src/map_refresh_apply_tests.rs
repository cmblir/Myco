use super::*;
use crate::role_authorization::{capture_role_at, RoleUsage};
use crate::settings::test_support::with_isolated_data;
use std::path::Path;

fn create(root: &Path) -> (String, crate::map_custody::MapCreationUndo) {
    std::fs::create_dir_all(root.join("wiki/maps")).unwrap();
    std::fs::write(root.join("wiki/synthetic.md"), "Synthetic source.").unwrap();
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../src/lib/mapContent.fixture.json")).unwrap();
    let content = fixture["content"].as_str().unwrap().to_owned();
    let store = crate::map_custody::MapCreationStore::open(root, "wiki/maps/synthetic.md").unwrap();
    let undo = crate::vault::with_root_mutation(root, |_, guard| {
        let written = store.write(
            guard,
            root.join("wiki/maps/synthetic.md").to_str().unwrap(),
            &content,
        )?;
        store.record(guard, &written, &content)
    })
    .unwrap();
    (content, undo)
}

fn candidate(baseline: &str, body: &str) -> String {
    let old = "Synthetic relationship [[wiki/synthetic.md]].\n";
    baseline.replace(old, body).replace(
        &crate::importers::wikify::source_revision(old),
        &crate::importers::wikify::source_revision(body),
    )
}

#[test]
#[ignore = "invoked only by the isolated multi-process refresh test"]
fn synthetic_refresh_child() {
    let data = std::path::PathBuf::from(std::env::var_os("MYCO_DATA_DIR").unwrap());
    assert_eq!(
        std::fs::read_to_string(data.join("synthetic.marker")).unwrap(),
        "Synthetic map refresh restart only"
    );
    let phase = std::env::var("MYCO_MAP_REFRESH_PHASE").unwrap();
    let root = data.join("vault");
    if phase == "create" {
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let (baseline, _) = create(&root);
        std::fs::write(
            root.join("wiki/maps/synthetic.md"),
            format!("{baseline}\nHuman restart annotation.\n"),
        )
        .unwrap();
        return;
    }
    assert!(matches!(
        phase.as_str(),
        "first" | "second" | "interrupt" | "inspect-interrupted"
    ));
    let root = root.canonicalize().unwrap();
    let state = VaultRoot::default();
    let generation = state.begin_open().unwrap();
    state.finish_open(generation, root.clone(), || ()).unwrap();
    let origin = state.snapshot().unwrap();
    if phase == "inspect-interrupted" {
        let retained = history(&state, &origin, "synthetic").unwrap().unwrap();
        assert!(retained.before.contains("Synthetic relationship"));
        assert!(retained
            .after
            .contains("Synthetic interrupt restart refresh"));
        assert!(retained.before.ends_with("Human restart annotation.\n"));
        assert!(retained.after.ends_with("Human restart annotation.\n"));
        assert_eq!(
            retained.after,
            std::fs::read_to_string(root.join("wiki/maps/synthetic.md")).unwrap()
        );
        assert!(!retained.has_changes_since_refresh);
        return;
    }
    let role = capture_role_at(&origin, RoleId::Organization, RoleUsage::Foreground).unwrap();
    let sources = crate::map_sources::MapSourceRegistry::default();
    let snapshot = crate::map_sources::capture(
        &state,
        &sources,
        &origin,
        &role,
        &["wiki/synthetic.md".into()],
    )
    .unwrap();
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("../../src/lib/mapContent.fixture.json")).unwrap();
    let body = format!("Synthetic {phase} restart refresh [[wiki/synthetic.md]].\n");
    let proposed = candidate(fixture["content"].as_str().unwrap(), &body);
    let target = root.join("wiki/maps/synthetic.md");
    if phase == "second" {
        assert!(std::fs::read_to_string(&target)
            .unwrap()
            .contains("Synthetic first restart refresh"));
    }
    let previous = std::fs::read_to_string(&target).unwrap();
    if phase == "second" {
        let prior = history(&state, &origin, "synthetic").unwrap().unwrap();
        assert!(prior.before.contains("Synthetic relationship"));
        assert_eq!(prior.after, previous);
        assert!(!prior.has_changes_since_refresh);
    } else {
        assert!(history(&state, &origin, "synthetic").unwrap().is_none());
    }
    let review = preview(
        &state,
        &sources,
        &origin,
        &role,
        "synthetic",
        &proposed,
        &snapshot.snapshot_id,
    )
    .unwrap();
    if phase == "interrupt" {
        let store =
            crate::map_custody::MapCreationStore::open(&root, "wiki/maps/synthetic.md").unwrap();
        let calls = std::cell::Cell::new(0);
        let _ = crate::vault::with_root_mutation(&root, |_, guard| {
            store.refresh(guard, &proposed, &review.current_revision, &|| {
                calls.set(calls.get() + 1);
                if calls.get() == 2 {
                    // Abrupt child exit: no successful refresh result or stack cleanup.
                    std::process::exit(23);
                }
                Ok(())
            })
        });
        panic!("synthetic interrupt point was not reached");
    }
    let result = apply(
        &state,
        &sources,
        &origin,
        &role,
        "synthetic",
        &proposed,
        &snapshot.snapshot_id,
        &review.current_revision,
    )
    .unwrap();
    assert!(result.changed);
    let recorded = history(&state, &origin, "synthetic").unwrap().unwrap();
    assert_eq!(recorded.before, previous);
    assert_eq!(recorded.after, review.content);
    assert!(!recorded.has_changes_since_refresh);
    std::fs::write(&target, format!("{}\nLater human note.\n", review.content)).unwrap();
    assert!(
        history(&state, &origin, "synthetic")
            .unwrap()
            .unwrap()
            .has_changes_since_refresh
    );
    std::fs::write(&target, &review.content).unwrap();
    assert_eq!(std::fs::read_to_string(&target).unwrap(), review.content);
    assert!(review.content.contains(&body));
    assert!(review.content.ends_with("Human restart annotation.\n"));
}

#[test]
fn successive_refreshes_reopen_in_fresh_processes_with_fresh_source_grants() {
    let data = tempfile::Builder::new()
        .prefix("myco-synthetic-refresh-restart-")
        .tempdir()
        .unwrap();
    std::fs::write(
        data.path().join("synthetic.marker"),
        "Synthetic map refresh restart only",
    )
    .unwrap();
    for phase in ["create", "first", "second"] {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "map_refresh::apply_tests::synthetic_refresh_child",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("MYCO_DATA_DIR", data.path())
            .env("MYCO_MAP_REFRESH_PHASE", phase)
            .env_remove("MEMEX_DATA_DIR")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{phase} child failed: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
    }
}

#[test]
fn applies_successive_refreshes_preserving_annotations_and_rejecting_stale_cas() {
    with_isolated_data("map-refresh-apply", |data| {
        let root = data.join("vault");
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let (baseline, undo) = create(&root);
        let state = VaultRoot::default();
        let generation = state.begin_open().unwrap();
        state.finish_open(generation, root.clone(), || ()).unwrap();
        let origin = state.snapshot().unwrap();
        let role = capture_role_at(&origin, RoleId::Organization, RoleUsage::Foreground).unwrap();
        let sources = crate::map_sources::MapSourceRegistry::default();
        let snapshot = crate::map_sources::capture(
            &state,
            &sources,
            &origin,
            &role,
            &["wiki/synthetic.md".into()],
        )
        .unwrap();
        let target = root.join("wiki/maps/synthetic.md");
        let current = format!(
            "{}\nHuman annotation.\n",
            baseline.replace("Map: Synthetic topic", "Human title")
        );
        std::fs::write(&target, &current).unwrap();
        for body in [
            "First synthetic update [[wiki/synthetic.md]].\n",
            "Second synthetic update [[wiki/synthetic.md]].\n",
        ] {
            let proposed = candidate(&baseline, body);
            let review = preview(
                &state,
                &sources,
                &origin,
                &role,
                "synthetic",
                &proposed,
                &snapshot.snapshot_id,
            )
            .unwrap();
            let result = apply(
                &state,
                &sources,
                &origin,
                &role,
                "synthetic",
                &proposed,
                &snapshot.snapshot_id,
                &review.current_revision,
            )
            .unwrap();
            assert_eq!(result.path, "wiki/maps/synthetic.md");
            assert!(result.changed);
            assert_eq!(std::fs::read_to_string(&target).unwrap(), review.content);
            let entry_count = std::fs::read_dir(data.join("map-creation-custody"))
                .unwrap()
                .count();
            let repeated = apply(
                &state,
                &sources,
                &origin,
                &role,
                "synthetic",
                &proposed,
                &snapshot.snapshot_id,
                &result.revision,
            )
            .unwrap();
            assert!(!repeated.changed);
            assert_eq!(repeated.revision, result.revision);
            assert_eq!(
                std::fs::read_dir(data.join("map-creation-custody"))
                    .unwrap()
                    .count(),
                entry_count
            );
            assert_eq!(
                result.revision,
                crate::importers::wikify::source_revision(&review.content)
            );
            assert!(review.content.contains("Human title"));
            assert!(review.content.ends_with("Human annotation.\n"));
            assert!(apply(
                &state,
                &sources,
                &origin,
                &role,
                "synthetic",
                &proposed,
                &snapshot.snapshot_id,
                &review.current_revision
            )
            .is_err());
            assert!(crate::vault::remove_native_map_creation(&undo).is_err());
            assert_eq!(std::fs::read_to_string(&target).unwrap(), review.content);
        }
        let proposed = candidate(&baseline, "Third synthetic update [[wiki/synthetic.md]].\n");
        let review = preview(
            &state,
            &sources,
            &origin,
            &role,
            "synthetic",
            &proposed,
            &snapshot.snapshot_id,
        )
        .unwrap();
        std::fs::write(root.join("wiki/synthetic.md"), "Changed source.").unwrap();
        assert!(apply(
            &state,
            &sources,
            &origin,
            &role,
            "synthetic",
            &proposed,
            &snapshot.snapshot_id,
            &review.current_revision
        )
        .is_err());
        let unchanged = std::fs::read_to_string(&target).unwrap();
        assert!(unchanged.contains("Second synthetic update"));
        assert!(history(&state, &origin, "../synthetic").is_err());
        state.close().unwrap();
        assert!(history(&state, &origin, "synthetic").is_err());
        assert!(apply(
            &state,
            &sources,
            &origin,
            &role,
            "synthetic",
            &proposed,
            &snapshot.snapshot_id,
            &review.current_revision
        )
        .is_err());
        assert_eq!(std::fs::read_to_string(&target).unwrap(), unchanged);
    });
}

#[test]
fn refresh_detects_intervening_human_edits_and_preserves_postwrite_failure_output() {
    for postwrite in [false, true] {
        with_isolated_data("map-refresh-fault", |data| {
            let root = data.join("vault");
            std::fs::create_dir(&root).unwrap();
            let root = root.canonicalize().unwrap();
            let (baseline, _) = create(&root);
            let proposed = candidate(&baseline, "Synthetic changed map [[wiki/synthetic.md]].\n");
            let target = root.join("wiki/maps/synthetic.md");
            let store = crate::map_custody::MapCreationStore::open(&root, "wiki/maps/synthetic.md")
                .unwrap();
            let calls = std::cell::Cell::new(0);
            let result = crate::vault::with_root_mutation(&root, |_, guard| {
                store.refresh(
                    guard,
                    &proposed,
                    &crate::importers::wikify::source_revision(&baseline),
                    &|| {
                        calls.set(calls.get() + 1);
                        if postwrite && calls.get() == 2 {
                            return Err("synthetic source verification failure".into());
                        }
                        if !postwrite {
                            std::fs::write(
                                &target,
                                format!("{baseline}\nIntervening human note.\n"),
                            )
                            .unwrap();
                        }
                        Ok(())
                    },
                )
            });
            let error = result.err().unwrap();
            if postwrite {
                assert!(error.contains("output retained for manual recovery"));
                assert_eq!(std::fs::read_to_string(&target).unwrap(), proposed);
                let state = VaultRoot::default();
                let generation = state.begin_open().unwrap();
                state.finish_open(generation, root.clone(), || ()).unwrap();
                let origin = state.snapshot().unwrap();
                let retained = history(&state, &origin, "synthetic").unwrap().unwrap();
                assert_eq!(retained.before, baseline);
                assert_eq!(retained.after, proposed);
                assert!(!retained.has_changes_since_refresh);
            } else {
                assert!(
                    error.contains("changed after refresh preparation")
                        || error.contains("changed")
                );
                assert!(std::fs::read_to_string(&target)
                    .unwrap()
                    .ends_with("Intervening human note.\n"));
            }
        });
    }
}

#[test]
fn unchanged_refresh_rechecks_target_after_final_source_check() {
    with_isolated_data("map-refresh-noop-race", |data| {
        let root = data.join("vault");
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let (baseline, _) = create(&root);
        let target = root.join("wiki/maps/synthetic.md");
        let store =
            crate::map_custody::MapCreationStore::open(&root, "wiki/maps/synthetic.md").unwrap();
        let calls = std::cell::Cell::new(0);
        let result = crate::vault::with_root_mutation(&root, |_, guard| {
            store.refresh(
                guard,
                &baseline,
                &crate::importers::wikify::source_revision(&baseline),
                &|| {
                    calls.set(calls.get() + 1);
                    if calls.get() == 2 {
                        std::fs::write(&target, format!("{baseline}\nLate human note.\n")).unwrap();
                    }
                    Ok(())
                },
            )
        });
        assert!(result.is_err());
        assert!(std::fs::read_to_string(target)
            .unwrap()
            .ends_with("Late human note.\n"));
        assert_eq!(
            std::fs::read_dir(data.join("map-creation-custody"))
                .unwrap()
                .count(),
            2
        );
    });
}

#[test]
fn oversized_before_and_after_record_rejects_before_canonical_write() {
    with_isolated_data("map-refresh-history-budget", |data| {
        let root = data.join("vault");
        std::fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let (baseline, _) = create(&root);
        let target = root.join("wiki/maps/synthetic.md");
        let current = format!("{baseline}\n{}", "\t".repeat(2_200_000));
        std::fs::write(&target, &current).unwrap();
        let proposed = candidate(&baseline, "Synthetic changed map [[wiki/synthetic.md]].\n");
        let store =
            crate::map_custody::MapCreationStore::open(&root, "wiki/maps/synthetic.md").unwrap();
        let result = crate::vault::with_root_mutation(&root, |_, guard| {
            store.refresh(
                guard,
                &proposed,
                &crate::importers::wikify::source_revision(&current),
                &|| Ok(()),
            )
        });
        assert!(result.err().unwrap().contains("byte budget"));
        assert_eq!(std::fs::read_to_string(target).unwrap(), current);
        assert_eq!(
            std::fs::read_dir(data.join("map-creation-custody"))
                .unwrap()
                .count(),
            2
        );
    });
}

#[test]
fn retained_history_survives_exit_before_postwrite_source_validation() {
    let data = tempfile::Builder::new()
        .prefix("myco-synthetic-map-interrupt-")
        .tempdir()
        .unwrap();
    std::fs::write(
        data.path().join("synthetic.marker"),
        "Synthetic map refresh restart only",
    )
    .unwrap();
    for (phase, expected_code) in [("create", 0), ("interrupt", 23), ("inspect-interrupted", 0)] {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "map_refresh::apply_tests::synthetic_refresh_child",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("MYCO_DATA_DIR", data.path())
            .env("MYCO_MAP_REFRESH_PHASE", phase)
            .env_remove("MEMEX_DATA_DIR")
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(expected_code),
            "{phase}: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
