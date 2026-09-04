// Link graph builder. Walks every markdown file under the vault root, parses
// `[[wikilinks]]`, resolves each target by stem against the file index, and
// returns a fresh adjacency map on every call.

use crate::parser;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

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
    /// Hash of everything above, so a poller can skip re-rendering an
    /// identical graph. See [`fingerprint`].
    pub rev: u64,
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

    let mut cache = parse_cache().lock().unwrap_or_else(|e| e.into_inner());
    // Take the previous generation out; whatever we don't carry over below is
    // a deleted file and drops with it.
    let prev = cache.remove(&root_path).unwrap_or_default();
    let mut cur: HashMap<PathBuf, Arc<CachedFile>> = HashMap::with_capacity(sources.len());

    let mut adj = Adjacency::default();
    for file in &sources {
        // Stat only. `stamp` is None when metadata is unreadable, which forces
        // a re-read (and never caches) — the conservative side.
        let stamp = std::fs::metadata(file)
            .ok()
            .and_then(|m| Some((m.modified().ok()?, m.len())));
        // Skip pathologically large files so one file can't dominate a full-vault
        // scan (matches the 2 MB cap search_vault uses). A failed metadata read
        // (len 0) falls through to read_to_string, preserving its error behaviour.
        if stamp.is_some_and(|(_, len)| len > 2 * 1024 * 1024) {
            continue;
        }
        let parsed = match prev.get(file) {
            // Same mtime+len as last build: reuse the parse, don't touch the disk.
            Some(hit) if stamp.is_some() && hit.stamp == stamp => Arc::clone(hit),
            _ => {
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
                Arc::new(parse_file(stamp, &raw))
            }
        };
        // Resolution is redone every build even for unchanged files: creating or
        // deleting ANY note changes what an untouched note's [[links]] resolve to.
        resolve_links(file, &parsed.links, &names, &mut adj);
        let key = file.to_string_lossy().into_owned();
        if !parsed.tags.is_empty() {
            adj.tags.insert(key.clone(), parsed.tags.clone());
        }
        if !parsed.meta.is_empty() {
            adj.meta.insert(key, parsed.meta.clone());
        }
        cur.insert(file.clone(), parsed);
    }
    cache.insert(root_path, cur);
    adj.rev = fingerprint(&adj);

    Ok(adj)
}

/// One file's parse, kept between builds so a rescan re-reads only what
/// changed. `links` are the RAW wikilink targets as written; they are resolved
/// against the name index on every build (see above).
struct CachedFile {
    /// (mtime, len) at parse time — `None` when metadata was unreadable, which
    /// never matches and so always forces a re-read.
    stamp: Option<(SystemTime, u64)>,
    links: Vec<String>,
    tags: Vec<String>,
    meta: NodeMeta,
}

/// Per-vault parse cache, keyed by canonical root.
///
/// WHY: during an ingest run the UI rescanned the link graph every 2 s, and
/// each scan read and parsed the whole vault — 1747 files / 26 MB, ~309 ms of
/// I/O warm — to see the one file the agent had just written. Now the walk only
/// stats, and only changed/new files are read.
///
/// ponytail: one global mutex, so two builds (different vaults included)
/// serialise. Per-root locks only if that ever shows up in a profile.
fn parse_cache() -> &'static Mutex<ParseCache> {
    static CACHE: OnceLock<Mutex<ParseCache>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// Canonical vault root -> its files' parses.
type ParseCache = HashMap<PathBuf, HashMap<PathBuf, Arc<CachedFile>>>;

// Files actually read from disk, so a test can assert the cache is used.
// Thread-local because cargo runs tests in parallel threads and each test only
// ever counts its own builds.
#[cfg(test)]
thread_local! {
    static PARSE_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Reads and resets the parse counter for the current test.
#[cfg(test)]
fn take_parse_count() -> usize {
    PARSE_COUNT.with(|c| c.replace(0))
}

fn parse_file(stamp: Option<(SystemTime, u64)>, text: &str) -> CachedFile {
    #[cfg(test)]
    PARSE_COUNT.with(|c| c.set(c.get() + 1));
    let (tags, meta) = parse_frontmatter(text);
    CachedFile {
        stamp,
        links: parser::parse_links_from_text(text),
        tags,
        meta,
    }
}

/// Hash of the whole adjacency, so a poller can tell "nothing changed" from a
/// rebuilt-but-identical graph and skip re-rendering. Truncated to 53 bits
/// because it crosses IPC into a JS `number`.
fn fingerprint(adj: &Adjacency) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for map in [&adj.forward, &adj.backward, &adj.unresolved, &adj.tags] {
        map.hash(&mut h);
    }
    for (k, m) in &adj.meta {
        k.hash(&mut h);
        (&m.node_type, &m.confidence, &m.status, m.source_count).hash(&mut h);
    }
    h.finish() & ((1u64 << 53) - 1)
}

