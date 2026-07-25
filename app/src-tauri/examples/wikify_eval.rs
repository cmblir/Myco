// Wikify evaluation harness (Phase 1b).
//
// `wikify_candidates` is the app's SECOND retrieval consumer: given a piece of
// source text it suggests which existing wiki pages that text should link to /
// update. It got the same dense+BM25(RRF) fusion as Ask (retrieval 1b), and
// this harness measured it FIRST for this path — fusion turned out to help
// English cases but lose ~15-16pp k=10 recall on Korean ones (long-prose
// queries dilute BM25; the CJK bigram tokenizer makes it worse on long text),
// so wikify shipped back to dense-only while Ask kept the fusion. See
// eval/BASELINE.md for the full tables. This harness is kept running BOTH
// arms so a future, smarter fusion attempt for this path can be re-measured
// against the same recorded baseline instead of re-discovering the diagnosis.
//
// It drives the SHIPPED glue — `pipeline::dense_chunk_matches` (filter → cap)
// and `pipeline::rank_candidates` — so it cannot drift from the command: the
// `dense` arm calls the very helper `wikify_candidates` calls, making it a true
// control. The `fused` arm calls `pipeline::fuse_chunk_matches` with real BM25
// hits to keep the other side measurable. Only the Tauri/IO shell (vault root,
// caches, `embed_texts`) is replaced.
//
// Ground truth is the corpus's own link graph, not invented labels: for a page
// P, the relevant set is the pages P links to via `[[...]]`. Two source-text
// variants are measured, because both difficulty levels matter:
//   - `easy`: wikilinks replaced by their display text (a user pasting ordinary
//     prose that names the concepts).
//   - `hard`: the linked phrase deleted, leaving only surrounding context (no
//     lexical gift at all).
//
// Run:  MEMEX_EMBED_SPEC=bge-m3 cargo run --example wikify_eval --release
// (bge-m3 is the default here since that is what ships; the env var overrides.)

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;

use memex_lib::{
    embeddings,
    local_llm::{apply_prefix, embed_spec_by_id, EmbedRole, LocalLlm},
    parser::parse_links_from_text,
    pipeline::{self, CandidatePage},
    retrieval::Bm25Index,
    sample_vault,
    vector_index::VectorStore,
};
use regex::Regex;

/// Reported cut-offs. 20 is also the hard ceiling of the shipped path
/// (`wikify_candidates` clamps `k` to 1..=20), so MAP below is MAP@20.
const KS: [usize; 3] = [5, 10, 20];
const K_MAX: usize = 20;

struct Page {
    /// Vault-relative path, e.g. `wiki/rlhf.md`.
    rel: String,
    stem: String,
    content: String,
}

/// One measurable page: its label set plus both source-text variants.
struct Case {
    stem: String,
    labels: HashSet<String>,
    easy: String,
    hard: String,
}

fn wikilink_re() -> Regex {
    Regex::new(r"\[\[([^\]\n]+?)\]\]").expect("static regex")
}

