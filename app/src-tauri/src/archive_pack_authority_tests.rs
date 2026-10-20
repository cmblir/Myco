use super::*;
use crate::archive_pack::{MutationCheckpoint, MUTATION_HOOK};
use std::io::Read;
use std::sync::Arc;

struct ClearHook;
impl Drop for ClearHook {
    fn drop(&mut self) {
        MUTATION_HOOK.with(|hook| *hook.borrow_mut() = None);
    }
}

#[test]
fn stale_opening_retains_owned_sealed_stage_and_reports_refused_cleanup() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().canonicalize().unwrap();
    let parent = root.join("sessions/archive");
    std::fs::create_dir_all(parent.join("2026-01")).unwrap();
    let source = parent.join("2026-01/a.md");
    std::fs::write(&source, b"Synthetic retained original.\n").unwrap();
    std::fs::create_dir(root.join("raw")).unwrap();
    std::fs::write(root.join("raw/sentinel.md"), b"Immutable synthetic raw.\n").unwrap();
    let state = Arc::new(VaultRoot::default());
    let generation = state.begin_open().unwrap();
    state.finish_open(generation, root.clone(), || ()).unwrap();
    let origin = state.snapshot().unwrap();
    let changed_state = state.clone();
    let changed_root = root.clone();
    MUTATION_HOOK.with(|stored| {
        *stored.borrow_mut() = Some(Box::new(move |checkpoint| {
            if checkpoint == MutationCheckpoint::PackPrepared {
                let generation = changed_state.begin_open()?;
                changed_state.finish_open(generation, changed_root.clone(), || ())?;
            }
            Ok(())
        }));
    });
    let _clear = ClearHook;
    let error =
        compress_for_origin(&state, &origin, &origin.vault_path, 3, 1_787_184_000).unwrap_err();
    assert!(error.contains("stage cleanup refused"), "{error}");
    assert!(error.contains("retained at"), "{error}");
    assert_eq!(
        std::fs::read(&source).unwrap(),
        b"Synthetic retained original.\n"
    );
    assert!(!parent.join("2026-01.zip").exists());
    let stages = std::fs::read_dir(&parent)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .ends_with(".zip.part")
        })
        .collect::<Vec<_>>();
    assert_eq!(
        stages.len(),
        1,
        "stale cleanup must preserve its owned stage"
    );
    let mut zip = zip::ZipArchive::new(std::fs::File::open(&stages[0]).unwrap()).unwrap();
    let mut bytes = Vec::new();
    zip.by_name("a.md")
        .unwrap()
        .read_to_end(&mut bytes)
        .unwrap();
    assert_eq!(bytes, b"Synthetic retained original.\n");
    assert_eq!(
        std::fs::read(root.join("raw/sentinel.md")).unwrap(),
        b"Immutable synthetic raw.\n"
    );
}
