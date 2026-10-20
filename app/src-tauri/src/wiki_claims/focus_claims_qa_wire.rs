//! Closed focused encodings reuse the same native projection without repair.

use super::{proposal_sha256, AssertionKindQa, Encoding, FocusWitnessQa, Packet};
use crate::wiki_claims::{
    sha256, ActorBasis, ActorRole, ClaimOutcome, ClaimProposal, ClaimStatus, SpeechAct, TimeBasis,
    TimePrecision, TimeUncertainty,
};
use serde::{Deserialize, Serialize};

#[path = "focus_claims_named_qa_wire.rs"]
mod named;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Batch<T> {
    version: String,
    packet_sha256: String,
    outcome: ClaimOutcome,
    claims: Vec<T>,
}

#[derive(Deserialize, Serialize)]
struct FocusedClaim(
    usize,
    String,
    AssertionKindQa,
    Vec<usize>,
    (ActorRole, ActorBasis, Option<usize>),
    (
        Option<String>,
        TimeBasis,
        TimePrecision,
        TimeUncertainty,
        Option<usize>,
    ),
    SpeechAct,
    ClaimStatus,
    (),
);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct NativeProjection {
    pub(super) outcome: ClaimOutcome,
    pub(super) claims: Vec<ClaimProposal>,
}

pub(super) fn validate_originals(packet: &Packet) -> Result<[ActorRole; 8], String> {
    let mut speakers = [ActorRole::Unknown; 8];
    for (index, span) in packet.original_spans().iter().enumerate() {
        let role = span
            .get("speaker")
            .ok_or("source focus QA original speaker is required")?;
        speakers[index] = serde_json::from_value(role.clone())
            .map_err(|error| format!("source focus QA original speaker: {error}"))?;
        let text = span["text"]
            .as_str()
            .ok_or("source focus QA original text is required")?;
        let start = coordinate(span, "start")?;
        let end = coordinate(span, "end")?;
        let revision = span["sourceRevision"]
            .as_str()
            .ok_or("source focus QA original revision is required")?;
        if end.checked_sub(start) != Some(text.len())
            || span["sha256"] != sha256(text.as_bytes())
            || revision.len() != 64
            || !revision
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("source focus QA original coordinates, SHA or revision are invalid".into());
        }
    }
    Ok(speakers)
}

pub(super) fn expand(
    packet: &Packet,
    raw: &str,
    encoding: Encoding,
) -> Result<(String, Vec<FocusWitnessQa>), String> {
    if raw.len() > crate::wiki_claims::MAX_OUTPUT_BYTES {
        return Err("source focus QA output exceeds native bounds".into());
    }
    let batch: Batch<FocusedClaim> = match encoding {
        Encoding::TupleV1 => serde_json::from_str(raw)
            .map_err(|error| format!("invalid complete source focus QA output: {error}"))?,
        Encoding::NamedV1 => named::parse(raw)?,
    };
    if batch.version != encoding.wire_version() || batch.packet_sha256 != packet.packet_sha256() {
        return Err("source focus QA version or full original packet SHA differs".into());
    }
    let speakers = validate_originals(packet)?;
    let mut tuples = Vec::new();
    let mut witnesses = Vec::new();
    for claim in batch.claims {
        let FocusedClaim(anchor, focus, kind, supports, actor, time, speech, status, ()) = claim;
        if !compatible_kind(kind, speech, status) {
            return Err("source focus QA declared kind, speech act and status disagree".into());
        }
        if actor.1 == ActorBasis::Speaker && speakers.get(anchor) != Some(&actor.0) {
            return Err("source focus QA actor contradicts its actual anchor speaker".into());
        }
        witnesses.push(bind_focus(packet, anchor, &focus, kind)?);
        tuples.push(serde_json::json!([
            focus, anchor, supports, actor, time, speech, status, null
        ]));
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct CompactBatch<'a> {
        version: &'static str,
        packet_sha256: &'a str,
        outcome: ClaimOutcome,
        claims: Vec<serde_json::Value>,
    }
    let compact = serde_json::to_string(&CompactBatch {
        version: crate::wiki_claims::compact_qa::VERSION,
        packet_sha256: &batch.packet_sha256,
        outcome: batch.outcome,
        claims: tuples,
    })
    .map_err(|error| error.to_string())?;
    let canonical = crate::wiki_claims::compact_qa::expand_captured(packet, &compact)?;
    let native: NativeProjection =
        serde_json::from_str(&canonical).map_err(|error| error.to_string())?;
    for (witness, proposal) in witnesses.iter_mut().zip(&native.claims) {
        witness.proposal_sha256 = proposal_sha256(proposal)?;
    }
    Ok((canonical, witnesses))
}

fn coordinate(span: &serde_json::Value, field: &str) -> Result<usize, String> {
    span[field]
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| format!("source focus QA original {field} is invalid"))
}

fn bind_focus(
    packet: &Packet,
    anchor: usize,
    focus: &str,
    kind: AssertionKindQa,
) -> Result<FocusWitnessQa, String> {
    if focus.trim().is_empty() || focus.chars().count() > 512 {
        return Err("source focus QA focus exceeds native action bounds".into());
    }
    let original = packet
        .original_spans()
        .get(anchor)
        .ok_or("source focus QA anchor ordinal is absent")?;
    let text = original["text"]
        .as_str()
        .ok_or("source focus QA original text is absent")?;
    let mut occurrences = text
        .char_indices()
        .filter_map(|(offset, _)| text[offset..].starts_with(focus).then_some(offset));
    let offset = occurrences
        .next()
        .ok_or("source focus QA focus must occur exactly once in its original")?;
    if occurrences.next().is_some() {
        return Err("source focus QA focus must occur exactly once in its original".into());
    }
    let start = coordinate(original, "start")?
        .checked_add(offset)
        .ok_or("source focus QA coordinates overflow")?;
    let end = start
        .checked_add(focus.len())
        .filter(|end| coordinate(original, "end").is_ok_and(|limit| *end <= limit))
        .ok_or("source focus QA focus exceeds original coordinates")?;
    Ok(FocusWitnessQa {
        proposal_sha256: String::new(),
        anchor_span_id: packet.span_ids()[anchor].clone(),
        source_revision: original["sourceRevision"]
            .as_str()
            .ok_or("source focus QA original revision is absent")?
            .into(),
        start,
        end,
        focus_sha256: sha256(focus.as_bytes()),
        assertion_kind: kind,
    })
}

pub(super) fn compatible_kind(
    kind: AssertionKindQa,
    speech: SpeechAct,
    status: ClaimStatus,
) -> bool {
    use ClaimStatus::*;
    if status.is_verified() {
        return false;
    }
    match kind {
        AssertionKindQa::ExplicitNonoccurrence | AssertionKindQa::RecordOrVerificationLimit => {
            speech == SpeechAct::Report && status == Unknown
        }
        AssertionKindQa::Intention => match speech {
            SpeechAct::Request => matches!(status, Requested | Unknown),
            SpeechAct::Plan => matches!(status, Planned | Unknown),
            _ => false,
        },
        AssertionKindQa::Uncertain => {
            matches!(speech, SpeechAct::Unknown | SpeechAct::Question) && status == Unknown
        }
        AssertionKindQa::AssertedOccurrence => {
            matches!(speech, SpeechAct::Report | SpeechAct::Retraction)
                && crate::wiki_claims::compatible_status(speech, status)
        }
    }
}
