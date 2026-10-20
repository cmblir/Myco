//! Source-focused QA proposals; exact bindings never establish source meaning.

use super::compact_qa::Packet;
use super::source_interpretation_qa::AssertionKindQa;
use super::{sha256, ActorRole, CheckedClaims, ClaimProposal, SourceSet};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

#[path = "focus_claims_qa_encoding.rs"]
mod encoding;
pub use encoding::DecoderFocusQa;
pub(crate) use encoding::Encoding;
#[path = "focus_claims_qa_binding.rs"]
mod binding;
use binding::bound_revision;
#[cfg(test)]
use binding::projection_revision;

#[path = "activity_types_qa.rs"]
mod activity_types;
#[path = "focus_claims_correction_qa.rs"]
mod correction;
#[path = "ordinal_activity_qa.rs"]
mod ordinal_activity;
pub use activity_types::ActivityTypesDecoderQa;
#[path = "activity_types_qa_prompt.rs"]
mod activity_types_prompt;
#[path = "focus_claims_qa_prompt.rs"]
mod prompt;
#[path = "focus_claims_qa_wire.rs"]
mod wire;
pub(crate) use ordinal_activity::PreparedOrdinalActivityQa;

pub(crate) const VERSION: &str = "WikiSourceFocusClaimsQaV1";
pub(crate) const NAMED_VERSION: &str = "WikiSourceFocusClaimsNamedQaV1";

pub(crate) struct PreparedFocusQa {
    packet: Packet,
    user: String,
    system: String,
    decoder: DecoderFocusQa,
    correction: Option<correction::CorrectionPromptQa>,
}

impl PreparedFocusQa {
    pub(crate) fn prepare(user: &str) -> Result<Self, String> {
        Self::prepare_for(user, Encoding::TupleV1)
    }

    pub(crate) fn prepare_for(user: &str, encoding: Encoding) -> Result<Self, String> {
        let original: Value = serde_json::from_str(user).map_err(|error| error.to_string())?;
        if original.get(correction::FIELD).is_some() {
            return Err(
                "source focus QA ordinary preparation contains reserved correction metadata".into(),
            );
        }
        Self::prepare_inner(user, encoding)
    }

    fn prepare_inner(user: &str, encoding: Encoding) -> Result<Self, String> {
        let packet = Packet::capture(user)?;
        let speakers = wire::validate_originals(&packet)?;
        let original: Value = serde_json::from_str(user).map_err(|error| error.to_string())?;
        validate_question_period(&original)?;
        let decoder = DecoderFocusQa {
            packet_sha256: Sha256::digest(user.as_bytes()).into(),
            speakers,
            span_count: u8::try_from(packet.span_ids().len())
                .map_err(|_| "source focus QA span count exceeds decoder bounds")?,
            encoding,
        };
        Ok(Self {
            user: packet.augmented_user()?,
            system: prompt::system_for(encoding),
            packet,
            decoder,
            correction: None,
        })
    }

    /// Bind one augmented prompt while retaining the original packet unchanged.
    /// The caller must supply a bound negative receipt and rerun every validator.
    pub(crate) fn prepare_correction(
        original_user: &str,
        previous_raw: &str,
        feedback: &Value,
    ) -> Result<Self, String> {
        Self::prepare_correction_for(original_user, previous_raw, feedback, Encoding::TupleV1)
    }

    pub(crate) fn prepare_correction_for(
        original_user: &str,
        previous_raw: &str,
        feedback: &Value,
        encoding: Encoding,
    ) -> Result<Self, String> {
        Self::prepare_for(original_user, encoding)?;
        let (raw_user, correction) = correction::CorrectionPromptQa::capture(
            original_user,
            previous_raw,
            feedback,
            encoding,
        )?;
        let mut prepared = Self::prepare_inner(&raw_user, encoding)?;
        prepared.system = correction.system().into();
        correction.verify(&prepared.packet)?;
        prepared.correction = Some(correction);
        Ok(prepared)
    }

    pub(crate) fn system(&self) -> &str {
        &self.system
    }
    pub(crate) fn user(&self) -> &str {
        &self.user
    }
    pub(crate) fn original_user(&self) -> &str {
        self.packet.raw_user()
    }
    pub(crate) fn decoder(&self) -> DecoderFocusQa {
        self.decoder
    }
    pub(crate) fn encoding(&self) -> Encoding {
        self.decoder.encoding
    }

