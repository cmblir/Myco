//! Text embedding helpers for the semantic layer (Feature 1).
//!
//! Pure, dependency-light building blocks: page chunking, vector math, and an
//! Ollama provider embed call. The bundled-model embed path lives with the model
//! itself (`local_llm::embed`); `commands::embed_texts` dispatches between the
//! two. OpenAI/Google provider paths would slot in there without touching
//! callers.
//!
//! Every path here returns L2-normalized vectors, and the index stores them that
//! way — which is what lets `dot` stand in for `cosine`.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

/// Target chunk size in ESTIMATED TOKENS. The old byte budget (1800 bytes,
/// "~512 tokens") was an English-only equation: XLM-R spends roughly one token
/// per Hangul/CJK character, so a Korean-prose chunk under the byte budget
/// could reach 4–5× the token estimate — and the Metal compute buffer scales
/// at ~1 MiB per token of the widest text in an embed call (see
/// `embed_pooled_with`), which on a memory-pressed machine turned every
/// background page embed into a burst of transient GiB-scale allocation.
/// 320 tokens caps that burst at ~320 MiB and is a better retrieval unit
/// anyway (finer-grained chunks match queries more precisely).
const CHUNK_TOKENS: usize = 320;
const CHUNK_MIN_TOKENS: usize = 24; // don't emit trailing scraps alone

/// Cheap per-char token estimate for the XLM-R tokenizer: Hangul/CJK runs at
/// ~1 token per character (often merging two, sometimes splitting jamo — 1.0
/// is the safe planning number), everything else at the classic ~4 chars per
/// token. Only used for chunk budgeting, never for anything that must be
/// exact; the embed path still hard-truncates at the model's real ctx.
pub fn est_tokens(s: &str) -> usize {
    let mut est = 0f32;
    for c in s.chars() {
        est += match c {
            '\u{AC00}'..='\u{D7A3}' // Hangul syllables
            | '\u{1100}'..='\u{11FF}' // Hangul jamo
            | '\u{4E00}'..='\u{9FFF}' // CJK unified
            | '\u{3040}'..='\u{30FF}' // kana
            | '\u{F900}'..='\u{FAFF}' => 1.0,
            _ => 0.25,
        };
    }
    est.ceil() as usize
}

/// A non-cryptographic content hash — enough to detect a changed chunk so we skip
/// re-embedding unchanged text. Not used for any security decision.
pub fn content_hash(s: &str) -> u64 {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

/// Emit `text` as one chunk, or as several if it is longer than `CHUNK_TOKENS`.
///
/// The hard split is what keeps `chunk_page`'s size promise. Splitting on
/// headings and blank lines only bounds a chunk when the text *has* those:
/// a page written as one long unbroken paragraph — ordinary in Korean prose,
/// and in any wall-of-text note — used to come back out at whatever length it
/// went in at. That silently broke the embed path, which cannot pool a sequence
/// past its ubatch.
///
/// Prefers to break at whitespace so a chunk does not end mid-word, and falls
/// back to the nearest char boundary when there is no whitespace to use (CJK
/// text often has none for long stretches). Never splits inside a codepoint.
fn push_bounded(out: &mut Vec<String>, text: &str) {
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    if est_tokens(text) <= CHUNK_TOKENS {
        out.push(text.to_string());
        return;
    }
    let mut rest = text;
    while est_tokens(rest) > CHUNK_TOKENS {
        // Walk chars until the token budget is spent — the byte offset of that
        // point is the split candidate (never inside a codepoint by
        // construction).
        let mut est = 0f32;
        let mut end = rest.len();
        for (i, c) in rest.char_indices() {
            est += match c {
                '\u{AC00}'..='\u{D7A3}'
                | '\u{1100}'..='\u{11FF}'
                | '\u{4E00}'..='\u{9FFF}'
                | '\u{3040}'..='\u{30FF}'
                | '\u{F900}'..='\u{FAFF}' => 1.0,
                _ => 0.25,
            };
            if est > CHUNK_TOKENS as f32 {
                end = i;
                break;
            }
        }
        if end == rest.len() {
            break; // estimate says it now fits — emit below
        }
        // Back off to the last whitespace, unless that leaves a scrap.
        if let Some(ws) = rest[..end].rfind(char::is_whitespace) {
            if est_tokens(&rest[..ws]) >= CHUNK_MIN_TOKENS {
                end = ws;
            }
        }
        // A single codepoint wider than the limit cannot happen, but a boundary
        // search that collapsed to 0 would loop forever — refuse to make no
        // progress.
        if end == 0 {
            break;
        }
        let (head, tail) = rest.split_at(end);
        let head = head.trim();
        if !head.is_empty() {
            out.push(head.to_string());
        }
        rest = tail.trim_start();
    }
    if !rest.trim().is_empty() {
        out.push(rest.trim().to_string());
    }
}

/// Split a markdown page into retrieval-sized chunks. Splits first on ATX headings
/// (`# ...`), then packs paragraphs up to CHUNK_TOKENS, so a chunk stays topically
/// coherent. Frontmatter and code fences are kept inline (cheap; good enough v1).
///
/// Every emitted chunk is at most ~`CHUNK_TOKENS` estimated tokens; see `push_bounded`.
pub fn chunk_page(text: &str) -> Vec<String> {
    // Split into heading-led sections.
    let mut sections: Vec<String> = Vec::new();
    let mut cur = String::new();
    for line in text.lines() {
        if line.starts_with('#') && !cur.trim().is_empty() {
            sections.push(std::mem::take(&mut cur));
        }
        cur.push_str(line);
        cur.push('\n');
    }
    if !cur.trim().is_empty() {
        sections.push(cur);
    }
    // Pack/emit each section under CHUNK_TOKENS, splitting big ones on blank lines.
    let mut out: Vec<String> = Vec::new();
    for sec in sections {
        if est_tokens(&sec) <= CHUNK_TOKENS {
            push_bounded(&mut out, &sec);
            continue;
        }
        let mut buf = String::new();
        for para in sec.split("\n\n") {
            if est_tokens(&buf) + est_tokens(para) > CHUNK_TOKENS
                && est_tokens(&buf) >= CHUNK_MIN_TOKENS
            {
                push_bounded(&mut out, &buf);
                buf.clear();
            }
            buf.push_str(para);
            buf.push_str("\n\n");
        }
        // `buf` can still exceed the limit here: a single paragraph longer than
        // CHUNK_CHARS never triggers the flush above (the guard needs a
        // non-scrap `buf` to flush, and an empty one has nothing to give), so it
        // lands here whole. push_bounded is what actually bounds it.
        push_bounded(&mut out, &buf);
    }
    out
}

/// In-place L2 normalization so cosine similarity reduces to a dot product.
pub fn normalize(v: &mut [f32]) {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 1e-8 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}

/// Dot product — cosine similarity for vectors that are *already* L2-normalized,
/// which is what every embed path stores (`embed_ollama` and the bundled model
/// both normalize before the vector reaches the index).
///
/// Worth ~10%, not the multiple the arithmetic suggests: `cosine` reads the same
/// two vectors and only adds two more FMAs per element, so the scan is bound by
/// memory bandwidth rather than by the norms (`cargo bench --bench vector_store`:
/// cosine 1.112 µs vs dot 1.003 µs at 1152d).
///
/// Keeps `cosine`'s length guard. Nothing on today's write paths produces a
/// mismatched width — the tokenizer always emits at least a BOS, so an "empty"
/// text still embeds to a full vector — but the index is a file on disk that can
/// be stale or hand-edited, and scoring 0 beats reading past the end of a
/// vector.
pub fn dot(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut acc = 0.0f32;
    for i in 0..a.len() {
        acc += a[i] * b[i];
    }
    acc
}

/// Cosine similarity of two vectors (dot product if both are already normalized).
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    let denom = (na.sqrt() * nb.sqrt()).max(1e-8);
    dot / denom
}

