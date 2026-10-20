//! Exposed synthetic development cases; protocol success is not semantic acceptance.

use super::{activity_smoke, ProbeHost, ProbeModel};
use myco_lib::local_generation::{activity_synthesis_steps, Request};
use myco_lib::local_llm::GenerationSchema;
use myco_lib::local_synthesis::Evidence;
use myco_lib::retrieval::Scope;
use myco_lib::wiki_claims::{
    ActorRole, ClaimStatus, SourceDocument, SourceSet, SpanInput, SpeechAct,
};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::io::Read;
use std::path::Path;
use std::time::Instant;

const SUITE_ID: &str = "local-wiki-development-meaning-v1";
const ARTIFACT: &str = "local-wiki-development-meaning-v1.json";
const MAX_BYTES: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    version: u32,
    id: String,
    synthetic_only: bool,
    split: String,
    label_status: String,
    source_review: SourceReview,
    artifact: Artifact,
    case_count: usize,
    semantic_acceptance: String,
    runtime_prompt_override: bool,
    native_authority: bool,
    private_vault_read: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceReview {
    status: String,
    method: String,
    reviewer: String,
    independent_human: bool,
    inference_observed: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Artifact {
    path: String,
    bytes: usize,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Corpus {
    version: u32,
    id: String,
    synthetic_only: bool,
    split: String,
    scope: String,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Case {
    id: String,
    synthetic_only: bool,
    title: String,
    language: String,
    question: String,
    activity_period: Period,
    source: Original,
    gold: Gold,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Period {
    start: String,
    end: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Original {
    id: String,
    path: String,
    selection_path: String,
    #[serde(deserialize_with = "required_optional")]
    record_time: Option<String>,
    original: String,
    bytes: usize,
    sha256: String,
    turns: Vec<Turn>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Turn {
    id: String,
    start: usize,
    end: usize,
    text: String,
    sha256: String,
    turn_id: String,
    speaker: ActorRole,
    #[serde(deserialize_with = "required_optional")]
    turn_time: Option<String>,
    #[serde(deserialize_with = "required_optional")]
    source_phase: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Gold {
    required_facts: Vec<String>,
    expected_claims: Vec<ExpectedClaim>,
    forbidden_interpretations: Vec<String>,
    answer_expectations: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExpectedClaim {
    meaning: String,
    source_turn_ids: Vec<String>,
    actor_role: ActorRole,
    speech_act: SpeechAct,
    status: ClaimStatus,
    event_time_meaning: String,
}

pub(super) struct Suite {
    manifest_sha256: String,
    artifact_sha256: String,
    source_review: SourceReview,
    scope: String,
    cases: Vec<Case>,
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn required_optional<'de, D: Deserializer<'de>>(decoder: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(decoder)
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, String> {
    let file = std::fs::File::open(path).map_err(|error| format!("development input: {error}"))?;
    if !file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("development input must be an explicit regular file".into());
    }
    let mut bytes = Vec::new();
    file.take((MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err("development input exceeds its bounded file size".into());
    }
    Ok(bytes)
}

/// Only the selected manifest and its same-directory, SHA-bound synthetic JSON
/// are read. No user vault, directory discovery or installed fallback exists.
pub(super) fn load(path: &Path) -> Result<Suite, String> {
    let path = path
        .canonicalize()
        .map_err(|error| format!("development manifest: {error}"))?;
    let manifest_bytes = read_bounded(&path)?;
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|error| format!("development manifest JSON: {error}"))?;
    if manifest.version != 1
        || manifest.id != SUITE_ID
        || !manifest.synthetic_only
        || manifest.split != "development"
        || manifest.label_status != "frozen_before_inference"
        || manifest.source_review.status != "automated_agent_original_source_reviewed"
        || manifest.source_review.method != "original_source_only"
        || manifest.source_review.reviewer.trim().is_empty()
        || manifest.source_review.independent_human
        || manifest.source_review.inference_observed
        || manifest.runtime_prompt_override
        || manifest.native_authority
        || manifest.private_vault_read
        || manifest.semantic_acceptance != "manual_original_source_cross_review_required"
        || manifest.artifact.path != ARTIFACT
        || !(1..=4).contains(&manifest.case_count)
    {
        return Err("development manifest lacks the explicit synthetic, pre-inference source-review contract".into());
    }
    let parent = path.parent().ok_or("development manifest has no parent")?;
    let artifact_path = parent
        .join(&manifest.artifact.path)
        .canonicalize()
        .map_err(|error| format!("development artifact: {error}"))?;
    if artifact_path.parent() != Some(parent) {
        return Err("development artifact escapes the selected manifest directory".into());
    }
    let bytes = read_bounded(&artifact_path)?;
    if bytes.len() != manifest.artifact.bytes || sha256(&bytes) != manifest.artifact.sha256 {
        return Err("development artifact bytes or SHA differ from its manifest".into());
    }
    let corpus: Corpus = serde_json::from_slice(&bytes)
        .map_err(|error| format!("development corpus JSON: {error}"))?;
    if corpus.version != 1
        || corpus.id != SUITE_ID
        || !corpus.synthetic_only
        || corpus.split != "development"
        || corpus.scope.trim().is_empty()
        || corpus.cases.len() != manifest.case_count
    {
        return Err("development corpus identity, split or count differs from its manifest".into());
    }
    let mut ids = HashSet::new();
    for (index, case) in corpus.cases.iter().enumerate() {
        if !ids.insert(&case.id) {
            return Err("development case ID is duplicated".into());
        }
        let first_id = format!("D{}A", index + 1);
        if case.source.turns.first().map(|turn| turn.id.as_str()) != Some(first_id.as_str()) {
            return Err("development span IDs must match the bounded case ordinal".into());
        }
        case.document()?;
    }
    Ok(Suite {
        manifest_sha256: sha256(&manifest_bytes),
        artifact_sha256: manifest.artifact.sha256,
        source_review: manifest.source_review,
        scope: corpus.scope,
        cases: corpus.cases,
    })
}

fn bounded_phrases(phrases: &[String]) -> bool {
    (1..=8).contains(&phrases.len())
        && phrases
            .iter()
            .all(|text| !text.trim().is_empty() && text.chars().count() <= 512)
}

fn valid_day(day: &str) -> bool {
    let bytes = day.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes
            .iter()
            .enumerate()
            .any(|(index, byte)| index != 4 && index != 7 && !byte.is_ascii_digit())
    {
        return false;
    }
    let year: u32 = day[..4].parse().unwrap_or(0);
    let month: u32 = day[5..7].parse().unwrap_or(0);
    let date: u32 = day[8..].parse().unwrap_or(0);
    let days = match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => return false,
    };
    (1..=days).contains(&date)
}

impl Case {
    fn document(&self) -> Result<SourceDocument, String> {
        let suffix = self
            .id
            .strip_prefix("synthetic-dev-")
            .ok_or("development case lacks its synthetic ID marker")?;
        let source = &self.source;
        if suffix.is_empty()
            || self.id.len() > 48
            || !suffix
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            || !self.synthetic_only
            || !self.title.starts_with("Synthetic ")
            || !matches!(self.language.as_str(), "ko" | "en" | "ja")
            || self.question.trim().is_empty()
            || self.question.chars().count() > 2000
            || !valid_day(&self.activity_period.start)
            || !valid_day(&self.activity_period.end)
            || self.activity_period.start > self.activity_period.end
            || source.id != format!("{}-source", self.id)
            || source.path != format!("raw/synthetic-development/{}.md", self.id)
            || source.selection_path != format!("wiki/synthetic-development/{}.md", self.id)
            || source.bytes != source.original.len()
            || source.bytes > 4096
            || sha256(source.original.as_bytes()) != source.sha256
            || !(source.original.to_lowercase().contains("synthetic")
                || source.original.contains("합성"))
            || !(1..=3).contains(&source.turns.len())
            || !bounded_phrases(&self.gold.required_facts)
            || !bounded_phrases(&self.gold.forbidden_interpretations)
            || !bounded_phrases(&self.gold.answer_expectations)
            || !(1..=8).contains(&self.gold.expected_claims.len())
        {
            return Err(
                "development case lacks bounded synthetic originals or semantic gold".into(),
            );
        }
        let mut next = 0;
        let mut inputs = Vec::new();
        let first = source.turns[0].id.as_bytes();
        if first.len() != 3
            || first[0] != b'D'
            || !(b'1'..=b'4').contains(&first[1])
            || first[2] != b'A'
        {
            return Err("development originals lack their short synthetic span marker".into());
        }
        for (index, turn) in source.turns.iter().enumerate() {
            let turn_id = format!("D{}{}", first[1] as char, (b'A' + index as u8) as char);
            if turn.id != turn_id
                || turn.turn_id != turn_id
                || turn.start != next
                || turn.end != turn.start + turn.text.len()
                || turn.text.is_empty()
                || source.original.get(turn.start..turn.end) != Some(turn.text.as_str())
                || sha256(turn.text.as_bytes()) != turn.sha256
                || turn.source_phase.is_some()
            {
                return Err(
                    "development turn bytes, offsets, SHA, identity or null phase differ".into(),
                );
            }
            next = turn.end;
            if index + 1 < source.turns.len() {
                if source.original.as_bytes().get(next) != Some(&b'\n') {
                    return Err(
                        "development turns must retain their exact newline separator".into(),
                    );
                }
                next += 1;
            }
            inputs.push(SpanInput {
                id: turn.id.clone(),
                start: turn.start,
                end: turn.end,
                turn_id: turn.turn_id.clone(),
                speaker: turn.speaker,
                turn_time: turn.turn_time.clone(),
            });
        }
        if next != source.original.len()
            || self.gold.expected_claims.iter().any(|claim| {
                claim.meaning.trim().is_empty()
                    || claim.meaning.chars().count() > 512
                    || claim.event_time_meaning.trim().is_empty()
                    || claim.event_time_meaning.chars().count() > 512
                    || claim.source_turn_ids.is_empty()
                    || claim.source_turn_ids.len() > 3
                    || claim.source_turn_ids.iter().collect::<HashSet<_>>().len()
                        != claim.source_turn_ids.len()
                    || claim
                        .source_turn_ids
                        .iter()
                        .any(|id| !source.turns.iter().any(|turn| &turn.turn_id == id))
                    || matches!(
                        claim.status,
                        ClaimStatus::VerifiedCompleted | ClaimStatus::VerifiedFailed
                    )
            })
        {
            return Err("development gold lacks complete original support".into());
        }
        // Public binding issues null phase; declaring a non-null phase cannot fake it.
        SourceDocument::bind(
            source.id.clone(),
            source.path.clone(),
            source.selection_path.clone(),
            &source.original,
            source.record_time.clone(),
            inputs,
        )
    }

    fn fixture(&self, model: &ProbeModel) -> Result<(Request, Vec<Evidence>, SourceSet), String> {
        let document = self.document()?;
        let evidence = vec![Evidence {
            page: self.source.selection_path.clone(),
            stem: self.title.clone(),
            section: 0,
            text: self.source.original.clone(),
            title: None,
            compiled: None,
        }];
        let mut request =
            activity_smoke::request(model, &self.id, &self.question, &evidence, true)?;
        request.lang = self.language.clone();
        request.range = Some(
            serde_json::from_value(json!({
                "start":self.activity_period.start,"end":self.activity_period.end
            }))
            .map_err(|error| format!("development activity period: {error}"))?,
        );
        let origin = request
            .origin
            .clone()
            .ok_or("development synthetic binding unavailable")?;
        Ok((
            request,
            evidence,
            SourceSet::new(origin, Scope::Wiki, vec![document], vec![])?,
        ))
    }
}

struct PacketTracker {
    originals: Vec<Value>,
    cursor: usize,
    current: Vec<Value>,
    awaiting_review: bool,
    answer_generated: bool,
    answer_reviewed: bool,
}

// These development-only phases check transport order, never native review authority.
#[derive(Clone, Copy)]
enum PacketStage {
    Claims,
    ClaimReview,
    Answer,
    AnswerReview,
}

impl PacketStage {
    fn from_schema(schema: GenerationSchema) -> Result<Self, String> {
        match schema {
            GenerationSchema::WikiClaimsV1 => Ok(Self::Claims),
            GenerationSchema::WikiClaimReviewV1(_) => Ok(Self::ClaimReview),
            GenerationSchema::AskAnswerV1 => Ok(Self::Answer),
            GenerationSchema::AskAnswerReviewV1 => Ok(Self::AnswerReview),
            _ => Err("development probe received a non-activity schema".into()),
        }
    }
}

impl PacketTracker {
    fn new(originals: Vec<Value>) -> Self {
        Self {
            originals,
            cursor: 0,
            current: Vec::new(),
            awaiting_review: false,
            answer_generated: false,
            answer_reviewed: false,
        }
    }

    fn expected(&mut self, stage: PacketStage, user: &str) -> Result<Vec<Value>, String> {
        let expected = match stage {
            PacketStage::Claims if !self.awaiting_review && !self.answer_generated => {
                let payload: Value =
                    serde_json::from_str(user).map_err(|error| error.to_string())?;
                let spans = payload["originalSpans"]
                    .as_array()
                    .ok_or("development extraction lacks originals")?;
                if !(1..=2).contains(&spans.len())
                    || self.cursor + spans.len() > self.originals.len()
                    || spans
                        .iter()
                        .filter_map(|span| span["id"].as_str())
                        .collect::<HashSet<_>>()
                        .len()
                        != spans.len()
                {
                    return Err(
                        "development extraction skipped, duplicated or exceeded bounded originals"
                            .into(),
                    );
                }
                self.current = self.originals[self.cursor..self.cursor + spans.len()].to_vec();
                activity_smoke::packet_matches(user, &self.current, true)?;
                self.cursor += spans.len();
                self.awaiting_review = true;
                self.current.clone()
            }
            PacketStage::ClaimReview if self.awaiting_review => {
                self.awaiting_review = false;
                self.current.clone()
            }
            PacketStage::Answer
                if self.cursor == self.originals.len()
                    && !self.awaiting_review
                    && !self.answer_generated =>
            {
                self.answer_generated = true;
                self.originals.clone()
            }
            PacketStage::AnswerReview if self.answer_generated && !self.answer_reviewed => {
                self.answer_reviewed = true;
                self.originals.clone()
            }
            _ => return Err("development stage lacks its complete ordered original packet".into()),
        };
        activity_smoke::packet_matches(user, &expected, true)?;
        Ok(expected)
    }
}

impl Suite {
    pub(super) fn metadata(&self) -> Value {
        json!({"phase":"development_manifest","suite":SUITE_ID,"split":"development",
            "manifestSha256":self.manifest_sha256,"artifactSha256":self.artifact_sha256,
            "caseCount":self.cases.len(),"sourceReview":self.source_review,"scope":self.scope,
            "experimental_prompt_override":false,"native_io_authenticated":false,
            "semantic_accepted":false,"production_accepted":false})
    }

    pub(super) fn run(&self, probe: ProbeHost<'_>) -> Result<(), String> {
        let mut failures = Vec::new();
        for case in &self.cases {
            let (request, evidence, sources) = case.fixture(probe.model)?;
            let original_spans = serde_json::to_value(sources.spans().collect::<Vec<_>>())
                .map_err(|error| error.to_string())?
                .as_array()
                .cloned()
                .ok_or("invalid development source spans")?;
            let mut tracker = PacketTracker::new(original_spans);
            let mut stages = Vec::new();
            let started = Instant::now();
            let result = activity_synthesis_steps(
                &request,
                &evidence,
                &sources,
                request
                    .origin
                    .as_ref()
                    .ok_or("development synthetic origin unavailable")?,
                |system, user| probe.host.chat_token_count(system, user),
                |system, user, output, context, schema| {
                    let expected = tracker.expected(PacketStage::from_schema(schema)?, user)?;
                    stages.push(schema);
                    activity_smoke::decode(
                        probe,
                        (system, user),
                        (output, context),
                        schema,
                        &case.id,
                        &expected,
                        true,
                    )
                },
            );
            println!(
                "{}",
                json!({"phase":"activity_flow","suite":SUITE_ID,"case":case.id,
                "model":probe.model.metadata(),"manifestSha256":self.manifest_sha256,
                "artifactSha256":self.artifact_sha256,"sourceSha256":case.source.sha256,
                "prompt_variant":"production","experimental_prompt_override":false,
                "generation_calls":stages.len(),"elapsed_ms":started.elapsed().as_secs_f64()*1000.0,
                "answer":result.as_ref().ok().map(|value|&value.answer),
                "receipt":result.as_ref().ok().map(|value|&value.receipt),
                "failure":result.as_ref().err().map(|error|format!("{}: {}",error.code,error.detail)),
                "gold":case.gold,"gold_scope":"pre-inference automated-agent original-source labels; no keyword quality grader",
                "four_stage_completed":result.is_ok(),"manual_meaning_review_required":true,
                "native_io_authenticated":false,"product_role_authorized":false,
                "semantic_accepted":false,"production_accepted":false,
                "scope":"actual model/shared production helpers with synthetic custody; not actual query_activity_v3 IPC or installed acceptance"})
            );
            if let Err(error) = result {
                failures.push(format!("{}: {}: {}", case.id, error.code, error.detail));
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }
}

#[cfg(test)]
#[path = "development_smoke_tests.rs"]
mod tests;
