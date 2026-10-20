//! Synthetic mutation regressions exercise the actual public and checked
//! helpers. Per-call callbacks and lock inspection avoid timing-based races.

use super::{
    archive_inbox_source_checked_at, archive_inbox_source_checked_impl,
    archive_inbox_source_checked_with_at, move_path, move_path_checked_at, rename_path,
    rename_path_checked_at, try_lock_file_mutation, with_root_mutation_impl, write_file,
};
use sha2::{Digest, Sha256};
use std::path::Path;

const SOURCE: &str = "Original synthetic source.\n";
const UPDATED: &str = "Updated synthetic source.\n";

fn write(root: &Path, rel: &str, content: &str) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

fn hash(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

#[cfg(unix)]
#[test]
fn rename_refuses_dangling_destination_and_preserves_source_and_link() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "source.md", SOURCE);
    let source = root.join("source.md");
    let destination = root.join("occupied.md");
    let missing = root.join("missing.md");
    symlink(&missing, &destination).unwrap();
    assert!(
        !destination.exists(),
        "the collision must be a dangling link"
    );
    let result = rename_path(&source.to_string_lossy(), "occupied.md");
    assert!(
        result.is_err(),
        "rename overwrote a dangling destination: {result:?}"
    );
    assert_eq!(std::fs::read_to_string(source).unwrap(), SOURCE);
    assert_eq!(std::fs::read_link(destination).unwrap(), missing);
}

#[cfg(unix)]
#[test]
fn move_refuses_dangling_destination_and_preserves_source_and_link() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "source.md", SOURCE);
    std::fs::create_dir_all(root.join("notes")).unwrap();
    let source = root.join("source.md");
    let destination = root.join("notes/source.md");
    let missing = root.join("missing.md");
    symlink(&missing, &destination).unwrap();
    assert!(
        !destination.exists(),
        "the collision must be a dangling link"
    );
    let result = move_path(
        &source.to_string_lossy(),
        &root.join("notes").to_string_lossy(),
    );
    assert!(
        result.is_err(),
        "move overwrote a dangling destination: {result:?}"
    );
    assert_eq!(std::fs::read_to_string(source).unwrap(), SOURCE);
    assert_eq!(std::fs::read_link(destination).unwrap(), missing);
}

#[cfg(unix)]
#[test]
fn checked_archive_suffix_skips_dangling_destination_and_preserves_link() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "_inbox/source.md", SOURCE);
    std::fs::create_dir_all(root.join("_inbox/.archived")).unwrap();
    let source = root.join("_inbox/source.md");
    let destination = root.join("_inbox/.archived/source.md");
    let missing = root.join("missing.md");
    symlink(&missing, &destination).unwrap();
    assert!(
        !destination.exists(),
        "the collision must be a dangling link"
    );
    let archived =
        archive_inbox_source_checked_at(root, &source.to_string_lossy(), Some(&hash(SOURCE)))
            .unwrap();
    assert_eq!(Path::new(&archived).file_name().unwrap(), "source-2.md");
    assert_eq!(std::fs::read_to_string(archived).unwrap(), SOURCE);
    assert_eq!(std::fs::read_link(destination).unwrap(), missing);
    assert!(!source.exists());
}

#[test]
fn checked_archive_excludes_normal_writer_between_sha_recheck_and_move() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "_inbox/source.md", SOURCE);
    let source = root.join("_inbox/source.md");
    let mut writer = None;
    let archived = archive_inbox_source_checked_impl(
        root,
        &source.to_string_lossy(),
        Some(&hash(SOURCE)),
        || Ok(()),
        || {
            assert!(try_lock_file_mutation().unwrap().is_none());
            let source = source.clone();
            let (started, received) = std::sync::mpsc::channel();
            writer = Some(std::thread::spawn(move || {
                started.send(()).unwrap();
                write_file(&source.to_string_lossy(), UPDATED)
            }));
            // This confirms that the normal writer thread has started. The
            // held FILE mutex proves exclusion independently of scheduling.
            received.recv().unwrap();
        },
    )
    .unwrap();
    writer.unwrap().join().unwrap().unwrap();
    assert_eq!(std::fs::read_to_string(&archived).unwrap(), SOURCE);
    assert_eq!(std::fs::read_to_string(source).unwrap(), UPDATED);
}

