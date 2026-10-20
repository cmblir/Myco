// Deterministic ingest validator (Phase 1f, retrieval-first redesign). Runs in
// Rust instead of the LLM so ingest gains a hard gate that doesn't depend on
// the model noticing its own mistakes: dangling citations and malformed
// frontmatter are ERRORS; unresolved wikilinks and a stale `source_count` are
// WARNINGS the agent should fix but that don't block the write.

use crate::local_llm::WIKI_TYPES;
use crate::{index, parser, provenance};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

// Structural/meta page exemption — mirrors mcp_native's LINT_SKIP_NAMES /
// LINT_META_TYPES so the same pages ("index.md", "log.md", `type: overview`
// or `type: meta`) are exempt everywhere in this codebase. Deliberately does
// NOT exempt by stem (e.g. `pipeline::is_knowledge_page`'s `source-*`
// carve-out) — a source-summary page is the most citation-dense output of
// every ingest and must be validated like any other page.
const SKIP_NAMES: [&str; 2] = ["index.md", "log.md"];
const META_TYPES: [&str; 2] = ["overview", "meta"];

#[derive(Debug, Serialize, Clone)]
pub struct Issue {
    pub page: String,
    pub kind: String,
    pub detail: String,
}

#[derive(Debug, Serialize, Clone, Default)]
pub struct ValidationReport {
    pub errors: Vec<Issue>,
    pub warnings: Vec<Issue>,
}

impl ValidationReport {
    pub fn ok(&self) -> bool {
        self.errors.is_empty()
    }
}

const CONFIDENCE: [&str; 3] = ["high", "medium", "low"];
const STATUS: [&str; 3] = ["active", "superseded", "disputed"];

/// Definitions and references share one visible-body pass. Fence length and
/// marker must match so a shorter example fence cannot expose forged sources.
fn source_citations(text: &str) -> (BTreeSet<String>, BTreeMap<String, Vec<String>>) {
    let mut slugs = BTreeSet::new();
    let mut definitions = BTreeMap::<String, Vec<String>>::new();
    let (mut seen_content, mut frontmatter) = (false, false);
    let mut fence: Option<(u8, usize)> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if !seen_content && !trimmed.is_empty() {
            seen_content = true;
            if trimmed == "---" {
                frontmatter = true;
                continue;
            }
        }
        if frontmatter {
            if trimmed == "---" {
                frontmatter = false;
            }
            continue;
        }
        let indentation = line.bytes().take_while(|byte| *byte == b' ').count();
        if indentation >= 4 || line[indentation..].starts_with('\t') {
            continue;
        }
        let bytes = trimmed.as_bytes();
        let marker = bytes.first().copied();
        let length = marker
            .map(|marker| bytes.iter().take_while(|byte| **byte == marker).count())
            .unwrap_or(0);
        if let Some((open_marker, open_length)) = fence {
            if marker == Some(open_marker)
                && length >= open_length
                && trimmed[length..].trim().is_empty()
            {
                fence = None;
            }
            continue;
        }
        if matches!(marker, Some(b'`' | b'~')) && length >= 3 {
            fence = Some((marker.unwrap_or_default(), length));
            continue;
        }
        provenance::extract_src_slugs(line, &mut slugs);
        if let Some((slug, definition)) = trimmed
            .strip_prefix("[^src-")
            .and_then(|rest| rest.split_once("]:"))
        {
            let token = definition.split_whitespace().next().unwrap_or("");
            let token = token
                .strip_prefix('`')
                .and_then(|rest| rest.strip_suffix('`'))
                .or_else(|| {
                    token
                        .strip_prefix('<')
                        .and_then(|rest| rest.strip_suffix('>'))
                })
                .unwrap_or(token);
            definitions
                .entry(slug.to_string())
                .or_default()
                .push(token.to_string());
        }
    }
    (slugs, definitions)
}

fn is_explicit_source_path(token: &str) -> bool {
    !token.starts_with("[[")
        && (token.contains(['/', '\\']) || Path::new(token).extension().is_some())
}

/// An alias is valid only for the exact immutable Markdown source it names.
/// Reuse the vault's no-symlink component guard and canonical confinement.
fn exact_raw_source_exists(root: &Path, token: &str) -> bool {
    if !token.starts_with("raw/")
        || token.contains('\\')
        || token.chars().any(char::is_control)
        || token
            .split('/')
            .any(|component| component.is_empty() || matches!(component, "." | ".."))
        || Path::new(token)
            .extension()
            .and_then(|extension| extension.to_str())
            != Some("md")
    {
        return false;
    }
    let path = root.join(token);
    let Ok(guarded) = crate::vault::confine_delete_path(root, &path.to_string_lossy()) else {
        return false;
    };
    let Ok(confined) = crate::vault::confine_path(root, &guarded.to_string_lossy()) else {
        return false;
    };
    confined.starts_with(root.join("raw")) && confined.is_file()
}

