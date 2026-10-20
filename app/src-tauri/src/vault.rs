// Vault filesystem operations: open, list, read, write.
// All paths returned to the frontend are canonical absolute paths so the
// frontend can use them as stable file identifiers.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[cfg(test)]
#[path = "vault_scan_tests.rs"]
pub(crate) mod scan_tests;

#[cfg(test)]
#[path = "vault_mutation_tests.rs"]
mod mutation_tests;

#[path = "vault_compiler_pin.rs"]
mod compiler_pin;
pub(crate) use compiler_pin::{
    capture_compiler_initial_file_pin_locked, compiler_prior_from_receipt,
    open_compiler_pin_directory, read_compiler_prior_file_pin_locked,
    reopen_compiler_prior_file_pin, write_compiler_file_anchored_locked, CompilerPinDirectory,
    CompilerPriorFilePin,
};

#[path = "vault_compiler_retirement.rs"]
mod compiler_retirement;
pub(crate) use compiler_retirement::{
    capture_compiler_retired_file_locked, read_compiler_retired_file_pin_locked,
    unlink_compiler_retired_file_pin_locked, CompilerRetiredFilePin,
};

// Cooperating app writers share this lock; external editors and other
// processes/devices do not. It is not a filesystem-wide transaction.
static FILE_WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Hold the cooperating writer transaction for checks and filesystem mutation.
/// Do not call a locking writer or acquire earlier origin/registry locks while held.
pub(crate) fn lock_file_mutation() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    FILE_WRITE_LOCK
        .lock()
        .map_err(|_| "file write lock poisoned".to_string())
}

/// Normalize a caller root, then recheck it after waiting for the writer lock.
/// The callback must use unlocked leaves and must not reacquire earlier locks.
pub(crate) fn with_root_mutation<T>(
    root: &Path,
    operation: impl FnOnce(&Path, &std::sync::MutexGuard<'_, ()>) -> Result<T, String>,
) -> Result<T, String> {
    with_root_mutation_impl(
        root,
        operation,
        #[cfg(test)]
        || {},
    )
}

pub(crate) fn with_root_mutation_impl<T>(
    root: &Path,
    operation: impl FnOnce(&Path, &std::sync::MutexGuard<'_, ()>) -> Result<T, String>,
    #[cfg(test)] before_lock: impl FnOnce(),
) -> Result<T, String> {
    let inspect = || {
        let metadata = std::fs::symlink_metadata(root)
            .map_err(|error| format!("inspect mutation vault: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("mutation vault is not a real directory".to_string());
        }
        root.canonicalize()
            .map_err(|error| format!("canonicalize mutation vault: {error}"))
    };
    let captured = inspect()?;
    #[cfg(unix)]
    let held_root =
        std::fs::File::open(&captured).map_err(|error| format!("open mutation vault: {error}"))?;
    #[cfg(test)]
    before_lock();
    let guard = lock_file_mutation()?;
    if inspect()? != captured {
        return Err("mutation vault changed while waiting for writer".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let held = held_root
            .metadata()
            .map_err(|error| format!("inspect held mutation vault: {error}"))?;
        let current = std::fs::metadata(&captured)
            .map_err(|error| format!("reinspect mutation vault: {error}"))?;
        if held.dev() != current.dev() || held.ino() != current.ino() {
            return Err("mutation vault identity changed while waiting for writer".into());
        }
    }
    operation(&captured, &guard)
}

/// Rebase a lexical caller-root alias onto the rechecked canonical root.
pub(crate) fn confine_mutation_path(
    root: &Path,
    requested_root: &Path,
    path: &str,
) -> Result<PathBuf, String> {
    let requested = Path::new(path);
    let rebased = requested
        .strip_prefix(requested_root)
        .map(|relative| root.join(relative))
        .unwrap_or_else(|_| requested.to_path_buf());
    confine_delete_path(root, &rebased.to_string_lossy())
}

#[cfg(test)]
pub(crate) fn try_lock_file_mutation() -> Result<Option<std::sync::MutexGuard<'static, ()>>, String>
{
    match FILE_WRITE_LOCK.try_lock() {
        Ok(guard) => Ok(Some(guard)),
        Err(std::sync::TryLockError::WouldBlock) => Ok(None),
        Err(std::sync::TryLockError::Poisoned(_)) => Err("file write lock poisoned".into()),
    }
}

// --- Vault-root confinement -------------------------------------------------
// The frontend can ask to read/write/delete/rename arbitrary paths over IPC.
// Without a check, `delete_path("~/.ssh/id_rsa")` or `write_file("/etc/...")`
// would succeed. These helpers resolve a requested path and refuse anything
// that does not land inside the currently-open vault root. `root` MUST already
// be canonical (open_vault returns a canonical path). `Path::starts_with` is
// component-wise, so "/vault" does not match a sibling "/vault-evil".

/// Confine an existing-or-new target to `root`. If the target exists, its
/// canonical path must be inside root. If it does not exist yet (e.g. a fresh
/// write_file), its parent must exist and be inside root; the final component is
/// re-attached. Returns the confined path to operate on.
pub fn confine_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let p = Path::new(path);
    if let Ok(resolved) = p.canonicalize() {
        if !resolved.starts_with(root) {
            return Err("path is outside the open vault".into());
        }
        return Ok(resolved);
    }
    let parent = p
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| format!("no parent dir for {path}"))?;
    let name = p
        .file_name()
        .ok_or_else(|| format!("no file name in {path}"))?;
    let parent_resolved = parent
        .canonicalize()
        .map_err(|e| format!("canonicalize failed for {}: {e}", parent.display()))?;
    if !parent_resolved.starts_with(root) {
        return Err("path is outside the open vault".into());
    }
    Ok(parent_resolved.join(name))
}

/// Destructive operations reject links rather than deleting their resolved
/// targets. Missing final entries remain valid for idempotent batch cleanup.
pub(crate) fn confine_delete_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("canonicalize vault: {e}"))?;
    let requested = Path::new(path);
    let relative = requested
        .strip_prefix(root)
        .or_else(|_| requested.strip_prefix(&canonical_root))
        .map_err(|_| "path is outside the open vault".to_string())?;
    let mut target = canonical_root;
    for component in relative.components() {
        match component {
            std::path::Component::Normal(name) => target.push(name),
            std::path::Component::CurDir => continue,
            _ => return Err("path is outside the open vault".into()),
        }
        match std::fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("refused: deletion path contains a symbolic link".into());
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("inspect deletion target: {e}")),
        }
    }
    Ok(target)
}

/// Confine a parent directory (for create_file / create_folder) to `root`.
pub fn confine_parent(root: &Path, parent: &str) -> Result<PathBuf, String> {
    let requested = Path::new(parent);
    let joined = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        root.join(requested)
    };
    if joined
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err("parent is outside the open vault".into());
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("canonicalize creation vault: {error}"))?;
    let relative = match joined
        .strip_prefix(root)
        .or_else(|_| joined.strip_prefix(&canonical_root))
    {
        Ok(relative) => relative.to_path_buf(),
        Err(_) => {
            // macOS /var and /private/var may spell the same root. Rebase only
            // the root alias, then inspect every descendant without following links.
            let mut relative = None;
            for ancestor in joined.ancestors() {
                match ancestor.canonicalize() {
                    Ok(resolved) if resolved == canonical_root => {
                        relative = Some(joined.strip_prefix(ancestor).unwrap().to_path_buf());
                        break;
                    }
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(format!("inspect creation root alias: {error}")),
                }
            }
            relative.ok_or_else(|| "parent is outside the open vault".to_string())?
        }
    };
    let mut confined = canonical_root.clone();
    for component in relative.components() {
        match component {
            std::path::Component::Normal(name) => confined.push(name),
            std::path::Component::CurDir => continue,
            _ => return Err("parent is outside the open vault".into()),
        }
        match std::fs::symlink_metadata(&confined) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err("refused: creation parent contains a symbolic link".into());
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(format!("parent is not a directory: {}", confined.display()));
            }
            Ok(_) => {
                // Normalize existing directory spelling before raw protection,
                // including case aliases on case-insensitive filesystems.
                confined = confined
                    .canonicalize()
                    .map_err(|error| format!("canonicalize creation parent: {error}"))?;
                if !confined.starts_with(&canonical_root) {
                    return Err("parent is outside the open vault".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("inspect creation parent: {error}")),
        }
    }
    Ok(confined)
}

// --- Backlink rewriting on rename -------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub path: String,
    pub name: String,
    /// 1-based line number of the first match in this file.
    pub line: usize,
    pub snippet: String,
}

/// Top-level entries myco writes and keeps. The same list as MANAGED in
/// src/lib/vaultAreas.ts — change the two together.
const MANAGED_TOP: &[&str] = &[
    "raw",
    "sessions",
    "cards",
    "ingest-reports",
    "work",
    "_inbox",
    "templates",
    "audio",
    "CLAUDE.md",
];

fn is_managed(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root)
        .ok()
        .and_then(|rel| rel.components().next())
        .is_some_and(|top| MANAGED_TOP.iter().any(|m| top.as_os_str() == *m))
}

/// Case-insensitive full-text search across the vault's .md files. Returns up to
/// `limit` hits — the first matching line per file — skipping files larger than
/// 2 MB. The person's notes are visited before the folders myco keeps, each in
/// path order: in path order cards/ and sessions/ came before wiki/, so their
/// hits filled `limit` and the person's notes never showed (UX backlog S15).
pub fn search_vault(root: &Path, query: &str, limit: usize) -> Vec<SearchHit> {
    let mut files = Vec::new();
    collect_md_files(root, &mut files);
    files.sort();
    files.sort_by_key(|p| is_managed(root, p)); // stable: path order within
    first_hits(files, query, limit)
}

/// The first matching line of each of `files`, in their order, up to `limit`.
fn first_hits(files: Vec<PathBuf>, query: &str, limit: usize) -> Vec<SearchHit> {
    // NFC both the needle and each line: an NFD-form file (pasted text,
    // synced from a mac path) is invisible to an NFC query without it. The
    // quick-check fast path keeps the per-line cost at a scan for the
    // overwhelmingly common already-NFC case.
    let needle = crate::norm::nfc(query.trim()).to_lowercase();
    if needle.is_empty() || limit == 0 {
        return Vec::new();
    }
    let mut hits = Vec::new();
    for path in files {
        if hits.len() >= limit {
            break;
        }
        match std::fs::metadata(&path) {
            Ok(m) if m.len() <= 2 * 1024 * 1024 => {}
            _ => continue, // unreadable or too large
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        for (i, raw_line) in content.lines().enumerate() {
            if crate::norm::nfc(raw_line).to_lowercase().contains(&needle) {
                hits.push(SearchHit {
                    path: path.to_string_lossy().into_owned(),
                    name: path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or_default()
                        .to_string(),
                    line: i + 1,
                    // char-based truncation keeps the snippet valid UTF-8.
                    snippet: raw_line.trim().chars().take(140).collect(),
                });
                break; // one hit per file
            }
        }
    }
    hits
}

/// `search_vault` over one top-level folder of the vault (`wiki`), so
/// `limit` counts that folder's hits only, in path order — managed is a
/// top-level notion, so a `wiki/cards/` is still the person's. A folder the
/// vault's own walk would enter, or nothing: no link, no hidden name, no path.
pub fn search_folder(root: &Path, folder: &str, query: &str, limit: usize) -> Vec<SearchHit> {
    let Some((dir, _)) = vault_entries(root)
        .into_iter()
        .find(|(e, kind)| kind.is_dir() && e.file_name() == folder)
    else {
        return Vec::new();
    };
    let mut files = Vec::new();
    collect_md_files(&dir.path(), &mut files);
    files.sort();
    first_hits(files, query, limit)
}

fn collect_md_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for (entry, kind) in vault_entries(dir) {
        let path = entry.path();
        if kind.is_dir() {
            collect_md_files(&path, out);
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("md"))
        {
            out.push(path);
        }
    }
}

/// The entries of `dir` that belong to the vault: real files and real
/// directories, no symlinks, no hidden/ignored names. Returns `(entry, kind)`
/// so a caller never has to ask the filesystem about the path again.
///
/// `file_type()` is the whole point — it reports the entry itself, where
/// `Path::is_dir()` follows the link and answers about the target. Every vault
/// walker used `is_dir()`, so one `ln -s ~ notes` inside a vault was enough to
/// walk a home directory into search results, into the context inlined for the
/// LLM, into the embedding index — and, through `rewrite_backlinks`, to *write*
/// to files outside the vault when a page was renamed. The whole confinement
/// promise (see `VaultRoot`) is that this cannot happen, and every mutating
/// command enforced it on its path argument while the walkers quietly went
/// around it. A symlink cycle also grew paths until the walk died on
/// ENAMETOOLONG.
///
/// Symlinked FILES are skipped too, not just directories. That is the same
/// escape with one less step: `write_file` follows a link and persists outside
/// the vault. The cost is real — a note deliberately symlinked into a vault
/// stops being indexed — but it fails visibly and recoverably, where following
/// fails silently and destructively.
///
/// Best-effort by design: an unreadable directory yields nothing rather than an
/// error. Callers walk vaults that can contain anything.
pub(crate) fn vault_entries(dir: &Path) -> Vec<(std::fs::DirEntry, std::fs::FileType)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|e| !is_hidden(&e.file_name()))
        .filter_map(|e| {
            let ft = e.file_type().ok()?;
            // A symlink is neither, so this drops it.
            (ft.is_dir() || ft.is_file()).then_some((e, ft))
        })
        .collect()
}

/// Read a complete directory listing with the same hidden/symlink policy.
/// Callers must not publish a partial tree or infer deletion after an error.
/// `NotFound` is preserved so an explicitly optional tree can be distinguished
/// from an unreadable one; the opened vault root itself is never optional.
pub(crate) fn vault_entries_checked(
    dir: &Path,
) -> std::io::Result<Vec<(std::fs::DirEntry, std::fs::FileType)>> {
    let context = |operation: &str, path: &Path, error: std::io::Error| {
        std::io::Error::new(
            error.kind(),
            format!("{operation} {}: {error}", path.display()),
        )
    };
    let metadata = std::fs::symlink_metadata(dir)
        .map_err(|error| context("inspect scan directory", dir, error))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("scan directory is not a real directory: {}", dir.display()),
        ));
    }
    let entries =
        std::fs::read_dir(dir).map_err(|error| context("read scan directory", dir, error))?;
    let mut result = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| context("read scan entry", dir, error))?;
        if is_hidden(&entry.file_name()) {
            continue;
        }
        let kind = entry
            .file_type()
            .map_err(|error| context("inspect scan entry", &entry.path(), error))?;
        if kind.is_dir() || kind.is_file() {
            result.push((entry, kind));
        }
    }
    Ok(result)
}

/// True if `path` lies inside the vault's immutable `raw/` tree.
///
/// `raw/` holds the source documents every wiki page cites. They are read-only
/// by rule — the repo's CLAUDE.md states this outranks any project-level rule —
/// because a citation is only worth anything if the thing cited never moved
/// under it. This is the one definition of that boundary; `agent_tools` gates
/// its write tools on it too, and a second copy is how the rule gets missed in
/// a third place.
pub(crate) fn is_raw_path(root: &Path, path: &Path) -> bool {
    let Some(component) = path
        .strip_prefix(root)
        .ok()
        .and_then(|rel| rel.components().next())
    else {
        return false;
    };
    if component.as_os_str() == "raw" {
        return true;
    }
    if !component
        .as_os_str()
        .to_str()
        .is_some_and(|name| name.eq_ignore_ascii_case("raw"))
    {
        return false;
    }
    // An existing RAW directory may be the actual raw namespace on a
    // case-insensitive volume. Distinct directories on a case-sensitive volume
    // remain distinct; uncertain case-alias inspection fails closed.
    match (
        root.join("raw").canonicalize(),
        root.join(component.as_os_str()).canonicalize(),
    ) {
        (Ok(raw), Ok(candidate)) => raw == candidate,
        (Err(error), _) | (_, Err(error)) if error.kind() == std::io::ErrorKind::NotFound => false,
        _ => true,
    }
}

/// Structural source mutations must also protect the root containing raw/.
/// Both paths are canonical and confined. A root destination remains valid
/// when moving an ordinary note into the top level of the vault.
pub(crate) fn is_raw_mutation_source(root: &Path, path: &Path) -> bool {
    path == root || is_raw_path(root, path)
}