/// Body only: drop the YAML frontmatter, the `[^src-*]` inline citation markers
/// and the footnote definition lines. Those are Memex markup, not prose a user
/// would paste in. The `#` heading and the body text stay.
fn strip_markup(content: &str) -> String {
    let body = content
        .strip_prefix("---\n")
        .and_then(|rest| rest.split_once("\n---\n"))
        .map(|(_, body)| body)
        .unwrap_or(content);
    let marker = Regex::new(r"\[\^[^\]\n]+\]").expect("static regex");
    body.lines()
        .filter(|l| !l.trim_start().starts_with("[^"))
        .map(|l| marker.replace_all(l, "").to_string())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Repair the whitespace/punctuation damage left by deleting spans mid-sentence,
/// so the `hard` variant reads like prose rather than like a redaction.
fn tidy(text: &str) -> String {
    let space = Regex::new(r"[ \t]{2,}").expect("static regex");
    let before_punct = Regex::new(r" +([,.;:!?)\]…”])").expect("static regex");
    let after_open = Regex::new(r"([(\[“]) +").expect("static regex");
    let empty_paren = Regex::new(r"\(\s*\)").expect("static regex");
    let doubled = Regex::new(r"([,;:]) *([,.;:])").expect("static regex");
    let out: Vec<String> = text
        .lines()
        .map(|line| {
            let s = empty_paren.replace_all(line, "").to_string();
            let s = space.replace_all(&s, " ").to_string();
            let s = after_open.replace_all(&s, "$1").to_string();
            let s = before_punct.replace_all(&s, "$1").to_string();
            let s = doubled.replace_all(&s, "$2").to_string();
            s.trim_end().to_string()
        })
        .collect();
    out.join("\n")
}

/// `easy`: each `[[stem|alias]]` becomes `alias`, each `[[stem]]` becomes the
/// stem as prose (hyphens → spaces). This is the realistic case — the user's
/// text names the concepts, and wikify has to find the pages that own them.
fn easy_variant(body: &str) -> String {
    let out = wikilink_re().replace_all(body, |c: &regex::Captures| {
        let inner = c.get(1).map(|m| m.as_str()).unwrap_or("");
        match inner.split_once('|') {
            Some((_, alias)) => alias.trim().to_string(),
            None => inner.trim().replace('-', " "),
        }
    });
    tidy(&out)
}

/// `hard`: the linked phrase is deleted outright, leaving only the surrounding
/// prose, so only context can identify the target. A Hangul run glued to the
/// closing brackets is an agglutinative particle belonging to the deleted
/// phrase (`[[dpo|직접 선호 최적화]]는`), so it goes with it — otherwise the
/// sentence is left with a dangling 는/을/이.
fn hard_variant(body: &str) -> String {
    let re = Regex::new(r"\[\[[^\]\n]+?\]\][\u{AC00}-\u{D7A3}]*").expect("static regex");
    tidy(&re.replace_all(body, ""))
}

/// Whether retrieved stem `s` counts as a hit against `label` under the given
/// label definition.
///
/// **strict** (`translation_aware = false`): exact stem match only — what the
/// harness measured before this change.
///
/// **translation-aware** (`true`): also true if `s` and `label` are the two
/// mechanical forms of the same underlying page under the corpus's own
/// `ko-<slug>.md` / `wiki/<slug>.md` naming convention (checked both
/// directions, since either side of a pair can be the label depending on which
/// page is the source). This is a string-level rule derived from the existing
/// filename convention, not a hand-maintained stem-to-stem mapping table.
fn label_match(s: &str, label: &str, translation_aware: bool) -> bool {
    if s == label {
        return true;
    }
    translation_aware
        && (s.strip_prefix("ko-") == Some(label) || label.strip_prefix("ko-") == Some(s))
}

/// Which ranks in `list` count as a hit, and against which label — computed
/// once per case so both the recall/precision/F1 loop and MAP walk the exact
/// same accounting.
///
/// A label can be satisfied by more than one retrieved stem under the
/// translation-aware definition (e.g. both `self-attention` and its twin
/// `ko-self-attention` could both appear in the ranked list). Counting both as
/// hits would silently inflate precision and MAP relative to the strict
/// definition without the retriever having found anything extra, so each
/// label is claimed by the FIRST (best-ranked) matching stem only; any later
/// stem matching an already-claimed label is not counted as a hit. This is the
/// dedup the translation-aware definition requires: one label satisfied is
/// one hit, never two.
fn compute_hits(list: &[String], labels: &HashSet<String>, translation_aware: bool) -> Vec<bool> {
    let mut claimed: HashSet<&str> = HashSet::new();
    list.iter()
        .map(|s| {
            match labels
                .iter()
                .find(|l| !claimed.contains(l.as_str()) && label_match(s, l, translation_aware))
            {
                Some(l) => {
                    claimed.insert(l.as_str());
                    true
                }
                None => false,
            }
        })
        .collect()
}

/// Link targets of `body`, normalised to bare stems: `[[Note#Section]]` refers
/// to the note, and an alias is already dropped by `parse_links_from_text`.
fn link_stems(body: &str) -> Vec<String> {
    parse_links_from_text(body)
        .into_iter()
        .map(|t| {
            t.split('#')
                .next()
                .unwrap_or(&t)
                .trim()
                .trim_end_matches(".md")
                .to_string()
        })
        .filter(|s| !s.is_empty())
        .collect()
}

fn main() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // Defaults to bge-m3 — the model the app actually ships — unlike
    // retrieval_eval, whose "gemma" default preserves its Phase-0 baseline.
    let spec_id = std::env::var("MEMEX_EMBED_SPEC").unwrap_or_else(|_| "bge-m3".into());
    let model_path = if spec_id == "gemma" {
        manifest.join("models/gemma-3-1b-it-q4_k_m.gguf")
    } else {
        manifest.join(embed_spec_by_id(&spec_id).expect("known spec").file)
    };

    // ---- corpus: identical to retrieval_eval's (English sample vault + Korean
    // fixtures), so both harnesses measure the same pages.
    let mut corpus: Vec<Page> = Vec::new();
    for (path, content) in sample_vault::SAMPLE_NOTES {
        if !path.starts_with("wiki/") {
            continue; // index only wiki pages, like the app
        }
        corpus.push(Page {
            rel: path.to_string(),
            stem: path
                .trim_start_matches("wiki/")
                .trim_end_matches(".md")
                .to_string(),
            content: content.to_string(),
        });
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
            let stem = path.file_stem().unwrap().to_string_lossy().to_string();
            corpus.push(Page {
                rel: format!("ko-corpus/{stem}.md"),
                content: std::fs::read_to_string(&path).expect("read ko page"),
                stem,
            });
        }
    }
    let corpus_stems: HashSet<&str> = corpus.iter().map(|p| p.stem.as_str()).collect();

    // ---- labeled cases, derived from the link graph.
    let mut cases: Vec<Case> = Vec::new();
    let mut skipped: Vec<&str> = Vec::new();
    for page in &corpus {
        let body = strip_markup(&page.content);
        let labels: HashSet<String> = link_stems(&body)
            .into_iter()
            // A target is ground truth only if it exists in the corpus, is a
            // page wikify is allowed to return, and is not the page itself
            // (every page self-links at least once in this vault).
            .filter(|s| {
                corpus_stems.contains(s.as_str())
                    && pipeline::is_knowledge_page(s)
                    && *s != page.stem
            })
            .collect();
        if labels.is_empty() {
            skipped.push(&page.stem);
            continue;
        }
        cases.push(Case {
            stem: page.stem.clone(),
            labels,
            easy: easy_variant(&body),
            hard: hard_variant(&body),
        });
    }
    cases.sort_by(|a, b| a.stem.cmp(&b.stem));

    // Inspection mode: dump one case's derived labels and both source variants
    // and stop, so the eval inputs can be reviewed without a 5-minute run.
    if let Ok(want) = std::env::var("MEMEX_WIKIFY_DUMP") {
        let case = cases.iter().find(|c| c.stem == want).expect("case exists");
        let mut labels: Vec<&str> = case.labels.iter().map(String::as_str).collect();
        labels.sort();
        println!("labels: {}\n\n--- easy ---\n{}\n\n--- hard ---\n{}", labels.join(", "), case.easy, case.hard);
        return;
    }

    eprintln!("loading model {} (spec: {spec_id}) …", model_path.display());
    let llm = LocalLlm::load(&model_path).expect("load model");
    let embed = |role: EmbedRole, texts: &[String]| -> Vec<Vec<f32>> {
        if spec_id == "gemma" {
            llm.embed(texts).expect("embed")
        } else {
            let spec = embed_spec_by_id(&spec_id).expect("known spec");
            let prefixed = apply_prefix(spec, role, texts);
            llm.embed_pooled(&prefixed, spec.pooling, spec.max_ctx)
                .expect("embed")
        }
    };

    // ---- index, mirroring reindex_embeddings (chunk_page → content_hash →
    // embed as Document → upsert), with the lexical index built from the SAME
    // chunks so both arms share `(page, section)` identity.
    // Built empty in memory, never loaded from disk: depending on a path that
    // must NOT exist would silently augment the corpus (and invalidate the
    // recorded baseline) the day such a file happens to be there.
    let mut store = VectorStore::default();
    let mut bm25 = Bm25Index::new();
    let mut pages = 0usize;
    let mut chunks_total = 0usize;
    for page in &corpus {
        let chunks = embeddings::chunk_page(&page.content);
        if chunks.is_empty() {
            continue;
        }
        let hashes: Vec<u64> = chunks.iter().map(|c| embeddings::content_hash(c)).collect();
        let vecs = embed(EmbedRole::Document, &chunks);
        chunks_total += chunks.len();
        pages += 1;
        store.upsert_page(&page.rel, &page.stem, hashes.into_iter().zip(vecs).collect());
        bm25.upsert_page(&page.rel, &page.stem, &chunks);
        eprint!("\rindexed {pages} pages / {chunks_total} chunks");
    }
    eprintln!("\nevaluating {} cases × 2 variants × 2 arms …", cases.len());

    // ---- run the shipped path per case. The `dense` arm calls
    // `pipeline::dense_chunk_matches`, the exact helper `wikify_candidates`
    // ships (filter → cap, cosine scores preserved), so it is the real
    // dense-only behaviour rather than a re-implementation. The `fused` arm
    // calls `pipeline::fuse_chunk_matches` with the real BM25 hits; note its
    // hit scores are RRF rank scores, so `rank_candidates` folds a page's
    // chunks by best rank there and by max cosine on the dense arm — that
    // difference is part of what the two arms measure.
    struct Ranked {
        dense: Vec<String>,
        fused: Vec<String>,
    }
    let run = |source_text: &str| -> Ranked {
        let mut chunks = embeddings::chunk_page(source_text);
        chunks.truncate(pipeline::MAX_CHUNKS);
        if chunks.is_empty() {
            return Ranked { dense: Vec::new(), fused: Vec::new() };
        }
        let vecs = embed(EmbedRole::Query, &chunks);
        let mut dense_per_chunk = Vec::with_capacity(chunks.len());
        let mut fused_per_chunk = Vec::with_capacity(chunks.len());
        for (v, chunk_text) in vecs.iter().zip(chunks.iter()) {
            let dense = store.search(v, pipeline::FUSE_POOL);
            let lexical = bm25.search(chunk_text, pipeline::FUSE_POOL);
            dense_per_chunk.push(pipeline::dense_chunk_matches(&dense));
            fused_per_chunk.push(pipeline::fuse_chunk_matches(&dense, &lexical));
        }
        let stems = |c: Vec<CandidatePage>| c.into_iter().map(|c| c.stem).collect();
        Ranked {
            dense: stems(pipeline::rank_candidates(&dense_per_chunk, K_MAX)),
            fused: stems(pipeline::rank_candidates(&fused_per_chunk, K_MAX)),
        }
    };

    let mut ranked: HashMap<(&str, &str), Ranked> = HashMap::new();
    for (i, case) in cases.iter().enumerate() {
        ranked.insert(("easy", case.stem.as_str()), run(&case.easy));
        ranked.insert(("hard", case.stem.as_str()), run(&case.hard));
        eprint!("\r{}/{} cases", i + 1, cases.len());
    }
    eprintln!();

    // ---- metrics. Set retrieval with several correct answers, so
    // precision/recall/F1 at k plus MAP over the ranked list.
    struct Metrics {
        precision: [f64; KS.len()],
        recall: [f64; KS.len()],
        f1: [f64; KS.len()],
        map: f64,
        /// Per-case recall@10, index-aligned with `cases`.
        recall_at_10: Vec<f64>,
    }

    let evaluate = |subset: &[&Case],
                     arm: fn(&Ranked) -> &Vec<String>,
                     variant: &str,
                     translation_aware: bool|
     -> Metrics {
        let n = subset.len() as f64;
        let mut p_sum = [0.0f64; KS.len()];
        let mut r_sum = [0.0f64; KS.len()];
        let mut f_sum = [0.0f64; KS.len()];
        let mut map_sum = 0.0f64;
        let mut recall_at_10 = Vec::with_capacity(subset.len());

        for case in subset {
            let list = arm(&ranked[&(variant, case.stem.as_str())]);
            let rel_n = case.labels.len() as f64;
            // `hits[i]` is true iff rank i is the first (best-ranked) stem to
            // satisfy some not-yet-claimed label — see `compute_hits` for why
            // this dedup matters once translation twins are in play.
            let hits = compute_hits(list, &case.labels, translation_aware);
            for (ki, &k) in KS.iter().enumerate() {
                let found = hits.iter().take(k).filter(|&&h| h).count() as f64;
                // Precision divides by the number of slots actually returned:
                // a list shorter than k is not penalised for slots that never
                // existed. Empty list -> precision 0.
                let returned = list.len().min(k) as f64;
                let p = if returned > 0.0 { found / returned } else { 0.0 };
                let r = found / rel_n;
                p_sum[ki] += p;
                r_sum[ki] += r;
                f_sum[ki] += if p + r > 0.0 { 2.0 * p * r / (p + r) } else { 0.0 };
                if k == 10 {
                    recall_at_10.push(r);
                }
            }
            // Average precision over the ranked list, divided by the number of
            // relevant pages (so missed labels cost, as they should).
            let mut found = 0.0f64;
            let mut ap = 0.0f64;
            for (i, &h) in hits.iter().enumerate() {
                if h {
                    found += 1.0;
                    ap += found / (i + 1) as f64;
                }
            }
            map_sum += ap / rel_n;
        }
        Metrics {
            precision: std::array::from_fn(|ki| p_sum[ki] / n),
            recall: std::array::from_fn(|ki| r_sum[ki] / n),
            f1: std::array::from_fn(|ki| f_sum[ki] / n),
            map: map_sum / n,
            recall_at_10,
        }
    };

    fn print_block(title: &str, m: &Metrics) {
        println!("  --- {title} ---");
        println!("  k     precision@k  recall@k  F1@k");
        for (ki, &k) in KS.iter().enumerate() {
            println!(
                "  {:<4}  {:>9.1}%   {:>6.1}%   {:>5.3}",
                k,
                100.0 * m.precision[ki],
                100.0 * m.recall[ki],
                m.f1[ki]
            );
        }
        println!("\n  MAP@{K_MAX}     {:>6.3}\n", m.map);
    }

    let dense_arm: fn(&Ranked) -> &Vec<String> = |r| &r.dense;
    let fused_arm: fn(&Ranked) -> &Vec<String> = |r| &r.fused;
    let all: Vec<&Case> = cases.iter().collect();
    let ki10 = KS.iter().position(|&k| k == 10).expect("k=10 reported");

    println!("═══════════════════════════════════════════════════");
    println!(" Memex wikify_candidates — {spec_id}");
    println!("═══════════════════════════════════════════════════");
    println!(
        " corpus: {pages} pages · {chunks_total} chunks · {} labeled cases ({} skipped: no in-corpus knowledge-page links)",
        cases.len(),
        skipped.len()
    );
    if !skipped.is_empty() {
        println!(" skipped: {}", skipped.join(", "));
    }
    let mut label_total = 0usize;
    for c in &cases {
        label_total += c.labels.len();
    }
    println!(
        " labels: {label_total} total · {:.1} per case (max k = {K_MAX})",
        label_total as f64 / cases.len() as f64
    );
    println!();

    // Every metric block below is reported under BOTH label definitions, side
    // by side, rather than picking one after seeing which looks better:
    //   - strict:            a suggestion is correct only if its stem is
    //     exactly a labeled link target.
    //   - translation-aware: a suggestion is also correct if it is the
    //     mechanical `ko-<slug>` / `<slug>` translation twin of a labeled
    //     stem (see `label_match`/`compute_hits`). This targets one specific,
    //     evidenced artifact — the KO fixtures' labels point at English stems
    //     by construction — and is reported alongside strict, not instead of
    //     it, so the reader sees the artifact's size rather than a single
    //     number that hides it.
    for (label_name, translation_aware) in [("strict labels", false), ("translation-aware labels", true)] {
        let easy_dense = evaluate(&all, dense_arm, "easy", translation_aware);
        let easy_fused = evaluate(&all, fused_arm, "easy", translation_aware);
        let hard_dense = evaluate(&all, dense_arm, "hard", translation_aware);
        let hard_fused = evaluate(&all, fused_arm, "hard", translation_aware);

        println!(" ═══ label definition: {label_name} ═══\n");
        println!(" ### easy variant (wikilinks → display text)\n");
        print_block("dense only", &easy_dense);
        print_block("dense+bm25 (RRF)", &easy_fused);
        println!(" ### hard variant (linked phrase deleted)\n");
        print_block("dense only", &hard_dense);
        print_block("dense+bm25 (RRF)", &hard_fused);

        // Deltas at k=10 (the headline) — gains and regressions equally visible.
        println!(" ### delta at k=10 (fused − dense) — {label_name}\n");
        println!("  variant  metric        dense    fused    delta");
        for (variant, d, f) in [
            ("easy", &easy_dense, &easy_fused),
            ("hard", &hard_dense, &hard_fused),
        ] {
            for (name, dv, fv) in [
                ("precision@10", 100.0 * d.precision[ki10], 100.0 * f.precision[ki10]),
                ("recall@10", 100.0 * d.recall[ki10], 100.0 * f.recall[ki10]),
                ("F1@10", d.f1[ki10], f.f1[ki10]),
                ("MAP", d.map, f.map),
            ] {
                println!("  {variant:<7}  {name:<12}  {dv:>6.3}  {fv:>7.3}  {:>+7.3}", fv - dv);
            }
        }
        println!();
    }

    // Split by corpus language. This is a POST-HOC split — chosen after seeing
    // the strict aggregate regress — not a pre-registered breakdown, and it
    // is labeled as such rather than presented as if planned in advance. It
    // exists because the Korean fixtures link to the ENGLISH stems
    // (`[[self-attention|셀프 어텐션]]`) while the corpus also holds their
    // Korean twins, so under strict labels a Korean case's semantically-right
    // answer is a page that is NOT in its label set. Reported under both
    // label definitions so the translation-aware recovery on KO is visible
    // alongside the strict confound, not asserted separately.
    let en: Vec<&Case> = cases.iter().filter(|c| !c.stem.starts_with("ko-")).collect();
    let ko: Vec<&Case> = cases.iter().filter(|c| c.stem.starts_with("ko-")).collect();
    println!(" ### by corpus language at k=10 (EN {} cases · KO {} cases) — post-hoc split\n", en.len(), ko.len());
    println!("  labels                    lang  variant  arm     precision@10  recall@10  F1@10   MAP");
    for (label_name, translation_aware) in [("strict", false), ("translation-aware", true)] {
        for (lang, subset) in [("EN", &en), ("KO", &ko)] {
            for variant in ["easy", "hard"] {
                for (arm_name, arm) in [("dense", dense_arm), ("fused", fused_arm)] {
                    let m = evaluate(subset, arm, variant, translation_aware);
                    println!(
                        "  {label_name:<24}  {lang:<4}  {variant:<7}  {arm_name:<6}  {:>10.1}%   {:>7.1}%   {:>5.3}  {:>5.3}",
                        100.0 * m.precision[ki10],
                        100.0 * m.recall[ki10],
                        m.f1[ki10],
                        m.map
                    );
                }
            }
        }
    }
    println!();

    // Worst cases by fused recall@10 (strict labels — where a future change
    // should aim under the definition that exists today). Split by language,
    // because otherwise the confounded KO subset fills the whole list and
    // hides the EN cases that are actually actionable.
    for (variant, lang, subset) in [
        ("easy", "EN", &en),
        ("easy", "KO", &ko),
        ("hard", "EN", &en),
        ("hard", "KO", &ko),
    ] {
        let m = evaluate(subset, fused_arm, variant, false);
        let mut worst: Vec<(&str, f64, usize)> = subset
            .iter()
            .zip(&m.recall_at_10)
            .map(|(c, &r)| (c.stem.as_str(), r, c.labels.len()))
            .collect();
        // Recall ascending, then stem ascending — deterministic ordering.
        worst.sort_by(|a, b| {
            a.1.partial_cmp(&b.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.0.cmp(b.0))
        });
        // The fused top-5 is printed alongside: a bare recall figure cannot say
        // WHAT the retriever returned instead, which is the whole diagnosis.
        println!("  worst 5 by fused recall@10 ({lang} · {variant}) — with the fused top-5 returned:");
        for (stem, r, labels) in worst.iter().take(5) {
            let top: Vec<&str> = ranked[&(variant, *stem)]
                .fused
                .iter()
                .take(5)
                .map(String::as_str)
                .collect();
            println!("    {:>5.1}%  {stem} ({labels} labels) <- {}", 100.0 * r, top.join(", "));
        }
        println!();
    }
}
