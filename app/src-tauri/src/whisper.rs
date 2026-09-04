// Audio/video transcription, BUILT IN. The app bundles a static whisper.cpp
// `whisper-cli` as a tauri sidecar (~3 MB, Metal embedded) and fetches its
// speech model once on first use — the owner's call: "사용자는 아무것도 모르는
// 사람들이 많을텐데 내부에 자체적으로 만들어놔야지". A user never installs
// anything. A whisper already on PATH still wins as an override for people who
// tuned their own (bigger model, custom build).
//
// Invocation shapes:
//   - bundled `whisper-cli` (whisper.cpp): `-f <audio> -m <model> -l auto
//                     -pp -otxt -of <tmp>/<stem>` → <tmp>/<stem>.txt
//   - PATH `whisper` (openai-whisper): `whisper <audio> --output_format txt
//                     --output_dir <tmp> --model base` → <tmp>/<stem>.txt
//   - PATH `whisper-cli`: as bundled, minus -m/-l (their own default model)

use std::io::BufRead as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tauri::Emitter as _;

use crate::claude::{augmented_path, locate_bin, run_with_timeout, CliResult, CliStatus};

/// Floor, not ceiling: `transcribe_timeout` scales the deadline with the
/// audio's size, and this floor keeps short clips from a too-tight budget.
/// The old fixed 900s silently killed hour-plus meeting recordings.
const DEFAULT_TIMEOUT_SECS: u64 = 900;

/// Emitted while a transcription runs: `{pct}` (0–100), parsed from
/// whisper.cpp's `-pp` progress lines. Only the bundled run emits it — a
/// user's own PATH binary is invoked with their flags untouched.
pub const TRANSCRIBE_PROGRESS_EVENT: &str = "whisper-transcribe-progress";

/// The only audio containers the whisper.cpp sidecar decodes itself (its
/// --help states them). Everything else ingest accepts (m4a/aac/mp4/mov…)
/// must be converted first — there is no ffmpeg in this app on purpose.
const SIDECAR_AUDIO_EXTS: [&str; 4] = ["flac", "mp3", "ogg", "wav"];

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

fn sidecar_reads_natively(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| SIDECAR_AUDIO_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Convert `src` to the 16 kHz mono 16-bit WAV the sidecar (and its model)
/// expects, using macOS's built-in `afconvert` (CoreAudio) — zero new
/// dependencies, nothing for the user to install, which is the same rule the
/// bundled sidecar itself follows. Covers the m4a/aac/mp4 recordings that
/// meeting apps and phones actually produce; a container CoreAudio cannot
/// read (webm/mkv) fails here with the tool named, never silently.
fn afconvert_to_wav(src: &Path, out_dir: &Path) -> Result<PathBuf, String> {
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("audio");
    let dst = out_dir.join(format!("{stem}.wav"));
    let child = Command::new("afconvert")
        .args([
            "-f",
            "WAVE",
            "-d",
            "LEI16@16000",
            "-c",
            "1",
            &src.to_string_lossy(),
            &dst.to_string_lossy(),
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn afconvert failed (audio format needs conversion): {e}"))?;
    let res = run_with_timeout(child, Vec::new(), Duration::from_secs(600), "afconvert")?;
    if res.status != 0 || !dst.is_file() {
        return Err(format!(
            "afconvert could not read this audio (exit {}): {}",
            res.status,
            res.stderr.trim()
        ));
    }
    Ok(dst)
}

/// Deadline scaled to the audio: bytes/32k ≈ seconds for our 16 kHz mono WAV,
/// and an over-estimate for compressed input (denser bytes → shorter audio) —
/// over is the safe direction for a timeout. ×6 allows well below real-time
/// transcription on an old CPU; DEFAULT_TIMEOUT_SECS floors short clips.
fn transcribe_timeout(audio_bytes: u64) -> Duration {
    let est_secs = audio_bytes / 32_000;
    Duration::from_secs(DEFAULT_TIMEOUT_SECS.max(est_secs.saturating_mul(6)))
}

/// The percent in a whisper.cpp `-pp` stderr line
/// (`whisper_print_progress_callback: progress =   5%`), if this is one.
fn parse_progress_line(line: &str) -> Option<u8> {
    let rest = line.split("progress =").nth(1)?;
    let digits: String = rest.chars().filter(|c| c.is_ascii_digit()).collect();
    digits.parse::<u8>().ok().filter(|p| *p <= 100)
}

/// Like claude::run_with_timeout, but stderr is read LINE-WISE so progress
/// can be reported mid-run — the buffering runner cannot say anything until
/// the process exits, which for an hour of audio reads as a hang. Every
/// stderr line is kept for error reporting; lines that parse as progress are
/// re-emitted as TRANSCRIBE_PROGRESS_EVENT (unless `quiet`).
fn run_streaming(
    app: &tauri::AppHandle,
    mut child: std::process::Child,
    timeout: Duration,
    quiet: bool,
) -> Result<CliResult, String> {
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_handle = std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut so) = stdout {
            let _ = std::io::Read::read_to_end(&mut so, &mut buf);
        }
        buf
    });
    let emit_app = app.clone();
    let stderr_handle = std::thread::spawn(move || {
        let mut all = String::new();
        if let Some(se) = stderr {
            for line in std::io::BufReader::new(se).lines() {
                let Ok(line) = line else { break };
                if !quiet {
                    if let Some(pct) = parse_progress_line(&line) {
                        let _ = emit_app
                            .emit(TRANSCRIBE_PROGRESS_EVENT, serde_json::json!({ "pct": pct }));
                    }
                }
                all.push_str(&line);
                all.push('\n');
            }
        }
        all
    });
    let start = std::time::Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {
                if start.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_handle.join();
                    let _ = stderr_handle.join();
                    return Err(format!("whisper timed out after {}s", timeout.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(80));
            }
            Err(e) => return Err(format!("wait for whisper failed: {e}")),
        }
    };
    let stdout = String::from_utf8_lossy(&stdout_handle.join().unwrap_or_default()).into_owned();
    let stderr = stderr_handle.join().unwrap_or_default();
    Ok(CliResult {
        stdout,
        stderr,
        status: status.code().unwrap_or(-1),
    })
}

