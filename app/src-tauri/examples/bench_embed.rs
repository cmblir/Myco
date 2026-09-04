//! Measurement harness for the bundled embedder (multilingual-e5-small-ko-v2,
//! 39.7 MB Q8_0, spec id `e5-small-ko`).
//!
//! Run: `cargo run --release --example bench_embed`
//! Model: `MYCO_EMBED_MODEL=/path/to.gguf`, else the app bundle's copy.
//!
//! Same protocol and the same reasons as `bench_local_llm.rs`: an example
//! rather than a Criterion bench because `LlamaBackend::init()` is
//! once-per-process, and because the honest summary of a Metal latency is
//! "discard the cold run, then median and p95 over warm state".
//!
//! What this exists to answer: `commands::MAX_PAGE_CHUNKS` and
//! `index_updater::LONG_PAGE_DEBOUNCE` were both picked by arithmetic off the
//! old Gemma embedder's cost. This measures the real per-chunk cost of the
//! model actually shipping.
//!
//! Do not read absolute numbers across machines; read the shape.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use myco_lib::local_llm::{embed_spec_by_id, EmbedRole, LocalLlm, BUILTIN_EMBED_MODEL};

/// Warm-state runs kept per measurement, after the discarded first one.
const RUNS: usize = 5;

/// Same cap `commands::MAX_PAGE_CHUNKS` applies to one page.
const PAGE_CHUNKS: usize = 200;

/// Resident set size in MB, via `ps` — same coarse measure as bench_local_llm.
fn rss_mb() -> f64 {
    let pid = std::process::id();
    std::process::Command::new("ps")
        .args(["-o", "rss=", "-p", &pid.to_string()])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.trim().parse::<f64>().ok())
        .map(|kb| kb / 1024.0)
        .unwrap_or(f64::NAN)
}

struct Stats {
    median: Duration,
    p95: Duration,
    min: Duration,
    max: Duration,
}

fn summarize(mut samples: Vec<Duration>) -> Stats {
    samples.sort_unstable();
    let n = samples.len();
    // Nearest-rank p95: with 5 samples this is the slowest, which is the honest
    // answer at this sample count rather than an interpolated invention.
    let p95_idx = (((n as f64) * 0.95).ceil() as usize)
        .saturating_sub(1)
        .min(n - 1);
    Stats {
        median: samples[n / 2],
        p95: samples[p95_idx],
        min: samples[0],
        max: samples[n - 1],
    }
}

/// Discard one run, measure `RUNS` more, print total and per-chunk cost.
fn measure(label: &str, chunks: usize, mut f: impl FnMut()) {
    f(); // discarded: first run pays shader compilation and page-ins
    let mut samples = Vec::with_capacity(RUNS);
    for _ in 0..RUNS {
        let t = Instant::now();
        f();
        samples.push(t.elapsed());
    }
    let s = summarize(samples);
    let ms = |d: Duration| d.as_secs_f64() * 1e3;
    println!(
        "  {label:<26} median {:>9.1} ms ({:>6.1} ms/chunk)   p95 {:>9.1} ms   [min {:.1} / max {:.1}]",
        ms(s.median),
        ms(s.median) / chunks as f64,
        ms(s.p95),
        ms(s.min),
        ms(s.max),
    );
}

/// A real session log's chunks if one is readable, else synthetic prose of the
/// same shape. Returns the chunks and where they came from.
fn page_chunks() -> (Vec<String>, String) {
    let sessions =
        PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Documents/Memex/sessions");
    // Biggest .md two levels down (sessions/<month>/<file>.md) — the transcripts
    // MAX_PAGE_CHUNKS exists for.
    let biggest = std::fs::read_dir(&sessions)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|month| std::fs::read_dir(month.path()).ok())
        .flatten()
        .flatten()
        .filter(|f| f.path().extension().is_some_and(|e| e == "md"))
        .filter_map(|f| f.metadata().ok().map(|m| (m.len(), f.path())))
        .max_by_key(|(len, _)| *len);
    if let Some((len, path)) = biggest {
        if let Ok(text) = std::fs::read_to_string(&path) {
            let chunks = myco_lib::embeddings::chunk_page(&text);
            let src = format!(
                "{} ({} KB, {} chunks)",
                path.display(),
                len / 1024,
                chunks.len()
            );
            return (chunks, src);
        }
    }
    // Fallback: mixed-script prose, one paragraph per would-be chunk. Latin and
    // Hangul differ several times over in tokens per byte, so a pure-ASCII
    // filler would measure the wrong sequence length.
    const UNIT: &str = "지식 그래프는 노트 사이의 연결을 보여준다. A wiki links notes together. \
                        세션 로그는 계속 덧붙여진다, and each append re-chunks the tail. ";
    let text: String = (0..PAGE_CHUNKS)
        .map(|i| format!("## section {i}\n\n{}\n\n", UNIT.repeat(12)))
        .collect();
    let chunks = myco_lib::embeddings::chunk_page(&text);
    let src = format!("synthetic ({} chunks)", chunks.len());
    (chunks, src)
}

fn main() {
    let model_path = std::env::var("MYCO_EMBED_MODEL")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(
                "/Applications/myco.app/Contents/Resources/models/multilingual-e5-small-ko-v2-q8_0.gguf",
            )
        });
    if !model_path.exists() {
        println!(
            "embed model not found at {}\nset MYCO_EMBED_MODEL=/path/to/multilingual-e5-small-ko-v2-q8_0.gguf",
            model_path.display()
        );
        return;
    }
    let size_mb = std::fs::metadata(&model_path)
        .map(|m| m.len() as f64 / 1e6)
        .unwrap_or(f64::NAN);
    let spec = embed_spec_by_id(BUILTIN_EMBED_MODEL).expect("bundled spec exists");
    println!(
        "model: {} ({size_mb:.1} MB, spec {}, max_ctx {})",
        model_path.display(),
        spec.id,
        spec.max_ctx
    );

    // ---- load --------------------------------------------------------------
    // Single shot: the backend initializes once per process, and the number is
    // page-cache dependent anyway.
    let rss_before = rss_mb();
    let t0 = Instant::now();
    let mut llm = LocalLlm::load_embed_host().expect("embed host");
    llm.load_embed_model(&model_path).expect("load embed model");
    let load = t0.elapsed();
    let rss_after = rss_mb();
    println!("\nload (single shot, page-cache dependent)");
    println!(
        "  cold_load                  {:>9.1} ms   RSS {:.0} -> {:.0} MB (+{:.0})",
        load.as_secs_f64() * 1e3,
        rss_before,
        rss_after,
        rss_after - rss_before,
    );

    let (chunks, src) = page_chunks();
    assert!(!chunks.is_empty(), "no chunks to embed");
    println!("\npage: {src}");

    // ---- batch sizes -------------------------------------------------------
    // One context serves a whole call (see `embed_pooled_with`), so batch size
    // is where any amortization shows up.
    println!("\nembed batches (EmbedRole::Document)");
    for n in [1usize, 8, 32, PAGE_CHUNKS] {
        let texts: Vec<String> = chunks.iter().cycle().take(n).cloned().collect();
        measure(&format!("embed_{n}"), n, || {
            llm.embed_spec(spec, EmbedRole::Document, &texts)
                .expect("embed");
        });
    }

    println!("\nRSS at exit: {:.0} MB", rss_mb());
}
