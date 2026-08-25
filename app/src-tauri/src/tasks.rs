//! Task scanner. Collects GitHub-style markdown checkbox items — `- [ ] todo`,
//! `- [/] doing`, `- [-] blocked`, `- [x] done` — from every note in the vault
//! into one list, so open TODOs scattered across daily notes and pages are
//! visible in one place. Scanning never edits a file; the two writers at the
//! bottom (`set_line_status`, `append_task_line`) exist for the MCP task
//! tools and rewrite exactly one line / append exactly one. `raw/`, `_inbox/`
//! and `sessions/` are skipped — none of them is the user's own task list — as
//! are code fences (a checkbox inside a code sample is documentation, not a
//! task).

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TaskItem {
    /// Vault-relative path of the note the task lives in.
    pub page: String,
    /// Filename stem, for display and wikilinks.
    pub stem: String,
    /// 1-based line number of the checkbox within the file.
    pub line: u32,
    pub text: String,
    /// `true` only for `[x]`. Kept alongside `status` because "is it finished"
    /// is what most callers actually ask.
    pub done: bool,
    /// The checkbox mark, widened past done/not-done so a board can have more
    /// than two columns: `todo` `[ ]`, `doing` `[/]`, `blocked` `[-]`, `done`
    /// `[x]` — the Obsidian Tasks convention, so these files stay meaningful in
    /// other editors.
    pub status: TaskStatus,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Todo,
    Doing,
    Blocked,
    Done,
}

pub fn scan_tasks(vault_path: &str) -> Result<Vec<TaskItem>, String> {
    let root = Path::new(vault_path)
        .canonicalize()
        .map_err(|e| format!("canonicalize failed: {e}"))?;
    if !root.is_dir() {
        return Err(format!("not a directory: {vault_path}"));
    }
    let files = collect_markdown(&root).map_err(|e| format!("walk failed: {e}"))?;
    let mut out = Vec::new();
    for file in &files {
        if std::fs::metadata(file).map(|m| m.len()).unwrap_or(0) > 2 * 1024 * 1024 {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(file) else {
            continue;
        };
        let rel = file
            .strip_prefix(&root)
            .unwrap_or(file)
            .to_string_lossy()
            .into_owned();
        let stem = file
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        for (line, status, task) in extract_tasks(&text) {
            out.push(TaskItem {
                page: rel.clone(),
                stem: stem.clone(),
                line,
                text: task,
                done: status == TaskStatus::Done,
                status,
            });
        }
    }
    // Open tasks first, then by page — the actionable ones surface at the top.
    out.sort_by(|a, b| {
        a.done
            .cmp(&b.done)
            .then_with(|| a.page.cmp(&b.page))
            .then_with(|| a.line.cmp(&b.line))
    });
    Ok(out)
}

/// Pull `(1-based line, status, text)` for every checkbox item in a note,
/// skipping fenced code blocks. Pure so it is unit-testable without the
/// filesystem.
pub fn extract_tasks(text: &str) -> Vec<(u32, TaskStatus, String)> {
    let mut out = Vec::new();
    let mut in_code = false;
    for (i, raw) in text.lines().enumerate() {
        let trimmed = raw.trim_start();
        if trimmed.starts_with("```") {
            in_code = !in_code;
            continue;
        }
        if in_code {
            continue;
        }
        if let Some((status, task)) = parse_task_line(trimmed) {
            out.push((i as u32 + 1, status, task));
        }
    }
    out
}

/// A single `- [ ] text` / `- [x] text` line (also `*`/`+` bullets, `X` mark),
/// plus the in-progress `[/]` and blocked `[-]` marks. Returns
/// `(status, text)`; `None` for a non-task line.
///
/// `[/]` and `[-]` used to return `None`, i.e. they were not tasks at all — so
/// moving a card to a board column that writes one would have made the task
/// vanish from the very list the board is built from.
fn parse_task_line(trimmed: &str) -> Option<(TaskStatus, String)> {
    let rest = trimmed
        .strip_prefix("- ")
        .or_else(|| trimmed.strip_prefix("* "))
        .or_else(|| trimmed.strip_prefix("+ "))?
        .trim_start();
    let after = rest.strip_prefix('[')?;
    let mut chars = after.chars();
    let mark = chars.next()?;
    let text = chars.as_str().strip_prefix(']')?.trim();
    let status = match mark {
        ' ' => TaskStatus::Todo,
        'x' | 'X' => TaskStatus::Done,
        '/' => TaskStatus::Doing,
        '-' => TaskStatus::Blocked,
        _ => return None,
    };
    if text.is_empty() {
        return None;
    }
    Some((status, text.to_string()))
}

fn collect_markdown(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in std::fs::read_dir(&d)? {
            let e = entry?;
            let name = e.file_name();
            let name = name.to_str().unwrap_or("");
            // Skip dotdirs, deps, and the directories that are not the user's
            // own task list: `raw/` (immutable sources), `_inbox/` (sources
            // awaiting ingest) and `sessions/` (imported work logs — one real
            // vault had 386 checkbox lines inside session transcripts, every
            // one of which would have shown up as a task to do).
            if name.starts_with('.')
                || name == "node_modules"
                || name == "target"
                || name == "raw"
                || name == "_inbox"
                || name == "sessions"
            {
                continue;
            }
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().and_then(|s| s.to_str()) == Some("md") {
                out.push(p);
            }
        }
    }
    out.sort();
    Ok(out)
}

