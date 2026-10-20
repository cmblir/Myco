//! Actual completed-journal byte custody; no proposed compact codec is assumed.
#![cfg(unix)]

use super::*;
use std::collections::BTreeMap;

const ORIGINAL: &str =
    "---\ntitle: Synthetic compact baseline A\n---\nOriginal A must leave completed journals.\n";
const DRAFT: &str =
    "---\ntitle: Synthetic compact draft D\n---\nDraft D must leave completed journals. 한글\n";
const HUMAN: &str = "---\ntitle: Synthetic human B\n---\nHuman replacement B stays untouched.\n";
const PROCESS_MARKER: &str = "Synthetic editor compact completion process only";
const PUBLICATION_FAULT: &str = "synthetic uncertainty after real v2 CAS publication";

fn file_stamp(path: &Path) -> (u64, u64, u64, u32, i64, i64, i64, i64) {
    use std::os::unix::fs::MetadataExt;
    let value = std::fs::symlink_metadata(path).unwrap();
    (
        value.dev(),
        value.ino(),
        value.nlink(),
        value.mode(),
        value.mtime(),
        value.mtime_nsec(),
        value.ctime(),
        value.ctime_nsec(),
    )
}

fn backup_path(
    state: &VaultRoot,
    path: &Path,
    origin: &AgentVaultSession,
    revision: &str,
) -> PathBuf {
    with_journal(
        state,
        &path.to_string_lossy(),
        origin,
        |_, directory, target, _| retirement::compacting_path(directory, target, revision),
    )
    .unwrap()
}

fn seed_legacy_completion(
    state: &VaultRoot,
    path: &Path,
    origin: &AgentVaultSession,
    revision: &str,
) -> Vec<u8> {
    let (primary, _, committed) = paths(state, path, origin, revision);
    let legacy = std::fs::read(&primary).unwrap();
    retire(state, &path.to_string_lossy(), origin, revision).unwrap();
    let previous = std::fs::read(&committed).unwrap();
    let receipt = crate::vault::write_file_if_unchanged_recorded(
        &committed.to_string_lossy(),
        std::str::from_utf8(&legacy).unwrap(),
        Some(&hash(&previous)),
    )
    .unwrap();
    assert_eq!(receipt.revision, hash(&legacy));
    legacy
}

