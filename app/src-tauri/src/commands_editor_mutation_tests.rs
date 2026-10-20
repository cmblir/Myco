//! Synthetic editor mutation regressions use the same filesystem helpers as
//! the public commands. They do not exercise Tauri IPC, private data or models.

use super::{write_file_at, write_file_if_unchanged_at_impl, VaultRoot};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const ORIGINAL: &str = "---\ntitle: Synthetic original\n---\nOriginal human-owned note.\n";
const NEWER: &str = "---\ntitle: Synthetic newer\n---\nA newer human edit; preserve it.\n";
const DRAFT: &str = "---\ntitle: Synthetic draft\n---\nAn unsaved editor draft.\n";

fn hash(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

fn write(root: &Path, relative: &str, content: &str) {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

fn fixture() -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    write(&root, "wiki/note.md", ORIGINAL);
    (directory, root)
}

fn open(state: &VaultRoot, root: &Path) {
    let generation = state.begin_open().unwrap();
    state
        .finish_open(generation, root.to_path_buf(), || ())
        .unwrap();
}

#[test]
fn editor_mutation_stale_draft_preserves_newer_actual_writer_bytes() {
    let (_directory, root) = fixture();
    let state = VaultRoot::default();
    open(&state, &root);
    let origin = state.snapshot().unwrap();
    let path = root.join("wiki/note.md");
    let baseline = crate::editor_io::read(&state, &path.to_string_lossy(), &origin).unwrap();
    assert_eq!(baseline.file.raw, ORIGINAL);
    assert_eq!(baseline.revision, hash(ORIGINAL));
    crate::vault::write_file(&path.to_string_lossy(), NEWER).unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), NEWER);

    // The RED used the former generic command helper. Preserve the same actual
    // A/B writes and assertions through the editor's additive production path.
    let result = crate::editor_io::write(
        &state,
        &path.to_string_lossy(),
        DRAFT,
        &baseline.revision,
        &baseline.origin,
    );
    let persisted = std::fs::read_to_string(path).unwrap();
    assert_eq!(
        persisted, NEWER,
        "stale editor replaced the newer bytes; result={result:?}"
    );
    assert!(
        result.is_err(),
        "stale editor write was accepted: {result:?}"
    );
    assert_eq!(baseline.file.raw, ORIGINAL);
}

#[test]
fn editor_mutation_same_path_reopening_refuses_old_pending_draft() {
    let (_directory, root) = fixture();
    let state = VaultRoot::default();
    open(&state, &root);
    let origin = state.snapshot().unwrap();
    let path = root.join("wiki/note.md");
    let baseline = crate::editor_io::read(&state, &path.to_string_lossy(), &origin).unwrap();
    open(&state, &root);
    let reopened = state.snapshot().unwrap();
    assert_eq!(origin.vault_path, reopened.vault_path);
    assert_ne!(origin.opening_token, reopened.opening_token);
    crate::vault::write_file(&path.to_string_lossy(), NEWER).unwrap();

    let result = crate::editor_io::write(
        &state,
        &path.to_string_lossy(),
        DRAFT,
        &baseline.revision,
        &baseline.origin,
    );
    assert_eq!(
        std::fs::read_to_string(path).unwrap(),
        NEWER,
        "old editor write survived same-path reopening; result={result:?}"
    );
    assert!(
        result.unwrap_err().contains("active vault changed"),
        "old opening must be refused before content CAS"
    );
    assert_eq!(baseline.file.raw, ORIGINAL);
    assert_eq!(
        state.snapshot().unwrap().opening_token,
        reopened.opening_token
    );
}

