// Web clipper deep link — `memx://clip?url=…&title=…&selection=…` turns a
// browser page into an `_inbox/` source doc for the ingest pipeline. The
// parsing half is pure and unit-tested; the saving half only ever writes
// inside `<vault>/_inbox/`. Inputs come from the outside world (any app can
// open a memx:// URL), so everything is treated as hostile: length caps,
// http(s)-only source URLs, control characters stripped, and the filename is
// derived from a whitelisted slug — never from a caller-supplied path.

use std::path::{Path, PathBuf};

const MAX_TITLE: usize = 300;
const MAX_URL: usize = 2048;
const MAX_SELECTION: usize = 20_000;

#[derive(Debug, PartialEq)]
pub struct Clip {
    pub title: String,
    pub url: Option<String>,
    pub selection: Option<String>,
}

/// Strip control chars and cap length (on a char boundary).
fn clean(s: &str, max: usize) -> String {
    let mut out: String = s
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .collect();
    if out.chars().count() > max {
        out = out.chars().take(max).collect();
    }
    out.trim().to_string()
}

/// Parse and validate a `memx://clip?...` URL. Anything else is rejected.
pub fn parse_clip_url(raw: &str) -> Result<Clip, String> {
    let u = url::Url::parse(raw).map_err(|e| format!("bad url: {e}"))?;
    if u.scheme() != "memx" {
        return Err(format!("unsupported scheme: {}", u.scheme()));
    }
    // Accept both memx://clip?... (host) and memx:/clip?... (path) forms —
    // OS launchers normalize these differently.
    let action = u.host_str().unwrap_or_else(|| u.path().trim_start_matches('/'));
    if action != "clip" {
        return Err(format!("unsupported action: {action}"));
    }
    let mut title = String::new();
    let mut page_url: Option<String> = None;
    let mut selection: Option<String> = None;
    for (k, v) in u.query_pairs() {
        match k.as_ref() {
            "title" => title = clean(&v, MAX_TITLE),
            "url" => {
                let v = clean(&v, MAX_URL);
                // Only real web pages: no javascript:, file:, data:, memx: …
                if v.starts_with("http://") || v.starts_with("https://") {
                    page_url = Some(v);
                }
            }
            "selection" => {
                let v = clean(&v, MAX_SELECTION);
                if !v.is_empty() {
                    selection = Some(v);
                }
            }
            _ => {}
        }
    }
    if title.is_empty() {
        title = page_url
            .as_deref()
            .map(|u| u.to_string())
            .unwrap_or_else(|| "Web clip".to_string());
        title = clean(&title, MAX_TITLE);
    }
    if page_url.is_none() && selection.is_none() {
        return Err("clip carries neither url nor selection".to_string());
    }
    Ok(Clip { title, url: page_url, selection })
}

/// `_inbox/` filename: whitelisted slug from the title + a short content hash
/// so repeated clips of the same page never clobber each other.
pub fn clip_filename(clip: &Clip) -> String {
    let slug: String = clip
        .title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let slug = if slug.is_empty() { "web".to_string() } else { slug.chars().take(50).collect() };
    // FNV-1a over the whole clip — cheap, deterministic, no new deps.
    let mut h: u64 = 0xcbf29ce484222325;
    for b in format!("{}|{:?}|{:?}", clip.title, clip.url, clip.selection).bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("clip-{slug}-{:08x}.md", (h >> 32) as u32)
}

/// Markdown source doc for the ingest pipeline.
pub fn clip_markdown(clip: &Clip) -> String {
    let mut out = format!("# {}\n\n", clip.title);
    if let Some(u) = &clip.url {
        out.push_str(&format!("Source: {u}\n\n"));
    }
    if let Some(s) = &clip.selection {
        out.push_str("## Clipped text\n\n");
        for line in s.lines() {
            out.push_str("> ");
            out.push_str(line);
            out.push('\n');
        }
    }
    out
}

/// Write the clip into `<root>/_inbox/`, creating the folder if needed.
pub fn save_clip(root: &Path, clip: &Clip) -> Result<PathBuf, String> {
    let inbox = root.join("_inbox");
    std::fs::create_dir_all(&inbox).map_err(|e| format!("create _inbox: {e}"))?;
    let path = inbox.join(clip_filename(clip));
    // Confinement is structural (slug filename inside a fixed dir), but keep
    // the belt-and-braces canonical check used everywhere else.
    let canonical_parent = inbox
        .canonicalize()
        .map_err(|e| format!("canonicalize _inbox: {e}"))?;
    if !canonical_parent.starts_with(root.canonicalize().map_err(|e| e.to_string())?) {
        return Err("inbox escapes vault root".to_string());
    }
    std::fs::write(&path, clip_markdown(clip)).map_err(|e| format!("write clip: {e}"))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_full_clip() {
        let c = parse_clip_url(
            "memx://clip?title=Attention%20Is%20All%20You%20Need&url=https%3A%2F%2Farxiv.org%2Fabs%2F1706.03762&selection=Scaled%20dot-product%20attention",
        )
        .unwrap();
        assert_eq!(c.title, "Attention Is All You Need");
        assert_eq!(c.url.as_deref(), Some("https://arxiv.org/abs/1706.03762"));
        assert_eq!(c.selection.as_deref(), Some("Scaled dot-product attention"));
    }

    #[test]
    fn rejects_wrong_scheme_action_and_empty() {
        assert!(parse_clip_url("https://clip?url=https://x.com").is_err());
        assert!(parse_clip_url("memx://open?url=https://x.com").is_err());
        assert!(parse_clip_url("memx://clip?title=only-a-title").is_err());
    }

    #[test]
    fn drops_non_http_urls_but_keeps_selection() {
        let c = parse_clip_url("memx://clip?url=javascript%3Aalert(1)&selection=hi").unwrap();
        assert_eq!(c.url, None);
        assert_eq!(c.selection.as_deref(), Some("hi"));
    }

    #[test]
    fn strips_control_chars_and_caps_length() {
        let long = "a".repeat(9000);
        let raw = format!("memx://clip?title=bad%00title&selection={long}");
        let c = parse_clip_url(&raw).unwrap();
        assert_eq!(c.title, "badtitle");
        assert!(c.selection.unwrap().chars().count() <= 20_000);
    }

    #[test]
    fn filename_is_slugged_and_stable() {
        let c = Clip {
            title: "Hello, World! 안녕".into(),
            url: Some("https://x.com".into()),
            selection: None,
        };
        let f1 = clip_filename(&c);
        let f2 = clip_filename(&c);
        assert_eq!(f1, f2);
        assert!(f1.starts_with("clip-hello-world-안녕-") || f1.starts_with("clip-hello-world-"));
        assert!(f1.ends_with(".md"));
        assert!(!f1.contains('/') && !f1.contains(".."));
    }

    #[test]
    fn markdown_quotes_selection_lines() {
        let c = Clip {
            title: "T".into(),
            url: Some("https://x.com".into()),
            selection: Some("line one\nline two".into()),
        };
        let md = clip_markdown(&c);
        assert!(md.contains("Source: https://x.com"));
        assert!(md.contains("> line one\n> line two\n"));
    }

    #[test]
    fn save_clip_writes_inside_inbox() {
        let dir = std::env::temp_dir().join(format!("memex-clip-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let c = Clip { title: "t".into(), url: Some("https://x.com".into()), selection: None };
        let p = save_clip(&dir, &c).unwrap();
        assert!(p.starts_with(dir.join("_inbox")));
        assert!(std::fs::read_to_string(&p).unwrap().contains("Source:"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