/// Today as `YYYY-MM-DD` for the `✅` stamp. UTC via the registry's existing
/// helper — same trade the registry already made: a same-day discrepancy
/// across a midnight boundary is not worth a chrono dependency.
fn today_stamp() -> String {
    crate::registry::today_utc()
}

/// Rewrite line `line_no` (1-based) of `content` to `status`, stamping
/// `✅ <today>` on completion and removing the stamp when a task leaves done —
/// the same contract as the app's own writer (taskWrite.ts).
///
/// `expect_text` is the stale guard: it must equal the line's current text
/// after the checkbox mark, or nothing is written — a mismatch means the file
/// changed since the caller read it, and rewriting by line number would edit
/// the wrong task. Returns the new content and whether the line carries a
/// `🔁` rule (the caller reports that recurrence is app-only).
// ponytail: recurrence advance is TS-only (taskRecurrence.ts); port to Rust if
// MCP check-off of recurring tasks becomes common.
pub fn set_line_status(
    content: &str,
    line_no: u32,
    status: TaskStatus,
    expect_text: &str,
) -> Result<(String, bool), String> {
    let mut lines: Vec<String> = content.split('\n').map(str::to_string).collect();
    let idx = (line_no as usize)
        .checked_sub(1)
        .filter(|i| *i < lines.len())
        .ok_or_else(|| format!("line {line_no} does not exist"))?;
    let line = &lines[idx];
    let trimmed = line.trim_start();
    let Some((_, text)) = parse_task_line(trimmed) else {
        return Err(format!("line {line_no} is not a checkbox: {line:?}"));
    };
    if text != expect_text.trim() {
        return Err(format!(
            "line {line_no} changed since it was read — it now says {text:?}; re-read and retry"
        ));
    }
    let mark = match status {
        TaskStatus::Todo => ' ',
        TaskStatus::Doing => '/',
        TaskStatus::Blocked => '-',
        TaskStatus::Done => 'x',
    };
    // Everything before the mark (indent + bullet + '[') survives verbatim.
    let open = line.find('[').ok_or("no checkbox bracket")?;
    let close = open + line[open..].find(']').ok_or("no closing bracket")?;
    let mut body = line[close + 1..].trim().to_string();
    // The done stamp: added on completion, dropped when leaving done. A task
    // moved back to doing was not completed today, and a stale `✅` would
    // claim it was.
    let done_re = regex::Regex::new(r"\s*✅\s*\d{4}-\d{2}-\d{2}").unwrap();
    body = done_re.replace_all(&body, "").trim().to_string();
    if status == TaskStatus::Done {
        body = format!("{body} ✅ {}", today_stamp());
    }
    let recurring = body.contains('🔁');
    lines[idx] = format!("{}[{mark}] {body}", &line[..open]);
    Ok((lines.join("\n"), recurring))
}

