// Link graph builder. Walks every markdown file under the vault root, parses
// `[[wikilinks]]`, resolves each target by stem against the file index, and
// returns a fresh adjacency map on every call.

use crate::parser;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Serialize)]
pub struct Adjacency {
    pub forward: BTreeMap<String, Vec<String>>,
    pub backward: BTreeMap<String, Vec<String>>,
    pub unresolved: BTreeMap<String, Vec<String>>,
    pub tags: BTreeMap<String, Vec<String>>,
    /// Per-node wiki frontmatter the graph encodes visually (type / confidence /
    /// status / source_count). Keyed by the same absolute file path as `forward`.
    /// Only files that declare at least one of these fields appear here.
    pub meta: BTreeMap<String, NodeMeta>,
}

/// Subset of a page's YAML frontmatter the graph view encodes into the node's
/// appearance (brightness from confidence, glow from source_count, a warning
/// tint for disputed/superseded). Serialised camelCase to match the TS DTO.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeMeta {
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub node_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_count: Option<u32>,
}

impl NodeMeta {
    fn is_empty(&self) -> bool {
        self.node_type.is_none()
            && self.confidence.is_none()
            && self.status.is_none()
            && self.source_count.is_none()
    }
}

pub fn build_link_graph(root: &str) -> Result<Adjacency, String> {
    let root_path = Path::new(root)
        .canonicalize()
        .map_err(|e| format!("canonicalize failed for {root}: {e}"))?;
    let (sources, linkables) =
        collect_files(&root_path).map_err(|e| format!("walk failed: {e}"))?;
    let names = build_name_index(&linkables);

    let mut adj = Adjacency::default();
    for file in &sources {
        // Skip pathologically large files so one file can't dominate a full-vault
        // scan (matches the 2 MB cap search_vault uses). A failed metadata read
        // (len 0) falls through to read_to_string, preserving its error behaviour.
        if std::fs::metadata(file).map(|m| m.len()).unwrap_or(0) > 2 * 1024 * 1024 {
            continue;
        }
        // Skip what we cannot read instead of failing the build. One bad file —
        // a dangling symlink, an un-downloaded iCloud placeholder, a
        // permission-denied note, something that is not UTF-8 — used to abort
        // the whole adjacency, which blanks the Graph view and every multiverse
        // bubble for the vault. The user cannot see which file did it, and a
        // graph missing one note is enormously better than no graph at all.
        // This matches how search_vault (vault.rs) already degrades.
        let Ok(raw) = std::fs::read_to_string(file) else {
            continue;
        };
        ingest_links(file, &raw, &names, &mut adj);
        ingest_frontmatter(file, &raw, &mut adj);
    }

    Ok(adj)
}

/// Walk the vault once. `sources` = `.md` files (parsed for `[[wikilinks]]` and
/// tags). `linkables` = `.md` + `.base` — everything a wikilink may resolve to,
/// because Obsidian Bases (`.base`) are linked by name and otherwise leave a
/// large fraction of links unresolved (so their notes look like orphans).
fn collect_files(dir: &Path) -> std::io::Result<(Vec<PathBuf>, Vec<PathBuf>)> {
    let mut sources = Vec::new();
    let mut linkables = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        // A subdirectory we cannot list (permissions, a vanished mount) skips
        // itself rather than aborting the vault — same reasoning as the
        // per-file read below. `flatten` drops individual bad entries for the
        // same reason.
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in entries.flatten() {
            if is_hidden_name(&e.file_name()) {
                continue;
            }
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            match p.extension().and_then(|s| s.to_str()) {
                Some("md") => {
                    sources.push(p.clone());
                    linkables.push(p);
                }
                Some("base") => linkables.push(p),
                _ => {}
            }
        }
    }
    sources.sort();
    linkables.sort();
    Ok((sources, linkables))
}

pub(crate) fn is_hidden_name(name: &std::ffi::OsStr) -> bool {
    name.to_str()
        .is_some_and(|s| s.starts_with('.') || s == "node_modules" || s == "target")
}

/// Index every linkable file by BOTH its lowercased stem (`note`) and its full
/// lowercased basename (`note.md` / `x.base`). Obsidian links `.md` notes by
/// stem but Bases by full name (`[[X.base]]`), so a wikilink target must be
/// matchable in either form.
fn build_name_index(files: &[PathBuf]) -> HashMap<String, PathBuf> {
    let mut idx = HashMap::with_capacity(files.len() * 2);
    for f in files {
        if let Some(stem) = f.file_stem().and_then(|s| s.to_str()) {
            idx.insert(stem.to_lowercase(), f.clone());
        }
        if let Some(name) = f.file_name().and_then(|s| s.to_str()) {
            idx.insert(name.to_lowercase(), f.clone());
        }
    }
    idx
}

