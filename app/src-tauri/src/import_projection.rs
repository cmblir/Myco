//! Revision-bound ownership for editable imported transcript projections.
//! Human headings, non-provenance frontmatter and text outside the owned block
//! survive refresh. A changed owned block or an unproven legacy file is refused.

use crate::importers::{ledger, wikify, InboxDoc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

const RESERVED: &str = "<!-- myco:import-transcript";
const START: &str = "<!-- myco:import-transcript:v1 ";
const END: &str = "<!-- /myco:import-transcript -->";
const MAX_MARKER_BYTES: usize = 64 * 1024;
const OWNED_FIELDS: [&str; 8] = [
    "source",
    "conversation_id",
    "created",
    "turn_metadata",
    "last_activity",
    "raw_path",
    "original_path",
    "source_revision",
];

#[cfg(test)]
#[path = "import_projection_snapshot_tests.rs"]
mod snapshot_tests;

fn conflict(reason: &str) -> String {
    format!("PROJECTION_OWNERSHIP_CONFLICT: {reason}; original preserved for review/retry")
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Ownership {
    key: String,
    raw_path: String,
    original_path: Option<String>,
    source_revision: String,
    transcript_sha256: String,
}

pub(super) struct PreparedProjection {
    pub body: String,
    pub raw_path: String,
    pub original_path: Option<String>,
    pub previous_raw_path: Option<String>,
}

pub(super) fn read_existing(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(conflict(&format!("read projection: {error}"))),
    }
}

struct Source<'a> {
    prefix: &'a str,
    transcript: &'a str,
    fields: BTreeMap<&'static str, String>,
}

fn header(text: &str) -> Result<(usize, &str), String> {
    let rest = text
        .strip_prefix("---\n")
        .ok_or_else(|| conflict("missing frontmatter"))?;
    let closing = rest
        .find("\n---\n")
        .ok_or_else(|| conflict("unterminated frontmatter"))?;
    gray_matter::Matter::<gray_matter::engine::YAML>::new()
        .parse::<gray_matter::Pod>(text)
        .map_err(|_| conflict("invalid frontmatter"))?;
    Ok((4 + closing + 5, &rest[..closing]))
}

fn field_lines(text: &str) -> Result<BTreeMap<&'static str, String>, String> {
    let (_, yaml) = header(text)?;
    let mut fields = BTreeMap::new();
    for line in yaml.lines() {
        for key in OWNED_FIELDS {
            if line.starts_with(&format!("{key}:")) {
                if fields.insert(key, line.to_string()).is_some() {
                    return Err(conflict("duplicate generated provenance"));
                }
            } else if line.starts_with(&format!("'{key}':"))
                || line.starts_with(&format!("\"{key}\":"))
            {
                return Err(conflict("generated provenance encoding changed"));
            }
        }
    }
    Ok(fields)
}

fn source(text: &str) -> Result<Source<'_>, String> {
    if text.contains(RESERVED) || text.contains(END) {
        return Err(conflict("source contains reserved ownership markers"));
    }
    let (body_offset, _) = header(text)?;
    let body = &text[body_offset..];
    let heading = body.trim_start_matches('\n');
    if !heading.starts_with("# ") {
        return Err(conflict("missing source title"));
    }
    let title_end = heading
        .find("\n\n")
        .ok_or_else(|| conflict("invalid source title"))?;
    if heading[..title_end].contains('\n') {
        return Err(conflict("multiline source title"));
    }
    let transcript_offset = text.len() - heading.len() + title_end + 2;
    Ok(Source {
        prefix: &text[..transcript_offset],
        transcript: &text[transcript_offset..],
        fields: field_lines(text)?,
    })
}

