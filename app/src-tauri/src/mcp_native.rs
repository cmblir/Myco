// Native in-process MCP server (rmcp), replacing the Python subprocess so the
// server works on any machine with ZERO external runtime — no system Python, no
// venv, no pip. It runs inside the app's own tokio runtime and re-resolves the
// active vault per call (via the app-data marker), so switching projects in the
// UI is seen by the very next tool call with no restart.
//
// rmcp 2.2 dropped the legacy dual-endpoint SSE transport, so this serves
// Streamable HTTP at `/mcp`; clients register with `--transport http`.
//
// Tool handlers call the app's existing Tauri-free domain functions
// (vault.rs / registry.rs / index.rs / provenance.rs). This file is a crate
// module, so it can reach `pub(crate)` helpers too.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use regex::Regex;
use rmcp::{
    ErrorData as McpError, ServerHandler,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, ContentBlock},
    schemars, tool, tool_handler, tool_router,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    },
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::{registry, settings, vault};

/// Fixed loopback port. Matches the documented `claude mcp add` URL.
pub const MCP_PORT: u16 = 22360;

pub fn mcp_url() -> String {
    format!("http://localhost:{MCP_PORT}/mcp")
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/// Wrap a JSON value as the tool's text result. Every tool returns a uniform
/// JSON envelope (text content) so callers get a predictable shape.
fn json_result(v: Value) -> Result<CallToolResult, McpError> {
    let text = serde_json::to_string_pretty(&v)
        .unwrap_or_else(|e| format!("{{\"ok\":false,\"error\":\"serialize: {e}\"}}"));
    Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
}

/// A domain-level failure (no vault, bad path, missing page) is returned as a
/// normal `{ok:false}` result, not an MCP protocol error — the client sees it
/// as tool output it can reason about.
fn fail(msg: impl Into<String>) -> Result<CallToolResult, McpError> {
    json_result(json!({ "ok": false, "error": msg.into() }))
}

/// Resolve the vault root for a tool call: the named project's root, or the
/// active vault when `project` is empty.
fn resolve_root(project: &str) -> Result<PathBuf, String> {
    let active = settings::active_vault().map(PathBuf::from);
    if project.is_empty() {
        return active.ok_or_else(|| "no active vault open".to_string());
    }
    let start = active.ok_or("no active vault to locate the project registry")?;
    let reg = registry::Registry::discover(&start)
        .ok_or("no project registry found (standalone vault)")?;
    reg.resolve_project_root(project)
}

fn wiki_dir(root: &Path) -> PathBuf {
    root.join("wiki")
}
fn raw_dir(root: &Path) -> PathBuf {
    root.join("raw")
}
fn inbox_dir(root: &Path) -> PathBuf {
    root.join("_inbox")
}

/// Lexically resolve `rel` under `base`, rejecting any `..`/absolute escape.
/// Works for not-yet-existing paths (no canonicalize of the leaf required).
fn safe_join(base: &Path, rel: &str) -> Option<PathBuf> {
    let mut out = base.to_path_buf();
    for comp in Path::new(rel).components() {
        use std::path::Component::*;
        match comp {
            Normal(c) => out.push(c),
            CurDir => {}
            ParentDir => {
                if !out.pop() || !out.starts_with(base) {
                    return None;
                }
            }
            RootDir | Prefix(_) => return None,
        }
    }
    out.starts_with(base).then_some(out)
}

/// Collect every `.md` file under `dir` (recursively), returned as absolute
/// paths. Missing dir → empty. Reuses the vault file walker.
fn collect_md(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if !dir.is_dir() {
        return out;
    }
    if let Ok(nodes) = vault::list_files(&dir.to_string_lossy()) {
        fn walk(nodes: &[vault::FileNode], out: &mut Vec<PathBuf>) {
            for n in nodes {
                match n {
                    vault::FileNode::File { path, .. } => out.push(PathBuf::from(path)),
                    vault::FileNode::Directory { children, .. } => walk(children, out),
                }
            }
        }
        walk(&nodes, &mut out);
    }
    out
}

fn rel_to(base: &Path, abs: &Path) -> String {
    abs.strip_prefix(base)
        .unwrap_or(abs)
        .to_string_lossy()
        .to_string()
}

fn fm_str(fm: &Value, key: &str) -> String {
    fm.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

fn fm_opt(fm: &Value, key: &str) -> Option<String> {
    fm.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// (frontmatter, body) for a page, via the vault's frontmatter parser.
fn read_parts(abs: &Path) -> Option<(Value, String)> {
    vault::read_file(&abs.to_string_lossy())
        .ok()
        .map(|fc| (fc.frontmatter, fc.content))
}

// ─── ported wiki-schema logic (mirrors the Python server, regex parity) ───────

const VALID_TYPES: [&str; 5] = ["concept", "technique", "entity", "source-summary", "analysis"];
const LINT_META_TYPES: [&str; 2] = ["overview", "meta"];
const LINT_SKIP_NAMES: [&str; 2] = ["index.md", "log.md"];

/// title → slug. Mirror of the Python `make_slug` (Unicode-aware; the regex
/// crate's `\w` already matches Hangul, so Korean titles slug like Python's).
fn make_slug(title: &str) -> String {
    static NONWORD: OnceLock<Regex> = OnceLock::new();
    static WS: OnceLock<Regex> = OnceLock::new();
    static DASHES: OnceLock<Regex> = OnceLock::new();
    let nonword = NONWORD.get_or_init(|| Regex::new(r"[^\w\s-]").unwrap());
    let ws = WS.get_or_init(|| Regex::new(r"[\s_]+").unwrap());
    let dashes = DASHES.get_or_init(|| Regex::new(r"-+").unwrap());
    let s = title.trim().to_lowercase();
    let s = nonword.replace_all(&s, "");
    let s = ws.replace_all(&s, "-");
    let s = dashes.replace_all(&s, "-");
    let s = s.trim_matches('-').to_string();
    if s.is_empty() {
        let n = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        format!("untitled-{n}")
    } else {
        s
    }
}

/// `[^src-*]` citation refs (not the `[^src-*]:` definitions). The regex crate
/// has no lookahead, so the trailing-colon exclusion is checked by hand.
fn footnote_refs(body: &str) -> BTreeSet<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"\[\^(src-[\w-]+)\]").unwrap());
    let mut out = BTreeSet::new();
    for m in re.captures_iter(body) {
        let whole = m.get(0).unwrap();
        if body[whole.end()..].chars().next() == Some(':') {
            continue; // it's a definition, not a reference
        }
        out.insert(m[1].to_string());
    }
    out
}

