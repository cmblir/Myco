//! Ask history (UX S36): every finished Ask turn, one JSON line each, in an
//! append-only log per vault under the app data dir —
//! `<app-data>/ask-history/<hash>.jsonl`, keyed by the same vault-root hash
//! `VectorStore::path_for` keys the vault's index by. Outside the vault on
//! purpose: the history is this device's, so it never syncs, never conflicts
//! with another device's log, and never lands anywhere near `raw/`.
//!
//! A line that does not parse (a torn write, a hand edit), or whose time no JS
//! `Date` can hold, is skipped, never fatal: the rest of the history still
//! loads. The log keeps the last [`CAP`]
//! turns; an append that finds more than `CAP + SLACK` lines rewrites the file
//! with the last `CAP` (temp + rename), so the common append stays one write.

use serde::{Deserialize, Serialize};
use std::hash::{Hash, Hasher};
use std::io::Write as _;
use std::path::{Path, PathBuf};

/// Turns the log keeps.
pub const CAP: usize = 500;
/// Lines past [`CAP`] before an append compacts: one rewrite per 50 turns,
/// not one per turn.
const SLACK: usize = 50;

/// One Ask turn as the page showed it. Mirrored in ipc.ts `AskRecord`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AskTurn {
    /// Unix milliseconds the turn finished.
    pub at: u64,
    pub q: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// The answer as shown: the quoted lines under their `[[stem]]` for an
    /// extractive answer, the provider's text otherwise. Empty for an
    /// abstained, failed or stopped turn.
    #[serde(default)]
    pub a: String,
    /// Stems of the notes the answer cited.
    #[serde(default)]
    pub cited: Vec<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub abstained: bool,
    #[serde(default, skip_serializing_if = "is_false")]
    pub stopped: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// "Ask this note" (UX S37): the turn ran over this note and its one-hop
    /// links instead of a scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<NoteRef>,
}

/// The note a note-scoped turn ran over, by the title the page showed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NoteRef {
    pub title: String,
}

#[allow(clippy::trivially_copy_pass_by_ref)] // serde's skip_serializing_if contract
fn is_false(b: &bool) -> bool {
    !*b
}

/// The log file for `vault_root`. Creates `ask-history/` under the app data
/// dir. `DefaultHasher` because the vault's other app-data files are keyed by
/// it (std documents it may change across releases; were it ever to, the old
/// log stays on disk under its old name rather than being lost).
pub fn path_for(vault_root: &str) -> Result<PathBuf, String> {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    vault_root.hash(&mut h);
    let dir = crate::settings::settings_dir()?.join("ask-history");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir ask-history: {e}"))?;
    Ok(dir.join(format!("{:016x}.jsonl", h.finish())))
}

/// The last [`CAP`] turns, oldest first. A missing file is an empty history;
/// a line that does not parse is skipped. Any other read failure is an error,
/// so the page can say the history could not be read instead of showing none.
pub fn load(path: &Path) -> Result<Vec<AskTurn>, String> {
    let mut turns = parse(&read(path)?);
    let skip = turns.len().saturating_sub(CAP);
    turns.drain(..skip);
    Ok(turns)
}

/// Append `turn`, compacting to the last [`CAP`] once the file would hold
/// more than `CAP + SLACK` lines.
pub fn append(path: &Path, turn: &AskTurn) -> Result<(), String> {
    let line = serde_json::to_string(turn).map_err(|e| format!("serialize ask turn: {e}"))?;
    let existing = read(path)?;
    let lines = existing
        .split(|b| *b == b'\n')
        .filter(|l| !l.is_empty())
        .count();
    if lines + 1 > CAP + SLACK {
        let mut turns = parse(&existing);
        turns.push(turn.clone());
        let keep = &turns[turns.len().saturating_sub(CAP)..];
        let mut out = String::new();
        for t in keep {
            out.push_str(
                &serde_json::to_string(t).map_err(|e| format!("serialize ask turn: {e}"))?,
            );
            out.push('\n');
        }
        let tmp = path.with_extension("jsonl.tmp");
        std::fs::write(&tmp, out).map_err(|e| format!("write ask history: {e}"))?;
        return std::fs::rename(&tmp, path).map_err(|e| format!("replace ask history: {e}"));
    }
    // A torn last line (a crash mid-write) has no newline: start on a fresh
    // line, or this turn would fuse with it and both would be lost.
    let sep = if existing.last().is_some_and(|b| *b != b'\n') {
        "\n"
    } else {
        ""
    };
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("open ask history: {e}"))?;
    writeln!(f, "{sep}{line}").map_err(|e| format!("append ask history: {e}"))
}

fn read(path: &Path) -> Result<Vec<u8>, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("read ask history: {e}")),
    }
}

/// The largest time a JS `Date` holds, in ms: past it `toISOString` throws,
/// and the history list's render with it.
const JS_DATE_MAX_MS: u64 = 8_640_000_000_000_000;

