use super::*;
use std::sync::{mpsc, TryLockError};
use std::time::Duration;

#[test]
fn policy_guard_serializes_commit_before_native_policy_save() {
    settings::test_support::with_isolated_data("ttl-policy-serialization", |_| {
        let enabled = Settings {
            permanent_delete: true,
            ..Settings::default()
        };
        settings::save(&enabled).unwrap();
        let directory = tempfile::tempdir().unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (saved_tx, saved_rx) = mpsc::channel();
        let mut worker = None;
        with_deletion_policy(true, || {
            crate::vault::with_root_mutation(directory.path(), |_, _| {
                assert!(
                    matches!(authorization().try_lock(), Err(TryLockError::WouldBlock)),
                    "policy guard must remain held inside the writer transaction"
                );
                worker = Some(std::thread::spawn(move || {
                    let mut disabled = enabled;
                    disabled.permanent_delete = false;
                    started_tx.send(()).unwrap();
                    let result = settings::save(&disabled);
                    saved_tx.send(result).unwrap();
                }));
                started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
                assert!(matches!(
                    saved_rx.try_recv(),
                    Err(mpsc::TryRecvError::Empty)
                ));
                assert!(settings::confirmed_deletion_policy(Some(true)).unwrap());
                Ok(())
            })
        })
        .unwrap();
        saved_rx
            .recv_timeout(Duration::from_secs(2))
            .unwrap()
            .unwrap();
        worker.unwrap().join().unwrap();
        assert!(!settings::confirmed_deletion_policy(Some(false)).unwrap());
    });
}

#[test]
fn revoked_or_corrupt_policy_never_dispatches_a_commit() {
    settings::test_support::with_isolated_data("ttl-policy-no-dispatch", |_| {
        settings::save(&Settings::default()).unwrap();
        let mut called = false;
        let error = with_deletion_policy(true, || {
            called = true;
            Ok(())
        })
        .unwrap_err();
        assert!(error.contains("policy changed"), "{error}");
        assert!(!called);
        std::fs::write(settings::settings_dir().unwrap().join("settings.json"), "{").unwrap();
        assert!(with_deletion_policy(true, || {
            called = true;
            Ok(())
        })
        .is_err());
        assert!(!called);
    });
}
