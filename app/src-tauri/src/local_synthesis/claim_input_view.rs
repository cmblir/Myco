//! Model-only extraction layout; the native flat packet remains the custody input.

use crate::wiki_claims::source_input_view::{original_input, OriginalInputView};
use serde::Serialize;
use serde_json::Value;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivityInput<'a> {
    question: &'a Value,
    language: &'a Value,
    original_spans: Vec<OriginalInputView<'a>>,
    activity_period: &'a Value,
    record_period_context: &'a Value,
    allowed_span_ids: &'a Value,
    independent_verification_receipts: &'a Value,
}

pub(super) fn serialize(original_user: &str) -> Result<String, String> {
    let original: Value = serde_json::from_str(original_user)
        .map_err(|error| format!("read source reading activity packet: {error}"))?;
    let fields = [
        "question",
        "language",
        "originalSpans",
        "activityPeriod",
        "recordPeriodContext",
        "allowedSpanIds",
        "independentVerificationReceipts",
    ];
    if original.as_object().map_or(true, |object| {
        object.len() != fields.len() || fields.iter().any(|key| !object.contains_key(*key))
    }) {
        return Err("source reading activity packet fields changed".into());
    }
    let spans = original["originalSpans"]
        .as_array()
        .ok_or("source reading activity originals are absent")?
        .iter()
        .map(original_input)
        .collect::<Result<Vec<_>, _>>()?;
    // Serialize the borrowed view directly; Value would reorder nested members.
    serde_json::to_string(&ActivityInput {
        question: &original["question"],
        language: &original["language"],
        original_spans: spans,
        activity_period: &original["activityPeriod"],
        record_period_context: &original["recordPeriodContext"],
        allowed_span_ids: &original["allowedSpanIds"],
        independent_verification_receipts: &original["independentVerificationReceipts"],
    })
    .map_err(|error| format!("serialize source reading activity packet: {error}"))
}
