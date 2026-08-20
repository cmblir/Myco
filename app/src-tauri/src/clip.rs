// Web clipper deep link — `memx://clip?url=…&title=…&selection=…` turns a
// browser page into an `_inbox/` source doc for the ingest pipeline. The
// parsing half is pure and unit-tested; the saving half only ever writes
// inside `<vault>/_inbox/`. Inputs come from the outside world (any app can
// open a memx:// URL), so everything is treated as hostile: length caps,
// http(s)-only source URLs, control characters stripped, and the filename is
// derived from a whitelisted slug — never from a caller-supplied path.

use crate::importers::ledger::Ledger;
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

/// The deep-link schemes we answer to. `memx` is the pre-rename spelling and
/// must be accepted FOREVER: it is baked into bookmarklets users have already
/// saved and into browser extensions we cannot update on their machines.
pub const CLIP_SCHEMES: &[&str] = &["myco", "memx"];

/// Parse and validate a `myco://clip?...` URL (or the legacy `memx://` one).
/// Anything else is rejected.
pub fn parse_clip_url(raw: &str) -> Result<Clip, String> {
    let u = url::Url::parse(raw).map_err(|e| format!("bad url: {e}"))?;
    if !CLIP_SCHEMES.contains(&u.scheme()) {
        return Err(format!("unsupported scheme: {}", u.scheme()));
    }
    // Accept both myco://clip?... (host) and myco:/clip?... (path) forms —
    // OS launchers normalize these differently.
    let action = u
        .host_str()
        .unwrap_or_else(|| u.path().trim_start_matches('/'));
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
                // Only real web pages: no javascript:, file:, data:, myco: …
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
    Ok(Clip {
        title,
        url: page_url,
        selection,
    })
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
    let slug = if slug.is_empty() {
        "web".to_string()
    } else {
        slug.chars().take(50).collect()
    };
    // FNV-1a over the whole clip — cheap, deterministic, no new deps.
    let mut h: u64 = 0xcbf29ce484222325;
    for b in format!("{}|{:?}|{:?}", clip.title, clip.url, clip.selection).bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("clip-{slug}-{:08x}.md", (h >> 32) as u32)
}

/// A double-quoted YAML scalar. Titles and URLs come off a web page, so they
/// can hold `:`, `#`, quotes and (after `clean`) newlines — any of which turns a
/// bare scalar into frontmatter that fails to parse or, worse, parses to
/// something else. JSON string syntax IS a valid YAML double-quoted scalar and
/// escapes exactly those characters.
fn yaml_str(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string())
}

/// Ledger key for a clipped page. Keyed on the URL alone: a re-clip with a
/// different highlight is still the same page.
/// Dedup key for a clipped page. The URL is normalised first so the SAME page
/// arriving with tracking noise, a fragment, or a trailing slash is recognised
/// as the same clip: `#section`, a trailing `/`, and `utm_*`/`fbclid`/`gclid`
/// query params are dropped. Anything else in the query is kept — `?id=42` is
/// a different page, not noise.
fn ledger_key(url: &str) -> String {
    format!("clipper:{}", normalize_clip_url(url))
}

pub(crate) fn normalize_clip_url(url: &str) -> String {
    let no_frag = url.split('#').next().unwrap_or(url);
    let (base, query) = match no_frag.split_once('?') {
        Some((b, q)) => (b, Some(q)),
        None => (no_frag, None),
    };
    let base = base.strip_suffix('/').unwrap_or(base);
    let kept: Vec<&str> = query
        .map(|q| {
            q.split('&')
                .filter(|p| {
                    let name = p.split('=').next().unwrap_or(p);
                    !(name.starts_with("utm_") || name == "fbclid" || name == "gclid")
                })
                .filter(|p| !p.is_empty())
                .collect()
        })
        .unwrap_or_default();
    if kept.is_empty() {
        base.to_string()
    } else {
        format!("{base}?{}", kept.join("&"))
    }
}

/// Whether the doc the previous clip of this URL wrote is still in `_inbox/`.
/// The ledger stores that doc's file NAME (see `save_clip`'s record call), so
/// this asks about the very file the earlier clip produced. A legacy entry
/// from before that (a content fingerprint, not a name) is treated as
/// present — the old refuse-the-duplicate behaviour, never a surprise rewrite.
fn clip_still_present(root: &Path, recorded: Option<&String>) -> bool {
    match recorded {
        Some(name) if name.ends_with(".md") => root.join("_inbox").join(name).exists(),
        _ => true,
    }
}