    /// Project exact focus bytes and every declared field unchanged. The caller
    /// still owns SourceSet validation, native authorization and semantic review.
    pub(crate) fn expand(&self, raw: &str) -> Result<FocusProjectionQa, String> {
        self.packet.verify_snapshot()?;
        let speakers = wire::validate_originals(&self.packet)?;
        if self.decoder.packet_sha256() != self.packet.packet_sha256()
            || self.decoder.span_count() != self.packet.span_ids().len()
            || self.decoder.speakers != speakers
            || self.user != self.packet.augmented_user()?
        {
            return Err("source-focus captured decoder or actual user changed".into());
        }
        if let Some(correction) = &self.correction {
            correction.verify(&self.packet)?;
            if correction.encoding() != self.encoding() || correction.system() != self.system {
                return Err("source-focus correction measured generation prompt changed".into());
            }
        } else if self.system != prompt::system_for(self.encoding()) {
            return Err("source-focus measured generation system changed".into());
        }
        let (canonical, witnesses) = wire::expand(&self.packet, raw, self.encoding())?;
        let native: wire::NativeProjection = serde_json::from_str(&canonical)
            .map_err(|error| format!("read source focus native projection: {error}"))?;
        let proposals = native
            .claims
            .iter()
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        let revision = bound_revision(
            self.packet.raw_user(),
            &canonical,
            &witnesses,
            self.encoding(),
            &self.system,
            &self.user,
            self.correction.as_ref(),
        )?;
        Ok(FocusProjectionQa {
            version: self.decoder.wire_version(),
            packet_sha256: self.packet.packet_sha256(),
            revision,
            canonical,
            model_raw: raw.into(),
            model_raw_sha256: sha256(raw.as_bytes()),
            original_user: self.packet.raw_user().into(),
            original_spans: self.packet.original_spans().to_vec(),
            proposals,
            witnesses,
            encoding: Some(self.encoding()),
            ordinal: None,
            generation_system: self.system.clone(),
            generation_user: self.user.clone(),
            correction: self.correction.clone(),
            semantic_review_required: true,
            semantic_accepted: false,
            native_io_authenticated: false,
            production_accepted: false,
        })
    }
}

/// Private, app-calculated coordinates for one unchanged model judgment. No
/// deserialization, publication conversion or semantic receipt is available.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FocusWitnessQa {
    proposal_sha256: String,
    anchor_span_id: String,
    source_revision: String,
    start: usize,
    end: usize,
    focus_sha256: String,
    assertion_kind: AssertionKindQa,
}

/// Serialization exposes witnesses and explicit non-authority flags, without
/// duplicating complete originals or the native proposal body in each witness.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FocusProjectionQa {
    version: &'static str,
    packet_sha256: String,
    revision: String,
    #[serde(skip)]
    canonical: String,
    #[serde(skip)]
    model_raw: String,
    #[serde(skip)]
    model_raw_sha256: String,
    #[serde(skip)]
    original_user: String,
    #[serde(skip)]
    original_spans: Vec<Value>,
    #[serde(skip)]
    proposals: Vec<Value>,
    witnesses: Vec<FocusWitnessQa>,
    #[serde(skip)]
    encoding: Option<Encoding>,
    #[serde(skip)]
    ordinal: Option<ordinal_activity::OrdinalCaptureQa>,
    #[serde(skip)]
    generation_system: String,
    #[serde(skip)]
    generation_user: String,
    #[serde(skip)]
    correction: Option<correction::CorrectionPromptQa>,
    semantic_review_required: bool,
    semantic_accepted: bool,
    native_io_authenticated: bool,
    production_accepted: bool,
}

impl FocusProjectionQa {
    pub(crate) fn canonical(&self) -> &str {
        &self.canonical
    }
    pub(crate) fn revision(&self) -> &str {
        &self.revision
    }
    pub(crate) fn proposal_count(&self) -> usize {
        self.proposals.len()
    }
    pub(crate) fn encoding(&self) -> Option<Encoding> {
        self.encoding
    }
    pub(crate) fn verify_review_context(&self, revision: &str) -> Result<(), String> {
        if let Some(ordinal) = &self.ordinal {
            ordinal.verify_context(revision)?;
        }
        Ok(())
    }

