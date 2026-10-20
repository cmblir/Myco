// Web clipper deep link — `memx://clip?url=…&title=…&selection=…&note=…` turns a
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
const MAX_NOTE: usize = 500;
/// The label a clip's note is quoted under. The backlog contract (S39) fixes
/// the Korean wording; the file is ingest input, not UI, so it is not i18n'd.
const NOTE_LABEL: &str = "내 메모";

#[derive(Debug, Clone, PartialEq)]
pub struct Clip {
    pub title: String,
    pub url: Option<String>,
    pub selection: Option<String>,
    /// Why it was saved: one line from the clipper popup (`note=`).
    pub note: Option<String>,
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
    let mut note: Option<String> = None;
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
            "note" => {
                // One line: the note is quoted as a single `>` line.
                let v = clean(
                    &v.split_whitespace().collect::<Vec<_>>().join(" "),
                    MAX_NOTE,
                );
                if !v.is_empty() {
                    note = Some(v);
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
        note,
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
///
/// `pub(crate)`: `commands::voice_markdown` writes the same `_inbox/`
/// frontmatter spine and has the same hostile-title problem (a transcript's
/// opening words become the title).
pub(crate) fn yaml_str(s: &str) -> String {
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

/// Dedup key for a clip that highlighted a passage. Keying the whole page was
/// too coarse: a second clip of a DIFFERENT passage on a page already clipped
/// was refused, so a long article could only ever contribute one excerpt.
/// Same page + same passage still collides, which is the case dedup is for.
fn ledger_key_with_selection(url: &str, selection: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in selection.trim().bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{}#{:08x}", ledger_key(url), (h >> 32) as u32)
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
    if let Some(n) = &clip.note {
        out.push_str(&format!("> {NOTE_LABEL}: {n}\n\n"));
    }
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
    /// Already clipped, and the re-clip's note was added to that `_inbox/` doc.
    NoteAdded(PathBuf),
    /// Already clipped, but its doc names no file to add the note to, so the
    /// note was not saved — the caller must say so.
    DuplicateNoteDropped,
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
/// A highlighted clip is keyed on `url + selection`, so a second passage from
/// the same article is new material rather than a refused duplicate; a whole-
/// page clip stays keyed on the URL alone.
pub fn save_clip(root: &Path, clip: &Clip) -> Result<Saved, String> {
    let _import_guard = crate::importers::wikify::import_lock()?;
    let mut ledger = Ledger::load(root)?;
    let inbox = root.join("_inbox");
    crate::vault::confine_delete_path(root, &inbox.to_string_lossy())?;
    let url_key = clip.url.as_deref().map(ledger_key);
    let key = match (clip.url.as_deref(), clip.selection.as_deref()) {
        (Some(u), Some(sel)) if !sel.trim().is_empty() => Some(ledger_key_with_selection(u, sel)),
        _ => url_key.clone(),
    };
    // "Already clipped" must mean the earlier clip is still HERE. The ledger
    // never forgets, so without this check a page consumed by ingest (its
    // source archived) or deleted by hand could never be clipped again — the
    // only recovery was hand-editing .myco/ledger.json.
    let is_dup = |k: &str| ledger.seen_key(k) && clip_still_present(root, ledger.entry(k));
    if let Some(k) = key.as_deref().filter(|k| is_dup(k)) {
        return add_note_to_duplicate(root, clip, ledger.entry(k));
    }
    // Entries written before clips were keyed per passage live under the bare
    // URL key. `clip_filename` already hashes title+url+selection, so an
    // identical re-clip matches that older entry exactly — recognised as the
    // duplicate it is instead of landing a second copy on upgrade.
    if url_key
        .as_deref()
        .is_some_and(|k| is_dup(k) && ledger.entry(k) == Some(&clip_filename(clip)))
    {
        return add_note_to_duplicate(root, clip, Some(&clip_filename(clip)));
    }
    std::fs::create_dir_all(&inbox).map_err(|e| format!("create _inbox: {e}"))?;
    let filename = clip_filename(clip);
    let mut path = inbox.join(&filename);
    crate::vault::confine_delete_path(root, &path.to_string_lossy())?;
    if key.is_none() {
        // URL-less captures are separate sources; never replace an earlier note.
        let stem = filename.trim_end_matches(".md");
        let mut suffix = 2;
        while std::fs::symlink_metadata(&path).is_ok() {
            path = inbox.join(format!("{stem}-{suffix}.md"));
            crate::vault::confine_delete_path(root, &path.to_string_lossy())?;
            suffix += 1;
        }
    }
    // Confinement is structural (slug filename inside a fixed dir), but keep
    // the belt-and-braces canonical check used everywhere else.
    let canonical_parent = inbox
        .canonicalize()
        .map_err(|e| format!("canonicalize _inbox: {e}"))?;
    if !canonical_parent.starts_with(root.canonicalize().map_err(|e| e.to_string())?) {
        return Err("inbox escapes vault root".to_string());
    }
    let body = clip_markdown(clip, now_secs());
    crate::vault::write_file_if_unchanged(&path.to_string_lossy(), &body, None)
        .map_err(|e| format!("write clip: {e}"))?;
    crate::inflow_log::record(root, "clipper", "clip");
    if let Some(k) = key {
        // The doc's file name, not its content hash: dedup is URL-keyed, and
        // the name is what `clip_still_present` needs to tell "already here"
        // from "was here, then ingested or deleted".
        ledger.record(k, clip_filename(clip));
        ledger.save(root).map_err(|error| {
            format!(
                "clip retained but ledger publication incomplete; retry after recovery: {error}"
            )
        })?;
    }
    Ok(Saved::Written(path))
}

/// A re-clip of a page already in `_inbox/`: its note (if any) goes into that
/// doc as the first body line, the same place `clip_markdown` puts it. Only
/// the `_inbox/` file the ledger names is touched — never anything else.
fn add_note_to_duplicate(
    root: &Path,
    clip: &Clip,
    recorded: Option<&String>,
) -> Result<Saved, String> {
    let Some(note) = &clip.note else {
        return Ok(Saved::Duplicate);
    };
    let Some(name) = recorded.filter(|n| n.ends_with(".md") && !n.contains(['/', '\\'])) else {
        return Ok(Saved::DuplicateNoteDropped);
    };
    let path = root.join("_inbox").join(name);
    crate::vault::confine_delete_path(root, &path.to_string_lossy())?;
    let md = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Saved::DuplicateNoteDropped)
        }
        Err(error) => return Err(format!("read clip note: {error}")),
    };
    let line = format!("> {NOTE_LABEL}: {note}\n\n");
    if md.contains(&line) {
        return Ok(Saved::Duplicate);
    }
    let Some((front, body)) = md.split_once("\n---\n\n") else {
        return Ok(Saved::DuplicateNoteDropped);
    };
    crate::vault::write_file_if_unchanged(
        &path.to_string_lossy(),
        &format!("{front}\n---\n\n{line}{body}"),
        Some(&crate::importers::wikify::source_revision(&md)),
    )
    .map_err(|e| format!("write clip note: {e}"))?;
    Ok(Saved::NoteAdded(path))
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

    fn synthetic_clip() -> Clip {
        Clip {
            title: "Synthetic source".into(),
            url: Some("https://example.com/synthetic".into()),
            selection: None,
            note: None,
        }
    }

    #[test]
    fn clip_boundary_corrupt_ledger_blocks_publication() {
        let vault = tempfile::tempdir().unwrap();
        std::fs::create_dir(vault.path().join(".myco")).unwrap();
        let path = vault.path().join(".myco/ledger.json");
        let original = b"{corrupt synthetic identity";
        std::fs::write(&path, original).unwrap();
        assert!(save_clip(vault.path(), &synthetic_clip()).is_err());
        assert_eq!(std::fs::read(path).unwrap(), original);
        assert!(!vault.path().join("_inbox").exists());
    }

    #[cfg(unix)]
    #[test]
    fn clip_boundary_aliased_inbox_preserves_raw_bytes() {
        let vault = tempfile::tempdir().unwrap();
        let clip = synthetic_clip();
        let raw = vault.path().join("raw");
        std::fs::create_dir(&raw).unwrap();
        let source = raw.join(clip_filename(&clip));
        let original = b"Synthetic immutable raw source";
        std::fs::write(&source, original).unwrap();
        std::os::unix::fs::symlink(&raw, vault.path().join("_inbox")).unwrap();
        let outcome = save_clip(vault.path(), &clip);
        assert_eq!(std::fs::read(source).unwrap(), original);
        assert!(outcome.is_err());
    }

    #[cfg(unix)]
    #[test]
    fn clip_boundary_aliased_final_file_preserves_raw_bytes() {
        let vault = tempfile::tempdir().unwrap();
        let clip = synthetic_clip();
        let raw = vault.path().join("raw");
        std::fs::create_dir(&raw).unwrap();
        let source = raw.join("synthetic.md");
        let original = b"Synthetic immutable raw source";
        std::fs::write(&source, original).unwrap();
        std::fs::create_dir(vault.path().join("_inbox")).unwrap();
        std::os::unix::fs::symlink(
            &source,
            vault.path().join("_inbox").join(clip_filename(&clip)),
        )
        .unwrap();
        let outcome = save_clip(vault.path(), &clip);
        assert_eq!(std::fs::read(source).unwrap(), original);
        assert!(outcome.is_err());
    }

    #[test]
    fn clip_boundary_existing_untracked_human_projection_survives() {
        let vault = tempfile::tempdir().unwrap();
        let clip = synthetic_clip();
        std::fs::create_dir(vault.path().join("_inbox")).unwrap();
        let path = vault.path().join("_inbox").join(clip_filename(&clip));
        let original = b"# Human annotation\nRetain this decision.";
        std::fs::write(&path, original).unwrap();
        let outcome = save_clip(vault.path(), &clip);
        assert_eq!(std::fs::read(path).unwrap(), original);
        assert!(outcome.is_err());
    }

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
            note: None,
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
            note: None,
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
            note: None,
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
            note: None,
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
            note: None,
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
            note: None,
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
    fn a_second_passage_from_the_same_page_is_new_material() {
        // URL-only dedup meant a long article could contribute exactly one
        // excerpt ever; the second highlight was refused as a duplicate.
        let dir = tempfile::tempdir().unwrap();
        let first = Clip {
            title: "Paper".into(),
            url: Some("https://x.com/a".into()),
            selection: Some("first highlight".into()),
            note: None,
        };
        assert!(matches!(
            save_clip(dir.path(), &first).unwrap(),
            Saved::Written(_)
        ));
        let second = Clip {
            selection: Some("second highlight".into()),
            note: None,
            ..first.clone()
        };
        assert!(matches!(
            save_clip(dir.path(), &second).unwrap(),
            Saved::Written(_)
        ));
        // The SAME passage twice is still the duplicate dedup exists for.
        assert_eq!(save_clip(dir.path(), &first).unwrap(), Saved::Duplicate);
        let written = std::fs::read_dir(dir.path().join("_inbox"))
            .unwrap()
            .count();
        assert_eq!(written, 2, "two passages, two docs, no third");
    }

    #[test]
    fn a_whole_page_re_clip_is_still_a_duplicate() {
        let dir = tempfile::tempdir().unwrap();
        let page = Clip {
            title: "Paper".into(),
            url: Some("https://x.com/a".into()),
            selection: None,
            note: None,
        };
        assert!(matches!(
            save_clip(dir.path(), &page).unwrap(),
            Saved::Written(_)
        ));
        assert_eq!(save_clip(dir.path(), &page).unwrap(), Saved::Duplicate);
    }

    #[test]
    fn a_clip_recorded_under_the_old_url_only_key_is_recognised() {
        // Upgrade path: entries written before per-passage keys exist under the
        // bare URL. An identical re-clip must not land a second copy.
        let dir = tempfile::tempdir().unwrap();
        let clip = Clip {
            title: "Paper".into(),
            url: Some("https://x.com/a".into()),
            selection: Some("only highlight".into()),
            note: None,
        };
        let mut ledger = Ledger::load(dir.path()).unwrap();
        ledger.record(ledger_key("https://x.com/a"), clip_filename(&clip));
        ledger.save(dir.path()).unwrap();
        std::fs::create_dir_all(dir.path().join("_inbox")).unwrap();
        std::fs::write(
            dir.path().join("_inbox").join(clip_filename(&clip)),
            "old clip",
        )
        .unwrap();

        assert_eq!(save_clip(dir.path(), &clip).unwrap(), Saved::Duplicate);
    }

    #[test]
    fn a_different_url_is_not_a_duplicate() {
        let dir = tempfile::tempdir().unwrap();
        for u in ["https://x.com/a", "https://x.com/b"] {
            let c = Clip {
                title: "t".into(),
                url: Some(u.into()),
                selection: None,
                note: None,
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
            note: None,
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

    /// `note=` is the clipper popup's "why I saved this" line — the same
    /// contract as a phone share sheet's comment field. One line, capped.
    #[test]
    fn parses_a_note_as_one_capped_line() {
        let c =
            parse_clip_url("myco://clip?url=https%3A%2F%2Fx.com&note=for%0Athe%20talk").unwrap();
        assert_eq!(c.note.as_deref(), Some("for the talk"));
        let long = "n".repeat(2000);
        let c =
            parse_clip_url(&format!("myco://clip?url=https%3A%2F%2Fx.com&note={long}")).unwrap();
        assert_eq!(c.note.unwrap().chars().count(), MAX_NOTE);
        let c = parse_clip_url("myco://clip?url=https%3A%2F%2Fx.com&note=%20%20").unwrap();
        assert_eq!(c.note, None);
    }

    #[test]
    fn a_note_is_the_first_body_line() {
        let c = Clip {
            title: "T".into(),
            url: Some("https://x.com".into()),
            selection: Some("s".into()),
            note: Some("for the talk".into()),
        };
        let md = clip_markdown(&c, 1_700_000_000);
        let body = md.split_once("\n---\n\n").unwrap().1;
        assert!(
            body.starts_with("> 내 메모: for the talk\n\n# T\n"),
            "{body}"
        );
        // A note never reaches a clip without one.
        let none = Clip { note: None, ..c };
        assert!(!clip_markdown(&none, 1_700_000_000).contains("내 메모"));
    }

    /// The right-click menu clips with no note; the popup then re-clips the
    /// same page WITH one. That note must land on the clip already in
    /// _inbox/, not vanish behind "Already clipped".
    #[test]
    fn a_note_on_a_re_clip_joins_the_existing_doc() {
        let dir = tempfile::tempdir().unwrap();
        let bare = Clip {
            title: "P".into(),
            url: Some("https://x.com/p".into()),
            selection: None,
            note: None,
        };
        let Saved::Written(path) = save_clip(dir.path(), &bare).unwrap() else {
            panic!("first clip must be written");
        };
        let noted = Clip {
            note: Some("for the talk".into()),
            ..bare.clone()
        };
        assert_eq!(
            save_clip(dir.path(), &noted).unwrap(),
            Saved::NoteAdded(path.clone())
        );
        let md = std::fs::read_to_string(&path).unwrap();
        let body = md.split_once("\n---\n\n").unwrap().1;
        assert!(
            body.starts_with("> 내 메모: for the talk\n\n# P\n"),
            "{body}"
        );
        // The same note again adds nothing; no note is a plain duplicate.
        assert_eq!(save_clip(dir.path(), &noted).unwrap(), Saved::Duplicate);
        assert_eq!(save_clip(dir.path(), &bare).unwrap(), Saved::Duplicate);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), md);
    }

    /// A legacy ledger entry names no file, so there is nowhere to put the
    /// note: the caller is told it was not saved instead of a bare duplicate.
    #[test]
    fn a_note_with_nowhere_to_go_is_reported_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let mut ledger = Ledger::load(dir.path()).unwrap();
        ledger.record(ledger_key("https://x.com/p"), "deadbeef".to_string());
        ledger.save(dir.path()).unwrap();
        let noted = Clip {
            title: "P".into(),
            url: Some("https://x.com/p".into()),
            selection: None,
            note: Some("for the talk".into()),
        };
        assert_eq!(
            save_clip(dir.path(), &noted).unwrap(),
            Saved::DuplicateNoteDropped
        );
    }
}
