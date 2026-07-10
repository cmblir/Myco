// Audio/video transcription via an INSTALLED whisper CLI (Feature 2). We do NOT
// bundle a speech model (hundreds of MB + a heavy dependency); instead, like the
// claude/gemini/codex bridges, we detect a whisper binary on PATH and shell it,
// so media ingest works for users who have whisper — and degrades to a clear
// "install whisper" message for those who don't. No asset bloat, no telemetry.
//
// Supported binaries (auto-detected, in order):
//   - `whisper`      (openai-whisper): `whisper <audio> --output_format txt
//                     --output_dir <tmp> --model base` → <tmp>/<stem>.txt
//   - `whisper-cli`  (whisper.cpp):    `whisper-cli -f <audio> -otxt
//                     -of <tmp>/<stem>` → <tmp>/<stem>.txt

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::claude::{augmented_path, locate_bin, run_with_timeout, CliResult, CliStatus};

const DEFAULT_TIMEOUT_SECS: u64 = 900; // transcription can be slow

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Variant {
    OpenAi,   // `whisper`
    WhisperCpp, // `whisper-cli`
}

/// Locate a whisper binary, preferring openai-whisper, then whisper.cpp.
pub fn locate() -> Option<(String, Variant)> {
    if let Some(p) = locate_bin("whisper", "MEMEX_WHISPER_PATH") {
        return Some((p, Variant::OpenAi));
    }
    if let Some(p) = locate_bin("whisper-cli", "MEMEX_WHISPER_CLI_PATH") {
        return Some((p, Variant::WhisperCpp));
    }
    None
}

pub fn check() -> CliStatus {
    match locate() {
        Some((path, _)) => CliStatus {
            installed: true,
            version: None,
            path: Some(path),
        },
        None => CliStatus {
            installed: false,
            version: None,
            path: None,
        },
    }
}

/// Build the CLI args + the .txt path the run is expected to produce. Pure, so
/// the invocation shape is unit-testable without the binary present.
pub fn build_args(
    variant: Variant,
    audio: &str,
    stem: &str,
    out_dir: &Path,
) -> (Vec<String>, PathBuf) {
    let out_txt = out_dir.join(format!("{stem}.txt"));
    match variant {
        Variant::OpenAi => (
            vec![
                audio.to_string(),
                "--output_format".into(),
                "txt".into(),
                "--output_dir".into(),
                out_dir.to_string_lossy().into_owned(),
                "--model".into(),
                "base".into(),
            ],
            out_txt,
        ),
        Variant::WhisperCpp => {
            let of = out_dir.join(stem);
            (
                vec![
                    "-f".into(),
                    audio.to_string(),
                    "-otxt".into(),
                    "-of".into(),
                    of.to_string_lossy().into_owned(),
                ],
                out_txt,
            )
        }
    }
}

pub fn transcribe(path: &str) -> Result<String, String> {
    let (bin, variant) = locate().ok_or_else(|| {
        "no whisper CLI found on PATH. Install openai-whisper (`pip install \
         openai-whisper`) or whisper.cpp, or set MEMEX_WHISPER_PATH."
            .to_string()
    })?;
    let file = Path::new(path);
    if !file.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let stem = file
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("audio")
        .to_string();
    let out_dir = std::env::temp_dir().join(format!("memex-whisper-{}", std::process::id()));
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("mkdir: {e}"))?;
    let (args, out_txt) = build_args(variant, path, &stem, &out_dir);

    let child = Command::new(&bin)
        .args(&args)
        .env("PATH", augmented_path(&bin))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn whisper failed: {e}"))?;
    let res: CliResult = run_with_timeout(
        child,
        Vec::new(),
        Duration::from_secs(DEFAULT_TIMEOUT_SECS),
        "whisper",
    )?;
    let text = std::fs::read_to_string(&out_txt)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        // Some builds print the transcript to stdout instead of a file.
        .unwrap_or_else(|| res.stdout.trim().to_string());
    let _ = std::fs::remove_dir_all(&out_dir);
    if text.is_empty() {
        return Err(format!(
            "whisper produced no transcript (exit {}): {}",
            res.status,
            res.stderr.trim()
        ));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_args_shape() {
        let (args, out) = build_args(Variant::OpenAi, "/a/talk.mp3", "talk", Path::new("/tmp/x"));
        assert_eq!(args[0], "/a/talk.mp3");
        assert!(args.contains(&"--output_format".to_string()));
        assert!(args.contains(&"txt".to_string()));
        assert!(args.contains(&"/tmp/x".to_string()));
        assert_eq!(out, PathBuf::from("/tmp/x/talk.txt"));
    }

    #[test]
    fn whisper_cpp_args_shape() {
        let (args, out) = build_args(Variant::WhisperCpp, "/a/talk.wav", "talk", Path::new("/tmp/x"));
        assert_eq!(args[0], "-f");
        assert_eq!(args[1], "/a/talk.wav");
        assert!(args.contains(&"-otxt".to_string()));
        // -of gets the base path without extension; whisper.cpp appends .txt.
        let of_idx = args.iter().position(|a| a == "-of").unwrap();
        assert_eq!(args[of_idx + 1], "/tmp/x/talk");
        assert_eq!(out, PathBuf::from("/tmp/x/talk.txt"));
    }
}
