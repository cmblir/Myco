// Text extraction for ingest inputs. The ingest pipeline writes a markdown
// source into raw/ from plain text; this lets the user drop binary/spreadsheet
// sources too (PDF, XLSX/XLS/ODS) by extracting their text first. CSV and other
// text-like files are read as-is. Used by the read_external_text command.

use calamine::{open_workbook_auto, Data, Reader};
use std::fs;
use std::path::Path;

// Same ceiling as the old text-only path — guards against a huge file blowing up
// memory during parse.
const MAX_BYTES: u64 = 25 * 1024 * 1024;

/// Extract a file's textual content, dispatching on extension. PDF and
/// spreadsheets are parsed to text; everything else (md/txt/csv/tsv/html/json/
/// yaml…) is read as UTF-8.
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
    Ok(trimmed.to_string())
}

fn extract_spreadsheet(p: &Path) -> Result<String, String> {
    let mut wb = open_workbook_auto(p).map_err(|e| format!("spreadsheet open failed: {e}"))?;
    let mut out = String::new();
    for name in wb.sheet_names() {
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
    }
}
