//! Actual synthetic files and cooperating writers, without models or app data.
#![cfg(unix)]

use super::*;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::time::Duration;

const ORIGINAL: &str = "---\r\ntitle: Synthetic deck\r\n---\r\n# Human heading\r\nQ ?? A\r\n<!--src:[[Synthetic]]-->\r\n\r\nKeep this human note.\r\n";
const PATCHED: &str = "Synthetic submitted patch.\n";
const HUMAN: &str = "A newer synthetic human edit.\n";

struct Fixture {
    _directory: tempfile::TempDir,
    root: PathBuf,
    state: Arc<VaultRoot>,
    registry: Arc<StudyDeckRegistry>,
    origin: AgentVaultSession,
}

fn open(state: &VaultRoot, root: &Path) {
    let generation = state.begin_open().unwrap();
    state
        .finish_open(generation, root.to_path_buf(), || ())
        .unwrap();
}

impl Fixture {
    fn new(existing: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let state = Arc::new(VaultRoot::default());
        open(&state, &root);
        let origin = state.snapshot().unwrap();
        if existing {
            std::fs::create_dir(root.join("cards")).unwrap();
            std::fs::write(root.join("cards/deck.md"), ORIGINAL).unwrap();
        }
        Self {
            _directory: directory,
            root,
            state,
            registry: Arc::new(StudyDeckRegistry::default()),
            origin,
        }
    }
    fn path(&self) -> PathBuf {
        self.root.join("cards/deck.md")
    }
    fn read(&self) -> Snapshot {
        read(
            &self.state,
            &self.registry,
            &self.path().to_string_lossy(),
            &self.origin,
        )
        .unwrap()
    }
    fn write(&self, context: &Context, content: &str) -> Result<MutationReceipt, String> {
        write(&self.state, &self.registry, context, content)
    }
    fn assert_bytes(&self, expected: &str) {
        assert_eq!(std::fs::read_to_string(self.path()).unwrap(), expected);
    }
}

#[test]
fn absent_and_existing_empty_have_distinct_native_baselines() {
    let fixture = Fixture::new(false);
    let absent = fixture.read();
    assert_eq!(absent.raw, "");
    assert_eq!(absent.revision, None);
    assert!(
        !fixture.root.join("cards").exists(),
        "reading must not create a folder"
    );
    let receipt = fixture.write(&absent.context, "").unwrap();
    assert_eq!(receipt.state, MutationState::Persisted);
    assert_eq!(
        receipt.revision.as_deref(),
        Some(sources::digest("").as_str())
    );
    assert_eq!(receipt.path, absent.context.path);
    assert!(receipt.error.is_none());
    let empty = fixture.read();
    assert_eq!(empty.raw, "");
    assert_eq!(empty.revision, receipt.revision);
    fixture.write(&empty.context, PATCHED).unwrap();
    fixture.assert_bytes(PATCHED);
}

#[test]
fn full_raw_bytes_and_actual_persisted_sha_are_returned() {
    let fixture = Fixture::new(true);
    let snapshot = fixture.read();
    assert_eq!(snapshot.raw, ORIGINAL);
    assert_eq!(snapshot.revision, Some(sources::digest(ORIGINAL)));
    assert!(same_origin(&snapshot.context.origin, &fixture.origin));
    let patch = format!("{ORIGINAL}\r\nNew Q ?? New A\r\n");
    let receipt = fixture.write(&snapshot.context, &patch).unwrap();
    assert_eq!(receipt.state, MutationState::Persisted);
    assert_eq!(receipt.revision, Some(sources::digest(&patch)));
    assert!(same_origin(&receipt.origin, &fixture.origin));
    fixture.assert_bytes(&patch);
    assert_eq!(
        fixture.write(&snapshot.context, &patch).unwrap().revision,
        receipt.revision
    );
    fixture.assert_bytes(&patch);
}

