// Memex application entry point. The Tauri builder wires IPC commands and
// plugins. Domain logic lives in dedicated modules and stays testable without
// the Tauri runtime.

pub mod claude;
pub mod cli_agent;
mod commands;
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
pub mod secrets;
pub mod settings;
pub mod vault;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
            commands::read_vault_context,
            commands::write_file,
            commands::write_run_log,
            commands::scaffold_obsidian_vault,
            commands::read_external_text,
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
            commands::list_provider_models,
            commands::ollama_status,
            commands::ollama_install_url,
            commands::open_external,
            commands::mcp_registration_info,
            commands::mcp_install,
            commands::mcp_register,
            commands::local_classify,
            commands::local_query,
        ])
        .setup(|_app| Ok(()))
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
