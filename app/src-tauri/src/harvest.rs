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

use crate::backfill::{self, MAX_BYTES, MIN_BYTES, SESSIONS_DIR};
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
    /// Already promoted, per `.myco/backfill.json`.
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
}

/// Build the queue. Reads every session once: the body hash needs the text,
/// and the whole-corpus `distinct_bodies` number is the point of the scan.
// ponytail: O(total session bytes) per call (~tens of MB on the owner's
// vault); cache hashes by (mtime, len) in the state file if the Overview
// feels it.
pub fn scan_at(root: &Path, limit: usize) -> Queue {
    let mut files = backfill::scan_sessions(root);
    files.sort_by(|a, b| b.created.cmp(&a.created).then_with(|| a.rel.cmp(&b.rel)));
    let promoted = backfill::load_state(root).promoted;
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
        total_scanned += 1;
        excluded.already_harvested += 1;
        if let Ok(content) = std::fs::read_to_string(root.join(&f.rel)) {
            let hash = body_hash(&content);
            distinct.insert(hash.clone());
            kept.insert(hash);
        }
    }
    for f in rest {
        let abs = root.join(&f.rel);
        // Unreadable (binary, or gone since the walk): not scanned, retried
        // next time.
        let Ok(content) = std::fs::read_to_string(&abs) else {
            continue;
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
            let mtime = std::fs::metadata(&abs)
                .ok()
                .and_then(|m| m.modified().ok())
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
    pub skipped: Vec<Skipped>,
}

/// Copy the chosen sessions into `_inbox/`, record them so they leave the
/// queue, and log one `harvest` inflow line. Anything that is not a `.md`
/// under this vault's `sessions/` is refused before any IO — `raw/` and the
/// rest of the vault are never touched.
pub fn run_at(root: &Path, paths: &[String]) -> Result<Run, String> {
    let promoted = backfill::load_state(root).promoted;
    let mut rels: Vec<String> = Vec::new();
    let mut skipped = Vec::new();
    for path in paths {
        match session_rel(root, path) {
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
    let done = backfill::promote_rels(root, &rels)?;
    skipped.extend(done.failed.into_iter().map(|(rel, reason)| Skipped {
        path: root.join(rel).to_string_lossy().into_owned(),
        reason,
    }));
    let copied = done.names.len() as u32;
    crate::inflow_log::record_n(root, "harvest", "session", copied);
    Ok(Run {
        copied,
        inbox_rels: done
            .names
            .into_iter()
            .map(|n| format!("_inbox/{n}"))
            .collect(),
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

        // It left the queue, via backfill's own state file.
        let after = scan_at(root, 20);
        assert_eq!(rels(&after), vec!["sessions/2026-08/other.md"]);
        assert_eq!(after.excluded.already_harvested, 1);
        assert!(backfill::load_state(root)
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

        // A second run of the same path is refused, copies nothing, logs nothing.
        let again = run_at(root, &[abs]).unwrap();
        assert_eq!(again.copied, 0);
        assert_eq!(again.skipped[0].reason, "already harvested");
        assert_eq!(
            std::fs::read_to_string(root.join(crate::inflow_log::LOG_REL)).unwrap(),
            log
        );
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
