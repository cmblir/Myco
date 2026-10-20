//! Separate closed candidate outputs and serialize-only, unreviewed bindings.

use super::super::types::{ActorProposalQa, EventTimeProposalQa, InterpretationProposalQa};
use super::super::{AssertionKindQa, BoundFocusQa, BoundInterpretationQa, RelevanceQa};
use crate::wiki_claims::{ClaimStatus, ProposedActor, ProposedEventTime, SourceSpan, SpeechAct};
use crate::{retrieval::Scope, vault_session::AgentVaultSession};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct FacetsOutputQa {
    pub(super) version: String,
    pub(super) units: Vec<FacetUnitProposalQa>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct FacetUnitProposalQa {
    pub(super) relevance: RelevanceQa,
    pub(super) interpretations: Vec<FacetProposalQa>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct FacetProposalQa {
    pub(super) focus_quote: String,
    pub(super) support_span_ids: Vec<String>,
    pub(super) actor: ActorProposalQa,
    pub(super) event_time: EventTimeProposalQa,
    pub(super) speech_act: SpeechAct,
    pub(super) status: ClaimStatus,
    pub(super) assertion_kinds: Vec<AssertionKindQa>,
    #[serde(deserialize_with = "required_nullable")]
    pub(super) verification_id: Option<String>,
}

impl FacetProposalQa {
    pub(super) fn into_common(
        self,
    ) -> Result<(InterpretationProposalQa, Vec<AssertionKindQa>), String> {
        // The shared binder does not inspect assertion_kind. This temporary
        // value is only for its focus/support/actor/time/status checks.
        let assertion_kind = self
            .assertion_kinds
            .first()
            .copied()
            .ok_or("source interpretation candidate requires assertion facets")?;
        Ok((
            InterpretationProposalQa {
                focus_quote: self.focus_quote,
                support_span_ids: self.support_span_ids,
                actor: self.actor,
                event_time: self.event_time,
                speech_act: self.speech_act,
                status: self.status,
                assertion_kind,
                verification_id: self.verification_id,
            },
            self.assertion_kinds,
        ))
    }
}

fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct OrdinalOutputQa {
    pub(super) version: String,
    pub(super) units: Vec<OrdinalUnitProposalQa>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct OrdinalUnitProposalQa {
    pub(super) unit_ordinal: usize,
    pub(super) relevance: RelevanceQa,
    pub(super) interpretations: Vec<InterpretationProposalQa>,
}

/// Keep the entire emitted facet set; never serialize the temporary V1 kind.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FacetBoundQa {
    pub(super) focus_quote: String,
    pub(super) focus: BoundFocusQa,
    pub(super) support_span_ids: Vec<String>,
    pub(super) actor: ProposedActor,
    pub(super) event_time: ProposedEventTime,
    pub(super) speech_act: SpeechAct,
    pub(super) status: ClaimStatus,
    pub(super) assertion_kinds: Vec<AssertionKindQa>,
    pub(super) verification_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FacetBoundUnitQa {
    pub(super) original: SourceSpan,
    pub(super) relevance: RelevanceQa,
    pub(super) interpretations: Vec<FacetBoundQa>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrdinalBoundUnitQa {
    pub(super) unit_ordinal: usize,
    pub(super) original: SourceSpan,
    pub(super) relevance: RelevanceQa,
    pub(super) interpretations: Vec<BoundInterpretationQa>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FacetsBoundQa {
    pub(super) version: &'static str,
    pub(super) input_sha256: String,
    pub(super) origin: AgentVaultSession,
    pub(super) scope: Scope,
    pub(super) units: Vec<FacetBoundUnitQa>,
    pub(super) binding_checked: bool,
    pub(super) semantic_review_required: bool,
    pub(super) native_io_authenticated: bool,
    pub(super) semantic_accepted: bool,
    pub(super) production_accepted: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrdinalBoundQa {
    pub(super) version: &'static str,
    pub(super) input_sha256: String,
    pub(super) origin: AgentVaultSession,
    pub(super) scope: Scope,
    pub(super) units: Vec<OrdinalBoundUnitQa>,
    pub(super) binding_checked: bool,
    pub(super) semantic_review_required: bool,
    pub(super) native_io_authenticated: bool,
    pub(super) semantic_accepted: bool,
    pub(super) production_accepted: bool,
}

/// Serialization exposes common flags at the top level. No input union,
/// Deserialize, semantic receipt, legacy action or publication conversion exists.
#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum BoundCandidateQa {
    Facets(FacetsBoundQa),
    Ordinal(OrdinalBoundQa),
}
