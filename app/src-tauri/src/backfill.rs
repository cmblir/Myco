//! Session backfill — the archive under `sessions/` becomes wiki knowledge.
//!
//! Measured on the owner's vault: 1,423 imported conversations produced ten
//! cited sources in the wiki. Import works; wikification never happens, because
//! auto-ingest walks `_inbox/` and imported sessions land in `sessions/`.
//!
//! This module does not build a second pipeline. It PROMOTES a selected session
//! into `_inbox/` (a copy — `sessions/` stays an archive) and lets the existing
//! ingest pass do everything else: retrieval grounding, the planner, the writing
//! agent, the WHY report, source archiving, the run log and its undo.
//!
//! Selection is by size, which is a usable proxy for substance on this corpus:
//! 990 of 1,428 files are under 2 KB — a few turns with no claim worth a page.
//! Oversized sessions are HELD and counted, never silently skipped, so the
//! ceiling stays a decision rather than an invisible truncation.
//!
//! See `app/docs/specs/2026-08-28-session-backfill-design.md`.

#[path = "backfill_read.rs"]
mod read;
pub use read::{ReadIssue, ReadIssueCode, ReadStatus};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Below this a session is chatter, not knowledge (1,231 of 1,428 files).
pub const MIN_BYTES: u64 = 8 * 1024;
/// Above this one ingest run is a bad deal even for a tool-capable provider.
pub const MAX_BYTES: u64 = 200 * 1024;
/// The archive this reads from, and the queue it promotes into.
pub const SESSIONS_DIR: &str = "sessions";
const INBOX_DIR: &str = "_inbox";
static BACKFILL_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize)]
pub(crate) struct PendingCopy {
    pub(crate) inbox_rel: String,
    pub(crate) source_revision: String,
}

#[derive(Serialize, Deserialize)]
pub(crate) struct CompletedHarvest {
    pub(crate) source_revision: String,
    pub(crate) completed_at: i64,
}

/// Promotion bookkeeping. Its OWN file on purpose: `importers::ledger` drops
/// unknown keys when it saves, so a field added to `ledger.json` would be
/// erased by the next in-app import.
#[derive(Serialize, Deserialize, Default)]
pub(crate) struct BackfillState {
    /// vault-relative session path → unix seconds when it was promoted.
    #[serde(default)]
    pub(crate) promoted: BTreeMap<String, i64>,
    /// Copies are retryable until an explicitly completed ingest archives them.
    #[serde(default)]
    pub(crate) pending: BTreeMap<String, PendingCopy>,
    /// Legacy `promoted` records prove copying only, not evidence completion.
    #[serde(default)]
    pub(crate) completed: BTreeMap<String, CompletedHarvest>,
}

fn state_path(root: &Path) -> PathBuf {
    root.canonicalize()
        .unwrap_or_else(|_| root.to_path_buf())
        .join(".myco")
        .join("backfill.json")
}

fn read_state_checked(root: &Path) -> Result<BackfillState, String> {
    read_state_snapshot(root).map(|(state, _)| state)
}

fn read_state_snapshot(root: &Path) -> Result<(BackfillState, Option<String>), String> {
    read_state_snapshot_report(root).map_err(|issue| issue.message)
}

fn read_state_snapshot_report(root: &Path) -> Result<(BackfillState, Option<String>), ReadIssue> {
    validate_read_root(root)?;
    let body = match read_regular_document(&state_path(root)) {
        Ok(body) => body,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((BackfillState::default(), None));
        }
        Err(error) => {
            return Err(ReadIssue::new(
                ".myco/backfill.json",
                ReadIssueCode::StateRead,
                format!("read backfill state: {error}"),
            ));
        }
    };
    let state = serde_json::from_slice(&body).map_err(|error| {
        ReadIssue::new(
            ".myco/backfill.json",
            ReadIssueCode::StateDecode,
            format!("decode backfill state: {error}"),
        )
    })?;
    Ok((state, Some(revision(&body))))
}

pub(crate) fn load_state(root: &Path) -> Result<BackfillState, ReadIssue> {
    read_state_snapshot_report(root).map(|(state, _)| state)
}

fn save_state(root: &Path, state: &BackfillState) -> Result<(), String> {
    let canonical = root
        .canonicalize()
        .map_err(|e| format!("canonicalize vault: {e}"))?;
    let path = state_path(&canonical);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create .myco: {e}"))?;
    }
    let body = serde_json::to_string_pretty(state).map_err(|e| format!("encode state: {e}"))?;
    let parent = path.parent().ok_or_else(|| "no state parent".to_string())?;
    let mut staged =
        tempfile::NamedTempFile::new_in(parent).map_err(|e| format!("stage state: {e}"))?;
    staged
        .write_all(body.as_bytes())
        .map_err(|e| format!("write state: {e}"))?;
    staged
        .persist(path)
        .map_err(|e| format!("persist state: {e}"))?;
    Ok(())
}

