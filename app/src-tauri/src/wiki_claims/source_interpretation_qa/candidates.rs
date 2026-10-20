//! Closed QA candidates alter one representation boundary, never V1 custody.

use super::{
    bind_interpretation, check_context, interpretation_identity, prepare, sha256, AssertionKindQa,
    PreparedQa, RelevanceQa, SourceSet,
};
use crate::{retrieval::Scope, vault_session::AgentVaultSession};
use std::collections::HashSet;

#[path = "candidates_grammar.rs"]
mod grammar;
#[path = "candidates_prompt.rs"]
mod prompt;
#[path = "candidate_types.rs"]
mod types;
pub use types::BoundCandidateQa;
use types::{
    FacetBoundQa, FacetBoundUnitQa, FacetProposalQa, FacetsBoundQa, FacetsOutputQa, OrdinalBoundQa,
    OrdinalBoundUnitQa, OrdinalOutputQa,
};

/// Explicit QA variants, absent from a normal product build.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CandidateQa {
    FacetsV2,
    OrdinalV3,
}

impl CandidateQa {
    pub(crate) fn system(self) -> String {
        prompt::system(self)
    }

    pub fn output_version(self) -> &'static str {
        match self {
            Self::FacetsV2 => "NativeSourceInterpretationFacetsQaV2",
            Self::OrdinalV3 => "NativeSourceInterpretationOrdinalQaV3",
        }
    }

    pub fn input_version(self) -> &'static str {
        match self {
            Self::FacetsV2 => "NativeSourceInterpretationFacetsQaInputV2",
            Self::OrdinalV3 => "NativeSourceInterpretationOrdinalQaInputV3",
        }
    }
}

/// Only a prepared capture issues the count/variant admitted by the decoder.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CandidateDecoderQa {
    units: usize,
    variant: CandidateQa,
}

impl CandidateDecoderQa {
    pub fn units(self) -> usize {
        self.units
    }

    pub fn variant(self) -> CandidateQa {
        self.variant
    }

    pub fn grammar(self) -> String {
        grammar::grammar(self.units, self.variant)
    }
}

pub struct PreparedCandidateQa {
    original: PreparedQa,
    user: String,
    system: String,
    decoder: CandidateDecoderQa,
}

/// Retain the unchanged V1 capture checks and complete supplied originals.
/// A candidate is not a native opening grant or an independent meaning review.
pub fn prepare_candidate(
    sources: &SourceSet,
    origin: &AgentVaultSession,
    scope: Scope,
    variant: CandidateQa,
) -> Result<PreparedCandidateQa, String> {
    let original = prepare(sources, origin, scope)?;
    let spans = match variant {
        CandidateQa::FacetsV2 => serde_json::to_value(sources.spans().collect::<Vec<_>>()),
        CandidateQa::OrdinalV3 => serde_json::to_value(
            sources
                .spans()
                .enumerate()
                .map(|(unit_ordinal, original)| {
                    serde_json::json!({"unitOrdinal": unit_ordinal, "original": original})
                })
                .collect::<Vec<_>>(),
        ),
    }
    .map_err(|error| format!("serialize source interpretation candidate originals: {error}"))?;
    let user = serde_json::to_string(&serde_json::json!({
        "version": variant.input_version(),
        "originalSpans": spans,
        "independentVerificationReceipts": [],
    }))
    .map_err(|error| format!("serialize source interpretation candidate input: {error}"))?;
    let decoder = CandidateDecoderQa {
        units: original.count().units(),
        variant,
    };
    Ok(PreparedCandidateQa {
        original,
        user,
        system: prompt::system(variant),
        decoder,
    })
}

impl PreparedCandidateQa {
    pub fn system(&self) -> &str {
        &self.system
    }

    pub fn user(&self) -> &str {
        &self.user
    }

    pub fn count(&self) -> CandidateDecoderQa {
        self.decoder
    }

    pub fn variant(&self) -> CandidateQa {
        self.decoder.variant()
    }

    pub fn validate(
        &self,
        output: &str,
        current_origin: &AgentVaultSession,
        current_scope: Scope,
    ) -> Result<BoundCandidateQa, String> {
        check_context(&self.original.sources, current_origin, current_scope)?;
        if output.len() > super::super::MAX_OUTPUT_BYTES {
            return Err("source interpretation candidate output exceeds bounds".into());
        }
        match self.variant() {
            CandidateQa::FacetsV2 => {
                let batch: FacetsOutputQa = serde_json::from_str(output).map_err(|error| {
                    format!("invalid source interpretation candidate JSON: {error}")
                })?;
                self.validate_facets(batch)
            }
            CandidateQa::OrdinalV3 => {
                let batch: OrdinalOutputQa = serde_json::from_str(output).map_err(|error| {
                    format!("invalid source interpretation candidate JSON: {error}")
                })?;
                self.validate_ordinals(batch)
            }
        }
    }

    fn check_batch(
        &self,
        version: &str,
        unit_count: usize,
        interpretations: usize,
    ) -> Result<(), String> {
        if version != self.variant().output_version() || unit_count != self.decoder.units() {
            return Err(
                "source interpretation candidate version or exact unit count changed".into(),
            );
        }
        if interpretations > super::MAX_INTERPRETATIONS {
            return Err("source interpretation candidate exceeds 16 total interpretations".into());
        }
        Ok(())
    }

