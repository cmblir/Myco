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
use tauri::menu::{IconMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Event the frontend listens on for tray menu actions. Payload is one of
/// "overview" | "settings" | "query" | "distill".
pub const TRAY_ACTION_EVENT: &str = "myco://tray-action";

/// One running activity. `kind` picks the row icon ("ask" | "distill" |
/// "index"); unknown kinds just render without an icon.
#[derive(Debug, Clone, Deserialize)]
pub struct RunningRow {
    #[serde(default)]
    pub kind: String,
    pub text: String,
}

/// Snapshot the frontend sends. All strings arrive already translated
/// (ko/en/ja per the app's own lang setting); empty strings hide their row.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct TrayStatus {
    /// Pre-formatted running rows ("Distilling — session digest", "Indexing
    /// 218/302" — progress stays text: native menus can't draw the in-app
    /// progress bar), rendered as disabled info items at the top.
    #[serde(default)]
    pub running: Vec<RunningRow>,
    /// Section headers, rendered as disabled rows above their section —
    /// native menus have no styled headers, a disabled item is the
    /// platform-honest equivalent. Empty string (or an empty section)
    /// drops the header entirely.
    #[serde(default, rename = "runningHeader")]
    pub running_header: String,
    #[serde(default, rename = "waitingHeader")]
    pub waiting_header: String,
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

/// Which bundled icon a row shows (icons/tray/menu/*.png).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RowIcon {
    Ask,
    Distill,
    Index,
    Link,
    Mcp,
}