fn revision(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) fn session_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let joined = crate::myco_pro::safe_join(root, rel)?;
    if !rel.starts_with("sessions/") || !rel.ends_with(".md") {
        return Err("refused: harvest source must be a sessions/ document".into());
    }
    let canonical = root
        .canonicalize()
        .map_err(|e| format!("canonicalize vault: {e}"))?;
    let confined = crate::vault::confine_path(&canonical, &joined.to_string_lossy())?;
    if !confined.starts_with(canonical.join(SESSIONS_DIR)) {
        return Err("refused: harvest source must stay within sessions/".into());
    }
    Ok(confined)
}

#[derive(Default)]
pub(crate) struct CompletedSources {
    pub(crate) completed: BTreeMap<String, i64>,
    pub(crate) unverified: BTreeSet<String>,
    pub(crate) read_issues: Vec<ReadIssue>,
}

/// A failed revision read is unknown completion, not a changed source.
pub(crate) fn completed_sources(root: &Path, state: &BackfillState) -> CompletedSources {
    let mut report = CompletedSources::default();
    for (rel, receipt) in &state.completed {
        let result = session_path(root, rel)
            .and_then(|path| read_regular_document(&path).map_err(|error| error.to_string()));
        match result {
            Ok(bytes) if revision(&bytes) == receipt.source_revision => {
                report.completed.insert(rel.clone(), receipt.completed_at);
            }
            Ok(_) => {}
            Err(error) => {
                report.unverified.insert(rel.clone());
                let issue_path = if rel.starts_with("sessions/")
                    && crate::myco_pro::safe_join(root, rel).is_ok()
                {
                    rel.as_str()
                } else {
                    ".myco/backfill.json"
                };
                report.read_issues.push(ReadIssue::new(
                    issue_path,
                    ReadIssueCode::CompletionRead,
                    format!("read completed source revision: {error}"),
                ));
            }
        }
    }
    report
}

