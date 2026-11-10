//! Isolated saved-model bridge. No generation, review approval, or publication.
use super::{checked_evidence_selection, ordinary_flow, Request};
use crate::local_synthesis::Prompt;
use crate::retrieval::Bm25Index;
use crate::wiki_claim_review::AskReviewContext;
use serde_json::{json, Value};
use std::path::Path;

// An immutable lexical snapshot is reused only while packing one authorized
// question. The command forces a fresh read at final input and answer rendering.
fn index_key(request: &Request) -> String {
    json!({"requestId":request.request_id,"expectedVault":request.expected_vault,"origin":request.origin,"role":request.role_snapshot,
        "question":request.question,"previousQuestion":request.previous_question,"lang":request.lang,
        "scope":request.scope,"range":request.range.as_ref().map(|r| (&r.start, &r.end, r.start_epoch, r.end_epoch)),"paths":request.paths}).to_string()
}
#[derive(Default)]
struct IndexMemo {
    entry: Option<(String, std::sync::Arc<Bm25Index>)>,
}
impl IndexMemo {
    fn get(&self, key: &str) -> Option<std::sync::Arc<Bm25Index>> {
        self.entry
            .as_ref()
            .filter(|(saved, _)| saved == key)
            .map(|(_, index)| index.clone())
    }
    fn clear(&mut self, key: &str) {
        if self.entry.as_ref().is_some_and(|(saved, _)| saved == key) {
            self.entry = None;
        }
    }
}
fn index_memo() -> &'static std::sync::Mutex<IndexMemo> {
    static MEMO: std::sync::OnceLock<std::sync::Mutex<IndexMemo>> = std::sync::OnceLock::new();
    MEMO.get_or_init(std::sync::Mutex::default)
}
pub(crate) fn packed_index(request: &Request) -> Option<std::sync::Arc<Bm25Index>> {
    index_memo().lock().ok()?.get(&index_key(request))
}
pub(crate) fn remember_index(request: &Request, index: std::sync::Arc<Bm25Index>) {
    if let Ok(mut memo) = index_memo().lock() {
        memo.entry = Some((index_key(request), index));
    }
}
pub(crate) fn forget_index(request: &Request) {
    if let Ok(mut memo) = index_memo().lock() {
        memo.clear(&index_key(request));
    }
}

fn prepare(root: &Path, index: &Bm25Index, request: &Request) -> Result<Prompt, String> {
    prepare_bound(root, index, request).map(|(prompt, _, _)| prompt)
}

fn prepare_bound(
    root: &Path,
    index: &Bm25Index,
    request: &Request,
) -> Result<(Prompt, crate::wiki_claims::SourceSet, AskReviewContext), String> {
    if request.activity_overview || request.resolution.is_some() {
        return Err("diagnostic bridge only accepts ordinary source reading".into());
    }
    let checked = checked_evidence_selection(root, index, request, true)?;
    if checked.original_inputs_incomplete {
        return Err("diagnostic original inputs incomplete".into());
    }
    let origin = request
        .origin
        .as_ref()
        .ok_or("diagnostic opening missing")?;
    let role = request
        .role_snapshot
        .as_ref()
        .ok_or("diagnostic role missing")?;
    let context = AskReviewContext::for_question(
        origin,
        role,
        &request.request_id,
        &request.question,
        request.previous_question.as_deref(),
        &request.lang,
        request.scope,
        request.range.as_ref(),
        request.paths.as_deref(),
    )
    .map_err(|error| error.to_string())?;
    let originals = checked
        .originals
        .ok_or("diagnostic original packet missing")?;
    let prompt = ordinary_flow::original_prompt(request, &checked.evidence, &originals, &context)
        .map_err(|error| error.detail)?;
    Ok((prompt, originals, context))
}

