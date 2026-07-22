// Native in-process MCP server (rmcp), replacing the Python subprocess so the
// server works on any machine with ZERO external runtime — no system Python, no
// venv, no pip. It runs inside the app's own tokio runtime and re-resolves the
// active vault per call (via the app-data marker), so switching projects in the
// UI is seen by the very next tool call with no restart.
//
// Phase 0 spike: ONE tool (get_instructions) exposed over Streamable HTTP at
// `/mcp`, to prove a Claude Code `--transport http` client round-trips against
// rmcp 2.2 before the full 26-tool surface is ported. No auth yet.

use std::path::PathBuf;

use rmcp::{
    ErrorData as McpError, ServerHandler,
    handler::server::router::tool::ToolRouter,
    model::{CallToolResult, ContentBlock},
    tool, tool_handler, tool_router,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    },
};
use tokio_util::sync::CancellationToken;

use crate::settings;

/// Fixed loopback port. Matches the documented `claude mcp add` URL. The old
/// Python server used the same port with the `/sse` path; the native server
/// serves `/mcp` (rmcp 2.2 dropped the legacy dual-endpoint SSE transport).
pub const MCP_PORT: u16 = 22360;

pub fn mcp_url() -> String {
    format!("http://localhost:{MCP_PORT}/mcp")
}

#[derive(Clone)]
pub struct MemexServer {
    tool_router: ToolRouter<MemexServer>,
}

#[tool_router]
impl MemexServer {
    pub fn new() -> Self {
        Self {
            tool_router: Self::tool_router(),
        }
    }

    /// Return the active vault's CLAUDE.md (the wiki authoring instructions).
    /// Resolved live from the active-vault marker so it always reflects the
    /// project currently open in the app.
    #[tool(
        description = "Get the Memex wiki authoring instructions (CLAUDE.md) for the active vault"
    )]
    async fn get_instructions(&self) -> Result<CallToolResult, McpError> {
        let text = match settings::active_vault() {
            Some(root) => {
                let path = PathBuf::from(&root).join("CLAUDE.md");
                std::fs::read_to_string(&path)
                    .unwrap_or_else(|e| format!("(no CLAUDE.md at {}: {e})", path.display()))
            }
            None => "(no active vault open)".to_string(),
        };
        Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
    }
}

#[tool_handler]
impl ServerHandler for MemexServer {}

/// Bind the native MCP server on 127.0.0.1:MCP_PORT and spawn its accept loop on
/// the current tokio runtime. Returns once bound (bind errors propagate).
/// Cancelling `ct` shuts the server down and frees the port.
pub async fn serve(ct: CancellationToken) -> Result<(), String> {
    let service = StreamableHttpService::new(
        || Ok(MemexServer::new()),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default()
            .with_stateful_mode(true)
            // Loopback only + DNS-rebinding protection: a page in a browser
            // can't set an arbitrary Host and reach this, only a local process.
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
