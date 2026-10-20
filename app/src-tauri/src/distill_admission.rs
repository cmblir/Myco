//! Model-free identity for admission inputs and current source revisions.

use super::{DistillConfig, Ontology, EMBED_CHARS, GATE_MIN_WIKI_PAGES, GATE_RULES};
use crate::vector_index::VectorStore;
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct DecisionInputs {
    pub signature: String,
    pub interests: Vec<String>,
}

pub(super) struct SourceRevision {
    pub bytes: Vec<u8>,
    pub sha256: String,
}

pub(super) fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(super) fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Missing sources remain absent; existing read/path failures are not absence.
pub(super) fn read_source(root: &Path, relative: &str) -> Result<Option<SourceRevision>, String> {
    let path = root.join(relative);
    let path = crate::vault::confine_delete_path(root, &path.to_string_lossy())?;
    crate::index_publication::read_checked(&path).map(|bytes| {
        bytes.map(|bytes| SourceRevision {
            sha256: sha256(&bytes),
            bytes,
        })
    })
}

pub(super) fn source_matches(
    root: &Path,
    relative: &str,
    expected_sha256: &str,
) -> Result<bool, String> {
    if !valid_digest(expected_sha256) {
        return Err("distill source revision is malformed".into());
    }
    Ok(read_source(root, relative)?.is_some_and(|source| source.sha256 == expected_sha256))
}

/// Only the ordered Interests bullets participate in semantic admission.
/// Role/Goals and formatting outside this section are not scoring inputs.
pub(super) fn read_interests(root: &Path) -> Result<Vec<String>, String> {
    let Some(source) = read_source(root, "profile.md")? else {
        return Ok(Vec::new());
    };
    let content = String::from_utf8(source.bytes)
        .map_err(|_| "distill profile source is not UTF-8".to_string())?;
    let mut interests = Vec::new();
    let mut in_interests = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('#') {
            in_interests = trimmed.eq_ignore_ascii_case("## interests");
            continue;
        }
        if !in_interests {
            continue;
        }
        let Some(item) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
        else {
            continue;
        };
        let item = item.trim();
        if !item.is_empty() {
            interests.push(item.to_string());
        }
    }
    Ok(interests)
}

/// Capture the actual policy inputs without invoking an embedding producer.
pub(super) fn capture(
    root: &Path,
    ontology: &Ontology,
    config: &DistillConfig,
) -> Result<DecisionInputs, String> {
    let snapshot = super::knowledge::read(root)?;
    capture_snapshot(root, ontology, config, &snapshot.signature)
}

pub(super) fn capture_snapshot(
    root: &Path,
    ontology: &Ontology,
    config: &DistillConfig,
    wiki_signature: &str,
) -> Result<DecisionInputs, String> {
    ontology.validate_geometry(None)?;
    let interests = read_interests(root)?;
    // Source identity alone does not bind manual geometry/radius changes.
    // Lifecycle timestamps do not participate in `ontology::admit`.
    let clusters: Vec<_> = ontology
        .clusters
        .iter()
        .map(|cluster| {
            (
                cluster.id,
                &cluster.label,
                &cluster.members,
                &cluster.centroid,
                cluster.sim_mean,
                cluster.sim_std,
                cluster.p5,
                cluster.p25,
                cluster.p40,
                cluster.override_widen,
            )
        })
        .collect();
    // Hash the compiled admission policy source as well as its selected
    // inputs. A threshold/entity/profile policy edit invalidates old scores
    // without copying its private constants into a second implementation.
    let policy = sha256(include_bytes!("ontology.rs"));
    let bytes = serde_json::to_vec(&(
        "distill-admission-inputs-v2",
        policy,
        wiki_signature,
        EMBED_CHARS,
        GATE_MIN_WIKI_PAGES,
        GATE_RULES,
        &ontology.embedding,
        &ontology.source_signature,
        ontology.wiki_pages,
        clusters,
        &ontology.entities,
        &config.gate_preset,
        &interests,
    ))
    .map_err(|_| "serialize distill decision inputs".to_string())?;
    Ok(DecisionInputs {
        signature: sha256(&bytes),
        interests,
    })
}

/// A stale/missing cache withholds authority; selection never rebuilds it.
/// Verify complete current eligible wiki chunks before deriving cache authority.
/// The u64 chunk contract is not a cryptographic producer-source attestation.
pub(super) fn current(
    root: &Path,
    store: &VectorStore,
    config: &DistillConfig,
) -> Result<Option<DecisionInputs>, String> {
    if store.dim == 0 && store.records.is_empty() {
        return Ok(None);
    }
    let snapshot = super::knowledge::read(root)?;
    let Some(covered) = snapshot.current_store(store)? else {
        return Ok(None);
    };
    let titles = snapshot.titles()?;
    let anchors = super::map_anchors_from_store(root, &covered)?;
    let Some(ontology) = crate::ontology::load_for_store(root, &covered, &titles, &anchors)? else {
        return Ok(None);
    };
    let inputs = capture_snapshot(root, &ontology, config, &snapshot.signature)?;
    if super::knowledge::read(root)?.signature != snapshot.signature {
        return Err("organization wiki changed during authority read".into());
    }
    Ok(Some(inputs))
}
