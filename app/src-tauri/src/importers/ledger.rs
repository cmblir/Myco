//! Import dedup ledger — makes re-importing the same export a no-op.
//!
//! Without it, importing a monthly ChatGPT export again re-creates every
//! `_inbox/` doc, so conversations already turned into wiki pages get ingested a
//! second time. The ledger records, per conversation, a `<source>:<id>` key and
//! a fingerprint of the rendered doc. On re-import a conversation is skipped when
//! its key is present with the SAME fingerprint; a changed one (a session that
//! grew, a chat continued) has a new fingerprint and imports again as an update.
//!
//! A second index keys on the BODY alone (`body_hash`: the text after the
//! frontmatter block, NFC-normalised, whitespace-collapsed). Measured on the
//! owner's vault, 1,473 session files held only 719 distinct bodies — the top
//! two bodies had 269 and 267 copies each, an agent's `[[TASK_DONE]]`
//! boilerplate re-exported under a fresh session id every run. The key index
//! cannot see that (every copy has its own `<source>:<id>`), so a body already
//! recorded under ANOTHER key is refused and counted in `duplicates`.
//!
//! It lives at `<vault>/.myco/ledger.json`. A missing or corrupt file reads as
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

/// The dedup key for a doc's CONTENT regardless of its provenance: the text
/// after the frontmatter block, NFC-normalised, whitespace-collapsed. Two
/// exports of the same conversation under different ids (or with a different
/// `created:`) hash equal; a changed transcript does not.
pub fn body_hash(doc: &str) -> String {
    let body = crate::norm::nfc(strip_frontmatter(doc));
    let mut h = DefaultHasher::new();
    // `str::hash` terminates each token, so "a b" and "ab" stay distinct while
    // runs of any whitespace collapse to one boundary.
    for token in body.split_whitespace() {
        token.hash(&mut h);
    }
    format!("{:016x}", h.finish())
}

/// Everything after a leading `---` YAML block (the shape `to_inbox_doc`
/// writes); the whole doc when there is none. A byte scan, not a YAML parse:
/// the hash must be stable on frontmatter a parser would reject.
pub fn strip_frontmatter(doc: &str) -> &str {
    let Some(rest) = doc.strip_prefix("---\n") else {
        return doc;
    };
    match rest.find("\n---") {
        Some(i) => rest[i + 4..].trim_start_matches(['\r', '\n']),
        None => doc,
    }
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
    #[serde(default)]
    bodies: BTreeMap<String, String>,
    #[serde(default)]
    duplicates: u64,
}

#[derive(Serialize)]
struct OnDiskRef<'a> {
    entries: &'a BTreeMap<String, String>,
    files: &'a BTreeMap<String, FileStamp>,
    bodies: &'a BTreeMap<String, String>,
    duplicates: u64,
}

#[derive(Default)]
pub struct Ledger {
    // key `<source>:<id>` → fingerprint. BTreeMap so the on-disk JSON is stable.
    entries: BTreeMap<String, String>,
    // absolute file path → its last clean import stamp.
    files: BTreeMap<String, FileStamp>,
    // `body_hash` → the key that first imported that body.
    bodies: BTreeMap<String, String>,
    // Conversations refused because their body was already here under another
    // key — how much boilerplate the import did NOT write.
    duplicates: u64,
}