/// Append one checkbox line to `content`, keeping exactly one trailing
/// newline (mirrors the frontend's `appendTaskLine`).
pub fn append_task_line(content: &str, line: &str) -> String {
    let body = content.trim_end();
    if body.is_empty() {
        format!("{line}\n")
    } else {
        format!("{body}\n{line}\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_open_and_done_checkboxes_with_line_numbers() {
        let text = "# Notes\n\n- [ ] write the parser\n- [x] read the spec\nplain line\n* [ ] star bullet\n+ [X] plus bullet\n";
        let tasks = extract_tasks(text);
        assert_eq!(tasks.len(), 4);
        assert_eq!(
            tasks[0],
            (3, TaskStatus::Todo, "write the parser".to_string())
        );
        assert_eq!(tasks[1], (4, TaskStatus::Done, "read the spec".to_string()));
        assert_eq!(tasks[2], (6, TaskStatus::Todo, "star bullet".to_string()));
        assert_eq!(tasks[3], (7, TaskStatus::Done, "plus bullet".to_string()));
    }

    #[test]
    fn staging_directories_are_not_the_users_task_list() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for d in ["wiki", "raw", "_inbox", "sessions"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        std::fs::write(root.join("wiki/a.md"), "- [ ] mine\n").unwrap();
        std::fs::write(root.join("raw/s.md"), "- [ ] from a source\n").unwrap();
        std::fs::write(root.join("_inbox/p.md"), "- [ ] pending source\n").unwrap();
        // A session transcript quoting a plan is not a task list.
        std::fs::write(
            root.join("sessions/log.md"),
            "- [ ] Step 1: write the test\n",
        )
        .unwrap();

        let tasks = scan_tasks(root.to_str().unwrap()).unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].text, "mine");
    }

    #[test]
    fn reads_the_in_progress_and_blocked_marks_as_tasks() {
        // These used to parse as "not a task", so a board column that writes
        // one would have made the card disappear from the list it came from.
        let text = "- [/] migrating the schema\n- [-] waiting on approval\n";
        let tasks = extract_tasks(text);
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].1, TaskStatus::Doing);
        assert_eq!(tasks[1].1, TaskStatus::Blocked);
    }

    #[test]
    fn only_a_finished_box_counts_as_done() {
        let text = "- [ ] a\n- [/] b\n- [-] c\n- [x] d\n";
        let marks: Vec<bool> = extract_tasks(text)
            .iter()
            .map(|(_, s, _)| *s == TaskStatus::Done)
            .collect();
        assert_eq!(marks, vec![false, false, false, true]);
    }

    #[test]
    fn ignores_non_tasks_and_empty_boxes() {
        let text = "- a plain bullet\n- [] no space\n- [ ]   \n- [z] bad mark\nnormal text\n";
        assert!(extract_tasks(text).is_empty());
    }

    #[test]
    fn skips_checkboxes_inside_code_fences() {
        let text = "- [ ] real task\n```md\n- [ ] documentation example\n```\n- [x] another real\n";
        let tasks = extract_tasks(text);
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].2, "real task");
        assert_eq!(tasks[1].2, "another real");
    }

    #[test]
    fn scan_tasks_walks_the_vault_and_skips_raw() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("wiki")).unwrap();
        std::fs::create_dir_all(root.join("raw")).unwrap();
        std::fs::write(root.join("wiki/a.md"), "- [ ] open one\n- [x] done one\n").unwrap();
        std::fs::write(root.join("daily.md"), "- [ ] daily todo\n").unwrap();
        std::fs::write(root.join("raw/source.md"), "- [ ] not a task (raw)\n").unwrap();

        let tasks = scan_tasks(root.to_str().unwrap()).unwrap();
        // 3 tasks (raw/ excluded); open ones sorted before done.
        assert_eq!(tasks.len(), 3);
        assert!(tasks.iter().all(|t| !t.page.starts_with("raw/")));
        assert!(!tasks[0].done && !tasks[1].done); // open first
        assert!(tasks[2].done); // done last
        assert!(tasks.iter().any(|t| t.text == "daily todo"));
    }
}

#[cfg(test)]
mod writer_tests {
    use super::*;

    const DOC: &str = "# day\n- [ ] ship it 📅 2026-08-28\n- [x] old ✅ 2026-08-20\nprose";

    #[test]
    fn checks_a_line_and_stamps_the_done_date() {
        let (out, recurring) =
            set_line_status(DOC, 2, TaskStatus::Done, "ship it 📅 2026-08-28").unwrap();
        let line = out.lines().nth(1).unwrap();
        assert!(
            line.starts_with("- [x] ship it 📅 2026-08-28 ✅ "),
            "{line}"
        );
        assert!(!recurring);
        // Every other line untouched.
        assert_eq!(out.lines().next().unwrap(), "# day");
        assert_eq!(out.lines().nth(3).unwrap(), "prose");
    }

    #[test]
    fn leaving_done_clears_the_stamp() {
        let (out, _) = set_line_status(DOC, 3, TaskStatus::Doing, "old ✅ 2026-08-20").unwrap();
        assert_eq!(out.lines().nth(2).unwrap(), "- [/] old");
    }

    #[test]
    fn refuses_a_stale_expect_text() {
        let err = set_line_status(DOC, 2, TaskStatus::Done, "something else").unwrap_err();
        assert!(err.contains("changed since it was read"), "{err}");
        assert!(err.contains("ship it"), "the current text is named: {err}");
    }

    #[test]
    fn refuses_a_non_checkbox_line_and_a_missing_line() {
        assert!(set_line_status(DOC, 4, TaskStatus::Done, "prose").is_err());
        assert!(set_line_status(DOC, 99, TaskStatus::Done, "x").is_err());
    }

    #[test]
    fn keeps_indentation_and_bullet_and_flags_recurrence() {
        let doc = "  * [ ] 주간 회고 🔁 every week";
        let (out, recurring) =
            set_line_status(doc, 1, TaskStatus::Done, "주간 회고 🔁 every week").unwrap();
        assert!(
            out.starts_with("  * [x] 주간 회고 🔁 every week ✅ "),
            "{out}"
        );
        assert!(recurring);
    }

    #[test]
    fn append_keeps_one_trailing_newline() {
        assert_eq!(append_task_line("", "- [ ] a"), "- [ ] a\n");
        assert_eq!(append_task_line("# t\n\n", "- [ ] a"), "# t\n- [ ] a\n");
    }
}
