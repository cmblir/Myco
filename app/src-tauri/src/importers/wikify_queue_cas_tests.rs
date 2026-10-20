//! Synthetic baseline regressions for authoritative queue publication.

use super::Pending;
use std::path::{Path, PathBuf};

struct Sentinels(Vec<(PathBuf, Vec<u8>)>);

impl Sentinels {
    fn create(root: &Path) -> Self {
        let entries = [
            (
                "raw/conversations/codex/source.md",
                "---\nsource: codex\nconversation_id: synthetic\n---\nImmutable synthetic original.\n",
            ),
            (
                "wiki/source-synthetic.md",
                "---\ntitle: A human title\ncustom: retained\n---\n# A human title\n\nHuman annotation remains.\n",
            ),
        ]
        .into_iter()
        .map(|(rel, text)| {
            let path = root.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, text).unwrap();
            (path, text.as_bytes().to_vec())
        })
        .collect();
        Self(entries)
    }

    fn assert_unchanged(&self) {
        for (path, original) in &self.0 {
            assert_eq!(
                std::fs::read(path).unwrap(),
                *original,
                "queue publication must retain immutable raw and human edits"
            );
        }
    }
}

#[test]
fn queue_save_refuses_an_external_update_since_the_loaded_json() {
    let root = tempfile::tempdir().unwrap();
    let sentinels = Sentinels::create(root.path());
    let mut queue = Pending {
        done_count: 1,
        ..Pending::default()
    };
    queue.save(root.path()).unwrap();
    let mut loaded = Pending::try_load(root.path()).unwrap();
    let mut concurrent = Pending::try_load(root.path()).unwrap();
    concurrent.done_count = 41;
    concurrent.save(root.path()).unwrap();
    let before = std::fs::read(Pending::path(root.path())).unwrap();
    loaded.done_count = 42;
    let result = loaded.save(root.path());
    sentinels.assert_unchanged();
    assert!(
        result.is_err(),
        "consumer must reject stale loaded queue JSON"
    );
    assert_eq!(std::fs::read(Pending::path(root.path())).unwrap(), before);
}

#[test]
fn corrupt_presentation_queue_cannot_be_saved_as_an_empty_success() {
    let root = tempfile::tempdir().unwrap();
    let sentinels = Sentinels::create(root.path());
    std::fs::create_dir(root.path().join(".myco")).unwrap();
    let before = b"{invalid preserved source queue";
    std::fs::write(Pending::path(root.path()), before).unwrap();
    let mut presentation = Pending::load(root.path());
    presentation.done_count = 9;
    let result = presentation.save(root.path());
    sentinels.assert_unchanged();
    assert!(
        result.is_err(),
        "unreadable queue is not permission to replace existing state"
    );
    assert_eq!(std::fs::read(Pending::path(root.path())).unwrap(), before);
}

#[cfg(unix)]
#[test]
fn queue_save_refuses_a_symlinked_state_directory() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let sentinels = Sentinels::create(root.path());
    let outside_file = outside.path().join("wikify-pending.json");
    let before = b"outside synthetic sentinel";
    std::fs::write(&outside_file, before).unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join(".myco")).unwrap();
    let mut queue = Pending {
        done_count: 63,
        ..Pending::default()
    };
    let result = queue.save(root.path());
    sentinels.assert_unchanged();
    assert!(
        result.is_err(),
        "consumer must reject symlinked state paths"
    );
    assert_eq!(std::fs::read(outside_file).unwrap(), before);
}
