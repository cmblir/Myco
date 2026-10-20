//! Development-only reviewer replay over unchanged, source-audited proposal pairs.

use myco_lib::local_generation::Request;
use myco_lib::retrieval::Scope;
use myco_lib::wiki_claims::{ActorRole, SourceDocument, SourceSet, SpanInput};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::Path;

const MANIFEST_SHA: &str = "c811026389593175765195105d4e3e3d7c0986b1cc699469c908478ccb11bc55";
const AUDIT_SHA: &str = "397fe8f43d2c69ec163982359d0158e66e30b2f9dfc308501a0bd7976e510316";

pub(super) struct Case {
    pub(super) id: String,
    pub(super) pair_id: String,
    pub(super) expected_verdict: String,
    pub(super) proposal: String,
    pub(super) request: Request,
    pub(super) sources: SourceSet,
    pub(super) preview: Option<Value>,
    pub(super) expected_review: Option<Value>,
}

pub(super) struct Suite {
    pub(super) cases: Vec<Case>,
    pub(super) candidate_system: Option<String>,
    pub(super) reason_first: bool,
    pub(super) manifest_sha: &'static str,
    pub(super) audit_sha: &'static str,
    pub(super) packet_kind: &'static str,
}

pub(super) fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > limit {
        return Err("review QA input must be a bounded regular file".into());
    }
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("review QA input grew beyond its bound".into());
    }
    Ok(bytes)
}

pub(super) fn text(value: &Value, name: &str) -> Result<String, String> {
    value[name]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("review fixture lacks {name}"))
}

pub(super) fn checked_json(path: &Path, expected: &str, limit: u64) -> Result<Value, String> {
    let bytes = read_bounded(path, limit)?;
    if hash(&bytes) != expected {
        return Err("review QA input differs from its frozen source-audited hash".into());
    }
    serde_json::from_slice(&bytes).map_err(|error| error.to_string())
}

pub(super) fn load(
    manifest_path: &Path,
    audit_path: &Path,
    system_path: Option<&Path>,
    reason_first: bool,
) -> Result<Suite, String> {
    if reason_first && system_path.is_some() {
        return Err("reviewer grammar and SYSTEM interventions must run separately".into());
    }
    let manifest = checked_json(manifest_path, MANIFEST_SHA, 32 * 1024)?;
    let audit = checked_json(audit_path, AUDIT_SHA, 8 * 1024 * 1024)?;
    let directory = manifest_path
        .parent()
        .ok_or("review manifest lacks a directory")?;
    let artifact = &manifest["artifact"];
    if artifact["path"] != "review-pairs.json"
        || audit["scope"]["split"] != "development"
        || audit["summary"]["reviewerVerdictLabels"]["supported"] != 32
        || audit["summary"]["reviewerVerdictLabels"]["corrected"] != 0
        || audit["summary"]["reviewerVerdictLabels"]["uncertain"] != 0
        || audit["candidateOutputsInspected"] != false
        || audit["inferenceExecuted"] != false
    {
        return Err("review QA lacks the unchanged development reference audit".into());
    }
    let pairs = checked_json(
        &directory.join("review-pairs.json"),
        &text(artifact, "sha256")?,
        2 * 1024 * 1024,
    )?;
    let mut corpus = None;
    for entry in manifest["base"]["artifacts"]
        .as_array()
        .ok_or("review manifest lacks base artifacts")?
    {
        let name = text(entry, "path")?;
        if ![
            "corpus.json",
            "queries.json",
            "labels.json",
            "config.json",
            "scenarios.json",
            "receipt.schema.json",
        ]
        .contains(&name.as_str())
        {
            return Err("review manifest has an unsupported artifact path".into());
        }
        let value = checked_json(
            &directory.join(&name),
            &text(entry, "sha256")?,
            2 * 1024 * 1024,
        )?;
        if name == "corpus.json" {
            corpus = Some(value);
        }
    }
    let corpus = corpus.ok_or("review manifest lacks its original corpus")?;
    let cases = build_cases(&pairs, &corpus)?;
    for case in &cases {
        let audited = audit["reviewerPairs"]
            .as_array()
            .and_then(|pairs| pairs.iter().find(|pair| pair["id"] == case.pair_id))
            .and_then(|pair| pair["cases"].as_array())
            .and_then(|cases| cases.iter().find(|entry| entry["id"] == case.id))
            .ok_or("review case lacks its independent source-audit binding")?;
        let proposal: Value =
            serde_json::from_str(&case.proposal).map_err(|error| error.to_string())?;
        if audited["independentVerdict"] != case.expected_verdict
            || audited["proposal"] != proposal
            || audited["disposition"] != "supported"
        {
            return Err("review case differs from the approved reference audit".into());
        }
    }
    let candidate_system = system_path
        .map(|path| -> Result<String, String> {
            let bytes = read_bounded(path, 16 * 1024)?;
            let value = String::from_utf8(bytes).map_err(|error| error.to_string())?;
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
        packet_kind: "single-span",
    })
}

fn request(ordinal: usize, selection_path: &str) -> Result<Request, String> {
    // Model-independent DTO shape only. No actual role grant is issued; the
    // explicit pinned reviewer artifact is recorded outside the model USER.
    let origin = json!({"vaultPath":"/synthetic/reviewer-vault","openingToken":"synthetic-reviewer-opening"});
    serde_json::from_value(json!({
        "modelId":null,"requestId":format!("synthetic-review-case-{ordinal}"),
        "question":"Review whether the proposed activity preserves the supplied original and its important qualifications.",
        "previousQuestion":null,"lang":"en","hits":[],
        "expectedVault":"/synthetic/reviewer-vault","origin":origin,
        "roleSnapshot":{"snapshotId":"synthetic-reviewer-role","origin":origin,
            "role":"ask","usage":"foreground","authorizationRevision":"synthetic-only",
            "routeSignature":{"role":"ask","providerId":"synthetic-only","modelId":"synthetic-only",
                "effort":"(default)","executionLocation":"in-process",
                "artifactRevision":null,"artifactSha256":null,"runtimeContract":"synthetic-only","signature":"synthetic-only"}},
        "scope":"all","range":null,"paths":[selection_path],"maxTokens":null,
        "activityOverview":false,"resolution":null
    })).map_err(|error| error.to_string())
}