fn provenance(source: &Source<'_>, owner: &Ownership) -> BTreeMap<&'static str, String> {
    let mut fields = source.fields.clone();
    fields.insert("raw_path", format!("raw_path: {}", owner.raw_path));
    fields.insert(
        "source_revision",
        format!("source_revision: {}", owner.source_revision),
    );
    if let Some(path) = &owner.original_path {
        fields.insert("original_path", format!("original_path: {path}"));
    }
    fields
}

fn patch_provenance(
    prefix: &str,
    previous: &BTreeMap<&'static str, String>,
    next: &BTreeMap<&'static str, String>,
) -> Result<String, String> {
    let actual = field_lines(prefix)?;
    if &actual != previous {
        return Err(conflict("generated provenance was edited"));
    }
    let (body_offset, yaml) = header(prefix)?;
    let mut patched = String::from("---\n");
    for line in yaml.split_inclusive('\n') {
        let value = line.strip_suffix('\n').unwrap_or(line);
        let key = previous
            .iter()
            .find_map(|(key, old)| (old == value).then_some(*key));
        if let Some(key) = key {
            if let Some(replacement) = next.get(key) {
                patched.push_str(replacement);
                patched.push('\n');
            }
        } else {
            patched.push_str(line);
            if !line.ends_with('\n') {
                patched.push('\n');
            }
        }
    }
    for (key, line) in next {
        if !previous.contains_key(key) {
            patched.push_str(line);
            patched.push('\n');
        }
    }
    patched.push_str("---\n");
    patched.push_str(&prefix[body_offset..]);
    Ok(patched)
}

fn block(owner: &Ownership, transcript: &str) -> Result<String, String> {
    // JSON escapes keep vendor IDs containing '-->' from closing the comment.
    let metadata = serde_json::to_string(owner)
        .map_err(|e| e.to_string())?
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026");
    if metadata.len() > MAX_MARKER_BYTES {
        return Err(conflict("ownership marker exceeds its read budget"));
    }
    Ok(format!("{START}{metadata} -->\n{transcript}{END}\n"))
}

fn read_source(
    root: &Path,
    owner: &Ownership,
    doc: &InboxDoc,
    recorded: Option<&str>,
) -> Result<String, String> {
    let path =
        crate::vault::confine_delete_path(root, &root.join(&owner.raw_path).to_string_lossy())?;
    if !path.starts_with(root.join("raw/conversations")) {
        return Err(conflict("ownership source escapes raw/conversations"));
    }
    let text = std::fs::read_to_string(path)
        .map_err(|e| conflict(&format!("read previous source: {e}")))?;
    validate_source_identity(&text, owner, doc, recorded)?;
    Ok(text)
}

fn validate_source_identity(
    text: &str,
    owner: &Ownership,
    doc: &InboxDoc,
    recorded: Option<&str>,
) -> Result<(), String> {
    if owner.key != doc.key
        || crate::judge::frontmatter_key(text) != doc.key
        || wikify::source_revision(text) != owner.source_revision
    {
        return Err(conflict("previous source identity/revision changed"));
    }
    // An identical newly published revision can recover an interrupted ledger
    // save. An arbitrary untracked older projection cannot claim ownership.
    if recorded != Some(ledger::fingerprint(text).as_str()) && text != doc.body {
        return Err(conflict("previous source is not the recorded revision"));
    }
    Ok(())
}

fn parse_block(text: &str) -> Result<(&str, Ownership, &str, &str), String> {
    if text.matches(RESERVED).count() != 1 || text.matches(END).count() != 1 {
        return Err(conflict("duplicate or missing ownership markers"));
    }
    let (prefix, marked) = text
        .split_once(START)
        .ok_or_else(|| conflict("unsupported ownership marker"))?;
    let metadata_end = marked
        .find(" -->\n")
        .ok_or_else(|| conflict("invalid ownership marker"))?;
    if metadata_end > MAX_MARKER_BYTES {
        return Err(conflict("ownership marker exceeds its read budget"));
    }
    let owner = serde_json::from_str::<Ownership>(&marked[..metadata_end])
        .map_err(|_| conflict("invalid ownership metadata"))?;
    let body = &marked[metadata_end + 5..];
    let (transcript, suffix) = body
        .split_once(END)
        .ok_or_else(|| conflict("missing ownership end"))?;
    let suffix = suffix
        .strip_prefix('\n')
        .ok_or_else(|| conflict("invalid ownership end"))?;
    Ok((prefix, owner, transcript, suffix))
}

/// Prepare a refresh without writing. Whole-file CAS remains the caller's job.
pub(super) fn prepare(
    root: &Path,
    doc: &InboxDoc,
    previous: Option<&str>,
    recorded: Option<&str>,
) -> Result<PreparedProjection, String> {
    prepare_with_reader(doc, previous, recorded, |owner| {
        read_source(root, owner, doc, recorded)
    })
}

/// Validate a projection using already bounded native original bytes only.
/// File confinement and stable-read identity remain the caller's responsibility.
pub(super) fn validate_existing_from_original(
    doc: &InboxDoc,
    projection: &str,
    expected_raw_path: &str,
    recorded: &str,
) -> Result<(), String> {
    if ledger::fingerprint(&doc.body) != recorded || doc.fingerprint != recorded {
        return Err(conflict("original is not the recorded native revision"));
    }
    let prepared = prepare_with_reader(doc, Some(projection), Some(recorded), |owner| {
        if owner.raw_path != expected_raw_path {
            return Err(conflict("ownership source differs from the bound original"));
        }
        validate_source_identity(&doc.body, owner, doc, Some(recorded))?;
        Ok(doc.body.clone())
    })?;
    if prepared.raw_path != expected_raw_path || prepared.previous_raw_path.is_some() {
        return Err(conflict("projection lacks exact bound original lineage"));
    }
    Ok(())
}

fn prepare_with_reader(
    doc: &InboxDoc,
    previous: Option<&str>,
    recorded: Option<&str>,
    read_original: impl Fn(&Ownership) -> Result<String, String>,
) -> Result<PreparedProjection, String> {
    let next = source(&doc.body)?;
    if crate::judge::frontmatter_key(&doc.body) != doc.key {
        return Err(conflict("new source identity mismatch"));
    }
    let vendor = doc
        .key
        .split_once(':')
        .ok_or_else(|| conflict("invalid session key"))?
        .0;
    let raw_stem = format!(
        "raw/conversations/{vendor}/{}-{}",
        doc.stem, doc.fingerprint
    );
    let owner = Ownership {
        key: doc.key.clone(),
        raw_path: format!("{raw_stem}.md"),
        original_path: (!doc.original_records.is_empty()).then(|| format!("{raw_stem}.jsonl")),
        source_revision: wikify::source_revision(&doc.body),
        transcript_sha256: wikify::source_revision(next.transcript),
    };
    let next_fields = provenance(&next, &owner);
    let mut previous_raw_path = None;
    let (prefix, suffix) = match previous {
        None => (
            patch_provenance(next.prefix, &next.fields, &next_fields)?,
            "",
        ),
        Some(text) if text.contains(RESERVED) || text.contains(END) => {
            let (prefix, old_owner, transcript, suffix) = parse_block(text)?;
            let original = read_original(&old_owner)?;
            let old = source(&original)?;
            if wikify::source_revision(old.transcript) != old_owner.transcript_sha256
                || transcript != old.transcript
            {
                return Err(conflict("owned transcript was edited"));
            }
            (
                patch_provenance(prefix, &provenance(&old, &old_owner), &next_fields)?,
                suffix,
            )
        }
        Some(text) => {
            let old = source(text)?;
            if let Some(raw_line) = old.fields.get("raw_path") {
                let old_owner = Ownership {
                    key: doc.key.clone(),
                    raw_path: raw_line
                        .strip_prefix("raw_path: ")
                        .ok_or_else(|| conflict("invalid legacy source path"))?
                        .into(),
                    original_path: old
                        .fields
                        .get("original_path")
                        .map(|line| {
                            line.strip_prefix("original_path: ")
                                .map(str::to_string)
                                .ok_or_else(|| conflict("invalid legacy original path"))
                        })
                        .transpose()?,
                    source_revision: old
                        .fields
                        .get("source_revision")
                        .and_then(|line| line.strip_prefix("source_revision: "))
                        .ok_or_else(|| conflict("missing legacy source revision"))?
                        .into(),
                    transcript_sha256: String::new(),
                };
                let original = read_original(&old_owner)?;
                let original = source(&original)?;
                let suffix = old
                    .transcript
                    .strip_prefix(original.transcript)
                    .ok_or_else(|| conflict("legacy transcript was edited"))?;
                (
                    patch_provenance(old.prefix, &provenance(&original, &old_owner), &next_fields)?,
                    suffix,
                )
            } else {
                if recorded != Some(ledger::fingerprint(text).as_str())
                    || crate::judge::frontmatter_key(text) != doc.key
                {
                    return Err(conflict("legacy projection ownership is unknown"));
                }
                previous_raw_path = Some(format!(
                    "raw/conversations/{vendor}/{}-{}.md",
                    doc.stem,
                    ledger::fingerprint(text)
                ));
                (patch_provenance(old.prefix, &old.fields, &next_fields)?, "")
            }
        }
    };
    Ok(PreparedProjection {
        body: format!("{prefix}{}{suffix}", block(&owner, next.transcript)?),
        raw_path: owner.raw_path,
        original_path: owner.original_path,
        previous_raw_path,
    })
}

#[cfg(test)]
pub(super) mod hooks {
    std::thread_local! {
        static BEFORE_PUBLISH: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
    }
    pub fn install(callback: impl FnOnce() + 'static) {
        BEFORE_PUBLISH.with(|hook| *hook.borrow_mut() = Some(Box::new(callback)));
    }
    pub fn before_publish() {
        BEFORE_PUBLISH.with(|hook| {
            let callback = hook.borrow_mut().take();
            if let Some(callback) = callback {
                callback();
            }
        });
    }
}
