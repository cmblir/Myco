// Phase 0 spike harness (throwaway): boot ONLY the native MCP server so a
// `--transport http` client round-trip can be proven without launching the full
// Tauri app. Delete after Phase 0 sign-off.

use memex_lib::mcp_native;
use tokio_util::sync::CancellationToken;

#[tokio::main]
async fn main() {
    let ct = CancellationToken::new();
    mcp_native::serve(ct).await.expect("serve failed");
    println!("native MCP server up at {}", mcp_native::mcp_url());
    tokio::signal::ctrl_c().await.ok();
}
