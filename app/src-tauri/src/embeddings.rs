//! Text embedding helpers for the semantic layer (Feature 1).
//!
//! Pure, dependency-light building blocks: page chunking, vector math, and an
//! Ollama provider embed call. The bundled-model embed path lives with the model
//! itself (`local_llm::embed`); `commands::embed_texts` dispatches between the
//! two. OpenAI/Google provider paths would slot in there without touching
//! callers.
//!
//! Embedding providers return checked L2-normalized vectors. Generic vector
//! utilities also accept finite nonzero vectors without assuming unit length.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

#[cfg(test)]
#[path = "embeddings_numeric_tests.rs"]
mod numeric_tests;

#[cfg(test)]
#[path = "embeddings_provenance_tests.rs"]
mod provenance_tests;

/// The complete declared representation shared by a checked embedding batch.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmbeddingSpace {
    pub model: String,
    pub signature: String,
    pub dim: usize,
}

impl EmbeddingSpace {
    pub fn validate(&self) -> Result<(), String> {
        if self.model.trim().is_empty() || self.signature.trim().is_empty() || self.dim == 0 {
            return Err("embedding representation identity is incomplete".into());
        }
        u32::try_from(self.dim)
            .map_err(|_| "embedding representation dimension exceeds codec width".to_string())?;
        Ok(())
    }

    pub fn validate_batch(&self, vectors: &[Vec<f32>], count: usize) -> Result<(), String> {
        self.validate()?;
        validate_embedding_batch(vectors, count, Some(self.dim))
    }
}

/// Producer-bound vectors; callers must compare the space before using them.
pub struct EmbeddedBatch {
    pub space: EmbeddingSpace,
    pub vectors: Vec<Vec<f32>>,
}

impl EmbeddedBatch {
    pub fn validate(&self, expected: &EmbeddingSpace, count: usize) -> Result<(), String> {
        if &self.space != expected {
            return Err("embedding batch representation changed".into());
        }
        self.space.validate_batch(&self.vectors, count)
    }
}

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

/// The role markers emitted by every conversation importer. Chunk boundaries
/// and turn-metadata attribution must recognize the same complete set.
pub(crate) fn is_transcript_turn_header(line: &str) -> bool {
    matches!(
        line.trim(),
        "**User:**" | "**Assistant:**" | "**System:**" | "**Tool:**"
    )
}

