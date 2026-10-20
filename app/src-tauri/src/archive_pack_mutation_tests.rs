//! Proposed native helper regressions: actual cooperating writes, no models.
//! Run serially; the global writer try-lock is not a parallel-test attribution.

use super::*;
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

const ORIGINAL: &str = "Synthetic archived original.\n";
const NEWER: &str = "A newer synthetic human edit; preserve this.\n";
const BUCKET: &str = "sessions/archive/2026-01";
const NOW: i64 = 1_787_184_000;

fn receive<T>(receiver: &Receiver<T>) -> T {
    receiver
        .recv_timeout(Duration::from_secs(10))
        .expect("synthetic archive worker did not reach its checkpoint")
}

struct ClearHook;
impl Drop for ClearHook {
    fn drop(&mut self) {
        MUTATION_HOOK.with(|hook| *hook.borrow_mut() = None);
    }
}
fn install(hook: impl Fn(MutationCheckpoint) -> Result<(), String> + 'static) -> ClearHook {
    MUTATION_HOOK.with(|stored| *stored.borrow_mut() = Some(Box::new(hook)));
    ClearHook
}
fn fixture(files: &[(&str, &str)]) -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    std::fs::create_dir_all(root.join(BUCKET)).unwrap();
    for (name, body) in files {
        std::fs::write(root.join(BUCKET).join(name), body).unwrap();
    }
    std::fs::create_dir(root.join("raw")).unwrap();
    std::fs::write(root.join("raw/sentinel.md"), "Immutable synthetic raw.\n").unwrap();
    (directory, root)
}
fn archive_body(root: &Path, name: &str) -> String {
    let mut archive =
        zip::ZipArchive::new(std::fs::File::open(root.join(format!("{BUCKET}.zip"))).unwrap())
            .unwrap();
    let mut entry = archive.by_name(name).unwrap();
    let mut bytes = String::new();
    entry.read_to_string(&mut bytes).unwrap();
    bytes
}
fn raw_unchanged(root: &Path) {
    assert_eq!(
        std::fs::read_to_string(root.join("raw/sentinel.md")).unwrap(),
        "Immutable synthetic raw.\n"
    );
}

#[test]
fn pack_serializes_final_verification_and_unlink_against_cooperating_create_write() {
    let (_directory, root) = fixture(&[("a.md", ORIGINAL)]);
    let (reached, at_delete) = mpsc::channel();
    let (release, continue_pack) = mpsc::channel();
    let archive_root = root.clone();
    let packer = std::thread::spawn(move || {
        let _hook = install(move |phase| {
            if phase == MutationCheckpoint::PackVerified {
                reached
                    .send(crate::vault::try_lock_file_mutation()?.is_none())
                    .unwrap();
                receive(&continue_pack);
            }
            Ok(())
        });
        compress(&archive_root, 3, NOW)
    });
    let is_locked = receive(&at_delete);
    let (started, ready) = mpsc::channel();
    let (finished, written) = mpsc::channel();
    let editor_root = root.clone();
    let writer = std::thread::spawn(move || {
        started.send(()).unwrap();
        let outcome = (|| {
            // Packing removes an empty bucket. This explicit app creation is
            // a new-note operation, not a stale editor CAS retry or raw mkdir.
            match crate::vault::create_folder_checked_at(
                &editor_root,
                &editor_root.join("sessions/archive").to_string_lossy(),
                "2026-01",
            ) {
                Ok(_) => {}
                Err(error) if error.starts_with("already exists:") => {}
                Err(error) => return Err(error),
            }
            crate::vault::write_file(
                &editor_root.join(BUCKET).join("a.md").to_string_lossy(),
                NEWER,
            )
        })();
        finished.send(outcome).unwrap();
    });
    receive(&ready);
    // On the baseline, the write completes before the destructive unlink.
    // On the candidate, same-lock try-lock proves exclusion without sleeps.
    let early = (!is_locked).then(|| receive(&written));
    release.send(()).unwrap();
    let result = packer.join().unwrap();
    early.unwrap_or_else(|| receive(&written)).unwrap();
    writer.join().unwrap();
    assert_eq!(result.buckets, 1, "{:?}", result.failed);
    assert_eq!(
        std::fs::read_to_string(root.join(BUCKET).join("a.md")).map_err(|error| error.kind()),
        Ok(NEWER.into())
    );
    assert!(
        is_locked,
        "pack verified and deleted originals without the cooperating writer"
    );
    assert_eq!(archive_body(&root, "a.md"), ORIGINAL);
    raw_unchanged(&root);
}

