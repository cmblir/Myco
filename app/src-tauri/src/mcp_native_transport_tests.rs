//! Authenticated Streamable HTTP tests against the exposed MCP tool router.
//! Every filesystem target is synthetic and the server never uses app settings
//! to resolve a vault, starts a GUI, loads a model or reads a private corpus.

use super::*;
use sha2::{Digest, Sha256};

const TOKEN: &str = "synthetic-mcp-transport-token";
const PAGE: &str = "---\ntitle: Synthetic note\ntype: concept\nsource_count: 0\n---\n# Synthetic note\n\nOriginal synthetic content.\n";

struct TestServer {
    url: String,
    client: reqwest::Client,
    session: String,
    cancel: CancellationToken,
    handle: tokio::task::JoinHandle<()>,
}

impl TestServer {
    async fn start(root: &Path) -> Self {
        let server = McpServer::for_test_root(root.to_path_buf());
        Self::start_vault(server.test_vault.unwrap()).await
    }

    async fn start_vault(state: std::sync::Arc<commands::VaultRoot>) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let cancel = CancellationToken::new();
        let service = StreamableHttpService::new(
            move || Ok(McpServer::for_test_vault(state.clone())),
            LocalSessionManager::default().into(),
            StreamableHttpServerConfig::default()
                .with_stateful_mode(true)
                .with_json_response(true)
                .with_allowed_hosts([addr.to_string()])
                .with_cancellation_token(cancel.clone()),
        );
        let router = axum::Router::new().nest_service("/mcp", service).layer(
            axum::middleware::from_fn_with_state(
                std::sync::Arc::new(TOKEN.to_string()),
                require_bearer,
            ),
        );
        let shutdown = cancel.clone();
        let handle = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(shutdown.cancelled_owned())
                .await
                .unwrap();
        });
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .unwrap();
        let url = format!("http://{addr}/mcp");
        let response = client
            .post(&url)
            .bearer_auth(TOKEN)
            .header("Accept", "application/json, text/event-stream")
            .json(&json!({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {
                    "protocolVersion": "2025-11-25", "capabilities": {},
                    "clientInfo": { "name": "synthetic-transport-test", "version": "1" }
                }
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        let session = response
            .headers()
            .get("mcp-session-id")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        let body = rpc_body(response).await;
        assert_eq!(body["result"]["serverInfo"]["name"], "myco");
        let server = Self {
            url,
            client,
            session,
            cancel,
            handle,
        };
        let initialized = server
            .request(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .await;
        assert_eq!(initialized.status(), reqwest::StatusCode::ACCEPTED);
        server
    }

    async fn request(&self, body: Value) -> reqwest::Response {
        self.client
            .post(&self.url)
            .bearer_auth(TOKEN)
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", "2025-11-25")
            .header("MCP-Session-Id", &self.session)
            .json(&body)
            .send()
            .await
            .unwrap()
    }

    async fn rpc(&self, method: &str, params: Value) -> Value {
        let response = self
            .request(json!({
                "jsonrpc": "2.0", "id": 2, "method": method, "params": params
            }))
            .await;
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        rpc_body(response).await
    }

    async fn tool(&self, name: &str, arguments: Value) -> Value {
        let response = self
            .rpc(
                "tools/call",
                json!({ "name": name, "arguments": arguments }),
            )
            .await;
        assert!(response.get("error").is_none(), "{response}");
        serde_json::from_str(response["result"]["content"][0]["text"].as_str().unwrap()).unwrap()
    }

    async fn stop(self) {
        self.cancel.cancel();
        self.handle.await.unwrap();
    }
}

async fn rpc_body(response: reqwest::Response) -> Value {
    let text = response.text().await.unwrap();
    if let Some(data) = text
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .find(|data| !data.is_empty())
    {
        serde_json::from_str(data)
            .unwrap_or_else(|error| panic!("invalid SSE data: {error}: {text}"))
    } else {
        serde_json::from_str(&text)
            .unwrap_or_else(|error| panic!("invalid RPC body: {error}: {text}"))
    }
}

fn write(root: &Path, rel: &str, text: &str) {
    let target = root.join(rel);
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(target, text).unwrap();
}

fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

#[tokio::test]
async fn transport_auth_and_normal_read_use_the_exposed_router() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "wiki/synthetic.md", PAGE);
    let server = TestServer::start(dir.path()).await;
    let denied = server
        .client
        .post(&server.url)
        .header("Accept", "application/json, text/event-stream")
        .json(&json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/list" }))
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), reqwest::StatusCode::UNAUTHORIZED);
    let read = server
        .tool("read_page", json!({ "filename": "synthetic.md" }))
        .await;
    assert_eq!(read["ok"], true, "{read}");
    assert!(read["content"]
        .as_str()
        .unwrap()
        .contains("Original synthetic"));
    server.stop().await;
}

