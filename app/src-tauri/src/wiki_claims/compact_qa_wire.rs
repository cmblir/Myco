//! Exact tuples project to native proposals without semantic correction.

use super::{Packet, VERSION};
use crate::wiki_claims::{
    ActorBasis, ActorRole, ClaimOutcome, ClaimProposal, ClaimStatus, ProposedActor,
    ProposedEventTime, SpeechAct, TimeBasis, TimePrecision, TimeUncertainty,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Batch {
    version: String,
    packet_sha256: String,
    outcome: ClaimOutcome,
    claims: Vec<Claim>,
}

#[derive(Deserialize, Serialize)]
struct Claim(
    String,
    usize,
    Vec<usize>,
    Actor,
    Time,
    SpeechAct,
    ClaimStatus,
    (),
);

#[derive(Deserialize, Serialize)]
struct Actor(ActorRole, ActorBasis, Option<usize>);

#[derive(Deserialize, Serialize)]
struct Time(
    Option<String>,
    TimeBasis,
    TimePrecision,
    TimeUncertainty,
    Option<usize>,
);

pub(super) fn expand(packet: &Packet, raw: &str) -> Result<String, String> {
    if raw.len() > crate::wiki_claims::MAX_OUTPUT_BYTES {
        return Err("compact QA output exceeds native proposal bounds".into());
    }
    let batch: Batch = serde_json::from_str(raw)
        .map_err(|error| format!("invalid complete compact QA proposal: {error}"))?;
    if batch.version != VERSION || batch.packet_sha256 != packet.decoder.digest_hex() {
        return Err("compact QA version or complete original packet SHA differs".into());
    }
    if batch.claims.len() > crate::wiki_claims::MAX_CLAIMS
        || (batch.outcome == ClaimOutcome::InsufficientEvidence) != batch.claims.is_empty()
    {
        return Err("compact QA outcome and claim count disagree".into());
    }
    let mut seen = HashSet::new();
    let mut proposals = Vec::new();
    for claim in batch.claims {
        let exact = serde_json::to_string(&claim)
            .map_err(|error| format!("capture exact compact QA tuple: {error}"))?;
        if !seen.insert(exact) {
            return Err("compact QA repeats an exact claim tuple".into());
        }
        proposals.push(claim.into_native(&packet.span_ids)?);
    }
    let expanded = serde_json::to_string(&serde_json::json!({
        "outcome":batch.outcome,"claims":proposals,
    }))
    .map_err(|error| format!("serialize compact QA native projection: {error}"))?;
    if expanded.len() > crate::wiki_claims::MAX_OUTPUT_BYTES {
        return Err("compact QA expansion exceeds native proposal bounds".into());
    }
    Ok(expanded)
}

impl Claim {
    fn into_native(self, span_ids: &[String]) -> Result<ClaimProposal, String> {
        let Self(action, anchor, supports, actor, time, speech_act, status, ()) = self;
        if action.trim().is_empty() || action.chars().count() > 512 {
            return Err("compact QA action exceeds native proposal bounds".into());
        }
        if supports.is_empty()
            || supports.len() > crate::wiki_claims::MAX_SUPPORTS
            || supports.iter().collect::<HashSet<_>>().len() != supports.len()
            || !supports.contains(&anchor)
        {
            return Err("compact QA supports are duplicated or lack their anchor".into());
        }
        if status.is_verified() || !crate::wiki_claims::compatible_status(speech_act, status) {
            return Err("compact QA speech act and unverified status disagree".into());
        }
        if actor.2.is_some_and(|ordinal| !supports.contains(&ordinal))
            || time.4.is_some_and(|ordinal| !supports.contains(&ordinal))
        {
            return Err("compact QA actor or time reference is outside its claim supports".into());
        }
        let actor = actor.into_native(span_ids)?;
        let event_time = time.into_native(span_ids)?;
        Ok(ClaimProposal {
            action,
            anchor_span_id: ordinal_id(span_ids, anchor)?,
            support_span_ids: supports
                .into_iter()
                .map(|ordinal| ordinal_id(span_ids, ordinal))
                .collect::<Result<_, _>>()?,
            actor,
            event_time,
            speech_act,
            status,
            verification_id: None,
        })
    }

    fn from_native(proposal: ClaimProposal, span_ids: &[String]) -> Result<Self, String> {
        if proposal.verification_id.is_some() || proposal.status.is_verified() {
            return Err("compact QA cannot encode independent verification".into());
        }
        Ok(Self(
            proposal.action,
            id_ordinal(span_ids, &proposal.anchor_span_id)?,
            proposal
                .support_span_ids
                .iter()
                .map(|id| id_ordinal(span_ids, id))
                .collect::<Result<_, _>>()?,
            Actor(
                proposal.actor.role,
                proposal.actor.basis,
                proposal
                    .actor
                    .subject_span_id
                    .as_deref()
                    .map(|id| id_ordinal(span_ids, id))
                    .transpose()?,
            ),
            Time(
                proposal.event_time.value,
                proposal.event_time.basis,
                proposal.event_time.precision,
                proposal.event_time.uncertainty,
                proposal
                    .event_time
                    .support_span_id
                    .as_deref()
                    .map(|id| id_ordinal(span_ids, id))
                    .transpose()?,
            ),
            proposal.speech_act,
            proposal.status,
            (),
        ))
    }
}

impl Actor {
    fn into_native(self, ids: &[String]) -> Result<ProposedActor, String> {
        let Self(role, basis, subject) = self;
        let valid = match basis {
            ActorBasis::Unknown => role == ActorRole::Unknown && subject.is_none(),
            ActorBasis::Speaker => subject.is_none(),
            ActorBasis::ExplicitSubject => role != ActorRole::Unknown && subject.is_some(),
        };
        if !valid {
            return Err("compact QA actor fields disagree".into());
        }
        Ok(ProposedActor {
            role,
            basis,
            subject_span_id: subject
                .map(|ordinal| ordinal_id(ids, ordinal))
                .transpose()?,
        })
    }
}

impl Time {
    fn into_native(self, ids: &[String]) -> Result<ProposedEventTime, String> {
        let Self(value, basis, precision, uncertainty, support) = self;
        let valid = if basis == TimeBasis::Unknown {
            value.is_none()
                && precision == TimePrecision::Unknown
                && uncertainty == TimeUncertainty::Unknown
                && support.is_none()
        } else {
            let length_valid = value.as_deref().is_some_and(|value| match precision {
                TimePrecision::Day => value.chars().count() == 10,
                TimePrecision::Instant => {
                    let count = value.chars().count();
                    (1..=64).contains(&count) && count != 10
                }
                TimePrecision::Unknown => false,
            });
            length_valid
                && support.is_some()
                && match basis {
                    TimeBasis::Explicit => uncertainty == TimeUncertainty::Specified,
                    TimeBasis::InferredFromTurn | TimeBasis::DateReference => {
                        uncertainty == TimeUncertainty::Inferred
                    }
                    TimeBasis::Unknown => false,
                }
        };
        if !valid {
            return Err("compact QA event time fields disagree".into());
        }
        Ok(ProposedEventTime {
            value,
            basis,
            precision,
            uncertainty,
            support_span_id: support
                .map(|ordinal| ordinal_id(ids, ordinal))
                .transpose()?,
        })
    }
}

fn ordinal_id(ids: &[String], ordinal: usize) -> Result<String, String> {
    ids.get(ordinal)
        .cloned()
        .ok_or_else(|| "compact QA ordinal is outside its captured original dictionary".into())
}

fn id_ordinal(ids: &[String], id: &str) -> Result<usize, String> {
    ids.iter()
        .position(|candidate| candidate == id)
        .ok_or_else(|| "compact QA demonstration references an absent original".into())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NativeBatch {
    outcome: ClaimOutcome,
    claims: Vec<ClaimProposal>,
}

pub(super) fn encode_native(packet: &Packet, raw: &str) -> Result<String, String> {
    let native: NativeBatch = serde_json::from_str(raw)
        .map_err(|error| format!("invalid compact QA demonstration proposal: {error}"))?;
    let claims = native
        .claims
        .into_iter()
        .map(|claim| Claim::from_native(claim, &packet.span_ids))
        .collect::<Result<_, _>>()?;
    let output = serde_json::to_string(&Batch {
        version: VERSION.into(),
        packet_sha256: packet.decoder.digest_hex(),
        outcome: native.outcome,
        claims,
    })
    .map_err(|error| format!("serialize compact QA demonstration tuple: {error}"))?;
    // Demonstrations use the same complete, exact projection as actual output.
    expand(packet, &output)?;
    Ok(output)
}
