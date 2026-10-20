//! Explicit activity adaptation of OrdinalV3; exact projection never approves meaning.

use super::{
    activity_types, activity_types_prompt, proposal_sha256, sha256, validate_question_period, wire,
    ActivityTypesDecoderQa, FocusProjectionQa, FocusWitnessQa, Packet,
};
use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::source_input_view::{original_input, OriginalInputView, INSTRUCTIONS};
use crate::wiki_claims::source_interpretation_qa::{
    prepare_candidate, CandidateQa, PreparedCandidateQa,
};
use crate::wiki_claims::{ClaimProposal, SourceSet};
use serde::Serialize;
use serde_json::{json, Value};

const VERSION: &str = "NativeSourceInterpretationOrdinalActivityQaV3";
const INPUT_VERSION: &str = "NativeSourceInterpretationOrdinalActivityQaInputV4";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivityInputView<'a> {
    version: &'static str,
    question: &'a Value,
    language: &'a Value,
    original_spans: Vec<OriginalInputRow<'a>>,
    activity_period: &'a Value,
    record_period_context: &'a Value,
    independent_verification_receipts: &'a [Value],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OriginalInputRow<'a> {
    unit_ordinal: usize,
    original: OriginalInputView<'a>,
}

pub(crate) struct PreparedOrdinalActivityQa {
    core: PreparedCandidateQa,
    decoder: ActivityTypesDecoderQa,
    capture: OrdinalCaptureQa,
    system: String,
    user: String,
}

#[derive(Clone)]
pub(super) struct OrdinalCaptureQa {
    original_user: String,
    sources: SourceSet,
    origin: AgentVaultSession,
    scope: Scope,
    context_payload: Value,
    context_revision: String,
}

struct ProjectionParts {
    canonical: String,
    proposals: Vec<Value>,
    witnesses: Vec<FocusWitnessQa>,
}