#[cfg(unix)]
#[tokio::test]
async fn transport_legacy_update_rejects_raw_and_external_symlink_targets() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    write(dir.path(), "raw/synthetic.md", PAGE);
    write(outside.path(), "synthetic.md", PAGE);
    std::fs::create_dir(dir.path().join("wiki")).unwrap();
    std::os::unix::fs::symlink(dir.path().join("raw"), dir.path().join("wiki/raw-link")).unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("wiki/outside-link")).unwrap();
    let server = TestServer::start(dir.path()).await;
    for filename in ["raw-link/synthetic.md", "outside-link/synthetic.md"] {
        let result = server
            .tool(
                "update_page",
                json!({
                    "filename": filename, "content": PAGE.replace("Original", "Changed"),
                    "expected_sha256": hash(PAGE)
                }),
            )
            .await;
        assert_eq!(result["ok"], false, "{filename}: {result}");
    }
    assert_eq!(
        std::fs::read_to_string(dir.path().join("raw/synthetic.md")).unwrap(),
        PAGE
    );
    assert_eq!(
        std::fs::read_to_string(outside.path().join("synthetic.md")).unwrap(),
        PAGE
    );
    server.stop().await;
}

#[cfg(unix)]
#[tokio::test]
async fn transport_reads_and_resources_reject_external_and_raw_wiki_aliases() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    write(dir.path(), "raw/synthetic.md", PAGE);
    write(outside.path(), "synthetic.md", PAGE);
    std::fs::create_dir(dir.path().join("wiki")).unwrap();
    std::os::unix::fs::symlink(dir.path().join("raw"), dir.path().join("wiki/raw-link")).unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("wiki/outside-link")).unwrap();
    let server = TestServer::start(dir.path()).await;
    for filename in ["raw-link/synthetic.md", "outside-link/synthetic.md"] {
        let read = server
            .tool("read_page", json!({ "filename": filename }))
            .await;
        assert_eq!(read["ok"], false, "{read}");
        let resource = server
            .rpc(
                "resources/read",
                json!({ "uri": format!("myco://wiki/{filename}") }),
            )
            .await;
        assert!(resource.get("error").is_some(), "{resource}");
    }
    server.stop().await;
}

#[cfg(unix)]
#[tokio::test]
async fn transport_legacy_create_and_folder_reject_symlink_ancestors() {
    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("raw")).unwrap();
    std::fs::create_dir(dir.path().join("wiki")).unwrap();
    std::os::unix::fs::symlink(dir.path().join("raw"), dir.path().join("wiki/raw-link")).unwrap();
    std::os::unix::fs::symlink(outside.path(), dir.path().join("wiki/outside-link")).unwrap();
    let server = TestServer::start(dir.path()).await;
    for folder in ["raw-link", "outside-link"] {
        let created = server
            .tool(
                "create_page",
                json!({
                    "title": "Synthetic new", "page_type": "concept", "folder": folder,
                    "content": "Synthetic body."
                }),
            )
            .await;
        assert_eq!(created["ok"], false, "{created}");
        let created = server
            .tool(
                "create_folder",
                json!({ "parent": folder, "name": "nested" }),
            )
            .await;
        assert_eq!(created["ok"], false, "{created}");
    }
    assert_eq!(
        std::fs::read_dir(dir.path().join("raw")).unwrap().count(),
        0
    );
    assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
    server.stop().await;
}