/// Legacy test compatibility for an already archived inbox copy.
/// Production completion additionally requires native compilation/publication authority.
#[cfg(test)]
pub(crate) fn complete_inbox_at(
    root: &Path,
    inbox_rel: &str,
    archived_path: &str,
) -> Result<bool, String> {
    let _guard = BACKFILL_LOCK
        .lock()
        .map_err(|e| format!("backfill lock: {e}"))?;
    let mut state = read_state_checked(root)?;
    let Some((source, expected)) = state
        .pending
        .iter()
        .find(|(_, copy)| copy.inbox_rel == inbox_rel)
        .map(|(source, copy)| (source.clone(), copy.source_revision.clone()))
    else {
        return Ok(false);
    };
    let canonical = root
        .canonicalize()
        .map_err(|e| format!("canonicalize vault: {e}"))?;
    let archive = crate::vault::confine_path(&canonical, archived_path)?;
    if !archive.starts_with(canonical.join("_inbox/.archived")) {
        return Err("refused: harvest receipt must reference an archived inbox copy".into());
    }
    let bytes = std::fs::read(&archive).map_err(|e| format!("read archived harvest: {e}"))?;
    if revision(&bytes) != expected {
        return Err("refused: archived harvest source revision changed".into());
    }
    let completed_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    state.completed.insert(
        source.clone(),
        CompletedHarvest {
            source_revision: expected,
            completed_at,
        },
    );
    state.pending.remove(&source);
    save_state(root, &state)?;
    Ok(true)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InboxArchiveReceipt {
    pub(crate) archived_path: String,
    pub(crate) source_revision: String,
    pub(crate) harvest_completed: bool,
}

fn checked_pending_sources(
    state: &BackfillState,
    inbox_rel: &str,
    expected_revision: &str,
) -> Result<Vec<String>, String> {
    state
        .pending
        .iter()
        .filter(|(_, copy)| copy.inbox_rel == inbox_rel)
        .map(|(source, copy)| {
            if copy.source_revision != expected_revision {
                return Err("refused: pending harvest source revision changed".to_string());
            }
            Ok(source.clone())
        })
        .collect()
}

/// Read every pending source that shares this exact inbox revision.
pub(crate) fn pending_sources_for_inbox(
    root: &Path,
    inbox_rel: &str,
    expected_revision: &str,
) -> Result<Vec<String>, String> {
    let _guard = BACKFILL_LOCK
        .lock()
        .map_err(|e| format!("backfill lock: {e}"))?;
    checked_pending_sources(&read_state_checked(root)?, inbox_rel, expected_revision)
}

/// Archive exact captured bytes and finish only natively authorized pending keys.
/// The caller holds its opening/issuer guards; validation runs under the writer guard.
pub(crate) fn archive_pending_inbox_at(
    root: &Path,
    inbox_rel: &str,
    expected_revision: &str,
    complete_sources: &[String],
    validate: impl FnOnce() -> Result<(), String>,
) -> Result<InboxArchiveReceipt, String> {
    archive_pending_inbox_impl(
        root,
        inbox_rel,
        expected_revision,
        complete_sources,
        validate,
        #[cfg(test)]
        |_| Ok(()),
    )
}

fn archive_pending_inbox_impl(
    root: &Path,
    inbox_rel: &str,
    expected_revision: &str,
    complete_sources: &[String],
    validate: impl FnOnce() -> Result<(), String>,
    #[cfg(test)] after_archive: impl FnOnce(&str) -> Result<(), String>,
) -> Result<InboxArchiveReceipt, String> {
    let _guard = BACKFILL_LOCK
        .lock()
        .map_err(|e| format!("backfill lock: {e}"))?;
    let (mut state, state_revision) = read_state_snapshot(root)?;
    let pending = checked_pending_sources(&state, inbox_rel, expected_revision)?;
    let mut authorized = BTreeSet::new();
    for source in complete_sources {
        if !pending.contains(source) || !authorized.insert(source) {
            return Err("refused: harvest completion keys do not match pending sources".into());
        }
    }
    let source = crate::myco_pro::safe_join(root, inbox_rel)?;
    let archived_path = crate::vault::archive_inbox_source_checked_with_at(
        root,
        &source.to_string_lossy(),
        expected_revision,
        || {
            validate()?;
            if read_state_snapshot(root)?.1 != state_revision {
                return Err(
                    "backfill state changed before archive; source was left in place".into(),
                );
            }
            Ok(())
        },
    )?;
    #[cfg(test)]
    after_archive(&archived_path)?;
    if !authorized.is_empty() {
        let completed_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        for source in authorized {
            state.completed.insert(
                source.clone(),
                CompletedHarvest {
                    source_revision: expected_revision.to_string(),
                    completed_at,
                },
            );
            state.pending.remove(source);
        }
        save_state(root, &state).map_err(|error| {
            format!("harvest source archived at {archived_path}; completion state was not saved: {error}")
        })?;
    }
    let harvest_completed = !pending.is_empty()
        && !state
            .pending
            .values()
            .any(|copy| copy.inbox_rel == inbox_rel);
    Ok(InboxArchiveReceipt {
        archived_path,
        source_revision: expected_revision.to_string(),
        harvest_completed,
    })
}

/// One session document as the scanner sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionFile {
    /// Vault-relative, forward-slashed — the key the state file stores.
    pub rel: String,
    pub bytes: u64,
    /// Newest-first ordering key. `created` from frontmatter when it parses,
    /// else the file's mtime; 0 when neither is readable.
    pub created: i64,
}

fn validate_read_root(root: &Path) -> Result<(), ReadIssue> {
    std::fs::read_dir(root).map(|_| ()).map_err(|error| {
        ReadIssue::new(
            ".",
            ReadIssueCode::DirectoryRead,
            format!("read vault directory for session lookup: {error}"),
        )
    })
}

#[derive(Debug, Default)]
pub struct SessionScan {
    pub files: Vec<SessionFile>,
    pub read_status: ReadStatus,
    pub read_issues: Vec<ReadIssue>,
}

