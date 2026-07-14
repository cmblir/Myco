// Memex application entry point. The Tauri builder wires IPC commands and
// plugins. Domain logic lives in dedicated modules and stays testable without
// the Tauri runtime.

pub mod agent_tools;
pub mod claude;
pub mod cli_agent;
mod commands;
pub mod embeddings;
pub mod extract;
pub mod git_log;
pub mod index;
pub mod local_llm;
pub mod mcp_server;
pub mod memex_pro;
pub mod ollama;
pub mod parser;
pub mod provenance;
pub mod providers;
pub mod sample_vault;
pub mod schedules;
pub mod secrets;
pub mod settings;
pub mod vault;
pub mod vector_index;
pub mod whisper;
pub mod youtube;

use tauri::Manager as _;

/// Where the panic hook writes its report. Populated with the resolved app log
/// dir during setup; until then (or if resolution fails) the hook falls back
/// to the system temp dir.
static PANIC_LOG_PATH: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

fn panic_log_path() -> std::path::PathBuf {
    PANIC_LOG_PATH
        .get()
        .cloned()
        .unwrap_or_else(|| std::env::temp_dir().join("memex-panic.log"))
}

/// Release builds use `panic = "abort"` (Cargo.toml), so a backend panic kills
/// the window with no trace. This hook appends the panic message + location to
/// a log file before the process dies, leaving a post-mortem breadcrumb. Panic
/// hooks run before the abort, so this works even without unwinding.
fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".into());
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "<non-string panic payload>".into());
        let unix_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(panic_log_path())
        {
            use std::io::Write;
            let _ = writeln!(file, "[unix {unix_secs}] panic at {location}: {message}");
        }
        previous(info);
    }));
}

pub fn run() {
    install_panic_hook();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // Confinement root for filesystem commands; populated on open_vault.
        .manage(commands::VaultRoot::default())
        // Embedded local model — lazily loaded on first local_* command.
        .manage(commands::LocalLlmState::default())
        .invoke_handler(tauri::generate_handler![
            commands::open_vault,
            commands::ensure_default_vault,
            commands::list_files,
            commands::file_mtimes,
            commands::read_file,
            commands::read_raw_bytes,
            commands::read_vault_context,
            commands::write_file,
            commands::write_run_log,
            commands::scaffold_obsidian_vault,
            commands::read_external_text,
            commands::describe_image,
            commands::whisper_check,
            commands::transcribe_media,
            commands::create_file,
            commands::create_folder,
            commands::delete_path,
            commands::rename_path,
            commands::build_link_graph,
            commands::search_vault,
            commands::git_log,
            commands::claude_run,
            commands::claude_run_stream,
            commands::claude_cancel,
            commands::claude_check,
            commands::agent_check,
            commands::agent_run,
            commands::scan_provenance,
            commands::memex_pro_ingest,
            commands::memex_pro_login,
            commands::memex_pro_logout,
            commands::set_provider_key,
            commands::delete_provider_key,
            commands::get_settings,
            commands::set_settings,
            commands::chat_complete,
            commands::agent_tools_schema,
            commands::agent_tool_call,
            commands::agent_chat,
            commands::list_provider_models,
            commands::ollama_status,
            commands::ollama_install_url,
            commands::open_external,
            commands::mcp_registration_info,
            commands::mcp_install,
            commands::mcp_register,
            commands::mcp_serve,
            commands::mcp_stop,
            commands::local_classify,
            commands::local_query,
            commands::reindex_embeddings,
            commands::semantic_search,
            commands::related_pages,
            commands::embeddings_status,
            commands::semantic_edges,
            commands::fetch_youtube_transcript,
            commands::list_schedules,
            commands::upsert_schedule,
            commands::delete_schedule,
            commands::install_background_schedule,
        ])
        .setup(|app| {
            // Retarget the panic hook at the app log dir now that the path
            // resolver is available. Best-effort: on failure the hook keeps
            // writing to the temp-dir fallback.
            if let Ok(dir) = app.path().app_log_dir() {
                let _ = std::fs::create_dir_all(&dir);
                let _ = PANIC_LOG_PATH.set(dir.join("memex-panic.log"));
            }
            // Auto-start the app-hosted SSE MCP server if it's been installed,
            // so a registered `claude mcp add --transport sse memex …` just
            // works each launch. Best-effort — a failure never blocks startup.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let _ = mcp_server::serve(&handle);
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running Memex")
        .run(|_app, event| {
            // The embedded llama.cpp/ggml Metal backend aborts inside its C++
            // static destructors during process teardown. On macOS, quitting goes
            // AppKit `-[NSApplication terminate:]` → `exit()` → `__cxa_finalize`,
            // which runs those destructors and aborts — so every quit popped a
            // "Memex quit unexpectedly" dialog. RunEvent::Exit fires only after the
            // run loop returns, which never happens (AppKit calls exit() itself),
            // so we intercept at ExitRequested (emitted from applicationShould-
            // Terminate, BEFORE AppKit's exit()) and terminate immediately with
            // _exit(), which skips atexit / C++ static destructors entirely.
            //
            // Safe here: all app state is persisted incrementally (settings.json,
            // vault markdown), so there is nothing that needs those finalizers.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                claude::cancel_all(); // reap in-flight claude children
                mcp_server::stop_sse(); // don't orphan the SSE server child
                // SAFETY: _exit simply ends the process; no Rust state needs
                // unwinding, and it is async-signal-safe.
                unsafe {
                    extern "C" {
                        fn _exit(code: i32) -> !;
                    }
                    _exit(0)
                }
            }
        });
}
