//! Actual unlink failures and separate-process recovery of synthetic editor data.
#![cfg(unix)]

use super::*;

const ORIGINAL: &str = "---\ntitle: Synthetic retirement original\n---\nFull first baseline A.\n";
const DRAFT: &str = "---\ntitle: Synthetic retirement draft\n---\nUnsaved draft D. 한글\n";
const HUMAN: &str =
    "---\ntitle: Synthetic human replacement\n---\nExternal human B must survive.\n";
const FAILURE: &str = "synthetic parent sync failure after actual journal unlink";
const MARKER: &str = "Synthetic editor retirement restart only";

fn fixture() -> (tempfile::TempDir, VaultRoot, AgentVaultSession, PathBuf) {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path().canonicalize().unwrap();
    std::fs::create_dir(root.join("wiki")).unwrap();
    let path = root.join("wiki/note.md");
    std::fs::write(&path, ORIGINAL).unwrap();
    let state = VaultRoot::default();
    let origin = open(&state, &root);
    (vault, state, origin, path)
}

fn supporting_paths(
    state: &VaultRoot,
    path: &Path,
    origin: &AgentVaultSession,
    revision: &str,
) -> (PathBuf, PathBuf, PathBuf) {
    with_journal(
        state,
        &path.to_string_lossy(),
        origin,
        |_, directory, target, _| {
            let (pending, committed) = retirement::paths(directory, target, revision)?;
            Ok((target.to_path_buf(), pending, committed))
        },
    )
    .unwrap()
}