/// Export only after the same fresh source/revision binding as answer rendering.
/// Keep the native review's complete packet; do not apply the draft projection.
pub(crate) fn review_input(
    root: &Path,
    index: &Bm25Index,
    request: &Request,
    raw: &str,
    expected_revision: Option<&str>,
) -> Result<Value, String> {
    let (prompt, originals, context) = prepare_bound(root, index, request)?;
    let projected = model_view(&prompt.user)?;
    let revision = packet_revision(&prompt.system, &projected, &prompt.user)?;
    if expected_revision != Some(revision.as_str()) {
        return Err("diagnostic source or input changed during generation".into());
    }
    if is_declared_abstention(raw) {
        return Err("diagnostic review requires a nonempty answer draft".into());
    }
    let draft =
        crate::local_synthesis::answer_draft::validate_answer_draft(raw, &prompt, &request.lang)?;
    crate::local_synthesis::answer_review::diagnostic_input(&context, &originals, &prompt, &draft)
        .map_err(|error| error.to_string())
}

fn packet_revision(system: &str, user: &str, original: &str) -> Result<String, String> {
    serde_json::to_string(&json!({"system":system,"user":user,"originalPacket":original}))
        .map(|wire| crate::importers::wikify::source_revision(&wire))
        .map_err(|error| error.to_string())
}

/// Model-facing evidence retains original prose and attribution. Byte coordinates,
/// content hashes and revision IDs remain in the private packet used for rechecking.
/// This is a measured input projection, not a claim of identical training inputs.
fn model_view(original: &str) -> Result<String, String> {
    let mut value: Value = serde_json::from_str(original).map_err(|error| error.to_string())?;
    let sources = value
        .get_mut("sources")
        .and_then(Value::as_array_mut)
        .ok_or("diagnostic source list missing")?;
    let mut ordinal = 0;
    for source in sources {
        let spans = source
            .get_mut("originalSpans")
            .and_then(Value::as_array_mut)
            .ok_or("diagnostic original spans missing")?;
        for span in spans {
            let object = span
                .as_object_mut()
                .ok_or("diagnostic span is not an object")?;
            if !object.get("text").is_some_and(Value::is_string)
                || !object.get("speaker").is_some_and(Value::is_string)
            {
                return Err("diagnostic original text or speaker missing".into());
            }
            for key in [
                "sourceId",
                "sourcePath",
                "selectionPath",
                "sourceRevision",
                "start",
                "end",
                "sha256",
            ] {
                object.remove(key);
            }
            ordinal += 1;
            object.insert("id".into(), json!(format!("Q{ordinal}")));
        }
    }
    value
        .as_object_mut()
        .ok_or("diagnostic packet missing")?
        .remove("contextRevision");
    serde_json::to_string(&value).map_err(|error| error.to_string())
}

// This is an explicit policy outcome, never a successfully supported answer.
// Typed deserialization rejects duplicate/unknown fields and wrong value types.
fn is_declared_abstention(raw: &str) -> bool {
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Unanswered {
        answer: String,
        sources: Vec<String>,
    }
    raw.len() <= 8192
        && serde_json::from_str::<Unanswered>(raw)
            .is_ok_and(|value| value.answer.is_empty() && value.sources.is_empty())
}

