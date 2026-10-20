//! QA reviewer execution and measured preflight; observations confer no authority.

use super::review_smoke::{hash, Case, Suite};
use super::{activity_smoke, ProbeHost};
use myco_lib::local_generation::review_probe;
use myco_lib::local_llm::GenerationSchema;
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::collections::BTreeSet;
use std::time::Instant;

pub(super) struct Observation {
    pub(super) result: Result<Value, Value>,
    pub(super) generation_calls: usize,
    pub(super) counted: Option<Value>,
}

fn check_user(case: &Case, user: &str) -> Result<Value, String> {
    let input: Value = serde_json::from_str(user).map_err(|error| error.to_string())?;
    if case
        .preview
        .as_ref()
        .is_some_and(|preview| preview != &input)
    {
        return Err("native reviewer USER differs from the frozen packet preview".into());
    }
    Ok(input)
}

fn selected_schema(
    schema: GenerationSchema,
    reason_first: bool,
) -> Result<GenerationSchema, String> {
    let decisions = schema
        .claim_review_decisions()
        .ok_or("review-only QA received another stage schema")?;
    Ok(if reason_first {
        GenerationSchema::WikiClaimReviewReasonFirstQaV1(decisions)
    } else {
        GenerationSchema::WikiClaimReviewV1(decisions)
    })
}

fn observe(case: &Case, suite: &Suite, probe: ProbeHost<'_>, inference: bool) -> Observation {
    let counted = RefCell::new(None::<Value>);
    let generation_calls = Cell::new(0);
    let result: Result<Result<Value, Value>, String> = (|| {
        let origin = case
            .request
            .origin
            .as_ref()
            .ok_or("review fixture lacks origin")?;
        let expected = serde_json::to_value(case.sources.spans().collect::<Vec<_>>())
            .map_err(|error| error.to_string())?
            .as_array()
            .cloned()
            .ok_or("review original spans are invalid")?;
        Ok(review_probe::run(
            &case.request, &case.sources, origin, &case.proposal,
            |system, user| {
                check_user(case, user)?;
                let system = suite.candidate_system.as_deref().unwrap_or(system);
                let tokens = probe.host.chat_token_count(system, user)?;
                if tokens == 0 { return Err("measured reviewer prompt is empty".into()); }
                *counted.borrow_mut() = Some(json!({"systemSha256":hash(system.as_bytes()),
                    "userSha256":hash(user.as_bytes()),"promptTokens":tokens}));
                Ok(tokens)
            },
            |system, user, output, context, schema| {
                let input = check_user(case, user)?;
                let system = suite.candidate_system.as_deref().unwrap_or(system);
                let schema = selected_schema(schema, suite.reason_first)?;
                let record = counted.borrow().clone().ok_or("reviewer was not counted")?;
                if record["systemSha256"] != hash(system.as_bytes())
                    || record["userSha256"] != hash(user.as_bytes()) || (output, context) != (768,4096)
                { return Err("counted reviewer input or reserved budget changed".into()); }
                let metadata = json!({"phase":if inference {"review_development_input"} else {"review_preflight_input"},
                    "model":probe.model.metadata(),"case":case.id,"packetKind":suite.packet_kind,
                    "systemSha256":hash(system.as_bytes()),"userSha256":hash(user.as_bytes()),
                    "grammarSha256":schema.qa_grammar_sha256(),
                    "grammarOrder":if suite.reason_first {"reason_then_disposition_coverage_then_missing"} else {"production"},
                    "requiredDecisions":schema.claim_review_decisions().map(|issued|issued.count()),
                    "promptTokens":record["promptTokens"],"requestedOutputTokens":output,
                    "contextTokens":context,"reserveTokens":8,"user":input,
                    "systemOverride":suite.candidate_system.is_some(),
                    "native_io_authenticated":false,"product_role_authorized":false,
                    "semantic_accepted":false,"production_accepted":false});
                println!("{metadata}");
                if inference {
                    generation_calls.set(generation_calls.get()+1);
                    activity_smoke::decode(probe,(system,user),(output,context),schema,&case.id,&expected,false)
                } else {
                    // Explicit transport-only mock. This never calls generation or
                    // approves a claim; actual grammar masking is a separate gate.
                    Ok(json!({"version":"WikiClaimReviewV1",
                        "claims":input["requiredClaimIds"].as_array().ok_or("reviewer IDs missing")?.iter()
                            .map(|id|json!({"id":id,"disposition":"uncertain",
                                "reason":"Preflight mock only; no inference or semantic approval."})).collect::<Vec<_>>(),
                        "sourceCoverage":"uncertain","missingSpanIds":[]}).to_string())
                }
            },
        ).map_err(|error|json!(error)))
    })();
    let result = match result {
        Ok(result) => result,
        Err(detail) => Err(json!({"code":"qa_input_invalid","detail":detail})),
    };
    Observation {
        result,
        generation_calls: generation_calls.get(),
        counted: counted.into_inner(),
    }
}

