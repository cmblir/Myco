// Bridges to third-party agent CLIs (Gemini CLI, Codex CLI) so Memex can
// drive them like the claude CLI: locate the binary (the GUI inherits
// launchd's minimal PATH), spawn headless with the vault as cwd, and capture
// the final answer. Both CLIs use the user's own subscription/login that the
// CLI manages itself — Memex stores no API key for them.
//
// Invocations (verified against the installed CLIs):
//   gemini -p <prompt> [--model <m>] --approval-mode yolo
//     headless mode; yolo pre-authorises tool use inside the vault cwd, the
//     same intent as the claude bridge's --allowedTools.
//   codex exec - [-m <m>] -s workspace-write --skip-git-repo-check
//         --color never -o <tmpfile>
//     prompt on stdin; the final agent message lands in <tmpfile> (stdout
//     carries the progress log). workspace-write scopes writes to the cwd;
//     --skip-git-repo-check because vaults usually aren't git repos.
//
// SECURITY (ingest of untrusted raw/ content): like the claude bridge, ingest
// feeds untrusted source text to these agents. The two CLIs differ in blast
// radius and we pick the safest level each one offers headlessly:
//   - codex `-s workspace-write` is a real sandbox: writes are confined to the
//     cwd (the vault) and network is restricted, so a prompt-injection payload
//     cannot escape the vault or phone home. This is the level ingest needs (it
//     must write wiki/) — `read-only` would break ingest — so it is left as-is.
//   - gemini `--approval-mode yolo` auto-approves ALL tool use (incl. shell),
//     which is broader than we'd like; gemini-cli currently offers no headless
//     "edit-only" approval mode that wouldn't hang on a shell prompt. Until it
//     does, prefer codex or the claude bridge for ingesting untrusted sources.

use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::claude::{augmented_path, locate_bin, run_with_timeout, CliResult, CliStatus};

const DEFAULT_TIMEOUT_SECS: u64 = 600;

/// Settings sentinel meaning "let the CLI use its configured default model".
const DEFAULT_MODEL: &str = "(default)";

pub fn provider_bin(provider: &str) -> Option<(&'static str, &'static str)> {
    match provider {
        "gemini-cli" => Some(("gemini", "MEMEX_GEMINI_PATH")),
        "codex-cli" => Some(("codex", "MEMEX_CODEX_PATH")),
        _ => None,
    }
}

pub fn check(provider: &str) -> CliStatus {
    let Some((bin, env)) = provider_bin(provider) else {
        return CliStatus {
            installed: false,
            version: None,
            path: None,
        };
    };
    match locate_bin(bin, env) {
        Some(path) => {
            let v = Command::new(&path)
                .arg("--version")
                .env("PATH", augmented_path(&path))
                .output()
                .ok()
                .and_then(|o| {
                    if o.status.success() {
                        Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
                    } else {
                        None
                    }
                });
            CliStatus {
                installed: true,
                version: v,
                path: Some(path),
            }
        }
        None => CliStatus {
            installed: false,
            version: None,
            path: None,
        },
    }
}

/// CLI arguments for a headless run. Pure so the shape is unit-testable.
/// Returns (args, prompt_on_stdin).
fn build_args(
    provider: &str,
    model: &str,
    prompt: &str,
    out_file: &str,
) -> Option<(Vec<String>, bool)> {
    let model_flag = |flag: &str| -> Vec<String> {
        if model.is_empty() || model == DEFAULT_MODEL {
            vec![]
        } else {
            vec![flag.to_string(), model.to_string()]
        }
    };
    match provider {
        "gemini-cli" => {
            let mut args = vec![
                "-p".to_string(),
                prompt.to_string(),
                "--approval-mode".to_string(),
                "yolo".to_string(),
                // Headless runs in a not-yet-trusted folder hard-fail without
                // this (verified against gemini-cli's trusted-folders check).
                "--skip-trust".to_string(),
            ];
            args.extend(model_flag("-m"));
            Some((args, false))
        }
        "codex-cli" => {
            let mut args = vec![
                "exec".to_string(),
                "-".to_string(),
                "-s".to_string(),
                "workspace-write".to_string(),
                "--skip-git-repo-check".to_string(),
                "--color".to_string(),
                "never".to_string(),
                "-o".to_string(),
                out_file.to_string(),
            ];
            args.extend(model_flag("-m"));
            Some((args, true))
        }
        _ => None,
    }
}