/// `[^src-*]:` footnote definitions (line-start).
fn footnote_defs(body: &str) -> BTreeSet<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?m)^\[\^(src-[\w-]+)\]:").unwrap());
    re.captures_iter(body).map(|m| m[1].to_string()).collect()
}

/// Raw `[[...]]` occurrence count (with duplicates), for stats parity.
fn wikilink_count(body: &str) -> usize {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]").unwrap());
    re.find_iter(body).count()
}

/// `[[link]]` targets, `.md`-normalized and de-duplicated (sorted).
fn extract_links(body: &str) -> BTreeSet<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"\[\[([^\]|]+)(?:\|[^\]]*)?\]\]").unwrap());
    let mut out = BTreeSet::new();
    for m in re.captures_iter(body) {
        let s = m[1].trim();
        out.insert(if s.ends_with(".md") {
            s.to_string()
        } else {
            format!("{s}.md")
        });
    }
    out
}

/// `[[slug::page]]` cross-project links → (slug, page-without-.md).
fn cross_links(body: &str) -> Vec<(String, String)> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE
        .get_or_init(|| Regex::new(r"\[\[([a-z0-9][\w-]*?)::([^\]|]+?)(?:\|[^\]]*?)?\]\]").unwrap());
    re.captures_iter(body)
        .map(|m| {
            let slug = m[1].trim().to_string();
            let page = m[2].trim();
            (slug, page.strip_suffix(".md").unwrap_or(page).to_string())
        })
        .collect()
}

