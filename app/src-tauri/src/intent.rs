//! Query-intent detection by embedding similarity.
//!
//! Some questions are not answerable from page CONTENT at all. "which notes did
//! I add today" is answered from file mtimes; no amount of semantic search over
//! the text will produce it. The app used to detect this with a regex list,
//! which missed every phrasing nobody thought to enumerate — "오늘 쌓인 md파일"
//! among them, the reported failure.
//!
//! Instead: embed the question and compare it to a handful of exemplar
//! sentences. The embedder is multilingual (bge-m3), so Korean, English and
//! Japanese phrasings all land near the same exemplars without listing any of
//! them. The exemplars are DATA, and adding one costs a line.
//!
//! Cost: this runs ONLY when retrieval already abstained (see RELEVANCE_FLOOR
//! on the TS side). A question the vault could answer never pays for it.

use std::collections::HashMap;

/// What an intent means for the answer path. Kept deliberately small — one
/// intent that a different data source answers. Adding intents is cheap; adding
/// intents whose answers overlap is how routing becomes unpredictable.
pub const VAULT_FILES: &str = "vault-files";

/// Exemplars per intent, embedded once and cached.
///
/// Phrased as real questions rather than keywords: the query side is a question,
/// and cosine similarity rewards matching shape as well as topic.
pub const EXEMPLARS: &[(&str, &[&str])] = &[(
    VAULT_FILES,
    &[
        "what files did I add recently",
        "which notes changed today",
        "오늘 추가된 노트",
        "최근에 만든 파일 목록",
        "이번 주에 수정한 문서",
        "最近追加したファイル",
        "show me my newest notes",
        "어제 작성한 md 파일",
    ],
)];

/// Cosine an exemplar match must clear before the question is routed away from
/// content search.
///
/// Measured (`examples/intent_probe.rs`) — and RE-measured on every embed-model
/// swap, because the floor lives in that model's cosine geometry. Current
/// calibration (e5-small-ko, the 2026-08 swap):
///
///   time/file questions  n=8   max-cosine 0.538 … 0.779 (median ~0.68)
///   real content questions n=8            0.171 … 0.285
///   off-topic questions  n=3             0.226 … 0.354
///
/// 0.45 is the middle of the empty 0.354–0.538 gap (~0.09 margin both sides).
/// The probe's own sweep: 0.40–0.50 route 8/8 positives with zero negatives;
/// 0.55 already drops one positive, and bge-m3's old 0.65 would drop three.
///
/// CAVEAT, stated because the numbers look better than the evidence: those
/// samples are small, and the content-question set is all one domain (LLM/ML
/// jargon). The margin is why the midpoint was chosen over the edge. Misrouting
/// costs a content question its answer, so widen the negative set before ever
/// lowering this.
pub const INTENT_FLOOR: f32 = 0.45;

/// Every exemplar, flattened, in a fixed order — the order the embedder is
/// handed them and the order [`intent_at`] indexes.
pub fn exemplar_texts() -> Vec<String> {
    EXEMPLARS
        .iter()
        .flat_map(|(_, xs)| xs.iter().map(|s| (*s).to_string()))
        .collect()
}

/// The intent owning the `i`-th text from [`exemplar_texts`].
pub fn intent_at(i: usize) -> Option<&'static str> {
    let mut seen = 0usize;
    for (intent, xs) in EXEMPLARS {
        if i < seen + xs.len() {
            return Some(intent);
        }
        seen += xs.len();
    }
    None
}

/// The winning intent given a per-exemplar similarity, or `None` when nothing
/// clears [`INTENT_FLOOR`]. An intent scores as its BEST exemplar, not its mean:
/// exemplars are alternative phrasings, so matching one is the whole point and
/// averaging would punish an intent for covering many shapes.
///
/// `sims` is parallel to [`exemplar_texts`]; a length mismatch yields `None`
/// rather than a silently-truncated verdict.
pub fn best_intent(sims: &[f32]) -> Option<(&'static str, f32)> {
    if sims.len() != exemplar_texts().len() {
        return None;
    }
    let mut best: HashMap<&'static str, f32> = HashMap::new();
    for (i, &s) in sims.iter().enumerate() {
        let Some(intent) = intent_at(i) else { continue };
        let slot = best.entry(intent).or_insert(f32::MIN);
        if s > *slot {
            *slot = s;
        }
    }
    best.into_iter()
        .filter(|(_, s)| *s >= INTENT_FLOOR)
        // Deterministic on a tie: intent name breaks it, so two intents at the
        // same score never pick differently between runs.
        .max_by(|a, b| {
            a.1.partial_cmp(&b.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.0.cmp(a.0))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intent_at_maps_every_exemplar_index() {
        let texts = exemplar_texts();
        assert!(!texts.is_empty());
        for i in 0..texts.len() {
            assert_eq!(intent_at(i), Some(VAULT_FILES));
        }
        assert_eq!(intent_at(texts.len()), None);
    }

    #[test]
    fn best_intent_takes_the_strongest_exemplar_not_the_mean() {
        // One strong match among many weak ones must still route: exemplars are
        // alternative phrasings, so a mean would bury the hit.
        let mut sims = vec![0.10; exemplar_texts().len()];
        sims[3] = 0.86;
        assert_eq!(best_intent(&sims), Some((VAULT_FILES, 0.86)));
    }

    #[test]
    fn best_intent_rejects_everything_below_the_floor() {
        // The measured content-question ceiling under the current embed model
        // (e5-small-ko: content questions topped out at 0.285) — the case that
        // must NOT route. Re-measure with `examples/intent_probe.rs` on every
        // embed-model swap; the old 0.524 here was bge-m3's ceiling and became
        // a false failure the moment the floor moved to 0.45.
        let sims = vec![0.285; exemplar_texts().len()];
        assert_eq!(best_intent(&sims), None);
    }

    #[test]
    fn best_intent_accepts_exactly_at_the_floor() {
        let sims = vec![INTENT_FLOOR; exemplar_texts().len()];
        assert_eq!(best_intent(&sims), Some((VAULT_FILES, INTENT_FLOOR)));
    }

    #[test]
    fn best_intent_refuses_a_mismatched_similarity_vector() {
        // A short vector means the caller embedded a different exemplar set than
        // the one being indexed — a verdict from that is meaningless.
        assert_eq!(best_intent(&[0.99]), None);
        assert_eq!(best_intent(&[]), None);
    }
}
