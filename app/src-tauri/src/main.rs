// Prevents the noisy console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Isolated file-extraction worker mode: `memex --extract-text <path>` parses
    // one (possibly hostile) PDF/spreadsheet/text file, writes the extracted text
    // to stdout, and exits. The app re-invokes itself this way (see
    // extract::extract_text_isolated) so a parser panic/abort/OOM is contained in
    // this child process instead of taking down the UI.
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() == Some(std::ffi::OsStr::new("--extract-text")) {
        let path = args.next().unwrap_or_default();
        match memex_lib::extract::extract_text(&path.to_string_lossy()) {
            Ok(text) => {
                use std::io::Write;
                let _ = std::io::stdout().write_all(text.as_bytes());
                std::process::exit(0);
            }
            Err(e) => {
                eprintln!("{e}");
                std::process::exit(1);
            }
        }
    }

    memex_lib::run();
}