/// Whether `path` is a top-level staging directory the KNOWLEDGE graph must not
/// walk. `_inbox/` holds sources awaiting ingest and `sessions/` holds work logs
/// — neither is a wiki page, and both are full of text that merely LOOKS like
/// wiki syntax: 596 imported session logs mentioned `[[TASK_DONE]]` in passing,
/// which the link graph turned into one ghost node with 596 spokes. That hub is
/// what made the graph unusable at load, so the fix is to not walk them at all.
///
/// `templates/` holds note scaffolds with `{{title}}` placeholders — not
/// knowledge either, so they stay out of the graph, Tags and lint.
///
/// Top-level only (compared against the vault root), so a legitimate
/// `wiki/sessions.md` page or a `wiki/x/_inbox/` folder is untouched.
pub(crate) fn is_staging_dir(root: &Path, path: &Path) -> bool {
    path.parent() == Some(root)
        && matches!(
            path.file_name().and_then(|n| n.to_str()),
            Some("_inbox") | Some("sessions") | Some("templates")
        )
}

/// Walk the vault once. `sources` = `.md` files (parsed for `[[wikilinks]]` and
/// tags). `linkables` = `.md` + `.base` — everything a wikilink may resolve to,
/// because Obsidian Bases (`.base`) are linked by name and otherwise leave a
/// large fraction of links unresolved (so their notes look like orphans).
/// Top-level staging directories are skipped (see [`is_staging_dir`]).
pub(crate) fn collect_files(dir: &Path) -> std::io::Result<(Vec<PathBuf>, Vec<PathBuf>)> {
    let mut sources = Vec::new();
    let mut linkables = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        // vault_entries is best-effort (an unlistable subdirectory yields
        // nothing rather than aborting the vault — same reasoning as the
        // per-file read below) and, critically, does not follow symlinks: a
        // symlinked directory must not walk files from outside the vault into
        // the graph.
        for (e, kind) in crate::vault::vault_entries(&d) {
            let p = e.path();
            if kind.is_dir() {
                if is_staging_dir(dir, &p) {
                    continue;
                }
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
pub(crate) fn build_name_index(files: &[PathBuf]) -> HashMap<String, PathBuf> {
    let mut idx = HashMap::with_capacity(files.len() * 2);
    // NFC on the keys: macOS file APIs return NFD Hangul filenames, while a
    // typed `[[wikilink]]` is NFC — without normalization the same name never
    // matches and the link reads as a missing page.
    for f in files {
        if let Some(stem) = f.file_stem().and_then(|s| s.to_str()) {
            idx.insert(crate::norm::nfc(stem).to_lowercase(), f.clone());
        }
        if let Some(name) = f.file_name().and_then(|s| s.to_str()) {
            idx.insert(crate::norm::nfc(name).to_lowercase(), f.clone());
        }
    }
    idx
}

fn resolve_links(
    file: &Path,
    targets: &[String],
    names: &HashMap<String, PathBuf>,
    adj: &mut Adjacency,
) {
    let source = file.to_string_lossy().into_owned();
    // Dedup per source so a page that links the same target twice produces one
    // edge — otherwise forward/backward lists (and the link counts derived from
    // them) are inflated by repeated [[wikilinks]].
    let mut seen_resolved: HashSet<String> = HashSet::new();
    let mut seen_unresolved: HashSet<String> = HashSet::new();
    for target in targets {
        // Drop any `#heading` / `#^block` suffix — Obsidian resolves
        // `[[Note#Section]]` to the note itself. Then drop any path prefix
        // (`[[wiki/x]]`, `[[wiki/sub/x.md]]`) — this vault has a flat wikilink
        // name index (build_name_index keys by stem/basename only, not full
        // path), so a link written path-style must look up the same key as the
        // bare stem `[[x]]` or it reads as a false "missing page" even though
        // the file exists. Matches Obsidian's own basename resolution.
        let base = target.split('#').next().unwrap_or(target).trim();
        let base = base.rsplit(['/', '\\']).next().unwrap_or(base);
        // Same normalization as build_name_index's keys — both sides must
        // agree or NFD-vs-NFC pairs miss.
        let key = crate::norm::nfc(base).to_lowercase();
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
                    .push(target.clone());
            }
        }
    }
}

// Parse a file's YAML frontmatter ONCE and return both the tag list and the
// visual-encoding meta (type / confidence / status / source_count).
fn parse_frontmatter(text: &str) -> (Vec<String>, NodeMeta) {
    let parsed = match gray_matter::Matter::<gray_matter::engine::YAML>::new().parse(text) {
        Ok(p) => p,
        Err(_) => return Default::default(),
    };
    // Frontmatter `tags:` first, then inline body `#tags` (the Obsidian/Notion
    // habit). `parsed.content` is the text after the frontmatter block, so a
    // `tags:` key is never re-read as a body tag. Deduped case-insensitively,
    // first spelling wins, so `Rust` in frontmatter absorbs a body `#rust`.
    let mut tags = parsed
        .data
        .as_ref()
        .and_then(extract_tags)
        .unwrap_or_default();
    tags.extend(body_tags(&parsed.content));
    let mut seen = HashSet::new();
    tags.retain(|t| seen.insert(t.to_lowercase()));
    let meta = parsed.data.as_ref().map(extract_meta).unwrap_or_default();
    (tags, meta)
}

/// Inline `#tag`s in a markdown body, close to Obsidian's rule: `#` at line
/// start or after whitespace / an opening bracket or quote, followed by a token
/// of letters (any script), digits, `_`, `-`, `/` with at least one non-digit.
/// Skips fenced code blocks, inline code spans, ATX headings (`# Title` — a
/// space after `#` leaves an empty token) and URL fragments (`…/y#frag` — the
/// `#` is preceded by a non-space).
fn body_tags(body: &str) -> Vec<String> {
    let is_tag_char = |c: char| c.is_alphanumeric() || matches!(c, '_' | '-' | '/');
    let mut out = Vec::new();
    let mut in_fence = false;
    for line in body.lines() {
        let lead = line.trim_start();
        if lead.starts_with("```") || lead.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        // Even segments are outside backticks. An unclosed backtick swallows
        // the rest of the line — acceptable, a stray `#` there is rare.
        for (i, seg) in line.split('`').enumerate() {
            if i % 2 == 1 {
                continue;
            }
            // A segment after a code span starts right after the closing
            // backtick, which is not a valid tag boundary.
            let mut prev = if i == 0 { ' ' } else { '`' };
            let mut rest = seg;
            while let Some(hash) = rest.find('#') {
                if hash > 0 {
                    prev = rest[..hash].chars().next_back().unwrap_or(' ');
                }
                let after = &rest[hash + 1..];
                let end = after.find(|c: char| !is_tag_char(c)).unwrap_or(after.len());
                let token = &after[..end];
                let boundary = prev.is_whitespace() || matches!(prev, '(' | '[' | '{' | '"' | '\'');
                if boundary && !token.is_empty() && token.chars().any(|c| !c.is_ascii_digit()) {
                    out.push(token.to_string());
                }
                // `##` — the second `#` follows a `#`, so it is not a boundary.
                prev = token.chars().next_back().unwrap_or('#');
                rest = &after[end..];
            }
        }
    }
    out
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
        let dir = env::temp_dir().join(format!("myco-idx-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Staging dirs are not knowledge: `_inbox/` awaits ingest and `sessions/`
    /// is work logs. Walking them put 1,690 imported files in the graph, and
    /// the `[[TASK_DONE]]` strings quoted inside 596 session transcripts became
    /// one ghost hub with 596 spokes — the thing that made the graph unusable.
    #[test]
    fn the_graph_skips_inbox_and_sessions_but_not_wiki() {
        let root = temp_vault("staging");
        for d in ["wiki", "_inbox", "sessions"] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        fs::write(root.join("wiki/real.md"), "# real\n[[other]]\n").unwrap();
        fs::write(root.join("_inbox/pending.md"), "# pending\n[[TASK_DONE]]\n").unwrap();
        fs::write(root.join("sessions/log.md"), "# log\n[[TASK_DONE]]\n").unwrap();
        // A page legitimately NAMED sessions.md is a wiki page, not a staging dir.
        fs::write(root.join("wiki/sessions.md"), "# sessions\n").unwrap();

        let (sources, _) = collect_files(&root).unwrap();
        let names: Vec<String> = sources
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert!(names.contains(&"real.md".to_string()));
        assert!(names.contains(&"sessions.md".to_string()));
        assert!(!names.contains(&"pending.md".to_string()));
        assert!(!names.contains(&"log.md".to_string()));
    }

    /// `templates/*.md` are scaffolds full of `{{title}}` placeholders; walking
    /// them would put placeholder nodes in the graph. Only the top-level folder
    /// is skipped — `wiki/templates/` is an ordinary user folder.
    #[test]
    fn collect_files_skips_top_level_templates() {
        let root = temp_vault("templates");
        for d in ["templates", "wiki/templates"] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        fs::write(root.join("templates/note.md"), "# {{title}}\n").unwrap();
        fs::write(root.join("wiki/templates/real.md"), "# real\n").unwrap();

        let (sources, linkables) = collect_files(&root).unwrap();
        let names: Vec<String> = sources
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["real.md".to_string()]);
        assert_eq!(linkables.len(), 1);
    }

    /// An NFD-named file (macOS file APIs) must resolve a typed NFC
    /// [[wikilink]] — the name index and the lookup key both normalize.
    #[test]
    fn nfd_filename_resolves_nfc_wikilink() {
        let root = temp_vault("nfd-link");
        fs::create_dir_all(root.join("wiki")).unwrap();
        let nfd_stem = "\u{1112}\u{1161}\u{11AB}\u{1100}\u{1173}\u{11AF}"; // "한글" decomposed
        fs::write(root.join(format!("wiki/{nfd_stem}.md")), "# 한글\n").unwrap();
        fs::write(root.join("wiki/linker.md"), "본문 [[한글]] 링크\n").unwrap();

        let adj = build_link_graph(&root.to_string_lossy()).unwrap();
        // build_link_graph canonicalizes the root (macOS: /var → /private/var),
        // so the expected key must be canonical too.
        let linker = root
            .canonicalize()
            .unwrap()
            .join("wiki/linker.md")
            .to_string_lossy()
            .into_owned();
        let forward = adj.forward.get(&linker).cloned().unwrap_or_default();
        assert_eq!(forward.len(), 1, "NFC link must resolve the NFD file");
        assert!(!adj.unresolved.contains_key(&linker));
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
    fn resolves_path_style_links_to_the_same_page_as_the_bare_stem() {
        let dir = temp_vault("path-style");
        fs::create_dir_all(dir.join("wiki/sub")).unwrap();
        fs::write(
            dir.join("wiki/a.md"),
            "[[wiki/b]] [[wiki/b.md]] [[wiki/sub/b.md]] [[b.md]] [[b]]",
        )
        .unwrap();
        fs::write(dir.join("wiki/b.md"), "# b").unwrap();
        let adj = build_link_graph(dir.to_str().unwrap()).unwrap();
        let src = dir
            .join("wiki/a.md")
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        // All five spellings (bare stem, path+stem, path+ext, nested path+ext,
        // bare filename) resolve to the SAME page — one deduped forward edge,
        // nothing left unresolved.
        assert_eq!(adj.forward.get(&src).map(Vec::len), Some(1));
        assert!(adj.unresolved.is_empty());
    }

    #[test]
    fn strips_trailing_backslash_before_resolving() {
        let dir = temp_vault("backslash-resolve");
        fs::write(dir.join("a.md"), "see [[b\\]]").unwrap();
        fs::write(dir.join("b.md"), "# b").unwrap();
        let adj = build_link_graph(dir.to_str().unwrap()).unwrap();
        assert!(adj.unresolved.is_empty());
        assert_eq!(adj.forward.len(), 1);
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
        assert!(!adj.meta.contains_key(&bkey));
    }

    #[test]
    fn body_tags_ignore_headings_but_take_inline_tags() {
        assert_eq!(body_tags("# Title\n## Sub\n#\n"), Vec::<String>::new());
        assert_eq!(
            body_tags("#todo\nsee #rust and (#ml)"),
            ["todo", "rust", "ml"]
        );
    }

    #[test]
    fn body_tags_skip_code_fences_and_inline_code() {
        let body = "#a\n```sh\n#b comment\n```\n~~~\n#c\n~~~\nuse `#d` not #e\n";
        assert_eq!(body_tags(body), ["a", "e"]);
    }

    #[test]
    fn body_tags_skip_url_fragments_and_glued_hashes() {
        assert_eq!(body_tags("https://x/y#frag a#b &#39; #ok"), ["ok"]);
    }

    #[test]
    fn body_tags_accept_hangul_and_nested_but_not_digits_only() {
        assert_eq!(
            body_tags("#회의록 #tag/sub #123 #v2 #2024-plan"),
            ["회의록", "tag/sub", "v2", "2024-plan"]
        );
    }

    #[test]
    fn body_tags_merge_with_frontmatter_and_dedupe_case_insensitively() {
        let dir = temp_vault("body-tags");
        fs::write(
            dir.join("a.md"),
            "---\ntags: [Rust, ml]\n---\n# Title\nbody #rust #ML #new\n",
        )
        .unwrap();
        // No frontmatter at all: body tags alone still index the page.
        fs::write(dir.join("b.md"), "plain note #solo").unwrap();
        let adj = build_link_graph(dir.to_str().unwrap()).unwrap();
        let key = |n: &str| {
            dir.join(n)
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .into_owned()
        };
        assert_eq!(adj.tags[&key("a.md")], ["Rust", "ml", "new"]);
        assert_eq!(adj.tags[&key("b.md")], ["solo"]);
    }

    /// The incremental cache: a second build with nothing changed must not
    /// read a single file, and a changed/new/deleted file must be picked up.
    /// This is the whole point of the cache — a live ingest rescan re-read the
    /// owner's 1747-file / 26 MB vault every 2 s to see one written file.
    #[test]
    fn a_rescan_reparses_only_what_changed() {
        let root = temp_vault("incremental");
        fs::write(root.join("a.md"), "# a\n[[b]]\n").unwrap();
        fs::write(root.join("b.md"), "# b\n").unwrap();

        let key = |n: &str| {
            root.canonicalize()
                .unwrap()
                .join(n)
                .to_string_lossy()
                .into_owned()
        };
        let build = || build_link_graph(root.to_str().unwrap()).unwrap();

        take_parse_count();
        let first = build();
        assert_eq!(take_parse_count(), 2, "first build parses everything");
        assert_eq!(first.forward[&key("a.md")], [key("b.md")]);

        let second = build();
        assert_eq!(take_parse_count(), 0, "unchanged vault re-parses nothing");
        assert_eq!(second.rev, first.rev, "identical graph, identical rev");
        assert_eq!(second.forward, first.forward);

        // Changed file — different length, so mtime granularity cannot hide it.
        fs::write(root.join("a.md"), "# a\n[[b]] and [[c]] too\n").unwrap();
        let third = build();
        assert_eq!(take_parse_count(), 1, "only the touched file is re-read");
        assert_eq!(third.unresolved[&key("a.md")], ["c"]);
        assert_ne!(third.rev, second.rev);

        // New file — resolves a link that an UNCHANGED file already had.
        fs::write(root.join("c.md"), "# c\n").unwrap();
        let fourth = build();
        assert_eq!(take_parse_count(), 1, "only the new file is read");
        assert_eq!(fourth.forward[&key("a.md")], [key("b.md"), key("c.md")]);
        assert!(!fourth.unresolved.contains_key(&key("a.md")));

        // Deleted file — gone from the graph, and nothing re-read for it.
        fs::remove_file(root.join("b.md")).unwrap();
        let fifth = build();
        assert_eq!(take_parse_count(), 0);
        assert!(!fifth.backward.contains_key(&key("b.md")));
        assert_eq!(fifth.unresolved[&key("a.md")], ["b"]);
    }

    /// Before/after for the cache. Ignored by default (it writes ~1700 files);
    /// run with `cargo test --release -- --ignored --nocapture`.
    #[test]
    #[ignore = "timing benchmark, not a correctness check"]
    fn bench_full_vs_incremental_rescan() {
        let root = temp_vault("bench");
        fs::create_dir_all(root.join("wiki")).unwrap();
        for i in 0..1700 {
            let body = format!(
                "---\ntags: [t{}]\n---\n# n{}\n[[n{}]] [[n{}]]\n{}\n",
                i % 20,
                i,
                (i + 1) % 1700,
                (i + 7) % 1700,
                "lorem ipsum dolor sit amet ".repeat(500)
            );
            fs::write(root.join(format!("wiki/n{i}.md")), body).unwrap();
        }
        let path = root.to_str().unwrap();
        let cold = std::time::Instant::now();
        build_link_graph(path).unwrap();
        let cold = cold.elapsed();
        // BEFORE: what every rescan used to cost — full read+parse with the OS
        // page cache warm. Dropping the cache entry reproduces the old path.
        parse_cache().lock().unwrap().clear();
        let full = std::time::Instant::now();
        build_link_graph(path).unwrap();
        let full = full.elapsed();
        // AFTER: nothing changed since the last build.
        let warm = std::time::Instant::now();
        build_link_graph(path).unwrap();
        let warm = warm.elapsed();
        fs::write(root.join("wiki/n0.md"), "# n0\n[[n1]]\n").unwrap();
        let one = std::time::Instant::now();
        build_link_graph(path).unwrap();
        let one = one.elapsed();
        println!(
            "cold {cold:?} | warm FULL parse (before) {full:?} | no-change rescan {warm:?} | one-file rescan {one:?}"
        );
    }
}