#[tokio::test]
async fn transport_checked_and_legacy_updates_require_the_exact_read_revision() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "wiki/synthetic.md", PAGE);
    let server = TestServer::start(dir.path()).await;
    let read = server
        .tool("read_page", json!({ "filename": "synthetic.md" }))
        .await;
    assert_eq!(read["sha256"], hash(PAGE), "{read}");
    for name in ["write_page", "update_page"] {
        let args = if name == "write_page" {
            json!({ "path": "wiki/synthetic.md", "text": PAGE, "mode": "update", "force": true })
        } else {
            json!({ "filename": "synthetic.md", "content": PAGE })
        };
        let refused = server.tool(name, args).await;
        assert_eq!(refused["ok"], false, "{name}: {refused}");
    }
    let human_edit = format!("{PAGE}\nSynthetic human annotation.\n");
    write(dir.path(), "wiki/synthetic.md", &human_edit);
    for name in ["write_page", "update_page"] {
        let args = if name == "write_page" {
            json!({ "path": "wiki/synthetic.md", "text": PAGE, "mode": "update", "force": true, "expected_sha256": hash(PAGE) })
        } else {
            json!({ "filename": "synthetic.md", "content": PAGE, "expected_sha256": hash(PAGE) })
        };
        let refused = server.tool(name, args).await;
        assert_eq!(refused["ok"], false, "{name}: {refused}");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("wiki/synthetic.md")).unwrap(),
            human_edit
        );
    }
    let changed = format!("{human_edit}\nChecked generated addition.\n");
    let result = server
        .tool(
            "update_page",
            json!({
                "filename": "synthetic.md", "content": changed, "expected_sha256": hash(&human_edit)
            }),
        )
        .await;
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("wiki/synthetic.md")).unwrap(),
        changed
    );
    server.stop().await;
}

#[cfg(unix)]
#[tokio::test]
async fn transport_task_and_metadata_mutations_reject_raw_aliases() {
    let dir = tempfile::tempdir().unwrap();
    let original = format!("{PAGE}\n- [ ] Synthetic task\n");
    write(dir.path(), "raw/synthetic.md", &original);
    std::fs::create_dir(dir.path().join("wiki")).unwrap();
    std::os::unix::fs::symlink(dir.path().join("raw"), dir.path().join("wiki/raw-link")).unwrap();
    for name in ["profile.md", "CHANGELOG.md"] {
        std::os::unix::fs::symlink(dir.path().join("raw/synthetic.md"), dir.path().join(name))
            .unwrap();
    }
    let server = TestServer::start(dir.path()).await;
    for (name, args) in [
        (
            "add_task",
            json!({ "page": "wiki/raw-link/synthetic.md", "text": "New synthetic task" }),
        ),
        (
            "set_task_status",
            json!({ "page": "wiki/raw-link/synthetic.md", "line": original.lines().count(), "status": "done", "expect_text": "Synthetic task" }),
        ),
        ("setup_profile", json!({ "role": "Synthetic role" })),
        ("append_changelog", json!({ "entry": "Synthetic entry" })),
    ] {
        let result = server.tool(name, args).await;
        assert_eq!(result["ok"], false, "{name}: {result}");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("raw/synthetic.md")).unwrap(),
            original
        );
    }
    server.stop().await;
}

#[cfg(unix)]
#[tokio::test]
async fn transport_raw_and_inbox_mutations_reject_external_ancestors() {
    for namespace in ["raw", "_inbox", ".myco"] {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), dir.path().join(namespace)).unwrap();
        if namespace == "_inbox" {
            write(outside.path(), "synthetic.md", PAGE);
        }
        let server = TestServer::start(dir.path()).await;
        let (name, args) = match namespace {
            "raw" => (
                "add_raw_source",
                json!({ "filename": "synthetic.md", "content": PAGE }),
            ),
            "_inbox" => (
                "archive_inbox_source",
                json!({ "filename": "synthetic.md" }),
            ),
            _ => (
                "import_conversation",
                json!({ "raw_text": PAGE, "source": "codex", "conversation_id": "synthetic" }),
            ),
        };
        let result = server.tool(name, args).await;
        assert_eq!(result["ok"], false, "{namespace}: {result}");
        if namespace == "_inbox" {
            assert_eq!(
                std::fs::read_to_string(outside.path().join("synthetic.md")).unwrap(),
                PAGE
            );
        } else {
            assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
        }
        server.stop().await;
    }
}

