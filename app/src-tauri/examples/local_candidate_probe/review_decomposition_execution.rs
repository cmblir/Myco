//! Serial QA decomposition; raw observations never grant product authority.

use super::review_decomposition::{self as adapter, CheckedLedger};
use super::review_execution::Observation;
use super::review_smoke::{hash, Case, Suite};
use super::ProbeHost;
use myco_lib::local_generation::review_probe;
use myco_lib::local_llm::GenerationSchema;
use serde_json::{json, Value};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::path::Path;
use std::rc::Rc;
use std::sync::atomic::AtomicBool;

const CONTEXT_TOKENS: u32 = 4096;
const LEDGER_OUTPUT_TOKENS: i32 = 1536;
const REVIEW_OUTPUT_TOKENS: i32 = 768;
const RESERVE_TOKENS: usize = 8;

type LedgerCache = BTreeMap<String, Result<Rc<CheckedLedger>, String>>;

/// Load the exact bounded QA SYSTEM once, before model artifact loading.
pub(super) fn load_source_ledger_system(path: Option<&Path>) -> Result<Option<String>, String> {
    path.map(|path| {
        let bytes = super::review_smoke::read_bounded(path, 16 * 1024)?;
        let text = String::from_utf8(bytes).map_err(|error| error.to_string())?;
        if text.trim().is_empty() {
            return Err("source-ledger SYSTEM cannot be empty".into());
        }
        Ok(text)
    })
    .transpose()
}

fn decode(
    probe: ProbeHost<'_>,
    case: &Case,
    stage: &str,
    prompt: (&str, &str),
    schema: GenerationSchema,
    output_tokens: i32,
    calls: &Cell<usize>,
) -> Result<String, String> {
    let (system, user) = prompt;
    let prompt_tokens = probe.host.chat_token_count(system, user)?;
    let fits = prompt_tokens > 0
        && prompt_tokens + output_tokens as usize + RESERVE_TOKENS <= CONTEXT_TOKENS as usize;
    println!(
        "{}",
        json!({"phase":"review_source_ledger_input","model":probe.model.metadata(),
            "case":case.id,"stage":stage,"systemSha256":hash(system.as_bytes()),
            "userSha256":hash(user.as_bytes()),"grammarSha256":schema.qa_grammar_sha256(),
            "user":serde_json::from_str::<Value>(user).map_err(|error|error.to_string())?,
            "promptTokens":prompt_tokens,"requestedOutputTokens":output_tokens,
            "contextTokens":CONTEXT_TOKENS,"reserveTokens":RESERVE_TOKENS,
            "fullPromptReserveFits":fits,"semantic_accepted":false,"production_accepted":false,
            "native_io_authenticated":false,"product_role_authorized":false})
    );
    if !fits {
        return Err(
            "QA decomposition prompt does not fit the full reserved budget; original retained"
                .into(),
        );
    }
    calls.set(calls.get() + 1);
    let attempt = probe.host.generate_structured_cancellable_measured(
        system,
        user,
        output_tokens,
        CONTEXT_TOKENS,
        schema,
        &AtomicBool::new(false),
    );
    let telemetry = attempt.telemetry().clone();
    let result = attempt.into_result();
    println!(
        "{}",
        json!({"phase":"review_source_ledger_decode","model":probe.model.metadata(),
            "case":case.id,"stage":stage,"telemetry":telemetry,
            "raw":result.as_ref().ok(),"error":result.as_ref().err(),
            "semantic_accepted":false,"production_accepted":false,
            "native_io_authenticated":false,"product_role_authorized":false})
    );
    result
}

fn source_ledger(
    case: &Case,
    probe: ProbeHost<'_>,
    cache: &mut LedgerCache,
    calls: &Cell<usize>,
    ledger_system: &str,
    user: &str,
) -> Result<Rc<CheckedLedger>, String> {
    let key = hash(user.as_bytes());
    let reused = cache.contains_key(&key);
    let entry = cache.entry(key.clone()).or_insert_with(|| {
        let raw = decode(
            probe,
            case,
            "source_only_ledger",
            (ledger_system, user),
            GenerationSchema::WikiClaimsV1,
            LEDGER_OUTPUT_TOKENS,
            calls,
        )?;
        CheckedLedger::admit(case, &raw).map(Rc::new)
    });
    let result = entry.clone();
    println!(
        "{}",
        json!({"phase":"review_source_ledger_binding","model":probe.model.metadata(),
            "case":case.id,"sourceOnlyInputSha256":key,"reusedExactSourceOnlyLedger":reused,
            "sourceLedgerSystemSha256":hash(ledger_system.as_bytes()),
            "ledger":result.as_ref().ok().map(|ledger|ledger.metadata()),
            "error":result.as_ref().err(),"semantic_accepted":false,"production_accepted":false,
            "native_io_authenticated":false,"product_role_authorized":false})
    );
    result
}

