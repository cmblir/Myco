//! Synthetic creation tests call the production root-injected command helpers.
//! They do not exercise Tauri, private vaults, settings or model generation.

use super::{create_file_at, create_folder_at};
use std::path::Path;

const HUMAN: &str = "Human-authored synthetic note; preserve these bytes.\n";
const RAW: &str = "Immutable synthetic source; preserve these bytes.\n";

fn write(root: &Path, relative: &str, content: &str) {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

fn optional_text(path: &Path) -> Option<String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Some(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => panic!("inspect synthetic creation {}: {error}", path.display()),
    }
}

#[cfg(unix)]
#[test]
fn creation_mutation_file_refuses_outside_ancestor_with_missing_descendants() {
    use std::os::unix::fs::symlink;
    let vault = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root = vault.path().canonicalize().unwrap();
    write(outside.path(), "human.md", HUMAN);
    let alias = root.join("linked-wiki");
    symlink(outside.path(), &alias).unwrap();
    let parent = alias.join("missing/deeper");

    // Reach the real create before examining the result or side effects. The
    // previous lexical fallback created this file through the ancestor alias.
    let result = create_file_at(&root, &parent.to_string_lossy(), "new.md");
    let created = optional_text(&outside.path().join("missing/deeper/new.md"));
    assert_eq!(
        std::fs::read_to_string(outside.path().join("human.md")).unwrap(),
        HUMAN
    );
    assert_eq!(std::fs::read_link(alias).unwrap(), outside.path());
    assert!(
        created.is_none(),
        "creation escaped into outside bytes: {created:?}; result={result:?}"
    );
    assert!(!outside.path().join("missing").exists());
    assert!(result.is_err(), "outside ancestor was admitted: {result:?}");
}

#[cfg(unix)]
#[test]
fn creation_mutation_folder_refuses_outside_ancestor_with_missing_descendants() {
    use std::os::unix::fs::symlink;
    let vault = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let root = vault.path().canonicalize().unwrap();
    write(outside.path(), "human.md", HUMAN);
    let alias = root.join("linked-wiki");
    symlink(outside.path(), &alias).unwrap();
    let parent = alias.join("missing/deeper");

    let result = create_folder_at(&root, &parent.to_string_lossy(), "new-folder");
    let created = outside.path().join("missing/deeper/new-folder").is_dir();
    assert_eq!(
        std::fs::read_to_string(outside.path().join("human.md")).unwrap(),
        HUMAN
    );
    assert_eq!(std::fs::read_link(alias).unwrap(), outside.path());
    assert!(
        !created,
        "creation made an outside directory; result={result:?}"
    );
    assert!(!outside.path().join("missing").exists());
    assert!(result.is_err(), "outside ancestor was admitted: {result:?}");
}

#[cfg(unix)]
#[test]
fn creation_mutation_file_refuses_raw_ancestor_with_missing_descendants() {
    use std::os::unix::fs::symlink;
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path().canonicalize().unwrap();
    write(&root, "raw/original.md", RAW);
    let alias = root.join("linked-wiki");
    let raw = root.join("raw");
    symlink(&raw, &alias).unwrap();
    let parent = alias.join("missing/deeper");

    let result = create_file_at(&root, &parent.to_string_lossy(), "new.md");
    let created = optional_text(&raw.join("missing/deeper/new.md"));
    assert_eq!(
        std::fs::read_to_string(raw.join("original.md")).unwrap(),
        RAW
    );
    assert_eq!(std::fs::read_link(alias).unwrap(), raw);
    assert!(
        created.is_none(),
        "creation wrote into raw through an alias: {created:?}; result={result:?}"
    );
    assert!(!raw.join("missing").exists());
    assert!(
        result.is_err(),
        "raw ancestor alias was admitted: {result:?}"
    );
}

#[cfg(unix)]
#[test]
fn creation_mutation_folder_refuses_raw_ancestor_with_missing_descendants() {
    use std::os::unix::fs::symlink;
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path().canonicalize().unwrap();
    write(&root, "raw/original.md", RAW);
    let alias = root.join("linked-wiki");
    let raw = root.join("raw");
    symlink(&raw, &alias).unwrap();
    let parent = alias.join("missing/deeper");

    let result = create_folder_at(&root, &parent.to_string_lossy(), "new-folder");
    let created = raw.join("missing/deeper/new-folder").is_dir();
    assert_eq!(
        std::fs::read_to_string(raw.join("original.md")).unwrap(),
        RAW
    );
    assert_eq!(std::fs::read_link(alias).unwrap(), raw);
    assert!(
        !created,
        "creation made a raw directory through an alias; result={result:?}"
    );
    assert!(!raw.join("missing").exists());
    assert!(
        result.is_err(),
        "raw ancestor alias was admitted: {result:?}"
    );
}

