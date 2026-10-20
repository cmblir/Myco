//! `.myco/wikify-pending.json` — transcripts the MCP `import_conversation`
//! tool wrote to `raw/conversations/` that no wiki page cites yet. The MCP
//! `wikify_pending` tool hands them to the client oldest first and checks
//! them off by key. Its own file, not a key in `ledger.json`: the ledger
//! drops unknown keys on save, so anything added there would be erased by
//! the next in-app import.

use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

#[cfg(test)]
#[path = "wikify_queue_cas_tests.rs"]
mod queue_cas_baseline_tests;

/// Serialize import/queue updates in the in-process app and MCP server.
pub(crate) fn import_lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().map_err(|_| "import lock poisoned".to_string())
}

/// Stable revision identity for the exact immutable source bytes.
pub fn source_revision(text: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// Append a source, refusing symlink components and any existing different
/// bytes. Stage outside raw/ and publish with a no-clobber hard link so a
/// partial source is never visible to the scanner or citation resolver.
pub fn append_raw(root: &Path, rel: &str, content: &str) -> Result<(), String> {
    let mut path = root.to_path_buf();
    let components: Vec<_> = Path::new(rel).components().collect();
    if components.first().map(|c| c.as_os_str()) != Some(std::ffi::OsStr::new("raw")) {
        return Err("source must be inside raw/".into());
    }
    for (index, component) in components.iter().enumerate() {
        let std::path::Component::Normal(name) = component else {
            return Err("invalid raw source path".into());
        };
        path.push(name);
        if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err("raw source path contains a symlink".into());
        }
        if index + 1 < components.len() {
            std::fs::create_dir_all(&path)
                .map_err(|e| format!("create raw source directory: {e}"))?;
        }
    }
    let staging = crate::vault_dir::dir(root);
    if std::fs::symlink_metadata(&staging).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("raw staging path contains a symlink".into());
    }
    std::fs::create_dir_all(&staging).map_err(|e| format!("create raw staging directory: {e}"))?;
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let staged = staging.join(format!(
        "raw-import-{}-{nonce}-{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staged)
            .map_err(|e| format!("stage raw source: {e}"))?;
        file.write_all(content.as_bytes())
            .map_err(|e| format!("write staged source: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("sync staged source: {e}"))?;
        std::fs::hard_link(&staged, &path)
            .map_err(|e| (e.kind(), format!("publish raw source: {e}")))
            .or_else(|(kind, error)| {
                if kind == std::io::ErrorKind::AlreadyExists {
                    if std::fs::read_to_string(&path)
                        .map_err(|e| format!("read raw source: {e}"))?
                        == content
                    {
                        Ok(())
                    } else {
                        Err("raw/ source already exists (immutable)".into())
                    }
                } else {
                    Err(error)
                }
            })
    })();
    if staged.exists() {
        std::fs::remove_file(&staged).map_err(|e| format!("remove staged source: {e}"))?;
    }
    result
}

pub(crate) fn source_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if !rel.starts_with("raw/conversations/") {
        return Err("not an imported conversation source".into());
    }
    let root = root
        .canonicalize()
        .map_err(|e| format!("vault root: {e}"))?;
    let path = crate::vault::confine_path(&root, &root.join(rel).to_string_lossy())?;
    if !path.starts_with(root.join("raw/conversations")) {
        return Err("source escapes raw/conversations/".into());
    }
    Ok(path)
}

