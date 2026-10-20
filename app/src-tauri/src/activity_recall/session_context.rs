//! Secondary session statements bound to visible text and rechecked originals.

use super::*;
use crate::local_synthesis::CompiledSession;
use std::collections::HashSet;

const CONTEXT: &str = "<!-- myco:codex-session-context ";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Context {
    version: u8,
    proof_sha256: String,
    claims: Vec<Claim>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Claim {
    kind: QuotePurpose,
    text: String,
    quote_ids: Vec<String>,
}

/// The binding prevents mixing revisions; it does not prove a summary is true.
pub(super) fn bound_context(content: &str) -> Option<Context> {
    if content.matches(CURATED_START).count() != 1 || content.matches(CURATED_END).count() != 1 {
        return None;
    }
    let owned = content
        .split_once(CURATED_START)?
        .1
        .split_once(CURATED_END)?
        .0;
    if owned.matches(CONTEXT).count() != 1 || owned.matches(CURATED_PROOF).count() != 1 {
        return None;
    }
    let context: Context = marker_json(&owned[owned.find(CONTEXT)?..], CONTEXT)?;
    let proof = owned.split_once(CURATED_PROOF)?.1.split_once(" -->")?.0;
    if context.version != 1
        || context.proof_sha256 != format!("{:x}", Sha256::digest(proof.as_bytes()))
        || context.claims.is_empty()
        || context.claims.len() > 16
    {
        return None;
    }
    let proof = curated_proof(content)?;
    if proof.kind != "work" {
        return None;
    }
    let known: HashSet<_> = proof.quotes.iter().map(|quote| quote.id.as_str()).collect();
    if known.len() != proof.quotes.len() {
        return None;
    }
    for claim in &context.claims {
        let ids: HashSet<_> = claim.quote_ids.iter().map(String::as_str).collect();
        if claim.text.trim().is_empty()
            || claim.text.chars().count() > 1600
            || claim.text.contains(['\r', '\n'])
            || ids.is_empty()
            || ids.len() > 32
            || ids.len() != claim.quote_ids.len()
            || !ids.is_subset(&known)
            || !owned.lines().any(|line| {
                line.strip_prefix(&format!("- {} ", claim.text))
                    .is_some_and(|citations| citations.starts_with("[^src-codex-"))
            })
        {
            return None;
        }
    }
    Some(context)
}

/// Retain only statements whose every supporting quote was revalidated and
/// explicitly dated inside the requested period. Organization time is irrelevant.
pub(crate) fn compiled_session(
    content: &str,
    chunks: &[String],
    verified: &[bool],
    range: &DateRange,
    requested_sections: &[usize],
) -> Option<CompiledSession> {
    let context = bound_context(content)?;
    let proof = curated_proof(content)?;
    let mut covered_sections = HashSet::new();
    let eligible: HashSet<_> = proof
        .quotes
        .iter()
        .filter_map(|quote| {
            let timestamp = crate::importers::parse_iso8601(quote.date.as_deref()?)?;
            if !timestamp_in_range(timestamp, range) {
                return None;
            }
            let quote_chunks = chunk_page(&curated_quote_section(content, quote)?);
            if quote_chunks.is_empty() {
                return None;
            }
            let start = chunks
                .windows(quote_chunks.len())
                .position(|window| window == quote_chunks)?;
            let checked = verified
                .get(start..start + quote_chunks.len())?
                .iter()
                .all(|checked| *checked);
            if checked {
                covered_sections.extend(start..start + quote_chunks.len());
            }
            checked.then_some(quote.id.as_str())
        })
        .collect();
    // A later appended original must not disappear behind an older compilation.
    if requested_sections
        .iter()
        .any(|section| !covered_sections.contains(section))
    {
        return None;
    }
    let mut compiled = CompiledSession {
        work: Vec::new(),
        remaining: Vec::new(),
    };
    for claim in context.claims {
        if !claim
            .quote_ids
            .iter()
            .all(|id| eligible.contains(id.as_str()))
        {
            continue;
        }
        match claim.kind {
            QuotePurpose::Work => compiled.work.push(claim.text),
            QuotePurpose::Remaining => compiled.remaining.push(claim.text),
        }
    }
    (!compiled.work.is_empty() || !compiled.remaining.is_empty()).then_some(compiled)
}
