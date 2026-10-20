//! The window myco roams in while long work runs (spec
//! docs/specs/2026-10-02-mascot-roam.md, decision 3).
//!
//! A borderless, transparent, non-activating NSPanel over the visible frame of
//! the notch's screen: under the menu bar, over other apps' windows, deaf to
//! the mouse and never key, so it takes no click and no focus from the app
//! below. It is built on the first roam and ordered out between roams, like
//! the notch window (destroying a promoted NSPanel can raise inside WKWebView,
//! see notch.rs `set_notch_visible`). While it is out, one task feeds its
//! webview the pointer at the notch's ≤ 30 Hz and calls myco back when the
//! notch goes away, a full-screen app comes to the front, or the screen locks
//! or sleeps. Hidden, nothing runs. The same window carries myco's everyday
//! walks (the 2026-10-03 amendment), under the same rules.
//!
//! Non-macOS targets get inert commands.

use serde::Serialize;
use tauri::AppHandle;

/// Window label; the frontend routes on `?window=roam`.
pub const ROAM_LABEL: &str = "roam";

/// Where myco roams, in the roam window's own points: x right and y down from
/// its top-left corner, which sits just under the menu bar.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct RoamPlace {
    pub width: f64,
    pub height: f64,
    /// The collapsed input target's left edge (cutout or notchless target),
    /// where myco pops out and dives back in. It may lie outside the window
    /// when the Dock sits left of it.
    pub notch_left: f64,
}

#[cfg(target_os = "macos")]
use crate::notch::{CursorFeed, NotchGeometry, ScreenRect};
#[cfg(target_os = "macos")]
use objc2_app_kit::{NSWindowCollectionBehavior, NSWindowStyleMask};

/// Sent to every webview, so the notch hears it too: the `RoamPlace` once
/// myco is out, null once it is back.
#[cfg(target_os = "macos")]
const ROAM_VISIBILITY_EVENT: &str = "roam-visibility";
/// The pointer, roam-window-local `[x, y]` points, ≤ 30 Hz and only while
/// myco is out (decision 4: it hops away from the pointer).
#[cfg(target_os = "macos")]
const ROAM_CURSOR_EVENT: &str = "roam-cursor";

/// The panel's AppKit settings, as data so the tests can hold them.
#[cfg(target_os = "macos")]
struct PanelSpec {
    level: isize,
    mask: NSWindowStyleMask,
    behaviour: NSWindowCollectionBehavior,
    ignores_mouse: bool,
}

#[cfg(target_os = "macos")]
static ROAM_PANEL: PanelSpec = PanelSpec {
    // NSFloatingWindowLevel: over every app's ordinary windows, under the
    // Dock (20) and the menu bar (24) — the notch is 25.
    level: 3,
    // Borderless (0) plus the non-activating bit, and nothing else: a titled
    // mask keeps AppKit treating it as an ordinary activating window.
    mask: NSWindowStyleMask::NonactivatingPanel,
    // On every space and out of the Cmd-` cycle. Joining every space also
    // puts it over a full-screen app's (measured: isOnActiveSpace stays YES
    // and it draws there), so `full_screen_in_front` asks the window server
    // instead.
    behaviour: NSWindowCollectionBehavior::CanJoinAllSpaces
        .union(NSWindowCollectionBehavior::Stationary)
        .union(NSWindowCollectionBehavior::IgnoresCycle),
    ignores_mouse: true,
};

/// The menu bar's height without a notch (Big Sur and later). With one, the
/// bar is the cutout's height.
// ponytail: a fixed 24 pt; NSStatusBar.thickness if a taller bar ever shows up.
#[cfg(target_os = "macos")]
const MENU_BAR_PT: f64 = 24.0;

/// The menu bar's height on the notch's screen.
#[cfg(target_os = "macos")]
fn bar_height(geom: NotchGeometry) -> f64 {
    if geom.has_notch {
        geom.notch_h.max(MENU_BAR_PT)
    } else {
        MENU_BAR_PT
    }
}

/// The roam window's frame: the notch screen's visible frame (no menu bar,
/// no Dock), with its top held under the menu bar even when the bar
/// auto-hides and the visible frame runs to the screen's top edge.
#[cfg(target_os = "macos")]
fn roam_frame(screen: ScreenRect, visible: ScreenRect, geom: NotchGeometry) -> ScreenRect {
    let bar = bar_height(geom);
    let top = (visible.y + visible.h).min(screen.y + screen.h - bar);
    ScreenRect {
        h: (top - visible.y).max(0.0),
        ..visible
    }
}

