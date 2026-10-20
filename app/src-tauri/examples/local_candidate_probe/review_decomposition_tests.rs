use super::*;
use myco_lib::local_generation::review_probe;
use myco_lib::wiki_claims::{ActorRole, SourceDocument, SourceSet, SpanInput};
use serde_json::{json, Value};
use std::cell::RefCell;

fn cases() -> Vec<Case> {
    let packets = serde_json::from_str(include_str!(
        "../../eval/local-wiki-development-review-packets-v1.json"
    ))
    .unwrap();
    let corpus = serde_json::from_str(include_str!(
        "../../eval/local-wiki-development-meaning-v1.json"
    ))
    .unwrap();
    crate::review_packets::build_cases(&packets, &corpus).unwrap()
}

fn native_user(case: &Case) -> String {
    let captured = RefCell::new(None);
    review_probe::run(
        &case.request,
        &case.sources,
        case.request.origin.as_ref().unwrap(),
        &case.proposal,
        |_, _| Ok(0),
        |_, user, _, _, _| {
            *captured.borrow_mut() = Some(user.to_owned());
            let input: Value = serde_json::from_str(user).unwrap();
            Ok(json!({"version":"WikiClaimReviewV1",
                "claims":input["requiredClaimIds"].as_array().unwrap().iter().map(|id|
                    json!({"id":id,"disposition":"uncertain","reason":"Synthetic transport capture; no semantic approval."})).collect::<Vec<_>>(),
                "sourceCoverage":"uncertain","missingSpanIds":[]}).to_string())
        },
    )
    .unwrap();
    captured.into_inner().unwrap()
}

fn ledger(case: &Case) -> CheckedLedger {
    // Test input only: reusing a frozen proposal exercises source structure,
    // not semantic ledger extraction or model-generated ground truth.
    CheckedLedger::admit(case, &case.proposal).unwrap()
}

fn field(id: &str, span: &str, disposition: &str) -> Value {
    let judgment = json!({"disposition":disposition,"reason":"Synthetic field comparison.","evidenceSpanIds":[span]});
    json!({"version":"WikiClaimFieldReviewQaV1","claimId":id,
        "actor":judgment,"action":judgment,"eventTime":judgment,
        "speechAct":judgment,"status":judgment,"reason":"Synthetic complete field comparison."})
}

fn all_fields(native: &str, disposition: &str) -> Vec<String> {
    let input: Value = serde_json::from_str(native).unwrap();
    let span = input["originalSpans"][0]["id"].as_str().unwrap();
    input["requiredClaimIds"]
        .as_array()
        .unwrap()
        .iter()
        .map(|id| field(id.as_str().unwrap(), span, disposition).to_string())
        .collect()
}

fn coverage(disposition: &str, missing: Value) -> String {
    json!({"version":"WikiSourceCoverageQaV1","sourceCoverage":disposition,
        "missingSpanIds":missing,"reason":"Synthetic original coverage comparison."})
    .to_string()
}

#[test]
fn source_only_ledger_is_blind_to_proposals_labels_previews_and_case_identity() {
    let mut cases = cases();
    let case = &mut cases[0];
    let before = source_only_input(case).unwrap();
    case.id = "LABEL_SENTINEL_CASE".into();
    case.pair_id = "LABEL_SENTINEL_PAIR".into();
    case.proposal = "PROPOSAL_SENTINEL".into();
    case.expected_verdict = "LABEL_SENTINEL_VERDICT".into();
    case.preview = Some(json!({"sentinel":"PREVIEW_SENTINEL"}));
    case.expected_review = Some(json!({"sentinel":"GOLD_SENTINEL"}));
    case.request.request_id = "REQUEST_ID_SENTINEL".into();
    case.request.model_id = Some("MODEL_ID_SENTINEL".into());
    case.request.paths = Some(vec!["PATH_SENTINEL".into()]);
    case.request.previous_question = Some("PREVIOUS_SENTINEL".into());
    assert_eq!(source_only_input(case).unwrap(), before);
    let input: Value = serde_json::from_str(&before).unwrap();
    assert_eq!(input["context"]["question"], case.request.question);
    assert_eq!(input["context"]["language"], case.request.lang);
    assert_eq!(input["context"]["scope"], json!(case.request.scope));
    assert_eq!(input["context"]["activityPeriod"], Value::Null);
    assert_eq!(
        input["originalSpans"],
        json!(case.sources.spans().collect::<Vec<_>>())
    );
    assert_eq!(input.as_object().unwrap().len(), 2);
    assert_eq!(input["context"].as_object().unwrap().len(), 4);
    assert!(!before.contains("SENTINEL"));
}

