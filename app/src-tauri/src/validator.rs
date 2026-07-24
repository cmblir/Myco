// Deterministic ingest validator (Phase 1f, retrieval-first redesign). Runs in
// Rust instead of the LLM so ingest gains a hard gate that doesn't depend on
// the model noticing its own mistakes: dangling citations and malformed
// frontmatter are ERRORS; unresolved wikilinks and a stale `source_count` are
// WARNINGS the agent should fix but that don't block the write.

use crate::local_llm::WIKI_TYPES;
use crate::{index, parser, pipeline, provenance};
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

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

/// Validate the given vault-relative pages against the Balanced ingest policy.
/// `root` must already be the vault's canonical root (callers confine it).
/// Non-`wiki/` paths, structural pages (`index`/`log`/`source-*`), and
/// `type: overview` pages are exempt and produce no issues at all.
pub fn validate_pages(root: &Path, changed_rels: &[String]) -> ValidationReport {
    let mut rep = ValidationReport::default();
    // Recursive raw/ index (dangling-citation lookup) and the vault-wide
    // wikilink name index — both built once, over the whole vault, not just
    // the changed set, since a changed page may cite/link anywhere.
    let raw = provenance::build_raw_index(root);
    let (_sources, linkables): (Vec<PathBuf>, Vec<PathBuf>) =
        index::collect_files(root).unwrap_or_default();
    let names = index::build_name_index(&linkables);

    for rel in changed_rels {
        let rel = rel.replace('\\', "/");
        let stem = Path::new(&rel)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("");
        if !rel.starts_with("wiki/") || !pipeline::is_knowledge_page(stem) {
            continue; // non-wiki path or structural page (index/log/source-*)
        }
        let abs = root.join(&rel);
        let Ok(text) = std::fs::read_to_string(&abs) else {
            continue;
        };

        let fm = crate::vault::read_file(&abs.to_string_lossy())
            .ok()
            .map(|f| f.frontmatter);
        let is_overview = fm
            .as_ref()
            .and_then(|v| v.get("type"))
            .and_then(|v| v.as_str())
            .map(|t| t == "overview")
            .unwrap_or(false);
        if is_overview {
            continue; // structural overview page
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
                let mut slugs = BTreeSet::new();
                for line in text.lines() {
                    provenance::extract_src_slugs(line, &mut slugs);
                }
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
                    if !raw.contains_key(s) {
                        rep.errors.push(Issue {
                            page: rel.clone(),
                            kind: "dangling_citation".into(),
                            detail: format!("[^src-{s}] has no raw/{s}.md"),
                        });
                    }
                }
            }
        }

        // Wikilinks must resolve to a page in the vault (WARNING).
        for link in parser::parse_links_from_text(&text) {
            let key = link.split('#').next().unwrap_or(&link).to_lowercase();
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    fn vault(files: &[(&str, &str)]) -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        for (rel, body) in files {
            let p = d.path().join(rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, body).unwrap();
        }
        d
    }
    const GOOD_FM: &str = "---\ntitle: A\ntype: concept\ncreated: 2026-01-01\nsource_count: 1\nconfidence: high\nstatus: active\n---\n";

    #[test]
    fn dangling_citation_is_error() {
        let d = vault(&[
            ("raw/real.md", "# Real\nbody"),
            ("wiki/a.md", &format!("{GOOD_FM}\nBody claim.[^src-real]\nGhost claim.[^src-ghost]\n")),
        ]);
        let r = validate_pages(d.path(), &["wiki/a.md".into()]);
        assert!(r.errors.iter().any(|e| e.kind == "dangling_citation" && e.detail.contains("ghost")));
        assert!(!r.errors.iter().any(|e| e.detail.contains("real"))); // real resolves
    }
    #[test]
    fn missing_type_and_bad_enum_are_errors() {
        let d = vault(&[
            ("wiki/b.md", "---\ntitle: B\ncreated: 2026-01-01\nconfidence: high\nstatus: active\n---\nx"),          // no type
            ("wiki/c.md", "---\ntitle: C\ntype: concept\ncreated: 2026-01-01\nconfidence: sky-high\nstatus: active\n---\nx"), // bad confidence
        ]);
        let r = validate_pages(d.path(), &["wiki/b.md".into(), "wiki/c.md".into()]);
        assert!(r.errors.iter().any(|e| e.page.contains("b.md") && e.kind == "missing_frontmatter"));
        assert!(r.errors.iter().any(|e| e.page.contains("c.md") && e.kind == "invalid_frontmatter"));
    }
    #[test]
    fn unresolved_wikilink_and_source_count_are_warnings_not_errors() {
        let d = vault(&[
            ("raw/real.md", "# Real"),
            ("wiki/target.md", GOOD_FM),
            // source_count says 2 but only 1 distinct src; links to a missing page
            ("wiki/d.md", &format!("---\ntitle: D\ntype: concept\ncreated: 2026-01-01\nsource_count: 2\nconfidence: high\nstatus: active\n---\nClaim.[^src-real] See [[nonexistent]] and [[target]].\n")),
        ]);
        let r = validate_pages(d.path(), &["wiki/d.md".into()]);
        assert!(r.errors.is_empty(), "no hard errors: {:?}", r.errors);
        assert!(r.warnings.iter().any(|w| w.kind == "unresolved_wikilink" && w.detail.contains("nonexistent")));
        assert!(r.warnings.iter().any(|w| w.kind == "source_count_mismatch"));
    }
    #[test]
    fn clean_page_has_no_issues_and_structural_pages_are_exempt() {
        let d = vault(&[
            ("raw/real.md", "# Real"),
            ("wiki/index.md", "---\ntype: overview\n---\n# Index\n[[whatever]]"),       // structural: exempt
            ("wiki/e.md", &format!("{GOOD_FM}\nClaim.[^src-real]\n")),
        ]);
        let r = validate_pages(d.path(), &["wiki/index.md".into(), "wiki/e.md".into()]);
        assert!(r.errors.is_empty() && r.warnings.is_empty(), "clean+structural: {:?} {:?}", r.errors, r.warnings);
    }
}
