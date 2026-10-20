//! Closed question-specific development packets; reference answers never enter model inputs.

use super::*;
use crate::wiki_claims::{ActorRole, SourceDocument, SpanInput};
use serde::Deserialize;
use sha2::{Digest, Sha256};

pub const CASE_IDS: [&str; 7] = [
    "FUTURE-R-ALL",
    "FUTURE-A-ALL",
    "FUTURE-R-D2",
    "FUTURE-R-D4",
    "FUTURE-A-D2",
    "FUTURE-A-D4",
    "FUTURE-A-D3",
];
pub const REFERENCES_SHA256: &str =
    "5c8812c0352d729203ef91eff0f2c5ef39c1027cbd73e371b1373e833791e4cc";

struct Original {
    id: &'static str,
    path: &'static str,
    raw: &'static str,
    sha: &'static str,
    bytes: usize,
    turns: usize,
}
const ORIGINALS: [Original; 4] = [
    Original { id: "D1", path: "sessions/2026-10/synthetic-native-synthetic-dev-plan-negation.md",
        raw: include_str!("../../../eval/local-wiki-native-activity-development-v1/corpus/sessions/2026-10/synthetic-native-synthetic-dev-plan-negation.fixture"),
        sha: "ac6b29c3e38db5c7912befa56abd3394b3d070e75df1d045692eeeaf8f2cde74", bytes: 588, turns: 2 },
    Original { id: "D2", path: "sessions/2026-10/synthetic-native-synthetic-dev-decision-cause.md",
        raw: include_str!("../../../eval/local-wiki-native-activity-development-v1/corpus/sessions/2026-10/synthetic-native-synthetic-dev-decision-cause.fixture"),
        sha: "7e2c73668138e4e213ebfda6cfbba963272b9f1b441182065bccfc7c027d5077", bytes: 648, turns: 2 },
    Original { id: "D3", path: "sessions/2026-10/synthetic-native-synthetic-dev-actor-event-date.md",
        raw: include_str!("../../../eval/local-wiki-native-activity-development-v1/corpus/sessions/2026-10/synthetic-native-synthetic-dev-actor-event-date.fixture"),
        sha: "7985e794a530d5700da9a976cc883639526749ae9c25f9cf467a2e08e66a78cb", bytes: 630, turns: 2 },
    Original { id: "D4", path: "sessions/2026-10/synthetic-native-synthetic-dev-cancel-reopen.md",
        raw: include_str!("../../../eval/local-wiki-native-activity-development-v1/corpus/sessions/2026-10/synthetic-native-synthetic-dev-cancel-reopen.fixture"),
        sha: "d2147665263602c1a8d05b0d10169247c43f17d9fc4e93d85418d411e4cbcf30", bytes: 804, turns: 3 },
];
fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Turn {
    message_id: String,
    original_role: String,
    timestamp: String,
    phase: Option<String>,
}
fn field(raw: &str, name: &str) -> Result<String, String> {
    let prefix = format!("{name}: ");
    let value = raw
        .lines()
        .find_map(|line| line.strip_prefix(&prefix))
        .ok_or_else(|| format!("development container field missing: {name}"))?;
    serde_json::from_str(value).map_err(|error| error.to_string())
}
fn bind(original: &Original) -> Result<(SourceDocument, Evidence), String> {
    if original.raw.len() != original.bytes || hash(original.raw) != original.sha {
        return Err("compiled complete development container bytes or SHA changed".into());
    }
    let raw = original.raw;
    let metadata = raw
        .lines()
        .find_map(|line| line.strip_prefix("turn_metadata: "))
        .ok_or("development turn metadata absent")?;
    let turns: Vec<Turn> = serde_json::from_str(metadata).map_err(|error| error.to_string())?;
    let body = raw
        .find("\n---\n")
        .filter(|_| raw.starts_with("---\n"))
        .ok_or("development frontmatter boundary absent")?
        + "\n---\n".len();
    let mut boundaries = Vec::new();
    let mut offset = body;
    for line in raw[body..].split_inclusive('\n') {
        let role = match line {
            "**User:**\n" => Some(ActorRole::User),
            "**Assistant:**\n" => Some(ActorRole::Assistant),
            _ => None,
        };
        if let Some(role) = role {
            boundaries.push((offset, offset + line.len(), role));
        }
        offset += line.len();
    }
    if turns.len() != original.turns
        || turns.len() != boundaries.len()
        || boundaries.first().map(|boundary| boundary.0) != Some(body)
    {
        return Err("development full turn membership changed".into());
    }
    let mut inputs = Vec::new();
    for (index, (turn, &(_, start, speaker))) in turns.iter().zip(&boundaries).enumerate() {
        let role: ActorRole =
            serde_json::from_value(json!(turn.original_role)).map_err(|error| error.to_string())?;
        if role != speaker
            || turn.phase.is_some()
            || turn.message_id != format!("{}{}", original.id, char::from(b'A' + index as u8))
        {
            return Err("development turn identity, speaker or null phase changed".into());
        }
        inputs.push(SpanInput {
            id: format!("Q-development-{}", turn.message_id),
            start,
            end: boundaries.get(index + 1).map_or(raw.len(), |next| next.0),
            turn_id: turn.message_id.clone(),
            speaker,
            turn_time: Some(turn.timestamp.clone()),
        });
    }
    let document = SourceDocument::bind(
        format!("S-development-{}", original.id),
        original.path.into(),
        original.path.into(),
        raw,
        Some(field(raw, "created")?),
        inputs,
    )?;
    let title = field(raw, "title")?;
    let evidence = Evidence {
        page: original.path.into(),
        stem: title.clone(),
        section: 0,
        text: raw.into(),
        title: Some(title),
        compiled: None,
    };
    Ok((document, evidence))
}