#[test]
fn checked_ledger_binds_exact_source_packet_and_retains_untrusted_raw_provenance() {
    let case = cases().remove(0);
    let admitted = ledger(&case);
    let metadata = admitted.metadata();
    assert_eq!(
        metadata["sourceOnlyInputSha256"],
        crate::review_smoke::hash(source_only_input(&case).unwrap().as_bytes())
    );
    assert_eq!(
        admitted.source_packet_sha256(),
        metadata["sourceOnlyInputSha256"].as_str().unwrap()
    );
    assert_eq!(metadata["raw"], case.proposal);
    assert_eq!(
        metadata["rawSha256"],
        crate::review_smoke::hash(case.proposal.as_bytes())
    );
    assert_eq!(metadata["structureChecked"], true);
    assert_eq!(metadata["semanticAccepted"], false);
    assert_eq!(metadata["productAuthority"], false);
    assert_eq!(
        admitted.compact_prompt_metadata(),
        json!({
            "proposal":serde_json::from_str::<Value>(&case.proposal).unwrap(),
            "sourceOnlyInputSha256":metadata["sourceOnlyInputSha256"],
            "rawSha256":metadata["rawSha256"],
            "semanticAccepted":false,"productAuthority":false
        })
    );
    assert!(metadata["checkedClaims"]["claims"][0]["provenance"]
        .as_array()
        .unwrap()
        .iter()
        .all(|span| case
            .sources
            .spans()
            .any(|original| json!(original) == *span)));
    let mut proposal: Value = serde_json::from_str(&case.proposal).unwrap();
    proposal["sourcePacketSha256"] = json!(admitted.source_packet_sha256());
    assert!(CheckedLedger::admit(&case, &proposal.to_string()).is_err());
    proposal
        .as_object_mut()
        .unwrap()
        .remove("sourcePacketSha256");
    proposal["claims"][0]["supportSpanIds"] = json!(["OUTSIDE"]);
    assert!(CheckedLedger::admit(&case, &proposal.to_string()).is_err());
}

#[test]
fn every_native_original_proposal_context_and_coverage_id_survives_both_inputs() {
    for case in cases() {
        let native = native_user(&case);
        let original: Value = serde_json::from_str(&native).unwrap();
        let admitted = ledger(&case);
        let id = original["requiredClaimIds"][0].as_str().unwrap();
        let field: Value =
            serde_json::from_str(&field_input(&native, id, &admitted).unwrap()).unwrap();
        let coverage: Value =
            serde_json::from_str(&coverage_input(&native, &admitted).unwrap()).unwrap();
        for (key, value) in original.as_object().unwrap() {
            assert_eq!(&field[key], value, "field packet changed {key}");
            assert_eq!(&coverage[key], value, "coverage packet changed {key}");
        }
        assert_eq!(field["targetClaimId"], id);
        assert_eq!(
            field.as_object().unwrap().len(),
            original.as_object().unwrap().len() + 2
        );
        assert_eq!(
            coverage.as_object().unwrap().len(),
            original.as_object().unwrap().len() + 1
        );
        assert_eq!(
            field["untrustedSourceLedger"],
            admitted.compact_prompt_metadata()
        );
        assert_eq!(
            coverage["untrustedSourceLedger"],
            admitted.compact_prompt_metadata()
        );
        assert!(field_input(&native, "UNISSUED", &admitted).is_err());
    }
}