#[test]
fn creation_mutation_file_refuses_direct_raw_parent_without_changes() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path().canonicalize().unwrap();
    write(&root, "raw/original.md", RAW);
    let parent = root.join("raw");

    let result = create_file_at(&root, &parent.to_string_lossy(), "new.md");
    let created = optional_text(&parent.join("new.md"));
    assert_eq!(
        std::fs::read_to_string(parent.join("original.md")).unwrap(),
        RAW
    );
    assert!(
        created.is_none(),
        "ordinary file creation wrote into raw: {created:?}; result={result:?}"
    );
    assert!(result.is_err(), "raw parent was admitted: {result:?}");
    assert_eq!(std::fs::read_dir(parent).unwrap().count(), 1);
}

#[test]
fn creation_mutation_existing_targets_preserve_files_and_folder_children() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path().canonicalize().unwrap();
    write(&root, "wiki/human.md", HUMAN);
    write(&root, "wiki/occupied-folder/child.md", HUMAN);
    let parent = root.join("wiki");

    let file = create_file_at(&root, &parent.to_string_lossy(), "human.md");
    let folder = create_folder_at(&root, &parent.to_string_lossy(), "occupied-folder");
    let file_at_folder = create_file_at(&root, &parent.to_string_lossy(), "occupied-folder");
    let folder_at_file = create_folder_at(&root, &parent.to_string_lossy(), "human.md");
    for result in [file, folder, file_at_folder, folder_at_file] {
        assert!(
            result.is_err(),
            "an existing target was replaced: {result:?}"
        );
    }
    assert_eq!(
        std::fs::read_to_string(parent.join("human.md")).unwrap(),
        HUMAN
    );
    assert_eq!(
        std::fs::read_to_string(parent.join("occupied-folder/child.md")).unwrap(),
        HUMAN
    );
    assert_eq!(std::fs::read_dir(parent).unwrap().count(), 2);
}

#[cfg(unix)]
#[test]
fn creation_mutation_dangling_targets_preserve_their_links_and_absent_targets() {
    use std::os::unix::fs::symlink;
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path().canonicalize().unwrap();
    write(&root, "wiki/human.md", HUMAN);
    let parent = root.join("wiki");
    let missing_file = root.join("missing-file.md");
    let missing_folder = root.join("missing-folder");
    let file_link = parent.join("linked.md");
    let folder_link = parent.join("linked-folder");
    symlink(&missing_file, &file_link).unwrap();
    symlink(&missing_folder, &folder_link).unwrap();

    let file = create_file_at(&root, &parent.to_string_lossy(), "linked.md");
    let folder = create_folder_at(&root, &parent.to_string_lossy(), "linked-folder");
    assert!(file.is_err(), "a dangling file link was replaced: {file:?}");
    assert!(
        folder.is_err(),
        "a dangling folder link was replaced: {folder:?}"
    );
    assert_eq!(std::fs::read_link(file_link).unwrap(), missing_file);
    assert_eq!(std::fs::read_link(folder_link).unwrap(), missing_folder);
    assert!(!missing_file.exists());
    assert!(!missing_folder.exists());
    assert_eq!(
        std::fs::read_to_string(parent.join("human.md")).unwrap(),
        HUMAN
    );
}

#[test]
fn creation_mutation_invalid_names_leave_missing_parents_absent() {
    for name in [
        "",
        ".",
        "..",
        "../escape",
        "nested/file",
        "bad\\name",
        "bad\0name",
    ] {
        let vault = tempfile::tempdir().unwrap();
        let root = vault.path().canonicalize().unwrap();
        let parent = root.join("wiki/missing/deeper");

        let file = create_file_at(&root, &parent.to_string_lossy(), name);
        let folder = create_folder_at(&root, &parent.to_string_lossy(), name);
        assert!(
            file.is_err(),
            "invalid file name {name:?} was admitted: {file:?}"
        );
        assert!(
            folder.is_err(),
            "invalid folder name {name:?} was admitted: {folder:?}"
        );
        assert!(
            !root.join("wiki").exists(),
            "invalid name {name:?} materialized its parent"
        );
        assert_eq!(std::fs::read_dir(root).unwrap().count(), 0);
    }
}

