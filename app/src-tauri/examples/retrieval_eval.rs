// Phase 0 — retrieval evaluation harness.
//
// Measures the ACTUAL semantic retrieval the app ships (bundled Gemma-3-1B
// mean-pooled embeddings → VectorStore cosine search) against a labeled query
// set, so any Phase-1 change (a real embed model, BM25, reranking) can be proven
// to help instead of measured by vibes. Reports recall@k, MRR and nDCG@10.
//
// Run:  cargo run --example retrieval_eval --release
// (release so the one-time embed of the sample vault isn't glacial.)

use std::collections::HashSet;
use std::path::PathBuf;

use memex_lib::{embeddings, local_llm::LocalLlm, sample_vault, vector_index::VectorStore};
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

const KS: [usize; 4] = [1, 3, 5, 10];

fn main() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let model_path = manifest.join("models/gemma-3-1b-it-q4_k_m.gguf");
    let eval_path = manifest.join("eval/retrieval-queries.json");

    let set: EvalSet = serde_json::from_str(
        &std::fs::read_to_string(&eval_path).expect("read eval set"),
    )
    .expect("parse eval set");

    eprintln!("loading model {} …", model_path.display());
    let llm = LocalLlm::load(&model_path).expect("load model");

    // Build an in-memory index from the bundled sample vault, mirroring
    // reindex_embeddings exactly (chunk_page → content_hash → embed → upsert).
    let mut store = VectorStore::load(&PathBuf::from("/tmp/memex-eval-nonexistent.mxv"));
    let mut pages = 0usize;
    let mut chunks_total = 0usize;
    for (path, content) in sample_vault::SAMPLE_NOTES {
        if !path.starts_with("wiki/") {
            continue; // index only wiki pages, like the app
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
        let vecs = llm.embed(&chunks).expect("embed page");
        chunks_total += chunks.len();
        pages += 1;
        let entries: Vec<(u64, Vec<f32>)> = hashes.into_iter().zip(vecs).collect();
        store.upsert_page(&rel, &stem, entries);
        eprint!("\rindexed {pages} pages / {chunks_total} chunks");
    }
    eprintln!("\nindexed {pages} pages, {chunks_total} chunks. evaluating {} queries…\n", set.queries.len());

    // Aggregates
    let n = set.queries.len() as f64;
    let mut recall_sum = [0.0f64; KS.len()];
    let mut hit_sum = [0.0f64; KS.len()];
    let mut mrr_sum = 0.0f64;
    let mut ndcg_sum = 0.0f64;
    let mut worst: Vec<(String, usize)> = Vec::new(); // (query, rank-of-first-relevant; 0 = miss)

    for lab in &set.queries {
        let qvec = llm.embed(&[lab.q.clone()]).expect("embed query");
        let hits = store.search(&qvec[0], 40);
        // Dedup to best-per-page, preserving the score-desc order search returns.
        let mut ranked: Vec<String> = Vec::new();
        let mut seen = HashSet::new();
        for h in &hits {
            if seen.insert(h.stem.clone()) {
                ranked.push(h.stem.clone());
            }
        }
        let relevant: HashSet<&str> = lab.relevant.iter().map(String::as_str).collect();
        let rel_n = relevant.len().max(1) as f64;

        // rank (1-based) of the first relevant page, 0 if none in top-40
        let first_rel = ranked
            .iter()
            .position(|s| relevant.contains(s.as_str()))
            .map(|i| i + 1)
            .unwrap_or(0);
        mrr_sum += if first_rel > 0 { 1.0 / first_rel as f64 } else { 0.0 };
        worst.push((lab.q.clone(), first_rel));

        for (ki, &k) in KS.iter().enumerate() {
            let topk: HashSet<&str> = ranked.iter().take(k).map(String::as_str).collect();
            let found = relevant.iter().filter(|r| topk.contains(*r)).count();
            recall_sum[ki] += found as f64 / rel_n;
            hit_sum[ki] += if found > 0 { 1.0 } else { 0.0 };
        }

        // nDCG@10 (binary relevance)
        let mut dcg = 0.0f64;
        for (i, s) in ranked.iter().take(10).enumerate() {
            if relevant.contains(s.as_str()) {
                dcg += 1.0 / ((i + 2) as f64).log2();
            }
        }
        let ideal = relevant.len().min(10);
        let mut idcg = 0.0f64;
        for i in 0..ideal {
            idcg += 1.0 / ((i + 2) as f64).log2();
        }
        ndcg_sum += if idcg > 0.0 { dcg / idcg } else { 0.0 };
    }

    println!("═══════════════════════════════════════════════════");
    println!(" Memex retrieval baseline — Gemma-3-1B dense, cosine");
    println!("═══════════════════════════════════════════════════");
    println!(" corpus: {pages} wiki pages · {chunks_total} chunks · {} queries", set.queries.len());
    println!();
    println!("  k     hit@k    recall@k");
    for (ki, &k) in KS.iter().enumerate() {
        println!("  {:<4}  {:>5.1}%   {:>5.1}%", k, 100.0 * hit_sum[ki] / n, 100.0 * recall_sum[ki] / n);
    }
    println!();
    println!("  MRR       {:>6.3}", mrr_sum / n);
    println!("  nDCG@10   {:>6.3}", ndcg_sum / n);
    println!();

    // Surface the misses — these are exactly where BM25 / rerank should help.
    let mut misses: Vec<&(String, usize)> = worst.iter().filter(|(_, r)| *r == 0 || *r > 3).collect();
    misses.sort_by_key(|(_, r)| if *r == 0 { usize::MAX } else { *r });
    if !misses.is_empty() {
        println!("  weak queries (first relevant beyond rank 3, or missed):");
        for (q, r) in misses {
            let where_ = if *r == 0 { "MISS".to_string() } else { format!("@{r}") };
            println!("    {:>5}  {}", where_, q);
        }
    }
}