/// Embed a batch of texts against an Ollama model (`POST /api/embeddings`, one
/// call per text — Ollama's embeddings endpoint takes a single prompt). Returns
/// L2-normalized vectors. Base defaults to the local daemon.
pub async fn embed_ollama(
    base: &str,
    model: &str,
    texts: &[String],
) -> Result<Vec<Vec<f32>>, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let url = format!("{}/api/embeddings", base.trim_end_matches('/'));
    let mut out = Vec::with_capacity(texts.len());
    for t in texts {
        let resp = client
            .post(&url)
            .json(&serde_json::json!({ "model": model, "prompt": t }))
            .send()
            .await
            .map_err(|e| format!("ollama embed request: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("ollama embed status {}", resp.status()));
        }
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("ollama embed decode: {e}"))?;
        let arr = body
            .get("embedding")
            .and_then(|v| v.as_array())
            .ok_or("ollama embed: no 'embedding' in response")?;
        let mut vec: Vec<f32> = arr
            .iter()
            .filter_map(|x| x.as_f64().map(|f| f as f32))
            .collect();
        if vec.is_empty() {
            return Err("ollama embed: empty vector".into());
        }
        normalize(&mut vec);
        out.push(vec);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_split_on_headings() {
        let md = "# A\nalpha text here\n\n# B\nbeta text here\n";
        let c = chunk_page(md);
        assert_eq!(c.len(), 2);
        assert!(c[0].contains("alpha"));
        assert!(c[1].contains("beta"));
    }

    #[test]
    fn chunk_skips_empty() {
        assert!(chunk_page("\n\n   \n").is_empty());
    }

    #[test]
    fn chunk_bounds_an_unbroken_paragraph() {
        // Regression: a page with no headings and no blank lines produced ONE
        // chunk of the whole page — the size limit was only ever enforced
        // between paragraphs, so text without any came back unsplit. A real
        // Korean page did this at 6,419 chars / 1,501 tokens, which then
        // crashed the embed path.
        let wall = "지식 그래프는 노트 사이의 연결을 보여준다. ".repeat(200);
        assert!(
            est_tokens(&wall) > CHUNK_TOKENS * 3,
            "fixture must exceed the limit"
        );
        let chunks = chunk_page(&wall);
        assert!(chunks.len() > 1);
        for c in &chunks {
            assert!(
                est_tokens(c) <= CHUNK_TOKENS + 8,
                "chunk of ~{} tokens exceeds limit",
                est_tokens(c)
            );
        }
        // No text is dropped on the floor.
        let rejoined: String = chunks
            .join(" ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let original: String = wall.split_whitespace().collect::<Vec<_>>().join(" ");
        assert_eq!(rejoined, original);
    }

    #[test]
    fn chunk_never_splits_a_codepoint() {
        // A hard split at a byte offset would corrupt multi-byte text; every
        // chunk must be valid UTF-8 that round-trips.
        let wall = "한국어".repeat(3000); // no whitespace at all to back off to
        let chunks = chunk_page(&wall);
        assert!(chunks.len() > 1);
        for c in &chunks {
            assert!(est_tokens(c) <= CHUNK_TOKENS + 8);
            assert!(!c.contains('\u{FFFD}'));
        }
        assert_eq!(chunks.concat(), wall);
    }

    #[test]
    fn chunk_bounds_long_paragraphs_within_a_section() {
        // Same failure one level in: a heading section whose single paragraph
        // is oversized.
        let para = "wiki knowledge graph note ".repeat(200);
        let md = format!("# Title\n{para}\n\n# Other\nshort body\n");
        let chunks = chunk_page(&md);
        for c in &chunks {
            assert!(
                est_tokens(c) <= CHUNK_TOKENS + 8,
                "chunk of ~{} tokens exceeds limit",
                est_tokens(c)
            );
        }
        assert!(chunks.iter().any(|c| c.contains("short body")));
    }

    #[test]
    fn chunk_prefers_whitespace_breaks() {
        let words = "alpha ".repeat(1000);
        for c in chunk_page(&words) {
            // Backing off to whitespace means no chunk ends mid-word.
            assert!(
                !c.ends_with("alp") && !c.ends_with("alph"),
                "split mid-word: {c:?}"
            );
        }
    }

    #[test]
    fn cosine_identical_is_one() {
        let a = vec![1.0, 2.0, 3.0];
        assert!((cosine(&a, &a) - 1.0).abs() < 1e-5);
    }

    #[test]
    fn cosine_orthogonal_is_zero() {
        assert!(cosine(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-6);
    }

    #[test]
    fn cosine_dim_mismatch_is_zero() {
        assert_eq!(cosine(&[1.0], &[1.0, 2.0]), 0.0);
    }

    #[test]
    fn normalize_unit_length() {
        let mut v = vec![3.0, 4.0];
        normalize(&mut v);
        let n = (v[0] * v[0] + v[1] * v[1]).sqrt();
        assert!((n - 1.0).abs() < 1e-6);
    }

    #[test]
    fn content_hash_changes_with_text() {
        assert_ne!(content_hash("a"), content_hash("b"));
        assert_eq!(content_hash("same"), content_hash("same"));
    }
}

#[cfg(test)]
mod token_budget_tests {
    use super::*;

    #[test]
    fn korean_counts_a_token_per_syllable_and_ascii_a_quarter() {
        assert_eq!(est_tokens("가나다라"), 4);
        // 8 ASCII chars × 0.25 = 2.
        assert_eq!(est_tokens("abcdefgh"), 2);
        // ceil: one latin char still costs a token.
        assert_eq!(est_tokens("a"), 1);
    }

    #[test]
    fn korean_prose_chunks_stay_under_the_token_budget() {
        // ~1500 Hangul chars in one unbroken paragraph — the exact shape that
        // used to come out as ONE 1.5k-token chunk and allocate a GiB-scale
        // Metal buffer per embed call.
        let prose = "가나다라마바사아자차카타파하".repeat(110);
        assert!(est_tokens(&prose) > 1000);
        let chunks = chunk_page(&prose);
        assert!(chunks.len() >= 4, "split into several: {}", chunks.len());
        for c in &chunks {
            assert!(
                est_tokens(c) <= CHUNK_TOKENS + 8,
                "chunk over budget: {} tokens",
                est_tokens(c)
            );
        }
    }

    #[test]
    fn english_prose_packs_more_characters_per_chunk_than_korean() {
        let en = "the quick brown fox jumps over the lazy dog ".repeat(120); // ~5.3k chars
        let ko = "빠른 갈색 여우가 게으른 개를 뛰어넘는다 ".repeat(120); // ~2.6k chars
        let en_chunks = chunk_page(&en);
        let ko_chunks = chunk_page(&ko);
        let en_avg = en.len() / en_chunks.len().max(1);
        let ko_avg = ko.chars().count() / ko_chunks.len().max(1);
        // English fits ~4 chars/token, Korean ~1 — budgets must differ in kind.
        assert!(en_avg > ko_avg, "en {} vs ko {}", en_avg, ko_avg);
        for c in en_chunks.iter().chain(ko_chunks.iter()) {
            assert!(est_tokens(c) <= CHUNK_TOKENS + 8);
        }
    }

    #[test]
    fn short_pages_stay_one_chunk() {
        let chunks = chunk_page("# 제목\n\n짧은 노트.\n");
        assert_eq!(chunks.len(), 1);
    }
}
