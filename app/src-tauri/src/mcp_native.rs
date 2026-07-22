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

use std::path::{Path, PathBuf};

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

use crate::{index, provenance, registry, settings, vault};

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

    /// Counts: wiki pages, raw sources, links, and page-type breakdown.
    #[tool(description = "Vault statistics: page/source counts, link totals, type breakdown")]
    async fn stats(
        &self,
        Parameters(a): Parameters<ProjectArg>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        let pages = collect_md(&wiki_dir(&root)).len();
        let raw_sources = collect_md(&raw_dir(&root)).len();
        let (mut links, mut unresolved) = (0usize, 0usize);
        let mut types: std::collections::BTreeMap<String, usize> = Default::default();
        if let Ok(adj) = index::build_link_graph(&root.to_string_lossy()) {
            links = adj.forward.values().map(|v| v.len()).sum();
            unresolved = adj.unresolved.values().map(|v| v.len()).sum();
            for m in adj.meta.values() {
                if let Some(t) = &m.node_type {
                    *types.entry(t.clone()).or_default() += 1;
                }
            }
        }
        json_result(json!({
            "ok": true, "pages": pages, "raw_sources": raw_sources,
            "links": links, "unresolved_links": unresolved, "types": types,
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

    /// Citation-trust report: per-source confidence tiers (from provenance).
    #[tool(description = "Provenance/trust report: which sources back each page and how")]
    async fn trust_report(
        &self,
        Parameters(a): Parameters<ProjectArg>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        match provenance::scan_provenance(&root.to_string_lossy()) {
            Ok(rows) => {
                let pages: Vec<Value> = rows
                    .into_iter()
                    .map(|r| {
                        json!({
                            "page": rel_to(&root, Path::new(&r.path)),
                            "cited": r.cited, "total": r.total,
                            "sources": r.sources.iter().map(|s| json!({
                                "slug": s.slug, "kind": s.kind, "title": s.title,
                                "resolved": s.resolved,
                            })).collect::<Vec<_>>(),
                        })
                    })
                    .collect();
                json_result(json!({ "ok": true, "count": pages.len(), "pages": pages }))
            }
            Err(e) => fail(e),
        }
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
