use super::{compress_archives_core, restore_archive_bucket_core, AgentVaultSession, VaultRoot};
use crate::archive_pack::{MutationCheckpoint, MUTATION_HOOK};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const NOW: i64 = 1_787_184_000;
const BODY: &[u8] = b"Synthetic original archive source.\n";
const BUCKET: &str = "sessions/archive/2026-01";

fn open(state: &VaultRoot, root: &Path) -> AgentVaultSession {
    let generation = state.begin_open().unwrap();
    state
        .finish_open(generation, root.to_path_buf(), || ())
        .unwrap();
    state.snapshot().unwrap()
}

fn fixture() -> (
    tempfile::TempDir,
    PathBuf,
    Arc<VaultRoot>,
    AgentVaultSession,
) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    std::fs::create_dir(root.join("raw")).unwrap();
    std::fs::write(root.join("raw/sentinel.md"), b"Immutable synthetic raw.\n").unwrap();
    let state = Arc::new(VaultRoot::default());
    let origin = open(&state, &root);
    (directory, root, state, origin)
}

fn seed(root: &Path) -> PathBuf {
    let directory = root.join(BUCKET);
    std::fs::create_dir_all(&directory).unwrap();
    let source = directory.join("a.md");
    std::fs::write(&source, BODY).unwrap();
    source
}

fn independent_zip(root: &Path) -> (PathBuf, Vec<u8>) {
    let path = root.join(format!("{BUCKET}.zip"));
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut writer = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
    writer
        .start_file("a.md", zip::write::SimpleFileOptions::default())
        .unwrap();
    writer.write_all(BODY).unwrap();
    writer.finish().unwrap();
    let original = std::fs::read(&path).unwrap();
    (path, original)
}

fn raw_unchanged(root: &Path) {
    assert_eq!(
        std::fs::read(root.join("raw/sentinel.md")).unwrap(),
        b"Immutable synthetic raw.\n"
    );
}

struct ClearHook;
impl Drop for ClearHook {
    fn drop(&mut self) {
        MUTATION_HOOK.with(|hook| *hook.borrow_mut() = None);
    }
}
fn reopen_at(state: Arc<VaultRoot>, root: PathBuf, expected: MutationCheckpoint) -> ClearHook {
    MUTATION_HOOK.with(|stored| {
        *stored.borrow_mut() = Some(Box::new(move |checkpoint| {
            if checkpoint == expected {
                // Real opening transitions must remain possible outside each commit.
                open(&state, &root);
            }
            Ok(())
        }));
    });
    ClearHook
}

#[test]
fn pack_rejects_raw_descendant_as_caller_root_before_source_mutation() {
    let (_directory, root, state, origin) = fixture();
    let raw = root.join("raw");
    let source = seed(&raw);
    let result = compress_archives_core(&state, &raw.to_string_lossy(), &origin, 3, NOW);
    assert!(result.is_err(), "raw descendant was admitted: {result:?}");
    assert_eq!(std::fs::read(source).unwrap(), BODY);
    assert!(!raw.join(format!("{BUCKET}.zip")).exists());
    raw_unchanged(&root);
}

#[test]
fn restore_rejects_raw_descendant_as_caller_root_before_directory_creation() {
    let (_directory, root, state, origin) = fixture();
    let raw = root.join("raw");
    let (zip, original) = independent_zip(&raw);
    let result = restore_archive_bucket_core(
        &state,
        &raw.to_string_lossy(),
        &origin,
        "sessions",
        "2026-01",
    );
    assert!(result.is_err(), "raw descendant was restored: {result:?}");
    assert_eq!(std::fs::read(zip).unwrap(), original);
    assert!(!raw.join(BUCKET).exists());
    raw_unchanged(&root);
}

#[test]
fn pack_rejects_previous_same_path_opening_before_processing_sources() {
    let (_directory, root, state, origin) = fixture();
    let source = seed(&root);
    open(&state, &root);
    let result = compress_archives_core(&state, &origin.vault_path, &origin, 3, NOW);
    assert!(result.is_err(), "old opening packed sources: {result:?}");
    assert_eq!(std::fs::read(source).unwrap(), BODY);
    assert!(!root.join(format!("{BUCKET}.zip")).exists());
    raw_unchanged(&root);
}

