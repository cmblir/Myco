//! Fixed paired Korean advice diagnostic; automated delivery is not semantic acceptance.

use super::*;
use myco_lib::local_generation::direct_reading_qa::{development::PreparedCase, KoAdvicePolicyQa};
use myco_lib::local_synthesis::original_groups_qa::decode;
use std::cell::{Cell, RefCell};

const PREPARE_STOP: &str = "advice_policy_pair_writer_prepared";
const CASES: [(usize, &str, usize); 4] = [
    (1, "FUTURE-A-ALL", 9),
    (4, "FUTURE-A-D2", 2),
    (5, "FUTURE-A-D4", 3),
    (6, "FUTURE-A-D3", 2),
];

#[derive(Clone, Debug, PartialEq, Eq)]
struct Wire {
    system: String,
    user: String,
}
struct PairInputs {
    control: Wire,
    treatment: Wire,
}
impl PairInputs {
    fn get(&self, policy: KoAdvicePolicyQa) -> &Wire {
        match policy {
            KoAdvicePolicyQa::ExistingControl => &self.control,
            KoAdvicePolicyQa::IntentConditionalV1 => &self.treatment,
        }
    }
}
fn arm(policy: KoAdvicePolicyQa) -> &'static str {
    match policy {
        KoAdvicePolicyQa::ExistingControl => "control",
        KoAdvicePolicyQa::IntentConditionalV1 => "treatment",
    }
}
fn order(index: usize) -> [KoAdvicePolicyQa; 2] {
    use KoAdvicePolicyQa::{ExistingControl, IntentConditionalV1};
    if index % 2 == 0 {
        [ExistingControl, IntentConditionalV1]
    } else {
        [IntentConditionalV1, ExistingControl]
    }
}

fn prepare_writer(case: &PreparedCase, policy: KoAdvicePolicyQa) -> Result<Wire, String> {
    let captured = RefCell::new(None);
    let generated = Cell::new(false);
    let outcome = case.run_with_advice_policy_qa(
        QaWireFormat::SourceDocumentGroupsQaV1,
        policy,
        |system, user| {
            if captured.borrow().is_some() {
                return Err("paired preparation repeated".into());
            }
            *captured.borrow_mut() = Some(Wire {
                system: system.into(),
                user: user.into(),
            });
            // This is preparation only; no tokenizer or model is accessed by this callback.
            Err(PREPARE_STOP.into())
        },
        |_, _, _, _, _| {
            generated.set(true);
            Err("paired preparation cannot generate".into())
        },
    );
    if generated.get()
        || !outcome.as_ref().is_err_and(|error| {
            error.code == "review_unavailable"
                && error.detail == format!("review_unavailable: {PREPARE_STOP}")
        })
    {
        return Err("paired writer preparation did not stop at its first count boundary".into());
    }
    captured
        .into_inner()
        .ok_or_else(|| "paired writer preparation absent".into())
}

fn verify_pair(control: &Wire, treatment: &Wire) -> Result<(), String> {
    let old = KoAdvicePolicyQa::ExistingControl.branches();
    let new = KoAdvicePolicyQa::IntentConditionalV1.branches();
    if old == new
        || control.user != treatment.user
        || control.system.matches(old).count() != 1
        || treatment.system.matches(new).count() != 1
        || control.system.replacen(old, new, 1) != treatment.system
    {
        return Err("paired writer inputs differ beyond the registered policy branch block".into());
    }
    Ok(())
}

fn prepare_pairs(prepared: &[PreparedCase]) -> Result<Vec<PairInputs>, String> {
    let mut inputs = Vec::new();
    for &(index, id, originals) in &CASES {
        let case = prepared
            .get(index)
            .ok_or("paired development case absent")?;
        if case.id() != id || case.question_index() != 1 || case.original_count() != originals {
            return Err("paired advice case membership changed".into());
        }
        let control = prepare_writer(case, KoAdvicePolicyQa::ExistingControl)?;
        let treatment = prepare_writer(case, KoAdvicePolicyQa::IntentConditionalV1)?;
        verify_pair(&control, &treatment)?;
        inputs.push(PairInputs { control, treatment });
    }
    Ok(inputs)
}