/// Build the CLI args + the .txt path the run is expected to produce. Pure, so
/// the invocation shape is unit-testable without the binary present.
pub fn build_args(
    variant: Variant,
    audio: &str,
    stem: &str,
    out_dir: &Path,
    model: Option<&Path>,
    json: bool,
    fast: bool,
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
                if fast {
                    // Live captions: greedy decoding instead of the default
                    // beam search. Measured on this model (small-q5_1, Metal):
                    // 13 s of speech 2.65 s → 1.64 s, 27 s 3.64 s → 2.14 s.
                    // The words are provisional — the saved note is written by
                    // the ordinary beam-search run — so ~40% of the wait is
                    // worth an occasional worse guess. `-pp` is dropped too:
                    // nothing renders a partial's percent.
                    args.push("-bs".into());
                    args.push("1".into());
                    args.push("-bo".into());
                    args.push("1".into());
                } else {
                    // `-pp` prints progress lines that run_streaming re-emits
                    // as events; only injected here, never into a user's own
                    // setup.
                    args.push("-pp".into());
                }
                if json {
                    // Meeting-length audio: segment offsets for the
                    // timestamped transcript. Alongside -otxt, so a parse
                    // failure still has the plain text to fall back on.
                    args.push("-oj".into());
                }
            }
            args.push("-otxt".into());
            args.push("-of".into());
            args.push(of.to_string_lossy().into_owned());
            (args, out_txt)
        }
    }
}

// ---- meeting-length output (F3) ---------------------------------------------
//
// Speaker diarization stays a SEPARATE slice: the spike (2026-08-31, web)
// confirmed whisper.cpp's tinydiarize ships an English-only small.en-tdrz
// model — unusable for Korean meetings — while sherpa-onnx offers local,
// language-independent diarization (pyannote-segmentation-3.0 onnx + a
// speaker-embedding model, standalone CLI). Adopting that means a second
// sidecar + two model downloads + merging its turns with these segments,
// so F4 builds on the Segment type below when it lands.

/// One transcript segment from whisper.cpp's `-oj` output.
#[derive(Debug, Clone, PartialEq)]
pub struct Segment {
    pub from_ms: u64,
    pub to_ms: u64,
    pub text: String,
}

/// Parse whisper.cpp's `-oj` JSON (`{"transcription":[{"offsets":{"from","to"},
/// "text"}]}`). Unknown shapes yield an empty list — the caller falls back to
/// the plain-text output rather than failing a finished transcription.
pub fn parse_whisper_json(raw: &str) -> Vec<Segment> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Vec::new();
    };
    let Some(items) = v.get("transcription").and_then(|t| t.as_array()) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|it| {
            let text = it.get("text")?.as_str()?.trim().to_string();
            if text.is_empty() {
                return None;
            }
            let off = it.get("offsets")?;
            Some(Segment {
                from_ms: off.get("from")?.as_u64()?,
                to_ms: off.get("to")?.as_u64()?,
                text,
            })
        })
        .collect()
}

