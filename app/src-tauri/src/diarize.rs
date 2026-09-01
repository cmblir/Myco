//! Speaker diarization sidecar — WHO said it, to pair with whisper's WHAT.
//!
//! whisper transcribes text but discards the voice; telling 화자 1 from
//! 화자 2 needs two acoustic models (2026-08-31 spike, verified live on a
//! two-voice synthetic meeting): pyannote-segmentation-3.0 finds
//! speaker-change boundaries, a 3D-Speaker eres2net embedding model
//! fingerprints each stretch so stretches cluster into speakers. Both are
//! language-independent — they never look at words — which is exactly why
//! this route works for Korean meetings where whisper's own tinydiarize
//! (English-only small.en-tdrz) cannot.
//!
//! Everything is fetched on first use into the settings dir (the whisper
//! model's own pattern — the user installs nothing): the sherpa-onnx CLI
//! archive for this arch (~18-21 MB, Apache-2.0, extracted bin/+lib/), the
//! segmentation model tar (~6.6 MB, MIT) and the embedding model (~38 MB,
//! Apache-2.0). Diarization is strictly best-effort: any failure here
//! degrades a meeting transcript to timestamps-only, never to an error.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use tauri::Emitter as _;

use crate::claude::run_with_timeout;

const SHERPA_VERSION: &str = "1.13.7";
/// Exact published sizes, verified 2026-09-01 — a download is only accepted
/// at the advertised byte count (the whisper model's .part discipline).
#[cfg(target_arch = "aarch64")]
const BIN_TAR: (&str, u64) = (
    "sherpa-onnx-v1.13.7-osx-arm64-shared-no-tts.tar.bz2",
    18_192_670,
);
#[cfg(target_arch = "x86_64")]
const BIN_TAR: (&str, u64) = (
    "sherpa-onnx-v1.13.7-osx-x64-shared-no-tts.tar.bz2",
    20_553_619,
);
const SEG_TAR: (&str, u64) = ("sherpa-onnx-pyannote-segmentation-3-0.tar.bz2", 6_958_444);
const EMB_ONNX: (&str, u64) = (
    "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx",
    39_593_761,
);

/// Emitted while any diarization asset downloads: `{name, downloaded, total, pct}`.
pub const DIARIZE_PROGRESS_EVENT: &str = "diarize-model-progress";

/// Diarization can double a long transcription's wall time (RTF ~0.6 on one
/// thread; threads below cut that) — its own generous ceiling.
const RUN_TIMEOUT_SECS: u64 = 3 * 3600;

/// One speaker turn from the CLI's stdout (`0.031 -- 8.553 speaker_00`).
#[derive(Debug, Clone, PartialEq)]
pub struct Turn {
    pub from_ms: u64,
    pub to_ms: u64,
    pub speaker: u32,
}

fn assets_dir() -> Result<PathBuf, String> {
    Ok(crate::settings::settings_dir()?.join("diarize"))
}

fn bin_path(dir: &Path) -> PathBuf {
    dir.join(format!(
        "sherpa-onnx-v{SHERPA_VERSION}-osx-{}-shared-no-tts",
        if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        }
    ))
    .join("bin/sherpa-onnx-offline-speaker-diarization")
}

fn seg_path(dir: &Path) -> PathBuf {
    // int8 quantization: a quarter the size, and segmentation boundaries are
    // not precision-sensitive at our block granularity.
    dir.join("sherpa-onnx-pyannote-segmentation-3-0/model.int8.onnx")
}

fn emb_path(dir: &Path) -> PathBuf {
    dir.join(EMB_ONNX.0)
}

/// Whether every asset is already on disk (no downloads would run).
pub fn assets_ready() -> bool {
    assets_dir()
        .map(|d| bin_path(&d).is_file() && seg_path(&d).is_file() && emb_path(&d).is_file())
        .unwrap_or(false)
}