fn review_common(writer: &Wire, user: &str, raw_sha: &str) -> Result<Value, String> {
    let draft: Value = serde_json::from_str(&writer.user).map_err(|error| error.to_string())?;
    let mut review: Value = serde_json::from_str(user).map_err(|error| error.to_string())?;
    let mut expected_originals = Vec::new();
    let sources = draft["sources"]
        .as_array()
        .ok_or("paired writer sources absent")?;
    for source in sources {
        let originals = decode(&source["originalSpans"].to_string())?;
        expected_originals.extend(
            originals
                .as_array()
                .ok_or("paired writer original array absent")?
                .iter()
                .cloned(),
        );
    }
    let originals = decode(&review["originalSpans"].to_string())?;
    let citations = json!(sources
        .iter()
        .map(|source| json!({"id":source["id"],"path":source["path"]}))
        .collect::<Vec<_>>());
    if review["answerInputRevision"] != raw_sha
        || review["context"] != draft["context"]
        || review["contextRevision"] != draft["contextRevision"]
        || review["citations"] != citations
        || originals != Value::Array(expected_originals)
    {
        return Err(
            "paired reviewer lost its actual draft, original order, citation or context binding"
                .into(),
        );
    }
    let object = review
        .as_object_mut()
        .ok_or("paired review object absent")?;
    if object.remove("answer").is_none() || object.remove("answerInputRevision").is_none() {
        return Err("paired review answer view absent".into());
    }
    Ok(review)
}

