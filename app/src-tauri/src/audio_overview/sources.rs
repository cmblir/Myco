//! Retained Markdown originals and exact, bounded prompt body ranges.

use super::{BodyRange, Coverage};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const MAX_SELECTED: usize = 32;
const MAX_ORIGINAL_BYTES: usize = 4 * 1024 * 1024;
pub(super) const BODY_BUDGET: usize = 24_000;

struct Original {
    path: PathBuf,
    saved: String,
    sha256: String,
    handle: File,
}

pub(super) struct Sources {
    originals: Vec<Original>,
    pub(super) user: Arc<String>,
    pub(super) coverage: Coverage,
    pub(super) cites: BTreeSet<String>,
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn identity(handle: &File, path: &Path) -> Result<(), String> {
    let held = handle
        .metadata()
        .map_err(|error| format!("inspect held audio source: {error}"))?;
    let named = std::fs::symlink_metadata(path)
        .map_err(|error| format!("inspect audio source: {error}"))?;
    if !held.is_file() || !named.file_type().is_file() {
        return Err("audio source is not its retained regular file".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if held.dev() != named.dev()
            || held.ino() != named.ino()
            || held.nlink() != 1
            || named.nlink() != 1
        {
            return Err("audio source identity changed or has unowned hard links".into());
        }
        Ok(())
    }
    #[cfg(not(unix))]
    Err("retained audio source identity is unsupported on this platform".into())
}

fn open_regular(path: &Path) -> Result<File, String> {
    let metadata = std::fs::symlink_metadata(path)
        .map_err(|error| format!("inspect selected audio source: {error}"))?;
    if !metadata.file_type().is_file() {
        return Err("selected audio source is not a regular Markdown file".into());
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // A metadata-to-open replacement must not turn a source read into a
        // blocking FIFO. Identity is verified again on the opened handle.
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .map_err(|error| format!("open selected audio source: {error}"))?;
    identity(&file, path)?;
    Ok(file)
}

fn read(file: &File, limit: usize) -> Result<String, String> {
    if file
        .metadata()
        .map_err(|error| format!("inspect audio source length: {error}"))?
        .len()
        > limit as u64
    {
        return Err("selected audio sources exceed the retained read budget".into());
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read audio source: {error}"))?;
    if bytes.len() > limit {
        return Err("audio source grew beyond the retained read budget".into());
    }
    String::from_utf8(bytes).map_err(|error| format!("audio source is not UTF-8: {error}"))
}

fn checked_path(root: &Path, selected: &str) -> Result<PathBuf, String> {
    if selected.len() > 8192 || selected.chars().any(char::is_control) {
        return Err("invalid selected audio source path".into());
    }
    let requested = Path::new(selected);
    let absolute = if requested.is_absolute() {
        requested.to_path_buf()
    } else {
        root.join(requested)
    };
    let path = crate::vault::confine_delete_path(root, &absolute.to_string_lossy())?;
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
    {
        return Err("audio requires selected Markdown sources".into());
    }
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .ok_or("audio source name is not UTF-8")?;
    if stem.is_empty() || stem.contains(['[', ']', '|', '#', '\\', '\n', '\r']) {
        return Err("audio source name cannot form a closed citation".into());
    }
    Ok(path)
}

/// Strip only a complete leading frontmatter envelope, without parsing YAML.
fn body_range(raw: &str) -> (usize, usize) {
    let mut start = 0;
    if raw.starts_with("---\n") || raw.starts_with("---\r\n") {
        let first_line = raw.find('\n').unwrap() + 1;
        let mut offset = first_line;
        for line in raw[first_line..].split_inclusive('\n') {
            offset += line.len();
            if matches!(line.trim_end_matches(['\r', '\n']), "---" | "...") {
                start = offset;
                break;
            }
        }
    }
    let body = &raw[start..];
    let trimmed = body.trim();
    let start = start + body.len() - body.trim_start().len();
    (start, start + trimmed.len())
}

fn footnotes(body: &str, cites: &mut BTreeSet<String>) {
    let mut rest = body;
    while let Some(start) = rest.find("[^src-") {
        rest = &rest[start..];
        if let Some(end) = rest.find(']') {
            let token = &rest[..=end];
            if token.len() <= 128
                && token[2..end]
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            {
                cites.insert(token.to_owned());
            }
            rest = &rest[end + 1..];
        } else {
            break;
        }
    }
}

pub(super) fn capture(root: &Path, selected: &[String]) -> Result<Sources, String> {
    if selected.is_empty() || selected.len() > MAX_SELECTED {
        return Err("audio requires 1–32 selected Markdown sources".into());
    }
    let mut originals = Vec::new();
    let mut coverage = Coverage {
        selected_pages: Vec::new(),
        included_pages: Vec::new(),
        omitted_pages: Vec::new(),
        included_body_ranges: Vec::new(),
        budget_bytes: BODY_BUDGET,
        included_bodies_only: true,
    };
    let mut cites = BTreeSet::new();
    let mut blocks = Vec::new();
    let mut retained = 0;
    let mut used = 0;
    let mut exhausted = false;
    let mut seen = BTreeSet::new();
    for selected in selected {
        let path = checked_path(root, selected)?;
        if !seen.insert(path.clone()) {
            return Err("duplicate selected audio source".into());
        }
        let handle = open_regular(&path)?;
        let saved = read(&handle, MAX_ORIGINAL_BYTES - retained)?;
        retained += saved.len();
        identity(&handle, &path)?;
        let sha256 = sha256(saved.as_bytes());
        let name = path.to_string_lossy().into_owned();
        coverage.selected_pages.push(name.clone());
        let (start_byte, end_byte) = body_range(&saved);
        let body = &saved[start_byte..end_byte];
        let stem = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .ok_or("invalid audio source stem")?;
        let cite = format!("[[{stem}]]");
        let block = format!("===== {cite} =====\n{body}");
        let separator = if blocks.is_empty() { 0 } else { 2 };
        if !body.is_empty() && blocks.is_empty() && block.len() > BODY_BUDGET {
            return Err("the first audio source body exceeds the prompt byte budget".into());
        }
        if !body.is_empty() && !exhausted && used + separator + block.len() <= BODY_BUDGET {
            used += separator + block.len();
            blocks.push(block);
            coverage.included_pages.push(name.clone());
            coverage.included_body_ranges.push(BodyRange {
                path: name,
                start_byte,
                end_byte,
            });
            cites.insert(cite);
            footnotes(body, &mut cites);
        } else {
            if !body.is_empty() {
                exhausted = true;
            }
            coverage.omitted_pages.push(name);
        }
        originals.push(Original {
            path,
            saved,
            sha256,
            handle,
        });
    }
    if blocks.is_empty() {
        return Err("no non-empty source pages are available for the audio overview".into());
    }
    Ok(Sources {
        originals,
        coverage,
        cites,
        user: Arc::new(format!(
            "Create the audio-overview dialogue for these notes.\n\nNOTES:\n{}",
            blocks.join("\n\n")
        )),
    })
}

impl Sources {
    /// Called under the common writer lock, for every selected original.
    pub(super) fn verify(&self, root: &Path) -> Result<(), String> {
        for original in &self.originals {
            let confined = checked_path(root, &original.path.to_string_lossy())?;
            if confined != original.path {
                return Err("audio source path changed".into());
            }
            identity(&original.handle, &confined)?;
            let fresh = open_regular(&confined)?;
            let current = read(&fresh, original.saved.len())?;
            identity(&original.handle, &confined)?;
            identity(&fresh, &confined)?;
            if sha256(current.as_bytes()) != original.sha256 || current != original.saved {
                return Err("audio source revision changed".into());
            }
        }
        Ok(())
    }
}