/// Download `url` to `dest` with the `.part` + verify-size + rename
/// discipline, emitting progress under `name`.
fn fetch(
    app: &tauri::AppHandle,
    url: &str,
    dest: &Path,
    name: &str,
    bytes: u64,
) -> Result<(), String> {
    if dest.exists() && std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0) == bytes {
        return Ok(());
    }
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("mkdir: {e}"))?;
    }
    let part = dest.with_extension("part");
    let app2 = app.clone();
    let part2 = part.clone();
    let url2 = url.to_string();
    let name2 = name.to_string();
    tauri::async_runtime::block_on(async move {
        use futures_util::StreamExt as _;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(3600))
            .build()
            .map_err(|e| format!("http client: {e}"))?;
        let resp = client
            .get(&url2)
            .send()
            .await
            .map_err(|e| format!("diarize asset request: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("diarize asset status {}", resp.status()));
        }
        let total = resp.content_length().unwrap_or(bytes);
        let mut file = std::fs::File::create(&part2).map_err(|e| format!("create: {e}"))?;
        let mut stream = resp.bytes_stream();
        let mut downloaded: u64 = 0;
        let mut last_pct: u64 = 0;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("diarize asset read: {e}"))?;
            std::io::Write::write_all(&mut file, &chunk).map_err(|e| format!("write: {e}"))?;
            downloaded += chunk.len() as u64;
            let pct = downloaded * 100 / total.max(1);
            if pct >= last_pct + 5 || downloaded == total {
                last_pct = pct;
                let _ = app2.emit(
                    DIARIZE_PROGRESS_EVENT,
                    serde_json::json!({
                        "name": name2, "downloaded": downloaded, "total": total, "pct": pct
                    }),
                );
            }
        }
        Ok(())
    })
    .inspect_err(|_| {
        let _ = std::fs::remove_file(&part);
    })?;
    let got = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if got != bytes {
        let _ = std::fs::remove_file(&part);
        return Err(format!("diarize asset incomplete ({got} of {bytes} bytes)"));
    }
    std::fs::rename(&part, dest).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

