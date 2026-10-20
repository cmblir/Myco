use super::*;
use std::sync::mpsc;
use std::time::Duration;

const CONTENT: &str = "Synthetic quarantine note retained by its owner.\n";
const REL: &str = "_inbox/quarantine/note.md";

struct Fixture {
    directory: tempfile::TempDir,
    content: PathBuf,
    sidecar: PathBuf,
    verdict: String,
}

impl Fixture {
    fn new(expires: i64) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let content = directory.path().join(REL);
        std::fs::create_dir_all(content.parent().unwrap()).unwrap();
        let sidecar = sidecar_path(&content);
        let verdict = serde_json::json!({
            "tier": "quarantine", "from": "_inbox/note.md", "expires": expires,
            "source_sha256": admission::sha256(CONTENT.as_bytes()),
            "vector": [0.25, 0.75], "reason": "Synthetic owner review"
        })
        .to_string();
        std::fs::write(&content, CONTENT).unwrap();
        std::fs::write(&sidecar, &verdict).unwrap();
        Self {
            directory,
            content,
            sidecar,
            verdict,
        }
    }

    fn extend(&self) -> Result<usize, String> {
        extend_quarantine(self.directory.path(), &[REL.into()], 7)
    }
}

#[test]
fn missing_payload_cannot_report_a_successful_keep() {
    let fixture = Fixture::new(now_secs());
    std::fs::remove_file(&fixture.content).unwrap();
    let result = fixture.extend();
    assert_eq!(
        std::fs::read_to_string(&fixture.sidecar).unwrap(),
        fixture.verdict
    );
    assert!(
        result.is_err(),
        "missing payload must refuse Keep: {result:?}"
    );
}

#[test]
fn directory_payload_cannot_be_kept_as_a_note() {
    let fixture = Fixture::new(now_secs());
    std::fs::remove_file(&fixture.content).unwrap();
    std::fs::create_dir(&fixture.content).unwrap();
    let result = fixture.extend();
    assert_eq!(
        std::fs::read_to_string(&fixture.sidecar).unwrap(),
        fixture.verdict
    );
    assert!(
        result.is_err(),
        "non-file payload must refuse Keep: {result:?}"
    );
}

#[test]
fn directory_verdict_is_an_error_rather_than_a_legacy_skip() {
    let fixture = Fixture::new(now_secs());
    std::fs::remove_file(&fixture.sidecar).unwrap();
    std::fs::create_dir(&fixture.sidecar).unwrap();
    assert!(fixture.extend().is_err());
    assert_eq!(std::fs::read_to_string(&fixture.content).unwrap(), CONTENT);
    assert!(fixture.sidecar.is_dir());
}

#[cfg(unix)]
#[test]
fn linked_verdict_never_modifies_an_outside_file() {
    let fixture = Fixture::new(now_secs());
    let outside = tempfile::tempdir().unwrap();
    let target = outside.path().join("outside.json");
    std::fs::write(&target, &fixture.verdict).unwrap();
    std::fs::remove_file(&fixture.sidecar).unwrap();
    std::os::unix::fs::symlink(&target, &fixture.sidecar).unwrap();
    let result = fixture.extend();
    assert_eq!(std::fs::read_to_string(&target).unwrap(), fixture.verdict);
    assert!(result.is_err());
    assert!(std::fs::symlink_metadata(&fixture.sidecar)
        .unwrap()
        .file_type()
        .is_symlink());
}

#[cfg(unix)]
#[test]
fn linked_payload_never_authorizes_keep() {
    let fixture = Fixture::new(now_secs());
    let other = fixture.directory.path().join("other.md");
    std::fs::rename(&fixture.content, &other).unwrap();
    std::os::unix::fs::symlink(&other, &fixture.content).unwrap();
    let result = fixture.extend();
    assert_eq!(
        std::fs::read_to_string(&fixture.sidecar).unwrap(),
        fixture.verdict
    );
    assert!(result.is_err());
    assert_eq!(std::fs::read_to_string(other).unwrap(), CONTENT);
}

#[cfg(unix)]
#[test]
fn hardlinked_verdict_never_rewrites_raw_original_bytes() {
    let fixture = Fixture::new(now_secs());
    let raw = fixture.directory.path().join("raw/original.json");
    std::fs::create_dir(raw.parent().unwrap()).unwrap();
    std::fs::hard_link(&fixture.sidecar, &raw).unwrap();
    let result = fixture.extend();
    assert_eq!(std::fs::read_to_string(raw).unwrap(), fixture.verdict);
    assert_eq!(
        std::fs::read_to_string(&fixture.sidecar).unwrap(),
        fixture.verdict
    );
    assert!(result.is_err());
}

#[test]
fn future_expiry_extension_preserves_all_other_fields() {
    let expires = now_secs() + 10 * 86_400;
    let fixture = Fixture::new(expires);
    assert_eq!(fixture.extend().unwrap(), 1);
    let mut before: serde_json::Value = serde_json::from_str(&fixture.verdict).unwrap();
    before["expires"] = (expires + 7 * 86_400).into();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(
            &std::fs::read_to_string(&fixture.sidecar).unwrap()
        )
        .unwrap(),
        before
    );
    assert_eq!(std::fs::read_to_string(&fixture.content).unwrap(), CONTENT);
}

