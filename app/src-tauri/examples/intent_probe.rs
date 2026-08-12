// Intent-routing threshold probe (throwaway measurement, NOT wired into CI).
//
// Goal: gather the cosine data needed to pick a floor for embedding-based
// query-intent routing -- detecting "which notes did I add today"-style
// questions (answerable only from file mtimes, never from page content) by
// comparing the query's embedding to a small exemplar set, instead of the
// brittle regex list the app uses today.
//
// Model setup is copied verbatim from `abstention_probe.rs` (MYCO_EMBED_SPEC
// dispatch, apply_prefix, LocalLlm::load). Corpus/vector-index building is
// skipped entirely -- this probe only needs the embedder, not the wiki corpus
// or VectorStore.
//
// Method: embed the EXEMPLAR set with EmbedRole::Document, embed every probe
// query with EmbedRole::Query, and for each query take the max cosine against
// the exemplar set (the nearest exemplar) -- that single number is the
// routing signal. NOTE: bge-m3's query_prefix/doc_prefix are both "" (see
// EMBED_SPECS in local_llm.rs), so apply_prefix is a no-op for this spec and
// the Query/Document role split has no effect on the actual vectors. The
// calls are kept anyway for fidelity with the app's real embedding path (and
// so this probe stays correct if a future spec has non-empty prefixes).
//
// Run:
//   cd app/src-tauri && MYCO_EMBED_SPEC=bge-m3 cargo run --release --example intent_probe

use std::path::PathBuf;

use myco_lib::{
    embeddings::cosine,
    local_llm::{apply_prefix, embed_spec_by_id, EmbedRole, LocalLlm},
};

/// Intent: `vault-files` -- "which notes/files did I add or change, and when".
const EXEMPLARS: &[&str] = &[
    "what files did I add recently",
    "which notes changed today",
    "오늘 추가된 노트",
    "최근에 만든 파일 목록",
    "이번 주에 수정한 문서",
    "最近追加したファイル",
    "show me my newest notes",
    "어제 작성한 md 파일",
];

const POSITIVES: &[&str] = &[
    "오늘 쌓인 md파일",
    "오늘 만든 노트 뭐 있어",
    "최근에 추가한 파일 보여줘",
    "이번 주에 뭐 정리했지",
    "which pages did I write this week",
    "list files modified yesterday",
    "신규로 들어온 문서 있나",
    "요즘 새로 생긴 노트",
];

const NEG_CONTENT: &[&str] = &[
    "BPE가 뭐야",
    "attention 메커니즘 설명해줘",
    "how does RLHF work",
    "transformer 구조에서 positional encoding 역할",
    "DPO와 PPO 차이",
    "what is a KV cache",
    "임베딩 인덱스는 어떻게 만들어지나",
    "LoRA 어댑터 원리",
];

const NEG_OFFTOPIC: &[&str] = &[
    "김치찌개 레시피",
    "내일 서울 날씨",
    "how to fix a leaking faucet",
];

const FLOORS: [f32; 9] = [0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80];

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
        "  {:<24} n={:<3} min={:.3}  p10={:.3}  median={:.3}  p90={:.3}  max={:.3}",
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

struct ProbeResult {
    q: String,
    max_cos: f32,
    nearest: String,
}

