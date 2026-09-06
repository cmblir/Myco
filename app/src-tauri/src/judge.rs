//! Pre-ingest judgement — what a source deserves BEFORE any file is written.
//!
//! Recording "테스트" used to write five files and run the model even though
//! the plan came back NOOP, and `distill::junk_reason` (the 200-byte floor,
//! the ≥ 90 % tool-noise rule) was never consulted on the ingest path at all.
//! `judge` is the one pure classifier the frontend asks first: junk and
//! already-known bodies are dropped, real text outside the harvest band is
//! logged, and only the rest reaches the model. `record_noop_at` is the
//! trace a dropped or NOOP source leaves — one JSONL line, no
//! `wiki/source-*.md`, no `index.md`/`log.md` rewrite, no `ingest-reports/`.

use crate::backfill::{MAX_BYTES, MIN_BYTES};
use crate::importers::ledger::{body_hash, strip_frontmatter, Ledger};
use serde::Serialize;
use std::io::Write as _;
use std::path::Path;

/// Where `record_noop_at` appends.
pub const NOOP_LOG_REL: &str = ".myco/ingest-noop.jsonl";

/// What `judge_source` returns.
#[derive(Serialize, Debug, PartialEq)]
pub struct Judgement {
    /// `"drop"`: nothing of value (junk, or a body the vault already has).
    /// `"log"`: real text outside the harvest band — leave a trace, skip the
    /// model. `"harvest"`: run the ingest.
    pub verdict: &'static str,
    /// Human-readable; `junk_reason`'s own text when that rule fired.
    pub reason: String,
    /// `junk_reason` | `duplicate` | `too_small` | `too_large` | `ok`.
    pub rule: &'static str,
}

/// Classify a source. Rules fire in this order — junk beats everything (a
/// junk body is dropped whatever its size), a known body beats the size
/// bands, then `< MIN_BYTES → log`, `> MAX_BYTES → log`, else harvest.
///
/// `is_duplicate(body_hash, own_key)` is the body oracle: is this body already
/// in the vault under a key other than `own_key`? `own_key` is the doc's own
/// `<source>:<conversation_id>` from its frontmatter (`""` when it has none),
/// so a harvested copy of a session is not a duplicate of itself while a
/// re-export under a fresh id — or a repeated recording — is. `size_bytes` is
/// the caller's (the file on disk may be larger than the extracted text).
pub fn judge(text: &str, size_bytes: u64, is_duplicate: impl Fn(&str, &str) -> bool) -> Judgement {
    let body = strip_frontmatter(text);
    if let Some(reason) = crate::distill::junk_reason(body) {
        return Judgement {
            verdict: "drop",
            reason,
            rule: "junk_reason",
        };
    }
    if is_duplicate(&body_hash(text), &frontmatter_key(text)) {
        return Judgement {
            verdict: "drop",
            reason: "duplicate body".to_string(),
            rule: "duplicate",
        };
    }
    if size_bytes < MIN_BYTES {
        return Judgement {
            verdict: "log",
            reason: format!("{size_bytes} bytes < {} KB floor", MIN_BYTES / 1024),
            rule: "too_small",
        };
    }
    if size_bytes > MAX_BYTES {
        return Judgement {
            verdict: "log",
            reason: format!("{} KB > {} KB ceiling", size_bytes / 1024, MAX_BYTES / 1024),
            rule: "too_large",
        };
    }
    Judgement {
        verdict: "harvest",
        reason: "in band, distinct body, not junk".to_string(),
        rule: "ok",
    }
}

/// `judge` with the import ledger's body index as the oracle.
pub fn judge_against(text: &str, size_bytes: u64, ledger: &Ledger) -> Judgement {
    judge(text, size_bytes, |hash, key| ledger.seen_body(hash, key))
}

/// `<source>:<conversation_id>` out of a leading `---` block — the key
/// `plan_import` records a session under. Empty when either line is missing.
fn frontmatter_key(text: &str) -> String {
    let Some(rest) = text.strip_prefix("---\n") else {
        return String::new();
    };
    let (mut source, mut id) = (None, None);
    for line in rest.lines() {
        if line.starts_with("---") {
            break;
        }
        if let Some(v) = line.strip_prefix("source:") {
            source = Some(v.trim());
        } else if let Some(v) = line.strip_prefix("conversation_id:") {
            id = Some(v.trim());
        }
    }
    match (source, id) {
        (Some(s), Some(i)) if !s.is_empty() && !i.is_empty() => format!("{s}:{i}"),
        _ => String::new(),
    }
}

