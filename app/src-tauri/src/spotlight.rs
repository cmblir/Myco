// Global "ask the wiki from anywhere" shortcut and the spotlight window it
// opens (ROADMAP P0).
//
// This module owns ONLY the key registration and the window. It answers no
// questions: the spotlight webview emits `myco://spotlight-ask` and the MAIN
// window (which is the one that has a vault open and owns queryStore) runs the
// exact same ask path the in-app Ask page uses, then emits the answer back.
// Same reasoning as tray.rs: one entry point per behaviour, never a second
// implementation in a second webview.
//
// Registration is deliberately NOT done through the plugin Builder's
// `with_shortcut`: that registers inside plugin setup, where a failure becomes
// an app-init error. We register at runtime instead, keep the Err, and show it
// in Settings — a shortcut another app already owns must be reported, never
// fatal.

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState as KeyState};

/// The spotlight webview. `index.html?window=spotlight` renders only the
/// spotlight component (see main.tsx) — App and its schedulers never mount.
pub const SPOTLIGHT_LABEL: &str = "spotlight";

/// Option+Space, the combination the tray design showed. Not registered until
/// `init` runs, and overridable/disableable in Settings.
pub const DEFAULT_SHORTCUT: &str = "Alt+Space";

// Window = the card + a transparent margin ring that gives the CSS shadow room
// (the OS window shadow is OFF, for the same reason as the tray panel). Mirrors
// the `html.spotlight-window body` padding in styles.css.
const MARGIN: f64 = 20.0; // sides + bottom
const MARGIN_TOP: f64 = 12.0;
const WIDTH: f64 = 600.0 + MARGIN * 2.0; // logical px
/// First-paint height: the input row alone. `resize_spotlight` fits the window
/// to the card as soon as it renders, and again when an answer arrives.
const HEIGHT: f64 = 150.0;
/// Where the window's top edge sits inside the monitor work area, as a
/// fraction of its height — spotlight windows sit high, not centred.
const TOP_FRACTION: f64 = 0.16;

/// What to do with a user-supplied shortcut string. Pure decision, so the
/// parse/disable/register split is testable without a running app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShortcutPlan {
    /// Empty (or whitespace) input: the feature is off, register nothing.
    Disabled,
    /// The string is not a shortcut global-hotkey can parse; the message is
    /// the parser's own, shown verbatim in Settings.
    Invalid(String),
    /// Parsed; register this (normalized back to the accepted input).
    Register(String),
}

/// Decide what a requested shortcut string means. Parsing happens here rather
/// than at registration time so a typo is reported as a typo instead of as a
/// failed registration.
pub fn plan_shortcut(raw: &str) -> ShortcutPlan {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return ShortcutPlan::Disabled;
    }
    match trimmed.parse::<Shortcut>() {
        Ok(_) => ShortcutPlan::Register(trimmed.to_string()),
        Err(e) => ShortcutPlan::Invalid(e.to_string()),
    }
}

/// Honest registration state, mirrored into Settings. `registered == false`
/// with a non-empty `shortcut` means we tried and failed — `error` says why
/// (unparseable, or the OS refused it because something else holds it).
#[derive(Debug, Clone, Default, Serialize)]
pub struct ShortcutStatus {
    pub shortcut: String,
    pub registered: bool,
    pub error: Option<String>,
}

/// Live registration state + the shortcut currently held by the OS (needed to
/// unregister it before registering a replacement).
#[derive(Default)]
pub struct ShortcutRegistration(pub Mutex<ShortcutStatus>);

/// Top-left corner (physical px) for the spotlight window inside `work_area`:
/// horizontally centred, `TOP_FRACTION` down. Sizes in, sizes out are
/// physical; `w_logical`/`h_logical` are the builder's logical size.
pub fn window_origin(
    area_pos: (f64, f64),
    area_size: (f64, f64),
    scale: f64,
    w_logical: f64,
    h_logical: f64,
) -> (f64, f64) {
    let w = w_logical * scale;
    let h = h_logical * scale;
    let x = area_pos.0 + (area_size.0 - w) / 2.0;
    let y = area_pos.1 + area_size.1 * TOP_FRACTION;
    // A window taller than the work area would otherwise start off-screen.
    let max_y = area_pos.1 + (area_size.1 - h).max(0.0);
    (x.max(area_pos.0), y.min(max_y).max(area_pos.1))
}