#[test]
fn unreadable_utf8_oversize_and_directory_are_not_absence() {
    let fixture = Fixture::new(true);
    std::fs::write(fixture.path(), [0xff, 0xfe]).unwrap();
    assert!(read(
        &fixture.state,
        &fixture.registry,
        &fixture.path().to_string_lossy(),
        &fixture.origin
    )
    .unwrap_err()
    .contains("UTF-8"));
    assert_eq!(std::fs::read(fixture.path()).unwrap(), [0xff, 0xfe]);
    std::fs::write(fixture.path(), vec![b'x'; MAX_BYTES + 1]).unwrap();
    assert!(read(
        &fixture.state,
        &fixture.registry,
        &fixture.path().to_string_lossy(),
        &fixture.origin
    )
    .unwrap_err()
    .contains("1 MiB"));
    std::fs::remove_file(fixture.path()).unwrap();
    std::fs::create_dir(fixture.path()).unwrap();
    assert!(read(
        &fixture.state,
        &fixture.registry,
        &fixture.path().to_string_lossy(),
        &fixture.origin
    )
    .is_err());
    assert_eq!(fixture.registry.0.lock().unwrap().len(), 0);
}

#[test]
fn injected_read_permission_failure_is_not_a_new_deck() {
    let fixture = Fixture::new(true);
    // Root-capable hosts cannot reliably obtain EACCES from mode bits. Inject
    // that syscall outcome after actual confinement/open/identity checks.
    let result = read_impl(
        &fixture.state,
        &fixture.registry,
        &fixture.path().to_string_lossy(),
        &fixture.origin,
        || {
            Err(format!(
                "read study deck: {}",
                std::io::Error::from(std::io::ErrorKind::PermissionDenied)
            ))
        },
    );
    assert!(result.unwrap_err().contains("denied"));
    fixture.assert_bytes(ORIGINAL);
    assert_eq!(fixture.registry.0.lock().unwrap().len(), 0);
}

#[test]
fn symlink_hardlink_fifo_and_nested_targets_are_refused() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new(true);
    let original = fixture.root.join("original.md");
    std::fs::rename(fixture.path(), &original).unwrap();
    symlink(&original, fixture.path()).unwrap();
    assert!(read(
        &fixture.state,
        &fixture.registry,
        &fixture.path().to_string_lossy(),
        &fixture.origin
    )
    .is_err());
    std::fs::remove_file(fixture.path()).unwrap();
    std::fs::hard_link(&original, fixture.path()).unwrap();
    assert!(read(
        &fixture.state,
        &fixture.registry,
        &fixture.path().to_string_lossy(),
        &fixture.origin
    )
    .is_err());
    std::fs::remove_file(fixture.path()).unwrap();
    let name = std::ffi::CString::new(fixture.path().to_string_lossy().as_bytes()).unwrap();
    // The CString stays alive and names only this synthetic temporary path.
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    assert!(read(
        &fixture.state,
        &fixture.registry,
        &fixture.path().to_string_lossy(),
        &fixture.origin
    )
    .is_err());
    for path in [
        fixture.root.join("cards/archive/deck.md"),
        fixture.root.join("wiki/deck.md"),
        fixture.root.join("cards/deck.txt"),
    ] {
        assert!(read(
            &fixture.state,
            &fixture.registry,
            &path.to_string_lossy(),
            &fixture.origin
        )
        .is_err());
    }
    assert_eq!(std::fs::read_to_string(original).unwrap(), ORIGINAL);
}

#[test]
fn same_byte_file_replacement_and_added_hardlink_refuse_old_snapshot() {
    let fixture = Fixture::new(true);
    let snapshot = fixture.read();
    std::fs::rename(fixture.path(), fixture.root.join("held-original.md")).unwrap();
    std::fs::write(fixture.path(), ORIGINAL).unwrap();
    assert!(fixture
        .write(&snapshot.context, PATCHED)
        .unwrap_err()
        .contains("identity"));
    fixture.assert_bytes(ORIGINAL);
    let fresh = fixture.read();
    std::fs::hard_link(fixture.path(), fixture.root.join("alias.md")).unwrap();
    assert!(fixture
        .write(&fresh.context, PATCHED)
        .unwrap_err()
        .contains("hard links"));
    fixture.assert_bytes(ORIGINAL);
}

#[test]
fn replaced_parent_directory_and_parent_symlink_refuse_old_snapshot() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new(true);
    let snapshot = fixture.read();
    let held = fixture.root.join("held-cards");
    std::fs::rename(fixture.root.join("cards"), &held).unwrap();
    std::fs::create_dir(fixture.root.join("cards")).unwrap();
    std::fs::write(fixture.path(), ORIGINAL).unwrap();
    assert!(fixture
        .write(&snapshot.context, PATCHED)
        .unwrap_err()
        .contains("identity"));
    fixture.assert_bytes(ORIGINAL);
    std::fs::remove_file(fixture.path()).unwrap();
    std::fs::remove_dir(fixture.root.join("cards")).unwrap();
    symlink(&held, fixture.root.join("cards")).unwrap();
    assert!(fixture.write(&snapshot.context, PATCHED).is_err());
    assert_eq!(
        std::fs::read_to_string(held.join("deck.md")).unwrap(),
        ORIGINAL
    );
}

