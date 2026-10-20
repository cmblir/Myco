//! Declarative plugins (block editor roadmap, stage 5): every folder under
//! `<vault>/.myco/plugins/` holds a `manifest.json` that the frontend checks
//! (app/src/lib/plugins.ts). This side only lists and reads those files: no
//! plugin code runs, nothing is written, and nothing outside
//! `.myco/plugins/` is read — a plugin folder or manifest that is a link to
//! somewhere else (raw/, outside the vault) is refused, as is a
//! `.myco/plugins` that is itself a link.

use serde::Serialize;
use std::path::Path;

/// Bigger than any real manifest; a larger file is refused unread.
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;

#[derive(Debug, Serialize, PartialEq)]
pub struct PluginFile {
    /// The plugin's folder name (the manifest's `id` must match it).
    pub dir: String,
    /// `manifest.json`'s text; `None` when it was not read (see `error`).
    pub raw: Option<String>,
    /// Why it was not read: "missing", "outside" (a link out of the plugin's
    /// folder), "too_large" or "unreadable" (not UTF-8, not a file).
    pub error: Option<&'static str>,
}

/// Every plugin folder's manifest, sorted by folder name. Dot folders and
/// plain files are skipped; no `.myco/plugins/` = none.
pub fn list_manifests(root: &Path) -> Vec<PluginFile> {
    let base = root.join(".myco").join("plugins");
    // `root` is canonical (open_vault), so a base that canonicalizes to
    // anything else is a link: list nothing rather than follow it.
    if base.canonicalize().ok().as_deref() != Some(base.as_path()) {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(&base) else {
        return Vec::new();
    };
    let mut out: Vec<PluginFile> = entries
        .flatten()
        .filter_map(|e| {
            let dir = e.file_name().to_str()?.to_string();
            // file_type does not follow links: a linked folder is listed
            // (and refused) rather than silently hidden.
            let kind = e.file_type().ok()?;
            if dir.starts_with('.') || !(kind.is_dir() || kind.is_symlink()) {
                return None;
            }
            Some(read_manifest(&e.path(), dir))
        })
        .collect();
    out.sort_by(|a, b| a.dir.cmp(&b.dir));
    out
}

fn read_manifest(folder: &Path, dir: String) -> PluginFile {
    let file = folder.join("manifest.json");
    let refused = |error| PluginFile {
        dir: dir.clone(),
        raw: None,
        error: Some(error),
    };
    // The only path read is `.myco/plugins/<dir>/manifest.json` with no link
    // on the way: its canonical form must be itself.
    match file.canonicalize() {
        Ok(c) if c == file => {}
        Ok(_) => return refused("outside"),
        Err(_) if folder.canonicalize().ok().as_deref() != Some(folder) => {
            return refused("outside")
        }
        Err(_) => return refused("missing"),
    }
    match std::fs::metadata(&file) {
        Ok(m) if !m.is_file() => return refused("unreadable"),
        Ok(m) if m.len() > MAX_MANIFEST_BYTES => return refused("too_large"),
        Ok(_) => {}
        Err(_) => return refused("unreadable"),
    }
    match std::fs::read_to_string(&file) {
        Ok(raw) => PluginFile {
            dir,
            raw: Some(raw),
            error: None,
        },
        Err(_) => refused("unreadable"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;

    fn vault() -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        // macOS: /var → /private/var; open_vault hands us the canonical root.
        let root = dir.path().canonicalize().unwrap();
        fs::create_dir_all(root.join(".myco/plugins")).unwrap();
        fs::create_dir_all(root.join("raw")).unwrap();
        (dir, root)
    }

    fn plugin(root: &Path, id: &str, manifest: &str) {
        let d = root.join(".myco/plugins").join(id);
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("manifest.json"), manifest).unwrap();
    }

    fn found(root: &Path) -> Vec<(String, Option<String>, Option<&'static str>)> {
        list_manifests(root)
            .into_iter()
            .map(|p| (p.dir, p.raw, p.error))
            .collect()
    }

    #[test]
    fn lists_each_folders_manifest_sorted() {
        let (_d, root) = vault();
        plugin(&root, "zeta", r#"{"id":"zeta"}"#);
        plugin(&root, "alpha", r#"{"id":"alpha"}"#);
        fs::create_dir_all(root.join(".myco/plugins/empty")).unwrap();
        fs::create_dir_all(root.join(".myco/plugins/.hidden")).unwrap();
        fs::write(root.join(".myco/plugins/README.md"), "not a plugin").unwrap();
        assert_eq!(
            found(&root),
            [
                ("alpha".into(), Some(r#"{"id":"alpha"}"#.into()), None),
                ("empty".into(), None, Some("missing")),
                ("zeta".into(), Some(r#"{"id":"zeta"}"#.into()), None),
            ]
        );
    }

    #[test]
    fn no_plugins_folder_lists_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert!(list_manifests(&dir.path().canonicalize().unwrap()).is_empty());
    }

    #[test]
    fn refuses_links_into_raw_and_out_of_the_vault() {
        let (_d, root) = vault();
        let outside = tempfile::tempdir().unwrap();
        let secret = r#"{"id":"leak"}"#;
        fs::write(root.join("raw/manifest.json"), secret).unwrap();
        fs::write(outside.path().join("manifest.json"), secret).unwrap();
        // A plugin folder that is raw/, one that is outside the vault, and a
        // real folder whose manifest.json links into raw/.
        symlink(root.join("raw"), root.join(".myco/plugins/in-raw")).unwrap();
        symlink(outside.path(), root.join(".myco/plugins/away")).unwrap();
        let d = root.join(".myco/plugins/linked");
        fs::create_dir_all(&d).unwrap();
        symlink(root.join("raw/manifest.json"), d.join("manifest.json")).unwrap();
        // A link to a folder with no manifest is still refused as a link.
        let empty = tempfile::tempdir().unwrap();
        symlink(empty.path(), root.join(".myco/plugins/nothing")).unwrap();
        assert_eq!(
            found(&root),
            [
                ("away".into(), None, Some("outside")),
                ("in-raw".into(), None, Some("outside")),
                ("linked".into(), None, Some("outside")),
                ("nothing".into(), None, Some("outside")),
            ]
        );
    }

    #[test]
    fn a_linked_plugins_folder_lists_nothing() {
        let (_d, root) = vault();
        fs::remove_dir(root.join(".myco/plugins")).unwrap();
        fs::create_dir_all(root.join("raw/p")).unwrap();
        fs::write(root.join("raw/p/manifest.json"), "{}").unwrap();
        symlink(root.join("raw"), root.join(".myco/plugins")).unwrap();
        assert!(list_manifests(&root).is_empty());
    }

    #[test]
    fn refuses_a_huge_or_binary_manifest() {
        let (_d, root) = vault();
        plugin(&root, "big", &"x".repeat(MAX_MANIFEST_BYTES as usize + 1));
        let d = root.join(".myco/plugins/bin");
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("manifest.json"), [0xff, 0xfe, 0x00]).unwrap();
        fs::create_dir_all(root.join(".myco/plugins/dir/manifest.json")).unwrap();
        assert_eq!(
            found(&root),
            [
                ("big".into(), None, Some("too_large")),
                ("bin".into(), None, Some("unreadable")),
                ("dir".into(), None, Some("unreadable")),
            ]
        );
    }
}
