//! Explicit synthetic compatibility probe; no private-vault or installed-model fallback.

use myco_lib::local_llm::LocalLlm;
use myco_lib::local_model::{
    resolve_verified_artifact, ModelManifest, GEMMA_CANDIDATE as CANDIDATE, MODEL,
};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

#[path = "local_candidate_probe/activity_smoke.rs"]
mod activity_smoke;
#[cfg(test)]
#[path = "local_candidate_probe/claim_budget_tests.rs"]
mod claim_budget_tests;
#[path = "local_candidate_probe/development_smoke.rs"]
mod development_smoke;
#[cfg(test)]
#[path = "local_candidate_probe/review_smoke_tests.rs"]
mod review_smoke_tests;
#[cfg(test)]
#[path = "local_candidate_probe/review_source_ledger_cli_tests.rs"]
mod review_source_ledger_cli_tests;
#[cfg(test)]
#[path = "local_candidate_probe/single_proposition_cli_tests.rs"]
mod single_proposition_cli_tests;

#[cfg(feature = "native-index-probe")]
#[path = "local_candidate_probe/ordinary_smoke.rs"]
mod ordinary_smoke;
#[cfg(feature = "native-index-probe")]
#[path = "local_candidate_probe/review_decomposition.rs"]
mod review_decomposition;
#[cfg(feature = "native-index-probe")]
#[path = "local_candidate_probe/review_decomposition_execution.rs"]
mod review_decomposition_execution;
#[cfg(feature = "native-index-probe")]
#[path = "local_candidate_probe/review_execution.rs"]
mod review_execution;
#[cfg(feature = "native-index-probe")]
#[path = "local_candidate_probe/review_packets.rs"]
mod review_packets;
#[cfg(feature = "native-index-probe")]
#[path = "local_candidate_probe/review_smoke.rs"]
mod review_smoke;
#[cfg(feature = "native-index-probe")]
#[path = "local_candidate_probe/single_proposition.rs"]
mod single_proposition;

// The helper remains explicitly selected and uses the shared pinned QA artifact.
const QWEN9B_CANDIDATE: ModelManifest = myco_lib::local_model::QWEN9B_CANDIDATE;

#[derive(Clone, Copy)]
struct ProbeModel {
    manifest: ModelManifest,
    explicit: bool,
}

impl ProbeModel {
    fn select(id: Option<&str>) -> Result<Self, String> {
        let manifest = match id {
            None => CANDIDATE,
            Some(id) if id == CANDIDATE.id => CANDIDATE,
            Some(id) if id == MODEL.id => MODEL,
            Some(id) if id == QWEN9B_CANDIDATE.id => QWEN9B_CANDIDATE,
            _ => {
                return Err(
                    "unsupported QA model ID; select pinned Gemma, Qwen4B or explicit Qwen9B"
                        .into(),
                )
            }
        };
        Ok(Self {
            manifest,
            explicit: id.is_some(),
        })
    }

    fn metadata(self) -> Value {
        json!({"manifest":self.manifest,"modelIdExplicit":self.explicit,
            "manifestSource":if self.manifest.id == MODEL.id {"app::local_model::MODEL"}
                else if self.manifest.id == QWEN9B_CANDIDATE.id {"qa::local_candidate_probe::QWEN9B_CANDIDATE"}
                else {"app::local_model::GEMMA_CANDIDATE"},
            "templateContract":if self.manifest.id == CANDIDATE.id {"native-pinned-gemma4-text-only-non-thinking"}
                else {"native-pinned-qwen35-text-only-non-thinking"}})
    }
}

#[derive(Clone, Copy)]
struct ProbeHost<'a> {
    host: &'a LocalLlm,
    model: &'a ProbeModel,
    claim_output_tokens: Option<i32>,
}

struct ProbeOptions {
    directory: PathBuf,
    model: ProbeModel,
    template_only: bool,
    activity: bool,
    ordinary: bool,
    activity_positive: bool,
    activity_contract_experiment: bool,
    activity_development: Option<PathBuf>,
    claim_output_tokens: Option<i32>,
    review_development: Option<PathBuf>,
    review_whole_packet: Option<PathBuf>,
    review_source_audit: Option<PathBuf>,
    review_system: Option<PathBuf>,
    review_reason_first: bool,
    review_admission_only: bool,
    review_source_ledger: bool,
    review_source_ledger_system: Option<PathBuf>,
    review_source_ledger_only: bool,
    review_single_proposition: bool,
    review_single_proposition_actor_contract: bool,
    review_single_proposition_bounded_thinking: bool,
}

