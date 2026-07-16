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

/// Split a markdown page into retrieval-sized chunks. Splits first on ATX headings
/// (`# ...`), then packs paragraphs up to CHUNK_CHARS, so a chunk stays topically
/// coherent. Frontmatter and code fences are kept inline (cheap; good enough v1).
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
            let t = sec.trim();
            if !t.is_empty() {
                out.push(t.to_string());
            }
            continue;
        }
        let mut buf = String::new();
        for para in sec.split("\n\n") {
            if buf.len() + para.len() > CHUNK_CHARS && buf.len() >= CHUNK_MIN {
                out.push(buf.trim().to_string());
                buf.clear();
            }
            buf.push_str(para);
            buf.push_str("\n\n");
        }
        let t = buf.trim();
        if !t.is_empty() {
            out.push(t.to_string());
        }
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
/// Keeps `cosine`'s length guard. The guard is not ceremony — the embed path
/// stores an empty vector for a page that tokenizes to nothing, so mismatched
/// widths do reach this function and must score 0 rather than panic.
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