fn write_private_fixture(path: &Path, bytes: &[u8]) {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    if path.exists() {
        assert_eq!(std::fs::read(path).unwrap(), bytes);
        return;
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .unwrap();
    file.write_all(bytes).unwrap();
    file.sync_all().unwrap();
}

fn open(state: &VaultRoot, root: &Path) -> AgentVaultSession {
    let generation = state.begin_open().unwrap();
    state
        .finish_open(generation, root.canonicalize().unwrap(), || ())
        .unwrap();
    state.snapshot().unwrap()
}

fn checkpoint(state: &VaultRoot, path: &Path, origin: &AgentVaultSession) -> RecoveryDraft {
    let read = crate::editor_io::read(state, &path.to_string_lossy(), origin).unwrap();
    assert_eq!(read.file.raw, ORIGINAL);
    assert_eq!(read.revision, hash(ORIGINAL.as_bytes()));
    stage(
        state,
        &path.to_string_lossy(),
        &read.revision,
        DRAFT,
        origin,
        None,
    )
    .unwrap()
}

fn fail_after_actual_unlink(
    state: &VaultRoot,
    path: &Path,
    origin: &AgentVaultSession,
    revision: &str,
) -> String {
    let mut actual_unlink_observed = false;
    let result = retire_impl(
        state,
        &path.to_string_lossy(),
        origin,
        revision,
        |journal| {
            assert!(
                !journal.exists(),
                "fault must follow the real primary unlink"
            );
            actual_unlink_observed = true;
            Err(FAILURE.into())
        },
    );
    assert!(
        actual_unlink_observed,
        "retirement must reach its actual unlink boundary"
    );
    let error = result.unwrap_err();
    assert!(
        error.contains(FAILURE),
        "unexpected retirement error: {error}"
    );
    error
}

fn require_preserved_draft(
    state: &VaultRoot,
    path: &Path,
    origin: &AgentVaultSession,
) -> RecoveryDraft {
    let saved = load(state, &path.to_string_lossy(), origin)
        .unwrap()
        .expect("a failed retirement must preserve acknowledged full A/D for recovery");
    assert_eq!(saved.baseline_raw, ORIGINAL);
    assert_eq!(saved.baseline_revision, hash(ORIGINAL.as_bytes()));
    assert_eq!(saved.draft_raw, DRAFT);
    assert_eq!(std::fs::read_to_string(path).unwrap(), HUMAN);
    assert!(
        assert_no_pending_at(Path::new(&origin.vault_path), &path.to_string_lossy())
            .unwrap_err()
            .contains("pending editor recovery")
    );
    saved
}

#[test]
fn actual_unlink_then_parent_sync_failure_keeps_acknowledged_draft_and_path_guard() {
    crate::settings::test_support::with_isolated_data("editor-retirement-post-unlink", |_| {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path().canonicalize().unwrap();
        std::fs::create_dir(root.join("wiki")).unwrap();
        let path = root.join("wiki/note.md");
        std::fs::write(&path, ORIGINAL).unwrap();
        let state = VaultRoot::default();
        let origin = open(&state, &root);
        let first = checkpoint(&state, &path, &origin);
        std::fs::write(&path, HUMAN).unwrap();

        fail_after_actual_unlink(&state, &path, &origin, &first.revision);
        let recovered = require_preserved_draft(&state, &path, &origin);
        assert_eq!(recovered.revision, first.revision);
        assert!(same_origin(&recovered.origin, &first.origin));
    });
}

#[test]
#[ignore = "spawned only with explicit synthetic retirement vault and private app-data"]
fn synthetic_retirement_restart_child() {
    let requested = PathBuf::from(
        std::env::var_os("MYCO_EDITOR_RETIREMENT_VAULT")
            .expect("explicit synthetic retirement vault required"),
    );
    assert!(requested.is_absolute());
    assert!(requested
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("myco-synthetic-editor-retirement-"));
    assert_eq!(
        std::fs::read_to_string(requested.join("synthetic.marker")).unwrap(),
        MARKER
    );
    let root = requested.canonicalize().unwrap();
    let data = PathBuf::from(
        std::env::var_os("MYCO_DATA_DIR").expect("explicit synthetic private app-data required"),
    );
    assert!(data.is_absolute());
    assert!(data
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("myco-synthetic-editor-retirement-data-"));
    assert!(std::env::var_os("MEMEX_DATA_DIR").is_none());
    let state = VaultRoot::default();
    let origin = open(&state, &root);
    let path = root.join("wiki/note.md");
    let phase = std::env::var("MYCO_EDITOR_RETIREMENT_PHASE").unwrap();
    if phase == "successful_retirement" {
        let saved = checkpoint(&state, &path, &origin);
        std::fs::write(&path, HUMAN).unwrap();
        retire(&state, &path.to_string_lossy(), &origin, &saved.revision).unwrap();
        assert!(load(&state, &path.to_string_lossy(), &origin)
            .unwrap()
            .is_none());
        assert_no_pending_at(&root, &path.to_string_lossy()).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), HUMAN);
        println!(
            "SYNTHETIC_EDITOR_RETIREMENT={}",
            serde_json::json!({
                "phase":phase,"pid":std::process::id(),"beforeRetirement":saved,
                "currentOrigin":origin,"committedAbsenceObserved":true,
                "humanFileSha256":hash(HUMAN.as_bytes()),"powerLossTested":false
            })
        );
        return;
    }
    if phase == "restore_after_success" {
        assert!(load(&state, &path.to_string_lossy(), &origin)
            .unwrap()
            .is_none());
        assert_no_pending_at(&root, &path.to_string_lossy()).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), HUMAN);
        println!(
            "SYNTHETIC_EDITOR_RETIREMENT={}",
            serde_json::json!({
                "phase":phase,"pid":std::process::id(),"currentOrigin":origin,
                "committedAbsenceObserved":true,"humanFileSha256":hash(HUMAN.as_bytes()),
                "powerLossTested":false
            })
        );
        return;
    }
    let (saved, error) = match phase.as_str() {
        "abrupt_unlink" => {
            use std::io::Write;
            let saved = checkpoint(&state, &path, &origin);
            std::fs::write(&path, HUMAN).unwrap();
            let result = retire_impl(
                &state,
                &path.to_string_lossy(),
                &origin,
                &saved.revision,
                |journal| {
                    assert!(
                        !journal.exists(),
                        "process exit must follow the actual primary unlink"
                    );
                    println!(
                        "SYNTHETIC_EDITOR_RETIREMENT={}",
                        serde_json::json!({
                            "phase":phase,"pid":std::process::id(),"recovery":saved,
                            "currentOrigin":origin,"realUnlinkObserved":true,
                            "humanFileSha256":hash(HUMAN.as_bytes()),"noDropExit":23,
                            "nativeHelperOnly":true,"powerLossTested":false
                        })
                    );
                    std::io::stdout().flush().unwrap();
                    std::process::exit(23)
                },
            );
            panic!("abrupt unlink boundary was not reached: {result:?}")
        }
        "unlink_failure" => {
            let saved = checkpoint(&state, &path, &origin);
            std::fs::write(&path, HUMAN).unwrap();
            let error = fail_after_actual_unlink(&state, &path, &origin, &saved.revision);
            // Record the genuine acknowledged pre-retirement receipt; do not repair the journal.
            (saved, Some(error))
        }
        "restore" => {
            let saved = require_preserved_draft(&state, &path, &origin);
            assert!(!same_origin(&saved.origin, &origin));
            assert!(state.with_origin(&saved.origin, |_| Ok(())).is_err());
            assert!(crate::editor_io::write(
                &state,
                &path.to_string_lossy(),
                DRAFT,
                &saved.baseline_revision,
                &saved.origin
            )
            .is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), HUMAN);
            (saved, None)
        }
        _ => panic!("unexpected synthetic retirement phase: {phase}"),
    };
    assert_eq!(std::fs::read_to_string(&path).unwrap(), HUMAN);
    println!(
        "SYNTHETIC_EDITOR_RETIREMENT={}",
        serde_json::json!({
            "phase":phase,"pid":std::process::id(),"recovery":saved,"currentOrigin":origin,
            "realUnlinkObserved":phase == "unlink_failure","retirementError":error,
            "humanFileSha256":hash(HUMAN.as_bytes()),"nativeHelperOnly":true,
            "powerLossTested":false,"installedUi":false
        })
    );
}

