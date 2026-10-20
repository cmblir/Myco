//! Closed QA outputs projected into the unchanged native review proposal.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

const MAX_OUTPUT_BYTES: usize = 32 * 1024;

pub(super) struct NativePacket {
    pub(super) value: Value,
    pub(super) claim_ids: Vec<String>,
    original_ids: BTreeSet<String>,
    coverage_ids: BTreeSet<String>,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn ids(value: &Value, maximum: usize) -> Result<Vec<String>, String> {
    let array = value.as_array().ok_or("QA review IDs must be an array")?;
    let ids = array
        .iter()
        .map(|id| {
            id.as_str()
                .filter(|id| valid_id(id))
                .map(str::to_owned)
                .ok_or_else(|| "QA review ID is invalid".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if ids.len() > maximum || ids.iter().collect::<BTreeSet<_>>().len() != ids.len() {
        return Err("QA review IDs exceed bounds or duplicate an identity".into());
    }
    Ok(ids)
}

impl NativePacket {
    pub(super) fn parse(user: &str) -> Result<Self, String> {
        if user.len() > 2 * 1024 * 1024 {
            return Err("QA native review input exceeds bounds".into());
        }
        let value: Value = serde_json::from_str(user).map_err(|error| error.to_string())?;
        let keys = [
            "context",
            "contextRevision",
            "coverageRequiredSpanIds",
            "referenceSpanIds",
            "originalSpans",
            "requiredClaimIds",
            "claims",
            "independentVerificationReceipts",
        ];
        let object = value
            .as_object()
            .ok_or("QA native review input is not an object")?;
        if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
            return Err("QA native review input has unknown or missing keys".into());
        }
        let spans = value["originalSpans"]
            .as_array()
            .ok_or("QA originals are absent")?;
        let original_ids = ids(
            &json!(spans
                .iter()
                .map(|span| span["id"].clone())
                .collect::<Vec<_>>()),
            512,
        )?;
        let coverage_ids = ids(&value["coverageRequiredSpanIds"], 512)?;
        let references = ids(&value["referenceSpanIds"], 512)?;
        let original_ids = original_ids.into_iter().collect::<BTreeSet<_>>();
        let covered = coverage_ids
            .iter()
            .chain(&references)
            .collect::<BTreeSet<_>>();
        if coverage_ids.is_empty()
            || covered.len() != original_ids.len()
            || coverage_ids.iter().any(|id| references.contains(id))
            || covered.iter().any(|id| !original_ids.contains(*id))
        {
            return Err("QA coverage/reference IDs do not partition admitted originals".into());
        }
        let claim_ids = ids(&value["requiredClaimIds"], 16)?;
        let claims = value["claims"]
            .as_array()
            .ok_or("QA native proposals are absent")?;
        if claims.len() != claim_ids.len() || claims.iter().zip(&claim_ids).enumerate().any(|(index, (claim, id))|
            id != &format!("C{index}") || claim["id"] != *id
                || !matches!(claim.as_object(), Some(fields) if fields.len() == 2 && fields.contains_key("proposal")))
        {
            return Err("QA native proposals differ from exact app-issued IDs".into());
        }
        if !value["context"].is_object()
            || !value["contextRevision"].is_string()
            || !value["independentVerificationReceipts"].is_array()
        {
            return Err("QA native context or verification metadata is malformed".into());
        }
        Ok(Self {
            value,
            claim_ids,
            original_ids,
            coverage_ids: coverage_ids.into_iter().collect(),
        })
    }
}

fn valid_reason(reason: &str) -> bool {
    !reason.trim().is_empty()
        && reason.chars().count() <= 128
        && !reason.chars().any(char::is_control)
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Disposition {
    Supported,
    Unsupported,
    Uncertain,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FieldJudgment {
    disposition: Disposition,
    reason: String,
    evidence_span_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct FieldReview {
    version: String,
    claim_id: String,
    actor: FieldJudgment,
    action: FieldJudgment,
    event_time: FieldJudgment,
    speech_act: FieldJudgment,
    status: FieldJudgment,
    reason: String,
}

impl FieldReview {
    fn fields(&self) -> [&FieldJudgment; 5] {
        [
            &self.actor,
            &self.action,
            &self.event_time,
            &self.speech_act,
            &self.status,
        ]
    }

    fn decision(&self) -> Value {
        let fields = self.fields();
        let decisive = fields
            .iter()
            .find(|field| field.disposition == Disposition::Unsupported)
            .or_else(|| {
                fields
                    .iter()
                    .find(|field| field.disposition == Disposition::Uncertain)
            });
        let (disposition, reason) = decisive
            .map_or((Disposition::Supported, self.reason.as_str()), |field| {
                (field.disposition, field.reason.as_str())
            });
        json!({"id":self.claim_id,"disposition":disposition,"reason":reason})
    }
}

pub(super) fn field(native: &NativePacket, target: &str, raw: &str) -> Result<FieldReview, String> {
    if raw.len() > MAX_OUTPUT_BYTES {
        return Err("QA field output exceeds bounds".into());
    }
    let review: FieldReview = serde_json::from_str(raw).map_err(|error| error.to_string())?;
    if review.version != "WikiClaimFieldReviewQaV1"
        || review.claim_id != target
        || !native.claim_ids.iter().any(|id| id == target)
        || !valid_reason(&review.reason)
        || review.fields().iter().any(|field| {
            !valid_reason(&field.reason)
                || field.evidence_span_ids.len() > 8
                || field
                    .evidence_span_ids
                    .iter()
                    .collect::<BTreeSet<_>>()
                    .len()
                    != field.evidence_span_ids.len()
                || field
                    .evidence_span_ids
                    .iter()
                    .any(|id| !valid_id(id) || !native.original_ids.contains(id))
        })
    {
        return Err("QA field output has invalid target, evidence or reasons".into());
    }
    Ok(review)
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Coverage {
    Covered,
    Missing,
    Uncertain,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SourceCoverage {
    version: String,
    source_coverage: Coverage,
    missing_span_ids: Vec<String>,
    reason: String,
}

pub(super) fn coverage(native: &NativePacket, raw: &str) -> Result<SourceCoverage, String> {
    if raw.len() > MAX_OUTPUT_BYTES {
        return Err("QA coverage output exceeds bounds".into());
    }
    let review: SourceCoverage = serde_json::from_str(raw).map_err(|error| error.to_string())?;
    if review.version != "WikiSourceCoverageQaV1"
        || !valid_reason(&review.reason)
        || review.missing_span_ids.len() > 512
        || review
            .missing_span_ids
            .iter()
            .collect::<BTreeSet<_>>()
            .len()
            != review.missing_span_ids.len()
        || review
            .missing_span_ids
            .iter()
            .any(|id| !valid_id(id) || !native.coverage_ids.contains(id))
        || (review.source_coverage == Coverage::Covered && !review.missing_span_ids.is_empty())
        || (review.source_coverage == Coverage::Missing && review.missing_span_ids.is_empty())
    {
        return Err("QA coverage output has invalid original IDs, state or reason".into());
    }
    Ok(review)
}

pub(super) fn project(
    native: &NativePacket,
    fields: &[String],
    raw_coverage: &str,
) -> Result<String, String> {
    if fields.len() != native.claim_ids.len() {
        return Err("QA field projection lacks one result per app-issued claim".into());
    }
    let mut reviews = BTreeMap::new();
    for raw in fields {
        if raw.len() > MAX_OUTPUT_BYTES {
            return Err("QA field output exceeds bounds".into());
        }
        let value: Value = serde_json::from_str(raw).map_err(|error| error.to_string())?;
        let target = value["claimId"]
            .as_str()
            .ok_or("QA field projection lacks a claim ID")?;
        let review = field(native, target, raw)?;
        if reviews.insert(target.to_owned(), review).is_some() {
            return Err("QA field projection duplicates an app-issued claim".into());
        }
    }
    let coverage = coverage(native, raw_coverage)?;
    if coverage.missing_span_ids.len() > 8 {
        return Err(
            "QA missing IDs exceed unchanged native review bounds; no trimming permitted".into(),
        );
    }
    let claims = native
        .claim_ids
        .iter()
        .map(|id| {
            reviews
                .get(id)
                .map(FieldReview::decision)
                .ok_or_else(|| "QA field projection omitted an app-issued claim".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let output = json!({"version":"WikiClaimReviewV1","claims":claims,
        "sourceCoverage":coverage.source_coverage,"missingSpanIds":coverage.missing_span_ids})
    .to_string();
    if output.len() > MAX_OUTPUT_BYTES {
        return Err("QA native review projection exceeds bounds".into());
    }
    Ok(output)
}
