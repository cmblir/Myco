//! Private source-focus answer bindings; model sidecars never grant authority.

use super::answer_review::AnswerCorrectionFeedback;
use super::claim_prompt::Extraction;
use crate::activity_recall::period_context;
use crate::commands::DateRange;
use crate::wiki_claims::focus_claims_qa::FocusProjectionQa;
use crate::wiki_claims::{CheckedClaim, SourceSet, SourceSpan};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

const VERSION: &str = "WikiSourceFocusAnswerBindingQaV1";
const MODEL_FIELDS: [&str; 4] = [
    "sourceFocusRepresentation",
    "sourceFocusInterpretations",
    "sourceFocusInterpretationRevision",
    "sourceFocusInterpretationRevisions",
];
const MODEL_SPAN_FIELDS: [&str; 7] = [
    "id",
    "text",
    "speaker",
    "turnId",
    "turnTime",
    "recordTime",
    "sourcePhase",
];

/// Native capture and bound QA feedback construct this private proof. No deserialization or
/// conversion into a native authorization, semantic receipt or published claim.
#[derive(Clone)]
pub(crate) struct FocusAnswerQa {
    base_payload: Value,
    question: String,
    language: String,
    range: DateRange,
    original_closure: Vec<SourceSpan>,
    projections: Vec<FocusProjectionQa>,
    claims: Vec<CheckedClaim>,
    focus_claim_count: usize,
    selected_ordinals: Vec<usize>,
    full_witnesses: Vec<Value>,
    answer_correction: Option<AnswerCorrectionFeedback>,
    revision: String,
}

impl FocusAnswerQa {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn capture(
        base_payload: &Value,
        question: &str,
        language: &str,
        range: &DateRange,
        original_closure: &[SourceSpan],
        extraction: &Extraction,
        selected: &[&CheckedClaim],
    ) -> Result<Option<Self>, String> {
        if base_payload.get("answerCorrection").is_some() {
            return Err("source focus answer initial payload contains correction feedback".into());
        }
        if extraction.focus_projections.is_empty() {
            if extraction.focus_claim_count != 0 {
                return Err("source focus answer lacks its initial projections".into());
            }
            return Ok(None);
        }
        let mut selected_ordinals = Vec::with_capacity(selected.len());
        let mut seen = HashSet::new();
        for claim in selected {
            let ordinal = extraction
                .claims
                .claims
                .iter()
                .position(|original| std::ptr::eq(original, *claim))
                .ok_or("source focus answer selected claim is outside its frozen extraction")?;
            if !seen.insert(ordinal) {
                return Err("source focus answer selected claim is duplicated".into());
            }
            selected_ordinals.push(ordinal);
        }
        let full_witnesses = collect_witnesses(
            &extraction.focus_projections,
            &extraction.claims.claims,
            extraction.focus_claim_count,
            &selected_ordinals,
            question,
            language,
            range,
            original_closure,
        )?;
        let mut captured = Self {
            base_payload: base_payload.clone(),
            question: question.into(),
            language: language.into(),
            range: range.clone(),
            original_closure: original_closure.to_vec(),
            projections: extraction.focus_projections.clone(),
            claims: extraction.claims.claims.clone(),
            focus_claim_count: extraction.focus_claim_count,
            selected_ordinals,
            full_witnesses,
            answer_correction: None,
            revision: String::new(),
        };
        captured.validate_base()?;
        captured.revision = captured.calculate_revision()?;
        Ok(Some(captured))
    }

    /// Preserve original content and declared fields while retaining proof-only
    /// source metadata and review hashes in the private captured base packet.
    pub(crate) fn model_payload(&self) -> Result<Value, String> {
        self.verify_binding()?;
        let mut payload = self.base_payload.clone();
        let sources = payload["sources"]
            .as_array_mut()
            .ok_or("source focus answer model citations are missing")?;
        for source in sources {
            let originals = source["originalSpans"]
                .as_array_mut()
                .ok_or("source focus answer model originals are missing")?;
            for original in originals {
                *original = model_span(original)?;
            }
        }
        payload
            .as_object_mut()
            .ok_or("source focus answer model payload is not an object")?
            .remove("automatedClaimReviewInputRevisions");
        payload["sourceFocusRepresentation"] = json!("source_focus_quote");
        payload["sourceFocusInterpretations"] = json!(self
            .full_witnesses
            .iter()
            .map(|witness| json!({
                "selectedProposalOrdinal":witness["selectedProposalOrdinal"],
                "assertionKind":witness["assertionKind"],
            }))
            .collect::<Vec<_>>());
        payload["sourceFocusInterpretationRevision"] = json!(self.revision);
        Ok(payload)
    }

    /// Supply the same content projection in complete native closure order for
    /// final QA review. Missing fields fail rather than receiving guessed values.
    pub(crate) fn model_original_spans(&self) -> Result<Vec<Value>, String> {
        self.verify_binding()?;
        self.original_closure
            .iter()
            .map(|span| {
                let full = serde_json::to_value(span).map_err(|error| error.to_string())?;
                model_span(&full)
            })
            .collect()
    }

