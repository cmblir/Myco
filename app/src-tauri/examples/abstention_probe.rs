// Abstention-threshold probe (throwaway measurement, NOT wired into CI).
//
// Goal: gather the raw data needed to pick a dense-cosine floor below which
// the app's semantic retrieval should abstain ("no confident match") rather
// than show a passage. Corpus/model setup is copied verbatim from
// `retrieval_eval.rs` (model loading, corpus assembly, chunking, index
// building, query-label parsing) so the measured index is identical to what
// that harness evaluates.
//
// Positives: the eval/retrieval-queries.json labeled queries, dense-searched
// against the same index; we record the TRUE cosine straight from
// `VectorStore::search` (`Hit.score`), before any RRF fusion touches it.
//
// Negatives: a hand-authored set of off-corpus queries (everyday topics +
// other technical domains, English + Korean) that have no business matching
// this LLM/ML wiki corpus. Their top-1 cosine is the "pure noise" floor.
//
// Run:
//   cd app/src-tauri && MYCO_EMBED_SPEC=bge-m3 cargo run --release --example abstention_probe

use std::collections::HashSet;
use std::path::PathBuf;

use myco_lib::{
    embeddings,
    local_llm::{apply_prefix, embed_spec_by_id, EmbedRole, LocalLlm},
    sample_vault,
    vector_index::VectorStore,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct EvalSet {
    queries: Vec<Labeled>,
}
#[derive(Deserialize)]
struct Labeled {
    q: String,
    relevant: Vec<String>,
}

/// Off-corpus negative queries: everyday non-technical topics and other
/// (non-LLM) technical domains, English + Korean. None of these concepts
/// appear in the corpus, which is confined to LLM/ML wiki pages (attention,
/// tokenization, RLHF, RAG, embeddings, transformer internals, AI companies
/// and products, etc. — see `sample_vault::SAMPLE_NOTES` + `eval/ko-corpus/`).
const NEGATIVES: &[&str] = &[
    "김치찌개 레시피 알려줘",
    "내일 서울 날씨",
    "how do I rotate AWS IAM keys",
    "손흥민 어제 경기 결과",
    "best espresso grind size",
    "화물 운송장 번호 조회",
    "convert MP4 to GIF ffmpeg flags",
    "how to change a flat tire",
    "제주도 3박4일 여행 코스 추천",
    "postgresql index bloat vacuum tuning",
    "강아지 슬개골 탈구 수술 비용",
    "how to fix a leaking kitchen faucet",
    "연말정산 소득공제 항목 정리",
    "what's the offside rule in soccer",
    "docker compose healthcheck retries syntax",
];

const FLOORS: [f32; 9] = [0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70];

/// Nearest-rank percentile over an already-sorted-ascending slice.
fn percentile(sorted: &[f32], p: f64) -> f32 {
    if sorted.is_empty() {
        return f32::NAN;
    }
    let idx = ((p * (sorted.len() - 1) as f64).round() as usize).min(sorted.len() - 1);
    sorted[idx]
}

fn summarize(label: &str, values: &[f32]) {
    let mut v = values.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    if v.is_empty() {
        println!("  {label}: n=0");
        return;
    }
    println!(
        "  {:<28} n={:<3} min={:.3}  p10={:.3}  median={:.3}  p90={:.3}  max={:.3}",
        label,
        v.len(),
        v[0],
        percentile(&v, 0.10),
        percentile(&v, 0.50),
        percentile(&v, 0.90),
        v[v.len() - 1],
    );
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let head: String = s.chars().take(n).collect();
        format!("{head}…")
    }
}