/// Admission-only inventory; no expected facts or answerability class is served.
pub fn corpus_manifest() -> Value {
    json!(ORIGINALS
        .iter()
        .map(|source| json!({"fixtureId":source.id,"path":source.path,
        "sha256":source.sha,"bytes":source.bytes,"turnCount":source.turns}))
        .collect::<Vec<_>>())
}

/// Immutable prepared synthetic case. Its role/opening are custody labels, not grants.
pub struct PreparedCase {
    id: &'static str,
    question_index: usize,
    fixture_ids: &'static [usize],
    request: Request,
    evidence: Vec<Evidence>,
    sources: SourceSet,
}
impl PreparedCase {
    pub fn id(&self) -> &'static str {
        self.id
    }
    pub fn question_index(&self) -> usize {
        self.question_index
    }
    pub fn request(&self) -> &Request {
        &self.request
    }
    pub fn original_count(&self) -> usize {
        self.sources.spans().count()
    }
    pub fn run(
        &self,
        token_count: impl Fn(&str, &str) -> Result<usize, String>,
        generate: impl FnMut(&str, &str, i32, u32, GenerationSchema) -> Result<String, String>,
    ) -> Result<Value, ActivityFlowFailure> {
        self.run_with_wire_format_qa(QaWireFormat::Flat, token_count, generate)
    }

    /// Opt-in representation diagnostic; case binding and semantic criteria are unchanged.
    pub fn run_with_wire_format_qa(
        &self,
        format: QaWireFormat,
        token_count: impl Fn(&str, &str) -> Result<usize, String>,
        generate: impl FnMut(&str, &str, i32, u32, GenerationSchema) -> Result<String, String>,
    ) -> Result<Value, ActivityFlowFailure> {
        self.run_selected(format, None, token_count, generate)
    }

    /// Paired KO advice diagnostic; neither summary cases nor other languages are admitted.
    pub fn run_with_advice_policy_qa(
        &self,
        format: QaWireFormat,
        policy: KoAdvicePolicyQa,
        token_count: impl Fn(&str, &str) -> Result<usize, String>,
        generate: impl FnMut(&str, &str, i32, u32, GenerationSchema) -> Result<String, String>,
    ) -> Result<Value, ActivityFlowFailure> {
        if self.question_index != 1
            || self.request.lang != "ko"
            || self.request.question != QUESTIONS[1]
        {
            return Err(ActivityFlowFailure {
                code: "source_verification_failed",
                detail: "KO advice policy QA requires an unchanged prepared advice case".into(),
            });
        }
        self.run_selected(format, Some(policy), token_count, generate)
    }

    fn run_selected(
        &self,
        format: QaWireFormat,
        policy: Option<KoAdvicePolicyQa>,
        token_count: impl Fn(&str, &str) -> Result<usize, String>,
        generate: impl FnMut(&str, &str, i32, u32, GenerationSchema) -> Result<String, String>,
    ) -> Result<Value, ActivityFlowFailure> {
        let expected = self
            .fixture_ids
            .iter()
            .map(|&index| ORIGINALS[index].turns)
            .sum();
        let mut result = super::run_bound(
            &self.request,
            &self.evidence,
            &self.sources,
            self.request
                .origin
                .as_ref()
                .expect("prepared synthetic origin"),
            expected,
            format,
            policy,
            token_count,
            generate,
        )?;
        result["developmentCaseId"] = json!(self.id);
        result["referenceCriteriaServedToModel"] = json!(false);
        if let Some(policy) = policy {
            result["koAdvicePolicyQa"] = json!(policy);
        }
        Ok(result)
    }
}

