//! Lossless extraction presentation; no source, actor or semantic authority is issued.

use serde::Serialize;
use serde_json::Value;

pub(crate) const INSTRUCTIONS: &str = "Actual extraction originals use SourceReadingViewV1: id, speaker and complete text are followed by sourceContext and provenance. sourceContext contains turnId, turnTime, sourcePhase and recordTime; they are source context, not assertions of event time or performed work. provenance contains the unchanged capture identity, coordinates and hash; it supplies no semantic approval. Interpret described actors, activity time, negation and scope from the entire original under the unchanged rules above. Fictional examples are schema demonstrations, not current evidence.";

const ORIGINAL_FIELDS: [&str; 14] = [
    "id",
    "speaker",
    "text",
    "turnId",
    "turnTime",
    "sourcePhase",
    "recordTime",
    "sourceId",
    "sourcePath",
    "selectionPath",
    "sourceRevision",
    "start",
    "end",
    "sha256",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OriginalInputView<'a> {
    id: &'a Value,
    speaker: &'a Value,
    text: &'a Value,
    source_context: SourceContext<'a>,
    provenance: Provenance<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceContext<'a> {
    turn_id: &'a Value,
    turn_time: &'a Value,
    source_phase: &'a Value,
    record_time: &'a Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Provenance<'a> {
    source_id: &'a Value,
    source_path: &'a Value,
    selection_path: &'a Value,
    source_revision: &'a Value,
    start: &'a Value,
    end: &'a Value,
    sha256: &'a Value,
}

/// Borrow all fourteen values from an existing flat capture without normalizing them.
pub(crate) fn original_input(original: &Value) -> Result<OriginalInputView<'_>, String> {
    let original = original
        .as_object()
        .filter(|original| {
            original.len() == ORIGINAL_FIELDS.len()
                && ORIGINAL_FIELDS
                    .iter()
                    .all(|key| original.contains_key(*key))
        })
        .ok_or("source reading complete original metadata fields changed")?;
    Ok(OriginalInputView {
        id: &original["id"],
        speaker: &original["speaker"],
        text: &original["text"],
        source_context: SourceContext {
            turn_id: &original["turnId"],
            turn_time: &original["turnTime"],
            source_phase: &original["sourcePhase"],
            record_time: &original["recordTime"],
        },
        provenance: Provenance {
            source_id: &original["sourceId"],
            source_path: &original["sourcePath"],
            selection_path: &original["selectionPath"],
            source_revision: &original["sourceRevision"],
            start: &original["start"],
            end: &original["end"],
            sha256: &original["sha256"],
        },
    })
}

#[cfg(test)]
#[path = "source_input_view_tests.rs"]
mod tests;
