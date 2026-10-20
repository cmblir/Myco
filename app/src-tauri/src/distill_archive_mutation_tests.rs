use super::*;
use std::sync::mpsc::{self, Receiver};
use std::time::Duration;

fn receive<T>(receiver: &Receiver<T>) -> T {
    receiver
        .recv_timeout(Duration::from_secs(10))
        .expect("synthetic mutation worker did not reach its checkpoint")
}

fn planned_source(root: &Path, original: &str) -> ArchivePlan {
    let from = "sessions/source.md";
    let to = "sessions/archive/2026-08/source.md";
    std::fs::create_dir_all(root.join(to).parent().unwrap()).unwrap();
    crate::vault::write_file(&root.join(from).to_string_lossy(), original).unwrap();
    ArchivePlan {
        from: from.into(),
        to: to.into(),
        fingerprint: content_fingerprint(original.as_bytes()),
        revision: sha(original.as_bytes()),
    }
}

#[test]
fn journal_move_serializes_final_unlink_against_normal_writer() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    let plan = planned_source(&root, "original conversation");
    let (at_unlink, unlink_ready) = mpsc::channel();
    let (continue_move, move_release) = mpsc::channel();
    let (move_finished, move_result) = mpsc::channel();
    let move_root = root.clone();
    let move_plan = plan.clone();
    let mover = std::thread::spawn(move || {
        let outcome = move_planned(&move_root, &move_plan, |phase| {
            if phase == MoveCheckpoint::Unlink {
                let is_locked = crate::vault::try_lock_file_mutation().unwrap().is_none();
                at_unlink.send(is_locked).unwrap();
                receive(&move_release);
            }
        });
        move_finished.send(outcome).unwrap();
    });
    let is_locked = receive(&unlink_ready);
    let (writer_started, writer_ready) = mpsc::channel();
    let (write_finished, write_result) = mpsc::channel();
    let write_path = root.join(&plan.from);
    let writer = std::thread::spawn(move || {
        writer_started.send(()).unwrap();
        write_finished
            .send(crate::vault::write_file(
                &write_path.to_string_lossy(),
                "new conversation from the normal writer",
            ))
            .unwrap();
    });
    receive(&writer_ready);
    // The same-lock try-lock proves exclusion, not the writer's start signal.
    // On the unguarded baseline, finish the replacement before unlink to retain
    // a deterministic reproduction of the lost update without sleeps.
    let early_write = (!is_locked).then(|| receive(&write_result));
    continue_move.send(()).unwrap();
    let moved = receive(&move_result);
    let written = early_write.unwrap_or_else(|| receive(&write_result));
    mover.join().unwrap();
    writer.join().unwrap();
    moved.unwrap();
    written.unwrap();
    assert_eq!(
        std::fs::read_to_string(root.join(&plan.from)).map_err(|error| error.kind()),
        Ok("new conversation from the normal writer".into())
    );
    assert!(
        is_locked,
        "final source verification and unlink were unguarded"
    );
    assert_eq!(
        std::fs::read_to_string(root.join(&plan.to)).unwrap(),
        "original conversation"
    );
}

#[test]
fn journal_move_rechecks_source_revision_after_waiting_for_writer() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    let plan = planned_source(&root, "admitted conversation");
    let preceding_writer = crate::vault::lock_file_mutation().unwrap();
    let (at_lock, lock_ready) = mpsc::channel();
    let (continue_move, move_release) = mpsc::channel();
    let (move_finished, move_result) = mpsc::channel();
    let move_root = root.clone();
    let move_plan = plan.clone();
    let mover = std::thread::spawn(move || {
        let outcome = move_planned(&move_root, &move_plan, |phase| {
            if phase == MoveCheckpoint::WriterLock {
                at_lock.send(()).unwrap();
                receive(&move_release);
            }
        });
        move_finished.send(outcome).unwrap();
    });
    receive(&lock_ready);
    // This is the preceding cooperating writer's critical section. Calling
    // write_file while owning its mutex would incorrectly reacquire that mutex.
    std::fs::write(root.join(&plan.from), "changed before archive admission").unwrap();
    continue_move.send(()).unwrap();
    drop(preceding_writer);
    let outcome = receive(&move_result);
    mover.join().unwrap();
    assert_eq!(outcome.unwrap_err(), "source revision changed");
    assert_eq!(
        std::fs::read_to_string(root.join(&plan.from)).unwrap(),
        "changed before archive admission"
    );
    assert!(!root.join(&plan.to).exists());
}

#[test]
fn journal_move_never_overwrites_a_competing_destination() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    let plan = planned_source(&root, "original conversation");
    let destination = root.join(&plan.to);
    let outcome = move_planned(&root, &plan, |phase| {
        if phase == MoveCheckpoint::Link {
            // A non-cooperating synthetic edit exercises hard_link's no-clobber
            // property; the shared mutex does not cover external filesystem edits.
            std::fs::write(&destination, "competing destination").unwrap();
        }
    });
    assert!(outcome
        .unwrap_err()
        .starts_with("create non-overwriting archive link:"));
    assert_eq!(
        std::fs::read_to_string(root.join(&plan.from)).unwrap(),
        "original conversation"
    );
    assert_eq!(
        std::fs::read_to_string(destination).unwrap(),
        "competing destination"
    );
}

#[test]
fn journal_move_preserves_a_same_bytes_distinct_destination() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    let plan = planned_source(&root, "original conversation");
    crate::vault::write_file(
        &root.join(&plan.to).to_string_lossy(),
        "original conversation",
    )
    .unwrap();
    let outcome = move_planned(&root, &plan, |_| {});
    #[cfg(unix)]
    assert_eq!(
        outcome.unwrap_err(),
        "source and archive are distinct files; manual recovery required"
    );
    #[cfg(not(unix))]
    assert_eq!(
        outcome.unwrap_err(),
        "two-name archive recovery requires file identity support"
    );
    for path in [&plan.from, &plan.to] {
        assert_eq!(
            std::fs::read_to_string(root.join(path)).unwrap(),
            "original conversation"
        );
    }
}

#[test]
fn journal_archive_persists_completion_without_reentering_writer_lock() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    let plan = planned_source(&root, "original conversation");
    let (archive_finished, archive_result) = mpsc::channel();
    let archive_root = root.clone();
    let from = plan.from.clone();
    let fingerprint = plan.fingerprint.clone();
    let worker = std::thread::spawn(move || {
        let context = ArchiveContext {
            manifest_id: "llm-802".into(),
            publications: Vec::new(),
        };
        archive_finished
            .send(archive_digested_sessions_with_context(
                &archive_root,
                "2026-08-10",
                &[from],
                Some(&[fingerprint]),
                Some(&context),
            ))
            .unwrap();
    });
    let receipt = receive(&archive_result).unwrap();
    worker.join().unwrap();
    assert_eq!(receipt.moved.len(), 1);
    assert!(receipt.pending.is_empty());
    assert!(!receipt.retryable);
    let (manifest, _) = load(&root, "llm-802").unwrap();
    assert_eq!(manifest.moves.len(), 1);
    assert_eq!(manifest.moves[0].from, plan.from);
    assert_eq!(manifest.moves[0].to, plan.to);
    assert_eq!(manifest.move_revisions.get(&plan.to), Some(&plan.revision));
    assert!(!root.join(&plan.from).exists());
    assert_eq!(
        std::fs::read_to_string(root.join(&plan.to)).unwrap(),
        "original conversation"
    );
}
