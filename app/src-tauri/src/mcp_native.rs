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
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, ContentBlock},
    schemars, tool, tool_handler, tool_router,
    transport::streamable_http_server::{
        session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
    },
    ErrorData as McpError, ServerHandler,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager as _;
use tokio_util::sync::CancellationToken;

use crate::importers::secrets_scan;
use crate::retrieval::{Scope, TierWeights};
use crate::{commands, registry, settings, vault};

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

/// The name this server is registered under in the user's `~/.claude.json`.
pub const SERVER_NAME: &str = "myco";

/// The name used before the myco rename. Only ever passed to `mcp remove`, so
/// an upgrading user does not keep a duplicate registration of the same server.
const LEGACY_SERVER_NAME: &str = "memex";

/// The current bearer token (minted+persisted on first use).
pub fn token() -> String {
    token_ref().to_string()
}

/// The one-line `claude mcp add` command (with the auth header) the UI shows.
pub fn connect_command() -> String {
    format!(
        "claude mcp add --transport http myco {} --header \"Authorization: Bearer {}\"",
        mcp_url(),
        token()
    )
}

/// The claude_desktop_config.json snippet (a URL connector with the header).
pub fn desktop_json() -> String {
    format!(
        "{{\n  \"mcpServers\": {{\n    \"myco\": {{\n      \"url\": \"{}\",\n      \"headers\": {{ \"Authorization\": \"Bearer {}\" }}\n    }}\n  }}\n}}",
        mcp_url(),
        token()
    )
}

static RUNNING: AtomicBool = AtomicBool::new(false);

/// Whether the in-process server is currently bound and listening.
pub fn is_running() -> bool {
    RUNNING.load(Ordering::Relaxed)
}

// ─── tool-call log (inflow stats) ────────────────────────────────────────────

/// In-memory tool-call log: (epoch secs, tool name). Process-lifetime only —
/// the UI labels the derived count "since app launch", never persisted-today.
/// Readers filter by their own local-midnight cutoff; writes prune anything
/// older than 48h so a resident app can't grow it unbounded.
static TOOL_CALLS: std::sync::Mutex<Vec<(u64, String)>> = std::sync::Mutex::new(Vec::new());

const TOOL_CALL_RETENTION_SECS: u64 = 48 * 3600;

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn record_tool_call_at(log: &mut Vec<(u64, String)>, now: u64, name: &str) {
    log.retain(|(t, _)| now.saturating_sub(*t) < TOOL_CALL_RETENTION_SECS);
    log.push((now, name.to_string()));
}

fn record_tool_call(name: &str) {
    record_tool_call_at(&mut TOOL_CALLS.lock().unwrap(), now_secs(), name);
}