fn hhmmss(ms: u64) -> String {
    let s = ms / 1000;
    format!("{:02}:{:02}:{:02}", s / 3600, (s % 3600) / 60, s % 60)
}

/// Render segments as timestamped paragraphs. A new block starts on a ≥2s
/// silence or once a block spans a minute — the two natural paragraph
/// boundaries a meeting transcript has. Each block leads with `[HH:MM:SS]`,
/// so a citation into an hour of audio is seekable.
pub fn format_timestamped(segments: &[Segment]) -> String {
    const GAP_MS: u64 = 2_000;
    const BLOCK_MS: u64 = 60_000;
    let mut blocks: Vec<String> = Vec::new();
    let mut cur: Vec<&str> = Vec::new();
    let mut cur_start = 0u64;
    let mut prev_end = 0u64;
    for seg in segments {
        let boundary = !cur.is_empty()
            && (seg.from_ms.saturating_sub(prev_end) >= GAP_MS
                || seg.to_ms.saturating_sub(cur_start) >= BLOCK_MS);
        if boundary {
            blocks.push(format!("[{}] {}", hhmmss(cur_start), cur.join(" ")));
            cur.clear();
        }
        if cur.is_empty() {
            cur_start = seg.from_ms;
        }
        cur.push(&seg.text);
        prev_end = seg.to_ms;
    }
    if !cur.is_empty() {
        blocks.push(format!("[{}] {}", hhmmss(cur_start), cur.join(" ")));
    }
    blocks.join("\n\n")
}

/// Like `format_timestamped`, with each block owned by one speaker: a block
/// also breaks when the diarizer says the voice changed, and leads with
/// `[HH:MM:SS] 화자 N:`. A segment the diarizer could not place (None)
/// inherits the running block's speaker rather than forcing a break.
pub fn format_timestamped_speakers(segments: &[Segment], turns: &[crate::diarize::Turn]) -> String {
    const GAP_MS: u64 = 2_000;
    const BLOCK_MS: u64 = 60_000;
    let mut blocks: Vec<String> = Vec::new();
    let mut cur: Vec<&str> = Vec::new();
    let mut cur_start = 0u64;
    let mut cur_speaker: Option<u32> = None;
    let mut prev_end = 0u64;
    let flush = |blocks: &mut Vec<String>, cur: &mut Vec<&str>, start: u64, sp: Option<u32>| {
        if cur.is_empty() {
            return;
        }
        let who = sp.map(|n| format!("화자 {}: ", n + 1)).unwrap_or_default();
        blocks.push(format!("[{}] {}{}", hhmmss(start), who, cur.join(" ")));
        cur.clear();
    };
    for seg in segments {
        let sp = crate::diarize::speaker_at(turns, seg.from_ms, seg.to_ms);
        let speaker_changed = sp.is_some() && cur_speaker.is_some() && sp != cur_speaker;
        let boundary = !cur.is_empty()
            && (speaker_changed
                || seg.from_ms.saturating_sub(prev_end) >= GAP_MS
                || seg.to_ms.saturating_sub(cur_start) >= BLOCK_MS);
        if boundary {
            flush(&mut blocks, &mut cur, cur_start, cur_speaker);
        }
        if cur.is_empty() {
            cur_start = seg.from_ms;
            cur_speaker = sp;
        } else if cur_speaker.is_none() {
            cur_speaker = sp;
        }
        cur.push(&seg.text);
        prev_end = seg.to_ms;
    }
    flush(&mut blocks, &mut cur, cur_start, cur_speaker);
    blocks.join("\n\n")
}

/// Audio length (secs) worth timestamping — short clips read better plain.
const TIMESTAMP_MIN_SECS: u64 = 600;

/// Plain transcript — quick voice captures and short clips.
pub fn transcribe(app: &tauri::AppHandle, path: &str) -> Result<String, String> {
    transcribe_inner(app, path, false, false)
}

/// Plain transcript with NO progress events: the live-caption partials run
/// every few seconds beside a recording, and their `-pp` lines would drive
/// the spotlight/notch save meter while nothing is being saved.
pub fn transcribe_quiet(app: &tauri::AppHandle, path: &str) -> Result<String, String> {
    transcribe_inner(app, path, false, true)
}

/// Media-file transcript: meeting-length audio (>10 min, bundled runs) comes
/// back as `[HH:MM:SS]`-led paragraphs; anything shorter stays plain. PATH
/// binaries keep their own output shape — no flags are injected into a
/// user's setup, so those never timestamp.
pub fn transcribe_auto(app: &tauri::AppHandle, path: &str) -> Result<String, String> {
    transcribe_inner(app, path, true, false)
}