/// What the webview is told, from the frame the window has and the collapsed
/// notch surface myco pops out of.
#[cfg(target_os = "macos")]
fn place_for(frame: ScreenRect, surface: ScreenRect) -> RoamPlace {
    RoamPlace {
        width: frame.w,
        height: frame.h,
        notch_left: surface.x - frame.x,
    }
}

/// Whether myco may be out: the notch is up (myco pops out of it and dives
/// back into it), no full-screen app is in front on the notch's screen
/// (decision 7: myco then stays in the notch), and the screen is not `dark`
/// (`screen_dark`: nobody would see it).
#[cfg(target_os = "macos")]
fn may_roam(notch_shown: bool, full_screen: bool, dark: bool) -> bool {
    notch_shown && !full_screen && !dark
}

/// The screen is locked or its display asleep.
#[cfg(target_os = "macos")]
fn screen_dark(locked: bool, asleep: bool) -> bool {
    locked || asleep
}

/// Whether a window (AppKit coordinates) fills `screen` the way a
/// full-screen one does: the whole width, from the bottom edge up to at
/// least the bar's strip, which a full-screen window on a notched screen sits
/// under (measured: 1 pt taller than the cutout).
// ponytail: geometry only, so a zoomed window with the Dock hidden reads as
// full screen too and myco stays in the notch; a private space API
// (CGSSpaceGetType) would tell them apart.
#[cfg(target_os = "macos")]
fn fills_screen(win: ScreenRect, screen: ScreenRect, bar: f64) -> bool {
    const SLOP: f64 = 2.0;
    win.x <= screen.x + SLOP
        && win.x + win.w >= screen.x + screen.w - SLOP
        && win.y <= screen.y + SLOP
        && win.y + win.h >= screen.y + screen.h - bar - SLOP
}

/// CGWindowList bounds (y down from the primary screen's top-left) as an
/// AppKit rect (y up from its bottom-left), given the primary's height.
#[cfg(target_os = "macos")]
fn from_window_server(x: f64, y: f64, w: f64, h: f64, primary_h: f64) -> ScreenRect {
    ScreenRect {
        x,
        y: primary_h - (y + h),
        w,
        h,
    }
}

/// What one sample of a roam's watch does.
#[cfg(target_os = "macos")]
#[derive(Debug, PartialEq)]
enum RoamTick {
    /// This roam is over (ordered out, or a newer one took over): end the watch.
    Stop,
    /// The notch went away, a full-screen app came forward, or the screen
    /// locked or slept: bring myco back.
    Recall,
    /// Still out: send this cursor, if there is one to send.
    Feed(Option<(f64, f64)>),
}