#[cfg(unix)]
fn assert_parent_replacement_refused(is_raw_target: bool, is_editor: bool) {
    use std::os::unix::fs::symlink;
    let (_directory, root) = fixture();
    let outside = tempfile::tempdir().unwrap();
    let outside_root = outside.path().canonicalize().unwrap();
    write(&outside_root, "note.md", ORIGINAL);
    write(&root, "raw/note.md", ORIGINAL);
    let parent = root.join("wiki");
    let saved = root.join("saved-wiki");
    let path = parent.join("note.md");
    let state = std::sync::Arc::new(VaultRoot::default());
    open(&state, &root);
    let origin = state.snapshot().unwrap();
    let baseline = crate::editor_io::read(&state, &path.to_string_lossy(), &origin).unwrap();
    let expected = baseline.revision;
    let alias_target = if is_raw_target {
        root.join("raw")
    } else {
        outside_root.clone()
    };
    let (entered, reached) = std::sync::mpsc::channel();
    let guard = crate::vault::lock_file_mutation().unwrap();
    let worker_root = root.clone();
    let worker_path = path.clone();
    let worker = std::thread::spawn(move || {
        let before_lock = || entered.send(()).unwrap();
        if is_editor {
            crate::editor_io::write_impl(
                &state,
                &worker_path.to_string_lossy(),
                DRAFT,
                &expected,
                &origin,
                before_lock,
                |_| Ok(()),
            )
            .map(|_| ())
        } else {
            write_file_if_unchanged_at_impl(
                &worker_root,
                &worker_path.to_string_lossy(),
                DRAFT,
                Some(&expected),
                before_lock,
            )
        }
    });
    let reached = reached.recv_timeout(std::time::Duration::from_secs(5));
    let replacement = if reached.is_ok() {
        std::fs::rename(&parent, &saved).and_then(|_| symlink(&alias_target, &parent))
    } else {
        Ok(())
    };
    // Release before joining/asserting so failures cannot poison the shared
    // writer lock or strand this test's specifically owned worker.
    drop(guard);
    let result = worker.join().unwrap();
    reached.unwrap();
    replacement.unwrap();
    assert_eq!(std::fs::read_link(&parent).unwrap(), alias_target);
    assert_eq!(
        std::fs::read_to_string(saved.join("note.md")).unwrap(),
        ORIGINAL
    );
    assert_eq!(
        std::fs::read_to_string(alias_target.join("note.md")).unwrap(),
        ORIGINAL,
        "conditional editor write escaped through replaced parent; result={result:?}"
    );
    assert_eq!(
        std::fs::read_to_string(root.join("raw/note.md")).unwrap(),
        ORIGINAL
    );
    assert_eq!(
        std::fs::read_to_string(outside_root.join("note.md")).unwrap(),
        ORIGINAL
    );
    assert!(result.is_err(), "parent alias was admitted: {result:?}");
}

#[cfg(unix)]
#[test]
fn editor_mutation_writer_wait_rechecks_outside_parent_even_with_matching_sha() {
    for is_editor in [false, true] {
        assert_parent_replacement_refused(false, is_editor);
    }
}

#[cfg(unix)]
#[test]
fn editor_mutation_writer_wait_rechecks_raw_parent_even_with_matching_sha() {
    for is_editor in [false, true] {
        assert_parent_replacement_refused(true, is_editor);
    }
}

#[test]
fn editor_mutation_existing_raw_write_is_refused_without_hiding_raw_read() {
    let (_directory, root) = fixture();
    write(&root, "raw/source.md", ORIGINAL);
    let path = root.join("raw/source.md");
    let file = crate::vault::read_file(&path.to_string_lossy()).unwrap();
    assert_eq!(file.raw, ORIGINAL);
    let result = write_file_at(&root, &path.to_string_lossy(), DRAFT);
    assert!(result.unwrap_err().contains("raw/ is immutable"));
    let state = VaultRoot::default();
    open(&state, &root);
    let origin = state.snapshot().unwrap();
    let read = crate::editor_io::read(&state, &path.to_string_lossy(), &origin).unwrap();
    assert_eq!(read.file.raw, ORIGINAL);
    assert_eq!(read.revision, hash(ORIGINAL));
    let result = crate::editor_io::write(
        &state,
        &path.to_string_lossy(),
        DRAFT,
        &read.revision,
        &origin,
    );
    assert!(result.unwrap_err().contains("raw/ is immutable"));
    assert_eq!(std::fs::read_to_string(path).unwrap(), ORIGINAL);
}