fn run_child(vault: &Path, data: &Path, phase: &str, expected_exit: i32) -> serde_json::Value {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "editor_recovery::retirement_tests::synthetic_retirement_restart_child",
            "--ignored",
            "--nocapture",
            "--test-threads=1",
        ])
        .env("MYCO_EDITOR_RETIREMENT_VAULT", vault)
        .env("MYCO_EDITOR_RETIREMENT_PHASE", phase)
        .env("MYCO_DATA_DIR", data)
        .env_remove("MEMEX_DATA_DIR")
        .env("RUST_BACKTRACE", "1")
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(expected_exit),
        "retirement child {phase} failed: stdout={} stderr={}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    let raw = stdout
        .lines()
        .find_map(|line| {
            line.split_once("SYNTHETIC_EDITOR_RETIREMENT=")
                .map(|(_, raw)| raw)
        })
        .expect("actual retirement child proof required");
    serde_json::from_str(raw).unwrap()
}

#[test]
fn actual_two_process_restart_recovers_acknowledged_draft_after_retirement_unlink_error() {
    let vault = tempfile::Builder::new()
        .prefix("myco-synthetic-editor-retirement-")
        .tempdir()
        .unwrap();
    let data = tempfile::Builder::new()
        .prefix("myco-synthetic-editor-retirement-data-")
        .tempdir()
        .unwrap();
    std::fs::create_dir(vault.path().join("wiki")).unwrap();
    std::fs::write(vault.path().join("wiki/note.md"), ORIGINAL).unwrap();
    std::fs::write(vault.path().join("synthetic.marker"), MARKER).unwrap();
    let run = |phase: &str| {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "editor_recovery::retirement_tests::synthetic_retirement_restart_child",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("MYCO_EDITOR_RETIREMENT_VAULT", vault.path())
            .env("MYCO_EDITOR_RETIREMENT_PHASE", phase)
            .env("MYCO_DATA_DIR", data.path())
            .env_remove("MEMEX_DATA_DIR")
            .env("RUST_BACKTRACE", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "retirement child {phase} failed: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8(output.stdout).unwrap();
        let raw = stdout
            .lines()
            .find_map(|line| {
                line.split_once("SYNTHETIC_EDITOR_RETIREMENT=")
                    .map(|(_, raw)| raw)
            })
            .expect("actual retirement child proof required");
        serde_json::from_str::<serde_json::Value>(raw).unwrap()
    };
    let first = run("unlink_failure");
    let second = run("restore");
    assert_eq!(first["realUnlinkObserved"], true);
    assert!(first["retirementError"].as_str().unwrap().contains(FAILURE));
    assert_ne!(first["pid"], second["pid"]);
    assert_ne!(
        first["currentOrigin"]["openingToken"],
        second["currentOrigin"]["openingToken"]
    );
    assert_eq!(first["recovery"], second["recovery"]);
    assert_eq!(second["recovery"]["baselineRaw"], ORIGINAL);
    assert_eq!(second["recovery"]["draftRaw"], DRAFT);
    assert_eq!(
        std::fs::read_to_string(vault.path().join("wiki/note.md")).unwrap(),
        HUMAN
    );
    println!(
        "SYNTHETIC_EDITOR_RETIREMENT_RESTART_PROOF={}",
        serde_json::json!({
            "failedRetirementProcess":first,"restoreProcess":second,
            "oldOpeningWriteRefused":true,"pendingPathGuardRefused":true,
            "nativeHelperOnly":true,"powerLossTested":false,"installedUi":false
        })
    );
}

#[test]
fn successful_retirement_remains_absent_after_a_distinct_process_restart() {
    let vault = tempfile::Builder::new()
        .prefix("myco-synthetic-editor-retirement-")
        .tempdir()
        .unwrap();
    let data = tempfile::Builder::new()
        .prefix("myco-synthetic-editor-retirement-data-")
        .tempdir()
        .unwrap();
    std::fs::create_dir(vault.path().join("wiki")).unwrap();
    std::fs::write(vault.path().join("wiki/note.md"), ORIGINAL).unwrap();
    std::fs::write(vault.path().join("synthetic.marker"), MARKER).unwrap();
    let first = run_child(vault.path(), data.path(), "successful_retirement", 0);
    let second = run_child(vault.path(), data.path(), "restore_after_success", 0);
    assert_ne!(first["pid"], second["pid"]);
    assert_ne!(
        first["currentOrigin"]["openingToken"],
        second["currentOrigin"]["openingToken"]
    );
    assert_eq!(first["committedAbsenceObserved"], true);
    assert_eq!(second["committedAbsenceObserved"], true);
    assert_eq!(second["humanFileSha256"], hash(HUMAN.as_bytes()));
    assert_eq!(
        std::fs::read_to_string(vault.path().join("wiki/note.md")).unwrap(),
        HUMAN
    );
}

#[test]
fn corrupt_pending_recovery_copy_is_never_absence_or_silently_overwritten() {
    crate::settings::test_support::with_isolated_data("editor-retirement-corrupt-copy", |_| {
        let (_vault, state, origin, path) = fixture();
        let saved = checkpoint(&state, &path, &origin);
        std::fs::write(&path, HUMAN).unwrap();
        let (primary, pending, _) = supporting_paths(&state, &path, &origin, &saved.revision);
        fail_after_actual_unlink(&state, &path, &origin, &saved.revision);
        let original_copy = std::fs::read(&pending).unwrap();
        let original: serde_json::Value = serde_json::from_slice(&original_copy).unwrap();
        for mutation in ["invalid_json", "version", "draft_hash", "unknown_field"] {
            let mut changed = original.clone();
            match mutation {
                "version" => changed["version"] = 99.into(),
                "draft_hash" => changed["draftSha256"] = "0".repeat(64).into(),
                "unknown_field" => changed["inventedAuthority"] = true.into(),
                _ => {}
            }
            let bad = if mutation == "invalid_json" {
                b"{invalid synthetic journal".to_vec()
            } else {
                serde_json::to_vec(&changed).unwrap()
            };
            std::fs::write(&pending, &bad).unwrap();
            assert!(
                load(&state, &path.to_string_lossy(), &origin).is_err(),
                "{mutation}"
            );
            assert!(
                assert_no_pending_at(Path::new(&origin.vault_path), &path.to_string_lossy())
                    .is_err()
            );
            assert!(stage(
                &state,
                &path.to_string_lossy(),
                &saved.baseline_revision,
                "Synthetic newer draft",
                &origin,
                Some(&saved.revision)
            )
            .is_err());
            assert!(retire(&state, &path.to_string_lossy(), &origin, &saved.revision).is_err());
            assert!(
                !primary.exists(),
                "corrupt copy must not mint a replacement primary"
            );
            assert_eq!(std::fs::read(&pending).unwrap(), bad);
            assert_eq!(std::fs::read_to_string(&path).unwrap(), HUMAN);
            std::fs::write(&pending, &original_copy).unwrap();
        }
        assert_eq!(
            require_preserved_draft(&state, &path, &origin).revision,
            saved.revision
        );
    });
}

#[test]
fn pre_unlink_preparation_obstruction_keeps_original_primary_record() {
    crate::settings::test_support::with_isolated_data("editor-retirement-copy-obstruction", |_| {
        let (_vault, state, origin, path) = fixture();
        let saved = checkpoint(&state, &path, &origin);
        std::fs::write(&path, HUMAN).unwrap();
        let (primary, pending, _) = supporting_paths(&state, &path, &origin, &saved.revision);
        let original_primary = std::fs::read(&primary).unwrap();
        std::fs::create_dir(&pending).unwrap();
        let mut reached_unlink = false;
        let result = retire_impl(
            &state,
            &path.to_string_lossy(),
            &origin,
            &saved.revision,
            |_| {
                reached_unlink = true;
                Ok(())
            },
        );
        assert!(
            result.is_err(),
            "a directory cannot serve as a checked recovery copy"
        );
        assert!(
            !reached_unlink,
            "backup obstruction must stop before actual unlink"
        );
        assert_eq!(std::fs::read(&primary).unwrap(), original_primary);
        assert!(pending.is_dir());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), HUMAN);
        std::fs::remove_dir(&pending).unwrap();
        assert_eq!(
            require_preserved_draft(&state, &path, &origin).revision,
            saved.revision
        );
    });
}