/// Create (once) the frameless, transparent, always-on-top spotlight window —
/// same recipe as the tray popover in tray.rs, minus the click-to-dismiss
/// grace window (there is no tray icon click to race with here).
fn ensure_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window(SPOTLIGHT_LABEL) {
        return Some(w);
    }
    let built = WebviewWindowBuilder::new(
        app,
        SPOTLIGHT_LABEL,
        WebviewUrl::App("index.html?window=spotlight".into()),
    )
    .decorations(false)
    .transparent(true)
    // OS shadow OFF for the same reason as the tray panel: it hugs the
    // transparent window rect, not the rounded card inside it.
    .shadow(false)
    .always_on_top(true)
    .resizable(false)
    .skip_taskbar(true)
    .visible(false)
    .inner_size(WIDTH, HEIGHT)
    .build();
    match built {
        Ok(w) => {
            // Focus loss dismisses it, like Spotlight itself.
            let hide = w.clone();
            w.on_window_event(move |e| {
                if matches!(e, tauri::WindowEvent::Focused(false)) {
                    let _ = hide.hide();
                }
            });
            Some(w)
        }
        Err(e) => {
            eprintln!("spotlight window failed: {e}");
            None
        }
    }
}

/// Show the spotlight near the top of the monitor the cursor is on (the
/// closest available proxy for "the monitor the user is working on"), or hide
/// it if it is already up — pressing the shortcut again closes it.
fn toggle(app: &AppHandle) {
    let Some(win) = ensure_window(app) else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        let _ = win.hide();
        return;
    }
    place_and_show(app, &win);
}

/// Park the window on the monitor the cursor is on and raise it. Split out of
/// `toggle` so the voice hotkey's fallback can raise the spotlight WITHOUT the
/// hide half — ⌥M must never close the surface it is about to record into.
fn place_and_show(app: &AppHandle, win: &tauri::WebviewWindow) {
    let scale = win.scale_factor().unwrap_or(1.0);
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    if let Some(m) = monitor {
        let area = m.work_area();
        let (x, y) = window_origin(
            (f64::from(area.position.x), f64::from(area.position.y)),
            (f64::from(area.size.width), f64::from(area.size.height)),
            scale,
            WIDTH,
            HEIGHT,
        );
        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    }
    let _ = win.show();
    let _ = win.set_focus();
    // The input must be empty and focused on every open, not still holding the
    // last question — the window is reused, so only the webview can do that.
    let _ = app.emit_to(SPOTLIGHT_LABEL, SPOTLIGHT_OPENED_EVENT, ());
}

/// Emitted to the spotlight webview each time the window is shown, so it can
/// reset and focus its input.
pub const SPOTLIGHT_OPENED_EVENT: &str = "myco://spotlight-opened";

/// Rust → the voice surface: ⌥M was pressed anywhere; toggle a take. Payload
/// free — the surface, not the key, knows whether it is starting or saving.
pub const VOICE_HOTKEY_EVENT: &str = "myco://voice-hotkey";

/// The voice quick-capture hotkey. Fixed, unlike the ask shortcut: it is not
/// in Settings yet, and the notch peek row and the spotlight both print it.
pub const VOICE_SHORTCUT: &str = "Alt+KeyM";

/// Which webview a ⌥M press belongs to. Pure so the fallback rule is testable
/// without a running app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoiceTarget {
    /// The notch panel — the surface the hotkey was designed for.
    Notch,
    /// The notch surface is off in Settings (its window is destroyed, not
    /// hidden), so the spotlight — which owns the same recorder — takes the
    /// take instead. The hotkey must never be a key that does nothing.
    Spotlight,
}

pub fn voice_target(notch_window_exists: bool) -> VoiceTarget {
    if notch_window_exists {
        VoiceTarget::Notch
    } else {
        VoiceTarget::Spotlight
    }
}