#[test]
fn genuine_absence_conflicts_with_later_creation_or_directory_alias() {
    use std::os::unix::fs::symlink;
    let fixture = Fixture::new(false);
    let snapshot = fixture.read();
    std::fs::create_dir(fixture.root.join("cards")).unwrap();
    std::fs::write(fixture.path(), HUMAN).unwrap();
    assert!(fixture.write(&snapshot.context, PATCHED).is_err());
    fixture.assert_bytes(HUMAN);
    let fresh = fixture.read();
    let held = fixture.root.join("other-cards");
    std::fs::rename(fixture.root.join("cards"), &held).unwrap();
    symlink(&held, fixture.root.join("cards")).unwrap();
    assert!(fixture.write(&fresh.context, PATCHED).is_err());
    assert_eq!(
        std::fs::read_to_string(held.join("deck.md")).unwrap(),
        HUMAN
    );
}

#[test]
fn same_path_reopen_refuses_old_read_write_but_allows_exact_discard() {
    let fixture = Fixture::new(true);
    let snapshot = fixture.read();
    open(&fixture.state, &fixture.root);
    assert!(read(
        &fixture.state,
        &fixture.registry,
        &fixture.path().to_string_lossy(),
        &fixture.origin
    )
    .is_err());
    assert!(fixture
        .write(&snapshot.context, PATCHED)
        .unwrap_err()
        .contains("active vault changed"));
    fixture.assert_bytes(ORIGINAL);
    assert!(discard(&fixture.registry, &snapshot.context).unwrap());
    assert!(!discard(&fixture.registry, &snapshot.context).unwrap());
}

#[test]
fn forged_context_cannot_write_or_discard_another_snapshot() {
    let fixture = Fixture::new(true);
    let snapshot = fixture.read();
    for forged in [
        Context {
            path: fixture
                .root
                .join("cards/other.md")
                .to_string_lossy()
                .into_owned(),
            ..snapshot.context.clone()
        },
        Context {
            origin: AgentVaultSession {
                opening_token: "forged-opening".into(),
                ..fixture.origin.clone()
            },
            ..snapshot.context.clone()
        },
    ] {
        assert!(fixture.write(&forged, PATCHED).is_err());
        assert!(discard(&fixture.registry, &forged).is_err());
    }
    assert_eq!(fixture.registry.0.lock().unwrap().len(), 1);
    let mut dto = serde_json::to_value(&snapshot.context).unwrap();
    dto["roleSnapshot"] = serde_json::json!({"role":"study"});
    assert!(serde_json::from_value::<Context>(dto).is_err());
    fixture.assert_bytes(ORIGINAL);
}

#[test]
fn competing_snapshots_cannot_overwrite_first_persisted_change() {
    let fixture = Fixture::new(true);
    let first = fixture.read();
    let second = fixture.read();
    fixture.write(&first.context, PATCHED).unwrap();
    assert!(fixture.write(&second.context, HUMAN).is_err());
    fixture.assert_bytes(PATCHED);
    let fresh = fixture.read();
    assert_eq!(fresh.raw, PATCHED);
    fixture.write(&fresh.context, HUMAN).unwrap();
    fixture.assert_bytes(HUMAN);
}