/// Every regular `.md` under `sessions/`, including `sessions/archive/`.
/// Missing optional archives are empty; failed reads remain visible.
pub fn scan_sessions(root: &Path) -> SessionScan {
    let base = root.join(SESSIONS_DIR);
    let mut report = SessionScan::default();
    if let Err(issue) = validate_read_root(root) {
        report.read_status = ReadStatus::ReadFailed;
        report.read_issues.push(issue);
        return report;
    }
    match std::fs::symlink_metadata(&base) {
        Ok(meta) if meta.file_type().is_symlink() => return report,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return report,
        Err(error) => {
            report.read_issues.push(ReadIssue::new(
                SESSIONS_DIR,
                ReadIssueCode::DirectoryRead,
                format!("inspect session directory: {error}"),
            ));
            report.read_status = ReadStatus::Partial;
            return report;
        }
        Ok(_) => {}
    }
    let mut stack = vec![(base, SESSIONS_DIR.to_string())];
    while let Some((dir, dir_rel)) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) => {
                report.read_issues.push(ReadIssue::new(
                    dir_rel,
                    ReadIssueCode::DirectoryRead,
                    format!("read session directory: {error}"),
                ));
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) => {
                    report.read_issues.push(ReadIssue::new(
                        &dir_rel,
                        ReadIssueCode::EntryRead,
                        format!("read session entry: {error}"),
                    ));
                    continue;
                }
            };
            let path = entry.path();
            let kind = match entry.file_type() {
                Ok(kind) => kind,
                Err(error) => {
                    report.read_issues.push(ReadIssue::new(
                        &dir_rel,
                        ReadIssueCode::MetadataRead,
                        format!("inspect session entry: {error}"),
                    ));
                    continue;
                }
            };
            if kind.is_symlink() {
                continue;
            }
            if !kind.is_dir() && path.extension().and_then(|ext| ext.to_str()) != Some("md") {
                continue;
            }
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                report.read_issues.push(ReadIssue::new(
                    &dir_rel,
                    ReadIssueCode::MetadataRead,
                    "session path is not valid UTF-8",
                ));
                continue;
            };
            #[cfg(unix)]
            if name.contains('\\') {
                report.read_issues.push(ReadIssue::new(
                    &dir_rel,
                    ReadIssueCode::MetadataRead,
                    "session path contains an unsupported backslash",
                ));
                continue;
            }
            let rel = format!("{dir_rel}/{name}");
            let meta = match entry.metadata() {
                Ok(meta) => meta,
                Err(error) => {
                    report.read_issues.push(ReadIssue::new(
                        &rel,
                        ReadIssueCode::MetadataRead,
                        format!("read session metadata: {error}"),
                    ));
                    continue;
                }
            };
            if kind.is_dir() && meta.is_dir() {
                stack.push((path, rel));
                continue;
            }
            if !kind.is_file() || !meta.is_file() {
                report.read_issues.push(ReadIssue::new(
                    rel,
                    ReadIssueCode::MetadataRead,
                    "session document is not a regular file",
                ));
                continue;
            }
            let created = match read_created(&path) {
                Ok(created) => created.unwrap_or_else(|| mtime_secs(&meta)),
                Err(error) => {
                    report.read_issues.push(ReadIssue::new(
                        rel,
                        ReadIssueCode::BodyRead,
                        format!("read session header: {error}"),
                    ));
                    continue;
                }
            };
            report.files.push(SessionFile {
                rel,
                bytes: meta.len(),
                created,
            });
        }
    }
    if !report.read_issues.is_empty() {
        report.read_status = ReadStatus::Partial;
    }
    report
}

fn mtime_secs(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// State and session reads must reject a replaced leaf FIFO without blocking open.
fn open_regular_document(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "document is not a regular file",
        ));
    }
    Ok(file)
}

fn read_regular_document(path: &Path) -> std::io::Result<Vec<u8>> {
    use std::io::Read as _;
    let mut bytes = Vec::new();
    open_regular_document(path)?.read_to_end(&mut bytes)?;
    Ok(bytes)
}

pub(crate) fn read_session_text(path: &Path) -> Result<String, String> {
    let bytes = read_regular_document(path).map_err(|error| error.to_string())?;
    String::from_utf8(bytes).map_err(|error| error.to_string())
}

/// `created: <unix seconds>` from the frontmatter, using only the file head.
fn read_created(path: &Path) -> std::io::Result<Option<i64>> {
    use std::io::Read as _;
    let mut head = [0u8; 512];
    let mut file = open_regular_document(path)?;
    let n = file.read(&mut head)?;
    let text = String::from_utf8_lossy(&head[..n]);
    if !text.starts_with("---") {
        return Ok(None);
    }
    for line in text.lines().skip(1) {
        if line.starts_with("---") {
            break;
        }
        if let Some(value) = line.strip_prefix("created:") {
            return Ok(value.trim().parse::<i64>().ok());
        }
    }
    Ok(None)
}

/// What the Ingest card shows.
#[derive(Serialize)]
pub struct BackfillStatus {
    /// Every session document found.
    pub total: usize,
    /// Already promoted in an earlier batch.
    pub promoted: usize,
    /// Ready to promote now.
    pub eligible: usize,
    /// Under the substance floor — chatter, not knowledge.
    pub too_small: usize,
    /// Over the ceiling. Counted, not hidden: this is a held bucket the owner
    /// can decide about, not a silent skip.
    pub too_large: usize,
    /// Partial counts cover confirmed files; failed reads do not prove an empty archive.
    pub read_status: ReadStatus,
    pub read_issues: Vec<ReadIssue>,
}

/// Split the scan into the four buckets, given what has already been promoted.
pub fn summarize(files: &[SessionFile], state_promoted: &BTreeMap<String, i64>) -> BackfillStatus {
    let mut s = BackfillStatus {
        total: files.len(),
        promoted: 0,
        eligible: 0,
        too_small: 0,
        too_large: 0,
        read_status: ReadStatus::Complete,
        read_issues: Vec::new(),
    };
    for f in files {
        if state_promoted.contains_key(&f.rel) {
            s.promoted += 1;
        } else if f.bytes < MIN_BYTES {
            s.too_small += 1;
        } else if f.bytes > MAX_BYTES {
            s.too_large += 1;
        } else {
            s.eligible += 1;
        }
    }
    s
}

