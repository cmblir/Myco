//! Harvest — the hand-picked path from `sessions/` into the wiki.
//!
//! `backfill.rs` promotes the next N eligible sessions blind, and had never
//! been run. This module shows the queue first: every session in the
//! substance band, minus the copies (`ledger::body_hash` — 1,473 files held
//! 719 distinct bodies on the owner's vault), minus the junk
//! (`distill::junk_reason`, which the ingest path never called), newest
//! first, each with a title, a preview and the wiki page it most likely
//! belongs to. Then it promotes exactly the sessions the owner picked,
//! through backfill's own copy and state file, so the two never disagree
//! about what has been harvested. `raw/` and `sessions/` are read, never
//! written; the copy lands in `_inbox/` for the ordinary ingest pass.
//!
//! The commands live in `commands.rs` (`harvest_candidates` adds the
//! `cluster` lookup, which needs the embedder); everything here takes a vault
//! root and is tested against a temp dir.

use crate::backfill::{
    self, ReadIssue, ReadIssueCode, ReadStatus, MAX_BYTES, MIN_BYTES, SESSIONS_DIR,
};
use crate::importers::ledger::{body_hash, strip_frontmatter};
use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;

/// Leading characters of a candidate's body the command embeds to place it
/// — the same window `distill`'s gate uses; enough to find the topic without
/// paying for the whole transcript.
const EMBED_CHARS: usize = 2000;
/// Preview lines per candidate, and the width each is cut to.
const PREVIEW_LINES: usize = 3;
const PREVIEW_CHARS: usize = 160;
/// Citation-estimate ceiling: the ingest agent writes a handful of cited
/// claims per source however long the transcript runs.
const MAX_EST_CITATIONS: usize = 8;

/// The wiki page a candidate most likely belongs to: `pipeline::rank_candidates`
/// top-1, `score` being the cosine similarity it measured (not a rank).
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Cluster {
    pub page: String,
    pub score: f32,
}

/// One session the owner can harvest.
#[derive(Serialize, Debug)]
pub struct Candidate {
    /// Absolute path, the argument `harvest_run` takes back.
    pub path: String,
    /// Vault-relative, forward-slashed (`sessions/2026-08/claude-code-abc.md`).
    pub rel: String,
    pub size_bytes: u64,
    /// File mtime, unix seconds.
    pub mtime: i64,
    /// The doc's `# heading`, else its file stem.
    pub title: String,
    /// Up to three non-empty body lines after the title, turn markers skipped.
    pub preview: Vec<String>,
    /// Filled in by the command; `None` when nothing is indexed or the embed
    /// was skipped. The queue is useful without it.
    pub cluster: Option<Cluster>,
    /// See `est_citations` — an estimate for display and ordering.
    pub est_citations: u32,
    /// Only `"session"` is queued today; `"raw"` is reserved in the contract.
    pub kind: &'static str,
    /// What the command embeds to find `cluster`. Not part of the payload.
    #[serde(skip)]
    pub embed_text: String,
}

/// Why a scanned session is not in the queue. Each file lands in exactly one
/// bucket, in this order of precedence.
#[derive(Serialize, Default, Debug, PartialEq)]
pub struct Excluded {
    /// Same body as a newer session (or a harvested one) — the newest copy of
    /// each body is the one that stays in the queue.
    pub duplicate: u32,
    /// `distill::junk_reason` hit: under 200 bytes of body or ≥ 90 % tool-noise lines.
    pub boilerplate: u32,
    /// Under `backfill::MIN_BYTES`.
    pub too_small: u32,
    /// Over `backfill::MAX_BYTES` — held, not hidden.
    pub too_large: u32,
    /// Explicitly completed at the current source revision, per `.myco/backfill.json`.
    pub already_harvested: u32,
}

/// What `harvest_candidates` returns.
#[derive(Serialize, Debug)]
pub struct Queue {
    /// Newest first, at most `limit`.
    pub items: Vec<Candidate>,
    pub excluded: Excluded,
    /// Session files examined (harvested ones included; unreadable ones not).
    pub total_scanned: u32,
    /// Distinct `body_hash` values across `total_scanned`.
    pub distinct_bodies: u32,
    /// Candidates before the `limit` cut, so the UI can say "20 of 137".
    pub eligible: u32,
    pub read_status: ReadStatus,
    pub read_issues: Vec<ReadIssue>,
}

