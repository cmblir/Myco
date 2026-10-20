//! Isolated QA input measurements; no source bodies, receipts or authority.

use super::{json, sha, Ordering, ProbeState, Value};
use tauri::Manager;

pub(super) const OBSERVATION_LIMIT: usize = 256;

/// The caller identifies the actual tokenizer call site, never model content.
#[derive(Clone, Copy, Debug, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FocusTokenPhaseQa {
    InitialClaimReview,
    InitialExtractionCorrection,
    AnswerGroupCandidate,
    AnswerDraftFinal,
    AnswerCorrection,
    FinalAnswerReview,
}

/// Actual caller budgets; measurement does not change generation limits.
#[derive(Clone, Copy, Debug)]
pub(crate) struct FocusTokenBudgetQa {
    pub(crate) context_tokens: u32,
    pub(crate) output_tokens: i32,
    pub(crate) reserve: usize,
}

impl FocusTokenBudgetQa {
    fn maximum_prompt_tokens(self) -> Result<usize, &'static str> {
        let output = usize::try_from(self.output_tokens)
            .ok()
            .filter(|value| *value > 0)
            .ok_or("measurement output budget is invalid")?;
        (self.context_tokens as usize)
            .checked_sub(output)
            .and_then(|remaining| remaining.checked_sub(self.reserve))
            .ok_or("measurement context/output/reserve budgets disagree")
    }
}

struct PacketCounts {
    original_spans: usize,
    proposed_claims: Option<usize>,
    selected_claims: Option<usize>,
    mapped_kinds: Option<usize>,
}

pub(crate) fn observe(
    app: &tauri::AppHandle,
    request_id: &str,
    system: &str,
    user: &str,
    counted: &Result<usize, String>,
) {
    let Some(state) = app.try_state::<ProbeState>() else {
        return;
    };
    if !state.activity_questions || !state.source_focus_claims {
        return;
    }
    let payload: Value = match serde_json::from_str(user) {
        Ok(payload) => payload,
        Err(_) => {
            report_error(&state, "token input is not complete JSON");
            return;
        }
    };
    if !initial_review_input(&payload) {
        return;
    }
    observe_tokens(
        app,
        request_id,
        FocusTokenPhaseQa::InitialClaimReview,
        system,
        user,
        counted,
        FocusTokenBudgetQa {
            context_tokens: 4096,
            output_tokens: 768,
            reserve: 8,
        },
    );
}

fn initial_review_input(payload: &Value) -> bool {
    payload.get("interpretationRevision").is_some()
        && payload.get("requiredClaimIds").is_some()
        && payload.get("sourceFocusInterpretations").is_some()
}

/// Observe only the actual prepared initial correction input and caller budget.
pub(crate) fn observe_initial_correction(
    app: &tauri::AppHandle,
    request_id: &str,
    system: &str,
    user: &str,
    counted: &Result<usize, String>,
    budget: FocusTokenBudgetQa,
) {
    let Some(state) = app.try_state::<ProbeState>() else {
        return;
    };
    if !super::reviewed_activity_correction_mode(&state) {
        return;
    }
    let payload: Value = match serde_json::from_str(user) {
        Ok(payload) => payload,
        Err(_) => {
            report_error(&state, "correction token input is not complete JSON");
            return;
        }
    };
    if payload.get("initialExtractionCorrection").is_none() {
        return;
    }
    observe_tokens(
        app,
        request_id,
        FocusTokenPhaseQa::InitialExtractionCorrection,
        system,
        user,
        counted,
        budget,
    );
}

pub(crate) fn observe_tokens(
    app: &tauri::AppHandle,
    request_id: &str,
    phase: FocusTokenPhaseQa,
    system: &str,
    user: &str,
    counted: &Result<usize, String>,
    budget: FocusTokenBudgetQa,
) {
    let Some(state) = app.try_state::<ProbeState>() else {
        return;
    };
    if let Err(error) = record(&state, request_id, phase, system, user, counted, budget) {
        report_error(&state, error);
    }
}

fn report_error(state: &ProbeState, error: &'static str) {
    state.observation_errors.fetch_add(1, Ordering::Relaxed);
    eprintln!("native Ask QA token observation: {error}");
}

