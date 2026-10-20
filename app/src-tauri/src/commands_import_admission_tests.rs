use super::*;
use crate::importers::{ledger::Ledger, wikify::Pending};

fn open(state: &VaultRoot, root: &Path) {
    let generation = state.begin_open().unwrap();
    state
        .finish_open(generation, root.canonicalize().unwrap(), || ())
        .unwrap();
}

fn record(id: &str) -> String {
    serde_json::json!({"type":"user","uuid":"turn-1","sessionId":id,
        "timestamp":"2026-10-09T12:00:00Z", "message":{"role":"user",
        "content":format!("A synthetic person is researching the {id} design decision. ").repeat(24)}})
    .to_string()
}

fn source(root: &Path, id: &str) -> PathBuf {
    let path = root.join(format!("{id}.jsonl"));
    std::fs::write(&path, record(id)).unwrap();
    path
}

#[test]
fn native_import_rejects_a_captured_origin_after_same_path_reopen() {
    let vault = tempfile::tempdir().unwrap();
    let state = VaultRoot::default();
    open(&state, vault.path());
    let origin = state.snapshot().unwrap();
    let input = source(vault.path(), "same-root");
    open(&state, vault.path());
    let outcome = run(
        &state,
        &origin,
        &[input],
        super::super::DEST_SESSIONS,
        || true,
        |_| {},
    );
    assert_eq!(outcome.imported, 0, "old opening published a projection");
    assert_eq!(outcome.failed.len(), 1);
    assert!(!vault.path().join("raw").exists());
    assert!(!vault.path().join("sessions").exists());
    assert!(!vault.path().join(".myco/ledger.json").exists());
    assert!(!Pending::path(vault.path()).exists());
}

#[test]
fn native_import_stops_a_batch_after_close_without_losing_prior_admission() {
    let vault = tempfile::tempdir().unwrap();
    let state = VaultRoot::default();
    open(&state, vault.path());
    let origin = state.snapshot().unwrap();
    let inputs = [source(vault.path(), "first"), source(vault.path(), "late")];
    let outcome = run(
        &state,
        &origin,
        &inputs,
        super::super::DEST_SESSIONS,
        || true,
        |progress| {
            if progress.done == 1 {
                state.close().unwrap();
            }
        },
    );
    assert_eq!(
        outcome.imported, 1,
        "closed opening admitted a later source"
    );
    assert_eq!(outcome.failed.len(), 1);
    let ledger = Ledger::load(vault.path()).unwrap();
    assert!(ledger.entry("claude-code:first").is_some());
    assert!(ledger.entry("claude-code:late").is_none());
    let pending = Pending::try_load(vault.path()).unwrap();
    assert_eq!(pending.pending.len(), 1);
    assert_eq!(pending.pending[0].key, "claude-code:first");
}

#[test]
fn native_import_queues_the_admitted_immutable_revision_when_organization_is_enabled() {
    let vault = tempfile::tempdir().unwrap();
    let state = VaultRoot::default();
    open(&state, vault.path());
    let origin = state.snapshot().unwrap();
    let input = source(vault.path(), "automatic");
    let outcome = run(
        &state,
        &origin,
        &[input],
        super::super::DEST_SESSIONS,
        || true,
        |_| {},
    );
    assert!(outcome.failed.is_empty());
    assert_eq!(outcome.imported, 1);
    let pending = Pending::try_load(vault.path()).unwrap();
    assert_eq!(
        pending.pending.len(),
        1,
        "automatic source admission never reached the durable queue"
    );
    let item = &pending.pending[0];
    let raw = std::fs::read_to_string(vault.path().join(&item.raw_path)).unwrap();
    assert_eq!(
        item.source_revision,
        crate::importers::wikify::source_revision(&raw)
    );
    assert_eq!(item.key, "claude-code:automatic");
    assert!(item.read_ranges.is_empty());
    assert!(
        pending.receipts.is_empty(),
        "queue admission is not compilation completion"
    );
}

#[test]
fn native_archive_import_does_not_queue_without_organization_permission() {
    let vault = tempfile::tempdir().unwrap();
    let state = VaultRoot::default();
    open(&state, vault.path());
    let origin = state.snapshot().unwrap();
    let input = source(vault.path(), "archive-only");
    let outcome = run(
        &state,
        &origin,
        &[input],
        super::super::DEST_SESSIONS,
        || false,
        |_| {},
    );
    assert!(outcome.failed.is_empty());
    assert_eq!(outcome.imported, 1);
    assert!(!Pending::path(vault.path()).exists());
}

