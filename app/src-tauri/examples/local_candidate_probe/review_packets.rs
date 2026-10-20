//! Development-only whole-packet review inputs; no grants or semantic acceptance.

use super::review_smoke::{checked_json, hash, read_bounded, text, Case, Suite};
use myco_lib::local_generation::{review_probe, Request};
use myco_lib::retrieval::Scope;
use myco_lib::wiki_claims::{ActorRole, SourceDocument, SourceSet, SpanInput};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::path::Path;

pub(super) const MANIFEST_SHA: &str =
    "470fed90af029cc5e900f680734a3567f24c7c4b95b6c2a5457d02338a305732";
pub(super) const AUDIT_SHA: &str =
    "8fe7e07c348451275d30aa7b79723fda485b2e0c21e4a011b98c2fe8ad5ccbc9";
const BASE_SHA: &str = "d697b33b60d555615a8e921158f3baeda1c003c6cac3c4a69d5cbe5d000f348c";
const ARTIFACT_SHA: &str = "208f70a7c653e9c38ba3b1d4a4a39a09cc38d5f4be1c4fd7bd8dfabd0c005e31";
const SOURCE_REVIEW: &str =
    "independent_automated_source_review_approved_for_development_reference_freeze";

pub(super) fn load(
    manifest_path: &Path,
    audit_path: &Path,
    system_path: Option<&Path>,
    reason_first: bool,
) -> Result<Suite, String> {
    if reason_first && system_path.is_some() {
        return Err("reason-first review must not also change SYSTEM".into());
    }
    let manifest = checked_json(manifest_path, MANIFEST_SHA, 32 * 1024)?;
    if manifest["version"] != 1
        || manifest["id"] != "local-wiki-development-review-packets-v1"
        || manifest["syntheticOnly"] != true
        || manifest["split"] != "development"
        || manifest["labelStatus"] != "frozen_before_inference"
        || manifest["sourceReviewStatus"] != SOURCE_REVIEW
        || manifest["sourceAuditSha256"] != AUDIT_SHA
        || manifest["counts"] != json!({"pairs":4,"cases":8,"normal":4,"comparison":4})
        || manifest["priorDevelopmentOutputsKnown"] != true
        || manifest["currentTrialOutputsInspected"] != false
        || manifest["heldOutInspected"] != false
        || manifest["humanReviewed"] != false
        || manifest["nativeAuthority"] != false
        || manifest["base"]
            != json!({"path":"local-wiki-development-meaning-v1.json",
            "bytes":20012,"sha256":BASE_SHA})
        || manifest["artifact"]
            != json!({"path":"local-wiki-development-review-packets-v1.json",
            "bytes":98226,"sha256":ARTIFACT_SHA})
    {
        return Err("whole-packet manifest differs from its frozen development contract".into());
    }
    let directory = manifest_path
        .parent()
        .ok_or("review manifest lacks directory")?;
    let corpus = checked_json(
        &directory.join("local-wiki-development-meaning-v1.json"),
        BASE_SHA,
        20012,
    )?;
    let artifact = checked_json(
        &directory.join("local-wiki-development-review-packets-v1.json"),
        ARTIFACT_SHA,
        98226,
    )?;
    let audit = checked_json(audit_path, AUDIT_SHA, 8 * 1024 * 1024)?;
    check_audit(&artifact, &audit)?;
    let cases = build_cases(&artifact, &corpus)?;
    let candidate_system = system_path
        .map(|path| -> Result<String, String> {
            let value = String::from_utf8(read_bounded(path, 16 * 1024)?)
                .map_err(|error| error.to_string())?;
            if value.trim().is_empty() {
                return Err("review SYSTEM cannot be empty".into());
            }
            Ok(value)
        })
        .transpose()?;
    Ok(Suite {
        cases,
        candidate_system,
        reason_first,
        manifest_sha: MANIFEST_SHA,
        audit_sha: AUDIT_SHA,
        packet_kind: "whole_packet_development",
    })
}

fn array<'a>(value: &'a Value, field: &str) -> Result<&'a Vec<Value>, String> {
    value[field]
        .as_array()
        .ok_or_else(|| format!("whole-packet fixture lacks {field} array"))
}

fn optional_text(value: &Value, field: &str) -> Result<Option<String>, String> {
    match &value[field] {
        Value::Null => Ok(None),
        Value::String(text) => Ok(Some(text.clone())),
        _ => Err(format!("whole-packet metadata {field} is not text or null")),
    }
}