#[test]
fn pack_rejects_previous_same_path_opening_even_for_an_empty_archive() {
    let (_directory, root, state, origin) = fixture();
    open(&state, &root);
    assert!(compress_archives_core(&state, &origin.vault_path, &origin, 3, NOW).is_err());
    raw_unchanged(&root);
}

#[test]
fn pack_preparation_does_not_hold_opening_lock_and_reopen_blocks_publication() {
    let (_directory, root, state, origin) = fixture();
    let source = seed(&root);
    let _hook = reopen_at(
        state.clone(),
        root.clone(),
        MutationCheckpoint::PackPrepared,
    );
    let result = compress_archives_core(&state, &origin.vault_path, &origin, 3, NOW);
    assert!(
        result.is_err()
            || result
                .as_ref()
                .is_ok_and(|report| !report.failed.is_empty()),
        "reopened job succeeded: {result:?}"
    );
    assert_eq!(std::fs::read(source).unwrap(), BODY);
    assert!(!root.join(format!("{BUCKET}.zip")).exists());
    raw_unchanged(&root);
}

#[test]
fn restore_preparation_reopen_blocks_bucket_creation() {
    let (_directory, root, state, origin) = fixture();
    let (zip, original) = independent_zip(&root);
    let _hook = reopen_at(
        state.clone(),
        root.clone(),
        MutationCheckpoint::RestorePrepared,
    );
    let result =
        restore_archive_bucket_core(&state, &origin.vault_path, &origin, "sessions", "2026-01");
    assert!(
        result.is_err(),
        "reopened restore created its bucket: {result:?}"
    );
    assert_eq!(std::fs::read(zip).unwrap(), original);
    assert!(!root.join(BUCKET).exists());
    raw_unchanged(&root);
}

#[test]
fn restore_finalize_reopen_preserves_zip_and_already_restored_bytes() {
    let (_directory, root, state, origin) = fixture();
    let (zip, original) = independent_zip(&root);
    let _hook = reopen_at(
        state.clone(),
        root.clone(),
        MutationCheckpoint::RestoreFinalize,
    );
    let result =
        restore_archive_bucket_core(&state, &origin.vault_path, &origin, "sessions", "2026-01");
    assert!(
        result.is_err(),
        "reopened restore removed its archive: {result:?}"
    );
    assert_eq!(std::fs::read(zip).unwrap(), original);
    assert_eq!(std::fs::read(root.join(BUCKET).join("a.md")).unwrap(), BODY);
    raw_unchanged(&root);
}

#[test]
fn exact_current_opening_can_pack_and_restore_without_changing_raw() {
    let (_directory, root, state, origin) = fixture();
    let source = seed(&root);
    assert_eq!(
        compress_archives_core(&state, &origin.vault_path, &origin, 3, NOW)
            .unwrap()
            .buckets,
        1
    );
    assert!(!source.exists());
    assert_eq!(
        restore_archive_bucket_core(&state, &origin.vault_path, &origin, "sessions", "2026-01")
            .unwrap()
            .files,
        1
    );
    assert_eq!(std::fs::read(source).unwrap(), BODY);
    raw_unchanged(&root);
}

#[test]
fn foreign_and_closed_vaults_cannot_dispatch_compaction() {
    let (_directory, root, state, origin) = fixture();
    let foreign = tempfile::tempdir().unwrap();
    let foreign_root = foreign.path().canonicalize().unwrap();
    let source = seed(&foreign_root);
    assert!(
        compress_archives_core(&state, &foreign_root.to_string_lossy(), &origin, 3, NOW).is_err()
    );
    assert_eq!(std::fs::read(source).unwrap(), BODY);
    state.close().unwrap();
    assert!(compress_archives_core(&state, &origin.vault_path, &origin, 3, NOW).is_err());
    raw_unchanged(&root);
}
