//! Replay `.myco/eval/misses.jsonl` against the vault's on-disk BM25 index.
//!
//!   MYCO_VAULT=/abs/path/to/vault cargo run --example miss_replay
//!
//! For each miss with an `expected` stem, print the rank of that stem in
//! the BM25 top-10 (0 = not found). Lexical arm only — the dense arm needs
//! the embed model loaded and is deliberately out of scope here.

use myco_lib::retrieval::Bm25Index;

#[derive(serde::Deserialize)]
struct MissRow {
    query: String,
    expected: Option<String>,
    #[allow(dead_code)]
    at: i64,
}

fn main() -> Result<(), String> {
    let vault =
        std::env::var("MYCO_VAULT").map_err(|_| "set MYCO_VAULT to the vault root".to_string())?;
    let misses_path = std::path::Path::new(&vault).join(".myco/eval/misses.jsonl");
    let raw = std::fs::read_to_string(&misses_path)
        .map_err(|e| format!("read {}: {e}", misses_path.display()))?;

    let index_path = Bm25Index::path_for(&vault)?;
    let index = Bm25Index::load(&index_path);
    if index.is_empty() {
        return Err("BM25 index is empty — open the vault in the app to build it first".into());
    }

    let mut total = 0usize;
    let mut hit3 = 0usize;
    let mut hit10 = 0usize;
    println!("{:<4} {:<40} expected", "rank", "query");
    for line in raw.lines().filter(|l| !l.trim().is_empty()) {
        let Ok(row) = serde_json::from_str::<MissRow>(line) else {
            continue;
        };
        let Some(expected) = row.expected else {
            continue;
        };
        total += 1;
        let hits = index.search(&row.query, 10);
        let mut seen = Vec::new();
        for h in &hits {
            if !seen.contains(&h.stem) {
                seen.push(h.stem.clone());
            }
        }
        let rank = seen
            .iter()
            .position(|s| *s == expected)
            .map(|i| i + 1)
            .unwrap_or(0);
        if (1..=3).contains(&rank) {
            hit3 += 1;
        }
        if (1..=10).contains(&rank) {
            hit10 += 1;
        }
        let q: String = row.query.chars().take(38).collect();
        println!("{rank:<4} {q:<40} {expected}");
    }
    if total == 0 {
        println!("no labeled misses yet — use ⌥⏎ in the palette with an expectation in mind");
        return Ok(());
    }
    println!("\nlabeled: {total} · hit@3 {hit3}/{total} · hit@10 {hit10}/{total}");
    Ok(())
}