#[test]
fn native_import_preserves_corrupt_queue_before_publishing_a_source() {
    let vault = tempfile::tempdir().unwrap();
    let state = VaultRoot::default();
    open(&state, vault.path());
    let origin = state.snapshot().unwrap();
    let input = source(vault.path(), "queue-corrupt");
    std::fs::create_dir(vault.path().join(".myco")).unwrap();
    let queue = Pending::path(vault.path());
    std::fs::write(&queue, "{ corrupt synthetic queue").unwrap();
    let previous = std::fs::read(&queue).unwrap();
    let outcome = run(
        &state,
        &origin,
        &[input],
        super::super::DEST_SESSIONS,
        || true,
        |_| {},
    );
    assert_eq!(
        outcome.imported, 0,
        "corrupt queue was ignored during source publication"
    );
    assert_eq!(outcome.failed.len(), 1);
    assert_eq!(std::fs::read(queue).unwrap(), previous);
    assert!(!vault.path().join("raw").exists());
    assert!(!vault.path().join("sessions").exists());
    assert!(!vault.path().join(".myco/ledger.json").exists());
}

#[test]
fn native_import_rechecks_opening_after_source_parse_before_any_write() {
    let vault = tempfile::tempdir().unwrap();
    let state = std::sync::Arc::new(VaultRoot::default());
    open(&state, vault.path());
    let origin = state.snapshot().unwrap();
    let input = source(vault.path(), "parsed-old-opening");
    let reopened_state = state.clone();
    let root = vault.path().to_path_buf();
    probe_hooks::install_after_parse(move || open(&reopened_state, &root));
    let outcome = run(
        &state,
        &origin,
        &[input],
        super::super::DEST_SESSIONS,
        || true,
        |_| {},
    );
    assert_eq!(outcome.imported, 0);
    assert_eq!(outcome.failed.len(), 1);
    assert!(!vault.path().join("raw").exists());
    assert!(!vault.path().join(".myco/ledger.json").exists());
    assert!(!Pending::path(vault.path()).exists());
}

#[test]
fn native_queue_uses_admitted_bytes_when_the_external_session_grows_after_parse() {
    let vault = tempfile::tempdir().unwrap();
    let state = VaultRoot::default();
    open(&state, vault.path());
    let origin = state.snapshot().unwrap();
    let input = source(vault.path(), "grew");
    let original = std::fs::read_to_string(&input).unwrap();
    let original_body =
        crate::importers::detect_and_parse("grew.jsonl", &original).unwrap()[0].to_inbox_doc();
    let changed = input.clone();
    probe_hooks::install_after_parse(move || {
        let appended = format!(
            "{}\n{}",
            std::fs::read_to_string(&changed).unwrap(),
            serde_json::json!({"type":"assistant","uuid":"later-turn","sessionId":"grew",
            "message":{"role":"assistant","content":"The later synthetic decision must wait for the next admitted revision."}})
        );
        std::fs::write(changed, appended).unwrap();
    });
    let first = run(
        &state,
        &origin,
        std::slice::from_ref(&input),
        super::super::DEST_SESSIONS,
        || true,
        |_| {},
    );
    assert!(first.failed.is_empty());
    assert_eq!(first.imported, 1);
    let first_queue = Pending::try_load(vault.path()).unwrap();
    let first_item = first_queue.pending.first().unwrap();
    let first_raw = vault.path().join(&first_item.raw_path);
    let first_bytes = std::fs::read(&first_raw).unwrap();
    assert_eq!(std::str::from_utf8(&first_bytes).unwrap(), original_body);
    assert_eq!(
        first_item.source_revision,
        crate::importers::wikify::source_revision(&original_body)
    );
    let again = run(
        &state,
        &origin,
        &[input],
        super::super::DEST_SESSIONS,
        || true,
        |_| {},
    );
    assert!(again.failed.is_empty());
    assert_eq!(again.imported, 1);
    let next = Pending::try_load(vault.path()).unwrap();
    assert_eq!(
        next.pending.len(),
        1,
        "resumed identity duplicated the pending queue"
    );
    assert_ne!(next.pending[0].source_revision, first_item.source_revision);
    assert_eq!(std::fs::read(first_raw).unwrap(), first_bytes);
    assert!(next.receipts.is_empty());
}

