// End-to-end vault test. Walks the exact same code paths the UI calls
// through the IPC layer, in the same order: seed → list → write → parse
// links → build graph → scan provenance → mutate (create / rename /
// delete) → re-scan.

use memex_lib::index;
use memex_lib::parser;
use memex_lib::provenance;
use memex_lib::vault::{self, FileContent, FileNode, VaultMeta};
use std::fs;
use std::path::{Path, PathBuf};

fn temp_vault(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("memex-lifecycle-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn count_files(tree: &[FileNode]) -> usize {
    let mut n = 0;
    let mut stack: Vec<&FileNode> = tree.iter().collect();
    while let Some(node) = stack.pop() {
        match node {
            FileNode::File { .. } => n += 1,
            FileNode::Directory { children, .. } => {
                stack.extend(children.iter());
            }
        }
    }
    n
}

fn find_file_path(tree: &[FileNode], stem: &str) -> Option<String> {
    let mut stack: Vec<&FileNode> = tree.iter().collect();
    while let Some(node) = stack.pop() {
        match node {
            FileNode::File { name, path } => {
                if name.starts_with(stem) {
                    return Some(path.clone());
                }
            }
            FileNode::Directory { children, .. } => stack.extend(children.iter()),
        }
    }
    None
}

#[test]
fn full_lifecycle_seed_to_graph_to_mutate() {
    let dir = temp_vault("full");

    // ---- 1. open_vault on a brand new directory ----
    let meta: VaultMeta = vault::open_vault(dir.to_str().unwrap()).unwrap();
    assert!(meta.path.ends_with("full") || meta.path.contains("memex-lifecycle"));
    assert!(!meta.name.is_empty());

    // ---- 2. create_folder + create_file mimicking the sidebar's "+" ----
    let wiki_path = vault::create_folder(&meta.path, "wiki").unwrap();
    assert!(Path::new(&wiki_path).is_dir());
    let raw_path = vault::create_folder(&meta.path, "raw").unwrap();
    assert!(Path::new(&raw_path).is_dir());

    let alpha = vault::create_file(&wiki_path, "alpha.md", "").unwrap();
    let beta = vault::create_file(&wiki_path, "beta.md", "").unwrap();
    let src1 = vault::create_file(&raw_path, "src-paper.md", "").unwrap();

    // Name validation: traversal / slashes / empty / dotdot all rejected.
    assert!(vault::create_file(&meta.path, "../escape.md", "").is_err());
    assert!(vault::create_file(&meta.path, "", "").is_err());
    assert!(vault::create_file(&meta.path, "..", "").is_err());
    assert!(vault::create_folder(&meta.path, "with/slash").is_err());

    // ---- 3. write_file with body that has frontmatter + wikilinks ----
    vault::write_file(
        &alpha,
        "---\ntitle: Alpha\ntype: concept\ntags: [foo, bar]\n---\n\
         # Alpha\n\nLink to [[beta]] and source [[src-paper]][^src-paper].\n\n\
         [^src-paper]: A claim.\n",
    )
    .unwrap();
    vault::write_file(
        &beta,
        "---\ntitle: Beta\ntype: concept\n---\n\n\
         # Beta\n\nReferences back to [[alpha]] for context.\n",
    )
    .unwrap();
    vault::write_file(&src1, "raw text of a paper\n").unwrap();

    // ---- 4. list_files reflects the new tree ----
    let tree = vault::list_files(&meta.path).unwrap();
    assert_eq!(count_files(&tree), 3, "expected 3 md files");
    let alpha_in_tree = find_file_path(&tree, "alpha").expect("alpha in tree");
    assert!(alpha_in_tree.ends_with("alpha.md"));

    // ---- 5. read_file roundtrips frontmatter ----
    let fc: FileContent = vault::read_file(&alpha).unwrap();
    assert!(fc.content.contains("# Alpha"));
    assert_eq!(fc.frontmatter["title"], "Alpha");
    assert_eq!(fc.frontmatter["type"], "concept");

    // ---- 6. parser extracts wikilinks ----
    let links = parser::parse_links(&alpha).unwrap();
    assert_eq!(links, vec!["beta".to_string(), "src-paper".to_string()]);

    // ---- 7. build_link_graph resolves edges + collects tags ----
    let adj = index::build_link_graph(&meta.path).unwrap();
    assert!(
        adj.forward
            .iter()
            .any(|(_, t)| t.iter().any(|p| p.ends_with("beta.md"))),
        "expected alpha→beta resolved edge"
    );
    assert!(
        adj.backward
            .iter()
            .any(|(_, s)| s.iter().any(|p| p.ends_with("alpha.md"))),
        "expected backward link to alpha"
    );
    assert!(
        adj.tags.values().any(|v| v.contains(&"foo".to_string())),
        "expected tag 'foo' from alpha frontmatter"
    );

    // ---- 8. scan_provenance counts claims ----
    let rows = provenance::scan_provenance(&meta.path).unwrap();
    let alpha_row = rows
        .iter()
        .find(|r| r.path.ends_with("alpha.md"))
        .expect("alpha row");
    assert!(alpha_row.total >= 1);
    assert!(
        alpha_row.cited >= 1,
        "alpha has a [^src-*] citation so cited > 0"
    );

    // ---- 9. rename_path keeps everything wired ----
    let new_path = vault::rename_path(&beta, "gamma.md").unwrap();
    assert!(Path::new(&new_path).is_file());
    assert!(!Path::new(&beta).exists());
    let tree2 = vault::list_files(&meta.path).unwrap();
    assert!(find_file_path(&tree2, "gamma").is_some());
    assert!(find_file_path(&tree2, "beta").is_none());

    // ---- 10. delete_path removes a file ----
    vault::delete_path(&src1).unwrap();
    assert!(!Path::new(&src1).exists());
    let tree3 = vault::list_files(&meta.path).unwrap();
    assert_eq!(count_files(&tree3), 2, "expected 2 files after delete");

    // ---- 11. delete_path can remove a whole folder ----
    vault::delete_path(&raw_path).unwrap();
    assert!(!Path::new(&raw_path).exists());
}

#[test]
fn ensure_default_vault_idempotency() {
    // Override HOME so we don't poke the real user's Documents.
    let fake_home = temp_vault("home");
    let prev_home = std::env::var("HOME").ok();
    unsafe {
        std::env::set_var("HOME", &fake_home);
    }
    let path1 = vault::ensure_default_vault().unwrap();
    // User edits the welcome.
    fs::write(format!("{path1}/welcome.md"), "MY OWN WELCOME\n").unwrap();
    // Re-call.
    let path2 = vault::ensure_default_vault().unwrap();
    assert_eq!(path1, path2);
    let after = fs::read_to_string(format!("{path1}/welcome.md")).unwrap();
    assert_eq!(after, "MY OWN WELCOME\n", "must not clobber user edit");
    // Restore HOME so other tests aren't affected.
    if let Some(h) = prev_home {
        unsafe {
            std::env::set_var("HOME", h);
        }
    } else {
        unsafe {
            std::env::remove_var("HOME");
        }
    }
}

#[test]
fn write_file_is_atomic_replace() {
    // Establish that a partially-failed write doesn't leave the target
    // truncated. We can't easily induce a failure, but we can assert the
    // tempfile-then-rename behaviour leaves no .tmp residue.
    let dir = temp_vault("atomic");
    let target = dir.join("doc.md");
    fs::write(&target, "original\n").unwrap();
    vault::write_file(target.to_str().unwrap(), "replaced\n").unwrap();
    let contents = fs::read_to_string(&target).unwrap();
    assert_eq!(contents, "replaced\n");
    // No leftover .memex-tmp-* files in the directory.
    let leftover: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_str()
                .map(|s| s.starts_with(".memex-tmp-"))
                .unwrap_or(false)
        })
        .collect();
    assert!(leftover.is_empty(), "tempfile residue left behind");
}