/// Snapshot of the tool-call log for `inflow_stats`.
pub(crate) fn tool_calls_snapshot() -> Vec<(u64, String)> {
    TOOL_CALLS.lock().unwrap().clone()
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

/// One-click Connect: register (or re-register) myco with Claude Code over the
/// HTTP transport, WITH the auth header (the old SSE button omitted it). A
/// best-effort remove first so a re-Connect never collides with a stale entry.
///
/// The removal covers the pre-rename name too: a user who connected before the
/// rebrand has a `memex` entry in `~/.claude.json` pointing at this same port,
/// and leaving it there gives Claude Code two registrations of one server.
pub fn register() -> Result<String, String> {
    let url = mcp_url();
    let claude = crate::claude::locate_bin("claude", "MYCO_CLAUDE_PATH")
        .ok_or("claude CLI not found on PATH")?;
    let path = crate::claude::augmented_path(&claude);
    for name in [SERVER_NAME, LEGACY_SERVER_NAME] {
        let _ = std::process::Command::new(&claude)
            .args(["mcp", "remove", name])
            .env("PATH", &path)
            .output();
    }
    let out = std::process::Command::new(&claude)
        .args([
            "mcp",
            "add",
            "--transport",
            "http",
            SERVER_NAME,
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
    Ok(format!("Connected {SERVER_NAME} over HTTP at {url}"))
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
fn parse_task_status(s: &str) -> Option<crate::tasks::TaskStatus> {
    use crate::tasks::TaskStatus::*;
    match s.trim().to_lowercase().as_str() {
        "todo" => Some(Todo),
        "doing" => Some(Doing),
        "blocked" => Some(Blocked),
        "done" => Some(Done),
        _ => None,
    }
}

/// A vault-relative task page, confined to the vault and kept out of the
/// folders that are not the user's own task list: `raw/` is immutable, and
/// `_inbox/` / `sessions/` are skipped by the scanner, so a line number there
/// could never have come from list_tasks.
fn task_page_path(root: &Path, page: &str) -> Result<PathBuf, String> {
    let first = Path::new(page)
        .components()
        .next()
        .and_then(|c| c.as_os_str().to_str())
        .unwrap_or("");
    if matches!(first, "raw" | "_inbox" | "sessions") {
        return Err(format!("tasks cannot be edited under {first}/"));
    }
    let Some(target) = safe_join(root, page) else {
        return Err(format!("path escapes the vault: {page}"));
    };
    if !target.is_file() {
        return Err(format!("page not found: {page}"));
    }
    Ok(target)
}

/// A wiki-relative page that must already exist, confined to wiki/. The
/// not-found text names the next call to make instead of the host path the
/// filesystem error would have carried.
fn wiki_page_path(root: &Path, filename: &str) -> Result<PathBuf, String> {
    let Some(abs) = safe_join(&wiki_dir(root), filename) else {
        return Err(format!("path escapes wiki/: {filename}"));
    };
    if !abs.is_file() {
        return Err(format!(
            "page not found: {filename} — call list_pages or search to find the right filename"
        ));
    }
    Ok(abs)
}

/// `list_pages` body: every wiki page (optionally under `folder`, of
/// `type_filter`) as a frontmatter summary, cut to `limit` rows. 100 pages
/// measured 16.9 KB of output, so `truncated` tells the caller when the cut
/// hid something rather than letting a big vault look small.
fn list_wiki_pages(
    root: &Path,
    folder: &str,
    type_filter: &str,
    limit: usize,
) -> Result<Value, String> {
    let wiki = wiki_dir(root);
    let scope = if folder.is_empty() {
        wiki.clone()
    } else {
        safe_join(&wiki, folder).ok_or_else(|| format!("folder escapes wiki/: {folder}"))?
    };
    let mut pages = Vec::new();
    for abs in collect_md(&scope) {
        let Ok(fc) = vault::read_file(&abs.to_string_lossy()) else {
            continue;
        };
        let ptype = fm_str(&fc.frontmatter, "type");
        if !type_filter.is_empty() && ptype != type_filter {
            continue;
        }
        pages.push(json!({
            "filename": rel_to(&wiki, &abs),
            "title": fm_str(&fc.frontmatter, "title"),
            "type": ptype,
            "tags": fc.frontmatter.get("tags").cloned().unwrap_or(json!([])),
        }));
    }
    let limit = limit.max(1);
    let truncated = pages.len() > limit;
    pages.truncate(limit);
    Ok(json!({ "ok": true, "count": pages.len(), "truncated": truncated, "pages": pages }))
}

/// `read_page` body: frontmatter, body, the body's outbound `[[links]]`
/// (`.md`-normalized, deduplicated) and word count.
fn read_wiki_page(root: &Path, filename: &str) -> Result<Value, String> {
    let abs = wiki_page_path(root, filename)?;
    let fc = vault::read_file(&abs.to_string_lossy())?;
    Ok(json!({
        "ok": true,
        "filename": filename,
        "frontmatter": fc.frontmatter,
        "content": fc.content,
        "links": extract_links(&fc.content),
        "word_count": fc.content.split_whitespace().count(),
    }))
}

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
pub(crate) fn collect_md(dir: &Path) -> Vec<PathBuf> {
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

pub(crate) fn rel_to(base: &Path, abs: &Path) -> String {
    abs.strip_prefix(base)
        .unwrap_or(abs)
        .to_string_lossy()
        .to_string()
}

fn fm_str(fm: &Value, key: &str) -> String {
    fm.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

pub(crate) fn fm_opt(fm: &Value, key: &str) -> Option<String> {
    fm.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// (frontmatter, body) for a page, via the vault's frontmatter parser.
pub(crate) fn read_parts(abs: &Path) -> Option<(Value, String)> {
    vault::read_file(&abs.to_string_lossy())
        .ok()
        .map(|fc| (fc.frontmatter, fc.content))
}

// ─── ported wiki-schema logic (mirrors the Python server, regex parity) ───────

// Mirrors `local_llm::WIKI_TYPES` and the Python `VALID_TYPES` — `"map"`
// (Phase B, Task 4) added there too, so a `wiki/maps/` topic-map page lints
// clean everywhere instead of only in one of the three copies.
const VALID_TYPES: [&str; 6] = [
    "concept",
    "technique",
    "entity",
    "source-summary",
    "analysis",
    "map",
];
pub(crate) const LINT_META_TYPES: [&str; 2] = ["overview", "meta"];
pub(crate) const LINT_SKIP_NAMES: [&str; 2] = ["index.md", "log.md"];

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
        if body[whole.end()..].starts_with(':') {
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
    let re = RE.get_or_init(|| {
        Regex::new(r"\[\[([a-z0-9][\w-]*?)::([^\]|]+?)(?:\|[^\]]*?)?\]\]").unwrap()
    });
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
pub(crate) fn lint_page(fm: &Value, body: &str) -> Vec<String> {
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
pub(crate) fn source_trust(stype: &str) -> f64 {
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

pub(crate) fn suggest_confidence(stype: Option<&str>, cites: usize) -> &'static str {
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

#[derive(Clone, Debug, serde::Serialize)]
pub struct SuspectPage {
    pub page: String,
    pub reasons: Vec<String>,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct SuspectReport {
    pub pages_checked: usize,
    pub suspects: Vec<SuspectPage>,
}

/// Pure scan behind both the MCP trust/lint tools and the app's
/// Morning-Report suspect card (Q4 item 2). `wiki` is the wiki dir.
pub(crate) fn suspect_scan(wiki: &Path) -> SuspectReport {
    // list_files canonicalizes (`/var` -> `/private/var` on macOS); match it so
    // rel_to can strip the base.
    let wiki = &wiki.canonicalize().unwrap_or_else(|_| wiki.to_path_buf());
    let mut checked = 0usize;
    let mut suspects = Vec::new();
    for abs in collect_md(wiki) {
        let name = abs
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        if LINT_SKIP_NAMES.contains(&name.as_str()) {
            continue;
        }
        let Some((fm, body)) = read_parts(&abs) else {
            continue;
        };
        if fm_opt(&fm, "type")
            .map(|t| LINT_META_TYPES.contains(&t.as_str()))
            .unwrap_or(false)
        {
            continue;
        }
        checked += 1;
        let mut reasons = lint_page(&fm, &body);
        let stype = fm_opt(&fm, "source_type");
        let cites = footnote_refs(&body).len();
        let declared = fm_opt(&fm, "confidence");
        let suggested = suggest_confidence(stype.as_deref(), cites);
        if let Some(d) = &declared {
            if d != suggested {
                reasons.push(format!("confidence: declared {d}, suggested {suggested}"));
            }
        }
        if !reasons.is_empty() {
            suspects.push(SuspectPage {
                page: rel_to(wiki, &abs),
                reasons,
            });
        }
    }
    SuspectReport {
        pages_checked: checked,
        suspects,
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
pub struct McpServer {
    /// The app, for the managed retrieval state: `search` runs the same
    /// embedder and indexes the Ask page does.
    app: tauri::AppHandle,
    // Read by the hand-written call_tool below and by the #[tool_handler]
    // macro's generated list_tools.
    tool_router: ToolRouter<McpServer>,
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
    /// Max pages returned (default 200); `truncated` says whether more exist.
    #[serde(default)]
    limit: Option<usize>,
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
    /// Question or keywords; a "quoted phrase" must appear verbatim in the hit.
    query: String,
    /// Max hits (1-50, default 20).
    #[serde(default)]
    top_k: Option<usize>,
    /// Indexed tier to rank: "wiki" (default: notes, maps and the
    /// daily/weekly/monthly digests), "sessions" (transcripts only), or
    /// "all". raw/ is never indexed.
    #[serde(default)]
    scope: Option<String>,
    /// Search across ALL projects instead of just one (hits grouped per project).
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
struct ListTasksArgs {
    /// Only tasks whose text links this project page, e.g. "myco-q4-roadmap"
    /// (matched as `[[project]]`).
    #[serde(default)]
    project: String,
    /// Only tasks carrying this category tag, e.g. "dev" (matched as `#dev`).
    #[serde(default)]
    tag: String,
    /// Only this status: todo | doing | blocked | done.
    #[serde(default)]
    status: String,
    /// Only tasks whose page path starts with this, e.g. "wiki/roadmaps/".
    #[serde(default)]
    path_prefix: String,
    #[serde(default)]
    vault_project: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct SetTaskStatusArgs {
    /// Vault-relative page path, e.g. "wiki/roadmaps/q4.md" (from list_tasks).
    page: String,
    /// 1-based line number (from list_tasks).
    line: u32,
    /// todo | doing | blocked | done.
    status: String,
    /// The task text as last read — the stale guard: if the line no longer
    /// says this, nothing is written and the current text is returned.
    expect_text: String,
    #[serde(default)]
    vault_project: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct AddTaskArgs {
    /// Vault-relative page to append to, e.g. "wiki/roadmaps/q4.md" or
    /// "daily/2026-08-25.md". Must exist; raw/, _inbox/ and sessions/ refuse.
    page: String,
    /// Task text; categories (`#dev`) and project links (`[[page]]`) ride
    /// inside it as plain text.
    text: String,
    /// Optional due date `YYYY-MM-DD` — written as `📅 <due>`.
    #[serde(default)]
    due: String,
    #[serde(default)]
    vault_project: String,
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

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ImportConversationArgs {
    /// The transcript as text — paste it, do not describe it.
    raw_text: String,
    /// Short source slug: chatgpt | claude | claude-code | codex, or another
    /// lowercase slug.
    source: String,
    #[serde(default)]
    title: String,
    /// Keeps re-imports idempotent; omitted = a hash of the text.
    #[serde(default)]
    conversation_id: String,
    /// `YYYY-MM-DD` the conversation happened; omitted = today.
    #[serde(default)]
    created: String,
    #[serde(default)]
    project: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct ImportSessionArgs {
    /// A session file on this machine, e.g. ~/.claude/projects/**/*.jsonl or
    /// ~/.codex/sessions/**/*.jsonl.
    jsonl_path: String,
    /// "sessions" (default: the searchable archive) or "_inbox" (queued for
    /// the next ingest pass).
    #[serde(default)]
    dest: String,
    #[serde(default)]
    project: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct WikifyPendingArgs {
    /// Items to return (1-10, default 3).
    #[serde(default)]
    limit: Option<usize>,
    /// Keys (`<source>:<conversation_id>`) whose pages are written — checked off.
    #[serde(default)]
    done: Vec<String>,
    #[serde(default)]
    project: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
struct SetupProfileArgs {
    #[serde(default)]
    role: String,
    #[serde(default)]
    goals: Vec<String>,
    #[serde(default)]
    interests: Vec<String>,
    /// How the owner likes answers — depth, format, tone.
    #[serde(default)]
    style: String,
    #[serde(default)]
    project: String,
}

#[tool_router]
impl McpServer {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self {
            app,
            tool_router: Self::tool_router(),
        }
    }

    /// List all myco projects plus the active slug. Use a slug as `project` in
    /// other tools, or pass "" for the active one.
    #[tool(description = "List all myco projects and the active project slug")]
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
    #[tool(description = "Get the myco wiki authoring instructions (CLAUDE.md) for a project")]
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
    #[tool(
        description = "List wiki pages with title/type/tags; optional folder or type filter; limit (default 200) with a truncated flag"
    )]
    async fn list_pages(
        &self,
        Parameters(a): Parameters<ListPagesArgs>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        match list_wiki_pages(&root, &a.folder, &a.type_filter, a.limit.unwrap_or(200)) {
            Ok(out) => json_result(out),
            Err(e) => fail(e),
        }
    }

    /// Read one wiki page: frontmatter, body, outbound links, and word count.
    #[tool(
        description = "Read a wiki page's frontmatter, body and outbound [[links]] by wiki-relative filename"
    )]
    async fn read_page(
        &self,
        Parameters(a): Parameters<ReadPageArgs>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        match read_wiki_page(&root, &a.filename) {
            Ok(out) => json_result(out),
            Err(e) => fail(e),
        }
    }

    /// Hybrid retrieval — the same dense + BM25 fusion the app's Ask page runs.
    #[tool(
        description = "Rank vault pages for a question or keywords with the app's hybrid retrieval (local embeddings + BM25, fused by reciprocal rank, then weighted by tier: note 1.0 > map 0.9 > digest/rollup 0.8 > session 0.6) — paraphrases match, not only exact words. scope: wiki (default: notes, maps, daily/weekly/monthly digests) | sessions (transcripts only) | all (raw/ is never indexed). Each hit carries rank, tier, score_bm25 and score_vec (dense cosine). The order is rank-fused and NOT a confidence: judge relevance by score_vec (on the eval corpus, real answers scored >= 0.54 and off-topic hits <= 0.49). When the embedding index is absent or stale the result is BM25-only and `note` says so."
    )]
    async fn search(
        &self,
        Parameters(a): Parameters<SearchArgs>,
    ) -> Result<CallToolResult, McpError> {
        let k = a.top_k.unwrap_or(20).clamp(1, 50);
        let scope: Scope = match a.scope.as_deref().unwrap_or("wiki").parse() {
            Ok(s) => s,
            Err(e) => return fail(e),
        };
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
        let mut note = None;
        for (slug, root) in roots {
            let found = match self.hybrid(&root, &a.query, k, scope).await {
                Ok(f) => f,
                Err(e) => return fail(e),
            };
            if let Some(n) = found.dense_skipped {
                note.get_or_insert(n);
            }
            for (i, h) in found.hits.iter().enumerate() {
                let mut row = search_row(&root, i + 1, h);
                row["project"] = json!(slug);
                hits.push(row);
            }
        }
        let mut out = json!({ "ok": true, "scope": scope, "total": hits.len(), "hits": hits });
        if let Some(n) = note {
            out["note"] = json!(n);
        }
        json_result(out)
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
            let name = abs
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            if LINT_SKIP_NAMES.contains(&name.as_str()) {
                continue;
            }
            let Some((fm, body)) = read_parts(&abs) else {
                continue;
            };
            let empty = fm.as_object().map(|o| o.is_empty()).unwrap_or(true);
            if empty
                || fm_opt(&fm, "type")
                    .map(|t| LINT_META_TYPES.contains(&t.as_str()))
                    .unwrap_or(false)
            {
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
        json_result(
            json!({ "ok": true, "pages": rows.len(), "mismatches": mismatches, "rows": rows }),
        )
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
            let name = abs
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            if LINT_SKIP_NAMES.contains(&name.as_str()) {
                continue;
            }
            checked += 1;
            let Some((fm, body)) = read_parts(&abs) else {
                continue;
            };
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
        let abs = match wiki_page_path(&root, &a.filename) {
            Ok(p) => p,
            Err(e) => return fail(e),
        };
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
            let name = abs
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            if LINT_SKIP_NAMES.contains(&name.as_str()) {
                continue;
            }
            let Some((fm, body)) = read_parts(&abs) else {
                continue;
            };
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
                if pages
                    .get(tgt)
                    .map(|(s, _)| s == "superseded")
                    .unwrap_or(false)
                {
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
        let abs = match wiki_page_path(&root, &a.filename) {
            Ok(p) => p,
            Err(e) => return fail(e),
        };
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
                .map(|p| {
                    Path::new(&p.root)
                        .join("wiki")
                        .join(format!("{page}.md"))
                        .is_file()
                })
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
            let stem = abs
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            if let Some((fm, _)) = read_parts(&abs) {
                metas.insert(stem, fm);
            }
        }
        let mut pairs = Vec::new();
        for (stem, fm) in &metas {
            let Some(tgt) = fm_opt(fm, "translation_of") else {
                continue;
            };
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

    /// Create a new wiki page with proper myco frontmatter.
    #[tool(description = "Create a wiki page with myco frontmatter (title/type/tags/sources)")]
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
            parts.push(
                a.tags
                    .iter()
                    .map(|t| format!("  - {t}"))
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
        }
        if !a.sources.is_empty() {
            parts.push("sources:".into());
            parts.push(
                a.sources
                    .iter()
                    .map(|s| format!("  - {s}"))
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
        }
        parts.push("---\n".into());
        let body = if a.content.is_empty() {
            format!(
                "# {}\n\n<!-- TODO: add content with inline [^src-*] citations -->",
                a.title
            )
        } else {
            a.content.clone()
        };
        let full = format!("{}\n{}\n", parts.join("\n"), body);
        if let Err(e) = vault::write_file(&target.to_string_lossy(), &full) {
            return fail(e);
        }
        if let Some(u) = crate::INDEX_UPDATER.get() {
            u.mark_dirty(rel_to(&root, &target).replace('\\', "/"));
        }
        crate::inflow_log::record(&root, "mcp", "create_page");
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
        let target = match wiki_page_path(&root, &a.filename) {
            Ok(p) => p,
            Err(e) => return fail(e),
        };
        if let Err(e) = vault::write_file(&target.to_string_lossy(), &a.content) {
            return fail(e);
        }
        if let Some(u) = crate::INDEX_UPDATER.get() {
            u.mark_dirty(rel_to(&root, &target).replace('\\', "/"));
        }
        crate::inflow_log::record(&root, "mcp", "update_page");
        json_result(json!({ "ok": true, "filename": rel_to(&wiki_dir(&root), &target) }))
    }

    /// Every markdown checkbox task in the vault, filtered.
    #[tool(
        description = "List markdown checkbox tasks across the vault. Filters: project (text contains [[project]]), tag (text contains #tag), status (todo|doing|blocked|done), path_prefix (e.g. wiki/roadmaps/ for roadmap items). Returns {page, line, status, text} rows — feed page/line/text to set_task_status."
    )]
    async fn list_tasks(
        &self,
        Parameters(a): Parameters<ListTasksArgs>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.vault_project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        let tasks = match crate::tasks::scan_tasks(&root.to_string_lossy()) {
            Ok(t) => t,
            Err(e) => return fail(e),
        };
        let status = a.status.trim().to_lowercase();
        let link = format!("[[{}", a.project.trim());
        let tag = format!("#{}", a.tag.trim());
        let rows: Vec<Value> = tasks
            .into_iter()
            .filter(|t| a.path_prefix.is_empty() || t.page.starts_with(&a.path_prefix))
            .filter(|t| a.project.trim().is_empty() || t.text.contains(&link))
            .filter(|t| a.tag.trim().is_empty() || t.text.contains(&tag))
            .filter(|t| {
                status.is_empty()
                    || serde_json::to_value(t.status)
                        .ok()
                        .and_then(|v| v.as_str().map(|s| s == status))
                        .unwrap_or(false)
            })
            .map(|t| json!({ "page": t.page, "line": t.line, "status": t.status, "text": t.text }))
            .collect();
        json_result(json!({ "ok": true, "count": rows.len(), "tasks": rows }))
    }

    /// Rewrite one task's checkbox mark, with a stale guard.
    #[tool(
        description = "Set one task's status (todo|doing|blocked|done). page/line/expect_text come from list_tasks; expect_text must match the line's current text or nothing is written (the file changed — re-list and retry). Completing stamps ✅ <today>. Completing a 🔁 recurring task also inserts its next occurrence above, unchecked."
    )]
    async fn set_task_status(
        &self,
        Parameters(a): Parameters<SetTaskStatusArgs>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.vault_project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        let status = match parse_task_status(&a.status) {
            Some(st) => st,
            None => return fail(format!("unknown status: {}", a.status)),
        };
        let target = match task_page_path(&root, &a.page) {
            Ok(p) => p,
            Err(e) => return fail(e),
        };
        let content = match std::fs::read_to_string(&target) {
            Ok(c) => c,
            Err(e) => return fail(format!("read failed for {}: {e}", a.page)),
        };
        let (next, recurring) =
            match crate::tasks::set_line_status(&content, a.line, status, &a.expect_text) {
                Ok(v) => v,
                Err(e) => return fail(e),
            };
        if let Err(e) = vault::write_file(&target.to_string_lossy(), &next) {
            return fail(e);
        }
        if let Some(u) = crate::INDEX_UPDATER.get() {
            u.mark_dirty(a.page.replace('\\', "/"));
        }
        let mut out = json!({ "ok": true, "page": a.page, "line": a.line, "status": a.status });
        if recurring && status == crate::tasks::TaskStatus::Done {
            // Reported, not warned about: the successor is written now (it was
            // app-only before), and a caller that just ticked a repeating task
            // should be told another one exists.
            out["recurrence"] = json!("next occurrence inserted above, unchecked");
        }
        json_result(out)
    }

    /// Append a checkbox task line to an existing page.
    #[tool(
        description = "Append a task (`- [ ] text`) to an existing page, e.g. a wiki/roadmaps/ page or a daily note. Categories (#tag) and project links ([[page]]) go inside text; due becomes 📅 <date>. Creating a new roadmap page is create_page's job."
    )]
    async fn add_task(
        &self,
        Parameters(a): Parameters<AddTaskArgs>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.vault_project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        let text = a.text.trim();
        if text.is_empty() {
            return fail("text is empty");
        }
        let target = match task_page_path(&root, &a.page) {
            Ok(p) => p,
            Err(e) => return fail(e),
        };
        let content = match std::fs::read_to_string(&target) {
            Ok(c) => c,
            Err(e) => return fail(format!("page not found: {} ({e})", a.page)),
        };
        let due = a.due.trim();
        let line = if due.is_empty() {
            format!("- [ ] {text}")
        } else {
            format!("- [ ] {text} 📅 {due}")
        };
        let next = crate::tasks::append_task_line(&content, &line);
        if let Err(e) = vault::write_file(&target.to_string_lossy(), &next) {
            return fail(e);
        }
        if let Some(u) = crate::INDEX_UPDATER.get() {
            u.mark_dirty(a.page.replace('\\', "/"));
        }
        json_result(json!({ "ok": true, "page": a.page, "line": next.trim_end().lines().count() }))
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
        // Q4 item 13 (scope decision 2): scan BEFORE the write — raw/ is
        // immutable, so a secret must never touch disk. The caller still holds
        // the content; a structured refusal lets it redact and retry.
        let pii_warning =
            match raw_source_guard(&a.content, crate::settings::load().pii_quarantine_enabled) {
                Ok(w) => w,
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
        let stem = target
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        // Inflow ledger (daily MCP volume chart) — after the write succeeded.
        crate::inflow_log::record(&root, "mcp", "add_raw_source");
        let mut out = json!({
            "ok": true, "raw_path": rel_to(&root, &target), "src_slug": format!("src-{stem}"),
        });
        if let Some(w) = pii_warning {
            out["pii_warning"] = json!(w);
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
    #[tool(
        description = "Archive an ingested inbox source: copy to raw/ (secrets/PII-scanned like add_raw_source) then move it out"
    )]
    async fn archive_inbox_source(
        &self,
        Parameters(a): Parameters<InboxSourceArgs>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        match archive_inbox(
            &root,
            &a.filename,
            crate::settings::load().pii_quarantine_enabled,
        ) {
            Ok(out) => json_result(out),
            Err(e) => fail(e),
        }
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
        let section = if a.section.trim().is_empty() {
            "Changed"
        } else {
            a.section.trim()
        };
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
        let ur = lines
            .iter()
            .position(|l| l.starts_with("## [Unreleased]"))
            .unwrap_or(0);
        let nxt = (ur + 1..lines.len())
            .find(|&i| lines[i].starts_with("## "))
            .unwrap_or(lines.len());
        let hdr = format!("### {sec}");
        let block_hdr = (ur + 1..nxt).find(|&i| lines[i] == hdr);
        if let Some(hi) = block_hdr {
            lines.insert(hi + 1, format!("- {}", a.entry.trim()));
        } else {
            for (k, s) in ["".to_string(), hdr, format!("- {}", a.entry.trim())]
                .into_iter()
                .enumerate()
            {
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
        let base = root
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "vault".into());
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
                    let msg = if o.stderr.is_empty() {
                        &o.stdout
                    } else {
                        &o.stderr
                    };
                    let msg: String = String::from_utf8_lossy(msg)
                        .trim()
                        .chars()
                        .take(500)
                        .collect();
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
                let msg = if o.stderr.is_empty() {
                    &o.stdout
                } else {
                    &o.stderr
                };
                let msg: String = String::from_utf8_lossy(msg)
                    .trim()
                    .chars()
                    .take(500)
                    .collect();
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

    // ─── import / wikify / ledger / distill / profile ─────────────────────────
    // Ported from the retired Python server onto the app's own modules.

    /// One transcript the caller already holds → `raw/conversations/`.
    #[tool(
        description = "Import one conversation transcript into raw/conversations/<source>/ — dedup by <source>:<conversation_id> AND by body (a re-export under a new id is refused), secrets/PII-scanned like add_raw_source, then queued for wikify_pending. Changed content under a known id lands as a new .rN revision (raw/ is immutable)."
    )]
    async fn import_conversation(
        &self,
        Parameters(a): Parameters<ImportConversationArgs>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        match import_conversation_at(
            &root,
            &a.raw_text,
            &a.source,
            &a.title,
            &a.conversation_id,
            &a.created,
            settings::load().pii_quarantine_enabled,
        ) {
            Ok(out) => json_result(out),
            Err(e) => fail(e),
        }
    }

    /// One coding-session file → the app's own importer (parsers, dedup
    /// ledger, secret quarantine, month buckets).
    #[tool(
        description = "Import a coding-session .jsonl (Claude Code project session or Codex rollout) through the app's own parsers and dedup ledger. dest: sessions (default — the searchable archive; the app's harvest queue promotes a session into the wiki) | _inbox (the next ingest pass turns it into pages). A conversation holding a secret is quarantined, never written."
    )]
    async fn import_session(
        &self,
        Parameters(a): Parameters<ImportSessionArgs>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        let dest = if a.dest.trim().is_empty() {
            commands::DEST_SESSIONS
        } else {
            a.dest.trim()
        };
        let dest = match commands::import_dest(dest) {
            Ok(d) => d,
            Err(e) => return fail(e),
        };
        let path = match session_file(&a.jsonl_path) {
            Ok(p) => p,
            Err(e) => return fail(e),
        };
        let outcome = match tauri::async_runtime::spawn_blocking(move || {
            commands::run_import(&root, &[path], dest, |_| {})
        })
        .await
        {
            Ok(o) => o,
            Err(e) => return fail(format!("join failed: {e}")),
        };
        json_result(import_outcome_json(dest, &outcome))
    }

    /// The import queue: transcripts no wiki page cites yet.
    #[tool(
        description = "Imported-but-not-yet-wikified transcripts (from import_conversation), oldest first, each with a 2,400-char excerpt; write pages citing its src_slug, then call again with done=[key,...] to check them off. Empty = the import queue is fully wikified."
    )]
    async fn wikify_pending(
        &self,
        Parameters(a): Parameters<WikifyPendingArgs>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        match wikify_pending_at(&root, a.limit.unwrap_or(3), &a.done) {
            Ok(out) => json_result(out),
            Err(e) => fail(e),
        }
    }

    /// The dedup ledger's counters.
    #[tool(
        description = "Import dedup ledger: conversations recorded per source, session files stamped, distinct bodies indexed and duplicates refused, plus the wikify queue"
    )]
    async fn ledger_status(
        &self,
        Parameters(a): Parameters<ProjectArg>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        json_result(ledger_status_at(&root))
    }

    /// The Distill tab's numbers, for an agent.
    #[tool(
        description = "Distillation status (no LLM): backlog, proposals awaiting resolution (pending or approved), quarantine count, gate state, last run, and whether the count trigger is exceeded — the numbers the app's Distill tab shows"
    )]
    async fn distill_status(
        &self,
        Parameters(a): Parameters<ProjectArg>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        json_result(distill_status_at(&root))
    }

    /// The no-LLM detection pass, read-only.
    #[tool(
        description = "No-LLM distillation detection pass: unscored inflow per folder (_inbox / raw / sessions), quarantine items expiring within 7 days, proposals still awaiting a decision. Reads .myco/ state, writes nothing."
    )]
    async fn distill_report(
        &self,
        Parameters(a): Parameters<ProjectArg>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        let mut out = serde_json::to_value(crate::distill::report(&root)).unwrap_or(Value::Null);
        out["ok"] = json!(true);
        json_result(out)
    }

    /// Interview-driven `profile.md`.
    #[tool(
        description = "Interview-driven personalisation of <vault>/profile.md. Call with no answers to get the four questions (and the existing profile); ask the user, then call again with role/goals/interests/style to write it — empty fields keep their current value. The profile weights distillation and, in the app, Ask/ingest context. Secrets are warned about, not blocked (profile.md is mutable)."
    )]
    async fn setup_profile(
        &self,
        Parameters(a): Parameters<SetupProfileArgs>,
    ) -> Result<CallToolResult, McpError> {
        let root = match resolve_root(&a.project) {
            Ok(r) => r,
            Err(e) => return fail(e),
        };
        match setup_profile_at(&root, &a.role, &a.goals, &a.interests, &a.style) {
            Ok(out) => json_result(out),
            Err(e) => fail(e),
        }
    }
}

