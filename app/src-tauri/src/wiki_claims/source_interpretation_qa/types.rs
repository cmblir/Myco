//! QA proposals and read-only bindings; none of these types issue authority.

use super::super::{
    ActorBasis, ActorRole, ClaimStatus, ProposedActor, ProposedEventTime, SourceSpan, SpeechAct,
    TimeBasis, TimePrecision, TimeUncertainty,
};
use crate::{retrieval::Scope, vault_session::AgentVaultSession};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RelevanceQa {
    Relevant,
    NotRelevant,
    Uncertain,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AssertionKindQa {
    AssertedOccurrence,
    ExplicitNonoccurrence,
    Intention,
    RecordOrVerificationLimit,
    Uncertain,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct OutputQa {
    pub(super) version: String,
    pub(super) units: Vec<UnitProposalQa>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct UnitProposalQa {
    pub(super) relevance: RelevanceQa,
    pub(super) interpretations: Vec<InterpretationProposalQa>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct InterpretationProposalQa {
    pub(super) focus_quote: String,
    pub(super) support_span_ids: Vec<String>,
    pub(super) actor: ActorProposalQa,
    pub(super) event_time: EventTimeProposalQa,
    pub(super) speech_act: SpeechAct,
    pub(super) status: ClaimStatus,
    pub(super) assertion_kind: AssertionKindQa,
    #[serde(deserialize_with = "required_nullable")]
    pub(super) verification_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ActorProposalQa {
    role: ActorRole,
    basis: ActorBasis,
    #[serde(deserialize_with = "required_nullable")]
    subject_span_id: Option<String>,
}

impl ActorProposalQa {
    pub(super) fn into_native(self) -> ProposedActor {
        ProposedActor {
            role: self.role,
            basis: self.basis,
            subject_span_id: self.subject_span_id,
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct EventTimeProposalQa {
    #[serde(deserialize_with = "required_nullable")]
    value: Option<String>,
    basis: TimeBasis,
    precision: TimePrecision,
    uncertainty: TimeUncertainty,
    #[serde(deserialize_with = "required_nullable")]
    support_span_id: Option<String>,
}

impl EventTimeProposalQa {
    pub(super) fn into_native(self) -> ProposedEventTime {
        ProposedEventTime {
            value: self.value,
            basis: self.basis,
            precision: self.precision,
            uncertainty: self.uncertainty,
            support_span_id: self.support_span_id,
        }
    }
}

fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

/// Exact coordinates calculated against the retained original, never supplied
/// by model output. An exact focus is not an entailment or coverage receipt.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundFocusQa {
    pub(super) start: usize,
    pub(super) end: usize,
    pub(super) sha256: String,
}

/// The typed judgments remain proposals about the complete original context.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundInterpretationQa {
    pub(super) focus_quote: String,
    pub(super) focus: BoundFocusQa,
    pub(super) support_span_ids: Vec<String>,
    pub(super) actor: ProposedActor,
    pub(super) event_time: ProposedEventTime,
    pub(super) speech_act: SpeechAct,
    pub(super) status: ClaimStatus,
    pub(super) assertion_kind: AssertionKindQa,
    pub(super) verification_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundUnitQa {
    pub(super) original: SourceSpan,
    pub(super) relevance: RelevanceQa,
    pub(super) interpretations: Vec<BoundInterpretationQa>,
}

impl BoundUnitQa {
    pub fn original(&self) -> &SourceSpan {
        &self.original
    }

    pub fn relevance(&self) -> RelevanceQa {
        self.relevance
    }

    pub fn interpretations(&self) -> &[BoundInterpretationQa] {
        &self.interpretations
    }
}

/// Pure source/shape binding only. There is intentionally no Deserialize,
/// CheckedClaims projection, review receipt or publication capability.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundInterpretationsQa {
    pub(super) version: &'static str,
    pub(super) input_sha256: String,
    pub(super) origin: AgentVaultSession,
    pub(super) scope: Scope,
    pub(super) units: Vec<BoundUnitQa>,
    pub(super) binding_checked: bool,
    pub(super) semantic_review_required: bool,
    pub(super) native_io_authenticated: bool,
    pub(super) semantic_accepted: bool,
    pub(super) production_accepted: bool,
}

impl BoundInterpretationsQa {
    pub fn units(&self) -> &[BoundUnitQa] {
        &self.units
    }
}
