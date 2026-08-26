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
    // Left AND right: the native right-click menu is gone (owner call — two
    // clicks showing two different UIs read as a bug), so every click path
    // lands on the same styled panel.
    (button == MouseButton::Left || button == MouseButton::Right) && state == MouseButtonState::Up
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
// The mascot HOPS — a squash-and-stretch cycle (RunCat-style). The template
// machinery is deliberately OUT of the animation loop: set_icon resets the
// template flag (glyph went black), and re-asserting it per frame double-
// updates the status item, which flashes. Instead the frames are pre-tinted —
// a white set for a dark menu bar, a black set for a light one — and each
// tick is a single set_icon of a pre-decoded image. The menu-bar appearance
// is re-read every ~30s and on the rare change the other set takes over.

/// True while the status push says something is running (distill/ingest/…).
static ANIM_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// The hop cycle, sine-interpolated: squash on the ground at both ends, a
/// gentle stretch through the airborne arc. Ten frames whose neighbours
/// differ by ≤2px, so the loop reads as one continuous motion — fewer,
/// coarser frames read as flicker at menu-bar size. Two pre-tinted sets so
/// no template call is ever needed mid-animation.
const HOP_WHITE: [&[u8]; 10] = [
    include_bytes!("../icons/tray/frames/h0w.png"),
    include_bytes!("../icons/tray/frames/h1w.png"),
    include_bytes!("../icons/tray/frames/h2w.png"),
    include_bytes!("../icons/tray/frames/h3w.png"),
    include_bytes!("../icons/tray/frames/h4w.png"),
    include_bytes!("../icons/tray/frames/h5w.png"),
    include_bytes!("../icons/tray/frames/h6w.png"),
    include_bytes!("../icons/tray/frames/h7w.png"),
    include_bytes!("../icons/tray/frames/h8w.png"),
    include_bytes!("../icons/tray/frames/h9w.png"),
];
const HOP_BLACK: [&[u8]; 10] = [
    include_bytes!("../icons/tray/frames/h0b.png"),
    include_bytes!("../icons/tray/frames/h1b.png"),
    include_bytes!("../icons/tray/frames/h2b.png"),
    include_bytes!("../icons/tray/frames/h3b.png"),
    include_bytes!("../icons/tray/frames/h4b.png"),
    include_bytes!("../icons/tray/frames/h5b.png"),
    include_bytes!("../icons/tray/frames/h6b.png"),
    include_bytes!("../icons/tray/frames/h7b.png"),
    include_bytes!("../icons/tray/frames/h8b.png"),
    include_bytes!("../icons/tray/frames/h9b.png"),
];

/// True when the menu bar is dark (glyph should be white). `defaults` is the
/// stable way to read this from a plain process; the key is absent in light
/// mode, so a non-zero exit means light.
fn menu_bar_is_dark() -> bool {
    std::process::Command::new("defaults")
        .args(["read", "-g", "AppleInterfaceStyle"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(true)
}

/// Spawn the animator. One task for the app's lifetime; ticks are no-ops when
/// nothing changes (the same frame is never re-set).
fn spawn_icon_animator(app: AppHandle) {
    use std::sync::atomic::Ordering;
    tauri::async_runtime::spawn(async move {
        let decode = |set: &[&[u8]; 10]| -> Vec<tauri::image::Image<'static>> {
            set.iter()
                .filter_map(|b| tauri::image::Image::from_bytes(b).ok())
                .map(|i| i.to_owned())
                .collect()
        };
        let white = decode(&HOP_WHITE);
        let black = decode(&HOP_BLACK);
        if white.len() != 10 || black.len() != 10 {
            return; // a frame failed to decode; keep the static glyph
        }
        let mut dark = menu_bar_is_dark();
        let mut tick: u64 = 0;
        loop {
            let active = ANIM_ACTIVE.load(Ordering::Relaxed);
            // Appearance changes are rare; a re-read every ~30s is plenty.
            if tick % 384 == 0 && tick > 0 {
                dark = menu_bar_is_dark();
            }
            let frames = if dark { &white } else { &black };
            let frame = (tick % 10) as usize;
            let sleep_ms: u64 = if active { 55 } else { 80 };
            let tray = app
                .state::<TrayHandle>()
                .0
                .lock()
                .ok()
                .and_then(|g| g.as_ref().cloned());
            if let Some(tray) = tray {
                // One call per frame, nothing else — the two-call
                // icon+template sequence is what flashed.
                let _ = tray.set_icon(Some(frames[frame].clone()));
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
        // No native menu at all: left AND right click open the same React
        // popover (tray_click_shows_panel). The old right-click fallback menu
        // rendered a second, unstyled copy of the same rows.
        .show_menu_on_left_click(false)
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
    // No set_menu: the native menu is gone (both clicks open the panel), so
    // the per-push rebuild would maintain UI nothing can display.
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
    fn either_button_release_opens_panel_press_and_middle_do_not() {
        assert!(tray_click_shows_panel(
            MouseButton::Left,
            MouseButtonState::Up
        ));
        // Right now opens the SAME panel — the native fallback menu is gone.
        assert!(tray_click_shows_panel(
            MouseButton::Right,
            MouseButtonState::Up
        ));
        // Press: wait for the release (native-menu-like feel).
        assert!(!tray_click_shows_panel(
            MouseButton::Left,
            MouseButtonState::Down
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
}
