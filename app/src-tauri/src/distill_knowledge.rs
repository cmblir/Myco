//! Current wiki inventory and published chunk coverage for organization.

use super::admission;
use crate::vector_index::VectorStore;
use std::collections::BTreeSet;
use std::path::Path;

pub(super) struct WikiPage {
    pub path: String,
    pub stem: String,
    pub content: String,
    pub sha256: String,
    pub eligible: bool,
}

pub(super) struct Snapshot {
    pub pages: Vec<WikiPage>,
    pub signature: String,
}

fn string_field<'a>(map: &'a gray_matter::Pod, field: &str) -> Option<&'a str> {
    match map {
        gray_matter::Pod::Hash(fields) => match fields.get(field) {
            Some(gray_matter::Pod::String(value)) => Some(value.as_str()),
            _ => None,
        },
        _ => None,
    }
}

fn metadata(content: &str) -> Result<Option<gray_matter::Pod>, String> {
    let fields = gray_matter::Matter::<gray_matter::engine::YAML>::new()
        .parse(content)
        .map(|parsed| parsed.data)
        .map_err(|error| format!("parse organization wiki metadata: {error}"))?;
    if let Some(gray_matter::Pod::Hash(map)) = &fields {
        for field in ["type", "status", "title", "cluster"] {
            if map
                .get(field)
                .is_some_and(|value| !matches!(value, gray_matter::Pod::String(_)))
            {
                return Err(format!(
                    "organization wiki metadata {field} must be a string"
                ));
            }
        }
    } else if fields.is_some() {
        return Err("organization wiki metadata must be a mapping".into());
    }
    Ok(fields)
}

pub(super) fn settled_map(content: &str) -> Result<Option<String>, String> {
    let Some(fields) = metadata(content)? else {
        return Ok(None);
    };
    if string_field(&fields, "type") != Some("map")
        || string_field(&fields, "status") != Some("active")
    {
        return Ok(None);
    }
    Ok(string_field(&fields, "cluster")
        .filter(|cluster| !cluster.trim().is_empty())
        .map(str::to_owned))
}

/// The existing index contract uses u64 chunk hashes, not producer SHA proofs.
/// Check every actual section, including repeated chunks, without inference.
pub(super) fn has_current_chunks(store: &VectorStore, page: &str, content: &str) -> bool {
    let chunks = crate::embeddings::chunk_page(content);
    let mut records: Vec<_> = store
        .records
        .iter()
        .filter(|record| record.page == page)
        .collect();
    records.sort_by_key(|record| record.section);
    records.len() == chunks.len()
        && records
            .iter()
            .zip(chunks.iter())
            .enumerate()
            .all(|(section, (record, chunk))| {
                record.section == section
                    && record.id == format!("{page}#{section}")
                    && record.hash == crate::embeddings::content_hash(chunk)
            })
}