/// Structural + citation lint of one page (frontmatter + body). Mirrors the
/// Python `lint_page_text`. Empty = clean.
fn lint_page(fm: &Value, body: &str) -> Vec<String> {
    let mut problems = Vec::new();
    let empty_fm = fm.as_object().map(|o| o.is_empty()).unwrap_or(true);
    if empty_fm {
        problems.push("missing frontmatter".to_string());
        return problems;
    }
    let ptype = fm_opt(fm, "type");
    if let Some(t) = &ptype {
        if LINT_META_TYPES.contains(&t.as_str()) {
            return Vec::new(); // meta/scaffold page — schema does not apply
        }
    }
    match &ptype {
        None => problems.push("missing `type`".to_string()),
        Some(t) if !VALID_TYPES.contains(&t.as_str()) => {
            problems.push(format!("invalid `type`: {t}"))
        }
        _ => {}
    }
    let status = fm_opt(fm, "status");
    if status.as_deref() == Some("superseded") && fm.get("superseded_by").is_none() {
        problems.push("status=superseded without `superseded_by`".to_string());
    }
    if status.as_deref() == Some("disputed") && !body.contains("## Disputed") {
        problems.push("status=disputed without a `## Disputed` section".to_string());
    }
    let refs = footnote_refs(body);
    let defs = footnote_defs(body);
    for r in refs.difference(&defs) {
        problems.push(format!("citation [^{r}] has no definition"));
    }
    for d in defs.difference(&refs) {
        problems.push(format!("footnote [^{d}] defined but never referenced"));
    }
    if !refs.is_empty() {
        if let Some(sc) = fm.get("source_count") {
            let n = sc
                .as_i64()
                .or_else(|| sc.as_str().and_then(|s| s.parse::<i64>().ok()));
            match n {
                Some(n) if n as usize != refs.len() => problems.push(format!(
                    "source_count={sc} but {} distinct citations",
                    refs.len()
                )),
                None if sc.as_str().is_some() => {
                    problems.push(format!("source_count is not a number: {sc}"))
                }
                _ => {}
            }
        }
    }
    problems
}

/// Source-type → trust weight (GOV-03). Unknown/absent → neutral 0.5.
fn source_trust(stype: &str) -> f64 {
    match stype.trim().to_lowercase().as_str() {
        "peer-reviewed" => 1.0,
        "paper" => 0.95,
        "book" => 0.9,
        "official-docs" => 0.85,
        "primary" => 0.85,
        "news" => 0.6,
        "blog" => 0.45,
        "forum" => 0.35,
        "tweet" => 0.25,
        _ => 0.5,
    }
}

fn suggest_confidence(stype: Option<&str>, cites: usize) -> &'static str {
    let trust = source_trust(stype.unwrap_or("unknown"));
    let cite_factor = (cites as f64 / 3.0).min(1.0);
    let score = trust * (0.5 + 0.5 * cite_factor);
    if score >= 0.75 {
        "high"
    } else if score >= 0.45 {
        "medium"
    } else {
        "low"
    }
}