/// Markdown source doc for the ingest pipeline.
///
/// The frontmatter follows the importers' idiom
/// (`importers::Conversation::to_inbox_doc`) so the readers that already exist
/// keep working unchanged: `provenance.rs` wants `source`/`title` as strings and
/// `distill.rs` wants `created` as a unix integer. `url` and `clipped` are the
/// clipper's own additions — which page a claim came from, and when it was
/// captured. `clipped` names the same instant as `created`; `created` is the key
/// the existing readers look for, `clipped` the one that says how it got here.
pub fn clip_markdown(clip: &Clip, clipped_at: i64) -> String {
    let mut out = String::from("---\nsource: clipper\n");
    if let Some(u) = &clip.url {
        out.push_str(&format!("url: {}\n", yaml_str(u)));
    }
    out.push_str(&format!("title: {}\n", yaml_str(&clip.title)));
    out.push_str(&format!(
        "created: {clipped_at}\nclipped: {clipped_at}\n---\n\n"
    ));
    out.push_str(&format!("# {}\n\n", clip.title));
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

/// What happened to a clip, so the caller can tell the user which.
#[derive(Debug, PartialEq)]
pub enum Saved {
    Written(PathBuf),
    /// This URL is already in the import ledger — nothing was written.
    Duplicate,
}

/// Write the clip into `<root>/_inbox/`, creating the folder if needed.
///
/// A URL already in the import ledger is NOT written again. Without the check,
/// re-clipping a page you already have leaves a second `_inbox/` doc (the
/// filename hash covers the selection, so a different highlight makes a
/// different file) and the ingest pipeline cites the same page twice. The
/// ledger is the same one the conversation importers dedup against, so a lost
/// `.myco/ledger.json` costs one duplicate clip and nothing else.
///
/// ponytail: dedup is URL-only, so a second clip of a *different* passage on a
/// page you already clipped is refused rather than appended. Key on
/// `url + selection` if that turns out to bite.
pub fn save_clip(root: &Path, clip: &Clip) -> Result<Saved, String> {
    let mut ledger = Ledger::load(root);
    let key = clip.url.as_deref().map(ledger_key);
    // "Already clipped" must mean the earlier clip is still HERE. The ledger
    // never forgets, so without this check a page consumed by ingest (its
    // source archived) or deleted by hand could never be clipped again — the
    // only recovery was hand-editing .myco/ledger.json.
    if key.as_deref().is_some_and(|k| ledger.seen_key(k))
        && clip_still_present(root, key.as_deref().and_then(|k| ledger.entry(k)))
    {
        return Ok(Saved::Duplicate);
    }
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
    let body = clip_markdown(clip, now_secs());
    std::fs::write(&path, &body).map_err(|e| format!("write clip: {e}"))?;
    if let Some(k) = key {
        // The doc's file name, not its content hash: dedup is URL-keyed, and
        // the name is what `clip_still_present` needs to tell "already here"
        // from "was here, then ingested or deleted".
        ledger.record(k, clip_filename(clip));
        // Best effort: the doc is already on disk, and a ledger that failed to
        // save costs a duplicate next time, never the clip.
        if let Err(e) = ledger.save(root) {
            eprintln!("clip ledger not saved: {e}");
        }
    }
    Ok(Saved::Written(path))
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
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
    fn parses_the_same_clip_under_the_new_scheme() {
        // The tests around this one deliberately stay on `memx://`: saved
        // bookmarklets still emit it and must keep working forever.
        let c = parse_clip_url("myco://clip?title=Hi&url=https%3A%2F%2Fx.com%2Fa").unwrap();
        assert_eq!(c.title, "Hi");
        assert_eq!(c.url.as_deref(), Some("https://x.com/a"));
        assert_eq!(CLIP_SCHEMES, &["myco", "memx"]);
    }

    #[test]
    fn rejects_wrong_scheme_action_and_empty() {
        assert!(parse_clip_url("https://clip?url=https://x.com").is_err());
        assert!(parse_clip_url("memx://open?url=https://x.com").is_err());
        assert!(parse_clip_url("myco://open?url=https://x.com").is_err());
        assert!(parse_clip_url("mycox://clip?url=https://x.com").is_err());
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
        let md = clip_markdown(&c, 1_700_000_000);
        assert!(md.contains("Source: https://x.com"));
        assert!(md.contains("> line one\n> line two\n"));
    }

    /// The whole point of the frontmatter: the fields the existing readers look
    /// for (`provenance::parse_source_ref` on source/title, `distill`'s
    /// `frontmatter_created` on an integer `created`) must come back out.
    #[test]
    fn markdown_carries_provenance_frontmatter() {
        let c = Clip {
            title: "Attention: all you need".into(),
            url: Some("https://arxiv.org/abs/1706.03762".into()),
            selection: None,
        };
        let md = clip_markdown(&c, 1_700_000_000);
        let parsed = gray_matter::Matter::<gray_matter::engine::YAML>::new()
            .parse(&md)
            .unwrap();
        let gray_matter::Pod::Hash(map) = parsed.data.unwrap() else {
            panic!("frontmatter is not a mapping");
        };
        assert_eq!(
            map.get("source"),
            Some(&gray_matter::Pod::String("clipper".into()))
        );
        assert_eq!(
            map.get("url"),
            Some(&gray_matter::Pod::String(
                "https://arxiv.org/abs/1706.03762".into()
            ))
        );
        // A colon in the title would have broken a bare YAML scalar.
        assert_eq!(
            map.get("title"),
            Some(&gray_matter::Pod::String("Attention: all you need".into()))
        );
        assert_eq!(
            map.get("created"),
            Some(&gray_matter::Pod::Integer(1_700_000_000))
        );
        assert_eq!(
            map.get("clipped"),
            Some(&gray_matter::Pod::Integer(1_700_000_000))
        );
    }

    /// A page title can carry quotes and (via `clean`) a newline; neither may
    /// escape the frontmatter block.
    #[test]
    fn a_hostile_title_stays_inside_its_scalar() {
        let c = Clip {
            title: "he said \"hi\"\n---\nsource: trusted".into(),
            url: None,
            selection: Some("s".into()),
        };
        let md = clip_markdown(&c, 1);
        let parsed = gray_matter::Matter::<gray_matter::engine::YAML>::new()
            .parse(&md)
            .unwrap();
        let gray_matter::Pod::Hash(map) = parsed.data.unwrap() else {
            panic!("frontmatter is not a mapping");
        };
        assert_eq!(
            map.get("source"),
            Some(&gray_matter::Pod::String("clipper".into()))
        );
    }

    #[test]
    fn save_clip_writes_inside_inbox() {
        let dir = tempfile::tempdir().unwrap();
        let c = Clip {
            title: "t".into(),
            url: Some("https://x.com".into()),
            selection: None,
        };
        let Saved::Written(p) = save_clip(dir.path(), &c).unwrap() else {
            panic!("first clip must be written");
        };
        assert!(p.starts_with(dir.path().join("_inbox")));
        let body = std::fs::read_to_string(&p).unwrap();
        assert!(body.starts_with("---\nsource: clipper\n"));
        assert!(body.contains("Source:"));
    }

    #[test]
    fn a_clip_whose_doc_is_gone_can_be_clipped_again() {
        // Ingest archives the source out of _inbox/ (or the user deletes it).
        // The ledger never forgets, so without a presence check the page could
        // never be captured again except by hand-editing .myco/ledger.json.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let clip = Clip {
            title: "post".into(),
            url: Some("https://example.com/post".into()),
            selection: None,
        };
        let Saved::Written(first) = save_clip(root, &clip).unwrap() else {
            panic!("first clip must be written");
        };
        assert_eq!(save_clip(root, &clip).unwrap(), Saved::Duplicate);
        std::fs::remove_file(&first).unwrap(); // consumed by ingest
        assert!(
            matches!(save_clip(root, &clip).unwrap(), Saved::Written(_)),
            "a page whose clip is gone must be clippable again"
        );
    }

    #[test]
    fn tracking_noise_does_not_make_a_new_clip() {
        assert_eq!(
            normalize_clip_url("https://example.com/post/?utm_source=x&id=42#top"),
            "https://example.com/post?id=42"
        );
        assert_eq!(
            normalize_clip_url("https://example.com/post"),
            normalize_clip_url("https://example.com/post/#section"),
        );
    }

    #[test]
    fn re_clipping_the_same_url_is_a_duplicate_even_with_a_new_selection() {
        let dir = tempfile::tempdir().unwrap();
        let first = Clip {
            title: "Paper".into(),
            url: Some("https://x.com/a".into()),
            selection: Some("first highlight".into()),
        };
        assert!(matches!(
            save_clip(dir.path(), &first).unwrap(),
            Saved::Written(_)
        ));
        // Different highlight → different filename and fingerprint, same page.
        let again = Clip {
            selection: Some("second highlight".into()),
            ..first
        };
        assert_eq!(save_clip(dir.path(), &again).unwrap(), Saved::Duplicate);
        let written = std::fs::read_dir(dir.path().join("_inbox"))
            .unwrap()
            .count();
        assert_eq!(written, 1, "the duplicate must not reach _inbox/");
    }

    #[test]
    fn a_different_url_is_not_a_duplicate() {
        let dir = tempfile::tempdir().unwrap();
        for u in ["https://x.com/a", "https://x.com/b"] {
            let c = Clip {
                title: "t".into(),
                url: Some(u.into()),
                selection: None,
            };
            assert!(matches!(
                save_clip(dir.path(), &c).unwrap(),
                Saved::Written(_)
            ));
        }
    }

    /// A selection-only clip has no URL to key on, so it can never be a
    /// duplicate — refusing it would silently drop the clip.
    #[test]
    fn a_url_less_clip_always_writes() {
        let dir = tempfile::tempdir().unwrap();
        let c = Clip {
            title: "notes".into(),
            url: None,
            selection: Some("some highlighted prose".into()),
        };
        assert!(matches!(
            save_clip(dir.path(), &c).unwrap(),
            Saved::Written(_)
        ));
        assert!(matches!(
            save_clip(dir.path(), &c).unwrap(),
            Saved::Written(_)
        ));
    }
}
