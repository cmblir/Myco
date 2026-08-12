// Corpus-mix probe (throwaway measurement, NOT wired into CI).
//
// Question it answers: in a vault where 1010 of 1125 notes are auto-swept
// session transcripts and only 87 are hand-written wiki pages, does Ask still
// retrieve the wiki, or do the sessions crowd it out?
//
// This is a measurement, not a fix. Reranking or a folder weight would be easy
// to add and impossible to justify without the number.
//
// The retrieval path is copied from `commands::semantic_search` so the mix
// measured here is the mix Ask actually sees: same pool width (k*5, clamped
// 20..50), same dense arm, same BM25 arm, same RRF fusion, same dense-cosine
// bookkeeping. It reads the LIVE index rather than rebuilding one, so it
// measures the user's vault, not a fixture.
//
// Run:
//   cd app/src-tauri
//   MYCO_VAULT=/path/to/vault MYCO_EMBED_SPEC=bge-m3 \
//     cargo run --release --example corpus_mix_probe

use std::collections::HashMap;
use std::path::PathBuf;

use myco_lib::{
    local_llm::{apply_prefix, embed_spec_by_id, EmbedRole, LocalLlm},
    retrieval::{cap_per_page, rrf_fuse, Bm25Index},
    vector_index::VectorStore,
};

/// Questions a user of this wiki would actually ask. Deliberately a mix:
/// - wiki-shaped: concepts the hand-written pages cover
/// - session-shaped: things only a transcript would record
/// - ambiguous: answerable from either
const QUERIES: &[(&str, &str)] = &[
    ("wiki", "What is the attention mechanism in a transformer?"),
    ("wiki", "How does backpropagation compute gradients?"),
    ("wiki", "트랜스포머의 셀프 어텐션은 어떻게 동작하나요?"),
    ("wiki", "What is tokenization and why does BPE matter?"),
    ("wiki", "batch normalization과 layer normalization의 차이"),
    ("wiki", "How is a language model pretrained?"),
    (
        "session",
        "What did we decide about the abstention threshold?",
    ),
    ("session", "인박스 스윕은 어떤 문제 때문에 껐지?"),
    ("ambiguous", "embedding model 선택 기준"),
    ("ambiguous", "How should retrieval rank results?"),
];

/// Top-level folder of a vault-relative page path — the grouping we care about.
fn bucket(page: &str) -> &str {
    page.split('/').next().unwrap_or("(root)")
}

fn main() {
    let root = std::env::var("MYCO_VAULT")
        .expect("set MYCO_VAULT to the vault root (see ~/Library/Application Support/dev.cmblir.myco/active-vault)");
    let spec_id = std::env::var("MYCO_EMBED_SPEC").unwrap_or_else(|_| "bge-m3".into());

    let index_path = VectorStore::path_for(&root).expect("index path");
    let store = VectorStore::load(&index_path);
    if store.records.is_empty() {
        eprintln!(
            "index at {} is empty — nothing to measure",
            index_path.display()
        );
        return;
    }

    // Corpus composition, straight from the index — the baseline any per-query
    // mix has to be read against.
    let mut corpus: HashMap<&str, usize> = HashMap::new();
    for r in &store.records {
        *corpus.entry(bucket(&r.page)).or_default() += 1;
    }
    let total = store.records.len();
    println!(
        "index: {} ({} chunks, model {})",
        index_path.display(),
        total,
        store.model
    );
    let mut rows: Vec<_> = corpus.iter().collect();
    rows.sort_by_key(|(_, n)| std::cmp::Reverse(**n));
    for (b, n) in &rows {
        println!(
            "  corpus {:<16} {:>6} chunks  {:>5.1}%",
            b,
            n,
            100.0 * **n as f64 / total as f64
        );
    }

    let spec = embed_spec_by_id(&spec_id).unwrap_or_else(|| panic!("unknown embed spec {spec_id}"));
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let llm = LocalLlm::load(&manifest.join(spec.file)).expect("load embed model");
    let bm25 = Bm25Index::load(&Bm25Index::path_for(&root).expect("bm25 path"));

    let k = 12usize; // what Ask asks for
    let pool = (k * 5).clamp(20, 50);
    println!("\nper-query top-{k} mix (pool {pool}, dense+bm25 RRF — same as semantic_search)\n");

    // Aggregate over every query, so one unlucky question does not decide it.
    let mut agg: HashMap<String, usize> = HashMap::new();
    let mut agg_slots = 0usize;
    let mut agg_distinct = 0usize;

    for (kind, q) in QUERIES {
        let prefixed = apply_prefix(spec, EmbedRole::Query, &[(*q).to_string()]);
        let qv = match llm.embed_pooled(&prefixed, spec.pooling, spec.max_ctx) {
            Ok(mut v) => v.pop().unwrap_or_default(),
            Err(e) => {
                eprintln!("embed failed for {q:?}: {e}");
                continue;
            }
        };
        let dense = store.search(&qv, pool);
        let lexical = bm25.search(q, pool);
        // Dense cosine before fusion overwrites score with a rank value — the
        // top cosine is the only number here that says "anything relevant at
        // all", so keep it next to the mix.
        let top_cos = dense.first().map(|h| h.score).unwrap_or(0.0);
        // Fuse WIDER than k, then cap, then truncate — capping a list already
        // cut to k would only shrink it, never promote a distinct page.
        let fused = rrf_fuse(&dense, &lexical, pool);
        let cap: usize = std::env::var("MYCO_PAGE_CAP")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let hits = cap_per_page(fused, cap, k);

        let mut mix: HashMap<&str, usize> = HashMap::new();
        for h in &hits {
            *mix.entry(bucket(&h.page)).or_default() += 1;
            *agg.entry(bucket(&h.page).to_string()).or_default() += 1;
            agg_slots += 1;
        }
        let distinct = hits
            .iter()
            .map(|h| h.page.as_str())
            .collect::<std::collections::HashSet<_>>()
            .len();
        agg_distinct += distinct;
        let mut m: Vec<_> = mix.into_iter().collect();
        m.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
        let shown = m
            .iter()
            .map(|(b, n)| format!("{b} {n}"))
            .collect::<Vec<_>>()
            .join(", ");
        println!("[{kind:<9}] cos {top_cos:.3}  {distinct} distinct  {shown}");
        println!("            {q}");
        for h in hits.iter().take(3) {
            println!("              - {}", h.page);
        }
    }

    println!(
        "\naggregate over {} queries ({agg_slots} slots, {agg_distinct} distinct pages, cap={}):",
        QUERIES.len(),
        std::env::var("MYCO_PAGE_CAP").unwrap_or_else(|_| "0(off)".into())
    );
    let mut a: Vec<_> = agg.into_iter().collect();
    a.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
    for (b, n) in a {
        let corpus_share = corpus.get(b.as_str()).copied().unwrap_or(0) as f64 / total as f64;
        let retrieved_share = n as f64 / agg_slots as f64;
        // >1 means the folder is retrieved MORE than its size alone would give.
        println!(
            "  {:<16} {:>4} slots {:>5.1}%   corpus {:>5.1}%   lift {:.2}x",
            b,
            n,
            100.0 * retrieved_share,
            100.0 * corpus_share,
            if corpus_share > 0.0 {
                retrieved_share / corpus_share
            } else {
                0.0
            }
        );
    }
}
