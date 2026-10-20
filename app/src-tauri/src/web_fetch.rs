//! Web-link import (S38): fetch an article URL and hand back its main text as
//! markdown, so a pasted link ingests like a pasted source. Nothing here
//! writes to the vault — the caller puts the text in the ingest box and the
//! normal ingest path (secret/PII scan, judge, raw/ rules) takes it from there.
//!
//! The URL comes from the user's clipboard, i.e. from anywhere, so the fetch
//! is guarded against SSRF:
//! - http/https only, no `user:pass@` credentials;
//! - `localhost`, `*.localhost`, `*.local`, `*.internal` names are refused;
//! - the host is resolved HERE, every address must be public (no loopback,
//!   private, link-local/metadata, CGNAT, multicast, reserved), and the
//!   connection is pinned to the vetted address so a DNS rebind between the
//!   check and the connect cannot swap it;
//! - redirects are followed by hand (max 5), each hop re-vetted from scratch;
//! - no proxy, no cookie store, no auth headers; 5 MB body cap; timeouts.
//!
//! Errors are stable codes (the UI translates them): `bad_url`, `scheme`,
//! `credentials`, `blocked`, `resolve`, `redirect`, `redirects`, `status:<n>`,
//! `not_html`, `too_large`, `timeout`, `network`, `empty`.

use encoding_rs::{Encoding, UTF_16BE, UTF_16LE, UTF_8, WINDOWS_1252, X_USER_DEFINED};
use regex::Regex;
use std::future::Future;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::sync::OnceLock;
use std::time::Duration;
use url::{Host, Url};

const MAX_BYTES: usize = 5 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
/// Per request; the whole chain of up to 6 requests gets `2 * TIMEOUT`.
const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_TITLE: usize = 300;
/// Same ceiling the YouTube transcript path uses for ingest input.
const MAX_MARKDOWN_CHARS: usize = 400_000;
/// A candidate `article`/`main` shorter than this is a teaser, not the story.
const MIN_MAIN_TEXT: usize = 200;
/// Never part of the readable text. `head`/`script`/`style` are also skipped by
/// the md serializer, but removing them here keeps them out of the
/// longest-text pick as well.
const STRIP: &str = "script, style, noscript, template, iframe, object, embed, svg, canvas, \
    form, button, input, select, textarea, dialog, nav, aside, footer, \
    body > header, [hidden], [aria-hidden='true']";

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct WebPage {
    /// Where the text actually came from (after redirects).
    pub url: String,
    pub title: String,
    pub markdown: String,
}

/// Fetch `url` with the SSRF guard and return its readable text.
pub async fn fetch_page(url: &str) -> Result<WebPage, String> {
    fetch_guarded(url, system_resolve, |a| is_public_ip(a.ip()), TIMEOUT).await
}

async fn system_resolve(host: String, port: u16) -> io::Result<Vec<SocketAddr>> {
    tokio::task::spawn_blocking(move || {
        (host.as_str(), port).to_socket_addrs().map(|a| a.collect())
    })
    .await
    .map_err(io::Error::other)?
}

/// True for an address a page fetch may connect to: globally routable unicast.
pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_public_v4(v4),
        IpAddr::V6(v6) => is_public_v6(v6),
    }
}

fn is_public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    let blocked = a == 0 // "this network", incl. 0.0.0.0
        || a == 10
        || a == 127
        || a >= 224 // multicast, reserved, broadcast
        || (a == 100 && (64..128).contains(&b)) // CGNAT
        || (a == 169 && b == 254) // link-local, incl. 169.254.169.254 metadata
        || (a == 172 && (16..32).contains(&b))
        || (a == 192 && b == 168)
        || (a == 192 && b == 0 && (c == 0 || c == 2)) // IETF assignments, docs
        || (a == 198 && (b == 18 || b == 19)) // benchmarking
        || (a == 198 && b == 51 && c == 100) // docs
        || (a == 203 && b == 0 && c == 113); // docs
    !blocked
}

