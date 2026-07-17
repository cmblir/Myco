// Vault filesystem operations: open, list, read, write.
// All paths returned to the frontend are canonical absolute paths so the
// frontend can use them as stable file identifiers.

use serde::Serialize;
use std::path::{Path, PathBuf};

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

/// Confine a parent directory (for create_file / create_folder) to `root`.
pub fn confine_parent(root: &Path, parent: &str) -> Result<PathBuf, String> {
    let resolved = Path::new(parent)
        .canonicalize()
        .map_err(|e| format!("canonicalize failed for {parent}: {e}"))?;
    if !resolved.starts_with(root) {
        return Err("parent is outside the open vault".into());
    }
    Ok(resolved)
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

/// Case-insensitive full-text search across the vault's .md files. Returns up to
/// `limit` hits — the first matching line per file — skipping files larger than
/// 2 MB. Files are visited in sorted order for stable results.
pub fn search_vault(root: &Path, query: &str, limit: usize) -> Vec<SearchHit> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() || limit == 0 {
        return Vec::new();
    }
    let mut files = Vec::new();
    collect_md_files(root, &mut files);
    files.sort();

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
            if raw_line.to_lowercase().contains(&needle) {
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

fn collect_md_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
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

/// True if `path` lies inside the vault's immutable `raw/` tree.
///
/// `raw/` holds the source documents every wiki page cites. They are read-only
/// by rule — the repo's CLAUDE.md states this outranks any project-level rule —
/// because a citation is only worth anything if the thing cited never moved
/// under it. This is the one definition of that boundary; `agent_tools` gates
/// its write tools on it too, and a second copy is how the rule gets missed in
/// a third place.
pub(crate) fn is_raw_path(root: &Path, path: &Path) -> bool {
    path.strip_prefix(root)
        .ok()
        .and_then(|rel| rel.components().next())
        .map(|c| c.as_os_str() == "raw")
        .unwrap_or(false)
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

// Creates and seeds Memex's own vault on first launch. We default to
// ~/Documents/Memex so the folder shows up in Finder/Files, alongside the
// user's other documents — Memex owns it, but it is plain markdown that
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
    let target = Path::new(&home).join("Documents").join("Memex");
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

fn write_if_missing(path: &Path, content: &str) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    std::fs::write(path, content).map_err(|e| format!("write {path:?}: {e}"))
}

const WELCOME: &str = r#"# Welcome to Memex

This is your Memex vault. Everything you write here lives in plain
markdown on disk — you stay in control.

## Layout

- `raw/` — drop or paste sources here (PDF, text, articles). Treat as
  immutable; Memex never modifies these.
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

const VAULT_CLAUDE_MD: &str = r#"# Memex Vault — Maintenance Rules

This vault is maintained by Claude through the Memex desktop app. The
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

When the user drops a source via Memex's Ingest page, Claude is called
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
    let meta = std::fs::metadata(&confined).map_err(|e| format!("stat failed: {e}"))?;
    if meta.len() > max {
        return Err("file is too large to open in the viewer".into());
    }
    std::fs::read(&confined).map_err(|e| format!("read failed: {e}"))
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

fn pod_to_json(pod: gray_matter::Pod) -> serde_json::Value {
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

pub fn create_file(parent: &str, name: &str) -> Result<String, String> {
    validate_name(name)?;
    let parent_path = Path::new(parent);
    if !parent_path.is_dir() {
        return Err(format!("parent is not a directory: {parent}"));
    }
    let target = parent_path.join(name);
    if target.exists() {
        return Err(format!("already exists: {}", target.display()));
    }
    std::fs::write(&target, "").map_err(|e| format!("create failed: {e}"))?;
    Ok(target.to_string_lossy().into_owned())
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
        std::fs::write(&app_json, "{\"attachmentFolderPath\":\"raw/assets\"}")
            .map_err(|e| format!("write app.json failed: {e}"))?;
    }
    Ok(dir.to_string_lossy().into_owned())
}

pub fn create_folder(parent: &str, name: &str) -> Result<String, String> {
    validate_name(name)?;
    let parent_path = Path::new(parent);
    if !parent_path.is_dir() {
        return Err(format!("parent is not a directory: {parent}"));
    }
    let target = parent_path.join(name);
    if target.exists() {
        return Err(format!("already exists: {}", target.display()));
    }
    std::fs::create_dir(&target).map_err(|e| format!("mkdir failed: {e}"))?;
    Ok(target.to_string_lossy().into_owned())
}

/// Move a file or directory to the OS trash (recoverable) instead of
/// unlinking it. Deliberately NO fallback to a hard delete: if the trash
/// operation fails we surface the error rather than silently destroying data.
pub fn delete_path(path: &str) -> Result<(), String> {
    let target = Path::new(path);
    if !target.exists() {
        return Err(format!("not found: {path}"));
    }
    trash::delete(target).map_err(|e| format!("move to trash failed: {e}"))
}

pub fn rename_path(from: &str, to_name: &str) -> Result<String, String> {
    validate_name(to_name)?;
    let src = Path::new(from);
    if !src.exists() {
        return Err(format!("not found: {from}"));
    }
    let parent = src.parent().ok_or_else(|| "no parent dir".to_string())?;
    let target = parent.join(to_name);
    if target.exists() {
        return Err(format!("destination exists: {}", target.display()));
    }
    std::fs::rename(src, &target).map_err(|e| format!("rename failed: {e}"))?;
    Ok(target.to_string_lossy().into_owned())
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

pub fn write_file(path: &str, content: &str) -> Result<(), String> {
    let target = Path::new(path);
    let parent = target
        .parent()
        .ok_or_else(|| format!("no parent dir for {path}"))?;
    if !parent.exists() {
        return Err(format!("parent does not exist: {}", parent.display()));
    }

    use std::io::Write;
    let mut tmp = tempfile::Builder::new()
        .prefix(".memex-tmp-")
        .suffix(".md")
        .tempfile_in(parent)
        .map_err(|e| format!("tempfile create failed: {e}"))?;
    tmp.write_all(content.as_bytes())
        .map_err(|e| format!("tempfile write failed: {e}"))?;
    tmp.as_file_mut()
        .sync_all()
        .map_err(|e| format!("tempfile sync failed: {e}"))?;
    tmp.persist(target)
        .map_err(|e| format!("rename failed: {}", e.error))?;
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
    Ok(())
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

/// A cheap fingerprint of the vault's markdown: a hash over every .md file's
/// path, mtime and length.
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
    collect_revision_entries(&root_path, &mut entries);
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

/// Stat-only walk backing `vault_revision`. Best-effort throughout: an
/// unreadable directory contributes nothing rather than failing the check, for
/// the same reason the link-graph walk skips one — a fingerprint that errors is
/// a fingerprint the caller has to fall back from, which defeats the point.
fn collect_revision_entries(dir: &Path, out: &mut Vec<(String, i64, u64)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if is_hidden(&entry.file_name()) {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            collect_revision_entries(&path, out);
        } else if is_markdown(&path) {
            let Ok(meta) = entry.metadata() else { continue };
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            out.push((path.to_string_lossy().into_owned(), mtime, meta.len()));
        }
    }
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
    for entry in std::fs::read_dir(dir)?.flatten() {
        if is_hidden(&entry.file_name()) {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            collect_mtimes(&path, out)?;
        } else if is_markdown(&path) {
            let mtime = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            out.push((path.to_string_lossy().into_owned(), mtime));
        }
    }
    Ok(())
}

fn walk_dir(dir: &Path) -> std::io::Result<Vec<FileNode>> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter(|e| !is_hidden(&e.file_name()))
        .collect();
    entries.sort_by_key(|e| e.file_name());

    let mut nodes = Vec::with_capacity(entries.len());
    for entry in entries {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let path_str = path.to_string_lossy().into_owned();
        if path.is_dir() {
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
    let push_dir = |dir: std::path::PathBuf,
                        out: &mut Vec<std::path::PathBuf>|
     -> Result<(), String> {
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
        let header = format!("\n\n===== {} =====\n", rel.to_string_lossy());
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
    for entry in std::fs::read_dir(dir)?.flatten() {
        if is_hidden(&entry.file_name()) {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
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

fn is_hidden(name: &std::ffi::OsStr) -> bool {
    name.to_str()
        .is_some_and(|s| s.starts_with('.') || s == "node_modules" || s == "target")
}

fn is_markdown(path: &Path) -> bool {
    path.extension().and_then(|s| s.to_str()) == Some("md")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::fs;

    #[test]
    fn open_vault_rejects_empty() {
        assert!(open_vault("").is_err());
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
        assert_ne!(r2, r3, "an edit that changes length must change the revision");

        // Deleting changes it back to something new (not necessarily r1: mtimes
        // of the remaining files are unchanged, so it should in fact equal r1).
        fs::remove_file(dir.join("wiki/b.md")).unwrap();
        assert_eq!(r1, vault_revision(root).unwrap(), "removing the new page restores the revision");

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

    #[test]
    fn vault_revision_survives_an_unreadable_subdir() {
        // A fingerprint that errors is one the caller must fall back from,
        // which defeats its purpose.
        let dir = temp_vault("revision-locked");
        fs::create_dir_all(dir.join("wiki")).unwrap();
        fs::write(dir.join("wiki/a.md"), "alpha").unwrap();
        let locked = dir.join("locked");
        fs::create_dir_all(&locked).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
        }
        let got = vault_revision(dir.to_str().unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).ok();
        }
        assert!(got.is_ok(), "an unlistable subdir must not fail the check");
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
        assert!(wiki_after.contains("[[new-note]]"), "wiki backlinks still rewrite");
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

    #[test]
    fn write_file_fails_if_parent_missing() {
        let p = env::temp_dir().join("memex-no-parent-xyz/file.md");
        assert!(write_file(p.to_str().unwrap(), "x").is_err());
    }

    #[test]
    fn create_file_writes_empty_md() {
        let dir = temp_vault("create-file");
        let path = create_file(dir.to_str().unwrap(), "alpha.md").unwrap();
        assert!(std::path::Path::new(&path).exists());
        assert_eq!(fs::read_to_string(&path).unwrap(), "");
    }

    #[test]
    fn create_file_rejects_collision() {
        let dir = temp_vault("create-file-collide");
        fs::write(dir.join("x.md"), "old").unwrap();
        assert!(create_file(dir.to_str().unwrap(), "x.md").is_err());
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
    fn rename_path_moves_within_parent() {
        let dir = temp_vault("ren");
        fs::write(dir.join("old.md"), "x").unwrap();
        let new_path = rename_path(dir.join("old.md").to_str().unwrap(), "new.md").unwrap();
        assert!(std::path::Path::new(&new_path).exists());
        assert!(!dir.join("old.md").exists());
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