/// A bounded byte read: queue summaries never read the whole source first.
pub fn read_range(
    root: &Path,
    rel: &str,
    offset: usize,
    limit: usize,
) -> Result<(String, usize, usize), String> {
    let path = source_path(root, rel)?;
    let mut file = std::fs::File::open(path).map_err(|e| format!("read imported source: {e}"))?;
    let total = file
        .metadata()
        .map_err(|e| format!("source metadata: {e}"))?
        .len() as usize;
    if offset > total {
        return Err("source offset exceeds file size".into());
    }
    file.seek(SeekFrom::Start(offset as u64))
        .map_err(|e| format!("seek imported source: {e}"))?;
    let mut bytes = Vec::new();
    file.take(limit.clamp(4, 64 * 1024) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read source range: {e}"))?;
    let valid = match std::str::from_utf8(&bytes) {
        Ok(_) => bytes.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(),
        Err(_) => {
            return Err("source offset is not a UTF-8 boundary or source is not UTF-8".into())
        }
    };
    bytes.truncate(valid);
    let next = offset + bytes.len();
    Ok((
        String::from_utf8(bytes).map_err(|e| e.to_string())?,
        next,
        total,
    ))
}

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
    #[serde(default)]
    pub source_revision: String,
    #[serde(default)]
    pub read_ranges: Vec<[usize; 2]>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Receipt {
    pub key: String,
    pub raw_path: String,
    pub source_revision: String,
    pub wiki_paths: Vec<String>,
    pub completed: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct Pending {
    #[serde(default)]
    pub pending: Vec<PendingItem>,
    #[serde(default)]
    pub done_count: u64,
    #[serde(default)]
    pub receipts: Vec<Receipt>,
    /// Compiler jobs do not disappear when a legacy citation reminder is done.
    #[serde(default)]
    pub(crate) compile_jobs: Vec<crate::session_compile::CompilationJob>,
    #[serde(skip)]
    loaded_revision: Option<String>,
}

impl Pending {
    pub fn path(vault_root: &Path) -> PathBuf {
        crate::vault_dir::dir(vault_root).join("wikify-pending.json")
    }

    /// Compatibility presentation only. Integrity-sensitive callers use
    /// try_load; failed presentation reads cannot overwrite existing state.
    pub fn load(vault_root: &Path) -> Pending {
        Self::try_load(vault_root).unwrap_or_default()
    }

    /// Only absence creates empty authoritative state. Capture the exact loaded
    /// JSON revision so an external writer cannot be overwritten on save.
    pub fn try_load(vault_root: &Path) -> Result<Pending, String> {
        let path = crate::vault::confine_delete_path(
            vault_root,
            &Self::path(vault_root).to_string_lossy(),
        )?;
        match std::fs::read_to_string(path) {
            Ok(text) => {
                let mut pending: Self = serde_json::from_str(&text)
                    .map_err(|e| format!("invalid wikify queue: {e}"))?;
                pending.loaded_revision = Some(source_revision(&text));
                Ok(pending)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(format!("read wikify queue: {e}")),
        }
    }

    /// Publish exactly the loaded JSON revision, retaining the new baseline for
    /// subsequent mutations in this in-process transaction.
    pub fn save(&mut self, vault_root: &Path) -> Result<(), String> {
        let path = crate::vault::confine_delete_path(
            vault_root,
            &Self::path(vault_root).to_string_lossy(),
        )?;
        let parent = path.parent().ok_or("wikify queue has no state directory")?;
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create wikify queue directory: {e}"))?;
        let path = crate::vault::confine_delete_path(
            vault_root,
            &Self::path(vault_root).to_string_lossy(),
        )?;
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| format!("serialize wikify queue: {e}"))?;
        crate::vault::write_file_if_unchanged(
            &path.to_string_lossy(),
            &json,
            self.loaded_revision.as_deref(),
        )
        .map_err(|e| format!("publish wikify queue: {e}"))?;
        self.loaded_revision = Some(source_revision(&json));
        Ok(())
    }

    /// Register source work independently of legacy citation receipts. Admission
    /// requires source identity; missing generator weights leave this pending.
    pub(crate) fn admit_compile_job(&mut self, item: &PendingItem) -> bool {
        let source = crate::session_compile::SourceBinding {
            key: item.key.clone(),
            raw_path: item.raw_path.clone(),
            source_revision: item.source_revision.clone(),
        };
        if self.compile_jobs.iter().any(|job| job.source == source) {
            return false;
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |duration| duration.as_secs());
        for job in self.compile_jobs.iter_mut().filter(|job| {
            job.source.key == item.key && job.source.source_revision != item.source_revision
        }) {
            job.supersede(item.source_revision.clone(), now);
        }
        let job_id = source_revision(&format!(
            "{}:{}{}:{}{}:{}",
            item.key.len(),
            item.key,
            item.raw_path.len(),
            item.raw_path,
            item.source_revision.len(),
            item.source_revision
        ));
        self.compile_jobs
            .push(crate::session_compile::CompilationJob::new(
                job_id, source, now,
            ));
        true
    }

    /// Queue `item`, replacing an older entry with the same key (a re-import
    /// under the same id moves it to the back, it does not duplicate it).
    pub fn push(&mut self, item: PendingItem) {
        self.admit_compile_job(&item);
        self.pending.retain(|p| p.key != item.key);
        self.pending.push(item);
    }

    pub fn record_read(
        &mut self,
        key: &str,
        revision: &str,
        start: usize,
        end: usize,
    ) -> Result<(), String> {
        let item = self
            .pending
            .iter_mut()
            .find(|p| p.key == key)
            .ok_or("conversation is not pending")?;
        if item.source_revision != revision {
            return Err("source revision changed; read the current revision".into());
        }
        item.read_ranges.push([start, end]);
        item.read_ranges.sort_unstable();
        let mut ranges: Vec<[usize; 2]> = Vec::new();
        for [start, end] in &item.read_ranges {
            if let Some(last) = ranges.last_mut().filter(|r| *start <= r[1]) {
                last[1] = last[1].max(*end);
            } else {
                ranges.push([*start, *end]);
            }
        }
        item.read_ranges = ranges;
        Ok(())
    }

    pub fn read_complete(item: &PendingItem, total: usize) -> bool {
        item.read_ranges
            .first()
            .is_some_and(|r| r[0] == 0 && r[1] >= total)
    }

    /// Only a verified receipt removes a revision; a bare key is insufficient.
    pub fn complete(&mut self, receipt: Receipt) -> Result<(), String> {
        let index = self
            .pending
            .iter()
            .position(|p| p.key == receipt.key)
            .ok_or("conversation is not pending")?;
        let item = &self.pending[index];
        if item.raw_path != receipt.raw_path
            || item.source_revision != receipt.source_revision
            || receipt.wiki_paths.is_empty()
        {
            return Err("receipt does not match the pending source revision".into());
        }
        self.pending.remove(index);
        self.receipts.push(receipt);
        self.done_count += 1;
        Ok(())
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
            source_revision: "revision-a".into(),
            read_ranges: Vec::new(),
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
        q.complete(Receipt {
            key: "chatgpt:a".into(),
            raw_path: item("chatgpt:a").raw_path,
            source_revision: "revision-a".into(),
            wiki_paths: vec!["wiki/a.md".into()],
            completed: "2026-09-06".into(),
        })
        .unwrap();
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
        assert!(
            Pending::try_load(root).is_err(),
            "completion must refuse corrupt queue state"
        );
    }

    #[test]
    fn read_ranges_merge_only_complete_coverage_and_revision_matches() {
        let mut q = Pending::default();
        q.push(item("codex:a"));
        q.record_read("codex:a", "revision-a", 5, 10).unwrap();
        assert!(!Pending::read_complete(&q.pending[0], 10));
        q.record_read("codex:a", "revision-a", 0, 5).unwrap();
        assert!(Pending::read_complete(&q.pending[0], 10));
        assert!(q.record_read("codex:a", "revision-old", 0, 10).is_err());
    }

    #[test]
    fn original_sources_are_append_only_and_utf8_reads_are_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let rel = "raw/conversations/codex/a.jsonl";
        append_raw(root, rel, "가나다 English").unwrap();
        append_raw(root, rel, "가나다 English").unwrap();
        assert!(append_raw(root, rel, "changed").is_err());
        let (text, next, total) = read_range(root, rel, 0, 4).unwrap();
        assert_eq!(text, "가");
        assert_eq!(next, 3);
        assert_eq!(total, "가나다 English".len());
        assert!(read_range(root, rel, 1, 4).is_err());
    }
}
