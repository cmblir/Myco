// Rust mirror of mcp-server/project_registry.py — the read side, plus the two
// writes the app owns on a project switch (`active` pointer + `last_used`).
// Project CRUD stays in the Python registry; this module exists so the app can
// enumerate every registered project ("universe") and build READ-ONLY link
// graphs for projects other than the open vault (the multiverse view), without
// widening the mutation path's single-root confinement.
//
// Location: unlike the Python module (whose PROJECT_ROOT *is* the active
// vault), the app's open vault is normally `projects/<slug>/` itself, so the
// registry is found by walking UP from the open vault until a directory
// holding a `projects.json` file appears. A standalone vault with no registry
// above it has no multiverse (`discover` → None).

use serde::Serialize;
use std::path::{Path, PathBuf};

/// One registered project, parsed from `projects.json`. Unknown fields are
/// preserved on write by editing the raw JSON value, not this struct.
#[derive(Debug, Clone)]
pub struct Entry {
    pub slug: String,
    pub title: String,
    pub description: String,
    pub created: String,
    pub last_used: String,
    pub independent_vault: bool,
}

/// A discovered registry: the directory holding `projects.json` plus its
/// validated entries. Malformed or unsafe entries are skipped (mirrors
/// `project_registry.list_projects`), never used to build a path.
#[derive(Debug, Clone)]
pub struct Registry {
    /// Canonical directory containing `projects.json`.
    pub project_root: PathBuf,
    /// `<project_root>/projects` — every project root must live under here.
    pub projects_dir: PathBuf,
    pub active: Option<String>,
    pub entries: Vec<Entry>,
}

/// Frontend DTO for `list_projects` (camelCase to match the TS side).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub slug: String,
    pub title: String,
    pub description: String,
    /// Absolute project root (`<project_root>/projects/<slug>`).
    pub root: String,
    /// Markdown notes under the project root (graph-node approximation).
    pub note_count: usize,
    pub created: String,
    pub last_used: String,
    pub independent_vault: bool,
    pub active: bool,
}

/// Reject a slug that could escape `projects/` via `..`, a path separator, an
/// absolute path, or a hidden-dir prefix. Mirrors `project_registry._validate_slug`
/// (defense-in-depth: a hand-edited projects.json must not relocate a project
/// root outside `projects/`). Fails closed.
pub fn validate_slug(slug: &str) -> Result<&str, String> {
    let s = slug.trim();
    if s.is_empty()
        || s.contains('/')
        || s.contains('\\')
        // A colon is a Windows drive separator (`C:`), so a slug like "C:" would
        // make `projects_dir.join(slug)` resolve drive-relative and escape the
        // registry tree. It never appears in a generated (kebab-case) slug, so
        // rejecting it costs nothing and closes that class cross-platform.
        || s.contains(':')
        || s.contains("..")
        || s.starts_with('.')
        || s.contains('\0')
    {
        return Err(format!("invalid project slug: {slug:?}"));
    }
    Ok(s)
}

impl Registry {
    /// Walk up from `start` (the open vault root) looking for a directory that
    /// holds a `projects.json` file. Returns None when there is no registry —
    /// the vault is standalone and the multiverse view is unavailable.
    pub fn discover(start: &Path) -> Option<Registry> {
        let start = start.canonicalize().ok()?;
        for dir in start.ancestors() {
            if dir.join("projects.json").is_file() {
                return Some(Self::load_at(dir));
            }
        }
        None
    }

