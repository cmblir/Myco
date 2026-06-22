// End-to-end Ingest workflow test through the exact Rust function the
// desktop app calls. Mirrors PageIngest.tsx → ipc.claudeRun → Rust
// claude::run_prompt.

use memex_lib::claude;

const PROMPT: &str = r#"New source has been added at `raw/test-attention.md` (title: "Attention mechanism test source"). Ingest it into the wiki following CLAUDE.md:

1. Read the source.
2. Create `wiki/attention.md` (type: technique) with required frontmatter and inline [^src-test-attention] citations.
3. Create the source-summary page `wiki/source-test-attention.md`.
4. Update `wiki/index.md` and append to `wiki/log.md`.
5. Write `ingest-reports/2026-05-18-test-attention.md`.

Output a one-line confirmation when done."#;

fn main() {
    let home = std::env::var("HOME").expect("HOME");
    let vault = format!("{home}/Documents/Memex");

    println!("Running ingest workflow through memex_lib::claude::run_prompt");
    println!("cwd: {vault}");
    let start = std::time::Instant::now();
    match claude::run_prompt(PROMPT, &vault, None) {
        Ok(r) => {
            let elapsed = start.elapsed();
            println!("\n status: {}", r.status);
            println!(" elapsed: {:.1}s", elapsed.as_secs_f64());
            println!("\n— stdout —\n{}", r.stdout);
            if !r.stderr.is_empty() {
                println!("\n— stderr —\n{}", r.stderr);
            }
            if r.status != 0 {
                std::process::exit(2);
            }
        }
        Err(e) => {
            eprintln!("FAIL: {e}");
            std::process::exit(3);
        }
    }
}