fn compact_with_fault(
    state: &VaultRoot,
    path: &Path,
    origin: &AgentVaultSession,
    revision: &str,
    callback: impl FnOnce(&Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    with_journal(
        state,
        &path.to_string_lossy(),
        origin,
        |scope, directory, target, guard| {
            retirement::compact_with_hook(directory, target, scope, guard, revision, callback)
        },
    )
}

fn publish_uncertain_completion(
    state: &VaultRoot,
    path: &Path,
    origin: &AgentVaultSession,
    revision: &str,
    legacy: &[u8],
) {
    let mut reached = false;
    let result = compact_with_fault(state, path, origin, revision, |published, backup| {
        let receipt: serde_json::Value =
            serde_json::from_slice(&std::fs::read(published).unwrap()).unwrap();
        assert_eq!(receipt["version"], 2);
        assert_eq!(receipt["revision"], revision);
        assert_eq!(receipt["journalSha256"], hash(legacy));
        assert_eq!(std::fs::read(backup).unwrap(), legacy);
        reached = true;
        Err(PUBLICATION_FAULT.into())
    });
    assert!(
        reached,
        "the fault must follow actual v2 CAS, before native receipt confirmation"
    );
    assert!(result.unwrap_err().contains(PUBLICATION_FAULT));
}

fn fixture() -> (
    tempfile::TempDir,
    VaultRoot,
    AgentVaultSession,
    PathBuf,
    RecoveryDraft,
) {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path().canonicalize().unwrap();
    std::fs::create_dir(root.join("wiki")).unwrap();
    let path = root.join("wiki/note.md");
    std::fs::write(&path, ORIGINAL).unwrap();
    let state = VaultRoot::default();
    let generation = state.begin_open().unwrap();
    state.finish_open(generation, root, || ()).unwrap();
    let origin = state.snapshot().unwrap();
    let read = crate::editor_io::read(&state, &path.to_string_lossy(), &origin).unwrap();
    assert_eq!(read.file.raw, ORIGINAL);
    assert_eq!(read.revision, hash(ORIGINAL.as_bytes()));
    let saved = stage(
        &state,
        &path.to_string_lossy(),
        &read.revision,
        DRAFT,
        &origin,
        None,
    )
    .unwrap();
    std::fs::write(&path, HUMAN).unwrap();
    (vault, state, origin, path, saved)
}

fn paths(
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

fn private_files(directory: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut found = BTreeMap::new();
    for entry in std::fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        let metadata = std::fs::symlink_metadata(&path).unwrap();
        assert!(!metadata.file_type().is_symlink());
        if metadata.is_dir() {
            found.extend(private_files(&path));
        } else {
            assert!(
                metadata.is_file(),
                "journal storage must contain regular files"
            );
            found.insert(path.clone(), std::fs::read(path).unwrap());
        }
    }
    found
}

fn contains_raw_string(value: &serde_json::Value, raw: &str) -> bool {
    match value {
        serde_json::Value::String(text) => text.contains(raw),
        serde_json::Value::Array(values) => {
            values.iter().any(|value| contains_raw_string(value, raw))
        }
        serde_json::Value::Object(values) => {
            values.values().any(|value| contains_raw_string(value, raw))
        }
        _ => false,
    }
}

fn assert_retired_raw_absent(files: &BTreeMap<PathBuf, Vec<u8>>) {
    assert!(
        !files.is_empty(),
        "the exact retired nonce still needs a persisted acknowledgement"
    );
    for (path, bytes) in files {
        let text = std::str::from_utf8(bytes).unwrap();
        let decoded: serde_json::Value = serde_json::from_slice(bytes)
            .expect("completed journal acknowledgement must remain valid stored JSON");
        for raw in [ORIGINAL, DRAFT] {
            let escaped = serde_json::to_string(raw).unwrap();
            assert!(
                !text.contains(raw)
                    && !text.contains(&escaped[1..escaped.len() - 1])
                    && !contains_raw_string(&decoded, raw),
                "completed journal still retains the full retired original or draft: {}",
                path.display()
            );
        }
    }
}

#[test]
fn successful_retirement_removes_full_raw_and_keeps_exact_nonce_acknowledgement() {
    crate::settings::test_support::with_isolated_data("editor-compact-completed", |data| {
        let (_vault, state, origin, path, saved) = fixture();
        retire(&state, &path.to_string_lossy(), &origin, &saved.revision).unwrap();
        let files = private_files(&data.join("editor-recovery"));
        assert_retired_raw_absent(&files);
        assert!(load(&state, &path.to_string_lossy(), &origin)
            .unwrap()
            .is_none());
        assert_no_pending_at(Path::new(&origin.vault_path), &path.to_string_lossy()).unwrap();
        retire(&state, &path.to_string_lossy(), &origin, &saved.revision).unwrap();
        assert_eq!(private_files(&data.join("editor-recovery")), files);
        let mut unknown = saved.revision.clone();
        unknown.replace_range(..1, if unknown.starts_with('0') { "1" } else { "0" });
        assert!(retire(&state, &path.to_string_lossy(), &origin, &unknown).is_err());
        assert_eq!(private_files(&data.join("editor-recovery")), files);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), HUMAN);
    });
}

#[test]
fn replay_of_an_exact_legacy_full_committed_record_removes_its_retired_raw() {
    crate::settings::test_support::with_isolated_data("editor-compact-legacy-replay", |data| {
        let (_vault, state, origin, path, saved) = fixture();
        let (primary, pending, committed) = paths(&state, &path, &origin, &saved.revision);
        let legacy = std::fs::read(&primary).unwrap();
        let legacy_value: serde_json::Value = serde_json::from_slice(&legacy).unwrap();
        assert_eq!(legacy_value["version"], 1);
        assert_eq!(legacy_value["recovery"]["baselineRaw"], ORIGINAL);
        assert_eq!(legacy_value["recovery"]["draftRaw"], DRAFT);
        assert_eq!(legacy_value["recovery"]["revision"], saved.revision);
        retire(&state, &path.to_string_lossy(), &origin, &saved.revision).unwrap();
        assert!(!primary.exists());
        assert!(!pending.exists());
        // Preserve a genuine version-one record as a legacy fixture, without inventing a new codec.
        let previous = std::fs::read(&committed).unwrap();
        let receipt = crate::vault::write_file_if_unchanged_recorded(
            &committed.to_string_lossy(),
            std::str::from_utf8(&legacy).unwrap(),
            Some(&hash(&previous)),
        )
        .unwrap();
        assert_eq!(receipt.revision, hash(&legacy));
        assert_eq!(std::fs::read(&committed).unwrap(), legacy);
        retire(&state, &path.to_string_lossy(), &origin, &saved.revision).unwrap();
        assert_retired_raw_absent(&private_files(&data.join("editor-recovery")));
        assert!(load(&state, &path.to_string_lossy(), &origin)
            .unwrap()
            .is_none());
        assert_no_pending_at(Path::new(&origin.vault_path), &path.to_string_lossy()).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), HUMAN);
    });
}

