//! QA-only lossless original presentation. No source or meaning authority is issued.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

const VERSION: &str = "SourceDocumentGroupsQaV1";

/// Closed diagnostic presentation choice; this does not grant a product role.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum QaWireFormat {
    Flat,
    SourceDocumentGroupsQaV1,
}

/// Fixed inheritance description; its actual token cost is part of each serving input.
pub const GROUP_INSTRUCTION: &str = " SourceDocumentGroupsQaV1 preserves original order. Each document's sourceId, sourcePath, selectionPath, sourceRevision and recordTime apply to its originalSpans turns; all other fields remain on each turn. Evidence and review rules are unchanged.";

impl QaWireFormat {
    /// Stable diagnostic log label, separate from source and execution authority.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Flat => "Flat",
            Self::SourceDocumentGroupsQaV1 => VERSION,
        }
    }

    /// Project the complete draft before prompt hashing, token admission or generation.
    pub fn apply_draft(self, system: &mut String, user: &mut String) -> Result<(), String> {
        self.apply(system, user, true)
    }

    /// Project all reviewer originals, including those not cited by the draft.
    pub fn apply_review(self, system: &mut String, user: &mut String) -> Result<(), String> {
        self.apply(system, user, false)
    }

    fn apply(self, system: &mut String, user: &mut String, is_draft: bool) -> Result<(), String> {
        if self == Self::Flat {
            return Ok(());
        }
        let flat: Value = serde_json::from_str(user).map_err(|error| error.to_string())?;
        let mut projected = flat.clone();
        for originals in original_arrays(&mut projected, is_draft)? {
            *originals = encode(originals)?;
        }
        let mut restored = projected.clone();
        for originals in original_arrays(&mut restored, is_draft)? {
            *originals = decode(&originals.to_string())?;
        }
        if restored != flat {
            return Err(
                "grouped presentation changed original or non-original payload values".into(),
            );
        }
        let serialized = serde_json::to_string(&projected).map_err(|error| error.to_string())?;
        // Commit both strings only after the exact inverse succeeds.
        system.push_str(GROUP_INSTRUCTION);
        *user = serialized;
        Ok(())
    }
}