/// Split a markdown page into retrieval-sized chunks. Splits first on ATX headings
/// (`# ...`), then packs paragraphs up to CHUNK_TOKENS, so a chunk stays topically
/// coherent. Frontmatter is excluded; spoken turns remain separate retrieval sections.
///
/// Every emitted chunk is at most ~`CHUNK_TOKENS` estimated tokens; see `push_bounded`.
pub fn chunk_page(text: &str) -> Vec<String> {
    // NFC before anything else. Indexing hashes/embeds these chunks and
    // `chunk_text_at` re-derives them from the file at query time — both go
    // through here, so normalizing at this one point keeps section indices,
    // content hashes, and phrase comparisons aligned regardless of the form
    // the file was written in (macOS hands back NFD Hangul).
    let normalized = crate::norm::nfc(text);
    // Source metadata (including turn IDs/timestamps) is provenance, not
    // answer evidence. Never let a large frontmatter array displace the body.
    let text = gray_matter::Matter::<gray_matter::engine::YAML>::new()
        .parse::<gray_matter::Pod>(&normalized)
        .map(|parsed| parsed.content)
        .unwrap_or_else(|_| normalized.into_owned());
    // Split into heading- or spoken-turn-led sections.
    let mut sections: Vec<String> = Vec::new();
    let mut cur = String::new();
    for line in text.lines() {
        if (line.starts_with('#') || is_transcript_turn_header(line)) && !cur.trim().is_empty() {
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

/// Index contract: changes to chunk identity or vector aggregation require a rebuild.
pub const INDEX_SIGNATURE: &str =
    "nfc-body-turn-chunk320-v3/token-windows-mean-v3/stable-l2-v1/full-coverage-v1";

/// Split without dropping bytes, using the model tokenizer rather than a character
/// estimate. The counter includes the role prefix and model special tokens.
pub fn token_bounded_windows(
    text: &str,
    limit: usize,
    mut count: impl FnMut(&str) -> Result<usize, String>,
) -> Result<Vec<String>, String> {
    if limit == 0 {
        return Err("embedding token budget is zero".into());
    }
    let mut rest = text;
    let mut windows = Vec::new();
    loop {
        if count(rest)? <= limit {
            windows.push(rest.to_string());
            return Ok(windows);
        }
        let boundaries: Vec<usize> = rest
            .char_indices()
            .map(|(i, _)| i)
            .chain([rest.len()])
            .collect();
        let (mut lo, mut hi) = (1, boundaries.len() - 1);
        let mut end = 0;
        while lo <= hi {
            let mid = lo + (hi - lo) / 2;
            let candidate = boundaries[mid];
            if count(&rest[..candidate])? <= limit {
                end = candidate;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        if end == 0 {
            return Err("one character plus embedding prefix exceeds token budget".into());
        }
        // Prefer a word boundary, but do not create tiny fragments for code/IDs.
        if let Some((i, c)) = rest[..end]
            .char_indices()
            .rev()
            .find(|(_, c)| c.is_whitespace())
        {
            let boundary = i + c.len_utf8();
            if boundary >= end / 2 {
                end = boundary;
            }
        }
        // Token counts need not be monotonic across word merges. Check every
        // emitted window, even after the boundary preference above.
        while count(&rest[..end])? > limit {
            end = rest[..end].char_indices().last().map_or(0, |(i, _)| i);
            if end == 0 {
                return Err("cannot fit an embedding window".into());
            }
        }
        windows.push(rest[..end].to_string());
        rest = &rest[end..];
    }
}

/// Retain low-order terms when signed f64 sums cancel (Neumaier summation).
#[derive(Clone, Copy, Default)]
pub(crate) struct CompensatedSum {
    sum: f64,
    correction: f64,
}

impl CompensatedSum {
    pub(crate) fn add(&mut self, value: f64) {
        let next = self.sum + value;
        self.correction += if self.sum.abs() >= value.abs() {
            (self.sum - next) + value
        } else {
            (value - next) + self.sum
        };
        self.sum = next;
    }

    pub(crate) fn total(self) -> f64 {
        self.sum + self.correction
    }
}

/// Combine bounded windows into their stable parent chunk. A single window
/// returns its existing vector unchanged; all windows participate otherwise.
pub fn combine_window_vectors(vectors: &[Vec<f32>], weights: &[usize]) -> Result<Vec<f32>, String> {
    if vectors.len() != weights.len() || vectors.is_empty() {
        return Err("embedding window count mismatch".into());
    }
    let dim = vectors[0].len();
    for vector in vectors {
        checked_vector_norm(vector, Some(dim))?;
    }
    if vectors.len() == 1 {
        return Ok(vectors[0].clone());
    }
    let total = weights.iter().map(|w| (*w).max(1) as f64).sum::<f64>();
    let mut combined = vec![CompensatedSum::default(); dim];
    for (vector, weight) in vectors.iter().zip(weights) {
        let weight = (*weight).max(1) as f64 / total;
        for (out, value) in combined.iter_mut().zip(vector) {
            out.add(f64::from(*value) * weight);
        }
    }
    let combined: Vec<f64> = combined.into_iter().map(CompensatedSum::total).collect();
    // Normalize before narrowing: a nonzero mean may be below the f32 range.
    let norm = combined
        .iter()
        .map(|value| value * value)
        .sum::<f64>()
        .sqrt();
    if !norm.is_finite() || norm == 0.0 {
        return Err("embedding windows have no finite nonzero aggregate direction".into());
    }
    let output: Vec<f32> = combined
        .into_iter()
        .map(|value| (value / norm) as f32)
        .collect();
    checked_unit_vector(&output, Some(dim))?;
    Ok(output)
}

/// Validate geometry without requiring generic stored vectors to be normalized.
pub(crate) fn checked_vector_norm(
    vector: &[f32],
    expected_dim: Option<usize>,
) -> Result<f64, String> {
    if vector.is_empty() || expected_dim.is_some_and(|dim| dim != vector.len()) {
        return Err("embedding vector dimension mismatch or empty vector".into());
    }
    if vector.iter().any(|value| !value.is_finite()) {
        return Err("embedding vector contains a nonfinite value".into());
    }
    // Widen before multiplication to retain both subnormal and large f32 input.
    let norm = vector
        .iter()
        .map(|value| f64::from(*value).powi(2))
        .sum::<f64>()
        .sqrt();
    if !norm.is_finite() || norm == 0.0 {
        return Err("embedding vector has no finite nonzero norm".into());
    }
    Ok(norm)
}

fn checked_unit_vector(vector: &[f32], expected_dim: Option<usize>) -> Result<(), String> {
    // Allow f32 output rounding; regression oracles use the stricter 1e-6 bound.
    if (checked_vector_norm(vector, expected_dim)? - 1.0).abs() > 1e-5 {
        return Err("embedding output is not L2-normalized".into());
    }
    Ok(())
}

/// Normalize a producer output after validating its complete input geometry.
pub(crate) fn normalize_output(
    vector: &mut [f32],
    expected_dim: Option<usize>,
) -> Result<(), String> {
    let norm = checked_vector_norm(vector, expected_dim)?;
    for value in vector.iter_mut() {
        *value = (f64::from(*value) / norm) as f32;
    }
    checked_unit_vector(vector, expected_dim)
}

/// Check the complete producer batch before exposing any of its vectors.
pub(crate) fn validate_embedding_batch(
    vectors: &[Vec<f32>],
    expected_count: usize,
    expected_dim: Option<usize>,
) -> Result<(), String> {
    if vectors.len() != expected_count {
        return Err("embedding output count mismatch".into());
    }
    let dim = expected_dim.or_else(|| vectors.first().map(Vec::len));
    for vector in vectors {
        checked_unit_vector(vector, dim)?;
    }
    Ok(())
}

/// In-place L2 normalization for legacy generic-vector callers. Invalid inputs
/// remain unchanged; embedding producers must use the checked Result API.
pub fn normalize(vector: &mut [f32]) {
    if let Ok(norm) = checked_vector_norm(vector, None) {
        for value in vector.iter_mut() {
            *value = (f64::from(*value) / norm) as f32;
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

/// Cosine for finite nonzero vectors, with explicit errors for invalid geometry.
pub fn checked_cosine(a: &[f32], b: &[f32]) -> Result<f32, String> {
    let na = checked_vector_norm(a, None)?;
    let nb = checked_vector_norm(b, Some(a.len()))?;
    let mut dot = CompensatedSum::default();
    for (a, b) in a.iter().zip(b) {
        dot.add(f64::from(*a) * f64::from(*b));
    }
    let score = dot.total() / (na * nb);
    if !score.is_finite() {
        return Err("embedding cosine is not finite".into());
    }
    // Clamp only floating-point rounding at the mathematical cosine bounds.
    Ok(score.clamp(-1.0, 1.0) as f32)
}

/// Legacy cosine utility: invalid geometry retains the historical zero result.
/// Semantic decisions must use `checked_cosine` and propagate its error.
pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    checked_cosine(a, b).unwrap_or(0.0)
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
        .redirect(reqwest::redirect::Policy::none())
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
            .map(|value| {
                value
                    .as_f64()
                    .map(|number| number as f32)
                    .ok_or_else(|| "ollama embed: nonnumeric vector element".to_string())
            })
            .collect::<Result<_, _>>()?;
        normalize_output(&mut vec, out.first().map(Vec::len))?;
        out.push(vec);
    }
    Ok(out)
}

fn ollama_tag_name(model: &str) -> String {
    if model
        .rsplit('/')
        .next()
        .is_some_and(|name| name.contains(':'))
    {
        model.to_string()
    } else {
        format!("{model}:latest")
    }
}

/// Resolve the selected local tag to its manifest digest, rejecting ambiguity.
pub(crate) fn ollama_digest_from_tags(
    body: &serde_json::Value,
    model: &str,
) -> Result<String, String> {
    let models = body["models"]
        .as_array()
        .ok_or("ollama model inventory is malformed")?;
    let selected = ollama_tag_name(model);
    let mut matches = models.iter().filter(|entry| {
        entry["name"]
            .as_str()
            .is_some_and(|name| ollama_tag_name(name) == selected)
    });
    let entry = matches
        .next()
        .ok_or("selected ollama model is unavailable")?;
    if matches.next().is_some() {
        return Err("selected ollama model tag is ambiguous".into());
    }
    let digest = entry["digest"]
        .as_str()
        .filter(|digest| digest.len() == 64 && digest.bytes().all(|c| c.is_ascii_hexdigit()))
        .ok_or("selected ollama model has no valid manifest digest")?;
    Ok(digest.to_ascii_lowercase())
}

/// Read identity metadata only; no prompt or vault bytes are sent to this route.
async fn ollama_identity_metadata(base: &str, route: &str) -> Result<serde_json::Value, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("ollama identity client: {e}"))?;
    let response = client
        .get(format!("{}{route}", base.trim_end_matches('/')))
        .send()
        .await
        .map_err(|e| format!("ollama identity request: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("ollama identity status {}", response.status()));
    }
    response
        .json()
        .await
        .map_err(|e| format!("ollama identity decode: {e}"))
}

pub(crate) async fn ollama_model_digest(base: &str, model: &str) -> Result<String, String> {
    ollama_digest_from_tags(&ollama_identity_metadata(base, "/api/tags").await?, model)
}

/// Include the daemon runtime in cache identity, not just its selected tag.
pub(crate) async fn ollama_runtime_version(base: &str) -> Result<String, String> {
    let body = ollama_identity_metadata(base, "/api/version").await?;
    body["version"]
        .as_str()
        .filter(|version| {
            !version.is_empty()
                && version.len() <= 128
                && version
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b".-_+".contains(&c))
        })
        .map(str::to_owned)
        .ok_or_else(|| "ollama runtime version is malformed".into())
}

#[cfg(test)]
mod tests {
    #[test]
    fn actual_token_windows_preserve_code_ids_and_unicode_tail() {
        let text = format!(
            "{} TAIL_REQUEST_8F27 끝까지",
            "abc_한국어_identifier ".repeat(30)
        );
        let windows =
            super::token_bounded_windows(&text, 24, |s| Ok(s.chars().count() + 3)).unwrap();
        assert!(windows.len() > 1);
        assert_eq!(windows.concat(), text);
        assert!(windows.iter().all(|s| s.chars().count() + 3 <= 24));
        assert!(windows.last().unwrap().contains("끝까지"));
    }

    #[test]
    fn short_window_is_unchanged_and_weighted_tail_changes_vector() {
        let vector = vec![0.6, 0.8];
        assert_eq!(
            super::combine_window_vectors(std::slice::from_ref(&vector), &[12]).unwrap(),
            vector
        );
        let both =
            super::combine_window_vectors(&[vec![1.0, 0.0], vec![0.0, 1.0]], &[3, 1]).unwrap();
        assert!(both[1] > 0.3 && both[0] > 0.9);
        assert!((both.iter().map(|x| x * x).sum::<f32>() - 1.0).abs() < 1e-6);
        assert!(super::combine_window_vectors(&[vec![f32::NAN]], &[1]).is_err());
    }

    #[test]
    fn frontmatter_metadata_never_displaces_spoken_turns() {
        let content = format!("---\nturn_metadata: [{}]\n---\n\n# Session\n\n**User:**\n\nfirst spoken question\n\n**Assistant:**\n\nsecond spoken answer\n", "{} ,".repeat(500).trim_end_matches(','));
        let chunks = super::chunk_page(&content);
        assert_eq!(chunks.len(), 3);
        assert!(!chunks.iter().any(|c| c.contains("turn_metadata")));
        assert!(chunks[1].contains("first spoken") && chunks[2].contains("second spoken"));
    }

    #[test]
    fn all_imported_roles_remain_separate_retrieval_sections() {
        let content = "# Session\n\n**System:**\n\nSYSTEM_EVENT\n\n**User:**\n\nUSER_EVENT\n\n**Tool:**\n\nTOOL_EVENT\n\n**Assistant:**\n\nASSISTANT_EVENT\n";
        let chunks = super::chunk_page(content);
        assert_eq!(chunks.len(), 5);
        for (chunk, event) in chunks.iter().skip(1).zip([
            "SYSTEM_EVENT",
            "USER_EVENT",
            "TOOL_EVENT",
            "ASSISTANT_EVENT",
        ]) {
            assert!(chunk.contains(event));
            assert_eq!(chunk.matches("_EVENT").count(), 1);
        }
    }

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

    #[test]
    fn nfd_and_nfc_pages_chunk_identically() {
        // Same page in composed and decomposed form must produce the same
        // chunks — indexing hashes these and `chunk_text_at` re-derives them
        // at query time, so any divergence is a silent retrieval miss.
        let nfc = "# 한글 제목\n\n한글 본문입니다.\n";
        let nfd = "# \u{1112}\u{1161}\u{11AB}\u{1100}\u{1173}\u{11AF} \
                   \u{110C}\u{1166}\u{1106}\u{1169}\u{11A8}\n\n\
                   \u{1112}\u{1161}\u{11AB}\u{1100}\u{1173}\u{11AF} 본문입니다.\n";
        assert_eq!(chunk_page(nfd), chunk_page(nfc));
    }
}