fn observe(
    case: &Case,
    probe: ProbeHost<'_>,
    cache: &mut LedgerCache,
    ledger_system: &str,
) -> Observation {
    let counted = RefCell::new(None::<Value>);
    let calls = Cell::new(0);
    let attempt: Result<Result<Value, Value>, String> = (|| {
        let origin = case
            .request
            .origin
            .as_ref()
            .ok_or("review fixture lacks origin")?;
        let ledger_user = adapter::source_only_input(case)?;
        let ledger = source_ledger(case, probe, cache, &calls, ledger_system, &ledger_user)?;
        Ok(review_probe::run(
            &case.request,
            &case.sources,
            origin,
            &case.proposal,
            |system, user| {
                let input: Value = serde_json::from_str(user).map_err(|error| error.to_string())?;
                if case
                    .preview
                    .as_ref()
                    .is_some_and(|preview| preview != &input)
                {
                    return Err("native review USER differs from the frozen preview".into());
                }
                let tokens = probe.host.chat_token_count(system, user)?;
                *counted.borrow_mut() = Some(json!({"systemSha256":hash(system.as_bytes()),
                    "userSha256":hash(user.as_bytes()),"promptTokens":tokens}));
                Ok(tokens)
            },
            |system, user, output, context, schema| {
                let count = counted
                    .borrow()
                    .clone()
                    .ok_or("native review input was not counted")?;
                if (output, context) != (REVIEW_OUTPUT_TOKENS, CONTEXT_TOKENS)
                    || schema.claim_review_decisions().is_none()
                    || count["systemSha256"] != hash(system.as_bytes())
                    || count["userSha256"] != hash(user.as_bytes())
                {
                    return Err("native review input or budget changed after counting".into());
                }
                let input: Value = serde_json::from_str(user).map_err(|error| error.to_string())?;
                let mut fields = Vec::new();
                for id in input["requiredClaimIds"]
                    .as_array()
                    .ok_or("native claim IDs missing")?
                {
                    let id = id.as_str().ok_or("native claim ID is not text")?;
                    let field_user = adapter::field_input(user, id, &ledger)?;
                    let raw = decode(
                        probe,
                        case,
                        "claim_field_review",
                        (adapter::FIELD_SYSTEM, &field_user),
                        GenerationSchema::WikiClaimFieldReviewQaV1,
                        REVIEW_OUTPUT_TOKENS,
                        &calls,
                    )?;
                    adapter::validate_field_output(user, id, &raw)?;
                    fields.push(raw);
                }
                let coverage_user = adapter::coverage_input(user, &ledger)?;
                let coverage = decode(
                    probe,
                    case,
                    "whole_source_coverage",
                    (adapter::COVERAGE_SYSTEM, &coverage_user),
                    GenerationSchema::WikiSourceCoverageQaV1,
                    REVIEW_OUTPUT_TOKENS,
                    &calls,
                )?;
                adapter::validate_coverage_output(user, &coverage)?;
                let projected = adapter::project(user, &ledger, &fields, &coverage)?;
                println!(
                    "{}",
                    json!({"phase":"review_source_ledger_projection","model":probe.model.metadata(),
                    "case":case.id,"sourceOnlyInputSha256":ledger.source_packet_sha256(),
                    "nativeUserSha256":hash(user.as_bytes()),"raw":projected,
                    "semantic_accepted":false,"production_accepted":false,
                    "native_io_authenticated":false,"product_role_authorized":false})
                );
                Ok(projected)
            },
        )
        .map_err(|error| json!(error)))
    })();
    let result = match attempt {
        Ok(result) => result,
        Err(detail) => Err(json!({"code":"qa_decomposition_stage_failed","detail":detail})),
    };
    Observation {
        result,
        generation_calls: calls.get(),
        counted: counted.into_inner(),
    }
}