fn transcribe_inner(
    app: &tauri::AppHandle,
    path: &str,
    want_timestamps: bool,
    quiet: bool,
) -> Result<String, String> {
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
    // Per RUN, not per process: live captions transcribe a partial while the
    // same take's save_voice_capture may already be running, and the shared
    // directory made the two races each other — whichever finished first ran
    // remove_dir_all and deleted the other's `-otxt` output, so the survivor
    // fell back to stdout or empty, errored, and the memo's audio was lost.
    static RUN: AtomicU64 = AtomicU64::new(0);
    let out_dir = std::env::temp_dir().join(format!(
        "memex-whisper-{}-{}",
        std::process::id(),
        RUN.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("mkdir: {e}"))?;
    // whisper.cpp (bundled OR the user's PATH whisper-cli) reads only
    // flac/mp3/ogg/wav — but ingest accepts the m4a/mp4 that meeting apps
    // and phones produce. Convert those with the OS's own afconvert first.
    // openai-whisper decodes via its own ffmpeg and is left alone.
    let audio: String = if variant == Variant::WhisperCpp && !sidecar_reads_natively(file) {
        afconvert_to_wav(file, &out_dir)?
            .to_string_lossy()
            .into_owned()
    } else {
        path.to_string()
    };
    // Timestamp only what is actually long: bytes/32k ≈ seconds for our
    // 16 kHz mono WAV and a conservative floor for compressed input.
    let audio_bytes = std::fs::metadata(&audio).map(|m| m.len()).unwrap_or(0);
    let json = want_timestamps && model.is_some() && audio_bytes / 32_000 >= TIMESTAMP_MIN_SECS;
    let (args, out_txt) = build_args(
        variant,
        &audio,
        &stem,
        &out_dir,
        model.as_deref(),
        json,
        quiet,
    );

    let timeout = transcribe_timeout(audio_bytes);
    let child = Command::new(&bin)
        .args(&args)
        .env("PATH", augmented_path(&bin))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn whisper failed: {e}"))?;
    let res: CliResult = run_streaming(app, child, timeout, quiet)?;
    // Prefer the timestamped rendering when segments were asked for and
    // parsed; any JSON hiccup falls back to the plain text, never to an
    // error — the transcription itself succeeded. When segments exist,
    // speaker diarization runs on top (sherpa-onnx sidecar, fetched on
    // first use) — best-effort: any failure there means timestamps
    // without speakers, silently.
    let timestamped = json
        .then(|| std::fs::read_to_string(out_txt.with_extension("json")).ok())
        .flatten()
        .map(|raw| {
            let segs = parse_whisper_json(&raw);
            if segs.is_empty() {
                return String::new();
            }
            // The diarizer wants a 16 kHz mono WAV; a natively-readable
            // mp3/flac input skipped afconvert above, so convert here.
            let wav = if audio.to_lowercase().ends_with(".wav") {
                Some(audio.clone())
            } else {
                afconvert_to_wav(Path::new(&audio), &out_dir)
                    .ok()
                    .map(|p| p.to_string_lossy().into_owned())
            };
            match wav.and_then(|w| crate::diarize::diarize(app, &w).ok()) {
                Some(turns) => format_timestamped_speakers(&segs, &turns),
                None => format_timestamped(&segs),
            }
        })
        .filter(|s| !s.is_empty());
    let text = timestamped.unwrap_or_else(|| {
        std::fs::read_to_string(&out_txt)
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            // Some builds print the transcript to stdout instead of a file.
            .unwrap_or_else(|| res.stdout.trim().to_string())
    });
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
            false,
            false,
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
            false,
            false,
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
            false,
            false,
        );
        let m = args.iter().position(|a| a == "-m").unwrap();
        assert_eq!(args[m + 1], "/data/models/ggml-small-q5_1.bin");
        let l = args.iter().position(|a| a == "-l").unwrap();
        // auto, not the whisper-cli default (en): Korean garbles otherwise.
        assert_eq!(args[l + 1], "auto");
        // Progress lines for run_streaming — bundled runs only.
        assert!(args.contains(&"-pp".to_string()));
    }

    #[test]
    fn fast_runs_decode_greedily_and_skip_progress() {
        let model = Path::new("/m/ggml-small-q5_1.bin");
        let (args, _) = build_args(
            Variant::WhisperCpp,
            "/a/partial.wav",
            "partial",
            Path::new("/tmp/x"),
            Some(model),
            false,
            true,
        );
        // Greedy: measured ~40% off the wall time, and a live caption is
        // provisional — the saved note comes from the ordinary run.
        let bs = args.iter().position(|a| a == "-bs").unwrap();
        assert_eq!(args[bs + 1], "1");
        let bo = args.iter().position(|a| a == "-bo").unwrap();
        assert_eq!(args[bo + 1], "1");
        // Nothing renders a partial's percent, so no progress chatter.
        assert!(!args.contains(&"-pp".to_string()));
    }

    #[test]
    fn json_flag_rides_only_on_bundled_runs() {
        let model = Path::new("/m/ggml-small-q5_1.bin");
        let (args, _) = build_args(
            Variant::WhisperCpp,
            "/a/mtg.wav",
            "mtg",
            Path::new("/tmp/x"),
            Some(model),
            true,
            false,
        );
        assert!(args.contains(&"-oj".to_string()));
        assert!(args.contains(&"-otxt".to_string()), "plain fallback stays");
        // A user's own PATH whisper-cli never gets extra flags injected.
        let (args, _) = build_args(
            Variant::WhisperCpp,
            "/a/mtg.wav",
            "mtg",
            Path::new("/tmp/x"),
            None,
            true,
            false,
        );
        assert!(!args.contains(&"-oj".to_string()));
    }

    #[test]
    fn whisper_json_parses_offsets_and_skips_junk() {
        let raw = r#"{"transcription":[
            {"offsets":{"from":0,"to":4000},"text":" 회의를 시작하겠습니다."},
            {"offsets":{"from":4000,"to":9000},"text":" 첫 안건은 유입 원장."},
            {"offsets":{"from":9000,"to":9500},"text":"   "},
            {"bogus": true}
        ]}"#;
        let segs = parse_whisper_json(raw);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].from_ms, 0);
        assert_eq!(segs[1].text, "첫 안건은 유입 원장.");
        assert!(parse_whisper_json("not json").is_empty());
        assert!(parse_whisper_json("{}").is_empty());
    }

    #[test]
    fn timestamped_blocks_break_on_silence_and_length() {
        let seg = |from: u64, to: u64, text: &str| Segment {
            from_ms: from,
            to_ms: to,
            text: text.into(),
        };
        let out = format_timestamped(&[
            seg(0, 3_000, "하나"),
            seg(3_200, 6_000, "둘"),     // continues (gap < 2s)
            seg(9_000, 12_000, "셋"),    // 3s silence → new block
            seg(12_000, 80_000, "넷"),   // joining would span >60s → own block
            seg(80_500, 81_000, "다섯"), // ditto (previous block already 68s)
        ]);
        let blocks: Vec<&str> = out.split("\n\n").collect();
        assert_eq!(blocks.len(), 4, "{out}");
        assert!(blocks[0].starts_with("[00:00:00] 하나 둘"));
        assert!(blocks[1].starts_with("[00:00:09] 셋"));
        assert!(blocks[2].starts_with("[00:00:12] 넷"));
        assert!(blocks[3].starts_with("[00:01:20] 다섯"));
    }

    #[test]
    fn progress_lines_parse_and_noise_does_not() {
        assert_eq!(
            parse_progress_line("whisper_print_progress_callback: progress =   5%"),
            Some(5)
        );
        assert_eq!(
            parse_progress_line("whisper_print_progress_callback: progress = 100%"),
            Some(100)
        );
        assert_eq!(
            parse_progress_line("whisper_init_from_file_with_params"),
            None
        );
        assert_eq!(parse_progress_line("[00:00:14.320] 안녕하세요"), None);
    }

    #[test]
    fn timeout_scales_with_audio_but_never_below_the_floor() {
        // A 30s voice memo (16 kHz mono ≈ 0.96 MB) keeps the 900s floor.
        assert_eq!(transcribe_timeout(960_000), Duration::from_secs(900));
        // An hour of 16 kHz mono WAV (~115 MB) gets ~6h — the fixed 900s
        // used to kill exactly this case.
        assert_eq!(
            transcribe_timeout(115_200_000),
            Duration::from_secs(3600 * 6)
        );
    }

    #[test]
    fn sidecar_native_formats_skip_conversion_and_m4a_does_not() {
        assert!(sidecar_reads_natively(Path::new("/a/clip.WAV")));
        assert!(sidecar_reads_natively(Path::new("/a/clip.mp3")));
        assert!(!sidecar_reads_natively(Path::new("/a/meeting.m4a")));
        assert!(!sidecar_reads_natively(Path::new("/a/screen.mov")));
        assert!(!sidecar_reads_natively(Path::new("/a/noext")));
    }
}
