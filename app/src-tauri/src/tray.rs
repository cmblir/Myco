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

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::menu::{IconMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

/// Event the frontend listens on for tray menu actions. Payload is one of
/// "overview" | "settings" | "query" | "distill".
pub const TRAY_ACTION_EVENT: &str = "myco://tray-action";

/// Event the tray-panel window listens on for live status pushes; the same
/// payload `get_tray_status` returns on demand.
pub const TRAY_STATUS_EVENT: &str = "myco://tray-status";

/// The frameless popover window shown on tray LEFT-click (the native menu
/// stays on right-click as the plain fallback).
const PANEL_LABEL: &str = "tray-panel";
// Window = the 340px panel + a transparent margin ring that gives the CSS
// shadow room (the OS window shadow is OFF — drawn around the whole
// transparent rect, it rendered as a ghost outline below the card whenever
// the fixed window was taller than the content).
const PANEL_MARGIN: f64 = 24.0; // sides + bottom (CSS shadow room)
const PANEL_MARGIN_TOP: f64 = 8.0; // slim on top so the card hugs the menu bar
const PANEL_WIDTH: f64 = 340.0 + PANEL_MARGIN * 2.0; // logical px
const PANEL_HEIGHT: f64 = 440.0; // first-paint guess; resize_tray_panel fits it to content
const PANEL_GAP: f64 = 2.0; // logical px between the menu bar and the window edge

/// One running activity. `kind` picks the row icon ("ask" | "distill" |
/// "index"); unknown kinds just render without an icon.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RunningRow {
    #[serde(default)]
    pub kind: String,
    pub text: String,
}

/// Snapshot the frontend sends. All strings arrive already translated
/// (ko/en/ja per the app's own lang setting); empty strings hide their row.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
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
    /// Standing rows: suggested-links count, unseen reflect findings (empty
    /// when there are none), and MCP on/off.
    #[serde(default)]
    pub suggested: String,
    #[serde(default)]
    pub reflect: String,
    /// Quarantined items awaiting review (ROADMAP P0); empty when there are
    /// none. Routes to the Feedback page's quarantine tab, the only surface
    /// that can resolve them.
    #[serde(default)]
    pub quarantine: String,
    #[serde(default)]
    pub mcp: String,
    /// Today's-inflow block (translated lines + sparkbar buckets); None hides
    /// the section and the native menu's summary row.
    #[serde(default)]
    pub inflow: Option<TrayInflow>,
    /// Pending map proposals the PANEL can approve/reject inline (ROADMAP P0).
    /// Panel-only: a native menu row cannot carry two buttons, so the native
    /// menu keeps sending the user to the Feedback page instead.
    #[serde(default)]
    pub proposals: Vec<TrayProposal>,
    #[serde(default, rename = "proposalsMore")]
    pub proposals_more: String,
    #[serde(default, rename = "proposalApprove")]
    pub proposal_approve: String,
    #[serde(default, rename = "proposalReject")]
    pub proposal_reject: String,
    /// Shown under the rows when the query provider can't draft a map;
    /// empty otherwise.
    #[serde(default, rename = "proposalNote")]
    pub proposal_note: String,
    /// Header line under the mascot in the panel; empty hides it.
    #[serde(default)]
    pub greeting: String,
    /// Popover stat cards (panel-only; the native menu has no card idiom).
    #[serde(default)]
    pub cards: Vec<TrayCard>,
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

/// One popover stat card; `id` doubles as the tray_panel_action on click.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct TrayCard {
    pub id: String,
    pub label: String,
    pub value: String,
    #[serde(default)]
    pub sub: String,
    #[serde(default)]
    pub accent: bool,
}

/// One pending map proposal for the panel: its vault-relative path (sent back
/// with the approve/reject action) plus both lines pre-translated.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct TrayProposal {
    pub path: String,
    pub label: String,
    #[serde(default)]
    pub sub: String,
}

