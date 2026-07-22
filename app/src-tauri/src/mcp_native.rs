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
use std::io::Write as _;
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
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::atomic::{AtomicBool, Ordering};
use tokio_util::sync::CancellationToken;

use crate::importers::secrets_scan;
use crate::{registry, settings, vault};

/// Fixed loopback port. Matches the documented `claude mcp add` URL.
pub const MCP_PORT: u16 = 22360;

pub fn mcp_url() -> String {
    format!("http://localhost:{MCP_PORT}/mcp")
}

// ─── auth token (persisted, so Connect is one-time) ──────────────────────────

/// Bearer token the server requires. Loopback bind + DNS-rebinding protection
/// already keep browsers out; the token stops any OTHER local process from
/// driving the write tools against the open vault. Persisted to app-data (the
/// user chose a one-time Connect over a per-launch rotating token), so a single
/// `claude mcp add` survives restarts.
fn load_or_create_token() -> String {
    let path = settings::settings_dir().ok().map(|d| d.join("mcp-token"));
    if let Some(p) = &path {
        if let Ok(t) = std::fs::read_to_string(p) {
            let t = t.trim().to_string();
            if !t.is_empty() {
                return t;
            }
        }
    }
    let tok = gen_token();
    if let Some(p) = &path {
        let _ = std::fs::write(p, &tok);
    }
    tok
}

fn gen_token() -> String {
    let mut buf = [0u8; 16];
    #[cfg(unix)]
    {
        use std::io::Read;
        if std::fs::File::open("/dev/urandom")
            .and_then(|mut f| f.read_exact(&mut buf))
            .is_ok()
        {
            return buf.iter().map(|b| format!("{b:02x}")).collect();
        }
    }
    // Fallback (non-unix / urandom failure): time+pid mix. Weak, but the threat
    // model is a same-user local process, and the token is persisted to a
    // user-readable file anyway — its job is binding a client, not deep secrecy.
    let n = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(1)
        ^ ((std::process::id() as u64) << 32);
    buf[..8].copy_from_slice(&n.to_le_bytes());
    buf[8..].copy_from_slice(&n.rotate_left(17).to_le_bytes());
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

fn token_ref() -> &'static str {
    static TOKEN: OnceLock<String> = OnceLock::new();
    TOKEN.get_or_init(load_or_create_token)
}

/// The current bearer token (minted+persisted on first use).
pub fn token() -> String {
    token_ref().to_string()
}

/// The one-line `claude mcp add` command (with the auth header) the UI shows.
pub fn connect_command() -> String {
    format!(
        "claude mcp add --transport http memex {} --header \"Authorization: Bearer {}\"",
        mcp_url(),
        token()
    )
}

/// The claude_desktop_config.json snippet (a URL connector with the header).
pub fn desktop_json() -> String {
    format!(
        "{{\n  \"mcpServers\": {{\n    \"memex\": {{\n      \"url\": \"{}\",\n      \"headers\": {{ \"Authorization\": \"Bearer {}\" }}\n    }}\n  }}\n}}",
        mcp_url(),
        token()
    )
}

static RUNNING: AtomicBool = AtomicBool::new(false);

/// Whether the in-process server is currently bound and listening.
pub fn is_running() -> bool {
    RUNNING.load(Ordering::Relaxed)
}

/// What the Settings panel needs: the server is always running (no install),
/// the connect command, and the desktop-config snippet.
#[derive(Debug, Clone, Serialize)]
pub struct NativeInfo {
    pub running: bool,
    pub url: String,
    pub command: String,
    pub desktop_json: String,
}

pub fn info() -> NativeInfo {
    NativeInfo {
        running: is_running(),
        url: mcp_url(),
        command: connect_command(),
        desktop_json: desktop_json(),
    }
}

