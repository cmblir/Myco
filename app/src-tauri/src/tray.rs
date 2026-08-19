// macOS menu bar tray — the OS half of the topbar activity system.
//
// The Rust side owns NO translations and NO activity logic: the frontend
// (lib/trayStatus.ts) watches its stores and calls `update_tray_status` with
// pre-translated labels whenever the aggregate state changes (debounced
// there, not here). This module only turns that snapshot into a native menu
// and a tray title.
//
// Menu clicks never start work in Rust — "Distill now" emits an event the
// frontend routes through the same runDistillGuarded as every other trigger,
// so there is exactly one distill entry point.

use serde::Deserialize;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Event the frontend listens on for tray menu actions. Payload is one of
/// "overview" | "settings" | "query" | "distill".
pub const TRAY_ACTION_EVENT: &str = "myco://tray-action";

/// Snapshot the frontend sends. All strings arrive already translated
/// (ko/en/ja per the app's own lang setting); empty strings hide their row.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct TrayStatus {
    /// Pre-formatted running rows ("Distilling — session digest", "Indexing
    /// 218/302"), rendered as disabled info items at the top.
    #[serde(default)]
    pub running: Vec<String>,
    /// Text next to the tray icon ("72%", "2"); None/absent clears it.
    #[serde(default)]
    pub title: Option<String>,
    /// Standing rows: suggested-links count and MCP on/off.
    #[serde(default)]
    pub suggested: String,
    #[serde(default)]
    pub mcp: String,
    /// Action rows.
    #[serde(default)]
    pub ask: String,
    #[serde(default)]
    pub distill: String,
    #[serde(default)]
    pub open: String,
    #[serde(default)]
    pub quit: String,
}

impl TrayStatus {
    /// Menu shown between app launch and the frontend's first update — plain
    /// English actions only, no state rows (the frontend replaces this within
    /// its first debounce tick).
    fn boot() -> Self {
        Self {
            open: "Open myco".into(),
            quit: "Quit myco".into(),
            ..Self::default()
        }
    }
}

/// One row of the tray menu, in display order. Pure data so the layout is
/// unit-testable without a running app.
#[derive(Debug, PartialEq)]
pub struct MenuRow {
    /// Stable id the menu-event handler matches on; empty for separators.
    pub id: String,
    pub text: String,
    pub enabled: bool,
    pub separator: bool,
}

impl MenuRow {
    fn item(id: &str, text: &str, enabled: bool) -> Self {
        Self {
            id: id.into(),
            text: text.into(),
            enabled,
            separator: false,
        }
    }
    fn separator() -> Self {
        Self {
            id: String::new(),
            text: String::new(),
            enabled: false,
            separator: true,
        }
    }
}

/// Layout mirroring the in-app popover: running rows (disabled), separator,
/// standing rows (suggested → Overview, MCP → Settings), separator, actions.
/// Rows with an empty label are omitted, as are separators that would end up
/// leading, trailing, or doubled.
pub fn menu_rows(s: &TrayStatus) -> Vec<MenuRow> {
    let mut sections: Vec<Vec<MenuRow>> = Vec::new();

    let running: Vec<MenuRow> = s
        .running
        .iter()
        .filter(|t| !t.is_empty())
        .enumerate()
        .map(|(i, t)| MenuRow::item(&format!("tray-run-{i}"), t, false))
        .collect();
    sections.push(running);

    let mut standing = Vec::new();
    if !s.suggested.is_empty() {
        standing.push(MenuRow::item("tray-overview", &s.suggested, true));
    }
    if !s.mcp.is_empty() {
        standing.push(MenuRow::item("tray-settings", &s.mcp, true));
    }
    sections.push(standing);

    let mut actions = Vec::new();
    if !s.ask.is_empty() {
        actions.push(MenuRow::item("tray-query", &s.ask, true));
    }
    if !s.distill.is_empty() {
        actions.push(MenuRow::item("tray-distill", &s.distill, true));
    }
    if !s.open.is_empty() {
        actions.push(MenuRow::item("tray-open", &s.open, true));
    }
    if !s.quit.is_empty() {
        actions.push(MenuRow::item("tray-quit", &s.quit, true));
    }
    sections.push(actions);

    let mut rows = Vec::new();
    for section in sections.into_iter().filter(|s| !s.is_empty()) {
        if !rows.is_empty() {
            rows.push(MenuRow::separator());
        }
        rows.extend(section);
    }
    rows
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, s: &TrayStatus) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    for row in menu_rows(s) {
        if row.separator {
            menu.append(&PredefinedMenuItem::separator(app)?)?;
        } else {
            menu.append(&MenuItem::with_id(
                app,
                row.id,
                row.text,
                row.enabled,
                None::<&str>,
            )?)?;
        }
    }
    Ok(menu)
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn handle_menu_id<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match id {
        "tray-quit" => app.exit(0),
        "tray-open" => show_main_window(app),
        "tray-overview" | "tray-settings" | "tray-query" => {
            show_main_window(app);
            // Route names match the frontend's RouteId values.
            let route = match id {
                "tray-overview" => "overview",
                "tray-settings" => "settings",
                _ => "query",
            };
            let _ = app.emit(TRAY_ACTION_EVENT, route);
        }
        "tray-distill" => {
            show_main_window(app);
            let _ = app.emit(TRAY_ACTION_EVENT, "distill");
        }
        _ => {}
    }
}