fn open(state: &commands::VaultRoot, root: &Path) {
    let generation = state.begin_open().unwrap();
    state
        .finish_open(generation, root.canonicalize().unwrap(), || ())
        .unwrap();
}

#[tokio::test]
async fn transport_old_sessions_refuse_switch_reopen_failed_open_and_close() {
    for transition in ["switch", "reopen", "failed-open", "close"] {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        write(first.path(), "wiki/synthetic.md", PAGE);
        write(second.path(), "wiki/synthetic.md", PAGE);
        let state = std::sync::Arc::new(commands::VaultRoot::default());
        open(&state, first.path());
        let server = TestServer::start_vault(state.clone()).await;
        match transition {
            "switch" => open(&state, second.path()),
            "reopen" => open(&state, first.path()),
            "failed-open" => {
                state.begin_open().unwrap();
            }
            _ => state.close().unwrap(),
        }
        let read = server
            .tool("read_page", json!({ "filename": "synthetic.md" }))
            .await;
        assert_eq!(read["ok"], false, "{transition}: {read}");
        let update = server
            .tool(
                "update_page",
                json!({
                    "filename": "synthetic.md", "content": PAGE.replace("Original", "Changed"),
                    "expected_sha256": hash(PAGE)
                }),
            )
            .await;
        assert_eq!(update["ok"], false, "{transition}: {update}");
        let resource = server
            .rpc(
                "resources/read",
                json!({ "uri": "myco://wiki/synthetic.md" }),
            )
            .await;
        assert!(resource.get("error").is_some(), "{transition}: {resource}");
        for root in [first.path(), second.path()] {
            assert_eq!(
                std::fs::read_to_string(root.join("wiki/synthetic.md")).unwrap(),
                PAGE
            );
        }
        server.stop().await;
    }
}

#[tokio::test]
async fn transport_guarded_writers_and_nested_importer_finish_without_reentrant_locking() {
    let dir = tempfile::tempdir().unwrap();
    let external = tempfile::tempdir().unwrap();
    write(dir.path(), "wiki/synthetic.md", PAGE);
    write(dir.path(), "_inbox/synthetic.md", PAGE);
    let session = external.path().join("synthetic.jsonl");
    let prompt =
        "Review the synthetic project implementation and document each completed task. ".repeat(20);
    let records = [
        json!({"type":"session_meta","timestamp":"2026-10-01T12:00:00Z","payload":{"id":"synthetic-session","cwd":"/synthetic"}}),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":prompt}]}}),
        json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Synthetic review completed."}]}}),
    ];
    std::fs::write(
        &session,
        records
            .iter()
            .map(|row| format!("{row}\n"))
            .collect::<String>(),
    )
    .unwrap();
    let server = TestServer::start(dir.path()).await;
    for (name, args) in [
        ("write_page", json!({"path":"wiki/new.md","text":PAGE})),
        (
            "create_page",
            json!({"title":"Legacy synthetic","page_type":"concept","content":"Synthetic body."}),
        ),
        ("create_folder", json!({"name":"synthetic-folder"})),
        ("setup_profile", json!({"role":"Synthetic role"})),
        ("append_changelog", json!({"entry":"Synthetic entry"})),
        (
            "add_raw_source",
            json!({"filename":"added.md","content":PAGE}),
        ),
        ("archive_inbox_source", json!({"filename":"synthetic.md"})),
        (
            "import_conversation",
            json!({"raw_text":"Synthetic conversation body.","source":"codex","conversation_id":"synthetic-conversation"}),
        ),
        (
            "import_session",
            json!({"jsonl_path":session,"dest":"sessions"}),
        ),
        ("wikify_pending", json!({"limit":3})),
        ("ledger_status", json!({})),
        ("register_vault", json!({})),
        ("export_project", json!({})),
    ] {
        let result = server.tool(name, args).await;
        assert_eq!(result["ok"], true, "{name}: {result}");
    }
    server.stop().await;
}