    /// Require the exact observed output, including JSON whitespace, before it
    /// is supplied as previous-result data to a bounded correction prompt.
    pub(crate) fn verify_model_result(&self, raw: &str) -> Result<(), String> {
        self.verify_binding()?;
        if raw != self.model_raw || sha256(raw.as_bytes()) != self.model_raw_sha256 {
            return Err("source-focus correction previous raw model output changed".into());
        }
        Ok(())
    }

    /// Permit a later-source superset while rebinding every captured original
    /// in order, including its entire body and metadata. This is not native
    /// authorization or a semantic judgment about the additional originals.
    pub(crate) fn verify_answer_context(
        &self,
        question: &str,
        lang: &str,
        range: &crate::commands::DateRange,
        original_closure: &[crate::wiki_claims::SourceSpan],
    ) -> Result<(), String> {
        let original = self.verify_binding()?;
        let period = serde_json::json!({"start":range.start,"end":range.end,
            "startEpoch":range.start_epoch,"endEpoch":range.end_epoch});
        if original["question"].as_str() != Some(question)
            || original["language"].as_str() != Some(lang)
            || original["activityPeriod"] != period
        {
            return Err(
                "source focus QA answer question, language or activity period changed".into(),
            );
        }
        let captured = Packet::capture(&self.original_user)?;
        let current = original_closure
            .iter()
            .filter(|span| captured.span_ids().iter().any(|id| id == span.id()))
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        if current != self.original_spans {
            return Err("source focus QA answer captured originals are missing, duplicated, changed or reordered".into());
        }
        Ok(())
    }

    fn verify_binding(&self) -> Result<Value, String> {
        if let Some(ordinal) = &self.ordinal {
            return ordinal.verify_projection(self);
        }
        let encoding = self
            .encoding
            .ok_or("source-focus wire encoding is absent")?;
        let captured = Packet::capture(&self.original_user)?;
        if let Some(correction) = &self.correction {
            correction.verify(&captured)?;
            if correction.encoding() != encoding || correction.system() != self.generation_system {
                return Err("source-focus correction encoding or system changed".into());
            }
        } else if serde_json::from_str::<Value>(&self.original_user)
            .map_err(|error| error.to_string())?
            .get(correction::FIELD)
            .is_some()
        {
            return Err("source-focus correction lost its private actual-prompt binding".into());
        } else if self.generation_system != prompt::system_for(encoding) {
            return Err("source-focus private actual system changed".into());
        }
        let original: Value =
            serde_json::from_str(&self.original_user).map_err(|error| error.to_string())?;
        let native: wire::NativeProjection =
            serde_json::from_str(&self.canonical).map_err(|error| error.to_string())?;
        let (raw_canonical, raw_witnesses) = wire::expand(&captured, &self.model_raw, encoding)?;
        let proposals = native
            .claims
            .iter()
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        if self.version != encoding.wire_version()
            || self.generation_user != captured.augmented_user()?
            || sha256(self.model_raw.as_bytes()) != self.model_raw_sha256
            || raw_canonical != self.canonical
            || serde_json::to_value(raw_witnesses).map_err(|error| error.to_string())?
                != serde_json::to_value(&self.witnesses).map_err(|error| error.to_string())?
            || captured.packet_sha256() != self.packet_sha256
            || captured.original_spans() != self.original_spans
            || proposals != self.proposals
            || self.proposals.len() != self.witnesses.len()
            || bound_revision(
                &self.original_user,
                &self.canonical,
                &self.witnesses,
                encoding,
                &self.generation_system,
                &self.generation_user,
                self.correction.as_ref(),
            )? != self.revision
            || !self.semantic_review_required
            || self.semantic_accepted
            || self.native_io_authenticated
            || self.production_accepted
        {
            return Err("source focus QA projection binding or non-authority flags changed".into());
        }
        Ok(original)
    }