fn is_public_v6(ip: Ipv6Addr) -> bool {
    let s = ip.segments();
    // Forms that carry an IPv4 address are judged by that address:
    // ::a.b.c.d (compatible — also covers :: and ::1), ::ffff:a.b.c.d
    // (mapped), 64:ff9b::a.b.c.d (NAT64) and 2002:AABB:CCDD:: (6to4).
    let v4 = |hi: u16, lo: u16| Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8);
    if s[..5] == [0; 5] && (s[5] == 0 || s[5] == 0xffff) {
        return is_public_v4(v4(s[6], s[7]));
    }
    if s[0] == 0x64 && s[1] == 0xff9b && s[2..6] == [0; 4] {
        return is_public_v4(v4(s[6], s[7]));
    }
    if s[0] == 0x2002 {
        return is_public_v4(v4(s[1], s[2]));
    }
    let blocked = s[0] & 0xff00 == 0xff00 // multicast
        || s[0] & 0xfe00 == 0xfc00 // unique local (ULA)
        || s[0] & 0xffc0 == 0xfe80 // link-local
        || s[0] & 0xffc0 == 0xfec0 // site-local (deprecated)
        || (s[0] == 0x2001 && s[1] == 0x0db8) // docs
        || (s[0] == 0x2001 && s[1] == 0); // Teredo tunnels to an arbitrary v4
    !blocked
}

/// Checks that need no network: scheme, credentials, local-only names.
fn check_target(url: &Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("scheme".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("credentials".into());
    }
    match url.host() {
        Some(Host::Domain(d)) => {
            let d = d.trim_end_matches('.').to_ascii_lowercase();
            let local = d == "localhost"
                || [".localhost", ".local", ".internal"]
                    .iter()
                    .any(|s| d.ends_with(s));
            if local {
                return Err("blocked".into());
            }
            Ok(())
        }
        Some(_) => Ok(()), // IP literals are judged with the resolved ones
        None => Err("bad_url".into()),
    }
}

/// Vet one hop: [`check_target`], then resolve and require every address to
/// pass `allow`. Returns the `(host, addr)` to pin the connection to (None
/// for an IP literal, which needs no lookup).
async fn vet<R, F, A>(
    url: &Url,
    resolve: &R,
    allow: &A,
) -> Result<Option<(String, SocketAddr)>, String>
where
    R: Fn(String, u16) -> F,
    F: Future<Output = io::Result<Vec<SocketAddr>>>,
    A: Fn(SocketAddr) -> bool,
{
    check_target(url)?;
    let port = url.port_or_known_default().ok_or("bad_url")?;
    let (host, addrs) = match url.host() {
        Some(Host::Ipv4(ip)) => (None, vec![SocketAddr::new(ip.into(), port)]),
        Some(Host::Ipv6(ip)) => (None, vec![SocketAddr::new(ip.into(), port)]),
        Some(Host::Domain(d)) => {
            let addrs = resolve(d.to_string(), port).await.map_err(|_| "resolve")?;
            (Some(d.to_string()), addrs)
        }
        None => return Err("bad_url".into()),
    };
    // Any bad address refuses the host: a name that also points inside the
    // network is not one we want to talk to, whichever address we'd pick.
    if addrs.is_empty() {
        return Err("resolve".into());
    }
    if !addrs.iter().all(|a| allow(*a)) {
        return Err("blocked".into());
    }
    Ok(host.map(|h| (h, addrs[0])))
}

/// The guarded fetch. `resolve` and `allow` are parameters only so tests can
/// stand a loopback mock server in for the internet; production passes the
/// system resolver and [`is_public_ip`].
async fn fetch_guarded<R, F, A>(
    raw: &str,
    resolve: R,
    allow: A,
    timeout: Duration,
) -> Result<WebPage, String>
where
    R: Fn(String, u16) -> F,
    F: Future<Output = io::Result<Vec<SocketAddr>>>,
    A: Fn(SocketAddr) -> bool,
{
    let mut url = Url::parse(raw.trim()).map_err(|_| "bad_url")?;
    let chain = async {
        for hop in 0..=MAX_REDIRECTS {
            let pin = vet(&url, &resolve, &allow).await?;
            let mut builder = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy() // a proxy would resolve the host itself, unpinned
                .timeout(timeout)
                .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/537.36");
            if let Some((host, addr)) = pin {
                builder = builder.resolve(&host, addr);
            }
            let client = builder.build().map_err(|_| "network")?;
            let resp = client
                .get(url.clone())
                .header(
                    reqwest::header::ACCEPT,
                    "text/html,application/xhtml+xml,text/plain;q=0.8",
                )
                .send()
                .await
                .map_err(net_err)?;
            let status = resp.status();
            if status.is_redirection() {
                if hop == MAX_REDIRECTS {
                    return Err("redirects".to_string());
                }
                let next = resp
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|loc| url.join(loc).ok())
                    .ok_or("redirect")?;
                url = next;
                continue;
            }
            if !status.is_success() {
                return Err(format!("status:{}", status.as_u16()));
            }
            let ct = resp
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .map(|v| v.to_str().unwrap_or("").to_ascii_lowercase())
                .unwrap_or_default();
            let is_plain = match ct.split(';').next().unwrap_or("").trim() {
                "" | "text/html" | "application/xhtml+xml" => false,
                "text/plain" => true,
                _ => return Err("not_html".to_string()),
            };
            let body = read_capped(resp).await?;
            let text = decode(&body, &ct, !is_plain);
            return if is_plain {
                finish(&url, String::new(), text)
            } else {
                let (title, markdown) = extract(&text);
                finish(&url, title, markdown)
            };
        }
        Err("redirects".to_string())
    };
    tokio::time::timeout(timeout * 2, chain)
        .await
        .map_err(|_| "timeout".to_string())?
}

