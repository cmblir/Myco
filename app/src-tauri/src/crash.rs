// Reads the panic log `install_panic_hook` (lib.rs) writes, for the Settings ->
// About crash viewer (ROADMAP P2). The hook's format is
// `[unix TS] panic at LOCATION: MESSAGE` — parsing here must invert exactly
// that `writeln!`, nothing more general.

use serde::Serialize;
use std::path::Path;

/// One parsed panic log line.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PanicEntry {
    pub unix_secs: u64,
    pub location: String,
    pub message: String,
    /// The untouched log line — what "Copy a bug report" pastes verbatim, so
    /// the report can never drift from what the hook actually wrote.
    pub raw: String,
}

fn parse_panic_line(line: &str) -> Option<PanicEntry> {
    let raw = line.trim_end_matches(['\r', '\n']);
    let body = raw.strip_prefix("[unix ")?;
    let (secs_str, rest) = body.split_once(']')?;
    let unix_secs: u64 = secs_str.trim().parse().ok()?;
    let rest = rest.trim_start().strip_prefix("panic at ")?;
    let (location, message) = rest.split_once(": ")?;
    if location.is_empty() {
        return None;
    }
    Some(PanicEntry {
        unix_secs,
        location: location.to_string(),
        message: message.to_string(),
        raw: raw.to_string(),
    })
}

// ponytail: fixed tail-read cap, not a config knob — revisit if a single
// session ever logs enough panics to fill 256KB (thousands of entries).
const MAX_READ_BYTES: u64 = 256 * 1024;

/// Last `limit` panic entries, oldest first. Reads at most the tail
/// `MAX_READ_BYTES` of the file so a runaway log can't be pulled fully into
/// memory; a line clipped by that seek (or any other unparsable line) is
/// skipped rather than failing the whole read. A missing file yields an empty
/// list, never an error — no crash yet is the common case.
pub fn recent_panics(path: &Path, limit: usize) -> Vec<PanicEntry> {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(MAX_READ_BYTES);
    if start > 0 && file.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&buf);
    let mut entries: Vec<PanicEntry> = text.lines().filter_map(parse_panic_line).collect();
    if entries.len() > limit {
        entries.drain(0..entries.len() - limit);
    }
    entries
}

/// Delete the panic log. A file that is already gone is not an error.
pub fn clear_log(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Best-effort OS name + version for bug reports. Shells out to the
/// platform's own version tool instead of pulling in an `os_info`/`sysinfo`
/// crate for one string; falls back to the bare platform+arch if the command
/// is missing or fails.
pub fn os_version() -> String {
    let fallback = || format!("{} {}", std::env::consts::OS, std::env::consts::ARCH);
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("sw_vers")
            .arg("-productVersion")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|v| format!("macOS {}", v.trim()))
            .unwrap_or_else(fallback)
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "ver"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|v| v.trim().to_string())
            .unwrap_or_else(fallback)
    }
    #[cfg(target_os = "linux")]
    {
        std::fs::read_to_string("/etc/os-release")
            .ok()
            .and_then(|s| {
                s.lines()
                    .find_map(|l| l.strip_prefix("PRETTY_NAME="))
                    .map(|v| v.trim_matches('"').to_string())
            })
            .unwrap_or_else(fallback)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        fallback()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_log(dir: &tempfile::TempDir, contents: &str) -> std::path::PathBuf {
        let path = dir.path().join("myco-panic.log");
        std::fs::write(&path, contents).unwrap();
        path
    }

    #[test]
    fn parses_a_real_shaped_line() {
        let line = "[unix 1755000000] panic at src/vault.rs:42:9: called `Option::unwrap()` on a `None` value";
        let e = parse_panic_line(line).unwrap();
        assert_eq!(e.unix_secs, 1755000000);
        assert_eq!(e.location, "src/vault.rs:42:9");
        assert_eq!(e.message, "called `Option::unwrap()` on a `None` value");
        assert_eq!(e.raw, line);
    }

    // Representative of the Hangul slice-panic diagnosed this week: a
    // byte-index string slice landing inside a multi-byte character. The
    // parser splits only on ASCII "]"/": " markers, so the Korean payload
    // must survive untouched end to end.
    #[test]
    fn multibyte_message_survives() {
        let line = "[unix 1755000001] panic at src/vault.rs:88:15: byte index 5 is not a char boundary; it is inside '한' (bytes 3..6) of `제목한글텍스트`";
        let e = parse_panic_line(line).unwrap();
        assert!(e.message.contains("제목한글텍스트"));
        assert!(e.message.contains('한'));

        let dir = tempfile::tempdir().unwrap();
        let path = write_log(&dir, &format!("{line}\n"));
        let found = recent_panics(&path, 10);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].message, e.message);
    }

    #[test]
    fn truncated_last_line_is_skipped_not_fatal() {
        // A write cut short by a kill mid-`writeln!` — no ": MESSAGE" ever
        // landed, so there is nothing to split on. Must be dropped, not
        // mistaken for a valid (empty-message) entry.
        let good = "[unix 1755000002] panic at src/a.rs:1:1: boom\n";
        let truncated = "[unix 1755000003] panic at src/b";
        let dir = tempfile::tempdir().unwrap();
        let path = write_log(&dir, &format!("{good}{truncated}"));
        let found = recent_panics(&path, 10);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].location, "src/a.rs:1:1");
    }

    #[test]
    fn missing_file_is_empty_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("does-not-exist.log");
        assert_eq!(recent_panics(&path, 10), Vec::new());
        // Clearing an already-absent log is a no-op, not an error.
        assert!(clear_log(&path).is_ok());
    }

    #[test]
    fn oversized_file_is_capped_and_keeps_the_last_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("myco-panic.log");
        let mut file = std::fs::File::create(&path).unwrap();
        // Well over MAX_READ_BYTES so the seek-based cap actually engages.
        for i in 0..20_000u64 {
            writeln!(
                file,
                "[unix {}] panic at src/loop.rs:{i}:1: iteration {i}",
                1_700_000_000 + i
            )
            .unwrap();
        }
        drop(file);
        assert!(std::fs::metadata(&path).unwrap().len() > MAX_READ_BYTES);

        let found = recent_panics(&path, 5);
        assert_eq!(found.len(), 5);
        // Last entry written must be last entry returned.
        assert_eq!(found[4].message, "iteration 19999");
        assert!(found[4].unix_secs > found[0].unix_secs);
    }

    #[test]
    fn clear_log_removes_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_log(&dir, "[unix 1] panic at a:1:1: x\n");
        assert!(path.exists());
        clear_log(&path).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn os_version_is_never_empty() {
        assert!(!os_version().is_empty());
    }
}
