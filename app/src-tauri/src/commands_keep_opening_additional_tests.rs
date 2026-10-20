use super::{keep, open, Fixture, EXPIRES, REL};
use crate::vault_session::VaultRoot;
use std::sync::{mpsc, Arc};
use std::time::Duration;

#[test]
fn writer_wait_directly_observes_the_original_opening_lock() {
    let fixture = Fixture::new();
    let state = Arc::new(VaultRoot::default());
    let origin = open(&state, &fixture.root);
    let guard = crate::vault::lock_file_mutation().unwrap();
    let (tx, rx) = mpsc::channel();
    let worker_state = state.clone();
    let root = fixture.root.clone();
    let worker = std::thread::spawn(move || {
        let observed_state = worker_state.clone();
        crate::distill::set_keep_before_lock_hook(move || {
            tx.send((
                crate::vault::try_lock_file_mutation().unwrap().is_none(),
                observed_state.is_transition_locked_for_test().unwrap(),
            ))
            .unwrap();
        });
        keep(&worker_state, &root, &origin)
    });
    let observed = rx.recv_timeout(Duration::from_secs(5));
    drop(guard);
    let result = worker.join().unwrap();
    assert_eq!(observed.unwrap(), (true, true));
    assert_eq!(result.unwrap(), 1);
}

#[test]
fn canonical_alias_of_the_current_root_keeps_the_registry_target() {
    let fixture = Fixture::new();
    let state = VaultRoot::default();
    let origin = open(&state, &fixture.root);
    assert_eq!(keep(&state, &fixture.root.join("."), &origin).unwrap(), 1);
    let current: serde_json::Value = serde_json::from_slice(
        &std::fs::read(fixture.root.join("_inbox/quarantine/note.verdict.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(current["expires"].as_i64().unwrap(), EXPIRES + 7 * 86_400);
    assert!(fixture.root.join(REL).is_file());
}

#[test]
fn switching_to_another_vault_refuses_the_previous_origin_and_preserves_both() {
    let first = Fixture::new();
    let second = Fixture::new();
    let state = VaultRoot::default();
    let original = open(&state, &first.root);
    open(&state, &second.root);
    assert!(keep(&state, &second.root, &original).is_err());
    first.assert_unchanged(&first.root);
    second.assert_unchanged(&second.root);
}
