// Audio/video transcription, BUILT IN. The app bundles a static whisper.cpp
// `whisper-cli` as a tauri sidecar (~3 MB, Metal embedded) and fetches its
// speech model once on first use — the owner's call: "사용자는 아무것도 모르는
// 사람들이 많을텐데 내부에 자체적으로 만들어놔야지". A user never installs
// anything. A whisper already on PATH still wins as an override for people who
// tuned their own (bigger model, custom build).
//
// Invocation shapes:
//   - bundled `whisper-cli` (whisper.cpp): `-f <audio> -m <model> -l auto
//                     -otxt -of <tmp>/<stem>` → <tmp>/<stem>.txt
//   - PATH `whisper` (openai-whisper): `whisper <audio> --output_format txt
//                     --output_dir <tmp> --model base` → <tmp>/<stem>.txt
//   - PATH `whisper-cli`: as bundled, minus -m/-l (their own default model)

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use tauri::Emitter as _;

use crate::claude::{augmented_path, locate_bin, run_with_timeout, CliResult, CliStatus};

const DEFAULT_TIMEOUT_SECS: u64 = 900; // transcription can be slow

/// The bundled model: whisper small, q5_1. `base` was measurably poor at
/// Korean — the e5 lesson again — and 190 MB once beats bad transcripts
/// forever. Verified against the exact published byte size before rename.
pub const BUILTIN_MODEL_FILE: &str = "ggml-small-q5_1.bin";
const BUILTIN_MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin";
const BUILTIN_MODEL_BYTES: u64 = 190_085_487;
/// Emitted while the one-time model download runs: `{downloaded, total, pct}`.
pub const MODEL_PROGRESS_EVENT: &str = "whisper-model-progress";

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Variant {
    OpenAi,     // `whisper`
    WhisperCpp, // `whisper-cli`
}

/// The bundled sidecar, if this install has one: tauri's externalBin lands it
/// next to the app executable (Contents/MacOS on macOS). Absent in `cargo
/// test` and dev servers launched without the bundler — the PATH fallback
/// keeps those working.
fn builtin_bin() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let bin = exe.parent()?.join("whisper-cli");
    bin.is_file().then_some(bin)
}

fn builtin_model_path() -> Result<PathBuf, String> {
    Ok(crate::settings::settings_dir()?
        .join("models")
        .join(BUILTIN_MODEL_FILE))
}

/// Make sure the bundled model exists, downloading it (once) with progress
/// events if not. Runs on a blocking thread; the async download is bridged
/// with block_on. `.part` + verify-size + rename, so a killed download can
/// never masquerade as a model.
fn ensure_builtin_model(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let model = builtin_model_path()?;
    if model.is_file() {
        return Ok(model);
    }
    let dir = model
        .parent()
        .ok_or_else(|| "model path has no parent".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("mkdir models: {e}"))?;
    let part = model.with_extension("bin.part");
    let app = app.clone();
    let part_dl = part.clone();
    tauri::async_runtime::block_on(async move {
        use futures_util::StreamExt as _;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(3600))
            .build()
            .map_err(|e| format!("http client: {e}"))?;
        let resp = client.get(BUILTIN_MODEL_URL).send().await.map_err(|e| {
            // Flatten the source chain: reqwest's Display hides the real
            // cause (the headed failure printed nothing but the URL, while
            // the cause was a corporate-proxy cert rustls didn't trust).
            let mut msg = format!("model download request: {e}");
            let mut src = std::error::Error::source(&e);
            while let Some(s) = src {
                msg.push_str(&format!(" — {s}"));
                src = s.source();
            }
            msg
        })?;
        if !resp.status().is_success() {
            return Err(format!("model download status {}", resp.status()));
        }
        let total = resp.content_length().unwrap_or(BUILTIN_MODEL_BYTES);
        let mut file = std::fs::File::create(&part_dl).map_err(|e| format!("create: {e}"))?;
        let mut stream = resp.bytes_stream();
        let mut downloaded: u64 = 0;
        let mut last_pct: u64 = 0;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("model download read: {e}"))?;
            std::io::Write::write_all(&mut file, &chunk).map_err(|e| format!("write: {e}"))?;
            downloaded += chunk.len() as u64;
            let pct = downloaded * 100 / total.max(1);
            if pct >= last_pct + 2 || downloaded == total {
                last_pct = pct;
                let _ = app.emit(
                    MODEL_PROGRESS_EVENT,
                    serde_json::json!({ "downloaded": downloaded, "total": total, "pct": pct }),
                );
            }
        }
        Ok(())
    })
    .inspect_err(|_| {
        let _ = std::fs::remove_file(&part);
    })?;
    let got = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if got != BUILTIN_MODEL_BYTES {
        let _ = std::fs::remove_file(&part);
        return Err(format!(
            "model download incomplete ({got} of {BUILTIN_MODEL_BYTES} bytes) — check the network and try again"
        ));
    }
    std::fs::rename(&part, &model).map_err(|e| format!("rename model: {e}"))?;
    Ok(model)
}