/// Read-only status using the same checked state authority as promotion.
pub fn status_at(root: &Path) -> BackfillStatus {
    let mut status = summarize(&[], &BTreeMap::new());
    let state = match load_state(root) {
        Ok(state) => state,
        Err(issue) => {
            status.read_status = ReadStatus::ReadFailed;
            status.read_issues.push(issue);
            return status;
        }
    };
    let scan = scan_sessions(root);
    if scan.read_status == ReadStatus::ReadFailed {
        status.read_status = ReadStatus::ReadFailed;
        status.read_issues = scan.read_issues;
        return status;
    }
    let completion = completed_sources(root, &state);
    let mut files = scan.files;
    files.retain(|file| !completion.unverified.contains(&file.rel));
    status = summarize(&files, &state.promoted);
    status.read_issues = scan.read_issues;
    status.read_issues.extend(completion.read_issues);
    if !status.read_issues.is_empty() {
        status.read_status = ReadStatus::Partial;
    }
    status
}

/// The next `limit` sessions to promote, newest first. Ties break on `rel` so
/// the order is stable across runs (directory reads are not ordered).
pub fn next_batch(
    files: &[SessionFile],
    state_promoted: &BTreeMap<String, i64>,
    limit: usize,
) -> Vec<SessionFile> {
    let mut eligible: Vec<SessionFile> = files
        .iter()
        .filter(|f| {
            !state_promoted.contains_key(&f.rel) && f.bytes >= MIN_BYTES && f.bytes <= MAX_BYTES
        })
        .cloned()
        .collect();
    eligible.sort_by(|a, b| b.created.cmp(&a.created).then_with(|| a.rel.cmp(&b.rel)));
    eligible.truncate(limit);
    eligible
}

/// `_inbox/` filename for a promoted session: its own basename, suffixed if
/// taken. `sessions/2026-08/claude-code-abc.md` keeps a name the owner can
/// recognise in the pending list.
fn inbox_name(rel: &str, taken: &dyn Fn(&str) -> bool) -> String {
    let base = rel.rsplit('/').next().unwrap_or(rel);
    let (stem, ext) = match base.rsplit_once('.') {
        Some((s, e)) => (s, format!(".{e}")),
        None => (base, String::new()),
    };
    let mut candidate = format!("{stem}{ext}");
    let mut n = 2;
    while taken(&candidate) {
        candidate = format!("{stem}-{n}{ext}");
        n += 1;
    }
    candidate
}

fn matching_inbox_name(inbox: &Path, source: &[u8]) -> Option<String> {
    let mut entries: Vec<_> = std::fs::read_dir(inbox).ok()?.flatten().collect();
    entries.sort_by_key(|entry| entry.file_name());
    entries.into_iter().find_map(|entry| {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || !name.ends_with(".md") || !entry.file_type().ok()?.is_file() {
            return None;
        }
        if entry.metadata().ok()?.len() != source.len() as u64 {
            return None;
        }
        std::fs::read(entry.path())
            .is_ok_and(|bytes| bytes == source)
            .then_some(name)
    })
}

/// Exact bytes of a promoted or reused inbox copy, bound to its session source.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct InboxSourceBinding {
    pub source_rel: String,
    pub inbox_rel: String,
    pub source_revision: String,
}

#[derive(Serialize)]
pub struct BackfillPromotion {
    /// `_inbox/` names that now hold a copy, in promotion order.
    pub promoted: Vec<String>,
    pub inbox_sources: Vec<InboxSourceBinding>,
    /// Still eligible after this batch.
    pub remaining: usize,
}

/// What `promote_rels` did.
pub(crate) struct Promoted {
    /// `_inbox/` names now holding a copy, in promotion order.
    pub names: Vec<String>,
    pub inbox_sources: Vec<InboxSourceBinding>,
    /// (vault-relative session, error) for each copy that failed.
    pub failed: Vec<(String, String)>,
    pub created: u32,
}

/// Copy the given sessions (vault-relative paths under `sessions/`) into
/// `_inbox/` and record them in the state file. One unreadable session must
/// not abort the batch, and nothing is recorded for it so the next attempt
/// retries it. Shared by the batch button (`promote_at`) and the
/// picked-by-hand harvest (`harvest::run_at`).
pub(crate) fn promote_rels(root: &Path, rels: &[String]) -> Result<Promoted, String> {
    promote_rels_impl(
        root,
        rels,
        #[cfg(test)]
        |_| Ok(()),
        #[cfg(test)]
        |_, _| Ok(()),
    )
}