/// Rewrite every inbound `[[wikilink]]` that targets `old_stem` to `new_stem`
/// across all .md files under `root`, preserving any `#section`, `^block`, and
/// `|alias`. Matches the target case-insensitively (Obsidian semantics). Returns
/// the number of files changed. Best-effort: files that fail to read or write
/// are skipped so a single bad file can't abort a rename that already happened.
///
/// Skips `raw/`: renaming a wiki page must not edit the sources that cite it.
pub fn rewrite_backlinks(root: &Path, old_stem: &str, new_stem: &str) -> usize {
    use regex::Regex;
    use std::sync::OnceLock;
    static LINK_RE: OnceLock<Regex> = OnceLock::new();
    let re = LINK_RE.get_or_init(|| Regex::new(r"\[\[([^\]\n]+?)\]\]").expect("static regex"));

    let old_lc = old_stem.to_lowercase();
    let mut files = Vec::new();
    collect_md_files(root, &mut files);

    let mut changed = 0usize;
    for path in files {
        if is_raw_path(root, &path) {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let mut dirty = false;
        let rewritten = re.replace_all(&content, |caps: &regex::Captures| {
            let inner = &caps[1];
            // The file target is everything before the first |alias, #section,
            // or ^block marker.
            let cut = inner.find(['|', '#', '^']).unwrap_or(inner.len());
            let (target, rest) = inner.split_at(cut);
            if target.trim().to_lowercase() == old_lc {
                dirty = true;
                format!("[[{new_stem}{rest}]]")
            } else {
                caps[0].to_string()
            }
        });
        if dirty && write_file(&path.to_string_lossy(), &rewritten).is_ok() {
            changed += 1;
        }
    }
    changed
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultMeta {
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum FileNode {
    File {
        name: String,
        path: String,
    },
    Directory {
        name: String,
        path: String,
        children: Vec<FileNode>,
    },
}

// Creates and seeds myco's own vault on first launch. We default to
// ~/Documents/myco so the folder shows up in Finder/Files, alongside the
// user's other documents — myco owns it, but it is plain markdown that
// can also be opened in Obsidian or any editor.
//
// Scaffolds the wiki workflow layout from CLAUDE.md:
//   raw/             — immutable source documents
//   wiki/            — LLM-maintained pages (with index.md, log.md)
//   daily/           — daily notes
//   ingest-reports/  — WHY reports for each ingest
// Plus a top-level welcome.md and a per-vault CLAUDE.md so Claude knows
// the wiki maintainer rules when invoked with this vault as cwd.
//
// Idempotent: only creates files that don't already exist.
pub fn ensure_default_vault() -> Result<String, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| "no home directory found".to_string())?;
    // A fresh install gets ~/Documents/myco. An install that already has the
    // pre-rename folder keeps using it: moving a directory full of the user's
    // own notes is not ours to do, and seeding a second empty vault beside it
    // would look like their writing had vanished.
    let documents = Path::new(&home).join("Documents");
    let legacy = documents.join("Memex");
    let target = if legacy.is_dir() {
        legacy
    } else {
        documents.join("myco")
    };
    seed_vault(&target)?;
    Ok(target.to_string_lossy().into_owned())
}

fn seed_vault(target: &Path) -> Result<(), String> {
    std::fs::create_dir_all(target).map_err(|e| format!("create vault root: {e}"))?;
    for sub in ["raw", "wiki", "daily", "ingest-reports"] {
        let p = target.join(sub);
        if !p.exists() {
            std::fs::create_dir_all(&p).map_err(|e| format!("create {sub}: {e}"))?;
        }
    }
    write_if_missing(&target.join("welcome.md"), WELCOME)?;
    write_if_missing(&target.join("CLAUDE.md"), VAULT_CLAUDE_MD)?;
    write_if_missing(&target.join("wiki/index.md"), WIKI_INDEX)?;
    write_if_missing(&target.join("wiki/log.md"), WIKI_LOG)?;
    // A small set of interconnected starter notes so the Graph / Provenance /
    // Overview views have content on first launch. Idempotent and deletable.
    for (rel, content) in crate::sample_vault::SAMPLE_NOTES {
        write_if_missing(&target.join(rel), content)?;
    }
    Ok(())
}

/// First-run seeding of a user-picked folder (M10 step 1). Same idempotent
/// scaffold as the default vault, but refuses when `wiki/` already holds pages:
/// the offer exists for empty folders only, and must never mix demo notes into
/// a vault someone already writes in.
pub fn seed_sample(target: &Path) -> Result<(), String> {
    let mut pages = Vec::new();
    collect_md_files(&target.join("wiki"), &mut pages);
    if !pages.is_empty() {
        return Err("vault already has wiki pages — demo seeding is for empty vaults only".into());
    }
    seed_vault(target)
}

fn write_if_missing(path: &Path, content: &str) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    std::fs::write(path, content).map_err(|e| format!("write {path:?}: {e}"))
}

const WELCOME: &str = r#"# Welcome to myco

This is your myco vault. Everything you write here lives in plain
markdown on disk — you stay in control.

## Layout

- `raw/` — drop or paste sources here (PDF, text, articles). Treat as
  immutable; myco never modifies these.
- `wiki/` — your maintained pages: entities, concepts, techniques,
  analyses, plus `index.md` and `log.md`.
- `daily/` — daily notes (`YYYY-MM-DD.md`). Use the sidebar
  **Today's note** button.
- `ingest-reports/` — auto-generated reports each time you ingest a
  source.

## Quick start

1. Type `[[` anywhere to autocomplete a wikilink to another note.
2. Click **Ingest** in the sidebar to drop a source — Claude will
   integrate it into your wiki with citations.
3. Click **Ask** to question your wiki; answers cite the pages they
   come from.
4. The **Graph** view shows every wikilink across the vault.

Your `wiki/` already holds a few interconnected starter notes (LLM
concepts) so the **Graph** isn't empty on day one — open it to explore,
then delete them whenever you like.

Open Settings → Connections to wire up your LLM provider (Claude CLI,
Anthropic API, OpenAI, Gemini, Ollama, or OpenRouter).
"#;

const VAULT_CLAUDE_MD: &str = r#"# myco Vault — Maintenance Rules

This vault is maintained by Claude through the myco desktop app. The
following rules govern how Claude reads and writes files when invoked
with this vault as cwd.

## Directory rules

- `raw/` is **immutable**. Read only. Never edit, rename, or delete.
- `wiki/` is the LLM-maintained area. You own this entirely.
- `daily/` holds daily journals; do not rewrite past dates.
- `ingest-reports/` is append-only.

## Page frontmatter

Every `wiki/` page MUST start with:

```yaml
---
title: "..."
type: source-summary | entity | concept | technique | analysis
created: YYYY-MM-DD
last_updated: YYYY-MM-DD
source_count: N
confidence: high | medium | low
status: active | superseded | disputed
---
```

## Citation rules

- Every factual claim ends with `[^src-<slug>]`.
- Footnote definitions at the bottom point to a `[[source-<slug>]]` page.
- Each citation slug corresponds to a real file in `raw/<slug>.md`.

## On ingest

When the user drops a source via myco's Ingest page, Claude is called
with the prompt and the new `raw/<slug>.md` already written. Steps:

1. Read the full source.
2. Identify pages in `wiki/` that this source affects.
3. Update those pages with new claims + citations.
4. Create the `wiki/source-<slug>.md` summary (300–500 words).
5. Update `wiki/index.md` (catalog) and append to `wiki/log.md`.
6. Write `ingest-reports/<datetime>-<slug>.md` with the WHY.
"#;

const WIKI_INDEX: &str = r#"# Index

Catalog of all wiki pages, grouped by type. These starter notes ship with a
fresh vault so the Graph has something to show — delete them anytime.

## Sources
- [[source-attention-is-all-you-need]] — Source: Attention Is All You Need
- [[source-constitutional-ai-paper]] — Source: Constitutional AI
- [[source-scaling-laws-paper]] — Source: Scaling Laws for Neural Language Models

## Entities
- [[anthropic]] — Anthropic
- [[claude]] — Claude
- [[gemini]] — Gemini
- [[google-deepmind]] — Google DeepMind
- [[gpt-4]] — GPT-4
- [[llama]] — Llama
- [[meta-ai]] — Meta AI
- [[openai]] — OpenAI

## Concepts
- [[agents]] — Agents
- [[alignment]] — Alignment
- [[compute-budget]] — Compute Budget
- [[embeddings]] — Embeddings
- [[feedforward-network]] — Feedforward Network
- [[in-context-learning]] — In-Context Learning
- [[inference-optimization]] — Inference Optimization
- [[interpretability]] — Interpretability
- [[mcp]] — Model Context Protocol
- [[planning]] — Planning
- [[reasoning]] — Reasoning
- [[residual-connections]] — Residual Connections
- [[reward-modeling]] — Reward Modeling
- [[scaling-laws]] — Scaling Laws
- [[transformer-architecture]] — Transformer Architecture
- [[vector-database]] — Vector Database

## Techniques
- [[attention-mechanism]] — Attention Mechanism
- [[byte-pair-encoding]] — Byte-Pair Encoding
- [[chain-of-thought]] — Chain-of-Thought
- [[constitutional-ai]] — Constitutional AI
- [[distillation]] — Knowledge Distillation
- [[dpo]] — Direct Preference Optimization
- [[fine-tuning]] — Fine-tuning
- [[function-calling]] — Function Calling
- [[instruction-tuning]] — Instruction Tuning
- [[kv-cache]] — KV Cache
- [[layer-normalization]] — Layer Normalization
- [[lora]] — LoRA
- [[multi-head-attention]] — Multi-Head Attention
- [[positional-encoding]] — Positional Encoding
- [[pretraining]] — Pretraining
- [[prompting]] — Prompting
- [[quantization]] — Quantization
- [[rag]] — Retrieval-Augmented Generation
- [[rlhf]] — RLHF
- [[self-attention]] — Self-Attention
- [[tokenization]] — Tokenization
- [[tool-use]] — Tool Use

## Analyses
- [[analysis-rlhf-vs-dpo]] — RLHF vs. DPO
- [[analysis-scaling-vs-data]] — Scaling vs. Data Quality
"#;

const WIKI_LOG: &str = r#"# Log

Chronological record of vault activity.
"#;