/// Pre-translated "today's inflow" lines for the tray-panel window, plus the
/// hourly buckets its sparkbar draws. The native menu uses only `summary`.
/// Rows are split label / sub / count so the panel can right-align the counts
/// (approved artifact); new fields default to "" for older cached payloads.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct TrayInflow {
    pub header: String,
    pub sessions: String,
    #[serde(default, rename = "sessionsSub")]
    pub sessions_sub: String,
    #[serde(default, rename = "sessionsCount")]
    pub sessions_count: String,
    pub mcp: String,
    #[serde(rename = "mcpSub")]
    pub mcp_sub: String,
    #[serde(default, rename = "mcpCount")]
    pub mcp_count: String,
    pub inbox: String,
    #[serde(default, rename = "inboxCount")]
    pub inbox_count: String,
    #[serde(default, rename = "inboxView")]
    pub inbox_view: String,
    #[serde(default, rename = "sparkCaption")]
    pub spark_caption: String,
    /// One-line summary for the native right-click menu.
    pub summary: String,
    #[serde(rename = "hourlyFiles")]
    pub hourly_files: Vec<u32>,
    #[serde(rename = "hourlyMcp")]
    pub hourly_mcp: Vec<u32>,
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
        // Reflect borrows distill's icon — same whole-vault pass, read-only.
        "distill" | "reflect" => Some(RowIcon::Distill),
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
    if !s.reflect.is_empty() {
        standing.push(MenuRow::icon_item(
            "tray-reflect",
            &s.reflect,
            true,
            Some(RowIcon::Distill),
        ));
    }
    if !s.quarantine.is_empty() {
        standing.push(MenuRow::icon_item(
            "tray-quarantine",
            &s.quarantine,
            true,
            Some(RowIcon::Distill),
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
    // Today's-inflow one-liner, right under the MCP row — a disabled info row,
    // like the running rows (the full section lives in the popover surfaces).
    if let Some(inflow) = &s.inflow {
        if !inflow.summary.is_empty() {
            standing.push(MenuRow::item("tray-inflow", &inflow.summary, false));
        }
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
        // "tray-reflect" goes to Overview too — that is where the reflect
        // panel lives.
        "tray-overview" | "tray-reflect" | "tray-settings" | "tray-query" | "tray-ingest"
        | "tray-quarantine" | "tray-proposals" | "tray-tasks" => {
            show_main_window(app);
            // Route names match the frontend's RouteId values — except
            // "quarantine"/"proposals", which the frontend expands into route
            // `feedback` plus that tab (a tab is not a route of its own).
            let route = match id {
                "tray-overview" | "tray-reflect" => "overview",
                "tray-settings" => "settings",
                "tray-ingest" => "ingest",
                "tray-quarantine" => "quarantine",
                "tray-proposals" => "proposals",
                "tray-tasks" => "tasks",
                _ => "query",
            };
            let _ = app.emit(TRAY_ACTION_EVENT, route);
        }
        "tray-distill" => {
            // No show/focus: distilling needs the main WEBVIEW alive (a hidden
            // window's webview keeps running), not the window in the user's
            // face. From the popover this also keeps the panel focused and
            // open, so the user watches it flip to "증류 중 — …" live via the
            // status push instead of everything vanishing on click.
            let _ = app.emit(TRAY_ACTION_EVENT, "distill");
        }
        _ => {}
    }
}

/// The live tray icon, kept in managed state so `update_tray_status` can
/// swap its menu/title. None until `init` runs (or if tray creation failed).
#[derive(Default)]
pub struct TrayHandle(pub Mutex<Option<tauri::tray::TrayIcon>>);

/// Last snapshot the frontend pushed, kept so the tray-panel window (a
/// separate JS context — it shares no zustand store with the main window)
/// can ask for the current state on open via `get_tray_status`. Starts at
/// the same boot menu the native tray shows before the first push.
pub struct TrayStatusCache(pub Mutex<TrayStatus>);

impl Default for TrayStatusCache {
    fn default() -> Self {
        Self(Mutex::new(TrayStatus::boot()))
    }
}

/// Click routing: LEFT release opens the popover panel; every other click is
/// ignored here (the native menu is bound to right-click by
/// `show_menu_on_left_click(false)` + tray-icon's default right-click menu).
pub fn tray_click_shows_panel(button: MouseButton, state: MouseButtonState) -> bool {
    button == MouseButton::Left && state == MouseButtonState::Up
}

/// Top-left corner (physical px) for the panel: horizontally centred under
/// the tray icon, just below the menu bar, clamped so the right edge never
/// leaves the screen (tray icons live near the right edge). `rect` is the
/// icon rect from TrayIconEvent (physical on macOS); widths are logical.
pub fn panel_position(
    rect: &tauri::Rect,
    scale: f64,
    panel_w_logical: f64,
    screen_right: Option<f64>,
) -> (f64, f64) {
    let pos = rect.position.to_physical::<f64>(scale);
    let size = rect.size.to_physical::<f64>(scale);
    let w = panel_w_logical * scale;
    let mut x = pos.x + size.width / 2.0 - w / 2.0;
    if let Some(right) = screen_right {
        // The window's own transparent margin keeps the CARD off the edge,
        // so the window may touch the screen edge exactly.
        x = x.min(right - w);
    }
    x = x.max(0.0);
    let y = pos.y + size.height + PANEL_GAP * scale;
    (x, y)
}

/// Wall-clock guards for the toggle/blur race, in ms since the unix epoch.
/// A tray click that dismisses the panel often arrives right AFTER the OS
/// already delivered the panel's focus-loss (which hid it) — a naive
/// `is_visible()` check then reads false and re-shows the panel the user
/// just tried to close. Symmetrically, a transient blur right after `show()`
/// (focus still settling) must not instantly close a fresh panel.
static PANEL_HIDDEN_BY_BLUR_AT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static PANEL_SHOWN_AT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
// Two different windows: the click-vs-blur race resolves in tens of ms (the
// blur is delivered by the same click's focus shift), so a SHORT window
// suffices — a long one eats a genuine quick re-open (blur-hide by clicking
// another app, then immediately clicking the tray to bring the panel back).
// The show-vs-transient-blur settle can take longer, so it keeps 300.
const PANEL_CLICK_GRACE_MS: u64 = 150;
const PANEL_SHOW_GRACE_MS: u64 = 300;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Pure decision for a tray click on a currently-hidden panel: a hide that
/// happened within the grace window was almost certainly the blur produced by
/// THIS click's own focus shift — the click meant "close", so stay hidden.
pub(crate) fn click_should_reshow(hidden_by_blur_at: u64, now: u64) -> bool {
    now.saturating_sub(hidden_by_blur_at) > PANEL_CLICK_GRACE_MS
}

/// Pure decision for a blur on a just-shown panel: ignore focus-loss inside
/// the grace window (focus is still settling from our own show+set_focus).
pub(crate) fn blur_should_hide(shown_at: u64, now: u64) -> bool {
    now.saturating_sub(shown_at) > PANEL_SHOW_GRACE_MS
}

/// Show (or hide, when already visible) the tray popover window, creating it
/// lazily on first click. The window is reused: reposition + show afterwards.
/// Create the (hidden) popover window if it does not exist yet. Called once
/// at startup so the FIRST tray click shows a warm, already-populated panel
/// instead of a blank card while the webview cold-loads; also the lazy path
/// inside `toggle_panel` for resilience.
pub(crate) fn ensure_panel(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    use std::sync::atomic::Ordering;
    if let Some(w) = app.get_webview_window(PANEL_LABEL) {
        return Some(w);
    }
    let built = WebviewWindowBuilder::new(
        app,
        PANEL_LABEL,
        WebviewUrl::App("index.html?window=tray".into()),
    )
    .decorations(false)
    .transparent(true)
    // OS shadow OFF: it hugs the transparent window RECT, not the
    // rounded card inside it — the card carries a CSS shadow instead
    // (inside the PANEL_MARGIN ring).
    .shadow(false)
    .always_on_top(true)
    .resizable(false)
    .skip_taskbar(true)
    .visible(false)
    .inner_size(PANEL_WIDTH, PANEL_HEIGHT)
    .build();
    match built {
        Ok(w) => {
            // Focus loss dismisses the popover, like a native menu —
            // except inside the just-shown grace window (see above).
            let hide = w.clone();
            w.on_window_event(move |e| {
                if matches!(e, tauri::WindowEvent::Focused(false))
                    && blur_should_hide(PANEL_SHOWN_AT.load(Ordering::Relaxed), now_ms())
                {
                    PANEL_HIDDEN_BY_BLUR_AT.store(now_ms(), Ordering::Relaxed);
                    let _ = hide.hide();
                }
            });
            Some(w)
        }
        Err(e) => {
            eprintln!("tray panel window failed: {e}");
            None
        }
    }
}

fn toggle_panel(app: &AppHandle, rect: tauri::Rect) {
    use std::sync::atomic::Ordering;
    let Some(win) = ensure_panel(app) else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        return;
    }
    if !click_should_reshow(PANEL_HIDDEN_BY_BLUR_AT.load(Ordering::Relaxed), now_ms()) {
        // The blur from this very click already hid the panel — the click
        // meant "close"; re-showing would make the panel undismissable.
        return;
    }
    let scale = win.scale_factor().unwrap_or(1.0);
    let probe = rect.position.to_physical::<f64>(scale);
    let screen_right = app
        .monitor_from_point(probe.x, probe.y)
        .ok()
        .flatten()
        .map(|m| f64::from(m.position().x) + f64::from(m.size().width));
    let (x, y) = panel_position(&rect, scale, PANEL_WIDTH, screen_right);
    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    PANEL_SHOWN_AT.store(now_ms(), std::sync::atomic::Ordering::Relaxed);
    let _ = win.show();
    let _ = win.set_focus();
}

// ─── icon animation ──────────────────────────────────────────────────────────
//
// The template glyph is the mascot; motion makes the menu bar read as alive
// and doubles as an activity light. Two modes, both cheap:
//   idle    — a blink every few seconds (one frame swap and back)
//   working — a continuous 4-frame bob while anything is running
// Frames are pre-baked template PNGs (black + alpha) so dark/light menu bars
// keep working; swapping goes through the same TrayHandle the menu updates use.

/// True while the status push says something is running (distill/ingest/…).
static ANIM_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

const FRAME_BASE: &[u8] = include_bytes!("../icons/tray/frames/base.png");
const FRAME_UP: &[u8] = include_bytes!("../icons/tray/frames/up.png");
const FRAME_DOWN: &[u8] = include_bytes!("../icons/tray/frames/down.png");
const FRAME_BLINK: &[u8] = include_bytes!("../icons/tray/frames/blink.png");

/// Spawn the animator. One task for the app's lifetime; ticks are no-ops when
/// nothing changes (the same frame is never re-set).
fn spawn_icon_animator(app: AppHandle) {
    use std::sync::atomic::Ordering;
    tauri::async_runtime::spawn(async move {
        // Idle blink: hold base ~4s, blink 140ms. Working bob: 160ms/frame.
        // Frame ids: 0 base, 1 up, 2 down, 3 blink.
        const FRAMES: [&[u8]; 4] = [FRAME_BASE, FRAME_UP, FRAME_DOWN, FRAME_BLINK];
        const BOB: [usize; 4] = [0, 1, 0, 2];
        let mut tick: u64 = 0;
        let mut last = usize::MAX;
        loop {
            let active = ANIM_ACTIVE.load(Ordering::Relaxed);
            let (frame, sleep_ms) = if active {
                (BOB[(tick % 4) as usize], 160)
            } else if tick % 26 == 25 {
                // One blink per idle cycle (25 × 160ms ≈ 4s between blinks).
                (3, 140)
            } else {
                (0, 160)
            };
            if frame != last {
                last = frame;
                let tray = app
                    .state::<TrayHandle>()
                    .0
                    .lock()
                    .ok()
                    .and_then(|g| g.as_ref().cloned());
                if let Some(tray) = tray {
                    if let Ok(img) = tauri::image::Image::from_bytes(FRAMES[frame]) {
                        let _ = tray.set_icon(Some(img));
                        let _ = tray.set_icon_as_template(true);
                    }
                }
            }
            tick = tick.wrapping_add(1);
            tokio::time::sleep(std::time::Duration::from_millis(sleep_ms)).await;
        }
    });
}

/// Build the tray icon with the template glyph and the boot menu. Called once
/// from setup; best-effort — a tray failure must never block app startup.
pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray/tray.png"))?;
    let tray = TrayIconBuilder::with_id("myco-tray")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("myco")
        .menu(&build_menu(app, &TrayStatus::boot())?)
        // Left-click opens the React popover panel; the native menu stays on
        // right-click (tray-icon's menu_on_right_click default) as fallback.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| handle_menu_id(app, event.id().as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button,
                button_state,
                rect,
                ..
            } = event
            {
                if tray_click_shows_panel(button, button_state) {
                    toggle_panel(tray.app_handle(), rect);
                }
            }
        })
        .build(app)?;
    app.state::<TrayHandle>().0.lock().unwrap().replace(tray);
    spawn_icon_animator(app.clone());
    // Warm the popover now (hidden): the first click must show a populated
    // card, not a blank webview mid cold-load. Best-effort like the tray.
    let _ = ensure_panel(app);
    Ok(())
}

