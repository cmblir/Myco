//! Immutable structural answer draft; parsing does not approve meaning.

use super::{
    comparable_text, render_source_references, validate_answer_prose, GeneratedAnswer, Prompt,
    INCOMPLETE_ANSWER,
};
use crate::importers::wikify::source_revision;
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Serialize)]
pub(crate) struct ValidatedAnswerDraft {
    model_answer: String,
    review_prose: String,
    source_ids: Vec<String>,
    paths: Vec<String>,
    rendered_body: String,
    citations: Vec<String>,
    input_revision: String,
    prompt_revision: String,
}
impl ValidatedAnswerDraft {
    pub(crate) fn input_revision(&self) -> &str {
        &self.input_revision
    }
    pub(crate) fn prompt_revision(&self) -> &str {
        &self.prompt_revision
    }
    pub(crate) fn source_ids(&self) -> &[String] {
        &self.source_ids
    }
    pub(crate) fn revision(&self) -> Result<String, String> {
        serde_json::to_string(self)
            .map(|text| source_revision(&text))
            .map_err(|error| error.to_string())
    }
    pub(crate) fn review_payload(&self) -> Value {
        json!({"modelAnswer":self.model_answer,"proseWithoutModelLinkLabels":self.review_prose,
            "sourceIds":self.source_ids,"inputRevision":self.input_revision})
    }
    pub(crate) fn binds_prompt(&self, prompt: &Prompt, lang: &str) -> bool {
        prompt_revision(prompt, lang).is_ok_and(|value| value == self.prompt_revision)
    }
    pub(crate) fn into_rendered(self) -> (String, Vec<String>) {
        (
            format!("{}\n\n{}", self.rendered_body, self.citations.join(" · ")),
            self.paths,
        )
    }
}
fn prompt_revision(prompt: &Prompt, lang: &str) -> Result<String, String> {
    serde_json::to_string(&json!({"system":prompt.system,"user":prompt.user,
        "question":prompt.question,"language":lang,"evidence":prompt.evidence}))
    .map(|text| source_revision(&text))
    .map_err(|error| error.to_string())
}

pub(crate) fn validate_answer_draft(
    raw: &str,
    prompt: &Prompt,
    lang: &str,
) -> Result<ValidatedAnswerDraft, String> {
    if raw.len() > 8192 {
        return Err("local answer exceeds the output budget".into());
    }
    let generated: GeneratedAnswer = serde_json::from_str(raw.trim()).map_err(|error| {
        if error.is_eof() {
            INCOMPLETE_ANSWER.to_string()
        } else {
            "local answer is not complete citation-bearing JSON".to_string()
        }
    })?;
    let answer = generated.answer.trim();
    if answer.is_empty()
        || answer.chars().count() > 1200
        || generated.sources.is_empty()
        || generated.sources.len() > prompt.evidence.len()
        || answer.contains(['<', '>'])
        || answer.contains("](")
        || answer.contains("```")
    {
        return Err("local answer has insufficient or invalid evidence references".into());
    }
    validate_answer_prose(answer, prompt, lang)?;
    let mut citations = Vec::new();
    let mut paths = Vec::new();
    let mut references = std::collections::HashMap::new();
    for id in &generated.sources {
        let source = prompt
            .evidence
            .iter()
            .enumerate()
            .find(|(index, _)| *id == format!("S{}", index + 1))
            .map(|(_, source)| source)
            .ok_or("local answer cited an unknown source")?;
        let clean = |text: &str| text.replace(['[', ']', '|', '\r', '\n'], "");
        let citation = format!(
            "[[{}|{}]]",
            clean(source.page.trim_end_matches(".md")),
            clean(&source.stem)
        );
        references.insert(id.as_str(), citation.clone());
        if paths.contains(&source.page) {
            continue;
        }
        citations.push(citation);
        paths.push(source.page.clone());
    }
    let (rendered, prose) = render_source_references(answer, &references, &prompt.evidence)?;
    if prose != answer {
        if comparable_text(&prose).is_empty() {
            return Err("local answer has no answer prose".into());
        }
        // A model-supplied link label cannot satisfy language or echo guards.
        validate_answer_prose(&prose, prompt, lang)?;
    }
    Ok(ValidatedAnswerDraft {
        model_answer: answer.into(),
        review_prose: prose,
        source_ids: generated.sources,
        paths,
        rendered_body: rendered,
        citations,
        input_revision: source_revision(raw),
        prompt_revision: prompt_revision(prompt, lang)?,
    })
}

#[cfg(test)]
#[path = "answer_draft_tests.rs"]
mod tests;