#[test]
fn old_completed_nonce_cannot_clear_a_newer_draft_from_a_fresh_native_baseline() {
    crate::settings::test_support::with_isolated_data("editor-compact-newer-draft", |data| {
        let (_vault, state, origin, path, old) = fixture();
        retire(&state, &path.to_string_lossy(), &origin, &old.revision).unwrap();
        let fresh = crate::editor_io::read(&state, &path.to_string_lossy(), &origin).unwrap();
        assert_eq!(fresh.file.raw, HUMAN);
        assert_eq!(fresh.revision, hash(HUMAN.as_bytes()));
        let newer = stage(
            &state,
            &path.to_string_lossy(),
            &fresh.revision,
            "Synthetic latest E must remain",
            &fresh.origin,
            None,
        )
        .unwrap();
        let files = private_files(&data.join("editor-recovery"));
        assert!(retire(&state, &path.to_string_lossy(), &origin, &old.revision).is_err());
        assert_eq!(private_files(&data.join("editor-recovery")), files);
        let preserved = load(&state, &path.to_string_lossy(), &origin)
            .unwrap()
            .unwrap();
        assert_eq!(preserved.revision, newer.revision);
        assert_eq!(preserved.baseline_raw, HUMAN);
        assert_eq!(preserved.draft_raw, "Synthetic latest E must remain");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), HUMAN);
    });
}

#[test]
fn completed_full_copy_cleanup_failure_blocks_path_changes_without_resurrecting_the_draft() {
    crate::settings::test_support::with_isolated_data("editor-compact-cleanup-privacy", |data| {
        let (_vault, state, origin, path, saved) = fixture();
        let (primary, pending, committed) = paths(&state, &path, &origin, &saved.revision);
        let original_record = std::fs::read(&primary).unwrap();
        let mut cleanup_fault_reached = false;
        retire_with_cleanup_impl(
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
                assert_eq!(std::fs::read(&committed).unwrap(), original_record);
                assert_eq!(std::fs::read(&pending).unwrap(), original_record);
                cleanup_fault_reached = true;
                Err("synthetic cleanup failure after actual full committed copy".into())
            },
        )
        .unwrap();
        assert!(cleanup_fault_reached);
        assert!(!primary.exists());
        assert_eq!(std::fs::read(&committed).unwrap(), original_record);
        assert_eq!(std::fs::read(&pending).unwrap(), original_record);
        assert!(load(&state, &path.to_string_lossy(), &origin)
            .unwrap()
            .is_none());
        let files = private_files(&data.join("editor-recovery"));
        assert!(
            assert_no_pending_at(Path::new(&origin.vault_path), &path.to_string_lossy()).is_err(),
            "completed full copies must block path changes until their raw custody is resolved"
        );
        assert_eq!(private_files(&data.join("editor-recovery")), files);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), HUMAN);
    });
}