#[test]
fn completion_validator_runs_under_writer_guard_and_refuses_before_archive() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "_inbox/source.md", SOURCE);
    let source = root.join("_inbox/source.md");
    let result = archive_inbox_source_checked_with_at(
        root,
        &source.to_string_lossy(),
        &hash(SOURCE),
        || {
            assert!(try_lock_file_mutation().unwrap().is_none());
            Err("native publication was replaced".into())
        },
    );
    assert_eq!(result.unwrap_err(), "native publication was replaced");
    assert_eq!(std::fs::read_to_string(source).unwrap(), SOURCE);
    assert!(!root.join("_inbox/.archived").exists());
}

#[test]
fn checked_rename_then_move_accepts_tempdir_root_and_preserves_source_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "notes/source.md", SOURCE);
    write(root, "raw/immutable.md", UPDATED);
    std::fs::create_dir_all(root.join("destination")).unwrap();
    let source = root.join("notes/source.md");
    let renamed = rename_path_checked_at(root, &source.to_string_lossy(), "renamed.md").unwrap();
    assert_eq!(
        Path::new(&renamed),
        root.canonicalize().unwrap().join("notes/renamed.md")
    );
    assert_eq!(std::fs::read_to_string(&renamed).unwrap(), SOURCE);
    assert!(!source.exists());
    let moved =
        move_path_checked_at(root, &renamed, &root.join("destination").to_string_lossy()).unwrap();
    assert_eq!(
        Path::new(&moved),
        root.canonicalize().unwrap().join("destination/renamed.md")
    );
    assert_eq!(std::fs::read_to_string(moved).unwrap(), SOURCE);
    assert!(!Path::new(&renamed).exists());
    assert_eq!(
        std::fs::read_to_string(root.join("raw/immutable.md")).unwrap(),
        UPDATED
    );
}

#[cfg(unix)]
#[test]
fn root_mutation_refuses_same_path_directory_replacement_before_lock() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("captured");
    let moved = dir.path().join("original");
    let outside = dir.path().join("outside");
    write(&root, "sentinel.md", SOURCE);
    write(&outside, "sentinel.md", "Outside synthetic sentinel.\n");
    let ran = std::cell::Cell::new(false);
    let result = with_root_mutation_impl(
        &root,
        |_, _| {
            ran.set(true);
            Ok(())
        },
        || {
            std::fs::rename(&root, &moved).unwrap();
            write(&root, "sentinel.md", UPDATED);
        },
    );
    let error = result.unwrap_err();
    assert!(error.contains("identity changed"), "{error}");
    assert!(!ran.get(), "the mutation callback must never run");
    assert_eq!(
        std::fs::read_to_string(moved.join("sentinel.md")).unwrap(),
        SOURCE
    );
    assert_eq!(
        std::fs::read_to_string(root.join("sentinel.md")).unwrap(),
        UPDATED
    );
    assert_eq!(
        std::fs::read_to_string(outside.join("sentinel.md")).unwrap(),
        "Outside synthetic sentinel.\n"
    );
}

#[cfg(unix)]
#[test]
fn root_mutation_refuses_replacement_with_outside_symlink_before_lock() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("captured");
    let moved = dir.path().join("original");
    let outside = dir.path().join("outside");
    write(&root, "sentinel.md", SOURCE);
    write(&outside, "sentinel.md", UPDATED);
    let ran = std::cell::Cell::new(false);
    let result = with_root_mutation_impl(
        &root,
        |_, _| {
            ran.set(true);
            Ok(())
        },
        || {
            std::fs::rename(&root, &moved).unwrap();
            symlink(&outside, &root).unwrap();
        },
    );
    let error = result.unwrap_err();
    assert!(error.contains("not a real directory"), "{error}");
    assert!(!ran.get(), "the mutation callback must never run");
    assert_eq!(std::fs::read_link(root).unwrap(), outside);
    assert_eq!(
        std::fs::read_to_string(moved.join("sentinel.md")).unwrap(),
        SOURCE
    );
    assert_eq!(
        std::fs::read_to_string(outside.join("sentinel.md")).unwrap(),
        UPDATED
    );
}