/// Locate a PATH whisper binary, preferring openai-whisper, then whisper.cpp.
/// A user's own install outranks the bundled one on purpose.
pub fn locate() -> Option<(String, Variant)> {
    if let Some(p) = locate_bin("whisper", "MYCO_WHISPER_PATH") {
        return Some((p, Variant::OpenAi));
    }
    if let Some(p) = locate_bin("whisper-cli", "MYCO_WHISPER_CLI_PATH") {
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
        None => match builtin_bin() {
            Some(bin) => CliStatus {
                installed: true,
                version: None,
                path: Some(bin.to_string_lossy().into_owned()),
            },
            None => CliStatus {
                installed: false,
                version: None,
                path: None,
            },
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
    model: Option<&Path>,
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
            let mut args = vec!["-f".to_string(), audio.to_string()];
            if let Some(m) = model {
                // Bundled run: OUR model, and `-l auto` — whisper-cli defaults
                // to English, which silently garbles Korean notes.
                args.push("-m".into());
                args.push(m.to_string_lossy().into_owned());
                args.push("-l".into());
                args.push("auto".into());
            }
            args.push("-otxt".into());
            args.push("-of".into());
            args.push(of.to_string_lossy().into_owned());
            (args, out_txt)
        }
    }
}

pub fn transcribe(app: &tauri::AppHandle, path: &str) -> Result<String, String> {
    // A PATH whisper is an explicit user choice and wins; otherwise the
    // bundled sidecar runs with the (auto-fetched) bundled model.
    let (bin, variant, model) = match locate() {
        Some((bin, variant)) => (bin, variant, None),
        None => {
            let bin = builtin_bin().ok_or_else(|| {
                "voice recognition binary is missing from this install — \
                 reinstall myco (or set MYCO_WHISPER_PATH)."
                    .to_string()
            })?;
            let model = ensure_builtin_model(app)?;
            (
                bin.to_string_lossy().into_owned(),
                Variant::WhisperCpp,
                Some(model),
            )
        }
    };
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
    let (args, out_txt) = build_args(variant, path, &stem, &out_dir, model.as_deref());

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
        let (args, out) = build_args(
            Variant::OpenAi,
            "/a/talk.mp3",
            "talk",
            Path::new("/tmp/x"),
            None,
        );
        assert_eq!(args[0], "/a/talk.mp3");
        assert!(args.contains(&"--output_format".to_string()));
        assert!(args.contains(&"txt".to_string()));
        assert!(args.contains(&"/tmp/x".to_string()));
        assert_eq!(out, PathBuf::from("/tmp/x/talk.txt"));
    }

    #[test]
    fn whisper_cpp_args_shape() {
        let (args, out) = build_args(
            Variant::WhisperCpp,
            "/a/talk.wav",
            "talk",
            Path::new("/tmp/x"),
            None,
        );
        assert_eq!(args[0], "-f");
        assert_eq!(args[1], "/a/talk.wav");
        assert!(args.contains(&"-otxt".to_string()));
        // -of gets the base path without extension; whisper.cpp appends .txt.
        // Built with join() rather than a literal: this is a real filesystem
        // path, so the separator is the platform's ('\' on Windows).
        let of_idx = args.iter().position(|a| a == "-of").unwrap();
        assert_eq!(
            args[of_idx + 1],
            Path::new("/tmp/x").join("talk").to_string_lossy()
        );
        assert_eq!(out, Path::new("/tmp/x").join("talk.txt"));
        // No model given (PATH binary) — never inject -m/-l into a user's
        // own whisper-cli setup.
        assert!(!args.contains(&"-m".to_string()));
        assert!(!args.contains(&"-l".to_string()));
    }

    #[test]
    fn builtin_args_carry_model_and_auto_language() {
        let (args, _) = build_args(
            Variant::WhisperCpp,
            "/a/talk.wav",
            "talk",
            Path::new("/tmp/x"),
            Some(Path::new("/data/models/ggml-small-q5_1.bin")),
        );
        let m = args.iter().position(|a| a == "-m").unwrap();
        assert_eq!(args[m + 1], "/data/models/ggml-small-q5_1.bin");
        let l = args.iter().position(|a| a == "-l").unwrap();
        // auto, not the whisper-cli default (en): Korean garbles otherwise.
        assert_eq!(args[l + 1], "auto");
    }
}