#[test]
#[ignore = "spawned only with explicit synthetic compaction vault and app-data"]
fn synthetic_compact_completion_child() {
    let requested = PathBuf::from(
        std::env::var_os("MYCO_EDITOR_COMPACTION_VAULT")
            .expect("explicit synthetic compaction vault required"),
    );
    let data = PathBuf::from(
        std::env::var_os("MYCO_DATA_DIR").expect("explicit synthetic compaction app-data required"),
    );
    assert!(requested.is_absolute() && data.is_absolute());
    assert!(requested
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("myco-synthetic-editor-compaction-"));
    assert!(data
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("myco-synthetic-editor-compaction-data-"));
    assert_eq!(
        std::fs::read_to_string(requested.join("synthetic.marker")).unwrap(),
        PROCESS_MARKER
    );
    assert!(std::env::var_os("MEMEX_DATA_DIR").is_none());
    let root = requested.canonicalize().unwrap();
    let state = VaultRoot::default();
    let generation = state.begin_open().unwrap();
    state.finish_open(generation, root.clone(), || ()).unwrap();
    let origin = state.snapshot().unwrap();
    let path = root.join("wiki/note.md");
    let phase = std::env::var("MYCO_EDITOR_COMPACTION_PHASE").unwrap();
    let old_origin;
    let revision;
    match phase.as_str() {
        "complete" | "abrupt_publication" => {
            let first = crate::editor_io::read(&state, &path.to_string_lossy(), &origin).unwrap();
            assert_eq!(first.file.raw, ORIGINAL);
            let saved = stage(
                &state,
                &path.to_string_lossy(),
                &first.revision,
                DRAFT,
                &origin,
                None,
            )
            .unwrap();
            std::fs::write(&path, HUMAN).unwrap();
            if phase == "abrupt_publication" {
                let legacy = seed_legacy_completion(&state, &path, &origin, &saved.revision);
                compact_with_fault(
                    &state,
                    &path,
                    &origin,
                    &saved.revision,
                    |published, backup| {
                        use std::io::Write;
                        let bytes = std::fs::read(published).unwrap();
                        let receipt: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                        assert_eq!(receipt["version"], 2);
                        assert_eq!(receipt["revision"], saved.revision);
                        assert_eq!(receipt["journalSha256"], hash(&legacy));
                        assert_eq!(std::fs::read(backup).unwrap(), legacy);
                        assert_eq!(std::fs::read_to_string(&path).unwrap(), HUMAN);
                        println!(
                            "SYNTHETIC_EDITOR_COMPACTION_PROCESS={}",
                            serde_json::json!({
                                "phase":phase,"pid":std::process::id(),"revision":saved.revision,
                                "oldOrigin":saved.origin,"currentOrigin":origin,
                                "publishedSha256":hash(&bytes),"backupSha256":hash(&legacy),
                                "publishedStamp":file_stamp(published),
                                "legacyFixtureFromActualNativeCheckpoint":true,
                                "realV2PublicationObserved":true,"nativeReceiptConfirmed":false,
                                "exitBeforeNativeReceiptRead":true,"nativeHelperOnly":true,
                                "installedUi":false,"powerLossTested":false
                            })
                        );
                        std::io::stdout().flush().unwrap();
                        std::process::exit(23);
                    },
                )
                .expect("the child must stop inside the real publication callback");
                panic!("publication callback did not stop the process");
            }
            retire(&state, &path.to_string_lossy(), &origin, &saved.revision).unwrap();
            revision = saved.revision;
            old_origin = saved.origin;
        }
        "restore" | "repair_after_abrupt" => {
            revision = std::env::var("MYCO_EDITOR_COMPACTION_NONCE").unwrap();
            old_origin = serde_json::from_str::<AgentVaultSession>(
                &std::env::var("MYCO_EDITOR_COMPACTION_OLD_ORIGIN").unwrap(),
            )
            .unwrap();
            assert_eq!(old_origin.vault_path, origin.vault_path);
            assert!(state.with_origin(&old_origin, |_| Ok(())).is_err());
            assert!(crate::editor_io::write(
                &state,
                &path.to_string_lossy(),
                DRAFT,
                &hash(ORIGINAL.as_bytes()),
                &old_origin
            )
            .is_err());
        }
        _ => panic!("unexpected compaction child phase: {phase}"),
    }
    let mut repaired_published_sha = None;
    let mut repaired_backup_sha = None;
    let mut repaired_published_stamp = None;
    if phase == "repair_after_abrupt" {
        let (_, _, committed) = paths(&state, &path, &origin, &revision);
        let backup = backup_path(&state, &path, &origin, &revision);
        let published = std::fs::read(&committed).unwrap();
        let published_stamp = file_stamp(&committed);
        let original = std::fs::read(&backup).unwrap();
        let raw: serde_json::Value = serde_json::from_slice(&original).unwrap();
        assert_eq!(raw["version"], 1);
        assert_eq!(raw["recovery"]["baselineRaw"], ORIGINAL);
        assert_eq!(raw["recovery"]["draftRaw"], DRAFT);
        assert_eq!(raw["recovery"]["revision"], revision);
        assert_eq!(
            raw["recovery"]["origin"],
            serde_json::to_value(&old_origin).unwrap()
        );
        assert!(load(&state, &path.to_string_lossy(), &origin)
            .unwrap()
            .is_none());
        assert!(assert_no_pending_at(&root, &path.to_string_lossy()).is_err());
        retire(&state, &path.to_string_lossy(), &origin, &revision).unwrap();
        assert!(!backup.exists());
        assert_eq!(std::fs::read(&committed).unwrap(), published);
        assert_eq!(file_stamp(&committed), published_stamp);
        repaired_published_stamp = Some(published_stamp);
        repaired_published_sha = Some(hash(&published));
        repaired_backup_sha = Some(hash(&original));
    }
    let before_ack = private_files(&data.join("editor-recovery"));
    let receipt_stamps: BTreeMap<_, _> = before_ack
        .keys()
        .map(|path| (path.clone(), file_stamp(path)))
        .collect();
    assert_retired_raw_absent(&before_ack);
    assert!(load(&state, &path.to_string_lossy(), &origin)
        .unwrap()
        .is_none());
    assert_no_pending_at(&root, &path.to_string_lossy()).unwrap();
    retire(&state, &path.to_string_lossy(), &origin, &revision).unwrap();
    assert_eq!(private_files(&data.join("editor-recovery")), before_ack);
    for (path, stamp) in &receipt_stamps {
        assert_eq!(file_stamp(path), *stamp);
    }
    assert_eq!(std::fs::read_to_string(&path).unwrap(), HUMAN);
    let receipt_hashes: BTreeMap<_, _> = before_ack
        .iter()
        .map(|(path, bytes)| {
            (
                path.file_name().unwrap().to_string_lossy().into_owned(),
                hash(bytes),
            )
        })
        .collect();
    println!(
        "SYNTHETIC_EDITOR_COMPACTION_PROCESS={}",
        serde_json::json!({
            "phase":phase,"pid":std::process::id(),"revision":revision,"oldOrigin":old_origin,
            "currentOrigin":origin,"receiptHashes":receipt_hashes,"humanFileSha256":hash(HUMAN.as_bytes()),
            "oldOpeningWriteRefused":phase == "restore" || phase == "repair_after_abrupt",
            "repairedPublishedSha256":repaired_published_sha,"repairedBackupSha256":repaired_backup_sha,
            "repairedPublishedStamp":repaired_published_stamp,
            "nativeHelperOnly":true,
            "installedUi":false,"powerLossTested":false
        })
    );
}