    /// Parse `<root>/projects.json`. A malformed file yields an empty registry
    /// (mirrors `_load_registry`'s default-on-error), and malformed or unsafe
    /// entries are skipped rather than aborting the listing.
    fn load_at(root: &Path) -> Registry {
        let projects_dir = root.join("projects");
        let mut reg = Registry {
            project_root: root.to_path_buf(),
            projects_dir: projects_dir.clone(),
            active: None,
            entries: Vec::new(),
        };
        let Ok(raw) = std::fs::read_to_string(root.join("projects.json")) else {
            return reg;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) else {
            return reg;
        };
        reg.active = json
            .get("active")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        let Some(projects) = json.get("projects").and_then(|v| v.as_array()) else {
            return reg;
        };
        for e in projects {
            let Some(slug) = e.get("slug").and_then(|v| v.as_str()) else {
                continue;
            };
            let Ok(slug) = validate_slug(slug) else {
                continue; // unsafe entry — skip, never build a path from it
            };
            let str_field = |k: &str| {
                e.get(k)
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string()
            };
            reg.entries.push(Entry {
                slug: slug.to_string(),
                title: e
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or(slug)
                    .to_string(),
                description: str_field("description"),
                created: str_field("created"),
                last_used: str_field("last_used"),
                // On-disk truth (an .obsidian/ dir) OR the registry flag, so a
                // hand-scaffolded vault is still recognised (Python parity).
                independent_vault: e
                    .get("independent_vault")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false)
                    || projects_dir.join(slug).join(".obsidian").is_dir(),
            });
        }
        reg
    }

    /// Canonical root of a REGISTERED project, or an error. This is the only
    /// way a multiverse command turns a frontend-supplied slug into a path:
    /// the slug must validate, must exist in the registry, and the on-disk
    /// project root must be the REAL directory `<registry root>/projects/<slug>`
    /// with no symlink indirection at any component.
    ///
    /// Security: we must NOT confine against `canonicalize(projects_dir)` — that
    /// resolves a symlinked `projects` component to its target and would confine
    /// to the target instead of the registry tree, letting a hostile shared vault
    /// (`projects -> ../..` + a slug naming a sibling of the registry root, e.g.
    /// "Documents") read/write arbitrary directories. Instead we canonicalize the
    /// registry root, rebuild the expected literal path under it, canonicalize
    /// the actual entry, and require the two to be identical. A symlink anywhere
    /// in `projects/<slug>` makes the canonical path differ from the expected
    /// literal one, so it fails closed.
    pub fn resolve_project_root(&self, slug: &str) -> Result<PathBuf, String> {
        let s = validate_slug(slug)?;
        if !self.entries.iter().any(|e| e.slug == s) {
            return Err(format!("project not registered: {s}"));
        }
        let registry_root = self
            .project_root
            .canonicalize()
            .map_err(|e| format!("registry root missing: {e}"))?;
        let expected = registry_root.join("projects").join(s);
        let root = expected
            .canonicalize()
            .map_err(|e| format!("project root missing for {s}: {e}"))?;
        if root != expected {
            // canonicalize() differs from the literal expected path only when a
            // component of projects/<slug> is a symlink (or `..`) — an escape
            // out of the registry tree. Refuse it.
            return Err(format!("project root escapes projects/: {s}"));
        }
        Ok(root)
    }

    /// Entries as frontend DTOs, with per-project note counts.
    pub fn project_infos(&self) -> Vec<ProjectInfo> {
        self.entries
            .iter()
            .map(|e| {
                let root = self.projects_dir.join(&e.slug);
                ProjectInfo {
                    slug: e.slug.clone(),
                    title: e.title.clone(),
                    description: e.description.clone(),
                    root: root.to_string_lossy().into_owned(),
                    note_count: count_notes(&root),
                    created: e.created.clone(),
                    last_used: e.last_used.clone(),
                    independent_vault: e.independent_vault,
                    active: self.active.as_deref() == Some(e.slug.as_str()),
                }
            })
            .collect()
    }
}

/// Point the registry's `active` field at `slug` and stamp the entry's
/// `last_used` (mirrors `project_registry.switch_project`). Edits the raw JSON
/// so unknown fields (model, template, …) survive the round-trip; the write is
/// atomic. Errors if the slug is not in the file — the caller must not have
/// switched anything yet.
pub fn set_active(project_root: &Path, slug: &str) -> Result<(), String> {
    let s = validate_slug(slug)?;
    let file = project_root.join("projects.json");
    let raw = std::fs::read_to_string(&file).map_err(|e| format!("read projects.json: {e}"))?;
    let mut json: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("parse projects.json: {e}"))?;
    let entry = json
        .get_mut("projects")
        .and_then(|v| v.as_array_mut())
        .and_then(|arr| {
            arr.iter_mut()
                .find(|e| e.get("slug").and_then(|v| v.as_str()) == Some(s))
        })
        .ok_or_else(|| format!("project not registered: {s}"))?;
    entry["last_used"] = serde_json::Value::String(today_utc());
    json["active"] = serde_json::Value::String(s.to_string());
    let out = serde_json::to_string_pretty(&json).map_err(|e| e.to_string())? + "\n";
    crate::settings::atomic_write(&file, out.as_bytes())
        .map_err(|e| format!("write projects.json: {e}"))
}

/// Whether a directory looks like a Memex/Obsidian vault worth showing as a
/// universe: a `wiki/`, an `.obsidian/`, a top-level `CLAUDE.md`, or at least
/// one top-level `.md` file. Cheap (a shallow read, no recursion).
fn looks_like_vault(dir: &Path) -> bool {
    if dir.join("wiki").is_dir()
        || dir.join(".obsidian").is_dir()
        || dir.join("CLAUDE.md").is_file()
    {
        return true;
    }
    // A top-level markdown file also qualifies (a flat notes folder).
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .any(|e| e.path().extension().and_then(|x| x.to_str()) == Some("md"))
}