/// Prepare all seven known development cases before any model is resolved.
pub fn prepare_all() -> Result<Vec<PreparedCase>, String> {
    let bindings = ORIGINALS.iter().map(bind).collect::<Result<Vec<_>, _>>()?;
    let schedule: [(&str, usize, &[usize]); 7] = [
        (CASE_IDS[0], 0, &[0, 1, 2, 3]),
        (CASE_IDS[1], 1, &[0, 1, 2, 3]),
        (CASE_IDS[2], 0, &[1]),
        (CASE_IDS[3], 0, &[3]),
        (CASE_IDS[4], 1, &[1]),
        (CASE_IDS[5], 1, &[3]),
        (CASE_IDS[6], 1, &[2]),
    ];
    let origin = AgentVaultSession {
        vault_path: "/synthetic/question-specific-development".into(),
        opening_token: "synthetic-rebound-not-a-live-native-opening".into(),
    };
    let mut prepared = Vec::new();
    for (id, question_index, fixture_ids) in schedule {
        let documents = fixture_ids
            .iter()
            .map(|&index| bindings[index].0.clone())
            .collect();
        let evidence: Vec<_> = fixture_ids
            .iter()
            .map(|&index| bindings[index].1.clone())
            .collect();
        let captured = if question_index == 0 {
            1792173935_i64
        } else {
            1792174502_i64
        };
        let request: Request = serde_json::from_value(json!({
            "modelId":GEMMA12B_CANDIDATE.id,"requestId":format!("qa-development-{id}"),
            "question":QUESTIONS[question_index],"previousQuestion":null,"lang":"ko","hits":evidence,
            "expectedVault":origin.vault_path,"origin":origin,
            "roleSnapshot":{"snapshotId":format!("synthetic-development-{id}"),"origin":origin,
                "role":"ask","usage":"foreground","authorizationRevision":"synthetic-no-authority",
                "routeSignature":{"role":"ask","providerId":"builtin-local","modelId":GEMMA12B_CANDIDATE.id,
                    "effort":"none","executionLocation":"in-process","artifactRevision":GEMMA12B_CANDIDATE.revision,
                    "artifactSha256":GEMMA12B_CANDIDATE.sha256,"runtimeContract":"synthetic-development-reading-diagnostic",
                    "signature":"not-a-native-issued-grant"}},
            "scope":"all","range":{"start":"2026-10-01","end":"2026-10-04",
                "startEpoch":1790780400_i64,"endEpoch":1791126000_i64},
            "paths":evidence.iter().map(|source|&source.page).collect::<Vec<_>>(),
            "maxTokens":768,"activityOverview":true,
            "resolution":{"mode":if question_index==0{"historical_as_of"}else{"current_state"},
                "asOfEpoch":if question_index==0{1791125999_i64}else{captured},"capturedQueryEpoch":captured}
        })).map_err(|error| error.to_string())?;
        prepared.push(PreparedCase {
            id,
            question_index,
            fixture_ids,
            request,
            evidence,
            sources: SourceSet::new(origin.clone(), Scope::All, documents, vec![])?,
        });
    }
    Ok(prepared)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule_matches_frozen_question_reference_metadata_without_serving_gold() {
        let raw = include_str!(
            "../../../eval/local-wiki-native-activity-development-v1/question-references-v1.json"
        );
        assert_eq!(hash(raw), REFERENCES_SHA256);
        let reference: Value = serde_json::from_str(raw).unwrap();
        let prepared = prepare_all().unwrap();
        let cases = reference["proposal"]["cases"].as_array().unwrap();
        assert_eq!(prepared.len(), 7);
        for (case, reference) in prepared.iter().zip(cases) {
            assert_eq!(json!(case.id()), reference["case_id"]);
            assert_eq!(json!(case.request.question), reference["question"]);
            let ids: Vec<_> = case
                .fixture_ids
                .iter()
                .map(|&index| ORIGINALS[index].id)
                .collect();
            assert_eq!(json!(ids), reference["fixture_ids"]);
        }
    }

    #[test]
    fn every_case_preserves_complete_turns_exact_coordinates_and_all_fourteen_fields() {
        let mapping: Value = serde_json::from_str(include_str!(
            "../../../eval/local-wiki-native-activity-development-v1/span-mapping.json"
        ))
        .unwrap();
        for case in prepare_all().unwrap() {
            assert_eq!(
                case.sources.spans().count(),
                case.fixture_ids
                    .iter()
                    .map(|&index| ORIGINALS[index].turns)
                    .sum::<usize>()
            );
            for span in case.sources.spans() {
                let original = ORIGINALS
                    .iter()
                    .find(|source| source.path == span.selection_path())
                    .unwrap();
                let value = serde_json::to_value(span).unwrap();
                let container = mapping["containers"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|container| container["vaultPath"] == original.path)
                    .unwrap();
                let turn = container["turns"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|turn| turn["originalTurnId"] == value["turnId"])
                    .unwrap();
                let start = turn["nativeBodyStart"].as_u64().unwrap() as usize;
                let end = turn["nativeBodyEnd"].as_u64().unwrap() as usize;
                assert_eq!(
                    value,
                    json!({
                        "id":format!("Q-development-{}",turn["originalTurnId"].as_str().unwrap()),
                        "speaker":turn["speaker"],"text":&original.raw[start..end],
                        "turnId":turn["originalTurnId"],"turnTime":turn["turnTimestamp"],
                        "sourcePhase":turn["sourcePhase"],"recordTime":container["recordTime"],
                        "sourceId":format!("S-development-{}",original.id),
                        "sourcePath":original.path,"selectionPath":original.path,
                        "sourceRevision":container["containerSha256"],"start":start,"end":end,
                        "sha256":turn["nativeBodySha256"],
                    })
                );
                assert_eq!(value.as_object().unwrap().len(), 14);
            }
        }
    }

    #[test]
    fn all_sources_remain_in_unfitting_case_without_generation_or_criteria_leakage() {
        let cases = prepare_all().unwrap();
        let error = cases[0]
            .run(
                |_, user| {
                    let packet: Value = serde_json::from_str(user).unwrap();
                    let originals: usize = packet["sources"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|source| source["originalSpans"].as_array().unwrap().len())
                        .sum();
                    assert_eq!(originals, 9);
                    assert_eq!(packet["coverage"]["omittedSuppliedOriginalSpans"], 0);
                    assert!(packet.get("expectation_class").is_none());
                    assert!(packet.get("required_answer_meaning").is_none());
                    Ok(3321)
                },
                |_, _, _, _, _| panic!("unfitting full original case must not generate"),
            )
            .unwrap_err();
        assert_eq!(error.code, "review_not_fit");
    }

    #[test]
    fn grouped_all_case_retains_complete_ordered_originals_in_draft_and_uncited_review_closure() {
        use crate::local_synthesis::original_groups_qa;
        use std::cell::{Cell, RefCell};
        let cases = prepare_all().unwrap();
        let case = &cases[0];
        let expected = serde_json::to_value(case.sources.spans().collect::<Vec<_>>()).unwrap();
        let expected_context = RefCell::new(None);
        let calls = Cell::new(0);
        let result = case.run_with_wire_format_qa(QaWireFormat::SourceDocumentGroupsQaV1,
            |system, _| { assert!(system.ends_with(original_groups_qa::GROUP_INSTRUCTION)); Ok(500) },
            |_, user, output, window, schema| {
                assert_eq!((output, window), (768, 4096));
                calls.set(calls.get()+1);
                let payload: Value = serde_json::from_str(user).unwrap();
                assert!(payload.get("required_answer_meaning").is_none());
                assert!(payload.get("expectation_class").is_none());
                let actual = if schema == GenerationSchema::AskAnswerV1 {
                    *expected_context.borrow_mut() = Some(payload["context"].clone());
                    let mut spans = Vec::new();
                    for source in payload["sources"].as_array().unwrap() {
                        let flat = original_groups_qa::decode(&source["originalSpans"].to_string())?;
                        spans.extend(flat.as_array().unwrap().iter().cloned());
                    }
                    Value::Array(spans)
                } else {
                    assert_eq!(payload["context"], *expected_context.borrow().as_ref().unwrap());
                    assert_eq!(payload["answer"]["sourceIds"], json!(["S1"]));
                    original_groups_qa::decode(&payload["originalSpans"].to_string())?
                };
                assert_eq!(actual, expected);
                assert_eq!(actual.as_array().unwrap().len(), 9);
                assert!(actual.as_array().unwrap().iter().all(|span|span.as_object().unwrap().len()==14));
                Ok(if schema == GenerationSchema::AskAnswerV1 {
                    json!({"answer":"합성 기록에는 서로 다른 원문 활동과 한정이 있습니다.","sources":["S1"]}).to_string()
                } else {
                    json!({"version":"AskAnswerReviewV1","answerDisposition":"supported","taskResponse":"adequate",
                        "sourceCoverage":"covered","missingSpanIds":[],"reason":"Synthetic binding control only, not semantic proof."}).to_string()
                })
            }).unwrap();
        assert_eq!(calls.get(), 2);
        assert_eq!(result["native_io_authenticated"], false);
        assert_eq!(result["product_role_authorized"], false);
        assert_eq!(result["activityContractAccepted"], false);
    }
}

#[cfg(test)]
#[path = "development_advice_policy_qa_tests.rs"]
mod advice_policy_qa_tests;