/// One sample of the watch at `now_ms`. `out`: this roam's panel is still
/// ordered in. The cursor goes through the notch's own throttle.
#[cfg(target_os = "macos")]
fn roam_tick(
    feed: &mut CursorFeed,
    now_ms: u64,
    out: bool,
    notch_shown: bool,
    full_screen: bool,
    dark: bool,
    cursor: Option<(f64, f64)>,
) -> RoamTick {
    if !out {
        RoamTick::Stop
    } else if !may_roam(notch_shown, full_screen, dark) {
        RoamTick::Recall
    } else {
        RoamTick::Feed(cursor.and_then(|p| feed.offer(now_ms, p)))
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{
        bar_height, fills_screen, from_window_server, place_for, roam_frame, screen_dark,
        RoamPlace, ROAM_PANEL,
    };
    use crate::notch::{collapsed_rect, imp as notch};
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2::{ClassType, MainThreadMarker};
    use objc2_app_kit::{NSPanel, NSScreen, NSWindow, NSWorkspace};
    use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSRect, NSString};

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        /// A +1 CFArray of CFDictionary, toll-free bridged to NSArray.
        fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> *mut AnyObject;
        fn CGRectMakeWithDictionaryRepresentation(
            dict: *const AnyObject,
            rect: *mut NSRect,
        ) -> bool;
        /// A +1 CFDictionary (NSDictionary), or null outside a GUI session.
        fn CGSessionCopyCurrentDictionary() -> *mut AnyObject;
        fn CGMainDisplayID() -> u32;
        fn CGDisplayIsAsleep(display: u32) -> u32;
    }

    /// Whether the screen is locked or the main display asleep. The lock is
    /// the session's `CGSSessionScreenIsLocked`, there only while locked.
    // ponytail: the main display's sleep stands for the notch screen's; they
    // sleep together unless one is set apart, CGDisplay per NSScreenNumber if so.
    pub fn dark() -> bool {
        // Safe: a Copy function's +1 result, released by Retained.
        let raw = unsafe { CGSessionCopyCurrentDictionary() };
        let session = unsafe { Retained::from_raw(raw as *mut NSDictionary<NSString, AnyObject>) };
        let locked = session.is_some_and(|d| {
            d.objectForKey(&NSString::from_str("CGSSessionScreenIsLocked"))
                .and_then(|v| v.downcast::<NSNumber>().ok())
                .is_some_and(|n| n.as_bool())
        });
        // Safe: plain C calls with no pointers.
        let asleep = unsafe { CGDisplayIsAsleep(CGMainDisplayID()) } != 0;
        screen_dark(locked, asleep)
    }
    /// kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements.
    const ON_SCREEN_WINDOWS: u32 = 1 | 16;

    /// Whether the frontmost app has a window filling `screen` the way a
    /// full-screen one does (`fills_screen`). Bounds, layer and owner need no
    /// screen-recording permission.
    pub fn full_screen_in_front(screen: &NSScreen, mtm: MainThreadMarker) -> bool {
        let Some(front) = NSWorkspace::sharedWorkspace().frontmostApplication() else {
            return false;
        };
        let pid = front.processIdentifier();
        let Some(primary) = NSScreen::screens(mtm).firstObject() else {
            return false;
        };
        let primary_h = primary.frame().size.height;
        let target = notch::rect(screen.frame());
        let bar = bar_height(notch::read_geometry(mtm));
        // Safe: a Copy function's +1 result, released by Retained; a CFArray
        // of CFDictionary is an NSArray of NSDictionary.
        let raw = unsafe { CGWindowListCopyWindowInfo(ON_SCREEN_WINDOWS, 0) };
        let Some(list) =
            (unsafe { Retained::from_raw(raw as *mut NSArray<NSDictionary<NSString, AnyObject>>) })
        else {
            return false;
        };
        let number = |d: &NSDictionary<NSString, AnyObject>, key: &str| {
            d.objectForKey(&NSString::from_str(key))
                .and_then(|v| v.downcast::<NSNumber>().ok())
                .map(|n| n.as_i64())
        };
        list.iter().any(|d| {
            if number(&d, "kCGWindowLayer") != Some(0)
                || number(&d, "kCGWindowOwnerPID") != Some(i64::from(pid))
            {
                return false;
            }
            let Some(bounds) = d.objectForKey(&NSString::from_str("kCGWindowBounds")) else {
                return false;
            };
            let mut r = NSRect::ZERO;
            // Safe: a live dictionary and an out-pointer to a CGRect.
            if !unsafe { CGRectMakeWithDictionaryRepresentation(&*bounds, &mut r) } {
                return false;
            }
            let win = from_window_server(
                r.origin.x,
                r.origin.y,
                r.size.width,
                r.size.height,
                primary_h,
            );
            fills_screen(win, target, bar)
        })
    }

    fn ns_window(window: &tauri::WebviewWindow) -> Result<&NSWindow, String> {
        let ptr = window.ns_window().map_err(|e| e.to_string())?;
        if ptr.is_null() {
            return Err("ns_window returned null".into());
        }
        // Safe: Tauri hands out the live NSWindow for this window, and every
        // caller is on the main thread (MainThreadMarker).
        Ok(unsafe { &*(ptr as *const NSWindow) })
    }

    /// Make the freshly built window the roam panel (`ROAM_PANEL`), before it
    /// is ever shown. The isa-swap is the notch's (notch.rs `promote`): only
    /// an NSPanel honours the non-activating bit, and NSPanel adds no ivars
    /// over NSWindow. A plain NSPanel, not the notch's subclass: this one
    /// must never become key.
    pub fn promote(window: &tauri::WebviewWindow, _mtm: MainThreadMarker) -> Result<(), String> {
        let w = ns_window(window)?;
        // Safe: the same live object, viewed as the AnyObject set_class takes.
        let obj: &AnyObject = unsafe { &*(w as *const NSWindow as *const AnyObject) };
        unsafe { AnyObject::set_class(obj, NSPanel::class()) };
        w.setLevel(ROAM_PANEL.level);
        w.setStyleMask(ROAM_PANEL.mask);
        w.setCollectionBehavior(ROAM_PANEL.behaviour);
        w.setIgnoresMouseEvents(ROAM_PANEL.ignores_mouse);
        // NSPanel's default, should AppKit ever re-read it: the panel would
        // vanish whenever myco is not the active app, which is always.
        w.setHidesOnDeactivate(false);
        w.setHasShadow(false);
        Ok(())
    }

    /// Where myco stands for the window as it is placed now.
    pub fn place(window: &tauri::WebviewWindow, mtm: MainThreadMarker) -> Option<RoamPlace> {
        let w = ns_window(window).ok()?;
        let screen = notch::notch_screen(mtm)?;
        let surface = collapsed_rect(notch::rect(screen.frame()), notch::read_geometry(mtm));
        Some(place_for(notch::rect(w.frame()), surface))
    }

    /// Order the panel in over the notch screen's visible frame, unless a
    /// full-screen app holds that screen's space: then nothing moves and
    /// myco stays in the notch (None). `orderFrontRegardless`, not Tauri's
    /// `show`: that is `makeKeyAndOrderFront`, and this panel is never key.
    pub fn order_in(
        window: &tauri::WebviewWindow,
        mtm: MainThreadMarker,
    ) -> Result<Option<RoamPlace>, String> {
        let w = ns_window(window)?;
        let screen = notch::notch_screen(mtm).ok_or("no screen")?;
        if !super::may_roam(true, full_screen_in_front(&screen, mtm), dark()) {
            return Ok(None);
        }
        let f = roam_frame(
            notch::rect(screen.frame()),
            notch::rect(screen.visibleFrame()),
            notch::read_geometry(mtm),
        );
        let frame = objc2_foundation::NSRect {
            origin: objc2_foundation::NSPoint { x: f.x, y: f.y },
            size: objc2_foundation::NSSize {
                width: f.w,
                height: f.h,
            },
        };
        w.setFrame_display(frame, true);
        w.orderFrontRegardless();
        Ok(place(window, mtm))
    }

    /// One sample of the watch: is a full-screen app in front on the notch's
    /// screen, is the screen locked or asleep, and where is the pointer,
    /// window-local.
    pub fn sample(
        window: &tauri::WebviewWindow,
        mtm: MainThreadMarker,
    ) -> (bool, bool, Option<(f64, f64)>) {
        let full_screen = notch::notch_screen(mtm).is_some_and(|s| full_screen_in_front(&s, mtm));
        (full_screen, dark(), notch::panel_cursor(window, mtm))
    }
}