    /// Rebind the complete current original sequence and the exact app-rendered
    /// prompt. The native opening, route and semantic review remain caller-owned.
    pub(crate) fn verify_prompt(
        &self,
        question: &str,
        language: &str,
        user: &str,
        packet: &SourceSet,
    ) -> Result<(), String> {
        if question != self.question || language != self.language {
            return Err("source focus answer question or language changed".into());
        }
        let current: Vec<_> = packet.spans().cloned().collect();
        if current != self.original_closure {
            return Err("source focus answer original closure changed or reordered".into());
        }
        let expected = self.model_payload()?;
        let actual: Value = serde_json::from_str(user)
            .map_err(|error| format!("source focus answer prompt JSON: {error}"))?;
        // The app owns serialization. Exact bytes also reject duplicate JSON
        // members that a Value comparison alone would silently collapse.
        let rendered = serde_json::to_string(&expected).map_err(|error| error.to_string())?;
        if actual != expected || user != rendered {
            return Err("source focus answer model payload or revision changed".into());
        }
        Ok(())
    }

    pub(crate) fn revision(&self) -> &str {
        &self.revision
    }

    /// Preserve the complete private draft/review while binding exactly one
    /// native-issued untrusted feedback view to the same original closure.
    pub(crate) fn with_answer_correction(
        &self,
        feedback: &AnswerCorrectionFeedback,
    ) -> Result<Self, String> {
        self.verify_binding()?;
        if self.answer_correction.is_some() || feedback.focus_revision() != self.revision {
            return Err("source focus answer correction is repeated or replayed".into());
        }
        let mut corrected = self.clone();
        corrected.base_payload["answerCorrection"] = feedback.model_payload().clone();
        corrected.answer_correction = Some(feedback.clone());
        corrected.revision = corrected.calculate_revision()?;
        corrected.verify_binding()?;
        Ok(corrected)
    }

    #[cfg(test)]
    pub(crate) fn full_witnesses(&self) -> &[Value] {
        &self.full_witnesses
    }

    fn verify_binding(&self) -> Result<(), String> {
        self.validate_base()?;
        let witnesses = collect_witnesses(
            &self.projections,
            &self.claims,
            self.focus_claim_count,
            &self.selected_ordinals,
            &self.question,
            &self.language,
            &self.range,
            &self.original_closure,
        )?;
        if witnesses != self.full_witnesses || self.calculate_revision()? != self.revision {
            return Err("source focus answer private proof or revision changed".into());
        }
        Ok(())
    }

    fn validate_base(&self) -> Result<(), String> {
        let object = self
            .base_payload
            .as_object()
            .ok_or("source focus answer base payload is not an object")?;
        match &self.answer_correction {
            Some(feedback)
                if self.base_payload.get("answerCorrection") == Some(feedback.model_payload()) => {}
            None if !object.contains_key("answerCorrection") => {}
            _ => return Err("source focus answer correction view changed".into()),
        }
        if MODEL_FIELDS.iter().any(|field| object.contains_key(*field))
            || self.base_payload["question"].as_str() != Some(self.question.as_str())
            || self.base_payload["language"].as_str() != Some(self.language.as_str())
            || self.base_payload["activityPeriod"] != period_value(&self.range)
        {
            return Err("source focus answer base request or representation changed".into());
        }
        let mut span_ids = HashSet::new();
        if self
            .original_closure
            .iter()
            .any(|span| !span_ids.insert(span.id()))
        {
            return Err("source focus answer original identity is duplicated".into());
        }
        let sources = self.base_payload["sources"]
            .as_array()
            .ok_or("source focus answer base sources are missing")?;
        let mut pages = HashSet::new();
        let mut source_ids = HashSet::new();
        let mut supplied_ids = HashSet::new();
        for source in sources {
            let page = source["path"]
                .as_str()
                .ok_or("source focus answer citation path is missing")?;
            let id = source["id"]
                .as_str()
                .ok_or("source focus answer citation identity is missing")?;
            if !pages.insert(page) || !source_ids.insert(id) {
                return Err("source focus answer citation is duplicated".into());
            }
            let supplied = source["originalSpans"]
                .as_array()
                .ok_or("source focus answer citation originals are missing")?;
            let expected = self
                .original_closure
                .iter()
                .filter(|span| span.selection_path() == page)
                .map(serde_json::to_value)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            // Existing answer packets group by citation page. Preserve each
            // page's native subsequence without reordering the full closure.
            if expected.is_empty() || supplied != &expected {
                return Err(
                    "source focus answer citation original bytes, metadata or order changed".into(),
                );
            }
            for span in supplied {
                let id = span["id"]
                    .as_str()
                    .ok_or("source focus answer original identity is missing")?;
                if !supplied_ids.insert(id) {
                    return Err("source focus answer supplied original is duplicated".into());
                }
            }
        }
        if supplied_ids != span_ids {
            return Err("source focus answer original closure is missing or foreign".into());
        }
        let expected_proposals = self
            .selected_ordinals
            .iter()
            .map(|ordinal| {
                let claim = self
                    .claims
                    .get(*ordinal)
                    .ok_or("source focus answer selected ordinal changed")?;
                serde_json::to_value(&claim.proposal).map_err(|error| error.to_string())
            })
            .collect::<Result<Vec<_>, String>>()?;
        if self.base_payload["claimProposals"] != json!(expected_proposals) {
            return Err("source focus answer selected native proposals changed".into());
        }
        for claim in &self.claims {
            let provenance = claim
                .proposal
                .support_span_ids
                .iter()
                .filter_map(|id| self.original_closure.iter().find(|span| span.id() == id))
                .collect::<Vec<_>>();
            if !claim.structure_checked
                || !claim.semantic_review_required
                || provenance.is_empty()
                || provenance.len() != claim.proposal.support_span_ids.len()
                || provenance.len() != claim.provenance.len()
                || provenance
                    .iter()
                    .zip(&claim.provenance)
                    .any(|(expected, actual)| *expected != actual)
            {
                return Err("source focus answer claim provenance changed".into());
            }
        }
        let context = period_context::annotate(&self.range, self.original_closure.iter())?;
        if self.base_payload["recordPeriodContext"]
            != serde_json::to_value(context).map_err(|error| error.to_string())?
        {
            return Err("source focus answer record period context changed".into());
        }
        Ok(())
    }