#[test]
fn actual_completed_compact_factory_restarts_with_the_same_nonce_and_no_raw_or_old_write_authority()
{
    let vault = tempfile::Builder::new()
        .prefix("myco-synthetic-editor-compaction-")
        .tempdir()
        .unwrap();
    let data = tempfile::Builder::new()
        .prefix("myco-synthetic-editor-compaction-data-")
        .tempdir()
        .unwrap();
    std::fs::create_dir(vault.path().join("wiki")).unwrap();
    std::fs::write(vault.path().join("wiki/note.md"), ORIGINAL).unwrap();
    std::fs::write(vault.path().join("synthetic.marker"), PROCESS_MARKER).unwrap();
    let run = |phase: &str, previous: Option<&serde_json::Value>| {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "editor_recovery::compaction_tests::synthetic_compact_completion_child",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("MYCO_EDITOR_COMPACTION_VAULT", vault.path())
            .env("MYCO_DATA_DIR", data.path())
            .env("MYCO_EDITOR_COMPACTION_PHASE", phase)
            .env_remove("MEMEX_DATA_DIR")
            .env_remove("MYCO_EDITOR_COMPACTION_NONCE")
            .env_remove("MYCO_EDITOR_COMPACTION_OLD_ORIGIN")
            .env("RUST_BACKTRACE", "1");
        if let Some(first) = previous {
            command
                .env(
                    "MYCO_EDITOR_COMPACTION_NONCE",
                    first["revision"].as_str().unwrap(),
                )
                .env(
                    "MYCO_EDITOR_COMPACTION_OLD_ORIGIN",
                    serde_json::to_string(&first["oldOrigin"]).unwrap(),
                );
        }
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "compaction child {phase} failed: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8(output.stdout).unwrap();
        let raw = stdout
            .lines()
            .find_map(|line| {
                line.split_once("SYNTHETIC_EDITOR_COMPACTION_PROCESS=")
                    .map(|(_, raw)| raw)
            })
            .expect("actual compaction child proof required");
        serde_json::from_str::<serde_json::Value>(raw).unwrap()
    };
    let first = run("complete", None);
    let second = run("restore", Some(&first));
    assert_ne!(first["pid"], second["pid"]);
    assert_ne!(
        first["currentOrigin"]["openingToken"],
        second["currentOrigin"]["openingToken"]
    );
    assert_eq!(first["revision"], second["revision"]);
    assert_eq!(first["receiptHashes"], second["receiptHashes"]);
    assert_eq!(second["oldOpeningWriteRefused"], true);
    assert_eq!(second["humanFileSha256"], hash(HUMAN.as_bytes()));
    assert_eq!(
        std::fs::read_to_string(vault.path().join("wiki/note.md")).unwrap(),
        HUMAN
    );
    println!(
        "SYNTHETIC_EDITOR_COMPACTION_RESTART_PROOF={}",
        serde_json::json!({
            "completionProcess":first,"restoreProcess":second,"nativeHelperOnly":true,
            "installedUi":false,"powerLossTested":false
        })
    );
}

#[test]
fn real_v2_publication_uncertainty_preserves_full_backup_then_replay_cleans_without_rewriting_v2() {
    crate::settings::test_support::with_isolated_data(
        "editor-compact-real-publication-fault",
        |data| {
            let (_vault, state, origin, path, saved) = fixture();
            let legacy = seed_legacy_completion(&state, &path, &origin, &saved.revision);
            let (_, _, committed) = paths(&state, &path, &origin, &saved.revision);
            let backup = backup_path(&state, &path, &origin, &saved.revision);
            publish_uncertain_completion(&state, &path, &origin, &saved.revision, &legacy);
            let published = std::fs::read(&committed).unwrap();
            let published_stamp = file_stamp(&committed);
            assert_eq!(std::fs::read(&backup).unwrap(), legacy);
            assert!(load(&state, &path.to_string_lossy(), &origin)
                .unwrap()
                .is_none());
            assert!(
                assert_no_pending_at(Path::new(&origin.vault_path), &path.to_string_lossy())
                    .is_err()
            );
            assert_eq!(std::fs::read_to_string(&path).unwrap(), HUMAN);
            retire(&state, &path.to_string_lossy(), &origin, &saved.revision).unwrap();
            assert!(!backup.exists());
            assert_eq!(std::fs::read(&committed).unwrap(), published);
            assert_eq!(file_stamp(&committed), published_stamp);
            assert_retired_raw_absent(&private_files(&data.join("editor-recovery")));
            assert_no_pending_at(Path::new(&origin.vault_path), &path.to_string_lossy()).unwrap();
            assert_eq!(std::fs::read_to_string(&path).unwrap(), HUMAN);
        },
    );
}