/// Discover the vaults SITTING BESIDE the open vault — the immediate sibling
/// directories of its parent that look like vaults — so the multiverse can show
/// a user's several side-by-side vaults without any `projects.json` registry.
/// Read-only and confined: only immediate children of the open vault's parent,
/// each canonicalized and required to stay under that parent (no symlink
/// escape), and only if it looks like a vault. The open vault itself is
/// included (flagged active). Returns [] when the parent is a filesystem root
/// or unreadable.
pub fn discover_sibling_vaults(open_vault: &Path) -> Vec<ProjectInfo> {
    let Ok(vault) = open_vault.canonicalize() else {
        return Vec::new();
    };
    let Some(parent) = vault.parent() else {
        return Vec::new();
    };
    // Don't scan a filesystem root (parent has no parent) — too broad.
    if parent.parent().is_none() {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(parent) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in entries.flatten() {
        if is_hidden_name(&e.file_name()) {
            continue;
        }
        let Ok(cp) = e.path().canonicalize() else {
            continue;
        };
        // Immediate child of the (canonical) parent — rejects symlinks that
        // resolve elsewhere.
        if cp.parent() != Some(parent) || !cp.is_dir() {
            continue;
        }
        if !looks_like_vault(&cp) {
            continue;
        }
        let name = cp
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("vault")
            .to_string();
        out.push(ProjectInfo {
            slug: name.clone(),
            title: name,
            description: String::new(),
            root: cp.to_string_lossy().into_owned(),
            note_count: count_notes(&cp),
            created: String::new(),
            last_used: String::new(),
            independent_vault: cp.join(".obsidian").is_dir(),
            active: cp == vault,
        });
    }
    out.sort_by(|a, b| a.slug.cmp(&b.slug));
    out
}

/// Local mirror of index::is_hidden_name for the sibling scan (dot-dirs,
/// node_modules, target).
fn is_hidden_name(name: &std::ffi::OsStr) -> bool {
    crate::index::is_hidden_name(name)
}

/// Count markdown notes under a project root, with the same hidden-dir skip
/// rules as the link-graph walker so the count approximates graph-node count.
/// Directory symlinks are NOT followed: a symlink cycle inside a project would
/// otherwise hang list_projects, and following one would count (and thereby
/// leak the existence of) notes outside the project root.
fn count_notes(root: &Path) -> usize {
    let mut count = 0usize;
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in entries.flatten() {
            if crate::index::is_hidden_name(&e.file_name()) {
                continue;
            }
            // file_type() does not traverse symlinks, so a symlinked dir reports
            // as a symlink (not a dir) and is skipped — no cycle, no escape.
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                stack.push(e.path());
            } else if ft.is_file()
                && e.path().extension().and_then(|s| s.to_str()) == Some("md")
            {
                count += 1;
            }
        }
    }
    count
}

