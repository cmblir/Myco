//! Named syntax copies every declared field into the shared focused tuple.

use super::{Batch, FocusedClaim};
use crate::wiki_claims::source_interpretation_qa::AssertionKindQa;
use crate::wiki_claims::{
    ActorBasis, ActorRole, ClaimStatus, SpeechAct, TimeBasis, TimePrecision, TimeUncertainty,
};
use serde::{Deserialize, Deserializer};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NamedClaim {
    anchor_ordinal: usize,
    focus_quote: String,
    assertion_kind: AssertionKindQa,
    support_ordinals: Vec<usize>,
    actor: NamedActor,
    event_time: NamedTime,
    speech_act: SpeechAct,
    status: ClaimStatus,
    #[serde(deserialize_with = "required_null")]
    verification_id: (),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NamedActor {
    role: ActorRole,
    basis: ActorBasis,
    #[serde(deserialize_with = "required_nullable")]
    subject_ordinal: Option<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NamedTime {
    #[serde(deserialize_with = "required_nullable")]
    value: Option<String>,
    basis: TimeBasis,
    precision: TimePrecision,
    uncertainty: TimeUncertainty,
    #[serde(deserialize_with = "required_nullable")]
    time_support_ordinal: Option<usize>,
}

pub(super) fn parse(raw: &str) -> Result<Batch<FocusedClaim>, String> {
    let shape: serde_json::Value = serde_json::from_str(raw)
        .map_err(|error| format!("invalid complete named source focus QA output: {error}"))?;
    if !shape.is_object()
        || shape["claims"].as_array().map_or(true, |claims| {
            claims.iter().any(|claim| {
                !claim.is_object() || !claim["actor"].is_object() || !claim["eventTime"].is_object()
            })
        })
    {
        return Err(
            "named source focus QA requires closed claim, actor and eventTime objects".into(),
        );
    }
    // Reparse the original bytes: the shape inspection must not erase duplicate
    // JSON keys before serde's typed, required-field checks reject them.
    let batch: Batch<NamedClaim> = serde_json::from_str(raw)
        .map_err(|error| format!("invalid closed named source focus QA output: {error}"))?;
    Ok(Batch {
        version: batch.version,
        packet_sha256: batch.packet_sha256,
        outcome: batch.outcome,
        claims: batch
            .claims
            .into_iter()
            .map(|claim| {
                let () = claim.verification_id;
                FocusedClaim(
                    claim.anchor_ordinal,
                    claim.focus_quote,
                    claim.assertion_kind,
                    claim.support_ordinals,
                    (
                        claim.actor.role,
                        claim.actor.basis,
                        claim.actor.subject_ordinal,
                    ),
                    (
                        claim.event_time.value,
                        claim.event_time.basis,
                        claim.event_time.precision,
                        claim.event_time.uncertainty,
                        claim.event_time.time_support_ordinal,
                    ),
                    claim.speech_act,
                    claim.status,
                    (),
                )
            })
            .collect(),
    })
}

fn required_nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(deserializer)
}

fn required_null<'de, D: Deserializer<'de>>(deserializer: D) -> Result<(), D::Error> {
    <()>::deserialize(deserializer)
}