fn ingest_links(file: &Path, text: &str, names: &HashMap<String, PathBuf>, adj: &mut Adjacency) {
    let source = file.to_string_lossy().into_owned();
    // Dedup per source so a page that links the same target twice produces one
    // edge — otherwise forward/backward lists (and the link counts derived from
    // them) are inflated by repeated [[wikilinks]].
    let mut seen_resolved: HashSet<String> = HashSet::new();
    let mut seen_unresolved: HashSet<String> = HashSet::new();
    for target in parser::parse_links_from_text(text) {
        // Drop any `#heading` / `#^block` suffix — Obsidian resolves
        // `[[Note#Section]]` to the note itself.
        let key = target
            .split('#')
            .next()
            .unwrap_or(&target)
            .trim()
            .to_lowercase();
        match names.get(&key) {
            Some(resolved) => {
                let target_path = resolved.to_string_lossy().into_owned();
                if !seen_resolved.insert(target_path.clone()) {
                    continue;
                }
                adj.forward
                    .entry(source.clone())
                    .or_default()
                    .push(target_path.clone());
                adj.backward
                    .entry(target_path)
                    .or_default()
                    .push(source.clone());
            }
            None => {
                if !seen_unresolved.insert(target.clone()) {
                    continue;
                }
                adj.unresolved
                    .entry(source.clone())
                    .or_default()
                    .push(target);
            }
        }
    }
}

// Parse a file's YAML frontmatter ONCE and fill both the tag list and the
// visual-encoding meta (type / confidence / status / source_count).
fn ingest_frontmatter(file: &Path, text: &str, adj: &mut Adjacency) {
    let parsed = match gray_matter::Matter::<gray_matter::engine::YAML>::new().parse(text) {
        Ok(p) => p,
        Err(_) => return,
    };
    let Some(data) = parsed.data else {
        return;
    };
    let key = file.to_string_lossy().into_owned();
    if let Some(tags) = extract_tags(&data) {
        if !tags.is_empty() {
            adj.tags.insert(key.clone(), tags);
        }
    }
    let meta = extract_meta(&data);
    if !meta.is_empty() {
        adj.meta.insert(key, meta);
    }
}