    fn calculate_revision(&self) -> Result<String, String> {
        let base = (
            VERSION,
            &self.base_payload,
            &self.original_closure,
            &self.claims,
            self.focus_claim_count,
            &self.selected_ordinals,
            &self.projections,
            &self.full_witnesses,
        );
        // The default proof's existing byte identity is unchanged.
        let encoded = match &self.answer_correction {
            Some(feedback) => serde_json::to_vec(&(base, feedback)),
            None => serde_json::to_vec(&base),
        };
        encoded
            .map(|bytes| format!("{:x}", Sha256::digest(bytes)))
            .map_err(|error| error.to_string())
    }
}

#[allow(clippy::too_many_arguments)]
fn collect_witnesses(
    projections: &[FocusProjectionQa],
    claims: &[CheckedClaim],
    focus_claim_count: usize,
    selected_ordinals: &[usize],
    question: &str,
    language: &str,
    range: &DateRange,
    original_closure: &[SourceSpan],
) -> Result<Vec<Value>, String> {
    let initial = claims
        .get(..focus_claim_count)
        .ok_or("source focus answer initial claim count changed")?;
    let mut initial_witnesses = Vec::new();
    let mut cursor = 0_usize;
    for projection in projections {
        projection.verify_answer_context(question, language, range, original_closure)?;
        let end = cursor
            .checked_add(projection.proposal_count())
            .ok_or("source focus answer initial claim count overflow")?;
        let proposals = initial
            .get(cursor..end)
            .ok_or("source focus answer initial proposal closure changed")?
            .iter()
            .map(|claim| &claim.proposal)
            .collect::<Vec<_>>();
        initial_witnesses.extend(projection.ordered_answer_witnesses(&proposals)?);
        cursor = end;
    }
    if cursor != initial.len() || initial_witnesses.len() != initial.len() {
        return Err("source focus answer initial witness coverage changed".into());
    }
    let mut witnesses = Vec::new();
    let mut selected = HashSet::new();
    for (selected_ordinal, original_ordinal) in selected_ordinals.iter().enumerate() {
        if *original_ordinal >= claims.len() || !selected.insert(*original_ordinal) {
            return Err(
                "source focus answer selected ordinal is duplicated or outside extraction".into(),
            );
        }
        if let Some(witness) = initial_witnesses.get(*original_ordinal) {
            let mut witness = witness.clone();
            witness["selectedProposalOrdinal"] = json!(selected_ordinal);
            witnesses.push(witness);
        }
    }
    Ok(witnesses)
}

fn period_value(range: &DateRange) -> Value {
    json!({"start":range.start,"end":range.end,
        "startEpoch":range.start_epoch,"endEpoch":range.end_epoch})
}

fn model_span(full: &Value) -> Result<Value, String> {
    let fields = full
        .as_object()
        .ok_or("source focus answer original is not an object")?;
    let projected = MODEL_SPAN_FIELDS
        .iter()
        .map(|field| {
            let value = fields
                .get(*field)
                .ok_or_else(|| format!("source focus answer original lacks {field}"))?;
            Ok(((*field).to_owned(), value.clone()))
        })
        .collect::<Result<serde_json::Map<String, Value>, String>>()?;
    Ok(Value::Object(projected))
}

#[cfg(test)]
#[path = "focus_answer_qa_tests.rs"]
mod tests;