/// Bumped by every roam that goes out: a watch whose roam is no longer the
/// current one stops at its next sample, so a quick hide and show never runs
/// two feeds.
#[cfg(target_os = "macos")]
static ROAM_EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[cfg(target_os = "macos")]
fn notch_shown(app: &AppHandle) -> bool {
    use tauri::Manager as _;
    app.get_webview_window(crate::notch::NOTCH_LABEL)
        .is_some_and(|w| matches!(w.is_visible(), Ok(true)))
}

/// Build (once) the roam panel, hidden. A window that cannot be made the
/// panel is closed again and never shown: unpromoted, it would be an
/// ordinary window over the whole screen taking every click.
#[cfg(target_os = "macos")]
fn ensure_roam_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    use tauri::{Manager as _, WebviewUrl, WebviewWindowBuilder};
    if let Some(w) = app.get_webview_window(ROAM_LABEL) {
        return Some(w);
    }
    let built = WebviewWindowBuilder::new(
        app,
        ROAM_LABEL,
        WebviewUrl::App("index.html?window=roam".into()),
    )
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .always_on_top(true)
    .resizable(false)
    .skip_taskbar(true)
    .focused(false)
    .visible(false)
    .build();
    let window = match built {
        Ok(w) => w,
        Err(e) => {
            eprintln!("roam window failed: {e}");
            return None;
        }
    };
    let promoted = crate::notch::imp::on_main(app, {
        let win = window.clone();
        move |mtm| imp::promote(&win, mtm)
    });
    if let Ok(Err(e)) | Err(e) = promoted {
        eprintln!("roam window promote failed: {e}");
        let _ = window.destroy();
        return None;
    }
    Some(window)
}