impl Ledger {
    fn dir(vault_root: &Path) -> std::path::PathBuf {
        crate::vault_dir::dir(vault_root)
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
                ..Ledger::default()
            };
        }
        match serde_json::from_str::<OnDisk>(&s) {
            Ok(d) => Ledger {
                entries: d.entries,
                files: d.files,
                bodies: d.bodies,
                duplicates: d.duplicates,
            },
            Err(_) => Ledger::default(),
        }
    }

    /// True when this key was already imported with the identical content.
    pub fn seen(&self, key: &str, fingerprint: &str) -> bool {
        self.entries.get(key).is_some_and(|f| f == fingerprint)
    }

    /// True when this key was recorded before, whatever its content. Used by
    /// the web clipper, which dedups on the page URL alone: a re-clip with a
    /// different highlight renders a different doc, so a fingerprint comparison
    /// would not recognise it as the same page.
    pub fn seen_key(&self, key: &str) -> bool {
        self.entries.contains_key(key)
    }

    /// The value recorded for `key`. The clipper stores the file name its
    /// clip wrote, so it can ask whether that doc is still in `_inbox/`
    /// before calling a re-clip a duplicate.
    pub fn entry(&self, key: &str) -> Option<&String> {
        self.entries.get(key)
    }

    pub fn record(&mut self, key: String, fingerprint: String) {
        self.entries.insert(key, fingerprint);
    }

    /// True when this body is already recorded under a DIFFERENT key — the
    /// same conversation re-exported with a new id. The same key re-importing
    /// its own body is the `seen` case, not a duplicate.
    pub fn seen_body(&self, body_hash: &str, key: &str) -> bool {
        self.bodies.get(body_hash).is_some_and(|k| k != key)
    }

    /// Claim a body for `key`. First claim wins: a later key with the same
    /// body is the duplicate, so an existing owner is never overwritten.
    pub fn record_body(&mut self, body_hash: String, key: &str) {
        self.bodies
            .entry(body_hash)
            .or_insert_with(|| key.to_string());
    }

    /// Count `n` conversations refused as body duplicates.
    pub fn note_duplicates(&mut self, n: usize) {
        self.duplicates += n as u64;
    }

    /// How many conversations this ledger has refused as body duplicates.
    pub fn duplicates(&self) -> u64 {
        self.duplicates
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

    /// Persist the ledger, creating `.myco/` (and a `.gitignore` so the whole
    /// directory stays out of a vault that is itself a git repo).
    pub fn save(&self, vault_root: &Path) -> Result<(), String> {
        let dir = Self::dir(vault_root);
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("create {}: {e}", crate::vault_dir::DIR_NAME))?;
        let ignore = dir.join(".gitignore");
        if !ignore.exists() {
            let _ = std::fs::write(&ignore, "*\n");
        }
        let on_disk = OnDiskRef {
            entries: &self.entries,
            files: &self.files,
            bodies: &self.bodies,
            duplicates: self.duplicates,
        };
        let json =
            serde_json::to_string_pretty(&on_disk).map_err(|e| format!("serialize ledger: {e}"))?;
        std::fs::write(Self::path(vault_root), json).map_err(|e| format!("write ledger: {e}"))
    }
}