fn icon_for_kind(kind: &str) -> Option<RowIcon> {
    match kind {
        "ask" => Some(RowIcon::Ask),
        "distill" => Some(RowIcon::Distill),
        "index" => Some(RowIcon::Index),
        _ => None,
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
    pub icon: Option<RowIcon>,
}

impl MenuRow {
    fn item(id: &str, text: &str, enabled: bool) -> Self {
        Self {
            id: id.into(),
            text: text.into(),
            enabled,
            separator: false,
            icon: None,
        }
    }
    fn icon_item(id: &str, text: &str, enabled: bool, icon: Option<RowIcon>) -> Self {
        Self {
            icon,
            ..Self::item(id, text, enabled)
        }
    }
    fn separator() -> Self {
        Self {
            id: String::new(),
            text: String::new(),
            enabled: false,
            separator: true,
            icon: None,
        }
    }
}

/// Layout per the approved menubar-v2 design: "now working on" header +
/// running rows (disabled), separator, "waiting" header + standing rows
/// (suggested → Overview, MCP → Settings), separator, actions. A header is
/// emitted only when its section is non-empty AND its label is non-empty;
/// rows with an empty label are omitted, as are separators that would end
/// up leading, trailing, or doubled.
pub fn menu_rows(s: &TrayStatus) -> Vec<MenuRow> {
    let mut sections: Vec<Vec<MenuRow>> = Vec::new();

    let mut running: Vec<MenuRow> = s
        .running
        .iter()
        .filter(|r| !r.text.is_empty())
        .enumerate()
        .map(|(i, r)| {
            MenuRow::icon_item(
                &format!("tray-run-{i}"),
                &r.text,
                false,
                icon_for_kind(&r.kind),
            )
        })
        .collect();
    if !running.is_empty() && !s.running_header.is_empty() {
        running.insert(
            0,
            MenuRow::item("tray-hdr-running", &s.running_header, false),
        );
    }
    sections.push(running);

    let mut standing = Vec::new();
    if !s.suggested.is_empty() {
        standing.push(MenuRow::icon_item(
            "tray-overview",
            &s.suggested,
            true,
            Some(RowIcon::Link),
        ));
    }
    if !s.mcp.is_empty() {
        standing.push(MenuRow::icon_item(
            "tray-settings",
            &s.mcp,
            true,
            Some(RowIcon::Mcp),
        ));
    }
    if !standing.is_empty() && !s.waiting_header.is_empty() {
        standing.insert(
            0,
            MenuRow::item("tray-hdr-waiting", &s.waiting_header, false),
        );
    }
    sections.push(standing);

    let mut actions = Vec::new();
    if !s.ask.is_empty() {
        actions.push(MenuRow::icon_item(
            "tray-query",
            &s.ask,
            true,
            Some(RowIcon::Ask),
        ));
    }
    if !s.distill.is_empty() {
        actions.push(MenuRow::icon_item(
            "tray-distill",
            &s.distill,
            true,
            Some(RowIcon::Distill),
        ));
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

/// Decode a bundled row icon. Cheap enough to do per menu rebuild (tiny
/// PNGs, rebuilds are rate-limited to ~1/s by the frontend sender).
fn row_icon_image(icon: RowIcon) -> tauri::Result<tauri::image::Image<'static>> {
    let bytes: &[u8] = match icon {
        RowIcon::Ask => include_bytes!("../icons/tray/menu/ask.png"),
        RowIcon::Distill => include_bytes!("../icons/tray/menu/distill.png"),
        RowIcon::Index => include_bytes!("../icons/tray/menu/index.png"),
        RowIcon::Link => include_bytes!("../icons/tray/menu/link.png"),
        RowIcon::Mcp => include_bytes!("../icons/tray/menu/mcp.png"),
    };
    tauri::image::Image::from_bytes(bytes)
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, s: &TrayStatus) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    for row in menu_rows(s) {
        if row.separator {
            menu.append(&PredefinedMenuItem::separator(app)?)?;
        } else if let Some(icon) = row.icon {
            menu.append(&IconMenuItem::with_id(
                app,
                row.id,
                row.text,
                row.enabled,
                Some(row_icon_image(icon)?),
                None::<&str>,
            )?)?;
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

    fn run(kind: &str, text: &str) -> RunningRow {
        RunningRow {
            kind: kind.into(),
            text: text.into(),
        }
    }

    fn full_status() -> TrayStatus {
        TrayStatus {
            running: vec![
                run("distill", "Distilling — digest"),
                run("index", "Indexing 218/302"),
            ],
            running_header: "Now working on".into(),
            waiting_header: "Waiting".into(),
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
    fn full_layout_matches_approved_design_order() {
        let rows = menu_rows(&full_status());
        let ids: Vec<&str> = rows
            .iter()
            .map(|r| if r.separator { "---" } else { r.id.as_str() })
            .collect();
        assert_eq!(
            ids,
            vec![
                "tray-hdr-running",
                "tray-run-0",
                "tray-run-1",
                "---",
                "tray-hdr-waiting",
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
    fn headers_are_disabled_and_iconless_running_rows_disabled_with_icons() {
        let rows = menu_rows(&full_status());
        let hdr = &rows[0];
        assert!(!hdr.enabled && hdr.icon.is_none());
        assert_eq!(rows[1].icon, Some(RowIcon::Distill));
        assert!(!rows[1].enabled);
        assert_eq!(rows[2].icon, Some(RowIcon::Index));
        assert!(!rows[2].enabled);
    }

    #[test]
    fn standing_and_action_rows_carry_their_icons() {
        let rows = menu_rows(&full_status());
        let icon_of = |id: &str| rows.iter().find(|r| r.id == id).unwrap().icon;
        assert_eq!(icon_of("tray-overview"), Some(RowIcon::Link));
        assert_eq!(icon_of("tray-settings"), Some(RowIcon::Mcp));
        assert_eq!(icon_of("tray-query"), Some(RowIcon::Ask));
        assert_eq!(icon_of("tray-distill"), Some(RowIcon::Distill));
        assert_eq!(icon_of("tray-open"), None);
        assert_eq!(icon_of("tray-quit"), None);
    }

    #[test]
    fn unknown_running_kind_renders_without_icon() {
        let s = TrayStatus {
            running: vec![run("mystery", "Doing something")],
            ..full_status()
        };
        assert_eq!(menu_rows(&s)[1].icon, None);
    }

    #[test]
    fn empty_running_section_drops_its_header_entirely() {
        let s = TrayStatus {
            running: vec![],
            ..full_status()
        };
        let rows = menu_rows(&s);
        assert!(!rows[0].separator, "no leading separator");
        assert_eq!(rows[0].id, "tray-hdr-waiting");
        assert!(rows.iter().all(|r| r.id != "tray-hdr-running"));
        assert_eq!(rows.iter().filter(|r| r.separator).count(), 1);
    }

    #[test]
    fn empty_waiting_section_drops_its_header_entirely() {
        let s = TrayStatus {
            suggested: String::new(),
            mcp: String::new(),
            ..full_status()
        };
        let rows = menu_rows(&s);
        assert!(rows.iter().all(|r| r.id != "tray-hdr-waiting"));
    }

    #[test]
    fn empty_header_label_is_omitted_but_rows_stay() {
        let s = TrayStatus {
            running_header: String::new(),
            ..full_status()
        };
        let rows = menu_rows(&s);
        assert_eq!(rows[0].id, "tray-run-0");
        assert!(rows.iter().all(|r| r.id != "tray-hdr-running"));
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
        s.running = vec![run("ask", "")];
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