/// Frontend-driven tray refresh: replace the menu and the icon-side title.
/// Async so it runs on the tokio pool — menu construction marshals itself to
/// the main thread internally (tauri's run_main_thread), and calling that
/// FROM the main thread could deadlock.
#[tauri::command]
pub async fn update_tray_status(app: AppHandle, status: TrayStatus) -> Result<(), String> {
    // Cache + push first: the popover panel mirrors the same snapshot the
    // native menu renders, even if the menu swap below fails.
    *app.state::<TrayStatusCache>().0.lock().unwrap() = status.clone();
    // The icon animator's mode: bob while anything runs, blink otherwise.
    ANIM_ACTIVE.store(
        !status.running.is_empty(),
        std::sync::atomic::Ordering::Relaxed,
    );
    let _ = app.emit(TRAY_STATUS_EVENT, &status);
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

/// The tray-panel window's data source: the last snapshot the main window
/// pushed (boot defaults before the first push).
#[tauri::command]
pub fn get_tray_status(app: AppHandle) -> TrayStatus {
    app.state::<TrayStatusCache>().0.lock().unwrap().clone()
}

/// Fit the popover window to its rendered content — the panel measures
/// itself (ResizeObserver) and reports the card height in logical px; the
/// window becomes card + margin ring. Runs in Rust so no window-plugin
/// capability is needed. Height is clamped to sane bounds so a broken
/// measurement can't create a zero or screen-tall window.
#[tauri::command]
pub fn resize_tray_panel(app: AppHandle, height: f64) -> Result<(), String> {
    let Some(win) = app.get_webview_window(PANEL_LABEL) else {
        return Ok(()); // window not created yet — the builder size applies
    };
    let clamped = height.clamp(60.0, 800.0);
    win.set_size(tauri::LogicalSize::new(
        PANEL_WIDTH,
        clamped + PANEL_MARGIN_TOP + PANEL_MARGIN,
    ))
    .map_err(|e| e.to_string())
}

/// Quick actions clicked in the tray-panel window. Routes through the same
/// handler as the native menu rows so both surfaces behave identically
/// (including resident-mode show and quit). "dismiss" just hides the panel.
#[tauri::command]
pub fn tray_panel_action(app: AppHandle, action: String) -> Result<(), String> {
    // Navigation/quit actions close the popover (they move the user
    // somewhere else). "distill" does NOT: the panel stays open and
    // live-updates to show the run it just started — closing it read as
    // "the button turned the app off".
    // Map-proposal decisions stay open too, for the same reason as "distill":
    // the row leaves on the next status push, which is the feedback.
    let is_proposal_decision = action.starts_with("proposal-");
    if action != "distill" && !is_proposal_decision {
        if let Some(win) = app.get_webview_window(PANEL_LABEL) {
            let _ = win.hide();
        }
    }
    // The path travels in the action string; only the main window (which owns
    // distillStore, the single writer) can act on it.
    if is_proposal_decision {
        let _ = app.emit(TRAY_ACTION_EVENT, action.as_str());
        return Ok(());
    }
    let menu_id = match action.as_str() {
        "query" => "tray-query",
        "distill" => "tray-distill",
        "open" => "tray-open",
        "quit" => "tray-quit",
        "overview" => "tray-overview",
        "settings" => "tray-settings",
        "ingest" => "tray-ingest",
        "quarantine" => "tray-quarantine",
        "proposals" => "tray-proposals",
        "tasks" => "tray-tasks",
        "dismiss" => return Ok(()),
        other => return Err(format!("unknown tray panel action: {other}")),
    };
    handle_menu_id(&app, menu_id);
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

    #[test]
    fn a_click_right_after_a_blur_hide_means_close_not_reshow() {
        // The blur produced by the click's own focus shift lands first.
        assert!(!click_should_reshow(10_000, 10_050));
        // A human re-open after app-switching is slower than the race window.
        assert!(click_should_reshow(10_000, 10_200));
        assert!(click_should_reshow(10_000, 10_500));
        // No blur ever recorded (0) — always show.
        assert!(click_should_reshow(0, 10_000));
    }

    #[test]
    fn a_transient_blur_right_after_show_does_not_close_the_panel() {
        assert!(!blur_should_hide(20_000, 20_100));
        assert!(blur_should_hide(20_000, 20_400));
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
            reflect: String::new(),
            quarantine: String::new(),
            mcp: "MCP server running".into(),
            inflow: None,
            ask: "Ask the wiki".into(),
            distill: "Distill now".into(),
            open: "Open myco".into(),
            quit: "Quit myco".into(),
            // Panel-only rows — `menu_rows` deliberately ignores them.
            ..Default::default()
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
    fn unseen_reflect_findings_add_a_clickable_standing_row() {
        let s = TrayStatus {
            reflect: "8 reflect suggestions".into(),
            ..full_status()
        };
        let rows = menu_rows(&s);
        let i = rows.iter().position(|r| r.id == "tray-reflect").unwrap();
        assert_eq!(rows[i - 1].id, "tray-overview");
        assert_eq!(rows[i + 1].id, "tray-settings");
        assert!(rows[i].enabled);
        assert_eq!(rows[i].icon, Some(RowIcon::Distill));
        // Empty (nothing unseen) → no row at all.
        assert!(menu_rows(&full_status())
            .iter()
            .all(|r| r.id != "tray-reflect"));
    }

    #[test]
    fn quarantined_items_add_a_clickable_standing_row_before_mcp() {
        let s = TrayStatus {
            quarantine: "2 awaiting review".into(),
            ..full_status()
        };
        let rows = menu_rows(&s);
        let i = rows.iter().position(|r| r.id == "tray-quarantine").unwrap();
        assert_eq!(rows[i + 1].id, "tray-settings");
        assert!(rows[i].enabled);
        assert_eq!(rows[i].icon, Some(RowIcon::Distill));
        // Nothing quarantined → no row at all.
        assert!(menu_rows(&full_status())
            .iter()
            .all(|r| r.id != "tray-quarantine"));
    }

    #[test]
    fn a_running_reflect_row_shows_the_distill_icon() {
        let s = TrayStatus {
            running: vec![run("reflect", "Reflect running…")],
            ..full_status()
        };
        assert_eq!(menu_rows(&s)[1].icon, Some(RowIcon::Distill));
    }

    #[test]
    fn inflow_summary_is_a_disabled_info_row_under_the_mcp_row() {
        let s = TrayStatus {
            inflow: Some(TrayInflow {
                header: "Today's inflow".into(),
                sessions: "Sessions swept".into(),
                sessions_count: "+2".into(),
                mcp: "MCP tool calls".into(),
                mcp_sub: "top: search".into(),
                mcp_count: "7".into(),
                inbox: "_inbox arrivals".into(),
                inbox_count: "+3".into(),
                summary: "Today: sessions +2 · MCP 7 · inbox +3".into(),
                hourly_files: vec![0; 24],
                hourly_mcp: vec![0; 24],
                ..TrayInflow::default()
            }),
            ..full_status()
        };
        let rows = menu_rows(&s);
        let i = rows.iter().position(|r| r.id == "tray-inflow").unwrap();
        assert_eq!(rows[i - 1].id, "tray-settings");
        assert!(!rows[i].enabled && rows[i].icon.is_none());
        assert_eq!(rows[i].text, "Today: sessions +2 · MCP 7 · inbox +3");
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
    fn left_release_opens_panel_everything_else_does_not() {
        assert!(tray_click_shows_panel(
            MouseButton::Left,
            MouseButtonState::Up
        ));
        // Left press: wait for the release (native-menu-like feel).
        assert!(!tray_click_shows_panel(
            MouseButton::Left,
            MouseButtonState::Down
        ));
        // Right clicks belong to the native fallback menu.
        assert!(!tray_click_shows_panel(
            MouseButton::Right,
            MouseButtonState::Up
        ));
        assert!(!tray_click_shows_panel(
            MouseButton::Middle,
            MouseButtonState::Up
        ));
    }

    fn icon_rect(x: f64, y: f64, w: f64, h: f64) -> tauri::Rect {
        tauri::Rect {
            position: tauri::Position::Physical(tauri::PhysicalPosition {
                x: x as i32,
                y: y as i32,
            }),
            size: tauri::Size::Physical(tauri::PhysicalSize {
                width: w as u32,
                height: h as u32,
            }),
        }
    }

    #[test]
    fn panel_centres_under_the_icon_below_the_bar() {
        // scale 2: panel is 680 physical px wide; icon centre at x=1000.
        let (x, y) = panel_position(&icon_rect(978.0, 0.0, 44.0, 48.0), 2.0, 340.0, None);
        assert_eq!(x, 1000.0 - 340.0); // centre - half panel width
        assert_eq!(y, 48.0 + 2.0 * 2.0); // icon bottom + gap
    }

    #[test]
    fn panel_clamps_to_the_right_screen_edge() {
        // Icon 20px from the right edge of a 2000px-wide screen.
        let (x, _) = panel_position(
            &icon_rect(1936.0, 0.0, 44.0, 48.0),
            2.0,
            340.0,
            Some(2000.0),
        );
        // Window may touch the edge — its transparent margin spaces the card.
        assert_eq!(x, 2000.0 - 680.0);
    }

    #[test]
    fn panel_never_goes_off_the_left_edge() {
        let (x, _) = panel_position(&icon_rect(0.0, 0.0, 44.0, 48.0), 2.0, 340.0, None);
        assert_eq!(x, 0.0);
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
