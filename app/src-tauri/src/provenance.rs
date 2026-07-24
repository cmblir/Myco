// Provenance scanner. For each markdown file in the vault, count claim
// sentences vs cited claims. A "claim" is any non-empty line of body text
// that is not a heading, list marker, code fence or comment. A "cited claim"
// is one that contains at least one `[^src-…]` footnote reference or a
// `<cite n="N"/>` tag.

use serde::Serialize;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

/// A source a page cites, resolved from its `[^src-<slug>]` footnote to the
/// immutable `raw/<slug>.md` file behind it. For a source imported from an AI
/// conversation the raw file carries the provenance the importer recorded
/// (`source:` vendor, `conversation_id:`, `created:`); a hand-authored source
/// has only the slug/title. Lets the Provenance view answer "which conversation
/// did this page come from," not just "how much of it is cited."
#[derive(Debug, Clone, Serialize)]
pub struct SourceRef {
    /// The raw stem, i.e. the footnote id minus `src-` (e.g. `chatgpt-ab12`).
    pub slug: String,
    /// Vendor from the raw file's `source:` frontmatter (chatgpt | claude |
    /// claude-code | codex), or empty for a hand-authored source.
    pub kind: String,
    /// `title:` frontmatter, else the first `# ` heading, else none.
    pub title: Option<String>,
    /// The vendor conversation/session id, when the source was imported.
    pub conversation_id: Option<String>,
    /// `created:` frontmatter as written (an epoch or a date string).
    pub created: Option<String>,
    /// False when no `raw/<slug>.md` backs the citation (a dangling source).
    pub resolved: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProvenanceRow {
    pub path: String,
    pub name: String,
    pub cited: u32,
    pub total: u32,
    /// Distinct sources this page cites, resolved to their raw provenance.
    pub sources: Vec<SourceRef>,
}

pub fn scan_provenance(vault_path: &str) -> Result<Vec<ProvenanceRow>, String> {
    let root = Path::new(vault_path)
        .canonicalize()
        .map_err(|e| format!("canonicalize failed: {e}"))?;
    if !root.is_dir() {
        return Err(format!("not a directory: {vault_path}"));
    }
    let files = collect_markdown(&root).map_err(|e| format!("walk failed: {e}"))?;
    // Index the immutable raw sources once so resolving each page's citations is
    // a map lookup, not a re-read per citation. Read-only — raw/ is never touched.
    let raw_index = build_raw_index(&root);
    let mut rows = Vec::with_capacity(files.len());
    for file in &files {
        // Skip files larger than 2 MB so a single pathological file can't dominate
        // the whole-vault provenance scan (matches search_vault's cap).
        if std::fs::metadata(file).map(|m| m.len()).unwrap_or(0) > 2 * 1024 * 1024 {
            continue;
        }
        let raw = match std::fs::read_to_string(file) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let (cited, total, slugs) = scan_page(&raw);
        if total == 0 {
            continue;
        }
        let sources = slugs
            .iter()
            .map(|stem| {
                raw_index.get(stem).cloned().unwrap_or_else(|| SourceRef {
                    slug: stem.clone(),
                    kind: String::new(),
                    title: None,
                    conversation_id: None,
                    created: None,
                    resolved: false,
                })
            })
            .collect();
        rows.push(ProvenanceRow {
            path: file.to_string_lossy().into_owned(),
            name: file
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string(),
            cited,
            total,
            sources,
        });
    }
    rows.sort_by(|a, b| {
        let pa = a.cited as f64 / a.total.max(1) as f64;
        let pb = b.cited as f64 / b.total.max(1) as f64;
        pa.partial_cmp(&pb).unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(rows)
}

#[cfg(test)]
fn count_claims(text: &str) -> (u32, u32) {
    let (cited, total, _) = scan_page(text);
    (cited, total)
}

/// Count claim/cited lines AND collect the distinct raw source slugs the page
/// cites (footnote id minus `src-`), sharing one frontmatter/code-skipping pass.
fn scan_page(text: &str) -> (u32, u32, BTreeSet<String>) {
    let mut total = 0u32;
    let mut cited = 0u32;
    let mut slugs = BTreeSet::new();
    let mut in_frontmatter = false;
    let mut frontmatter_done = false;
    let mut in_code = false;
    let mut seen_content = false;
    for line in text.lines() {
        let trimmed = line.trim();
        // YAML frontmatter opens ONLY when `---` is the first non-empty line of
        // the file. A `---` later in the body is a Markdown thematic break, not
        // frontmatter, and must not swallow the claims that follow it.
        if !seen_content && !frontmatter_done && !in_frontmatter && trimmed == "---" {
            in_frontmatter = true;
            seen_content = true;
            continue;
        }
        if in_frontmatter {
            if trimmed == "---" {
                in_frontmatter = false;
                frontmatter_done = true;
            }
            continue;
        }
        if trimmed.starts_with("```") {
            in_code = !in_code;
            seen_content = true;
            continue;
        }
        if in_code {
            continue;
        }
        if trimmed.is_empty() {
            continue;
        }
        seen_content = true;
        // Collect sources from any body line (a prose reference or the footnote
        // definition both name the same source), so a page's sources are found
        // even when its citations live only in the definition block.
        extract_src_slugs(trimmed, &mut slugs);
        if is_non_claim_line(trimmed) {
            continue;
        }
        total += 1;
        if trimmed.contains("[^src-") || trimmed.contains("<cite n=\"") {
            cited += 1;
        }
    }
    (cited, total, slugs)
}

/// Pull every `[^src-<stem>]` footnote out of a line, inserting each `<stem>`
/// (the raw filename behind the citation). Tolerant of several per line.
pub(crate) fn extract_src_slugs(line: &str, out: &mut BTreeSet<String>) {
    let mut rest = line;
    while let Some(pos) = rest.find("[^src-") {
        let after = &rest[pos + "[^src-".len()..];
        match after.find(']') {
            Some(end) => {
                let stem = &after[..end];
                if !stem.is_empty() {
                    out.insert(stem.to_string());
                }
                rest = &after[end + 1..];
            }
            None => break,
        }
    }
}

/// Read every `<root>/raw/**/*.md` once (recursively — sources may live in
/// subdirectories, e.g. `raw/conversations/<id>.md`), mapping each file stem to
/// the provenance recorded in its frontmatter. Missing raw/ (a young vault)
/// yields an empty index.
pub(crate) fn build_raw_index(root: &Path) -> HashMap<String, SourceRef> {
    let mut idx = HashMap::new();
    let raw_dir = root.join("raw");
    if !raw_dir.is_dir() {
        return idx;
    }
    let Ok(files) = collect_markdown(&raw_dir) else {
        return idx;
    };
    for p in files {
        let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        // Only the frontmatter matters; cap the read like the main scan.
        if std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0) > 2 * 1024 * 1024 {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(&p) {
            idx.insert(stem.to_string(), parse_source_ref(stem, &text));
        }
    }
    idx
}

/// Parse a raw source file's frontmatter into a `SourceRef`. Uses the same
/// gray_matter YAML engine as the indexer, so it agrees on what a field is.
fn parse_source_ref(stem: &str, text: &str) -> SourceRef {
    use gray_matter::Pod;
    let mut kind = String::new();
    let mut title = None;
    let mut conversation_id = None;
    let mut created = None;
    if let Ok(parsed) = gray_matter::Matter::<gray_matter::engine::YAML>::new().parse(text) {
        if let Some(Pod::Hash(map)) = parsed.data {
            let get_str = |k: &str| match map.get(k) {
                Some(Pod::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
                _ => None,
            };
            kind = get_str("source").unwrap_or_default();
            title = get_str("title");
            conversation_id = get_str("conversation_id");
            // `created` is an epoch integer from the importer, a date string when
            // hand-authored; keep whichever form and let the UI format it.
            created = match map.get("created") {
                Some(Pod::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
                Some(Pod::Integer(n)) => Some(n.to_string()),
                _ => None,
            };
        }
    }
    if title.is_none() {
        title = first_h1(text);
    }
    SourceRef {
        slug: stem.to_string(),
        kind,
        title,
        conversation_id,
        created,
        resolved: true,
    }
}

/// The first `# ` heading in the body, as a title fallback.
fn first_h1(text: &str) -> Option<String> {
    text.lines().find_map(|l| {
        let t = l.trim();
        t.strip_prefix("# ")
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    })
}

// Lines that carry markdown structure rather than a prose claim: headings,
// blockquotes, unordered bullets (-, *, +), ordered list items (1. / 1)),
// thematic breaks (--- / ***), images, and table rows/separators (|...|).
fn is_non_claim_line(trimmed: &str) -> bool {
    trimmed.starts_with('#')
        || trimmed.starts_with('>')
        || trimmed.starts_with("- ")
        || trimmed.starts_with("* ")
        || trimmed.starts_with("+ ")
        || trimmed.starts_with("---")
        || trimmed.starts_with("***")
        || trimmed.starts_with("![")
        || is_footnote_definition(trimmed)
        || is_ordered_list_item(trimmed)
        || is_table_row(trimmed)
}

// A footnote DEFINITION line — `[^id]: ...` — is structural metadata (it declares
// where a citation points), not a prose claim. The schema mandates one such line
// per source at the bottom of every page, e.g. `[^src-x]: [[source-x]]`. Without
// this exclusion each definition counts as BOTH a claim (total) and a cited claim
// (it contains `[^src-`), inflating coverage toward 100% and hiding the exact
// under-cited pages the Provenance view exists to surface.
fn is_footnote_definition(s: &str) -> bool {
    let Some(rest) = s.strip_prefix("[^") else {
        return false;
    };
    match rest.find(']') {
        // `[^label]:` — the label must close with `]` immediately followed by `:`.
        Some(close) => rest[close + 1..].starts_with(':'),
        None => false,
    }
}

fn is_ordered_list_item(s: &str) -> bool {
    let digits = s.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits == 0 {
        return false;
    }
    let rest = &s[digits..];
    rest.starts_with(". ") || rest.starts_with(") ")
}

fn is_table_row(s: &str) -> bool {
    s.len() > 1 && s.starts_with('|') && s.ends_with('|')
}

fn collect_markdown(dir: &Path) -> std::io::Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for entry in std::fs::read_dir(&d)? {
            let e = entry?;
            let name = e.file_name();
            if name
                .to_str()
                .is_some_and(|s| s.starts_with('.') || s == "node_modules" || s == "target")
            {
                continue;
            }
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().and_then(|s| s.to_str()) == Some("md") {
                out.push(p);
            }
        }
    }
    out.sort();
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_cited_vs_total() {
        let text =
            "---\ntitle: A\n---\n# Heading\n\nA claim without cite.\nA claim with cite[^src-x].\n";
        let (cited, total) = count_claims(text);
        assert_eq!(total, 2);
        assert_eq!(cited, 1);
    }

    #[test]
    fn skips_code_blocks() {
        let text = "Real claim.\n```\nfake claim inside code\n```\nAnother real.\n";
        let (_, total) = count_claims(text);
        assert_eq!(total, 2);
    }

    #[test]
    fn detects_cite_tag() {
        let text = "Body with cite tag.<cite n=\"1\"/>\n";
        let (cited, total) = count_claims(text);
        assert_eq!(cited, 1);
        assert_eq!(total, 1);
    }

    #[test]
    fn body_thematic_break_is_not_frontmatter() {
        // A `---` mid-body is a horizontal rule; claims after it must still count.
        let text = "Claim one.\n\n---\n\nClaim two[^src-a].\n";
        let (cited, total) = count_claims(text);
        assert_eq!(total, 2);
        assert_eq!(cited, 1);
    }

    #[test]
    fn skips_ordered_lists_bullets_and_tables() {
        let text = "1. step one\n+ a bullet\n|a|b|\n|---|---|\n| c | d |\nReal claim.\n";
        let (_, total) = count_claims(text);
        assert_eq!(total, 1);
    }

    #[test]
    fn footnote_definitions_are_not_counted_as_claims() {
        // A page with one cited prose claim plus two footnote-definition lines:
        // only the prose claim must count, and it is cited.
        let text = "A claim with cite[^src-a].\n\n[^src-a]: [[source-a]]\n[^src-b]: [[source-b]]\n";
        let (cited, total) = count_claims(text);
        assert_eq!(total, 1, "footnote definitions must not inflate total");
        assert_eq!(cited, 1);

        // A page whose only `[^src-` occurrences are definitions has zero claims.
        let defs_only = "# Title\n\n[^src-a]: [[source-a]]\n";
        let (cited2, total2) = count_claims(defs_only);
        assert_eq!(total2, 0);
        assert_eq!(cited2, 0);
    }

    #[test]
    fn extract_src_slugs_finds_distinct_stems() {
        let mut out = BTreeSet::new();
        extract_src_slugs("a[^src-x] and b[^src-y] and again[^src-x].", &mut out);
        assert_eq!(out.len(), 2);
        assert!(out.contains("x"));
        assert!(out.contains("y"));
        // A plain footnote (not a source) is ignored.
        let mut only = BTreeSet::new();
        extract_src_slugs("a note[^1] and a source[^src-z].", &mut only);
        assert_eq!(only.len(), 1);
        assert!(only.contains("z"));
    }

    #[test]
    fn resolves_a_citation_to_its_raw_source_provenance() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("raw")).unwrap();
        std::fs::create_dir_all(root.join("wiki")).unwrap();
        std::fs::write(
            root.join("raw/chatgpt-ab12.md"),
            "---\nsource: chatgpt\nconversation_id: ab12\ncreated: 1700000000\n---\n# How attention works\n",
        )
        .unwrap();
        std::fs::write(
            root.join("wiki/attention.md"),
            "---\ntitle: Attention\n---\nSelf-attention scales with length[^src-chatgpt-ab12].\n\n[^src-chatgpt-ab12]: [[source-chatgpt-ab12]]\n",
        )
        .unwrap();

        let rows = scan_provenance(root.to_str().unwrap()).unwrap();
        let row = rows.iter().find(|r| r.name == "attention.md").unwrap();
        assert_eq!(row.sources.len(), 1);
        let s = &row.sources[0];
        assert_eq!(s.slug, "chatgpt-ab12");
        assert_eq!(s.kind, "chatgpt");
        assert_eq!(s.conversation_id.as_deref(), Some("ab12"));
        assert_eq!(s.created.as_deref(), Some("1700000000"));
        assert_eq!(s.title.as_deref(), Some("How attention works"));
        assert!(s.resolved);
    }

    #[test]
    fn a_citation_with_no_raw_file_is_unresolved() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("wiki")).unwrap();
        std::fs::write(root.join("wiki/x.md"), "A claim[^src-ghost].\n").unwrap();

        let rows = scan_provenance(root.to_str().unwrap()).unwrap();
        let row = rows.iter().find(|r| r.name == "x.md").unwrap();
        assert_eq!(row.sources.len(), 1);
        assert_eq!(row.sources[0].slug, "ghost");
        assert!(!row.sources[0].resolved);
    }

    #[test]
    fn footnote_definition_detection() {
        assert!(is_footnote_definition("[^src-x]: [[source-x]]"));
        assert!(is_footnote_definition("[^1]: a note"));
        // A reference (not a definition) inside prose is still a claim.
        assert!(!is_footnote_definition(
            "A sentence ending in a cite[^src-x]."
        ));
        assert!(!is_footnote_definition("[not a footnote]"));
    }
}