fn parse_arguments(arguments: impl IntoIterator<Item = String>) -> Result<ProbeOptions, String> {
    let mut arguments = arguments.into_iter();
    let mut directory = None;
    let mut model_id = None;
    let mut template_only = false;
    let mut activity = false;
    let mut ordinary = false;
    let mut activity_positive = false;
    let mut activity_contract_experiment = false;
    let mut activity_development = None;
    let mut claim_output_tokens = None;
    let mut review_development = None;
    let mut review_whole_packet = None;
    let mut review_source_audit = None;
    let mut review_system = None;
    let mut review_reason_first = false;
    let mut review_admission_only = false;
    let mut review_source_ledger = false;
    let mut review_source_ledger_system = None;
    let mut review_source_ledger_only = false;
    let mut review_single_proposition = false;
    let mut review_single_proposition_actor_contract = false;
    let mut review_single_proposition_bounded_thinking = false;
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--review-single-proposition-bounded-thinking"
                if !review_single_proposition_bounded_thinking =>
            {
                if !cfg!(feature = "native-index-probe") {
                    return Err(
                        "bounded thinking QA requires the native-index-probe feature".into(),
                    );
                }
                review_single_proposition_bounded_thinking = true;
            }
            "--review-single-proposition-actor-contract"
                if !review_single_proposition_actor_contract =>
            {
                if !cfg!(feature = "native-index-probe") {
                    return Err("actor-contract QA requires the native-index-probe feature".into());
                }
                review_single_proposition_actor_contract = true;
            }
            "--review-single-proposition" if !review_single_proposition => {
                if !cfg!(feature = "native-index-probe") {
                    return Err(
                        "single-proposition QA requires the native-index-probe feature".into(),
                    );
                }
                review_single_proposition = true;
            }
            "--review-development-smoke"
            | "--review-whole-packet-smoke"
            | "--review-source-audit"
            | "--review-system"
            | "--review-source-ledger-system" => {
                if !cfg!(feature = "native-index-probe") {
                    return Err("reviewer QA requires the native-index-probe feature".into());
                }
                let target = match argument.as_str() {
                    "--review-development-smoke" => &mut review_development,
                    "--review-whole-packet-smoke" => &mut review_whole_packet,
                    "--review-source-audit" => &mut review_source_audit,
                    "--review-source-ledger-system" => &mut review_source_ledger_system,
                    _ => &mut review_system,
                };
                if target.is_some() {
                    return Err(format!("unsupported or repeated argument: {argument}"));
                }
                let path = arguments
                    .next()
                    .filter(|path| !path.is_empty() && !path.starts_with("--"))
                    .ok_or_else(|| format!("{argument} requires an explicit path"))?;
                *target = Some(PathBuf::from(path));
            }
            "--review-reason-first" if !review_reason_first => {
                if !cfg!(feature = "native-index-probe") {
                    return Err("reviewer QA requires the native-index-probe feature".into());
                }
                review_reason_first = true;
            }
            "--review-source-ledger" if !review_source_ledger => {
                if !cfg!(feature = "native-index-probe") {
                    return Err("reviewer QA requires the native-index-probe feature".into());
                }
                review_source_ledger = true;
            }
            "--review-source-ledger-only" if !review_source_ledger_only => {
                if !cfg!(feature = "native-index-probe") {
                    return Err("reviewer QA requires the native-index-probe feature".into());
                }
                review_source_ledger_only = true;
            }
            "--review-admission-only" if !review_admission_only => {
                if !cfg!(feature = "native-index-probe") {
                    return Err("reviewer QA requires the native-index-probe feature".into());
                }
                review_admission_only = true;
            }
            "--model-dir" if directory.is_none() => {
                let path = arguments
                    .next()
                    .filter(|path| !path.is_empty() && !path.starts_with("--"))
                    .ok_or("--model-dir requires a path")?;
                directory = Some(PathBuf::from(path));
            }
            "--model-id" if model_id.is_none() => {
                model_id = Some(
                    arguments
                        .next()
                        .filter(|id| !id.is_empty() && !id.starts_with("--"))
                        .ok_or("--model-id requires an exact pinned model ID")?,
                );
            }
            "--template-only" if !template_only => template_only = true,
            "--activity-smoke" if !activity => activity = true,
            "--activity-positive-smoke" if !activity_positive => activity_positive = true,
            "--activity-contract-experiment" if !activity_contract_experiment => {
                activity_contract_experiment = true;
            }
            "--activity-development-smoke" if activity_development.is_none() => {
                let path = arguments
                    .next()
                    .filter(|path| !path.is_empty() && !path.starts_with("--"))
                    .ok_or("--activity-development-smoke requires an explicit manifest path")?;
                activity_development = Some(PathBuf::from(path));
            }
            "--activity-claim-output-tokens" if claim_output_tokens.is_none() => {
                claim_output_tokens = Some(match arguments.next().as_deref() {
                    Some("768") => 768,
                    Some("1536") => 1536,
                    _ => return Err("claim output trial requires exactly 768 or 1536".into()),
                });
            }
            "--ordinary-smoke" if !ordinary => {
                if !cfg!(feature = "native-index-probe") {
                    return Err(
                        "--ordinary-smoke requires the native-index-probe QA feature".into(),
                    );
                }
                ordinary = true;
            }
            _ => return Err(format!("unsupported or repeated argument: {argument}")),
        }
    }
    let directory = directory.ok_or("--model-dir is required; no installed/private fallback")?;
    let has_review = review_development.is_some() || review_whole_packet.is_some();
    if (review_development.is_some() && review_whole_packet.is_some())
        || has_review != review_source_audit.is_some()
        || ((review_system.is_some()
            || review_reason_first
            || review_admission_only
            || review_source_ledger
            || review_source_ledger_system.is_some()
            || review_source_ledger_only
            || review_single_proposition
            || review_single_proposition_actor_contract
            || review_single_proposition_bounded_thinking)
            && !has_review)
    {
        return Err("reviewer QA requires an explicit manifest and source audit together".into());
    }
    if has_review && model_id.is_none() {
        return Err("reviewer QA requires an explicit exact pinned model ID".into());
    }
    if review_single_proposition_actor_contract && !review_single_proposition {
        return Err("actor-contract QA requires --review-single-proposition".into());
    }
    if review_single_proposition_bounded_thinking
        && (!review_single_proposition
            || !review_single_proposition_actor_contract
            || model_id.as_deref() != Some(CANDIDATE.id))
    {
        return Err(
            "bounded thinking QA requires explicit pinned Gemma actor-contract propositions".into(),
        );
    }
    if review_single_proposition
        && (review_development.is_none()
            || review_whole_packet.is_some()
            || review_system.is_some()
            || review_reason_first
            || review_source_ledger
            || review_source_ledger_system.is_some()
            || review_source_ledger_only)
    {
        return Err("single-proposition QA requires only the frozen single-span suite".into());
    }
    if review_source_ledger && (review_reason_first || review_system.is_some()) {
        return Err(
            "source-ledger decomposition cannot be combined with SYSTEM or field-order trials"
                .into(),
        );
    }
    if (review_source_ledger_system.is_some() || review_source_ledger_only) && !review_source_ledger
    {
        return Err(
            "source-ledger SYSTEM and source-only trials require --review-source-ledger".into(),
        );
    }
    if review_source_ledger_only && review_admission_only {
        return Err("source-only inference and admission-only QA must run separately".into());
    }
    if review_reason_first && review_system.is_some() {
        return Err("reviewer grammar and SYSTEM interventions must run separately".into());
    }
    if has_review
        && (template_only
            || activity
            || activity_positive
            || ordinary
            || activity_contract_experiment
            || activity_development.is_some()
            || claim_output_tokens.is_some())
    {
        return Err(
            "reviewer QA cannot be combined with another flow or output-budget mode".into(),
        );
    }
    if template_only
        && (activity
            || activity_positive
            || ordinary
            || activity_contract_experiment
            || activity_development.is_some())
    {
        return Err("--template-only and flow smoke flags are mutually exclusive".into());
    }
    if activity_development.is_some() && activity_contract_experiment {
        return Err("development fixtures cannot use a runtime prompt experiment".into());
    }
    if claim_output_tokens.is_some()
        && (template_only
            || ordinary
            || activity_contract_experiment
            || !(activity || activity_positive || activity_development.is_some()))
    {
        return Err("claim output trial requires only unchanged activity flow modes".into());
    }
    Ok(ProbeOptions {
        directory,
        model: ProbeModel::select(model_id.as_deref())?,
        template_only,
        activity,
        ordinary,
        activity_positive,
        activity_contract_experiment,
        activity_development,
        claim_output_tokens,
        review_development,
        review_whole_packet,
        review_source_audit,
        review_system,
        review_reason_first,
        review_admission_only,
        review_source_ledger,
        review_source_ledger_system,
        review_source_ledger_only,
        review_single_proposition,
        review_single_proposition_actor_contract,
        review_single_proposition_bounded_thinking,
    })
}

