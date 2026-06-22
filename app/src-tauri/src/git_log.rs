// Git log reader. Shells out to the system `git` binary to keep our binary
// small. The vault directory must be inside (or be the root of) a git repo;
// otherwise we return an empty list rather than failing — many Memex users
// won't have version control set up yet.

use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Serialize)]
pub struct Commit {
    pub hash: String,
    pub date: String,
    pub subject: String,
    pub created: u32,
    pub modified: u32,
}

pub fn git_log(vault_path: &str, limit: usize) -> Result<Vec<Commit>, String> {
    let root = Path::new(vault_path);
    if !root.is_dir() {
        return Err(format!("not a directory: {vault_path}"));
    }

    let inside = Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(root)
        .output();
    let inside_ok = matches!(inside, Ok(o) if o.status.success() && String::from_utf8_lossy(&o.stdout).trim() == "true");
    if !inside_ok {
        return Ok(Vec::new());
    }

    let limit_arg = format!("-{limit}");
    let output = Command::new("git")
        .args([
            "log",
            &limit_arg,
            "--pretty=format:%h\x1f%ad\x1f%s",
            "--date=short",
            "--shortstat",
        ])
        .current_dir(root)
        .output()
        .map_err(|e| format!("git log failed: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "git log exit {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(parse_log(&String::from_utf8_lossy(&output.stdout)))
}

fn parse_log(text: &str) -> Vec<Commit> {
    let mut out = Vec::new();
    let mut current: Option<Commit> = None;
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        if let Some((hash, rest)) = line.split_once('\x1f') {
            if let Some(c) = current.take() {
                out.push(c);
            }
            if let Some((date, subject)) = rest.split_once('\x1f') {
                current = Some(Commit {
                    hash: hash.to_string(),
                    date: date.to_string(),
                    subject: subject.to_string(),
                    created: 0,
                    modified: 0,
                });
            }
        } else {
            // shortstat: ` 3 files changed, 12 insertions(+), 4 deletions(-)`
            // Singular variants: ` 1 file changed, 1 insertion(+), 1 deletion(-)`.
            if let Some(c) = current.as_mut() {
                c.modified =
                    extract_after("file changed", line).max(extract_after("files changed", line));
                c.created =
                    extract_after("insertion(+)", line).max(extract_after("insertions(+)", line));
            }
        }
    }
    if let Some(c) = current {
        out.push(c);
    }
    out
}

fn extract_after(needle: &str, line: &str) -> u32 {
    if let Some(idx) = line.find(needle) {
        let prefix = &line[..idx];
        let num_chars: String = prefix
            .chars()
            .rev()
            .skip_while(|c| !c.is_ascii_digit())
            .take_while(|c| c.is_ascii_digit() || c.is_whitespace())
            .collect();
        let digits: String = num_chars.chars().rev().collect();
        return digits.trim().parse::<u32>().unwrap_or(0);
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_basic_log() {
        let text = "abc1234\x1f2026-05-08\x1ffeat: hello\n 1 file changed, 5 insertions(+)\n";
        let commits = parse_log(text);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].hash, "abc1234");
        assert_eq!(commits[0].date, "2026-05-08");
        assert_eq!(commits[0].subject, "feat: hello");
        assert_eq!(commits[0].created, 5);
        assert_eq!(commits[0].modified, 1);
    }

    #[test]
    fn parses_singular_forms() {
        let text = "abc\x1f2026-01-01\x1finit\n 1 file changed, 1 insertion(+)\n";
        let commits = parse_log(text);
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0].created, 1);
        assert_eq!(commits[0].modified, 1);
    }

    #[test]
    fn parses_multiple_commits() {
        let text = "aaa\x1f2026-05-01\x1ffirst\n 2 files changed, 3 insertions(+), 1 deletion(-)\nbbb\x1f2026-05-02\x1fsecond\n";
        let commits = parse_log(text);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].hash, "aaa");
        assert_eq!(commits[1].subject, "second");
    }
}