fn check_audit(artifact: &Value, audit: &Value) -> Result<(), String> {
    if audit["sourceReviewStatus"] != SOURCE_REVIEW
        || audit["bindings"]["canonicalArtifact"]["sha256"] != ARTIFACT_SHA
        || audit["bindings"]["originalFixture"]["sha256"] != BASE_SHA
        || audit["exposure"]["priorDevelopmentOutputsKnown"] != true
        || audit["exposure"]["currentTrialOutputsInspected"] != false
        || audit["exposure"]["heldOutInspected"] != false
        || audit["conclusion"]["canFreezeSourceReferencesForDevelopment"] != true
        || audit["conclusion"]["blockingSourceMeaningIssues"] != json!([])
    {
        return Err("whole-packet audit lacks its immutable original-source approval".into());
    }
    let reviewed = array(audit, "cases")?;
    let entries = array(artifact, "cases")?;
    if reviewed.len() != 8 || entries.len() != 8 {
        return Err("whole-packet audit must retain all eight source references".into());
    }
    let mut ids = BTreeSet::new();
    for entry in entries {
        let id = text(entry, "id")?;
        let matching: Vec<_> = reviewed.iter().filter(|case| case["id"] == id).collect();
        if !ids.insert(id) || matching.len() != 1 {
            return Err("whole-packet audit case identity is missing or repeated".into());
        }
        let checked = matching[0];
        let verdict = &checked["independentVerdict"];
        if [
            "pairId",
            "sourceCaseId",
            "variant",
            "proposalBatch",
            "reference",
        ]
        .iter()
        .any(|field| checked[*field] != entry[*field])
            || verdict["sourceReferenceApprovedForDevelopmentFreeze"] != true
            || verdict["allProposedFieldDispositionsMatchOriginals"] != true
            || verdict["coverageAndMissingIdsMatchSuppliedOriginals"] != true
            || verdict["blockingChangesRequired"] != json!([])
            || checked["blockers"] != json!([])
            || checked["proposalBatchSha256"] != hash(entry["proposalBatch"].to_string().as_bytes())
            || checked["referenceSha256"] != hash(entry["reference"].to_string().as_bytes())
            || checked["userPreviewSha256"] != hash(entry["userPreview"].to_string().as_bytes())
        {
            return Err("whole-packet case differs from its frozen source audit".into());
        }
    }
    Ok(())
}