#[test]
fn ledger_cannot_cross_sources_context_or_tampered_native_originals() {
    let mut cases = cases();
    let case = cases.remove(0);
    let admitted = ledger(&case);
    let native = native_user(&case);
    for (key, value) in [
        ("question", json!("Different original question")),
        ("language", json!("ja")),
        ("scope", json!("wiki")),
        (
            "activityPeriod",
            json!({"start":"2026-01-01","end":"2026-02-01","startEpoch":null,"endEpoch":null}),
        ),
    ] {
        let mut changed: Value = serde_json::from_str(&native).unwrap();
        changed["context"][key] = value;
        assert!(coverage_input(&changed.to_string(), &admitted).is_err());
    }
    for key in ["text", "sourceRevision", "sha256", "id", "speaker"] {
        let mut changed: Value = serde_json::from_str(&native).unwrap();
        changed["originalSpans"][0][key] = json!("FORGED");
        assert!(coverage_input(&changed.to_string(), &admitted).is_err());
    }
    let other = cases
        .into_iter()
        .find(|other| {
            json!(other.sources.spans().collect::<Vec<_>>())
                != json!(case.sources.spans().collect::<Vec<_>>())
        })
        .unwrap();
    assert!(coverage_input(&native_user(&other), &admitted).is_err());
}