pub fn open_vault(path: &str) -> Result<VaultMeta, String> {
    if path.is_empty() {
        return Err("vault path is empty".into());
    }

    let candidate = Path::new(path);
    if !candidate.exists() {
        return Err(format!("path does not exist: {path}"));
    }
    if !candidate.is_dir() {
        return Err(format!("not a directory: {path}"));
    }

    let canonical = candidate
        .canonicalize()
        .map_err(|e| format!("failed to canonicalize {path}: {e}"))?;

    let name = canonical
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("vault")
        .to_string();

    Ok(VaultMeta {
        path: canonical.to_string_lossy().into_owned(),
        name,
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct FileContent {
    pub path: String,
    /// The full, unmodified file on disk. The editor edits and saves THIS, so a
    /// round-trip through write_file is lossless — in particular the YAML
    /// frontmatter block is preserved. `content` (below) is only the body with
    /// frontmatter stripped, for non-editing previews.
    pub raw: String,
    /// The document body with any leading YAML frontmatter removed. Used for
    /// read-only previews (NodePreview, history). NEVER write this back to disk
    /// as-is — doing so silently deletes the frontmatter.
    pub content: String,
    pub frontmatter: serde_json::Value,
}

/// Read the bytes of a source file confined to the vault's `raw/` tree
/// (Feature 6 PDF viewer). Rejects paths outside the vault or outside `raw/`,
/// and files larger than `max`. Pure over `root` so it is unit-testable.
///
/// A `[[pdf::<stem>#p…]]` pinpoint link only carries the stem, so the caller
/// hands back the flat `raw/<stem>.pdf` it was minted with — but distillation
/// archives sources to `raw/archive/YYYY-MM/<stem>.pdf` and never deletes them
/// (see the repo's Phase A distillation spec), so that literal path stops
/// existing once a source is archived. When it does, fall back to a recursive
/// by-filename search under `raw/` before giving up, mirroring how citations
/// already resolve (`provenance::build_raw_index`).
pub fn read_confined_raw(root: &Path, relpath: &str, max: u64) -> Result<Vec<u8>, String> {
    let abs = if Path::new(relpath).is_absolute() {
        relpath.to_string()
    } else {
        root.join(relpath).to_string_lossy().into_owned()
    };
    let confined = confine_path(root, &abs)?;
    let in_raw = confined
        .strip_prefix(root)
        .ok()
        .and_then(|rel| rel.components().next())
        .map(|c| c.as_os_str() == "raw")
        .unwrap_or(false);
    if !in_raw {
        return Err("read_raw_bytes only serves files under raw/".into());
    }
    let resolved = if confined.is_file() {
        confined
    } else {
        let name = confined
            .file_name()
            .ok_or_else(|| format!("no file name in {relpath}"))?;
        find_in_raw_by_name(root, name)
            .ok_or_else(|| format!("not found under raw/ (including raw/archive/): {relpath}"))?
    };
    let meta = std::fs::metadata(&resolved).map_err(|e| format!("stat failed: {e}"))?;
    if meta.len() > max {
        return Err("file is too large to open in the viewer".into());
    }
    std::fs::read(&resolved).map_err(|e| format!("read failed: {e}"))
}

/// Recursively search `root/raw/**` for a file whose name (not path) matches
/// `name`, e.g. after it moved from `raw/<stem>.pdf` to an archive subfolder.
/// Uses `vault_entries` so the search shares the same symlink/hidden-file
/// safety as every other vault walker.
///
/// `std::fs::read_dir` order is platform/filesystem-dependent, so a stack walk
/// that returned on first match would serve a non-deterministic file if the
/// same name existed under two different `raw/archive/YYYY-MM/` folders —
/// silent wrong-file substitution in the PDF viewer. Instead collect every
/// match and deterministically pick the lexicographically LAST full path:
/// zero-padded `YYYY-MM` archive folder names sort chronologically, so "last"
/// is the newest archive month, i.e. the only sane "current" copy of a name
/// that (should not, but did) end up duplicated.
fn find_in_raw_by_name(root: &Path, name: &std::ffi::OsStr) -> Option<PathBuf> {
    let mut matches = Vec::new();
    let mut stack = vec![root.join("raw")];
    while let Some(dir) = stack.pop() {
        for (entry, kind) in vault_entries(&dir) {
            let path = entry.path();
            if kind.is_dir() {
                stack.push(path);
            } else if path.file_name() == Some(name) {
                matches.push(path);
            }
        }
    }
    matches.sort();
    matches.pop()
}

pub fn read_file(path: &str) -> Result<FileContent, String> {
    let resolved = Path::new(path)
        .canonicalize()
        .map_err(|e| format!("canonicalize failed for {path}: {e}"))?;
    if !resolved.is_file() {
        return Err(format!("not a file: {path}"));
    }
    // Guard against a pathologically large file (e.g. a multi-GB or adversarial
    // doc synced into the vault) being slurped + frontmatter-parsed into memory.
    // 16 MB is far beyond any real markdown note.
    if let Ok(meta) = std::fs::metadata(&resolved) {
        if meta.len() > 16 * 1024 * 1024 {
            return Err(format!(
                "file too large to open: {} bytes (limit 16 MB)",
                meta.len()
            ));
        }
    }
    let raw = std::fs::read_to_string(&resolved).map_err(|e| format!("read failed: {e}"))?;
    let (frontmatter, content) = if frontmatter_too_deep(&raw) {
        // Adversarially deep frontmatter could overflow the YAML parser's stack;
        // refuse to parse it and treat the file as having no frontmatter.
        (serde_json::Value::Null, raw.clone())
    } else {
        match gray_matter::Matter::<gray_matter::engine::YAML>::new().parse(&raw) {
            Ok(parsed) => {
                let fm = parsed
                    .data
                    .map(pod_to_json)
                    .unwrap_or(serde_json::Value::Null);
                (fm, parsed.content)
            }
            Err(_) => (serde_json::Value::Null, raw.clone()),
        }
    };
    Ok(FileContent {
        path: resolved.to_string_lossy().into_owned(),
        raw,
        content,
        frontmatter,
    })
}

/// `pub(crate)`: also `distill::apply_proposal`'s frontmatter `payload` reader
/// (Task 7) — a proposal file's `payload:` value is exactly this same
/// gray_matter `Pod` needing the same conversion.
pub(crate) fn pod_to_json(pod: gray_matter::Pod) -> serde_json::Value {
    pod_to_json_depth(pod, 0)
}

// Frontmatter is untrusted (a synced/shared note could carry adversarial YAML).
// Cap recursion so deeply-nested arrays/maps collapse to Null instead of
// overflowing the stack on read_file.
const MAX_FM_DEPTH: usize = 64;

// Pre-parse guard: reject frontmatter whose nesting is pathologically deep BEFORE
// handing it to the YAML parser, so adversarial input (e.g. `[[[[…` thousands
// deep, or absurd indentation) can't overflow the parser's own stack. Scans only
// the leading `---`-fenced block; a cheap byte walk, no allocation.
fn frontmatter_too_deep(raw: &str) -> bool {
    if !raw.starts_with("---") {
        return false;
    }
    let mut flow_depth: i32 = 0;
    let mut max_flow: i32 = 0;
    let mut max_indent: usize = 0;
    for line in raw.lines().skip(1) {
        if line.trim_end() == "---" {
            break; // end of the frontmatter block
        }
        let indent = line.len() - line.trim_start().len();
        max_indent = max_indent.max(indent);
        for b in line.bytes() {
            match b {
                b'[' | b'{' => {
                    flow_depth += 1;
                    max_flow = max_flow.max(flow_depth);
                }
                b']' | b'}' => flow_depth -= 1,
                _ => {}
            }
        }
    }
    max_flow as usize > MAX_FM_DEPTH || max_indent > MAX_FM_DEPTH * 2
}

fn pod_to_json_depth(pod: gray_matter::Pod, depth: usize) -> serde_json::Value {
    use gray_matter::Pod;
    use serde_json::{Map, Number, Value};
    if depth >= MAX_FM_DEPTH {
        return Value::Null;
    }
    match pod {
        Pod::Null => Value::Null,
        Pod::String(s) => Value::String(s),
        Pod::Boolean(b) => Value::Bool(b),
        Pod::Integer(i) => Value::Number(Number::from(i)),
        Pod::Float(f) => Number::from_f64(f).map_or(Value::Null, Value::Number),
        Pod::Array(arr) => Value::Array(
            arr.into_iter()
                .map(|p| pod_to_json_depth(p, depth + 1))
                .collect(),
        ),
        Pod::Hash(map) => {
            let mut out = Map::new();
            for (k, v) in map {
                out.insert(k, pod_to_json_depth(v, depth + 1));
            }
            Value::Object(out)
        }
    }
}

pub fn create_file(parent: &str, name: &str, content: &str) -> Result<String, String> {
    let guard = lock_file_mutation()?;
    create_file_locked(&guard, parent, name, content)
}

fn create_file_locked(
    guard: &std::sync::MutexGuard<'_, ()>,
    parent: &str,
    name: &str,
    content: &str,
) -> Result<String, String> {
    validate_name(name)?;
    let parent_path = Path::new(parent);
    // Same as create_folder: the parent is vault-confined by the caller and may
    // legitimately not exist yet (clicking an unresolved [[wikilink]] in a vault
    // with no `wiki/` directory), so create it instead of erroring out.
    if !parent_path.exists() {
        std::fs::create_dir_all(parent_path)
            .map_err(|e| format!("mkdir parent failed for {parent}: {e}"))?;
    }
    if !parent_path.is_dir() {
        return Err(format!("parent is not a directory: {parent}"));
    }
    let target = parent_path.join(name);
    require_absent_creation_target(&target)?;
    write_file_if_unchanged_recorded_locked(guard, &target.to_string_lossy(), content, None)?;
    Ok(target.to_string_lossy().into_owned())
}

pub(crate) fn create_file_checked_at(
    root: &Path,
    parent: &str,
    name: &str,
    content: &str,
) -> Result<String, String> {
    create_file_checked_at_impl(
        root,
        parent,
        name,
        content,
        #[cfg(test)]
        || {},
    )
}

fn create_file_checked_at_impl(
    root: &Path,
    parent: &str,
    name: &str,
    content: &str,
    #[cfg(test)] before_lock: impl FnOnce(),
) -> Result<String, String> {
    validate_name(name)?;
    with_root_mutation_impl(
        root,
        |canonical_root, guard| {
            let parent = confine_parent(canonical_root, parent)?;
            if is_raw_path(canonical_root, &parent.join(name)) {
                return Err("refused: raw/ is immutable".into());
            }
            create_file_locked(guard, &parent.to_string_lossy(), name, content)
        },
        #[cfg(test)]
        before_lock,
    )
}

fn require_absent_creation_target(target: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(target) {
        Ok(_) => Err(format!("already exists: {}", target.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("inspect creation target: {error}")),
    }
}

// Directories with their own file format — a new file here must NOT get the
// wiki page schema (daily notes are dated journals, raw/ is immutable sources,
// etc.). Everything else that is markdown is a knowledge page.
const NON_WIKI_DIRS: &[&str] = &[
    "daily",
    "weekly",
    "monthly",
    "raw",
    "ingest-reports",
    "_inbox",
    "cards",
    "audio",
    "runs",
    "templates",
];

/// Whether a NEW markdown file at `path` should be seeded with the wiki page
/// schema. True for a `.md` knowledge page (wiki/, the vault root, user folders);
/// false for non-markdown and for files under a directory that owns its own
/// format. The graph and Views scan the whole vault, so a root-level note needs
/// the frontmatter too, not only `wiki/`.
pub(crate) fn should_seed_frontmatter(root: &Path, path: &Path) -> bool {
    let is_md = path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("md"));
    if !is_md {
        return false;
    }
    let Ok(rel) = path.strip_prefix(root) else {
        return false;
    };
    let first = rel
        .components()
        .next()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .unwrap_or_default();
    // A dotdir (.obsidian, .myco, .archived) or a known format-owning dir is
    // excluded; a plain filename first component means a root-level note.
    !first.starts_with('.') && !NON_WIKI_DIRS.contains(&first.as_str())
}

/// The starter body for a new `wiki/` page: the required frontmatter with
/// sensible defaults, and an H1 from the file stem. Without this a
/// human-created page has no frontmatter and is invisible to Views, gap
/// buckets and the graph's type/confidence encoding. `date` is injected so the
/// template is deterministic to test.
pub(crate) fn wiki_page_stub(stem: &str, date: &str) -> String {
    let title = stem.replace(['-', '_'], " ");
    format!(
        "---\ntype: concept\ntags:\ncreated: {date}\nconfidence: medium\nstatus: active\n---\n\n# {title}\n",
    )
}

/// Persist a completed run transcript to `<vault>/runs/<name>`, creating the
/// runs/ directory if absent. `name` must be a bare file name (no path
/// separators) so the write can't escape runs/. Overwrites an existing file of
/// the same name. Best-effort feature — the caller swallows failures.
pub fn write_run_log(vault: &Path, name: &str, content: &str) -> Result<(), String> {
    validate_name(name)?;
    let runs = vault.join("runs");
    if !runs.exists() {
        std::fs::create_dir_all(&runs).map_err(|e| format!("mkdir runs failed: {e}"))?;
    }
    let target = runs.join(name);
    std::fs::write(&target, content).map_err(|e| format!("write run log failed: {e}"))
}

/// Scaffold a minimal Obsidian config inside `vault` so it opens directly as an
/// Obsidian vault. Idempotent: creates `.obsidian/` when missing and writes
/// `app.json` only when absent, leaving any existing user config untouched.
/// Returns the `.obsidian` directory path.
pub fn scaffold_obsidian_vault(vault: &Path) -> Result<String, String> {
    let dir = vault.join(".obsidian");
    if !dir.exists() {
        std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir .obsidian failed: {e}"))?;
    }
    let app_json = dir.join("app.json");
    if !app_json.exists() {
        std::fs::write(&app_json, "{\"attachmentFolderPath\":\"assets\"}")
            .map_err(|e| format!("write app.json failed: {e}"))?;
    }
    Ok(dir.to_string_lossy().into_owned())
}

pub fn create_folder(parent: &str, name: &str) -> Result<String, String> {
    let guard = lock_file_mutation()?;
    create_folder_locked(&guard, parent, name)
}

fn create_folder_locked(
    _guard: &std::sync::MutexGuard<'_, ()>,
    parent: &str,
    name: &str,
) -> Result<String, String> {
    validate_name(name)?;
    let parent_path = Path::new(parent);
    // The parent is already confined to the vault by `confine_parent`, which now
    // admits one that does not exist yet — so materialize it rather than
    // refusing (creating `wiki/.annotations` in a vault with no `wiki/` is the
    // real case this hit).
    if !parent_path.exists() {
        std::fs::create_dir_all(parent_path)
            .map_err(|e| format!("mkdir parent failed for {parent}: {e}"))?;
    }
    if !parent_path.is_dir() {
        return Err(format!("parent is not a directory: {parent}"));
    }
    let target = parent_path.join(name);
    require_absent_creation_target(&target)?;
    std::fs::create_dir(&target).map_err(|e| format!("mkdir failed: {e}"))?;
    Ok(target.to_string_lossy().into_owned())
}

pub(crate) fn create_folder_checked_at(
    root: &Path,
    parent: &str,
    name: &str,
) -> Result<String, String> {
    create_folder_checked_at_impl(
        root,
        parent,
        name,
        #[cfg(test)]
        || {},
    )
}

fn create_folder_checked_at_impl(
    root: &Path,
    parent: &str,
    name: &str,
    #[cfg(test)] before_lock: impl FnOnce(),
) -> Result<String, String> {
    validate_name(name)?;
    with_root_mutation_impl(
        root,
        |canonical_root, guard| {
            let parent = confine_parent(canonical_root, parent)?;
            let is_raw_scaffold = parent == canonical_root && name == "raw";
            if is_raw_path(canonical_root, &parent.join(name)) && !is_raw_scaffold {
                return Err("refused: raw/ is immutable".into());
            }
            create_folder_locked(guard, &parent.to_string_lossy(), name)
        },
        #[cfg(test)]
        before_lock,
    )
}

/// Move a file or directory to the OS trash (recoverable) instead of
/// unlinking it. Deliberately NO fallback to a hard delete: if the trash
/// operation fails we surface the error rather than silently destroying data.
pub fn delete_path(path: &str) -> Result<(), String> {
    let guard = lock_file_mutation()?;
    delete_path_locked(&guard, path)
}

pub(crate) fn delete_path_locked(
    _guard: &std::sync::MutexGuard<'_, ()>,
    path: &str,
) -> Result<(), String> {
    let target = Path::new(path);
    if !target.exists() {
        return Err(format!("not found: {path}"));
    }
    trash::delete(target).map_err(|e| format!("move to trash failed: {e}"))
}

/// `delete_path` for many files at once: one trash request for the whole
/// list (one Finder call on macOS). Same rule: no fallback to a hard delete.
pub fn trash_all(paths: &[PathBuf]) -> Result<(), String> {
    let guard = lock_file_mutation()?;
    trash_all_locked(&guard, paths)
}

pub(crate) fn trash_all_locked(
    _guard: &std::sync::MutexGuard<'_, ()>,
    paths: &[PathBuf],
) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    trash::delete_all(paths).map_err(|e| format!("move to trash failed: {e}"))
}

/// Validate a pre-confined permanent-deletion batch before its first unlink.
/// A symbolic link inside a directory invalidates the whole batch.
pub(crate) fn validate_remove_all(paths: &[PathBuf]) -> Result<(), String> {
    fn validate(target: &Path) -> Result<(), String> {
        let metadata = std::fs::symlink_metadata(target)
            .map_err(|e| format!("inspect deletion target {}: {e}", target.display()))?;
        if metadata.file_type().is_symlink() {
            return Err("refused: deletion target contains a symbolic link".into());
        }
        if metadata.is_dir() {
            for entry in
                std::fs::read_dir(target).map_err(|e| format!("inspect deletion directory: {e}"))?
            {
                validate(
                    &entry
                        .map_err(|e| format!("inspect deletion entry: {e}"))?
                        .path(),
                )?;
            }
        } else if !metadata.is_file() {
            return Err("refused: deletion target is not a regular file or directory".into());
        }
        Ok(())
    }
    for target in paths {
        validate(target)?;
    }
    Ok(())
}

/// Permanently remove pre-confined entries after validating the complete batch.
pub(crate) fn remove_all(paths: &[PathBuf]) -> Result<(), String> {
    let guard = lock_file_mutation()?;
    remove_all_locked(&guard, paths)
}

pub(crate) fn remove_all_locked(
    _guard: &std::sync::MutexGuard<'_, ()>,
    paths: &[PathBuf],
) -> Result<(), String> {
    validate_remove_all(paths)?;
    for target in paths {
        let result = if target.is_dir() {
            std::fs::remove_dir_all(target)
        } else {
            std::fs::remove_file(target)
        };
        result.map_err(|e| format!("permanent deletion failed for {}: {e}", target.display()))?;
    }
    Ok(())
}

pub fn rename_path(from: &str, to_name: &str) -> Result<String, String> {
    let _guard = lock_file_mutation()?;
    rename_path_unlocked(from, to_name)
}

/// Recheck confinement and immutable-source protection inside the writer guard.
pub(crate) fn rename_path_checked_at(
    root: &Path,
    from: &str,
    to_name: &str,
) -> Result<String, String> {
    with_root_mutation(root, |canonical_root, _guard| {
        let source = confine_mutation_path(canonical_root, root, from)?;
        if is_raw_mutation_source(canonical_root, &source) {
            return Err("refused: raw/ is immutable — a source cannot be renamed".into());
        }
        rename_path_unlocked(&source.to_string_lossy(), to_name)
    })
}

fn rename_path_unlocked(from: &str, to_name: &str) -> Result<String, String> {
    validate_name(to_name)?;
    let src = Path::new(from);
    if !src.exists() {
        return Err(format!("not found: {from}"));
    }
    let parent = src.parent().ok_or_else(|| "no parent dir".to_string())?;
    let target = parent.join(to_name);
    if path_entry_exists(&target)? {
        return Err(format!("destination exists: {}", target.display()));
    }
    std::fs::rename(src, &target).map_err(|e| format!("rename failed: {e}"))?;
    Ok(target.to_string_lossy().into_owned())
}

/// Move `from` into directory `to_dir`, keeping its file name. Refuses an
/// existing target and moving a directory into itself or a descendant. Both
/// paths are canonical (confined by the caller), so starts_with is a real
/// ancestry test.
pub fn move_path(from: &str, to_dir: &str) -> Result<String, String> {
    let _guard = lock_file_mutation()?;
    move_path_unlocked(from, to_dir)
}

/// Recheck both move paths while excluding cooperating saves and mutations.
pub(crate) fn move_path_checked_at(
    root: &Path,
    from: &str,
    to_dir: &str,
) -> Result<String, String> {
    with_root_mutation(root, |canonical_root, _guard| {
        let source = confine_mutation_path(canonical_root, root, from)?;
        let destination = confine_mutation_path(canonical_root, root, to_dir)?;
        if is_raw_mutation_source(canonical_root, &source)
            || is_raw_path(canonical_root, &destination)
        {
            return Err("refused: raw/ is immutable — sources cannot be moved in or out".into());
        }
        move_path_unlocked(&source.to_string_lossy(), &destination.to_string_lossy())
    })
}

fn move_path_unlocked(from: &str, to_dir: &str) -> Result<String, String> {
    let src = Path::new(from);
    if !src.exists() {
        return Err(format!("not found: {from}"));
    }
    let dest = Path::new(to_dir);
    if !dest.is_dir() {
        return Err(format!("not a directory: {to_dir}"));
    }
    if dest.starts_with(src) {
        return Err("cannot move a folder into itself".into());
    }
    let name = src
        .file_name()
        .ok_or_else(|| format!("no file name in {from}"))?;
    let target = dest.join(name);
    if path_entry_exists(&target)? {
        return Err(format!("destination exists: {}", target.display()));
    }
    std::fs::rename(src, &target).map_err(|e| format!("move failed: {e}"))?;
    Ok(target.to_string_lossy().into_owned())
}

/// A `raw/<stem>.md` path that does not exist yet, suffixing `-2`, `-3`, … on
/// collision. Returned vault-relative.
///
/// raw/ is immutable, so ingesting a second source under a title that already
/// has a raw file must not overwrite the first — it gets its own original. Same
/// suffix scheme as the archive path. A stem an archived copy
/// (`raw/archive/**`) holds is taken too: citations and `wiki/source-<stem>.md`
/// name a source by its stem alone, so a second body under it would make
/// both mean two files.
pub fn available_raw_path(root: &Path, stem: &str) -> String {
    let raw = root.join("raw");
    let mut archived = Vec::new();
    collect_md_files(&raw.join("archive"), &mut archived);
    let taken = |s: &str| {
        raw.join(format!("{s}.md")).exists()
            || archived
                .iter()
                .any(|p| p.file_stem().is_some_and(|f| f == s))
    };
    if !taken(stem) {
        return format!("raw/{stem}.md");
    }
    let mut n = 2;
    loop {
        let name = format!("{stem}-{n}");
        if !taken(&name) {
            return format!("raw/{name}.md");
        }
        n += 1;
    }
}

/// The vault-relative raw/ file whose bytes equal `content`: a top-level
/// `raw/*.md`, or any `.md` under `raw/archive/` (where distill's archive pass
/// moves them). None when there is none.
///
/// raw/ is immutable, so every copy an ingest writes is permanent. A source
/// whose model call failed was retried with a fresh `-2`, `-3`, … copy each
/// time (one session left 19). Ingest asks this first and reuses the hit.
/// Byte equality is the match, after a length check: no hash to collide, and
/// a file of any other size is never read.
pub fn find_raw_copy(root: &Path, content: &str) -> Option<String> {
    let want = content.as_bytes();
    let hit = raw_copies(root).into_iter().find(|p| {
        std::fs::metadata(p).is_ok_and(|m| m.len() == want.len() as u64)
            && std::fs::read(p).is_ok_and(|b| b == want)
    })?;
    let rel = hit.strip_prefix(root).ok()?;
    Some(rel.to_string_lossy().replace('\\', "/"))
}

/// Whether another raw/ copy (top level or `raw/archive/**`) has the file
/// stem of `rel`. Citations (`[^src-<stem>]`) and the summary page
/// (`wiki/source-<stem>.md`) name a source by stem alone, so ingesting `rel`
/// would write over the other body's summary. Vaults from before
/// available_raw_path checked raw/archive/ can hold such pairs; raw/ being
/// immutable, they stay.
pub fn raw_stem_shared(root: &Path, rel: &str) -> bool {
    let me = root.join(rel);
    let Some(stem) = me.file_stem() else {
        return false;
    };
    raw_copies(root)
        .iter()
        .any(|p| *p != me && p.file_stem() == Some(stem))
}

/// `<!-- myco:source-sha256 <hex> -->` for the file at `path`: names an image
/// or recording by its bytes. Its description or transcript is model output,
/// sampled anew on every call, so a retried `_inbox/` picture made a new raw
/// payload each time and find_raw_copy never matched it: one more permanent
/// copy per failed pass. Ingest files the first text under this marker and
/// reads it back from that raw copy on a retry (find_marked_raw_copy).
pub fn source_marker(path: &Path) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    std::io::copy(&mut std::fs::File::open(path)?, &mut hasher)?;
    Ok(format!(
        "<!-- myco:source-sha256 {:x} -->",
        hasher.finalize()
    ))
}

/// The whole raw copy (top level or `raw/archive/**`) whose header carries
/// `marker`. Ingest writes `# <title>\n\n<marker>`, and the title is a file
/// name, so the marker sits in the first few hundred bytes; only those are
/// read from the files that do not match.
pub fn find_marked_raw_copy(root: &Path, marker: &str) -> Option<String> {
    use std::io::Read;
    const HEAD: u64 = 1024;
    raw_copies(root).into_iter().find_map(|p| {
        let mut head = Vec::new();
        std::fs::File::open(&p)
            .ok()?
            .take(HEAD)
            .read_to_end(&mut head)
            .ok()?;
        String::from_utf8_lossy(&head)
            .contains(marker)
            .then(|| std::fs::read_to_string(&p).ok())?
    })
}

/// Where ingest's raw copies live: the top-level `raw/*.md` files and every
/// `.md` under `raw/archive/` (distill's archive pass moves them there).
fn raw_copies(root: &Path) -> Vec<PathBuf> {
    let raw = root.join("raw");
    let mut files: Vec<PathBuf> = vault_entries(&raw)
        .into_iter()
        .filter(|(_, kind)| kind.is_file())
        .map(|(e, _)| e.path())
        .filter(|p| {
            p.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("md"))
        })
        .collect();
    collect_md_files(&raw.join("archive"), &mut files);
    files
}

/// Move a consumed inbox source into `<its dir>/.archived/`, never delete it.
///
/// Mirrors the headless daemon (`automation/autoingest.py::_archive`) exactly so
/// the two auto-ingest paths behave the same: on success the original survives
/// in `.archived/`, not the trash, so a half-failed run cannot lose a source
/// whose only other copy the ingest was still writing. Collisions get a
/// `-2`, `-3`, … suffix, same as the daemon.
pub fn archive_inbox_source(from: &str) -> Result<String, String> {
    let _guard = lock_file_mutation()?;
    archive_inbox_source_unlocked(from)
}

