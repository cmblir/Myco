//! Opt-in vault git history. One shared commit helper carries the
//! agent/human authorship convention for every writer in the app.
//! Local-only by design: no remotes are configured, nothing is pushed.

use std::path::Path;

pub const AGENT_NAME: &str = "myco agent";
pub const AGENT_EMAIL: &str = "agent@myco.invalid";
/// Fallback human identity when ambient git config has none — the vault
/// must never fail to commit just because git was never set up.
const HUMAN_FALLBACK_NAME: &str = "myco user";
const HUMAN_FALLBACK_EMAIL: &str = "you@myco.invalid";

const GITIGNORE_LINES: &[&str] = &[".myco/", ".DS_Store", ".obsidian/workspace*"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CommitIdentity {
    Agent,
    Human,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct HistoryStatus {
    pub git_present: bool,
    pub enabled: bool,
}

pub(crate) fn git(root: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    std::process::Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| format!("git {}: {e}", args.first().copied().unwrap_or("")))
}

fn ambient_identity_missing(root: &Path) -> bool {
    !matches!(git(root, &["config", "user.email"]), Ok(o) if o.status.success() && !o.stdout.is_empty())
}

/// `-c` overrides for the requested identity. Agent commits are always
/// pinned; human commits use ambient config and only fall back when none.
fn identity_args(root: &Path, identity: CommitIdentity) -> Vec<String> {
    let (name, email) = match identity {
        CommitIdentity::Agent => (AGENT_NAME, AGENT_EMAIL),
        CommitIdentity::Human => {
            if ambient_identity_missing(root) {
                (HUMAN_FALLBACK_NAME, HUMAN_FALLBACK_EMAIL)
            } else {
                return Vec::new();
            }
        }
    };
    vec![
        "-c".into(),
        format!("user.name={name}"),
        "-c".into(),
        format!("user.email={email}"),
    ]
}

pub fn status(root: &Path, enabled: bool) -> HistoryStatus {
    HistoryStatus {
        git_present: root.join(".git").exists(),
        enabled,
    }
}

/// Stage `paths` (existing ones only) and commit as `identity`.
/// Ok(false) when staging produced no diff — matches the no-op detection
/// in mcp_native::git_commit.
pub fn commit_paths(
    root: &Path,
    paths: &[&str],
    message: &str,
    identity: CommitIdentity,
) -> Result<bool, String> {
    if !root.join(".git").exists() {
        return Ok(false);
    }
    let live: Vec<&str> = paths
        .iter()
        .copied()
        .filter(|p| root.join(p).exists())
        .collect();
    if live.is_empty() {
        return Ok(false);
    }
    let mut add = vec!["add", "--"];
    add.extend(&live);
    let out = git(root, &add)?;
    if !out.status.success() {
        return Err(format!(
            "git add failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    let staged = git(root, &["diff", "--cached", "--name-only"])?;
    if staged.stdout.is_empty() {
        return Ok(false);
    }
    let mut args: Vec<String> = identity_args(root, identity);
    args.extend(["commit".into(), "-m".into(), message.into()]);
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = git(root, &arg_refs)?;
    if !out.status.success() {
        return Err(format!(
            "git commit failed: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(true)
}

/// Full SHA of the newest commit whose subject is exactly `message`.
/// `None`: no repo, or no exact match. `--grep` is a substring match even
/// with `--fixed-strings`, so every candidate's subject is compared for
/// equality here instead of trusting grep's newest hit.
pub fn commit_for_message(root: &Path, message: &str) -> Option<String> {
    if !root.join(".git").exists() {
        return None;
    }
    let out = git(
        root,
        &[
            "log",
            "--format=%H %s",
            "--fixed-strings",
            "--grep",
            message,
        ],
    )
    .ok()?;
    if !out.status.success() {
        return None; // empty repo, or anything else git refuses to log
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|line| {
            let (sha, subject) = line.split_once(' ')?;
            (subject == message).then(|| sha.to_string())
        })
}

/// File content at `<sha>:<rel>`; `Ok(None)` when the path didn't exist in
/// that tree, `Err` for anything else (bad sha, no repo).
pub fn file_at(root: &Path, sha: &str, rel: &str) -> Result<Option<String>, String> {
    let spec = format!("{sha}:{rel}");
    let out = git(root, &["show", &spec])?;
    if out.status.success() {
        return Ok(Some(String::from_utf8_lossy(&out.stdout).into_owned()));
    }
    let err = String::from_utf8_lossy(&out.stderr);
    if err.contains("does not exist") || err.contains("exists on disk, but not in") {
        return Ok(None);
    }
    Err(format!("git show {spec}: {}", err.trim()))
}

/// `git show --name-status` of `sha` vs its first parent: `(status, rel)`
/// pairs in git's path order. Rename/copy rows (`R<score>\told\tnew`) emit
/// the NEW path under the bare status letter. A root commit (no parent)
/// lists every file as added.
pub fn changed_files(root: &Path, sha: &str) -> Result<Vec<(char, String)>, String> {
    let out = git(root, &["show", "--name-status", "--format=", sha])?;
    if !out.status.success() {
        return Err(format!(
            "git show --name-status {sha}: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut cols = line.split('\t');
            let status = cols.next()?.chars().next()?;
            let rel = cols.next_back()?;
            Some((status, rel.to_string()))
        })
        .collect())
}

/// Idempotent: creates the repo, seeds .gitignore, makes the initial commit.
pub fn init(root: &Path) -> Result<(), String> {
    if !root.join(".git").exists() {
        let out = git(root, &["init"])?;
        if !out.status.success() {
            return Err(format!(
                "git init failed: {}",
                String::from_utf8_lossy(&out.stderr)
            ));
        }
    }
    let gi = root.join(".gitignore");
    let existing = std::fs::read_to_string(&gi).unwrap_or_default();
    let mut merged = existing.clone();
    for line in GITIGNORE_LINES {
        if !existing.lines().any(|l| l.trim() == *line) {
            if !merged.is_empty() && !merged.ends_with('\n') {
                merged.push('\n');
            }
            merged.push_str(line);
            merged.push('\n');
        }
    }
    if merged != existing {
        std::fs::write(&gi, merged).map_err(|e| format!("write .gitignore: {e}"))?;
    }
    commit_paths(
        root,
        &["."],
        "chore: start vault history",
        CommitIdentity::Human,
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(root: &std::path::Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .expect("git runs");
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    #[test]
    fn status_reports_git_presence() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!status(dir.path(), false).git_present);
        init(dir.path()).unwrap();
        let s = status(dir.path(), true);
        assert!(s.git_present && s.enabled);
    }

    #[test]
    fn init_creates_repo_gitignore_and_initial_commit() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("wiki")).unwrap();
        std::fs::write(dir.path().join("wiki/a.md"), "hello").unwrap();
        init(dir.path()).unwrap();
        let ignore = std::fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        assert!(ignore.contains(".DS_Store"));
        let log = git(dir.path(), &["log", "--oneline"]);
        assert_eq!(log.lines().count(), 1, "exactly one initial commit");
        // init is idempotent
        init(dir.path()).unwrap();
        assert_eq!(git(dir.path(), &["log", "--oneline"]).lines().count(), 1);
    }

    #[test]
    fn commit_paths_separates_agent_and_human_authors() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("wiki")).unwrap();
        init(dir.path()).unwrap();

        std::fs::write(dir.path().join("wiki/a.md"), "agent wrote this").unwrap();
        assert!(commit_paths(
            dir.path(),
            &["wiki"],
            "distill: run test",
            CommitIdentity::Agent
        )
        .unwrap());

        std::fs::write(dir.path().join("wiki/a.md"), "then a human edited").unwrap();
        assert!(
            commit_paths(dir.path(), &["wiki/a.md"], "edit: a", CommitIdentity::Human).unwrap()
        );

        let authors = git(dir.path(), &["log", "--format=%an"]);
        let names: Vec<&str> = authors.lines().collect();
        assert!(
            names.contains(&AGENT_NAME),
            "agent author recorded: {authors}"
        );
        assert!(
            !names.iter().all(|n| *n == AGENT_NAME),
            "human commit uses a different author"
        );
    }

    #[test]
    fn commit_paths_is_a_noop_when_nothing_changed() {
        let dir = tempfile::tempdir().unwrap();
        init(dir.path()).unwrap();
        assert!(!commit_paths(dir.path(), &["wiki"], "empty", CommitIdentity::Agent).unwrap());
        assert_eq!(git(dir.path(), &["log", "--oneline"]).lines().count(), 1);
    }

    #[test]
    fn commit_for_message_finds_exact_subject() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("wiki")).unwrap();
        std::fs::write(root.join("wiki/a.md"), "v1").unwrap();
        init(root).unwrap();
        std::fs::write(root.join("wiki/a.md"), "v2").unwrap();
        assert!(
            commit_paths(root, &["."], "distill: run digest-1", CommitIdentity::Agent).unwrap()
        );

        let sha = commit_for_message(root, "distill: run digest-1").expect("commit found");
        assert_eq!(sha.len(), 40, "full sha, not abbreviated: {sha}");
        assert_eq!(git(root, &["rev-parse", "HEAD"]).trim(), sha);

        // A later unrelated commit must not shadow the match…
        std::fs::write(root.join("wiki/a.md"), "v3").unwrap();
        assert!(commit_paths(root, &["."], "edit: unrelated", CommitIdentity::Human).unwrap());
        assert_eq!(commit_for_message(root, "distill: run digest-1"), Some(sha));
        // …a substring of a real subject is not an exact match (grep is
        // substring even with --fixed-strings)…
        assert_eq!(commit_for_message(root, "distill: run"), None);
        // …and no repo at all is None, not an error.
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(
            commit_for_message(empty.path(), "distill: run digest-1"),
            None
        );
    }

    #[test]
    fn file_at_returns_versions_and_none_for_absent() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("wiki")).unwrap();
        std::fs::write(root.join("wiki/a.md"), "v1 content\n").unwrap();
        init(root).unwrap();
        let sha1 = commit_for_message(root, "chore: start vault history").expect("initial");
        std::fs::write(root.join("wiki/a.md"), "v2 content\n").unwrap();
        assert!(commit_paths(
            root,
            &["wiki"],
            "distill: run digest-2",
            CommitIdentity::Agent
        )
        .unwrap());
        let sha2 = commit_for_message(root, "distill: run digest-2").expect("second");

        assert_eq!(
            file_at(root, &sha2, "wiki/a.md").unwrap(),
            Some("v2 content\n".to_string())
        );
        assert_eq!(
            file_at(root, &sha1, "wiki/a.md").unwrap(),
            Some("v1 content\n".to_string())
        );
        assert_eq!(file_at(root, &sha1, "wiki/absent.md").unwrap(), None);
        assert!(file_at(root, "not-a-sha", "wiki/a.md").is_err());
    }

    #[test]
    fn changed_files_lists_status_pairs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("wiki")).unwrap();
        std::fs::write(root.join("wiki/a.md"), "v1").unwrap();
        init(root).unwrap();
        std::fs::write(root.join("wiki/a.md"), "v2").unwrap();
        std::fs::write(root.join("wiki/b.md"), "new").unwrap();
        assert!(commit_paths(
            root,
            &["wiki"],
            "distill: run digest-3",
            CommitIdentity::Agent
        )
        .unwrap());
        let sha = commit_for_message(root, "distill: run digest-3").unwrap();

        assert_eq!(
            changed_files(root, &sha).unwrap(),
            vec![
                ('M', "wiki/a.md".to_string()),
                ('A', "wiki/b.md".to_string())
            ]
        );

        // A root commit has no parent — git still lists its files as added.
        let sha1 = commit_for_message(root, "chore: start vault history").unwrap();
        assert!(changed_files(root, &sha1)
            .unwrap()
            .contains(&('A', "wiki/a.md".to_string())));
    }
}