fn verdict(result: &Result<Value, Value>) -> &'static str {
    match result {
        Ok(value) if value["automatedReviewAccepted"] == true => "accept",
        Ok(value)
            if value["acceptanceFailure"]["code"] == "review_rejected"
                || value["acceptanceFailure"]["code"] == "review_missing" =>
        {
            "reject"
        }
        Ok(_) => "uncertain",
        Err(_) => "technical_failure",
    }
}

fn review_matches(case: &Case, result: &Result<Value, Value>) -> Option<bool> {
    let expected = case.expected_review.as_ref()?;
    let Ok(observation) = result else {
        return Some(false);
    };
    let actual = &observation["review"]["proposal"];
    let Some(claims) = actual["claims"].as_array() else {
        return Some(false);
    };
    let actual_claims = claims
        .iter()
        .map(|claim| {
            json!({"id":claim["id"],
        "disposition":claim["disposition"]})
        })
        .collect::<Vec<_>>();
    let missing = |value: &Value| -> Option<BTreeSet<String>> {
        value
            .as_array()?
            .iter()
            .map(|id| id.as_str().map(str::to_owned))
            .collect()
    };
    Some(
        json!(actual_claims) == expected["claims"]
            && actual["sourceCoverage"] == expected["sourceCoverage"]
            && missing(&actual["missingSpanIds"]) == missing(&expected["missingSpanIds"]),
    )
}

impl Suite {
    pub(super) fn metadata(&self) -> Value {
        json!({"phase":"review_development_inputs","scheduledCases":self.cases.len(),
            "manifestSha256":self.manifest_sha,"sourceAuditSha256":self.audit_sha,
            "systemOverride":self.candidate_system.is_some(),
            "candidateSystemSha256":self.candidate_system.as_ref().map(|value|hash(value.as_bytes())),
            "grammarOrder":if self.reason_first {"reason_then_disposition_coverage_then_missing"} else {"production"},
            "packetKind":self.packet_kind,"syntheticContextModelIndependent":true,
            "rawBodyAndSuppliedSpansPreserved":true,
            "selectionPathPolicy":"admitted synthetic wiki selection; frozen raw bytes/path/hash/bounds preserved",
            "scope":"development reviewer only; whole-source pipeline/held-out/native/offline/installed acceptance remains separate",
            "independentHumanReviewed":false,"native_io_authenticated":false,"product_role_authorized":false,
            "semantic_accepted":false,"production_accepted":false})
    }

    pub(super) fn preflight(&self, probe: ProbeHost<'_>) -> Result<(), String> {
        let mut admitted = 0;
        let mut measured = 0;
        let mut fit = 0;
        for case in &self.cases {
            let observation = observe(case, self, probe, false);
            if let Some(tokens) = observation
                .counted
                .as_ref()
                .and_then(|record| record["promptTokens"].as_u64())
            {
                measured += 1;
                fit += usize::from(tokens <= 4096 - 768 - 8);
            }
            let valid = observation.result.as_ref().is_ok_and(|result| {
                result["automatedReviewAccepted"] == false
                    && result["acceptanceFailure"]["code"] == "review_uncertain"
            }) && observation.counted.is_some()
                && observation.generation_calls == 0;
            admitted += usize::from(valid);
            println!(
                "{}",
                json!({"phase":"review_preflight_case","model":probe.model.metadata(),
                "case":case.id,"packetKind":self.packet_kind,"nativeStructureAndUserAdmitted":valid,
                "counted":observation.counted,"failure":observation.result.as_ref().err(),
                "generationCalls":observation.generation_calls,"mockedVerdict":true,
                "semantic_accepted":false,"production_accepted":false,
                "native_io_authenticated":false,"product_role_authorized":false})
            );
        }
        println!(
            "{}",
            json!({"phase":"review_preflight_summary","model":probe.model.metadata(),
            "packetKind":self.packet_kind,"scheduledCases":self.cases.len(),"nativeAdmittedCases":admitted,
            "fullPromptReserveMeasured":measured==self.cases.len(),
            "fullPromptReserveMeasuredCases":measured,"fullPromptReserveFitCases":fit,
            "generationCalls":0,"mockedVerdicts":true,
            "actualModelInferenceExecuted":false,"semantic_accepted":false,"production_accepted":false,
            "native_io_authenticated":false,"product_role_authorized":false})
        );
        if admitted == self.cases.len() {
            Ok(())
        } else {
            Err(
                "review preflight failed; no inference may start and no original may be trimmed"
                    .into(),
            )
        }
    }