/// Every line that parses as a turn the page can show; lossy UTF-8 so one bad
/// byte costs only its own line. Load and compaction both read through here,
/// so a skipped line is never written back either.
fn parse(bytes: &[u8]) -> Vec<AskTurn> {
    String::from_utf8_lossy(bytes)
        .lines()
        .filter_map(|l| serde_json::from_str::<AskTurn>(l).ok())
        .filter(|t| t.at <= JS_DATE_MAX_MS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log_path(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("myco-askhist-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.join("h.jsonl")
    }

    fn turn(q: &str, at: u64) -> AskTurn {
        AskTurn {
            at,
            q: q.into(),
            scope: Some("wiki".into()),
            a: "> quoted line\n\n**[[attention]]**".into(),
            cited: vec!["attention".into()],
            abstained: false,
            stopped: false,
            error: None,
            note: None,
        }
    }

    #[test]
    fn a_note_scoped_turn_keeps_its_note() {
        // "Ask this note" (UX S37): the turn ran over one note, not a scope.
        let p = log_path("note");
        let mut scoped = turn("what is attention", 1);
        scoped.scope = None;
        scoped.note = Some(NoteRef {
            title: "Attention".into(),
        });
        append(&p, &scoped).unwrap();
        let line = std::fs::read_to_string(&p).unwrap();
        assert!(line.contains(r#""note":{"title":"Attention"}"#));
        assert_eq!(load(&p).unwrap(), vec![scoped]);
        // A line written before the field reads it as unset.
        let back: AskTurn = serde_json::from_str(r#"{"at":1,"q":"q"}"#).unwrap();
        assert!(back.note.is_none());
    }

    #[test]
    fn appended_turns_load_back_in_order() {
        let p = log_path("roundtrip");
        let mut abstained = turn("off-vault", 2);
        abstained.a.clear();
        abstained.cited.clear();
        abstained.abstained = true;
        append(&p, &turn("what is attention", 1)).unwrap();
        append(&p, &abstained).unwrap();
        assert_eq!(
            load(&p).unwrap(),
            vec![turn("what is attention", 1), abstained]
        );
    }

    #[test]
    fn a_missing_log_is_an_empty_history() {
        assert!(load(&log_path("missing")).unwrap().is_empty());
    }

    #[test]
    fn a_corrupt_line_is_skipped_not_fatal() {
        let p = log_path("corrupt");
        append(&p, &turn("first", 1)).unwrap();
        // A line of the wrong shape, a time no JS Date can hold (it threw in
        // the page's render), then a torn write with no newline: the next
        // append must not fuse with it.
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        writeln!(f, "[1,2,3]").unwrap();
        writeln!(f, "{{\"at\":18446744073709551615,\"q\":\"x\"}}").unwrap();
        write!(f, "{{\"at\":2,\"q\":\"tor").unwrap();
        drop(f);
        append(&p, &turn("third", 3)).unwrap();
        let qs: Vec<String> = load(&p).unwrap().into_iter().map(|t| t.q).collect();
        assert_eq!(qs, ["first", "third"]);
    }

    #[test]
    fn the_log_keeps_the_last_cap_turns() {
        let p = log_path("cap");
        for i in 0..(CAP + SLACK + 1) as u64 {
            append(&p, &turn(&format!("q{i}"), i)).unwrap();
        }
        let all = load(&p).unwrap();
        assert_eq!(all.len(), CAP);
        assert_eq!(all[0].q, format!("q{}", SLACK + 1));
        assert_eq!(all.last().unwrap().q, format!("q{}", CAP + SLACK));
        // Compacted on disk too, not just trimmed on read.
        let lines = std::fs::read_to_string(&p).unwrap().lines().count();
        assert_eq!(lines, CAP);
    }

    #[test]
    fn each_vault_gets_its_own_log_in_app_data_never_in_the_vault() {
        // path_for resolves (and creates) the app-data dir: isolated, or it
        // would write under the developer's real Application Support.
        crate::settings::test_support::with_isolated_data("ask-history-path", |data| {
            let a = path_for("/vaults/a").unwrap();
            assert!(a.starts_with(data.join("ask-history")));
            assert!(!a.starts_with("/vaults/a"));
            assert_eq!(a, path_for("/vaults/a").unwrap());
            assert_ne!(a, path_for("/vaults/b").unwrap());
        });
    }

    #[test]
    fn flags_left_unset_stay_off_the_line() {
        let line = serde_json::to_string(&turn("q", 1)).unwrap();
        assert!(
            !line.contains("abstained") && !line.contains("stopped") && !line.contains("error")
        );
        // And a line written without them reads them as unset.
        let back: AskTurn = serde_json::from_str(r#"{"at":1,"q":"q"}"#).unwrap();
        assert!(!back.abstained && back.scope.is_none() && back.cited.is_empty());
    }
}