#[test]
fn stale_pending_and_committed_nonce_cannot_hide_or_retire_a_newer_primary() {
    crate::settings::test_support::with_isolated_data("editor-retirement-stale-copy", |_| {
        let (_vault, state, origin, path) = fixture();
        let first = checkpoint(&state, &path, &origin);
        std::fs::write(&path, HUMAN).unwrap();
        let (primary, pending, committed) =
            supporting_paths(&state, &path, &origin, &first.revision);
        let old_record = std::fs::read(&primary).unwrap();
        retire(&state, &path.to_string_lossy(), &origin, &first.revision).unwrap();
        let newer = stage(
            &state,
            &path.to_string_lossy(),
            &first.baseline_revision,
            "Synthetic latest draft E",
            &origin,
            None,
        )
        .unwrap();
        assert_ne!(newer.revision, first.revision);
        let newer_primary = std::fs::read(&primary).unwrap();
        // Inject an exact old native record as an adversarial stale supporting copy.
        write_private_fixture(&pending, &old_record);
        let loaded = load(&state, &path.to_string_lossy(), &origin)
            .unwrap()
            .unwrap();
        assert_eq!(loaded.revision, newer.revision);
        assert_eq!(loaded.draft_raw, "Synthetic latest draft E");
        assert!(retire(&state, &path.to_string_lossy(), &origin, &first.revision).is_err());
        assert_eq!(std::fs::read(&primary).unwrap(), newer_primary);
        assert_eq!(std::fs::read(&pending).unwrap(), old_record);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), HUMAN);
        // Without the old commit evidence, conflicting pending data must fail closed.
        std::fs::remove_file(&committed).unwrap();
        assert!(load(&state, &path.to_string_lossy(), &origin).is_err());
        assert!(retire(&state, &path.to_string_lossy(), &origin, &first.revision).is_err());
        assert_eq!(std::fs::read(&primary).unwrap(), newer_primary);
        assert_eq!(std::fs::read(&pending).unwrap(), old_record);
        std::fs::remove_file(&pending).unwrap();
        assert_eq!(
            load(&state, &path.to_string_lossy(), &origin)
                .unwrap()
                .unwrap()
                .revision,
            newer.revision
        );
    });
}