/// Hand the press to whichever voice surface exists.
fn toggle_voice(app: &AppHandle) {
    match voice_target(app.get_webview_window(crate::notch::NOTCH_LABEL).is_some()) {
        VoiceTarget::Notch => {
            let _ = app.emit_to(crate::notch::NOTCH_LABEL, VOICE_HOTKEY_EVENT, ());
        }
        VoiceTarget::Spotlight => {
            let Some(win) = ensure_window(app) else {
                return;
            };
            // Raise it only if it is down: an already-open spotlight keeps its
            // question and its scroll, and re-showing would reset the input.
            if !win.is_visible().unwrap_or(false) {
                place_and_show(app, &win);
            }
            // ponytail: on the FIRST press after launch this emit races the
            // webview's load, so that press only opens the window and the next
            // one records. Pre-creating the spotlight at startup (or carrying
            // the intent in its URL) is the fix if that ever matters.
            let _ = app.emit_to(SPOTLIGHT_LABEL, VOICE_HOTKEY_EVENT, ());
        }
    }
}

/// Register the voice hotkey. Best-effort in exactly the sense `apply` is: a
/// combination another app already owns is logged and skipped, never a panic
/// and never a startup failure. No status is stored — see the log line.
fn init_voice_hotkey(app: &AppHandle) {
    let handle = app.clone();
    let result =
        app.global_shortcut()
            .on_shortcut(VOICE_SHORTCUT, move |_app, _shortcut, event| {
                // Press only, like the ask shortcut: release would toggle twice.
                if event.state == KeyState::Pressed {
                    toggle_voice(&handle);
                }
            });
    if let Err(e) = result {
        eprintln!(
            "voice hotkey '{VOICE_SHORTCUT}' not registered: {e} — ⌥M will only \
             work while the notch or spotlight webview has keyboard focus"
        );
    }
}

/// (Re)register the global shortcut and report what happened. Unregisters
/// whatever we currently hold first, so changing the shortcut in Settings can
/// never leave two live. Never panics and never returns Err: a shortcut the OS
/// refuses is a status to display, not a failure to start.
pub fn apply(app: &AppHandle, requested: &str) -> ShortcutStatus {
    let state = app.state::<ShortcutRegistration>();
    let previous = state.0.lock().unwrap().clone();
    if previous.registered && !previous.shortcut.is_empty() {
        if let Err(e) = app.global_shortcut().unregister(previous.shortcut.as_str()) {
            eprintln!("spotlight: unregistering {} failed: {e}", previous.shortcut);
        }
    }
    let status = match plan_shortcut(requested) {
        ShortcutPlan::Disabled => ShortcutStatus {
            shortcut: String::new(),
            registered: false,
            error: None,
        },
        ShortcutPlan::Invalid(message) => ShortcutStatus {
            shortcut: requested.trim().to_string(),
            registered: false,
            error: Some(message),
        },
        ShortcutPlan::Register(accel) => {
            let handle = app.clone();
            let result =
                app.global_shortcut()
                    .on_shortcut(accel.as_str(), move |_app, _shortcut, event| {
                        // Fires on press AND release; only the press should toggle,
                        // or the window would open and close on one keystroke.
                        if event.state == KeyState::Pressed {
                            toggle(&handle);
                        }
                    });
            match result {
                Ok(()) => ShortcutStatus {
                    shortcut: accel,
                    registered: true,
                    error: None,
                },
                Err(e) => ShortcutStatus {
                    shortcut: accel,
                    registered: false,
                    error: Some(e.to_string()),
                },
            }
        }
    };
    *state.0.lock().unwrap() = status.clone();
    status
}

/// Register the persisted shortcut at startup. Best-effort, like tray::init —
/// a shortcut we cannot get must never block launch; Settings shows why.
pub fn init(app: &AppHandle) {
    // Same lifecycle as the ask shortcut, so there is one place where this app
    // asks the OS for keys and one place a refusal is logged.
    init_voice_hotkey(app);
    let status = apply(app, &crate::settings::load().spotlight_shortcut);
    if let Some(e) = &status.error {
        eprintln!(
            "spotlight shortcut '{}' not registered: {e}",
            status.shortcut
        );
    }
}

/// What Settings renders: the shortcut and whether the OS actually gave it to us.
#[tauri::command]
pub fn spotlight_status(app: AppHandle) -> ShortcutStatus {
    app.state::<ShortcutRegistration>()
        .0
        .lock()
        .unwrap()
        .clone()
}