/// Only absent legacy flat citations may follow one unambiguous archive move.
/// Explicit aliases and revision paths retain their exact-source contract.
fn explicit_raw_source_exists(root: &Path, slug: &str, token: &str) -> bool {
    if exact_raw_source_exists(root, token) {
        return true;
    }
    if token != format!("raw/{slug}.md")
        || slug.contains(['/', '\\'])
        || slug.chars().any(char::is_control)
        || !matches!(std::fs::symlink_metadata(root.join(token)), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
        || crate::vault::confine_delete_path(root, &root.join(token).to_string_lossy()).is_err()
    {
        return false;
    }
    let archive = root.join("raw/archive");
    if crate::vault::confine_delete_path(root, &archive.to_string_lossy()).is_err()
        || !archive.is_dir()
    {
        return false;
    }
    let name = Path::new(token).file_name();
    let mut matches = 0;
    let mut stack = vec![archive];
    while let Some(dir) = stack.pop() {
        if crate::vault::confine_delete_path(root, &dir.to_string_lossy()).is_err() {
            return false;
        }
        for (entry, kind) in crate::vault::vault_entries(&dir) {
            let path = entry.path();
            if kind.is_dir() {
                stack.push(path);
            } else if path.file_name() == name {
                let Ok(relative) = path.strip_prefix(root) else {
                    return false;
                };
                if !exact_raw_source_exists(root, &relative.to_string_lossy()) {
                    return false;
                }
                matches += 1;
                if matches > 1 {
                    return false;
                }
            }
        }
    }
    matches == 1
}

/// Validate the given vault-relative pages against the Balanced ingest policy.
/// `root` must already be the vault's canonical root (callers confine it).
/// Non-`wiki/` paths, `index.md`/`log.md`, and `type: overview`/`type: meta`
/// pages are exempt and produce no issues at all. Every path is re-confined to
/// `root` before it is read, so a `changed_rels` entry that tries to escape
/// the vault (e.g. `wiki/../../../etc/passwd`) is skipped rather than read.
pub fn validate_pages(root: &Path, changed_rels: &[String]) -> ValidationReport {
    let mut rep = ValidationReport::default();
    // Recursive raw/ index (dangling-citation lookup) and the vault-wide
    // wikilink name index — both built once, over the whole vault, not just
    // the changed set, since a changed page may cite/link anywhere.
    let mut raw = None;
    let (_sources, linkables): (Vec<PathBuf>, Vec<PathBuf>) =
        index::collect_files(root).unwrap_or_default();
    let names = index::build_name_index(&linkables);

    for rel in changed_rels {
        let rel = rel.replace('\\', "/");
        if !rel.starts_with("wiki/") {
            continue; // non-wiki path
        }
        // Confine before reading: `rel.starts_with("wiki/")` is a string check
        // and does not resolve `..`, so a `changed_rels` entry like
        // "wiki/../../../etc/passwd" would otherwise read outside the vault.
        // `confine_path` canonicalizes and rejects anything that lands outside
        // `root`; a rejected path is skipped, not read.
        let abs = root.join(&rel);
        let Ok(confined) = crate::vault::confine_path(root, &abs.to_string_lossy()) else {
            continue; // traversal / outside vault root
        };
        let Ok(text) = std::fs::read_to_string(&confined) else {
            continue;
        };

        let name = confined.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if SKIP_NAMES.contains(&name) {
            continue; // structural page (index.md / log.md)
        }

        let fm = crate::vault::read_file(&confined.to_string_lossy())
            .ok()
            .map(|f| f.frontmatter);
        let is_meta = fm
            .as_ref()
            .and_then(|v| v.get("type"))
            .and_then(|v| v.as_str())
            .map(|t| META_TYPES.contains(&t))
            .unwrap_or(false);
        if is_meta {
            continue; // structural overview/meta page
        }

        // `read_file` returns `Value::Null` (not an Err) for a file with no
        // parseable YAML frontmatter block, so both "read_file failed" and
        // "no frontmatter" collapse to the same missing-frontmatter error.
        match fm.filter(|v| !v.is_null()) {
            None => rep.errors.push(Issue {
                page: rel.clone(),
                kind: "missing_frontmatter".into(),
                detail: "no YAML frontmatter".into(),
            }),
            Some(v) => {
                let get = |k: &str| v.get(k).and_then(|x| x.as_str()).map(str::to_string);
                for k in ["title", "type", "created", "confidence", "status"] {
                    if get(k).filter(|s| !s.trim().is_empty()).is_none() {
                        rep.errors.push(Issue {
                            page: rel.clone(),
                            kind: "missing_frontmatter".into(),
                            detail: format!("required field `{k}` missing"),
                        });
                    }
                }
                if let Some(t) = get("type") {
                    if !WIKI_TYPES.contains(&t.as_str()) {
                        rep.errors.push(Issue {
                            page: rel.clone(),
                            kind: "invalid_frontmatter".into(),
                            detail: format!("type `{t}` not in {WIKI_TYPES:?}"),
                        });
                    }
                }
                if let Some(c) = get("confidence") {
                    if !CONFIDENCE.contains(&c.as_str()) {
                        rep.errors.push(Issue {
                            page: rel.clone(),
                            kind: "invalid_frontmatter".into(),
                            detail: format!("confidence `{c}` invalid"),
                        });
                    }
                }
                if let Some(st) = get("status") {
                    if !STATUS.contains(&st.as_str()) {
                        rep.errors.push(Issue {
                            page: rel.clone(),
                            kind: "invalid_frontmatter".into(),
                            detail: format!("status `{st}` invalid"),
                        });
                    }
                    if st == "superseded" && v.get("superseded_by").is_none() {
                        rep.warnings.push(Issue {
                            page: rel.clone(),
                            kind: "missing_superseded_by".into(),
                            detail: "status=superseded needs superseded_by".into(),
                        });
                    }
                }

                // source_count vs distinct [^src-*] citations.
                let (slugs, definitions) = source_citations(&text);
                if let Some(n) = v.get("source_count").and_then(|x| x.as_u64()) {
                    if n as usize != slugs.len() {
                        rep.warnings.push(Issue {
                            page: rel.clone(),
                            kind: "source_count_mismatch".into(),
                            detail: format!(
                                "source_count={n} but {} distinct citations",
                                slugs.len()
                            ),
                        });
                    }
                }
                // Citations must resolve to an immutable raw/ source (ERROR).
                for s in &slugs {
                    let definition = definitions.get(s);
                    let duplicate = definition.is_some_and(|definitions| definitions.len() != 1);
                    let explicit = definition
                        .and_then(|definitions| definitions.first())
                        .filter(|token| is_explicit_source_path(token));
                    let resolves = if duplicate {
                        false
                    } else if let Some(token) = explicit {
                        explicit_raw_source_exists(root, s, token)
                    } else {
                        raw.get_or_insert_with(|| provenance::build_raw_index(root))
                            .contains_key(s)
                    };
                    if !resolves {
                        rep.errors.push(Issue {
                            page: rel.clone(),
                            kind: "dangling_citation".into(),
                            detail: if duplicate {
                                format!("[^src-{s}] has multiple footnote definitions")
                            } else if explicit.is_some() {
                                format!("[^src-{s}] names no valid exact raw/ Markdown source")
                            } else {
                                format!("[^src-{s}] has no raw/{s}.md")
                            },
                        });
                    }
                }
            }
        }

        // Wikilinks must resolve to a page in the vault (WARNING).
        for link in parser::parse_links_from_text(&text) {
            let key = link
                .split('#')
                .next()
                .unwrap_or(&link)
                .trim()
                .to_lowercase();
            if !key.is_empty() && !names.contains_key(&key) {
                rep.warnings.push(Issue {
                    page: rel.clone(),
                    kind: "unresolved_wikilink".into(),
                    detail: format!("[[{link}]] resolves to no page"),
                });
            }
        }
    }
    rep
}

/// The wiki lint's findings, tiered the way the lint report renders them.
/// `critical`/`warning` are the ingest validator's own errors/warnings; `info`
/// is the freshness/hedging pass that only the lint runs.
#[derive(Debug, Serialize, Clone, Default)]
pub struct LintReport {
    pub critical: Vec<Issue>,
    pub warning: Vec<Issue>,
    pub info: Vec<Issue>,
}

/// The hedge phrases the lint checklist names verbatim — a literal scan, no
/// model involved.
const HEDGES: [&str; 3] = ["대체로", "일반적으로", "in general"];
const STALE_SECS: u64 = 30 * 24 * 60 * 60;

/// Deterministic wiki lint over `pages` (vault-relative, already filtered to
/// knowledge pages by the caller — the UI owns that classifier). Composes
/// `validate_pages` with the checks the ingest gate has no reason to run:
/// freshness, unsupported `confidence: high`, hedged single-source claims and
/// a missing `## Disputed` section. `now` is epoch seconds, injected so the
/// freshness check is testable.
///
/// Unresolved wikilinks are dropped from the validator's warnings on purpose:
/// the UI re-derives link gaps from the link graph, where the
/// malformed-placeholder filter (`isMalformedLinkName`) lives, so reporting
/// them here too would double-count them AND re-list the placeholders the gap
/// panel already buckets away.
pub fn lint_local(root: &Path, pages: &[String], now: u64) -> LintReport {
    let base = validate_pages(root, pages);
    let mut rep = LintReport {
        critical: base.errors,
        warning: base
            .warnings
            .into_iter()
            .filter(|w| w.kind != "unresolved_wikilink")
            .collect(),
        info: Vec::new(),
    };

    // ponytail: this re-reads each page that validate_pages just read. Kept
    // that way so the ingest gate stays untouched; fold the two passes together
    // only if a huge vault makes the double read measurable.
    for rel in pages {
        let rel = rel.replace('\\', "/");
        if !rel.starts_with("wiki/") {
            continue;
        }
        let abs = root.join(&rel);
        let Ok(confined) = crate::vault::confine_path(root, &abs.to_string_lossy()) else {
            continue; // traversal / outside vault root
        };
        let name = confined.file_name().and_then(|s| s.to_str()).unwrap_or("");
        if SKIP_NAMES.contains(&name) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&confined) else {
            continue;
        };
        let Some(fm) = crate::vault::read_file(&confined.to_string_lossy())
            .ok()
            .map(|f| f.frontmatter)
            .filter(|v| !v.is_null())
        else {
            continue; // no frontmatter: validate_pages already flagged it
        };
        let get = |k: &str| fm.get(k).and_then(|x| x.as_str()).map(str::to_string);
        if get("type")
            .map(|t| META_TYPES.contains(&t.as_str()))
            .unwrap_or(false)
        {
            continue; // structural overview/meta page
        }
        let status = get("status").unwrap_or_default();
        let sources = fm.get("source_count").and_then(|x| x.as_u64());

        if status == "disputed" && !has_disputed_section(&text) {
            rep.warning.push(Issue {
                page: rel.clone(),
                kind: "missing_disputed_section".into(),
                detail: "status=disputed but no `## Disputed` heading".into(),
            });
        }
        if get("confidence").as_deref() == Some("high") && sources.unwrap_or(0) < 2 {
            rep.warning.push(Issue {
                page: rel.clone(),
                kind: "weak_confidence".into(),
                detail: format!("confidence=high with source_count={}", sources.unwrap_or(0)),
            });
        }
        if status == "active" {
            if let Some(age) = age_secs(&confined, now) {
                if age > STALE_SECS {
                    rep.info.push(Issue {
                        page: rel.clone(),
                        kind: "stale_page".into(),
                        detail: format!("status=active, not modified in {} days", age / 86_400),
                    });
                }
            }
        }
        if sources == Some(1) {
            if let Some(h) = HEDGES.iter().find(|h| text.contains(**h)) {
                rep.info.push(Issue {
                    page: rel.clone(),
                    kind: "hedged_claim".into(),
                    detail: format!("source_count=1 and the body says \"{h}\""),
                });
            }
        }
    }
    rep
}