fn original_arrays(payload: &mut Value, is_draft: bool) -> Result<Vec<&mut Value>, String> {
    if is_draft {
        let sources = payload
            .get_mut("sources")
            .and_then(Value::as_array_mut)
            .filter(|sources| !sources.is_empty())
            .ok_or("complete draft sources absent")?;
        sources
            .iter_mut()
            .map(|source| {
                source
                    .get_mut("originalSpans")
                    .ok_or_else(|| "draft originals absent".into())
            })
            .collect()
    } else {
        Ok(vec![payload
            .get_mut("originalSpans")
            .ok_or("review originals absent")?])
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Shared {
    source_id: String,
    source_path: String,
    selection_path: String,
    source_revision: String,
    record_time: Value,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Turn {
    id: String,
    speaker: String,
    text: String,
    turn_id: String,
    turn_time: Value,
    source_phase: Value,
    start: u64,
    end: u64,
    sha256: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    source_id: String,
    source_path: String,
    selection_path: String,
    source_revision: String,
    record_time: Value,
    original_spans: Vec<Turn>,
}

impl Document {
    fn shared(&self) -> Shared {
        Shared {
            source_id: self.source_id.clone(),
            source_path: self.source_path.clone(),
            selection_path: self.selection_path.clone(),
            source_revision: self.source_revision.clone(),
            record_time: self.record_time.clone(),
        }
    }
    fn new(shared: Shared) -> Self {
        Self {
            source_id: shared.source_id,
            source_path: shared.source_path,
            selection_path: shared.selection_path,
            source_revision: shared.source_revision,
            record_time: shared.record_time,
            original_spans: Vec::new(),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Packet {
    version: String,
    documents: Vec<Document>,
}

fn nullable_text(value: &Value) -> bool {
    value.is_null() || value.is_string()
}

fn split(original: &Value) -> Result<(Shared, Turn), String> {
    let object = original
        .as_object()
        .ok_or("original must be a closed object")?;
    const SHARED: [&str; 5] = [
        "sourceId",
        "sourcePath",
        "selectionPath",
        "sourceRevision",
        "recordTime",
    ];
    const TURN: [&str; 9] = [
        "id",
        "speaker",
        "text",
        "turnId",
        "turnTime",
        "sourcePhase",
        "start",
        "end",
        "sha256",
    ];
    if object.len() != 14
        || SHARED
            .iter()
            .chain(TURN.iter())
            .any(|key| !object.contains_key(*key))
    {
        return Err("original fourteen-field membership changed".into());
    }
    let select = |keys: &[&str]| -> Value {
        Value::Object(
            keys.iter()
                .map(|key| ((*key).to_owned(), object[*key].clone()))
                .collect(),
        )
    };
    let shared: Shared = serde_json::from_value(select(&SHARED)).map_err(|e| e.to_string())?;
    let turn: Turn = serde_json::from_value(select(&TURN)).map_err(|e| e.to_string())?;
    if !nullable_text(&shared.record_time)
        || !nullable_text(&turn.turn_time)
        || !nullable_text(&turn.source_phase)
        || turn.id.is_empty()
        || turn.turn_id.is_empty()
        || turn.end <= turn.start
        || turn.end - turn.start != turn.text.len() as u64
        || !matches!(
            turn.speaker.as_str(),
            "user" | "assistant" | "system" | "tool" | "source" | "unknown"
        )
    {
        return Err("original field types or UTF-8 byte length changed".into());
    }
    Ok((shared, turn))
}

fn join(shared: &Shared, turn: &Turn) -> Value {
    json!({"id":turn.id,"speaker":turn.speaker,"text":turn.text,
        "turnId":turn.turn_id,"turnTime":turn.turn_time,"sourcePhase":turn.source_phase,
        "recordTime":shared.record_time,"sourceId":shared.source_id,
        "sourcePath":shared.source_path,"selectionPath":shared.selection_path,
        "sourceRevision":shared.source_revision,"start":turn.start,"end":turn.end,"sha256":turn.sha256})
}

/// Group only consecutive equal five-field provenance tuples. Do not merge originals.
pub fn encode(originals: &Value) -> Result<Value, String> {
    let originals = originals.as_array().ok_or("originals must be an array")?;
    if originals.is_empty() || originals.len() > 512 {
        return Err("original array exceeds existing native span bounds".into());
    }
    let mut documents: Vec<Document> = Vec::new();
    let mut ids = HashSet::new();
    for original in originals {
        let (shared, turn) = split(original)?;
        if !ids.insert(turn.id.clone()) {
            return Err("duplicate original ID in presentation".into());
        }
        if documents.last().map(|document| document.shared()) != Some(shared.clone()) {
            documents.push(Document::new(shared));
        }
        documents
            .last_mut()
            .expect("new or matching document")
            .original_spans
            .push(turn);
    }
    serde_json::to_value(Packet {
        version: VERSION.into(),
        documents,
    })
    .map_err(|e| e.to_string())
}

/// Parse closed objects, preserving each native row and all fourteen field values.
/// This validates presentation only; it cannot authenticate source bytes or meaning.
pub fn decode(serialized: &str) -> Result<Value, String> {
    // Typed parsing rejects duplicate and unknown keys, including nested objects.
    let packet: Packet = serde_json::from_str(serialized).map_err(|e| e.to_string())?;
    let raw: Value = serde_json::from_str(serialized).map_err(|e| e.to_string())?;
    let required = |object: &Value, fields: &[&str]| {
        object.as_object().is_some_and(|object| {
            object.len() == fields.len() && fields.iter().all(|field| object.contains_key(*field))
        })
    };
    if !required(&raw, &["version", "documents"])
        || raw["documents"].as_array().map_or(true, |documents| {
            documents.iter().any(|document| {
                !required(
                    document,
                    &[
                        "sourceId",
                        "sourcePath",
                        "selectionPath",
                        "sourceRevision",
                        "recordTime",
                        "originalSpans",
                    ],
                ) || document["originalSpans"].as_array().map_or(true, |turns| {
                    turns.iter().any(|turn| {
                        !required(
                            turn,
                            &[
                                "id",
                                "speaker",
                                "text",
                                "turnId",
                                "turnTime",
                                "sourcePhase",
                                "start",
                                "end",
                                "sha256",
                            ],
                        )
                    })
                })
            })
        })
    {
        return Err("grouped original required field membership changed".into());
    }
    if packet.version != VERSION || packet.documents.is_empty() {
        return Err("grouped original version or documents changed".into());
    }
    let mut originals = Vec::new();
    for document in &packet.documents {
        if document.original_spans.is_empty() {
            return Err("empty grouped original document".into());
        }
        let shared = document.shared();
        for turn in &document.original_spans {
            if originals.len() >= 512 {
                return Err("original array exceeds existing native span bounds".into());
            }
            let original = join(&shared, turn);
            split(&original)?;
            originals.push(original);
        }
    }
    let originals = Value::Array(originals);
    let canonical = serde_json::to_value(&packet).map_err(|e| e.to_string())?;
    if encode(&originals)? != canonical {
        return Err("grouped originals are not canonical consecutive runs".into());
    }
    Ok(originals)
}

#[cfg(test)]
#[path = "original_groups_qa_tests.rs"]
mod tests;