/// Extract a `.tar.bz2` with the OS's own tar (bzip2 built in on macOS) —
/// the same no-new-dependencies rule as afconvert.
fn untar(archive: &Path, into: &Path) -> Result<(), String> {
    let out = Command::new("/usr/bin/tar")
        .args([
            "xjf",
            &archive.to_string_lossy(),
            "-C",
            &into.to_string_lossy(),
        ])
        .output()
        .map_err(|e| format!("tar spawn: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "tar failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

/// Make sure binary + both models exist, fetching what is missing.
fn ensure_assets(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let dir = assets_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir diarize: {e}"))?;

    let bin = bin_path(&dir);
    if !bin.is_file() {
        let tar = dir.join(BIN_TAR.0);
        fetch(
            app,
            &format!(
                "https://github.com/k2-fsa/sherpa-onnx/releases/download/v{SHERPA_VERSION}/{}",
                BIN_TAR.0
            ),
            &tar,
            "sherpa-onnx",
            BIN_TAR.1,
        )?;
        untar(&tar, &dir)?;
        let _ = std::fs::remove_file(&tar);
        if !bin.is_file() {
            return Err("sherpa-onnx archive did not contain the diarization binary".into());
        }
    }

    let seg = seg_path(&dir);
    if !seg.is_file() {
        let tar = dir.join(SEG_TAR.0);
        fetch(
            app,
            &format!(
                "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/{}",
                SEG_TAR.0
            ),
            &tar,
            "segmentation",
            SEG_TAR.1,
        )?;
        untar(&tar, &dir)?;
        let _ = std::fs::remove_file(&tar);
        if !seg.is_file() {
            return Err("segmentation archive did not contain model.int8.onnx".into());
        }
    }

    let emb = emb_path(&dir);
    // NB: "recongition" is the release tag's own long-standing typo.
    fetch(
        app,
        &format!(
            "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/{}",
            EMB_ONNX.0
        ),
        &emb,
        "embedding",
        EMB_ONNX.1,
    )?;

    Ok((bin, seg, emb))
}

/// Parse the CLI's stdout: `<from-secs> -- <to-secs> speaker_<NN>` lines,
/// anything else ignored.
pub fn parse_turns(stdout: &str) -> Vec<Turn> {
    stdout
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let from: f64 = parts.next()?.parse().ok()?;
            if parts.next()? != "--" {
                return None;
            }
            let to: f64 = parts.next()?.parse().ok()?;
            let speaker = parts.next()?.strip_prefix("speaker_")?.parse().ok()?;
            Some(Turn {
                from_ms: (from * 1000.0) as u64,
                to_ms: (to * 1000.0) as u64,
                speaker,
            })
        })
        .collect()
}

/// The speaker whose turn best overlaps `[from, to)`; None when nothing does
/// (silence-adjacent whisper hallucinations land here and stay unlabeled).
pub fn speaker_at(turns: &[Turn], from_ms: u64, to_ms: u64) -> Option<u32> {
    let mut best: Option<(u64, u32)> = None;
    for t in turns {
        let overlap = t.to_ms.min(to_ms).saturating_sub(t.from_ms.max(from_ms));
        if overlap > 0 && best.map(|(o, _)| overlap > o).unwrap_or(true) {
            best = Some((overlap, t.speaker));
        }
    }
    best.map(|(_, s)| s)
}

/// Run diarization on a 16 kHz mono WAV. Slow-but-bounded: thread count set
/// to a sane 4, and the caller treats any Err as "timestamps only".
pub fn diarize(app: &tauri::AppHandle, wav: &str) -> Result<Vec<Turn>, String> {
    let (bin, seg, emb) = ensure_assets(app)?;
    let child = Command::new(&bin)
        .args([
            &format!("--segmentation.pyannote-model={}", seg.to_string_lossy()),
            &format!("--embedding.model={}", emb.to_string_lossy()),
            "--segmentation.num-threads=4",
            "--embedding.num-threads=4",
            wav,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn diarizer: {e}"))?;
    let res = run_with_timeout(
        child,
        Vec::new(),
        Duration::from_secs(RUN_TIMEOUT_SECS),
        "diarize",
    )?;
    if res.status != 0 {
        return Err(format!(
            "diarizer exit {}: {}",
            res.status,
            res.stderr.trim()
        ));
    }
    let turns = parse_turns(&res.stdout);
    if turns.is_empty() {
        return Err("diarizer produced no speaker turns".into());
    }
    Ok(turns)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stdout_turns_parse_and_noise_is_ignored() {
        let out = "OfflineSpeakerDiarizationConfig(...)\nStarted\n\
                   0.031 -- 8.553 speaker_00\n\
                   8.553 -- 13.126 speaker_01\n\
                   garbage line\n\
                   13.126 -- 18.442 speaker_00\n";
        let turns = parse_turns(out);
        assert_eq!(turns.len(), 3);
        assert_eq!(
            turns[0],
            Turn {
                from_ms: 31,
                to_ms: 8553,
                speaker: 0
            }
        );
        assert_eq!(turns[1].speaker, 1);
    }

    #[test]
    fn speaker_lookup_picks_max_overlap_and_none_outside() {
        let turns = vec![
            Turn {
                from_ms: 0,
                to_ms: 8000,
                speaker: 0,
            },
            Turn {
                from_ms: 8000,
                to_ms: 13000,
                speaker: 1,
            },
        ];
        assert_eq!(speaker_at(&turns, 1000, 3000), Some(0));
        // Straddles the boundary but sits mostly in the second turn.
        assert_eq!(speaker_at(&turns, 7500, 12000), Some(1));
        assert_eq!(speaker_at(&turns, 20000, 21000), None);
    }
}
