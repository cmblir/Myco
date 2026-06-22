// Exercises claude::run_prompt the way the desktop app's claude_run IPC
// does — same function, same vault cwd, same prompt shape. If this script
// returns a non-empty stdout with status 0, the subscription chain works.

use memex_lib::claude;

fn main() {
    let home = std::env::var("HOME").expect("HOME");
    let vault = format!("{home}/Documents/Memex");
    let status = claude::check();
    println!(
        "claude.check() → installed={} version={:?} path={:?}",
        status.installed, status.version, status.path
    );
    if !status.installed {
        eprintln!("claude CLI not installed; aborting");
        std::process::exit(1);
    }

    let prompt = "You are Memex's test prompt. Reply with exactly: PONG. \
         No other words, no punctuation, no code fences.";
    println!("\nCalling claude::run_prompt with cwd={vault}");
    println!("prompt={prompt:?}");
    let start = std::time::Instant::now();
    let result = claude::run_prompt(prompt, &vault, None);
    let elapsed = start.elapsed();
    match result {
        Ok(r) => {
            println!("\n— result —");
            println!("status: {}", r.status);
            println!("elapsed: {:.2}s", elapsed.as_secs_f64());
            println!("stdout:\n{}", r.stdout);
            if !r.stderr.is_empty() {
                println!("stderr:\n{}", r.stderr);
            }
            if r.status == 0 {
                println!("\nPASS — Claude CLI subscription chain works.");
            } else {
                println!("\nFAIL — non-zero exit");
                std::process::exit(2);
            }
        }
        Err(e) => {
            eprintln!("\nFAIL — {e}");
            std::process::exit(3);
        }
    }
}
