// Real git-log integration test. Spins up a temp directory, initializes
// a git repo, makes a few commits, then verifies our shellout returns
// the same set the user would see in `git log`.

use memex_lib::git_log;
use std::path::PathBuf;
use std::process::Command;

fn temp_repo(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("memex-gitlog-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    run(&["git", "init", "-q"], &dir);
    run(&["git", "config", "user.email", "test@memex.local"], &dir);
    run(&["git", "config", "user.name", "Memex Test"], &dir);
    run(&["git", "config", "commit.gpgsign", "false"], &dir);
    dir
}

fn run(args: &[&str], cwd: &std::path::Path) {
    let out = Command::new(args[0])
        .args(&args[1..])
        .current_dir(cwd)
        .output()
        .unwrap_or_else(|_| panic!("failed to spawn {:?}", args));
    assert!(
        out.status.success(),
        "{:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
}

#[test]
fn returns_commits_in_reverse_chronological_order() {
    let repo = temp_repo("seq");
    for (i, msg) in [
        "initial commit",
        "add second file",
        "refactor stuff",
        "fix a bug",
    ]
    .iter()
    .enumerate()
    {
        std::fs::write(repo.join(format!("file-{i}.md")), format!("content {i}\n")).unwrap();
        run(&["git", "add", "."], &repo);
        run(&["git", "commit", "-q", "-m", msg], &repo);
    }
    let commits = git_log::git_log(repo.to_str().unwrap(), 10).unwrap();
    assert_eq!(commits.len(), 4);
    // Most recent first.
    assert_eq!(commits[0].subject, "fix a bug");
    assert_eq!(commits[3].subject, "initial commit");
    for c in &commits {
        assert!(c.hash.len() >= 7);
        assert_eq!(c.date.len(), 10, "YYYY-MM-DD: got {:?}", c.date);
        assert!(c.created > 0 || c.modified > 0);
    }
}

#[test]
fn honors_limit_argument() {
    let repo = temp_repo("limit");
    for i in 0..5 {
        std::fs::write(repo.join(format!("f{i}.md")), "x\n").unwrap();
        run(&["git", "add", "."], &repo);
        run(&["git", "commit", "-q", "-m", &format!("c{i}")], &repo);
    }
    let commits = git_log::git_log(repo.to_str().unwrap(), 2).unwrap();
    assert_eq!(commits.len(), 2, "limit not honoured");
}

#[test]
fn returns_empty_for_non_git_directory() {
    let dir = std::env::temp_dir().join(format!("memex-nogit-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let commits = git_log::git_log(dir.to_str().unwrap(), 10).unwrap();
    assert!(
        commits.is_empty(),
        "non-git dir should return [], not error"
    );
}

#[test]
fn errors_on_missing_directory() {
    let p = std::env::temp_dir().join("memex-does-not-exist-zzz");
    let _ = std::fs::remove_dir_all(&p);
    let res = git_log::git_log(p.to_str().unwrap(), 10);
    assert!(res.is_err());
}