/// The usage brief a client receives at `initialize` — the same one the
/// Python server ships, plus what `search` now is.
const INSTRUCTIONS: &str = "myco is a self-maintaining LLM wiki backed by an Obsidian vault. \
    Use `get_instructions` once per session to load the wiki schema (frontmatter rules, \
    citation format, contradiction policy). Then use the read tools (list_pages, read_page, \
    search) to browse and the write tools (add_raw_source, create_page, update_page) to \
    maintain. `search` is the app's hybrid retrieval — ask it questions, not just keywords. \
    Never modify files under any raw/ directory; raw is immutable. Commit groups of related \
    changes with git_commit. To auto-ingest a backlog: call list_inbox, then for each pending \
    file read_inbox_source -> create/update wiki pages with [^src-*] citations -> \
    archive_inbox_source. Repeat until the inbox is empty.";

/// What `initialize` answers: this server by name and app version (the
/// macro's default names the rmcp crate), tools only, and the brief above.
fn server_info() -> rmcp::model::ServerInfo {
    rmcp::model::ServerInfo::new(
        rmcp::model::ServerCapabilities::builder()
            .enable_tools()
            .build(),
    )
    .with_server_info(rmcp::model::Implementation::new(
        SERVER_NAME,
        env!("CARGO_PKG_VERSION"),
    ))
    .with_instructions(INSTRUCTIONS)
}

