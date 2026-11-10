//! Content format checks only. Public hashes and markers never grant update custody.

use serde::Deserialize;
use sha2::{Digest, Sha256};

const START: &str = "<!-- myco:map-generated:v1 -->\n";
const END: &str = "<!-- /myco:map-generated -->\n";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Descriptor {
    version: u8,
    body_revision: String,
}

/// Validate a newly rendered draft before native publication. Existing human
/// pages are never validated into ownership by this function.
pub(crate) fn validate_new_draft(content: &str) -> Result<(), String> {
    let invalid =
        || "map generated section is invalid; publication rejected, retry required".to_string();
    if content.len() > 4 * 1024 * 1024 || content.contains('\0') {
        return Err(invalid());
    }
    let rest = content.strip_prefix("---\n").ok_or_else(invalid)?;
    let (header, body) = rest.split_once("\n---\n\n").ok_or_else(invalid)?;
    let mut descriptors = header
        .lines()
        .filter_map(|line| line.strip_prefix("map_generated: "));
    let descriptor: Descriptor =
        serde_json::from_str(descriptors.next().ok_or_else(invalid)?).map_err(|_| invalid())?;
    if descriptors.next().is_some() || descriptor.version != 1 {
        return Err(invalid());
    }
    let generated = body
        .strip_prefix(START)
        .and_then(|value| value.strip_suffix(END))
        .ok_or_else(invalid)?;
    let reserved = regex::Regex::new(r"(?i)<!--\s*/?myco:map-generated")
        .map_err(|error| format!("map marker validator: {error}"))?;
    if generated.trim().is_empty()
        || !generated.ends_with('\n')
        || reserved.is_match(generated)
        || reserved.is_match(header)
        || descriptor.body_revision != format!("{:x}", Sha256::digest(generated.as_bytes()))
    {
        return Err(invalid());
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
