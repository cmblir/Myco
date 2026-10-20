use super::*;
use std::io::Read;

fn session(root: &Path) -> std::path::PathBuf {
    let path = root.join("synthetic.jsonl");
    let text =
        "Explain the synthetic parser migration and the evidence validation plan. ".repeat(30);
    let line = serde_json::json!({
        "type": "user", "sessionId": "synthetic",
        "message": {"role": "user", "content": text}
    });
    std::fs::write(&path, format!("{line}\n")).unwrap();
    path
}

#[test]
fn corrupt_ledger_stops_public_import_without_replacing_identity() {
    let vault = tempfile::tempdir().unwrap();
    std::fs::create_dir(vault.path().join(".myco")).unwrap();
    let ledger_path = vault.path().join(".myco/ledger.json");
    let original = b"{broken synthetic identity";
    std::fs::write(&ledger_path, original).unwrap();
    let input = session(vault.path());
    let outcome = crate::commands::run_import(vault.path(), &[input], "_inbox", |_| {});
    assert_eq!(outcome.imported, 0);
    assert!(!outcome.failed.is_empty());
    assert_eq!(std::fs::read(&ledger_path).unwrap(), original);
    assert!(!vault.path().join("_inbox").exists());
}

#[cfg(unix)]
#[test]
fn unreadable_ledger_stops_public_import_before_projection_write() {
    let vault = tempfile::tempdir().unwrap();
    let directory = vault.path().join(".myco");
    std::fs::create_dir(&directory).unwrap();
    let ledger_path = directory.join("ledger.json");
    let original = b"{\"entries\":{\"codex:prior\":\"prior\"}}";
    std::fs::write(&ledger_path, original).unwrap();
    let input = session(vault.path());
    let denied = crate::vault::scan_tests::DeniedDirectory::new(&directory);
    let outcome = crate::commands::run_import(vault.path(), &[input], "_inbox", |_| {});
    drop(denied);
    assert_eq!(outcome.imported, 0);
    assert!(!outcome.failed.is_empty());
    assert_eq!(std::fs::read(&ledger_path).unwrap(), original);
    assert!(!vault.path().join("_inbox").exists());
}

#[test]
fn stale_ledger_snapshot_cannot_replace_a_newer_record() {
    let vault = tempfile::tempdir().unwrap();
    let mut first = Ledger::load(vault.path()).unwrap();
    let mut stale = Ledger::load(vault.path()).unwrap();
    first.record("codex:first".into(), "first".into());
    first.save(vault.path()).unwrap();
    stale.record("codex:stale".into(), "stale".into());
    assert!(stale.save(vault.path()).is_err());
    let restored = Ledger::load(vault.path()).unwrap();
    assert!(restored.seen("codex:first", "first"));
    assert!(!restored.seen("codex:stale", "stale"));
}

#[test]
fn ledger_publication_keeps_the_previous_open_file_complete() {
    let vault = tempfile::tempdir().unwrap();
    let mut ledger = Ledger::default();
    ledger.record("codex:first".into(), "first".into());
    ledger.save(vault.path()).unwrap();
    let path = vault.path().join(".myco/ledger.json");
    let previous = std::fs::read_to_string(&path).unwrap();
    let mut held_reader = std::fs::File::open(&path).unwrap();
    ledger.record("codex:second".into(), "second".into());
    ledger.save(vault.path()).unwrap();
    let mut held_bytes = String::new();
    held_reader.read_to_string(&mut held_bytes).unwrap();
    assert_eq!(held_bytes, previous);
    assert!(Ledger::load(vault.path())
        .unwrap()
        .seen("codex:second", "second"));
}

