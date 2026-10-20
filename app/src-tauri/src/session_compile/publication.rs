//! Durable prepare -> output CAS -> queue receipt. A failed final queue write
//! retains the artifact and intent, without manufacturing completion authority.

use super::{bound_path, identity, nonce, now, Grant, SessionCompileContext};
use crate::importers::wikify::{source_revision, Pending};
use crate::session_compile::state::{
    CheckState, NativeOutput, OutputPreparation, ProcessingChecks,
};
use std::path::Path;

#[path = "compiled_publication.rs"]
mod compiled;
pub(super) use compiled::{
    finish_compiled, maintain_custody, publish_compiled, verify_compiled, NativeSectionAuthority,
};

pub(super) fn allowed(
    context: &SessionCompileContext,
    rel: &str,
    write: bool,
) -> Result<(), String> {
    if [
        &context.summary_path,
        &context.index_path,
        &context.log_path,
        &context.report_path,
    ]
    .into_iter()
    .any(|allowed| allowed == rel)
        || (!write && context.source.raw_path == rel)
    {
        Ok(())
    } else {
        Err("compiler file is outside its native issued output/source set".into())
    }
}

fn parse(text: &str) -> Result<(serde_json::Value, String), String> {
    let parsed = gray_matter::Matter::<gray_matter::engine::YAML>::new()
        .parse::<serde_json::Value>(text)
        .map_err(|_| "invalid compiler summary frontmatter")?;
    Ok((
        parsed.data.unwrap_or(serde_json::Value::Null),
        parsed.content,
    ))
}

fn lines_retained(old: &str, new: &str) -> bool {
    let mut lines = new.lines();
    old.lines()
        .all(|old_line| lines.by_ref().any(|line| line == old_line))
}

fn frontmatter(text: &str) -> Vec<&str> {
    let mut lines = text.lines();
    if lines.next() != Some("---") {
        return Vec::new();
    }
    lines.take_while(|line| *line != "---").collect()
}

fn yaml_comment(line: &str) -> Option<&str> {
    let mut quote = None;
    let mut escaped = false;
    for (offset, character) in line.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if quote == Some('"') && character == '\\' {
            escaped = true;
            continue;
        }
        if matches!(character, '\'' | '"') {
            if quote == Some(character) {
                quote = None;
            } else if quote.is_none() {
                quote = Some(character);
            }
        }
        if character == '#'
            && quote.is_none()
            && (offset == 0 || line[..offset].ends_with(char::is_whitespace))
        {
            return Some(&line[offset..]);
        }
    }
    None
}

fn human_frontmatter_retained(
    old: &str,
    new: &str,
    owned: &[&str],
    can_update_title: bool,
) -> bool {
    let new_lines = frontmatter(new);
    let mut skip_children = false;
    let mut human_lines = Vec::new();
    for line in frontmatter(old) {
        if let Some(comment) = yaml_comment(line) {
            if !new_lines
                .iter()
                .any(|new_line| yaml_comment(new_line) == Some(comment))
            {
                return false;
            }
        }
        let key = (!line.starts_with(char::is_whitespace))
            .then(|| line.split_once(':'))
            .flatten()
            .map(|(key, _)| key.trim_matches(['\'', '"']));
        if let Some(key) = key {
            skip_children = owned.contains(&key) || (key == "title" && can_update_title);
            if skip_children {
                continue;
            }
        } else if skip_children && (line.starts_with(char::is_whitespace) || line.trim().is_empty())
        {
            continue;
        }
        human_lines.push(line);
    }
    let mut remaining = new_lines.into_iter();
    human_lines
        .into_iter()
        .all(|human| remaining.by_ref().any(|line| line == human))
}