#[test]
fn mixed_v1_pending_and_v2_receipt_bind_exact_original_bytes_before_cleanup() {
    crate::settings::test_support::with_isolated_data("editor-compact-mixed-digest", |data| {
        let (_vault, state, origin, path, saved) = fixture();
        let (primary, pending, committed) = paths(&state, &path, &origin, &saved.revision);
        let legacy = std::fs::read(&primary).unwrap();
        retire(&state, &path.to_string_lossy(), &origin, &saved.revision).unwrap();
        let published = std::fs::read(&committed).unwrap();
        let receipt = crate::vault::write_file_if_unchanged_recorded(
            &pending.to_string_lossy(),
            std::str::from_utf8(&legacy).unwrap(),
            None,
        )
        .unwrap();
        assert_eq!(receipt.revision, hash(&legacy));
        assert!(load(&state, &path.to_string_lossy(), &origin)
            .unwrap()
            .is_none());
        assert!(
            assert_no_pending_at(Path::new(&origin.vault_path), &path.to_string_lossy()).is_err()
        );
        // JSON meaning is unchanged, but the exact original-byte digest is different.
        let changed = [b" ".as_slice(), legacy.as_slice()].concat();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&changed).unwrap(),
            serde_json::from_slice::<serde_json::Value>(&legacy).unwrap()
        );
        std::fs::write(&pending, &changed).unwrap();
        assert!(load(&state, &path.to_string_lossy(), &origin).is_err());
        assert!(retire(&state, &path.to_string_lossy(), &origin, &saved.revision).is_err());
        assert!(!primary.exists());
        assert_eq!(std::fs::read(&pending).unwrap(), changed);
        assert_eq!(std::fs::read(&committed).unwrap(), published);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), HUMAN);
        std::fs::write(&pending, &legacy).unwrap();
        retire(&state, &path.to_string_lossy(), &origin, &saved.revision).unwrap();
        assert!(!pending.exists());
        assert_eq!(std::fs::read(&committed).unwrap(), published);
        assert_retired_raw_absent(&private_files(&data.join("editor-recovery")));
    });
}

