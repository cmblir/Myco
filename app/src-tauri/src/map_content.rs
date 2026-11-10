//! Content format checks only. Public hashes and markers never grant update custody.

use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::ops::Range;

const START: &str = "<!-- myco:map-generated:v1 -->\n";
const END: &str = "<!-- /myco:map-generated -->\n";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Descriptor {
    version: u8,
    body_revision: String,
}

struct OwnedSections<'a> {
    identity: (&'a str, &'a str, Option<&'a str>),
    body_range: Range<usize>,
}

fn owned_sections(content: &str) -> Result<OwnedSections<'_>, String> {
    let invalid = || "map generated section is ambiguous or edited".to_string();
    if content.len() > 4 * 1024 * 1024 || content.contains('\0') {
        return Err(invalid());
    }
    let rest = content.strip_prefix("---\n").ok_or_else(invalid)?;
    let (header, body) = rest.split_once("\n---\n\n").ok_or_else(invalid)?;
    let field = |key: &str| -> Result<Option<&str>, String> {
        let mut found = None;
        for line in header.lines() {
            // Reject duplicate/alternate spellings instead of allowing YAML to
            // interpret metadata differently from the byte-level ownership check.
            let trimmed = line.trim_start();
            if trimmed.starts_with(&format!("\"{key}\""))
                || trimmed.starts_with(&format!("'{key}'"))
            {
                return Err(invalid());
            }
            if trimmed.starts_with(key) {
                let value = line.strip_prefix(&format!("{key}: ")).ok_or_else(invalid)?;
                if found.replace(value).is_some() {
                    return Err(invalid());
                }
            }
        }
        Ok(found)
    };
    let descriptor = field("map_generated")?.ok_or_else(invalid)?;
    let decoded: Descriptor = serde_json::from_str(descriptor).map_err(|_| invalid())?;
    let evidence = field("map_evidence")?;
    let reserved = regex::Regex::new(r"(?i)<!--\s*/?myco:map-generated")
        .map_err(|error| format!("map marker validator: {error}"))?;
    if decoded.version != 1 || reserved.is_match(header) || reserved.find_iter(body).count() != 2 {
        return Err(invalid());
    }
    let start = body.find(START).ok_or_else(invalid)?;
    let end = body.find(END).ok_or_else(invalid)?;
    if end < start + START.len()
        || (start != 0 && !body[..start].ends_with('\n'))
        || (end != 0 && !body[..end].ends_with('\n'))
    {
        return Err(invalid());
    }
    let generated = &body[start + START.len()..end];
    if generated.trim().is_empty()
        || decoded.body_revision != format!("{:x}", Sha256::digest(generated.as_bytes()))
    {
        return Err(invalid());
    }
    Ok(OwnedSections {
        identity: (generated, descriptor, evidence),
        body_range: start..end + END.len(),
    })
}

/// Compare only app-generated content to a privately retained baseline. Human
/// titles and text outside the markers are preserved by this classification.
/// A true result is a content comparison, never permission to write the file.
#[cfg(any(unix, test))]
pub(crate) fn owned_sections_unchanged(baseline: &str, current: &str) -> bool {
    let (Ok(before), Ok(now)) = (owned_sections(baseline), owned_sections(current)) else {
        return false;
    };
    before.identity == now.identity
}

/// Validate a newly rendered draft before native publication. Existing human
/// pages are never validated into ownership by this function.
pub(crate) fn validate_new_draft(content: &str) -> Result<(), String> {
    let sections = owned_sections(content).map_err(|_| {
        "map generated section is invalid; publication rejected, retry required".to_string()
    })?;
    let body = content.split_once("\n---\n\n").ok_or("missing map body")?.1;
    if sections.body_range != (0..body.len()) || !sections.identity.0.ends_with('\n') {
        return Err("map generated section is invalid; new map contains unmarked text".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_shared_frontend_draft_contract() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../src/lib/mapContent.fixture.json")).unwrap();
        validate_new_draft(fixture["content"].as_str().unwrap()).unwrap();
    }

    fn draft(body: &str) -> String {
        format!("---\ntitle: Synthetic\nmap_generated: {{\"version\":1,\"bodyRevision\":\"{:x}\"}}\n---\n\n{START}{body}{END}", Sha256::digest(body.as_bytes()))
    }

    #[test]
    fn distinguishes_owned_edits_from_human_title_and_annotations() {
        let baseline = draft("Synthetic evidence.\n");
        let annotated = baseline
            .replace("title: Synthetic", "title: Human title")
            .replace(START, &format!("Human introduction.\n\n{START}"));
        let annotated = format!("{annotated}\nHuman conclusion.\n");
        assert!(owned_sections_unchanged(&baseline, &annotated));
        assert!(!owned_sections_unchanged(
            &baseline,
            &draft("Human edited evidence.\n")
        ));
        assert!(!owned_sections_unchanged(
            &baseline,
            &annotated.replace("evidence.", "changed.")
        ));
        assert!(validate_new_draft(&annotated).is_err());
    }

    #[test]
    fn rejects_ambiguous_markers_and_owned_metadata_edits() {
        let baseline = draft("Synthetic evidence.\n").replace(
            "title: Synthetic",
            "title: Synthetic\nmap_evidence: {\"version\":1}",
        );
        for changed in [
            baseline.replace(
                "map_evidence: {\"version\":1}",
                "map_evidence: {\"version\":2}",
            ),
            baseline.replace("map_evidence: {\"version\":1}\n", ""),
            baseline.replace("map_generated: ", "map_generated: {}\nmap_generated: "),
            baseline.replace("map_generated: ", "'map_generated': {}\nmap_generated: "),
            baseline.replace(START, &format!("Inline{START}")),
            baseline.replace(START, &format!("{START}{START}")),
            baseline.replace(END, ""),
            format!("{baseline}<!-- MYCO:map-generated:v2 -->\n"),
            baseline.replace("\n", "\r\n"),
        ] {
            assert!(!owned_sections_unchanged(&baseline, &changed));
        }
    }

    #[test]
    fn accepts_exact_utf8_generated_bytes_but_not_an_edited_body() {
        let original = draft("Synthetic 한글 evidence.\n");
        validate_new_draft(&original).unwrap();
        validate_new_draft(&draft(
            "The literal myco:map-generated is ordinary prose.\n",
        ))
        .unwrap();
        assert!(validate_new_draft(&original.replace("evidence.", "edited evidence.")).is_err());
    }

    #[test]
    fn rejects_ambiguous_missing_and_forged_boundaries() {
        for body in [
            "",
            " \n",
            "unterminated",
            "Synthetic\0body\n",
            "<!-- /myco:map-generated -->\n",
            "<!-- MYCO:map-generated:v2 -->\n",
        ] {
            assert!(validate_new_draft(&draft(body)).is_err(), "{body:?}");
        }
        let original = draft("Synthetic evidence.\n");
        for changed in [
            original.replace(START, ""),
            original.replace(END, ""),
            original.replace("\"version\":1", "\"version\":2"),
            format!("{original}Unmarked generated prose.\n"),
            original.replace("map_generated: ", "map_generated: {}\nmap_generated: "),
        ] {
            assert!(validate_new_draft(&changed).is_err());
        }
    }
}