    fn validate_facets(&self, batch: FacetsOutputQa) -> Result<BoundCandidateQa, String> {
        self.check_batch(
            &batch.version,
            batch.units.len(),
            batch
                .units
                .iter()
                .map(|unit| unit.interpretations.len())
                .sum(),
        )?;
        let mut units = Vec::with_capacity(self.decoder.units());
        for (original, proposal) in self.original.sources.spans().zip(batch.units) {
            check_relevance(proposal.relevance, proposal.interpretations.len())?;
            let mut identities = HashSet::new();
            let mut interpretations = Vec::with_capacity(proposal.interpretations.len());
            for interpretation in proposal.interpretations {
                check_facets(&interpretation.assertion_kinds)?;
                if !identities.insert(facet_identity(&interpretation)?) {
                    return Err(
                        "source interpretation candidate duplicated an interpretation".into(),
                    );
                }
                let (common, assertion_kinds) = interpretation.into_common()?;
                let bound = bind_interpretation(&self.original.sources, original, common)?;
                // Copy shared checked fields explicitly: no temporary single
                // assertionKind is retained in the facet binding or its JSON.
                interpretations.push(FacetBoundQa {
                    focus_quote: bound.focus_quote,
                    focus: bound.focus,
                    support_span_ids: bound.support_span_ids,
                    actor: bound.actor,
                    event_time: bound.event_time,
                    speech_act: bound.speech_act,
                    status: bound.status,
                    assertion_kinds,
                    verification_id: bound.verification_id,
                });
            }
            units.push(FacetBoundUnitQa {
                original: original.clone(),
                relevance: proposal.relevance,
                interpretations,
            });
        }
        Ok(BoundCandidateQa::Facets(FacetsBoundQa {
            version: self.variant().output_version(),
            input_sha256: sha256(self.user.as_bytes()),
            origin: self.original.origin.clone(),
            scope: self.original.scope,
            units,
            binding_checked: true,
            semantic_review_required: true,
            native_io_authenticated: false,
            semantic_accepted: false,
            production_accepted: false,
        }))
    }

    fn validate_ordinals(&self, batch: OrdinalOutputQa) -> Result<BoundCandidateQa, String> {
        self.check_batch(
            &batch.version,
            batch.units.len(),
            batch
                .units
                .iter()
                .map(|unit| unit.interpretations.len())
                .sum(),
        )?;
        let mut units = Vec::with_capacity(self.decoder.units());
        for (ordinal, (original, proposal)) in
            self.original.sources.spans().zip(batch.units).enumerate()
        {
            if proposal.unit_ordinal != ordinal {
                return Err("source interpretation candidate exact unit ordinal changed".into());
            }
            check_relevance(proposal.relevance, proposal.interpretations.len())?;
            let mut identities = HashSet::new();
            let mut interpretations = Vec::with_capacity(proposal.interpretations.len());
            for interpretation in proposal.interpretations {
                if !identities.insert(interpretation_identity(&interpretation)?) {
                    return Err(
                        "source interpretation candidate duplicated an interpretation".into(),
                    );
                }
                interpretations.push(bind_interpretation(
                    &self.original.sources,
                    original,
                    interpretation,
                )?);
            }
            units.push(OrdinalBoundUnitQa {
                unit_ordinal: ordinal,
                original: original.clone(),
                relevance: proposal.relevance,
                interpretations,
            });
        }
        Ok(BoundCandidateQa::Ordinal(OrdinalBoundQa {
            version: self.variant().output_version(),
            input_sha256: sha256(self.user.as_bytes()),
            origin: self.original.origin.clone(),
            scope: self.original.scope,
            units,
            binding_checked: true,
            semantic_review_required: true,
            native_io_authenticated: false,
            semantic_accepted: false,
            production_accepted: false,
        }))
    }
}

fn check_relevance(relevance: RelevanceQa, count: usize) -> Result<(), String> {
    if (relevance == RelevanceQa::Relevant) == (count == 0) {
        return Err(
            "source interpretation candidate relevance and interpretations disagree".into(),
        );
    }
    Ok(())
}

fn check_facets(kinds: &[AssertionKindQa]) -> Result<(), String> {
    if !(1..=5).contains(&kinds.len())
        || kinds
            .iter()
            .enumerate()
            .any(|(index, kind)| kinds[..index].contains(kind))
    {
        return Err(
            "source interpretation candidate requires 1 to 5 unique assertion facets".into(),
        );
    }
    Ok(())
}

fn facet_identity(proposal: &FacetProposalQa) -> Result<String, String> {
    let mut value = serde_json::to_value(proposal)
        .map_err(|error| format!("serialize candidate interpretation identity: {error}"))?;
    let mut supports = proposal.support_span_ids.clone();
    supports.sort();
    let mut kinds = proposal.assertion_kinds.clone();
    kinds.sort_by_key(|kind| match kind {
        AssertionKindQa::AssertedOccurrence => 0,
        AssertionKindQa::ExplicitNonoccurrence => 1,
        AssertionKindQa::Intention => 2,
        AssertionKindQa::RecordOrVerificationLimit => 3,
        AssertionKindQa::Uncertain => 4,
    });
    value["supportSpanIds"] = serde_json::json!(supports);
    value["assertionKinds"] = serde_json::json!(kinds);
    serde_json::to_string(&value)
        .map_err(|error| format!("serialize candidate interpretation identity: {error}"))
}

#[cfg(test)]
#[path = "candidate_tests.rs"]
mod tests;