fn main() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // MYCO_EMBED_SPEC selects which embed model the harness measures. This
    // probe is meaningless without bge-m3 (the only GGUF present in
    // models/), but the branch is kept so the setup matches retrieval_eval.rs
    // verbatim.
    let spec_id = std::env::var("MYCO_EMBED_SPEC").unwrap_or_else(|_| "gemma".into());
    let model_path = if spec_id == "gemma" {
        manifest.join("models/gemma-3-1b-it-q4_k_m.gguf")
    } else {
        let spec = embed_spec_by_id(&spec_id).expect("known spec");
        manifest.join(spec.file)
    };
    let eval_path = manifest.join("eval/retrieval-queries.json");

    let set: EvalSet =
        serde_json::from_str(&std::fs::read_to_string(&eval_path).expect("read eval set"))
            .expect("parse eval set");

    eprintln!("loading model {} (spec: {spec_id}) …", model_path.display());
    let llm = LocalLlm::load(&model_path).expect("load model");

    let doc_vecs = |llm: &LocalLlm, chunks: &[String]| -> Vec<Vec<f32>> {
        if spec_id == "gemma" {
            llm.embed(chunks).expect("embed page")
        } else {
            let spec = embed_spec_by_id(&spec_id).expect("known spec");
            let prefixed = apply_prefix(spec, EmbedRole::Document, chunks);
            llm.embed_pooled(&prefixed, spec.pooling, spec.max_ctx)
                .expect("embed page")
        }
    };
    let query_vec = |llm: &LocalLlm, q: &str| -> Vec<f32> {
        if spec_id == "gemma" {
            llm.embed(&[q.to_string()])
                .expect("embed query")
                .pop()
                .unwrap()
        } else {
            let spec = embed_spec_by_id(&spec_id).expect("known spec");
            let prefixed = apply_prefix(spec, EmbedRole::Query, &[q.to_string()]);
            llm.embed_pooled(&prefixed, spec.pooling, spec.max_ctx)
                .expect("embed query")
                .pop()
                .unwrap()
        }
    };

    // Build the same in-memory index as retrieval_eval.rs (English sample
    // vault + Korean parallel corpus), tracking chunk character lengths as we
    // go for the passage-bloat report.
    let mut store = VectorStore::default();
    let mut pages = 0usize;
    let mut chunks_total = 0usize;
    let mut chunk_lens: Vec<f32> = Vec::new();

    for (path, content) in sample_vault::SAMPLE_NOTES {
        if !path.starts_with("wiki/") {
            continue;
        }
        let rel = path.to_string();
        let stem = path
            .trim_start_matches("wiki/")
            .trim_end_matches(".md")
            .to_string();
        let chunks = embeddings::chunk_page(content);
        if chunks.is_empty() {
            continue;
        }
        let hashes: Vec<u64> = chunks.iter().map(|c| embeddings::content_hash(c)).collect();
        let vecs = doc_vecs(&llm, &chunks);
        for c in &chunks {
            chunk_lens.push(c.chars().count() as f32);
        }
        chunks_total += chunks.len();
        pages += 1;
        let entries: Vec<(u64, Vec<f32>)> = hashes.into_iter().zip(vecs).collect();
        store.upsert_page(&rel, &stem, entries);
        eprint!("\rindexed {pages} pages / {chunks_total} chunks");
    }

    let ko_dir = manifest.join("eval/ko-corpus");
    if ko_dir.is_dir() {
        let mut ko_files: Vec<PathBuf> = std::fs::read_dir(&ko_dir)
            .expect("read ko-corpus dir")
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().map(|x| x == "md").unwrap_or(false))
            .collect();
        ko_files.sort();
        for path in ko_files {
            let content = std::fs::read_to_string(&path).expect("read ko page");
            let stem = path.file_stem().unwrap().to_string_lossy().to_string();
            let rel = format!("ko-corpus/{stem}.md");
            let chunks = embeddings::chunk_page(&content);
            if chunks.is_empty() {
                continue;
            }
            let hashes: Vec<u64> = chunks.iter().map(|c| embeddings::content_hash(c)).collect();
            let vecs = doc_vecs(&llm, &chunks);
            for c in &chunks {
                chunk_lens.push(c.chars().count() as f32);
            }
            chunks_total += chunks.len();
            pages += 1;
            let entries: Vec<(u64, Vec<f32>)> = hashes.into_iter().zip(vecs).collect();
            store.upsert_page(&rel, &stem, entries);
            eprint!("\rindexed {pages} pages / {chunks_total} chunks");
        }
    }

    eprintln!(
        "\nindexed {pages} pages, {chunks_total} chunks. probing {} labeled queries + {} negatives…\n",
        set.queries.len(),
        NEGATIVES.len()
    );

    // ---- Positives: labeled queries, raw dense cosine straight from search() ----
    struct PosResult {
        q: String,
        top1_cosine: f32,
        correct: bool,
        rank5_cosine: f32,
    }
    let mut pos: Vec<PosResult> = Vec::with_capacity(set.queries.len());
    for lab in &set.queries {
        let qvec = query_vec(&llm, &lab.q);
        let hits = store.search(&qvec, 10); // raw cosine, pre-fusion
        let relevant: HashSet<&str> = lab.relevant.iter().map(String::as_str).collect();
        let top1_cosine = hits.first().map(|h| h.score).unwrap_or(f32::NAN);
        let correct = hits
            .first()
            .map(|h| relevant.contains(h.stem.as_str()))
            .unwrap_or(false);
        let rank5_cosine = if hits.is_empty() {
            f32::NAN
        } else {
            hits[hits.len().min(5) - 1].score
        };
        pos.push(PosResult {
            q: lab.q.clone(),
            top1_cosine,
            correct,
            rank5_cosine,
        });
    }

    // ---- Negatives: off-corpus queries, top-1 dense cosine ----
    struct NegResult {
        q: String,
        top1_cosine: f32,
    }
    let mut neg: Vec<NegResult> = Vec::with_capacity(NEGATIVES.len());
    for q in NEGATIVES {
        let qvec = query_vec(&llm, q);
        let hits = store.search(&qvec, 1);
        let top1_cosine = hits.first().map(|h| h.score).unwrap_or(f32::NAN);
        neg.push(NegResult {
            q: q.to_string(),
            top1_cosine,
        });
    }

    let correct_cos: Vec<f32> = pos
        .iter()
        .filter(|p| p.correct)
        .map(|p| p.top1_cosine)
        .collect();
    let wrong_cos: Vec<f32> = pos
        .iter()
        .filter(|p| !p.correct)
        .map(|p| p.top1_cosine)
        .collect();
    let neg_cos: Vec<f32> = neg.iter().map(|n| n.top1_cosine).collect();
    let rank5_correct: Vec<f32> = pos
        .iter()
        .filter(|p| p.correct)
        .map(|p| p.rank5_cosine)
        .collect();

    println!("═══════════════════════════════════════════════════");
    println!(" Abstention probe — dense cosine ({spec_id})");
    println!("═══════════════════════════════════════════════════");
    println!(" corpus: {pages} wiki pages · {chunks_total} chunks");
    println!(
        " positives: {} labeled queries ({} correct top-1, {} wrong top-1) · negatives: {}",
        pos.len(),
        correct_cos.len(),
        wrong_cos.len(),
        neg.len()
    );
    println!();

    println!("--- top-1 cosine, by group ---");
    summarize("positives (top-1 CORRECT)", &correct_cos);
    summarize("positives (top-1 WRONG)", &wrong_cos);
    summarize("negatives (off-corpus)", &neg_cos);
    println!();

    println!("--- threshold sweep (floor -> reject if top-1 cosine < floor) ---");
    println!(
        "  {:<6} {:>28} {:>28}",
        "floor", "positives wrongly rejected", "negatives correctly rejected"
    );
    let n_correct_pos = correct_cos.len().max(1);
    let n_neg = neg_cos.len().max(1);
    for floor in FLOORS {
        let wrongly_rejected = correct_cos.iter().filter(|&&c| c < floor).count();
        let correctly_rejected = neg_cos.iter().filter(|&&c| c < floor).count();
        println!(
            "  {:<6.2} {:>4}/{:<3} ({:>5.1}%){:>13} {:>4}/{:<3} ({:>5.1}%)",
            floor,
            wrongly_rejected,
            correct_cos.len(),
            100.0 * wrongly_rejected as f64 / n_correct_pos as f64,
            "",
            correctly_rejected,
            neg_cos.len(),
            100.0 * correctly_rejected as f64 / n_neg as f64,
        );
    }
    println!();

    println!("--- rank-5 cosine, correct positives only (passage-count sizing) ---");
    summarize("rank-5 (correct positives)", &rank5_correct);
    println!();

    println!("--- chunk length distribution, whole index (characters) ---");
    summarize("chunk length (chars)", &chunk_lens);
    println!();

    println!("--- per-query top-1 (positives) ---");
    for p in &pos {
        println!(
            "  {:<52} cos={:.3}  {}",
            truncate(&p.q, 50),
            p.top1_cosine,
            if p.correct { "CORRECT" } else { "WRONG" }
        );
    }
    println!();

    println!("--- per-query top-1 (negatives) ---");
    for n in &neg {
        println!("  {:<52} cos={:.3}", truncate(&n.q, 50), n.top1_cosine);
    }
}