#[test]
fn actual_process_exit_after_v2_publication_retains_backup_until_exact_nonce_repair() {
    let vault = tempfile::Builder::new()
        .prefix("myco-synthetic-editor-compaction-")
        .tempdir()
        .unwrap();
    let data = tempfile::Builder::new()
        .prefix("myco-synthetic-editor-compaction-data-")
        .tempdir()
        .unwrap();
    std::fs::create_dir(vault.path().join("wiki")).unwrap();
    std::fs::write(vault.path().join("wiki/note.md"), ORIGINAL).unwrap();
    std::fs::write(vault.path().join("synthetic.marker"), PROCESS_MARKER).unwrap();
    let run = |phase: &str, previous: Option<&serde_json::Value>, exit_code: i32| {
        let mut command = std::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "editor_recovery::compaction_tests::synthetic_compact_completion_child",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("MYCO_EDITOR_COMPACTION_VAULT", vault.path())
            .env("MYCO_DATA_DIR", data.path())
            .env("MYCO_EDITOR_COMPACTION_PHASE", phase)
            .env_remove("MEMEX_DATA_DIR")
            .env_remove("MYCO_EDITOR_COMPACTION_NONCE")
            .env_remove("MYCO_EDITOR_COMPACTION_OLD_ORIGIN")
            .env("RUST_BACKTRACE", "1");
        if let Some(first) = previous {
            command
                .env(
                    "MYCO_EDITOR_COMPACTION_NONCE",
                    first["revision"].as_str().unwrap(),
                )
                .env(
                    "MYCO_EDITOR_COMPACTION_OLD_ORIGIN",
                    serde_json::to_string(&first["oldOrigin"]).unwrap(),
                );
        }
        let output = command.output().unwrap();
        assert_eq!(
            output.status.code(),
            Some(exit_code),
            "compaction child {phase}: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8(output.stdout).unwrap();
        let raw = stdout
            .lines()
            .find_map(|line| {
                line.split_once("SYNTHETIC_EDITOR_COMPACTION_PROCESS=")
                    .map(|(_, raw)| raw)
            })
            .expect("actual child publication/repair proof required");
        serde_json::from_str::<serde_json::Value>(raw).unwrap()
    };
    let first = run("abrupt_publication", None, 23);
    let second = run("repair_after_abrupt", Some(&first), 0);
    assert_ne!(first["pid"], second["pid"]);
    assert_ne!(
        first["currentOrigin"]["openingToken"],
        second["currentOrigin"]["openingToken"]
    );
    assert_eq!(first["revision"], second["revision"]);
    assert_eq!(first["publishedSha256"], second["repairedPublishedSha256"]);
    assert_eq!(first["backupSha256"], second["repairedBackupSha256"]);
    assert_eq!(first["publishedStamp"], second["repairedPublishedStamp"]);
    assert_eq!(first["realV2PublicationObserved"], true);
    assert_eq!(first["nativeReceiptConfirmed"], false);
    assert_eq!(second["oldOpeningWriteRefused"], true);
    assert_eq!(
        std::fs::read_to_string(vault.path().join("wiki/note.md")).unwrap(),
        HUMAN
    );
    println!(
        "SYNTHETIC_EDITOR_COMPACTION_ABRUPT_REPAIR_PROOF={}",
        serde_json::json!({
            "publicationProcess":first,"repairProcess":second,"firstExitCode":23,
            "nativeHelperOnly":true,"installedUi":false,"powerLossTested":false
        })
    );
}

#[test]
fn corrupt_or_unsafe_compact_receipt_and_backup_fail_closed_without_changing_newer_draft() {
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
    for target_kind in ["receipt", "backup"] {
        crate::settings::test_support::with_isolated_data(
            "editor-compact-unsafe-support",
            |data| {
                let (_vault, state, origin, path, old) = fixture();
                let (primary, _, committed) = paths(&state, &path, &origin, &old.revision);
                let legacy = std::fs::read(&primary).unwrap();
                retire(&state, &path.to_string_lossy(), &origin, &old.revision).unwrap();
                let fresh =
                    crate::editor_io::read(&state, &path.to_string_lossy(), &origin).unwrap();
                let newer = stage(
                    &state,
                    &path.to_string_lossy(),
                    &fresh.revision,
                    "Synthetic latest E remains through corrupt support",
                    &fresh.origin,
                    None,
                )
                .unwrap();
                let active = std::fs::read(&primary).unwrap();
                let target = if target_kind == "receipt" {
                    committed.clone()
                } else {
                    let backup = backup_path(&state, &path, &origin, &old.revision);
                    crate::vault::write_file_if_unchanged_recorded(
                        &backup.to_string_lossy(),
                        std::str::from_utf8(&legacy).unwrap(),
                        None,
                    )
                    .unwrap();
                    backup
                };
                let valid = std::fs::read(&target).unwrap();
                let proxy = data.join("synthetic-external-support.json");
                let refuse = || {
                    assert!(load(&state, &path.to_string_lossy(), &origin).is_err());
                    assert!(
                        retire(&state, &path.to_string_lossy(), &origin, &old.revision).is_err()
                    );
                    assert!(stage(
                        &state,
                        &path.to_string_lossy(),
                        &fresh.revision,
                        "must not overwrite E",
                        &fresh.origin,
                        Some(&newer.revision)
                    )
                    .is_err());
                    assert!(assert_no_pending_at(
                        Path::new(&origin.vault_path),
                        &path.to_string_lossy()
                    )
                    .is_err());
                    assert_eq!(std::fs::read(&primary).unwrap(), active);
                    assert_eq!(std::fs::read_to_string(&path).unwrap(), HUMAN);
                };
                for fault in [
                    "malformed",
                    "version",
                    "unknown",
                    "mode",
                    "symlink",
                    "hardlink",
                ] {
                    match fault {
                        "malformed" => std::fs::write(&target, b"{").unwrap(),
                        "version" | "unknown" => {
                            let mut value: serde_json::Value =
                                serde_json::from_slice(&valid).unwrap();
                            if fault == "version" {
                                value["version"] = serde_json::json!(99);
                            } else {
                                value["unapprovedExtraField"] = serde_json::json!(true);
                            }
                            std::fs::write(&target, serde_json::to_vec(&value).unwrap()).unwrap();
                        }
                        "mode" => std::fs::set_permissions(
                            &target,
                            std::fs::Permissions::from_mode(0o644),
                        )
                        .unwrap(),
                        "symlink" => {
                            std::fs::write(&proxy, &valid).unwrap();
                            std::fs::remove_file(&target).unwrap();
                            symlink(&proxy, &target).unwrap();
                        }
                        "hardlink" => {
                            std::fs::hard_link(&target, &proxy).unwrap();
                            assert_eq!(std::fs::symlink_metadata(&target).unwrap().nlink(), 2);
                        }
                        _ => unreachable!(),
                    }
                    let fault_bytes = std::fs::read(&target).unwrap();
                    let fault_stamp = file_stamp(&target);
                    refuse();
                    assert_eq!(std::fs::read(&target).unwrap(), fault_bytes);
                    assert_eq!(file_stamp(&target), fault_stamp);
                    match fault {
                        "symlink" => {
                            assert!(std::fs::symlink_metadata(&target)
                                .unwrap()
                                .file_type()
                                .is_symlink());
                            assert_eq!(std::fs::read(&proxy).unwrap(), valid);
                            std::fs::remove_file(&target).unwrap();
                            std::fs::remove_file(&proxy).unwrap();
                            std::fs::write(&target, &valid).unwrap();
                        }
                        "hardlink" => {
                            assert_eq!(std::fs::symlink_metadata(&target).unwrap().nlink(), 2);
                            assert_eq!(std::fs::read(&proxy).unwrap(), valid);
                            std::fs::remove_file(&proxy).unwrap();
                        }
                        _ => std::fs::write(&target, &valid).unwrap(),
                    }
                    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o600))
                        .unwrap();
                    let current = load(&state, &path.to_string_lossy(), &origin)
                        .unwrap()
                        .unwrap();
                    assert_eq!(current.revision, newer.revision);
                    assert_eq!(current.baseline_raw, HUMAN);
                    assert_eq!(
                        current.draft_raw,
                        "Synthetic latest E remains through corrupt support"
                    );
                    assert_eq!(std::fs::read(&primary).unwrap(), active);
                }
            },
        );
    }
}