    pub(super) fn run(&self, probe: ProbeHost<'_>) -> Result<(), String> {
        self.run_observed(probe, |case| observe(case, self, probe, true))
    }

    // Every QA execution path retains these original frozen acceptance gates.
    pub(super) fn run_observed(
        &self,
        probe: ProbeHost<'_>,
        mut observer: impl FnMut(&Case) -> Observation,
    ) -> Result<(), String> {
        self.preflight(probe)?;
        let correct = self
            .cases
            .iter()
            .filter(|case| case.expected_verdict == "accept")
            .count();
        let incorrect = self.cases.len() - correct;
        let references = self
            .cases
            .iter()
            .filter(|case| case.expected_review.is_some())
            .count();
        let (mut correct_accepted, mut wrong_accepted, mut incorrect_completed) = (0, 0, 0);
        let (mut technical_failures, mut uncertain, mut generation_calls, mut reference_matches) =
            (0, 0, 0, 0);
        for case in &self.cases {
            let started = Instant::now();
            let observation = observer(case);
            generation_calls += observation.generation_calls;
            let observed = verdict(&observation.result);
            let matched = review_matches(case, &observation.result);
            reference_matches += usize::from(matched == Some(true));
            match (case.expected_verdict.as_str(), observed) {
                ("accept", "accept") => correct_accepted += 1,
                ("reject", "accept") => {
                    wrong_accepted += 1;
                    incorrect_completed += 1;
                }
                ("reject", "reject") => incorrect_completed += 1,
                (_, "technical_failure") => technical_failures += 1,
                (_, "uncertain") => uncertain += 1,
                _ => {}
            }
            println!(
                "{}",
                json!({"phase":"review_development_flow","model":probe.model.metadata(),
                "case":case.id,"pair":case.pair_id,"packetKind":self.packet_kind,
                "expectedVerdict":case.expected_verdict,"observedVerdict":observed,
                "expectedReview":case.expected_review,"referenceFieldsMatched":matched,
                "elapsed_ms":started.elapsed().as_secs_f64()*1000.0,
                "result":observation.result.as_ref().ok(),"failure":observation.result.as_ref().err(),
                "semantic_accepted":false,"production_accepted":false,
                "native_io_authenticated":false,"product_role_authorized":false})
            );
        }
        let required_correct = (correct * 90).div_ceil(100);
        let gates = correct_accepted >= required_correct
            && wrong_accepted == 0
            && incorrect_completed == incorrect
            && technical_failures == 0
            && uncertain == 0
            && reference_matches == references;
        println!(
            "{}",
            json!({"phase":"review_development_summary","model":probe.model.metadata(),
            "packetKind":self.packet_kind,"scheduledCases":self.cases.len(),"generationCalls":generation_calls,
            "correctAccepted":correct_accepted,"scheduledCorrect":correct,"criticalWrongAccepted":wrong_accepted,
            "scheduledIncorrect":incorrect,"incorrectVerdictsCompleted":incorrect_completed,
            "technicalFailures":technical_failures,"uncertainVerdicts":uncertain,
            "referenceCases":references,"referenceFieldsMatched":reference_matches,"referenceGatesMet":gates,
            "semantic_accepted":false,"production_accepted":false,
            "native_io_authenticated":false,"product_role_authorized":false,
            "scope":"development reviewer reference gate only; useful-answer/native/offline/installed gates remain open"})
        );
        if gates {
            Ok(())
        } else {
            Err(
                "reviewer failed frozen development reference gates; retain all scheduled cases"
                    .into(),
            )
        }
    }
}

#[cfg(test)]
#[path = "review_execution_tests.rs"]
mod tests;