#[test]
fn checked_mutations_refuse_raw_sources_and_move_destination_without_changes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "raw/source.md", SOURCE);
    write(root, "notes/note.md", UPDATED);
    let original = root.join("raw/source.md");
    let note = root.join("notes/note.md");
    assert!(rename_path_checked_at(root, &original.to_string_lossy(), "renamed.md").is_err());
    assert!(move_path_checked_at(
        root,
        &original.to_string_lossy(),
        &root.join("notes").to_string_lossy(),
    )
    .is_err());
    assert!(move_path_checked_at(
        root,
        &note.to_string_lossy(),
        &root.join("raw").to_string_lossy(),
    )
    .is_err());
    assert!(archive_inbox_source_checked_at(root, &original.to_string_lossy(), None).is_err());
    assert_eq!(std::fs::read_to_string(original).unwrap(), SOURCE);
    assert_eq!(std::fs::read_to_string(note).unwrap(), UPDATED);
    assert!(!root.join("raw/renamed.md").exists());
    assert!(!root.join("raw/note.md").exists());
    assert!(!root.join("notes/source.md").exists());
    assert!(!root.join("raw/.archived").exists());
}

#[test]
fn checked_mutations_refuse_outside_source_or_destination_without_changes() {
    let dir = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "notes/note.md", SOURCE);
    write(other.path(), "outside.md", UPDATED);
    let note = root.join("notes/note.md");
    let outside = other.path().join("outside.md");
    assert!(rename_path_checked_at(root, &outside.to_string_lossy(), "renamed.md").is_err());
    assert!(move_path_checked_at(
        root,
        &note.to_string_lossy(),
        &other.path().to_string_lossy()
    )
    .is_err());
    assert!(archive_inbox_source_checked_at(root, &outside.to_string_lossy(), None).is_err());
    assert_eq!(std::fs::read_to_string(note).unwrap(), SOURCE);
    assert_eq!(std::fs::read_to_string(outside).unwrap(), UPDATED);
    assert!(!other.path().join("renamed.md").exists());
    assert!(!other.path().join("note.md").exists());
    assert!(!other.path().join(".archived").exists());
}

#[cfg(unix)]
#[test]
fn checked_mutations_refuse_source_alias_without_touching_its_target() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(other.path(), "target.md", SOURCE);
    std::fs::create_dir_all(root.join("_inbox")).unwrap();
    std::fs::create_dir_all(root.join("notes")).unwrap();
    let target = other.path().join("target.md");
    let source = root.join("_inbox/alias.md");
    symlink(&target, &source).unwrap();
    assert!(rename_path_checked_at(root, &source.to_string_lossy(), "renamed.md").is_err());
    assert!(move_path_checked_at(
        root,
        &source.to_string_lossy(),
        &root.join("notes").to_string_lossy()
    )
    .is_err());
    assert!(archive_inbox_source_checked_at(root, &source.to_string_lossy(), None).is_err());
    assert_eq!(std::fs::read_link(source).unwrap(), target);
    assert_eq!(std::fs::read_to_string(target).unwrap(), SOURCE);
    assert!(!root.join("_inbox/renamed.md").exists());
    assert!(!root.join("notes/alias.md").exists());
    assert!(!root.join("_inbox/.archived").exists());
}

#[cfg(unix)]
#[test]
fn checked_mutations_refuse_destination_directory_alias_without_changes() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let other = tempfile::tempdir().unwrap();
    let root = dir.path();
    write(root, "_inbox/source.md", SOURCE);
    let source = root.join("_inbox/source.md");
    let destination = root.join("linked-notes");
    symlink(other.path(), &destination).unwrap();
    assert!(move_path_checked_at(
        root,
        &source.to_string_lossy(),
        &destination.to_string_lossy()
    )
    .is_err());
    symlink(other.path(), root.join("_inbox/.archived")).unwrap();
    assert!(archive_inbox_source_checked_at(root, &source.to_string_lossy(), None).is_err());
    assert_eq!(std::fs::read_to_string(source).unwrap(), SOURCE);
    assert_eq!(std::fs::read_link(destination).unwrap(), other.path());
    assert_eq!(
        std::fs::read_link(root.join("_inbox/.archived")).unwrap(),
        other.path()
    );
    assert!(std::fs::read_dir(other.path()).unwrap().next().is_none());
}

