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
/// May a credential be sent to this proxy URL?
///
/// The URL is typed by hand in Settings, and both paths here carry secrets: the
/// account password on login, the license key as a bearer token on ingest. On
/// `http://` to anything but loopback, both go out in the clear — a typo, a
/// paste of the wrong thing, or a downgrade is enough. Loopback stays allowed
/// because that is how the proxy is developed and tested, and traffic on it
/// never leaves the machine.
///
/// The same rule the keyed provider endpoints already use, borrowed rather than
/// restated: two copies of "is this URL safe to put a secret on" is one too
/// many.
fn proxy_url_allowed(url: &str) -> bool {
    crate::providers::override_allowed(url)
}

fn require_safe_proxy(url: &str) -> Result<(), String> {
    if proxy_url_allowed(url) {
        return Ok(());
    }
    Err(format!(
        "Memex Pro URL must be https (or http://localhost while testing) — \
         refusing to send your credentials in the clear to {url:?}"
    ))
}

pub async fn ingest(
    root: &Path,
    proxy_url: &str,
    license_key: &str,
    slug: &str,
    title: &str,
    text: &str,
) -> Result<MemexProResult, String> {
    require_safe_proxy(proxy_url)?;
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
        // Defence in depth: the proxy is meant to return wiki operations, but a
        // compromised or buggy response must not be able to overwrite an
        // immutable raw/ source. Same rule the command and agent-tool layers
        // enforce.
        if crate::vault::is_raw_path(root, &target) {
            return Err(format!("refused: raw/ is immutable: {}", op.path));
        }
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

// ---- account login --------------------------------------------------------

#[derive(Deserialize)]
struct LoginLicense {
    key: String,
    #[serde(default)]
    exp: i64,
}

#[derive(Deserialize)]
struct LoginAccount {
    #[serde(default)]
    email: String,
    #[serde(default)]
    license: Option<LoginLicense>,
}

#[derive(Deserialize)]
struct LoginResponse {
    #[serde(default)]
    account: Option<LoginAccount>,
    #[serde(default)]
    error: Option<String>,
}

/// Outcome of a Memex Pro account login. `license_key` is the access key fetched
/// for the account (None when the account has no active access granted yet).
#[derive(Debug, Clone, Serialize)]
pub struct LoginOutcome {
    pub email: String,
    /// True when a usable license key was obtained (account has active access).
    pub connected: bool,
    pub license_key: Option<String>,
    pub exp: i64,
}

/// Log in to the Memex Pro proxy with the account created on the website and
/// fetch its access key. The app then uses that key for ingest — the user never
/// copies a key by hand.
pub async fn login(proxy_url: &str, email: &str, password: &str) -> Result<LoginOutcome, String> {
    require_safe_proxy(proxy_url)?;
    let url = format!("{}/auth/login", proxy_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "email": email, "password": password }))
        .send()
        .await
        .map_err(|e| format!("Memex Pro login failed: {e}"))?;
    let status = resp.status();
    let bytes = read_capped(resp, MAX_RESPONSE_BYTES).await?;
    let parsed: LoginResponse =
        serde_json::from_slice(&bytes).map_err(|e| format!("Memex Pro login parse: {e}"))?;
    if !status.is_success() {
        return Err(parsed
            .error
            .unwrap_or_else(|| format!("Memex Pro login {status}")));
    }
    let account = parsed
        .account
        .ok_or_else(|| "no account in login response".to_string())?;
    let resolved_email = if account.email.is_empty() {
        email.to_string()
    } else {
        account.email
    };
    Ok(match account.license {
        Some(l) => LoginOutcome {
            email: resolved_email,
            connected: true,
            license_key: Some(l.key),
            exp: l.exp,
        },
        None => LoginOutcome {
            email: resolved_email,
            connected: false,
            license_key: None,
            exp: 0,
        },
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

    /// The proxy URL is typed by hand in Settings. If it reads `http://`, login
    /// POSTs the account password in the clear and ingest sends the license key
    /// as a bearer token in the clear.
    #[tokio::test]
    async fn plaintext_http_is_refused_for_a_remote_proxy() {
        let err = login("http://pro.example.com", "a@b.c", "hunter2")
            .await
            .expect_err("cleartext password must be refused");
        assert!(err.contains("https"), "the error must say why: {err}");

        let err = ingest(
            Path::new("/tmp"),
            "http://pro.example.com",
            "license-key",
            "slug",
            "title",
            "text",
        )
        .await
        .expect_err("cleartext license key must be refused");
        assert!(err.contains("https"), "the error must say why: {err}");
    }

    /// A scheme we do not understand is not a free pass. Asserting on the
    /// MESSAGE, not just is_err(): these would fail at the network layer anyway,
    /// so a bare is_err() passes with the guard removed and tests nothing.
    #[tokio::test]
    async fn a_non_http_url_is_refused_by_the_check_not_by_the_network() {
        for url in ["ftp://pro.example.com", "pro.example.com", ""] {
            let err = login(url, "a@b.c", "p").await.expect_err("must refuse");
            assert!(
                err.contains("must be https"),
                "{url:?} should be refused by the URL check, got: {err}"
            );
        }
    }

    /// Loopback stays usable: that is how the proxy is developed and tested,
    /// and a password on the loopback interface never leaves the machine.
    #[test]
    fn loopback_http_is_allowed() {
        assert!(proxy_url_allowed("http://localhost:8787"));
        assert!(proxy_url_allowed("http://127.0.0.1:8787/base"));
        assert!(proxy_url_allowed("https://pro.example.com"));
        assert!(!proxy_url_allowed("http://pro.example.com"));
        assert!(!proxy_url_allowed("http://127.0.0.1.evil.com"));
    }

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
    fn a_raw_write_op_is_caught_by_the_immutability_guard() {
        // safe_join permits raw/ (it only blocks escapes), so the ingest loop
        // relies on is_raw_path to refuse a proxy op that targets raw/. Verify
        // the composition the loop performs.
        let root = Path::new("/vault");
        let raw = safe_join(root, "raw/attention.md").unwrap();
        assert!(crate::vault::is_raw_path(root, &raw));
        let wiki = safe_join(root, "wiki/attention.md").unwrap();
        assert!(!crate::vault::is_raw_path(root, &wiki));
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