#[test]
#[ignore = "explicit synthetic completed-receipt guard benchmark only"]
fn synthetic_completed_receipt_guard_benchmark() {
    crate::settings::test_support::with_isolated_data("editor-compact-guard-benchmark", |data| {
        let initial_preparation = std::time::Instant::now();
        let (_vault, state, origin, path, saved) = fixture();
        retire(&state, &path.to_string_lossy(), &origin, &saved.revision).unwrap();
        let mut preparation_seconds = initial_preparation.elapsed().as_secs_f64();
        let mut completed_receipts = 1_usize;
        let directory = data.join("editor-recovery");
        for target in [32_usize, 128] {
            let preparation = std::time::Instant::now();
            while completed_receipts < target {
                let current =
                    crate::editor_io::read(&state, &path.to_string_lossy(), &origin).unwrap();
                assert_eq!(current.file.raw, HUMAN);
                let saved = stage(
                    &state,
                    &path.to_string_lossy(),
                    &current.revision,
                    DRAFT,
                    &current.origin,
                    None,
                )
                .unwrap();
                retire(&state, &path.to_string_lossy(), &origin, &saved.revision).unwrap();
                completed_receipts += 1;
            }
            preparation_seconds += preparation.elapsed().as_secs_f64();
            let expected_files = private_files(&directory);
            assert_eq!(expected_files.len(), target);
            assert_retired_raw_absent(&expected_files);
            for (receipt_path, bytes) in &expected_files {
                assert!(receipt_path
                    .file_name()
                    .unwrap()
                    .to_str()
                    .unwrap()
                    .ends_with(".committed.json"));
                let receipt: serde_json::Value = serde_json::from_slice(bytes).unwrap();
                assert_eq!(receipt["version"], 2);
                assert!(!contains_raw_string(&receipt, HUMAN));
            }
            let journal_bytes: usize = expected_files.values().map(Vec::len).sum();
            let mut guard_seconds = Vec::new();
            for _ in 0..3 {
                assert_eq!(std::fs::read_to_string(&path).unwrap(), HUMAN);
                assert_eq!(private_files(&directory), expected_files);
                let started = std::time::Instant::now();
                let result =
                    assert_no_pending_at(Path::new(&origin.vault_path), &path.to_string_lossy());
                guard_seconds.push(started.elapsed().as_secs_f64());
                result.unwrap();
                assert_eq!(std::fs::read_to_string(&path).unwrap(), HUMAN);
                assert_eq!(private_files(&directory), expected_files);
            }
            println!(
                "SYNTHETIC_EDITOR_GUARD_BENCHMARK={}",
                serde_json::json!({
                    "completedReceipts":target,"journalFileCount":expected_files.len(),
                    "journalBytes":journal_bytes,"guardCallSeconds":guard_seconds,
                    "fixturePreparationSecondsCumulative":preparation_seconds,
                    "snapshotReadBeforeEachGuard":true,"humanNoteUnchanged":true,
                    "receiptBytesUnchanged":true,"nativeHelpersOnly":true,
                    "quotaOrExpiryAccepted":false,"installedUi":false
                })
            );
        }
    });
}