pub(crate) fn promote_rels_impl(
    root: &Path,
    rels: &[String],
    #[cfg(test)] before_save: impl FnOnce(&Path) -> Result<(), String>,
    #[cfg(test)] mut before_copy: impl FnMut(&Path, &str) -> Result<(), String>,
) -> Result<Promoted, String> {
    let _guard = BACKFILL_LOCK
        .lock()
        .map_err(|e| format!("backfill lock: {e}"))?;
    // New descendants must use the canonical spelling too: macOS temp roots
    // can arrive as /var while confinement resolves their parent to /private/var.
    let canonical = root
        .canonicalize()
        .map_err(|e| format!("canonicalize vault: {e}"))?;
    let root = canonical.as_path();
    let mut state = read_state_checked(root)?;
    let inbox = root.join(INBOX_DIR);
    crate::vault::confine_parent(&canonical, &inbox.to_string_lossy())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let mut out = Promoted {
        names: Vec::new(),
        inbox_sources: Vec::new(),
        failed: Vec::new(),
        created: 0,
    };
    for rel in rels {
        let src = match session_path(root, rel) {
            Ok(path) => path,
            Err(e) => {
                out.failed.push((rel.clone(), e));
                continue;
            }
        };
        let source = match read_regular_document(&src) {
            Ok(bytes) => bytes,
            Err(e) => {
                out.failed.push((rel.clone(), format!("read session: {e}")));
                continue;
            }
        };
        let source_revision = revision(&source);
        if let Some(copy) = state.pending.get(rel) {
            if copy.source_revision == source_revision {
                if let Ok(path) = crate::myco_pro::safe_join(root, &copy.inbox_rel) {
                    if path.starts_with(&inbox)
                        && crate::vault::confine_path(&canonical, &path.to_string_lossy())
                            .is_ok_and(|confined| {
                                std::fs::read(confined).is_ok_and(|bytes| bytes == source)
                            })
                    {
                        out.names
                            .push(copy.inbox_rel.trim_start_matches("_inbox/").to_string());
                        out.inbox_sources.push(InboxSourceBinding {
                            source_rel: rel.clone(),
                            inbox_rel: copy.inbox_rel.clone(),
                            source_revision,
                        });
                        continue;
                    }
                }
            }
        }
        // A legacy copy or a previous save failure may have no pending map.
        // Exact bytes recover the copy, never infer completed wiki knowledge.
        if let Some(name) = matching_inbox_name(&inbox, &source) {
            let inbox_rel = format!("_inbox/{name}");
            state.promoted.insert(rel.clone(), now);
            state.pending.insert(
                rel.clone(),
                PendingCopy {
                    inbox_rel: inbox_rel.clone(),
                    source_revision: source_revision.clone(),
                },
            );
            out.names.push(name);
            out.inbox_sources.push(InboxSourceBinding {
                source_rel: rel.clone(),
                inbox_rel,
                source_revision,
            });
            continue;
        }
        let name = inbox_name(rel, &|n: &str| inbox.join(n).exists());
        #[cfg(test)]
        before_copy(root, rel)?;
        // Reuses the notch drop's copy: same confinement (safe_join), same
        // no-overwrite rule, same size cap.
        match crate::commands::copy_into_inbox_at(root, &src.to_string_lossy(), &name) {
            Ok(dest) => {
                let bytes = match std::fs::read(&dest) {
                    Ok(bytes) => bytes,
                    Err(e) => {
                        out.failed
                            .push((rel.clone(), format!("read copied session: {e}")));
                        continue;
                    }
                };
                if bytes != source {
                    out.failed.push((
                        rel.clone(),
                        "session source changed while copying; inbox copy was preserved"
                            .to_string(),
                    ));
                    continue;
                }
                let inbox_rel = format!("_inbox/{name}");
                let copied_revision = revision(&bytes);
                state.promoted.insert(rel.clone(), now);
                state.pending.insert(
                    rel.clone(),
                    PendingCopy {
                        inbox_rel: inbox_rel.clone(),
                        source_revision: copied_revision.clone(),
                    },
                );
                out.names.push(name);
                out.inbox_sources.push(InboxSourceBinding {
                    source_rel: rel.clone(),
                    inbox_rel,
                    source_revision: copied_revision,
                });
                out.created += 1;
            }
            Err(e) => out.failed.push((rel.clone(), e)),
        }
    }
    if !out.names.is_empty() {
        #[cfg(test)]
        before_save(root)?;
        save_state(root, &state)?;
    }
    Ok(out)
}