#[test]
fn post_commit_pending_cleanup_error_does_not_resurrect_a_retired_draft() {
    crate::settings::test_support::with_isolated_data(
        "editor-retirement-committed-cleanup",
        |_| {
            let (_vault, state, origin, path) = fixture();
            let saved = checkpoint(&state, &path, &origin);
            std::fs::write(&path, HUMAN).unwrap();
            let (primary, pending, committed) =
                supporting_paths(&state, &path, &origin, &saved.revision);
            let original_record = std::fs::read(&primary).unwrap();
            let mut cleanup_reached = false;
            let result = retire_with_cleanup_impl(
                &state,
                &path.to_string_lossy(),
                &origin,
                &saved.revision,
                |target| {
                    assert!(!target.exists());
                    Ok(())
                },
                |cleanup_path| {
                    assert_eq!(cleanup_path, pending.as_path());
                    assert!(!primary.exists());
                    assert_eq!(std::fs::read(&committed).unwrap(), original_record);
                    assert_eq!(std::fs::read(&pending).unwrap(), original_record);
                    cleanup_reached = true;
                    Err("synthetic pending cleanup I/O failure after committed receipt".into())
                },
            );
            assert!(
                cleanup_reached,
                "cleanup fault must follow the actual committed full-copy receipt"
            );
            assert!(
                result.is_ok(),
                "committed retirement remains committed: {result:?}"
            );
            assert_eq!(std::fs::read(&pending).unwrap(), original_record);
            assert_eq!(std::fs::read(&committed).unwrap(), original_record);
            assert!(load(&state, &path.to_string_lossy(), &origin)
                .unwrap()
                .is_none());
            assert!(
                assert_no_pending_at(Path::new(&origin.vault_path), &path.to_string_lossy())
                    .is_err(),
                "unfinished full-copy cleanup must block path changes"
            );
            assert_eq!(std::fs::read_to_string(&path).unwrap(), HUMAN);
            let newer = stage(
                &state,
                &path.to_string_lossy(),
                &saved.baseline_revision,
                "Synthetic draft after committed retirement",
                &origin,
                None,
            )
            .unwrap();
            assert_eq!(
                load(&state, &path.to_string_lossy(), &origin)
                    .unwrap()
                    .unwrap()
                    .revision,
                newer.revision
            );
        },
    );
}

