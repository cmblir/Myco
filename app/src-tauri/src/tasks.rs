//! Task scanner. Collects GitHub-style markdown checkbox items — `- [ ] todo`
//! and `- [x] done` — from every note in the vault into one list, so open TODOs
//! scattered across daily notes and pages are visible in one place. Read-only:
//! it never edits a file. `raw/` is skipped (immutable source material, not the
//! user's own task list), as are code fences (a checkbox inside a code sample is
//! documentation, not a task).

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
    pub done: bool,
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
        for (line, done, task) in extract_tasks(&text) {
            out.push(TaskItem {
                page: rel.clone(),
                stem: stem.clone(),
                line,
                text: task,
                done,
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

/// Pull `(1-based line, done, text)` for every checkbox item in a note, skipping
/// fenced code blocks. Pure so it is unit-testable without the filesystem.
pub fn extract_tasks(text: &str) -> Vec<(u32, bool, String)> {
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
        if let Some((done, task)) = parse_task_line(trimmed) {
            out.push((i as u32 + 1, done, task));
        }
    }
    out
}

/// A single `- [ ] text` / `- [x] text` line (also `*`/`+` bullets, `X` mark).
/// Returns `(done, text)`; `None` for a non-task line.
fn parse_task_line(trimmed: &str) -> Option<(bool, String)> {
    let rest = trimmed
        .strip_prefix("- ")
        .or_else(|| trimmed.strip_prefix("* "))
        .or_else(|| trimmed.strip_prefix("+ "))?
        .trim_start();
    let after = rest.strip_prefix('[')?;
    let mut chars = after.chars();
    let mark = chars.next()?;
    let text = chars.as_str().strip_prefix(']')?.trim();
    let done = match mark {
        ' ' => false,
        'x' | 'X' => true,
        _ => return None,
    };
    if text.is_empty() {
        return None;
    }
    Some((done, text.to_string()))
}

fn collect_markdown(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in std::fs::read_dir(&d)? {
            let e = entry?;
            let name = e.file_name();
            let name = name.to_str().unwrap_or("");
            // Skip dotdirs, deps, and raw/ (immutable sources, not tasks).
            if name.starts_with('.') || name == "node_modules" || name == "target" || name == "raw"
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_open_and_done_checkboxes_with_line_numbers() {
        let text = "# Notes\n\n- [ ] write the parser\n- [x] read the spec\nplain line\n* [ ] star bullet\n+ [X] plus bullet\n";
        let tasks = extract_tasks(text);
        assert_eq!(tasks.len(), 4);
        assert_eq!(tasks[0], (3, false, "write the parser".to_string()));
        assert_eq!(tasks[1], (4, true, "read the spec".to_string()));
        assert_eq!(tasks[2], (6, false, "star bullet".to_string()));
        assert_eq!(tasks[3], (7, true, "plus bullet".to_string()));
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
