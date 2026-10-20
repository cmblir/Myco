use super::{extend_quarantine_core, AgentVaultSession, VaultRoot};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc};
use std::time::Duration;

#[path = "commands_keep_opening_additional_tests.rs"]
mod additional;

const REL: &str = "_inbox/quarantine/note.md";
const CONTENT: &str = "Synthetic owner-selected quarantine note.\n";
const EXPIRES: i64 = 2_000_000_000;

struct Fixture {
    _directory: tempfile::TempDir,
    root: PathBuf,
    verdict: String,
}

impl Fixture {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let verdict = serde_json::json!({"expires": EXPIRES, "vector": [0.25, 0.75], "legacy": {"retained": true}}).to_string();
        Self::seed(&root, &verdict);
        Self {
            _directory: directory,
            root,
            verdict,
        }
    }

    fn seed(root: &Path, verdict: &str) {
        std::fs::create_dir_all(root.join("_inbox/quarantine")).unwrap();
        std::fs::write(root.join(REL), CONTENT).unwrap();
        std::fs::write(root.join("_inbox/quarantine/note.verdict.json"), verdict).unwrap();
    }

    fn assert_unchanged(&self, root: &Path) {
        assert_eq!(std::fs::read_to_string(root.join(REL)).unwrap(), CONTENT);
        assert_eq!(
            std::fs::read_to_string(root.join("_inbox/quarantine/note.verdict.json")).unwrap(),
            self.verdict
        );
    }
}

fn open(state: &VaultRoot, root: &Path) -> AgentVaultSession {
    let generation = state.begin_open().unwrap();
    state
        .finish_open(generation, root.to_path_buf(), || ())
        .unwrap();
    state.snapshot().unwrap()
}

fn keep(state: &VaultRoot, vault: &Path, origin: &AgentVaultSession) -> Result<usize, String> {
    extend_quarantine_core(state, &vault.to_string_lossy(), origin, &[REL.into()], 7)
}

#[test]
fn current_native_opening_extends_once_and_preserves_other_fields() {
    let fixture = Fixture::new();
    let state = VaultRoot::default();
    let origin = open(&state, &fixture.root);
    assert_eq!(keep(&state, &fixture.root, &origin).unwrap(), 1);
    let mut expected: serde_json::Value = serde_json::from_str(&fixture.verdict).unwrap();
    expected["expires"] = (EXPIRES + 7 * 86_400).into();
    let current: serde_json::Value = serde_json::from_slice(
        &std::fs::read(fixture.root.join("_inbox/quarantine/note.verdict.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(current, expected);
    assert_eq!(
        std::fs::read_to_string(fixture.root.join(REL)).unwrap(),
        CONTENT
    );
}

#[test]
fn same_path_reopening_refuses_the_original_keep_request() {
    let fixture = Fixture::new();
    let state = VaultRoot::default();
    let old = open(&state, &fixture.root);
    let current = open(&state, &fixture.root);
    assert_ne!(old.opening_token, current.opening_token);
    let result = keep(&state, &fixture.root, &old);
    fixture.assert_unchanged(&fixture.root);
    assert!(result.is_err(), "old opening was accepted: {result:?}");
}

#[test]
fn stale_empty_request_still_requires_the_original_opening() {
    let fixture = Fixture::new();
    let state = VaultRoot::default();
    let old = open(&state, &fixture.root);
    open(&state, &fixture.root);
    let result = extend_quarantine_core(&state, &old.vault_path, &old, &[], 7);
    fixture.assert_unchanged(&fixture.root);
    assert!(
        result.is_err(),
        "empty stale request was accepted: {result:?}"
    );
}

#[test]
fn empty_native_token_cannot_authorize_keep() {
    let fixture = Fixture::new();
    let state = VaultRoot::default();
    let mut origin = open(&state, &fixture.root);
    origin.opening_token.clear();
    let result = keep(&state, &fixture.root, &origin);
    fixture.assert_unchanged(&fixture.root);
    assert!(result.is_err());
}

#[test]
fn child_root_cannot_redirect_a_current_keep_request() {
    let fixture = Fixture::new();
    let child = fixture.root.join("child");
    Fixture::seed(&child, &fixture.verdict);
    let state = VaultRoot::default();
    let origin = open(&state, &fixture.root);
    let result = keep(&state, &child, &origin);
    fixture.assert_unchanged(&child);
    fixture.assert_unchanged(&fixture.root);
    assert!(result.is_err());
}

#[test]
fn outside_vault_argument_is_refused_before_keep() {
    let fixture = Fixture::new();
    let outside = Fixture::new();
    let state = VaultRoot::default();
    let origin = open(&state, &fixture.root);
    assert!(keep(&state, &outside.root, &origin).is_err());
    fixture.assert_unchanged(&fixture.root);
    outside.assert_unchanged(&outside.root);
}

#[test]
fn closed_vault_refuses_keep_without_rewriting_its_old_files() {
    let fixture = Fixture::new();
    let state = VaultRoot::default();
    let origin = open(&state, &fixture.root);
    state.close().unwrap();
    assert!(keep(&state, &fixture.root, &origin).is_err());
    fixture.assert_unchanged(&fixture.root);
}

#[test]
fn admitted_keep_holds_its_opening_while_waiting_for_the_native_writer() {
    let fixture = Fixture::new();
    let state = Arc::new(VaultRoot::default());
    let origin = open(&state, &fixture.root);
    let guard = crate::vault::lock_file_mutation().unwrap();
    let (entered_tx, entered_rx) = mpsc::channel();
    let keep_state = state.clone();
    let keep_origin = origin.clone();
    let root = fixture.root.clone();
    let worker = std::thread::spawn(move || {
        crate::distill::set_keep_before_lock_hook(move || {
            entered_tx
                .send(crate::vault::try_lock_file_mutation().unwrap().is_none())
                .unwrap();
        });
        keep(&keep_state, &root, &keep_origin)
    });
    let entered = entered_rx.recv_timeout(Duration::from_secs(5));
    let (close_tx, close_rx) = mpsc::channel();
    let close_state = state.clone();
    let closer = std::thread::spawn(move || {
        let result = close_state.close();
        close_tx.send(result.clone()).unwrap();
        result
    });
    let completed_while_writer_held = close_rx.recv_timeout(Duration::from_millis(150));
    drop(guard);
    let keep_result = worker.join().unwrap();
    let close_result = closer.join().unwrap();
    assert!(
        entered.unwrap(),
        "actual Keep reached the held native writer"
    );
    assert!(
        matches!(
            completed_while_writer_held,
            Err(mpsc::RecvTimeoutError::Timeout)
        ),
        "opening transition completed during admitted Keep: {completed_while_writer_held:?}"
    );
    assert_eq!(keep_result.unwrap(), 1);
    close_result.unwrap();
    assert!(state.current().is_none());
    assert!(keep(&state, &fixture.root, &origin).is_err());
    let current: serde_json::Value = serde_json::from_slice(
        &std::fs::read(fixture.root.join("_inbox/quarantine/note.verdict.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(current["expires"].as_i64().unwrap(), EXPIRES + 7 * 86_400);
}