#[test]
fn creation_mutation_nested_wiki_file_has_seeded_body_and_preserves_raw() {
    let vault = tempfile::tempdir().unwrap();
    // Keep the caller's lexical spelling to exercise supported temp-root aliases.
    let root = vault.path();
    write(root, "raw/original.md", RAW);
    let parent = root.join("wiki/missing/deeper");

    let created = create_file_at(root, &parent.to_string_lossy(), "Synthetic-topic.md").unwrap();
    let expected = root
        .canonicalize()
        .unwrap()
        .join("wiki/missing/deeper/Synthetic-topic.md");
    assert_eq!(Path::new(&created), expected);
    let text = std::fs::read_to_string(&created).unwrap();
    assert!(
        text.starts_with("---\ntype: concept\ntags:\ncreated: "),
        "{text}"
    );
    assert!(
        text.contains("\nconfidence: medium\nstatus: active\n---\n\n# Synthetic topic\n"),
        "{text}"
    );
    assert!(parent.is_dir());
    assert_eq!(
        std::fs::read_to_string(root.join("raw/original.md")).unwrap(),
        RAW
    );
}

#[test]
fn creation_mutation_annotations_folder_materializes_missing_wiki_parent() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    write(root, "raw/original.md", RAW);
    let parent = root.join("wiki");

    let created = create_folder_at(root, &parent.to_string_lossy(), ".annotations").unwrap();
    assert_eq!(
        Path::new(&created),
        root.canonicalize().unwrap().join("wiki/.annotations")
    );
    assert!(Path::new(&created).is_dir());
    assert!(parent.is_dir());
    assert_eq!(std::fs::read_dir(&created).unwrap().count(), 0);
    assert_eq!(
        std::fs::read_to_string(root.join("raw/original.md")).unwrap(),
        RAW
    );
}

#[test]
fn creation_mutation_absent_raw_namespace_scaffold_remains_supported() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    write(root, "human.md", HUMAN);

    let created = create_folder_at(root, &root.to_string_lossy(), "raw").unwrap();
    assert_eq!(
        Path::new(&created),
        root.canonicalize().unwrap().join("raw")
    );
    assert!(Path::new(&created).is_dir());
    assert_eq!(std::fs::read_dir(&created).unwrap().count(), 0);
    assert_eq!(
        std::fs::read_to_string(root.join("human.md")).unwrap(),
        HUMAN
    );
}

#[test]
fn creation_mutation_existing_raw_namespace_keeps_already_exists_error() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    write(root, "raw/original.md", RAW);

    let error = create_folder_at(root, &root.to_string_lossy(), "raw").unwrap_err();
    // Ingestion prepares this namespace even when it already exists and
    // handles only its established collision error before writing a source.
    assert!(error.starts_with("already exists:"), "{error}");
    assert_eq!(
        std::fs::read_to_string(root.join("raw/original.md")).unwrap(),
        RAW
    );
    assert_eq!(std::fs::read_dir(root.join("raw")).unwrap().count(), 1);
}

#[test]
fn creation_mutation_folder_refuses_direct_raw_parent_without_changes() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path().canonicalize().unwrap();
    write(&root, "raw/original.md", RAW);
    let parent = root.join("raw");

    let result = create_folder_at(&root, &parent.to_string_lossy(), "nested");
    let created = parent.join("nested").is_dir();
    assert!(
        !created,
        "ordinary folder creation changed raw; result={result:?}"
    );
    assert!(result.is_err(), "raw parent was admitted: {result:?}");
    assert_eq!(
        std::fs::read_to_string(parent.join("original.md")).unwrap(),
        RAW
    );
    assert_eq!(std::fs::read_dir(parent).unwrap().count(), 1);
}