/// Copy the next `limit` eligible sessions into `_inbox/` and record them.
/// Testable core: takes the vault root, no Tauri state.
pub fn promote_at(root: &Path, limit: usize) -> Result<BackfillPromotion, String> {
    let limit = limit.clamp(1, 50);
    let scan = scan_sessions(root);
    if let Some(issue) = scan.read_issues.first() {
        return Err(format!(
            "session scan incomplete at {}: {}",
            issue.path, issue.message
        ));
    }
    let files = scan.files;
    let batch = next_batch(&files, &read_state_checked(root)?.promoted, limit);
    let rels: Vec<String> = batch.into_iter().map(|f| f.rel).collect();
    let done = promote_rels(root, &rels)?;
    for (rel, e) in done.failed {
        eprintln!("backfill: skipped {rel}: {e}");
    }
    let remaining = summarize(&files, &read_state_checked(root)?.promoted).eligible;
    Ok(BackfillPromotion {
        promoted: done.names,
        inbox_sources: done.inbox_sources,
        remaining,
    })
}

/// Counts for the Ingest card.
#[tauri::command]
pub fn backfill_status(
    state: tauri::State<crate::commands::VaultRoot>,
) -> Result<BackfillStatus, String> {
    let root = crate::commands::require_root(&state)?;
    Ok(status_at(&root))
}

/// Promote the next batch of sessions into `_inbox/`.
#[tauri::command]
pub fn promote_sessions(
    state: tauri::State<crate::commands::VaultRoot>,
    limit: usize,
    origin: crate::vault_session::AgentVaultSession,
) -> Result<BackfillPromotion, String> {
    state.with_origin(&origin, |root| promote_at(root, limit))
}