#[test]
fn loading_legacy_body_index_does_not_publish_a_hidden_write() {
    let vault = tempfile::tempdir().unwrap();
    std::fs::create_dir(vault.path().join(".myco")).unwrap();
    std::fs::create_dir(vault.path().join("sessions")).unwrap();
    std::fs::write(
        vault.path().join("sessions/prior.md"),
        "# Synthetic prior\nBody",
    )
    .unwrap();
    let path = vault.path().join(".myco/ledger.json");
    let previous = b"{\"entries\":{\"codex:prior\":\"prior\"}}";
    std::fs::write(&path, previous).unwrap();
    let _loaded = Ledger::load(vault.path()).unwrap();
    assert_eq!(std::fs::read(path).unwrap(), previous);
}

#[cfg(unix)]
#[test]
fn redirected_state_directory_cannot_modify_raw_through_import() {
    let vault = tempfile::tempdir().unwrap();
    let raw = vault.path().join("raw");
    std::fs::create_dir(&raw).unwrap();
    let raw_path = raw.join("ledger.json");
    let previous = b"Synthetic immutable sentinel";
    std::fs::write(&raw_path, previous).unwrap();
    std::os::unix::fs::symlink(&raw, vault.path().join(".myco")).unwrap();
    let input = session(vault.path());
    let outcome = crate::commands::run_import(vault.path(), &[input], "_inbox", |_| {});
    assert_eq!(std::fs::read(raw_path).unwrap(), previous);
    assert_eq!(outcome.imported, 0);
    assert!(!outcome.failed.is_empty());
}

#[test]
fn a_failed_ledger_publication_reports_original_sources_as_retryable() {
    let vault = tempfile::tempdir().unwrap();
    let input = session(vault.path());
    let later = b"{\"entries\":{\"codex:later\":\"later\"},\"body_index_version\":1}";
    let ledger_path = vault.path().join(".myco/ledger.json");
    let outcome =
        crate::commands::run_import(vault.path(), std::slice::from_ref(&input), "_inbox", |_| {
            std::fs::create_dir_all(vault.path().join(".myco")).unwrap();
            std::fs::write(&ledger_path, later).unwrap();
        });
    assert_eq!(outcome.imported, 1, "the projection already exists");
    assert_eq!(outcome.failed.len(), 1);
    assert_eq!(outcome.failed[0].path, input.to_string_lossy());
    assert!(outcome.failed[0].error.contains("publication incomplete"));
    assert_eq!(std::fs::read(ledger_path).unwrap(), later);
    assert!(vault.path().join("raw/conversations").is_dir());
    assert!(vault.path().join("_inbox").is_dir());
}

#[test]
fn unknown_object_fields_cannot_be_erased_by_a_ledger_upgrade() {
    let vault = tempfile::tempdir().unwrap();
    std::fs::create_dir(vault.path().join(".myco")).unwrap();
    let path = vault.path().join(".myco/ledger.json");
    let original = b"{\"entries\":{},\"future_state\":{\"revision\":2}}";
    std::fs::write(&path, original).unwrap();
    assert!(Ledger::load(vault.path()).is_err());
    assert_eq!(std::fs::read(path).unwrap(), original);
}

#[test]
fn a_loaded_ledger_cannot_publish_to_another_vault() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let mut ledger = Ledger::load(first.path()).unwrap();
    ledger.record("codex:first".into(), "first".into());
    assert!(ledger.save(second.path()).is_err());
    assert!(!second.path().join(".myco").exists());
}

#[cfg(unix)]
#[test]
fn an_unreadable_backfill_does_not_stamp_partial_coverage() {
    let vault = tempfile::tempdir().unwrap();
    let sessions = vault.path().join("sessions");
    std::fs::create_dir(&sessions).unwrap();
    std::fs::write(sessions.join("synthetic.md"), "# Synthetic prior\nBody").unwrap();
    std::fs::create_dir(vault.path().join(".myco")).unwrap();
    let path = vault.path().join(".myco/ledger.json");
    let original = b"{\"entries\":{\"codex:prior\":\"prior\"}}";
    std::fs::write(&path, original).unwrap();
    let denied = crate::vault::scan_tests::DeniedDirectory::new(&sessions);
    assert!(Ledger::load(vault.path()).is_err());
    drop(denied);
    assert_eq!(std::fs::read(path).unwrap(), original);
}