/// Build the queue. Reads every session once: the body hash needs the text,
/// and the whole-corpus `distinct_bodies` number is the point of the scan.
// ponytail: O(total session bytes) per call (~tens of MB on the owner's
// vault); cache hashes by (mtime, len) in the state file if the Overview
// feels it.
pub fn scan_at(root: &Path, limit: usize) -> Queue {
    let state = match backfill::load_state(root) {
        Ok(state) => state,
        Err(issue) => {
            return Queue {
                items: Vec::new(),
                excluded: Excluded::default(),
                total_scanned: 0,
                distinct_bodies: 0,
                eligible: 0,
                read_status: ReadStatus::ReadFailed,
                read_issues: vec![issue],
            };
        }
    };
    let scan = backfill::scan_sessions(root);
    if scan.read_status == ReadStatus::ReadFailed {
        return Queue {
            items: Vec::new(),
            excluded: Excluded::default(),
            total_scanned: 0,
            distinct_bodies: 0,
            eligible: 0,
            read_status: ReadStatus::ReadFailed,
            read_issues: scan.read_issues,
        };
    }
    let completion = backfill::completed_sources(root, &state);
    let mut read_issues = scan.read_issues;
    read_issues.extend(completion.read_issues);
    let mut files = scan.files;
    files.retain(|file| !completion.unverified.contains(&file.rel));
    files.sort_by(|a, b| b.created.cmp(&a.created).then_with(|| a.rel.cmp(&b.rel)));
    let promoted = completion.completed;
    // Harvested sessions go first whatever their age: a newer, unharvested
    // copy of a body that is already in the wiki is a duplicate, not a
    // candidate.
    let (harvested, rest): (Vec<_>, Vec<_>) = files
        .into_iter()
        .partition(|f| promoted.contains_key(&f.rel));

    let mut excluded = Excluded::default();
    let mut kept: HashSet<String> = HashSet::new();
    let mut distinct: HashSet<String> = HashSet::new();
    let mut total_scanned = 0u32;
    let mut eligible = 0u32;
    let mut items = Vec::new();

    for f in &harvested {
        let content = match backfill::read_session_text(&root.join(&f.rel)) {
            Ok(content) => content,
            Err(error) => {
                read_issues.push(ReadIssue::new(
                    &f.rel,
                    ReadIssueCode::BodyRead,
                    format!("read harvested session body: {error}"),
                ));
                continue;
            }
        };
        total_scanned += 1;
        excluded.already_harvested += 1;
        let hash = body_hash(&content);
        distinct.insert(hash.clone());
        kept.insert(hash);
    }
    for f in rest {
        let abs = root.join(&f.rel);
        let content = match backfill::read_session_text(&abs) {
            Ok(content) => content,
            Err(error) => {
                read_issues.push(ReadIssue::new(
                    &f.rel,
                    ReadIssueCode::BodyRead,
                    format!("read session body: {error}"),
                ));
                continue;
            }
        };
        let metadata = match std::fs::metadata(&abs) {
            Ok(metadata) if metadata.is_file() => metadata,
            Ok(_) => {
                read_issues.push(ReadIssue::new(
                    &f.rel,
                    ReadIssueCode::MetadataRead,
                    "session document is no longer a regular file",
                ));
                continue;
            }
            Err(error) => {
                read_issues.push(ReadIssue::new(
                    &f.rel,
                    ReadIssueCode::MetadataRead,
                    format!("read session metadata after body: {error}"),
                ));
                continue;
            }
        };
        total_scanned += 1;
        let hash = body_hash(&content);
        distinct.insert(hash.clone());
        if f.bytes < MIN_BYTES {
            excluded.too_small += 1;
            continue;
        }
        if f.bytes > MAX_BYTES {
            excluded.too_large += 1;
            continue;
        }
        if !kept.insert(hash) {
            excluded.duplicate += 1;
            continue;
        }
        let body = strip_frontmatter(&content);
        if crate::distill::junk_reason(body).is_some() {
            excluded.boilerplate += 1;
            continue;
        }
        eligible += 1;
        if items.len() < limit {
            let mtime = metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(f.created);
            items.push(Candidate {
                path: abs.to_string_lossy().into_owned(),
                rel: f.rel.clone(),
                size_bytes: f.bytes,
                mtime,
                title: title(body, &f.rel),
                preview: preview(body),
                cluster: None,
                est_citations: est_citations(body),
                kind: "session",
                embed_text: body.chars().take(EMBED_CHARS).collect(),
            });
        }
    }
    Queue {
        items,
        excluded,
        total_scanned,
        distinct_bodies: distinct.len() as u32,
        eligible,
        read_status: if read_issues.is_empty() {
            ReadStatus::Complete
        } else {
            ReadStatus::Partial
        },
        read_issues,
    }
}

/// The doc's first `# heading`, else the file stem.
fn title(body: &str, rel: &str) -> String {
    body.lines()
        .find_map(|l| l.strip_prefix("# "))
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            let base = rel.rsplit('/').next().unwrap_or(rel);
            base.strip_suffix(".md").unwrap_or(base).to_string()
        })
}

/// `**User:**` / `**Assistant:**` — the turn markers `to_inbox_doc` writes.
fn is_turn_marker(line: &str) -> bool {
    line.starts_with("**") && line.ends_with(":**")
}

fn preview(body: &str) -> Vec<String> {
    body.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("# ") && !is_turn_marker(l))
        .take(PREVIEW_LINES)
        .map(|l| {
            let mut s: String = l.chars().take(PREVIEW_CHARS).collect();
            if s.len() < l.len() {
                s.push('…');
            }
            s
        })
        .collect()
}

/// ESTIMATED citations this session would contribute: one per user turn
/// (`**User:**` marker), at least 1, at most `MAX_EST_CITATIONS`. A cheap
/// proxy for "how many distinct things were asked", not a measurement of what
/// the ingest agent will actually cite.
fn est_citations(body: &str) -> u32 {
    body.lines()
        .filter(|l| l.trim() == "**User:**")
        .count()
        .clamp(1, MAX_EST_CITATIONS) as u32
}

/// A chosen path that could not be harvested, and why.
#[derive(Serialize, Debug, PartialEq)]
pub struct Skipped {
    pub path: String,
    pub reason: String,
}

/// What `harvest_run` returns.
#[derive(Serialize, Debug)]
pub struct Run {
    pub copied: u32,
    /// Vault-relative paths of the copies now waiting for ingest.
    pub inbox_rels: Vec<String>,
    pub inbox_sources: Vec<backfill::InboxSourceBinding>,
    pub skipped: Vec<Skipped>,
}