/// Order the panel out and tell every webview myco is back.
#[cfg(target_os = "macos")]
fn recall(app: &AppHandle, window: &tauri::WebviewWindow) -> Result<(), String> {
    use tauri::Emitter as _;
    window.hide().map_err(|e| e.to_string())?;
    app.emit(ROAM_VISIBILITY_EVENT, None::<RoamPlace>)
        .map_err(|e| e.to_string())
}

/// The roam's watch: the pointer for the roam webview, and myco called back
/// when the notch goes away or a full-screen app comes forward. It runs at
/// the notch's cursor pace and ends with the roam.
#[cfg(target_os = "macos")]
fn spawn_watch(app: &AppHandle) {
    use std::sync::atomic::Ordering;
    use tauri::{Emitter as _, Manager as _};
    let epoch = ROAM_EPOCH.fetch_add(1, Ordering::Relaxed) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let start = std::time::Instant::now();
        let mut feed = CursorFeed::default();
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(
                crate::notch::CURSOR_GAP_MS,
            ))
            .await;
            let Some(win) = app.get_webview_window(ROAM_LABEL) else {
                break;
            };
            let out =
                ROAM_EPOCH.load(Ordering::Relaxed) == epoch && matches!(win.is_visible(), Ok(true));
            let (full_screen, dark, cursor) = if out {
                // No answer from the main thread calls myco back.
                crate::notch::imp::on_main(&app, {
                    let win = win.clone();
                    move |mtm| imp::sample(&win, mtm)
                })
                .unwrap_or((true, false, None))
            } else {
                (false, false, None)
            };
            let now = start.elapsed().as_millis() as u64;
            let shown = notch_shown(&app);
            match roam_tick(&mut feed, now, out, shown, full_screen, dark, cursor) {
                RoamTick::Stop => break,
                RoamTick::Recall => {
                    if let Err(e) = recall(&app, &win) {
                        eprintln!("roam recall failed: {e}");
                    }
                    break;
                }
                RoamTick::Feed(Some(p)) => {
                    let _ = win.emit(ROAM_CURSOR_EVENT, p);
                }
                RoamTick::Feed(None) => {}
            }
        }
    });
}

/// Send myco out of the notch to roam. Resolves whether it went: not while
/// the notch is hidden, a full-screen app holds the notch's screen, or the
/// screen is locked or asleep (`may_roam`). Already out, it stays out.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn roam_show(app: AppHandle) -> Result<bool, String> {
    use tauri::Emitter as _;
    if !notch_shown(&app) {
        return Ok(false);
    }
    let window = ensure_roam_window(&app).ok_or("Could not create the roam window")?;
    if window.is_visible().map_err(|e| e.to_string())? {
        return Ok(true);
    }
    let placed = crate::notch::imp::on_main(&app, {
        let win = window.clone();
        move |mtm| imp::order_in(&win, mtm)
    })??;
    let Some(place) = placed else {
        return Ok(false);
    };
    if let Err(e) = app.emit(ROAM_VISIBILITY_EVENT, Some(place)) {
        // Nobody heard it go out, so nobody would bring it back.
        let _ = window.hide();
        return Err(e.to_string());
    }
    spawn_watch(&app);
    Ok(true)
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn roam_show(_app: AppHandle) -> Result<bool, String> {
    Ok(false)
}

/// Bring myco back: the panel orders out. Nothing to do when it is not out.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn roam_hide(app: AppHandle) -> Result<(), String> {
    use tauri::Manager as _;
    match app.get_webview_window(ROAM_LABEL) {
        Some(window) if window.is_visible().map_err(|e| e.to_string())? => recall(&app, &window),
        _ => Ok(()),
    }
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn roam_hide(_app: AppHandle) -> Result<(), String> {
    Ok(())
}

