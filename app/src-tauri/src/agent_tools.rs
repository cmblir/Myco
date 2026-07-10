// In-process agent tool registry (Feature 4). A typed set of tools the in-app
// agent loop can call, each reusing an existing domain function (search, read,
// link-graph neighbours, provenance) rather than spawning the external MCP
// server. Read tools are always available; WRITE tools (`create_page`,
// `update_page`) are gated by an `allow_write` flag the caller only sets after
// the user confirms the specific call in the UI, and are ALWAYS refused against
// `raw/` — source immutability outranks the agent (project CLAUDE.md).
//
// `dispatch` is pure over a `vault_root` string (no Tauri runtime), so every
// handler is unit-testable against a temp vault.

use serde_json::{json, Value};
use std::path::Path;

use crate::{index, provenance, vault};

/// A tool the model can call: name, human description, and a JSON Schema for its
/// arguments. Sent to the provider so it knows what it may invoke.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ToolDescriptor {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
    /// True for tools that mutate the vault (need per-call user confirmation).
    pub write: bool,
}

fn schema(props: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": props,
        "required": required,
    })
}

/// The full tool set, in a stable order. `write` tools are surfaced to the model
/// only when the UI has write-mode enabled (the loop filters on `.write`).
pub fn descriptors() -> Vec<ToolDescriptor> {
    vec![
        ToolDescriptor {
            name: "search_vault",
            description: "Full-text search the wiki for a query string. Returns matching pages with a snippet.",
            input_schema: schema(
                json!({
                    "query": { "type": "string", "description": "text to search for" },
                    "limit": { "type": "integer", "description": "max results (default 10)" }
                }),
                &["query"],
            ),
            write: false,
        },
        ToolDescriptor {
            name: "read_page",
            description: "Read a wiki page's markdown by its vault-relative or absolute path.",
            input_schema: schema(
                json!({ "path": { "type": "string", "description": "page path, e.g. wiki/attention.md" } }),
                &["path"],
            ),
            write: false,
        },
        ToolDescriptor {
            name: "list_pages",
            description: "List every wiki page path in the vault.",
            input_schema: schema(json!({}), &[]),
            write: false,
        },
        ToolDescriptor {
            name: "page_links",
            description: "Get the outbound and inbound wikilink neighbours of a page (graph traversal).",
            input_schema: schema(
                json!({ "path": { "type": "string", "description": "page path" } }),
                &["path"],
            ),
            write: false,
        },
        ToolDescriptor {
            name: "provenance",
            description: "List pages with their citation coverage (cited vs total claims), lowest first — find under-cited pages.",
            input_schema: schema(
                json!({ "limit": { "type": "integer", "description": "max rows (default 20)" } }),
                &[],
            ),
            write: false,
        },
        ToolDescriptor {
            name: "create_page",
            description: "Create a NEW wiki page with the given markdown content. Fails if it already exists. Never writes under raw/.",
            input_schema: schema(
                json!({
                    "path": { "type": "string", "description": "new page path, e.g. wiki/summary.md" },
                    "content": { "type": "string", "description": "full markdown body" }
                }),
                &["path", "content"],
            ),
            write: true,
        },
        ToolDescriptor {
            name: "update_page",
            description: "Overwrite an existing wiki page with new markdown content. Never writes under raw/.",
            input_schema: schema(
                json!({
                    "path": { "type": "string", "description": "existing page path" },
                    "content": { "type": "string", "description": "full markdown body to write" }
                }),
                &["path", "content"],
            ),
            write: true,
        },
    ]
}

fn arg_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("missing string argument '{key}'"))
}

fn arg_usize(args: &Value, key: &str, default: usize) -> usize {
    args.get(key)
        .and_then(|v| v.as_u64())
        .map(|n| n as usize)
        .unwrap_or(default)
}

/// Resolve a tool-supplied path (which may be vault-relative like
/// "wiki/a.md" or already absolute) to an absolute path under the vault, so
/// `confine_path` (which expects an absolute path) works either way.
fn resolve(root: &Path, path: &str) -> String {
    let p = Path::new(path);
    if p.is_absolute() {
        path.to_string()
    } else {
        root.join(p).to_string_lossy().into_owned()
    }
}

/// True if the confined path lies inside the vault's immutable `raw/` tree.
fn is_raw_path(root: &Path, confined: &Path) -> bool {
    confined
        .strip_prefix(root)
        .ok()
        .and_then(|rel| rel.components().next())
        .map(|c| c.as_os_str() == "raw")
        .unwrap_or(false)
}