/// A `## Disputed` heading, in any language's wording as long as the word is
/// there — matched on the heading line only, so a passing body mention of the
/// word does not satisfy the check.
fn has_disputed_section(text: &str) -> bool {
    text.lines().any(|l| {
        let t = l.trim_start();
        t.starts_with('#') && t.to_lowercase().contains("disputed")
    })
}

/// Seconds since the file was last modified, or None if the clock/metadata
/// disagree (a file stamped in the future is not "stale").
fn age_secs(path: &Path, now: u64) -> Option<u64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let secs = modified
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    now.checked_sub(secs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    // The page the OFFLINE (extractive) ingest writes, emitted verbatim from
    // `app/src/lib/extractiveIngest.ts::extractiveSummary` — the one path that
    // builds a wiki page without a model, so nothing else proves the two
    // languages still agree on the contract. Regenerate this fixture from that
    // function if its output changes; a drift here is a real ingest failure.
    const OFFLINE_INGEST_PAGE: &str = r#"---
title: "Source: Retrieval notes"
type: source-summary
tags:
  - source-summary
  - retrieval
created: 2026-09-06
last_updated: 2026-09-06
source_count: 1
confidence: low
status: active
---

# Source: Retrieval notes

_Extractive summary — every line below is quoted verbatim from `raw/retrieval-notes.md`. No model read this source, so nothing here is paraphrased and nothing is inferred._

- Hybrid retrieval fuses a dense vector arm with a lexical arm, and the fusion is what recovers the queries neither arm answers alone. [^src-retrieval-notes]
- Reciprocal rank fusion needs no score calibration between the two arms, which is exactly why it survives an embedding-model swap. [^src-retrieval-notes]

## Related

- [[attention-mechanism]]

[^src-retrieval-notes]: [[source-retrieval-notes]]
"#;

    #[test]
    fn offline_ingest_page_passes_validation() {
        let (_d, root) = vault(&[
            ("raw/retrieval-notes.md", "---\ntitle: Retrieval notes\n---\nbody\n"),
            (
                "wiki/attention-mechanism.md",
                "---\ntitle: Attention\ntype: concept\ncreated: 2026-01-01\nconfidence: high\nstatus: active\n---\n",
            ),
            ("wiki/source-retrieval-notes.md", OFFLINE_INGEST_PAGE),
        ]);
        let rep = validate_pages(&root, &["wiki/source-retrieval-notes.md".to_string()]);
        assert!(
            rep.errors.is_empty(),
            "offline ingest page must validate, got {:?}",
            rep.errors
        );
    }

    // The same function over a SESSION transcript: the title is the
    // transcript's first heading + agent + date (lib/sessionTitle.ts), and a
    // transcript candidate is linked through its `source-` summary, never by
    // its own stem, which resolves to nothing in wiki/.
    const OFFLINE_INGEST_SESSION_PAGE: &str = r#"---
title: "Source: 그래프 범례를 접을 수 있게 해줘 · Codex · 2026-07-27"
type: source-summary
tags:
  - source-summary
created: 2026-09-06
last_updated: 2026-09-06
source_count: 1
confidence: low
status: active
---

# Source: 그래프 범례를 접을 수 있게 해줘 · Codex · 2026-07-27

_Extractive summary — every line below is quoted verbatim from `raw/codex-019de763-362b-7613-bcfd-5c5e0e8ff9be.md`. No model read this source, so nothing here is paraphrased and nothing is inferred._

- 그래프 범례를 접을 수 있게 해줘. 왼쪽 갭 레일도 같이 접히면 좋겠어. [^src-codex-019de763-362b-7613-bcfd-5c5e0e8ff9be]
- The legend rail now collapses to a thin edge tab, and the canvas resizes to take the freed width. [^src-codex-019de763-362b-7613-bcfd-5c5e0e8ff9be]

## Related

- [[attention-mechanism]]
- [[source-claude-code-064ddbe4-251d-4da1-8315-da096a5b75ff]]

[^src-codex-019de763-362b-7613-bcfd-5c5e0e8ff9be]: [[source-codex-019de763-362b-7613-bcfd-5c5e0e8ff9be]]
"#;

    #[test]
    fn offline_ingest_session_page_passes_validation_with_no_dangling_link() {
        let cc = "wiki/source-claude-code-064ddbe4-251d-4da1-8315-da096a5b75ff.md";
        let page = "wiki/source-codex-019de763-362b-7613-bcfd-5c5e0e8ff9be.md";
        let (_d, root) = vault(&[
            (
                "raw/codex-019de763-362b-7613-bcfd-5c5e0e8ff9be.md",
                "# codex\n\nbody\n",
            ),
            ("wiki/attention-mechanism.md", GOOD_FM),
            (cc, GOOD_FM),
            (page, OFFLINE_INGEST_SESSION_PAGE),
        ]);
        let rep = validate_pages(&root, &[page.to_string()]);
        assert!(rep.errors.is_empty(), "got {:?}", rep.errors);
        let unresolved: Vec<_> = rep
            .warnings
            .iter()
            .filter(|w| w.kind == "unresolved_wikilink")
            .collect();
        assert!(unresolved.is_empty(), "got {unresolved:?}");
    }

    // Returns the TempDir (kept alive so its Drop doesn't delete the vault out
    // from under a test) alongside its CANONICAL root. `confine_path` (used by
    // `validate_pages` since the path-traversal fix) canonicalizes and compares
    // against `root`, and on macOS `tempfile::tempdir()`'s path is itself a
    // symlink (`/var/...` -> `/private/var/...`), so passing the raw `TempDir`
    // path as root would make every confinement check fail and every page get
    // silently skipped — production is unaffected because `open_vault` always
    // canonicalizes before `validate_pages` ever sees a root.
    fn vault(files: &[(&str, &str)]) -> (tempfile::TempDir, PathBuf) {
        let d = tempfile::tempdir().unwrap();
        for (rel, body) in files {
            let p = d.path().join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, body).unwrap();
        }
        let root = d.path().canonicalize().unwrap();
        (d, root)
    }
    const GOOD_FM: &str = "---\ntitle: A\ntype: concept\ncreated: 2026-01-01\nsource_count: 1\nconfidence: high\nstatus: active\n---\n";

    #[test]
    fn dangling_citation_is_error() {
        let (_d, root) = vault(&[
            ("raw/real.md", "# Real\nbody"),
            (
                "wiki/a.md",
                &format!("{GOOD_FM}\nBody claim.[^src-real]\nGhost claim.[^src-ghost]\n"),
            ),
        ]);
        let r = validate_pages(&root, &["wiki/a.md".into()]);
        assert!(r
            .errors
            .iter()
            .any(|e| e.kind == "dangling_citation" && e.detail.contains("ghost")));
        assert!(!r.errors.iter().any(|e| e.detail.contains("real"))); // real resolves
    }

    #[test]
    fn explicit_raw_revision_resolves_a_stable_session_citation_alias() {
        let (_d, root) = vault(&[
            ("raw/conversations/codex/synthetic.r1.md", "Synthetic revised source."),
            ("raw/conversations/claude/synthetic.r1.md", "Another namespace."),
            ("wiki/source-session.md", &format!("{GOOD_FM}\nA supported claim.[^src-session-codex-stable-revision]\n\n[^src-session-codex-stable-revision]: raw/conversations/codex/synthetic.r1.md · [[source-session]]\n")),
        ]);
        let report = validate_pages(&root, &["wiki/source-session.md".into()]);
        assert!(
            report.errors.is_empty(),
            "valid exact revision alias must resolve: {:?}",
            report.errors
        );
    }

    #[test]
    fn legacy_flat_citation_resolves_one_unique_archived_source() {
        let (_d, root) = vault(&[
            (
                "raw/archive/2026-08/nested/paper.md",
                "Synthetic archived source.",
            ),
            (
                "wiki/check.md",
                &format!("{GOOD_FM}\nClaim.[^src-paper]\n\n[^src-paper]: raw/paper.md\n"),
            ),
        ]);
        assert!(validate_pages(&root, &["wiki/check.md".into()]).ok());
    }

    #[test]
    fn legacy_flat_citation_refuses_ambiguous_archived_sources() {
        let (_d, root) = vault(&[
            ("raw/archive/2026-08/paper.md", "First synthetic source."),
            ("raw/archive/2026-09/paper.md", "Second synthetic source."),
            (
                "wiki/check.md",
                &format!("{GOOD_FM}\nClaim.[^src-paper]\n\n[^src-paper]: raw/paper.md\n"),
            ),
        ]);
        assert!(!validate_pages(&root, &["wiki/check.md".into()]).ok());
        fs::write(root.join("raw/paper.md"), "Current exact source.").unwrap();
        assert!(validate_pages(&root, &["wiki/check.md".into()]).ok());
    }

    #[test]
    fn archived_sources_never_redirect_explicit_revisions_or_invalid_tokens() {
        let (_d, root) = vault(&[
            ("raw/archive/2026-08/paper.md", "Synthetic archived source."),
            (
                "raw/archive/2026-08/paper.r1.md",
                "Synthetic archived revision.",
            ),
            ("wiki/check.md", GOOD_FM),
        ]);
        for token in [
            "raw/conversations/codex/paper.r1.md",
            "raw/conversations/codex/paper.md",
            "raw/archive/missing/paper.md",
            "raw/other.md",
            "raw/./paper.md",
            "raw/../raw/paper.md",
            "raw/paper.jsonl",
            "raw\\paper.md",
        ] {
            fs::write(
                root.join("wiki/check.md"),
                format!("{GOOD_FM}\nClaim.[^src-paper]\n\n[^src-paper]: {token}\n"),
            )
            .unwrap();
            assert!(
                !validate_pages(&root, &["wiki/check.md".into()]).ok(),
                "invalid or nested explicit token must not redirect: {token}"
            );
        }
        fs::write(
            root.join("wiki/check.md"),
            format!("{GOOD_FM}\nClaim.[^src-other]\n\n[^src-other]: raw/paper.md\n"),
        )
        .unwrap();
        assert!(!validate_pages(&root, &["wiki/check.md".into()]).ok());
    }

    #[test]
    fn legacy_flat_citation_requires_absence_and_an_archive_source() {
        let (_d, root) = vault(&[
            (
                "raw/conversations/codex/paper.md",
                "Another source namespace.",
            ),
            (
                "wiki/check.md",
                &format!("{GOOD_FM}\nClaim.[^src-paper]\n\n[^src-paper]: raw/paper.md\n"),
            ),
        ]);
        assert!(!validate_pages(&root, &["wiki/check.md".into()]).ok());
        fs::create_dir_all(root.join("raw/archive/2026-08")).unwrap();
        fs::write(
            root.join("raw/archive/2026-08/paper.md"),
            "Archived source.",
        )
        .unwrap();
        fs::create_dir(root.join("raw/paper.md")).unwrap();
        assert!(!validate_pages(&root, &["wiki/check.md".into()]).ok());
    }

    #[cfg(unix)]
    #[test]
    fn legacy_archive_fallback_refuses_direct_and_archived_symlinks() {
        let (_d, root) = vault(&[
            ("raw/archive/2026-08/paper.md", "Archived source."),
            (
                "wiki/check.md",
                &format!("{GOOD_FM}\nClaim.[^src-paper]\n\n[^src-paper]: raw/paper.md\n"),
            ),
        ]);
        std::os::unix::fs::symlink(
            root.join("raw/archive/2026-08/paper.md"),
            root.join("raw/paper.md"),
        )
        .unwrap();
        assert!(!validate_pages(&root, &["wiki/check.md".into()]).ok());
        fs::remove_file(root.join("raw/paper.md")).unwrap();
        fs::rename(
            root.join("raw/archive/2026-08/paper.md"),
            root.join("raw/source.md"),
        )
        .unwrap();
        std::os::unix::fs::symlink(
            root.join("raw/source.md"),
            root.join("raw/archive/2026-08/paper.md"),
        )
        .unwrap();
        assert!(!validate_pages(&root, &["wiki/check.md".into()]).ok());
        fs::remove_file(root.join("raw/archive/2026-08/paper.md")).unwrap();
        fs::create_dir_all(root.join("raw/elsewhere")).unwrap();
        fs::write(
            root.join("raw/elsewhere/paper.md"),
            "Linked directory source.",
        )
        .unwrap();
        std::os::unix::fs::symlink(root.join("raw/elsewhere"), root.join("raw/archive/linked"))
            .unwrap();
        assert!(!validate_pages(&root, &["wiki/check.md".into()]).ok());
        fs::remove_file(root.join("raw/archive/linked")).unwrap();
        fs::remove_dir_all(root.join("raw/archive")).unwrap();
        std::os::unix::fs::symlink(root.join("raw/elsewhere"), root.join("raw/archive")).unwrap();
        assert!(!validate_pages(&root, &["wiki/check.md".into()]).ok());
    }

    #[test]
    fn invalid_explicit_source_paths_cannot_fall_back_to_the_label_basename() {
        let (directory, root) = vault(&[
            ("raw/real.md", "Legacy source with matching label."),
            (
                "raw/conversations/codex/same.md",
                "Source in another namespace.",
            ),
            ("raw/real.jsonl", "Synthetic original records."),
            ("wiki/real.md", GOOD_FM),
            ("sessions/real.md", "A mutable projection."),
        ]);
        for token in [
            "raw/../wiki/real.md",
            "raw/./real.md",
            "raw/missing.md",
            "raw/real.jsonl",
            "wiki/real.md",
            "sessions/real.md",
            "/raw/real.md",
            "../raw/real.md",
            "raw\\real.md",
            "raw/conversations/claude/same.md",
            "https://invalid.example/raw/real.md",
        ] {
            fs::write(
                directory.path().join("wiki/check.md"),
                format!("{GOOD_FM}\nClaim.[^src-real]\n\n[^src-real]: {token}\n"),
            )
            .unwrap();
            let report = validate_pages(&root, &["wiki/check.md".into()]);
            assert!(
                report
                    .errors
                    .iter()
                    .any(|error| error.kind == "dangling_citation"),
                "invalid explicit token {token} must fail: {:?}",
                report.errors
            );
        }
        fs::create_dir_all(root.join("raw/not-a-file.md")).unwrap();
        fs::write(
            root.join("wiki/check.md"),
            format!("{GOOD_FM}\nClaim.[^src-real]\n\n[^src-real]: raw/not-a-file.md\n"),
        )
        .unwrap();
        assert!(!validate_pages(&root, &["wiki/check.md".into()]).ok());
    }

    #[test]
    fn duplicate_source_definitions_are_an_error_even_when_both_paths_exist() {
        let (_d, root) = vault(&[
            ("raw/real.md", "Legacy source."), ("raw/other.md", "Other source."),
            ("wiki/check.md", &format!("{GOOD_FM}\nClaim.[^src-real]\n\n[^src-real]: raw/real.md\n[^src-real]: raw/other.md\n")),
        ]);
        assert!(!validate_pages(&root, &["wiki/check.md".into()]).ok());
    }

    #[test]
    fn fenced_definitions_never_resolve_an_alias_and_fenced_references_are_not_citations() {
        for (opening, closing, interior) in [
            ("```", "```", ""),
            ("~~~", "~~~", ""),
            ("````", "````", "```\n"),
        ] {
            let (_d, root) = vault(&[
                ("raw/real.md", "Synthetic source."),
                ("wiki/check.md", &format!("{GOOD_FM}\nClaim.[^src-session-alias]\n\n{opening}\n{interior}[^src-session-alias]: raw/real.md\n[^src-fenced-missing]\n{closing}\n")),
            ]);
            let report = validate_pages(&root, &["wiki/check.md".into()]);
            assert_eq!(
                report
                    .errors
                    .iter()
                    .filter(|error| error.kind == "dangling_citation")
                    .count(),
                1,
                "only the visible unresolved alias must be counted: {:?}",
                report.errors
            );
            assert!(!report
                .warnings
                .iter()
                .any(|warning| warning.kind == "source_count_mismatch"));
        }
    }

    #[cfg(unix)]
    #[test]
    fn explicit_sources_reject_file_and_parent_symlinks_even_inside_raw() {
        let (_d, root) = vault(&[
            ("raw/real.md", "Synthetic source."),
            ("raw/nested/source.md", "Synthetic nested source."),
        ]);
        std::os::unix::fs::symlink(root.join("raw/real.md"), root.join("raw/alias.md")).unwrap();
        std::os::unix::fs::symlink(root.join("raw/nested"), root.join("raw/linked")).unwrap();
        for token in ["raw/alias.md", "raw/linked/source.md"] {
            fs::create_dir_all(root.join("wiki")).unwrap();
            fs::write(
                root.join("wiki/check.md"),
                format!("{GOOD_FM}\nClaim.[^src-real]\n\n[^src-real]: {token}\n"),
            )
            .unwrap();
            assert!(
                !validate_pages(&root, &["wiki/check.md".into()]).ok(),
                "symbolic source must fail: {token}"
            );
        }
    }
    #[test]
    fn missing_type_and_bad_enum_are_errors() {
        let (_d, root) = vault(&[
            ("wiki/b.md", "---\ntitle: B\ncreated: 2026-01-01\nconfidence: high\nstatus: active\n---\nx"),          // no type
            ("wiki/c.md", "---\ntitle: C\ntype: concept\ncreated: 2026-01-01\nconfidence: sky-high\nstatus: active\n---\nx"), // bad confidence
        ]);
        let r = validate_pages(&root, &["wiki/b.md".into(), "wiki/c.md".into()]);
        assert!(r
            .errors
            .iter()
            .any(|e| e.page.contains("b.md") && e.kind == "missing_frontmatter"));
        assert!(r
            .errors
            .iter()
            .any(|e| e.page.contains("c.md") && e.kind == "invalid_frontmatter"));
    }
    #[test]
    fn unresolved_wikilink_and_source_count_are_warnings_not_errors() {
        let (_d, root) = vault(&[
            ("raw/real.md", "# Real"),
            ("wiki/target.md", GOOD_FM),
            // source_count says 2 but only 1 distinct src; links to a missing page
            ("wiki/d.md", "---\ntitle: D\ntype: concept\ncreated: 2026-01-01\nsource_count: 2\nconfidence: high\nstatus: active\n---\nClaim.[^src-real] See [[nonexistent]] and [[target]].\n"),
        ]);
        let r = validate_pages(&root, &["wiki/d.md".into()]);
        assert!(r.errors.is_empty(), "no hard errors: {:?}", r.errors);
        assert!(r
            .warnings
            .iter()
            .any(|w| w.kind == "unresolved_wikilink" && w.detail.contains("nonexistent")));
        assert!(r.warnings.iter().any(|w| w.kind == "source_count_mismatch"));
    }
    #[test]
    fn clean_page_has_no_issues_and_structural_pages_are_exempt() {
        let (_d, root) = vault(&[
            ("raw/real.md", "# Real"),
            (
                "wiki/index.md",
                "---\ntype: overview\n---\n# Index\n[[whatever]]",
            ), // structural: exempt
            ("wiki/e.md", &format!("{GOOD_FM}\nClaim.[^src-real]\n")),
        ]);
        let r = validate_pages(&root, &["wiki/index.md".into(), "wiki/e.md".into()]);
        assert!(
            r.errors.is_empty() && r.warnings.is_empty(),
            "clean+structural: {:?} {:?}",
            r.errors,
            r.warnings
        );
    }
    #[test]
    fn overview_type_exempts_knowledge_named_page_but_missing_type_still_errors() {
        // "summary" is not one of SKIP_NAMES ("index.md"/"log.md"), so this
        // exercises the `type: overview` exemption itself, not the file-name
        // short-circuit that `wiki/index.md` covers above.
        let (_d1, root1) = vault(&[(
            "wiki/summary.md",
            "---\ntype: overview\n---\n# Summary\n[[whatever]]",
        )]);
        let r = validate_pages(&root1, &["wiki/summary.md".into()]);
        assert!(
            r.errors.is_empty() && r.warnings.is_empty(),
            "type:overview must fully exempt: {:?} {:?}",
            r.errors,
            r.warnings
        );

        // Same page name, but no `type: overview` this time — proves the
        // exemption above is what did the work, not the page's name.
        let (_d2, root2) = vault(&[(
            "wiki/summary.md",
            "---\ntitle: S\ncreated: 2026-01-01\nconfidence: high\nstatus: active\n---\n# Summary\n",
        )]);
        let r2 = validate_pages(&root2, &["wiki/summary.md".into()]);
        assert!(
            r2.errors
                .iter()
                .any(|e| e.kind == "missing_frontmatter" && e.detail.contains("type")),
            "missing type must still error without the overview exemption: {:?}",
            r2.errors
        );
    }
    #[test]
    fn wikilink_with_space_before_heading_hash_resolves_after_trim() {
        // Mirrors index::ingest_links's `.trim()`: a link like
        // "[[Target #Section]]" (space before `#`) must resolve to
        // wiki/target.md, not warn — matching what the real link-graph does.
        let (_d, root) = vault(&[
            ("raw/real.md", "# Real"),
            ("wiki/target.md", GOOD_FM),
            (
                "wiki/f.md",
                &format!("{GOOD_FM}\nClaim.[^src-real] See [[Target #Section]].\n"),
            ),
        ]);
        let r = validate_pages(&root, &["wiki/f.md".into()]);
        assert!(
            !r.warnings.iter().any(|w| w.kind == "unresolved_wikilink"),
            "space before # must still resolve via trim: {:?}",
            r.warnings
        );
    }
    #[test]
    fn nested_raw_source_resolves_by_stem() {
        // build_raw_index recurses into raw/ subdirectories and keys by file
        // stem (not path), so a source nested under raw/conversations/ must
        // still resolve — proving the recursion, not just the flat top-level
        // case every other test above exercises.
        let (_d, root) = vault(&[
            ("raw/conversations/conv-x.md", "# Conversation X\nbody"),
            ("wiki/g.md", &format!("{GOOD_FM}\nClaim.[^src-conv-x]\n")),
        ]);
        let r = validate_pages(&root, &["wiki/g.md".into()]);
        assert!(
            !r.errors.iter().any(|e| e.kind == "dangling_citation"),
            "nested raw/conversations/conv-x.md must resolve by stem: {:?}",
            r.errors
        );
    }
    #[test]
    fn source_summary_page_is_no_longer_exempt() {
        // Fix #2: `source-*` pages used to be exempt via
        // `pipeline::is_knowledge_page`, so a dangling citation in the most
        // citation-dense ingest output (the source-summary page) was never
        // caught. It must now be validated like any other wiki page.
        let (_d, root) = vault(&[(
            "wiki/source-foo.md",
            &format!("{GOOD_FM}\nClaim.[^src-ghost]\n"),
        )]);
        let r = validate_pages(&root, &["wiki/source-foo.md".into()]);
        assert!(
            r.errors
                .iter()
                .any(|e| e.kind == "dangling_citation" && e.detail.contains("ghost")),
            "source-* pages must be validated, not silently exempt: {:?}",
            r.errors
        );
    }
    #[test]
    fn type_map_passes_validator() {
        // Phase B, Task 4: `type: map` (topic-map / MOC pages under
        // `wiki/maps/`) is now in `WIKI_TYPES` — isolates that one field via
        // GOOD_FM's otherwise-valid frontmatter (status stays `active` here;
        // the actual freshly-drafted `status: draft` is a separate, disclosed
        // gap since this validator's own STATUS enum has no `draft` value —
        // moot in practice, as `maps.ts::draftMap` never calls validate_ingest).
        let fm = GOOD_FM.replace("type: concept", "type: map");
        let (_d, root) = vault(&[("wiki/maps/topic-a.md", fm.as_str())]);
        let r = validate_pages(&root, &["wiki/maps/topic-a.md".into()]);
        assert!(
            r.errors.is_empty(),
            "type: map must validate cleanly: {:?}",
            r.errors
        );
    }

    // ---- lint_local: the checks only the wiki lint runs -------------------

    fn now_secs() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
    }

    #[test]
    fn lint_tiers_validator_findings_and_drops_wikilink_gaps() {
        // Critical = validator errors; warnings keep source_count but NOT the
        // unresolved wikilink (the UI derives link gaps from the link graph).
        let (_d, root) = vault(&[
            ("raw/real.md", "# Real"),
            ("wiki/nofm.md", "no frontmatter here"),
            ("wiki/d.md", "---\ntitle: D\ntype: concept\ncreated: 2026-01-01\nsource_count: 2\nconfidence: medium\nstatus: active\n---\nClaim.[^src-real] See [[nonexistent]].\n"),
        ]);
        let r = lint_local(
            &root,
            &["wiki/nofm.md".into(), "wiki/d.md".into()],
            now_secs(),
        );
        assert!(r.critical.iter().any(|e| e.kind == "missing_frontmatter"));
        assert!(r.warning.iter().any(|w| w.kind == "source_count_mismatch"));
        assert!(
            !r.warning.iter().any(|w| w.kind == "unresolved_wikilink"),
            "link gaps belong to the graph pass: {:?}",
            r.warning
        );
    }

    #[test]
    fn stale_active_page_is_info() {
        let (_d, root) = vault(&[("wiki/a.md", GOOD_FM)]);
        // The file was written a moment ago; move the CLOCK forward 40 days
        // instead of trying to backdate the file.
        let future = now_secs() + 40 * 24 * 60 * 60;
        let r = lint_local(&root, &["wiki/a.md".into()], future);
        assert!(
            r.info
                .iter()
                .any(|i| i.kind == "stale_page" && i.detail.contains("40 days")),
            "40-day-old active page must be info: {:?}",
            r.info
        );
        // Fresh at the real clock — the same page must NOT be flagged.
        let fresh = lint_local(&root, &["wiki/a.md".into()], now_secs());
        assert!(!fresh.info.iter().any(|i| i.kind == "stale_page"));
    }

    #[test]
    fn hedge_on_single_source_page_is_info() {
        let (_d, root) = vault(&[
            ("raw/real.md", "# Real"),
            // source_count: 1 + a literal hedge from the checklist.
            (
                "wiki/h.md",
                &format!("{GOOD_FM}\n일반적으로 이것은 사실이다.[^src-real]\n"),
            ),
            // Two sources: the same hedge is not flagged.
            (
                "wiki/i.md",
                &format!(
                    "{}\nin general this holds.[^src-real]\n",
                    GOOD_FM.replace("source_count: 1", "source_count: 2")
                ),
            ),
        ]);
        let r = lint_local(&root, &["wiki/h.md".into(), "wiki/i.md".into()], now_secs());
        assert!(
            r.info
                .iter()
                .any(|i| i.kind == "hedged_claim" && i.page == "wiki/h.md"),
            "hedged single-source page must be info: {:?}",
            r.info
        );
        assert!(!r.info.iter().any(|i| i.page == "wiki/i.md"));
    }

    #[test]
    fn weak_confidence_and_missing_disputed_section_are_warnings() {
        let fm_disputed = GOOD_FM
            .replace("status: active", "status: disputed")
            .replace("confidence: high", "confidence: medium");
        let (_d, root) = vault(&[
            // confidence: high with source_count: 1
            ("wiki/w.md", GOOD_FM),
            ("wiki/x.md", &format!("{fm_disputed}\nbody, no heading\n")),
            (
                "wiki/y.md",
                &format!("{fm_disputed}\n## Disputed\nboth sides.\n"),
            ),
        ]);
        let r = lint_local(
            &root,
            &["wiki/w.md".into(), "wiki/x.md".into(), "wiki/y.md".into()],
            now_secs(),
        );
        assert!(r
            .warning
            .iter()
            .any(|w| w.kind == "weak_confidence" && w.page == "wiki/w.md"));
        assert!(r
            .warning
            .iter()
            .any(|w| w.kind == "missing_disputed_section" && w.page == "wiki/x.md"));
        assert!(
            !r.warning
                .iter()
                .any(|w| w.kind == "missing_disputed_section" && w.page == "wiki/y.md"),
            "a page WITH the section must not be flagged: {:?}",
            r.warning
        );
    }
}