fn validate_record(record: &Value, model: ProbeModel) -> Result<(), String> {
    if record["schema_version"] != 1 {
        return Err("unsupported isolated artifact record schema".into());
    }
    let mut matches = record["artifacts"]
        .as_array()
        .ok_or("isolated artifact record has no artifacts")?
        .iter()
        .filter(|item| item["id"] == model.manifest.id);
    let pinned = matches
        .next()
        .ok_or("selected model is not in the isolated artifact record")?;
    if matches.next().is_some() {
        return Err("selected model has duplicate isolated artifact records".into());
    }
    let encoded = serde_json::to_value(model.manifest)
        .map_err(|error| format!("selected manifest: {error}"))?;
    for (field, value) in encoded.as_object().ok_or("invalid selected manifest")? {
        if pinned[field] != *value {
            return Err(format!("selected model record differs at {field}"));
        }
    }
    Ok(())
}

fn main() -> Result<(), String> {
    let ProbeOptions {
        directory,
        model,
        template_only,
        activity,
        ordinary,
        activity_positive,
        activity_contract_experiment,
        activity_development,
        claim_output_tokens,
        review_development,
        review_whole_packet,
        review_source_audit,
        review_system,
        review_reason_first,
        review_admission_only,
        review_source_ledger,
        review_source_ledger_system,
        review_source_ledger_only,
        review_single_proposition,
        review_single_proposition_actor_contract,
        review_single_proposition_bounded_thinking,
    } = parse_arguments(std::env::args().skip(1))?;
    // Reject malformed or unreviewed development inputs before artifact loading.
    let development = activity_development
        .as_deref()
        .map(development_smoke::load)
        .transpose()?;
    #[cfg(feature = "native-index-probe")]
    let review = review_development
        .as_deref()
        .map(|manifest| {
            review_smoke::load(
                manifest,
                review_source_audit
                    .as_deref()
                    .ok_or("reviewer QA source audit is missing")?,
                review_system.as_deref(),
                review_reason_first,
            )
        })
        .transpose()?;
    #[cfg(feature = "native-index-probe")]
    let review = if let Some(manifest) = review_whole_packet.as_deref() {
        Some(review_packets::load(
            manifest,
            review_source_audit
                .as_deref()
                .ok_or("reviewer QA source audit is missing")?,
            review_system.as_deref(),
            review_reason_first,
        )?)
    } else {
        review
    };
    #[cfg(feature = "native-index-probe")]
    let source_ledger_system = review_decomposition_execution::load_source_ledger_system(
        review_source_ledger_system.as_deref(),
    )?;
    #[cfg(not(feature = "native-index-probe"))]
    let _ = (
        &review_source_audit,
        &review_system,
        review_reason_first,
        review_admission_only,
        review_source_ledger,
        &review_source_ledger_system,
        review_source_ledger_only,
        review_single_proposition,
        review_single_proposition_actor_contract,
        review_single_proposition_bounded_thinking,
    );
    if let Some(suite) = &development {
        println!("{}", suite.metadata());
    }
    #[cfg(feature = "native-index-probe")]
    if let Some(suite) = &review {
        println!("{}", suite.metadata());
    }
    #[cfg(feature = "native-index-probe")]
    if let Some(system) = &source_ledger_system {
        println!(
            "{}",
            json!({"phase":"review_source_ledger_system_override",
                "path":review_source_ledger_system,"bytes":system.len(),
                "sha256":review_smoke::hash(system.as_bytes()),
                "productionSystemUnchanged":true,"semantic_accepted":false,
                "production_accepted":false,"native_io_authenticated":false,
                "product_role_authorized":false})
        );
    }
    if let Some(output) = claim_output_tokens {
        println!(
            "{}",
            json!({"phase":"claim_output_budget_trial", "claimOutputTokens":output,
            "otherStageOutputTokens":768,"contextTokens":4096,
            "productionExtractionDefaultTokens":768,"sourceWindowBudgetTokens":768,
            "fullPromptReserveFitRequired":true,"promptOverride":false,
            "semantic_accepted":false,"production_accepted":false})
        );
    }
    let record: serde_json::Value =
        serde_json::from_str(include_str!("../eval/local-model-artifacts.json"))
            .map_err(|error| format!("candidate record: {error}"))?;
    validate_record(&record, model)?;
    let started = Instant::now();
    println!(
        "{}",
        serde_json::json!({"phase":"artifact_verification_started", "bytes":model.manifest.bytes,
        "model":model.metadata(),
        "production_accepted":false})
    );
    let path = resolve_verified_artifact(&directory, &model.manifest)?;
    println!(
        "{}",
        serde_json::json!({"phase":"artifact", "id":model.manifest.id,"model":model.metadata(),
        "sha256":model.manifest.sha256, "verification_ms":started.elapsed().as_secs_f64()*1000.0,
        "production_accepted":false})
    );
    println!(
        "{}",
        serde_json::json!({"phase":"backend_start","model":model.metadata()})
    );
    let mut host = LocalLlm::load_embed_host()?;
    let started = Instant::now();
    println!(
        "{}",
        serde_json::json!({"phase":"model_load_start","model":model.metadata()})
    );
    host.ensure_chat_model(&path)?;
    println!(
        "{}",
        serde_json::json!({"phase":"load","model":model.metadata(),"host_template_validation_passed":true,
        "load_ms":started.elapsed().as_secs_f64()*1000.0})
    );
    let probe = ProbeHost {
        host: &host,
        model: &model,
        claim_output_tokens,
    };
    let system = "Answer only from the supplied synthetic note. Return JSON with answer and sources. Use S1 for a supported fact. Do not add facts.";
    let user = "[S1] Synthetic note: the prefill batch contains 128 tokens. Question: how many tokens does that batch contain?";
    println!(
        "{}",
        serde_json::json!({"phase":"template_start","model":model.metadata()})
    );
    let prompt_tokens = host.chat_token_count(system, user)?;
    println!(
        "{}",
        serde_json::json!({"phase":"template","model":model.metadata(), "prompt_tokens":prompt_tokens,
        "scope":"synthetic compatibility, not semantic acceptance"})
    );
    let mut failures = Vec::new();
    if !template_only && review_development.is_none() && review_whole_packet.is_none() {
        let fact = (|| {
            let started = Instant::now();
            let output = host.generate_cancellable(system, user, 192, &AtomicBool::new(false))?;
            println!(
                "{}",
                serde_json::json!({"phase":"generation","model":model.metadata(), "elapsed_ms":started.elapsed().as_secs_f64()*1000.0,
            "output":output, "scope":"single compatibility smoke, not held-out quality"})
            );
            let parsed: serde_json::Value = serde_json::from_str(&output)
                .map_err(|error| format!("smoke structured output: {error}"))?;
            if parsed["sources"] != serde_json::json!(["S1"])
                || !parsed["answer"]
                    .as_str()
                    .is_some_and(|answer| answer.contains("128"))
            {
                return Err(
                    "synthetic compatibility smoke did not preserve the supplied fact/reference"
                        .into(),
                );
            }
            Ok(())
        })();
        record_result(model, "fact", fact, &mut failures);
    }
    #[cfg(feature = "native-index-probe")]
    if let Some(suite) = &review {
        let (name, result) = if review_single_proposition {
            (
                "review_single_proposition",
                single_proposition::run(
                    suite,
                    probe,
                    review_admission_only,
                    review_single_proposition_actor_contract,
                    review_single_proposition_bounded_thinking,
                ),
            )
        } else if review_source_ledger {
            (
                "review_source_ledger",
                review_decomposition_execution::run(
                    suite,
                    probe,
                    review_admission_only,
                    source_ledger_system.as_deref(),
                    review_source_ledger_only,
                ),
            )
        } else if review_admission_only {
            ("review_admission", suite.preflight(probe))
        } else {
            ("review_development", suite.run(probe))
        };
        record_result(model, name, result, &mut failures);
    }
    #[cfg(feature = "native-index-probe")]
    if ordinary {
        record_result(model, "ordinary", ordinary_smoke::run(probe), &mut failures);
    }
    if activity {
        record_result(
            model,
            "request_plan_only",
            activity_smoke::run(probe),
            &mut failures,
        );
    }
    if activity_positive {
        record_result(
            model,
            "activity_positive",
            activity_smoke::positive(probe),
            &mut failures,
        );
    }
    if activity_contract_experiment {
        record_result(
            model,
            "activity_contract_experiment",
            activity_smoke::contract_experiment(probe),
            &mut failures,
        );
    }
    if let Some(suite) = &development {
        record_result(
            model,
            "activity_development",
            suite.run(probe),
            &mut failures,
        );
    }
    if activity || activity_positive || ordinary || activity_contract_experiment {
        record_result(
            model,
            "host_cancel_recover",
            activity_smoke::cancel_and_recover(probe),
            &mut failures,
        );
    }
    drop(host);
    println!(
        "{}",
        serde_json::json!({"phase":"probe_terminal","model":model.metadata(),"failures":failures,
        "native_io_authenticated":false,"product_role_authorized":false,
        "semantic_accepted":false,"production_accepted":false,
        "timing_scope":"individual ordered stages, not representative averages"})
    );
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

fn record_result(
    model: ProbeModel,
    case: &str,
    result: Result<(), String>,
    failures: &mut Vec<String>,
) {
    println!(
        "{}",
        serde_json::json!({"phase":"probe_result","model":model.metadata(),"case":case,
        "error":result.as_ref().err(),"native_io_authenticated":false,
        "product_role_authorized":false,"semantic_accepted":false,"production_accepted":false})
    );
    if let Err(error) = result {
        failures.push(format!("{case}: {error}"));
    }
}

#[cfg(test)]
mod qa_model_tests {
    use super::*;

    fn options(args: &[&str]) -> Result<ProbeOptions, String> {
        parse_arguments(args.iter().map(|arg| (*arg).to_string()))
    }

    fn record() -> Value {
        serde_json::from_str(include_str!("../eval/local-model-artifacts.json")).unwrap()
    }

    #[test]
    fn qa_selector_keeps_gemma_default_without_inferring_from_directory() {
        let options = options(&["--model-dir", "/synthetic/qwen3.5-4b-q4_k_m"]).unwrap();
        assert_eq!(
            options.directory,
            PathBuf::from("/synthetic/qwen3.5-4b-q4_k_m")
        );
        assert_eq!(options.model.manifest.id, CANDIDATE.id);
        assert!(!options.model.explicit);
        assert_eq!(
            options.model.metadata()["manifestSource"],
            "app::local_model::GEMMA_CANDIDATE"
        );
    }

    #[test]
    fn qa_gemma_selector_preserves_the_full_pinned_artifact_identity() {
        let selected = ProbeModel::select(Some("gemma-4-e4b-it-qat-q4_0")).unwrap();
        assert_eq!(
            serde_json::to_value(selected.manifest).unwrap(),
            serde_json::json!({
                "id": "gemma-4-e4b-it-qat-q4_0",
                "repository": "google/gemma-4-E4B-it-qat-q4_0-gguf",
                "revision": "4b4a2c1d584be7264f87aac328a1bc739ce81b6c",
                "file": "gemma-4-E4B_q4_0-it.gguf",
                "url": "https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf/resolve/4b4a2c1d584be7264f87aac328a1bc739ce81b6c/gemma-4-E4B_q4_0-it.gguf",
                "bytes": 5_154_941_280_u64,
                "sha256": "676c35070db6dbe52f93e9c864ee0fba4eddea94b9c875d9cb10daff453fbaee",
                "license": "Apache-2.0"
            })
        );
        assert!(selected.explicit);
    }

    #[cfg(feature = "native-index-probe")]
    #[test]
    fn qa_gemma_selector_matches_native_admission_without_changing_the_control() {
        let selected = ProbeModel::select(Some(CANDIDATE.id)).unwrap();
        let admitted = myco_lib::local_model::manifest_for(Some(CANDIDATE.id))
            .expect("native QA admission must use the same pinned candidate as the helper");
        assert_eq!(
            serde_json::to_value(selected.manifest).unwrap(),
            serde_json::to_value(admitted).unwrap()
        );
        assert_eq!(
            myco_lib::local_model::manifest_for(None).unwrap().id,
            MODEL.id
        );
    }

    #[test]
    fn qa_selector_uses_exact_product_qwen_manifest_only_when_explicit() {
        let options = options(&[
            "--model-dir",
            "/synthetic/developer-cache",
            "--model-id",
            MODEL.id,
        ])
        .unwrap();
        assert_eq!(
            serde_json::to_value(options.model.manifest).unwrap(),
            serde_json::to_value(MODEL).unwrap()
        );
        assert!(options.model.explicit);
        assert_eq!(
            options.model.metadata()["manifestSource"],
            "app::local_model::MODEL"
        );
        assert_eq!(options.model.metadata()["manifest"]["sha256"], MODEL.sha256);
        let explicit_gemma = ProbeModel::select(Some(CANDIDATE.id)).unwrap();
        assert_eq!(explicit_gemma.manifest.id, CANDIDATE.id);
        assert!(explicit_gemma.explicit);
    }

    #[test]
    fn qa_qwen9b_requires_explicit_selection_and_preserves_isolated_identity() {
        let selected = options(&[
            "--model-dir",
            "/synthetic/developer-cache",
            "--model-id",
            "qwen3.5-9b-q4_k_m",
        ])
        .expect("the pinned stronger candidate must be explicitly selectable in QA");
        assert!(selected.model.explicit);
        assert_eq!(
            serde_json::to_value(selected.model.manifest).unwrap(),
            json!({
                "id": "qwen3.5-9b-q4_k_m",
                "repository": "lmstudio-community/Qwen3.5-9B-GGUF",
                "revision": "1379f25c6b505a3fc737bd7818cb09389cf807c1",
                "file": "Qwen3.5-9B-Q4_K_M.gguf",
                "url": "https://huggingface.co/lmstudio-community/Qwen3.5-9B-GGUF/resolve/1379f25c6b505a3fc737bd7818cb09389cf807c1/Qwen3.5-9B-Q4_K_M.gguf",
                "bytes": 5_627_044_256_u64,
                "sha256": "cd76ec205963b3b33350093e6904d9de16c4e666fd104e1f632d25c7f15f2a13",
                "license": "Apache-2.0"
            })
        );
        assert_eq!(
            selected.model.metadata()["manifestSource"],
            "qa::local_candidate_probe::QWEN9B_CANDIDATE"
        );
        assert_eq!(
            selected.model.metadata()["templateContract"],
            "native-pinned-qwen35-text-only-non-thinking"
        );
        assert_eq!(
            options(&["--model-dir", "/synthetic/qwen3.5-9b-q4_k_m"])
                .unwrap()
                .model
                .manifest
                .id,
            CANDIDATE.id
        );
        assert!(ProbeModel::select(Some("Qwen3.5-9B-Q4_K_M.gguf")).is_err());
    }

    #[test]
    fn qa_qwen9b_keeps_default_selection_and_feature_scoped_admission() {
        assert_eq!(
            myco_lib::local_model::manifest_for(None).unwrap().id,
            MODEL.id
        );
        #[cfg(not(feature = "native-index-probe"))]
        assert!(myco_lib::local_model::manifest_for(Some("qwen3.5-9b-q4_k_m")).is_err());
        #[cfg(feature = "native-index-probe")]
        assert_eq!(
            serde_json::to_value(
                myco_lib::local_model::manifest_for(Some(QWEN9B_CANDIDATE.id)).unwrap()
            )
            .unwrap(),
            serde_json::to_value(QWEN9B_CANDIDATE).unwrap()
        );
    }

    #[test]
    fn qa_selector_rejects_unknown_missing_and_repeated_values_without_fallback() {
        for args in [
            vec![],
            vec!["--model-id", MODEL.id],
            vec!["--model-dir"],
            vec!["--model-dir", ""],
            vec!["--model-dir", "--model-id", MODEL.id],
            vec!["--model-dir", "/synthetic", "--model-id"],
            vec!["--model-dir", "/synthetic", "--model-id", ""],
            vec![
                "--model-dir",
                "/synthetic",
                "--model-id",
                "Qwen3.5-4B-Q4_K_M.gguf",
            ],
            vec![
                "--model-dir",
                "/synthetic",
                "--model-id",
                "qwen3.5-2b-q4_k_m",
            ],
            vec!["--model-dir", "/synthetic", "--model-id", "unknown"],
            vec![
                "--model-dir",
                "/synthetic",
                "--model-id",
                MODEL.id,
                "--model-id",
                MODEL.id,
            ],
            vec!["--model-dir", "/synthetic", "--model-dir", "/other"],
            vec![
                "--model-dir",
                "/synthetic",
                "--activity-smoke",
                "--activity-smoke",
            ],
            vec![
                "--model-dir",
                "/synthetic",
                "--template-only",
                "--activity-positive-smoke",
            ],
        ] {
            assert!(
                options(&args).is_err(),
                "must reject without loading or fallback: {args:?}"
            );
        }
    }

    #[test]
    fn qa_artifact_record_matches_every_authoritative_manifest_field() {
        for id in [CANDIDATE.id, MODEL.id, "qwen3.5-9b-q4_k_m"] {
            let model = ProbeModel::select(Some(id)).unwrap();
            let valid = record();
            validate_record(&valid, model).unwrap();
            let index = valid["artifacts"]
                .as_array()
                .unwrap()
                .iter()
                .position(|item| item["id"] == id)
                .unwrap();
            let encoded = serde_json::to_value(model.manifest).unwrap();
            for field in encoded.as_object().unwrap().keys() {
                let mut changed = valid.clone();
                changed["artifacts"][index][field] = Value::Bool(true);
                assert!(
                    validate_record(&changed, model).is_err(),
                    "tampered {id}/{field} must reject before model loading"
                );
                let mut missing = valid.clone();
                missing["artifacts"][index]
                    .as_object_mut()
                    .unwrap()
                    .remove(field);
                assert!(
                    validate_record(&missing, model).is_err(),
                    "missing {id}/{field} must reject before model loading"
                );
            }
        }
    }

    #[test]
    fn qa_artifact_record_rejects_missing_duplicate_or_unsupported_records() {
        let model = ProbeModel::select(Some(MODEL.id)).unwrap();
        let mut missing = record();
        missing["artifacts"]
            .as_array_mut()
            .unwrap()
            .retain(|item| item["id"] != MODEL.id);
        assert!(validate_record(&missing, model).is_err());
        let mut duplicate = record();
        let qwen = duplicate["artifacts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == MODEL.id)
            .unwrap()
            .clone();
        duplicate["artifacts"].as_array_mut().unwrap().push(qwen);
        assert!(validate_record(&duplicate, model).is_err());
        let mut unsupported = record();
        unsupported["schema_version"] = json!(2);
        assert!(validate_record(&unsupported, model).is_err());
    }

    #[test]
    fn development_flag_requires_an_explicit_path_without_changing_model_selection() {
        let selected = options(&[
            "--model-dir",
            "/synthetic/developer-cache",
            "--activity-development-smoke",
            "/synthetic/development.manifest.json",
        ])
        .unwrap();
        assert_eq!(selected.model.manifest.id, CANDIDATE.id);
        assert_eq!(
            selected.activity_development,
            Some(PathBuf::from("/synthetic/development.manifest.json"))
        );
        for args in [
            vec!["--model-dir", "/synthetic", "--activity-development-smoke"],
            vec![
                "--model-dir",
                "/synthetic",
                "--activity-development-smoke",
                "",
            ],
            vec![
                "--model-dir",
                "/synthetic",
                "--activity-development-smoke",
                "--activity-smoke",
            ],
            vec![
                "--model-dir",
                "/synthetic",
                "--activity-development-smoke",
                "fixture.json",
                "--activity-development-smoke",
                "other.json",
            ],
            vec![
                "--model-dir",
                "/synthetic",
                "--template-only",
                "--activity-development-smoke",
                "fixture.json",
            ],
            vec![
                "--model-dir",
                "/synthetic",
                "--activity-contract-experiment",
                "--activity-development-smoke",
                "fixture.json",
            ],
        ] {
            assert!(options(&args).is_err(), "must reject: {args:?}");
        }
    }
}
