//! `.myco/wikify-pending.json` — transcripts the MCP `import_conversation`
//! tool wrote to `raw/conversations/` that no wiki page cites yet. The MCP
//! `wikify_pending` tool hands them to the client oldest first and checks
//! them off by key. Its own file, not a key in `ledger.json`: the ledger
//! drops unknown keys on save, so anything added there would be erased by
//! the next in-app import.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingItem {
    /// The ledger key, `<source>:<conversation_id>`.
    pub key: String,
    /// Vault-relative, e.g. `raw/conversations/chatgpt/abc123.md`.
    pub raw_path: String,
    /// The `[^src-*]` slug a page citing this transcript uses.
    pub src_slug: String,
    pub title: String,
    /// `YYYY-MM-DD` the import happened.
    pub imported: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Pending {
    #[serde(default)]
    pub pending: Vec<PendingItem>,
    #[serde(default)]
    pub done_count: u64,
}

impl Pending {
    pub fn path(vault_root: &Path) -> PathBuf {
        crate::vault_dir::dir(vault_root).join("wikify-pending.json")
    }

    /// A missing or corrupt file reads as empty — this is a queue of
    /// reminders, not a source of truth.
    pub fn load(vault_root: &Path) -> Pending {
        std::fs::read_to_string(Self::path(vault_root))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, vault_root: &Path) -> Result<(), String> {
        let path = Self::path(vault_root);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("create .myco: {e}"))?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| format!("serialize: {e}"))?;
        std::fs::write(&path, json).map_err(|e| format!("write wikify-pending.json: {e}"))
    }

    /// Queue `item`, replacing an older entry with the same key (a re-import
    /// under the same id moves it to the back, it does not duplicate it).
    pub fn push(&mut self, item: PendingItem) {
        self.pending.retain(|p| p.key != item.key);
        self.pending.push(item);
    }

    /// Check `keys` off. Returns how many were actually pending.
    pub fn done(&mut self, keys: &[String]) -> usize {
        let before = self.pending.len();
        self.pending.retain(|p| !keys.contains(&p.key));
        let removed = before - self.pending.len();
        self.done_count += removed as u64;
        removed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(key: &str) -> PendingItem {
        PendingItem {
            key: key.into(),
            raw_path: format!("raw/conversations/{}.md", key.replace(':', "/")),
            src_slug: "src-x".into(),
            title: key.into(),
            imported: "2026-09-06".into(),
        }
    }

    #[test]
    fn push_dedups_by_key_and_done_counts_only_real_removals() {
        let mut q = Pending::default();
        q.push(item("chatgpt:a"));
        q.push(item("chatgpt:b"));
        q.push(item("chatgpt:a")); // re-import: moved to the back, not doubled
        assert_eq!(
            q.pending.iter().map(|p| p.key.as_str()).collect::<Vec<_>>(),
            vec!["chatgpt:b", "chatgpt:a"]
        );
        assert_eq!(q.done(&["chatgpt:a".into(), "nope".into()]), 1);
        assert_eq!(q.done_count, 1);
        assert_eq!(q.pending.len(), 1);
    }

    #[test]
    fn round_trips_through_disk_and_a_missing_or_corrupt_file_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert!(Pending::load(root).pending.is_empty());
        let mut q = Pending::default();
        q.push(item("codex:s1"));
        q.done_count = 4;
        q.save(root).unwrap();
        let back = Pending::load(root);
        assert_eq!(back.pending, vec![item("codex:s1")]);
        assert_eq!(back.done_count, 4);
        std::fs::write(Pending::path(root), "{not json").unwrap();
        assert!(Pending::load(root).pending.is_empty());
    }
}