fn extract_meta(pod: &gray_matter::Pod) -> NodeMeta {
    use gray_matter::Pod;
    let mut m = NodeMeta::default();
    let Pod::Hash(map) = pod else { return m };
    let get_str = |k: &str| -> Option<String> {
        match map.get(k) {
            Some(Pod::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
            _ => None,
        }
    };
    m.node_type = get_str("type");
    m.confidence = get_str("confidence");
    m.status = get_str("status");
    m.source_count = match map.get("source_count") {
        Some(Pod::Integer(n)) => u32::try_from(*n).ok(),
        Some(Pod::Float(f)) if *f >= 0.0 => Some(*f as u32),
        Some(Pod::String(s)) => s.trim().parse::<u32>().ok(),
        _ => None,
    };
    m
}

fn extract_tags(pod: &gray_matter::Pod) -> Option<Vec<String>> {
    use gray_matter::Pod;
    let Pod::Hash(map) = pod else { return None };
    let raw = map.get("tags")?;
    Some(match raw {
        Pod::Array(items) => items
            .iter()
            .filter_map(|p| match p {
                Pod::String(s) => Some(s.trim().to_string()),
                _ => None,
            })
            .filter(|s| !s.is_empty())
            .collect(),
        Pod::String(s) => s
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .collect(),
        _ => Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;

    fn temp_vault(name: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!("memex-idx-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Regression: one unreadable .md must not blank the whole graph.
    #[test]
    fn one_unreadable_file_does_not_abort_the_build() {
        let dir = temp_vault("unreadable");
        fs::write(dir.join("good.md"), "links to [[other]]").unwrap();
        fs::write(dir.join("other.md"), "# other").unwrap();
        // A dangling symlink named *.md: is_dir() is false and the extension is
        // md, so it is collected as a source and then fails to read. This is not
        // exotic — a moved target or an un-downloaded iCloud placeholder does it.
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("nowhere.md"), dir.join("dangling.md")).unwrap();

        let adj = build_link_graph(dir.to_str().unwrap())
            .expect("one bad file must not fail the whole build");
        // build_link_graph canonicalizes the root, and on macOS the temp dir
        // resolves through /private — compare against the canonical path.
        let root = dir.canonicalize().unwrap();
        let good = root.join("good.md").to_string_lossy().into_owned();
        assert!(
            adj.forward.contains_key(&good),
            "the readable files must still be in the graph; got {:?}",
            adj.forward.keys().collect::<Vec<_>>()
        );
        fs::remove_dir_all(&dir).ok();
    }

    /// Regression: an unreadable SUBDIRECTORY must not abort the walk either.
    #[test]
    fn unreadable_directory_does_not_abort_the_walk() {
        let dir = temp_vault("unreadable-dir");
        fs::create_dir_all(dir.join("wiki")).unwrap();
        // `forward` only holds files that resolve at least one link, so the
        // fixture needs a real link to be observable there.
        fs::write(dir.join("wiki/good.md"), "see [[target]]").unwrap();
        fs::write(dir.join("wiki/target.md"), "# target").unwrap();
        let locked = dir.join("locked");
        fs::create_dir_all(&locked).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        }

        let adj = build_link_graph(dir.to_str().unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // Restore before asserting so the dir is removable even on failure.
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).ok();
        }
        let adj = adj.expect("an unreadable subdir must not fail the whole build");
        let root = dir.canonicalize().unwrap();
        let good = root.join("wiki/good.md").to_string_lossy().into_owned();
        assert!(
            adj.forward.contains_key(&good),
            "readable files survive an unlistable sibling dir; got {:?}",
            adj.forward.keys().collect::<Vec<_>>()
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn resolves_links_by_stem() {
        let dir = temp_vault("resolve");
        fs::write(dir.join("a.md"), "see [[B]] for context").unwrap();
        fs::write(dir.join("b.md"), "## B\n").unwrap();
        let adj = build_link_graph(dir.to_str().unwrap()).unwrap();
        assert_eq!(adj.forward.len(), 1);
        assert_eq!(adj.backward.len(), 1);
        assert!(adj.unresolved.is_empty());
    }

    #[test]
    fn captures_unresolved_targets() {
        let dir = temp_vault("unresolved");
        fs::write(dir.join("a.md"), "see [[ghost]]").unwrap();
        let adj = build_link_graph(dir.to_str().unwrap()).unwrap();
        assert_eq!(adj.unresolved.len(), 1);
        assert!(adj.forward.is_empty());
    }

    #[test]
    fn dedups_repeated_links() {
        let dir = temp_vault("dedup");
        fs::write(
            dir.join("a.md"),
            "[[b]] and again [[b]] and [[ghost]] [[ghost]]",
        )
        .unwrap();
        fs::write(dir.join("b.md"), "x").unwrap();
        let adj = build_link_graph(dir.to_str().unwrap()).unwrap();
        let src = dir.join("a.md").canonicalize().unwrap();
        let src = src.to_string_lossy().into_owned();
        assert_eq!(adj.forward.get(&src).map(Vec::len), Some(1));
        assert_eq!(adj.unresolved.get(&src).map(Vec::len), Some(1));
    }

    #[test]
    fn resolves_base_by_full_name_and_strips_heading() {
        let dir = temp_vault("base");
        fs::write(dir.join("note.md"), "[[Data.base]] and [[Other#Section]]").unwrap();
        fs::write(dir.join("Data.base"), "filters: []\n").unwrap();
        fs::write(dir.join("Other.md"), "x").unwrap();
        let adj = build_link_graph(dir.to_str().unwrap()).unwrap();
        let src = dir
            .join("note.md")
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        // Data.base resolves by full name; Other resolves after stripping #Section.
        assert_eq!(adj.forward.get(&src).map(Vec::len), Some(2));
        assert!(adj.unresolved.is_empty());
    }

    #[test]
    fn extracts_frontmatter_meta() {
        let dir = temp_vault("meta");
        fs::write(
            dir.join("a.md"),
            "---\ntype: concept\nconfidence: high\nstatus: disputed\nsource_count: 3\n---\nbody [[b]]",
        )
        .unwrap();
        fs::write(dir.join("b.md"), "x").unwrap();
        let adj = build_link_graph(dir.to_str().unwrap()).unwrap();
        let key = dir
            .join("a.md")
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let m = adj.meta.get(&key).expect("meta present");
        assert_eq!(m.node_type.as_deref(), Some("concept"));
        assert_eq!(m.confidence.as_deref(), Some("high"));
        assert_eq!(m.status.as_deref(), Some("disputed"));
        assert_eq!(m.source_count, Some(3));
        // A file with no frontmatter meta produces no entry.
        let bkey = dir
            .join("b.md")
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        assert!(adj.meta.get(&bkey).is_none());
    }
}