/// Archive only a confined inbox source, optionally bound to its captured bytes.
/// The SHA check and move share the cooperating writer guard; no raw copy is made.
pub(crate) fn archive_inbox_source_checked_at(
    root: &Path,
    from: &str,
    expected_sha256: Option<&str>,
) -> Result<String, String> {
    archive_inbox_source_checked_impl(
        root,
        from,
        expected_sha256,
        || Ok(()),
        #[cfg(test)]
        || {},
    )
}

/// Recheck native processing/publication proof while the same writer guard
/// protects the final source check and archive. The validator must not acquire
/// the writer lock again or wait for inference/transport.
pub(crate) fn archive_inbox_source_checked_with_at(
    root: &Path,
    from: &str,
    expected_sha256: &str,
    validate: impl FnOnce() -> Result<(), String>,
) -> Result<String, String> {
    archive_inbox_source_checked_impl(
        root,
        from,
        Some(expected_sha256),
        validate,
        #[cfg(test)]
        || {},
    )
}

fn archive_inbox_source_checked_impl(
    root: &Path,
    from: &str,
    expected_sha256: Option<&str>,
    validate: impl FnOnce() -> Result<(), String>,
    #[cfg(test)] before_move: impl FnOnce(),
) -> Result<String, String> {
    with_root_mutation(root, |canonical_root, _guard| {
        let source = confine_mutation_path(canonical_root, root, from)?;
        if is_raw_path(canonical_root, &source) {
            return Err("refused: raw/ is immutable — a source cannot be archived".into());
        }
        let inbox = canonical_root.join("_inbox");
        if !source.starts_with(&inbox) {
            return Err("refused: only _inbox sources can be archived".into());
        }
        let parent = source.parent().ok_or("no parent dir")?;
        let archive =
            confine_delete_path(canonical_root, &parent.join(".archived").to_string_lossy())?;
        if !archive.starts_with(&inbox) {
            return Err("refused: archive destination must stay within _inbox".into());
        }
        if let Some(expected) = expected_sha256 {
            use sha2::{Digest, Sha256};
            let bytes =
                std::fs::read(&source).map_err(|error| format!("reread inbox source: {error}"))?;
            if format!("{:x}", Sha256::digest(bytes)) != expected {
                return Err(
                    "inbox source changed while archiving; source was left in place".into(),
                );
            }
        }
        #[cfg(test)]
        before_move();
        validate()?;
        archive_inbox_source_unlocked(&source.to_string_lossy())
    })
}

fn archive_inbox_source_unlocked(from: &str) -> Result<String, String> {
    let src = Path::new(from);
    if !src.is_file() {
        return Err(format!("not a file: {from}"));
    }
    let parent = src.parent().ok_or_else(|| "no parent dir".to_string())?;
    let archive = parent.join(".archived");
    std::fs::create_dir_all(&archive).map_err(|e| format!("mkdir .archived failed: {e}"))?;
    let name = src
        .file_name()
        .ok_or_else(|| "no file name".to_string())?
        .to_string_lossy()
        .into_owned();
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned());
    let ext = src.extension().map(|s| s.to_string_lossy().into_owned());
    let mut dest = archive.join(&name);
    let mut n = 2;
    while path_entry_exists(&dest)? {
        let candidate = match (&stem, &ext) {
            (Some(s), Some(e)) => format!("{s}-{n}.{e}"),
            (Some(s), None) => format!("{s}-{n}"),
            _ => format!("{name}-{n}"),
        };
        dest = archive.join(candidate);
        n += 1;
    }
    std::fs::rename(src, &dest).map_err(|e| format!("archive failed: {e}"))?;
    Ok(dest.to_string_lossy().into_owned())
}

fn path_entry_exists(path: &Path) -> Result<bool, String> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("inspect destination {}: {error}", path.display())),
    }
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("name is empty".into());
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err("name contains invalid characters".into());
    }
    if name == "." || name == ".." {
        return Err("name reserved".into());
    }
    Ok(())
}

pub const MAX_ASSET_BYTES: usize = 20 * 1024 * 1024;
const ASSET_EXTS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];

/// Write `bytes` as `<root>/assets/<name>`, creating `assets/` and suffixing
/// `-2`, `-3`, … on collision (the archive_inbox_source idiom). `name` is a bare
/// `stem.ext` whose extension must be an allow-listed image type. Plain
/// `std::fs::write`: a fresh, unique file needs none of write_file's overwrite
/// atomicity. Never touches raw/. Returns the vault-relative `assets/<name>`.
pub fn write_asset(root: &Path, name: &str, bytes: &[u8]) -> Result<String, String> {
    validate_name(name)?;
    let (stem, ext) = name
        .rsplit_once('.')
        .filter(|(stem, ext)| {
            !stem.is_empty() && ASSET_EXTS.iter().any(|a| a.eq_ignore_ascii_case(ext))
        })
        .ok_or_else(|| format!("unsupported asset type: {name}"))?;
    if bytes.len() > MAX_ASSET_BYTES {
        return Err(format!(
            "asset is larger than {} MB",
            MAX_ASSET_BYTES / (1024 * 1024)
        ));
    }
    let dir = root.join("assets");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir assets failed: {e}"))?;
    let mut final_name = name.to_string();
    let mut n = 2;
    while dir.join(&final_name).exists() {
        final_name = format!("{stem}-{n}.{ext}");
        n += 1;
    }
    std::fs::write(dir.join(&final_name), bytes).map_err(|e| format!("write asset failed: {e}"))?;
    Ok(format!("assets/{final_name}"))
}

/// Copy a Finder-dropped image at `src` into `assets/<name>` under write_asset's
/// rules (allow-list, size cap, collision suffix). `src` is an arbitrary path the
/// user dropped, so it is not confined — reading it is harmless and the write
/// still lands only in assets/ — but it must resolve to a regular file. The size
/// is checked on metadata first so an oversize file is refused without reading it.
pub fn copy_asset(root: &Path, name: &str, src: &str) -> Result<String, String> {
    let src = Path::new(src)
        .canonicalize()
        .map_err(|e| format!("cannot read {src}: {e}"))?;
    let meta =
        std::fs::metadata(&src).map_err(|e| format!("cannot read {}: {e}", src.display()))?;
    if !meta.is_file() {
        return Err(format!("not a regular file: {}", src.display()));
    }
    if meta.len() > MAX_ASSET_BYTES as u64 {
        return Err(format!(
            "asset is larger than {} MB",
            MAX_ASSET_BYTES / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(&src).map_err(|e| format!("cannot read {}: {e}", src.display()))?;
    write_asset(root, name, &bytes)
}

pub fn write_file(path: &str, content: &str) -> Result<(), String> {
    let _guard = FILE_WRITE_LOCK
        .lock()
        .map_err(|_| "file write lock poisoned".to_string())?;
    atomic_write_file(path, content, true)
}

/// Replace only the exact bytes read by the caller, or create only if absent.
/// `Some` is a lowercase SHA256 of UTF-8 source bytes; `None` requires absence,
/// not an empty file. The caller must enforce vault confinement/raw immutability.
/// Only cooperating `write_file` calls in this process share this precondition.
pub fn write_file_if_unchanged(
    path: &str,
    content: &str,
    expected_sha256: Option<&str>,
) -> Result<(), String> {
    write_file_if_unchanged_recorded(path, content, expected_sha256).map(|_| ())
}

#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordedFileIdentity {
    device: u64,
    inode: u64,
    changed_seconds: i64,
    changed_nanoseconds: i64,
}

#[derive(Clone, Debug)]
pub(crate) struct RecordedWriteReceipt {
    pub path: PathBuf,
    pub revision: String,
    pub file_identity: Option<RecordedFileIdentity>,
    pub native_created: bool,
    // Keeping the persisted handle open prevents inode reuse from restoring
    // ownership after a path replacement. This capability is never serialized.
    #[cfg(unix)]
    file_handle: std::sync::Arc<std::fs::File>,
    #[cfg(unix)]
    retained_anchor: Option<std::sync::Arc<compiler_pin::CompilerAnchorLease>>,
}

fn recorded_identity(metadata: &std::fs::Metadata) -> Option<RecordedFileIdentity> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(RecordedFileIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
            changed_seconds: metadata.ctime(),
            changed_nanoseconds: metadata.ctime_nsec(),
        })
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        None
    }
}

/// Return facts from the actual persisted handle while holding the writer lock.
/// Absence-CAS success alone establishes `native_created`; caller booleans do not.
pub(crate) fn write_file_if_unchanged_recorded(
    path: &str,
    content: &str,
    expected_sha256: Option<&str>,
) -> Result<RecordedWriteReceipt, String> {
    let guard = lock_file_mutation()?;
    write_file_if_unchanged_recorded_locked(&guard, path, content, expected_sha256)
}

pub(crate) fn write_file_if_unchanged_recorded_locked(
    guard: &std::sync::MutexGuard<'_, ()>,
    path: &str,
    content: &str,
    expected_sha256: Option<&str>,
) -> Result<RecordedWriteReceipt, String> {
    write_file_if_unchanged_recorded_locked_impl(
        guard,
        path,
        content,
        expected_sha256,
        #[cfg(test)]
        |_| Ok(()),
    )
}

pub(crate) fn write_file_if_unchanged_recorded_locked_impl(
    _guard: &std::sync::MutexGuard<'_, ()>,
    path: &str,
    content: &str,
    expected_sha256: Option<&str>,
    #[cfg(test)] after_persist: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<RecordedWriteReceipt, String> {
    use sha2::{Digest, Sha256};
    if expected_sha256.is_some_and(|hash| {
        hash.len() != 64
            || !hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }) {
        return Err("invalid expected SHA256".into());
    }
    let current = match std::fs::read(path) {
        Ok(bytes) => Some(format!("{:x}", Sha256::digest(bytes))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("read before write failed: {error}")),
    };
    if current.as_deref() != expected_sha256 {
        return Err("write conflict: file changed since it was read".into());
    }
    let mut file = atomic_persist_file(path, content, expected_sha256.is_some())?;
    #[cfg(test)]
    after_persist(Path::new(path))
        .map_err(|error| format!("write persisted but receipt checkpoint failed: {error}"))?;
    use std::io::{Read, Seek, SeekFrom};
    file.seek(SeekFrom::Start(0))
        .map_err(|e| format!("write persisted but receipt seek failed: {e}"))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("write persisted but receipt read failed: {e}"))?;
    let revision = format!("{:x}", Sha256::digest(&bytes));
    if revision != format!("{:x}", Sha256::digest(content.as_bytes())) {
        return Err("write persisted but receipt bytes differ from submitted content".into());
    }
    let metadata = file
        .metadata()
        .map_err(|e| format!("write persisted but receipt metadata failed: {e}"))?;
    let identity = recorded_identity(&metadata);
    let named = std::fs::symlink_metadata(path)
        .map_err(|e| format!("write persisted but receipt target inspection failed: {e}"))?;
    if named.file_type().is_symlink() || recorded_identity(&named) != identity {
        return Err("write persisted but target identity changed before receipt".into());
    }
    Ok(RecordedWriteReceipt {
        path: PathBuf::from(path),
        revision,
        file_identity: identity,
        native_created: expected_sha256.is_none(),
        #[cfg(unix)]
        file_handle: std::sync::Arc::new(file),
        #[cfg(unix)]
        retained_anchor: None,
    })
}

fn atomic_write_file(path: &str, content: &str, should_replace: bool) -> Result<(), String> {
    atomic_persist_file(path, content, should_replace).map(|_| ())
}

fn atomic_persist_file(
    path: &str,
    content: &str,
    should_replace: bool,
) -> Result<std::fs::File, String> {
    let target = Path::new(path);
    let parent = target
        .parent()
        .ok_or_else(|| format!("no parent dir for {path}"))?;
    if !parent.exists() {
        return Err(format!("parent does not exist: {}", parent.display()));
    }

    use std::io::Write;
    let mut tmp = tempfile::Builder::new()
        .prefix(".myco-tmp-")
        .suffix(".md")
        .tempfile_in(parent)
        .map_err(|e| format!("tempfile create failed: {e}"))?;
    tmp.write_all(content.as_bytes())
        .map_err(|e| format!("tempfile write failed: {e}"))?;
    tmp.as_file_mut()
        .sync_all()
        .map_err(|e| format!("tempfile sync failed: {e}"))?;
    let persisted = if should_replace {
        tmp.persist(target)
            .map_err(|e| format!("rename failed: {}", e.error))?
    } else {
        tmp.persist_noclobber(target).map_err(|e| {
            if e.error.kind() == std::io::ErrorKind::AlreadyExists {
                "write conflict: file was created before save".to_string()
            } else {
                format!("create persist failed: {}", e.error)
            }
        })?
    };
    // Syncing the file's data is not enough: the rename itself lives in the
    // parent directory, so on a crash the rename can be lost even though the
    // temp file's bytes were flushed. fsync the parent directory to make the
    // rename durable. Best-effort — directory fsync is meaningful on unix and a
    // no-op (often EINVAL/!err) on windows, so we never surface its failure.
    #[cfg(unix)]
    {
        use std::fs::File;
        let _ = File::open(parent).and_then(|d| d.sync_all());
    }
    Ok(persisted)
}