/// Decode a body by its declared charset: a BOM first, then the Content-Type
/// `charset=`, then (HTML only) a `<meta>` charset in the first 1 KB — the
/// same window browsers prescan. UTF-8 when none names a known encoding.
fn decode(body: &[u8], content_type: &str, is_html: bool) -> String {
    static CHARSET: OnceLock<Regex> = OnceLock::new();
    let re = CHARSET.get_or_init(|| {
        Regex::new(r#"(?i)charset\s*=\s*["']?\s*([a-z0-9_:.\-]+)"#).expect("valid regex")
    });
    let label = |hay: &str| re.captures(hay).map(|c| c[1].to_string());
    let from_header = label(content_type).and_then(|l| Encoding::for_label(l.as_bytes()));
    let enc = from_header
        .or_else(|| {
            if !is_html {
                return None;
            }
            let head = String::from_utf8_lossy(&body[..body.len().min(1024)]);
            static META: OnceLock<Regex> = OnceLock::new();
            let meta = META.get_or_init(|| Regex::new(r"(?i)<meta[^>]*>").expect("valid regex"));
            let enc = meta
                .find_iter(&head)
                .find_map(|m| label(m.as_str()))
                .and_then(|l| Encoding::for_label(l.as_bytes()))?;
            // HTML prescan rule: a meta tag can't really mean UTF-16 (it was just read as
            // ASCII), and x-user-defined means windows-1252.
            Some(if enc == UTF_16LE || enc == UTF_16BE {
                UTF_8
            } else if enc == X_USER_DEFINED {
                WINDOWS_1252
            } else {
                enc
            })
        })
        .unwrap_or(UTF_8);
    // `decode` honors a BOM over `enc`, as the encoding standard says.
    enc.decode(body).0.into_owned()
}

fn net_err(e: reqwest::Error) -> String {
    if e.is_timeout() { "timeout" } else { "network" }.to_string()
}

async fn read_capped(mut resp: reqwest::Response) -> Result<Vec<u8>, String> {
    if resp.content_length().is_some_and(|n| n > MAX_BYTES as u64) {
        return Err("too_large".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(net_err)? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_BYTES {
            return Err("too_large".into());
        }
    }
    Ok(body)
}

/// Readability-lite: drop chrome and scripts, then serialize the longest
/// `article`/`main` block (or the body when none is substantial) to markdown.
fn extract(html: &str) -> (String, String) {
    let doc = dom_query::Document::from(html);
    let title = doc
        .select("meta[property='og:title']")
        .attr("content")
        .map(|t| t.to_string())
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| doc.select("title").text().to_string());
    doc.select(STRIP).remove();
    let candidates = doc.select("article, main, [role='main']");
    let best = candidates
        .nodes()
        .iter()
        .max_by_key(|n| n.text().chars().count())
        .filter(|n| n.text().chars().count() >= MIN_MAIN_TEXT)
        .cloned()
        .or_else(|| doc.body());
    let markdown = best.map(|n| n.md(None).to_string()).unwrap_or_default();
    (title, markdown)
}

fn finish(url: &Url, title: String, markdown: String) -> Result<WebPage, String> {
    let mut markdown = markdown.trim().to_string();
    if markdown.is_empty() {
        return Err("empty".into());
    }
    if markdown.chars().count() > MAX_MARKDOWN_CHARS {
        markdown = markdown.chars().take(MAX_MARKDOWN_CHARS).collect();
        markdown.push_str("\n\n…(truncated: page exceeds the ingest limit)…");
    }
    let mut title: String = title
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_TITLE)
        .collect::<String>()
        .trim()
        .to_string();
    if title.is_empty() {
        title = url.host_str().unwrap_or_default().to_string();
    }
    Ok(WebPage {
        url: url.to_string(),
        title,
        markdown,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn public(a: SocketAddr) -> bool {
        is_public_ip(a.ip())
    }

    /// A resolver that knows one name; everything else fails like NXDOMAIN.
    fn one_name(
        name: &'static str,
        addrs: Vec<SocketAddr>,
    ) -> impl Fn(String, u16) -> std::future::Ready<io::Result<Vec<SocketAddr>>> {
        move |h, _| {
            std::future::ready(if h == name {
                Ok(addrs.clone())
            } else {
                Err(io::Error::new(io::ErrorKind::NotFound, "nx"))
            })
        }
    }

    /// The production rules, no network (literals and names never resolve).
    async fn vet_prod(raw: &str) -> Result<(), String> {
        let url = Url::parse(raw).map_err(|_| "bad_url".to_string())?;
        vet(
            &url,
            &one_name("example.com", vec!["93.184.216.34:80".parse().unwrap()]),
            &public,
        )
        .await
        .map(|_| ())
    }

    #[tokio::test]
    async fn refuses_non_web_schemes() {
        for u in [
            "file:///etc/passwd",
            "ftp://example.com/x",
            "gopher://example.com/",
            "data:text/html,hi",
        ] {
            assert_eq!(vet_prod(u).await, Err("scheme".into()), "{u}");
        }
        assert_eq!(
            fetch_page("javascript:alert(1)").await,
            Err("scheme".into())
        );
    }

    #[tokio::test]
    async fn refuses_embedded_credentials() {
        assert_eq!(
            vet_prod("http://user:pw@example.com/").await,
            Err("credentials".into())
        );
        assert_eq!(
            vet_prod("https://user@example.com/").await,
            Err("credentials".into())
        );
    }

    #[tokio::test]
    async fn refuses_every_non_public_address_class() {
        let cases = [
            // loopback, incl. the integer/hex spellings url normalizes
            "http://127.0.0.1/",
            "http://127.1.2.3:8080/",
            "http://2130706433/",
            "http://0x7f.0.0.1/",
            "http://[::1]/",
            // unspecified
            "http://0.0.0.0/",
            "http://[::]/",
            // private (RFC1918) and ULA
            "http://10.0.0.1/",
            "http://172.16.5.4/",
            "http://172.31.255.255/",
            "http://192.168.1.1/",
            "http://[fd00::1]/",
            // link-local, incl. the cloud metadata address
            "http://169.254.169.254/latest/meta-data/",
            "http://[fe80::1]/",
            // CGNAT
            "http://100.64.0.1/",
            "http://100.127.255.254/",
            // multicast, broadcast, reserved
            "http://224.0.0.1/",
            "http://255.255.255.255/",
            "http://240.0.0.1/",
            "http://[ff02::1]/",
            // v4 smuggled inside v6
            "http://[::ffff:127.0.0.1]/",
            "http://[::ffff:169.254.169.254]/",
            "http://[64:ff9b::a00:1]/",
            "http://[2002:7f00:1::]/",
        ];
        for u in cases {
            assert_eq!(vet_prod(u).await, Err("blocked".into()), "{u}");
        }
    }

    #[tokio::test]
    async fn refuses_local_only_names_before_resolving() {
        for u in [
            "http://localhost/",
            "http://LOCALHOST./",
            "http://api.localhost/",
            "http://printer.local/",
            "http://metadata.google.internal/computeMetadata/v1/",
        ] {
            assert_eq!(vet_prod(u).await, Err("blocked".into()), "{u}");
        }
    }

    #[tokio::test]
    async fn a_public_name_that_resolves_inside_is_refused() {
        let url = Url::parse("http://evil.test/").unwrap();
        let inside = one_name("evil.test", vec!["10.0.0.1:80".parse().unwrap()]);
        assert_eq!(vet(&url, &inside, &public).await, Err("blocked".into()));
        // one bad address among good ones is enough
        let mixed = one_name(
            "evil.test",
            vec![
                "93.184.216.34:80".parse().unwrap(),
                "127.0.0.1:80".parse().unwrap(),
            ],
        );
        assert_eq!(vet(&url, &mixed, &public).await, Err("blocked".into()));
        let nx = one_name("other.test", vec![]);
        assert_eq!(vet(&url, &nx, &public).await, Err("resolve".into()));
    }

    #[tokio::test]
    async fn public_addresses_pass_and_names_are_pinned() {
        for u in [
            "http://93.184.216.34/",
            "https://1.1.1.1/",
            "http://[2606:4700::1111]/",
            "http://8.8.8.8:8080/",
        ] {
            assert_eq!(vet_prod(u).await, Ok(()), "{u}");
        }
        let url = Url::parse("https://example.com/a").unwrap();
        let pin = vet(
            &url,
            &one_name("example.com", vec!["93.184.216.34:443".parse().unwrap()]),
            &public,
        )
        .await
        .unwrap();
        assert_eq!(
            pin,
            Some(("example.com".into(), "93.184.216.34:443".parse().unwrap()))
        );
    }

    // --- against a mock server -------------------------------------------
    // The mock listens on loopback, which the production rule refuses. The
    // tests allow exactly the mock's own socket address and judge every
    // other address with the production rule — so a redirect anywhere else
    // inside (another loopback port, private, metadata) still hits it.

    const ARTICLE: &str = r#"<html><head><title>Plain title</title>
        <meta property="og:title" content="The real headline">
        <script>window.SECRET_JS = 1</script><style>.x{}</style></head>
        <body><nav>Home | Sections | Login</nav>
        <article><h1>The real headline</h1>
        <p>First paragraph of the story, long enough to be the main text of this page and not a teaser.</p>
        <p>Second paragraph keeps going so the article clearly outweighs the chrome around it.</p>
        <script>trackReader()</script></article>
        <aside>Related: other stories</aside><footer>(c) Newsroom</footer></body></html>"#;

    async fn serve(server: &MockServer, at: &str, resp: ResponseTemplate) {
        Mock::given(method("GET"))
            .and(path(at))
            .respond_with(resp)
            .mount(server)
            .await;
    }

    fn html(body: &str) -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_raw(body.to_string(), "text/html; charset=utf-8")
    }

    fn redirect(to: &str) -> ResponseTemplate {
        ResponseTemplate::new(302).insert_header("Location", to)
    }

    async fn fetch_via(server: &MockServer, raw: &str) -> Result<WebPage, String> {
        let me = *server.address();
        fetch_guarded(
            raw,
            one_name("rebind.test", vec![me]),
            move |a| a == me || is_public_ip(a.ip()),
            Duration::from_secs(5),
        )
        .await
    }

    #[tokio::test]
    async fn extracts_the_article_without_scripts_or_chrome() {
        let server = MockServer::start().await;
        serve(&server, "/story", html(ARTICLE)).await;
        let page = fetch_via(&server, &format!("{}/story", server.uri()))
            .await
            .unwrap();
        assert_eq!(page.title, "The real headline");
        assert!(
            page.markdown.contains("First paragraph of the story"),
            "{}",
            page.markdown
        );
        assert!(
            page.markdown.contains("# The real headline"),
            "{}",
            page.markdown
        );
        for gone in ["SECRET_JS", "trackReader", "Login", "Related", "Newsroom"] {
            assert!(
                !page.markdown.contains(gone),
                "{gone} leaked: {}",
                page.markdown
            );
        }
    }

    #[tokio::test]
    async fn a_name_is_connected_to_the_vetted_address_not_looked_up_again() {
        // `rebind.test` exists only in the vetting resolver; the system DNS
        // cannot resolve it. Success proves the connection used the pinned
        // address, so a rebind after the check cannot redirect it.
        let server = MockServer::start().await;
        serve(&server, "/story", html(ARTICLE)).await;
        let port = server.address().port();
        let page = fetch_via(&server, &format!("http://rebind.test:{port}/story"))
            .await
            .unwrap();
        assert_eq!(page.url, format!("http://rebind.test:{port}/story"));
    }

    #[tokio::test]
    async fn follows_a_safe_redirect() {
        let server = MockServer::start().await;
        serve(&server, "/old", redirect("/story")).await;
        serve(&server, "/story", html(ARTICLE)).await;
        let page = fetch_via(&server, &format!("{}/old", server.uri()))
            .await
            .unwrap();
        assert!(page.url.ends_with("/story"));
    }

    #[tokio::test]
    async fn every_redirect_hop_is_vetted_again() {
        let server = MockServer::start().await;
        let cases = [
            ("http://127.0.0.1:1/admin", "blocked"),
            ("http://localhost/", "blocked"),
            ("http://10.0.0.1/", "blocked"),
            ("http://169.254.169.254/latest/meta-data/", "blocked"),
            ("http://[::ffff:192.168.0.1]/", "blocked"),
            ("file:///etc/passwd", "scheme"),
            ("http://u:p@rebind.test/", "credentials"),
        ];
        for (i, (to, _)) in cases.iter().enumerate() {
            serve(&server, &format!("/r{i}"), redirect(to)).await;
        }
        for (i, (to, want)) in cases.iter().enumerate() {
            let got = fetch_via(&server, &format!("{}/r{i}", server.uri())).await;
            assert_eq!(got, Err(want.to_string()), "redirect to {to}");
        }
    }

    #[tokio::test]
    async fn five_redirects_are_followed_and_a_sixth_is_refused() {
        let server = MockServer::start().await;
        for i in 0..6 {
            serve(
                &server,
                &format!("/h{i}"),
                redirect(&format!("/h{}", i + 1)),
            )
            .await;
        }
        serve(&server, "/h6", html(ARTICLE)).await;
        assert!(fetch_via(&server, &format!("{}/h1", server.uri()))
            .await
            .is_ok());
        assert_eq!(
            fetch_via(&server, &format!("{}/h0", server.uri())).await,
            Err("redirects".into())
        );
    }

    #[tokio::test]
    async fn sends_no_cookies_across_redirects() {
        let server = MockServer::start().await;
        serve(
            &server,
            "/login",
            redirect("/story").insert_header("Set-Cookie", "sid=abc; Path=/"),
        )
        .await;
        serve(&server, "/story", html(ARTICLE)).await;
        fetch_via(&server, &format!("{}/login", server.uri()))
            .await
            .unwrap();
        for req in server.received_requests().await.unwrap() {
            assert!(
                req.headers.get("cookie").is_none(),
                "cookie sent to {}",
                req.url
            );
            assert!(req.headers.get("authorization").is_none());
        }
    }

    #[tokio::test]
    async fn refuses_oversized_non_html_failed_and_empty_pages() {
        let server = MockServer::start().await;
        let huge = "a".repeat(MAX_BYTES + 1);
        serve(&server, "/huge", html(&huge)).await;
        serve(
            &server,
            "/pdf",
            ResponseTemplate::new(200).set_body_raw(b"%PDF-1.7".to_vec(), "application/pdf"),
        )
        .await;
        serve(&server, "/gone", ResponseTemplate::new(404)).await;
        serve(
            &server,
            "/blank",
            html("<html><body><script>x()</script></body></html>"),
        )
        .await;
        serve(&server, "/noloc", ResponseTemplate::new(302)).await;
        let srv = &server;
        let get = |p: &str| {
            let u = format!("{}{p}", srv.uri());
            async move { fetch_via(srv, &u).await }
        };
        assert_eq!(get("/huge").await, Err("too_large".into()));
        assert_eq!(get("/pdf").await, Err("not_html".into()));
        assert_eq!(get("/gone").await, Err("status:404".into()));
        assert_eq!(get("/blank").await, Err("empty".into()));
        assert_eq!(get("/noloc").await, Err("redirect".into()));
    }

    /// A legacy-charset article: `body` is wrapped in the ARTICLE shape and
    /// encoded with `enc`, so the bytes on the wire are not UTF-8.
    fn legacy(
        enc: &'static encoding_rs::Encoding,
        head: &str,
        body: &str,
        ct: &str,
    ) -> ResponseTemplate {
        let page = format!(
            "<html><head>{head}<title>{body}</title></head><body><article><p>{}</p></article></body></html>",
            body.repeat(40)
        );
        let (bytes, _, lossy) = enc.encode(&page);
        assert!(!lossy, "test text must be encodable");
        ResponseTemplate::new(200).set_body_raw(bytes.into_owned(), ct)
    }

    #[test]
    fn a_meta_utf16_or_x_user_defined_follows_the_html_prescan_rule() {
        let html = b"<html><head><meta charset=\"utf-16le\"><title>t</title></head><body>plain ascii text</body></html>";
        assert!(decode(html, "text/html", true).contains("plain ascii text"));
        let html =
            b"<html><head><meta charset=\"x-user-defined\"></head><body>caf\xe9</body></html>";
        assert!(decode(html, "text/html", true).contains("caf\u{e9}"));
    }

    #[tokio::test]
    async fn decodes_legacy_charsets_from_the_header_or_a_meta_tag() {
        use encoding_rs::{EUC_KR, SHIFT_JIS};
        let server = MockServer::start().await;
        let ko = "한국어 기사 본문입니다. ";
        let ja = "日本語の記事の本文です。";
        serve(
            &server,
            "/hdr",
            legacy(EUC_KR, "", ko, "text/html; charset=EUC-KR"),
        )
        .await;
        serve(
            &server,
            "/meta",
            legacy(SHIFT_JIS, r#"<meta charset="Shift_JIS">"#, ja, "text/html"),
        )
        .await;
        serve(
            &server,
            "/equiv",
            legacy(
                EUC_KR,
                r#"<meta http-equiv="Content-Type" content="text/html; charset=euc-kr">"#,
                ko,
                "text/html",
            ),
        )
        .await;
        // The header wins over a meta tag that disagrees with it.
        serve(
            &server,
            "/both",
            legacy(
                SHIFT_JIS,
                r#"<meta charset="euc-kr">"#,
                ja,
                "text/html; charset=shift_jis",
            ),
        )
        .await;
        serve(
            &server,
            "/plain",
            ResponseTemplate::new(200).set_body_raw(
                EUC_KR.encode(ko).0.into_owned(),
                "text/plain; charset=euc-kr",
            ),
        )
        .await;
        for (at, want) in [("/hdr", ko), ("/meta", ja), ("/equiv", ko), ("/both", ja)] {
            let page = fetch_via(&server, &format!("{}{at}", server.uri()))
                .await
                .unwrap();
            // The markdown serializer escapes the sentence's `.`, so probe a
            // phrase without punctuation.
            let probe = if want == ko {
                "기사 본문"
            } else {
                "記事の本文"
            };
            assert!(page.markdown.contains(probe), "{at}: {}", page.markdown);
            assert_eq!(page.title, want.trim(), "{at}");
        }
        let plain = fetch_via(&server, &format!("{}/plain", server.uri()))
            .await
            .unwrap();
        assert_eq!(plain.markdown, ko.trim());
    }

    #[test]
    fn charset_falls_back_to_utf8_for_unknown_or_missing_labels() {
        let utf8 = "café 한국".as_bytes();
        assert_eq!(decode(utf8, "text/html", true), "café 한국");
        assert_eq!(
            decode(utf8, "text/html; charset=bogus-9", true),
            "café 한국"
        );
        // A meta tag only counts for HTML.
        let tagged = "<meta charset=\"euc-kr\"> café".as_bytes();
        assert_eq!(
            decode(tagged, "text/plain", false),
            "<meta charset=\"euc-kr\"> café"
        );
    }

    #[tokio::test]
    async fn plain_text_passes_through_and_a_slow_server_times_out() {
        let server = MockServer::start().await;
        serve(
            &server,
            "/notes.txt",
            ResponseTemplate::new(200).set_body_raw("just text", "text/plain"),
        )
        .await;
        serve(
            &server,
            "/slow",
            html(ARTICLE).set_delay(Duration::from_secs(3)),
        )
        .await;
        let page = fetch_via(&server, &format!("{}/notes.txt", server.uri()))
            .await
            .unwrap();
        assert_eq!(
            (page.markdown.as_str(), page.title.as_str()),
            ("just text", "127.0.0.1")
        );
        let me = *server.address();
        let slow = fetch_guarded(
            &format!("{}/slow", server.uri()),
            one_name("x", vec![]),
            move |a| a == me,
            Duration::from_millis(300),
        )
        .await;
        assert_eq!(slow, Err("timeout".into()));
    }
}