#[test]
fn editor_mutation_read_and_persisted_receipts_preserve_raw_and_camel_case_origin() {
    let (_directory, root) = fixture();
    let state = VaultRoot::default();
    open(&state, &root);
    let origin = state.snapshot().unwrap();
    let path = root.join("wiki/note.md");
    let read = crate::editor_io::read(&state, &path.to_string_lossy(), &origin).unwrap();
    assert_eq!(read.file.path, path.to_string_lossy());
    assert_eq!(read.file.raw, ORIGINAL);
    assert_eq!(read.file.frontmatter["title"], "Synthetic original");
    assert_eq!(read.revision, hash(ORIGINAL));
    let serialized = serde_json::to_value(&read).unwrap();
    assert_eq!(serialized["file"]["raw"], ORIGINAL);
    assert_eq!(serialized["origin"]["vaultPath"], origin.vault_path);
    assert_eq!(serialized["origin"]["openingToken"], origin.opening_token);
    assert!(serialized["origin"].get("opening_token").is_none());

    let receipt = crate::editor_io::write(
        &state,
        &path.to_string_lossy(),
        DRAFT,
        &read.revision,
        &read.origin,
    )
    .unwrap();
    let actual = std::fs::read_to_string(&path).unwrap();
    assert_eq!(actual, DRAFT);
    assert_eq!(receipt.path, path.to_string_lossy());
    assert_eq!(receipt.revision, hash(&actual));
    let serialized = serde_json::to_value(&receipt).unwrap();
    assert_eq!(serialized["origin"]["vaultPath"], origin.vault_path);
    assert_eq!(serialized["origin"]["openingToken"], origin.opening_token);
    assert_eq!(serialized["revision"], hash(DRAFT));
    assert_eq!(serialized.as_object().unwrap().len(), 3);

    // Only the accepted persisted receipt can supply the next successful CAS.
    let next = crate::editor_io::write(
        &state,
        &path.to_string_lossy(),
        "",
        &receipt.revision,
        &receipt.origin,
    )
    .unwrap();
    assert_eq!(std::fs::read_to_string(path).unwrap(), "");
    assert_eq!(next.revision, hash(""));
}

#[test]
fn editor_mutation_missing_or_invalid_first_baseline_cannot_replace_or_create() {
    let (_directory, root) = fixture();
    let state = VaultRoot::default();
    open(&state, &root);
    let origin = state.snapshot().unwrap();
    for relative in ["wiki/note.md", "wiki/missing.md"] {
        for revision in ["".to_string(), "not a SHA".to_string(), hash(ORIGINAL)] {
            if relative == "wiki/note.md" && revision == hash(ORIGINAL) {
                continue;
            }
            let result = crate::editor_io::write(
                &state,
                &root.join(relative).to_string_lossy(),
                DRAFT,
                &revision,
                &origin,
            );
            assert!(result.is_err(), "invalid baseline was accepted: {result:?}");
        }
    }
    assert_eq!(
        std::fs::read_to_string(root.join("wiki/note.md")).unwrap(),
        ORIGINAL
    );
    assert!(!root.join("wiki/missing.md").exists());
}

#[test]
fn editor_mutation_same_path_reopening_refuses_read_and_write_even_when_sha_matches() {
    let (_directory, root) = fixture();
    let state = VaultRoot::default();
    open(&state, &root);
    let origin = state.snapshot().unwrap();
    let path = root.join("wiki/note.md");
    let read = crate::editor_io::read(&state, &path.to_string_lossy(), &origin).unwrap();
    open(&state, &root);
    let stale_read = crate::editor_io::read(&state, &path.to_string_lossy(), &origin);
    let stale_write = crate::editor_io::write(
        &state,
        &path.to_string_lossy(),
        DRAFT,
        &read.revision,
        &origin,
    );
    assert!(stale_read.unwrap_err().contains("active vault changed"));
    assert!(stale_write.unwrap_err().contains("active vault changed"));
    assert_eq!(std::fs::read_to_string(path).unwrap(), ORIGINAL);
}