// ─── server ──────────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct MemexServer {
    tool_router: ToolRouter<MemexServer>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ProjectArg {
    /// Project slug; empty string = the active project.
    #[serde(default)]
    project: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ListPagesArgs {
    /// Optional wiki subfolder to scope to (e.g. "concepts"); empty = all.
    #[serde(default)]
    folder: String,
    /// Optional page-type filter (frontmatter `type`); empty = all.
    #[serde(default, rename = "type")]
    type_filter: String,
    #[serde(default)]
    project: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ReadPageArgs {
    /// wiki-relative filename, e.g. "transformer-architecture.md".
    filename: String,
    #[serde(default)]
    project: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct SearchArgs {
    /// Search query (whitespace-separated terms, case-insensitive substring).
    query: String,
    /// Max results (default 20).
    #[serde(default)]
    top_k: Option<usize>,
    /// Search across ALL projects instead of just one.
    #[serde(default)]
    all_projects: bool,
    #[serde(default)]
    project: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct RecentLogArgs {
    /// How many recent entries to return (default 20).
    #[serde(default)]
    n: Option<usize>,
    #[serde(default)]
    project: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct InboxSourceArgs {
    /// Filename inside the project's _inbox/.
    filename: String,
    #[serde(default)]
    project: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct PreviewArgs {
    /// wiki-relative filename to preview an update for.
    filename: String,
    /// The full proposed new content (frontmatter + body).
    content: String,
    #[serde(default)]
    project: String,
}

#[tool_router]
impl MemexServer {
    pub fn new() -> Self {
        Self {
            tool_router: Self::tool_router(),
        }
    }

    /// List all Memex projects plus the active slug. Use a slug as `project` in
    /// other tools, or pass "" for the active one.
    #[tool(description = "List all Memex projects and the active project slug")]
    async fn list_projects(&self) -> Result<CallToolResult, McpError> {
        let Some(active) = settings::active_vault().map(PathBuf::from) else {
            return fail("no active vault open");
        };
        let projects: Vec<Value> = match registry::Registry::discover(&active) {
            Some(reg) => reg
                .project_infos()
                .into_iter()
                .map(|p| {
                    json!({
                        "slug": p.slug, "title": p.title, "description": p.description,
                        "root": p.root, "note_count": p.note_count, "active": p.active,
                        "independent_vault": p.independent_vault,
                    })
                })
                .collect(),
            // Standalone vault (no projects.json): report the open vault itself.
            None => vec![json!({
                "slug": "", "title": active.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
                "root": active.to_string_lossy(), "active": true,
            })],
        };
        json_result(json!({ "ok": true, "projects": projects }))
    }

    /// The active (or named) vault's CLAUDE.md authoring instructions.
    #[tool(description = "Get the Memex wiki authoring instructions (CLAUDE.md) for a project")]
    async fn get_instructions(
        &self,
        Parameters(a): Parameters<ProjectArg>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        let path = root.join("CLAUDE.md");
        match std::fs::read_to_string(&path) {
            Ok(content) => json_result(json!({
                "ok": true, "found": true, "path": path.to_string_lossy(), "content": content,
            })),
            Err(e) => json_result(json!({
                "ok": true, "found": false, "path": path.to_string_lossy(),
                "content": "", "note": e.to_string(),
            })),
        }
    }

    /// Counts: wiki pages, raw sources, total wikilinks, and type breakdown.
    #[tool(description = "Vault statistics: page/source counts, link total, type breakdown")]
    async fn stats(
        &self,
        Parameters(a): Parameters<ProjectArg>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        let pages = collect_md(&wiki_dir(&root));
        let raw_sources = collect_md(&raw_dir(&root)).len();
        // total_links counts raw [[...]] occurrences (with duplicates), matching
        // the Python server — not resolved graph edges.
        let mut total_links = 0usize;
        let mut type_counts: std::collections::BTreeMap<String, usize> = Default::default();
        for abs in &pages {
            if let Some((fm, body)) = read_parts(abs) {
                if let Some(t) = fm_opt(&fm, "type") {
                    *type_counts.entry(t).or_default() += 1;
                }
                total_links += wikilink_count(&body);
            }
        }
        json_result(json!({
            "ok": true, "total_pages": pages.len(), "raw_sources": raw_sources,
            "total_links": total_links, "type_counts": type_counts,
        }))
    }

    /// List wiki pages with a frontmatter summary (title, type, tags).
    #[tool(description = "List wiki pages with title/type/tags; optional folder or type filter")]
    async fn list_pages(
        &self,
        Parameters(a): Parameters<ListPagesArgs>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        let wiki = wiki_dir(&root);
        let scope = if a.folder.is_empty() {
            wiki.clone()
        } else {
            match safe_join(&wiki, &a.folder) {
                Some(p) => p,
                None => return fail(format!("folder escapes wiki/: {}", a.folder)),
            }
        };
        let mut pages = Vec::new();
        for abs in collect_md(&scope) {
            let fc = match vault::read_file(&abs.to_string_lossy()) {
                Ok(fc) => fc,
                Err(_) => continue,
            };
            let ptype = fm_str(&fc.frontmatter, "type");
            if !a.type_filter.is_empty() && ptype != a.type_filter {
                continue;
            }
            pages.push(json!({
                "filename": rel_to(&wiki, &abs),
                "title": fm_str(&fc.frontmatter, "title"),
                "type": ptype,
                "tags": fc.frontmatter.get("tags").cloned().unwrap_or(json!([])),
            }));
        }
        json_result(json!({ "ok": true, "count": pages.len(), "pages": pages }))
    }

    /// Read one wiki page: frontmatter, body, and word count.
    #[tool(description = "Read a wiki page's frontmatter and body by wiki-relative filename")]
    async fn read_page(
        &self,
        Parameters(a): Parameters<ReadPageArgs>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        let Some(abs) = safe_join(&wiki_dir(&root), &a.filename) else {
            return fail(format!("path escapes wiki/: {}", a.filename));
        };
        match vault::read_file(&abs.to_string_lossy()) {
            Ok(fc) => json_result(json!({
                "ok": true,
                "filename": a.filename,
                "frontmatter": fc.frontmatter,
                "content": fc.content,
                "word_count": fc.content.split_whitespace().count(),
            })),
            Err(e) => fail(e),
        }
    }

    /// Full-text (substring) search over a project, or all projects.
    #[tool(description = "Search wiki + raw content; one hit per file with a snippet")]
    async fn search(
        &self,
        Parameters(a): Parameters<SearchArgs>,
    ) -> Result<CallToolResult, McpError> {
        let limit = a.top_k.unwrap_or(20).clamp(1, 200);
        let mut roots: Vec<(String, PathBuf)> = Vec::new();
        if a.all_projects {
            let active = match settings::active_vault().map(PathBuf::from) {
                Some(r) => r,
                None => return fail("no active vault open"),
            };
            match registry::Registry::discover(&active) {
                Some(reg) => {
                    for p in reg.project_infos() {
                        roots.push((p.slug, PathBuf::from(p.root)));
                    }
                }
                None => roots.push((String::new(), active)),
            }
        } else {
            match resolve_root(&a.project) {
                Ok(r) => roots.push((a.project.clone(), r)),
                Err(e) => return fail(e),
            }
        }
        let mut hits = Vec::new();
        for (slug, root) in roots {
            for h in vault::search_vault(&root, &a.query, limit) {
                hits.push(json!({
                    "project": slug,
                    "path": rel_to(&root, Path::new(&h.path)),
                    "name": h.name, "line": h.line, "snippet": h.snippet,
                }));
                if hits.len() >= limit {
                    break;
                }
            }
        }
        json_result(json!({ "ok": true, "count": hits.len(), "hits": hits }))
    }

    /// The wiki folder tree (directories + `.md` files).
    #[tool(description = "Folder tree of the wiki (directories and pages)")]
    async fn folder_tree(
        &self,
        Parameters(a): Parameters<ProjectArg>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        match vault::list_files(&wiki_dir(&root).to_string_lossy()) {
            Ok(tree) => json_result(json!({ "ok": true, "tree": tree })),
            Err(e) => fail(e),
        }
    }

    /// Recent wiki activity from wiki/log.md (newest first).
    #[tool(description = "Recent wiki log entries from wiki/log.md, newest first")]
    async fn recent_log(
        &self,
        Parameters(a): Parameters<RecentLogArgs>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        let n = a.n.unwrap_or(20).clamp(1, 500);
        let log = wiki_dir(&root).join("log.md");
        let text = std::fs::read_to_string(&log).unwrap_or_default();
        // Header lines look like: "## [2026-06-22] ingest | Title".
        let mut entries: Vec<&str> = text
            .lines()
            .filter(|l| l.starts_with("## ["))
            .map(|l| l.trim_start_matches("## ").trim())
            .collect();
        entries.reverse();
        entries.truncate(n);
        json_result(json!({ "ok": true, "count": entries.len(), "entries": entries }))
    }

    /// List raw/ source files with byte sizes.
    #[tool(description = "List immutable raw/ source files with sizes")]
    async fn list_raw_sources(
        &self,
        Parameters(a): Parameters<ProjectArg>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        let raw = raw_dir(&root);
        let mut sources = Vec::new();
        for abs in collect_md(&raw) {
            let size = std::fs::metadata(&abs).map(|m| m.len()).unwrap_or(0);
            sources.push(json!({ "filename": rel_to(&raw, &abs), "bytes": size }));
        }
        json_result(json!({ "ok": true, "count": sources.len(), "sources": sources }))
    }

    /// List _inbox/ files awaiting processing.
    #[tool(description = "List files in the project's _inbox/ awaiting ingest")]
    async fn list_inbox(
        &self,
        Parameters(a): Parameters<ProjectArg>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        let inbox = inbox_dir(&root);
        let mut files = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&inbox) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') {
                    continue;
                }
                let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                files.push(json!({ "filename": name, "bytes": size }));
            }
        }
        json_result(json!({ "ok": true, "count": files.len(), "files": files }))
    }

    /// Read one _inbox/ source file's text.
    #[tool(description = "Read a file from the project's _inbox/ by filename")]
    async fn read_inbox_source(
        &self,
        Parameters(a): Parameters<InboxSourceArgs>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        let Some(abs) = safe_join(&inbox_dir(&root), &a.filename) else {
            return fail(format!("path escapes _inbox/: {}", a.filename));
        };
        match std::fs::read_to_string(&abs) {
            Ok(content) => json_result(json!({
                "ok": true, "filename": a.filename, "content": content,
            })),
            Err(e) => fail(e.to_string()),
        }
    }

    /// Source-trust audit: each page's source_type, trust weight, citation
    /// count, and the confidence the schema would suggest (flags mismatches).
    #[tool(description = "Source-trust audit: declared vs suggested confidence per page")]
    async fn trust_report(
        &self,
        Parameters(a): Parameters<ProjectArg>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        let wiki = wiki_dir(&root);
        let mut rows = Vec::new();
        let mut mismatches = 0usize;
        for abs in collect_md(&wiki) {
            let name = abs.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            if LINT_SKIP_NAMES.contains(&name.as_str()) {
                continue;
            }
            let Some((fm, body)) = read_parts(&abs) else { continue };
            let empty = fm.as_object().map(|o| o.is_empty()).unwrap_or(true);
            if empty || fm_opt(&fm, "type").map(|t| LINT_META_TYPES.contains(&t.as_str())).unwrap_or(false) {
                continue;
            }
            let stype = fm_opt(&fm, "source_type");
            let cites = footnote_refs(&body).len();
            let suggested = suggest_confidence(stype.as_deref(), cites);
            let declared = fm_opt(&fm, "confidence");
            let mismatch = declared.as_deref().map(|d| d != suggested).unwrap_or(false);
            if mismatch {
                mismatches += 1;
            }
            rows.push(json!({
                "filename": rel_to(&wiki, &abs),
                "source_type": stype.clone().unwrap_or_else(|| "(unset)".into()),
                "trust": source_trust(stype.as_deref().unwrap_or("unknown")),
                "citations": cites,
                "declared_confidence": declared.unwrap_or_else(|| "(unset)".into()),
                "suggested_confidence": suggested,
                "mismatch": mismatch,
            }));
        }
        json_result(json!({ "ok": true, "pages": rows.len(), "mismatches": mismatches, "rows": rows }))
    }

    /// Structural + citation lint over every wiki page — no LLM, instant.
    #[tool(description = "Lint all wiki pages: frontmatter, type, citation contracts")]
    async fn lint_citations(
        &self,
        Parameters(a): Parameters<ProjectArg>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        let wiki = wiki_dir(&root);
        let mut report = serde_json::Map::new();
        let (mut total, mut checked) = (0usize, 0usize);
        for abs in collect_md(&wiki) {
            let name = abs.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            if LINT_SKIP_NAMES.contains(&name.as_str()) {
                continue;
            }
            checked += 1;
            let Some((fm, body)) = read_parts(&abs) else { continue };
            let problems = lint_page(&fm, &body);
            if !problems.is_empty() {
                total += problems.len();
                report.insert(rel_to(&wiki, &abs), json!(problems));
            }
        }
        json_result(json!({
            "ok": true, "pages_checked": checked,
            "pages_with_problems": report.len(), "problems_total": total, "report": report,
        }))
    }

    /// Unified diff of what update_page WOULD write — changes nothing on disk.
    #[tool(description = "Preview a page update as a unified diff without writing")]
    async fn preview_page_update(
        &self,
        Parameters(a): Parameters<PreviewArgs>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        let Some(abs) = safe_join(&wiki_dir(&root), &a.filename) else {
            return fail(format!("path escapes wiki/: {}", a.filename));
        };
        if !abs.is_file() {
            return fail(format!("not found: {}", a.filename));
        }
        let old = std::fs::read_to_string(&abs).unwrap_or_default();
        if old == a.content {
            return json_result(json!({ "ok": true, "changed": false, "diff": "" }));
        }
        let diff = similar::TextDiff::from_lines(&old, &a.content)
            .unified_diff()
            .header(&format!("a/{}", a.filename), &format!("b/{}", a.filename))
            .to_string();
        json_result(json!({ "ok": true, "changed": true, "diff": diff }))
    }

    /// Structural contradiction scan — disputed pages + active→superseded links.
    #[tool(description = "Flag disputed pages and active pages linking to superseded ones")]
    async fn contradictions(
        &self,
        Parameters(a): Parameters<ProjectArg>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        let wiki = wiki_dir(&root);
        // filename → (status, normalized links)
        let mut pages: std::collections::BTreeMap<String, (String, BTreeSet<String>)> =
            Default::default();
        for abs in collect_md(&wiki) {
            let name = abs.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            if LINT_SKIP_NAMES.contains(&name.as_str()) {
                continue;
            }
            let Some((fm, body)) = read_parts(&abs) else { continue };
            let status = fm_opt(&fm, "status").unwrap_or_else(|| "active".into());
            pages.insert(rel_to(&wiki, &abs), (status, extract_links(&body)));
        }
        let mut found = Vec::new();
        for (fnm, (status, _)) in &pages {
            if status == "disputed" {
                found.push(json!({ "kind": "disputed", "page": fnm, "detail": "page is flagged disputed" }));
            }
        }
        for (fnm, (status, links)) in &pages {
            if status != "active" {
                continue;
            }
            for tgt in links {
                if pages.get(tgt).map(|(s, _)| s == "superseded").unwrap_or(false) {
                    let disp = tgt.strip_suffix(".md").unwrap_or(tgt);
                    found.push(json!({ "kind": "stale-link", "page": fnm, "detail": format!("links to superseded [[{disp}]]") }));
                }
            }
        }
        json_result(json!({ "ok": true, "count": found.len(), "found": found }))
    }

    /// Resolve a page's [[slug::page]] cross-project links (target + existence).
    #[tool(description = "Resolve [[slug::page]] cross-project links on a page")]
    async fn resolve_cross_links(
        &self,
        Parameters(a): Parameters<ReadPageArgs>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        let Some(abs) = safe_join(&wiki_dir(&root), &a.filename) else {
            return fail(format!("path escapes wiki/: {}", a.filename));
        };
        if !abs.is_file() {
            return fail(format!("not found: {}", a.filename));
        }
        let Some((_, body)) = read_parts(&abs) else {
            return fail("could not read page");
        };
        let projs = settings::active_vault()
            .map(PathBuf::from)
            .and_then(|p| registry::Registry::discover(&p))
            .map(|r| r.project_infos())
            .unwrap_or_default();
        let mut links = Vec::new();
        for (slug, page) in cross_links(&body) {
            let tproj = projs.iter().find(|p| p.slug == slug);
            let exists = tproj
                .map(|p| Path::new(&p.root).join("wiki").join(format!("{page}.md")).is_file())
                .unwrap_or(false);
            links.push(json!({
                "project": slug, "page": page,
                "exists": exists, "known_project": tproj.is_some(),
            }));
        }
        json_result(json!({ "ok": true, "links": links }))
    }

    /// KO/EN translation-relation audit: declared translation_of pairs, dangling
    /// targets, and missing reciprocal back-links.
    #[tool(description = "Audit translation_of page pairs (dangling / non-reciprocal)")]
    async fn translation_report(
        &self,
        Parameters(a): Parameters<ProjectArg>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        let wiki = wiki_dir(&root);
        let mut metas: std::collections::BTreeMap<String, Value> = Default::default();
        for abs in collect_md(&wiki) {
            let stem = abs.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            if let Some((fm, _)) = read_parts(&abs) {
                metas.insert(stem, fm);
            }
        }
        let mut pairs = Vec::new();
        for (stem, fm) in &metas {
            let Some(tgt) = fm_opt(fm, "translation_of") else { continue };
            let tgt_stem = tgt.strip_suffix(".md").unwrap_or(&tgt).to_string();
            let target_meta = metas.get(&tgt_stem);
            let reciprocal = target_meta
                .and_then(|tm| fm_opt(tm, "translation_of"))
                .map(|s| s.replace(".md", "") == *stem)
                .unwrap_or(false);
            pairs.push(json!({
                "page": format!("{stem}.md"),
                "translation_of": format!("{tgt_stem}.md"),
                "target_exists": target_meta.is_some(),
                "reciprocal": reciprocal,
            }));
        }
        json_result(json!({ "ok": true, "count": pairs.len(), "pairs": pairs }))
    }
}

#[tool_handler]
impl ServerHandler for MemexServer {}

// ─── transport ───────────────────────────────────────────────────────────────

/// Bind the native MCP server on 127.0.0.1:MCP_PORT and spawn its accept loop on
/// the current tokio runtime. Returns once bound (bind errors propagate).
/// Cancelling `ct` shuts the server down and frees the port.
pub async fn serve(ct: CancellationToken) -> Result<(), String> {
    let service = StreamableHttpService::new(
        || Ok(MemexServer::new()),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default()
            .with_stateful_mode(true)
            // Loopback only + DNS-rebinding protection: a browser page can't set
            // an arbitrary Host and reach this, only a local process.
            .with_allowed_hosts([
                format!("127.0.0.1:{MCP_PORT}"),
                format!("localhost:{MCP_PORT}"),
                "127.0.0.1".to_string(),
                "localhost".to_string(),
            ])
            .with_cancellation_token(ct.clone()),
    );

    let router = axum::Router::new().nest_service("/mcp", service);
    let addr = format!("127.0.0.1:{MCP_PORT}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("bind {addr}: {e}"))?;

    tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move { ct.cancelled().await })
            .await;
    });
    Ok(())
}