/// Execute a tool call. Returns a JSON value on success or an error string the
/// loop feeds back to the model as a tool_result so it can recover.
pub fn dispatch(
    vault_root: &str,
    name: &str,
    args: &Value,
    allow_write: bool,
) -> Result<Value, String> {
    let root = Path::new(vault_root);
    if !root.is_dir() {
        return Err(format!("vault root is not a directory: {vault_root}"));
    }
    match name {
        "search_vault" => {
            let query = arg_str(args, "query")?;
            let limit = arg_usize(args, "limit", 10);
            let hits = vault::search_vault(root, &query, limit);
            Ok(json!({ "hits": hits }))
        }
        "read_page" => {
            let path = arg_str(args, "path")?;
            let confined = vault::confine_path(root, &resolve(root, &path))?;
            let file = vault::read_file(&confined.to_string_lossy())?;
            Ok(json!({ "path": file.path, "content": file.content }))
        }
        "list_pages" => {
            let graph = index::build_link_graph(&root.to_string_lossy())?;
            let pages: Vec<&String> = graph.forward.keys().collect();
            Ok(json!({ "pages": pages }))
        }
        "page_links" => {
            let path = arg_str(args, "path")?;
            let confined = vault::confine_path(root, &resolve(root, &path))?;
            let key = confined.to_string_lossy().to_string();
            let graph = index::build_link_graph(&root.to_string_lossy())?;
            Ok(json!({
                "outbound": graph.forward.get(&key).cloned().unwrap_or_default(),
                "inbound": graph.backward.get(&key).cloned().unwrap_or_default(),
            }))
        }
        "provenance" => {
            let limit = arg_usize(args, "limit", 20);
            let mut rows = provenance::scan_provenance(&root.to_string_lossy())?;
            // Lowest coverage first so the model sees the weakest pages.
            rows.sort_by(|a, b| {
                let ra = a.cited as f64 / (a.total.max(1) as f64);
                let rb = b.cited as f64 / (b.total.max(1) as f64);
                ra.partial_cmp(&rb).unwrap_or(std::cmp::Ordering::Equal)
            });
            rows.truncate(limit);
            Ok(json!({ "rows": rows }))
        }
        "create_page" | "update_page" => {
            if !allow_write {
                return Err(format!(
                    "tool '{name}' requires write confirmation, which was not granted"
                ));
            }
            let path = arg_str(args, "path")?;
            let content = arg_str(args, "content")?;
            let confined = vault::confine_path(root, &resolve(root, &path))?;
            if is_raw_path(root, &confined) {
                return Err("refused: raw/ is immutable and cannot be written".into());
            }
            let exists = confined.exists();
            if name == "create_page" && exists {
                return Err(format!("refused: {path} already exists (use update_page)"));
            }
            if name == "update_page" && !exists {
                return Err(format!("refused: {path} does not exist (use create_page)"));
            }
            vault::write_file(&confined.to_string_lossy(), &content)?;
            Ok(json!({ "written": confined.to_string_lossy(), "bytes": content.len() }))
        }
        other => Err(format!("unknown tool: {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_vault() -> std::path::PathBuf {
        // A process-wide atomic counter guarantees a unique dir per test even
        // when tests run concurrently (a timestamp alone can collide).
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let base = std::env::temp_dir().join(format!(
            "memex-agent-tools-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(base.join("wiki")).unwrap();
        fs::create_dir_all(base.join("raw")).unwrap();
        fs::write(
            base.join("wiki/attention.md"),
            "# Attention\n\nScaled dot-product attention over [[embeddings]].\n",
        )
        .unwrap();
        fs::write(base.join("raw/source.md"), "raw source\n").unwrap();
        // Canonicalize: on macOS temp_dir is /var/... which canonicalizes to
        // /private/var/..., and confine_path compares against the canonical form.
        base.canonicalize().unwrap()
    }

    #[test]
    fn descriptors_expose_read_and_write_tools() {
        let d = descriptors();
        assert!(d.iter().any(|t| t.name == "search_vault" && !t.write));
        assert!(d.iter().any(|t| t.name == "create_page" && t.write));
        // Every write tool must be flagged so the loop can gate it.
        assert!(d.iter().filter(|t| t.write).count() >= 2);
    }

    #[test]
    fn search_and_read_roundtrip() {
        let v = temp_vault();
        let root = v.to_string_lossy();
        let hits = dispatch(&root, "search_vault", &json!({ "query": "attention" }), false).unwrap();
        assert!(!hits["hits"].as_array().unwrap().is_empty());
        let page = dispatch(
            &root,
            "read_page",
            &json!({ "path": "wiki/attention.md" }),
            false,
        )
        .unwrap();
        assert!(page["content"].as_str().unwrap().contains("Scaled dot-product"));
        fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn write_tools_require_confirmation() {
        let v = temp_vault();
        let root = v.to_string_lossy();
        let denied = dispatch(
            &root,
            "create_page",
            &json!({ "path": "wiki/new.md", "content": "x" }),
            false,
        );
        assert!(denied.is_err(), "unconfirmed write must be refused");
        let ok = dispatch(
            &root,
            "create_page",
            &json!({ "path": "wiki/new.md", "content": "hello" }),
            true,
        );
        assert!(ok.is_ok(), "confirmed write should succeed");
        assert!(v.join("wiki/new.md").is_file());
        fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn writes_to_raw_are_refused_even_when_confirmed() {
        let v = temp_vault();
        let root = v.to_string_lossy();
        let res = dispatch(
            &root,
            "update_page",
            &json!({ "path": "raw/source.md", "content": "tampered" }),
            true,
        );
        assert!(res.is_err(), "raw/ must be immutable");
        // The original file is untouched.
        let body = fs::read_to_string(v.join("raw/source.md")).unwrap();
        assert_eq!(body, "raw source\n");
        fs::remove_dir_all(&v).ok();
    }

    #[test]
    fn create_refuses_existing_update_refuses_missing() {
        let v = temp_vault();
        let root = v.to_string_lossy();
        assert!(dispatch(
            &root,
            "create_page",
            &json!({ "path": "wiki/attention.md", "content": "x" }),
            true
        )
        .is_err());
        assert!(dispatch(
            &root,
            "update_page",
            &json!({ "path": "wiki/ghost.md", "content": "x" }),
            true
        )
        .is_err());
        fs::remove_dir_all(&v).ok();
    }
}
