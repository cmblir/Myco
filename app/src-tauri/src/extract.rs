// Text extraction for ingest inputs. The ingest pipeline writes a markdown
// source into raw/ from plain text; this lets the user drop binary/spreadsheet
// sources too (PDF, XLSX/XLS/ODS) by extracting their text first. CSV and other
// text-like files are read as-is.
//
// PDF/spreadsheet parsing runs on UNTRUSTED bytes through third-party parsers
// (pdf-extract, calamine) in a build compiled with `panic = "abort"`. A panic or
// OOM in those parsers would otherwise abort the whole app — the process that
// holds the vault filesystem handles and the OS keyring. So the IPC command goes
// through `extract_text_isolated`, which re-invokes this same binary as a
// short-lived child (`--extract-text <path>`); a crash/non-zero exit there is
// caught and returned as a normal `Err` instead of killing the UI. `extract_text`
// itself is the in-process worker (used by that child and by unit tests).

use calamine::{open_workbook_auto, Data, Reader};
use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

// Ceiling on the INPUT file size — guards against a huge file blowing up memory
// during parse.
const MAX_BYTES: u64 = 25 * 1024 * 1024;

// Ceiling on the EXTRACTED text we accumulate / return, independent of input
// size. xlsx/ods are zip containers, so a small file can inflate to far more
// text (a "zip bomb"), and pdf-extract can emit a large string. Capping the
// output bounds memory regardless of how the input expands.
const MAX_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

// Hard ceiling on cells walked in a workbook, so a sheet declaring a gigantic
// used-range cannot pin CPU/allocator before the byte cap trips.
const MAX_CELLS: usize = 5_000_000;

// Wall-clock bound on the isolated extractor child (kills a hung/looping parser).
const EXTRACT_TIMEOUT_SECS: u64 = 120;

/// Extract a file's text in a SEPARATE short-lived process (this same binary
/// re-invoked with `--extract-text <path>`). Because PDF/spreadsheet parsing runs
/// on untrusted bytes under `panic = "abort"`, isolating it means a parser panic,
/// abort, or OOM becomes a non-zero child exit we surface as `Err` — it can no
/// longer take down the app holding the vault FS + keyring. Falls back to
/// in-process extraction when the current exe can't be resolved (e.g. unit tests).
pub fn extract_text_isolated(path: &str) -> Result<String, String> {
    // Cheap in-process pre-checks (no parser involved) so obvious errors skip the
    // spawn cost and surface identically to the in-process path.
    let p = Path::new(path);
    if !p.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let exe = match std::env::current_exe() {
        Ok(e) => e,
        Err(_) => return extract_text(path),
    };

    let mut child = Command::new(exe)
        .arg("--extract-text")
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn extractor failed: {e}"))?;

    let mut so = child.stdout.take().ok_or("no stdout handle")?;
    let se = child.stderr.take();
    // Drain stdout (capped) on a thread and stderr on another so a chatty parser
    // can't deadlock by filling a pipe while we wait on the other.
    let out_handle = std::thread::spawn(move || read_capped(&mut so, MAX_OUTPUT_BYTES + 4096));
    let err_handle = se.map(|mut se| {
        std::thread::spawn(move || {
            let mut b = Vec::new();
            let _ = se.read_to_end(&mut b);
            b
        })
    });

    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {
                if start.elapsed() >= Duration::from_secs(EXTRACT_TIMEOUT_SECS) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(
                        "file extraction timed out (the file may be corrupt or malicious)".into(),
                    );
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("extractor wait failed: {e}")),
        }
    };

    let stdout = out_handle
        .join()
        .map_err(|_| "extractor stdout thread panicked".to_string())??;
    let stderr = err_handle.and_then(|h| h.join().ok()).unwrap_or_default();

    if status.success() {
        Ok(String::from_utf8_lossy(&stdout).into_owned())
    } else {
        // Under panic = "abort", a parser panic lands here as a non-zero exit.
        let msg = String::from_utf8_lossy(&stderr);
        let msg = msg.trim();
        if msg.is_empty() {
            Err("could not parse file (it may be corrupt or malicious)".into())
        } else {
            Err(msg.chars().take(300).collect())
        }
    }
}