#[test]
fn omitted_qualification_in_ledger_never_drops_its_original_from_coverage() {
    let case = cases()
        .into_iter()
        .find(|case| case.id == "whole-review-D3AB-duplicate-only-comparison")
        .unwrap();
    let native = native_user(&case);
    let admitted = ledger(&case);
    let input: Value = serde_json::from_str(&coverage_input(&native, &admitted).unwrap()).unwrap();
    assert_eq!(input["coverageRequiredSpanIds"], json!(["D3A", "D3B"]));
    assert_eq!(input["originalSpans"].as_array().unwrap().len(), 2);
    assert!(input["originalSpans"]
        .as_array()
        .unwrap()
        .iter()
        .any(|span| span["id"] == "D3B"));
    let output: Value = serde_json::from_str(
        &project(
            &native,
            &admitted,
            &all_fields(&native, "supported"),
            &coverage("missing", json!(["D3A", "D3B"])),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(output["sourceCoverage"], "missing");
    assert_eq!(output["missingSpanIds"], json!(["D3A", "D3B"]));
    assert!(output["claims"]
        .as_array()
        .unwrap()
        .iter()
        .all(|claim| claim["disposition"] == "supported"));
}

#[test]
fn closed_field_output_enforces_issued_target_evidence_reasons_and_bounds() {
    let case = cases().remove(0);
    let native = native_user(&case);
    let input: Value = serde_json::from_str(&native).unwrap();
    let id = input["requiredClaimIds"][0].as_str().unwrap();
    let span = input["originalSpans"][0]["id"].as_str().unwrap();
    let valid = field(id, span, "supported");
    assert!(validate_field_output(&native, id, &valid.to_string()).is_ok());
    for mutation in 0..10 {
        let mut changed = valid.clone();
        match mutation {
            0 => changed["extra"] = json!(true),
            1 => changed["version"] = json!("WikiClaimReviewV1"),
            2 => changed["claimId"] = json!("UNISSUED"),
            3 => changed["actor"]["extra"] = json!(true),
            4 => changed["action"]["disposition"] = json!("approved"),
            5 => changed["eventTime"]["evidenceSpanIds"] = json!(["OUTSIDE"]),
            6 => changed["speechAct"]["evidenceSpanIds"] = json!([span, span]),
            7 => changed["status"]["reason"] = json!(" "),
            8 => changed["reason"] = json!("x".repeat(129)),
            _ => changed["actor"]["reason"] = json!("control\nreason"),
        }
        assert!(
            validate_field_output(&native, id, &changed.to_string()).is_err(),
            "mutation {mutation}"
        );
    }
    assert!(validate_field_output(&native, "UNISSUED", &valid.to_string()).is_err());
}

#[test]
fn closed_coverage_output_enforces_only_coverage_ids_and_consistent_missing_state() {
    let case = cases().remove(0);
    let mut input: Value = serde_json::from_str(&native_user(&case)).unwrap();
    let original_ids = input["coverageRequiredSpanIds"].as_array().unwrap().clone();
    let span = original_ids[0].as_str().unwrap();
    let valid = coverage("missing", json!([span]));
    assert!(validate_coverage_output(&input.to_string(), &valid).is_ok());
    assert!(validate_coverage_output(&input.to_string(), &coverage("covered", json!([]))).is_ok());
    for changed in [
        coverage("covered", json!([span])),
        coverage("missing", json!([])),
        coverage("missing", json!([span, span])),
        coverage("missing", json!(["OUTSIDE"])),
        json!({"version":"WikiSourceCoverageQaV1","sourceCoverage":"uncertain","missingSpanIds":[],"reason":"x","extra":true}).to_string(),
        json!({"version":"WikiSourceCoverageQaV1","sourceCoverage":"uncertain","missingSpanIds":[],"reason":"x\n"}).to_string(),
    ] {
        assert!(validate_coverage_output(&input.to_string(), &changed).is_err());
    }
    input["coverageRequiredSpanIds"] = json!([span]);
    input["referenceSpanIds"] = json!(original_ids
        .iter()
        .filter(|id| id.as_str() != Some(span))
        .collect::<Vec<_>>());
    if let Some(reference) = input["referenceSpanIds"].as_array().unwrap().first() {
        assert!(validate_coverage_output(
            &input.to_string(),
            &coverage("missing", json!([reference]))
        )
        .is_err());
    }
}

#[test]
fn projection_preserves_native_ids_positive_acceptance_and_decisive_field_reason() {
    let case = cases().remove(0);
    let native = native_user(&case);
    let admitted = ledger(&case);
    let fields = all_fields(&native, "supported");
    let positive: Value = serde_json::from_str(
        &project(&native, &admitted, &fields, &coverage("covered", json!([]))).unwrap(),
    )
    .unwrap();
    let input: Value = serde_json::from_str(&native).unwrap();
    assert_eq!(positive["version"], "WikiClaimReviewV1");
    assert_eq!(
        positive["claims"]
            .as_array()
            .unwrap()
            .iter()
            .map(|claim| claim["id"].clone())
            .collect::<Vec<_>>(),
        *input["requiredClaimIds"].as_array().unwrap()
    );
    assert!(positive["claims"]
        .as_array()
        .unwrap()
        .iter()
        .all(|claim| claim["disposition"] == "supported"));
    for disposition in ["uncertain", "unsupported"] {
        let mut changed = fields.clone();
        let mut first: Value = serde_json::from_str(&changed[0]).unwrap();
        first["actor"]["disposition"] = json!(disposition);
        first["actor"]["reason"] = json!("The attributed actor differs from the exact original.");
        first["reason"] = json!("Generic top-level reason must not hide the decisive field.");
        changed[0] = first.to_string();
        let output: Value = serde_json::from_str(
            &project(
                &native,
                &admitted,
                &changed,
                &coverage("covered", json!([])),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(output["claims"][0]["disposition"], disposition);
        assert_eq!(
            output["claims"][0]["reason"],
            "The attributed actor differs from the exact original."
        );
    }
    let mut changed = fields.clone();
    let mut first: Value = serde_json::from_str(&changed[0]).unwrap();
    first["actor"]["disposition"] = json!("uncertain");
    first["action"]["disposition"] = json!("unsupported");
    first["action"]["reason"] = json!("The stated action is contradicted by the original.");
    changed[0] = first.to_string();
    let output: Value = serde_json::from_str(
        &project(
            &native,
            &admitted,
            &changed,
            &coverage("covered", json!([])),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(output["claims"][0]["disposition"], "unsupported");
    assert_eq!(
        output["claims"][0]["reason"],
        "The stated action is contradicted by the original."
    );
}

#[test]
fn projection_rejects_missing_duplicate_unissued_fields_and_source_rebinding() {
    let case = cases().remove(0);
    let native = native_user(&case);
    let admitted = ledger(&case);
    let fields = all_fields(&native, "supported");
    assert!(project(&native, &admitted, &fields, &coverage("covered", json!([]))).is_ok());
    assert!(project(
        &native,
        &admitted,
        &fields[1..],
        &coverage("covered", json!([]))
    )
    .is_err());
    let mut duplicate = fields.clone();
    duplicate.push(fields[0].clone());
    assert!(project(
        &native,
        &admitted,
        &duplicate,
        &coverage("covered", json!([]))
    )
    .is_err());
    let mut unknown = fields.clone();
    let mut value: Value = serde_json::from_str(&unknown[0]).unwrap();
    value["claimId"] = json!("UNISSUED");
    unknown[0] = value.to_string();
    assert!(project(
        &native,
        &admitted,
        &unknown,
        &coverage("covered", json!([]))
    )
    .is_err());
    let mut changed: Value = serde_json::from_str(&native).unwrap();
    changed["originalSpans"][0]["text"] = json!("Replaced exact original.");
    assert!(project(
        &changed.to_string(),
        &admitted,
        &fields,
        &coverage("covered", json!([]))
    )
    .is_err());
}

#[test]
fn projection_never_trims_qa_missing_ids_to_fit_the_native_review_bound() {
    let mut case = cases().remove(0);
    let body = (0..9)
        .map(|index| format!("Synthetic source span {index}.\n"))
        .collect::<String>();
    let mut cursor = 0;
    let inputs = body
        .split_inclusive('\n')
        .enumerate()
        .map(|(index, text)| {
            let start = cursor;
            cursor += text.len();
            SpanInput {
                id: format!("S{index}"),
                start,
                end: cursor,
                turn_id: format!("T{index}"),
                speaker: ActorRole::User,
                turn_time: None,
            }
        })
        .collect();
    case.sources = SourceSet::new(
        case.request.origin.clone().unwrap(),
        case.request.scope,
        vec![SourceDocument::bind(
            "synthetic-nine".into(),
            "raw/synthetic-nine.md".into(),
            "wiki/synthetic-nine.md".into(),
            &body,
            None,
            inputs,
        )
        .unwrap()],
        vec![],
    )
    .unwrap();
    case.proposal = json!({"outcome":"insufficient_evidence","claims":[]}).to_string();
    let admitted = ledger(&case);
    let native = native_user(&case);
    let missing = json!((0..9).map(|index| format!("S{index}")).collect::<Vec<_>>());
    let raw = coverage("missing", missing);
    assert!(validate_coverage_output(&native, &raw).is_ok());
    assert!(project(&native, &admitted, &[], &raw).is_err());
}

#[test]
fn decomposition_prompts_keep_unknowns_reports_negation_and_full_original_priority() {
    for system in [LEDGER_SYSTEM, FIELD_SYSTEM, COVERAGE_SYSTEM] {
        assert!(system.contains("untrusted"));
        assert!(system.contains("original"));
        assert!(system.contains("unknown"));
    }
    assert!(LEDGER_SYSTEM.contains("WikiClaimsV1"));
    assert!(FIELD_SYSTEM.contains("attributed report"));
    assert!(FIELD_SYSTEM.contains("requester"));
    assert!(FIELD_SYSTEM.contains("event time"));
    assert!(COVERAGE_SYSTEM.contains("negative qualifications"));
    assert!(COVERAGE_SYSTEM.contains("Empty"));
    assert!(COVERAGE_SYSTEM.contains("not authority"));
}