#[test]
fn editor_mutation_forged_origin_and_outside_paths_preserve_both_vaults() {
    let (_directory, root) = fixture();
    let outside = tempfile::tempdir().unwrap();
    let outside_root = outside.path().canonicalize().unwrap();
    write(&outside_root, "wiki/note.md", ORIGINAL);
    let state = VaultRoot::default();
    open(&state, &root);
    let origin = state.snapshot().unwrap();
    let forged = [
        super::AgentVaultSession {
            vault_path: outside_root.to_string_lossy().into_owned(),
            opening_token: origin.opening_token.clone(),
        },
        super::AgentVaultSession {
            vault_path: origin.vault_path.clone(),
            opening_token: "synthetic-forged-opening".into(),
        },
    ];
    for candidate in &forged {
        let read = crate::editor_io::read(
            &state,
            &root.join("wiki/note.md").to_string_lossy(),
            candidate,
        );
        let write = crate::editor_io::write(
            &state,
            &root.join("wiki/note.md").to_string_lossy(),
            DRAFT,
            &hash(ORIGINAL),
            candidate,
        );
        assert!(read.unwrap_err().contains("active vault changed"));
        assert!(write.unwrap_err().contains("active vault changed"));
    }
    let outside_path = outside_root.join("wiki/note.md");
    assert!(crate::editor_io::read(&state, &outside_path.to_string_lossy(), &origin).is_err());
    assert!(crate::editor_io::write(
        &state,
        &outside_path.to_string_lossy(),
        DRAFT,
        &hash(ORIGINAL),
        &origin,
    )
    .is_err());
    assert_eq!(
        std::fs::read_to_string(root.join("wiki/note.md")).unwrap(),
        ORIGINAL
    );
    assert_eq!(std::fs::read_to_string(outside_path).unwrap(), ORIGINAL);
}

#[cfg(unix)]
#[test]
fn editor_mutation_actual_persist_then_failed_receipt_is_explicit_and_cannot_reuse_baseline() {
    let (_directory, root) = fixture();
    let state = VaultRoot::default();
    open(&state, &root);
    let origin = state.snapshot().unwrap();
    let path = root.join("wiki/note.md");
    let read = crate::editor_io::read(&state, &path.to_string_lossy(), &origin).unwrap();
    let saved = root.join("wiki/actually-persisted.md");
    let result = crate::editor_io::write_impl(
        &state,
        &path.to_string_lossy(),
        DRAFT,
        &read.revision,
        &origin,
        || {},
        |target| {
            // This callback changes real files after the real atomic persist;
            // the shared leaf's named-identity inspection produces the error.
            std::fs::rename(target, &saved)
                .and_then(|_| std::fs::write(target, NEWER))
                .map_err(|error| format!("synthetic receipt replacement failed: {error}"))
        },
    );
    let error = result.unwrap_err();
    assert!(
        error.contains("write persisted but target identity changed before receipt"),
        "{error}"
    );
    assert_eq!(std::fs::read_to_string(&saved).unwrap(), DRAFT);
    assert_eq!(std::fs::read_to_string(&path).unwrap(), NEWER);
    assert_eq!(read.file.raw, ORIGINAL);
    assert_eq!(read.revision, hash(ORIGINAL));

    let retry = crate::editor_io::write(
        &state,
        &path.to_string_lossy(),
        DRAFT,
        &read.revision,
        &origin,
    );
    assert!(retry.unwrap_err().contains("write conflict"));
    assert_eq!(std::fs::read_to_string(saved).unwrap(), DRAFT);
    assert_eq!(std::fs::read_to_string(path).unwrap(), NEWER);
}
