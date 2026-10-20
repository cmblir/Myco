//! Complete the selected sources from current original bytes before any model call.

use crate::activity_recall::{bind_all_originals, read_original_bytes};
use crate::retrieval::Scope;
use crate::vault_session::AgentVaultSession;
use crate::wiki_claims::{ActorRole, SourceDocument, SourceSet, SpanInput};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;

pub(super) fn complete(
    root: &Path,
    selected: &SourceSet,
    origin: &AgentVaultSession,
    scope: Scope,
    paths: Option<&[String]>,
    selected_pages: &HashMap<String, String>,
    bytes_read: &mut usize,
) -> Result<SourceSet, String> {
    let originals = complete_backing(root, selected, origin, scope, paths, bytes_read)?;
    let mut documents = originals.documents().to_vec();
    // Add only the selected page's non-generated ranges AFTER raw closure;
    // those ranges must never be expanded into the generated summary body.
    for (page, content) in selected_pages {
        if let Some(notes) = selected_notes(page, content)? {
            documents.push(notes);
        }
    }
    SourceSet::new(origin.clone(), scope, documents, vec![])
}

/// Re-read only the already admitted backing originals. Activity callers retain
/// their selected provenance separately and do not admit selected-page notes.
pub(super) fn complete_backing(
    root: &Path,
    selected: &SourceSet,
    origin: &AgentVaultSession,
    scope: Scope,
    paths: Option<&[String]>,
    bytes_read: &mut usize,
) -> Result<SourceSet, String> {
    selected.validate(
        r#"{"outcome":"insufficient_evidence","claims":[]}"#,
        origin,
        scope,
    )?;
    let mut pairs = BTreeMap::new();
    for span in selected.spans() {
        let pair = (
            span.selection_path().to_owned(),
            span.source_path().to_owned(),
        );
        if pairs
            .get(&pair)
            .is_some_and(|revision| revision != span.source_revision())
        {
            return Err("ordinary original closure has conflicting revisions".into());
        }
        pairs.insert(pair, span.source_revision().to_owned());
    }
    if pairs.is_empty() {
        return Err("ordinary original closure is unavailable".into());
    }
    let mut originals = HashMap::new();
    let mut documents = Vec::new();
    for ((selection, source), revision) in pairs {
        // Selected note aliases retain the already checked scope/allowlist.
        // Backing raw/proof paths still require exact named-file custody.
        let source = if source == selection {
            let path = crate::vault::confine_path(root, &root.join(&source).to_string_lossy())?;
            let resolved = path
                .strip_prefix(root)
                .ok()
                .and_then(Path::to_str)
                .ok_or("ordinary resolved source is outside its vault")?;
            if !scope.keeps(resolved)
                || paths.is_some_and(|paths| !paths.iter().any(|path| path == resolved))
                || crate::vector_index::is_cold_for(
                    resolved,
                    crate::settings::search_archived_sessions(),
                )
            {
                return Err("ordinary resolved source is outside the requested scope".into());
            }
            resolved.to_owned()
        } else {
            source
        };
        if !originals.contains_key(&source) {
            originals.insert(
                source.clone(),
                read_original_bytes(root, &source, bytes_read)?,
            );
        }
        documents.push(bind_all_originals(
            &selection,
            &source,
            &originals[&source],
            &revision,
        )?);
    }
    SourceSet::new(origin.clone(), scope, documents, vec![])
}

fn selected_notes(page: &str, content: &str) -> Result<Option<SourceDocument>, String> {
    let pairs = [
        (
            "<!-- myco:session-compilation:v1 ",
            "<!-- /myco:session-compilation -->",
        ),
        (
            "<!-- myco:codex-session-summary:start -->",
            "<!-- myco:codex-session-summary:end -->",
        ),
    ];
    let mut generated = None;
    for (start, end) in pairs {
        if let Some(begin) = content.find(start) {
            if generated.is_some()
                || content.matches(start).count() != 1
                || content.matches(end).count() != 1
            {
                return Err("ordinary selected notes have ambiguous generated boundaries".into());
            }
            let close = content[begin..]
                .find(end)
                .ok_or("ordinary selected notes have an unclosed generated block")?
                + begin
                + end.len();
            generated = Some((begin, close));
        }
    }
    let Some((begin, end)) = generated else {
        return Ok(None);
    };
    if content[..begin].contains("<!-- myco:") || content[end..].contains("<!-- myco:") {
        return Err("ordinary selected notes contain an unclassified generated block".into());
    }
    let mut body = 0usize;
    if let Some(frontmatter) = content.strip_prefix("---\n") {
        body = frontmatter
            .find("\n---\n")
            .map(|close| close + 9)
            .ok_or("ordinary selected notes have invalid frontmatter")?;
    }
    // The canonical H1 is a navigation label; preserve the prose after it.
    let leading = content[body..].len() - content[body..].trim_start().len();
    if content[body + leading..].starts_with("# ") {
        body += leading
            + content[body + leading..]
                .find('\n')
                .unwrap_or(content.len() - body - leading);
    }
    if body > begin {
        return Err("ordinary selected notes overlap generated boundaries".into());
    }
    let mut inputs = Vec::new();
    for (ordinal, (start, end)) in [(body, begin), (end, content.len())]
        .into_iter()
        .enumerate()
    {
        if content[start..end].trim().is_empty() {
            continue;
        }
        let digest = format!(
            "{:x}",
            Sha256::digest(format!("notes:{page}:{start}:{end}").as_bytes())
        );
        inputs.push(SpanInput {
            id: format!("Q-{}", &digest[..32]),
            start,
            end,
            turn_id: format!("T-notes-{ordinal}"),
            speaker: ActorRole::Unknown,
            turn_time: None,
        });
    }
    if inputs.is_empty() {
        return Ok(None);
    }
    let digest = format!("{:x}", Sha256::digest(format!("notes:{page}").as_bytes()));
    let phases = inputs
        .iter()
        .map(|input| {
            (
                input.turn_id.clone(),
                Some("unattributed_selected_page_text".into()),
            )
        })
        .collect::<Vec<_>>();
    SourceDocument::bind(
        format!("S-{}", &digest[..32]),
        page.into(),
        page.into(),
        content,
        None,
        inputs,
    )?
    .with_turn_phases(&phases)
    .map(Some)
}