/// Append one `{"at","rel","reason"}` line to `.myco/ingest-noop.jsonl`.
/// `rel` is recorded as data, never used as a path — this touches nothing
/// else in the vault.
pub fn record_noop_at(root: &Path, rel: &str, reason: &str) -> Result<(), String> {
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = serde_json::json!({ "at": at, "rel": rel, "reason": reason }).to_string();
    let path = root.join(NOOP_LOG_REL);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("create .myco: {e}"))?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("open {NOOP_LOG_REL}: {e}"))?;
    writeln!(f, "{line}").map_err(|e| format!("write {NOOP_LOG_REL}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NEVER: fn(&str, &str) -> bool = |_, _| false;
    const ALWAYS: fn(&str, &str) -> bool = |_, _| true;

    /// Prose of about `bytes` bytes, no frontmatter.
    fn prose(bytes: usize) -> String {
        "A sentence of ordinary prose that no tool wrote.\n".repeat(bytes / 49 + 1)
    }

    fn rule(j: &Judgement) -> (&'static str, &'static str) {
        (j.verdict, j.rule)
    }

    #[test]
    fn a_recorded_test_word_is_junk_and_dropped_not_logged() {
        let j = judge("테스트", 9, NEVER);
        assert_eq!(rule(&j), ("drop", "junk_reason"));
        assert!(j.reason.contains("< 200"), "{}", j.reason);
    }

    #[test]
    fn tool_noise_is_junk_whatever_its_size() {
        let noise = "{\"type\":\"tool_use\",\"input\":\"x\"}\n".repeat(500);
        assert!(noise.len() as u64 > MIN_BYTES);
        let j = judge(&noise, noise.len() as u64, NEVER);
        assert_eq!(rule(&j), ("drop", "junk_reason"));
        assert!(j.reason.contains("tool-noise"), "{}", j.reason);
    }

    #[test]
    fn junk_is_judged_on_the_body_not_the_frontmatter() {
        // Four frontmatter lines must not dilute a 100 % tool-noise body.
        let doc = format!(
            "---\nsource: codex\nconversation_id: c1\n---\n\n{}",
            "{\"tool_result\":1}\n".repeat(30)
        );
        assert_eq!(judge(&doc, 20_000, NEVER).rule, "junk_reason");
    }

    #[test]
    fn a_known_body_is_a_duplicate_and_beats_the_size_bands() {
        let small = prose(1_000);
        assert_eq!(rule(&judge(&small, 1_000, ALWAYS)), ("drop", "duplicate"));
        assert_eq!(judge(&small, 1_000, ALWAYS).reason, "duplicate body");
        let large = prose(300_000);
        assert_eq!(rule(&judge(&large, 300_000, ALWAYS)), ("drop", "duplicate"));
    }

    #[test]
    fn junk_beats_duplicate() {
        assert_eq!(judge("hi", 2, ALWAYS).rule, "junk_reason");
    }

    #[test]
    fn size_bands_log_and_the_band_harvests_at_both_edges() {
        let text = prose(10_000);
        assert_eq!(
            rule(&judge(&text, MIN_BYTES - 1, NEVER)),
            ("log", "too_small")
        );
        assert_eq!(rule(&judge(&text, MIN_BYTES, NEVER)), ("harvest", "ok"));
        assert_eq!(rule(&judge(&text, MAX_BYTES, NEVER)), ("harvest", "ok"));
        assert_eq!(
            rule(&judge(&text, MAX_BYTES + 1, NEVER)),
            ("log", "too_large")
        );
        assert!(judge(&text, 3_000, NEVER).reason.contains("8 KB floor"));
        assert!(judge(&text, 400_000, NEVER)
            .reason
            .contains("200 KB ceiling"));
    }

    #[test]
    fn the_oracle_sees_the_body_hash_and_the_docs_own_key() {
        let doc = format!(
            "---\nsource: claude-code\nconversation_id: abc\ncreated: 5\n---\n\n{}",
            prose(9_000)
        );
        // The oracle answers "duplicate" ONLY if it was handed exactly this
        // doc's body hash and its own key — so the verdict proves both.
        let expected_hash = body_hash(&doc);
        let j = judge(&doc, 9_000, |hash, key| {
            hash == expected_hash && key == "claude-code:abc"
        });
        assert_eq!(j.rule, "duplicate");
        assert_eq!(frontmatter_key("no frontmatter"), "");
        assert_eq!(frontmatter_key("---\nsource: codex\n---\nbody"), "");
        assert_eq!(
            frontmatter_key("---\nsource: \nconversation_id: x\n---\n"),
            ""
        );
    }

    #[test]
    fn against_the_ledger_a_harvested_copy_is_not_its_own_duplicate_but_a_re_export_is() {
        let doc = |id: &str| {
            format!(
                "---\nsource: claude-code\nconversation_id: {id}\ncreated: 5\n---\n\n{}",
                prose(9_000)
            )
        };
        let mut ledger = Ledger::default();
        ledger.record_body(body_hash(&doc("abc")), "claude-code:abc");
        // The session itself, copied into _inbox/ by harvest_run.
        assert_eq!(judge_against(&doc("abc"), 9_000, &ledger).rule, "ok");
        // The same body re-exported under a new id.
        assert_eq!(judge_against(&doc("xyz"), 9_000, &ledger).rule, "duplicate");
        // The same body pasted with no provenance at all.
        let bare = prose(9_000);
        assert_eq!(judge_against(&bare, 9_000, &ledger).rule, "duplicate");
        // A body the ledger has never seen.
        assert_eq!(judge_against(&prose(9_500), 9_500, &ledger).rule, "ok");
    }

    #[test]
    fn record_noop_appends_one_line_per_call_and_creates_nothing_else() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        record_noop_at(root, "_inbox/테스트.md", "junk heuristic: 9 bytes (< 200)").unwrap();
        record_noop_at(root, "_inbox/x.md", "NOOP: already covered").unwrap();
        let log = std::fs::read_to_string(root.join(NOOP_LOG_REL)).unwrap();
        let lines: Vec<serde_json::Value> = log
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0]["rel"], "_inbox/테스트.md");
        assert_eq!(lines[1]["reason"], "NOOP: already covered");
        assert!(lines[0]["at"].as_u64().unwrap() > 0);
        // The trace is the ONLY thing written.
        let mut created: Vec<String> = std::fs::read_dir(root)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        created.sort();
        assert_eq!(created, vec![".myco".to_string()]);
        for never in ["wiki", "index.md", "log.md", "ingest-reports", "_inbox"] {
            assert!(!root.join(never).exists(), "{never} must not exist");
        }
    }
}