fn main() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let spec_id = std::env::var("MYCO_EMBED_SPEC").unwrap_or_else(|_| "bge-m3".into());
    let spec = embed_spec_by_id(&spec_id)
        .expect("known embed spec (set MYCO_EMBED_SPEC=bge-m3, the only GGUF bundled)");
    let model_path = manifest.join(spec.file);

    eprintln!(
        "loading embed model {} (spec: {spec_id}) …",
        model_path.display()
    );
    let llm = LocalLlm::load(&model_path).expect("load model");

    if spec.query_prefix.is_empty() && spec.doc_prefix.is_empty() {
        eprintln!(
            "note: spec '{spec_id}' has empty query_prefix/doc_prefix -- apply_prefix is a \
             no-op, so Query vs Document embedding is identical for this spec.\n"
        );
    }

    let embed_docs = |texts: &[String]| -> Vec<Vec<f32>> {
        let prefixed = apply_prefix(spec, EmbedRole::Document, texts);
        llm.embed_pooled(&prefixed, spec.pooling, spec.max_ctx)
            .expect("embed exemplars")
    };
    let embed_query = |q: &str| -> Vec<f32> {
        let prefixed = apply_prefix(spec, EmbedRole::Query, &[q.to_string()]);
        llm.embed_pooled(&prefixed, spec.pooling, spec.max_ctx)
            .expect("embed query")
            .pop()
            .unwrap()
    };

    let exemplar_texts: Vec<String> = EXEMPLARS.iter().map(|s| s.to_string()).collect();
    let exemplar_vecs = embed_docs(&exemplar_texts);

    let nearest_exemplar = |qvec: &[f32]| -> (f32, &'static str) {
        let mut best = f32::MIN;
        let mut best_ex = "";
        for (ex, vec) in EXEMPLARS.iter().zip(&exemplar_vecs) {
            let c = cosine(qvec, vec);
            if c > best {
                best = c;
                best_ex = ex;
            }
        }
        (best, best_ex)
    };

    let run_group = |queries: &[&str]| -> Vec<ProbeResult> {
        queries
            .iter()
            .map(|q| {
                let qvec = embed_query(q);
                let (max_cos, ex) = nearest_exemplar(&qvec);
                ProbeResult {
                    q: q.to_string(),
                    max_cos,
                    nearest: ex.to_string(),
                }
            })
            .collect()
    };

    eprintln!(
        "embedding {} exemplars + {} positive + {} content-negative + {} off-topic-negative queries…\n",
        EXEMPLARS.len(),
        POSITIVES.len(),
        NEG_CONTENT.len(),
        NEG_OFFTOPIC.len()
    );

    let pos = run_group(POSITIVES);
    let neg_content = run_group(NEG_CONTENT);
    let neg_off = run_group(NEG_OFFTOPIC);

    let pos_cos: Vec<f32> = pos.iter().map(|r| r.max_cos).collect();
    let neg_content_cos: Vec<f32> = neg_content.iter().map(|r| r.max_cos).collect();
    let neg_off_cos: Vec<f32> = neg_off.iter().map(|r| r.max_cos).collect();

    println!("═══════════════════════════════════════════════════");
    println!(" Intent-routing probe -- max cosine vs exemplars ({spec_id})");
    println!("═══════════════════════════════════════════════════");
    println!(" exemplars: {}", EXEMPLARS.len());
    println!();

    println!("--- max cosine (nearest exemplar), by group ---");
    summarize("POSITIVE (vault-files)", &pos_cos);
    summarize("NEGATIVE (content Qs)", &neg_content_cos);
    summarize("NEGATIVE (off-topic)", &neg_off_cos);
    println!();

    println!("--- threshold sweep (floor -> route to vault-files if max cosine >= floor) ---");
    println!(
        "  {:<6} {:>26} {:>26} {:>26}",
        "floor",
        "positives ROUTED (want yes)",
        "content-Qs ROUTED (want no)",
        "off-topic ROUTED (want no)"
    );
    let n_pos = pos_cos.len().max(1);
    let n_neg_content = neg_content_cos.len().max(1);
    let n_neg_off = neg_off_cos.len().max(1);
    for floor in FLOORS {
        let pos_hit = pos_cos.iter().filter(|&&c| c >= floor).count();
        let content_hit = neg_content_cos.iter().filter(|&&c| c >= floor).count();
        let off_hit = neg_off_cos.iter().filter(|&&c| c >= floor).count();
        println!(
            "  {:<6.2} {:>4}/{:<3} ({:>5.1}%){:>8} {:>4}/{:<3} ({:>5.1}%){:>8} {:>4}/{:<3} ({:>5.1}%)",
            floor,
            pos_hit,
            pos_cos.len(),
            100.0 * pos_hit as f64 / n_pos as f64,
            "",
            content_hit,
            neg_content_cos.len(),
            100.0 * content_hit as f64 / n_neg_content as f64,
            "",
            off_hit,
            neg_off_cos.len(),
            100.0 * off_hit as f64 / n_neg_off as f64,
        );
    }
    println!();

    println!("--- per-query max cosine (POSITIVE) ---");
    for r in &pos {
        println!(
            "  {:<40} cos={:.3}  nearest=\"{}\"",
            truncate(&r.q, 38),
            r.max_cos,
            r.nearest
        );
    }
    println!();

    println!("--- per-query max cosine (NEGATIVE content) ---");
    for r in &neg_content {
        println!(
            "  {:<40} cos={:.3}  nearest=\"{}\"",
            truncate(&r.q, 38),
            r.max_cos,
            r.nearest
        );
    }
    println!();

    println!("--- per-query max cosine (NEGATIVE off-topic) ---");
    for r in &neg_off {
        println!(
            "  {:<40} cos={:.3}  nearest=\"{}\"",
            truncate(&r.q, 38),
            r.max_cos,
            r.nearest
        );
    }
}