    /// Recheck exact ordered source/proposal/context bytes before adding a
    /// witness sidecar to an ordinary mandatory review. This does not approve it.
    pub(crate) fn review_value(
        &self,
        packet: &SourceSet,
        claims: &CheckedClaims,
        context_payload: &Value,
    ) -> Result<Value, String> {
        let original = self.verify_binding()?;
        if let Some(ordinal) = &self.ordinal {
            ordinal.verify_context_payload(context_payload)?;
        }
        let current_spans = packet
            .spans()
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        let current_proposals = claims
            .claims
            .iter()
            .map(|claim| serde_json::to_value(&claim.proposal))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        let native: wire::NativeProjection =
            serde_json::from_str(&self.canonical).map_err(|error| error.to_string())?;
        if current_spans != self.original_spans
            || current_proposals != self.proposals
            || claims.outcome != native.outcome
            || !context_payload.is_object()
            || ["question", "language", "activityPeriod"]
                .iter()
                .any(|field| context_payload[*field] != original[*field])
            || claims.claims.iter().any(|claim| {
                let expected = claim
                    .proposal
                    .support_span_ids
                    .iter()
                    .filter_map(|id| packet.spans().find(|span| span.id() == id))
                    .collect::<Vec<_>>();
                !claim.structure_checked
                    || !claim.semantic_review_required
                    || expected.len() != claim.proposal.support_span_ids.len()
                    || expected
                        .iter()
                        .zip(&claim.provenance)
                        .any(|(expected, actual)| *expected != actual)
                    || expected.len() != claim.provenance.len()
            })
        {
            return Err(
                "source focus QA review source, ordered proposals or request changed".into(),
            );
        }
        let period = validate_question_period(&original)?;
        let sidecar = crate::activity_recall::period_context::annotate(&period, packet.spans())?;
        if serde_json::to_value(sidecar).map_err(|error| error.to_string())?
            != original["recordPeriodContext"]
        {
            return Err("source focus QA review period sidecar changed".into());
        }
        serde_json::to_value(self).map_err(|error| error.to_string())
    }

    /// Keep the full native proof and binding checks while presenting only
    /// ordered, untrusted assertion kinds to the model's ordinary claim IDs.
    /// The adapter includes the interpretation revision once outside this
    /// sidecar; the model never needs to resolve a hash or byte coordinate.
    pub(crate) fn model_review_value(
        &self,
        packet: &SourceSet,
        claims: &CheckedClaims,
        context_payload: &Value,
    ) -> Result<Value, String> {
        self.review_value(packet, claims, context_payload)?;
        Ok(serde_json::json!({
            "version":self.version,
            "claims":self.witnesses.iter().enumerate().map(|(index,witness)|
                serde_json::json!({"id":format!("C{index}"),"assertionKind":witness.assertion_kind})
            ).collect::<Vec<_>>(),
            "untrustedModelJudgments":true,
            "semanticReviewRequired":true,
            "semanticAccepted":false,
            "nativeIoAuthenticated":false,
            "productionAccepted":false,
        }))
    }

    /// Bind every initial proposal in its captured order before the caller
    /// selects answer claims. Missing, changed or reordered proposals fail;
    /// later resolution claims are not passed through this QA projection.
    pub(crate) fn ordered_answer_witnesses(
        &self,
        proposals: &[&ClaimProposal],
    ) -> Result<Vec<Value>, String> {
        self.verify_binding()?;
        let current = proposals
            .iter()
            .map(serde_json::to_value)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        if current != self.proposals {
            return Err("source focus QA initial proposal count, values or order changed".into());
        }
        let mut witnesses = Vec::with_capacity(proposals.len());
        for (proposal, witness) in proposals.iter().zip(&self.witnesses) {
            if witness.proposal_sha256 != proposal_sha256(proposal)? {
                return Err("source focus QA initial proposal digest changed".into());
            }
            witnesses.push(serde_json::to_value(witness).map_err(|error| error.to_string())?);
        }
        Ok(witnesses)
    }
}

fn proposal_sha256(proposal: &ClaimProposal) -> Result<String, String> {
    serde_json::to_vec(proposal)
        .map(|bytes| sha256(&bytes))
        .map_err(|error| error.to_string())
}

fn validate_question_period(input: &Value) -> Result<crate::commands::DateRange, String> {
    if input["question"].as_str().map_or(true, |question| {
        question.trim().is_empty() || question.chars().count() > 2000
    }) || !matches!(input["language"].as_str(), Some("ko" | "en" | "ja"))
        || !input["recordPeriodContext"].is_object()
    {
        return Err(
            "source focus QA requires an unchanged question, language and period context".into(),
        );
    }
    let period: crate::commands::DateRange =
        serde_json::from_value(input["activityPeriod"].clone())
            .map_err(|error| format!("source focus QA activity period: {error}"))?;
    if !crate::activity_recall::valid_range(&period) {
        return Err("source focus QA activity period is invalid".into());
    }
    Ok(period)
}

#[cfg(test)]
#[path = "focus_claims_qa_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "focus_claims_named_qa_tests.rs"]
mod named_tests;