#[test]
fn sticky_partial_never_runs_a_second_writer_or_mints_a_revision() {
    let fixture = Fixture::new(true);
    let snapshot = fixture.read();
    let attempts = AtomicUsize::new(0);
    let receipt = write_with(
        &fixture.state,
        &fixture.registry,
        &snapshot.context,
        PATCHED,
        || {},
        |_| {
            attempts.fetch_add(1, Ordering::SeqCst);
            Err("synthetic receipt failure".into())
        },
    )
    .unwrap();
    assert_eq!(receipt.state, MutationState::Partial);
    assert!(receipt.revision.is_none());
    assert!(receipt
        .error
        .as_deref()
        .unwrap()
        .starts_with("write persisted but "));
    fixture.assert_bytes(PATCHED);
    crate::vault::write_file(&fixture.path().to_string_lossy(), HUMAN).unwrap();
    let repeat = write_with(
        &fixture.state,
        &fixture.registry,
        &snapshot.context,
        PATCHED,
        || {},
        |_| {
            attempts.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(repeat.state, MutationState::Partial);
    assert_eq!(repeat.error, receipt.error);
    assert!(repeat.revision.is_none());
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
    fixture.assert_bytes(HUMAN);
    assert!(discard(&fixture.registry, &snapshot.context).unwrap());
}

#[test]
fn terminal_changed_content_is_refused_after_persisted_without_a_second_write() {
    let fixture = Fixture::new(true);
    let snapshot = fixture.read();
    let attempts = AtomicUsize::new(0);
    let first = write_with(
        &fixture.state,
        &fixture.registry,
        &snapshot.context,
        PATCHED,
        || {},
        |_| {
            attempts.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(first.state, MutationState::Persisted);
    let changed = write_with(
        &fixture.state,
        &fixture.registry,
        &snapshot.context,
        HUMAN,
        || {},
        |_| {
            attempts.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
    );
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
    fixture.assert_bytes(PATCHED);
    assert_eq!(
        fixture
            .registry
            .0
            .lock()
            .unwrap()
            .get(&snapshot.context.snapshot_id)
            .unwrap()
            .terminal
            .as_ref()
            .unwrap()
            .revision,
        first.revision
    );
    assert!(
        changed.is_err(),
        "a terminal receipt cannot acknowledge changed content: {changed:?}"
    );
}

#[test]
fn terminal_changed_content_is_refused_after_partial_without_a_second_write() {
    let fixture = Fixture::new(true);
    let snapshot = fixture.read();
    let attempts = AtomicUsize::new(0);
    let first = write_with(
        &fixture.state,
        &fixture.registry,
        &snapshot.context,
        PATCHED,
        || {},
        |_| {
            attempts.fetch_add(1, Ordering::SeqCst);
            Err("synthetic receipt failure".into())
        },
    )
    .unwrap();
    assert_eq!(first.state, MutationState::Partial);
    assert!(first.revision.is_none());
    crate::vault::write_file(&fixture.path().to_string_lossy(), HUMAN).unwrap();
    let changed = write_with(
        &fixture.state,
        &fixture.registry,
        &snapshot.context,
        "different second request",
        || {},
        |_| {
            attempts.fetch_add(1, Ordering::SeqCst);
            Ok(())
        },
    );
    assert_eq!(attempts.load(Ordering::SeqCst), 1);
    fixture.assert_bytes(HUMAN);
    let terminal = fixture
        .registry
        .0
        .lock()
        .unwrap()
        .get(&snapshot.context.snapshot_id)
        .unwrap()
        .terminal
        .as_ref()
        .unwrap()
        .clone();
    assert_eq!(terminal.error, first.error);
    assert!(terminal.revision.is_none());
    assert!(
        changed.is_err(),
        "Partial history cannot acknowledge changed content: {changed:?}"
    );
}

#[test]
fn repeated_persisted_receipt_refuses_target_replacement() {
    let fixture = Fixture::new(true);
    let snapshot = fixture.read();
    fixture.write(&snapshot.context, PATCHED).unwrap();
    std::fs::rename(fixture.path(), fixture.root.join("old-published.md")).unwrap();
    std::fs::write(fixture.path(), PATCHED).unwrap();
    assert!(fixture.write(&snapshot.context, PATCHED).is_err());
    fixture.assert_bytes(PATCHED);
}

#[test]
fn parent_replacement_after_persist_is_partial_without_confirmed_revision() {
    let fixture = Fixture::new(true);
    let snapshot = fixture.read();
    let held = fixture.root.join("moved-after-write");
    let receipt = write_with(
        &fixture.state,
        &fixture.registry,
        &snapshot.context,
        PATCHED,
        || {},
        |_| {
            std::fs::rename(fixture.root.join("cards"), &held).unwrap();
            std::fs::create_dir(fixture.root.join("cards")).unwrap();
            std::fs::write(fixture.path(), HUMAN).unwrap();
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(receipt.state, MutationState::Partial);
    assert!(receipt.revision.is_none());
    assert!(receipt.error.unwrap().starts_with("write persisted but "));
    fixture.assert_bytes(HUMAN);
    assert_eq!(
        std::fs::read_to_string(held.join("deck.md")).unwrap(),
        PATCHED
    );
}

#[test]
fn snapshot_capacity_is_bounded_and_discard_releases_a_slot() {
    let fixture = Fixture::new(true);
    let snapshots: Vec<_> = (0..MAX_SNAPSHOTS).map(|_| fixture.read()).collect();
    assert!(read(
        &fixture.state,
        &fixture.registry,
        &fixture.path().to_string_lossy(),
        &fixture.origin
    )
    .unwrap_err()
    .contains("capacity"));
    assert!(discard(&fixture.registry, &snapshots[0].context).unwrap());
    fixture.read();
    assert_eq!(fixture.registry.0.lock().unwrap().len(), MAX_SNAPSHOTS);
}

#[test]
fn exact_input_and_output_byte_limits_preserve_the_original_on_overflow() {
    let fixture = Fixture::new(true);
    let bytes = "x".repeat(MAX_BYTES);
    std::fs::write(fixture.path(), &bytes).unwrap();
    let snapshot = fixture.read();
    assert_eq!(snapshot.raw.len(), MAX_BYTES);
    assert!(fixture
        .write(&snapshot.context, &"x".repeat(MAX_BYTES + 1))
        .is_err());
    fixture.assert_bytes(&bytes);
    fixture.write(&snapshot.context, PATCHED).unwrap();
}

#[test]
fn actual_editor_writer_wins_before_study_cas_without_lost_bytes() {
    let fixture = Fixture::new(true);
    let snapshot = fixture.read();
    let editor = Arc::new(VaultRoot::default());
    open(&editor, &fixture.root);
    let editor_origin = editor.snapshot().unwrap();
    let path = fixture.path().to_string_lossy().into_owned();
    let (editor_holds, editor_observed) = mpsc::channel();
    let (release_editor, editor_release) = mpsc::channel();
    let editor_thread = std::thread::spawn(move || {
        crate::editor_io::write_impl(
            &editor,
            &path,
            HUMAN,
            &sources::digest(ORIGINAL),
            &editor_origin,
            || {},
            |_| {
                editor_holds.send(()).unwrap();
                editor_release.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok(())
            },
        )
    });
    editor_observed
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    let (study_waits, study_observed) = mpsc::channel();
    let state = fixture.state.clone();
    let registry = fixture.registry.clone();
    let study_thread = std::thread::spawn(move || {
        write_with(
            &state,
            &registry,
            &snapshot.context,
            PATCHED,
            || study_waits.send(()).unwrap(),
            |_| Ok(()),
        )
    });
    study_observed.recv_timeout(Duration::from_secs(5)).unwrap();
    release_editor.send(()).unwrap();
    assert!(editor_thread.join().unwrap().is_ok());
    assert!(study_thread.join().unwrap().is_err());
    fixture.assert_bytes(HUMAN);
}

#[test]
fn actual_study_writer_wins_and_editor_cas_refuses_its_old_baseline() {
    let fixture = Fixture::new(true);
    let snapshot = fixture.read();
    let state = fixture.state.clone();
    let registry = fixture.registry.clone();
    let (study_holds, study_observed) = mpsc::channel();
    let (release_study, study_release) = mpsc::channel();
    let study_thread = std::thread::spawn(move || {
        write_with(
            &state,
            &registry,
            &snapshot.context,
            PATCHED,
            || {},
            |_| {
                study_holds.send(()).unwrap();
                study_release.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok(())
            },
        )
    });
    study_observed.recv_timeout(Duration::from_secs(5)).unwrap();
    let editor = Arc::new(VaultRoot::default());
    open(&editor, &fixture.root);
    let origin = editor.snapshot().unwrap();
    let path = fixture.path().to_string_lossy().into_owned();
    let (editor_waits, editor_observed) = mpsc::channel();
    let editor_thread = std::thread::spawn(move || {
        crate::editor_io::write_impl(
            &editor,
            &path,
            HUMAN,
            &sources::digest(ORIGINAL),
            &origin,
            || editor_waits.send(()).unwrap(),
            |_| Ok(()),
        )
    });
    editor_observed
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    release_study.send(()).unwrap();
    assert_eq!(
        study_thread.join().unwrap().unwrap().state,
        MutationState::Persisted
    );
    assert!(editor_thread.join().unwrap().is_err());
    fixture.assert_bytes(PATCHED);
}