/// Read every visible wiki markdown source. Failed reads/links are not absence.
pub(super) fn read(root: &Path) -> Result<Snapshot, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("canonicalize organization wiki vault: {error}"))?;
    let root = canonical_root.as_path();
    fn walk(root: &Path, directory: &Path, pages: &mut Vec<WikiPage>) -> Result<(), String> {
        for entry in std::fs::read_dir(directory)
            .map_err(|error| format!("read organization wiki directory: {error}"))?
        {
            let entry = entry.map_err(|error| format!("read organization wiki entry: {error}"))?;
            if crate::index::is_hidden_name(&entry.file_name()) {
                continue;
            }
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .map_err(|_| "organization wiki path escaped vault")?
                .to_str()
                .ok_or("organization wiki path is not UTF-8")?
                .to_string();
            let kind = entry
                .file_type()
                .map_err(|error| format!("inspect organization wiki entry: {error}"))?;
            if kind.is_symlink() {
                // Non-Markdown file attachments are not wiki evidence. Preserve
                // the index publisher's skip policy without reading their bytes.
                if path.extension().and_then(|value| value.to_str()) != Some("md")
                    && std::fs::metadata(&path).is_ok_and(|metadata| metadata.is_file())
                {
                    continue;
                }
                return Err("organization wiki source contains a symbolic link".into());
            }
            if kind.is_dir() {
                if path.extension().and_then(|value| value.to_str()) == Some("md") {
                    return Err("organization wiki markdown source is not a regular file".into());
                }
                let confined = crate::vault::confine_delete_path(root, &path.to_string_lossy())?;
                walk(root, &confined, pages)?;
            } else if path.extension().and_then(|value| value.to_str()) == Some("md") {
                let source = admission::read_source(root, &relative)?
                    .ok_or("organization wiki source disappeared during the scan")?;
                let content = String::from_utf8(source.bytes)
                    .map_err(|_| "organization wiki source is not UTF-8")?;
                let fields = metadata(&content)?;
                let status = fields
                    .as_ref()
                    .and_then(|fields| string_field(fields, "status"));
                let is_map = fields
                    .as_ref()
                    .and_then(|fields| string_field(fields, "type"))
                    == Some("map");
                let eligible = !matches!(status, Some("disputed" | "superseded"))
                    && (!is_map || status == Some("active"));
                let stem = path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .ok_or("organization wiki stem is not UTF-8")?
                    .to_string();
                pages.push(WikiPage {
                    path: relative,
                    stem,
                    content,
                    sha256: source.sha256,
                    eligible,
                });
            }
        }
        Ok(())
    }
    let directory = crate::vault::confine_delete_path(root, &root.join("wiki").to_string_lossy())?;
    let mut pages = Vec::new();
    match std::fs::symlink_metadata(&directory) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("inspect organization wiki tree: {error}")),
        Ok(metadata) if metadata.is_dir() => walk(root, &directory, &mut pages)?,
        Ok(_) => return Err("organization wiki tree is not a directory".into()),
    }
    pages.sort_by(|first, second| first.path.cmp(&second.path));
    let identities: Vec<_> = pages
        .iter()
        .map(|page| (&page.path, &page.sha256, page.eligible))
        .collect();
    let bytes = serde_json::to_vec(&(
        "organization-current-wiki-v1",
        admission::sha256(include_bytes!("distill_knowledge.rs")),
        identities,
    ))
    .map_err(|_| "serialize organization current wiki inventory")?;
    Ok(Snapshot {
        pages,
        signature: admission::sha256(&bytes),
    })
}

impl Snapshot {
    /// Refuse missing/extra/stale eligible geometry before cache rebuild or use.
    /// Ineligible pages remain searchable, but cannot influence this graph.
    pub fn covered_store(&self, store: &VectorStore) -> Result<VectorStore, String> {
        self.current_store(store)?.ok_or_else(|| {
            "organization index lacks current complete wiki chunks; reindex required".into()
        })
    }

    /// Selection withholds stale geometry; failed reads and invalid vectors
    /// remain errors. A runner requires successful complete coverage.
    pub fn current_store(&self, store: &VectorStore) -> Result<Option<VectorStore>, String> {
        store.validate_geometry()?;
        let present: BTreeSet<_> = self.pages.iter().map(|page| page.path.as_str()).collect();
        for record in &store.records {
            if record.page.starts_with("wiki/")
                && !crate::vector_index::is_cold(&record.page)
                && !present.contains(record.page.as_str())
            {
                return Ok(None);
            }
        }
        let eligible: BTreeSet<_> = self
            .pages
            .iter()
            .filter(|page| page.eligible)
            .map(|page| page.path.as_str())
            .collect();
        for page in self.pages.iter().filter(|page| page.eligible) {
            if !has_current_chunks(store, &page.path, &page.content) {
                return Ok(None);
            }
        }
        Ok(Some(VectorStore {
            model: store.model.clone(),
            signature: store.signature.clone(),
            dim: store.dim,
            records: store
                .records
                .iter()
                .filter(|record| eligible.contains(record.page.as_str()))
                .cloned()
                .collect(),
        }))
    }

    pub fn titles(&self) -> Result<Vec<(String, String)>, String> {
        let mut result = Vec::new();
        for page in self.pages.iter().filter(|page| page.eligible) {
            let fields = metadata(&page.content)?;
            let title = fields
                .as_ref()
                .and_then(|fields| string_field(fields, "title"))
                .unwrap_or_default()
                .to_string();
            result.push((page.stem.clone(), title));
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    include!("distill_knowledge_tests.rs");
}