pub(super) fn build_cases(artifact: &Value, corpus: &Value) -> Result<Vec<Case>, String> {
    if artifact["syntheticOnly"] != true
        || artifact["split"] != "development"
        || corpus["syntheticOnly"] != true
        || corpus["split"] != "development"
    {
        return Err("whole-packet inputs must remain synthetic exposed development".into());
    }
    let packets = array(artifact, "packets")?;
    let entries = array(artifact, "cases")?;
    let originals = array(corpus, "cases")?;
    if packets.len() != 4 || entries.len() != 8 {
        return Err("whole-packet development must retain four pairs/eight cases".into());
    }
    let mut ids = BTreeSet::new();
    let mut variants = BTreeSet::new();
    let mut cases = Vec::new();
    for entry in entries {
        let id = text(entry, "id")?;
        let pair_id = text(entry, "pairId")?;
        let variant = text(entry, "variant")?;
        if !ids.insert(id.clone())
            || !variants.insert((pair_id.clone(), variant.clone()))
            || !matches!(variant.as_str(), "source_supported" | "comparison")
            || entry["syntheticOnly"] != true
        {
            return Err("whole-packet case identity or variant changed".into());
        }
        let matching: Vec<_> = packets
            .iter()
            .filter(|packet| packet["pairId"] == pair_id)
            .collect();
        if matching.len() != 1 || matching[0]["sourceCaseId"] != entry["sourceCaseId"] {
            return Err("whole-packet case lacks its unique source selection".into());
        }
        let packet = matching[0];
        let original = originals
            .iter()
            .find(|case| case["id"] == entry["sourceCaseId"])
            .ok_or("whole-packet case lacks its immutable development original")?;
        let source = &original["source"];
        let body = text(source, "original")?;
        if source["sha256"] != hash(body.as_bytes()) || source["bytes"] != body.len() {
            return Err("whole-packet original body/hash/byte count changed".into());
        }
        let selected = array(packet, "selectedSpanIds")?;
        let turns = array(source, "turns")?;
        let mut span_inputs = Vec::new();
        let mut selected_ids = BTreeSet::new();
        for selected_id in selected {
            let span_id = selected_id
                .as_str()
                .ok_or("selected original ID is not text")?;
            if !selected_ids.insert(span_id) {
                return Err("whole-packet selected original ID is repeated".into());
            }
            let turn = turns
                .iter()
                .find(|turn| turn["id"] == span_id)
                .ok_or("whole-packet selected turn is absent from its original")?;
            let offset = |name: &str| -> Result<usize, String> {
                usize::try_from(
                    turn[name]
                        .as_u64()
                        .ok_or("original span lacks byte offset")?,
                )
                .map_err(|error| error.to_string())
            };
            let start = offset("start")?;
            let end = offset("end")?;
            let slice = body
                .get(start..end)
                .ok_or("original span exceeds UTF-8 boundaries")?;
            if turn["text"] != slice
                || turn["sha256"] != hash(slice.as_bytes())
                || !turn["sourcePhase"].is_null()
            {
                return Err("whole-packet turn bytes/hash/phase differ from original".into());
            }
            let speaker: ActorRole = serde_json::from_value(turn["speaker"].clone())
                .map_err(|error| error.to_string())?;
            span_inputs.push(SpanInput {
                id: span_id.into(),
                start,
                end,
                turn_id: text(turn, "turnId")?,
                speaker,
                turn_time: optional_text(turn, "turnTime")?,
            });
        }
        let request: Request =
            serde_json::from_value(entry["request"].clone()).map_err(|error| error.to_string())?;
        if request.scope != Scope::All
            || request.model_id.is_some()
            || request.activity_overview
            || request.range.is_some()
            || request.resolution.is_some()
        {
            return Err("whole-packet request changed its neutral model-independent scope".into());
        }
        let origin = request
            .origin
            .clone()
            .ok_or("whole-packet request lacks its origin")?;
        let document = SourceDocument::bind(
            text(source, "id")?,
            text(source, "path")?,
            text(source, "selectionPath")?,
            &body,
            optional_text(source, "recordTime")?,
            span_inputs,
        )?;
        let sources = SourceSet::new(origin, Scope::All, vec![document], vec![])?;
        let proposal =
            serde_json::to_string(&entry["proposalBatch"]).map_err(|error| error.to_string())?;
        let reference = &entry["reference"];
        let preview = &entry["userPreview"];
        if reference["coverageRequiredSpanIds"] != packet["selectedSpanIds"]
            || preview["coverageRequiredSpanIds"] != packet["selectedSpanIds"]
            || preview["referenceSpanIds"] != json!([])
        {
            return Err("whole-packet coverage must contain exactly its supplied originals".into());
        }
        let expected_verdict = text(reference, "expectedVerdict")?;
        if !matches!(expected_verdict.as_str(), "accept" | "reject") {
            return Err("whole-packet reference verdict is invalid".into());
        }
        let expected_review = json!({
            "claims":array(reference,"expectedDecisions")?.iter().map(|decision| {
                json!({"id":decision["id"],"disposition":decision["disposition"]})
            }).collect::<Vec<_>>(),
            "sourceCoverage":reference["sourceCoverage"],"missingSpanIds":reference["missingSpanIds"]
        });
        let case = Case {
            id,
            pair_id,
            expected_verdict,
            proposal,
            request,
            sources,
            preview: Some(preview.clone()),
            expected_review: Some(expected_review),
        };
        check_native_preview(&case)?;
        cases.push(case);
    }
    if packets.iter().any(|packet| {
        ["source_supported", "comparison"].iter().any(|variant| {
            !variants.contains(&(
                packet["pairId"].as_str().unwrap_or("").into(),
                (*variant).into(),
            ))
        })
    }) {
        return Err("whole-packet development lost one of its paired variants".into());
    }
    Ok(cases)
}