#[test]
fn creation_mutation_raw_missing_descendants_remain_absent() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path().canonicalize().unwrap();
    write(&root, "raw/original.md", RAW);
    let raw = root.join("raw");
    let parent = raw.join("missing/deeper");

    let file = create_file_at(&root, &parent.to_string_lossy(), "new.md");
    let folder = create_folder_at(&root, &parent.to_string_lossy(), "new-folder");
    let created = optional_text(&parent.join("new.md"));
    assert!(
        created.is_none(),
        "creation wrote into missing raw descendants: {created:?}; result={file:?}"
    );
    assert!(
        !parent.join("new-folder").is_dir(),
        "creation made a raw descendant folder; result={folder:?}"
    );
    assert!(!raw.join("missing").exists());
    assert!(file.is_err(), "raw descendant file was admitted: {file:?}");
    assert!(
        folder.is_err(),
        "raw descendant folder was admitted: {folder:?}"
    );
    assert_eq!(
        std::fs::read_to_string(raw.join("original.md")).unwrap(),
        RAW
    );
    assert_eq!(std::fs::read_dir(raw).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn creation_mutation_raw_namespace_links_preserve_outside_and_dangling_targets() {
    use std::os::unix::fs::symlink;
    for is_dangling in [false, true] {
        let vault = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = vault.path().canonicalize().unwrap();
        write(&root, "human.md", HUMAN);
        write(outside.path(), "human.md", HUMAN);
        let target = if is_dangling {
            outside.path().join("missing-raw")
        } else {
            outside.path().to_path_buf()
        };
        let raw = root.join("raw");
        symlink(&target, &raw).unwrap();
        let missing_parent = raw.join("missing/deeper");

        let scaffold = create_folder_at(&root, &root.to_string_lossy(), "raw");
        let file = create_file_at(&root, &raw.to_string_lossy(), "new.md");
        let folder = create_folder_at(&root, &raw.to_string_lossy(), "nested");
        let descendant = create_folder_at(&root, &missing_parent.to_string_lossy(), "new-folder");
        for result in [scaffold, file, folder, descendant] {
            assert!(
                result.is_err(),
                "raw namespace link was admitted (dangling={is_dangling}): {result:?}"
            );
        }
        assert_eq!(std::fs::read_link(raw).unwrap(), target);
        assert!(optional_text(&target.join("new.md")).is_none());
        assert!(!target.join("nested").exists());
        assert!(!target.join("missing").exists());
        if is_dangling {
            assert!(!target.exists(), "a dangling raw target was materialized");
        }
        assert_eq!(
            std::fs::read_to_string(root.join("human.md")).unwrap(),
            HUMAN
        );
        assert_eq!(
            std::fs::read_to_string(outside.path().join("human.md")).unwrap(),
            HUMAN
        );
        assert_eq!(std::fs::read_dir(root).unwrap().count(), 2);
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 1);
    }
}

#[test]
fn creation_mutation_relative_wiki_parent_returns_canonical_path_and_seeded_body() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path();
    write(root, "raw/original.md", RAW);
    let parent = "wiki/missing/deeper";

    let created = create_file_at(root, parent, "Relative-topic.md").unwrap();
    let canonical_root = root.canonicalize().unwrap();
    assert_eq!(
        Path::new(&created),
        canonical_root.join("wiki/missing/deeper/Relative-topic.md")
    );
    let text = std::fs::read_to_string(&created).unwrap();
    assert!(
        text.starts_with("---\ntype: concept\ntags:\ncreated: "),
        "{text}"
    );
    assert!(
        text.contains("\nconfidence: medium\nstatus: active\n---\n\n# Relative topic\n"),
        "{text}"
    );
    let folder = create_folder_at(root, parent, "supported-folder").unwrap();
    assert_eq!(
        Path::new(&folder),
        canonical_root.join("wiki/missing/deeper/supported-folder")
    );
    assert!(Path::new(&folder).is_dir());
    assert_eq!(std::fs::read_to_string(&created).unwrap(), text);
    assert_eq!(
        std::fs::read_to_string(root.join("raw/original.md")).unwrap(),
        RAW
    );
}

#[test]
fn creation_mutation_case_insensitive_uppercase_raw_namespace_remains_immutable() {
    let vault = tempfile::tempdir().unwrap();
    let root = vault.path().canonicalize().unwrap();
    write(&root, "RAW/original.md", RAW);
    let parent = root.join("RAW");
    let lowercase_raw = root.join("raw");
    match lowercase_raw.canonicalize() {
        Ok(resolved) => assert_eq!(resolved, parent.canonicalize().unwrap()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            assert!(parent.is_dir());
            assert!(!lowercase_raw.exists());
            eprintln!(
                "case-insensitive raw namespace regression not applicable: synthetic filesystem keeps RAW and raw distinct"
            );
            return;
        }
        Err(error) => panic!("inspect synthetic raw namespace alias: {error}"),
    }

    // Execute both production commands before assertions so a file refusal
    // regression cannot prevent the folder mutation from being exercised.
    let file = create_file_at(&root, &parent.to_string_lossy(), "new.md");
    let folder = create_folder_at(&root, &parent.to_string_lossy(), "new-folder");
    let created = optional_text(&parent.join("new.md"));
    assert_eq!(
        std::fs::read_to_string(parent.join("original.md")).unwrap(),
        RAW
    );
    assert!(
        created.is_none(),
        "creation wrote into uppercase raw namespace: {created:?}; result={file:?}"
    );
    assert!(
        !parent.join("new-folder").exists(),
        "creation made an uppercase raw namespace folder; result={folder:?}"
    );
    assert!(file.is_err(), "raw namespace file was admitted: {file:?}");
    assert!(
        folder.is_err(),
        "raw namespace folder was admitted: {folder:?}"
    );
    assert_eq!(std::fs::read_dir(parent).unwrap().count(), 1);
}