#[test]
fn pack_rechecks_source_after_preparation_instead_of_deleting_a_newer_write() {
    let (_directory, root) = fixture(&[("a.md", ORIGINAL)]);
    let edit = root.join(BUCKET).join("a.md");
    let _hook = install(move |phase| {
        if phase == MutationCheckpoint::PackPrepared {
            // Preparation must be outside the writer: use its actual API.
            assert!(crate::vault::try_lock_file_mutation()?.is_some());
            crate::vault::write_file(&edit.to_string_lossy(), NEWER)?;
        }
        Ok(())
    });
    let result = compress(&root, 3, NOW);
    assert_eq!(
        std::fs::read_to_string(root.join(BUCKET).join("a.md")).map_err(|error| error.kind()),
        Ok(NEWER.into())
    );
    assert_eq!(
        result.buckets, 0,
        "changed source must not be called packed"
    );
    assert_eq!(result.failed.len(), 1, "{result:?}");
    assert!(!root.join(format!("{BUCKET}.zip")).exists());
    assert!(!root.join(format!("{BUCKET}.zip.part")).exists());
    raw_unchanged(&root);
}

#[test]
fn restore_serializes_absence_check_and_persist_against_a_cooperating_write() {
    let (_directory, root) = fixture(&[("a.md", ORIGINAL)]);
    assert_eq!(compress(&root, 3, NOW).buckets, 1);
    let (reached, at_write) = mpsc::channel();
    let (release, continue_write) = mpsc::channel();
    let (finalizing, at_finalize) = mpsc::channel();
    let (finish, continue_finalize) = mpsc::channel();
    let restore_root = root.clone();
    let restorer = std::thread::spawn(move || {
        let _hook = install(move |phase| {
            if phase == MutationCheckpoint::RestoreWrite {
                reached
                    .send(crate::vault::try_lock_file_mutation()?.is_none())
                    .unwrap();
                receive(&continue_write);
            } else if phase == MutationCheckpoint::RestoreFinalize {
                // Finalization checkpoint remains before its own writer lock;
                // this ensures the legitimate later edit precedes revalidation.
                finalizing.send(()).unwrap();
                receive(&continue_finalize);
            }
            Ok(())
        });
        restore(&restore_root, "sessions", "2026-01")
    });
    let is_locked = receive(&at_write);
    let (started, ready) = mpsc::channel();
    let (finished, written) = mpsc::channel();
    let edited = root.join(BUCKET).join("a.md");
    let writer = std::thread::spawn(move || {
        started.send(()).unwrap();
        finished
            .send(crate::vault::write_file(&edited.to_string_lossy(), NEWER))
            .unwrap();
    });
    receive(&ready);
    let early = (!is_locked).then(|| receive(&written));
    release.send(()).unwrap();
    receive(&at_finalize);
    early.unwrap_or_else(|| receive(&written)).unwrap();
    finish.send(()).unwrap();
    let result = restorer.join().unwrap();
    writer.join().unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join(BUCKET).join("a.md")).unwrap(),
        NEWER
    );
    assert!(is_locked, "restore absence and actual write were unguarded");
    assert!(
        result.is_err(),
        "a later edit requires preserved archive and honest conflict"
    );
    assert_eq!(archive_body(&root, "a.md"), ORIGINAL);
    raw_unchanged(&root);
}

#[test]
fn partial_pack_unlink_preserves_complete_archive_and_can_resume_remaining_originals() {
    let (_directory, root) =
        fixture(&[("a.md", ORIGINAL), ("b.md", "Second synthetic original.\n")]);
    {
        let _hook = install(|phase| {
            if phase == MutationCheckpoint::PackBeforeDelete(1) {
                Err("injected later unlink failure".into())
            } else {
                Ok(())
            }
        });
        let result = compress(&root, 3, NOW);
        assert_eq!(result.buckets, 0);
        assert_eq!(result.failed.len(), 1, "{result:?}");
        assert_eq!(archive_body(&root, "a.md"), ORIGINAL);
        assert_eq!(archive_body(&root, "b.md"), "Second synthetic original.\n");
        assert!(!root.join(BUCKET).join("a.md").exists());
        assert_eq!(
            std::fs::read_to_string(root.join(BUCKET).join("b.md")).unwrap(),
            "Second synthetic original.\n"
        );
    }
    let retry = compress(&root, 3, NOW);
    assert_eq!(
        retry.buckets, 1,
        "exact remaining originals should resume: {:?}",
        retry.failed
    );
    assert!(!root.join(BUCKET).exists());
    let restored = restore(&root, "sessions", "2026-01").unwrap();
    assert_eq!(restored.files, 2);
    assert_eq!(
        std::fs::read_to_string(root.join(BUCKET).join("a.md")).unwrap(),
        ORIGINAL
    );
    assert_eq!(
        std::fs::read_to_string(root.join(BUCKET).join("b.md")).unwrap(),
        "Second synthetic original.\n"
    );
    raw_unchanged(&root);
}
