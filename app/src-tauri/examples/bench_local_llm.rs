//! Measurement harness for the embedded model (bundled Gemma 3 1B GGUF).
//!
//! Run: `cargo run --example bench_local_llm --release`
//!
//! Deliberately an example rather than a Criterion bench, for two reasons that
//! are properties of what is being measured, not of taste:
//!
//!   - `LlamaBackend::init()` refuses a second call in a process, so `LocalLlm`
//!     can be loaded exactly once. Criterion's whole model is "run this N
//!     times", which the load simply cannot do.
//!   - Metal timings need a fixed protocol — discard the first run, then report
//!     median and p95 over warm state. Criterion reports mean with confidence
//!     intervals over its own warmup schedule, which is the wrong summary for a
//!     latency budget and cannot express "throw the cold run away".
//!
//! It also requires the 769 MB GGUF, which `cargo bench` in CI must not. Being
//! an example keeps it explicitly opt-in, alongside `test_local_llm.rs`.
//!
//! Do not read absolute numbers across machines; read the shape. FLOP-count
//! reasoning in particular does not predict these — the paths are bound by
//! memory bandwidth, not arithmetic.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use memex_lib::local_llm::LocalLlm;

/// Warm-state runs kept per measurement, after the discarded first one.
const RUNS: usize = 5;

/// Resident set size in MB, via `ps`. Coarse and platform-shelling, but the
/// number that matters here is "how much RAM does loading this cost" at a
/// hundreds-of-MB scale, where coarse is fine.
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
    let p95_idx = (((n as f64) * 0.95).ceil() as usize).saturating_sub(1).min(n - 1);
    Stats {
        median: samples[n / 2],
        p95: samples[p95_idx],
        min: samples[0],
        max: samples[n - 1],
    }
}

/// Run `f` once to warm Metal and fill caches, discard it, then measure `RUNS`
/// more. Returns the warm-state summary.
fn measure(label: &str, mut f: impl FnMut()) {
    f(); // discarded: first run pays shader compilation and page-ins
    let mut samples = Vec::with_capacity(RUNS);
    for _ in 0..RUNS {
        let t = Instant::now();
        f();
        samples.push(t.elapsed());
    }
    let s = summarize(samples);
    println!(
        "  {label:<34} median {:>8.1} ms   p95 {:>8.1} ms   [min {:.1} / max {:.1}]",
        s.median.as_secs_f64() * 1e3,
        s.p95.as_secs_f64() * 1e3,
        s.min.as_secs_f64() * 1e3,
        s.max.as_secs_f64() * 1e3,
    );
}

/// Filler text tokenizing to as close to `target` as the unit allows. Returns
/// the prompt and the token count it actually reached — a label of "512 tok"
/// over a prompt that is really 1,154 is just a wrong measurement, so the count
/// is measured and reported rather than assumed.
///
/// Grows to bracket the target, then trims unit by unit; doubling alone
/// overshot by up to 2.2x.
fn prompt_of_tokens(llm: &LocalLlm, target: usize) -> (String, usize) {
    // Mixed script: real vault context is not pure ASCII, and tokens-per-byte
    // differs by several times between Latin and Hangul.
    const UNIT: &str = "지식 그래프는 노트 사이의 연결을 보여준다. A wiki links notes together. ";
    let per_unit = llm.token_count(UNIT).expect("tokenize").max(1);
    let mut reps = (target / per_unit).max(1);
    // Overshoot, then walk back to the last rep count still under target.
    while llm.token_count(&UNIT.repeat(reps)).expect("tokenize") < target {
        reps += 1;
    }
    let text = UNIT.repeat(reps);
    let n = llm.token_count(&text).expect("tokenize");
    (text, n)
}