fn record(
    state: &ProbeState,
    request_id: &str,
    phase: FocusTokenPhaseQa,
    system: &str,
    user: &str,
    counted: &Result<usize, String>,
    budget: FocusTokenBudgetQa,
) -> Result<bool, &'static str> {
    if !state.activity_questions || !state.source_focus_claims {
        return Ok(false);
    }
    if matches!(
        phase,
        FocusTokenPhaseQa::InitialExtractionCorrection | FocusTokenPhaseQa::AnswerCorrection
    ) && !super::reviewed_activity_correction_mode(state)
    {
        return Ok(false);
    }
    let owned = state
        .owned_requests
        .lock()
        .map_err(|_| "ownership lock poisoned")?;
    if !owned.contains(request_id) {
        return Err("token request is not QA-owned");
    }
    drop(owned);
    let maximum_prompt_tokens = budget.maximum_prompt_tokens()?;
    let payload: Value =
        serde_json::from_str(user).map_err(|_| "token input is not complete JSON")?;
    let counts = packet_counts(phase, &payload)?;
    let input_revision = sha(user.as_bytes());
    let system_revision = sha(system.as_bytes());
    let phase_value = json!(phase);
    let interpretation_revision = match phase {
        FocusTokenPhaseQa::InitialClaimReview => payload["interpretationRevision"].clone(),
        FocusTokenPhaseQa::InitialExtractionCorrection => Value::Null,
        _ => payload["sourceFocusInterpretationRevision"].clone(),
    };
    let mut records = state
        .focus_review_tokens
        .lock()
        .map_err(|_| "measurement lock poisoned")?;
    if records.len() >= OBSERVATION_LIMIT {
        return Err("token measurement capacity is full");
    }
    let observation_ordinal = records.len() + 1;
    let seen_ordinal = records
        .iter()
        .filter(|record| {
            record["requestId"] == request_id
                && record["phase"] == phase_value
                && record["inputSha256"] == input_revision
                && record["systemSha256"] == system_revision
        })
        .count()
        + 1;
    let mut observation = json!({"phase":phase_value,"requestId":request_id,
        "observationOrdinal":observation_ordinal,"seenOrdinal":seen_ordinal,
        "inputSha256":input_revision,"systemSha256":system_revision,"tokenCount":counted,
        "interpretationRevision":interpretation_revision,
        "contextTokens":budget.context_tokens,"outputTokens":budget.output_tokens,
        "safetyReserveTokens":budget.reserve,"maximumPromptTokens":maximum_prompt_tokens,
        "fits":counted.as_ref().ok().map(|count|*count<=maximum_prompt_tokens),
        "originalSpanCount":counts.original_spans,"proposalCount":counts.proposed_claims,
        "selectedClaimCount":counts.selected_claims,"mappedKinds":counts.mapped_kinds,
        "promptBodiesIncluded":false,"nativeIoAuthenticated":false,"semanticAccepted":false,
        "productionAccepted":false});
    if matches!(phase, FocusTokenPhaseQa::InitialExtractionCorrection) {
        observation["packetSha256"] = payload["packetSha256"].clone();
    }
    records.push(observation);
    Ok(true)
}

fn count(value: &Value) -> Result<usize, &'static str> {
    value
        .as_u64()
        .and_then(|value| usize::try_from(value).ok())
        .ok_or("measurement count is not a bounded unsigned integer")
}

fn valid_kind(value: &Value) -> bool {
    matches!(
        value.as_str(),
        Some(
            "asserted_occurrence"
                | "explicit_nonoccurrence"
                | "intention"
                | "record_or_verification_limit"
                | "uncertain"
        )
    )
}