#[cfg(unix)]
fn start_checked_creation(
    root: std::path::PathBuf,
    parent: std::path::PathBuf,
    is_folder: bool,
    entered: std::sync::mpsc::Sender<()>,
) -> std::thread::JoinHandle<Result<String, String>> {
    std::thread::spawn(move || {
        let before_lock = || entered.send(()).unwrap();
        if is_folder {
            super::create_folder_checked_at_impl(
                &root,
                &parent.to_string_lossy(),
                "new-folder",
                before_lock,
            )
        } else {
            super::create_file_checked_at_impl(
                &root,
                &parent.to_string_lossy(),
                "new.md",
                UPDATED,
                before_lock,
            )
        }
    })
}

#[cfg(unix)]
#[test]
fn checked_creation_refuses_root_identity_replacement_while_waiting_for_writer() {
    for is_folder in [false, true] {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("captured");
        let original = directory.path().join("original");
        write(&root, "sentinel.md", SOURCE);
        let (entered, reached) = std::sync::mpsc::channel();
        let guard = super::lock_file_mutation().unwrap();
        let worker = start_checked_creation(root.clone(), root.join("wiki"), is_folder, entered);
        let reached = reached.recv_timeout(std::time::Duration::from_secs(5));
        let replacement = if reached.is_ok() {
            std::fs::rename(&root, &original)
                .and_then(|_| std::fs::create_dir(&root))
                .and_then(|_| std::fs::write(root.join("sentinel.md"), UPDATED))
        } else {
            Ok(())
        };
        // Release before assertions so a failed test cannot poison FILE or
        // strand its specifically owned worker.
        drop(guard);
        let result = worker.join().unwrap();
        reached.unwrap();
        replacement.unwrap();
        let error = result.unwrap_err();
        assert!(error.contains("identity changed"), "{error}");
        assert_eq!(
            std::fs::read_to_string(original.join("sentinel.md")).unwrap(),
            SOURCE
        );
        assert_eq!(
            std::fs::read_to_string(root.join("sentinel.md")).unwrap(),
            UPDATED
        );
        assert!(!root.join("wiki").exists());
        assert!(!original.join("wiki").exists());
    }
}

#[cfg(unix)]
#[test]
fn checked_creation_rechecks_parent_alias_while_waiting_for_writer() {
    use std::os::unix::fs::symlink;
    for is_folder in [false, true] {
        for is_raw_target in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let outside = tempfile::tempdir().unwrap();
            let root = directory.path().canonicalize().unwrap();
            write(&root, "wiki/sentinel.md", SOURCE);
            write(&root, "raw/original.md", SOURCE);
            write(outside.path(), "sentinel.md", UPDATED);
            let parent = root.join("wiki");
            let saved = root.join("saved-wiki");
            let alias_target = if is_raw_target {
                root.join("raw")
            } else {
                outside.path().to_path_buf()
            };
            let (entered, reached) = std::sync::mpsc::channel();
            let guard = super::lock_file_mutation().unwrap();
            let worker = start_checked_creation(
                root.clone(),
                parent.join("missing/deeper"),
                is_folder,
                entered,
            );
            let reached = reached.recv_timeout(std::time::Duration::from_secs(5));
            let replacement = if reached.is_ok() {
                std::fs::rename(&parent, &saved).and_then(|_| symlink(&alias_target, &parent))
            } else {
                Ok(())
            };
            drop(guard);
            let result = worker.join().unwrap();
            reached.unwrap();
            replacement.unwrap();
            let error = result.unwrap_err();
            assert!(error.contains("symbolic link"), "{error}");
            assert_eq!(std::fs::read_link(&parent).unwrap(), alias_target);
            assert!(!alias_target.join("missing").exists());
            assert_eq!(
                std::fs::read_to_string(saved.join("sentinel.md")).unwrap(),
                SOURCE
            );
            assert_eq!(
                std::fs::read_to_string(root.join("raw/original.md")).unwrap(),
                SOURCE
            );
            assert_eq!(
                std::fs::read_to_string(outside.path().join("sentinel.md")).unwrap(),
                UPDATED
            );
        }
    }
}
