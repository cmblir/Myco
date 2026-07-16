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

/// Target chunk size in characters (~512 tokens). Sections larger than this are
/// split further on paragraph boundaries so each embedded unit is retrieval-sized.
const CHUNK_CHARS: usize = 1800;
const CHUNK_MIN: usize = 120; // don't emit trailing scraps shorter than this alone

/// A non-cryptographic content hash — enough to detect a changed chunk so we skip
/// re-embedding unchanged text. Not used for any security decision.
pub fn content_hash(s: &str) -> u64 {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

/// Emit `text` as one chunk, or as several if it is longer than `CHUNK_CHARS`.
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
    if text.len() <= CHUNK_CHARS {
        out.push(text.to_string());
        return;
    }
    let mut rest = text;
    while rest.len() > CHUNK_CHARS {
        // Largest char boundary at or before the limit.
        let mut end = CHUNK_CHARS;
        while end > 0 && !rest.is_char_boundary(end) {
            end -= 1;
        }
        // Back off to the last whitespace, unless that leaves a scrap.
        if let Some(ws) = rest[..end].rfind(char::is_whitespace) {
            if ws >= CHUNK_MIN {
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
/// (`# ...`), then packs paragraphs up to CHUNK_CHARS, so a chunk stays topically
/// coherent. Frontmatter and code fences are kept inline (cheap; good enough v1).
///
/// Every emitted chunk is at most `CHUNK_CHARS` bytes; see `push_bounded`.
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
    // Pack/emit each section under CHUNK_CHARS, splitting big ones on blank lines.
    let mut out: Vec<String> = Vec::new();
    for sec in sections {
        if sec.len() <= CHUNK_CHARS {
            push_bounded(&mut out, &sec);
            continue;
        }
        let mut buf = String::new();
        for para in sec.split("\n\n") {
            if buf.len() + para.len() > CHUNK_CHARS && buf.len() >= CHUNK_MIN {
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
        let body: serde_json::Value =
            resp.json().await.map_err(|e| format!("ollama embed decode: {e}"))?;
        let arr = body
            .get("embedding")
            .and_then(|v| v.as_array())
            .ok_or("ollama embed: no 'embedding' in response")?;
        let mut vec: Vec<f32> = arr.iter().filter_map(|x| x.as_f64().map(|f| f as f32)).collect();
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
        assert!(wall.len() > CHUNK_CHARS * 3, "fixture must exceed the limit");
        let chunks = chunk_page(&wall);
        assert!(chunks.len() > 1);
        for c in &chunks {
            assert!(c.len() <= CHUNK_CHARS, "chunk of {} chars exceeds limit", c.len());
        }
        // No text is dropped on the floor.
        let rejoined: String = chunks.join(" ").split_whitespace().collect::<Vec<_>>().join(" ");
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
            assert!(c.len() <= CHUNK_CHARS);
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
            assert!(c.len() <= CHUNK_CHARS, "chunk of {} chars exceeds limit", c.len());
        }
        assert!(chunks.iter().any(|c| c.contains("short body")));
    }

    #[test]
    fn chunk_prefers_whitespace_breaks() {
        let words = "alpha ".repeat(1000);
        for c in chunk_page(&words) {
            // Backing off to whitespace means no chunk ends mid-word.
            assert!(!c.ends_with("alp") && !c.ends_with("alph"), "split mid-word: {c:?}");
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