fn main() {
    let model_path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("models/gemma-3-1b-it-q4_k_m.gguf");
    let size_mb = std::fs::metadata(&model_path).map(|m| m.len() as f64 / 1e6).unwrap_or(f64::NAN);
    println!("model: {} ({size_mb:.0} MB)", model_path.display());

    // ---- cold load ---------------------------------------------------------
    // One shot only: LlamaBackend::init() cannot run twice in a process, so
    // there is no second load to average with. The number also depends on the
    // OS page cache — the first load after boot is far slower than one right
    // after another process read the same file.
    let rss_before = rss_mb();
    let t0 = Instant::now();
    let llm = LocalLlm::load(&model_path).expect("load bundled model");
    let load = t0.elapsed();
    let rss_after = rss_mb();
    println!("\nload (single shot, page-cache dependent)");
    println!(
        "  cold_load                          {:>8.1} ms   RSS {:.0} -> {:.0} MB (+{:.0})",
        load.as_secs_f64() * 1e3,
        rss_before,
        rss_after,
        rss_after - rss_before,
    );

    // ---- per-call floor ----------------------------------------------------
    // Every generate builds a fresh context off the shared model. The smallest
    // possible call isolates that fixed cost about as well as the public API
    // allows: it is context allocation plus one token, and it is the floor
    // under every local_query the app makes.
    println!("\nper-call floor (fresh context + 1 token)");
    measure("context_alloc_plus_1tok", || {
        llm.generate("Hi", 1).expect("generate");
    });

    // ---- prefill -----------------------------------------------------------
    // Prompt processing, measured as generate(prompt, max_tokens=1) so exactly
    // one decode rides along. The context window is 4096 and run_prompt reserves
    // max_tokens + 8, so ~4000 is the largest prompt that survives untruncated —
    // asking for 4090 would silently drop tokens from the front and measure a
    // shorter prefill than the label claimed.
    println!("\nprefill (includes fresh context + 1 decoded token)");
    // run_prompt keeps the tail and drops the front when a prompt exceeds
    // CTX_TOKENS - max_tokens - 8. Past that the label would describe a prompt
    // the model never saw: an early draft of this harness asked for 2048 and
    // 4000, overshot to 4610 and 9002, and reported two identical times because
    // both had been cut to the same 4087.
    const PREFILL_BUDGET: usize = 4096 - 1 - 8;
    for target in [128usize, 512, 2048, 4000] {
        let (prompt, actual) = prompt_of_tokens(&llm, target);
        assert!(
            actual <= PREFILL_BUDGET,
            "prompt of {actual} tok would be truncated to {PREFILL_BUDGET}; \
             the measurement would not be what the label says"
        );
        measure(&format!("prefill_{actual}tok"), || {
            llm.generate(&prompt, 1).expect("generate");
        });
    }

    // ---- generate ----------------------------------------------------------
    // TTFT vs total, decomposed rather than instrumented: the decode loop has no
    // per-token callback yet, so time-to-first-token is measured as the same
    // prompt capped at one token. Subtracting gives the marginal cost of the
    // remaining tokens, which is what a streaming UI would hide.
    //
    // Read total_max_tokens_* as "a whole realistic answer", not as "N tokens
    // decoded": the model emits EOG long before either cap, which is why 64 and
    // 320 land within noise of each other. The marginal cost per generated token
    // is (total - ttft) / tokens actually produced, and it is small — the caps
    // are there to show the cap is not what ends the run.
    println!("\ngenerate (512-token prompt)");
    let (prompt, ntok) = prompt_of_tokens(&llm, 512);
    let question = format!("{prompt}\n\n한 문장으로: 위키의 장점은?");
    println!("  (prompt {ntok} tok + question)");
    measure("ttft_proxy_max_tokens_1", || {
        llm.generate(&question, 1).expect("generate");
    });
    for cap in [64i32, 320] {
        measure(&format!("total_max_tokens_{cap}"), || {
            llm.generate(&question, cap).expect("generate");
        });
    }

    // ---- embed -------------------------------------------------------------
    // embed() builds one context per text, so a "batch" is not batched at all —
    // it is a loop. This is here to show whether that is costing anything: if
    // batch-of-8 is ~8x one, there is no batching to lose.
    println!("\nembed (one context per text — a 'batch' is a loop)");
    let (chunk, chunk_tok) = prompt_of_tokens(&llm, 400); // ~a real 1800-char chunk
    println!("  (chunk {chunk_tok} tok)");
    let one = vec![chunk.clone()];
    measure("embed_1", || {
        llm.embed(&one).expect("embed");
    });
    let eight: Vec<String> = (0..8).map(|i| format!("{i} {chunk}")).collect();
    measure("embed_8", || {
        llm.embed(&eight).expect("embed");
    });

    println!("\nRSS at exit: {:.0} MB", rss_mb());
}
