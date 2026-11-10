use sha2::{Digest, Sha256};

/// A source-recorded absolute cwd, not a claim of repository equivalence.
/// Preserve every byte and path kind: case folding, home stripping and
/// worktree-name heuristics can merge unrelated repositories.
pub(super) fn project_key(cwd: &str) -> Option<String> {
    if cwd.is_empty() || cwd.chars().any(char::is_control) {
        return None;
    }
    let bytes = cwd.as_bytes();
    let (kind, separator): (&[u8], char) = if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
    {
        (b"drive", '\\')
    } else if cwd.starts_with("\\\\") {
        (b"unc", '\\')
    } else if cwd.starts_with('/') {
        (b"posix", '/')
    } else {
        return None;
    };
    let parts: Vec<_> = cwd
        .split(|c| c == separator || (separator == '\\' && c == '/'))
        .filter(|part| !part.is_empty())
        .collect();
    if parts.is_empty()
        || parts.iter().any(|part| matches!(*part, "." | ".."))
        || (kind == b"drive" && parts.len() < 2)
        || (kind == b"unc" && parts.len() < 3)
    {
        return None;
    }
    let mut digest = Sha256::new();
    digest.update(b"myco:recorded-cwd:v1\0");
    digest.update(kind);
    digest.update([0]);
    digest.update(cwd.as_bytes());
    Some(format!("p5-{:x}", digest.finalize()))
}

pub(super) fn folder_title(cwd: &str) -> Option<String> {
    project_key(cwd)?;
    let windows = !cwd.starts_with('/');
    let last = cwd
        .split(|c| c == '/' || (windows && c == '\\'))
        .rfind(|part| !part.is_empty())?;
    super::clean_title(last)
}