/// One-click Connect: register (or re-register) memex with Claude Code over the
/// HTTP transport, WITH the auth header (the old SSE button omitted it). A
/// best-effort remove first so a re-Connect never collides with a stale entry.
pub fn register() -> Result<String, String> {
    let url = mcp_url();
    let claude = crate::claude::locate_bin("claude", "MEMEX_CLAUDE_PATH")
        .ok_or("claude CLI not found on PATH")?;
    let path = crate::claude::augmented_path(&claude);
    let _ = std::process::Command::new(&claude)
        .args(["mcp", "remove", "memex"])
        .env("PATH", &path)
        .output();
    let out = std::process::Command::new(&claude)
        .args([
            "mcp",
            "add",
            "--transport",
            "http",
            "memex",
            &url,
            "--header",
            &format!("Authorization: Bearer {}", token()),
        ])
        .env("PATH", &path)
        .output()
        .map_err(|e| format!("spawn claude failed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "claude mcp add failed:\n{}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(format!("Connected memex over HTTP at {url}"))
}

/// Constant-time byte comparison (no early return on mismatch).
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Reject any request without a valid `Authorization: Bearer <token>`.
async fn require_bearer(
    axum::extract::State(token): axum::extract::State<std::sync::Arc<String>>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let ok = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .map(|got| ct_eq(got.as_bytes(), token.as_bytes()))
        .unwrap_or(false);
    if ok {
        next.run(req).await
    } else {
        axum::http::StatusCode::UNAUTHORIZED.into_response()
    }
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

/// Python `str.capitalize()`: first char upper, the rest lower.
fn capitalize(s: &str) -> String {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase(),
        None => String::new(),
    }
}

/// Nearest ancestor (inclusive) that contains a `.git` directory.
fn find_git_root(start: &Path) -> Option<PathBuf> {
    let start = start.canonicalize().ok()?;
    let mut cur: Option<&Path> = Some(&start);
    while let Some(d) = cur {
        if d.join(".git").is_dir() {
            return Some(d.to_path_buf());
        }
        cur = d.parent();
    }
    None
}

/// Every file under `dir`, recursively (absolute paths, sorted). Empty if absent.
fn walk_all(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    fn rec(d: &Path, out: &mut Vec<PathBuf>) {
        let Ok(rd) = std::fs::read_dir(d) else { return };
        let mut entries: Vec<_> = rd.flatten().map(|e| e.path()).collect();
        entries.sort();
        for p in entries {
            if p.is_dir() {
                rec(&p, out);
            } else if p.is_file() {
                out.push(p);
            }
        }
    }
    rec(dir, &mut out);
    out
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

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct CreatePageArgs {
    /// Page title (used to derive the slug).
    title: String,
    /// One of concept/entity/technique/source-summary/analysis, or a custom type.
    page_type: String,
    /// Body markdown (without frontmatter). Include inline [^src-*] citations.
    #[serde(default)]
    content: String,
    /// Optional subfolder under wiki/.
    #[serde(default)]
    folder: String,
    /// Optional tag list.
    #[serde(default)]
    tags: Vec<String>,
    /// Optional source slugs (without the "src-" prefix).
    #[serde(default)]
    sources: Vec<String>,
    #[serde(default)]
    project: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct UpdatePageArgs {
    /// wiki-relative filename to overwrite. Keep the frontmatter block.
    filename: String,
    /// The full new content (frontmatter + body).
    content: String,
    #[serde(default)]
    project: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct AddRawArgs {
    /// New raw/ filename (may include a subfolder), e.g. "papers/attention.md".
    filename: String,
    /// Source content (immutable once written).
    content: String,
    #[serde(default)]
    project: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct CreateFolderArgs {
    /// New folder name.
    name: String,
    /// Optional parent under wiki/.
    #[serde(default)]
    parent: String,
    #[serde(default)]
    project: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct AppendChangelogArgs {
    /// The changelog entry text.
    entry: String,
    /// Section: Added / Changed / Fixed / Removed (default Changed).
    #[serde(default)]
    section: String,
    #[serde(default)]
    project: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct GitCommitArgs {
    /// Commit message (Conventional Commit style, e.g. "ingest: attention…").
    message: String,
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

    // ─── writers ─────────────────────────────────────────────────────────────

    /// Create a new wiki page with proper Memex frontmatter.
    #[tool(description = "Create a wiki page with Memex frontmatter (title/type/tags/sources)")]
    async fn create_page(
        &self,
        Parameters(a): Parameters<CreatePageArgs>,
    ) -> Result<CallToolResult, McpError> {
        if a.title.trim().is_empty() {
            return fail("title required");
        }
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        let wiki = wiki_dir(&root);
        let _ = std::fs::create_dir_all(&wiki);
        let slug = make_slug(&a.title);
        let Some(base) = safe_join(&wiki, &a.folder) else {
            return fail(format!("folder escapes wiki/: {}", a.folder));
        };
        let _ = std::fs::create_dir_all(&base);
        let mut target = base.join(format!("{slug}.md"));
        let mut n = 2;
        while target.exists() {
            target = base.join(format!("{slug}-{n}.md"));
            n += 1;
        }
        let today = registry::today_utc();
        let mut parts: Vec<String> = vec![
            "---".into(),
            format!("title: \"{}\"", a.title),
            format!("type: {}", a.page_type),
            format!("created: {today}"),
            format!("last_updated: {today}"),
            format!("source_count: {}", a.sources.len()),
            "confidence: medium".into(),
            "status: active".into(),
        ];
        if a.tags.is_empty() {
            parts.push("tags: []".into());
        } else {
            parts.push("tags:".into());
            parts.push(a.tags.iter().map(|t| format!("  - {t}")).collect::<Vec<_>>().join("\n"));
        }
        if !a.sources.is_empty() {
            parts.push("sources:".into());
            parts.push(a.sources.iter().map(|s| format!("  - {s}")).collect::<Vec<_>>().join("\n"));
        }
        parts.push("---\n".into());
        let body = if a.content.is_empty() {
            format!("# {}\n\n<!-- TODO: add content with inline [^src-*] citations -->", a.title)
        } else {
            a.content.clone()
        };
        let full = format!("{}\n{}\n", parts.join("\n"), body);
        if let Err(e) = vault::write_file(&target.to_string_lossy(), &full) {
            return fail(e);
        }
        json_result(json!({
            "ok": true, "filename": rel_to(&wiki, &target), "path": rel_to(&root, &target),
        }))
    }

    /// Overwrite a wiki page's content (caller keeps the frontmatter block).
    #[tool(description = "Overwrite a wiki page's full content by filename")]
    async fn update_page(
        &self,
        Parameters(a): Parameters<UpdatePageArgs>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        let Some(target) = safe_join(&wiki_dir(&root), &a.filename) else {
            return fail(format!("path escapes wiki/: {}", a.filename));
        };
        if !target.is_file() {
            return fail(format!("page not found: {}", a.filename));
        }
        if let Err(e) = vault::write_file(&target.to_string_lossy(), &a.content) {
            return fail(e);
        }
        json_result(json!({ "ok": true, "filename": rel_to(&wiki_dir(&root), &target) }))
    }

    /// Add a new immutable source file to raw/ (never overwrites).
    #[tool(description = "Add a new immutable raw/ source file (append-only)")]
    async fn add_raw_source(
        &self,
        Parameters(a): Parameters<AddRawArgs>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        let raw = raw_dir(&root);
        let _ = std::fs::create_dir_all(&raw);
        let Some(target) = safe_join(&raw, &a.filename) else {
            return fail(format!("path escapes raw/: {}", a.filename));
        };
        if target.exists() {
            return fail(format!("raw/ file exists (immutable): {}", a.filename));
        }
        if let Some(p) = target.parent() {
            let _ = std::fs::create_dir_all(p);
        }
        if let Err(e) = vault::write_file(&target.to_string_lossy(), &a.content) {
            return fail(e);
        }
        let stem = target.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let mut out = json!({
            "ok": true, "raw_path": rel_to(&root, &target), "src_slug": format!("src-{stem}"),
        });
        let hits = secrets_scan::scan(&a.content);
        if !hits.is_empty() {
            out["secret_warning"] = json!(format!(
                "possible secrets detected: {} — raw/ is immutable and committed to git; \
                 redact and re-add if unintended.",
                hits.join(", ")
            ));
        }
        json_result(out)
    }

    /// Create a folder under wiki/ (or wiki/<parent>/).
    #[tool(description = "Create a folder under wiki/")]
    async fn create_folder(
        &self,
        Parameters(a): Parameters<CreateFolderArgs>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        let wiki = wiki_dir(&root);
        let _ = std::fs::create_dir_all(&wiki);
        let base = if a.parent.is_empty() {
            wiki.clone()
        } else {
            match safe_join(&wiki, &a.parent) {
                Some(p) => p,
                None => return fail(format!("parent escapes wiki/: {}", a.parent)),
            }
        };
        let Some(target) = safe_join(&base, &a.name) else {
            return fail(format!("name escapes parent: {}", a.name));
        };
        if let Err(e) = std::fs::create_dir_all(&target) {
            return fail(format!("mkdir failed: {e}"));
        }
        json_result(json!({ "ok": true, "path": rel_to(&wiki, &target) }))
    }

    /// Archive a processed _inbox/ source: copy into a new raw/<slug>.md, then
    /// move the original into _inbox/.archived/.
    #[tool(description = "Archive an ingested inbox source: copy to raw/ then move it out")]
    async fn archive_inbox_source(
        &self,
        Parameters(a): Parameters<InboxSourceArgs>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        let Some(src) = safe_join(&inbox_dir(&root), &a.filename) else {
            return fail(format!("path escapes _inbox/: {}", a.filename));
        };
        if !src.is_file() {
            return fail(format!("not found in inbox: {}", a.filename));
        }
        let raw = raw_dir(&root);
        let _ = std::fs::create_dir_all(&raw);
        let content = std::fs::read_to_string(&src).unwrap_or_default();
        let stem = src.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let slug = make_slug(&stem);
        let mut raw_path = raw.join(format!("{slug}.md"));
        let mut n = 2;
        while raw_path.exists() {
            raw_path = raw.join(format!("{slug}-{n}.md"));
            n += 1;
        }
        if let Err(e) = vault::write_file(&raw_path.to_string_lossy(), &content) {
            return fail(e);
        }
        // Move the original out of the inbox so it is not re-ingested.
        let archive = src.parent().map(|p| p.join(".archived")).unwrap_or_default();
        let _ = std::fs::create_dir_all(&archive);
        let ext = src.extension().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let mut dest = archive.join(src.file_name().unwrap_or_default());
        let mut m = 2;
        while dest.exists() {
            dest = archive.join(if ext.is_empty() {
                format!("{stem}-{m}")
            } else {
                format!("{stem}-{m}.{ext}")
            });
            m += 1;
        }
        if let Err(e) = std::fs::rename(&src, &dest) {
            return fail(format!("archive move failed: {e}"));
        }
        let raw_stem = raw_path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        json_result(json!({
            "ok": true, "raw_path": rel_to(&root, &raw_path),
            "archived": dest.file_name().map(|s| s.to_string_lossy().to_string()),
            "src_slug": format!("src-{raw_stem}"),
        }))
    }

    /// Append an entry under CHANGELOG.md's `## [Unreleased]` → `### <section>`.
    #[tool(description = "Append a CHANGELOG.md entry (Keep a Changelog, Unreleased section)")]
    async fn append_changelog(
        &self,
        Parameters(a): Parameters<AppendChangelogArgs>,
    ) -> Result<CallToolResult, McpError> {
        if a.entry.trim().is_empty() {
            return fail("entry required");
        }
        let section = if a.section.trim().is_empty() { "Changed" } else { a.section.trim() };
        let sec = capitalize(section);
        if !["Added", "Changed", "Fixed", "Removed"].contains(&sec.as_str()) {
            return fail(format!("invalid section: {}", a.section));
        }
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        let _ = std::fs::create_dir_all(&root);
        let path = root.join("CHANGELOG.md");
        if !path.exists() {
            let seed = "# Changelog\n\nAll notable changes to this wiki are recorded here \
                        (Keep a Changelog format).\n\n## [Unreleased]\n";
            if let Err(e) = vault::write_file(&path.to_string_lossy(), seed) {
                return fail(e);
            }
        }
        let mut text = std::fs::read_to_string(&path).unwrap_or_default();
        if !text.contains("## [Unreleased]") {
            text = format!("{}\n\n## [Unreleased]\n", text.trim_end());
        }
        let mut lines: Vec<String> = text.lines().map(|s| s.to_string()).collect();
        let ur = lines.iter().position(|l| l.starts_with("## [Unreleased]")).unwrap_or(0);
        let nxt = (ur + 1..lines.len())
            .find(|&i| lines[i].starts_with("## "))
            .unwrap_or(lines.len());
        let hdr = format!("### {sec}");
        let block_hdr = (ur + 1..nxt).find(|&i| lines[i] == hdr);
        if let Some(hi) = block_hdr {
            lines.insert(hi + 1, format!("- {}", a.entry.trim()));
        } else {
            for (k, s) in ["".to_string(), hdr, format!("- {}", a.entry.trim())].into_iter().enumerate() {
                lines.insert(nxt + k, s);
            }
        }
        let joined = format!("{}\n", lines.join("\n").trim_end());
        if let Err(e) = vault::write_file(&path.to_string_lossy(), &joined) {
            return fail(e);
        }
        json_result(json!({ "ok": true, "changelog": rel_to(&root, &path), "section": sec }))
    }

    /// Scaffold the project as its own standalone Obsidian vault (.obsidian/).
    #[tool(description = "Make the project openable as its own Obsidian vault")]
    async fn register_vault(
        &self,
        Parameters(a): Parameters<ProjectArg>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        match vault::scaffold_obsidian_vault(&root) {
            Ok(obs) => json_result(json!({
                "ok": true, "obsidian_dir": rel_to(&root, Path::new(&obs)), "open_as": root.to_string_lossy(),
            })),
            Err(e) => fail(e),
        }
    }

    /// Zip a project's vault (wiki/, raw/, reports, CLAUDE.md, CHANGELOG.md,
    /// settings) into a backup archive.
    #[tool(description = "Export the project vault to a .zip backup")]
    async fn export_project(
        &self,
        Parameters(a): Parameters<ProjectArg>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        if !root.exists() {
            return fail("project root missing");
        }
        // Backups live beside the registry's projects/ dir when there is one,
        // else under the vault itself.
        let backups = settings::active_vault()
            .map(PathBuf::from)
            .and_then(|p| registry::Registry::discover(&p))
            .map(|r| r.projects_dir.join(".backups"))
            .unwrap_or_else(|| root.join(".backups"));
        let _ = std::fs::create_dir_all(&backups);
        let base = root.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "vault".into());
        let mut dest = backups.join(format!("{base}.zip"));
        let mut n = 2;
        while dest.exists() {
            dest = backups.join(format!("{base}-{n}.zip"));
            n += 1;
        }
        let file = match std::fs::File::create(&dest) {
            Ok(f) => f,
            Err(e) => return fail(format!("create zip: {e}")),
        };
        let mut zw = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        let mut count = 0usize;
        for sub in ["wiki", "raw", "ingest-reports", "reflect-reports"] {
            for f in walk_all(&root.join(sub)) {
                let arc = rel_to(&root, &f);
                if zw.start_file(arc, opts).is_ok() {
                    if let Ok(bytes) = std::fs::read(&f) {
                        let _ = zw.write_all(&bytes);
                        count += 1;
                    }
                }
            }
        }
        for fname in ["CLAUDE.md", "CHANGELOG.md", ".settings.json"] {
            let f = root.join(fname);
            if f.is_file() && zw.start_file(fname, opts).is_ok() {
                if let Ok(bytes) = std::fs::read(&f) {
                    let _ = zw.write_all(&bytes);
                    count += 1;
                }
            }
        }
        if let Err(e) = zw.finish() {
            return fail(format!("finish zip: {e}"));
        }
        json_result(json!({
            "ok": true, "archive": rel_to(&root, &dest), "files": count,
        }))
    }

    /// Stage the project's wiki/, raw/, reports (+ project metadata) and commit.
    #[tool(description = "git add the project's wiki/raw/reports and commit with a message")]
    async fn git_commit(
        &self,
        Parameters(a): Parameters<GitCommitArgs>,
    ) -> Result<CallToolResult, McpError> {
        if a.message.trim().is_empty() {
            return fail("message required");
        }
        let vault = match resolve_root(&a.project) {
            Ok(r) => r.canonicalize().unwrap_or(r),
            Err(e) => return fail(e),
        };
        // Repo root: the registry root (holds projects.json), else the nearest
        // .git ancestor, else the vault itself.
        let repo_root = registry::Registry::discover(&vault)
            .map(|r| r.project_root)
            .or_else(|| find_git_root(&vault))
            .unwrap_or_else(|| vault.clone());
        if !repo_root.join(".git").is_dir() {
            return fail("repository is not a git repo");
        }
        // A whole-repo (legacy) vault keeps wiki/raw at the root; a project vault
        // lives under projects/<slug>/ and also carries its own metadata files.
        let rel = vault
            .strip_prefix(&repo_root)
            .ok()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let paths: Vec<String> = if rel.is_empty() {
            vec!["wiki".into(), "raw".into(), "ingest-reports".into()]
        } else {
            vec![
                format!("{rel}/wiki"),
                format!("{rel}/raw"),
                format!("{rel}/ingest-reports"),
                format!("{rel}/CLAUDE.md"),
                format!("{rel}/CHANGELOG.md"),
                format!("{rel}/.settings.json"),
                "projects.json".into(),
            ]
        };
        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .args(args)
                .current_dir(&repo_root)
                .output()
        };
        for p in &paths {
            if !repo_root.join(p).exists() {
                continue;
            }
            match git(&["add", p]) {
                Ok(o) if !o.status.success() => {
                    let msg = if o.stderr.is_empty() { &o.stdout } else { &o.stderr };
                    let msg: String = String::from_utf8_lossy(msg).trim().chars().take(500).collect();
                    return fail(format!("git add failed for {p}: {msg}"));
                }
                Err(e) => return fail(format!("git add failed for {p}: {e}")),
                _ => {}
            }
        }
        let files: Vec<String> = match git(&["diff", "--cached", "--name-only"]) {
            Ok(o) => String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter(|l| !l.is_empty())
                .map(|s| s.to_string())
                .collect(),
            Err(e) => return fail(format!("git diff failed: {e}")),
        };
        if files.is_empty() {
            return json_result(json!({ "ok": true, "no_op": true, "files": [] }));
        }
        match git(&["commit", "-m", &a.message]) {
            Ok(o) if !o.status.success() => {
                let msg = if o.stderr.is_empty() { &o.stdout } else { &o.stderr };
                let msg: String = String::from_utf8_lossy(msg).trim().chars().take(500).collect();
                return fail(msg);
            }
            Err(e) => return fail(format!("git commit failed: {e}")),
            _ => {}
        }
        let hash = git(&["log", "-1", "--format=%H"])
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        json_result(json!({ "ok": true, "hash": hash, "files": files }))
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

    let router = axum::Router::new().nest_service("/mcp", service).layer(
        axum::middleware::from_fn_with_state(
            std::sync::Arc::new(token_ref().to_string()),
            require_bearer,
        ),
    );
    let addr = format!("127.0.0.1:{MCP_PORT}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("bind {addr}: {e}"))?;

    RUNNING.store(true, Ordering::Relaxed);
    tokio::spawn(async move {
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move { ct.cancelled().await })
            .await;
        RUNNING.store(false, Ordering::Relaxed);
    });
    Ok(())
}