/// Copy or resume chosen sessions in `_inbox/`; completion removes them from
/// the queue only after the ingest archive receipt. Anything that is not a `.md`
/// under this vault's `sessions/` is refused before any IO — `raw/` and the
/// rest of the vault are never touched.
pub fn run_at(root: &Path, paths: &[String]) -> Result<Run, String> {
    run_at_impl(
        root,
        paths,
        #[cfg(test)]
        |_| Ok(()),
    )
}

fn run_at_impl(
    root: &Path,
    paths: &[String],
    #[cfg(test)] before_save: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<Run, String> {
    let state = backfill::load_state(root).map_err(|issue| issue.message)?;
    let completion = backfill::completed_sources(root, &state);
    let promoted = completion.completed;
    let mut rels: Vec<String> = Vec::new();
    let mut skipped = Vec::new();
    for path in paths {
        match session_rel(root, path) {
            Ok(rel) if completion.unverified.contains(&rel) => skipped.push(Skipped {
                path: path.clone(),
                reason: "harvest completion could not be verified".to_string(),
            }),
            Ok(rel) if promoted.contains_key(&rel) => skipped.push(Skipped {
                path: path.clone(),
                reason: "already harvested".to_string(),
            }),
            Ok(rel) if rels.contains(&rel) => skipped.push(Skipped {
                path: path.clone(),
                reason: "listed twice".to_string(),
            }),
            Ok(rel) => rels.push(rel),
            Err(reason) => skipped.push(Skipped {
                path: path.clone(),
                reason,
            }),
        }
    }
    let done = backfill::promote_rels_impl(
        root,
        &rels,
        #[cfg(test)]
        before_save,
        #[cfg(test)]
        |_, _| Ok(()),
    )?;
    skipped.extend(done.failed.into_iter().map(|(rel, reason)| Skipped {
        path: root.join(rel).to_string_lossy().into_owned(),
        reason,
    }));
    let copied = done.names.len() as u32;
    crate::inflow_log::record_n(root, "harvest", "session", done.created);
    Ok(Run {
        copied,
        inbox_rels: done
            .names
            .into_iter()
            .map(|n| format!("_inbox/{n}"))
            .collect(),
        inbox_sources: done.inbox_sources,
        skipped,
    })
}