#[test]
fn abrupt_exit_after_real_unlink_recovers_identical_draft_in_a_new_process() {
    let vault = tempfile::Builder::new()
        .prefix("myco-synthetic-editor-retirement-")
        .tempdir()
        .unwrap();
    let data = tempfile::Builder::new()
        .prefix("myco-synthetic-editor-retirement-data-")
        .tempdir()
        .unwrap();
    std::fs::create_dir(vault.path().join("wiki")).unwrap();
    std::fs::write(vault.path().join("wiki/note.md"), ORIGINAL).unwrap();
    std::fs::write(vault.path().join("synthetic.marker"), MARKER).unwrap();
    let first = run_child(vault.path(), data.path(), "abrupt_unlink", 23);
    let second = run_child(vault.path(), data.path(), "restore", 0);
    assert_ne!(first["pid"], second["pid"]);
    assert_eq!(first["noDropExit"], 23);
    assert_eq!(first["realUnlinkObserved"], true);
    assert_ne!(
        first["currentOrigin"]["openingToken"],
        second["currentOrigin"]["openingToken"]
    );
    assert_eq!(first["recovery"], second["recovery"]);
    assert_eq!(second["recovery"]["baselineRaw"], ORIGINAL);
    assert_eq!(second["recovery"]["draftRaw"], DRAFT);
    assert_eq!(
        std::fs::read_to_string(vault.path().join("wiki/note.md")).unwrap(),
        HUMAN
    );
    println!(
        "SYNTHETIC_EDITOR_RETIREMENT_ABRUPT_RESTART_PROOF={}",
        serde_json::json!({
            "abruptProcess":first,"restoreProcess":second,"oldOpeningWriteRefused":true,
            "pendingPathGuardRefused":true,"nativeHelperOnly":true,"powerLossTested":false
        })
    );
}