/// Change (or, with an empty string, disable) the global shortcut: persist it
/// and re-register in one step, returning the honest result. Persisting even a
/// failed shortcut is deliberate — the user's choice survives a restart, where
/// the app that stole the combination may no longer be running.
#[tauri::command]
pub fn set_spotlight_shortcut(app: AppHandle, shortcut: String) -> Result<ShortcutStatus, String> {
    let status = apply(&app, &shortcut);
    // Read-modify-write the one field, so this never clobbers settings the
    // frontend changed since it last sent the whole struct.
    let mut settings = crate::settings::load();
    settings.spotlight_shortcut = status.shortcut.clone();
    crate::settings::save(&settings)?;
    Ok(status)
}

/// Fit the window to the card the webview measured (logical px), exactly as
/// `resize_tray_panel` does. Not cosmetic: the window is transparent AND
/// always-on-top, so every pixel of leftover height is an invisible surface
/// swallowing clicks aimed at the app underneath.
#[tauri::command]
pub fn resize_spotlight(app: AppHandle, height: f64) -> Result<(), String> {
    let Some(win) = app.get_webview_window(SPOTLIGHT_LABEL) else {
        return Ok(()); // window not created yet — the builder size applies
    };
    let clamped = height.clamp(60.0, 720.0);
    win.set_size(tauri::LogicalSize::new(
        WIDTH,
        clamped + MARGIN_TOP + MARGIN,
    ))
    .map_err(|e| e.to_string())
}

/// Hide the spotlight. Its own webview cannot: `core:window:default` grants no
/// `hide` (verified in the tauri 2.11.1 ACL), which is also why the tray panel
/// dismisses through Rust.
#[tauri::command]
pub fn close_spotlight(app: AppHandle) {
    if let Some(win) = app.get_webview_window(SPOTLIGHT_LABEL) {
        let _ = win.hide();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_disables_instead_of_failing() {
        assert_eq!(plan_shortcut(""), ShortcutPlan::Disabled);
        assert_eq!(plan_shortcut("   "), ShortcutPlan::Disabled);
    }

    #[test]
    fn the_default_shortcut_parses() {
        assert_eq!(
            plan_shortcut(DEFAULT_SHORTCUT),
            ShortcutPlan::Register("Alt+Space".into())
        );
        // "Option" is what macOS prints on the key; global-hotkey accepts it
        // as an alias for Alt, so the Settings recorder may emit either.
        assert_eq!(
            plan_shortcut("Option+Space"),
            ShortcutPlan::Register("Option+Space".into())
        );
        // event.code names (what the Settings recorder sends) parse directly.
        assert_eq!(
            plan_shortcut(" Control+Shift+KeyK "),
            ShortcutPlan::Register("Control+Shift+KeyK".into())
        );
    }

    #[test]
    fn unparseable_input_is_invalid_not_a_registration_attempt() {
        // Modifiers with no main key, and a key that does not exist.
        assert!(matches!(plan_shortcut("Alt+"), ShortcutPlan::Invalid(_)));
        assert!(matches!(
            plan_shortcut("Alt+Shift"),
            ShortcutPlan::Invalid(_)
        ));
        assert!(matches!(
            plan_shortcut("Alt+Nope"),
            ShortcutPlan::Invalid(_)
        ));
    }

    #[test]
    fn the_voice_hotkey_parses_and_falls_back_to_the_spotlight() {
        assert_eq!(
            plan_shortcut(VOICE_SHORTCUT),
            ShortcutPlan::Register("Alt+KeyM".into())
        );
        assert_eq!(voice_target(true), VoiceTarget::Notch);
        // Notch surface off in Settings ⇒ the key still has somewhere to go.
        assert_eq!(voice_target(false), VoiceTarget::Spotlight);
    }

    #[test]
    fn window_sits_high_and_centred_in_the_work_area() {
        // 1440x900 logical work area at the origin, no HiDPI.
        let (x, y) = window_origin((0.0, 0.0), (1440.0, 900.0), 1.0, 640.0, 460.0);
        assert_eq!(x, 400.0);
        assert_eq!(y, 144.0);
        // A second monitor to the left keeps the window on that monitor.
        let (x2, _) = window_origin((-1920.0, 0.0), (1920.0, 1080.0), 1.0, 640.0, 460.0);
        assert_eq!(x2, -1280.0);
    }

    #[test]
    fn window_never_starts_below_a_short_work_area() {
        // Work area shorter than the window: clamped to the top, not pushed off.
        let (_, y) = window_origin((0.0, 25.0), (1440.0, 300.0), 1.0, 640.0, 460.0);
        assert_eq!(y, 25.0);
    }
}