fn run_source_only(suite: &Suite, probe: ProbeHost<'_>, ledger_system: &str) -> Result<(), String> {
    suite.preflight(probe)?;
    let mut cache = LedgerCache::new();
    let calls = Cell::new(0);
    let mut cached_bindings = 0;
    let mut fresh_admitted = 0;
    let mut fresh_empty = 0;
    let mut fresh_failures = 0;
    let mut pre_binding_failures = 0;
    for case in &suite.cases {
        let input = adapter::source_only_input(case);
        let reused = input
            .as_ref()
            .is_ok_and(|user| cache.contains_key(&hash(user.as_bytes())));
        let before_calls = calls.get();
        let before_cache_entries = cache.len();
        let result = match input {
            Ok(user) => source_ledger(case, probe, &mut cache, &calls, ledger_system, &user),
            Err(error) => {
                pre_binding_failures += 1;
                Err(error)
            }
        };
        if reused {
            cached_bindings += 1;
        } else if result.is_ok() {
            fresh_admitted += 1;
            if result.as_ref().ok().is_some_and(|ledger| {
                ledger.metadata()["checkedClaims"]["outcome"] == "insufficient_evidence"
            }) {
                fresh_empty += 1;
            }
        } else if cache.len() > before_cache_entries {
            fresh_failures += 1;
        }
        println!(
            "{}",
            json!({"phase":"review_source_ledger_only_case","model":probe.model.metadata(),
                "case":case.id,"pair":case.pair_id,"packetKind":suite.packet_kind,
                "reusedExactSourceOnlyLedger":reused,"generationCalls":calls.get()-before_calls,
                "error":result.as_ref().err(),"semantic_accepted":false,
                "production_accepted":false,"native_io_authenticated":false,
                "product_role_authorized":false})
        );
    }
    println!(
        "{}",
        json!({"phase":"review_source_ledger_only_summary","model":probe.model.metadata(),
            "packetKind":suite.packet_kind,"manifestSha256":suite.manifest_sha,
            "sourceAuditSha256":suite.audit_sha,"scheduledCases":suite.cases.len(),
            "observedCases":suite.cases.len(),"distinctSourceOnlyInputs":cache.len(),
            "freshLedgerGenerationCalls":calls.get(),"cachedLedgerBindings":cached_bindings,
            "observedLedgerBindings":cache.len()+cached_bindings,
            "freshStructurallyAdmitted":fresh_admitted,"freshEmptyInsufficientEvidence":fresh_empty,
            "freshLedgerFailures":fresh_failures,"preBindingFailures":pre_binding_failures,
            "downstreamFieldAndCoverageGenerationCalls":0,
            "sourceLedgerSystemSha256":hash(ledger_system.as_bytes()),
            "scope":"source-only phase evidence; full source-fact, reviewer and useful-answer gates remain open",
            "semantic_accepted":false,"production_accepted":false,
            "native_io_authenticated":false,"product_role_authorized":false})
    );
    if fresh_failures > 0 || pre_binding_failures > 0 || fresh_empty > 0 {
        return Err("source-only phase contains failed or empty ledger proposals; retain all scheduled originals and semantic gates".into());
    }
    Ok(())
}

pub(super) fn run(
    suite: &Suite,
    probe: ProbeHost<'_>,
    admission_only: bool,
    system_override: Option<&str>,
    source_only: bool,
) -> Result<(), String> {
    let ledger_system = system_override.unwrap_or(adapter::LEDGER_SYSTEM);
    println!(
        "{}",
        json!({"phase":"review_source_ledger_contract","model":probe.model.metadata(),
        "sourceOnlyLedgerOutputTokens":LEDGER_OUTPUT_TOKENS,"fieldAndCoverageOutputTokens":REVIEW_OUTPUT_TOKENS,
        "contextTokens":CONTEXT_TOKENS,"reserveTokens":RESERVE_TOKENS,
        "ledgerReuse":"exact source-only input within this model/suite; failed ledger preserved and never silently retried",
        "originalSourcesProposalsAndReferenceGatesUnchanged":true,
        "sourceLedgerSystemOverride":system_override.is_some(),
        "sourceLedgerSystemSha256":hash(ledger_system.as_bytes()),
        "sourceOnlyPhase":source_only,"fullDecompositionRequiredForReviewerAcceptance":true,
        "admissionOnly":admission_only,"semantic_accepted":false,"production_accepted":false,
        "native_io_authenticated":false,"product_role_authorized":false})
    );
    if admission_only {
        // Only native packet transport and the source-only prompt are measured.
        // Generated ledger/field/coverage fit remains unknown until actual inference.
        suite.preflight(probe)?;
        for case in &suite.cases {
            let user = adapter::source_only_input(case)?;
            let tokens = probe.host.chat_token_count(ledger_system, &user)?;
            let fits = tokens > 0
                && tokens + LEDGER_OUTPUT_TOKENS as usize + RESERVE_TOKENS
                    <= CONTEXT_TOKENS as usize;
            println!(
                "{}",
                json!({"phase":"review_source_ledger_preflight","model":probe.model.metadata(),
                "case":case.id,"sourceOnlyInputSha256":hash(user.as_bytes()),"promptTokens":tokens,
                "sourceLedgerSystemSha256":hash(ledger_system.as_bytes()),
                "contextTokens":CONTEXT_TOKENS,"requestedOutputTokens":LEDGER_OUTPUT_TOKENS,
                "reserveTokens":RESERVE_TOKENS,"fullPromptReserveFits":fits,
                "generationCalls":0,"generatedLedgerAndReviewPromptFitKnown":false,
                "semantic_accepted":false,"production_accepted":false})
            );
            if !fits {
                return Err("source-only QA prompt does not fit; no inference executed".into());
            }
        }
        return Ok(());
    }
    if source_only {
        return run_source_only(suite, probe, ledger_system);
    }
    let mut cache = LedgerCache::new();
    suite.run_observed(probe, |case| {
        observe(case, probe, &mut cache, ledger_system)
    })
}