// call_tool and get_info are written out (the macro skips a method that
// already exists): every dispatch passes the inflow tool-call log, and
// `initialize` identifies myco instead of the SDK crate. list_tools stays
// generated.
#[tool_handler]
impl ServerHandler for McpServer {
    fn get_info(&self) -> rmcp::model::ServerInfo {
        server_info()
    }

    async fn call_tool(
        &self,
        request: rmcp::model::CallToolRequestParams,
        context: rmcp::service::RequestContext<rmcp::RoleServer>,
    ) -> Result<rmcp::model::CallToolResult, rmcp::ErrorData> {
        record_tool_call(&request.name);
        let tcc = rmcp::handler::server::tool::ToolCallContext::new(self, request, context);
        self.tool_router.call(tcc).await
    }
}

// ─── transport ───────────────────────────────────────────────────────────────

/// Bind the native MCP server on 127.0.0.1:MCP_PORT and spawn its accept loop on
/// the current tokio runtime. Returns once bound (bind errors propagate).
/// Cancelling `ct` shuts the server down and frees the port.
pub async fn serve(app: tauri::AppHandle, ct: CancellationToken) -> Result<(), String> {
    let service = StreamableHttpService::new(
        move || Ok(McpServer::new(app.clone())),
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

/// Scan-before-write gate for the raw/ entry path (Q4 item 13):
/// secrets always refuse; PII refuses when quarantine mode is on, otherwise
/// `Ok(Some(warning))` — the write proceeds and the warning is attached as
/// `pii_warning`. Refusal strings kept in sync with automation/autoingest.py
/// (quarantine move).
pub(crate) fn raw_source_guard(
    content: &str,
    pii_quarantine: bool,
) -> Result<Option<String>, String> {
    let secrets = secrets_scan::scan(content);
    if !secrets.is_empty() {
        return Err(format!(
            "refused: possible secrets ({}) — redact and re-add. Nothing was written.",
            secrets.join(", ")
        ));
    }
    let pii = secrets_scan::scan_pii(content);
    if pii.is_empty() {
        return Ok(None);
    }
    if pii_quarantine {
        return Err(format!(
            "refused: possible PII ({}) — redact and re-add. Nothing was written.",
            pii.join(", ")
        ));
    }
    Ok(Some(format!(
        "possible PII detected: {} — raw/ is immutable and committed to git; \
         redact and re-add if unintended.",
        pii.join(", ")
    )))
}

/// Archive one `_inbox/` source: copy it into a fresh `raw/<slug>[-n].md`,
/// then move the original into `_inbox/.archived/`. The copy is a raw/ write
/// like any other, so it passes `raw_source_guard` first — `_inbox/` is where
/// the clipper and autoingest drop untrusted text — and a refusal leaves the
/// inbox file exactly where it was.
fn archive_inbox(root: &Path, filename: &str, pii_quarantine: bool) -> Result<Value, String> {
    let Some(src) = safe_join(&inbox_dir(root), filename) else {
        return Err(format!("path escapes _inbox/: {filename}"));
    };
    if !src.is_file() {
        return Err(format!("not found in inbox: {filename}"));
    }
    let content = std::fs::read_to_string(&src).unwrap_or_default();
    let pii_warning = raw_source_guard(&content, pii_quarantine)?;
    let raw = raw_dir(root);
    let _ = std::fs::create_dir_all(&raw);
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let slug = make_slug(&stem);
    let mut raw_path = raw.join(format!("{slug}.md"));
    let mut n = 2;
    while raw_path.exists() {
        raw_path = raw.join(format!("{slug}-{n}.md"));
        n += 1;
    }
    vault::write_file(&raw_path.to_string_lossy(), &content)?;
    // Move the original out of the inbox so it is not re-ingested.
    let archive = src
        .parent()
        .map(|p| p.join(".archived"))
        .unwrap_or_default();
    let _ = std::fs::create_dir_all(&archive);
    let ext = src
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
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
    std::fs::rename(&src, &dest).map_err(|e| format!("archive move failed: {e}"))?;
    let raw_stem = raw_path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut out = json!({
        "ok": true, "raw_path": rel_to(root, &raw_path),
        "archived": dest.file_name().map(|s| s.to_string_lossy().to_string()),
        "src_slug": format!("src-{raw_stem}"),
    });
    if let Some(w) = pii_warning {
        out["pii_warning"] = json!(w);
    }
    Ok(out)
}

// ─── import / wikify / ledger / distill / profile bodies ─────────────────────

/// `^[a-z0-9][a-z0-9-]{0,31}$` — the source slug an import is filed under.
fn is_source_slug(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && s.len() <= 32
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A conversation id as a filename: runs of anything outside `[A-Za-z0-9._-]`
/// become one `-`, and the ends are trimmed of dashes.
fn sanitize_id(s: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in s.trim().chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            out.push(c);
            dash = false;
        } else if !dash {
            out.push('-');
            dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// `import_conversation` body: dedup (key+fingerprint, then body) against the
/// import ledger → the raw/ guard → `raw/conversations/<source>/<id>[.rN].md`
/// → ledger + wikify queue. `Err` is the structured refusal (nothing written).
fn import_conversation_at(
    root: &Path,
    raw_text: &str,
    source: &str,
    title: &str,
    conversation_id: &str,
    created: &str,
    pii_quarantine: bool,
) -> Result<Value, String> {
    use crate::importers::ledger::{body_hash, fingerprint, Ledger};
    use crate::importers::wikify::{Pending, PendingItem};
    let source = source.trim().to_lowercase();
    if !is_source_slug(&source) {
        return Err(format!(
            "source must be a short slug like 'chatgpt', 'claude', 'claude-code', 'codex' (got: {source:?})"
        ));
    }
    let text = raw_text.trim();
    if text.is_empty() {
        return Err("raw_text is empty".to_string());
    }
    let mut conv_id = sanitize_id(conversation_id);
    if conv_id.is_empty() {
        conv_id = fingerprint(text)[..12].to_string();
    }
    let key = format!("{source}:{conv_id}");
    let fp = fingerprint(text);
    let mut ledger = Ledger::load(root);
    if ledger.seen(&key, &fp) {
        return Ok(json!({ "ok": true, "status": "skipped_duplicate", "key": key }));
    }
    let hash = body_hash(text);
    if ledger.seen_body(&hash, &key) {
        ledger.note_duplicates(1);
        ledger.save(root)?;
        return Ok(json!({
            "ok": true, "status": "skipped_duplicate", "key": key,
            "reason": "same body already imported under another conversation id",
        }));
    }
    let prior = ledger.entry(&key).is_some();
    let raw = raw_dir(root);
    let mut rel = format!("conversations/{source}/{conv_id}.md");
    let mut rev = 0;
    while raw.join(&rel).exists() {
        rev += 1;
        rel = format!("conversations/{source}/{conv_id}.r{rev}.md");
    }
    let today = registry::today_utc();
    let safe_title = if title.trim().is_empty() {
        conv_id.clone()
    } else {
        crate::profile::sanitize_line(title)
    };
    let day = if created.trim().is_empty() {
        today.clone()
    } else {
        created.trim().to_string()
    };
    let content = format!(
        "---\ntitle: \"{}\"\nsource: {source}\nconversation_id: {conv_id}\ncreated: {day}\nimported: {today}\nvia: mcp\n---\n\n{text}\n",
        safe_title.replace('"', "\\\"")
    );
    let pii_warning = raw_source_guard(&content, pii_quarantine)?;
    let Some(target) = safe_join(&raw, &rel) else {
        return Err(format!("path escapes raw/: {rel}"));
    };
    if let Some(p) = target.parent() {
        std::fs::create_dir_all(p).map_err(|e| format!("create raw/conversations: {e}"))?;
    }
    vault::write_file(&target.to_string_lossy(), &content)?;
    ledger.record(key.clone(), fp);
    ledger.record_body(hash, &key);
    ledger.save(root)?;
    let stem = target
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let mut pending = Pending::load(root);
    pending.push(PendingItem {
        key: key.clone(),
        raw_path: rel_to(root, &target),
        src_slug: format!("src-{stem}"),
        title: safe_title,
        imported: today,
    });
    pending.save(root)?;
    crate::inflow_log::record(root, "mcp", "import_conversation");
    let mut out = json!({
        "ok": true,
        "status": if prior || rev > 0 { "reimported_update" } else { "imported" },
        "key": key,
        "raw_path": rel_to(root, &target),
        "src_slug": format!("src-{stem}"),
        "pending_total": pending.pending.len(),
        "next": "call wikify_pending to turn imported transcripts into wiki pages",
    });
    if let Some(w) = pii_warning {
        out["pii_warning"] = json!(w);
    }
    Ok(out)
}

/// `import_session`'s file argument: `~` expanded, must be an existing
/// `.jsonl` under 50 MB. Host paths are allowed on purpose — session files
/// live under `~/.claude` / `~/.codex`, not in the vault.
fn session_file(path: &str) -> Result<PathBuf, String> {
    let p = path.trim();
    let expanded = match p.strip_prefix("~/") {
        Some(rest) => {
            let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .map_err(|_| "cannot expand ~: no home directory".to_string())?;
            PathBuf::from(home).join(rest)
        }
        None => PathBuf::from(p),
    };
    if !expanded.is_file() {
        return Err(format!("not a file: {path}"));
    }
    if expanded.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return Err("expected a .jsonl session file".to_string());
    }
    let len = std::fs::metadata(&expanded).map(|m| m.len()).unwrap_or(0);
    if len > 50 * 1024 * 1024 {
        return Err("session file over 50 MB".to_string());
    }
    Ok(expanded)
}

/// The app's `ImportOutcome` as a tool result: `ok` is false only when the
/// file itself could not be read or parsed (`failed`), never for skips.
fn import_outcome_json(dest: &str, outcome: &commands::ImportOutcome) -> Value {
    let mut out = serde_json::to_value(outcome).unwrap_or(Value::Null);
    out["ok"] = json!(outcome.failed.is_empty());
    out["dest"] = json!(dest);
    if let Some(f) = outcome.failed.first() {
        out["error"] = json!(f.error);
    }
    out["next"] = json!(if dest == commands::DEST_SESSIONS {
        "the transcript is searchable (search scope=sessions); the app's harvest queue promotes it into _inbox/ for the wiki"
    } else {
        "the next ingest pass turns each _inbox/ doc into wiki pages"
    });
    out
}

/// `wikify_pending` body: check `done` off, then the oldest `limit` items
/// with an excerpt of each transcript.
fn wikify_pending_at(root: &Path, limit: usize, done: &[String]) -> Result<Value, String> {
    let mut pending = crate::importers::wikify::Pending::load(root);
    if !done.is_empty() {
        pending.done(done);
        pending.save(root)?;
    }
    let items: Vec<Value> = pending
        .pending
        .iter()
        .take(limit.clamp(1, 10))
        .map(|p| {
            // The queue file is ours, but a vault-relative path from disk is
            // still confined before it is read.
            let excerpt = safe_join(root, &p.raw_path)
                .and_then(|abs| std::fs::read_to_string(abs).ok())
                .map(|t| t.chars().take(2400).collect::<String>())
                .unwrap_or_default();
            json!({
                "key": p.key, "raw_path": p.raw_path, "src_slug": p.src_slug,
                "title": p.title, "excerpt": excerpt,
            })
        })
        .collect();
    let instructions = if items.is_empty() {
        "Nothing pending — the import queue is fully wikified."
    } else {
        "For each item: read the full raw file if the excerpt is not enough, create or update \
         wiki pages with inline [^src-*] citations to its src_slug, update wiki/index.md, \
         git_commit, then call wikify_pending(done=[key])."
    };
    Ok(json!({
        "ok": true,
        "pending_total": pending.pending.len(),
        "wikified_total": pending.done_count,
        "items": items,
        "instructions": instructions,
    }))
}

/// `ledger_status` body.
fn ledger_status_at(root: &Path) -> Value {
    let ledger = crate::importers::ledger::Ledger::load(root);
    let pending = crate::importers::wikify::Pending::load(root);
    json!({
        "ok": true,
        "conversations_recorded": ledger.conversations(),
        "per_source": ledger.per_source(),
        "session_files_stamped": ledger.files_stamped(),
        "bodies_indexed": ledger.bodies_indexed(),
        "duplicates": ledger.duplicates(),
        "wikify_pending": pending.pending.len(),
        "wikified_total": pending.done_count,
        "ledger_path": ".myco/ledger.json",
        "pending_path": ".myco/wikify-pending.json",
    })
}

/// `distill_status` body: the app's `DistillStatus` plus the count-trigger
/// check the Distill tab runs on it.
fn distill_status_at(root: &Path) -> Value {
    let status = crate::distill::status(root);
    let cfg = crate::distill::config_load(root);
    let trigger_exceeded = cfg.enabled && status.backlog >= cfg.count_trigger;
    let mut out = serde_json::to_value(&status).unwrap_or(Value::Null);
    out["ok"] = json!(true);
    out["trigger_exceeded"] = json!(trigger_exceeded);
    out["hint"] = if trigger_exceeded {
        json!("run distillation in the myco app")
    } else {
        Value::Null
    };
    out
}

/// `setup_profile` body: no answers → the interview; answers → merge into
/// the existing profile and write it.
fn setup_profile_at(
    root: &Path,
    role: &str,
    goals: &[String],
    interests: &[String],
    style: &str,
) -> Result<Value, String> {
    use crate::profile;
    let existing = profile::load(root);
    if role.trim().is_empty() && goals.is_empty() && interests.is_empty() && style.trim().is_empty()
    {
        let questions: Vec<Value> = profile::INTERVIEW
            .iter()
            .map(|(field, question)| json!({ "field": field, "question": question }))
            .collect();
        return Ok(json!({ "ok": true, "questions": questions, "existing": existing }));
    }
    let mut merged = existing.unwrap_or_default();
    if !role.trim().is_empty() {
        merged.role = role.to_string();
    }
    if !goals.is_empty() {
        merged.goals = goals.to_vec();
    }
    if !interests.is_empty() {
        merged.interests = interests.to_vec();
    }
    if !style.trim().is_empty() {
        merged.style = style.to_string();
    }
    profile::save(root, &merged)?;
    let mut out = json!({ "ok": true, "path": profile::FILE_NAME, "profile": merged });
    // Warn, not block: profile.md is mutable, so a redact-and-resave fixes it
    // (unlike raw/, where the guard refuses before writing).
    let hits = secrets_scan::scan(&profile::serialize(&merged));
    if !hits.is_empty() {
        out["secret_warning"] = json!(format!(
            "possible secrets detected: {} — profile.md is sent to configured AI providers when \
             injection is on; redact and re-save if unintended.",
            hits.join(", ")
        ));
    }
    Ok(out)
}

impl McpServer {
    /// The app's hybrid retrieval over `root`, restricted to one `search`
    /// scope — the same managed indexes and embedder the Ask page uses.
    async fn hybrid(
        &self,
        root: &Path,
        query: &str,
        k: usize,
        scope: Scope,
    ) -> Result<commands::HybridSearch, String> {
        let llm = self.app.state::<commands::LocalLlmState>();
        let cache = self.app.state::<crate::vector_index::VectorCache>();
        let bm25_cache = self.app.state::<crate::retrieval::Bm25Cache>();
        commands::hybrid_search(
            &self.app,
            &llm,
            &cache,
            &bm25_cache,
            root,
            query,
            k,
            "builtin-local",
            crate::local_llm::BUILTIN_EMBED_MODEL,
            None,
            scope,
            &TierWeights::default(),
        )
        .await
    }
}

/// One `search` hit: the page's identity from its frontmatter, the chunk's
/// position and snippet, and each retrieval arm's raw score.
fn search_row(root: &Path, rank: usize, h: &commands::HybridHit) -> Value {
    let fm = read_parts(&root.join(&h.page))
        .map(|(fm, _)| fm)
        .unwrap_or(Value::Null);
    json!({
        "rank": rank,
        "page": h.page,
        "tier": h.tier,
        "title": fm_opt(&fm, "title").unwrap_or_else(|| h.stem.clone()),
        "type": fm_str(&fm, "type"),
        "confidence": fm_str(&fm, "confidence"),
        "status": fm_str(&fm, "status"),
        "line": h.line,
        // char-based truncation keeps the snippet valid UTF-8.
        "snippet": h.text.trim().chars().take(240).collect::<String>(),
        "score_bm25": h.bm25,
        "score_vec": h.similarity,
    })
}

#[cfg(test)]
mod tests {
    use super::raw_source_guard;
    use super::record_tool_call_at;
    use super::suspect_scan;
    use super::{
        archive_inbox, collect_md, list_wiki_pages, read_wiki_page, search_row, server_info,
    };
    use super::{
        distill_status_at, import_conversation_at, import_outcome_json, ledger_status_at,
        session_file, setup_profile_at, wikify_pending_at,
    };
    use crate::commands::HybridHit;
    use crate::retrieval::{Bm25Index, TierWeights};
    use std::path::Path;

    #[test]
    fn raw_source_guard_refuses_secrets_before_any_write() {
        let err = raw_source_guard("key: sk-abcdefghijklmnopqrstuvwxyz012345", false).unwrap_err();
        assert!(err.starts_with("refused: possible secrets ("), "{err}");
        assert!(err.contains("Nothing was written."), "{err}");
    }

    #[test]
    fn raw_source_guard_pii_refuses_only_in_quarantine_mode() {
        let text = "reach me at someone@example.com";
        // Warn mode: the write proceeds and the warning is attached.
        let warn = raw_source_guard(text, false).unwrap().unwrap();
        assert!(warn.contains("possible PII detected"), "{warn}");
        assert!(warn.contains("Email address"), "{warn}");
        // Quarantine mode: refuse, same shape as the secrets refusal.
        let err = raw_source_guard(text, true).unwrap_err();
        assert!(err.starts_with("refused: possible PII ("), "{err}");
        assert!(err.contains("Nothing was written."), "{err}");
    }

    #[test]
    fn raw_source_guard_clean_text_passes_silently() {
        assert_eq!(
            raw_source_guard("plain prose, nothing sensitive", true).unwrap(),
            None
        );
    }

    #[test]
    fn suspect_scan_flags_lint_problems_and_confidence_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let wiki = dir.path().join("wiki");
        std::fs::create_dir_all(&wiki).unwrap();
        // clean page: valid type, three citation refs+defs (paper + 3 cites
        // suggests "high", so the declared confidence genuinely matches)
        std::fs::write(
            wiki.join("clean.md"),
            "---\ntype: analysis\nsource_type: paper\nconfidence: high\n---\nA claim.[^src-a] Another.[^src-b] A third.[^src-c]\n\n[^src-a]: raw/a.md\n[^src-b]: raw/b.md\n[^src-c]: raw/c.md\n",
        )
        .unwrap();
        // suspect 1: dangling citation ref (lint problem)
        std::fs::write(
            wiki.join("dangling.md"),
            "---\ntype: analysis\nsource_type: paper\nconfidence: high\n---\nClaim.[^src-missing]\n",
        )
        .unwrap();
        // suspect 2: declared high, zero citations from a forum source -> suggested low
        std::fs::write(
            wiki.join("overclaim.md"),
            "---\ntype: analysis\nsource_type: forum\nconfidence: high\n---\nNo citations at all.\n",
        )
        .unwrap();

        let report = suspect_scan(&wiki);
        assert_eq!(report.pages_checked, 3);
        let pages: Vec<&str> = report.suspects.iter().map(|s| s.page.as_str()).collect();
        assert!(
            pages.contains(&"dangling.md"),
            "dangling ref flagged: {pages:?}"
        );
        assert!(
            pages.contains(&"overclaim.md"),
            "confidence mismatch flagged"
        );
        assert!(
            !pages.contains(&"clean.md"),
            "clean page stays clean: {:?}",
            report.suspects
        );
        let over = report
            .suspects
            .iter()
            .find(|s| s.page == "overclaim.md")
            .unwrap();
        assert!(
            over.reasons.iter().any(|r| r.starts_with("confidence:")),
            "{:?}",
            over.reasons
        );
    }

    #[test]
    fn tool_call_log_prunes_entries_older_than_retention() {
        let mut log = vec![(0u64, "old".to_string())];
        record_tool_call_at(&mut log, 60 * 3_600, "new"); // 60h later: past 48h
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].1, "new");
    }

    #[test]
    fn tool_call_log_keeps_recent_entries() {
        let now = 100_000u64;
        let mut log = vec![(now - 3_600, "recent".to_string())];
        record_tool_call_at(&mut log, now, "new");
        assert_eq!(log.len(), 2);
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    // The guard sits in front of the raw/ copy, so a refusal changes nothing
    // on disk: the source stays in _inbox/ and raw/ stays empty.
    #[test]
    fn archive_inbox_refuses_a_secret_and_leaves_the_inbox_file_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(
            &root.join("_inbox/leak.md"),
            "token: sk-abcdefghijklmnopqrstuvwxyz012345\n",
        );
        let err = archive_inbox(root, "leak.md", false).unwrap_err();
        assert!(err.starts_with("refused: possible secrets ("), "{err}");
        assert!(
            root.join("_inbox/leak.md").is_file(),
            "source must not move"
        );
        assert!(
            collect_md(&root.join("raw")).is_empty(),
            "nothing lands in raw/"
        );
    }

    #[test]
    fn archive_inbox_pii_follows_the_quarantine_setting_like_add_raw_source() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(
            &root.join("_inbox/contact.md"),
            "reach me at someone@example.com\n",
        );
        let err = archive_inbox(root, "contact.md", true).unwrap_err();
        assert!(err.starts_with("refused: possible PII ("), "{err}");
        assert!(root.join("_inbox/contact.md").is_file());
        // Warn mode: the copy proceeds and the warning rides on the result.
        let out = archive_inbox(root, "contact.md", false).unwrap();
        assert_eq!(out["ok"], true);
        assert!(
            out["pii_warning"]
                .as_str()
                .unwrap()
                .contains("possible PII detected"),
            "{out}"
        );
        assert!(root.join("raw/contact.md").is_file());
    }

    #[test]
    fn archive_inbox_copies_a_clean_source_to_raw_and_moves_it_aside() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(
            &root.join("_inbox/My Clip.md"),
            "plain prose, nothing sensitive\n",
        );
        let out = archive_inbox(root, "My Clip.md", true).unwrap();
        assert_eq!(out["raw_path"], "raw/my-clip.md");
        assert_eq!(out["src_slug"], "src-my-clip");
        assert_eq!(out["archived"], "My Clip.md");
        assert_eq!(
            std::fs::read_to_string(root.join("raw/my-clip.md")).unwrap(),
            "plain prose, nothing sensitive\n"
        );
        assert!(!root.join("_inbox/My Clip.md").exists());
        assert!(root.join("_inbox/.archived/My Clip.md").is_file());
    }

    /// A three-page vault (two wiki notes, one session log) plus its BM25
    /// index. The dense arm needs the bundled embedder, so these tests drive
    /// `rank_hybrid` — the exact ranking glue the `search` tool runs — with
    /// the dense arm skipped, as the tool itself does when no index exists.
    fn indexed_vault() -> (tempfile::TempDir, Bm25Index) {
        let dir = tempfile::tempdir().unwrap();
        let pages = [
            (
                "wiki/scaling-laws.md",
                "---\ntitle: \"Scaling laws\"\ntype: concept\nconfidence: high\nstatus: active\n---\n\
                 # Scaling laws\n\nScaling laws describe how model performance grows with compute, \
                 data and parameters: loss falls as a smooth power law in compute.[^src-kaplan]\n\n\
                 [^src-kaplan]: raw/kaplan.md\n",
            ),
            (
                "wiki/compute-budget.md",
                "---\ntitle: \"Compute budget\"\ntype: concept\n---\n# Compute budget\n\n\
                 How many GPU hours a training run may spend.\n",
            ),
            (
                "sessions/2026-08/debug-session.md",
                "# Session 2026-08-20\n\nUser: can you look at the flaky test in the scheduler?\n\n\
                 Assistant: the retry loop races the timer. Unrelated: I skimmed the scaling laws \
                 page for the compute figure and it was fine.\n",
            ),
        ];
        let mut bm25 = Bm25Index::new();
        for (rel, text) in pages {
            write(&dir.path().join(rel), text);
            let stem = Path::new(rel).file_stem().unwrap().to_str().unwrap();
            bm25.upsert_page(rel, stem, &crate::embeddings::chunk_page(text));
        }
        (dir, bm25)
    }

    fn rank(root: &Path, bm25: &Bm25Index, query: &str, scope: &str) -> Vec<HybridHit> {
        crate::commands::rank_hybrid(
            root,
            &crate::vector_index::VectorStore::default(),
            None,
            bm25,
            query,
            10,
            None,
            scope.parse().unwrap(),
            &TierWeights::default(),
        )
    }

    fn pages(hits: &[HybridHit]) -> Vec<&str> {
        hits.iter().map(|h| h.page.as_str()).collect()
    }

    // The old substring scan returned nothing for this question because no
    // line contains it verbatim; ranked retrieval finds the note that answers it.
    #[test]
    fn search_ranks_the_note_answering_a_question_first() {
        let (dir, bm25) = indexed_vault();
        let hits = rank(
            dir.path(),
            &bm25,
            "how model performance grows with compute",
            "wiki",
        );
        assert_eq!(
            pages(&hits).first(),
            Some(&"wiki/scaling-laws.md"),
            "{:?}",
            pages(&hits)
        );
    }

    #[test]
    fn search_scope_wiki_excludes_sessions_and_scope_sessions_is_only_sessions() {
        let (dir, bm25) = indexed_vault();
        let wiki = rank(dir.path(), &bm25, "scaling laws", "wiki");
        assert!(!wiki.is_empty());
        assert!(
            wiki.iter().all(|h| h.page.starts_with("wiki/")),
            "{:?}",
            pages(&wiki)
        );
        let sessions = rank(dir.path(), &bm25, "scaling laws", "sessions");
        assert_eq!(pages(&sessions), vec!["sessions/2026-08/debug-session.md"]);
    }

    // `sessions/` sorts before `wiki/`, which is exactly why the old
    // alphabetical scan put a passing mention above the page about the topic.
    #[test]
    fn search_scope_all_ranks_the_wiki_note_above_an_alphabetically_earlier_session() {
        let (dir, bm25) = indexed_vault();
        let hits = rank(dir.path(), &bm25, "scaling laws", "all");
        let got = pages(&hits);
        assert!(
            got.contains(&"sessions/2026-08/debug-session.md"),
            "{got:?}"
        );
        assert_eq!(got[0], "wiki/scaling-laws.md", "{got:?}");
    }

    #[test]
    fn search_row_carries_frontmatter_identity_position_and_both_arm_scores() {
        let (dir, bm25) = indexed_vault();
        let hits = rank(dir.path(), &bm25, "scaling laws", "wiki");
        let row = search_row(dir.path(), 1, &hits[0]);
        assert_eq!(row["rank"], 1);
        assert_eq!(row["page"], "wiki/scaling-laws.md");
        assert_eq!(row["title"], "Scaling laws");
        assert_eq!(row["type"], "concept");
        assert_eq!(row["confidence"], "high");
        assert_eq!(row["status"], "active");
        assert!(row["line"].as_u64().unwrap() >= 1);
        assert!(row["snippet"].as_str().unwrap().contains("Scaling laws"));
        assert!(row["score_bm25"].as_f64().unwrap() > 0.0, "{row}");
        assert!(row["score_vec"].is_null(), "no dense arm ran: {row}");
        assert_eq!(row["tier"], "note", "{row}");
    }

    /// Four one-chunk pages with hand-built unit vectors, so the dense arm's
    /// cosine order is exact: note A > session S > note B > note C. The BM25
    /// arm is empty, so the fused order IS that order (rrf 1/60, 1/61, ...).
    fn tiered_vault() -> (tempfile::TempDir, crate::vector_index::VectorStore) {
        let dir = tempfile::tempdir().unwrap();
        let mut store = crate::vector_index::VectorStore::default();
        let pages = [
            ("wiki/a-note.md", [1.0, 0.0, 0.0, 0.0]),
            ("sessions/2026-08/s-transcript.md", [0.0, 1.0, 0.0, 0.0]),
            ("wiki/b-note.md", [0.0, 0.0, 1.0, 0.0]),
            ("wiki/c-note.md", [0.0, 0.0, 0.0, 1.0]),
        ];
        for (rel, v) in pages {
            write(
                &dir.path().join(rel),
                &format!(
                    "# {rel}

body of {rel}
"
                ),
            );
            let stem = Path::new(rel).file_stem().unwrap().to_str().unwrap();
            store.upsert_page(rel, stem, vec![(1, v.to_vec())]);
        }
        (dir, store)
    }

    fn rank_dense(
        root: &Path,
        store: &crate::vector_index::VectorStore,
        weights: &TierWeights,
    ) -> Vec<HybridHit> {
        crate::commands::rank_hybrid(
            root,
            store,
            Some(&[0.9, 0.8, 0.7, 0.6]),
            &Bm25Index::new(),
            "anything",
            10,
            None,
            "all".parse().unwrap(),
            weights,
        )
    }

    // The mockup's "2위 → 6위" claim on a four-page fixture: the transcript
    // fuses at rank 2 and the default prior (session 0.6) drops it below the
    // two notes behind it; a flat prior leaves the fused order alone.
    #[test]
    fn tier_prior_drops_a_rank_2_session_below_the_notes() {
        let (dir, store) = tiered_vault();
        let flat = rank_dense(dir.path(), &store, &TierWeights::FLAT);
        assert_eq!(
            pages(&flat),
            vec![
                "wiki/a-note.md",
                "sessions/2026-08/s-transcript.md",
                "wiki/b-note.md",
                "wiki/c-note.md",
            ]
        );

        let weighted = rank_dense(dir.path(), &store, &TierWeights::default());
        assert_eq!(
            pages(&weighted),
            vec![
                "wiki/a-note.md",
                "wiki/b-note.md",
                "wiki/c-note.md",
                "sessions/2026-08/s-transcript.md",
            ]
        );
        let s = &weighted[3];
        assert_eq!(s.tier, crate::retrieval::Tier::Session);
        assert!((s.score - flat[1].score * 0.6).abs() < 1e-7);
        // The cosine each hit earned is untouched by the prior.
        assert_eq!(s.similarity, flat[1].similarity);

        // What the prior did, per hit: the transcript fell two places (fused
        // #2 -> final #4), the two notes behind it each rose one, the leader
        // and the flat run report no movement at all.
        assert!(flat.iter().all(|h| h.rank_change == 0 && h.prior == 1.0));
        assert!(flat.iter().all(|h| h.score == h.score_rrf));
        assert_eq!(s.prior, 0.6);
        assert_eq!(s.score_rrf, flat[1].score_rrf);
        assert_eq!(s.rank_change, -2);
        assert_eq!(weighted[0].rank_change, 0);
        assert_eq!(weighted[1].rank_change, 1);
        assert_eq!(weighted[2].rank_change, 1);
    }

    #[test]
    fn scope_is_applied_before_the_pool_cut_on_both_arms() {
        let (dir, store) = tiered_vault();
        let only_sessions = crate::commands::rank_hybrid(
            dir.path(),
            &store,
            Some(&[0.9, 0.8, 0.7, 0.6]),
            &Bm25Index::new(),
            "anything",
            10,
            None,
            "sessions".parse().unwrap(),
            &TierWeights::default(),
        );
        assert_eq!(
            pages(&only_sessions),
            vec!["sessions/2026-08/s-transcript.md"]
        );
        let wiki = crate::commands::rank_hybrid(
            dir.path(),
            &store,
            Some(&[0.9, 0.8, 0.7, 0.6]),
            &Bm25Index::new(),
            "anything",
            10,
            None,
            "wiki".parse().unwrap(),
            &TierWeights::default(),
        );
        assert_eq!(
            pages(&wiki),
            vec!["wiki/a-note.md", "wiki/b-note.md", "wiki/c-note.md"]
        );
    }

    #[test]
    fn initialize_names_myco_with_the_app_version_and_the_usage_brief() {
        let info = server_info();
        assert_eq!(info.server_info.name, "myco");
        assert_eq!(info.server_info.version, env!("CARGO_PKG_VERSION"));
        assert!(
            info.capabilities.tools.is_some(),
            "tools capability advertised"
        );
        let brief = info.instructions.as_deref().unwrap();
        assert!(
            brief.contains("get_instructions") && brief.contains("archive_inbox_source"),
            "{brief}"
        );
    }

    fn three_page_wiki() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (name, ty) in [("a.md", "concept"), ("b.md", "entity"), ("c.md", "concept")] {
            write(
                &dir.path().join("wiki").join(name),
                &format!("---\ntitle: \"{name}\"\ntype: {ty}\n---\nBody linking [[b]] and [[c.md|see c]].\n"),
            );
        }
        dir
    }

    #[test]
    fn list_pages_cuts_at_limit_and_says_so() {
        let dir = three_page_wiki();
        // list_files canonicalizes (`/var` -> `/private/var` on macOS); hand it
        // the canonical root, as the app's active-vault marker does.
        let root = dir.path().canonicalize().unwrap();
        let cut = list_wiki_pages(&root, "", "", 2).unwrap();
        assert_eq!(cut["count"], 2);
        assert_eq!(cut["truncated"], true);
        let all = list_wiki_pages(&root, "", "", 200).unwrap();
        assert_eq!(all["count"], 3);
        assert_eq!(all["truncated"], false);
        let filtered = list_wiki_pages(&root, "", "entity", 200).unwrap();
        assert_eq!(filtered["count"], 1);
        assert_eq!(filtered["pages"][0]["filename"], "b.md");
        assert_eq!(filtered["truncated"], false);
        let err = list_wiki_pages(&root, "../raw", "", 200).unwrap_err();
        assert!(err.starts_with("folder escapes wiki/"), "{err}");
    }

    #[test]
    fn read_page_lists_outbound_links_and_points_a_miss_at_the_next_call() {
        let dir = three_page_wiki();
        let root = dir.path();
        let page = read_wiki_page(root, "a.md").unwrap();
        assert_eq!(page["links"], serde_json::json!(["b.md", "c.md"]));
        assert_eq!(page["frontmatter"]["type"], "concept");
        assert!(page["word_count"].as_u64().unwrap() > 0);
        let err = read_wiki_page(root, "nope.md").unwrap_err();
        assert_eq!(
            err,
            "page not found: nope.md — call list_pages or search to find the right filename"
        );
        assert!(
            !err.contains(&*root.to_string_lossy()),
            "no host path in a tool error: {err}"
        );
        let err = read_wiki_page(root, "../raw/x.md").unwrap_err();
        assert_eq!(err, "path escapes wiki/: ../raw/x.md");
    }

    // ─── import_conversation / import_session / wikify_pending / ledger_status ─
    // Ported from the retired mcp-server/test_myco_mcp.py; the fingerprint is the
    // Rust one (no `py-` prefix) and raw_path is vault-relative.

    fn import_vault() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("raw")).unwrap();
        std::fs::create_dir_all(dir.path().join("wiki")).unwrap();
        dir
    }

    #[test]
    fn import_conversation_writes_the_ledger_and_the_wikify_queue() {
        let dir = import_vault();
        let root = dir.path();
        let out = import_conversation_at(
            root,
            "User: hi\nAssistant: hello",
            "chatgpt",
            "Greeting",
            "abc123",
            "",
            false,
        )
        .unwrap();
        assert_eq!(out["ok"], true);
        assert_eq!(out["status"], "imported");
        assert_eq!(out["key"], "chatgpt:abc123");
        assert_eq!(out["src_slug"], "src-abc123");
        let raw = root.join("raw/conversations/chatgpt/abc123.md");
        assert!(raw.is_file());
        let body = std::fs::read_to_string(&raw).unwrap();
        assert!(body.contains("source: chatgpt") && body.contains("Assistant: hello"));
        assert!(body.contains("title: \"Greeting\""), "{body}");
        let ledger = crate::importers::ledger::Ledger::load(root);
        assert!(ledger.seen(
            "chatgpt:abc123",
            &crate::importers::ledger::fingerprint("User: hi\nAssistant: hello")
        ));
        let status = ledger_status_at(root);
        assert_eq!(status["conversations_recorded"], 1);
        assert_eq!(status["per_source"], serde_json::json!({ "chatgpt": 1 }));
        assert_eq!(status["bodies_indexed"], 1);
        assert_eq!(status["wikify_pending"], 1);
    }

    #[test]
    fn import_conversation_duplicate_skips_and_a_changed_transcript_appends_a_revision() {
        let dir = import_vault();
        let root = dir.path();
        import_conversation_at(root, "same text", "claude", "", "c1", "", false).unwrap();
        let again =
            import_conversation_at(root, "same text", "claude", "", "c1", "", false).unwrap();
        assert_eq!(again["status"], "skipped_duplicate");
        let changed =
            import_conversation_at(root, "the chat continued", "claude", "", "c1", "", false)
                .unwrap();
        assert_eq!(changed["status"], "reimported_update");
        // raw/ immutable: the original file is untouched, the revision is new.
        let original =
            std::fs::read_to_string(root.join("raw/conversations/claude/c1.md")).unwrap();
        assert!(original.contains("same text"));
        assert!(root.join("raw/conversations/claude/c1.r1.md").is_file());
    }

    #[test]
    fn import_conversation_refuses_a_bad_source_and_empty_text() {
        let dir = import_vault();
        let err = import_conversation_at(dir.path(), "text", "Not A Slug!", "", "", "", false)
            .unwrap_err();
        assert!(err.starts_with("source must be a short slug"), "{err}");
        let err =
            import_conversation_at(dir.path(), "   ", "chatgpt", "", "", "", false).unwrap_err();
        assert_eq!(err, "raw_text is empty");
        assert!(collect_md(&dir.path().join("raw")).is_empty());
    }

    // The harvest wave's body oracle applies here too: the same transcript
    // pasted under a new id is a duplicate, and a secret never reaches raw/.
    #[test]
    fn import_conversation_refuses_a_known_body_under_a_new_id_and_a_secret() {
        let dir = import_vault();
        let root = dir.path();
        import_conversation_at(root, "alpha talk", "chatgpt", "", "a", "", false).unwrap();
        let dup =
            import_conversation_at(root, "alpha talk", "chatgpt", "", "b", "", false).unwrap();
        assert_eq!(dup["status"], "skipped_duplicate");
        assert!(dup["reason"]
            .as_str()
            .unwrap()
            .contains("another conversation id"));
        assert!(!root.join("raw/conversations/chatgpt/b.md").exists());
        assert_eq!(ledger_status_at(root)["duplicates"], 1);
        let err = import_conversation_at(
            root,
            "token: sk-abcdefghijklmnopqrstuvwxyz012345",
            "chatgpt",
            "",
            "leak",
            "",
            false,
        )
        .unwrap_err();
        assert!(err.starts_with("refused: possible secrets ("), "{err}");
        assert!(!root.join("raw/conversations/chatgpt/leak.md").exists());
        assert_eq!(ledger_status_at(root)["conversations_recorded"], 1);
    }

    /// A user turn long enough to clear the importer's 800-spoken-char floor.
    fn long_turn(seed: &str) -> String {
        format!("{seed} ").repeat(900 / (seed.len() + 1) + 2)
    }

    #[test]
    fn import_session_parses_a_claude_code_jsonl_through_the_apps_importer() {
        let dir = import_vault();
        let root = dir.path();
        let session = dir.path().join("s1.jsonl");
        let prompt = long_turn("fix the bug in the scheduler");
        std::fs::write(
            &session,
            format!(
                "{{\"type\":\"user\",\"cwd\":\"/repo\",\"gitBranch\":\"main\",\"sessionId\":\"sess-9\",\"timestamp\":\"2026-08-01T10:00:00Z\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"{prompt}\"}}]}}}}\n\
                 {{\"type\":\"assistant\",\"sessionId\":\"sess-9\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"done\"}}]}}}}\n\
                 {{\"type\":\"tool_result\",\"noise\":true}}\n"
            ),
        )
        .unwrap();
        let path = session_file(&session.to_string_lossy()).unwrap();
        let outcome = crate::commands::run_import(root, &[path], "sessions", |_| {});
        let out = import_outcome_json("sessions", &outcome);
        assert_eq!(out["ok"], true, "{out}");
        assert_eq!(out["source"], "claude-code");
        assert_eq!(out["imported"], 1);
        assert_eq!(out["dest"], "sessions");
        let docs = collect_md(&root.join("sessions"));
        assert_eq!(docs.len(), 1, "{docs:?}");
        assert!(docs[0].ends_with("claude-code-sess-9.md"), "{docs:?}");
        let body = std::fs::read_to_string(&docs[0]).unwrap();
        assert!(body.contains("fix the bug in the scheduler"));
        assert!(body.contains("source: claude-code"));
        // Idempotent: the same file again is a skip, not a second doc.
        let again = crate::commands::run_import(
            root,
            &[session_file(&session.to_string_lossy()).unwrap()],
            "sessions",
            |_| {},
        );
        assert_eq!((again.imported, again.skipped), (0, 1));
    }

    #[test]
    fn import_session_parses_a_codex_rollout_into_the_inbox_when_asked() {
        let dir = import_vault();
        let root = dir.path();
        let session = dir.path().join("rollout-1.jsonl");
        let prompt = long_turn("explain rotary embeddings");
        std::fs::write(
            &session,
            format!(
                "{{\"type\":\"session_meta\",\"timestamp\":\"2026-05-18T23:59:51.000Z\",\"payload\":{{\"id\":\"sess-cdx\",\"cwd\":\"/x\"}}}}\n\
                 {{\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":[{{\"type\":\"input_text\",\"text\":\"{prompt}\"}}]}}}}\n\
                 {{\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{{\"type\":\"output_text\",\"text\":\"rotary embeddings rotate query and key vectors\"}}]}}}}\n"
            ),
        )
        .unwrap();
        let outcome = crate::commands::run_import(root, &[session], "_inbox", |_| {});
        let out = import_outcome_json("_inbox", &outcome);
        assert_eq!(out["ok"], true, "{out}");
        assert_eq!(out["source"], "codex");
        let doc = root.join("_inbox/codex-sess-cdx.md");
        assert!(doc.is_file());
        assert!(std::fs::read_to_string(doc)
            .unwrap()
            .contains("rotate query and key vectors"));
    }

    #[test]
    fn import_session_rejects_an_unrecognized_or_missing_file() {
        let dir = import_vault();
        let bad = dir.path().join("notes.jsonl");
        std::fs::write(&bad, "{\"just\": \"noise\"}\n").unwrap();
        let outcome = crate::commands::run_import(dir.path(), &[bad], "sessions", |_| {});
        let out = import_outcome_json("sessions", &outcome);
        assert_eq!(out["ok"], false);
        assert!(
            out["error"].as_str().unwrap().contains("unrecognized"),
            "{out}"
        );
        assert!(collect_md(&dir.path().join("sessions")).is_empty());
        let err = session_file(&dir.path().join("missing.jsonl").to_string_lossy()).unwrap_err();
        assert!(err.starts_with("not a file:"), "{err}");
        let txt = dir.path().join("x.txt");
        std::fs::write(&txt, "prose").unwrap();
        assert_eq!(
            session_file(&txt.to_string_lossy()).unwrap_err(),
            "expected a .jsonl session file"
        );
    }

    #[test]
    fn wikify_pending_lists_oldest_first_then_checks_off() {
        let dir = import_vault();
        let root = dir.path();
        import_conversation_at(root, "alpha talk", "chatgpt", "", "a", "", false).unwrap();
        import_conversation_at(root, "beta talk", "chatgpt", "", "b", "", false).unwrap();
        let out = wikify_pending_at(root, 1, &[]).unwrap();
        assert_eq!(out["pending_total"], 2);
        assert_eq!(out["items"].as_array().unwrap().len(), 1);
        let first = &out["items"][0];
        assert_eq!(first["key"], "chatgpt:a");
        assert_eq!(first["raw_path"], "raw/conversations/chatgpt/a.md");
        assert!(first["excerpt"].as_str().unwrap().contains("alpha talk"));
        let after = wikify_pending_at(root, 3, &["chatgpt:a".to_string()]).unwrap();
        assert_eq!(after["pending_total"], 1);
        assert_eq!(after["wikified_total"], 1);
        assert_eq!(after["items"][0]["key"], "chatgpt:b");
        let done = wikify_pending_at(root, 3, &["chatgpt:b".to_string()]).unwrap();
        assert_eq!(done["items"].as_array().unwrap().len(), 0);
        assert!(done["instructions"]
            .as_str()
            .unwrap()
            .starts_with("Nothing pending"));
    }

    #[test]
    fn ledger_status_reads_a_ledger_the_app_wrote() {
        let dir = import_vault();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".myco")).unwrap();
        std::fs::write(
            root.join(".myco/ledger.json"),
            r#"{"entries":{"chatgpt:x":"0011223344556677","codex:y":"8899aabbccddeeff"},
                "files":{"/home/u/.claude/projects/a.jsonl":{"mtime_ns":1,"len":2,"convs":1}}}"#,
        )
        .unwrap();
        let s = ledger_status_at(root);
        assert_eq!(s["conversations_recorded"], 2);
        assert_eq!(
            s["per_source"],
            serde_json::json!({ "chatgpt": 1, "codex": 1 })
        );
        assert_eq!(s["session_files_stamped"], 1);
        assert_eq!(s["bodies_indexed"], 0);
        assert_eq!(s["wikify_pending"], 0);
        assert_eq!(s["ledger_path"], ".myco/ledger.json");
    }

    // ─── distill_status / distill_report ──────────────────────────────────────
    // Ported from the Python server's tests against the Rust `distill` module.
    // Two shape differences are the app's: `last_run` is unix seconds (not
    // ISO), and the scan ledger is embedding-model-gated — a test state file
    // carries `"model": ""`, the model of the (absent) index under test.

    fn write_proposal(path: &Path, action: &str, title: &str, status: Option<&str>) {
        let status_line = status.map(|s| format!("status: {s}\n")).unwrap_or_default();
        write(
            path,
            &format!(
                "---\ntype: distill-proposal\naction: {action}\n{status_line}created: 2026-08-12\npayload: {{\"files\": []}}\n---\n\n# {title}\n\nBody.\n"
            ),
        );
    }

    #[test]
    fn distill_status_on_an_empty_vault_is_all_zeros() {
        let dir = tempfile::tempdir().unwrap();
        let s = distill_status_at(dir.path());
        assert_eq!(s["ok"], true);
        assert_eq!(s["backlog"], 0);
        assert_eq!(s["pending_proposals"], 0);
        assert_eq!(s["quarantined"], 0);
        assert!(s["last_run"].is_null());
        assert_eq!(s["trigger_exceeded"], false);
        assert!(s["hint"].is_null());
        assert_eq!(s["gate_active"], false);
    }

    #[test]
    fn distill_report_on_an_empty_vault_is_empty_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let r = crate::distill::report(dir.path());
        assert_eq!(
            r.unscored_by_folder,
            [("_inbox", 0), ("raw", 0), ("sessions", 0)]
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect()
        );
        assert!(r.quarantine_expiring_soon.is_empty());
        assert!(r.proposals.is_empty());
    }

    #[test]
    fn distill_status_counts_pending_and_approved_proposals_not_resolved_ones() {
        let dir = tempfile::tempdir().unwrap();
        let fb = dir.path().join("work/feedback");
        write_proposal(
            &fb.join("one.md"),
            "archive-batch",
            "Archive batch one",
            Some("pending"),
        );
        write_proposal(
            &fb.join("two.md"),
            "admit-cluster",
            "New topic forming",
            None,
        );
        // A stuck approved-but-unapplied proposal still awaits resolution.
        write_proposal(
            &fb.join("three.md"),
            "admit-cluster",
            "Approved",
            Some("approved"),
        );
        write_proposal(&fb.join("done.md"), "delete-batch", "Old", Some("done"));
        write_proposal(
            &fb.join("gone.md"),
            "delete-batch",
            "Dismissed",
            Some("dismissed"),
        );
        assert_eq!(distill_status_at(dir.path())["pending_proposals"], 3);
    }

    #[test]
    fn distill_report_lists_pending_proposals_with_title_and_action() {
        let dir = tempfile::tempdir().unwrap();
        let fb = dir.path().join("work/feedback");
        write_proposal(
            &fb.join("one.md"),
            "archive-batch",
            "Archive batch one",
            Some("pending"),
        );
        write_proposal(
            &fb.join("resolved.md"),
            "delete-batch",
            "Resolved",
            Some("dismissed"),
        );
        // Approved is status's business, not a decision to ask for again.
        write_proposal(
            &fb.join("approved.md"),
            "admit-cluster",
            "Approved",
            Some("approved"),
        );
        let r = crate::distill::report(dir.path());
        assert_eq!(
            r.proposals,
            vec![crate::distill::ProposalSummary {
                path: "work/feedback/one.md".into(),
                action: "archive-batch".into(),
                title: "Archive batch one".into(),
            }]
        );
    }

    #[test]
    fn distill_status_trigger_exceeded_when_backlog_meets_count_trigger() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join(".myco/distill.json"), r#"{"count_trigger": 1}"#);
        write(&root.join("_inbox/new.md"), "some fresh inflow content\n");
        let s = distill_status_at(root);
        assert_eq!(s["backlog"], 1);
        assert_eq!(s["trigger_exceeded"], true);
        assert_eq!(s["hint"], "run distillation in the myco app");
        // `enabled: false` never nags, whatever the backlog.
        write(
            &root.join(".myco/distill.json"),
            r#"{"count_trigger": 1, "enabled": false}"#,
        );
        assert_eq!(distill_status_at(root)["trigger_exceeded"], false);
    }

    #[test]
    fn distill_status_backlog_excludes_already_scored_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(&root.join("_inbox/seen.md"), "already scored\n");
        write(
            &root.join(".myco/distill-state.json"),
            r#"{"model":"","scored":{"_inbox/seen.md":{"hash":1,"tier":"full","at":0}}}"#,
        );
        assert_eq!(distill_status_at(root)["backlog"], 0);
        assert_eq!(crate::distill::report(root).unscored_by_folder["_inbox"], 0);
    }

    #[test]
    fn distill_status_reports_last_run_as_unix_seconds() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join(".myco/distill-state.json"),
            r#"{"model":"","scored":{},"last_run":1755000000}"#,
        );
        assert_eq!(distill_status_at(dir.path())["last_run"], 1_755_000_000);
    }

    #[test]
    fn distill_report_flags_quarantine_expiring_within_a_week() {
        let dir = tempfile::tempdir().unwrap();
        let q = dir.path().join("_inbox/quarantine");
        let now = super::now_secs() as i64;
        write(&q.join("soon.md"), "quarantined\n");
        write(
            &q.join("soon.verdict.json"),
            &format!("{{\"expires\": {}}}", now + 3_600),
        );
        write(&q.join("later.md"), "quarantined\n");
        write(
            &q.join("later.verdict.json"),
            &format!("{{\"expires\": {}}}", now + 30 * 86_400),
        );
        let r = crate::distill::report(dir.path());
        let paths: Vec<&str> = r
            .quarantine_expiring_soon
            .iter()
            .map(|e| e.path.as_str())
            .collect();
        assert_eq!(paths, vec!["_inbox/quarantine/soon.md"]);
        assert_eq!(r.quarantine_expiring_soon[0].expires, now + 3_600);
    }

    #[test]
    fn distill_status_counts_quarantine_toward_backlog_once() {
        let dir = tempfile::tempdir().unwrap();
        let q = dir.path().join("_inbox/quarantine");
        write(&q.join("a.md"), "quarantined\n");
        write(&q.join("a.verdict.json"), r#"{"expires": 9999999999}"#);
        // The quarantined .md itself is not unscored _inbox inflow — only its
        // sidecar counts, once.
        let s = distill_status_at(dir.path());
        assert_eq!(s["backlog"], 1);
        assert_eq!(s["quarantined"], 1);
    }

    #[test]
    fn distill_status_invalid_or_non_utf8_state_degrades_to_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join(".myco/distill-state.json");
        write(&state, "{not valid json");
        let s = distill_status_at(dir.path());
        assert_eq!(s["backlog"], 0);
        assert_eq!(s["pending_proposals"], 0);
        assert!(s["last_run"].is_null());
        assert_eq!(s["trigger_exceeded"], false);
        std::fs::write(&state, b"\xff\xfe not utf-8 \x80\x81").unwrap();
        assert_eq!(distill_status_at(dir.path())["backlog"], 0);
    }

    #[test]
    fn distill_report_skips_an_invalid_json_sidecar() {
        let dir = tempfile::tempdir().unwrap();
        let q = dir.path().join("_inbox/quarantine");
        let now = super::now_secs() as i64;
        write(&q.join("bad.md"), "x\n");
        write(&q.join("bad.verdict.json"), "{not valid json");
        write(&q.join("good.md"), "x\n");
        write(
            &q.join("good.verdict.json"),
            &format!("{{\"expires\": {}}}", now + 3_600),
        );
        let r = crate::distill::report(dir.path());
        let paths: Vec<&str> = r
            .quarantine_expiring_soon
            .iter()
            .map(|e| e.path.as_str())
            .collect();
        assert_eq!(paths, vec!["_inbox/quarantine/good.md"]);
    }

    #[test]
    fn distill_status_ignores_a_proposal_without_frontmatter() {
        let dir = tempfile::tempdir().unwrap();
        write(
            &dir.path().join("work/feedback/no-frontmatter.md"),
            "Just a plain note, no --- block.\n",
        );
        assert_eq!(distill_status_at(dir.path())["pending_proposals"], 0);
        assert!(crate::distill::report(dir.path()).proposals.is_empty());
    }

    // ─── setup_profile ────────────────────────────────────────────────────────

    #[test]
    fn setup_profile_with_no_answers_returns_the_interview() {
        let dir = tempfile::tempdir().unwrap();
        let out = setup_profile_at(dir.path(), "", &[], &[], "").unwrap();
        let questions = out["questions"].as_array().unwrap();
        assert_eq!(questions.len(), 4);
        let fields: std::collections::BTreeSet<&str> = questions
            .iter()
            .map(|q| q["field"].as_str().unwrap())
            .collect();
        assert_eq!(fields, ["goals", "interests", "role", "style"].into());
        assert!(out["existing"].is_null());
        assert!(
            !dir.path().join("profile.md").exists(),
            "asking writes nothing"
        );
    }

    #[test]
    fn setup_profile_with_no_answers_reports_the_existing_profile() {
        let dir = tempfile::tempdir().unwrap();
        setup_profile_at(dir.path(), "Backend engineer", &[], &[], "").unwrap();
        let out = setup_profile_at(dir.path(), "", &[], &[], "").unwrap();
        assert_eq!(out["existing"]["role"], "Backend engineer");
    }

    #[test]
    fn setup_profile_writes_profile_md_at_the_vault_root() {
        let dir = tempfile::tempdir().unwrap();
        let out = setup_profile_at(
            dir.path(),
            "Backend engineer",
            &[],
            &["rust".to_string(), "ontologies".to_string()],
            "",
        )
        .unwrap();
        assert_eq!(out["ok"], true);
        assert_eq!(out["path"], "profile.md");
        let written = std::fs::read_to_string(dir.path().join("profile.md")).unwrap();
        assert!(written.contains("Backend engineer"));
        assert!(written.contains("- rust") && written.contains("- ontologies"));
        assert!(written.contains("Settings → 증류"), "the header comment");
    }

    #[test]
    fn setup_profile_merges_and_empty_fields_keep_their_values() {
        let dir = tempfile::tempdir().unwrap();
        setup_profile_at(
            dir.path(),
            "Backend engineer",
            &["ship the gate".to_string()],
            &[],
            "Concise",
        )
        .unwrap();
        let out = setup_profile_at(
            dir.path(),
            "",
            &[],
            &["rust".to_string(), "vector search".to_string()],
            "",
        )
        .unwrap();
        assert_eq!(out["profile"]["role"], "Backend engineer");
        assert_eq!(
            out["profile"]["goals"],
            serde_json::json!(["ship the gate"])
        );
        assert_eq!(
            out["profile"]["interests"],
            serde_json::json!(["rust", "vector search"])
        );
        assert_eq!(out["profile"]["style"], "Concise");
    }

    #[test]
    fn setup_profile_warns_about_a_secret_but_still_writes() {
        let dir = tempfile::tempdir().unwrap();
        let out = setup_profile_at(
            dir.path(),
            "",
            &[],
            &[],
            "my key is sk-abcdefghijklmnopqrstuvwxyz0123456789",
        )
        .unwrap();
        assert_eq!(out["ok"], true);
        assert!(out["secret_warning"]
            .as_str()
            .unwrap()
            .starts_with("possible secrets detected"));
        assert!(dir.path().join("profile.md").exists(), "warn, not block");
    }
}