/// The vault-relative `sessions/…` path for a chosen file — absolute (as the
/// queue hands it out) or already relative. Everything else is an error.
fn session_rel(root: &Path, path: &str) -> Result<String, String> {
    let p = Path::new(path);
    let rel = if p.is_absolute() {
        p.strip_prefix(root)
            .map_err(|_| format!("outside the vault: {path}"))?
            .to_string_lossy()
            .replace('\\', "/")
    } else {
        path.replace('\\', "/")
    };
    // Rejects `..`, `.`, a leading `/`, backslashes and NULs.
    crate::myco_pro::safe_join(root, &rel)?;
    let under_sessions = rel
        .strip_prefix(SESSIONS_DIR)
        .is_some_and(|r| r.starts_with('/'));
    if !under_sessions {
        return Err(format!("not under {SESSIONS_DIR}/: {path}"));
    }
    if !rel.ends_with(".md") {
        return Err(format!("not a session document: {path}"));
    }
    backfill::session_path(root, &rel)?;
    Ok(rel)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::importers::ledger::boilerplate_doc;

    /// A session doc of about `bytes` bytes with `turns` user turns and a
    /// distinct body per `seed`.
    fn session_doc(seed: &str, bytes: usize, turns: usize) -> String {
        let mut s = format!("---\nsource: claude-code\nconversation_id: {seed}\ncreated: 1\n---\n\n# Talk about {seed}\n\n");
        let filler = format!("Some prose about {seed} that is not tool noise. ");
        let per_turn = bytes / turns.max(1);
        for i in 0..turns.max(1) {
            s.push_str("**User:**\n\n");
            s.push_str(&format!("question {i} on {seed}\n\n**Assistant:**\n\n"));
            while s.len() < per_turn * (i + 1) {
                s.push_str(&filler);
            }
            s.push('\n');
        }
        s
    }

    fn write(root: &Path, rel: &str, content: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn rels(q: &Queue) -> Vec<&str> {
        q.items.iter().map(|c| c.rel.as_str()).collect()
    }

    #[test]
    fn corrupt_state_is_a_read_failure_without_candidates_and_recovers_after_repair() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let source_rel = "sessions/synthetic.md";
        let source = session_doc("read-recovery", 10_000, 1);
        write(root, source_rel, &source);
        let state_rel = ".myco/backfill.json";
        let corrupt = "{ invalid synthetic backfill state";
        write(root, state_rel, corrupt);
        let source_before = std::fs::read(root.join(source_rel)).unwrap();
        let state_before = std::fs::read(root.join(state_rel)).unwrap();

        let failed = scan_at(root, 20);
        let wire = serde_json::to_value(&failed).unwrap();
        assert_eq!(wire["read_status"], "read_failed");
        assert!(failed.items.is_empty(), "unknown state is not eligibility");
        assert_eq!(failed.eligible, 0);
        assert!(wire["read_issues"]
            .as_array()
            .expect("a failed read must carry path-specific issues")
            .iter()
            .any(|issue| issue["path"] == state_rel));
        assert_eq!(std::fs::read(root.join(state_rel)).unwrap(), state_before);
        assert_eq!(std::fs::read(root.join(source_rel)).unwrap(), source_before);
        assert!(!root.join("_inbox").exists());

        std::fs::write(root.join(state_rel), "{}").unwrap();
        let recovered = scan_at(root, 20);
        let wire = serde_json::to_value(&recovered).unwrap();
        assert_eq!(wire["read_status"], "complete");
        assert!(wire["read_issues"].as_array().unwrap().is_empty());
        assert_eq!(recovered.eligible, 1);
        assert_eq!(rels(&recovered), vec![source_rel]);
        assert_eq!(std::fs::read(root.join(state_rel)).unwrap(), b"{}");
        assert_eq!(std::fs::read(root.join(source_rel)).unwrap(), source_before);
        assert!(!root.join("_inbox").exists());
    }

    #[test]
    fn a_missing_vault_root_is_read_failed_and_recovers_after_creation() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("missing-vault");
        let queue = scan_at(&root, 20);
        assert_eq!(queue.read_status, ReadStatus::ReadFailed);
        assert!(queue.items.is_empty());
        assert_eq!(
            (queue.eligible, queue.total_scanned, queue.distinct_bodies),
            (0, 0, 0)
        );
        assert!(queue
            .read_issues
            .iter()
            .any(|issue| { issue.path == "." && issue.code == ReadIssueCode::DirectoryRead }));
        let status = backfill::status_at(&root);
        assert_eq!(status.read_status, ReadStatus::ReadFailed);
        assert_eq!((status.total, status.promoted, status.eligible), (0, 0, 0));
        assert!(status.read_issues.iter().any(|issue| issue.path == "."));
        let scan = backfill::scan_sessions(&root);
        assert_eq!(scan.read_status, ReadStatus::ReadFailed);
        assert!(scan.files.is_empty());
        assert!(!root.exists());

        std::fs::create_dir(&root).unwrap();
        let empty = scan_at(&root, 20);
        assert_eq!(empty.read_status, ReadStatus::Complete);
        assert!(empty.read_issues.is_empty());
        assert!(empty.items.is_empty());
        write(
            &root,
            "sessions/recovered.md",
            &session_doc("root-recovery", 10_000, 1),
        );
        let recovered = scan_at(&root, 20);
        assert_eq!(recovered.read_status, ReadStatus::Complete);
        assert!(recovered.read_issues.is_empty());
        assert_eq!(rels(&recovered), vec!["sessions/recovered.md"]);
        let status = backfill::status_at(&root);
        assert_eq!(status.read_status, ReadStatus::Complete);
        assert_eq!(status.eligible, 1);
        assert!(!root.join(".myco").exists());
        assert!(!root.join("_inbox").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_denied_vault_root_is_read_failed_and_recovers_after_permission_restore() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let doc = session_doc("root-permission", 10_000, 1);
        write(root, "sessions/synthetic.md", &doc);
        let denied = crate::vault::scan_tests::DeniedDirectory::new(root);
        let queue = scan_at(root, 20);
        let status = backfill::status_at(root);
        let scan = backfill::scan_sessions(root);
        drop(denied);
        assert_eq!(queue.read_status, ReadStatus::ReadFailed);
        assert!(queue.items.is_empty());
        assert_eq!((queue.eligible, queue.total_scanned), (0, 0));
        assert!(queue
            .read_issues
            .iter()
            .any(|issue| { issue.path == "." && issue.code == ReadIssueCode::DirectoryRead }));
        assert_eq!(status.read_status, ReadStatus::ReadFailed);
        assert_eq!((status.total, status.eligible), (0, 0));
        assert_eq!(scan.read_status, ReadStatus::ReadFailed);
        assert!(scan.files.is_empty());
        assert_eq!(
            std::fs::read(root.join("sessions/synthetic.md")).unwrap(),
            doc.as_bytes()
        );
        assert!(!root.join(".myco").exists());
        assert!(!root.join("_inbox").exists());

        let recovered = scan_at(root, 20);
        assert_eq!(recovered.read_status, ReadStatus::Complete);
        assert!(recovered.read_issues.is_empty());
        assert_eq!(rels(&recovered), vec!["sessions/synthetic.md"]);
    }

    #[test]
    fn missing_optional_archive_and_state_are_a_complete_empty_queue() {
        let dir = tempfile::tempdir().unwrap();
        let queue = scan_at(dir.path(), 20);
        assert_eq!(queue.read_status, ReadStatus::Complete);
        assert!(queue.read_issues.is_empty());
        assert!(queue.items.is_empty());
        assert_eq!((queue.eligible, queue.total_scanned), (0, 0));
        assert!(!dir.path().join(".myco").exists());
        assert!(!dir.path().join("sessions").exists());
        assert!(!dir.path().join("_inbox").exists());
    }

    #[test]
    fn an_unreadable_state_path_is_not_empty_bookkeeping_and_can_recover() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let doc = session_doc("state-recovery", 10_000, 1);
        write(root, "sessions/synthetic.md", &doc);
        std::fs::create_dir_all(root.join(".myco/backfill.json")).unwrap();
        let queue = scan_at(root, 20);
        assert_eq!(queue.read_status, ReadStatus::ReadFailed);
        assert!(queue.items.is_empty());
        assert_eq!(queue.eligible, 0);
        assert!(queue.read_issues.iter().any(|issue| {
            issue.path == ".myco/backfill.json" && issue.code == ReadIssueCode::StateRead
        }));
        assert!(root.join(".myco/backfill.json").is_dir());
        assert_eq!(
            std::fs::read(root.join("sessions/synthetic.md")).unwrap(),
            doc.as_bytes()
        );
        assert!(!root.join("_inbox").exists());

        std::fs::remove_dir(root.join(".myco/backfill.json")).unwrap();
        let recovered = scan_at(root, 20);
        assert_eq!(recovered.read_status, ReadStatus::Complete);
        assert!(recovered.read_issues.is_empty());
        assert_eq!(rels(&recovered), vec!["sessions/synthetic.md"]);
    }

    #[test]
    fn invalid_utf8_is_reported_beside_confirmed_candidates_and_recovers() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "sessions/good.md", &session_doc("good", 10_000, 1));
        let mut invalid = vec![b'x'; MIN_BYTES as usize + 100];
        invalid[0] = 0xff;
        std::fs::write(root.join("sessions/unreadable.md"), &invalid).unwrap();
        let queue = scan_at(root, 20);
        assert_eq!(queue.read_status, ReadStatus::Partial);
        assert_eq!(rels(&queue), vec!["sessions/good.md"]);
        assert_eq!((queue.eligible, queue.total_scanned), (1, 1));
        assert!(queue.read_issues.iter().any(|issue| {
            issue.path == "sessions/unreadable.md" && issue.code == ReadIssueCode::BodyRead
        }));
        assert_eq!(
            std::fs::read(root.join("sessions/unreadable.md")).unwrap(),
            invalid
        );
        assert!(!root.join("_inbox").exists());

        write(
            root,
            "sessions/unreadable.md",
            &session_doc("repaired", 10_000, 1),
        );
        let recovered = scan_at(root, 20);
        assert_eq!(recovered.read_status, ReadStatus::Complete);
        assert!(recovered.read_issues.is_empty());
        assert_eq!((recovered.eligible, recovered.items.len()), (2, 2));
    }

    #[cfg(unix)]
    #[test]
    fn denied_subtree_and_completion_reads_are_partial_and_recover() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "sessions/good.md", &session_doc("good", 10_000, 1));
        let completed = session_doc("completed", 10_000, 1);
        write(root, "sessions/denied/done.md", &completed);
        let revision = crate::importers::wikify::source_revision(&completed);
        let state = serde_json::json!({
            "completed": {
                "sessions/denied/done.md": {"source_revision": revision, "completed_at": 1}
            }
        });
        write(root, ".myco/backfill.json", &state.to_string());
        let state_before = std::fs::read(root.join(".myco/backfill.json")).unwrap();
        let denied = crate::vault::scan_tests::DeniedDirectory::new(&root.join("sessions/denied"));
        let queue = scan_at(root, 20);
        drop(denied);
        assert_eq!(queue.read_status, ReadStatus::Partial);
        assert_eq!(rels(&queue), vec!["sessions/good.md"]);
        assert_eq!(queue.excluded.already_harvested, 0);
        assert!(queue.read_issues.iter().any(|issue| {
            issue.path == "sessions/denied" && issue.code == ReadIssueCode::DirectoryRead
        }));
        assert!(queue.read_issues.iter().any(|issue| {
            issue.path == "sessions/denied/done.md" && issue.code == ReadIssueCode::CompletionRead
        }));
        assert_eq!(
            std::fs::read(root.join(".myco/backfill.json")).unwrap(),
            state_before
        );
        assert_eq!(
            std::fs::read(root.join("sessions/denied/done.md")).unwrap(),
            completed.as_bytes()
        );
        assert!(!root.join("_inbox").exists());

        let recovered = scan_at(root, 20);
        assert_eq!(recovered.read_status, ReadStatus::Complete);
        assert!(recovered.read_issues.is_empty());
        assert_eq!(rels(&recovered), vec!["sessions/good.md"]);
        assert_eq!(recovered.excluded.already_harvested, 1);
    }

    #[cfg(unix)]
    #[test]
    fn unix_backslashes_are_held_and_hidden_sessions_are_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let valid = session_doc("valid", 10_000, 1);
        write(root, "sessions/.hidden.md", &valid);
        let backslash_path = root.join("sessions/literal\\name.md");
        std::fs::write(&backslash_path, session_doc("backslash-name", 10_000, 1)).unwrap();
        let queue = scan_at(root, 20);
        assert_eq!(queue.read_status, ReadStatus::Partial);
        assert_eq!(rels(&queue), vec!["sessions/.hidden.md"]);
        assert_eq!(queue.read_issues.len(), 1);
        assert!(queue.read_issues.iter().all(|issue| {
            issue.path == "sessions" && issue.code == ReadIssueCode::MetadataRead
        }));
        assert!(backslash_path.is_file());
        assert_eq!(
            std::fs::read(root.join("sessions/.hidden.md")).unwrap(),
            valid.as_bytes()
        );
        assert!(!root.join("_inbox").exists());
    }

    // APFS rejects non-UTF-8 names at creation; Linux can exercise discovery of them.
    #[cfg(target_os = "linux")]
    #[test]
    fn non_utf8_names_are_held_without_lossy_path_candidates() {
        use std::os::unix::ffi::OsStringExt;
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let valid = session_doc("valid", 10_000, 1);
        write(root, "sessions/.hidden.md", &valid);
        let invalid_name = std::ffi::OsString::from_vec(b"invalid-\xff.md".to_vec());
        let invalid_path = root.join("sessions").join(invalid_name);
        let invalid = session_doc("invalid-name", 10_000, 1);
        std::fs::write(&invalid_path, &invalid).unwrap();
        let queue = scan_at(root, 20);
        assert_eq!(queue.read_status, ReadStatus::Partial);
        assert_eq!(rels(&queue), vec!["sessions/.hidden.md"]);
        assert_eq!(queue.read_issues.len(), 1);
        assert_eq!(queue.read_issues[0].path, "sessions");
        assert_eq!(queue.read_issues[0].code, ReadIssueCode::MetadataRead);
        assert_eq!(std::fs::read(&invalid_path).unwrap(), invalid.as_bytes());
        assert_eq!(
            std::fs::read(root.join("sessions/.hidden.md")).unwrap(),
            valid.as_bytes()
        );
        assert!(!root.join("_inbox").exists());
    }

    #[test]
    fn queue_drops_copies_junk_and_out_of_band_sessions_and_counts_each_once() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let good = session_doc("attention", 20_000, 3);
        write(root, "sessions/2026-08/a.md", &good);
        // The same body re-exported under two more ids (different frontmatter).
        write(
            root,
            "sessions/2026-08/a2.md",
            &good.replace("conversation_id: attention", "conversation_id: copy-1"),
        );
        write(
            root,
            "sessions/2026-07/a3.md",
            &good.replace("created: 1", "created: 0"),
        );
        write(
            root,
            "sessions/2026-08/b.md",
            &session_doc("transformers", 12_000, 1),
        );
        // In the band, but ≥ 90 % tool-noise lines.
        let junk = format!(
            "---\nsource: codex\n---\n\n{}",
            "{\"type\":\"tool_use\",\"input\":\"…\"}\n".repeat(400)
        );
        assert!(junk.len() > MIN_BYTES as usize);
        write(root, "sessions/2026-08/junk.md", &junk);
        // The measured boilerplate, five times: 1,013 bytes each → too small.
        for i in 0..5 {
            write(
                root,
                &format!("sessions/2026-08/bp{i}.md"),
                &boilerplate_doc(&format!("bp{i}"), i),
            );
        }
        write(
            root,
            "sessions/2026-08/huge.md",
            &session_doc("huge", 300_000, 2),
        );
        write(root, "sessions/2026-08/notes.txt", "not a session");

        let q = scan_at(root, 20);
        assert_eq!(
            rels(&q),
            vec!["sessions/2026-08/a.md", "sessions/2026-08/b.md"],
            "newest first; a3 (created 0) is the oldest copy"
        );
        assert_eq!(
            q.excluded,
            Excluded {
                duplicate: 2,
                boilerplate: 1,
                too_small: 5,
                too_large: 1,
                already_harvested: 0,
            }
        );
        assert_eq!(q.total_scanned, 11, ".txt is not a session");
        assert_eq!(
            q.distinct_bodies, 5,
            "attention, transformers, junk, boilerplate, huge"
        );
        assert_eq!(q.eligible, 2);

        let a = &q.items[0];
        assert_eq!(a.title, "Talk about attention");
        assert_eq!(a.est_citations, 3);
        assert_eq!(a.kind, "session");
        assert_eq!(a.size_bytes, good.len() as u64);
        assert!(a.mtime > 0);
        assert!(Path::new(&a.path).is_absolute() && a.path.ends_with("sessions/2026-08/a.md"));
        assert_eq!(a.preview.len(), 3);
        assert_eq!(a.preview[0], "question 0 on attention");
        assert!(
            a.preview.iter().all(|l| !is_turn_marker(l)),
            "{:?}",
            a.preview
        );
        assert!(a.embed_text.starts_with("# Talk about attention"));
        assert!(a.embed_text.chars().count() <= EMBED_CHARS);
        assert!(a.cluster.is_none(), "the command fills this in");
        assert_eq!(q.items[1].est_citations, 1);
    }

    #[test]
    fn limit_cuts_items_but_not_the_eligible_count() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for i in 0..4 {
            write(
                root,
                &format!("sessions/s{i}.md"),
                &session_doc(&format!("topic-{i}"), 10_000, 1),
            );
        }
        let q = scan_at(root, 2);
        assert_eq!(q.items.len(), 2);
        assert_eq!((q.eligible, q.total_scanned), (4, 4));
    }

    #[test]
    fn a_body_already_harvested_is_a_duplicate_even_when_its_copy_is_newer() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let doc = session_doc("attention", 20_000, 2);
        write(
            root,
            "sessions/old.md",
            &doc.replace("created: 1", "created: 0"),
        );
        write(root, "sessions/new.md", &doc);
        let run = run_at(root, &["sessions/old.md".to_string()]).unwrap();
        assert_eq!(run.copied, 1);
        archive_completed(root, "_inbox/old.md");
        let q = scan_at(root, 20);
        assert!(q.items.is_empty(), "{:?}", rels(&q));
        assert_eq!((q.excluded.already_harvested, q.excluded.duplicate), (1, 1));
    }

    #[test]
    fn run_copies_into_inbox_records_state_and_logs_once_without_touching_the_archive() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let doc = session_doc("attention", 20_000, 2);
        write(root, "sessions/2026-08/talk.md", &doc);
        write(
            root,
            "sessions/2026-08/other.md",
            &session_doc("other", 9_000, 1),
        );
        write(root, "raw/paper.md", "raw is immutable");
        let before = scan_at(root, 20);
        assert_eq!(before.items.len(), 2);

        let talk = before
            .items
            .iter()
            .find(|c| c.rel.ends_with("/talk.md"))
            .unwrap();
        let abs = talk.path.clone();
        let run = run_at(root, std::slice::from_ref(&abs)).unwrap();
        assert_eq!(run.copied, 1);
        assert_eq!(run.inbox_rels, vec!["_inbox/talk.md".to_string()]);
        assert_eq!(
            run.inbox_sources,
            vec![backfill::InboxSourceBinding {
                source_rel: "sessions/2026-08/talk.md".to_string(),
                inbox_rel: "_inbox/talk.md".to_string(),
                source_revision: crate::importers::wikify::source_revision(&doc),
            }]
        );
        assert!(run.skipped.is_empty(), "{:?}", run.skipped);
        assert_eq!(
            std::fs::read_to_string(root.join("_inbox/talk.md")).unwrap(),
            doc
        );
        assert_eq!(
            std::fs::read_to_string(root.join("sessions/2026-08/talk.md")).unwrap(),
            doc,
            "sessions/ is copied, never moved"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("raw/paper.md")).unwrap(),
            "raw is immutable"
        );

        // Copying is not completion: it remains retryable in the queue.
        let after = scan_at(root, 20);
        assert_eq!(after.items.len(), 2);
        assert_eq!(after.excluded.already_harvested, 0);
        assert!(backfill::load_state(root)
            .unwrap()
            .promoted
            .contains_key("sessions/2026-08/talk.md"));

        // One inflow line, on the harvest channel.
        let log = std::fs::read_to_string(root.join(crate::inflow_log::LOG_REL)).unwrap();
        let lines: Vec<&str> = log.lines().collect();
        assert_eq!(lines.len(), 1);
        assert!(
            lines[0].contains("\"ch\":\"harvest\"") && lines[0].contains("\"kind\":\"session\""),
            "{log}"
        );

        // Resume reuses the exact pending copy without another inflow event.
        let resumed = run_at(root, std::slice::from_ref(&abs)).unwrap();
        assert_eq!(resumed.inbox_rels, run.inbox_rels);
        assert_eq!(resumed.inbox_sources, run.inbox_sources);
        assert!(resumed.skipped.is_empty());
        assert!(!root.join("_inbox/talk-2.md").exists());
        archive_completed(root, "_inbox/talk.md");
        let after = scan_at(root, 20);
        assert_eq!(rels(&after), vec!["sessions/2026-08/other.md"]);
        assert_eq!(after.excluded.already_harvested, 1);
        // Only a completed revision is refused on the next run.
        let again = run_at(root, &[abs]).unwrap();
        assert_eq!(again.copied, 0);
        assert_eq!(again.skipped[0].reason, "already harvested");
        assert_eq!(
            std::fs::read_to_string(root.join(crate::inflow_log::LOG_REL)).unwrap(),
            log
        );
    }

    fn archive_completed(root: &Path, rel: &str) {
        let archived =
            crate::vault::archive_inbox_source(&root.join(rel).to_string_lossy()).unwrap();
        assert!(backfill::complete_inbox_at(root, rel, &archived).unwrap());
    }

    #[test]
    fn archive_without_completion_and_legacy_copy_records_remain_retryable() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let doc = session_doc("recoverable", 10_000, 1);
        write(root, "sessions/a.md", &doc);
        write(
            root,
            ".myco/backfill.json",
            "{\"promoted\":{\"sessions/a.md\":1}}",
        );
        assert_eq!(scan_at(root, 20).items.len(), 1);
        let run = run_at(root, &["sessions/a.md".to_string()]).unwrap();
        assert_eq!(run.copied, 1);
        // An archive after a refused input or a failed ledger commit is not proof.
        crate::vault::archive_inbox_source(&root.join(&run.inbox_rels[0]).to_string_lossy())
            .unwrap();
        assert_eq!(scan_at(root, 20).items.len(), 1);
        let retry = run_at(root, &["sessions/a.md".to_string()]).unwrap();
        assert_eq!(retry.copied, 1);
        assert_eq!(
            std::fs::read_to_string(root.join(&retry.inbox_rels[0])).unwrap(),
            doc
        );
        assert!(backfill::load_state(root).unwrap().completed.is_empty());
    }

    #[test]
    fn completion_checks_exact_copy_revision_and_changed_source_is_queued_again() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "sessions/a.md", &session_doc("first", 10_000, 1));
        let run = run_at(root, &["sessions/a.md".to_string()]).unwrap();
        write(
            root,
            "_inbox/.archived/unrelated.md",
            &session_doc("other", 10_000, 1),
        );
        assert!(backfill::complete_inbox_at(
            root,
            &run.inbox_rels[0],
            &root.join("_inbox/.archived/unrelated.md").to_string_lossy()
        )
        .is_err());
        assert_eq!(scan_at(root, 20).items.len(), 1);
        archive_completed(root, &run.inbox_rels[0]);
        assert_eq!(scan_at(root, 20).excluded.already_harvested, 1);
        write(root, "sessions/a.md", &session_doc("revised", 12_000, 2));
        let changed = scan_at(root, 20);
        assert_eq!(changed.read_status, ReadStatus::Complete);
        assert!(changed.read_issues.is_empty());
        assert_eq!(changed.items.len(), 1);
        assert_eq!(changed.excluded.already_harvested, 0);
        assert_eq!(
            run_at(root, &["sessions/a.md".to_string()]).unwrap().copied,
            1
        );
    }

    #[test]
    fn a_failed_copy_state_save_can_resume_without_creating_another_copy() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let doc = session_doc("recoverable", 10_000, 1);
        write(root, "sessions/a.md", &doc);
        let failed = run_at_impl(root, &["sessions/a.md".to_string()], |root| {
            let copied = std::fs::read(root.join("_inbox/a.md"))
                .map_err(|error| format!("read test copy before save: {error}"))?;
            if copied.as_slice() != doc.as_bytes() {
                return Err("test copy before save differs from the source".to_string());
            }
            std::fs::create_dir_all(root.join(".myco/backfill.json"))
                .map_err(|error| format!("inject state save failure: {error}"))
        })
        .unwrap_err();
        assert!(failed.starts_with("persist state:"), "{failed}");
        assert!(root.join(".myco/backfill.json").is_dir());
        assert_eq!(
            std::fs::read(root.join("_inbox/a.md")).unwrap(),
            doc.as_bytes()
        );
        assert_eq!(
            std::fs::read(root.join("sessions/a.md")).unwrap(),
            doc.as_bytes()
        );
        assert!(!root.join(crate::inflow_log::LOG_REL).exists());
        std::fs::remove_dir(root.join(".myco/backfill.json")).unwrap();
        let retry = run_at(root, &["sessions/a.md".to_string()]).unwrap();
        assert_eq!(retry.copied, 1);
        assert_eq!(retry.inbox_rels, vec!["_inbox/a.md"]);
        assert_eq!(
            retry.inbox_sources,
            vec![backfill::InboxSourceBinding {
                source_rel: "sessions/a.md".to_string(),
                inbox_rel: "_inbox/a.md".to_string(),
                source_revision: crate::importers::wikify::source_revision(&doc),
            }]
        );
        assert!(retry.skipped.is_empty());
        assert!(!root.join("_inbox/a-2.md").exists());
        assert_eq!(
            std::fs::read(root.join("_inbox/a.md")).unwrap(),
            doc.as_bytes()
        );
        assert_eq!(
            std::fs::read(root.join("sessions/a.md")).unwrap(),
            doc.as_bytes()
        );
        assert_eq!(scan_at(root, 20).items.len(), 1);
        let state = backfill::load_state(root).unwrap();
        assert!(state.completed.is_empty());
        assert_eq!(state.pending.len(), 1);
        assert_eq!(state.pending["sessions/a.md"].inbox_rel, "_inbox/a.md");
    }

    #[cfg(unix)]
    #[test]
    fn session_symlinks_cannot_scan_or_copy_external_sources() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let outside = tempfile::tempdir().unwrap();
        write(outside.path(), "a.md", &session_doc("external", 10_000, 1));
        std::fs::create_dir_all(root.join("sessions")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("a.md"), root.join("sessions/alias.md"))
            .unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("sessions/linked-dir")).unwrap();
        assert_eq!(scan_at(root, 20).total_scanned, 0);
        let run = run_at(root, &["sessions/alias.md".to_string()]).unwrap();
        assert_eq!(run.copied, 0);
        assert_eq!(run.skipped.len(), 1);
        assert!(!root.join("_inbox").exists());
    }

    #[test]
    fn run_refuses_anything_outside_sessions_before_any_io() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(root, "raw/paper.md", "raw is immutable");
        write(root, "wiki/page.md", "# page");
        write(root, "sessions/ok.md", &session_doc("ok", 9_000, 1));
        let outside = tempfile::NamedTempFile::new().unwrap();
        let bad = vec![
            "raw/paper.md".to_string(),
            "wiki/page.md".to_string(),
            "sessions/../raw/paper.md".to_string(),
            "sessions-not/x.md".to_string(),
            "sessions/notes.txt".to_string(),
            root.join("raw/paper.md").to_string_lossy().into_owned(),
            outside.path().to_string_lossy().into_owned(),
            "/etc/hosts".to_string(),
        ];
        let run = run_at(root, &bad).unwrap();
        assert_eq!(run.copied, 0);
        assert_eq!(run.skipped.len(), bad.len(), "{:?}", run.skipped);
        assert!(!root.join("_inbox").exists(), "nothing was copied");
        assert!(
            !root.join(crate::inflow_log::LOG_REL).exists(),
            "nothing was logged"
        );
        assert!(
            !root.join(".myco/backfill.json").exists(),
            "nothing was recorded"
        );

        // The one good path still goes through alongside the refused ones.
        let mixed = run_at(
            root,
            &["raw/paper.md".to_string(), "sessions/ok.md".to_string()],
        )
        .unwrap();
        assert_eq!((mixed.copied, mixed.skipped.len()), (1, 1));
        assert_eq!(
            std::fs::read_to_string(root.join("raw/paper.md")).unwrap(),
            "raw is immutable"
        );
    }

    #[test]
    fn est_citations_is_one_per_user_turn_floored_and_capped() {
        assert_eq!(est_citations("no turns at all"), 1);
        assert_eq!(est_citations(&session_doc("x", 5_000, 3)), 3);
        assert_eq!(est_citations(&session_doc("x", 20_000, 12)), 8);
    }

    #[test]
    fn title_falls_back_to_the_file_stem() {
        assert_eq!(
            title("# Real title\n\nbody", "sessions/x/claude-code-abc.md"),
            "Real title"
        );
        assert_eq!(
            title("no heading here", "sessions/x/claude-code-abc.md"),
            "claude-code-abc"
        );
    }
}
