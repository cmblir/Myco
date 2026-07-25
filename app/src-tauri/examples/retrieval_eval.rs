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

use memex_lib::{
    embeddings,
    local_llm::{apply_prefix, embed_spec_by_id, EmbedRole, LocalLlm},
    retrieval::{rrf_fuse, Bm25Index},
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

const KS: [usize; 4] = [1, 3, 5, 10];

fn main() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // MEMEX_EMBED_SPEC selects which embed model the harness measures.
    // Default "gemma" reproduces the Phase-0 baseline (bundled chat model,
    // mean-pooled); any other id names an EMBED_SPECS entry (Task 4 bake-off).
    let spec_id = std::env::var("MEMEX_EMBED_SPEC").unwrap_or_else(|_| "gemma".into());
    let model_path = if spec_id == "gemma" {
        manifest.join("models/gemma-3-1b-it-q4_k_m.gguf")
    } else {
        let spec = embed_spec_by_id(&spec_id).expect("known spec");
        manifest.join(spec.file)
    };
    let eval_path = manifest.join("eval/retrieval-queries.json");

    let set: EvalSet = serde_json::from_str(
        &std::fs::read_to_string(&eval_path).expect("read eval set"),
    )
    .expect("parse eval set");

    eprintln!("loading model {} (spec: {spec_id}) …", model_path.display());
    let llm = LocalLlm::load(&model_path).expect("load model");

    // Document/query embedding, branched once here (DRY) instead of at each
    // call site. The non-gemma branch runs the shared pooling core
    // (`embed_pooled`) against the SAME loaded model rather than `embed_spec`,
    // which would need a second load via `load_embed_model` — both produce
    // identical vectors since they share the pooling core, but this avoids
    // loading the model file twice.
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
            llm.embed(&[q.to_string()]).expect("embed query").pop().unwrap()
        } else {
            let spec = embed_spec_by_id(&spec_id).expect("known spec");
            let prefixed = apply_prefix(spec, EmbedRole::Query, &[q.to_string()]);
            llm.embed_pooled(&prefixed, spec.pooling, spec.max_ctx)
                .expect("embed query")
                .pop()
                .unwrap()
        }
    };

    // Build an in-memory index from the bundled sample vault, mirroring
    // reindex_embeddings exactly (chunk_page → content_hash → embed → upsert).
    let mut store = VectorStore::load(&PathBuf::from("/tmp/memex-eval-nonexistent.mxv"));
    // Lexical index built from the SAME chunks fed to `store`, so dense and
    // fused arms are measured against identical (page, section) identity.
    let mut bm25 = Bm25Index::new();
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
        let vecs = doc_vecs(&llm, &chunks);
        chunks_total += chunks.len();
        pages += 1;
        let entries: Vec<(u64, Vec<f32>)> = hashes.into_iter().zip(vecs).collect();
        store.upsert_page(&rel, &stem, entries);
        bm25.upsert_page(&rel, &stem, &chunks);
        eprint!("\rindexed {pages} pages / {chunks_total} chunks");
    }

    // Korean parallel corpus (eval-only, read from disk so it never ships in the
    // binary or the starter vault). Same pipeline as the English block above.
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
            chunks_total += chunks.len();
            pages += 1;
            let entries: Vec<(u64, Vec<f32>)> = hashes.into_iter().zip(vecs).collect();
            store.upsert_page(&rel, &stem, entries);
            bm25.upsert_page(&rel, &stem, &chunks);
            eprint!("\rindexed {pages} pages / {chunks_total} chunks");
        }
    }

    eprintln!("\nindexed {pages} pages, {chunks_total} chunks. evaluating {} queries…\n", set.queries.len());

    // Aggregate metrics for one arm (dense-only or fused), computed from a
    // pre-ranked, deduped-by-stem list per query — the SAME function is
    // applied to both arms so the comparison is apples-to-apples.
    struct Metrics {
        recall: [f64; KS.len()],
        hit: [f64; KS.len()],
        mrr: f64,
        ndcg: f64,
        first_rel: Vec<usize>, // per-query rank of first relevant hit; 0 = miss
    }

    fn evaluate(ranked_per_query: &[Vec<String>], queries: &[Labeled]) -> Metrics {
        let n = queries.len() as f64;
        let mut recall_sum = [0.0f64; KS.len()];
        let mut hit_sum = [0.0f64; KS.len()];
        let mut mrr_sum = 0.0f64;
        let mut ndcg_sum = 0.0f64;
        let mut first_rel = Vec::with_capacity(queries.len());

        for (lab, ranked) in queries.iter().zip(ranked_per_query) {
            let relevant: HashSet<&str> = lab.relevant.iter().map(String::as_str).collect();
            let rel_n = relevant.len().max(1) as f64;

            // rank (1-based) of the first relevant page, 0 if none in top-40
            let rank = ranked
                .iter()
                .position(|s| relevant.contains(s.as_str()))
                .map(|i| i + 1)
                .unwrap_or(0);
            mrr_sum += if rank > 0 { 1.0 / rank as f64 } else { 0.0 };
            first_rel.push(rank);

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

        Metrics {
            recall: std::array::from_fn(|ki| recall_sum[ki] / n),
            hit: std::array::from_fn(|ki| hit_sum[ki] / n),
            mrr: mrr_sum / n,
            ndcg: ndcg_sum / n,
            first_rel,
        }
    }

    fn print_block(title: &str, m: &Metrics) {
        println!("  --- {title} ---");
        println!("  k     hit@k    recall@k");
        for (ki, &k) in KS.iter().enumerate() {
            println!("  {:<4}  {:>5.1}%   {:>5.1}%", k, 100.0 * m.hit[ki], 100.0 * m.recall[ki]);
        }
        println!();
        println!("  MRR       {:>6.3}", m.mrr);
        println!("  nDCG@10   {:>6.3}", m.ndcg);
        println!();
    }

    // Dedup a ranked Hit list to best-per-stem, preserving score-desc order.
    fn dedup_stems(hits: &[memex_lib::vector_index::Hit]) -> Vec<String> {
        let mut ranked = Vec::new();
        let mut seen = HashSet::new();
        for h in hits {
            if seen.insert(h.stem.clone()) {
                ranked.push(h.stem.clone());
            }
        }
        ranked
    }

    let mut dense_ranked: Vec<Vec<String>> = Vec::with_capacity(set.queries.len());
    let mut fused_ranked: Vec<Vec<String>> = Vec::with_capacity(set.queries.len());

    for lab in &set.queries {
        let qvec = query_vec(&llm, &lab.q);
        let dense_hits = store.search(&qvec, 40);
        let lexical_hits = bm25.search(&lab.q, 40);
        let fused_hits = rrf_fuse(&dense_hits, &lexical_hits, 40);

        dense_ranked.push(dedup_stems(&dense_hits));
        fused_ranked.push(dedup_stems(&fused_hits));
    }

    let dense = evaluate(&dense_ranked, &set.queries);
    let fused = evaluate(&fused_ranked, &set.queries);

    println!("═══════════════════════════════════════════════════");
    println!(" Memex retrieval — {spec_id}");
    println!("═══════════════════════════════════════════════════");
    println!(" corpus: {pages} wiki pages · {chunks_total} chunks · {} queries", set.queries.len());
    println!();
    print_block("dense", &dense);
    print_block("dense+bm25 (RRF)", &fused);

    // Every query whose first-relevant rank changed between the two arms —
    // gains and regressions must be equally visible, not just improvements.
    let fmt_rank = |r: usize| if r == 0 { "MISS".to_string() } else { format!("@{r}") };
    let mut changed: Vec<(&str, usize, usize)> = Vec::new();
    for (i, lab) in set.queries.iter().enumerate() {
        let d = dense.first_rel[i];
        let f = fused.first_rel[i];
        if d != f {
            changed.push((lab.q.as_str(), d, f));
        }
    }
    if !changed.is_empty() {
        println!("  rank changes (dense -> fused):");
        for (q, d, f) in &changed {
            println!("    {:>5} -> {:<5}  {}", fmt_rank(*d), fmt_rank(*f), q);
        }
        println!();
    }

    // Surface the dense misses — these are exactly where BM25 / rerank should help.
    let mut misses: Vec<(&str, usize)> = set
        .queries
        .iter()
        .zip(&dense.first_rel)
        .map(|(lab, &r)| (lab.q.as_str(), r))
        .filter(|(_, r)| *r == 0 || *r > 3)
        .collect();
    misses.sort_by_key(|(_, r)| if *r == 0 { usize::MAX } else { *r });
    if !misses.is_empty() {
        println!("  weak queries (dense: first relevant beyond rank 3, or missed):");
        for (q, r) in misses {
            println!("    {:>5}  {}", fmt_rank(r), q);
        }
    }
}