#[test]
fn native_queue_retry_repairs_a_failed_publication_without_rewriting_raw() {
    let vault = tempfile::tempdir().unwrap();
    let state = VaultRoot::default();
    open(&state, vault.path());
    let origin = state.snapshot().unwrap();
    let input = source(vault.path(), "retry");
    let root = vault.path().to_path_buf();
    super::super::import_projection::hooks::install(move || {
        std::fs::create_dir(Pending::path(&root)).unwrap();
    });
    let first = run(
        &state,
        &origin,
        std::slice::from_ref(&input),
        super::super::DEST_SESSIONS,
        || true,
        |_| {},
    );
    assert_eq!(first.imported, 1);
    assert_eq!(first.failed.len(), 1);
    let ledger = Ledger::load(vault.path()).unwrap();
    let projection = vault.path().join(
        ledger
            .location(super::super::DEST_SESSIONS, "claude-code:retry")
            .unwrap(),
    );
    let projection_before = std::fs::read(&projection).unwrap();
    let normalized = crate::importers::detect_and_parse(
        "retry.jsonl",
        &std::fs::read_to_string(&input).unwrap(),
    )
    .unwrap()[0]
        .to_inbox_doc();
    let fingerprint = crate::importers::ledger::fingerprint(&normalized);
    let raw = vault.path().join(format!(
        "raw/conversations/claude-code/claude-code-retry-{fingerprint}.md"
    ));
    let raw_before = std::fs::read(&raw).unwrap();
    std::fs::remove_dir(Pending::path(vault.path())).unwrap();
    let retry = run(
        &state,
        &origin,
        std::slice::from_ref(&input),
        super::super::DEST_SESSIONS,
        || true,
        |_| {},
    );
    assert!(retry.failed.is_empty());
    assert_eq!(retry.imported, 0);
    assert_eq!(retry.skipped, 1);
    assert_eq!(std::fs::read(&raw).unwrap(), raw_before);
    assert_eq!(std::fs::read(projection).unwrap(), projection_before);
    let queue_before = std::fs::read(Pending::path(vault.path())).unwrap();
    let again = run(
        &state,
        &origin,
        &[input],
        super::super::DEST_SESSIONS,
        || true,
        |_| {},
    );
    assert!(again.failed.is_empty());
    assert_eq!(
        std::fs::read(Pending::path(vault.path())).unwrap(),
        queue_before
    );
    assert_eq!(Pending::try_load(vault.path()).unwrap().pending.len(), 1);
}

#[test]
fn native_same_revision_retry_does_not_republish_an_unchanged_ledger_or_queue() {
    let vault = tempfile::tempdir().unwrap();
    let state = VaultRoot::default();
    open(&state, vault.path());
    let origin = state.snapshot().unwrap();
    let input = source(vault.path(), "quiet");
    let first = run(
        &state,
        &origin,
        std::slice::from_ref(&input),
        super::super::DEST_SESSIONS,
        || true,
        |_| {},
    );
    assert!(first.failed.is_empty());
    assert_eq!(first.imported, 1);
    // Complete the existing ledger's one-time body-index migration explicitly;
    // this fixture measures a quiet current-schema retry, not that migration.
    let mut current_ledger = Ledger::load(vault.path()).unwrap();
    current_ledger.save(vault.path()).unwrap();
    let ledger_path = vault.path().join(".myco/ledger.json");
    let queue_path = Pending::path(vault.path());
    let ledger = std::fs::read(&ledger_path).unwrap();
    let queue = std::fs::read(&queue_path).unwrap();
    let metadata = std::fs::metadata(&ledger_path).unwrap();
    let again = run(
        &state,
        &origin,
        &[input],
        super::super::DEST_SESSIONS,
        || true,
        |_| {},
    );
    assert!(again.failed.is_empty());
    assert_eq!(again.imported, 0);
    assert_eq!(again.skipped, 1);
    assert_eq!(std::fs::read(&ledger_path).unwrap(), ledger);
    assert_eq!(std::fs::read(queue_path).unwrap(), queue);
    let current_metadata = std::fs::metadata(ledger_path).unwrap();
    assert_eq!(
        current_metadata.modified().unwrap(),
        metadata.modified().unwrap(),
        "quiet admission rewrote the ledger"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(
            current_metadata.ino(),
            metadata.ino(),
            "quiet admission replaced the ledger file"
        );
    }
}
