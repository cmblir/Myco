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

use serde::{Deserialize, Serialize};
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

/// What a session file looked like the last time it imported cleanly. On a
/// re-sweep, a file whose (mtime, len) still match is skipped WITHOUT reading or
/// re-parsing it — the expensive part — so re-importing thousands of sessions is
/// near-instant once the first sweep is done. `convs` is how many conversations
/// it yielded, reported back as "already imported" so the tally stays honest.
#[derive(Serialize, Deserialize, Clone, Default)]
pub struct FileStamp {
    pub mtime_ns: u64,
    pub len: u64,
    pub convs: usize,
}

/// On-disk shape once the ledger tracks files too. Structurally disjoint from the
/// legacy flat map (string values vs object values), so `load` can tell them
/// apart and upgrade in place without dropping the conversation dedup.
#[derive(Deserialize, Default)]
struct OnDisk {
    #[serde(default)]
    entries: BTreeMap<String, String>,
    #[serde(default)]
    files: BTreeMap<String, FileStamp>,
}

#[derive(Serialize)]
struct OnDiskRef<'a> {
    entries: &'a BTreeMap<String, String>,
    files: &'a BTreeMap<String, FileStamp>,
}

#[derive(Default)]
pub struct Ledger {
    // key `<source>:<id>` → fingerprint. BTreeMap so the on-disk JSON is stable.
    entries: BTreeMap<String, String>,
    // absolute file path → its last clean import stamp.
    files: BTreeMap<String, FileStamp>,
}

impl Ledger {
    fn dir(vault_root: &Path) -> std::path::PathBuf {
        vault_root.join(".memex")
    }
    fn path(vault_root: &Path) -> std::path::PathBuf {
        Self::dir(vault_root).join("ledger.json")
    }

    /// Read the ledger. A missing or unparseable file is an empty ledger. A
    /// legacy flat-map ledger (before file tracking) is upgraded in place, so
    /// existing users keep their conversation dedup across the format bump.
    pub fn load(vault_root: &Path) -> Ledger {
        let Ok(s) = std::fs::read_to_string(Self::path(vault_root)) else {
            return Ledger::default();
        };
        // Legacy flat map first: the new format's object values make it fail
        // this parse, so the two never collide.
        if let Ok(entries) = serde_json::from_str::<BTreeMap<String, String>>(&s) {
            return Ledger {
                entries,
                files: BTreeMap::new(),
            };
        }
        match serde_json::from_str::<OnDisk>(&s) {
            Ok(d) => Ledger {
                entries: d.entries,
                files: d.files,
            },
            Err(_) => Ledger::default(),
        }
    }

    /// True when this key was already imported with the identical content.
    pub fn seen(&self, key: &str, fingerprint: &str) -> bool {
        self.entries.get(key).is_some_and(|f| f == fingerprint)
    }

    pub fn record(&mut self, key: String, fingerprint: String) {
        self.entries.insert(key, fingerprint);
    }

    /// If this file imported cleanly before and hasn't changed since (same
    /// mtime + length), return how many conversations it yielded — the caller
    /// skips reading it and counts those as already imported.
    pub fn file_convs(&self, path: &str, mtime_ns: u64, len: u64) -> Option<usize> {
        self.files
            .get(path)
            .filter(|s| s.mtime_ns == mtime_ns && s.len == len)
            .map(|s| s.convs)
    }

    pub fn record_file(&mut self, path: String, mtime_ns: u64, len: u64, convs: usize) {
        self.files.insert(
            path,
            FileStamp {
                mtime_ns,
                len,
                convs,
            },
        );
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
        let on_disk = OnDiskRef {
            entries: &self.entries,
            files: &self.files,
        };
        let json = serde_json::to_string_pretty(&on_disk)
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

    #[test]
    fn file_convs_matches_only_on_identical_mtime_and_len() {
        let mut l = Ledger::default();
        l.record_file("/s/a.jsonl".into(), 111, 2048, 3);
        assert_eq!(l.file_convs("/s/a.jsonl", 111, 2048), Some(3));
        assert_eq!(l.file_convs("/s/a.jsonl", 999, 2048), None); // touched
        assert_eq!(l.file_convs("/s/a.jsonl", 111, 4096), None); // grew
        assert_eq!(l.file_convs("/s/other.jsonl", 111, 2048), None); // unknown
    }

    #[test]
    fn file_stamps_round_trip_alongside_entries() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut l = Ledger::default();
        l.record("codex:s1".into(), "fp1".into());
        l.record_file("/s/a.jsonl".into(), 111, 2048, 3);
        l.save(root).unwrap();

        let reloaded = Ledger::load(root);
        assert!(reloaded.seen("codex:s1", "fp1"));
        assert_eq!(reloaded.file_convs("/s/a.jsonl", 111, 2048), Some(3));
    }

    #[test]
    fn a_legacy_flat_map_ledger_upgrades_and_keeps_dedup() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".memex")).unwrap();
        // Pre-file-tracking ledger: a bare `{key: fingerprint}` object.
        std::fs::write(
            root.join(".memex/ledger.json"),
            r#"{"chatgpt:c1":"abc","codex:s2":"def"}"#,
        )
        .unwrap();

        let mut l = Ledger::load(root);
        assert!(l.seen("chatgpt:c1", "abc")); // dedup preserved on upgrade
        assert!(l.seen("codex:s2", "def"));
        assert_eq!(l.file_convs("/s/a.jsonl", 1, 1), None); // no stamps yet

        // Saving now writes the new shape without losing the old entries.
        l.record_file("/s/a.jsonl".into(), 5, 10, 1);
        l.save(root).unwrap();
        let reloaded = Ledger::load(root);
        assert!(reloaded.seen("chatgpt:c1", "abc"));
        assert_eq!(reloaded.file_convs("/s/a.jsonl", 5, 10), Some(1));
    }
}
