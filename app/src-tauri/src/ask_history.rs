//! Ask history (UX S36): every finished Ask turn, one JSON line each, in an
//! append-only log per vault under the app data dir —
//! `<app-data>/ask-history/<hash>.jsonl`, keyed by the same vault-root hash
//! `VectorStore::path_for` keys the vault's index by. Outside the vault on
//! purpose: the history is this device's, so it never syncs, never conflicts
//! with another device's log, and never lands anywhere near `raw/`.
//!
//! A line that does not parse (a torn write, a hand edit), or whose time no JS
//! `Date` can hold, is skipped, never fatal: the rest of the history still
//! loads. The log keeps the last [`CAP`]
//! turns; an append that finds more than `CAP + SLACK` lines rewrites the file
//! with the last `CAP` (temp + rename), so the common append stays one write.

use serde::{Deserialize, Serialize};
use std::hash::{Hash, Hasher};
use std::io::Write as _;
use std::path::{Path, PathBuf};

/// Turns the log keeps.
pub const CAP: usize = 500;
/// Lines past [`CAP`] before an append compacts: one rewrite per 50 turns,
/// not one per turn.
const SLACK: usize = 50;

/// One Ask turn as the page showed it. Mirrored in ipc.ts `AskRecord`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AskTurn {
    /// Unix milliseconds the turn finished.
    pub at: u64,
    pub q: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// The answer as shown: the quoted lines under their `[[stem]]` for an
    /// extractive answer, the provider's text otherwise. Empty for an
    /// abstained, failed or stopped turn.
    #[serde(default)]
    pub a: String,
    /// Stems of the notes the answer cited.
    #[serde(default)]
    pub cited: Vec<String>,
    #[serde(
        default,
        rename = "citationEvidence",
        deserialize_with = "read_citation_evidence",
        skip_serializing_if = "Option::is_none"
    )]
    pub citation_evidence: Option<CitationEvidence>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub abstained: bool,
    #[serde(
        default,
        rename = "abstainReason",
        skip_serializing_if = "Option::is_none"
    )]
    pub abstain_reason: Option<AbstainReason>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub stopped: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// "Ask this note" (UX S37): the turn ran over this note and its one-hop
    /// links instead of a scope.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<NoteRef>,
    /// Applied retrieval limits and partial evidence as the answer showed them.
    /// Metadata only: it grants no source access and is not a correctness verdict.
    #[serde(
        default,
        rename = "searchContext",
        deserialize_with = "read_search_context",
        skip_serializing_if = "Option::is_none"
    )]
    pub search_context: Option<AskSearchContext>,
    /// App command provenance, not proof of GPU use or semantic correctness.
    #[serde(
        default,
        deserialize_with = "read_execution",
        skip_serializing_if = "Option::is_none"
    )]
    pub execution: Option<AskExecution>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskExecution {
    pub version: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selected: Option<AskRequestedModel>,
    pub answer_kind: AskAnswerKind,
    pub calls: Vec<AskExecutionCall>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskRequestedModel {
    pub provider_id: String,
    pub model_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AskAnswerKind {
    None,
    Clarification,
    Extractive,
    Application,
    ModelResponse,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AskRequestPurpose {
    Answer,
    PeriodPlan,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AskRequestState {
    Submitted,
    ResponseReceived,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskExecutionCall {
    pub id: String,
    pub purpose: AskRequestPurpose,
    pub requested: AskRequestedModel,
    pub state: AskRequestState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub identity: Option<AskModelIdentity>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskModelIdentity {
    pub model_id: String,
    pub source: AskIdentitySource,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AskIdentitySource {
    ProviderResponse,
    LocalManifest,
}

fn read_execution<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<AskExecution>, D::Error> {
    let value = serde_json::Value::deserialize(d)?;
    Ok(serde_json::from_value::<AskExecution>(value)
        .ok()
        .filter(|execution| {
            let id = |value: &str, limit: usize, empty: bool| {
                value.len() <= limit
                    && (empty || !value.trim().is_empty())
                    && !value.chars().any(char::is_control)
            };
            let route = |value: &AskRequestedModel| {
                id(&value.provider_id, 128, false) && id(&value.model_id, 512, true)
            };
            let mut ids = std::collections::HashSet::new();
            execution.version == 1
                && execution.calls.len() <= 32
                && (execution.answer_kind != AskAnswerKind::ModelResponse
                    || execution.calls.iter().any(|call| {
                        call.purpose == AskRequestPurpose::Answer
                            && call.state == AskRequestState::ResponseReceived
                    }))
                && execution.selected.as_ref().is_none_or(route)
                && execution.calls.iter().all(|call| {
                    id(&call.id, 200, false)
                        && ids.insert(&call.id)
                        && route(&call.requested)
                        && execution
                            .selected
                            .as_ref()
                            .is_none_or(|selected| *selected == call.requested)
                        && call.identity.as_ref().is_none_or(|identity| {
                            call.state == AskRequestState::ResponseReceived
                                && id(&identity.model_id, 512, false)
                                && (identity.source == AskIdentitySource::LocalManifest)
                                    == (call.requested.provider_id == "builtin-local")
                        })
                })
        }))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskSearchContext {
    pub version: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub guided_question: Option<serde_json::Value>,
    #[serde(
        default,
        deserialize_with = "read_historical_coverage",
        skip_serializing_if = "Option::is_none"
    )]
    pub historical: Option<AskHistoricalCoverage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<AskDateRange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range_ignored: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paths: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub packing: Option<AskPackingCoverage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity_coverage: Option<AskActivityCoverage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity_question: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub period_clarification: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskHistoricalCoverage {
    pub as_of: String,
    pub after_cutoff: u64,
    pub date_unverified: u64,
}

fn read_historical_coverage<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<AskHistoricalCoverage>, D::Error> {
    let value = serde_json::Value::deserialize(d)?;
    Ok(serde_json::from_value::<AskHistoricalCoverage>(value)
        .ok()
        .filter(|h| {
            h.as_of.len() == 10
                && h.as_of.is_ascii()
                && crate::distill::iso_week(&h.as_of).is_some()
                && h.after_cutoff <= 9_007_199_254_740_991
                && h.date_unverified <= 9_007_199_254_740_991
        }))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AskDateRange {
    pub start: String,
    pub end: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskPackingCoverage {
    pub selected_passages: u64,
    pub omitted_passages: u64,
    pub omitted_on_included_pages: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskActivityCoverage {
    pub scanned_pages: u64,
    pub sources: u64,
    pub incomplete: bool,
}

fn valid_guided_question(value: &serde_json::Value) -> bool {
    value.get("version").and_then(|v| v.as_u64()) == Some(1)
        && matches!(
            value.get("intent").and_then(|v| v.as_str()),
            Some("progress" | "decision" | "remaining" | "recall")
        )
        && value
            .get("subject")
            .and_then(|v| v.as_str())
            .is_some_and(|s| !s.trim().is_empty() && s.chars().count() <= 240)
        && value.get("asOf").is_none_or(|v| {
            v.as_str().is_some_and(|s| {
                s.len() == 10 && s.is_ascii() && crate::distill::iso_week(s).is_some()
            })
        })
}

// A new or malformed optional field must not discard an older readable turn.
fn read_search_context<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<AskSearchContext>, D::Error> {
    let value = serde_json::Value::deserialize(d)?;
    Ok(serde_json::from_value::<AskSearchContext>(value)
        .ok()
        .map(|mut context| {
            context.guided_question = context.guided_question.filter(valid_guided_question);
            context
        })
        .filter(|context| {
            const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
            context.version == 1
                && context.range_ignored.is_none_or(|value| value)
                && context.period_clarification.is_none_or(|value| value)
                && context.range.as_ref().is_none_or(|range| {
                    let day = |s: &str| {
                        s.len() == 10
                            && s.is_ascii()
                            && s.bytes().enumerate().all(|(i, b)| {
                                if i == 4 || i == 7 {
                                    b == b'-'
                                } else {
                                    b.is_ascii_digit()
                                }
                            })
                            && crate::distill::iso_week(s).is_some()
                    };
                    day(&range.start) && day(&range.end) && range.start <= range.end
                })
                && context.packing.as_ref().is_none_or(|packing| {
                    packing.selected_passages <= MAX_SAFE_INTEGER
                        && packing.omitted_passages <= MAX_SAFE_INTEGER
                        && packing.omitted_on_included_pages <= packing.omitted_passages
                })
                && context.activity_coverage.as_ref().is_none_or(|coverage| {
                    coverage.scanned_pages <= MAX_SAFE_INTEGER
                        && coverage.sources <= MAX_SAFE_INTEGER
                })
        }))
}

/// UI-only delivered originals. Never evidence of semantic acceptance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CitationEvidence {
    pub version: u8,
    pub sources: Vec<CitationSource>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CitationSource {
    pub path: String,
    pub revision: String,
    pub spans: Vec<CitationSpan>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CitationSpan {
    pub id: String,
    pub start: u64,
    pub end: u64,
    pub text: String,
    pub sha256: String,
    pub speaker: String,
    pub turn_time: Option<String>,
}

// Malformed optional metadata must not erase an otherwise readable answer.
fn read_citation_evidence<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<CitationEvidence>, D::Error> {
    let value = serde_json::Value::deserialize(d)?;
    Ok(serde_json::from_value::<CitationEvidence>(value)
        .ok()
        .filter(valid_citation_evidence))
}
fn valid_citation_evidence(e: &CitationEvidence) -> bool {
    let hash = |s: &str| {
        s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    if e.version != 1 || e.sources.is_empty() || e.sources.len() > 12 {
        return false;
    }
    let mut paths = std::collections::HashSet::new();
    let mut count = 0usize;
    let mut bytes = 0usize;
    for source in &e.sources {
        if !source.path.ends_with(".md")
            || source.path.starts_with('/')
            || source
                .path
                .chars()
                .any(|c| c == '\\' || c == '#' || c == '|' || c.is_control())
            || source
                .path
                .split('/')
                .any(|p| p.is_empty() || p == "." || p == "..")
            || !paths.insert(&source.path)
            || !hash(&source.revision)
            || source.spans.is_empty()
        {
            return false;
        }
        let mut ids = std::collections::HashSet::new();
        for span in &source.spans {
            count += 1;
            bytes = bytes.saturating_add(span.text.len());
            if count > 128
                || bytes > 524288
                || span.id.is_empty()
                || span.id.len() > 200
                || !ids.insert(&span.id)
                || span.start > 9_007_199_254_740_991
                || span.end > 9_007_199_254_740_991
                || span.end.checked_sub(span.start) != Some(span.text.len() as u64)
                || span.text.trim().is_empty()
                || !hash(&span.sha256)
                || span.speaker.len() > 64
                || span.turn_time.as_ref().is_some_and(|s| s.len() > 80)
            {
                return false;
            }
        }
    }
    true
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum AbstainReason {
    #[serde(rename = "model_evidence")]
    ModelEvidence,
}

/// The note a note-scoped turn ran over, by the title the page showed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NoteRef {
    pub title: String,
}

#[allow(clippy::trivially_copy_pass_by_ref)] // serde's skip_serializing_if contract
fn is_false(b: &bool) -> bool {
    !*b
}

/// The log file for `vault_root`. Creates `ask-history/` under the app data
/// dir. `DefaultHasher` because the vault's other app-data files are keyed by
/// it (std documents it may change across releases; were it ever to, the old
/// log stays on disk under its old name rather than being lost).
pub fn path_for(vault_root: &str) -> Result<PathBuf, String> {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    vault_root.hash(&mut h);
    let dir = crate::settings::settings_dir()?.join("ask-history");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir ask-history: {e}"))?;
    Ok(dir.join(format!("{:016x}.jsonl", h.finish())))
}

/// The last [`CAP`] turns, oldest first. A missing file is an empty history;
/// a line that does not parse is skipped. Any other read failure is an error,
/// so the page can say the history could not be read instead of showing none.
pub fn load(path: &Path) -> Result<Vec<AskTurn>, String> {
    let mut turns = parse(&read(path)?);
    let skip = turns.len().saturating_sub(CAP);
    turns.drain(..skip);
    Ok(turns)
}

/// Append `turn`, compacting to the last [`CAP`] once the file would hold
/// more than `CAP + SLACK` lines.
pub fn append(path: &Path, turn: &AskTurn) -> Result<(), String> {
    let line = serde_json::to_string(turn).map_err(|e| format!("serialize ask turn: {e}"))?;
    let existing = read(path)?;
    let lines = existing
        .split(|b| *b == b'\n')
        .filter(|l| !l.is_empty())
        .count();
    if lines + 1 > CAP + SLACK {
        let mut turns = parse(&existing);
        turns.push(turn.clone());
        let keep = &turns[turns.len().saturating_sub(CAP)..];
        let mut out = String::new();
        for t in keep {
            out.push_str(
                &serde_json::to_string(t).map_err(|e| format!("serialize ask turn: {e}"))?,
            );
            out.push('\n');
        }
        let tmp = path.with_extension("jsonl.tmp");
        std::fs::write(&tmp, out).map_err(|e| format!("write ask history: {e}"))?;
        return std::fs::rename(&tmp, path).map_err(|e| format!("replace ask history: {e}"));
    }
    // A torn last line (a crash mid-write) has no newline: start on a fresh
    // line, or this turn would fuse with it and both would be lost.
    let sep = if existing.last().is_some_and(|b| *b != b'\n') {
        "\n"
    } else {
        ""
    };
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("open ask history: {e}"))?;
    writeln!(f, "{sep}{line}").map_err(|e| format!("append ask history: {e}"))
}

fn read(path: &Path) -> Result<Vec<u8>, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(format!("read ask history: {e}")),
    }
}

/// The largest time a JS `Date` holds, in ms: past it `toISOString` throws,
/// and the history list's render with it.
const JS_DATE_MAX_MS: u64 = 8_640_000_000_000_000;

/// Every line that parses as a turn the page can show; lossy UTF-8 so one bad
/// byte costs only its own line. Load and compaction both read through here,
/// so a skipped line is never written back either.
fn parse(bytes: &[u8]) -> Vec<AskTurn> {
    String::from_utf8_lossy(bytes)
        .lines()
        .filter_map(|l| serde_json::from_str::<AskTurn>(l).ok())
        .filter(|t| t.at <= JS_DATE_MAX_MS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log_path(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("myco-askhist-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.join("h.jsonl")
    }

    fn turn(q: &str, at: u64) -> AskTurn {
        AskTurn {
            at,
            q: q.into(),
            scope: Some("wiki".into()),
            a: "> quoted line\n\n**[[attention]]**".into(),
            cited: vec!["attention".into()],
            citation_evidence: None,
            abstained: false,
            abstain_reason: None,
            stopped: false,
            error: None,
            note: None,
            search_context: None,
            execution: None,
        }
    }

    #[test]
    fn model_execution_identity_survives_disk_and_compaction() {
        let p = log_path("model-execution");
        let mut rec = turn("which model?", 5);
        rec.execution = Some(AskExecution {
            version: 1,
            selected: Some(AskRequestedModel {
                provider_id: "ollama".into(),
                model_id: "requested-alias".into(),
            }),
            answer_kind: AskAnswerKind::ModelResponse,
            calls: vec![AskExecutionCall {
                id: "answer-1".into(),
                purpose: AskRequestPurpose::Answer,
                requested: AskRequestedModel {
                    provider_id: "ollama".into(),
                    model_id: "requested-alias".into(),
                },
                state: AskRequestState::ResponseReceived,
                identity: Some(AskModelIdentity {
                    model_id: "reported-model".into(),
                    source: AskIdentitySource::ProviderResponse,
                }),
            }],
        });
        append(&p, &rec).unwrap();
        let line = std::fs::read_to_string(&p).unwrap();
        assert!(line.contains("requested-alias") && line.contains("reported-model"));
        assert_eq!(load(&p).unwrap(), vec![rec.clone()]);
        std::fs::write(&p, line.repeat(CAP + SLACK)).unwrap();
        append(&p, &rec).unwrap();
        let loaded = load(&p).unwrap();
        assert_eq!(loaded.len(), CAP);
        assert!(loaded.iter().all(|row| row.execution == rec.execution));
        std::fs::remove_dir_all(p.parent().unwrap()).unwrap();
    }

    #[test]
    fn invalid_execution_metadata_preserves_answer_and_legacy_stays_unknown() {
        let call = serde_json::json!({"id":"a","purpose":"answer","requested":{"providerId":"ollama","modelId":"chosen"},"state":"response_received"});
        for execution in [
            serde_json::json!(null),
            serde_json::json!("broken"),
            serde_json::json!({"version":2,"answerKind":"none","calls":[]}),
            serde_json::json!({"version":1,"answerKind":"model_response","calls":[]}),
            serde_json::json!({"version":1,"answerKind":"model_response","calls":[{
                "id":"a","purpose":"period_plan","requested":{"providerId":"ollama","modelId":"chosen"},"state":"response_received"}]}),
            serde_json::json!({"version":1,"answerKind":"model_response","calls":[{
                "id":"a","purpose":"answer","requested":{"providerId":"ollama","modelId":"chosen"},"state":"submitted"}]}),
            serde_json::json!({"version":1,"answerKind":"model_response","calls":[{
                "id":"a","purpose":"answer","requested":{"providerId":"ollama","modelId":"chosen"},"state":"failed"}]}),
            serde_json::json!({"version":1,"answerKind":"none","calls":[call.clone(),call.clone()]}),
            serde_json::json!({"version":1,"answerKind":"none","calls":vec![call.clone();33]}),
            serde_json::json!({"version":1,"selected":{"providerId":"ollama","modelId":"another"},"answerKind":"none","calls":[call.clone()]}),
            serde_json::json!({"version":1,"answerKind":"model_response","calls":[{
                "id":"a","purpose":"answer","requested":{"providerId":"ollama","modelId":"chosen"},
                "state":"response_received","identity":{"modelId":"fake","source":"local_manifest"}}]}),
            serde_json::json!({"version":1,"answerKind":"none","calls":[{
                "id":"a","purpose":"answer","requested":{"providerId":"ollama","modelId":"chosen"},
                "state":"cancelled","identity":{"modelId":"fake","source":"provider_response"}}]}),
            serde_json::json!({"version":1,"answerKind":"none","calls":[{
                "id":"a","purpose":"answer","requested":{"providerId":"ollama","modelId":"chosen"},
                "state":"response_received","identity":{"modelId":"한".repeat(171),"source":"provider_response"}}]}),
        ] {
            let parsed: AskTurn = serde_json::from_value(
                serde_json::json!({"at":1,"q":"q","a":"saved","execution":execution}),
            )
            .unwrap();
            assert_eq!(parsed.a, "saved");
            assert!(parsed.execution.is_none());
        }
        let legacy: AskTurn = serde_json::from_str(r#"{"at":1,"q":"q","a":"legacy"}"#).unwrap();
        assert!(legacy.execution.is_none());
        assert!(!serde_json::to_string(&legacy)
            .unwrap()
            .contains("execution"));
    }

    #[test]
    fn execution_does_not_invent_reported_identity_or_generated_answer() {
        for execution in [
            serde_json::json!({"version":1,"selected":{"providerId":"ollama","modelId":"chosen"},"answerKind":"clarification","calls":[]}),
            serde_json::json!({"version":1,"answerKind":"none","calls":[{"id":"a","purpose":"answer","requested":{"providerId":"ollama","modelId":"chosen"},"state":"cancelled"}]}),
            serde_json::json!({"version":1,"answerKind":"none","calls":[{"id":"a","purpose":"answer","requested":{"providerId":"builtin-local","modelId":"local"},"state":"response_received","identity":{"modelId":"local","source":"local_manifest"}}]}),
        ] {
            let parsed: AskTurn = serde_json::from_value(
                serde_json::json!({"at":1,"q":"q","a":"a","execution":execution}),
            )
            .unwrap();
            let saved = serde_json::to_value(&parsed).unwrap();
            assert_eq!(saved["execution"], execution);
            assert_ne!(
                parsed.execution.unwrap().answer_kind,
                AskAnswerKind::ModelResponse
            );
        }
        let parsed:AskTurn=serde_json::from_value(serde_json::json!({"at":1,"q":"q","execution":{
            "version":1,"answerKind":"model_response","calls":[{"id":"a","purpose":"answer","requested":{"providerId":"ollama","modelId":"chosen"},"state":"response_received"}]}})).unwrap();
        assert!(parsed.execution.unwrap().calls[0].identity.is_none());
    }

    #[test]
    fn partial_evidence_and_period_context_survive_disk_compaction() {
        let p = log_path("search-context");
        let mut rec = turn("this week", 4);
        rec.search_context = Some(AskSearchContext {
            version: 1,
            guided_question: Some(
                serde_json::json!({"version":1,"intent":"remaining","subject":"synthetic library","asOf":"2026-10-30"}),
            ),
            historical: Some(AskHistoricalCoverage {
                as_of: "2026-10-30".into(),
                after_cutoff: 1,
                date_unverified: 1,
            }),
            range: Some(AskDateRange {
                start: "2026-10-26".into(),
                end: "2026-10-30".into(),
            }),
            range_ignored: None,
            paths: Some(vec!["sessions/work.md".into()]),
            packing: Some(AskPackingCoverage {
                selected_passages: 2,
                omitted_passages: 3,
                omitted_on_included_pages: 2,
            }),
            activity_coverage: Some(AskActivityCoverage {
                scanned_pages: 50,
                sources: 1,
                incomplete: true,
            }),
            activity_question: Some("What did I work on recently?".into()),
            period_clarification: None,
        });
        append(&p, &rec).unwrap();
        let written = std::fs::read_to_string(&p).unwrap();
        assert!(written.contains("\"searchContext\""));
        assert!(written.contains("\"omittedOnIncludedPages\":2"));
        assert_eq!(load(&p).unwrap(), vec![rec.clone()]);
        std::fs::write(&p, written.repeat(CAP + SLACK)).unwrap();
        append(&p, &rec).unwrap();
        let loaded = load(&p).unwrap();
        assert_eq!(loaded.len(), CAP);
        assert!(loaded
            .iter()
            .all(|row| row.search_context == rec.search_context));
        std::fs::remove_dir_all(p.parent().unwrap()).unwrap();
    }

    #[test]
    fn malformed_guided_choice_preserves_other_history_metadata() {
        let parsed: AskTurn = serde_json::from_value(serde_json::json!({
            "at":1,"q":"q","a":"retained answer","searchContext":{
                "version":1,"guidedQuestion":{"version":1,"intent":"unknown","subject":"x"},
                "packing":{"selectedPassages":2,"omittedPassages":1,"omittedOnIncludedPages":0}
            }
        }))
        .unwrap();
        assert_eq!(parsed.a, "retained answer");
        let context = parsed.search_context.unwrap();
        assert!(context.guided_question.is_none());
        assert_eq!(context.packing.unwrap().selected_passages, 2);
    }

    #[test]
    fn malformed_historical_detail_does_not_erase_other_saved_search_context() {
        let parsed: AskTurn = serde_json::from_value(serde_json::json!({
            "at":1,"q":"q","a":"kept","searchContext":{"version":1,
                "historical":{"asOf":"2026-10-08","afterCutoff":-1,"dateUnverified":0},
                "packing":{"selectedPassages":1,"omittedPassages":2,"omittedOnIncludedPages":1}}
        }))
        .unwrap();
        let context = parsed.search_context.unwrap();
        assert!(context.historical.is_none());
        assert_eq!(context.packing.unwrap().omitted_passages, 2);
        assert_eq!(parsed.a, "kept");
    }

    #[test]
    fn malformed_optional_search_context_preserves_saved_answer() {
        for context in [
            serde_json::json!(null),
            serde_json::json!("broken"),
            serde_json::json!({"version":2}),
            serde_json::json!({"version":1,"range":{"start":"2026-02-30","end":"2026-03-01"}}),
            serde_json::json!({"version":1,"range":{"start":"2026-10-30","end":"2026-10-01"}}),
            serde_json::json!({"version":1,"packing":{"selectedPassages":1,"omittedPassages":0,"omittedOnIncludedPages":1}}),
            serde_json::json!({"version":1,"packing":{"selectedPassages":9007199254740992_u64,"omittedPassages":0,"omittedOnIncludedPages":0}}),
        ] {
            let parsed: AskTurn = serde_json::from_value(serde_json::json!({
                "at":4,"q":"q","a":"saved answer","searchContext":context
            }))
            .unwrap();
            assert_eq!(parsed.a, "saved answer");
            assert!(parsed.search_context.is_none());
        }
        let legacy: AskTurn = serde_json::from_str(r#"{"at":1,"q":"q","a":"legacy"}"#).unwrap();
        assert!(legacy.search_context.is_none());
        assert!(!serde_json::to_string(&legacy)
            .unwrap()
            .contains("searchContext"));
        let clarification: AskTurn = serde_json::from_value(serde_json::json!({
            "at":5,"q":"recent work","a":"Which period?", "searchContext":{
                "version":1,"periodClarification":true,"activityQuestion":"recent work"
            }
        }))
        .unwrap();
        let back: AskTurn =
            serde_json::from_str(&serde_json::to_string(&clarification).unwrap()).unwrap();
        assert_eq!(
            back.search_context.unwrap().period_clarification,
            Some(true)
        );
    }

    #[test]
    fn citation_evidence_survives_disk_and_compaction() {
        let p = log_path("citation-originals");
        let mut rec = turn("which original?", 1);
        rec.citation_evidence = Some(CitationEvidence {
            version: 1,
            sources: vec![CitationSource {
                path: "raw/record.md".into(),
                revision: "a".repeat(64),
                spans: vec![CitationSpan {
                    id: "original-1".into(),
                    start: 20,
                    end: 26,
                    text: "원문".into(),
                    sha256: "b".repeat(64),
                    speaker: "user".into(),
                    turn_time: None,
                }],
            }],
        });
        append(&p, &rec).unwrap();
        assert_eq!(load(&p).unwrap(), vec![rec.clone()]);
        // Force compaction using the same metadata without changing its bytes.
        let line = serde_json::to_string(&rec).unwrap() + "\n";
        std::fs::write(&p, line.repeat(CAP + SLACK)).unwrap();
        append(&p, &rec).unwrap();
        let loaded = load(&p).unwrap();
        assert_eq!(loaded.len(), CAP);
        assert!(loaded
            .iter()
            .all(|row| row.citation_evidence == rec.citation_evidence));
    }

    #[test]
    fn malformed_optional_citation_metadata_preserves_answer() {
        for evidence in [
            serde_json::json!(null),
            serde_json::json!("broken"),
            serde_json::json!({"version":1,"sources":[{"path":"../outside.md"}]}),
        ] {
            let value =
                serde_json::json!({"at":2,"q":"q","a":"saved answer","citationEvidence":evidence});
            let parsed: AskTurn = serde_json::from_value(value).unwrap();
            assert_eq!(parsed.a, "saved answer");
            assert!(parsed.citation_evidence.is_none());
        }
        let legacy: AskTurn = serde_json::from_str(r#"{"at":1,"q":"q","a":"legacy"}"#).unwrap();
        assert!(legacy.citation_evidence.is_none());
    }

    #[test]
    fn model_evidence_reason_survives_disk_roundtrip() {
        let p = log_path("model-evidence");
        let mut rec = turn("grounded question", 3);
        rec.a.clear();
        rec.cited.clear();
        rec.abstained = true;
        rec.abstain_reason = Some(AbstainReason::ModelEvidence);
        append(&p, &rec).unwrap();
        assert_eq!(load(&p).unwrap(), vec![rec]);
        let legacy: AskTurn =
            serde_json::from_str(r#"{"at":1,"q":"legacy","abstained":true}"#).unwrap();
        assert!(legacy.abstain_reason.is_none());
    }

    #[test]
    fn a_note_scoped_turn_keeps_its_note() {
        // "Ask this note" (UX S37): the turn ran over one note, not a scope.
        let p = log_path("note");
        let mut scoped = turn("what is attention", 1);
        scoped.scope = None;
        scoped.note = Some(NoteRef {
            title: "Attention".into(),
        });
        append(&p, &scoped).unwrap();
        let line = std::fs::read_to_string(&p).unwrap();
        assert!(line.contains(r#""note":{"title":"Attention"}"#));
        assert_eq!(load(&p).unwrap(), vec![scoped]);
        // A line written before the field reads it as unset.
        let back: AskTurn = serde_json::from_str(r#"{"at":1,"q":"q"}"#).unwrap();
        assert!(back.note.is_none());
    }

    #[test]
    fn appended_turns_load_back_in_order() {
        let p = log_path("roundtrip");
        let mut abstained = turn("off-vault", 2);
        abstained.a.clear();
        abstained.cited.clear();
        abstained.abstained = true;
        append(&p, &turn("what is attention", 1)).unwrap();
        append(&p, &abstained).unwrap();
        assert_eq!(
            load(&p).unwrap(),
            vec![turn("what is attention", 1), abstained]
        );
    }

    #[test]
    fn a_missing_log_is_an_empty_history() {
        assert!(load(&log_path("missing")).unwrap().is_empty());
    }

    #[test]
    fn a_corrupt_line_is_skipped_not_fatal() {
        let p = log_path("corrupt");
        append(&p, &turn("first", 1)).unwrap();
        // A line of the wrong shape, a time no JS Date can hold (it threw in
        // the page's render), then a torn write with no newline: the next
        // append must not fuse with it.
        let mut f = std::fs::OpenOptions::new().append(true).open(&p).unwrap();
        writeln!(f, "[1,2,3]").unwrap();
        writeln!(f, "{{\"at\":18446744073709551615,\"q\":\"x\"}}").unwrap();
        write!(f, "{{\"at\":2,\"q\":\"tor").unwrap();
        drop(f);
        append(&p, &turn("third", 3)).unwrap();
        let qs: Vec<String> = load(&p).unwrap().into_iter().map(|t| t.q).collect();
        assert_eq!(qs, ["first", "third"]);
    }

    #[test]
    fn the_log_keeps_the_last_cap_turns() {
        let p = log_path("cap");
        for i in 0..(CAP + SLACK + 1) as u64 {
            append(&p, &turn(&format!("q{i}"), i)).unwrap();
        }
        let all = load(&p).unwrap();
        assert_eq!(all.len(), CAP);
        assert_eq!(all[0].q, format!("q{}", SLACK + 1));
        assert_eq!(all.last().unwrap().q, format!("q{}", CAP + SLACK));
        // Compacted on disk too, not just trimmed on read.
        let lines = std::fs::read_to_string(&p).unwrap().lines().count();
        assert_eq!(lines, CAP);
    }

    #[test]
    fn each_vault_gets_its_own_log_in_app_data_never_in_the_vault() {
        // path_for resolves (and creates) the app-data dir: isolated, or it
        // would write under the developer's real Application Support.
        crate::settings::test_support::with_isolated_data("ask-history-path", |data| {
            let a = path_for("/vaults/a").unwrap();
            assert!(a.starts_with(data.join("ask-history")));
            assert!(!a.starts_with("/vaults/a"));
            assert_eq!(a, path_for("/vaults/a").unwrap());
            assert_ne!(a, path_for("/vaults/b").unwrap());
        });
    }

    #[test]
    fn flags_left_unset_stay_off_the_line() {
        let line = serde_json::to_string(&turn("q", 1)).unwrap();
        assert!(
            !line.contains("abstained") && !line.contains("stopped") && !line.contains("error")
        );
        // And a line written without them reads them as unset.
        let back: AskTurn = serde_json::from_str(r#"{"at":1,"q":"q"}"#).unwrap();
        assert!(!back.abstained && back.scope.is_none() && back.cited.is_empty());
    }
}