pub(super) fn build_cases(pairs: &Value, corpus: &Value) -> Result<Vec<Case>, String> {
    let originals = corpus["sources"]
        .as_array()
        .ok_or("review corpus lacks originals")?;
    let mut cases = Vec::new();
    let mut ids = BTreeSet::new();
    for pair in pairs["pairs"]
        .as_array()
        .ok_or("review artifact lacks pairs")?
    {
        if pair["split"] != "development" {
            continue;
        }
        let source = &pair["source"];
        let original = originals
            .iter()
            .find(|original| original["id"] == source["originalSourceId"])
            .ok_or("review pair has no frozen original")?;
        let body = text(original, "text")?;
        let raw_path = text(source, "path")?;
        if original["sha256"] != source["sha256"]
            || original["path"] != raw_path
            || hash(body.as_bytes()) != text(source, "sha256")?
        {
            return Err("review pair raw body/path/revision hash differs".into());
        }
        let span = &pair["originalSpan"];
        let start = usize::try_from(
            span["startByte"]
                .as_u64()
                .ok_or("review span lacks start")?,
        )
        .map_err(|error| error.to_string())?;
        let end = usize::try_from(span["endByte"].as_u64().ok_or("review span lacks end")?)
            .map_err(|error| error.to_string())?;
        let slice = body
            .get(start..end)
            .ok_or("review span exceeds its original UTF-8 bounds")?;
        if slice != text(span, "text")? || hash(slice.as_bytes()) != text(span, "sha256")? {
            return Err("review span differs from the frozen original bytes".into());
        }
        let span_id = text(span, "id")?;
        let speaker: ActorRole = serde_json::from_value(span["speakerRole"].clone())
            .map_err(|error| error.to_string())?;
        let turn_time = span["turnTime"].as_str().map(str::to_owned);
        let selection = format!("wiki/review-fixture-{}.md", text(source, "id")?);
        for entry in pair["cases"]
            .as_array()
            .ok_or("review pair lacks variants")?
        {
            let id = text(entry, "id")?;
            if !ids.insert(id.clone()) {
                return Err("review development case identity is duplicated".into());
            }
            let expected_verdict = text(&entry["label"], "expectedVerdict")?;
            if !matches!(expected_verdict.as_str(), "accept" | "reject") {
                return Err("review development reference verdict is unsupported".into());
            }
            let request = request(cases.len(), &selection)?;
            let origin = request
                .origin
                .clone()
                .ok_or("review fixture lacks origin")?;
            let document = SourceDocument::bind(
                text(source, "id")?,
                raw_path.clone(),
                selection.clone(),
                &body,
                None,
                vec![SpanInput {
                    id: span_id.clone(),
                    start,
                    end,
                    turn_id: span_id.clone(),
                    speaker,
                    turn_time: turn_time.clone(),
                }],
            )?;
            let sources = SourceSet::new(origin, Scope::All, vec![document], vec![])?;
            cases.push(Case {
                id,
                pair_id: text(pair, "id")?,
                expected_verdict,
                proposal: serde_json::to_string(&entry["proposal"])
                    .map_err(|error| error.to_string())?,
                request,
                sources,
                preview: None,
                expected_review: None,
            });
        }
    }
    if cases.len() != 32
        || cases
            .iter()
            .filter(|case| case.expected_verdict == "accept")
            .count()
            != 16
    {
        return Err("review development must retain all 16 pairs and 32 verdict cases".into());
    }
    Ok(cases)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_conversion_preserves_all_frozen_sources_and_native_prechecks() {
        let pairs: Value =
            serde_json::from_str(include_str!("../../eval/local-wiki-v1/review-pairs.json"))
                .unwrap();
        let corpus: Value =
            serde_json::from_str(include_str!("../../eval/local-wiki-v1/corpus.json")).unwrap();
        let cases = build_cases(&pairs, &corpus).unwrap();
        assert_eq!(cases.len(), 32);
        for case in cases {
            let origin = case.request.origin.as_ref().unwrap();
            let claims = case
                .sources
                .validate(&case.proposal, origin, Scope::All)
                .unwrap();
            assert_eq!(claims.claims.len(), 1);
            assert_eq!(case.sources.spans().count(), 1);
        }
    }

    #[test]
    fn development_conversion_rejects_modified_original_or_span_without_relabeling() {
        let pairs: Value =
            serde_json::from_str(include_str!("../../eval/local-wiki-v1/review-pairs.json"))
                .unwrap();
        let corpus: Value =
            serde_json::from_str(include_str!("../../eval/local-wiki-v1/corpus.json")).unwrap();
        for mutation in 0..3 {
            let mut changed = pairs.clone();
            match mutation {
                0 => changed["pairs"][0]["source"]["sha256"] = json!("changed"),
                1 => changed["pairs"][0]["originalSpan"]["text"] = json!("Different original"),
                _ => changed["pairs"][0]["originalSpan"]["endByte"] = json!(u64::MAX),
            }
            assert!(build_cases(&changed, &corpus).is_err());
        }
    }
}