/// The caller must already hold the common file writer guard. This preserves
/// the same identity/hash checks without lock re-entry inside checked archive.
pub(crate) fn verify_recorded_file_unlocked(receipt: &RecordedWriteReceipt) -> Result<(), String> {
    #[cfg(unix)]
    if receipt.retained_anchor.is_some() {
        return compiler_pin::verify_anchored_receipt(receipt);
    }
    use sha2::{Digest, Sha256};
    let expected_identity = receipt
        .file_identity
        .as_ref()
        .ok_or("native file identity is unsupported on this platform")?;
    let named = std::fs::symlink_metadata(&receipt.path)
        .map_err(|e| format!("inspect publication target: {e}"))?;
    if !named.file_type().is_file() || recorded_identity(&named).as_ref() != Some(expected_identity)
    {
        return Err("publication target identity changed".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if named.nlink() != 1 {
            return Err("publication target has unowned hard links".into());
        }
    }
    use std::io::Read;
    let mut file =
        std::fs::File::open(&receipt.path).map_err(|e| format!("open publication target: {e}"))?;
    let before = file
        .metadata()
        .map_err(|e| format!("inspect opened publication: {e}"))?;
    if recorded_identity(&before).as_ref() != Some(expected_identity) {
        return Err("opened publication identity changed".into());
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|e| format!("read publication target: {e}"))?;
    let after = file
        .metadata()
        .map_err(|e| format!("inspect publication after read: {e}"))?;
    let current = std::fs::symlink_metadata(&receipt.path)
        .map_err(|e| format!("reinspect publication target: {e}"))?;
    if format!("{:x}", Sha256::digest(&bytes)) != receipt.revision
        || recorded_identity(&after).as_ref() != Some(expected_identity)
        || !current.file_type().is_file()
        || recorded_identity(&current).as_ref() != Some(expected_identity)
    {
        return Err("publication bytes or identity changed".into());
    }
    Ok(())
}

/// Verify one native receipt. The caller must separately enforce confinement.
pub(crate) fn verify_recorded_file(receipt: &RecordedWriteReceipt) -> Result<(), String> {
    let _guard = FILE_WRITE_LOCK
        .lock()
        .map_err(|_| "file write lock poisoned")?;
    verify_recorded_file_unlocked(receipt)
}

/// Read the file still named by a retained native handle, allowing in-place
/// human edits. Callers must check confinement and their exact owned section;
/// this does not establish byte preservation, deletion or restart authority.
#[cfg(test)]
pub(crate) fn read_same_native_file(
    receipt: &RecordedWriteReceipt,
) -> Result<(String, String), String> {
    let _guard = FILE_WRITE_LOCK
        .lock()
        .map_err(|_| "file write lock poisoned")?;
    #[cfg(unix)]
    if receipt.retained_anchor.is_some() {
        return compiler_pin::read_anchored_receipt(receipt);
    }
    #[cfg(not(unix))]
    {
        let _ = receipt;
        Err("retained native file identity is unsupported on this platform".into())
    }
    #[cfg(unix)]
    {
        use sha2::{Digest, Sha256};
        use std::io::Read;
        use std::os::unix::fs::MetadataExt;
        let named = std::fs::symlink_metadata(&receipt.path)
            .map_err(|error| format!("inspect retained publication target: {error}"))?;
        let held = receipt
            .file_handle
            .metadata()
            .map_err(|error| format!("inspect retained publication handle: {error}"))?;
        let same_file = |metadata: &std::fs::Metadata| {
            metadata.is_file()
                && metadata.dev() == held.dev()
                && metadata.ino() == held.ino()
                && metadata.nlink() == 1
        };
        if named.file_type().is_symlink() || !same_file(&named) {
            return Err("retained publication path identity changed".into());
        }
        let mut file = std::fs::File::open(&receipt.path)
            .map_err(|error| format!("open retained publication: {error}"))?;
        let before = file
            .metadata()
            .map_err(|error| format!("inspect opened retained publication: {error}"))?;
        if !same_file(&before) || before.len() > 4 * 1024 * 1024 {
            return Err("retained publication identity or size changed".into());
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(4 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("read retained publication: {error}"))?;
        let after = file
            .metadata()
            .map_err(|error| format!("inspect retained publication after read: {error}"))?;
        let current = std::fs::symlink_metadata(&receipt.path)
            .map_err(|error| format!("reinspect retained publication: {error}"))?;
        if bytes.len() > 4 * 1024 * 1024
            || recorded_identity(&before) != recorded_identity(&after)
            || recorded_identity(&after) != recorded_identity(&current)
            || !same_file(&after)
            || !same_file(&current)
            || current.file_type().is_symlink()
        {
            return Err("retained publication changed while being read".into());
        }
        let revision = format!("{:x}", Sha256::digest(&bytes));
        let text = String::from_utf8(bytes).map_err(|_| "retained publication is not UTF-8")?;
        Ok((text, revision))
    }
}

/// Delete only an unchanged file created by the recorded absence-CAS operation.
/// This lock covers cooperating writers, not arbitrary external filesystem races.
pub(crate) fn remove_recorded_file(receipt: &RecordedWriteReceipt) -> Result<(), String> {
    #[cfg(unix)]
    if receipt.retained_anchor.is_some() {
        return Err("retained compiler anchor does not grant deletion authority".into());
    }
    if !receipt.native_created {
        return Err("native write receipt does not grant creation undo".into());
    }
    let _guard = FILE_WRITE_LOCK
        .lock()
        .map_err(|_| "file write lock poisoned")?;
    verify_recorded_file_unlocked(receipt)?;
    std::fs::remove_file(&receipt.path).map_err(|e| format!("remove recorded publication: {e}"))
}

pub fn list_files(root: &str) -> Result<Vec<FileNode>, String> {
    let root_path = Path::new(root)
        .canonicalize()
        .map_err(|e| format!("canonicalize failed for {root}: {e}"))?;
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    walk_dir(&root_path).map_err(|e| format!("walk failed: {e}"))
}

/// A cheap fingerprint of the vault: a hash over every .md file's path, mtime
/// and length, plus the path of every folder and of every note under the
/// staging dirs — the shape the sidebar tree shows (see
/// [`collect_revision_entries`]).
///
/// This exists so a caller can ask "did anything change?" without paying to
/// rebuild what it already has. The app polls for external edits (Obsidian,
/// Finder, a finished ingest) every few seconds, and answering that with a full
/// link-graph rebuild means reading and parsing every note in the vault —
/// measured at 305 ms warm (1.85 s cold) on a 10k-note vault, forever, in the
/// overwhelmingly common case where nothing changed at all. This walk only
/// stats.
///
/// Deliberately not a content hash: mtime+len is what a filesystem gives away
/// for free. It cannot see an edit that preserves both, which in practice means
/// a same-size write inside one mtime tick — the graph then updates on the next
/// real change or on the user's next explicit action. Paying to read every file
/// to close that gap would reintroduce the cost this removes.
pub fn vault_revision(root: &str) -> Result<u64, String> {
    let root_path = Path::new(root)
        .canonicalize()
        .map_err(|e| format!("canonicalize failed for {root}: {e}"))?;
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let mut entries: Vec<(String, i64, u64)> = Vec::new();
    collect_revision_entries(&root_path, &root_path, false, &mut entries)
        .map_err(|error| format!("revision scan failed: {error}"))?;
    // Sort so the hash depends on the vault's content, not on the order the
    // filesystem happened to hand back directory entries.
    entries.sort();
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for (path, mtime, len) in &entries {
        std::hash::Hash::hash(path, &mut h);
        std::hash::Hash::hash(mtime, &mut h);
        std::hash::Hash::hash(len, &mut h);
    }
    Ok(std::hash::Hasher::finish(&h))
}

/// Stat-only walk backing `vault_revision`. Incomplete scans return an error
/// instead of publishing a fingerprint that implies notes disappeared.
///
/// Two consumers poll this: the link graph, which reads non-staging `.md`
/// content, and the sidebar tree, which shows every folder (empty ones too) and
/// every `.md` NAME, staging dirs included. So folders and staging notes go in
/// by path alone — no stat, and a content edit there cannot move the revision
/// (the graph never reads it; one real vault holds 985 session logs) — while an
/// added, removed or renamed one does, or the tree would never learn of it.
fn collect_revision_entries(
    root: &Path,
    dir: &Path,
    staging: bool,
    out: &mut Vec<(String, i64, u64)>,
) -> std::io::Result<()> {
    for (entry, kind) in vault_entries_checked(dir)? {
        let path = entry.path();
        let key = path.to_string_lossy().into_owned();
        if kind.is_dir() {
            out.push((key, 0, 0));
            let staging = staging || crate::index::is_staging_dir(root, &path);
            collect_revision_entries(root, &path, staging, out)?;
        } else if is_markdown(&path) {
            if staging {
                out.push((key, 0, 0));
                continue;
            }
            let meta = entry.metadata()?;
            let mtime = meta
                .modified()?
                .duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            out.push((key, mtime, meta.len()));
        }
    }
    Ok(())
}

/// Flat (path, mtime_unix_seconds) list for every .md file under root.
/// Drives the graph timelapse — nodes are revealed in mtime order.
pub fn file_mtimes(root: &str) -> Result<Vec<(String, i64)>, String> {
    let root_path = Path::new(root)
        .canonicalize()
        .map_err(|e| format!("canonicalize failed for {root}: {e}"))?;
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }
    let mut out = Vec::new();
    collect_mtimes(&root_path, &mut out).map_err(|e| format!("walk failed: {e}"))?;
    Ok(out)
}

fn collect_mtimes(dir: &Path, out: &mut Vec<(String, i64)>) -> std::io::Result<()> {
    for (entry, kind) in vault_entries_checked(dir)? {
        let path = entry.path();
        if kind.is_dir() {
            collect_mtimes(&path, out)?;
        } else if is_markdown(&path) {
            let mtime = entry
                .metadata()?
                .modified()?
                .duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            out.push((path.to_string_lossy().into_owned(), mtime));
        }
    }
    Ok(())
}

fn walk_dir(dir: &Path) -> std::io::Result<Vec<FileNode>> {
    let mut entries = vault_entries_checked(dir)?;
    entries.sort_by_key(|(e, _)| e.file_name());

    let mut nodes = Vec::with_capacity(entries.len());
    for (entry, kind) in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let path_str = path.to_string_lossy().into_owned();
        if kind.is_dir() {
            // Always emit directories, including empty ones, so the seeded
            // scaffold folders (raw/, ingest-reports/) are visible and
            // navigable before they contain any .md file — like Obsidian.
            let children = walk_dir(&path)?;
            nodes.push(FileNode::Directory {
                name,
                path: path_str,
                children,
            });
        } else if is_markdown(&path) {
            nodes.push(FileNode::File {
                name,
                path: path_str,
            });
        }
    }
    Ok(nodes)
}

/// Concatenate the vault's markdown (CLAUDE.md schema + wiki/ + raw/) into a
/// single text blob, bounded to `max_bytes`. This lets non-tool providers
/// (Anthropic/OpenAI/Google/Ollama HTTP APIs) answer questions and run lint
/// against real vault content. Tool-capable providers (the Claude CLI) read
/// files directly and never need this.
pub fn read_vault_context(root: &str, max_bytes: usize) -> Result<String, String> {
    let root_path = Path::new(root)
        .canonicalize()
        .map_err(|e| format!("canonicalize failed for {root}: {e}"))?;
    if !root_path.is_dir() {
        return Err(format!("not a directory: {root}"));
    }

    // Emit in priority order, not alphabetical order. The byte budget is spent
    // top-down and truncates at the first file that does not fit, so whatever
    // comes first is what a small-budget caller actually receives.
    //
    // wiki/ leads because it is the material an answer is drawn from. Sorting
    // every path together used to put CLAUDE.md first (uppercase sorts ahead of
    // "raw"/"wiki"), which silently starved the builtin model: its context
    // budget is 6 KB, and a vault's CLAUDE.md alone — 10.6 KB in this repo's
    // karpathy vault — consumed all of it, so the model answered from schema
    // boilerplate with zero wiki pages in front of it.
    //
    // CLAUDE.md still follows, and raw/ source dumps last: at a cloud-sized
    // budget everything fits and lint keeps its schema rules, while a tight
    // budget now spends itself on pages instead of instructions.
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    let push_dir =
        |dir: std::path::PathBuf, out: &mut Vec<std::path::PathBuf>| -> Result<(), String> {
            if !dir.is_dir() {
                return Ok(());
            }
            let mut found = Vec::new();
            collect_markdown(&dir, &mut found).map_err(|e| format!("walk failed: {e}"))?;
            found.sort();
            found.dedup();
            out.extend(found);
            Ok(())
        };
    push_dir(root_path.join("wiki"), &mut files)?;
    let claude = root_path.join("CLAUDE.md");
    if claude.is_file() {
        files.push(claude);
    }
    push_dir(root_path.join("raw"), &mut files)?;

    let mut out = String::new();
    let mut truncated = false;
    for path in files {
        if out.len() >= max_bytes {
            truncated = true;
            break;
        }
        let rel = path.strip_prefix(&root_path).unwrap_or(&path);
        let body = match std::fs::read_to_string(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        // Vault-relative paths are addressed with '/' everywhere else the model
        // sees them (wikilinks, page ids, citations), so normalise the separator
        // instead of handing Windows a '\' form the model has never been shown.
        let header = format!(
            "\n\n===== {} =====\n",
            rel.to_string_lossy().replace('\\', "/")
        );
        // If even the section header can't fit in the remaining budget, stop
        // rather than overshoot. (A header is small, but the running total must
        // stay bounded — a single header should not push `out` past max_bytes.)
        if out.len().saturating_add(header.len()) > max_bytes {
            truncated = true;
            break;
        }
        out.push_str(&header);
        // Truncate this file's body to whatever budget is left so a single large
        // file can never overshoot max_bytes by its whole size. Previously the
        // budget was only checked between files, so one big file blew past it.
        let remaining = max_bytes.saturating_sub(out.len());
        if body.len() > remaining {
            out.push_str(safe_truncate(&body, remaining));
            out.push_str("\n…(truncated)…");
            truncated = true;
            break;
        }
        out.push_str(&body);
    }
    if truncated {
        out.push_str("\n\n(Note: vault context was truncated to fit the size budget.)");
    }
    Ok(out)
}

fn collect_markdown(dir: &Path, out: &mut Vec<std::path::PathBuf>) -> std::io::Result<()> {
    for (entry, kind) in vault_entries(dir) {
        let path = entry.path();
        if kind.is_dir() {
            collect_markdown(&path, out)?;
        } else if is_markdown(&path) {
            out.push(path);
        }
    }
    Ok(())
}

/// Largest prefix of `s` no longer than `max` bytes that ends on a UTF-8 char
/// boundary (so we never slice a multi-byte character in half).
fn safe_truncate(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// What the vault never walks into. One definition, in `index`, which the
/// registry also uses — the rule decides what a vault *is*, and it had already
/// been copied once.
fn is_hidden(name: &std::ffi::OsStr) -> bool {
    crate::index::is_hidden_name(name)
}

fn is_markdown(path: &Path) -> bool {
    path.extension().and_then(|s| s.to_str()) == Some("md")
}

/// `SF_DATALESS` (chflags(2)): the file's bytes live in the cloud, not on
/// disk. macOS Sonoma+ iCloud Drive with "Optimise Mac Storage" leaves evicted
/// notes under their own `.md` name with this flag set, and reading one starts
/// a download (or fails offline).
const SF_DATALESS: u32 = 0x4000_0000;

pub(crate) fn is_dataless_flags(flags: u32) -> bool {
    flags & SF_DATALESS != 0
}

/// Whether a stat says the file is not downloaded. Stat only — never opens the
/// file, so it cannot trigger the download itself. Other platforms have no
/// such flag and always answer false.
pub(crate) fn is_dataless(meta: &std::fs::Metadata) -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::os::macos::fs::MetadataExt;
        is_dataless_flags(meta.st_flags())
    }
    #[cfg(target_os = "ios")]
    {
        use std::os::ios::fs::MetadataExt;
        is_dataless_flags(meta.st_flags())
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        let _ = meta;
        false
    }
}

#[cfg(test)]
#[path = "vault_publication_identity_tests.rs"]
mod publication_identity_tests;

#[cfg(test)]
mod tests {
    #[test]
    fn dataless_flag_means_not_downloaded() {
        // SF_DATALESS alone, and among other flags (UF_HIDDEN 0x8000).
        assert!(super::is_dataless_flags(0x4000_0000));
        assert!(super::is_dataless_flags(0x4000_8000));
        assert!(!super::is_dataless_flags(0));
        assert!(!super::is_dataless_flags(0x8000));
    }

    use super::*;
    use std::env;
    use std::fs;

    #[test]
    fn open_vault_rejects_empty() {
        assert!(open_vault("").is_err());
    }

