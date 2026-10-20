//! App-owned, reversible activity projection. It does not repair extraction
//! omissions or grant semantic review, verification or publication authority.

use super::schema::{NativeClaim, SessionCompilationV1, SessionSummary};
use super::structure::ValidatedSessionStructure;
use serde::Serialize;
use std::fmt::Write as _;

pub(super) const MATERIALIZED_VERSION: &str = "CanonicalSessionMaterializationV1";
pub(super) const MAX_ROW_CHARACTERS: usize = 4096;
pub(super) const MAX_ROW_BYTES: usize = 8 * 1024;
pub(super) const MAX_VIEW_BYTES: usize = 96 * 1024;
const MAX_LABEL_CHARACTERS: usize = 32;

/// Only materialize can construct this wrapper. No Deserialize or mutable view:
/// stored/caller JSON cannot restore trusted app rows or runtime authority.
#[derive(Clone, Debug, Serialize)]
#[serde(transparent)]
pub(crate) struct MaterializedSessionV1 {
    view: SessionCompilationV1,
}

impl MaterializedSessionV1 {
    /// Borrow the exact reviewed/published field layout, retaining its distinct
    /// app-materialization version so the legacy model validator rejects it.
    pub(crate) fn as_view(&self) -> &SessionCompilationV1 {
        &self.view
    }
}

// English is source copy; the seven groups and their order are identical in
// every supported locale. Native JSON field/enum codes are never translated.
fn labels(lang: &str) -> Result<[&'static str; 7], String> {
    let labels = match lang {
        "en" => [
            "Action",
            "Actor",
            "Original speaker",
            "Speech act",
            "Status",
            "Event time",
            "Verification record",
        ],
        "ko" => [
            "내용",
            "주체",
            "원문 발화자",
            "발화 유형",
            "상태",
            "행위 시각",
            "검증 기록",
        ],
        "ja" => [
            "行為",
            "主体",
            "原文の発話者",
            "発話の種類",
            "状態",
            "行為の日時",
            "検証記録",
        ],
        _ => return Err("unsupported materializer language".into()),
    };
    if labels.iter().any(|label| {
        label.trim().is_empty()
            || label.chars().count() > MAX_LABEL_CHARACTERS
            || label.chars().any(display_control)
    }) {
        return Err("session materializer labels exceed bounds".into());
    }
    Ok(labels)
}

fn display_control(character: char) -> bool {
    character.is_control() || matches!(character, '\u{2028}' | '\u{2029}')
}

fn json(value: &impl Serialize) -> Result<String, String> {
    serde_json::to_string(value)
        .map_err(|error| format!("serialize canonical activity value: {error}"))
}

fn action_literal(action: &str) -> Result<String, String> {
    let literal = json(&action)?;
    let mut escaped = String::with_capacity(literal.len());
    for character in literal.chars() {
        if display_control(character) {
            let mut units = [0u16; 2];
            for &unit in character.encode_utf16(&mut units).iter() {
                write!(&mut escaped, "\\u{unit:04x}")
                    .map_err(|_| "encode canonical activity control".to_string())?;
            }
        } else {
            escaped.push(character);
        }
    }
    Ok(escaped)
}

pub(super) fn materialize(
    structure: ValidatedSessionStructure,
    claims: &[NativeClaim],
    lang: &str,
) -> Result<MaterializedSessionV1, String> {
    let labels = labels(lang)?;
    let proposal = structure.into_proposal(claims)?;
    let mut summaries = Vec::with_capacity(claims.len());
    for claim in claims {
        let activity = &claim.claim.proposal;
        if !claim.claim.structure_checked
            || activity.action.trim().is_empty()
            || activity.action.chars().count() > 512
        {
            return Err("materializer requires bounded native activity claims".into());
        }
        let anchor = claim
            .claim
            .provenance
            .iter()
            .find(|span| span.id() == activity.anchor_span_id)
            .ok_or("materializer claim lacks its native anchor span")?;
        let values = [
            action_literal(&activity.action)?,
            json(&activity.actor)?,
            json(&anchor.speaker())?,
            json(&activity.speech_act)?,
            json(&activity.status)?,
            json(&activity.event_time)?,
            json(&activity.verification_id)?,
        ];
        let text = labels
            .iter()
            .zip(values)
            .map(|(label, value)| format!("{label}: {value}"))
            .collect::<Vec<_>>()
            .join(" · ");
        if text.chars().count() > MAX_ROW_CHARACTERS
            || text.len() > MAX_ROW_BYTES
            || text.chars().any(display_control)
        {
            return Err("canonical session activity row exceeds display bounds".into());
        }
        summaries.push(SessionSummary {
            claim_id: claim.id.clone(),
            text,
        });
    }
    let view = SessionCompilationV1 {
        version: MATERIALIZED_VERSION.into(),
        title: proposal.title,
        title_claim_ids: proposal.title_claim_ids,
        entities: proposal.entities,
        summaries,
    };
    if serde_json::to_vec(&view)
        .map_err(|error| format!("serialize canonical session view: {error}"))?
        .len()
        > MAX_VIEW_BYTES
    {
        return Err("canonical session materialization exceeds packet bounds".into());
    }
    Ok(MaterializedSessionV1 { view })
}

#[cfg(test)]
#[path = "materializer_test_support.rs"]
pub(super) mod test_support;
#[cfg(test)]
#[path = "materializer_tests.rs"]
mod tests;
