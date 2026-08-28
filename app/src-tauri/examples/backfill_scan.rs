//! Read-only dry run of the session backfill's selection, against a real vault.
//!
//! The card in the app shows these four numbers; this prints them without
//! opening the app, copying anything, or spending a token — so the thresholds
//! in `backfill.rs` can be checked against a real archive before a batch is
//! ever promoted.
//!
//! Run: `cargo run --example backfill_scan -- ~/Documents/Memex`

use std::path::PathBuf;

fn main() {
    let Some(arg) = std::env::args().nth(1) else {
        eprintln!("usage: cargo run --example backfill_scan -- <vault path>");
        std::process::exit(2);
    };
    let root = PathBuf::from(shellexpand(&arg));
    if !root.join("sessions").is_dir() {
        eprintln!("no sessions/ under {}", root.display());
        std::process::exit(1);
    }

    let files = myco_lib::backfill::scan_sessions(&root);
    // Nothing has been promoted from this process's point of view; the real
    // command reads `.myco/backfill.json`, which this deliberately does not
    // touch so a dry run cannot influence the app's state.
    let empty = std::collections::BTreeMap::new();
    let s = myco_lib::backfill::summarize(&files, &empty);

    let total_bytes: u64 = files.iter().map(|f| f.bytes).sum();
    println!("vault: {}", root.display());
    println!(
        "sessions found : {} ({:.1} MB)",
        s.total,
        total_bytes as f64 / 1_048_576.0
    );
    println!(
        "eligible now   : {}  ({} KB – {} KB)",
        s.eligible,
        myco_lib::backfill::MIN_BYTES / 1024,
        myco_lib::backfill::MAX_BYTES / 1024
    );
    println!("too short      : {}", s.too_small);
    println!("held, too big  : {}", s.too_large);

    let batch = myco_lib::backfill::next_batch(&files, &empty, 10);
    println!("\nfirst batch of 10 (newest first):");
    for f in &batch {
        println!("  {:>7} KB  {}", f.bytes / 1024, f.rel);
    }
}

/// `~` only — enough for a path typed on the command line.
fn shellexpand(p: &str) -> String {
    match p.strip_prefix("~/") {
        Some(rest) => format!(
            "{}/{rest}",
            std::env::var("HOME").unwrap_or_else(|_| "~".into())
        ),
        None => p.to_string(),
    }
}
