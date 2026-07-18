//! Import dedup ledger — makes re-importing the same export a no-op.
//!
//! Without it, importing a monthly ChatGPT export again re-creates every
//! `_inbox/` doc, so conversations already turned into wiki pages get ingested a
//! second time. The ledger records, per conversation, a `<source>:<id>` key and
//! a fingerprint of the rendered doc. On re-import a conversation is skipped when
//! its key is present with the SAME fingerprint; a changed one (a session that
//! grew, a chat continued) has a new fingerprint and imports again as an update.
//!
//! It lives at `<vault>/.memex/ledger.json`. A missing or corrupt file reads as
//! empty — the ledger is a cache, never a source of truth, so losing it costs a
//! round of re-imports, nothing more. The fingerprint is a non-cryptographic
//! DefaultHasher digest, matching the vault's other content fingerprints
//! (vault_revision, VectorCache) rather than pulling in a hashing crate.

use std::collections::hash_map::DefaultHasher;
use std::collections::BTreeMap;
use std::hash::{Hash, Hasher};
use std::path::Path;

/// A content fingerprint for the dedup key.
pub fn fingerprint(content: &str) -> String {
    let mut h = DefaultHasher::new();
    content.hash(&mut h);
    format!("{:016x}", h.finish())
}

#[derive(Default)]
pub struct Ledger {
    // key `<source>:<id>` → fingerprint. BTreeMap so the on-disk JSON is stable.
    entries: BTreeMap<String, String>,
}

impl Ledger {
    fn dir(vault_root: &Path) -> std::path::PathBuf {
        vault_root.join(".memex")
    }
    fn path(vault_root: &Path) -> std::path::PathBuf {
        Self::dir(vault_root).join("ledger.json")
    }

    /// Read the ledger. A missing or unparseable file is an empty ledger.
    pub fn load(vault_root: &Path) -> Ledger {
        let entries = std::fs::read_to_string(Self::path(vault_root))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Ledger { entries }
    }

    /// True when this key was already imported with the identical content.
    pub fn seen(&self, key: &str, fingerprint: &str) -> bool {
        self.entries.get(key).is_some_and(|f| f == fingerprint)
    }

    pub fn record(&mut self, key: String, fingerprint: String) {
        self.entries.insert(key, fingerprint);
    }

    /// Persist the ledger, creating `.memex/` (and a `.gitignore` so the whole
    /// directory stays out of a vault that is itself a git repo).
    pub fn save(&self, vault_root: &Path) -> Result<(), String> {
        let dir = Self::dir(vault_root);
        std::fs::create_dir_all(&dir).map_err(|e| format!("create .memex: {e}"))?;
        let ignore = dir.join(".gitignore");
        if !ignore.exists() {
            let _ = std::fs::write(&ignore, "*\n");
        }
        let json = serde_json::to_string_pretty(&self.entries)
            .map_err(|e| format!("serialize ledger: {e}"))?;
        std::fs::write(Self::path(vault_root), json).map_err(|e| format!("write ledger: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_stable_and_content_sensitive() {
        assert_eq!(fingerprint("hello"), fingerprint("hello"));
        assert_ne!(fingerprint("hello"), fingerprint("hello!"));
    }

    #[test]
    fn seen_only_when_key_and_fingerprint_both_match() {
        let mut l = Ledger::default();
        l.record("chatgpt:c1".into(), "abc".into());
        assert!(l.seen("chatgpt:c1", "abc"));
        assert!(!l.seen("chatgpt:c1", "def")); // content changed → not seen
        assert!(!l.seen("chatgpt:c2", "abc")); // different conversation
    }

    #[test]
    fn round_trips_through_disk_and_writes_a_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut l = Ledger::default();
        l.record("codex:s1".into(), "fp1".into());
        l.save(root).unwrap();

        assert_eq!(std::fs::read_to_string(root.join(".memex/.gitignore")).unwrap(), "*\n");
        let reloaded = Ledger::load(root);
        assert!(reloaded.seen("codex:s1", "fp1"));
    }

    #[test]
    fn a_missing_or_corrupt_ledger_reads_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!Ledger::load(dir.path()).seen("x", "y")); // missing
        std::fs::create_dir_all(dir.path().join(".memex")).unwrap();
        std::fs::write(dir.path().join(".memex/ledger.json"), "{not json").unwrap();
        assert!(!Ledger::load(dir.path()).seen("x", "y")); // corrupt
    }
}