#[cfg(test)]
#[path = "backfill_archive_mutation_tests.rs"]
mod archive_mutation_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn write(root: &Path, rel: &str, bytes: usize, created: Option<i64>) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let head = match created {
            Some(c) => format!("---\nsource: claude-code\ncreated: {c}\n---\n\n"),
            None => String::new(),
        };
        let body = "x".repeat(bytes.saturating_sub(head.len()));
        std::fs::write(&path, format!("{head}{body}")).unwrap();
    }

    #[test]
    fn buckets_split_on_the_substance_floor_and_ceiling() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "sessions/2026-08/small.md", 1_000, Some(10));
        write(root, "sessions/2026-08/good.md", 20_000, Some(20));
        write(root, "sessions/archive/also-good.md", 9_000, Some(30));
        write(root, "sessions/archive/huge.md", 300_000, Some(40));

        let files = scan_sessions(root).files;
        assert_eq!(files.len(), 4, "archive/ counts — digested is not wikified");
        let s = summarize(&files, &BTreeMap::new());
        assert_eq!(
            (s.total, s.eligible, s.too_small, s.too_large),
            (4, 2, 1, 1)
        );
        assert_eq!(s.promoted, 0);
    }

    #[test]
    fn batch_is_newest_first_and_never_repeats() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "sessions/a.md", 20_000, Some(100));
        write(root, "sessions/b.md", 20_000, Some(300));
        write(root, "sessions/c.md", 20_000, Some(200));

        let files = scan_sessions(root).files;
        let first = next_batch(&files, &BTreeMap::new(), 2);
        assert_eq!(
            first.iter().map(|f| f.rel.as_str()).collect::<Vec<_>>(),
            vec!["sessions/b.md", "sessions/c.md"]
        );

        let mut done = BTreeMap::new();
        for f in &first {
            done.insert(f.rel.clone(), 1);
        }
        let second = next_batch(&files, &done, 2);
        assert_eq!(
            second.iter().map(|f| f.rel.as_str()).collect::<Vec<_>>(),
            vec!["sessions/a.md"]
        );
    }

    #[test]
    fn promote_copies_into_inbox_and_leaves_the_archive_alone() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "sessions/2026-08/talk.md", 20_000, Some(500));
        write(root, "sessions/2026-08/tiny.md", 100, Some(600));

        let out = promote_at(root, 10).unwrap();
        assert_eq!(out.promoted, vec!["talk.md".to_string()]);
        assert_eq!(
            out.remaining, 0,
            "only the tiny one is left, and it is not eligible"
        );
        assert!(root.join("_inbox/talk.md").is_file());
        assert!(
            root.join("sessions/2026-08/talk.md").is_file(),
            "sessions/ is an archive — promotion copies"
        );

        // A second press finds nothing new and writes nothing.
        let again = promote_at(root, 10).unwrap();
        assert!(again.promoted.is_empty());
        let s = backfill_summary(root);
        assert_eq!((s.promoted, s.eligible), (1, 0));
    }

    #[test]
    fn a_name_already_in_the_inbox_gets_a_suffix() {
        let taken = |n: &str| n == "talk.md" || n == "talk-2.md";
        assert_eq!(inbox_name("sessions/x/talk.md", &taken), "talk-3.md");
        assert_eq!(inbox_name("sessions/x/other.md", &taken), "other.md");
    }

    #[test]
    fn a_corrupt_state_file_is_a_read_failure_and_recovers_after_repair() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".myco")).unwrap();
        std::fs::write(root.join(".myco/backfill.json"), "{ not json").unwrap();
        write(root, "sessions/a.md", 20_000, Some(1));
        let source_before = std::fs::read(root.join("sessions/a.md")).unwrap();

        let status = backfill_summary(root);
        let wire = serde_json::to_value(&status).unwrap();
        assert_eq!(wire["read_status"], "read_failed");
        assert_eq!(status.eligible, 0);
        assert!(wire["read_issues"]
            .as_array()
            .expect("a failed read must carry path-specific issues")
            .iter()
            .any(|issue| issue["path"] == ".myco/backfill.json"));
        assert!(promote_at(root, 5).is_err());
        assert!(!root.join("_inbox").exists());
        assert_eq!(
            std::fs::read_to_string(state_path(root)).unwrap(),
            "{ not json"
        );
        assert_eq!(
            std::fs::read(root.join("sessions/a.md")).unwrap(),
            source_before
        );

        std::fs::write(state_path(root), "{}").unwrap();
        let recovered = backfill_summary(root);
        let wire = serde_json::to_value(&recovered).unwrap();
        assert_eq!(wire["read_status"], "complete");
        assert!(wire["read_issues"].as_array().unwrap().is_empty());
        assert_eq!((recovered.promoted, recovered.eligible), (0, 1));
        assert_eq!(std::fs::read(state_path(root)).unwrap(), b"{}");
        assert_eq!(
            std::fs::read(root.join("sessions/a.md")).unwrap(),
            source_before
        );
        assert!(!root.join("_inbox").exists());
    }

    #[test]
    fn regular_state_reads_keep_the_exact_snapshot_bytes_and_revision() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let body = b" {\n  \"promoted\": {}, \"pending\": {}, \"completed\": {}\n}\n";
        std::fs::create_dir(root.join(".myco")).unwrap();
        std::fs::write(state_path(root), body).unwrap();
        let (state, snapshot) = read_state_snapshot(root).unwrap();
        assert!(state.promoted.is_empty());
        assert!(state.pending.is_empty());
        assert!(state.completed.is_empty());
        assert_eq!(
            snapshot.as_deref(),
            Some("b8fca454be9e4dd78a822cafb9380ef10f80ff734db10749afd39c275184b596")
        );
        let status = status_at(root);
        assert_eq!(status.read_status, ReadStatus::Complete);
        assert!(status.read_issues.is_empty());
        assert_eq!(std::fs::read(state_path(root)).unwrap(), body);
        assert!(!root.join("_inbox").exists());
    }

    #[test]
    fn missing_optional_archive_and_state_are_complete_without_writes() {
        let dir = tempfile::tempdir().unwrap();
        let status = status_at(dir.path());
        assert_eq!(status.read_status, ReadStatus::Complete);
        assert!(status.read_issues.is_empty());
        assert_eq!((status.total, status.promoted, status.eligible), (0, 0, 0));
        assert!(!dir.path().join(".myco").exists());
        assert!(!dir.path().join("sessions").exists());
        assert!(!dir.path().join("_inbox").exists());
    }

    #[test]
    fn an_archive_path_that_is_a_file_is_partial_and_recovers_after_repair() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let sentinel = b"synthetic file occupying the optional archive path";
        std::fs::write(root.join("sessions"), sentinel).unwrap();
        let status = status_at(root);
        assert_eq!(status.read_status, ReadStatus::Partial);
        assert_eq!(status.eligible, 0);
        assert!(status.read_issues.iter().any(|issue| {
            issue.path == "sessions" && issue.code == ReadIssueCode::DirectoryRead
        }));
        assert!(promote_at(root, 5).is_err());
        assert_eq!(std::fs::read(root.join("sessions")).unwrap(), sentinel);
        assert!(!root.join("_inbox").exists());

        std::fs::remove_file(root.join("sessions")).unwrap();
        write(root, "sessions/recovered.md", 20_000, Some(1));
        let recovered = status_at(root);
        assert_eq!(recovered.read_status, ReadStatus::Complete);
        assert!(recovered.read_issues.is_empty());
        assert_eq!(recovered.eligible, 1);
        assert!(!state_path(root).exists());
    }

    /// Test-only helper mirroring the command's read path.
    fn backfill_summary(root: &Path) -> BackfillStatus {
        status_at(root)
    }
}
