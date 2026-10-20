//! Closed runtime binding, exact turn metadata and UTC record-period conversion.

use super::*;
use crate::commands::DateRange;
use crate::wiki_claims::{ActorRole, SourceDocument, SpanInput};
use serde::Deserialize;
use std::collections::HashSet;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Runtime {
    version: String,
    status: String,
    lang: String,
    wire_format: String,
    families: Vec<Family>,
    review_schedule: Vec<Schedule>,
    authority: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Family {
    family_id: String,
    question: String,
    lang: String,
    record_period_context: Value,
    documents: Vec<Document>,
    original_spans: Value,
    fixed_drafts: Vec<FixedDraft>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    fixture_id: String,
    source_id: String,
    citation_id: String,
    path: String,
    title: String,
    created: String,
    last_updated: String,
    record_time: String,
    utf8_bytes: usize,
    sha256: String,
    raw: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FixedDraft {
    proposal_id: String,
    raw_draft: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Schedule {
    ordinal: usize,
    family_id: String,
    proposal_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Turn {
    message_id: String,
    original_role: ActorRole,
    timestamp: String,
    phase: Option<String>,
}

fn header(raw: &str, name: &str) -> Result<String, String> {
    let prefix = format!("{name}: ");
    let boundary = raw
        .find("\n---\n")
        .ok_or("fixed review frontmatter absent")?;
    let values: Vec<_> = raw[..boundary]
        .lines()
        .filter_map(|line| line.strip_prefix(&prefix))
        .collect();
    if values.len() != 1 {
        return Err(format!("fixed review header membership changed: {name}"));
    }
    serde_json::from_str(values[0]).map_err(|error| error.to_string())
}
fn bind(document: &Document) -> Result<(SourceDocument, Evidence), String> {
    let raw = &document.raw;
    if raw.len() != document.utf8_bytes
        || source_revision(raw) != document.sha256
        || !raw.starts_with("---\n")
        || header(raw, "title")? != document.title
        || header(raw, "created")? != document.created
        || header(raw, "last_updated")? != document.last_updated
        || document.created != document.record_time
        || document.source_id != format!("S-development-{}", document.fixture_id)
    {
        return Err("fixed review complete source/header binding changed".into());
    }
    let body = raw
        .find("\n---\n")
        .ok_or("fixed review frontmatter boundary absent")?
        + "\n---\n".len();
    let entries: Vec<_> = raw[..body]
        .lines()
        .filter_map(|line| line.strip_prefix("turn_metadata: "))
        .collect();
    if entries.len() != 1 {
        return Err("fixed review turn metadata membership changed".into());
    }
    let turns: Vec<Turn> = serde_json::from_str(entries[0]).map_err(|error| error.to_string())?;
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
    if turns.is_empty()
        || turns.len() != boundaries.len()
        || boundaries.first().map(|r| r.0) != Some(body)
    {
        return Err("fixed review complete turn membership changed".into());
    }
    let mut inputs = Vec::new();
    for (index, (turn, &(_, start, speaker))) in turns.into_iter().zip(&boundaries).enumerate() {
        if turn.original_role != speaker
            || turn.phase.is_some()
            || turn.message_id
                != format!("{}{}", document.fixture_id, char::from(b'A' + index as u8))
        {
            return Err("fixed review speaker/turn/null phase changed".into());
        }
        inputs.push(SpanInput {
            id: format!("Q-development-{}", turn.message_id),
            start,
            end: boundaries.get(index + 1).map_or(raw.len(), |next| next.0),
            turn_id: turn.message_id,
            speaker,
            turn_time: Some(turn.timestamp),
        });
    }
    let source = SourceDocument::bind(
        document.source_id.clone(),
        document.path.clone(),
        document.path.clone(),
        raw,
        Some(document.created.clone()),
        inputs,
    )?;
    let evidence = Evidence {
        page: document.path.clone(),
        stem: document.title.clone(),
        section: 0,
        text: raw.clone(),
        title: Some(document.title.clone()),
        compiled: None,
    };
    Ok((source, evidence))
}
fn utc_midnight(day: &str) -> Result<i64, String> {
    if day.len() != 10 {
        return Err("fixed review UTC date shape changed".into());
    }
    let epoch = crate::importers::parse_iso8601(&format!("{day}T00:00:00Z"))
        .ok_or("invalid fixed review UTC date")?;
    let (year, month, date, hour, minute, second) = crate::distill::civil_datetime(epoch);
    if format!("{year:04}-{month:02}-{date:02}") != day || (hour, minute, second) != (0, 0, 0) {
        return Err("fixed review UTC date roundtrip changed".into());
    }
    Ok(epoch)
}
fn range(declared: &Value) -> Result<DateRange, String> {
    let start = declared["periodStart"]
        .as_str()
        .ok_or("fixed review period start absent")?;
    let end = declared["periodEndExclusive"]
        .as_str()
        .ok_or("fixed review period end absent")?;
    let start_epoch = utc_midnight(start)?;
    let end_epoch = utc_midnight(end)?;
    if start_epoch >= end_epoch {
        return Err("fixed review half-open period is empty".into());
    }
    let (year, month, day, ..) = crate::distill::civil_datetime(end_epoch - 86_400);
    Ok(DateRange {
        start: start.into(),
        end: format!("{year:04}-{month:02}-{day:02}"),
        start_epoch: Some(start_epoch),
        end_epoch: Some(end_epoch),
    })
}
fn request(
    family: &Family,
    evidence: &[Evidence],
    origin: &AgentVaultSession,
) -> Result<Request, String> {
    let period = range(&family.record_period_context)?;
    serde_json::from_value(json!({"modelId":GEMMA12B_CANDIDATE.id,"requestId":format!("qa-fixed-review-{}",family.family_id),
        "question":family.question,"previousQuestion":null,"lang":family.lang,"hits":evidence,
        "expectedVault":origin.vault_path,"origin":origin,"scope":"all",
        "range":{ "start":period.start,"end":period.end,
            "startEpoch":period.start_epoch,"endEpoch":period.end_epoch },
        "paths":evidence.iter().map(|e|&e.page).collect::<Vec<_>>(),"maxTokens":768,"activityOverview":false,"resolution":null,
        "roleSnapshot":{"snapshotId":format!("synthetic-fixed-review-{}",family.family_id),"origin":origin,
            "role":"ask","usage":"foreground","authorizationRevision":"synthetic-no-authority",
            "routeSignature":{"role":"ask","providerId":"builtin-local","modelId":GEMMA12B_CANDIDATE.id,
                "effort":"none","executionLocation":"in-process","artifactRevision":GEMMA12B_CANDIDATE.revision,
                "artifactSha256":GEMMA12B_CANDIDATE.sha256,"runtimeContract":"synthetic-fixed-answer-review-qa",
                "signature":"not-a-native-issued-grant"}}})).map_err(|error|error.to_string())
}

pub(super) fn prepare(value: Value) -> Result<Vec<PreparedReviewCase>, String> {
    let runtime: Runtime = serde_json::from_value(value).map_err(|error| error.to_string())?;
    if runtime.version != "FreshWholeAnswerReviewerInputsDraftV2"
        || runtime.status != "SOURCE_DRAFT_NOT_NATIVE_VALIDATED_NOT_EXECUTED"
        || runtime.lang != "ko"
        || runtime.wire_format != "Flat"
        || runtime.families.len() != 8
        || runtime.review_schedule.len() != 16
        || runtime.authority
            != json!({"native_io_authenticated":false,"product_role_authorized":false,
            "semantic_accepted":false,"production_accepted":false,"activityContractAccepted":false,"activityReceiptIssued":false})
    {
        return Err("fixed review runtime contract changed".into());
    }
    let origin = AgentVaultSession {
        vault_path: "/synthetic/fresh-answer-review-qualification".into(),
        opening_token: "synthetic-fixed-review-not-a-live-opening".into(),
    };
    let mut result = Vec::new();
    let mut paths = HashSet::new();
    let mut original_count = 0;
    for (family_index, family) in runtime.families.iter().enumerate() {
        if family.family_id != format!("F{:02}", family_index + 1)
            || family.lang != "ko"
            || family.documents.len() != 2
            || family.fixed_drafts.len() != 2
        {
            return Err("fixed review family membership changed".into());
        }
        let mut documents = Vec::new();
        let mut evidence = Vec::new();
        for (index, document) in family.documents.iter().enumerate() {
            if document.fixture_id != format!("{}D{}", family.family_id, index + 1)
                || document.citation_id != format!("S{}", index + 1)
                || !paths.insert(document.path.clone())
            {
                return Err("fixed review source identity/order changed".into());
            }
            let (source, hit) = bind(document)?;
            documents.push(source);
            evidence.push(hit);
        }
        let sources = SourceSet::new(origin.clone(), Scope::All, documents, vec![])?;
        if json!(sources.spans().collect::<Vec<_>>()) != family.original_spans {
            return Err("fixed review fourteen-field original order changed".into());
        }
        original_count += sources.spans().count();
        for (proposal_index, proposal) in family.fixed_drafts.iter().enumerate() {
            if proposal.proposal_id != format!("P{:02}", proposal_index + 1) {
                return Err("fixed review proposal order changed".into());
            }
            let request = request(family, &evidence, &origin)?;
            let role = request
                .role_snapshot
                .as_ref()
                .ok_or("fixed review synthetic role absent")?;
            let context = AskReviewContext::for_question(
                &origin,
                role,
                &request.request_id,
                &request.question,
                None,
                &request.lang,
                Scope::All,
                request.range.as_ref(),
                request.paths.as_deref(),
            )
            .map_err(|error| error.to_string())?
            .with_answer_review_qualification_qa(&family.family_id, &family.record_period_context)
            .map_err(|error| error.to_string())?;
            context
                .check_packet(&sources)
                .map_err(|error| error.to_string())?;
            let prompt = ordinary_flow::original_prompt(&request, &evidence, &sources, &context)
                .map_err(|error| error.detail)?;
            let draft =
                answer_draft::validate_answer_draft(&proposal.raw_draft, &prompt, &request.lang)?;
            let case = PreparedReviewCase {
                id: format!("{}-{}", family.family_id, proposal.proposal_id),
                family_id: family.family_id.clone(),
                proposal_id: proposal.proposal_id.clone(),
                request,
                origin: origin.clone(),
                sources: sources.clone(),
                evidence: evidence.clone(),
                declared: family.record_period_context.clone(),
                original_spans: family.original_spans.clone(),
                raw_draft: proposal.raw_draft.clone(),
                fixed_draft_sha: source_revision(&proposal.raw_draft),
                source_packet_revision: wiki_claim_review::revision(&sources)
                    .map_err(|error| error.to_string())?,
                context,
                prompt_revision: draft.prompt_revision().into(),
            };
            case.checked_inputs().map_err(|error| error.detail)?;
            result.push(case);
        }
    }
    if original_count != 26 {
        return Err("fixed review original denominator changed".into());
    }
    for (index, (entry, case)) in runtime.review_schedule.iter().zip(&result).enumerate() {
        if entry.ordinal != index + 1
            || entry.family_id != case.family_id
            || entry.proposal_id != case.proposal_id
        {
            return Err("fixed review scheduled sixteen cases changed".into());
        }
    }
    Ok(result)
}

pub(super) fn inventory(raw: &str) -> Result<Value, String> {
    if source_revision(raw) != RUNTIME_SHA256 {
        return Err("compiled fixed-review inventory SHA changed".into());
    }
    let runtime: Runtime = serde_json::from_str(raw).map_err(|error| error.to_string())?;
    Ok(json!(runtime.families.iter().flat_map(|family|family.documents.iter().map(|d|json!({
        "familyId":family.family_id,"fixtureId":d.fixture_id,"sourceId":d.source_id,"citationId":d.citation_id,
        "path":d.path,"bytes":d.utf8_bytes,"sha256":d.sha256,"recordTime":d.record_time
    }))).collect::<Vec<_>>()))
}