// Read from `r` into a buffer, stopping once `max` bytes are read so a hostile
// child cannot stream an unbounded body back to us.
fn read_capped<R: Read>(r: &mut R, max: usize) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 64 * 1024];
    loop {
        let n = r
            .read(&mut chunk)
            .map_err(|e| format!("read failed: {e}"))?;
        if n == 0 {
            break;
        }
        if buf.len() + n > max {
            let room = max.saturating_sub(buf.len());
            buf.extend_from_slice(&chunk[..room]);
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    Ok(buf)
}

/// Extract a file's textual content IN-PROCESS, dispatching on extension. PDF and
/// spreadsheets are parsed to text; everything else (md/txt/csv/tsv/html/json/
/// yaml…) is read as UTF-8. Prefer `extract_text_isolated` from the IPC layer so
/// a parser crash can't take down the app.
pub fn extract_text(path: &str) -> Result<String, String> {
    let p = Path::new(path);
    if !p.is_file() {
        return Err(format!("not a file: {path}"));
    }
    let meta = fs::metadata(p).map_err(|e| format!("stat failed: {e}"))?;
    if meta.len() > MAX_BYTES {
        return Err(format!(
            "file too large: {} bytes (limit 25 MB)",
            meta.len()
        ));
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "pdf" => extract_pdf(p),
        "xlsx" | "xls" | "xlsm" | "xlsb" | "ods" => extract_spreadsheet(p),
        // csv/tsv and every text-like format: read straight through.
        _ => fs::read_to_string(p).map_err(|e| format!("read failed: {e}")),
    }
}

fn extract_pdf(p: &Path) -> Result<String, String> {
    let text = pdf_extract::extract_text(p).map_err(|e| format!("pdf extract failed: {e}"))?;
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(
            "no text found in PDF (it may be a scanned image — OCR is not supported)".into(),
        );
    }
    if trimmed.len() > MAX_OUTPUT_BYTES {
        let cut = truncate_on_boundary(trimmed, MAX_OUTPUT_BYTES);
        return Ok(format!(
            "{cut}\n…(truncated: PDF text exceeds the extraction limit)…"
        ));
    }
    Ok(trimmed.to_string())
}

fn extract_spreadsheet(p: &Path) -> Result<String, String> {
    let mut wb = open_workbook_auto(p).map_err(|e| format!("spreadsheet open failed: {e}"))?;
    let mut out = String::new();
    let mut cells_seen = 0usize;
    'sheets: for name in wb.sheet_names() {
        let range = match wb.worksheet_range(&name) {
            Ok(r) => r,
            Err(e) => {
                out.push_str(&format!("## Sheet: {name} (unreadable: {e})\n\n"));
                continue;
            }
        };
        if range.is_empty() {
            continue;
        }
        out.push_str(&format!("## Sheet: {name}\n\n"));
        for row in range.rows() {
            let cells: Vec<String> = row.iter().map(cell_to_string).collect();
            out.push_str(&cells.join(", "));
            out.push('\n');
            cells_seen += row.len();
            // Bound both the accumulated text and the cells walked so a zip-bomb
            // or a sheet with a gigantic declared range can't OOM/pin the process.
            if out.len() >= MAX_OUTPUT_BYTES || cells_seen >= MAX_CELLS {
                out.push_str("\n…(truncated: spreadsheet exceeds the extraction limit)…\n");
                break 'sheets;
            }
        }
        out.push('\n');
    }
    let trimmed = out.trim();
    if trimmed.is_empty() {
        return Err("no readable cells found in the spreadsheet".into());
    }
    Ok(trimmed.to_string())
}

fn cell_to_string(c: &Data) -> String {
    match c {
        Data::Empty => String::new(),
        Data::String(s) => s.clone(),
        Data::Float(f) => f.to_string(),
        Data::Int(i) => i.to_string(),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(d) => d.to_string(),
        other => other.to_string(),
    }
}

/// Largest prefix of `s` no longer than `max` bytes ending on a UTF-8 boundary.
fn truncate_on_boundary(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tmp(name: &str, content: &[u8]) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("memex-extract-{}-{name}", std::process::id()));
        let mut f = fs::File::create(&p).unwrap();
        f.write_all(content).unwrap();
        p
    }

    #[test]
    fn csv_and_text_read_through() {
        let p = tmp("a.csv", b"model,price\nhaiku,1.0\n");
        let out = extract_text(p.to_str().unwrap()).unwrap();
        assert!(out.contains("haiku,1.0"));
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn unknown_text_extension_reads_as_text() {
        let p = tmp("b.md", b"# Title\nbody\n");
        let out = extract_text(p.to_str().unwrap()).unwrap();
        assert!(out.starts_with("# Title"));
        let _ = fs::remove_file(&p);
    }

    #[test]
    fn missing_file_errors() {
        assert!(extract_text("/no/such/file.pdf").is_err());
        // The isolated path pre-checks existence before spawning.
        assert!(extract_text_isolated("/no/such/file.pdf").is_err());
    }

    #[test]
    fn truncate_on_boundary_keeps_valid_utf8() {
        let s = "héllo wörld"; // multi-byte chars
        let cut = truncate_on_boundary(s, 3);
        assert!(s.starts_with(cut));
        assert!(cut.len() <= 3);
    }

    #[test]
    fn read_capped_stops_at_limit() {
        let data = vec![b'x'; 1000];
        let mut slice = &data[..];
        let out = read_capped(&mut slice, 100).unwrap();
        assert_eq!(out.len(), 100);
    }
}