#[tokio::test]
async fn transport_session_initialized_without_an_open_vault_does_not_retarget_later() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "wiki/synthetic.md", PAGE);
    let state = std::sync::Arc::new(commands::VaultRoot::default());
    let server = TestServer::start_vault(state.clone()).await;
    open(&state, dir.path());
    let read = server
        .tool("read_page", json!({"filename":"synthetic.md"}))
        .await;
    assert_eq!(read["ok"], false, "{read}");
    server.stop().await;
    let initialized = TestServer::start_vault(state).await;
    let read = initialized
        .tool("read_page", json!({"filename":"synthetic.md"}))
        .await;
    assert_eq!(read["ok"], true, "{read}");
    initialized.stop().await;
}

#[cfg(unix)]
#[tokio::test]
async fn transport_ancillary_writers_refuse_hard_link_aliases_of_raw() {
    for state_path in [".myco/inflow-log.jsonl", ".myco/wikify-pending.json.tmp"] {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "raw/synthetic.md", PAGE);
        std::fs::create_dir(dir.path().join(".myco")).unwrap();
        std::fs::hard_link(
            dir.path().join("raw/synthetic.md"),
            dir.path().join(state_path),
        )
        .unwrap();
        let server = TestServer::start(dir.path()).await;
        let (name, args) = if state_path.ends_with("inflow-log.jsonl") {
            (
                "create_page",
                json!({"title":"Synthetic new","page_type":"concept","content":"Synthetic body."}),
            )
        } else {
            (
                "import_conversation",
                json!({"raw_text":"Synthetic imported body.","source":"codex","conversation_id":"synthetic-hard-link"}),
            )
        };
        let result = server.tool(name, args).await;
        assert_eq!(
            std::fs::read_to_string(dir.path().join("raw/synthetic.md")).unwrap(),
            PAGE,
            "{state_path}: immutable raw bytes changed: {result}"
        );
        assert_eq!(result["ok"], false, "{state_path}: {result}");
        server.stop().await;
    }
}

#[cfg(unix)]
#[tokio::test]
async fn transport_page_cas_replaces_a_hard_link_without_modifying_its_raw_twin() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "raw/synthetic.md", PAGE);
    std::fs::create_dir(dir.path().join("wiki")).unwrap();
    std::fs::hard_link(
        dir.path().join("raw/synthetic.md"),
        dir.path().join("wiki/synthetic.md"),
    )
    .unwrap();
    let server = TestServer::start(dir.path()).await;
    let changed = PAGE.replace("Original", "Changed");
    let result = server
        .tool(
            "update_page",
            json!({
                "filename":"synthetic.md","content":changed,"expected_sha256":hash(PAGE)
            }),
        )
        .await;
    assert_eq!(result["ok"], true, "{result}");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("raw/synthetic.md")).unwrap(),
        PAGE
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("wiki/synthetic.md")).unwrap(),
        changed
    );
    server.stop().await;
}

#[cfg(unix)]
#[tokio::test]
async fn transport_git_side_effects_refuse_a_git_directory_alias_before_page_publish() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "raw/synthetic.md", PAGE);
    std::os::unix::fs::symlink(dir.path().join("raw"), dir.path().join(".git")).unwrap();
    let server = TestServer::start(dir.path()).await;
    let created = server
        .tool(
            "write_page",
            json!({
                "path":"wiki/synthetic.md","text":PAGE,"commit":true
            }),
        )
        .await;
    assert_eq!(created["ok"], false, "{created}");
    assert!(!dir.path().join("wiki/synthetic.md").exists());
    let committed = server
        .tool("git_commit", json!({"message":"Synthetic commit"}))
        .await;
    assert_eq!(committed["ok"], false, "{committed}");
    assert!(
        committed["error"]
            .as_str()
            .unwrap()
            .contains("symbolic link"),
        "{committed}"
    );
    assert_eq!(
        std::fs::read_to_string(dir.path().join("raw/synthetic.md")).unwrap(),
        PAGE
    );
    server.stop().await;
}