fn check_native_preview(case: &Case) -> Result<(), String> {
    let origin = case
        .request
        .origin
        .as_ref()
        .ok_or("whole-packet origin is absent")?;
    case.sources
        .validate(&case.proposal, origin, case.request.scope)?;
    // The native helper constructs and binds USER. Its mocked uncertain decoder
    // verifies transport only, never meaning, real tokenizer fit or authorization.
    let observed = review_probe::run(
        &case.request, &case.sources, origin, &case.proposal, |_, _| Ok(0),
        |_, user, _, _, _| {
            let actual: Value = serde_json::from_str(user).map_err(|error| error.to_string())?;
            if Some(&actual) != case.preview.as_ref() {
                return Err("actual native whole-packet USER differs from frozen preview".into());
            }
            Ok(json!({"version":"WikiClaimReviewV1",
                "claims":array(&actual,"requiredClaimIds")?.iter().map(|id| {
                    json!({"id":id,"disposition":"uncertain",
                        "reason":"Explicitly mocked native input transport, not a semantic verdict."})
                }).collect::<Vec<_>>(),"sourceCoverage":"uncertain","missingSpanIds":[]}).to_string())
        },
    ).map_err(|error| format!("{}: {}", error.code, error.detail))?;
    if observed["reviewBindsInput"] != true || observed["automatedReviewAccepted"] != false {
        return Err("native whole-packet transport failed its nonaccepting binding check".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use myco_lib::local_generation::review_probe;
    use serde_json::json;
    use std::cell::Cell;

    fn fixtures() -> (Value, Value) {
        (
            serde_json::from_str(include_str!(
                "../../eval/local-wiki-development-review-packets-v1.json"
            ))
            .unwrap(),
            serde_json::from_str(include_str!(
                "../../eval/local-wiki-development-meaning-v1.json"
            ))
            .unwrap(),
        )
    }

    #[test]
    fn all_eight_packets_use_native_admission_and_exact_frozen_user() {
        let (artifact, corpus) = fixtures();
        let cases = build_cases(&artifact, &corpus).expect("all eight frozen packets must bind");
        assert_eq!(cases.len(), 8);
        for case in cases {
            let origin = case.request.origin.as_ref().unwrap();
            case.sources
                .validate(&case.proposal, origin, case.request.scope)
                .expect("the exact proposed DTO must pass native structural admission");
            let calls = Cell::new(0);
            let expected = case.expected_review.as_ref().unwrap();
            let observation = review_probe::run(
                &case.request,
                &case.sources,
                origin,
                &case.proposal,
                |_, _| Ok(0),
                |_, user, output, context, _| {
                    calls.set(calls.get() + 1);
                    assert_eq!(output, 768);
                    assert_eq!(context, 4096);
                    let actual: Value = serde_json::from_str(user).unwrap();
                    assert_eq!(&actual, case.preview.as_ref().unwrap());
                    // Mock only the transport verdict, never semantic correctness.
                    Ok(json!({"version":"WikiClaimReviewV1",
                        "claims":expected["claims"].as_array().unwrap().iter().map(|item| {
                            json!({"id":item["id"],"disposition":item["disposition"],
                                "reason":"Explicitly mocked native transport verdict."})
                        }).collect::<Vec<_>>(),
                        "sourceCoverage":expected["sourceCoverage"],
                        "missingSpanIds":expected["missingSpanIds"]})
                    .to_string())
                },
            )
            .expect("mock verdict must traverse the actual native review path");
            assert_eq!(calls.get(), 1);
            assert_eq!(
                observation["automatedReviewAccepted"],
                case.expected_verdict == "accept"
            );
            for flag in [
                "native_io_authenticated",
                "product_role_authorized",
                "semantic_accepted",
                "production_accepted",
            ] {
                assert_eq!(observation[flag], false, "{flag}");
            }
        }
    }

    #[test]
    fn changed_original_bytes_or_hashes_fail_before_review() {
        let (artifact, corpus) = fixtures();
        for field in ["original", "sha256"] {
            let mut changed = corpus.clone();
            changed["cases"][0]["source"][field] = json!("changed synthetic original");
            assert!(build_cases(&artifact, &changed).is_err(), "{field}");
        }
    }

    #[test]
    fn changed_turn_bytes_bounds_or_metadata_fail_before_review() {
        let (artifact, corpus) = fixtures();
        for (field, replacement) in [
            ("text", json!("changed synthetic turn")),
            ("sha256", json!("0".repeat(64))),
            ("start", json!(1)),
            ("speaker", json!("tool")),
            ("turnTime", json!("2026-10-09T10:00:00Z")),
        ] {
            let mut changed = corpus.clone();
            changed["cases"][0]["source"]["turns"][0][field] = replacement;
            assert!(build_cases(&artifact, &changed).is_err(), "{field}");
        }
    }

    #[test]
    fn changed_preview_packet_claims_or_request_cannot_be_silently_rebuilt() {
        let (artifact, corpus) = fixtures();
        for mutation in 0..4 {
            let mut changed = artifact.clone();
            let case = &mut changed["cases"][0];
            match mutation {
                0 => case["userPreview"]["coverageRequiredSpanIds"] = json!(["D4C"]),
                1 => case["userPreview"]["originalSpans"][0]["text"] = json!("changed"),
                2 => case["userPreview"]["claims"][0]["proposal"]["status"] = json!("unknown"),
                _ => case["request"]["question"] = json!("A changed synthetic question"),
            }
            assert!(build_cases(&changed, &corpus).is_err(), "{mutation}");
        }
    }

    #[test]
    fn packet_selection_and_case_identity_cannot_expand_or_repeat() {
        let (artifact, corpus) = fixtures();
        let mut expanded = artifact.clone();
        expanded["packets"][0]["selectedSpanIds"] = json!(["D4A", "D4B", "D4C"]);
        assert!(build_cases(&expanded, &corpus).is_err());
        let mut repeated = artifact.clone();
        repeated["cases"][1]["id"] = repeated["cases"][0]["id"].clone();
        assert!(build_cases(&repeated, &corpus).is_err());
    }
}