pub fn run_prompt(
    provider: &str,
    model: &str,
    prompt: &str,
    cwd: &str,
) -> Result<CliResult, String> {
    let (bin, env) =
        provider_bin(provider).ok_or_else(|| format!("unknown provider: {provider}"))?;
    let path = locate_bin(bin, env).ok_or_else(|| {
        format!("{bin} CLI not found on PATH. Install it, or set {env} to its location.")
    })?;
    let dir = Path::new(cwd);
    if !dir.is_dir() {
        return Err(format!("cwd is not a directory: {cwd}"));
    }
    let out_file = std::env::temp_dir().join(format!(
        "memex-{bin}-{}-{}.txt",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let out_file_str = out_file.to_string_lossy().into_owned();
    let (args, prompt_on_stdin) =
        build_args(provider, model, prompt, &out_file_str).ok_or("unsupported provider")?;

    let child = Command::new(&path)
        .args(&args)
        .env("PATH", augmented_path(&path))
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn {bin} failed: {e}"))?;

    // Feed the prompt to stdin only when the provider wants it there (codex via
    // `exec -`); gemini takes it as an argv flag, so it just needs EOF. Reuse the
    // shared drain-on-threads runner: it writes stdin while concurrently reading
    // stdout/stderr to EOF, so a verbose child (codex streams a long progress log
    // to stdout) can't deadlock by filling its ~64 KB stdout pipe while we block
    // on the stdin write. It also reaps the child on timeout (no zombie).
    let prompt_bytes = if prompt_on_stdin {
        prompt.as_bytes().to_vec()
    } else {
        Vec::new()
    };
    let result = run_with_timeout(
        child,
        prompt_bytes,
        Duration::from_secs(DEFAULT_TIMEOUT_SECS),
        bin,
    )?;
    // Codex writes the final agent message to -o; prefer it over the
    // progress log on stdout.
    let answer = std::fs::read_to_string(&out_file)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| result.stdout.trim().to_string());
    let _ = std::fs::remove_file(&out_file);

    Ok(CliResult {
        stdout: answer,
        stderr: result.stderr,
        status: result.status,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_bins_map() {
        assert_eq!(provider_bin("gemini-cli").unwrap().0, "gemini");
        assert_eq!(provider_bin("codex-cli").unwrap().0, "codex");
        assert!(provider_bin("ollama").is_none());
    }

    #[test]
    fn gemini_args_headless_with_model() {
        let (args, stdin) = build_args("gemini-cli", "gemini-2.5-pro", "hello", "/tmp/x").unwrap();
        assert!(!stdin);
        assert_eq!(args[0], "-p");
        assert_eq!(args[1], "hello");
        assert!(args.contains(&"--approval-mode".to_string()));
        assert!(args.contains(&"--skip-trust".to_string()));
        assert!(args.contains(&"gemini-2.5-pro".to_string()));
    }

    #[test]
    fn gemini_args_default_model_omits_flag() {
        let (args, _) = build_args("gemini-cli", "(default)", "hi", "/tmp/x").unwrap();
        assert!(!args.contains(&"-m".to_string()));
    }

    #[test]
    fn codex_args_stdin_sandbox_and_outfile() {
        let (args, stdin) = build_args("codex-cli", "(default)", "hi", "/tmp/out.txt").unwrap();
        assert!(stdin);
        assert_eq!(args[0], "exec");
        assert_eq!(args[1], "-");
        assert!(args.contains(&"workspace-write".to_string()));
        assert!(args.contains(&"--skip-git-repo-check".to_string()));
        assert!(args.contains(&"/tmp/out.txt".to_string()));
        assert!(!args.contains(&"-m".to_string()));
    }

    #[test]
    fn run_prompt_rejects_unknown_provider() {
        let res = run_prompt("nope", "", "hi", "/tmp");
        assert!(res.is_err());
    }
}