#[test]
fn missing_or_malformed_verdict_is_skipped_only_with_a_live_payload() {
    let fixture = Fixture::new(now_secs());
    std::fs::remove_file(&fixture.sidecar).unwrap();
    assert_eq!(fixture.extend().unwrap(), 0);
    assert!(!fixture.sidecar.exists());
    std::fs::write(&fixture.sidecar, "{").unwrap();
    assert_eq!(fixture.extend().unwrap(), 0);
    assert_eq!(std::fs::read_to_string(&fixture.sidecar).unwrap(), "{");
    assert_eq!(std::fs::read_to_string(&fixture.content).unwrap(), CONTENT);
}

#[test]
fn expiry_overflow_is_reported_without_overwriting_the_verdict() {
    let fixture = Fixture::new(i64::MAX);
    let result = fixture.extend();
    assert_eq!(
        std::fs::read_to_string(&fixture.sidecar).unwrap(),
        fixture.verdict
    );
    assert!(result.is_err());
}

struct Hooks;
impl Drop for Hooks {
    fn drop(&mut self) {
        COMMIT_HOOK.with(|slot| *slot.borrow_mut() = None);
    }
}

struct KeepWorker {
    thread: std::thread::JoinHandle<Result<usize, String>>,
    completed_while_locked: Option<Result<usize, String>>,
    completion: mpsc::Receiver<Result<usize, String>>,
}

fn concurrent_keep_at_expiry(permanent: bool) {
    crate::settings::test_support::with_isolated_data("keep-expiry-writer", |_| {
        crate::settings::save(&crate::settings::Settings {
            permanent_delete: permanent,
            ..crate::settings::Settings::default()
        })
        .unwrap();
        let fixture = Fixture::new(now_secs() - 1000);
        let pending = std::rc::Rc::new(std::cell::RefCell::new(None));
        let root = fixture.directory.path().to_path_buf();
        let captured = pending.clone();
        let _hooks = Hooks;
        COMMIT_HOOK.with(|slot| {
            *slot.borrow_mut() = Some(Box::new(move |phase, _| {
                let seam = if permanent {
                    CommitCheckpoint::ContentDeleted
                } else {
                    CommitCheckpoint::ContentTrashed
                };
                if phase != seam {
                    return Ok(());
                }
                if crate::vault::try_lock_file_mutation()?.is_some() {
                    return Err("expiry seam does not hold its writer".into());
                }
                let (entered_tx, entered_rx) = mpsc::channel();
                let (done_tx, done_rx) = mpsc::channel();
                let worker_root = root.clone();
                let thread = std::thread::spawn(move || {
                    KEEP_BEFORE_LOCK_HOOK.with(|slot| {
                        *slot.borrow_mut() = Some(Box::new(move || {
                            entered_tx
                                .send(crate::vault::try_lock_file_mutation().unwrap().is_none())
                                .unwrap();
                        }))
                    });
                    let result = extend_quarantine(&worker_root, &[REL.into()], 7);
                    done_tx.send(result.clone()).unwrap();
                    result
                });
                let reached_locked_writer = entered_rx
                    .recv_timeout(Duration::from_secs(5))
                    .map_err(|error| format!("start Keep worker: {error}"))?;
                if !reached_locked_writer {
                    return Err("actual Keep did not reach the locked writer".into());
                }
                let completed_while_locked = match done_rx.recv_timeout(Duration::from_millis(150))
                {
                    Ok(result) => Some(result),
                    Err(mpsc::RecvTimeoutError::Timeout) => None,
                    Err(error) => return Err(format!("observe Keep worker: {error}")),
                };
                *captured.borrow_mut() = Some(KeepWorker {
                    thread,
                    completed_while_locked,
                    completion: done_rx,
                });
                Ok(())
            }))
        });
        let run_result =
            run_without_embeddings(fixture.directory.path(), &DistillConfig::default());
        let worker = pending
            .borrow_mut()
            .take()
            .expect("actual expiry reached the seam");
        let keep_result = worker.thread.join().unwrap();
        if worker.completed_while_locked.is_none() {
            assert_eq!(worker.completion.recv().unwrap(), keep_result);
        }
        assert!(
            worker.completed_while_locked.is_none(),
            "Keep completed inside expiry's critical section: {:?}",
            worker.completed_while_locked
        );
        assert!(run_result.is_ok(), "{run_result:?}");
        assert!(
            keep_result.is_err(),
            "a deleted/moved payload must refuse Keep: {keep_result:?}"
        );
        assert!(
            !fixture.content.exists() && !fixture.sidecar.exists(),
            "Keep must not recreate an orphan verdict"
        );
        let report = run_result.unwrap();
        let manifest: RunManifest = serde_json::from_slice(
            &std::fs::read(manifest_path(fixture.directory.path(), &report.id)).unwrap(),
        )
        .unwrap();
        if permanent {
            assert_eq!(
                manifest.deleted,
                [REL, "_inbox/quarantine/note.verdict.json"]
            );
            assert!(manifest.trashed.is_empty());
        } else {
            assert_eq!(manifest.trashed.len(), 2);
            assert_eq!(
                std::fs::read_to_string(fixture.directory.path().join(&manifest.trashed[1].to))
                    .unwrap(),
                fixture.verdict
            );
        }
    });
}

#[test]
fn actual_keep_waits_for_permanent_expiry_and_refuses_the_deleted_pair() {
    concurrent_keep_at_expiry(true);
}

#[test]
fn actual_keep_waits_for_recoverable_expiry_and_refuses_the_moved_pair() {
    concurrent_keep_at_expiry(false);
}