impl PreparedOrdinalActivityQa {
    /// Token fitting uses these exact inputs; this helper issues no decoder or source authority.
    pub(crate) fn inputs(
        original_user: &str,
        context: &Value,
        context_revision: &str,
    ) -> Result<(String, String), String> {
        if context_revision.len() != 64
            || !context_revision
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("Ordinal activity context revision is invalid".into());
        }
        let packet = Packet::capture(original_user)?;
        wire::validate_originals(&packet)?;
        let original: Value = serde_json::from_str(original_user).map_err(|e| e.to_string())?;
        validate_question_period(&original)?;
        if !context.is_object()
            || context["sourceFocusQaEncoding"] != "ordinal_activity_v3"
            || ["question", "language", "activityPeriod"]
                .iter()
                .any(|key| original[*key] != context[*key])
            || original["independentVerificationReceipts"] != json!([])
            || original.get("initialExtractionCorrection").is_some()
            || original.get("answerCorrection").is_some()
        {
            return Err(
                "Ordinal activity request differs or contains unsupported correction data".into(),
            );
        }
        let mut system = activity_types_prompt::system(INPUT_VERSION);
        system.push('\n');
        system.push_str(INSTRUCTIONS);
        // Direct serialization preserves member order at every object layer;
        // converting the view to Value would sort its maps again.
        let user = serde_json::to_string(&ActivityInputView {
            version: INPUT_VERSION,
            question: &original["question"],
            language: &original["language"],
            original_spans: packet
                .original_spans()
                .iter()
                .enumerate()
                .map(|(unit_ordinal, original)| {
                    Ok(OriginalInputRow {
                        unit_ordinal,
                        original: original_input(original)?,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?,
            activity_period: &original["activityPeriod"],
            record_period_context: &original["recordPeriodContext"],
            independent_verification_receipts: &[],
        })
        .map_err(|e| e.to_string())?;
        Ok((system, user))
    }

    #[allow(clippy::too_many_arguments)] // Capture the existing app-owned request/source boundary.
    pub(crate) fn prepare(
        original_user: &str,
        sources: &SourceSet,
        origin: &AgentVaultSession,
        scope: Scope,
        context_payload: &Value,
        context_revision: &str,
    ) -> Result<Self, String> {
        let (system, user) = Self::inputs(original_user, context_payload, context_revision)?;
        let packet = Packet::capture(original_user)?;
        let originals = sources
            .spans()
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        if originals != packet.original_spans() {
            return Err("Ordinal activity complete ordered originals changed".into());
        }
        let original: Value = serde_json::from_str(original_user).map_err(|e| e.to_string())?;
        let range = validate_question_period(&original)?;
        if serde_json::to_value(crate::activity_recall::period_context::annotate(
            &range,
            sources.spans(),
        )?)
        .map_err(|e| e.to_string())?
            != original["recordPeriodContext"]
        {
            return Err("Ordinal activity record-period context changed".into());
        }
        // This core validates source/shape only. Its source-only input hash is never
        // presented as a served activity prompt or semantic/review receipt.
        let core = prepare_candidate(sources, origin, scope, CandidateQa::OrdinalV3)?;
        let decoder = ActivityTypesDecoderQa::new(core.count(), wire::validate_originals(&packet)?);
        Ok(Self {
            core,
            decoder,
            system,
            user,
            capture: OrdinalCaptureQa {
                original_user: original_user.into(),
                sources: sources.clone(),
                origin: origin.clone(),
                scope,
                context_payload: context_payload.clone(),
                context_revision: context_revision.into(),
            },
        })
    }

    pub(crate) fn system(&self) -> &str {
        &self.system
    }
    pub(crate) fn user(&self) -> &str {
        &self.user
    }
    pub(crate) fn decoder(&self) -> ActivityTypesDecoderQa {
        self.decoder
    }

    fn parts(&self, raw: &str) -> Result<ProjectionParts, String> {
        // Validate the actual typed wire before any map conversion can hide
        // duplicate fields or omitted nullable keys. Only its fixed mapping expands.
        let packet = Packet::capture(&self.capture.original_user)?;
        let expanded = activity_types::expand(raw, packet.span_ids())?;
        let bound = self
            .core
            .validate(&expanded, &self.capture.origin, self.capture.scope)?;
        let bound = serde_json::to_value(bound).map_err(|e| e.to_string())?;
        let units = bound["units"]
            .as_array()
            .ok_or("Ordinal activity units are absent")?;
        let mut proposals = Vec::new();
        let mut witnesses = Vec::new();
        for (ordinal, unit) in units.iter().enumerate() {
            let original = &packet.original_spans()[ordinal];
            if unit["unitOrdinal"] != ordinal || unit["original"] != *original {
                return Err("Ordinal activity original row changed".into());
            }
            for interpretation in unit["interpretations"]
                .as_array()
                .ok_or("Ordinal activity interpretations are absent")?
            {
                let kind = serde_json::from_value(interpretation["assertionKind"].clone())
                    .map_err(|e| e.to_string())?;
                let speech = serde_json::from_value(interpretation["speechAct"].clone())
                    .map_err(|e| e.to_string())?;
                let status = serde_json::from_value(interpretation["status"].clone())
                    .map_err(|e| e.to_string())?;
                if !wire::compatible_kind(kind, speech, status) {
                    return Err(
                        "Ordinal activity assertion kind, speech act and status disagree".into(),
                    );
                }
                let proposal: ClaimProposal = serde_json::from_value(json!({
                    "action": interpretation["focusQuote"], "anchorSpanId": original["id"],
                    "supportSpanIds": interpretation["supportSpanIds"], "actor": interpretation["actor"],
                    "eventTime": interpretation["eventTime"], "speechAct": interpretation["speechAct"],
                    "status": interpretation["status"], "verificationId": interpretation["verificationId"],
                })).map_err(|e| e.to_string())?;
                // The destination's 512-scalar bound is checked without trimming or repair.
                if proposal.action.chars().count() > 512 {
                    return Err("Ordinal activity focus exceeds canonical action bound".into());
                }
                witnesses.push(FocusWitnessQa {
                    proposal_sha256: proposal_sha256(&proposal)?,
                    anchor_span_id: proposal.anchor_span_id.clone(),
                    source_revision: original["sourceRevision"]
                        .as_str()
                        .ok_or("Ordinal source revision absent")?
                        .into(),
                    start: interpretation["focus"]["start"]
                        .as_u64()
                        .and_then(|n| usize::try_from(n).ok())
                        .ok_or("Ordinal focus start invalid")?,
                    end: interpretation["focus"]["end"]
                        .as_u64()
                        .and_then(|n| usize::try_from(n).ok())
                        .ok_or("Ordinal focus end invalid")?,
                    focus_sha256: interpretation["focus"]["sha256"]
                        .as_str()
                        .ok_or("Ordinal focus SHA absent")?
                        .into(),
                    assertion_kind: kind,
                });
                proposals.push(serde_json::to_value(proposal).map_err(|e| e.to_string())?);
            }
        }
        let canonical = serde_json::to_string(&json!({
            "outcome": if proposals.is_empty() { "insufficient_evidence" } else { "claims" },
            "claims": proposals,
        }))
        .map_err(|e| e.to_string())?;
        self.capture
            .sources
            .validate(&canonical, &self.capture.origin, self.capture.scope)?;
        Ok(ProjectionParts {
            canonical,
            proposals,
            witnesses,
        })
    }

    fn revision(&self, raw: &str, parts: &ProjectionParts) -> Result<String, String> {
        serde_json::to_vec(&(
            VERSION,
            &self.capture.original_user,
            &self.capture.context_payload,
            &self.capture.context_revision,
            self.system(),
            self.user(),
            self.decoder().grammar(),
            raw,
            &parts.canonical,
            &parts.witnesses,
        ))
        .map(|bytes| sha256(&bytes))
        .map_err(|e| e.to_string())
    }

    pub(crate) fn expand(&self, raw: &str) -> Result<FocusProjectionQa, String> {
        let parts = self.parts(raw)?;
        let packet = Packet::capture(&self.capture.original_user)?;
        let revision = self.revision(raw, &parts)?;
        Ok(FocusProjectionQa {
            version: VERSION,
            packet_sha256: packet.packet_sha256(),
            revision,
            canonical: parts.canonical,
            model_raw: raw.into(),
            model_raw_sha256: sha256(raw.as_bytes()),
            original_user: self.capture.original_user.clone(),
            original_spans: packet.original_spans().to_vec(),
            proposals: parts.proposals,
            witnesses: parts.witnesses,
            encoding: None,
            ordinal: Some(self.capture.clone()),
            generation_system: self.system.clone(),
            generation_user: self.user.clone(),
            correction: None,
            semantic_review_required: true,
            semantic_accepted: false,
            native_io_authenticated: false,
            production_accepted: false,
        })
    }
}

impl OrdinalCaptureQa {
    pub(super) fn verify_context(&self, current_revision: &str) -> Result<(), String> {
        if current_revision != self.context_revision {
            return Err("Ordinal activity role or request context changed".into());
        }
        Ok(())
    }

    pub(super) fn verify_context_payload(&self, current_payload: &Value) -> Result<(), String> {
        if current_payload != &self.context_payload {
            return Err("Ordinal activity complete request payload changed".into());
        }
        Ok(())
    }

    pub(super) fn verify_projection(
        &self,
        projection: &FocusProjectionQa,
    ) -> Result<Value, String> {
        let prepared = PreparedOrdinalActivityQa::prepare(
            &self.original_user,
            &self.sources,
            &self.origin,
            self.scope,
            &self.context_payload,
            &self.context_revision,
        )?;
        let parts = prepared.parts(&projection.model_raw)?;
        let packet = Packet::capture(&self.original_user)?;
        if projection.version != VERSION
            || projection.encoding.is_some()
            || projection.correction.is_some()
            || projection.original_user != self.original_user
            || projection.original_spans != packet.original_spans()
            || projection.packet_sha256 != packet.packet_sha256()
            || projection.generation_system != prepared.system()
            || projection.generation_user != prepared.user()
            || projection.model_raw_sha256 != sha256(projection.model_raw.as_bytes())
            || projection.canonical != parts.canonical
            || projection.proposals != parts.proposals
            || serde_json::to_value(&projection.witnesses).map_err(|e| e.to_string())?
                != serde_json::to_value(&parts.witnesses).map_err(|e| e.to_string())?
            || projection.revision != prepared.revision(&projection.model_raw, &parts)?
            || !projection.semantic_review_required
            || projection.semantic_accepted
            || projection.native_io_authenticated
            || projection.production_accepted
        {
            return Err(
                "Ordinal activity actual input, output or non-authority binding changed".into(),
            );
        }
        serde_json::from_str(&self.original_user).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
#[path = "ordinal_activity_qa_tests.rs"]
mod tests;
