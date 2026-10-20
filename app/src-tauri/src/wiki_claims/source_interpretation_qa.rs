//! QA-only interpretation over complete supplied spans, never semantic approval.

use super::{check_actor, check_time, compatible_status, sha256, SourceSet, SourceSpan};
use crate::{retrieval::Scope, vault_session::AgentVaultSession};
use std::collections::HashSet;

#[path = "source_interpretation_qa/grammar.rs"]
mod grammar;
#[path = "source_interpretation_qa/prompt.rs"]
mod prompt;
#[path = "source_interpretation_qa/types.rs"]
mod types;
pub use types::{
    AssertionKindQa, BoundFocusQa, BoundInterpretationQa, BoundInterpretationsQa, BoundUnitQa,
    RelevanceQa,
};
use types::{InterpretationProposalQa, OutputQa};

#[cfg(feature = "native-index-probe")]
#[path = "source_interpretation_qa/candidates.rs"]
mod candidates;
#[cfg(feature = "native-index-probe")]
pub use candidates::{
    prepare_candidate, BoundCandidateQa, CandidateDecoderQa, CandidateQa, PreparedCandidateQa,
};

const VERSION: &str = "NativeSourceInterpretationQaV1";
const MAX_UNITS: usize = 16;
const MAX_INTERPRETATIONS: usize = 16;
const MAX_FOCUS_SCALARS: usize = 2048;

/// A decoder count can only be obtained from a prepared captured QA input.
/// It cannot issue source, role, review or publication authority.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct QaUnitCount(usize);

impl QaUnitCount {
    pub fn units(self) -> usize {
        self.0
    }

    pub fn grammar(self) -> String {
        grammar::grammar(self.0)
    }
}

/// Own the exact input graph before generation. Pure capture does not read disk
/// or authenticate a live native opening; the caller admits whole-unit lineage.
pub struct PreparedQa {
    sources: SourceSet,
    origin: AgentVaultSession,
    scope: Scope,
    user: String,
    count: QaUnitCount,
}

/// Preserve every byte of every supplied original span. No action projection,
/// punctuation split, windowing or prefix truncation occurs at this boundary.
/// Full-file/whole-turn admission and actual tokenizer fit remain caller duties.
pub fn prepare(
    sources: &SourceSet,
    origin: &AgentVaultSession,
    scope: Scope,
) -> Result<PreparedQa, String> {
    check_context(sources, origin, scope)?;
    let spans: Vec<_> = sources.spans().collect();
    if !(1..=MAX_UNITS).contains(&spans.len()) {
        return Err("source interpretation QA requires 1 to 16 original units".into());
    }
    for span in &spans {
        if span.end().checked_sub(span.start()) != Some(span.text().len())
            || sha256(span.text().as_bytes()) != span.span_sha256()
        {
            return Err("source interpretation QA original coordinates or SHA changed".into());
        }
    }
    let user = serde_json::to_string(&serde_json::json!({
        "version": "NativeSourceInterpretationQaInputV1",
        "originalSpans": spans,
        "independentVerificationReceipts": [],
    }))
    .map_err(|error| format!("serialize source interpretation QA input: {error}"))?;
    Ok(PreparedQa {
        sources: sources.clone(),
        origin: origin.clone(),
        scope,
        user,
        count: QaUnitCount(spans.len()),
    })
}

impl PreparedQa {
    pub fn count(&self) -> QaUnitCount {
        self.count
    }

    pub fn user(&self) -> &str {
        &self.user
    }

    pub fn system(&self) -> &'static str {
        prompt::SYSTEM
    }

    /// Bind only to this captured graph and the same caller-supplied context.
    /// Successful binding is not original-source meaning or a useful-answer grade.
    pub fn validate(
        &self,
        output: &str,
        current_origin: &AgentVaultSession,
        current_scope: Scope,
    ) -> Result<BoundInterpretationsQa, String> {
        check_context(&self.sources, current_origin, current_scope)?;
        if output.len() > super::MAX_OUTPUT_BYTES {
            return Err("source interpretation QA output exceeds bounds".into());
        }
        let batch: OutputQa = serde_json::from_str(output)
            .map_err(|error| format!("invalid source interpretation QA JSON: {error}"))?;
        if batch.version != VERSION || batch.units.len() != self.count.units() {
            return Err("source interpretation QA version or exact unit count changed".into());
        }
        if batch
            .units
            .iter()
            .map(|unit| unit.interpretations.len())
            .sum::<usize>()
            > MAX_INTERPRETATIONS
        {
            return Err("source interpretation QA exceeds 16 total interpretations".into());
        }
        let mut units = Vec::with_capacity(self.count.units());
        for (original, proposal) in self.sources.spans().zip(batch.units) {
            if (proposal.relevance == RelevanceQa::Relevant) == proposal.interpretations.is_empty()
            {
                return Err(
                    "source interpretation QA relevance and interpretations disagree".into(),
                );
            }
            let mut identities = HashSet::new();
            let mut interpretations = Vec::with_capacity(proposal.interpretations.len());
            for interpretation in proposal.interpretations {
                if !identities.insert(interpretation_identity(&interpretation)?) {
                    return Err("source interpretation QA duplicated an interpretation".into());
                }
                interpretations.push(bind_interpretation(
                    &self.sources,
                    original,
                    interpretation,
                )?);
            }
            units.push(BoundUnitQa {
                original: original.clone(),
                relevance: proposal.relevance,
                interpretations,
            });
        }
        Ok(BoundInterpretationsQa {
            version: VERSION,
            input_sha256: sha256(self.user.as_bytes()),
            origin: self.origin.clone(),
            scope: self.scope,
            units,
            binding_checked: true,
            semantic_review_required: true,
            native_io_authenticated: false,
            semantic_accepted: false,
            production_accepted: false,
        })
    }
}