#[test]
fn committed_nonce_acknowledgement_is_idempotent_but_cannot_retire_a_newer_draft() {
    use std::os::unix::fs::MetadataExt;
    crate::settings::test_support::with_isolated_data("editor-retirement-replayed-ack", |_| {
        let (_vault, state, origin, path) = fixture();
        let first = checkpoint(&state, &path, &origin);
        std::fs::write(&path, HUMAN).unwrap();
        let (primary, pending, committed) =
            supporting_paths(&state, &path, &origin, &first.revision);
        retire(&state, &path.to_string_lossy(), &origin, &first.revision).unwrap();
        assert!(!primary.exists());
        assert!(!pending.exists());
        let marker = std::fs::read(&committed).unwrap();
        let metadata = std::fs::symlink_metadata(&committed).unwrap();
        let identity = (
            metadata.dev(),
            metadata.ino(),
            metadata.len(),
            metadata.mtime(),
            metadata.mtime_nsec(),
            metadata.ctime(),
            metadata.ctime_nsec(),
        );
        let replay = retire(&state, &path.to_string_lossy(), &origin, &first.revision);
        assert!(
            replay.is_ok(),
            "the same committed nonce must acknowledge without rewriting: {replay:?}"
        );
        assert!(!primary.exists());
        assert!(!pending.exists());
        assert_eq!(std::fs::read(&committed).unwrap(), marker);
        let after = std::fs::symlink_metadata(&committed).unwrap();
        assert_eq!(
            (
                after.dev(),
                after.ino(),
                after.len(),
                after.mtime(),
                after.mtime_nsec(),
                after.ctime(),
                after.ctime_nsec()
            ),
            identity
        );
        assert!(load(&state, &path.to_string_lossy(), &origin)
            .unwrap()
            .is_none());

        let fresh = crate::editor_io::read(&state, &path.to_string_lossy(), &origin).unwrap();
        assert_eq!(fresh.file.raw, HUMAN);
        assert_eq!(fresh.revision, hash(HUMAN.as_bytes()));
        let newer = stage(
            &state,
            &path.to_string_lossy(),
            &fresh.revision,
            "Synthetic newer E after fresh human baseline",
            &fresh.origin,
            None,
        )
        .unwrap();
        assert_ne!(newer.revision, first.revision);
        let newer_bytes = std::fs::read(&primary).unwrap();
        assert!(retire(&state, &path.to_string_lossy(), &origin, &first.revision).is_err());
        assert_eq!(std::fs::read(&primary).unwrap(), newer_bytes);
        assert_eq!(std::fs::read(&committed).unwrap(), marker);
        let retained = load(&state, &path.to_string_lossy(), &origin)
            .unwrap()
            .unwrap();
        assert_eq!(retained.revision, newer.revision);
        assert_eq!(retained.baseline_raw, HUMAN);
        assert_eq!(
            retained.draft_raw,
            "Synthetic newer E after fresh human baseline"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), HUMAN);
    });
}