    #[test]
    fn search_finds_nfd_content_with_nfc_query() {
        let dir = tempfile::tempdir().unwrap();
        // "한글 검색" with the Hangul decomposed to jamo, as pasted-from-mac
        // text sometimes is. The NFC query must still hit.
        let nfd = "\u{1112}\u{1161}\u{11AB}\u{1100}\u{1173}\u{11AF} \
                   \u{1100}\u{1165}\u{11B7}\u{1109}\u{1162}\u{11A8}";
        fs::write(dir.path().join("note.md"), format!("메모: {nfd} 테스트\n")).unwrap();

        let hits = search_vault(dir.path(), "한글 검색", 5);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].line, 1);
    }

    // UX backlog S15: `limit` fills with the person's notes before the folders
    // myco keeps — path order put cards/ and sessions/ first, and an owner
    // vault's 1,428 session logs left no room for wiki/ in ⌘K.
    #[test]
    fn search_fills_its_limit_with_my_notes_before_managed_folders() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for (folder, n) in [("cards", 6), ("sessions/2026-09", 15)] {
            fs::create_dir_all(root.join(folder)).unwrap();
            for i in 0..n {
                fs::write(root.join(format!("{folder}/s{i:02}.md")), "attention\n").unwrap();
            }
        }
        for (rel, body) in [
            ("CLAUDE.md", "attention\n"),
            ("wiki/my-attention-note.md", "my attention notes\n"),
            ("daily/2026-10-02.md", "attention today\n"),
            ("zettel/idea.md", "attention, again\n"),
        ] {
            fs::create_dir_all(root.join(rel).parent().unwrap()).unwrap();
            fs::write(root.join(rel), body).unwrap();
        }

        let hits = search_vault(root, "atten", 20);
        let rels: Vec<String> = hits
            .iter()
            .map(|h| {
                let p = Path::new(&h.path).strip_prefix(root).unwrap();
                p.to_string_lossy().into_owned()
            })
            .collect();
        assert_eq!(rels.len(), 20);
        // Mine first, then managed, each in path order.
        assert_eq!(
            rels[..5],
            [
                "daily/2026-10-02.md",
                "wiki/my-attention-note.md",
                "zettel/idea.md",
                "CLAUDE.md",
                "cards/s00.md",
            ]
        );
    }

    // A folder search keeps plain path order: a wiki/ subfolder named like a
    // managed top-level folder is still the person's.
    #[test]
    fn search_folder_keeps_path_order_inside_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("wiki/cards")).unwrap();
        fs::write(root.join("wiki/cards/a.md"), "attention\n").unwrap();
        fs::write(root.join("wiki/zz.md"), "attention\n").unwrap();
        let names: Vec<String> = search_folder(root, "wiki", "atten", 1)
            .into_iter()
            .map(|h| h.name)
            .collect();
        assert_eq!(names, ["a.md"]);
    }

    #[test]
    fn archive_moves_the_source_and_leaves_it_intact() {
        let dir = tempfile::tempdir().unwrap();
        let inbox = dir.path().join("_inbox");
        fs::create_dir_all(&inbox).unwrap();
        let src = inbox.join("note.md");
        fs::write(&src, "hello").unwrap();

        let dest = archive_inbox_source(&src.to_string_lossy()).unwrap();

        // The source is gone from the inbox but preserved under .archived, byte
        // for byte — the daemon's promise, now the app's too.
        assert!(!src.exists());
        assert!(std::path::Path::new(&dest).exists());
        assert_eq!(fs::read_to_string(&dest).unwrap(), "hello");
        assert_eq!(
            std::path::Path::new(&dest).parent().unwrap(),
            inbox.join(".archived")
        );
    }

    #[test]
    fn archive_suffixes_on_collision_like_the_daemon() {
        let dir = tempfile::tempdir().unwrap();
        let inbox = dir.path().join("_inbox");
        fs::create_dir_all(&inbox).unwrap();

        for expected in ["note.md", "note-2.md", "note-3.md"] {
            let src = inbox.join("note.md");
            fs::write(&src, "x").unwrap();
            let dest = archive_inbox_source(&src.to_string_lossy()).unwrap();
            assert_eq!(
                std::path::Path::new(&dest).file_name().unwrap(),
                std::ffi::OsStr::new(expected)
            );
        }
    }

    #[test]
    fn archive_rejects_a_missing_file() {
        assert!(archive_inbox_source("/no/such/file.md").is_err());
    }

    #[test]
    fn is_raw_path_identifies_only_the_raw_subtree() {
        // The write/delete/rename command guards all key off this predicate, so
        // it has to be exactly right about what counts as raw/.
        let root = Path::new("/v");
        assert!(is_raw_path(root, Path::new("/v/raw/a.md")));
        assert!(is_raw_path(root, Path::new("/v/raw/sub/a.md")));
        assert!(is_raw_path(root, Path::new("/v/raw")));
        // Not raw: other top-level dirs, and a dir that merely starts with "raw".
        assert!(!is_raw_path(root, Path::new("/v/wiki/a.md")));
        assert!(!is_raw_path(root, Path::new("/v/_inbox/a.md")));
        assert!(!is_raw_path(root, Path::new("/v/rawish/a.md")));
        assert!(!is_raw_path(root, Path::new("/v/wiki/raw/a.md")));
        // Outside the root is not raw (confinement handles the escape separately).
        assert!(!is_raw_path(root, Path::new("/other/raw/a.md")));
    }

    #[test]
    fn raw_mutation_sources_include_the_vault_root_but_not_other_notes() {
        let root = Path::new("/v");
        assert!(is_raw_mutation_source(root, root));
        assert!(is_raw_mutation_source(root, Path::new("/v/raw")));
        assert!(is_raw_mutation_source(
            root,
            Path::new("/v/raw/conversations/a.md")
        ));
        assert!(!is_raw_mutation_source(root, Path::new("/v/wiki/a.md")));
        assert!(!is_raw_mutation_source(root, Path::new("/v/_inbox/a.md")));
        assert!(!is_raw_mutation_source(root, Path::new("/v/rawish/a.md")));
    }

    #[test]
    fn available_raw_path_suffixes_only_on_collision() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("raw")).unwrap();

        // Free name → no suffix.
        assert_eq!(available_raw_path(root, "attention"), "raw/attention.md");

        // Occupy it → next call suffixes, and keeps climbing.
        fs::write(root.join("raw/attention.md"), "x").unwrap();
        assert_eq!(available_raw_path(root, "attention"), "raw/attention-2.md");
        fs::write(root.join("raw/attention-2.md"), "x").unwrap();
        assert_eq!(available_raw_path(root, "attention"), "raw/attention-3.md");

        // A different stem is unaffected.
        assert_eq!(available_raw_path(root, "scaling"), "raw/scaling.md");
    }

    #[test]
    fn available_raw_path_skips_a_stem_an_archived_copy_holds() {
        // distill moves raw/t.md to raw/archive/<month>/t.md. A later source
        // under the same title must not get raw/t.md back: [^src-t] and
        // wiki/source-t.md would then mean two different bodies.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("raw/archive/2026-08")).unwrap();
        fs::create_dir_all(root.join("raw/archive/2026-09")).unwrap();
        fs::write(root.join("raw/archive/2026-09/t.md"), "x").unwrap();
        assert_eq!(available_raw_path(root, "t"), "raw/t-2.md");

        fs::write(root.join("raw/archive/2026-08/t-2.md"), "x").unwrap();
        assert_eq!(available_raw_path(root, "t"), "raw/t-3.md");

        // Only an archived markdown copy holds a name.
        fs::write(root.join("raw/archive/2026-09/u.pdf"), "x").unwrap();
        assert_eq!(available_raw_path(root, "u"), "raw/u.md");
    }

    #[test]
    fn find_raw_copy_matches_the_exact_body_at_top_level_or_in_archive() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        assert_eq!(find_raw_copy(root, "# t\n\nbody\n"), None, "no raw/ yet");

        fs::create_dir_all(root.join("raw/archive/2026-09")).unwrap();
        fs::create_dir_all(root.join("raw/conversations")).unwrap();
        fs::write(root.join("raw/top.md"), "# t\n\nbody\n").unwrap();
        fs::write(root.join("raw/archive/2026-09/old.md"), "# o\n\nolder\n").unwrap();
        // Outside the two places a raw copy lives, and not markdown.
        fs::write(root.join("raw/conversations/c.md"), "# c\n\nelsewhere\n").unwrap();
        fs::write(root.join("raw/archive/2026-09/doc.pdf"), "# p\n\npdf\n").unwrap();

        assert_eq!(
            find_raw_copy(root, "# t\n\nbody\n").as_deref(),
            Some("raw/top.md")
        );
        assert_eq!(
            find_raw_copy(root, "# o\n\nolder\n").as_deref(),
            Some("raw/archive/2026-09/old.md")
        );
        // Same length, one byte different; a prefix; a trailing newline less.
        assert_eq!(find_raw_copy(root, "# t\n\nbodY\n"), None);
        assert_eq!(find_raw_copy(root, "# t\n\nbody"), None);
        assert_eq!(find_raw_copy(root, "# c\n\nelsewhere\n"), None);
        assert_eq!(find_raw_copy(root, "# p\n\npdf\n"), None);
    }

    #[test]
    fn raw_stem_shared_sees_another_raw_copy_under_the_same_name() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("raw/archive/2026-08")).unwrap();
        fs::create_dir_all(root.join("raw/archive/2026-09")).unwrap();
        fs::create_dir_all(root.join("raw/conversations")).unwrap();
        fs::write(root.join("raw/archive/2026-09/t.md"), "alpha").unwrap();
        fs::write(root.join("raw/archive/2026-09/u.md"), "solo").unwrap();
        fs::write(root.join("raw/archive/2026-08/w.md"), "w one").unwrap();
        fs::write(root.join("raw/archive/2026-09/w.md"), "w two").unwrap();
        fs::write(root.join("raw/t.md"), "beta").unwrap();
        // Not where raw copies live, or not markdown: no clash.
        fs::write(root.join("raw/conversations/u.md"), "c").unwrap();
        fs::write(root.join("raw/u.pdf"), "p").unwrap();

        assert!(raw_stem_shared(root, "raw/archive/2026-09/t.md"));
        assert!(raw_stem_shared(root, "raw/t.md"));
        assert!(raw_stem_shared(root, "raw/archive/2026-08/w.md"));
        assert!(!raw_stem_shared(root, "raw/archive/2026-09/u.md"));
    }

    #[test]
    fn a_marked_raw_copy_is_found_by_its_original_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("_inbox")).unwrap();
        fs::write(root.join("_inbox/shot.png"), b"abc").unwrap();
        fs::write(root.join("_inbox/copy.png"), b"abc").unwrap();
        fs::write(root.join("_inbox/other.png"), b"abd").unwrap();
        let marker = source_marker(&root.join("_inbox/shot.png")).unwrap();
        // The SHA-256 of the bytes (the FIPS 180-2 "abc" vector), pinned: the
        // marker is written into immutable raw/ and must keep matching. The
        // same picture under another name has the same marker.
        assert_eq!(
            marker,
            "<!-- myco:source-sha256 \
             ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad -->"
        );
        assert_eq!(
            source_marker(&root.join("_inbox/copy.png")).unwrap(),
            marker
        );
        assert_ne!(
            source_marker(&root.join("_inbox/other.png")).unwrap(),
            marker
        );
        assert!(source_marker(&root.join("_inbox/gone.png")).is_err());

        assert_eq!(find_marked_raw_copy(root, &marker), None, "no raw/ yet");
        fs::create_dir_all(root.join("raw/archive/2026-09")).unwrap();
        fs::create_dir_all(root.join("raw/conversations")).unwrap();
        let copy = format!("# shot\n\n{marker}\n\nA chart of sales.\n");
        fs::write(root.join("raw/archive/2026-09/shot.md"), &copy).unwrap();
        fs::write(root.join("raw/plain.md"), "# plain\n\nno marker\n").unwrap();
        fs::write(root.join("raw/conversations/c.md"), &copy).unwrap();
        assert_eq!(
            find_marked_raw_copy(root, &marker).as_deref(),
            Some(copy.as_str())
        );
        // A marker deep in a body is not a raw copy's header.
        let deep = format!("# d\n\n{}{marker}\n", "x".repeat(8 * 1024));
        fs::write(root.join("raw/deep.md"), deep).unwrap();
        fs::remove_file(root.join("raw/archive/2026-09/shot.md")).unwrap();
        assert_eq!(find_marked_raw_copy(root, &marker), None);
    }

    #[test]
    fn open_vault_rejects_missing_path() {
        let missing = env::temp_dir().join("memex-does-not-exist-xyz");
        assert!(open_vault(missing.to_str().unwrap()).is_err());
    }

    #[test]
    fn open_vault_returns_meta_for_existing_dir() {
        let tmp = env::temp_dir();
        let meta = open_vault(tmp.to_str().unwrap()).unwrap();
        assert!(!meta.name.is_empty());
        assert!(!meta.path.is_empty());
    }

    fn temp_vault(name: &str) -> std::path::PathBuf {
        let dir = env::temp_dir().join(format!("memex-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn read_confined_raw_serves_raw_and_rejects_escapes() {
        let dir = temp_vault("rawbytes");
        let root = dir.canonicalize().unwrap();
        fs::create_dir_all(root.join("raw")).unwrap();
        fs::create_dir_all(root.join("wiki")).unwrap();
        fs::write(root.join("raw/doc.pdf"), b"%PDF-1.4 bytes").unwrap();
        fs::write(root.join("wiki/note.md"), b"secret").unwrap();

        // Serves a file under raw/.
        let bytes = read_confined_raw(&root, "raw/doc.pdf", 1_000).unwrap();
        assert_eq!(bytes, b"%PDF-1.4 bytes");

        // Rejects a file outside raw/ (e.g. wiki/) even though it's in the vault.
        assert!(read_confined_raw(&root, "wiki/note.md", 1_000).is_err());
        // Rejects a traversal escape.
        assert!(read_confined_raw(&root, "raw/../wiki/note.md", 1_000).is_err());
        // Rejects a file over the size cap.
        assert!(read_confined_raw(&root, "raw/doc.pdf", 4).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_confined_raw_falls_back_to_archive_when_the_flat_path_is_gone() {
        // A pinpoint PDF link only carries the stem, so the caller always asks
        // for the flat `raw/<stem>.pdf` it was minted with. Once distillation
        // archives the source to `raw/archive/YYYY-MM/`, that literal path no
        // longer exists — the lookup must still find it by name.
        let dir = temp_vault("rawbytes-archived");
        let root = dir.canonicalize().unwrap();
        fs::create_dir_all(root.join("raw/archive/2026-08")).unwrap();
        fs::write(
            root.join("raw/archive/2026-08/doc.pdf"),
            b"%PDF-1.4 archived",
        )
        .unwrap();

        let bytes = read_confined_raw(&root, "raw/doc.pdf", 1_000).unwrap();
        assert_eq!(bytes, b"%PDF-1.4 archived");

        // A name that truly doesn't exist anywhere under raw/ still errors.
        assert!(read_confined_raw(&root, "raw/ghost.pdf", 1_000).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_confined_raw_prefers_the_newest_archive_month_on_a_name_collision() {
        // Should not happen in practice (archiving never overwrites), but the
        // fallback search must still be deterministic rather than at the mercy
        // of read_dir order: the same filename under two different
        // raw/archive/YYYY-MM/ folders must always resolve to the newest month.
        let dir = temp_vault("rawbytes-collision");
        let root = dir.canonicalize().unwrap();
        fs::create_dir_all(root.join("raw/archive/2026-01")).unwrap();
        fs::create_dir_all(root.join("raw/archive/2026-07")).unwrap();
        fs::write(root.join("raw/archive/2026-01/doc.pdf"), b"old copy").unwrap();
        fs::write(root.join("raw/archive/2026-07/doc.pdf"), b"new copy").unwrap();

        let bytes = read_confined_raw(&root, "raw/doc.pdf", 1_000).unwrap();
        assert_eq!(
            bytes, b"new copy",
            "must deterministically prefer 2026-07 over 2026-01"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn confine_path_accepts_inside_allows_new_rejects_outside() {
        let dir = temp_vault("confine");
        let root = dir.canonicalize().unwrap();
        let inside = dir.join("a.md");
        fs::write(&inside, "x").unwrap();
        assert!(confine_path(&root, inside.to_str().unwrap()).is_ok());
        // A brand-new (not-yet-existing) file under the vault is allowed.
        let new_file = dir.join("new.md");
        assert!(confine_path(&root, new_file.to_str().unwrap()).is_ok());
        // A real file outside the vault is refused.
        let outside = env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("memex-outside-{}.md", std::process::id()));
        fs::write(&outside, "x").unwrap();
        assert!(confine_path(&root, outside.to_str().unwrap()).is_err());
        let _ = fs::remove_file(&outside);
    }

    #[test]
    fn confine_path_blocks_dotdot_escape() {
        let dir = temp_vault("confine-escape");
        let root = dir.canonicalize().unwrap();
        // Create a sibling next to the vault so canonicalize() resolves the
        // `..` path — proving the starts_with check (not a missing file) rejects.
        let sibling = root
            .parent()
            .unwrap()
            .join(format!("memex-escape-{}.md", std::process::id()));
        fs::write(&sibling, "x").unwrap();
        let escape = format!(
            "{}/../{}",
            root.display(),
            sibling.file_name().unwrap().to_str().unwrap()
        );
        assert!(confine_path(&root, &escape).is_err());
        let _ = fs::remove_file(&sibling);
    }

    #[test]
    fn vault_revision_is_stable_and_notices_real_changes() {
        let dir = temp_vault("revision");
        fs::create_dir_all(dir.join("wiki")).unwrap();
        fs::write(dir.join("wiki/a.md"), "alpha").unwrap();
        let root = dir.to_str().unwrap();

        let r1 = vault_revision(root).unwrap();
        // Same vault, no writes: the fingerprint must not move, or the caller it
        // exists for (skip the rebuild when nothing changed) never skips.
        assert_eq!(r1, vault_revision(root).unwrap());

        // A new file changes it.
        fs::write(dir.join("wiki/b.md"), "beta").unwrap();
        let r2 = vault_revision(root).unwrap();
        assert_ne!(r1, r2, "a new page must change the revision");

        // A length change changes it even within the same mtime second.
        fs::write(dir.join("wiki/b.md"), "beta plus more text").unwrap();
        let r3 = vault_revision(root).unwrap();
        assert_ne!(
            r2, r3,
            "an edit that changes length must change the revision"
        );

        // Deleting changes it back to something new (not necessarily r1: mtimes
        // of the remaining files are unchanged, so it should in fact equal r1).
        fs::remove_file(dir.join("wiki/b.md")).unwrap();
        assert_eq!(
            r1,
            vault_revision(root).unwrap(),
            "removing the new page restores the revision"
        );

        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn vault_revision_ignores_non_markdown_and_hidden() {
        let dir = temp_vault("revision-scope");
        fs::create_dir_all(dir.join("wiki")).unwrap();
        fs::create_dir_all(dir.join(".obsidian")).unwrap();
        fs::write(dir.join("wiki/a.md"), "alpha").unwrap();
        let root = dir.to_str().unwrap();
        let before = vault_revision(root).unwrap();

        // The link graph only reads .md, so churn the fingerprint must not see:
        // an app's own state file, and anything under a dot-directory.
        fs::write(dir.join("wiki/notes.txt"), "not markdown").unwrap();
        fs::write(dir.join(".obsidian/workspace.json"), "{}").unwrap();
        fs::write(dir.join(".obsidian/scratch.md"), "hidden md").unwrap();
        assert_eq!(
            before,
            vault_revision(root).unwrap(),
            "only vault markdown may move the revision"
        );
        fs::remove_dir_all(&dir).ok();
    }

    /// The sidebar tree polls the revision too, and it shows every folder and
    /// every note NAME — staging dirs included — so those must move it when
    /// added; but staging content is not knowledge, so an edit inside one must
    /// not (it would rebuild a graph that never reads it).
    #[test]
    fn vault_revision_sees_folders_and_staging_names_but_not_staging_content() {
        let dir = temp_vault("revision-tree");
        fs::create_dir_all(dir.join("wiki")).unwrap();
        fs::write(dir.join("wiki/a.md"), "alpha").unwrap();
        let root = dir.to_str().unwrap();
        let r0 = vault_revision(root).unwrap();

        fs::create_dir_all(dir.join("wiki/empty")).unwrap();
        let r1 = vault_revision(root).unwrap();
        assert_ne!(r0, r1, "a new (empty) folder must change the revision");

        fs::create_dir_all(dir.join("sessions/2026-09")).unwrap();
        let r2 = vault_revision(root).unwrap();
        fs::write(dir.join("sessions/2026-09/log.md"), "# log").unwrap();
        let r3 = vault_revision(root).unwrap();
        assert_ne!(
            r2, r3,
            "a note added under a staging dir must change the revision"
        );

        fs::write(
            dir.join("sessions/2026-09/log.md"),
            "# log, edited and longer",
        )
        .unwrap();
        assert_eq!(
            r3,
            vault_revision(root).unwrap(),
            "editing a staging note must not change the revision"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn vault_revision_rejects_an_unreadable_subdir_and_recovers() {
        // A partial fingerprint would make intact notes look removed.
        let dir = temp_vault("revision-locked");
        fs::create_dir_all(dir.join("wiki")).unwrap();
        fs::write(dir.join("wiki/a.md"), "alpha").unwrap();
        let locked = dir.join("locked");
        fs::create_dir_all(&locked).unwrap();
        let revision = vault_revision(dir.to_str().unwrap()).unwrap();
        let denied = scan_tests::DeniedDirectory::new(&locked);
        let got = vault_revision(dir.to_str().unwrap());
        drop(denied);
        assert!(got.is_err(), "an incomplete scan must fail the check");
        assert_eq!(vault_revision(dir.to_str().unwrap()).unwrap(), revision);
        fs::remove_dir_all(&dir).unwrap();
    }

    /// The confinement promise is that nothing outside the open vault is read or
    /// written. A directory symlink inside the vault broke both halves: the
    /// walkers used `Path::is_dir()`, which follows.
    #[cfg(unix)]
    #[test]
    fn walkers_do_not_follow_directory_symlinks_out_of_the_vault() {
        let base = temp_vault("symlink-escape");
        let vault = base.join("vault");
        let outside = base.join("outside");
        fs::create_dir_all(vault.join("wiki")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(vault.join("wiki/a.md"), "page citing [[secret-note]]").unwrap();
        // A private file that happens to be markdown, outside the vault.
        let secret = outside.join("secret-note.md");
        fs::write(&secret, "PRIVATE: links to [[old-name]]").unwrap();
        // The escape hatch: one symlinked directory inside the vault.
        std::os::unix::fs::symlink(&outside, vault.join("wiki/escape")).unwrap();
        let root = vault.canonicalize().unwrap();

        // READ: search must not see outside the vault.
        let hits = search_vault(&root, "PRIVATE", 10);
        assert!(hits.is_empty(), "search escaped the vault: {hits:?}");

        // READ: the LLM context must not inline outside files.
        let ctx = read_vault_context(root.to_str().unwrap(), 100_000).unwrap();
        assert!(!ctx.contains("PRIVATE"), "vault context escaped the vault");

        // READ: the link graph must not pull outside notes in as nodes.
        let adj = crate::index::build_link_graph(root.to_str().unwrap()).unwrap();
        let escaped: Vec<&String> = adj
            .forward
            .keys()
            .chain(adj.backward.keys())
            .filter(|k| k.contains("secret-note"))
            .collect();
        assert!(
            escaped.is_empty(),
            "link graph escaped the vault: {escaped:?}"
        );

        // READ: the file tree / mtimes / revision must not see outside either.
        let tree = format!("{:?}", list_files(root.to_str().unwrap()).unwrap());
        assert!(!tree.contains("secret-note"), "file tree escaped the vault");
        let mtimes = file_mtimes(root.to_str().unwrap()).unwrap();
        assert!(
            !mtimes.iter().any(|(p, _)| p.contains("secret-note")),
            "mtime walk escaped the vault"
        );

        // The revision must not change when a file OUTSIDE the vault changes —
        // if it does, the walk is reaching out there.
        let rev_before = vault_revision(root.to_str().unwrap()).unwrap();
        fs::write(
            &secret,
            "PRIVATE: links to [[old-name]] — edited, now longer",
        )
        .unwrap();
        assert_eq!(
            rev_before,
            vault_revision(root.to_str().unwrap()).unwrap(),
            "the fingerprint is watching files outside the vault"
        );

        // WRITE: a rename must not rewrite a file outside the vault.
        let before = fs::read_to_string(&secret).unwrap();
        rewrite_backlinks(&root, "old-name", "new-name");
        assert_eq!(
            fs::read_to_string(&secret).unwrap(),
            before,
            "rename rewrote a file OUTSIDE the vault"
        );

        fs::remove_dir_all(&base).ok();
    }

    /// A symlinked FILE is the same escape with one step removed — write_file
    /// follows it and persists outside the vault.
    #[cfg(unix)]
    #[test]
    fn walkers_do_not_follow_file_symlinks_out_of_the_vault() {
        let base = temp_vault("symlink-file");
        let vault = base.join("vault");
        let outside = base.join("outside");
        fs::create_dir_all(vault.join("wiki")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let secret = outside.join("secret.md");
        fs::write(&secret, "PRIVATE: cites [[old-name]]").unwrap();
        std::os::unix::fs::symlink(&secret, vault.join("wiki/linked.md")).unwrap();
        let root = vault.canonicalize().unwrap();

        assert!(
            search_vault(&root, "PRIVATE", 10).is_empty(),
            "search followed a file symlink"
        );
        let before = fs::read_to_string(&secret).unwrap();
        rewrite_backlinks(&root, "old-name", "new-name");
        assert_eq!(
            fs::read_to_string(&secret).unwrap(),
            before,
            "rename wrote THROUGH a file symlink, outside the vault"
        );
        fs::remove_dir_all(&base).ok();
    }

    /// A symlink cycle inside the vault must terminate, not grow paths until the
    /// walk dies on ENAMETOOLONG.
    #[cfg(unix)]
    #[test]
    fn walkers_terminate_on_a_symlink_cycle() {
        let dir = temp_vault("symlink-cycle");
        fs::create_dir_all(dir.join("wiki")).unwrap();
        fs::write(dir.join("wiki/a.md"), "alpha").unwrap();
        // wiki/loop -> the vault root: following this recurses forever.
        std::os::unix::fs::symlink(&dir, dir.join("wiki/loop")).unwrap();
        let root = dir.canonicalize().unwrap();

        let hits = search_vault(&root, "alpha", 10);
        assert_eq!(hits.len(), 1, "the real page is found exactly once");
        assert!(vault_revision(root.to_str().unwrap()).is_ok());
        assert!(list_files(root.to_str().unwrap()).is_ok());
        fs::remove_dir_all(&dir).ok();
    }

    /// Regression: `raw/` is immutable — the repo CLAUDE.md states it outranks
    /// every project rule, and the agent write tools already refuse it. A rename
    /// must not be the one path that edits a source document.
    #[test]
    fn rewrite_backlinks_never_touches_raw() {
        let dir = temp_vault("rewrite-raw");
        fs::create_dir_all(dir.join("wiki")).unwrap();
        fs::create_dir_all(dir.join("raw")).unwrap();
        let raw_before = "source doc citing [[old-note]] verbatim";
        fs::write(dir.join("raw/source.md"), raw_before).unwrap();
        fs::write(dir.join("wiki/a.md"), "wiki page citing [[old-note]]").unwrap();

        let changed = rewrite_backlinks(&dir, "old-note", "new-note");

        // The wiki page is rewritten...
        let wiki_after = fs::read_to_string(dir.join("wiki/a.md")).unwrap();
        assert!(
            wiki_after.contains("[[new-note]]"),
            "wiki backlinks still rewrite"
        );
        // ...and the immutable source is byte-for-byte untouched.
        assert_eq!(
            fs::read_to_string(dir.join("raw/source.md")).unwrap(),
            raw_before,
            "raw/ is immutable — a rename must not rewrite a source document"
        );
        assert_eq!(changed, 1, "only the wiki page counts as changed");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rewrite_backlinks_updates_inbound_links_preserving_alias_and_section() {
        let dir = temp_vault("backlinks");
        let root = dir.canonicalize().unwrap();
        fs::write(
            dir.join("a.md"),
            "see [[beta]] and [[beta|Beta]] and [[beta#Intro]] and [[Beta]] and [[betamax]]",
        )
        .unwrap();
        fs::write(dir.join("b.md"), "no links here").unwrap();
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub/c.md"), "nested [[beta#H|d]]").unwrap();

        let changed = rewrite_backlinks(&root, "beta", "gamma");
        assert_eq!(changed, 2); // a.md and sub/c.md

        // Alias and #section preserved; case-insensitive match; "betamax" left
        // alone (target must equal the stem, not just contain it).
        assert_eq!(
            fs::read_to_string(dir.join("a.md")).unwrap(),
            "see [[gamma]] and [[gamma|Beta]] and [[gamma#Intro]] and [[gamma]] and [[betamax]]"
        );
        assert_eq!(
            fs::read_to_string(dir.join("sub/c.md")).unwrap(),
            "nested [[gamma#H|d]]"
        );
        assert_eq!(
            fs::read_to_string(dir.join("b.md")).unwrap(),
            "no links here"
        );
    }

    #[test]
    fn search_vault_finds_content_case_insensitively() {
        let dir = temp_vault("search");
        let root = dir.canonicalize().unwrap();
        fs::write(
            dir.join("a.md"),
            "# Notes\n\nThe Transformer architecture uses attention.\n",
        )
        .unwrap();
        fs::write(dir.join("b.md"), "nothing relevant here\n").unwrap();
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub/c.md"), "deep TRANSFORMER note\n").unwrap();

        let hits = search_vault(&root, "transformer", 50);
        assert_eq!(hits.len(), 2); // a.md and sub/c.md, not b.md
                                   // First match line + snippet, case-insensitive.
        let a = hits.iter().find(|h| h.name == "a.md").unwrap();
        assert_eq!(a.line, 3);
        assert!(a.snippet.contains("Transformer architecture"));

        // Empty query and zero limit return nothing.
        assert!(search_vault(&root, "  ", 50).is_empty());
        assert!(search_vault(&root, "transformer", 0).is_empty());
        // Limit is honored.
        assert_eq!(search_vault(&root, "transformer", 1).len(), 1);
    }

    /// A plugin's search sees wiki/ pages only: the limit has to count those,
    /// not the daily/ and raw/ files that sort before wiki/ and match too.
    #[test]
    fn search_folder_counts_only_that_folders_hits() {
        let dir = temp_vault("search-folder");
        let root = dir.canonicalize().unwrap();
        for sub in ["daily", "raw", "wiki/deep"] {
            fs::create_dir_all(dir.join(sub)).unwrap();
        }
        for i in 1..=5 {
            fs::write(dir.join(format!("daily/2026-09-0{i}.md")), "attention").unwrap();
        }
        fs::write(dir.join("raw/paper.md"), "attention").unwrap();
        fs::write(dir.join("wiki/a.md"), "attention").unwrap();
        fs::write(dir.join("wiki/deep/b.md"), "attention").unwrap();

        let hits = search_folder(&root, "wiki", "attention", 2);
        let paths: Vec<_> = hits.iter().map(|h| h.path.clone()).collect();
        assert_eq!(
            paths,
            [
                root.join("wiki/a.md").to_string_lossy(),
                root.join("wiki/deep/b.md").to_string_lossy(),
            ]
        );
        // Only a folder of the vault itself: nothing for a missing one, a
        // path, a hidden name or the parent.
        for f in ["notes", "wiki/deep", "..", ".", ""] {
            assert!(search_folder(&root, f, "attention", 5).is_empty(), "{f}");
        }
        fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn search_folder_does_not_follow_a_linked_folder() {
        let dir = temp_vault("search-folder-link");
        let root = dir.canonicalize().unwrap();
        fs::create_dir_all(dir.join("raw")).unwrap();
        fs::write(dir.join("raw/paper.md"), "attention").unwrap();
        std::os::unix::fs::symlink(dir.join("raw"), dir.join("wiki")).unwrap();
        assert!(search_folder(&root, "wiki", "attention", 5).is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn confine_parent_rejects_outside_root() {
        let dir = temp_vault("confine-parent");
        let root = dir.canonicalize().unwrap();
        assert!(confine_parent(&root, dir.to_str().unwrap()).is_ok());
        let outside = env::temp_dir().canonicalize().unwrap();
        assert!(confine_parent(&root, outside.to_str().unwrap()).is_err());
    }

    #[test]
    fn list_files_returns_only_markdown() {
        let dir = temp_vault("list");
        fs::write(dir.join("note.md"), "# hi").unwrap();
        fs::write(dir.join("ignored.txt"), "x").unwrap();
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub/inner.md"), "# inner").unwrap();
        fs::create_dir_all(dir.join(".hidden")).unwrap();
        fs::write(dir.join(".hidden/secret.md"), "x").unwrap();

        let nodes = list_files(dir.to_str().unwrap()).unwrap();

        let names: Vec<&str> = nodes
            .iter()
            .map(|n| match n {
                FileNode::File { name, .. } => name.as_str(),
                FileNode::Directory { name, .. } => name.as_str(),
            })
            .collect();
        assert_eq!(names, vec!["note.md", "sub"]);
    }

    #[test]
    fn read_file_parses_yaml_frontmatter() {
        let dir = temp_vault("read");
        let p = dir.join("a.md");
        fs::write(
            &p,
            "---\ntitle: Hello\ntags:\n  - alpha\n  - beta\n---\n# Body\n",
        )
        .unwrap();
        let fc = read_file(p.to_str().unwrap()).unwrap();
        assert!(fc.content.starts_with("# Body"));
        assert_eq!(fc.frontmatter["title"], "Hello");
        assert_eq!(fc.frontmatter["tags"][0], "alpha");
        // `raw` must keep the full file incl. the frontmatter block so an edit
        // can round-trip losslessly.
        assert!(fc.raw.starts_with("---\ntitle: Hello"));
        assert!(fc.raw.contains("# Body"));
    }

    #[test]
    fn edit_save_round_trip_preserves_frontmatter() {
        // Regression for the P0 data-loss bug: opening a frontmatter-bearing
        // page in the editor and saving it back must NOT drop the YAML block.
        // The editor edits `raw`, so a read_file -> write_file(raw) cycle is the
        // exact path the app takes on autosave.
        let dir = temp_vault("roundtrip");
        let p = dir.join("note.md");
        let original = "---\ntitle: Keep Me\nstatus: active\n---\n# Heading\n\nbody text\n";
        fs::write(&p, original).unwrap();

        let fc = read_file(p.to_str().unwrap()).unwrap();
        // The app edits the body but ships the whole `raw` document back.
        let edited = fc.raw.replace("body text", "body text edited");
        write_file(p.to_str().unwrap(), &edited).unwrap();

        let on_disk = fs::read_to_string(&p).unwrap();
        assert!(
            on_disk.contains("---\ntitle: Keep Me\nstatus: active\n---"),
            "frontmatter was stripped on save: {on_disk:?}"
        );
        assert!(on_disk.contains("body text edited"));
        // A second read still parses the frontmatter, proving the block is intact.
        let fc2 = read_file(p.to_str().unwrap()).unwrap();
        assert_eq!(fc2.frontmatter["title"], "Keep Me");
        assert_eq!(fc2.frontmatter["status"], "active");
    }

    #[test]
    fn read_file_handles_missing_frontmatter() {
        let dir = temp_vault("read-plain");
        let p = dir.join("a.md");
        fs::write(&p, "no frontmatter here").unwrap();
        let fc = read_file(p.to_str().unwrap()).unwrap();
        assert_eq!(fc.content, "no frontmatter here");
        assert!(fc.frontmatter.is_null());
    }

    #[test]
    fn read_file_refuses_pathologically_deep_frontmatter() {
        // A synced/shared note with adversarially deep YAML must not overflow the
        // stack. The pre-parse guard skips it (Null frontmatter) and the body is
        // returned intact — read_file returns Ok, no panic/abort.
        let dir = temp_vault("deep-fm");
        let p = dir.join("deep.md");
        let depth = 5_000;
        let nested = format!("{}x{}", "[".repeat(depth), "]".repeat(depth));
        fs::write(&p, format!("---\nkey: {nested}\n---\n# Body\n")).unwrap();
        let fc = read_file(p.to_str().unwrap()).unwrap();
        assert!(fc.frontmatter.is_null(), "deep frontmatter must be skipped");
        assert!(fc.raw.contains("# Body"));
        // A normal shallow frontmatter is still parsed.
        assert!(!frontmatter_too_deep(
            "---\ntitle: Hi\ntags:\n  - a\n---\nbody"
        ));
    }

    #[test]
    fn write_file_replaces_atomically() {
        let dir = temp_vault("write");
        let p = dir.join("note.md");
        fs::write(&p, "old").unwrap();
        write_file(p.to_str().unwrap(), "new content").unwrap();
        let actual = fs::read_to_string(&p).unwrap();
        assert_eq!(actual, "new content");
    }

    #[test]
    fn write_file_creates_new_file() {
        let dir = temp_vault("write-new");
        let p = dir.join("brand-new.md");
        write_file(p.to_str().unwrap(), "fresh").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "fresh");
    }

    fn write_test_sha256(content: &str) -> String {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(content.as_bytes()))
    }

    #[test]
    fn conditional_write_matches_exact_utf8_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("derived.md");
        let original = "---\ntitle: Synthetic\n---\n# 기록\n사용자 편집\n";
        write_file(path.to_str().unwrap(), original).unwrap();
        let appended = format!("{original}\nQuoted evidence\n");
        write_file_if_unchanged(
            path.to_str().unwrap(),
            &appended,
            Some(&write_test_sha256(original)),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), appended);
    }

    #[test]
    fn conditional_write_refuses_a_newer_normal_writer_edit() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("derived.md");
        write_file(path.to_str().unwrap(), "old text").unwrap();
        let expected = write_test_sha256("old text");
        write_file(path.to_str().unwrap(), "new user text").unwrap();
        let error =
            write_file_if_unchanged(path.to_str().unwrap(), "stale append", Some(&expected))
                .unwrap_err();
        assert!(error.starts_with("write conflict:"), "{error}");
        assert_eq!(fs::read_to_string(path).unwrap(), "new user text");
    }

    #[test]
    fn conditional_write_distinguishes_absence_from_an_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("derived.md");
        let path = path.to_str().unwrap();
        let empty_hash = write_test_sha256("");
        assert!(write_file_if_unchanged(path, "stale", Some(&empty_hash))
            .unwrap_err()
            .starts_with("write conflict:"));
        assert!(!Path::new(path).exists());
        write_file_if_unchanged(path, "", None).unwrap();
        assert!(write_file_if_unchanged(path, "collision", None)
            .unwrap_err()
            .starts_with("write conflict:"));
        write_file_if_unchanged(path, "appended", Some(&empty_hash)).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), "appended");
    }

    #[test]
    fn absent_commit_does_not_clobber_an_external_creator() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("source.md");
        assert!(!path.exists());
        // Model an uncooperating creator after the absence check but before
        // the staged file is persisted. No process lock can protect this gap.
        fs::write(&path, "external original").unwrap();
        let error = atomic_write_file(path.to_str().unwrap(), "stale source", false).unwrap_err();
        assert!(error.starts_with("write conflict:"), "{error}");
        assert_eq!(fs::read_to_string(&path).unwrap(), "external original");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn conditional_write_rejects_invalid_hashes_and_read_errors() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("derived.md");
        write_file(path.to_str().unwrap(), "keep").unwrap();
        for hash in ["", "1234", &"g".repeat(64), &"A".repeat(64)] {
            assert_eq!(
                write_file_if_unchanged(path.to_str().unwrap(), "lost", Some(hash)).unwrap_err(),
                "invalid expected SHA256"
            );
        }
        assert_eq!(fs::read_to_string(path).unwrap(), "keep");
        let error =
            write_file_if_unchanged(dir.path().to_str().unwrap(), "lost", None).unwrap_err();
        assert!(error.starts_with("read before write failed:"), "{error}");
        assert!(dir.path().is_dir());
    }

    #[test]
    fn conditional_writers_with_one_revision_have_one_winner() {
        use std::sync::{Arc, Barrier};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("derived.md");
        write_file(path.to_str().unwrap(), "original").unwrap();
        let barrier = Arc::new(Barrier::new(8));
        let writers: Vec<_> = (0..8)
            .map(|number| {
                let barrier = barrier.clone();
                let path = path.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    match write_file_if_unchanged(
                        path.to_str().unwrap(),
                        &format!("writer {number}"),
                        Some(&write_test_sha256("original")),
                    ) {
                        Ok(()) => true,
                        Err(error) => {
                            assert!(error.starts_with("write conflict:"), "{error}");
                            false
                        }
                    }
                })
            })
            .collect();
        let winners = writers
            .into_iter()
            .map(|writer| writer.join().unwrap())
            .filter(|won| *won)
            .count();
        assert_eq!(winners, 1);
        assert!(fs::read_to_string(path).unwrap().starts_with("writer "));
    }

    #[test]
    fn write_asset_creates_dir_and_suffixes_collisions() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            write_asset(dir.path(), "x.png", b"one").unwrap(),
            "assets/x.png"
        );
        assert_eq!(
            write_asset(dir.path(), "x.png", b"two").unwrap(),
            "assets/x-2.png"
        );
        assert_eq!(fs::read(dir.path().join("assets/x.png")).unwrap(), b"one");
        assert_eq!(fs::read(dir.path().join("assets/x-2.png")).unwrap(), b"two");
    }

    #[test]
    fn write_asset_refuses_bad_names_types_and_size() {
        let dir = tempfile::tempdir().unwrap();
        for bad in ["a/b.png", "..", "x.svg", "x", ".png"] {
            assert!(write_asset(dir.path(), bad, b"x").is_err(), "{bad}");
        }
        let err = write_asset(dir.path(), "big.png", &vec![0; MAX_ASSET_BYTES + 1]).unwrap_err();
        assert!(err.contains("20 MB"), "{err}");
        assert!(!dir.path().join("assets").exists());
    }

    #[test]
    fn copy_asset_copies_and_suffixes_collisions() {
        let vault = tempfile::tempdir().unwrap();
        let src_dir = tempfile::tempdir().unwrap();
        let src = src_dir.path().join("shot.png");
        fs::write(&src, b"pixels").unwrap();
        let src = src.to_str().unwrap();
        assert_eq!(
            copy_asset(vault.path(), "x.png", src).unwrap(),
            "assets/x.png"
        );
        assert_eq!(
            copy_asset(vault.path(), "x.png", src).unwrap(),
            "assets/x-2.png"
        );
        assert_eq!(
            fs::read(vault.path().join("assets/x-2.png")).unwrap(),
            b"pixels"
        );
        // Source untouched.
        assert_eq!(fs::read(src).unwrap(), b"pixels");
    }

    #[test]
    fn copy_asset_refuses_bad_type_dir_missing_and_oversize() {
        let vault = tempfile::tempdir().unwrap();
        let src_dir = tempfile::tempdir().unwrap();
        let svg = src_dir.path().join("v.svg");
        fs::write(&svg, b"<svg/>").unwrap();
        assert!(copy_asset(vault.path(), "v.svg", svg.to_str().unwrap()).is_err());
        assert!(copy_asset(vault.path(), "d.png", src_dir.path().to_str().unwrap()).is_err());
        assert!(copy_asset(vault.path(), "m.png", "/nonexistent/m.png").is_err());
        // Sparse file: set_len allocates no blocks, so the cap is cheap to test.
        let big = src_dir.path().join("big.png");
        fs::File::create(&big)
            .unwrap()
            .set_len(MAX_ASSET_BYTES as u64 + 1)
            .unwrap();
        let err = copy_asset(vault.path(), "big.png", big.to_str().unwrap()).unwrap_err();
        assert!(err.contains("20 MB"), "{err}");
        assert!(!vault.path().join("assets").exists());
    }

    #[test]
    fn write_file_fails_if_parent_missing() {
        let p = env::temp_dir().join("memex-no-parent-xyz/file.md");
        assert!(write_file(p.to_str().unwrap(), "x").is_err());
    }

    #[test]
    fn create_file_writes_the_given_content() {
        let dir = temp_vault("create-file");
        let path = create_file(dir.to_str().unwrap(), "alpha.md", "").unwrap();
        assert!(std::path::Path::new(&path).exists());
        assert_eq!(fs::read_to_string(&path).unwrap(), "");
        let seeded = create_file(dir.to_str().unwrap(), "beta.md", "hello").unwrap();
        assert_eq!(fs::read_to_string(&seeded).unwrap(), "hello");
    }

    #[test]
    fn create_file_rejects_collision() {
        let dir = temp_vault("create-file-collide");
        fs::write(dir.join("x.md"), "old").unwrap();
        assert!(create_file(dir.to_str().unwrap(), "x.md", "").is_err());
    }

    #[test]
    fn concurrent_file_creators_preserve_the_only_winners_content() {
        use std::sync::{Arc, Barrier};
        let dir = tempfile::tempdir().unwrap();
        let barrier = Arc::new(Barrier::new(8));
        let writers: Vec<_> = (0..8)
            .map(|number| {
                let parent = dir.path().to_path_buf();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let content = format!("source {number}");
                    barrier.wait();
                    match create_file(parent.to_str().unwrap(), "source.md", &content) {
                        Ok(_) => Some(content),
                        Err(error) => {
                            assert!(
                                error.starts_with("already exists:")
                                    || error.starts_with("write conflict:"),
                                "{error}"
                            );
                            None
                        }
                    }
                })
            })
            .collect();
        let winners: Vec<_> = writers
            .into_iter()
            .filter_map(|writer| writer.join().unwrap())
            .collect();
        assert_eq!(winners.len(), 1);
        assert_eq!(
            fs::read_to_string(dir.path().join("source.md")).unwrap(),
            winners[0]
        );
    }

    #[test]
    fn should_seed_frontmatter_covers_knowledge_pages_only() {
        let root = Path::new("/v");
        // Knowledge pages: wiki/, subfolders, the vault root, a user folder.
        assert!(should_seed_frontmatter(root, Path::new("/v/wiki/a.md")));
        assert!(should_seed_frontmatter(root, Path::new("/v/wiki/sub/a.md")));
        assert!(should_seed_frontmatter(root, Path::new("/v/untitled.md"))); // root note
        assert!(should_seed_frontmatter(root, Path::new("/v/projects/x.md")));
        // Excluded: non-markdown and format-owning / dot directories.
        assert!(!should_seed_frontmatter(root, Path::new("/v/wiki/a.txt")));
        assert!(!should_seed_frontmatter(
            root,
            Path::new("/v/daily/2026-07-19.md")
        ));
        assert!(!should_seed_frontmatter(root, Path::new("/v/raw/a.md")));
        assert!(!should_seed_frontmatter(
            root,
            Path::new("/v/ingest-reports/r.md")
        ));
        assert!(!should_seed_frontmatter(root, Path::new("/v/_inbox/s.md")));
        // A template is a scaffold with `{{title}}` placeholders, not a page.
        assert!(!should_seed_frontmatter(
            root,
            Path::new("/v/templates/note.md")
        ));
        assert!(!should_seed_frontmatter(
            root,
            Path::new("/v/.obsidian/x.md")
        ));
    }

    #[test]
    fn wiki_page_stub_has_the_required_frontmatter_and_a_title() {
        let s = wiki_page_stub("attention-mechanism", "2026-07-19");
        assert!(s.starts_with("---\n"));
        assert!(s.contains("type: concept"));
        assert!(s.contains("tags:"));
        assert!(s.contains("created: 2026-07-19"));
        assert!(s.contains("confidence: medium"));
        assert!(s.contains("status: active"));
        // Title humanizes the stem.
        assert!(s.contains("# attention mechanism"));
    }

    #[test]
    fn create_folder_rejects_traversal() {
        let dir = temp_vault("create-folder");
        assert!(create_folder(dir.to_str().unwrap(), "../escape").is_err());
        assert!(create_folder(dir.to_str().unwrap(), "ok").is_ok());
    }

    #[test]
    fn delete_path_moves_file_and_dir_to_trash() {
        let dir = temp_vault("del");
        let f = dir.join("a.md");
        fs::write(&f, "x").unwrap();
        delete_path(f.to_str().unwrap()).unwrap();
        // delete_path routes through the OS trash; we only assert the entry is
        // gone from its original path (its trash destination is OS-specific).
        assert!(!f.exists());
        let sub = dir.join("sub");
        fs::create_dir_all(sub.join("inner")).unwrap();
        delete_path(sub.to_str().unwrap()).unwrap();
        assert!(!sub.exists());
        // A path that no longer exists must error, not silently succeed.
        assert!(delete_path(f.to_str().unwrap()).is_err());
    }

    #[test]
    fn permanent_delete_removes_files_and_directories_and_prevalidates_the_batch() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("synthetic.md");
        fs::write(&file, "synthetic note").unwrap();
        let missing = dir.path().join("missing.md");
        assert!(remove_all(&[file.clone(), missing]).is_err());
        assert!(
            file.exists(),
            "a later invalid target must preserve earlier files"
        );
        let folder = dir.path().join("notes");
        fs::create_dir_all(folder.join("nested")).unwrap();
        fs::write(folder.join("nested/note.md"), "synthetic note").unwrap();
        remove_all(&[file.clone(), folder.clone()]).unwrap();
        assert!(!file.exists());
        assert!(!folder.exists());
    }

    #[cfg(unix)]
    #[test]
    fn permanent_delete_refuses_symlinks_and_preserves_the_whole_batch() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let retained = outside.path().join("retained.md");
        fs::write(&retained, "synthetic retained note").unwrap();
        let good = root.join("good.md");
        fs::write(&good, "synthetic note").unwrap();
        let folder = root.join("folder");
        fs::create_dir(&folder).unwrap();
        std::os::unix::fs::symlink(&retained, folder.join("linked.md")).unwrap();
        assert!(remove_all(&[good.clone(), folder.clone()]).is_err());
        assert!(good.exists());
        assert!(retained.exists());
        assert!(confine_delete_path(&root, &folder.join("linked.md").to_string_lossy()).is_err());
        std::os::unix::fs::symlink(outside.path(), root.join("linked-dir")).unwrap();
        assert!(confine_delete_path(
            &root,
            &root.join("linked-dir/retained.md").to_string_lossy()
        )
        .is_err());
        assert!(confine_delete_path(&root, &root.join("../outside.md").to_string_lossy()).is_err());
    }

    #[test]
    fn rename_path_moves_within_parent() {
        let dir = temp_vault("ren");
        fs::write(dir.join("old.md"), "x").unwrap();
        let new_path = rename_path(dir.join("old.md").to_str().unwrap(), "new.md").unwrap();
        assert!(std::path::Path::new(&new_path).exists());
        assert!(!dir.join("old.md").exists());
    }

    #[test]
    fn move_path_moves_file_into_dir() {
        let dir = temp_vault("mv");
        fs::write(dir.join("a.md"), "x").unwrap();
        fs::create_dir_all(dir.join("notes")).unwrap();
        let new_path = move_path(
            dir.join("a.md").to_str().unwrap(),
            dir.join("notes").to_str().unwrap(),
        )
        .unwrap();
        assert_eq!(std::path::Path::new(&new_path), dir.join("notes/a.md"));
        assert!(dir.join("notes/a.md").is_file());
        assert!(!dir.join("a.md").exists());
    }

    #[test]
    fn move_path_refuses_existing_target() {
        let dir = temp_vault("mv-exists");
        fs::write(dir.join("a.md"), "x").unwrap();
        fs::create_dir_all(dir.join("notes")).unwrap();
        fs::write(dir.join("notes/a.md"), "y").unwrap();
        let err = move_path(
            dir.join("a.md").to_str().unwrap(),
            dir.join("notes").to_str().unwrap(),
        )
        .unwrap_err();
        assert!(err.contains("destination exists"), "{err}");
        assert_eq!(fs::read_to_string(dir.join("notes/a.md")).unwrap(), "y");
        assert!(dir.join("a.md").exists());
    }

    #[test]
    fn move_path_refuses_dir_into_itself_or_descendant() {
        let dir = temp_vault("mv-self");
        fs::create_dir_all(dir.join("a/b")).unwrap();
        let a = dir.join("a");
        for dest in [a.clone(), a.join("b")] {
            let err = move_path(a.to_str().unwrap(), dest.to_str().unwrap()).unwrap_err();
            assert!(err.contains("into itself"), "{err}");
        }
        assert!(dir.join("a/b").is_dir());
    }

    #[test]
    fn move_path_refuses_non_directory_dest() {
        let dir = temp_vault("mv-nodir");
        fs::write(dir.join("a.md"), "x").unwrap();
        fs::write(dir.join("b.md"), "y").unwrap();
        assert!(move_path(
            dir.join("a.md").to_str().unwrap(),
            dir.join("b.md").to_str().unwrap()
        )
        .is_err());
        assert!(move_path(
            dir.join("a.md").to_str().unwrap(),
            dir.join("missing").to_str().unwrap()
        )
        .is_err());
        assert!(move_path(dir.join("nope.md").to_str().unwrap(), dir.to_str().unwrap()).is_err());
        assert!(dir.join("a.md").exists());
    }

    #[test]
    fn seed_vault_creates_full_layout() {
        let dir = temp_vault("seed");
        seed_vault(&dir).unwrap();
        for sub in ["raw", "wiki", "daily", "ingest-reports"] {
            assert!(dir.join(sub).is_dir(), "missing {sub}/");
        }
        for file in ["welcome.md", "CLAUDE.md", "wiki/index.md", "wiki/log.md"] {
            assert!(dir.join(file).is_file(), "missing {file}");
        }
    }

    #[test]
    fn seed_vault_preserves_existing_files() {
        let dir = temp_vault("seed-preserve");
        seed_vault(&dir).unwrap();
        // User edits the welcome note.
        fs::write(dir.join("welcome.md"), "user edits here\n").unwrap();
        // Re-seed (e.g. on relaunch).
        seed_vault(&dir).unwrap();
        let contents = fs::read_to_string(dir.join("welcome.md")).unwrap();
        assert_eq!(
            contents, "user edits here\n",
            "must not clobber user content"
        );
    }

    #[test]
    fn seed_vault_writes_sample_graph() {
        let dir = temp_vault("seed-sample");
        seed_vault(&dir).unwrap();
        assert!(dir.join("wiki/transformer-architecture.md").is_file());
        assert!(dir
            .join("wiki/source-attention-is-all-you-need.md")
            .is_file());
        // The starter notes cross-link, so the link graph has resolved edges.
        let adj = crate::index::build_link_graph(dir.to_str().unwrap()).unwrap();
        assert!(
            adj.forward.values().any(|v| !v.is_empty()),
            "sample notes should form resolved graph edges"
        );
    }

    #[test]
    fn seed_sample_vault_seeds_into_empty() {
        let dir = temp_vault("seed-offer-empty");
        seed_sample(&dir).unwrap();
        // Same layout + starter notes as the default vault.
        assert!(dir.join("wiki/index.md").is_file());
        assert!(dir.join("wiki/transformer-architecture.md").is_file());
    }

    #[test]
    fn seed_sample_vault_refuses_non_empty() {
        let dir = temp_vault("seed-offer-refuse");
        fs::create_dir_all(dir.join("wiki")).unwrap();
        fs::write(dir.join("wiki/mine.md"), "# mine\n").unwrap();
        assert!(seed_sample(&dir).is_err());
        // The user's vault is left exactly as it was — no demo notes mixed in.
        assert!(!dir.join("wiki/transformer-architecture.md").exists());
        assert!(!dir.join("welcome.md").exists());
    }

    #[test]
    fn list_files_shows_empty_dirs() {
        let dir = temp_vault("empty");
        fs::create_dir_all(dir.join("only-empty")).unwrap();
        fs::write(dir.join("a.md"), "x").unwrap();

        let nodes = list_files(dir.to_str().unwrap()).unwrap();
        // Empty directories are now shown so seeded scaffold folders (raw/,
        // ingest-reports/) are visible. Sorted by name: "a.md" then "only-empty".
        assert_eq!(nodes.len(), 2);
        assert!(matches!(&nodes[0], FileNode::File { name, .. } if name == "a.md"));
        assert!(
            matches!(&nodes[1], FileNode::Directory { name, children, .. } if name == "only-empty" && children.is_empty())
        );
    }

    #[test]
    fn read_vault_context_concatenates_wiki_and_truncates() {
        let dir = temp_vault("ctx");
        fs::create_dir_all(dir.join("wiki")).unwrap();
        fs::write(dir.join("CLAUDE.md"), "schema rules").unwrap();
        fs::write(dir.join("wiki/alpha.md"), "alpha body").unwrap();
        fs::write(dir.join("wiki/beta.md"), "beta body").unwrap();

        let full = read_vault_context(dir.to_str().unwrap(), 100_000).unwrap();
        assert!(full.contains("schema rules"));
        assert!(full.contains("alpha body"));
        assert!(full.contains("beta body"));
        assert!(full.contains("CLAUDE.md"));

        // Tiny budget forces truncation without panicking on char boundaries.
        let small = read_vault_context(dir.to_str().unwrap(), 20).unwrap();
        assert!(small.contains("truncated"));
    }

    #[test]
    fn read_vault_context_spends_a_tight_budget_on_wiki_not_claude_md() {
        // Regression: paths were sorted as one list, so CLAUDE.md (uppercase
        // sorts before "raw"/"wiki") led the output. The builtin model asks for
        // a 6 KB budget, and a real vault's CLAUDE.md is larger than that on its
        // own — the karpathy vault's is 10,599 bytes — so the model received a
        // truncated copy of the schema rules and not one wiki page.
        let dir = temp_vault("ctx-priority");
        fs::create_dir_all(dir.join("wiki")).unwrap();
        fs::create_dir_all(dir.join("raw")).unwrap();
        fs::write(dir.join("CLAUDE.md"), "S".repeat(10_599)).unwrap();
        fs::write(dir.join("wiki/alpha.md"), "alpha body").unwrap();
        fs::write(dir.join("raw/source.md"), "raw source dump").unwrap();

        // The builtin model's real budget.
        let local = read_vault_context(dir.to_str().unwrap(), 6_000).unwrap();
        assert!(
            local.contains("alpha body"),
            "wiki content must survive a budget smaller than CLAUDE.md"
        );

        // A cloud-sized budget still fits everything, so lint keeps its schema.
        let cloud = read_vault_context(dir.to_str().unwrap(), 80_000).unwrap();
        assert!(cloud.contains("alpha body"));
        assert!(cloud.contains(&"S".repeat(10_599)));
        assert!(cloud.contains("raw source dump"));
        // Priority order is wiki -> CLAUDE.md -> raw.
        let wiki_at = cloud.find("wiki/alpha.md").unwrap();
        let claude_at = cloud.find("CLAUDE.md").unwrap();
        let raw_at = cloud.find("raw/source.md").unwrap();
        assert!(wiki_at < claude_at && claude_at < raw_at);
    }

    #[test]
    fn read_vault_context_respects_byte_budget_for_oversized_file() {
        // Regression: the budget used to be checked only BETWEEN files, so a
        // single file larger than max_bytes could overshoot by its whole size.
        // The result must stay within max_bytes plus a small allowance for the
        // section header and the truncation marker.
        let dir = temp_vault("ctx-budget");
        fs::create_dir_all(dir.join("wiki")).unwrap();
        let big = "x".repeat(50_000);
        fs::write(dir.join("wiki/huge.md"), &big).unwrap();

        let max_bytes = 1_000;
        let out = read_vault_context(dir.to_str().unwrap(), max_bytes).unwrap();
        // Header ("\n\n===== wiki/huge.md =====\n") + "\n…(truncated)…" marker +
        // the final "(Note: ...)" line are the only allowed overshoot. Give a
        // generous 256-byte header/marker allowance.
        assert!(
            out.len() <= max_bytes + 256,
            "context overshot budget: {} bytes for a {}-byte limit",
            out.len(),
            max_bytes
        );
        assert!(out.contains("truncated"));
    }
}