fn check_context(
    sources: &SourceSet,
    origin: &AgentVaultSession,
    scope: Scope,
) -> Result<(), String> {
    sources
        .validate(
            r#"{"outcome":"insufficient_evidence","claims":[]}"#,
            origin,
            scope,
        )
        .map(|_| ())
}

fn interpretation_identity(proposal: &InterpretationProposalQa) -> Result<String, String> {
    let mut value = serde_json::to_value(proposal)
        .map_err(|error| format!("serialize QA interpretation identity: {error}"))?;
    let mut supports = proposal.support_span_ids.clone();
    supports.sort();
    value["supportSpanIds"] = serde_json::json!(supports);
    serde_json::to_string(&value)
        .map_err(|error| format!("serialize QA interpretation identity: {error}"))
}

fn bind_interpretation(
    sources: &SourceSet,
    original: &SourceSpan,
    proposal: InterpretationProposalQa,
) -> Result<BoundInterpretationQa, String> {
    if proposal.focus_quote.trim().is_empty()
        || proposal.focus_quote.chars().count() > MAX_FOCUS_SCALARS
        || proposal.support_span_ids.is_empty()
        || proposal.support_span_ids.len() > super::MAX_SUPPORTS
        || super::unique_count(&proposal.support_span_ids) != proposal.support_span_ids.len()
        || !proposal
            .support_span_ids
            .iter()
            .any(|id| id == original.id())
    {
        return Err("source interpretation QA focus or support bounds are invalid".into());
    }
    if proposal.status.is_verified() || proposal.verification_id.is_some() {
        return Err("source interpretation QA verification is forbidden".into());
    }
    let supports = proposal
        .support_span_ids
        .iter()
        .map(|id| {
            sources
                .spans()
                .find(|span| span.id() == id)
                .cloned()
                .ok_or("source interpretation QA references an unselected original span")
        })
        .collect::<Result<Vec<_>, _>>()?;
    let focus = bind_focus(original, &proposal.focus_quote)?;
    let actor = proposal.actor.into_native();
    let event_time = proposal.event_time.into_native();
    check_actor(&actor, original, &supports)?;
    check_time(&event_time, &supports)?;
    if !compatible_status(proposal.speech_act, proposal.status) {
        return Err("source interpretation QA speech act and status disagree".into());
    }
    Ok(BoundInterpretationQa {
        focus_quote: proposal.focus_quote,
        focus,
        support_span_ids: proposal.support_span_ids,
        actor,
        event_time,
        speech_act: proposal.speech_act,
        status: proposal.status,
        assertion_kind: proposal.assertion_kind,
        verification_id: proposal.verification_id,
    })
}

fn bind_focus(original: &SourceSpan, focus: &str) -> Result<BoundFocusQa, String> {
    // Count overlapping UTF-8 starts; repeated text cannot choose native offsets.
    let mut occurrences = original.text().char_indices().filter_map(|(offset, _)| {
        original.text()[offset..]
            .starts_with(focus)
            .then_some(offset)
    });
    let offset = occurrences
        .next()
        .ok_or("source interpretation QA focus must occur exactly once in its original unit")?;
    if occurrences.next().is_some() {
        return Err(
            "source interpretation QA focus must occur exactly once in its original unit".into(),
        );
    }
    let start = original
        .start()
        .checked_add(offset)
        .ok_or("source interpretation QA focus coordinates overflow")?;
    let end = start
        .checked_add(focus.len())
        .filter(|end| *end <= original.end())
        .ok_or("source interpretation QA focus exceeds its original unit")?;
    Ok(BoundFocusQa {
        start,
        end,
        sha256: sha256(focus.as_bytes()),
    })
}

#[cfg(test)]
#[path = "source_interpretation_qa/tests.rs"]
mod tests;