/// The roam webview's first question, since it may load after the event
/// that sent myco out: where it roams, or null while myco is in the notch.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn roam_place(app: AppHandle) -> Result<Option<RoamPlace>, String> {
    use tauri::Manager as _;
    let Some(window) = app.get_webview_window(ROAM_LABEL) else {
        return Ok(None);
    };
    if !window.is_visible().map_err(|e| e.to_string())? {
        return Ok(None);
    }
    crate::notch::imp::on_main(&app, move |mtm| imp::place(&window, mtm))
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn roam_place(_app: AppHandle) -> Result<Option<RoamPlace>, String> {
    Ok(None)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::{
        fills_screen, from_window_server, may_roam, place_for, roam_frame, roam_tick, screen_dark,
        RoamPlace, RoamTick, ROAM_PANEL,
    };
    use crate::notch::{collapsed_rect, CursorFeed, NotchGeometry, ScreenRect};
    use objc2_app_kit::{
        NSFloatingWindowLevel, NSMainMenuWindowLevel, NSNormalWindowLevel,
        NSWindowCollectionBehavior, NSWindowStyleMask,
    };

    // devMock's 14" MacBook Pro: 1512×982 pt, a 204×37 cutout at x 654..858,
    // the menu bar as tall as the cutout, and the Dock 70 pt along the bottom.
    const SCREEN: ScreenRect = ScreenRect {
        x: 0.0,
        y: 0.0,
        w: 1512.0,
        h: 982.0,
    };
    const VISIBLE: ScreenRect = ScreenRect {
        x: 0.0,
        y: 70.0,
        w: 1512.0,
        h: 982.0 - 70.0 - 37.0,
    };
    const NOTCH: NotchGeometry = NotchGeometry {
        has_notch: true,
        notch_w: 204.0,
        notch_h: 37.0,
        screen_w: 1512.0,
    };

    #[test]
    fn the_panel_never_takes_a_click_or_activates_the_app() {
        assert!(ROAM_PANEL.ignores_mouse);
        assert_eq!(ROAM_PANEL.mask, NSWindowStyleMask::NonactivatingPanel);
        assert!(!ROAM_PANEL.mask.contains(NSWindowStyleMask::Titled));
    }

    #[test]
    fn it_floats_over_other_apps_but_under_the_menu_bar() {
        assert_eq!(ROAM_PANEL.level, NSFloatingWindowLevel);
        assert!(ROAM_PANEL.level > NSNormalWindowLevel);
        assert!(ROAM_PANEL.level < NSMainMenuWindowLevel);
    }

    #[test]
    fn it_joins_every_space_and_stays_out_of_the_window_cycle() {
        let b = ROAM_PANEL.behaviour;
        assert!(b.contains(NSWindowCollectionBehavior::CanJoinAllSpaces));
        assert!(b.contains(NSWindowCollectionBehavior::IgnoresCycle));
    }

    #[test]
    fn the_frame_is_the_visible_frame_of_the_notch_screen() {
        assert_eq!(roam_frame(SCREEN, VISIBLE, NOTCH), VISIBLE);
        // The Dock on the left, and the notch's screen left of the main one.
        let left_dock = ScreenRect {
            x: -1512.0 + 64.0,
            y: 0.0,
            w: 1512.0 - 64.0,
            h: 982.0 - 37.0,
        };
        let screen = ScreenRect {
            x: -1512.0,
            ..SCREEN
        };
        assert_eq!(roam_frame(screen, left_dock, NOTCH), left_dock);
    }

    #[test]
    fn an_auto_hidden_menu_bar_is_still_never_covered() {
        // With the bar set to hide, the visible frame runs to the top edge.
        let to_top = ScreenRect {
            h: 982.0 - 70.0,
            ..VISIBLE
        };
        let f = roam_frame(SCREEN, to_top, NOTCH);
        assert_eq!(f.y + f.h, 982.0 - 37.0, "under the notch-tall bar");
        assert_eq!(f.y, 70.0, "the Dock edge stays");
        let none = NotchGeometry {
            has_notch: false,
            ..NotchGeometry::default()
        };
        let f = roam_frame(SCREEN, to_top, none);
        assert_eq!(f.y + f.h, 982.0 - 24.0, "under a plain 24 pt bar");
    }

    #[test]
    fn myco_pops_out_where_the_collapsed_notch_stands() {
        let surface = collapsed_rect(SCREEN, NOTCH);
        let p = place_for(VISIBLE, surface);
        assert_eq!(
            p,
            RoamPlace {
                width: 1512.0,
                height: 875.0,
                notch_left: surface.x,
            }
        );
        // Window-local: a Dock on the left shifts the window, not the notch.
        let left_dock = ScreenRect {
            x: 64.0,
            w: 1512.0 - 64.0,
            ..VISIBLE
        };
        assert_eq!(place_for(left_dock, surface).notch_left, surface.x - 64.0);
    }

    #[test]
    fn myco_roams_only_with_the_notch_up_and_no_full_screen_app_in_front() {
        assert!(may_roam(true, false, false));
        assert!(!may_roam(false, false, false), "notch hidden");
        assert!(!may_roam(true, true, false), "a full-screen app in front");
        assert!(!may_roam(false, true, false));
    }

    #[test]
    fn myco_stays_in_while_the_screen_is_locked_or_asleep() {
        assert!(!may_roam(true, false, true));
        assert!(!screen_dark(false, false));
        assert!(screen_dark(true, false), "locked");
        assert!(screen_dark(false, true), "asleep");
        // And a lock or sleep that comes mid-roam calls it back.
        let mut feed = CursorFeed::default();
        assert_eq!(
            roam_tick(&mut feed, 0, true, true, false, true, Some((1.0, 1.0))),
            RoamTick::Recall
        );
    }

    #[test]
    fn a_window_filling_the_screen_under_the_bar_is_full_screen() {
        // Measured: a full-screen window on a notched screen sits under the
        // bar's strip, one point taller than the cutout.
        let bar = 37.0;
        let full = ScreenRect {
            h: 982.0 - 38.0,
            ..SCREEN
        };
        assert!(fills_screen(full, SCREEN, bar));
        assert!(fills_screen(SCREEN, SCREEN, bar), "drawn over the cutout");
        // A zoomed window stops at the Dock; a half-screen tile is half wide.
        assert!(!fills_screen(VISIBLE, SCREEN, bar));
        let half = ScreenRect { w: 756.0, ..full };
        assert!(!fills_screen(half, SCREEN, bar));
        // On another screen than the notch's.
        let other = ScreenRect { x: 1512.0, ..full };
        assert!(!fills_screen(other, SCREEN, bar));
    }

    #[test]
    fn window_server_bounds_turn_into_appkit_coordinates() {
        // CGWindowList is y-down from the primary screen's top-left.
        let r = from_window_server(0.0, 38.0, 1512.0, 944.0, 982.0);
        assert_eq!(
            r,
            ScreenRect {
                x: 0.0,
                y: 0.0,
                w: 1512.0,
                h: 944.0
            }
        );
    }

    #[test]
    fn the_pointer_is_fed_at_30_hz_or_less_while_out() {
        let mut feed = CursorFeed::default();
        let mut sent = 0;
        for t in (0..1000).step_by(5) {
            let p = Some((t as f64, 5.0));
            match roam_tick(&mut feed, t, true, true, false, false, p) {
                RoamTick::Feed(Some(_)) => sent += 1,
                RoamTick::Feed(None) => {}
                other => panic!("{other:?}"),
            }
        }
        assert!((25..=30).contains(&sent), "{sent}");
        // A still pointer is sent once.
        let mut feed = CursorFeed::default();
        let still = Some((3.0, 4.0));
        assert_eq!(
            roam_tick(&mut feed, 0, true, true, false, false, still),
            RoamTick::Feed(still)
        );
        assert_eq!(
            roam_tick(&mut feed, 100, true, true, false, false, still),
            RoamTick::Feed(None)
        );
    }

    #[test]
    fn nothing_is_fed_once_the_roam_is_over() {
        let mut feed = CursorFeed::default();
        assert_eq!(
            roam_tick(&mut feed, 0, false, true, false, false, Some((1.0, 1.0))),
            RoamTick::Stop
        );
    }

    #[test]
    fn a_full_screen_app_or_a_hidden_notch_calls_myco_back() {
        let mut feed = CursorFeed::default();
        let p = Some((1.0, 1.0));
        assert_eq!(
            roam_tick(&mut feed, 0, true, true, true, false, p),
            RoamTick::Recall
        );
        assert_eq!(
            roam_tick(&mut feed, 34, true, false, false, false, p),
            RoamTick::Recall
        );
    }
}