/// The live tray icon, kept in managed state so `update_tray_status` can
/// swap its menu/title. None until `init` runs (or if tray creation failed).
#[derive(Default)]
pub struct TrayHandle(pub Mutex<Option<tauri::tray::TrayIcon>>);

/// Build the tray icon with the template glyph and the boot menu. Called once
/// from setup; best-effort — a tray failure must never block app startup.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray/tray.png"))?;
    let tray = TrayIconBuilder::with_id("myco-tray")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("myco")
        .menu(&build_menu(app, &TrayStatus::boot())?)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| handle_menu_id(app, event.id().as_ref()))
        .build(app)?;
    app.state::<TrayHandle>().0.lock().unwrap().replace(tray);
    Ok(())
}

/// Frontend-driven tray refresh: replace the menu and the icon-side title.
/// Async so it runs on the tokio pool — menu construction marshals itself to
/// the main thread internally (tauri's run_main_thread), and calling that
/// FROM the main thread could deadlock.
#[tauri::command]
pub async fn update_tray_status(app: AppHandle, status: TrayStatus) -> Result<(), String> {
    let state = app.state::<TrayHandle>();
    let tray = {
        let guard = state.0.lock().unwrap();
        match guard.as_ref() {
            Some(t) => t.clone(),
            None => return Ok(()), // tray never came up; nothing to update
        }
    };
    let menu = build_menu(&app, &status).map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    tray.set_title(status.title.as_deref())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full_status() -> TrayStatus {
        TrayStatus {
            running: vec!["Distilling — digest".into(), "Indexing 218/302".into()],
            title: Some("2".into()),
            suggested: "3 suggested links".into(),
            mcp: "MCP server running".into(),
            ask: "Ask the wiki".into(),
            distill: "Distill now".into(),
            open: "Open myco".into(),
            quit: "Quit myco".into(),
        }
    }

    #[test]
    fn full_layout_matches_popover_order() {
        let rows = menu_rows(&full_status());
        let ids: Vec<&str> = rows
            .iter()
            .map(|r| if r.separator { "---" } else { r.id.as_str() })
            .collect();
        assert_eq!(
            ids,
            vec![
                "tray-run-0",
                "tray-run-1",
                "---",
                "tray-overview",
                "tray-settings",
                "---",
                "tray-query",
                "tray-distill",
                "tray-open",
                "tray-quit",
            ]
        );
    }

    #[test]
    fn running_rows_are_disabled_info_rows() {
        let rows = menu_rows(&full_status());
        assert!(!rows[0].enabled);
        assert!(!rows[1].enabled);
        assert!(rows
            .iter()
            .filter(|r| !r.separator)
            .skip(2)
            .all(|r| r.enabled));
    }

    #[test]
    fn idle_status_has_no_leading_separator_or_running_rows() {
        let s = TrayStatus {
            running: vec![],
            ..full_status()
        };
        let rows = menu_rows(&s);
        assert!(!rows[0].separator, "no leading separator");
        assert_eq!(rows[0].id, "tray-overview");
        assert_eq!(rows.iter().filter(|r| r.separator).count(), 1);
    }

    #[test]
    fn boot_menu_is_actions_only() {
        let rows = menu_rows(&TrayStatus::boot());
        let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
        assert_eq!(ids, vec!["tray-open", "tray-quit"]);
    }

    #[test]
    fn empty_labels_and_empty_running_entries_are_dropped() {
        let mut s = full_status();
        s.running = vec![String::new()];
        s.suggested = String::new();
        s.mcp = String::new();
        let rows = menu_rows(&s);
        let ids: Vec<&str> = rows
            .iter()
            .filter(|r| !r.separator)
            .map(|r| r.id.as_str())
            .collect();
        assert_eq!(
            ids,
            vec!["tray-query", "tray-distill", "tray-open", "tray-quit"]
        );
        assert_eq!(rows.iter().filter(|r| r.separator).count(), 0);
    }
}
