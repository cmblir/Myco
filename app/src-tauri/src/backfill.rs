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

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Below this a session is chatter, not knowledge (1,231 of 1,428 files).
pub const MIN_BYTES: u64 = 8 * 1024;
/// Above this one ingest run is a bad deal even for a tool-capable provider.
pub const MAX_BYTES: u64 = 200 * 1024;
/// The archive this reads from, and the queue it promotes into.
const SESSIONS_DIR: &str = "sessions";
const INBOX_DIR: &str = "_inbox";

/// Promotion bookkeeping. Its OWN file on purpose: `importers::ledger` drops
/// unknown keys when it saves, so a field added to `ledger.json` would be
/// erased by the next in-app import.
#[derive(Serialize, Deserialize, Default)]
struct BackfillState {
    /// vault-relative session path → unix seconds when it was promoted.
    #[serde(default)]
    promoted: BTreeMap<String, i64>,
}

fn state_path(root: &Path) -> PathBuf {
    root.join(".myco").join("backfill.json")
}

fn load_state(root: &Path) -> BackfillState {
    // A corrupt or missing file reads as empty: this is bookkeeping, not a
    // source of truth, so losing it costs a round of re-promotions at worst.
    std::fs::read_to_string(state_path(root))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_state(root: &Path, state: &BackfillState) -> Result<(), String> {
    let path = state_path(root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create .myco: {e}"))?;
    }
    let body = serde_json::to_string_pretty(state).map_err(|e| format!("encode state: {e}"))?;
    std::fs::write(&path, body).map_err(|e| format!("write state: {e}"))
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

/// Every `.md` under `sessions/`, including `sessions/archive/` — a session
/// that was digested into `daily/` and cold-archived is still un-wikified,
/// which is the whole point of this module.
pub fn scan_sessions(root: &Path) -> Vec<SessionFile> {
    let base = root.join(SESSIONS_DIR);
    let mut out = Vec::new();
    let mut stack = vec![base.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            let Ok(rel) = path.strip_prefix(root) else {
                continue;
            };
            let created = read_created(&path).unwrap_or_else(|| mtime_secs(&meta));
            out.push(SessionFile {
                rel: rel.to_string_lossy().replace('\\', "/"),
                bytes: meta.len(),
                created,
            });
        }
    }
    out
}

fn mtime_secs(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// `created: <unix seconds>` out of the frontmatter, read from the head of the
/// file only — some sessions are megabytes and none of that is needed here.
fn read_created(path: &Path) -> Option<i64> {
    use std::io::Read as _;
    let mut head = [0u8; 512];
    let mut file = std::fs::File::open(path).ok()?;
    let n = file.read(&mut head).ok()?;
    let text = String::from_utf8_lossy(&head[..n]);
    if !text.starts_with("---") {
        return None;
    }
    for line in text.lines().skip(1) {
        if line.starts_with("---") {
            break;
        }
        if let Some(v) = line.strip_prefix("created:") {
            return v.trim().parse::<i64>().ok();
        }
    }
    None
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
}

/// Split the scan into the four buckets, given what has already been promoted.
pub fn summarize(files: &[SessionFile], state_promoted: &BTreeMap<String, i64>) -> BackfillStatus {
    let mut s = BackfillStatus {
        total: files.len(),
        promoted: 0,
        eligible: 0,
        too_small: 0,
        too_large: 0,
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

#[derive(Serialize)]
pub struct BackfillPromotion {
    /// `_inbox/` names that now hold a copy, in promotion order.
    pub promoted: Vec<String>,
    /// Still eligible after this batch.
    pub remaining: usize,
}

/// Copy the next `limit` eligible sessions into `_inbox/` and record them.
/// Testable core: takes the vault root, no Tauri state.
pub fn promote_at(root: &Path, limit: usize) -> Result<BackfillPromotion, String> {
    let limit = limit.clamp(1, 50);
    let files = scan_sessions(root);
    let mut state = load_state(root);
    let batch = next_batch(&files, &state.promoted, limit);
    let inbox = root.join(INBOX_DIR);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let mut promoted = Vec::new();
    for file in &batch {
        let src = root.join(&file.rel);
        let name = inbox_name(&file.rel, &|n: &str| inbox.join(n).exists());
        // Reuses the notch drop's copy: same confinement (safe_join), same
        // no-overwrite rule, same size cap.
        match crate::commands::copy_into_inbox_at(root, &src.to_string_lossy(), &name) {
            Ok(_) => {
                state.promoted.insert(file.rel.clone(), now);
                promoted.push(name);
            }
            // One unreadable session must not abort the batch — record nothing
            // for it so the next press retries it.
            Err(e) => eprintln!("backfill: skipped {}: {e}", file.rel),
        }
    }
    if !promoted.is_empty() {
        save_state(root, &state)?;
    }
    let remaining = summarize(&files, &state.promoted).eligible;
    Ok(BackfillPromotion {
        promoted,
        remaining,
    })
}

/// Counts for the Ingest card.
#[tauri::command]
pub fn backfill_status(
    state: tauri::State<crate::commands::VaultRoot>,
) -> Result<BackfillStatus, String> {
    let root = crate::commands::require_root(&state)?;
    let files = scan_sessions(&root);
    Ok(summarize(&files, &load_state(&root).promoted))
}

/// Promote the next batch of sessions into `_inbox/`.
#[tauri::command]
pub fn promote_sessions(
    state: tauri::State<crate::commands::VaultRoot>,
    limit: usize,
) -> Result<BackfillPromotion, String> {
    let root = crate::commands::require_root(&state)?;
    promote_at(&root, limit)
}

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

        let files = scan_sessions(root);
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

        let files = scan_sessions(root);
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
    fn a_corrupt_state_file_reads_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".myco")).unwrap();
        std::fs::write(root.join(".myco/backfill.json"), "{ not json").unwrap();
        write(root, "sessions/a.md", 20_000, Some(1));
        // Bookkeeping, not truth: a broken file costs a re-promotion, not a run.
        let out = promote_at(root, 5).unwrap();
        assert_eq!(out.promoted, vec!["a.md".to_string()]);
    }

    /// Test-only helper mirroring the command's read path.
    fn backfill_summary(root: &Path) -> BackfillStatus {
        summarize(&scan_sessions(root), &load_state(root).promoted)
    }
}