fn valid_revision(value: &Value) -> bool {
    value.as_str().is_some_and(|revision| {
        revision.len() == 64
            && revision
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

fn compact_mapping(payload: &Value, selected: usize) -> Result<usize, &'static str> {
    if payload["sourceFocusRepresentation"] != "source_focus_quote"
        || !valid_revision(&payload["sourceFocusInterpretationRevision"])
    {
        return Err("measurement compact interpretation context is invalid");
    }
    let mapped = payload["sourceFocusInterpretations"]
        .as_array()
        .ok_or("measurement compact kind mapping missing")?;
    let mut ordinals = std::collections::BTreeSet::new();
    for mapping in mapped {
        let ordinal = count(&mapping["selectedProposalOrdinal"])?;
        if ordinal >= selected
            || !ordinals.insert(ordinal)
            || !valid_kind(&mapping["assertionKind"])
        {
            return Err("measurement compact kind mapping is inconsistent");
        }
    }
    Ok(mapped.len())
}

fn initial_correction_counts(payload: &Value) -> Result<PacketCounts, &'static str> {
    let originals = payload["originalSpans"]
        .as_array()
        .ok_or("initial correction originals missing")?;
    let dictionary = payload["spanOrdinalDictionary"]
        .as_array()
        .ok_or("initial correction span dictionary missing")?;
    let allowed = payload["allowedSpanIds"]
        .as_array()
        .ok_or("initial correction allowed span IDs missing")?;
    let correction = &payload["initialExtractionCorrection"];
    let feedback = &correction["automatedReviewFeedback"];
    if originals.is_empty()
        || dictionary.len() != originals.len()
        || allowed.len() != originals.len()
        || !valid_revision(&payload["packetSha256"])
        || !correction["previousModelResult"].is_string()
        || correction["correctionAttempt"] != 1
        || correction["untrustedModelData"] != true
        || correction["semanticApproval"] != false
        || !matches!(
            feedback["failureCode"].as_str(),
            Some("review_rejected" | "review_missing")
        )
        || feedback["review"]["version"] != "WikiClaimReviewV1"
        || !feedback["review"]["claims"].is_array()
        || !feedback["review"]["missingSpanIds"].is_array()
        || feedback["untrustedModelJudgments"] != true
        || feedback["sameModelReviewIsIndependent"] != false
        || feedback["semanticAccepted"] != false
        || feedback["nativeIoAuthenticated"] != false
        || feedback["productionAccepted"] != false
    {
        return Err("initial correction measurement packet is invalid");
    }
    let mut ids = std::collections::BTreeSet::new();
    for (ordinal, ((original, entry), allowed_id)) in
        originals.iter().zip(dictionary).zip(allowed).enumerate()
    {
        let id = original["id"]
            .as_str()
            .ok_or("initial correction original ID missing")?;
        if !ids.insert(id)
            || count(&entry["ordinal"])? != ordinal
            || entry["spanId"] != id
            || *allowed_id != id
        {
            return Err("initial correction measurement span dictionary disagrees");
        }
    }
    // The previous raw result is untrusted feedback, not current proposals.
    Ok(PacketCounts {
        original_spans: originals.len(),
        proposed_claims: None,
        selected_claims: None,
        mapped_kinds: None,
    })
}

fn check_answer_correction(payload: &Value) -> Result<(), &'static str> {
    let correction = &payload["answerCorrection"];
    let previous = &correction["previousAnswer"];
    let review = &correction["review"];
    if !previous["proseWithoutModelLinkLabels"].is_string()
        || !previous["sourceIds"].is_array()
        || previous
            .get("modelAnswer")
            .is_some_and(|answer| !answer.is_string())
        || review["version"] != "AskAnswerReviewV1"
        || !review["missingSpanIds"].is_array()
        || !review["reason"].is_string()
        || correction["untrustedModelJudgments"] != true
    {
        return Err("answer correction measurement feedback is invalid");
    }
    Ok(())
}