fn preserved_summary(old: &str, new: &str, key: &str) -> Result<(), String> {
    let (old_metadata, old_body) = parse(old)?;
    let (new_metadata, new_body) = parse(new)?;
    if new_metadata["session_key"].as_str() != Some(key) {
        return Err("compiler summary lacks its exact session identity".into());
    }
    let owned = [
        "session_key",
        "session_generated_title",
        "session_revision",
        "last_updated",
        "session_record_start",
        "session_record_end",
        "session_activity_days",
    ];
    let old_generated = old_metadata["session_generated_title"].as_str();
    let can_update_title =
        old_generated.is_some() && old_metadata["title"].as_str() == old_generated;
    if let Some(metadata) = old_metadata.as_object() {
        for (field, value) in metadata {
            if !(owned.contains(&field.as_str()) || field == "title" && can_update_title)
                && new_metadata.get(field) != Some(value)
            {
                return Err("compiler publication would replace human frontmatter".into());
            }
        }
    }
    if !human_frontmatter_retained(old, new, &owned, can_update_title) {
        return Err("compiler publication would remove human frontmatter annotation bytes".into());
    }
    if can_update_title
        && (new_metadata["session_generated_title"].as_str().is_none()
            || new_metadata["title"] != new_metadata["session_generated_title"])
    {
        return Err("generated title update differs from its owned title marker".into());
    }
    let expected_body = if can_update_title {
        match (
            old_generated,
            new_metadata["session_generated_title"].as_str(),
        ) {
            (Some(before), Some(after)) => {
                let old_heading = format!("# {before}");
                let new_heading = format!("# {after}");
                old_body
                    .lines()
                    .map(|line| {
                        if line == old_heading {
                            new_heading.as_str()
                        } else {
                            line
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            }
            _ => old_body.clone(),
        }
    } else {
        old_body.clone()
    };
    if !new_body.starts_with(expected_body.trim_end_matches('\n')) {
        return Err("compiler publication would replace prior human or generated body".into());
    }
    Ok(())
}

fn check_preservation(
    context: &SessionCompileContext,
    rel: &str,
    current: Option<&str>,
    content: &str,
    grant: &Grant,
) -> Result<(), String> {
    if content.len() > 16 * 1024 * 1024 || content.contains('\0') {
        return Err("compiler output exceeds its publication budget".into());
    }
    if rel == context.summary_path {
        match current {
            Some(old) => preserved_summary(old, content, &context.source.key)?,
            None => {
                if parse(content)?.0["session_key"].as_str() != Some(context.source.key.as_str()) {
                    return Err("compiler summary lacks its exact session identity".into());
                }
            }
        }
    } else if let Some(old) = current {
        if rel == context.report_path {
            if !grant.outputs.contains_key(rel) || !content.starts_with(old) {
                return Err(
                    "compiler report overwrite requires this attempt's native receipt and append"
                        .into(),
                );
            }
        } else if !lines_retained(old, content) {
            return Err("compiler publication would remove existing catalog or log lines".into());
        }
    }
    Ok(())
}

pub(super) fn publish(
    root: &Path,
    pending: &mut Pending,
    grant: &mut Grant,
    rel: &str,
    content: &str,
    expected: Option<&str>,
) -> Result<serde_json::Value, String> {
    let context = grant.context.clone();
    allowed(&context, rel, true)?;
    let path = bound_path(root, rel)?;
    let current = match std::fs::read_to_string(&path) {
        Ok(text) => Some(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("read compiler output precondition: {error}")),
    };
    if current.as_deref().map(source_revision).as_deref() != expected {
        return Err("write conflict: compiler output changed; preserve edits and retry".into());
    }
    check_preservation(&context, rel, current.as_deref(), content, grant)?;
    persist_content(root, pending, grant, rel, content, expected)
}

// Only public preservation checks or the private compiled publisher's exact
// section/live-handle checks may enter this shared durable write transaction.
fn persist_content(
    root: &Path,
    pending: &mut Pending,
    grant: &mut Grant,
    rel: &str,
    content: &str,
    expected: Option<&str>,
) -> Result<serde_json::Value, String> {
    let result = persist_recorded(root, pending, grant, rel, content, expected)?;
    if let Some(error) = result.queue_error {
        return Err(error);
    }
    grant.outputs.insert(rel.into(), result.receipt);
    Ok(result.value)
}

struct PersistedContent {
    value: serde_json::Value,
    receipt: crate::vault::RecordedWriteReceipt,
    queue_error: Option<String>,
}

fn persist_recorded(
    root: &Path,
    pending: &mut Pending,
    grant: &mut Grant,
    rel: &str,
    content: &str,
    expected: Option<&str>,
) -> Result<PersistedContent, String> {
    persist_recorded_with_writer(
        root,
        pending,
        grant,
        rel,
        content,
        expected,
        |path, content, expected| {
            crate::vault::write_file_if_unchanged_recorded(
                &path.to_string_lossy(),
                content,
                expected,
            )
        },
    )
}

// The writer callback returns only after releasing FILE. Queue CAS and finish
// reacquire the normal writer and must never run inside that critical section.
#[allow(clippy::too_many_arguments)]
fn persist_recorded_with_writer(
    root: &Path,
    pending: &mut Pending,
    grant: &mut Grant,
    rel: &str,
    content: &str,
    expected: Option<&str>,
    writer: impl FnOnce(&Path, &str, Option<&str>) -> Result<crate::vault::RecordedWriteReceipt, String>,
) -> Result<PersistedContent, String> {
    let context = grant.context.clone();
    let path = bound_path(root, rel)?;
    let publication_id = nonce()?;
    pending
        .compile_jobs
        .iter_mut()
        .find(|job| job.id == context.job_id)
        .ok_or("compiler job no longer admitted")?
        .active(
            &context.attempt_id,
            &context.origin,
            &context.role_snapshot.snapshot_id,
            &identity(&context),
        )?
        .prepared_outputs
        .push(OutputPreparation {
            publication_id: publication_id.clone(),
            path: rel.into(),
            content_revision: source_revision(content),
            expected_revision: expected.map(str::to_string),
        });
    pending.save(root)?;
    let parent = path.parent().ok_or("compiler output has no parent")?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("create compiler output directory: {error}"))?;
    let path = bound_path(root, rel)?;
    let receipt = writer(&path, content, expected)?;
    #[cfg(test)]
    if let Some(hook) = AFTER_OUTPUT.lock().unwrap().take() {
        hook();
    }
    let output = NativeOutput {
        publication_id: publication_id.clone(),
        attempt_id: context.attempt_id.clone(),
        path: rel.into(),
        revision: receipt.revision.clone(),
        native_created: receipt.native_created,
        identity: serde_json::to_value(&receipt.file_identity)
            .map_err(|error| error.to_string())?,
    };
    let attempt = pending
        .compile_jobs
        .iter_mut()
        .find(|job| job.id == context.job_id)
        .ok_or("compiler job no longer admitted")?
        .active(
            &context.attempt_id,
            &context.origin,
            &context.role_snapshot.snapshot_id,
            &identity(&context),
        )?;
    attempt.outputs.retain(|prior| prior.path != rel);
    attempt.outputs.push(output.clone());
    attempt
        .prepared_outputs
        .retain(|intent| intent.publication_id != publication_id);
    attempt.updated = now();
    let queue_error = pending
        .save(root)
        .err()
        .map(|error| format!("compiler artifact retained; queue publication incomplete: {error}"));
    Ok(PersistedContent {
        receipt,
        queue_error,
        value: serde_json::json!({"publicationId":publication_id,"attemptId":context.attempt_id,
        "path":rel,"revision":output.revision,"nativeCreated":output.native_created}),
    })
}

pub(super) fn finish(
    root: &Path,
    pending: &mut Pending,
    grant: &mut Grant,
    wiki_paths: &[String],
) -> Result<serde_json::Value, String> {
    let context = &grant.context;
    if wiki_paths.is_empty() || wiki_paths.iter().any(|path| path != &context.summary_path) {
        return Err("compiler completion must name this attempt's issued canonical summary".into());
    }
    let receipt = grant
        .outputs
        .get(&context.summary_path)
        .ok_or("compiler completion requires a native publication from this attempt")?;
    crate::vault::verify_recorded_file(receipt)?;
    let summary = std::fs::read_to_string(bound_path(root, &context.summary_path)?)
        .map_err(|error| format!("read published compiler summary: {error}"))?;
    let source_schema = crate::mcp_native::check_page_text(&summary, false)["ok"] == true
        && crate::mcp_native::cites_pending_revision(&summary, &context.source.raw_path);
    let job = pending
        .compile_jobs
        .iter_mut()
        .find(|job| job.id == context.job_id)
        .ok_or("compiler job no longer admitted")?;
    let outputs = job
        .active(
            &context.attempt_id,
            &context.origin,
            &context.role_snapshot.snapshot_id,
            &identity(context),
        )?
        .outputs
        .clone();
    for output in &outputs {
        let actual = grant
            .outputs
            .get(&output.path)
            .ok_or("persisted output lacks this runtime's native publisher authority")?;
        if actual.revision != output.revision {
            return Err("native compiler output receipt changed".into());
        }
        crate::vault::verify_recorded_file(actual)?;
    }
    // Publication syntax/citations are deterministic but do not validate the
    // typed SessionCompilationV1 schema. No production extraction/independent
    // semantic adapter is connected here yet; both checks remain unavailable.
    let checks = ProcessingChecks {
        original_source: CheckState::Passed,
        source_schema: if source_schema {
            CheckState::Unavailable
        } else {
            CheckState::Rejected
        },
        semantic_review: CheckState::Unavailable,
        ..ProcessingChecks::default()
    };
    let complete = job.finish(&context.attempt_id, checks.clone(), outputs, now())?;
    pending.save(root)?;
    Ok(
        serde_json::json!({"ok":complete,"state":"partial","attemptId":context.attempt_id,
        "reason":"native_compilation_or_review_unavailable","checks":checks,
        "publicationValidation":{"markdownSyntaxAndCitation":source_schema}}),
    )
}

#[cfg(test)]
#[allow(clippy::type_complexity)]
pub(super) static AFTER_OUTPUT: std::sync::Mutex<Option<Box<dyn FnOnce() + Send>>> =
    std::sync::Mutex::new(None);

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn human_title_frontmatter_and_annotation_are_retained() {
        let old = "---\ntitle: Human title\nsession_key: codex:synthetic\nsession_generated_title: Generated title\nannotation: keep # inline human annotation\n# Human frontmatter comment\n---\n# Human title\n\nHuman annotation\n";
        let new = old.replace("Generated title", "New generated title") + "\nNew source evidence\n";
        assert!(preserved_summary(old, &new, "codex:synthetic").is_ok());
        assert!(preserved_summary(
            old,
            &new.replace("Human annotation", "lost"),
            "codex:synthetic"
        )
        .is_err());
        assert!(preserved_summary(
            old,
            &new.replace("annotation: keep", "annotation: lost"),
            "codex:synthetic"
        )
        .is_err());
        assert!(preserved_summary(
            old,
            &new.replace("Human title", "Wrong title"),
            "codex:synthetic"
        )
        .is_err());
    }
    #[test]
    fn yaml_comments_and_unknown_formatting_are_preserved() {
        let old = "---\ntitle: Human title\nsession_key: codex:synthetic\nannotation: keep # inline annotation\n# Human comment\n---\n# Human title\n";
        assert!(
            preserved_summary(old, &(old.to_string() + "\nEvidence\n"), "codex:synthetic").is_ok()
        );
        assert!(preserved_summary(
            old,
            &old.replace(" # inline annotation", ""),
            "codex:synthetic"
        )
        .is_err());
        assert!(preserved_summary(
            old,
            &old.replace("# Human comment\n", ""),
            "codex:synthetic"
        )
        .is_err());
        assert!(preserved_summary(
            old,
            &old.replace("annotation: keep", "annotation:   keep"),
            "codex:synthetic"
        )
        .is_err());
    }
    #[test]
    fn catalog_insertion_retains_every_prior_line_in_order() {
        assert!(lines_retained(
            "# Index\n## Sources\nHuman entry\n",
            "# Index\n## Sources\nGenerated entry\nHuman entry\n"
        ));
        assert!(!lines_retained(
            "# Index\nHuman entry\n",
            "# Index\nGenerated entry\n"
        ));
    }
}
