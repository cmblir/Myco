//! Per-page open tracking: `.myco/page-opens.json`, vault-relative path ->
//! unix seconds of the last open. Written by the `record_page_open` command on
//! every page open; read by resurface dormancy (Q4 item 10).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Past this many entries, `record` drops entries whose file no longer exists
/// — a bound without a schedule.
const PRUNE_CAP: usize = 2048;

fn file_path(root: &Path) -> PathBuf {
    crate::vault_dir::dir(root).join("page-opens.json")
}

/// Load the map. Missing or corrupt file => empty.
pub fn load(root: &Path) -> HashMap<String, i64> {
    std::fs::read_to_string(file_path(root))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Record `rel` opened at `now`. Atomic tmp+rename (`distill::state_save`
/// idiom). When the map exceeds [`PRUNE_CAP`], entries whose file no longer
/// exists are pruned.
pub fn record(root: &Path, rel: &str, now: i64) -> Result<(), String> {
    let mut map = load(root);
    map.insert(rel.to_string(), now);
    if map.len() > PRUNE_CAP {
        map.retain(|r, _| root.join(r).is_file());
    }
    let d = crate::vault_dir::dir(root);
    std::fs::create_dir_all(&d)
        .map_err(|e| format!("create {} dir: {e}", crate::vault_dir::DIR_NAME))?;
    let raw = serde_json::to_string(&map).map_err(|e| format!("serialize page-opens: {e}"))?;
    let tmp = d.join(".page-opens.json.tmp");
    std::fs::write(&tmp, raw.as_bytes()).map_err(|e| format!("write tmp: {e}"))?;
    std::fs::rename(&tmp, file_path(root)).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("myco-pageopens-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn record_and_load_roundtrip() {
        let root = vault("roundtrip");
        record(&root, "wiki/a.md", 100).unwrap();
        record(&root, "wiki/b.md", 200).unwrap();
        // Re-record: the later timestamp wins.
        record(&root, "wiki/a.md", 300).unwrap();

        let map = load(&root);
        assert_eq!(map.get("wiki/a.md"), Some(&300));
        assert_eq!(map.get("wiki/b.md"), Some(&200));
        assert_eq!(map.len(), 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn load_on_missing_file_is_empty() {
        let root = vault("missing");
        assert!(load(&root).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn record_prunes_missing_files_past_cap() {
        let root = vault("prune");
        // Seed past the cap by direct file write; every entry points at a
        // file that does not exist.
        let seeded: HashMap<String, i64> = (0..=PRUNE_CAP)
            .map(|i| (format!("wiki/gone-{i}.md"), 1))
            .collect();
        let d = crate::vault_dir::dir(&root);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(
            d.join("page-opens.json"),
            serde_json::to_string(&seeded).unwrap(),
        )
        .unwrap();
        // One real file, recorded once.
        std::fs::create_dir_all(root.join("wiki")).unwrap();
        std::fs::write(root.join("wiki/real.md"), "# real").unwrap();
        record(&root, "wiki/real.md", 42).unwrap();

        let map = load(&root);
        assert_eq!(map.get("wiki/real.md"), Some(&42));
        assert_eq!(map.len(), 1, "entries for missing files were pruned");
        let _ = std::fs::remove_dir_all(&root);
    }
}