/// The owner's most-copied session (269 + 267 copies of its two variants) as
/// `to_inbox_doc` renders it: an agent's kickoff prompt plus
/// `[User] hi [lead] done [[TASK_DONE]]`, re-exported under a fresh id and
/// `created:` every run, 1,013 bytes each. The prompt text is synthetic; the
/// shape, the size and the varying frontmatter match the measurement. Shared
/// with the import and harvest tests.
#[cfg(test)]
pub(crate) fn boilerplate_doc(id: &str, created: i64) -> String {
    const PROMPT: &str =
        "You are the lead agent for this workspace. Read the task queue, pick the \
        highest-priority item that is not claimed, claim it, and work it to completion. When it \
        is done, append a one-line summary to the run log and reply with the exact token below so \
        the orchestrator can advance the queue. Do not start a second item in the same turn.";
    const TAIL: &str = "\n\ndone [[TASK_DONE]]\n";
    let head =
        format!("---\nsource: claude-code\nconversation_id: {id}\ncreated: {created}\n---\n\n");
    let mut body = format!("# lead\n\n**User:**\n\nhi\n\n**Assistant:**\n\n{PROMPT}");
    let pad = 1_013 - head.len() - body.len() - TAIL.len();
    let filler =
        " Never push. Never delete. Report partial progress honestly.".repeat(pad / 10 + 1);
    body.push_str(&filler[..pad]);
    body.push_str(TAIL);
    format!("{head}{body}")
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

        assert_eq!(
            std::fs::read_to_string(root.join(".myco/.gitignore")).unwrap(),
            "*\n"
        );
        let reloaded = Ledger::load(root);
        assert!(reloaded.seen("codex:s1", "fp1"));
    }

    #[test]
    fn a_missing_or_corrupt_ledger_reads_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!Ledger::load(dir.path()).seen("x", "y")); // missing
        std::fs::create_dir_all(dir.path().join(".myco")).unwrap();
        std::fs::write(dir.path().join(".myco/ledger.json"), "{not json").unwrap();
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
    fn body_hash_ignores_frontmatter_whitespace_and_normalisation_form() {
        let a = "---\nid: 1\ncreated: 5\n---\n\n# t\n\nhello  world\n";
        let b = "---\nid: 2\ncreated: 9\n---\r\n# t\nhello world";
        assert_eq!(body_hash(a), body_hash(b));
        assert_ne!(body_hash(a), body_hash("# t\n\nhello there"));
        assert_ne!(
            body_hash("a b"),
            body_hash("ab"),
            "tokens keep their boundary"
        );
        // NFD Hangul (as macOS file APIs emit it) hashes like the typed NFC form.
        let nfd = "\u{1112}\u{1161}\u{11AB}\u{1100}\u{1173}\u{11AF}";
        assert_eq!(body_hash(nfd), body_hash("한글"));
        // No frontmatter, or an unterminated block, hashes the whole doc.
        assert_eq!(body_hash("plain"), body_hash("  plain\n"));
        assert_eq!(strip_frontmatter("---\nnever closed"), "---\nnever closed");
    }

    #[test]
    fn same_body_under_another_key_is_a_duplicate_and_the_first_owner_stays() {
        let mut l = Ledger::default();
        let doc1 = boilerplate_doc("s1", 100);
        let doc2 = boilerplate_doc("s2", 200);
        assert_eq!(
            doc1.len(),
            1_013,
            "the fixture is the measured 1,013-byte copy"
        );
        assert_eq!(doc2.len(), 1_013);
        assert_ne!(doc1, doc2, "the copies differ in frontmatter only");
        let (h1, h2) = (body_hash(&doc1), body_hash(&doc2));
        assert_eq!(h1, h2);

        assert!(!l.seen_body(&h1, "claude-code:s1"));
        l.record_body(h1.clone(), "claude-code:s1");
        assert!(
            !l.seen_body(&h1, "claude-code:s1"),
            "a key's own body is not a duplicate"
        );
        assert!(
            l.seen_body(&h2, "claude-code:s2"),
            "the second insert is the duplicate"
        );
        l.record_body(h2, "claude-code:s2");
        assert!(
            l.seen_body(&h1, "claude-code:s2"),
            "the first owner is kept"
        );

        let other = body_hash("---\nconversation_id: s3\n---\n\n# real work\n\nsomething new\n");
        assert!(
            !l.seen_body(&other, "claude-code:s3"),
            "a different body is new"
        );
    }

    #[test]
    fn bodies_and_the_duplicate_count_round_trip_and_default_on_old_ledgers() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let mut l = Ledger::default();
        l.record_body("b1".into(), "codex:s1");
        l.note_duplicates(3);
        l.save(root).unwrap();
        let reloaded = Ledger::load(root);
        assert!(reloaded.seen_body("b1", "codex:s2"));
        assert_eq!(reloaded.duplicates(), 3);
        // A ledger written before the body index reads with an empty index.
        std::fs::write(
            root.join(".myco/ledger.json"),
            r#"{"entries":{"codex:s1":"fp"},"files":{}}"#,
        )
        .unwrap();
        let old = Ledger::load(root);
        assert!(old.seen("codex:s1", "fp"));
        assert!(!old.seen_body("b1", "codex:s2"));
        assert_eq!(old.duplicates(), 0);
    }

    #[test]
    fn a_legacy_flat_map_ledger_upgrades_and_keeps_dedup() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".myco")).unwrap();
        // Pre-file-tracking ledger: a bare `{key: fingerprint}` object.
        std::fs::write(
            root.join(".myco/ledger.json"),
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