/// Today's date as `YYYY-MM-DD` (UTC — the Python side uses local time; a
/// same-day discrepancy across a midnight boundary is acceptable for a
/// recency stamp and not worth a chrono dependency).
pub(crate) fn today_utc() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Days-since-epoch → proleptic Gregorian (y, m, d). Howard Hinnant's
/// `civil_from_days` algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Scaffold `<tmp>/projects.json` + `projects/<slug>/` dirs and return the
    /// temp root.
    fn scaffold(reg_json: &str, slugs: &[&str]) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("projects.json"), reg_json).unwrap();
        for s in slugs {
            std::fs::create_dir_all(tmp.path().join("projects").join(s).join("wiki")).unwrap();
        }
        tmp
    }

    const TWO_PROJECTS: &str = r#"{
      "version": 1,
      "active": "alpha",
      "projects": [
        {"slug": "alpha", "title": "Alpha", "model": "default", "template": "x"},
        {"slug": "beta", "last_used": "2026-01-01"}
      ]
    }"#;

    #[test]
    fn discover_sibling_vaults_finds_vault_like_siblings() {
        let tmp = tempfile::tempdir().unwrap();
        let parent = tmp.path().join("Documents");
        // Three sibling dirs: two vault-like, one not; plus the open vault.
        let open = parent.join("Memex");
        std::fs::create_dir_all(open.join("wiki")).unwrap();
        std::fs::write(open.join("CLAUDE.md"), "# open").unwrap();
        std::fs::create_dir_all(parent.join("demo").join("wiki")).unwrap();
        std::fs::create_dir_all(parent.join("obsidian").join(".obsidian")).unwrap();
        std::fs::create_dir_all(parent.join("Design")).unwrap(); // no md/markers
        std::fs::write(parent.join("loose.txt"), "not a dir").unwrap();

        let sibs = discover_sibling_vaults(&open);
        let slugs: Vec<_> = sibs.iter().map(|s| s.slug.as_str()).collect();
        assert!(slugs.contains(&"Memex"), "open vault included");
        assert!(slugs.contains(&"demo"), "wiki/ sibling included");
        assert!(slugs.contains(&"obsidian"), ".obsidian/ sibling included");
        assert!(!slugs.contains(&"Design"), "non-vault dir excluded");
        // The open vault is flagged active; obsidian is flagged independent.
        let open_e = sibs.iter().find(|s| s.slug == "Memex").unwrap();
        assert!(open_e.active);
        let obs = sibs.iter().find(|s| s.slug == "obsidian").unwrap();
        assert!(obs.independent_vault);
    }

    #[test]
    fn validate_slug_rejects_traversal_forms() {
        for bad in [
            "", " ", "../up", "a/b", r"a\b", ".hidden", "nul\0l", "..", "C:", "c:drive",
        ] {
            assert!(validate_slug(bad).is_err(), "should reject {bad:?}");
        }
        assert_eq!(validate_slug("karpathy-llm").unwrap(), "karpathy-llm");
        assert_eq!(validate_slug(" spaced ").unwrap(), "spaced");
    }

    #[test]
    fn discover_walks_up_from_a_project_vault() {
        let tmp = scaffold(TWO_PROJECTS, &["alpha", "beta"]);
        let vault = tmp.path().join("projects").join("alpha");
        let reg = Registry::discover(&vault).expect("registry above the vault");
        assert_eq!(reg.project_root, tmp.path().canonicalize().unwrap());
        assert_eq!(reg.active.as_deref(), Some("alpha"));
        assert_eq!(reg.entries.len(), 2);
        // Title defaults to the slug when absent.
        assert_eq!(reg.entries[1].title, "beta");
    }

    #[test]
    fn discover_picks_the_nearest_registry() {
        // Two registries in the ancestry: an inner one nested under an outer.
        // Opening a vault below the inner must resolve to the INNER registry,
        // not the outer — the walk stops at the first projects.json found.
        let outer = scaffold(
            r#"{"active": "outer-proj", "projects": [{"slug": "outer-proj"}]}"#,
            &["outer-proj"],
        );
        let inner_root = outer.path().join("nested");
        std::fs::create_dir_all(inner_root.join("projects").join("inner-proj")).unwrap();
        std::fs::write(
            inner_root.join("projects.json"),
            r#"{"active": "inner-proj", "projects": [{"slug": "inner-proj"}]}"#,
        )
        .unwrap();
        let vault = inner_root.join("projects").join("inner-proj");
        let reg = Registry::discover(&vault).unwrap();
        assert_eq!(reg.active.as_deref(), Some("inner-proj"));
        assert_eq!(reg.project_root, inner_root.canonicalize().unwrap());
        let slugs: Vec<_> = reg.entries.iter().map(|e| e.slug.as_str()).collect();
        assert_eq!(slugs, ["inner-proj"]);
    }

    #[test]
    fn discover_returns_none_without_a_registry() {
        let tmp = tempfile::tempdir().unwrap();
        let vault = tmp.path().join("standalone");
        std::fs::create_dir_all(&vault).unwrap();
        // NB: assumes no projects.json in the system temp dir's ancestors.
        assert!(Registry::discover(&vault).is_none());
    }

    #[test]
    fn malformed_registry_or_entries_degrade_to_empty() {
        let tmp = scaffold("{ not json", &[]);
        let reg = Registry::discover(tmp.path()).unwrap();
        assert!(reg.entries.is_empty());

        let tmp = scaffold(
            r#"{"projects": [{"slug": "../evil"}, {"title": "no slug"}, {"slug": "ok"}]}"#,
            &["ok"],
        );
        let reg = Registry::discover(tmp.path()).unwrap();
        let slugs: Vec<_> = reg.entries.iter().map(|e| e.slug.as_str()).collect();
        assert_eq!(slugs, ["ok"], "unsafe/malformed entries are skipped");
    }

    #[test]
    fn resolve_rejects_unregistered_and_traversal_slugs() {
        let tmp = scaffold(TWO_PROJECTS, &["alpha", "beta"]);
        let reg = Registry::discover(tmp.path()).unwrap();
        assert!(reg.resolve_project_root("alpha").is_ok());
        assert!(reg.resolve_project_root("gamma").is_err(), "not registered");
        assert!(reg.resolve_project_root("../alpha").is_err(), "traversal");
        // Registered in JSON but missing on disk must also fail.
        let tmp2 = scaffold(TWO_PROJECTS, &["alpha"]);
        let reg2 = Registry::discover(tmp2.path()).unwrap();
        assert!(reg2.resolve_project_root("beta").is_err(), "missing dir");
    }

    #[cfg(unix)]
    #[test]
    fn resolve_rejects_symlink_escaping_projects_dir() {
        let tmp = scaffold(
            r#"{"active": null, "projects": [{"slug": "escape"}]}"#,
            &[],
        );
        std::fs::create_dir_all(tmp.path().join("projects")).unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), tmp.path().join("projects").join("escape"))
            .unwrap();
        let reg = Registry::discover(tmp.path()).unwrap();
        assert!(reg.resolve_project_root("escape").is_err());
    }

    /// The escape a per-slug-symlink check misses: `projects` ITSELF is a
    /// symlink out of the registry tree, and the slug names a directory that
    /// exists under the target. Confining against canonicalize(projects_dir)
    /// would follow the symlink and wrongly allow this; the exact-path check
    /// must reject it.
    #[cfg(unix)]
    #[test]
    fn resolve_rejects_symlinked_projects_dir_escape() {
        let outside = tempfile::tempdir().unwrap();
        // The target the symlink points at, holding a "Documents"-style dir.
        std::fs::create_dir_all(outside.path().join("Documents").join("wiki")).unwrap();
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(
            tmp.path().join("projects.json"),
            r#"{"active": null, "projects": [{"slug": "Documents"}]}"#,
        )
        .unwrap();
        // projects -> <outside>, so projects/Documents resolves outside the
        // registry root entirely.
        std::os::unix::fs::symlink(outside.path(), tmp.path().join("projects")).unwrap();
        let reg = Registry::discover(tmp.path()).unwrap();
        assert!(
            reg.resolve_project_root("Documents").is_err(),
            "a symlinked projects/ dir must not relocate the confinement base"
        );
    }

    #[test]
    fn set_active_updates_pointer_and_preserves_unknown_fields() {
        let tmp = scaffold(TWO_PROJECTS, &["alpha", "beta"]);
        set_active(tmp.path(), "beta").unwrap();
        let raw = std::fs::read_to_string(tmp.path().join("projects.json")).unwrap();
        let json: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(json["active"], "beta");
        // beta's last_used was stamped with a fresh YYYY-MM-DD.
        let stamped = json["projects"][1]["last_used"].as_str().unwrap();
        assert_ne!(stamped, "2026-01-01");
        assert_eq!(stamped.len(), 10);
        // Fields this module doesn't model must survive the round-trip.
        assert_eq!(json["projects"][0]["model"], "default");
        assert_eq!(json["projects"][0]["template"], "x");
        assert_eq!(json["version"], 1);
        // Unknown slug errors without touching the file.
        assert!(set_active(tmp.path(), "gamma").is_err());
    }

    #[test]
    fn project_infos_count_notes_and_flag_active() {
        let tmp = scaffold(TWO_PROJECTS, &["alpha", "beta"]);
        let alpha = tmp.path().join("projects").join("alpha");
        std::fs::write(alpha.join("wiki").join("a.md"), "# a").unwrap();
        std::fs::write(alpha.join("wiki").join("b.md"), "# b").unwrap();
        std::fs::write(alpha.join("wiki").join("c.txt"), "not a note").unwrap();
        // Hidden dirs (e.g. .obsidian) are excluded from the count…
        let hidden = alpha.join(".trash");
        std::fs::create_dir_all(&hidden).unwrap();
        std::fs::write(hidden.join("gone.md"), "# gone").unwrap();
        // …but an .obsidian dir marks the project as an independent vault.
        std::fs::create_dir_all(alpha.join(".obsidian")).unwrap();

        let reg = Registry::discover(tmp.path()).unwrap();
        let infos = reg.project_infos();
        assert_eq!(infos.len(), 2);
        assert_eq!(infos[0].note_count, 2);
        assert!(infos[0].active);
        assert!(infos[0].independent_vault);
        assert_eq!(infos[1].note_count, 0);
        assert!(!infos[1].active);
        assert!(!infos[1].independent_vault);
    }

    #[test]
    fn civil_from_days_matches_known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(19_723), (2024, 1, 1));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29)); // leap day
        assert_eq!(today_utc().len(), 10);
    }
}
