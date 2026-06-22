// Memex Pro provider — the subscription ingest path.
//
// Instead of running a model locally (the claude CLI) the app sends the vault
// snapshot to the Memex Pro proxy, which runs a cheap model THE SERVICE pays for
// and returns the wiki file operations to apply. The app stores only the proxy
// URL (settings) and the license key (OS keychain) — the model and billing live
// server-side. This is a generic client: it POSTs to a configurable URL and
// applies confined writes; it contains none of the proxy/billing mechanism.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

const REQUEST_TIMEOUT_SECS: u64 = 300;
// Keep the snapshot we upload under the proxy's payload cap.
const MAX_PAGES_BYTES: usize = 3 * 1024 * 1024;
const MAX_RESPONSE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Serialize)]
struct WikiPage {
    filename: String,
    content: String,
}

#[derive(Serialize)]
struct SourceDoc<'a> {
    slug: &'a str,
    title: &'a str,
    text: &'a str,
}

#[derive(Serialize)]
struct IngestRequest<'a> {
    source: SourceDoc<'a>,
    schema: String,
    pages: Vec<WikiPage>,
}

#[derive(Deserialize)]
struct FileOperation {
    op: String,
    path: String,
    content: String,
}

#[derive(Deserialize)]
struct IngestResponse {
    #[serde(default)]
    operations: Vec<FileOperation>,
    #[serde(default)]
    summary: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MemexProResult {
    pub summary: String,
    pub applied: usize,
    pub paths: Vec<String>,
}

/// Ingest one source through the Memex Pro proxy and apply the result to `root`.
pub async fn ingest(
    root: &Path,
    proxy_url: &str,
    license_key: &str,
    slug: &str,
    title: &str,
    text: &str,
) -> Result<MemexProResult, String> {
    let pages = collect_pages(root);
    let schema = std::fs::read_to_string(root.join("CLAUDE.md")).unwrap_or_default();
    let body = IngestRequest {
        source: SourceDoc { slug, title, text },
        schema,
        pages,
    };

    let url = format!("{}/v1/ingest", proxy_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let resp = client
        .post(&url)
        .bearer_auth(license_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Memex Pro request failed: {e}"))?;
    let status = resp.status();
    let bytes = read_capped(resp, MAX_RESPONSE_BYTES).await?;
    if !status.is_success() {
        return Err(format!(
            "Memex Pro {}: {}",
            status,
            String::from_utf8_lossy(&bytes)
        ));
    }
    let parsed: IngestResponse =
        serde_json::from_slice(&bytes).map_err(|e| format!("Memex Pro response parse: {e}"))?;

    let mut paths = Vec::new();
    for op in &parsed.operations {
        if op.op != "write" {
            continue;
        }
        let target = safe_join(root, &op.path)?;
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create dir {}: {e}", parent.display()))?;
        }
        crate::vault::write_file(&target.to_string_lossy(), &op.content)?;
        paths.push(op.path.clone());
    }

    Ok(MemexProResult {
        summary: if parsed.summary.is_empty() {
            "ingest complete".to_string()
        } else {
            parsed.summary
        },
        applied: paths.len(),
        paths,
    })
}

/// Join a proxy-returned, vault-root-relative path under `root`, rejecting any
/// path that could escape the vault (absolute, backslash, or `..` segment).
fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let r = rel.trim();
    if r.is_empty() || r.starts_with('/') || r.contains('\\') || r.contains('\0') {
        return Err(format!("unsafe operation path: {rel}"));
    }
    if r.split('/').any(|seg| seg == ".." || seg == ".") {
        return Err(format!("unsafe operation path: {rel}"));
    }
    Ok(root.join(r))
}

/// Read every wiki/*.md page under `root` into the upload snapshot, bounded so a
/// large vault can't exceed the proxy's payload cap.
fn collect_pages(root: &Path) -> Vec<WikiPage> {
    let wiki = root.join("wiki");
    let mut out = Vec::new();
    let mut total = 0usize;
    let mut stack = vec![wiki.clone()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().and_then(|e| e.to_str()) == Some("md") {
                let Ok(content) = std::fs::read_to_string(&p) else {
                    continue;
                };
                if total + content.len() > MAX_PAGES_BYTES {
                    continue;
                }
                total += content.len();
                if let Ok(rel) = p.strip_prefix(&wiki) {
                    out.push(WikiPage {
                        filename: rel.to_string_lossy().replace('\\', "/"),
                        content,
                    });
                }
            }
        }
    }
    out.sort_by(|a, b| a.filename.cmp(&b.filename));
    out
}

async fn read_capped(resp: reqwest::Response, max: usize) -> Result<Vec<u8>, String> {
    if let Some(len) = resp.content_length() {
        if len as usize > max {
            return Err(format!("response too large: {len} bytes"));
        }
    }
    let mut resp = resp;
    let mut buf = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        if buf.len() + chunk.len() > max {
            return Err(format!("response too large: exceeds {max} bytes"));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_join_allows_wiki_paths_rejects_escape() {
        let root = Path::new("/vault");
        assert_eq!(
            safe_join(root, "wiki/concepts/x.md").unwrap(),
            Path::new("/vault/wiki/concepts/x.md")
        );
        assert!(safe_join(root, "../etc/passwd").is_err());
        assert!(safe_join(root, "/etc/passwd").is_err());
        assert!(safe_join(root, "wiki/../../escape.md").is_err());
        assert!(safe_join(root, "a\\b.md").is_err());
        assert!(safe_join(root, "").is_err());
    }

    #[test]
    fn collect_pages_reads_wiki_markdown() {
        let dir = std::env::temp_dir().join(format!("memex-pro-pages-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("wiki/sub")).unwrap();
        std::fs::write(dir.join("wiki/a.md"), "alpha").unwrap();
        std::fs::write(dir.join("wiki/sub/b.md"), "beta").unwrap();
        std::fs::write(dir.join("wiki/ignore.txt"), "x").unwrap();
        let pages = collect_pages(&dir);
        let names: Vec<&str> = pages.iter().map(|p| p.filename.as_str()).collect();
        assert_eq!(names, vec!["a.md", "sub/b.md"]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