pub(super) fn run(directory: PathBuf) -> Result<(), String> {
    let prepared = direct_reading_qa::development::prepare_all()?;
    // Compare both actual prepared writer inputs before resolving a model or observing output.
    let pairs = prepare_pairs(&prepared)?;
    let schedule = CASES
        .iter()
        .enumerate()
        .map(|(index, &(_, id, originals))| {
            json!({
                "caseId":id,"originals":originals,"arms":order(index).map(|policy| policy.as_str())
            })
        })
        .collect::<Vec<_>>();
    emit(
        json!({"phase":"advice_policy_pair_admission","wireFormat":"SourceDocumentGroupsQaV1",
        "model":GEMMA12B_CANDIDATE,"samplerProfile":"gemma12BOrdinalQaV1","seed":42,
        "schedule":schedule,"scheduledCases":4,"scheduledCaseArms":8,"positiveArms":6,"goalClarificationArms":2,
        "writerOriginalInstancesPlanned":32,"uniqueOriginals":9,"maximumGenerations":16,"maximumGenerationsPerArm":2,
        "compiledSources":direct_reading_qa::development::corpus_manifest(),"corrections":0,"retries":0,
        "knownDevelopmentCases":true,"heldOut":false,"referenceCriteriaServedToModel":false,
        "writerPairsVerifiedBeforeModelResolution":true,"preparationTokenCounts":0,
        "controlBranchesSha256":fixture::hash(KoAdvicePolicyQa::ExistingControl.branches()),
        "treatmentBranchesSha256":fixture::hash(KoAdvicePolicyQa::IntentConditionalV1.branches()),
        "periodContext":"same captured historical context; no planner or current-state evidence",
        "native_io_authenticated":false,"product_role_authorized":false,"activityClaimReview":"not_run",
        "activityContractAccepted":false,"semantic_accepted":false,"production_accepted":false}),
    )?;
    let model = resolve_verified_artifact(&directory, &GEMMA12B_CANDIDATE)?;
    let mut host = LocalLlm::load_embed_host()?;
    let total_calls = Cell::new(0usize);
    let result = (|| {
        host.ensure_chat_model(&model)?;
        let mut failures = Vec::new();
        let mut observed_arms = 0usize;
        for (pair_index, (&(case_index, id, _), inputs)) in CASES.iter().zip(&pairs).enumerate() {
            let case = &prepared[case_index];
            let common_review = RefCell::new(None::<(String, Value)>);
            let review_inputs = Cell::new(0usize);
            let mut case_failures = 0usize;
            for (arm_index, policy) in order(pair_index).into_iter().enumerate() {
                let expected = inputs.get(policy);
                let counts = Cell::new(0usize);
                let calls = Cell::new(0usize);
                let counted_wire = RefCell::new(None::<Wire>);
                let writer_raw = RefCell::new(None::<String>);
                let outcome = case.run_with_advice_policy_qa(QaWireFormat::SourceDocumentGroupsQaV1, policy,
                    |system, user| {
                        let count = counts.get() + 1;
                        if count > 2 || calls.get() + 1 != count {
                            return Err("paired count stage repeated or reordered".into());
                        }
                        counts.set(count);
                        let stage = if count == 1 { "draft" } else { "review" };
                        let current = Wire { system:system.into(), user:user.into() };
                        if count == 1 {
                            if &current != expected { return Err("actual paired writer input changed after preparation".into()); }
                        } else {
                            let raw_sha = writer_raw.borrow();
                            let common = review_common(expected, user, raw_sha.as_deref().ok_or("paired writer raw SHA absent")?)?;
                            let mut prior = common_review.borrow_mut();
                            if let Some((prior_system, prior_common)) = prior.as_ref() {
                                if prior_system != system || prior_common != &common {
                                    return Err("paired review SYSTEM or shared whole-original view changed between arms".into());
                                }
                            } else { *prior = Some((system.into(), common)); }
                            review_inputs.set(review_inputs.get()+1);
                        }
                        let counted = host.chat_token_count(system,user);
                        emit(json!({"phase":"advice_policy_pair_count","caseId":id,"caseIndex":case_index,
                            "pairIndex":pair_index,"armIndex":arm_index,"arm":arm(policy),"policyVersion":policy.as_str(),"stage":stage,
                            "system":system,"user":user,"systemSha256":fixture::hash(system),"userSha256":fixture::hash(user),
                            "tokenCount":counted.as_ref().ok(),"error":counted.as_ref().err(),
                            "contextTokens":4096,"outputTokens":768,"reserve":8,"inputAllowance":3320,
                            "referenceCriteriaServedToModel":false,"semantic_accepted":false,"production_accepted":false}))?;
                        let tokens = counted?;
                        *counted_wire.borrow_mut() = Some(current);
                        Ok(tokens)
                    },
                    |system,user,output,context,schema| {
                        let call = calls.get()+1;
                        let expected_schema = if call == 1 { GenerationSchema::AskAnswerV1 } else { GenerationSchema::AskAnswerReviewV1 };
                        let actual = Wire { system:system.into(),user:user.into() };
                        if call > 2 || total_calls.get() >= 16 || counts.get() != call
                            || schema != expected_schema || (output,context) != (768,4096)
                            || counted_wire.borrow_mut().take().as_ref() != Some(&actual) {
                            return Err("paired generation schema, budget or counted input changed".into());
                        }
                        calls.set(call); total_calls.set(total_calls.get()+1);
                        let started = Instant::now();
                        let attempt = host.generate_gemma12b_ordinal_cancellable_measured_qa(system,user,output,context,schema,&AtomicBool::new(false));
                        let telemetry = serde_json::to_value(attempt.telemetry()).map_err(|error|error.to_string());
                        let generated = attempt.into_result();
                        let schema_name = if call == 1 { "askAnswerV1" } else { "askAnswerReviewV1" };
                        let clean = telemetry.as_ref().is_ok_and(|value| value["profile"] == "gemma12BOrdinalQaV1"
                            && value["schema"] == schema_name && value["requestedOutputTokens"] == 768
                            && value["requestedContextTokens"] == 4096 && value["loopStop"] == "eog"
                            && value["terminal"] == "returnedText" && value["pendingUtf8Bytes"] == 0 && value["errorCode"].is_null());
                        // Preserve every actual raw result before draft parsing, review or acceptance.
                        emit(json!({"phase":"advice_policy_pair_generation","caseId":id,"caseIndex":case_index,
                            "pairIndex":pair_index,"armIndex":arm_index,"arm":arm(policy),"policyVersion":policy.as_str(),"call":call,
                            "system":system,"user":user,"systemSha256":fixture::hash(system),"userSha256":fixture::hash(user),
                            "grammarSha256":schema.qa_grammar_sha256(),"telemetry":telemetry.as_ref().ok(),"telemetryError":telemetry.as_ref().err(),
                            "rawOutput":generated.as_ref().ok(),"rawOutputSha256":generated.as_ref().ok().map(|raw|fixture::hash(raw)),
                            "error":generated.as_ref().err(),"cleanObservedDecode":clean,"elapsedSeconds":started.elapsed().as_secs_f64(),
                            "native_io_authenticated":false,"product_role_authorized":false,"semantic_accepted":false,"production_accepted":false}))?;
                        if call == 1 { *writer_raw.borrow_mut() = generated.as_ref().ok().map(|raw|fixture::hash(raw)); }
                        if !clean { return Err("paired decode telemetry was not clean EOG".into()); }
                        generated
                    });
                observed_arms += 1;
                emit(
                    json!({"phase":"advice_policy_pair_arm_terminal","caseId":id,"caseIndex":case_index,"pairIndex":pair_index,
                    "armIndex":arm_index,"arm":arm(policy),"policyVersion":policy.as_str(),"generationCalls":calls.get(),
                    "countCallbackCalls":counts.get(),"suppliedOriginalSpans":case.original_count(),"diagnostic":outcome.as_ref().ok(),
                    "error":outcome.as_ref().err().map(|error|json!({"code":error.code,"detail":error.detail})),
                    "meaningReview":"independent source-first audit required; automated delivery is not truth",
                    "native_io_authenticated":false,"product_role_authorized":false,"activityContractAccepted":false,
                    "semantic_accepted":false,"production_accepted":false}),
                )?;
                if let Err(error) = outcome {
                    case_failures += 1;
                    failures.push(format!(
                        "case {id} {}: {}: {}",
                        arm(policy),
                        error.code,
                        error.detail
                    ));
                }
            }
            emit(
                json!({"phase":"advice_policy_pair_case_terminal","caseId":id,"pairIndex":pair_index,
                "scheduledArms":2,"observedArmTerminals":2,"failedDiagnosticArms":case_failures,
                "reviewInputArmsObserved":review_inputs.get(),"reviewInputsComparedAcrossArms":review_inputs.get()==2,
                "semantic_accepted":false,"production_accepted":false}),
            )?;
        }
        emit(
            json!({"phase":"advice_policy_pair_schedule_terminal","scheduledCases":4,"observedCaseTerminals":4,
            "scheduledCaseArms":8,"observedArmTerminals":observed_arms,"positiveArms":6,"goalClarificationArms":2,
            "generationCalls":total_calls.get(),"maximumGenerations":16,"failedDiagnosticArms":failures.len(),
            "knownDevelopmentCases":true,"heldOut":false,"referenceMeaningAcceptance":"not_assessed",
            "native_io_authenticated":false,"product_role_authorized":false,"semantic_accepted":false,"production_accepted":false}),
        )?;
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    })();
    drop(host);
    emit(
        json!({"phase":"advice_policy_pair_host_dropped","ownedHostDropCompleted":true,
        "gpuMemoryReturnObserved":false,"processGlobalBackendReleaseObserved":false,"generationCalls":total_calls.get(),
        "semantic_accepted":false,"production_accepted":false}),
    )?;
    result
}

#[cfg(test)]
#[path = "advice_policy_pair_tests.rs"]
mod tests;