/// The command authenticates the current opening/role before entering this helper.
/// Rendering rebinds current original bytes and compares the exact prompt revision.
pub(crate) fn exchange(
    root: &Path,
    index: &Bm25Index,
    request: &Request,
    raw_answer: Option<&str>,
    expected_revision: Option<&str>,
) -> Result<Value, String> {
    let mut prompt = prepare(root, index, request)?;
    let original_packet = prompt.user.clone();
    prompt.user = model_view(&original_packet)?;
    let revision = packet_revision(&prompt.system, &prompt.user, &original_packet)?;
    if let Some(raw) = raw_answer {
        if expected_revision != Some(revision.as_str()) {
            return Err("diagnostic source or input changed during generation".into());
        }
        if is_declared_abstention(raw) {
            return Ok(
                json!({"answer":"","paths":[],"abstained":true,"revision":revision,
                "semanticAccepted":false,"productionAccepted":false}),
            );
        }
        let (answer, paths) = crate::local_synthesis::validate_answer(raw, &prompt, &request.lang)?;
        return Ok(json!({"answer":answer,"paths":paths,"revision":revision,
            "semanticAccepted":false,"productionAccepted":false}));
    }
    Ok(
        json!({"system":prompt.system,"user":prompt.user,"revision":revision,
        "evidence":prompt.evidence,"originalPacket":original_packet,
        "modelProjection":"original-text-attribution-v1","boundedOriginalSelection":true,
        "semanticAccepted":false,"productionAccepted":false}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn abstention_requires_exact_policy_shape_not_malformed_or_uncited_prose() {
        assert!(is_declared_abstention(r#"{"answer":"","sources":[]}"#));
        for raw in [
            r#"{"answer":" ","sources":[]}"#,
            r#"{"answer":"","sources":["S1"]}"#,
            r#"{"answer":"Unsupported","sources":[]}"#,
            r#"{"answer":"","sources":[],"extra":true}"#,
            r#"{"answer":"","answer":"","sources":[]}"#,
            r#"{"answer":null,"sources":[]}"#,
            "",
        ] {
            assert!(!is_declared_abstention(raw), "{raw}");
        }
    }
    #[test]
    fn lexical_memo_is_one_question_only_and_can_be_forcibly_invalidated() {
        let mut memo = IndexMemo::default();
        let index = std::sync::Arc::new(Bm25Index::new());
        memo.entry = Some(("opening-role-question-A".into(), index.clone()));
        assert!(std::sync::Arc::ptr_eq(
            &memo.get("opening-role-question-A").unwrap(),
            &index
        ));
        assert!(memo.get("opening-role-question-B").is_none());
        memo.clear("opening-role-question-B");
        assert!(memo.get("opening-role-question-A").is_some());
        memo.clear("opening-role-question-A");
        assert!(memo.get("opening-role-question-A").is_none());
    }

    #[test]
    fn lexical_memo_key_separates_request_vault_scope_and_question_context() {
        let base = json!({"requestId":"synthetic-a", "question":"Status?", "lang":"en",
            "hits":[], "expectedVault":"/synthetic/a", "scope":"all"});
        let key = index_key(&serde_json::from_value::<Request>(base.clone()).unwrap());
        for (field, value) in [
            ("requestId", json!("synthetic-b")),
            ("expectedVault", json!("/synthetic/b")),
            ("question", json!("Why?")),
            ("previousQuestion", json!("Earlier topic")),
            ("range", json!({"start":"2026-10-01","end":"2026-10-02"})),
            ("scope", json!("wiki")),
            ("paths", json!(["wiki/project.md"])),
            (
                "origin",
                json!({"vaultPath":"/synthetic/a", "openingToken":"new-opening"}),
            ),
        ] {
            let mut changed = base.clone();
            changed[field] = value;
            let request: Request = serde_json::from_value(changed).unwrap();
            assert_ne!(key, index_key(&request), "cache must separate {field}");
        }
    }

    #[test]
    fn projection_preserves_meaning_fields_and_source_ids_without_model_provenance_overhead() {
        let span = json!({"id":"Q-long-native-hash", "text":"Requested, then withdrawn. Not completed.",
            "speaker":"assistant", "turnId":"actual-turn", "turnTime":"2026-10-08T10:00:00Z",
            "recordTime":"2026-10-09", "sourcePhase":"final_answer", "sourceRevision":"hash",
            "sourcePath":"raw/a.md", "selectionPath":"raw/a.md", "sourceId":"native-source",
            "start":30,"end":75,"sha256":"span-hash"});
        let original = json!({"question":"Status?", "contextRevision":"private-context-hash",
            "allowed_source_ids":["S1"],"sources":[{"id":"S1","path":"raw/a.md","originalSpans":[span.clone()]}]});
        let projected: Value =
            serde_json::from_str(&model_view(&original.to_string()).unwrap()).unwrap();
        let model = &projected["sources"][0]["originalSpans"][0];
        for key in [
            "text",
            "speaker",
            "turnId",
            "turnTime",
            "recordTime",
            "sourcePhase",
        ] {
            assert_eq!(model[key], span[key]);
        }
        assert_eq!(model["id"], "Q1");
        assert!(model.get("sha256").is_none());
        assert!(projected.get("contextRevision").is_none());
        assert_eq!(
            projected["allowed_source_ids"],
            original["allowed_source_ids"]
        );
        assert_eq!(projected["sources"][0]["path"], "raw/a.md");
        assert_eq!(
            original["sources"][0]["originalSpans"][0]["sha256"],
            "span-hash"
        );
    }
}