fn packet_counts(phase: FocusTokenPhaseQa, payload: &Value) -> Result<PacketCounts, &'static str> {
    match phase {
        FocusTokenPhaseQa::InitialExtractionCorrection => initial_correction_counts(payload),
        FocusTokenPhaseQa::InitialClaimReview => {
            let originals = payload["originalSpans"]
                .as_array()
                .ok_or("review originals missing")?;
            let claims = payload["claims"]
                .as_array()
                .ok_or("review proposals missing")?;
            let required = payload["requiredClaimIds"]
                .as_array()
                .ok_or("review claim IDs missing")?;
            let mapped = payload["sourceFocusInterpretations"]["claims"]
                .as_array()
                .ok_or("review kind mapping missing")?;
            if originals.is_empty()
                || required.len() != claims.len()
                || mapped.len() != claims.len()
                || !valid_revision(&payload["interpretationRevision"])
            {
                return Err("review measurement counts disagree");
            }
            for ((claim, id), mapping) in claims.iter().zip(required).zip(mapped) {
                if !id.is_string()
                    || claim["id"] != *id
                    || mapping["id"] != *id
                    || !valid_kind(&mapping["assertionKind"])
                {
                    return Err("review measurement claim mapping disagrees");
                }
            }
            Ok(PacketCounts {
                original_spans: originals.len(),
                proposed_claims: Some(claims.len()),
                selected_claims: None,
                mapped_kinds: Some(mapped.len()),
            })
        }
        FocusTokenPhaseQa::AnswerGroupCandidate
        | FocusTokenPhaseQa::AnswerDraftFinal
        | FocusTokenPhaseQa::AnswerCorrection => {
            if matches!(phase, FocusTokenPhaseQa::AnswerCorrection) {
                check_answer_correction(payload)?;
            }
            let sources = payload["sources"]
                .as_array()
                .ok_or("answer sources missing")?;
            let originals = sources.iter().try_fold(0_usize, |total, source| {
                let spans = source["originalSpans"]
                    .as_array()
                    .ok_or("answer source originals missing")?;
                total
                    .checked_add(spans.len())
                    .ok_or("answer original count overflow")
            })?;
            let claims = payload["claimProposals"]
                .as_array()
                .ok_or("answer proposals missing")?;
            let proposed = count(&payload["coverage"]["proposedClaims"])?;
            let selected = count(&payload["coverage"]["selectedClaims"])?;
            if originals == 0 || selected != claims.len() || proposed < selected {
                return Err("answer measurement claim counts disagree");
            }
            if let Some(omitted) = payload["coverage"].get("omittedClaims") {
                if count(omitted)? != proposed - selected {
                    return Err("answer measurement omission counts disagree");
                }
            }
            Ok(PacketCounts {
                original_spans: originals,
                proposed_claims: Some(proposed),
                selected_claims: Some(selected),
                mapped_kinds: Some(compact_mapping(payload, selected)?),
            })
        }
        FocusTokenPhaseQa::FinalAnswerReview => {
            let originals = payload["originalSpans"]
                .as_array()
                .ok_or("final review originals missing")?;
            let claims = payload["claimProposals"]
                .as_array()
                .ok_or("final review proposals missing")?;
            if originals.is_empty()
                || payload
                    .get("coverage")
                    .is_some_and(|coverage| !coverage.is_object())
            {
                return Err("final review original or coverage shape is invalid");
            }
            let proposed = payload["coverage"]
                .get("proposedClaims")
                .map(count)
                .transpose()?;
            if proposed.is_some_and(|proposed| proposed < claims.len()) {
                return Err("final review proposed count is below selected claims");
            }
            if let Some(selected) = payload["coverage"].get("selectedClaims") {
                if count(selected)? != claims.len() {
                    return Err("final review selected count disagrees");
                }
            }
            Ok(PacketCounts {
                original_spans: originals.len(),
                proposed_claims: proposed,
                selected_claims: Some(claims.len()),
                mapped_kinds: Some(compact_mapping(payload, claims.len())?),
            })
        }
    }
}

pub(super) fn append_terminal(state: &ProbeState, terminal: &mut Value) {
    terminal["sourceFocusTokenObservationLimit"] = json!(OBSERVATION_LIMIT);
    match state.focus_review_tokens.lock() {
        Ok(records) => {
            terminal["sourceFocusReviewTokenCounts"] = json!(records
                .iter()
                .filter(|record| record["phase"] == "initial_claim_review")
                .collect::<Vec<_>>());
            terminal["sourceFocusTokenCounts"] = json!(&*records);
            terminal["sourceFocusTokenObservationReadError"] = Value::Null;
        }
        Err(_) => {
            report_error(state, "measurement terminal lock poisoned");
            terminal["sourceFocusReviewTokenCounts"] = Value::Null;
            terminal["sourceFocusTokenCounts"] = Value::Null;
            terminal["sourceFocusTokenObservationReadError"] =
                json!("measurement terminal lock poisoned");
        }
    }
}

#[cfg(test)]
#[path = "focus_sizing_tests.rs"]
mod tests;
