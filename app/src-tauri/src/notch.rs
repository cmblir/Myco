//! macOS notch spike (P0).
//!
//! Two things a notch surface needs from AppKit that Tauri does not expose:
//!
//! 1. the notch's real geometry — `NSScreen.safeAreaInsets.top` is the notch
//!    height, and what is left between `auxiliaryTopLeftArea` and
//!    `auxiliaryTopRightArea` (the two usable menu-bar strips) is its width;
//! 2. a window that draws ABOVE the menu bar without stealing focus. Tauri's
//!    `always_on_top` is NSFloatingWindowLevel (3) and the menu bar sits at 24,
//!    so the window has to be pushed to NSStatusWindowLevel (25). The
//!    non-activating style bit is honoured only by NSPanel, so the NSWindow
//!    Tauri built is isa-swapped to NSPanel first — NSPanel adds no ivars over
//!    NSWindow, which is what makes the swap safe (and it is what every
//!    menu-bar app, including tauri-nspanel, does).
//!
//! Non-macOS targets get an inert stub so the crate still builds.
//!
//! ## P0 spike verdict (2026-08-26, measured on a notched M3 / macOS 26)
//!
//! All three questions passed, so P1 builds on a real notch window:
//! 1. geometry — `{ has_notch: true, notch_w: 208.0, notch_h: 37.0,
//!    screen_w: 1920.0 }` (points, at the user's "more space" scaling);
//! 2. layering + non-activation — isa-swap to NSPanel at level 25 with
//!    styleMask 0x80 (nonactivating); a click on the panel left the
//!    frontmost app unchanged. `_setPreventsActivation:` (private) was ALSO
//!    on during the probe, so whether the public bits suffice alone is
//!    unproven — P1 should try without it first;
//! 3. drag receipt — a real Finder file drag delivered the full
//!    Enter{paths}/Over/Drop{paths} sequence to the non-activating panel.
//!    (Synthetic-drag footnote: CGEvent drags only start a file drag when the
//!    pointer moves in small interpolated steps; instant teleports rubber-band
//!    instead. Matters for test automation, not for users.)

use serde::Serialize;
use tauri::AppHandle;

/// Notch metrics in points (not pixels — AppKit screen coordinates).
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
pub struct NotchGeometry {
    pub has_notch: bool,
    pub notch_w: f64,
    pub notch_h: f64,
    pub screen_w: f64,
}

/// The arithmetic half of the geometry read, split out so it is testable
/// without AppKit. `aux_left_w`/`aux_right_w` are the widths of the two
/// menu-bar areas either side of the notch; the gap between them is the notch.
///
/// macOS-only: its one caller sits behind the same cfg, so on other targets
/// this is dead code and a `-D warnings` build would fail on it.
#[cfg(target_os = "macos")]
fn compute(screen_w: f64, aux_left_w: f64, aux_right_w: f64, safe_top: f64) -> NotchGeometry {
    // A Mac with no notch reports a zero top inset; some virtual displays also
    // report auxiliary areas of zero, and "screen_w wide" is not a notch, so
    // both have to be present before we claim a width.
    let has_notch = safe_top > 0.0 && aux_left_w > 0.0 && aux_right_w > 0.0;
    NotchGeometry {
        has_notch,
        notch_w: if has_notch {
            (screen_w - aux_left_w - aux_right_w).max(0.0)
        } else {
            0.0
        },
        notch_h: if has_notch { safe_top } else { 0.0 },
        screen_w,
    }
}

/// A rect in AppKit screen points: origin bottom-left, y up.
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct ScreenRect {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) w: f64,
    pub(crate) h: f64,
}

#[cfg(target_os = "macos")]
impl ScreenRect {
    fn contains(&self, px: f64, py: f64, slop: f64) -> bool {
        px >= self.x - slop
            && px <= self.x + self.w + slop
            && py >= self.y - slop
            && py <= self.y + self.h + slop
    }
}

/// The notch window remains centred on the hardware cutout at every size.
#[cfg(target_os = "macos")]
fn frame_x(screen: ScreenRect, width: f64) -> f64 {
    screen.x + (screen.w - width) / 2.0
}

/// What hovering opens the panel on: the `w × h` target at the top of the
/// screen, centred on the cutout or the transparent notchless target.
#[cfg(target_os = "macos")]
fn opening_rect(screen: ScreenRect, w: f64, h: f64) -> ScreenRect {
    let x = screen.x + (screen.w - w) / 2.0;
    ScreenRect {
        x,
        y: screen.y + screen.h - h,
        w,
        h,
    }
}

/// The collapsed input target on `screen`: the hardware cutout, or a
/// transparent target on a Mac without a notch. Hovering it opens the peek, and the
/// roam window (roam.rs) pops myco out from its left edge.
#[cfg(target_os = "macos")]
pub(crate) fn collapsed_rect(screen: ScreenRect, geom: NotchGeometry) -> ScreenRect {
    if geom.has_notch {
        opening_rect(screen, geom.notch_w, geom.notch_h)
    } else {
        opening_rect(screen, PILL_W, PILL_H)
    }
}

#[cfg(target_os = "macos")]
pub(crate) mod imp {
    use super::{collapsed_rect, compute, frame_x, NotchGeometry, ScreenRect};
    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSScreen;
    use tauri::AppHandle;

    use objc2::runtime::AnyObject;
    use objc2::ClassType;
    use objc2_app_kit::{NSPanel, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask};

    // Only the probe's diagnostics look at the drag types.
    #[cfg(feature = "notch-probe")]
    use objc2_app_kit::NSView;

    /// NSStatusWindowLevel. The menu bar is NSMainMenuWindowLevel (24), so 25
    /// is the lowest level that covers it.
    const NS_STATUS_WINDOW_LEVEL: isize = 25;

    /// Run `f` on the main thread and wait for its value. Every AppKit call in
    /// this module is main-thread-only, and Tauri commands are not.
    pub fn on_main<T: Send + 'static>(
        app: &AppHandle,
        f: impl FnOnce(MainThreadMarker) -> T + Send + 'static,
    ) -> Result<T, String> {
        let (tx, rx) = std::sync::mpsc::channel();
        app.run_on_main_thread(move || {
            // Safe: run_on_main_thread is, by contract, on the main thread.
            let mtm = MainThreadMarker::new()
                .expect("tauri run_on_main_thread must run on the main thread");
            let _ = tx.send(f(mtm));
        })
        .map_err(|e| e.to_string())?;
        rx.recv().map_err(|e| e.to_string())
    }

    /// The screen the notch lives on: the built-in display, identified as the
    /// first one reporting a top safe-area inset. Falls back to the main screen
    /// so a notch-less Mac still gets an honest `screen_w`.
    pub fn notch_screen(mtm: MainThreadMarker) -> Option<Retained<NSScreen>> {
        NSScreen::screens(mtm)
            .iter()
            .find(|s| s.safeAreaInsets().top > 0.0)
            .or_else(|| NSScreen::mainScreen(mtm))
    }

    pub fn read_geometry(mtm: MainThreadMarker) -> NotchGeometry {
        let Some(screen) = notch_screen(mtm) else {
            return NotchGeometry::default();
        };
        let frame = screen.frame();
        let left = screen.auxiliaryTopLeftArea();
        let right = screen.auxiliaryTopRightArea();
        compute(
            frame.size.width,
            left.size.width,
            right.size.width,
            screen.safeAreaInsets().top,
        )
    }

    /// Every attached screen, in AppKit global coordinates. Spike diagnostics:
    /// multi-display layouts are exactly where notch positioning goes wrong.
    // Probe-only (see `spawn_probe`): compiled out of a normal build.
    #[cfg(feature = "notch-probe")]
    pub fn screens_summary(mtm: MainThreadMarker) -> String {
        NSScreen::screens(mtm)
            .iter()
            .map(|s| {
                let f = s.frame();
                format!(
                    "[{} ({},{} {}x{}) safeTop={}]",
                    s.localizedName(),
                    f.origin.x,
                    f.origin.y,
                    f.size.width,
                    f.size.height,
                    s.safeAreaInsets().top
                )
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// Park the window flush against the top edge of the notched screen,
    /// horizontally centred on the notch. Tauri's own `set_position` runs a
    /// multi-display coordinate conversion that placed the window *above* the
    /// screen on this machine (frame y=1205 on a 1200pt-tall display); AppKit
    /// screen coordinates are unambiguous, so P1 should position this way.
    // Probe-only (see `spawn_probe`): compiled out of a normal build.
    #[cfg(feature = "notch-probe")]
    pub fn pin_to_top(window: &tauri::WebviewWindow, mtm: MainThreadMarker) -> Result<(), String> {
        let screen = notch_screen(mtm).ok_or("no screen")?;
        let sf = screen.frame();
        let ptr = window.ns_window().map_err(|e| e.to_string())?;
        // Safe: Tauri hands out the live NSWindow, and we are on the main thread.
        let w: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        let mut origin = w.frame().origin;
        origin.x = sf.origin.x + (sf.size.width - w.frame().size.width) / 2.0;
        origin.y = sf.origin.y + sf.size.height - w.frame().size.height;
        w.setFrameOrigin(origin);
        Ok(())
    }

    /// What AppKit thinks of the window right now. Spike diagnostics: the
    /// promotion happens behind Tauri's back, so nothing else can see it.
    // Probe-only (see `spawn_probe`): compiled out of a normal build.
    #[cfg(feature = "notch-probe")]
    pub fn describe(window: &tauri::WebviewWindow, _mtm: MainThreadMarker) -> String {
        let Ok(ptr) = window.ns_window() else {
            return "ns_window unavailable".into();
        };
        // Safe: Tauri hands out the live NSWindow, and we are on the main thread.
        let w: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        let f = w.frame();
        format!(
            "frame=({},{} {}x{}) visible={} onActiveSpace={} alpha={} opaque={} level={}",
            f.origin.x,
            f.origin.y,
            f.size.width,
            f.size.height,
            w.isVisible(),
            w.isOnActiveSpace(),
            w.alphaValue(),
            w.isOpaque(),
            w.level(),
        )
    }

    /// Raise the window above the menu bar and stop clicks on it from
    /// activating myco. See the module docs for why the class swap is needed.
    /// Public AppKit bits only — the private `_setPreventsActivation:` lever
    /// stays behind `notch-probe` (module docs: unproven whether the public
    /// bits suffice alone, so ship without it and re-measure if they don't).
    /// The runtime NSPanel subclass the notch window is isa-swapped to.
    /// One override: `canBecomeKeyWindow` returns YES. A plain NSPanel with
    /// the non-activating mask refuses key (measured live:
    /// "makeKeyWindow refused (canBecomeKey=false)"), which left the capture
    /// input deaf. Overriding the getter is what tauri-nspanel does; the
    /// panel still never ACTIVATES the app — non-activation comes from the
    /// style mask, not from refusing key status.
    fn notch_panel_class() -> &'static objc2::runtime::AnyClass {
        use std::sync::OnceLock;
        static CLASS: OnceLock<&'static objc2::runtime::AnyClass> = OnceLock::new();
        CLASS.get_or_init(|| {
            let mut builder =
                objc2::runtime::ClassBuilder::new(c"MycoNotchPanel", NSPanel::class())
                    .expect("class name free");
            extern "C-unwind" fn can_become_key(
                _this: &AnyObject,
                _sel: objc2::runtime::Sel,
            ) -> objc2::runtime::Bool {
                objc2::runtime::Bool::YES
            }
            unsafe {
                builder.add_method(
                    objc2::sel!(canBecomeKeyWindow),
                    can_become_key as extern "C-unwind" fn(_, _) -> _,
                );
            }
            builder.register()
        })
    }

    pub fn promote(window: &tauri::WebviewWindow, mtm: MainThreadMarker) -> Result<(), String> {
        let ptr = window.ns_window().map_err(|e| e.to_string())?;
        if ptr.is_null() {
            return Err("ns_window returned null".into());
        }
        // Safe: Tauri hands out the live NSWindow for this window, and we are
        // on the main thread (MainThreadMarker).
        let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        let obj: &AnyObject = unsafe { &*(ptr as *const AnyObject) };
        unsafe { AnyObject::set_class(obj, notch_panel_class()) };
        ns_window.setLevel(NS_STATUS_WINDOW_LEVEL);
        // Replace, not OR: the mask must be exactly the non-activating panel
        // (Borderless is 0). Leaving Titled/FullSizeContentView in place keeps
        // AppKit treating it as an ordinary activating window.
        ns_window.setStyleMask(NSWindowStyleMask::NonactivatingPanel);
        // Follow the user across spaces and stay put over a fullscreen app —
        // a menu-bar surface that vanishes on space switch is not one.
        ns_window.setCollectionBehavior(
            NSWindowCollectionBehavior::CanJoinAllSpaces
                | NSWindowCollectionBehavior::Stationary
                | NSWindowCollectionBehavior::FullScreenAuxiliary,
        );
        // S7 typing: let the panel become key, but only when a view asks for
        // it (public NSPanel bit; the capture entry then asks explicitly via
        // `focus_capture`). Sound cast: the isa-swap above made this an
        // NSPanel, and NSPanel adds no ivars over NSWindow.
        let panel: &NSPanel = unsafe { &*(ptr as *const NSPanel) };
        panel.setBecomesKeyOnlyIfNeeded(true);
        // Hover growth needs mouse-MOVED events, which a non-key panel does
        // not track by default — clicks arrived while hover stayed dead, the
        // exact signature the second headed run reported.
        ns_window.setAcceptsMouseMovedEvents(true);
        let _ = mtm;
        Ok(())
    }

    /// Give the panel key focus for S7 text capture, WITHOUT activating the
    /// app. Two public paths, both attempted and logged, because WKWebView is
    /// not guaranteed to answer `needsPanelToBecomeKey` (so the
    /// `becomesKeyOnlyIfNeeded` route alone may never fire — owner verifies
    /// the logs on hardware):
    /// 1. `makeKeyWindow` — the direct ask;
    /// 2. `makeKeyAndOrderFront` — the fallback; on a nonactivating NSPanel
    ///    key is granted without app activation.
    ///
    /// Returns whether the panel IS the key window afterwards — the honest
    /// answer even when both paths refuse.
    // ponytail: if canBecomeKey logs false on-device, both paths are dead —
    // upgrade path is an isa-swap to a runtime NSPanel subclass overriding
    // canBecomeKeyWindow (tauri-nspanel's approach).
    pub fn focus_capture(
        window: &tauri::WebviewWindow,
        _mtm: MainThreadMarker,
    ) -> Result<bool, String> {
        let ptr = window.ns_window().map_err(|e| e.to_string())?;
        if ptr.is_null() {
            return Err("ns_window returned null".into());
        }
        // Safe: Tauri hands out the live NSWindow, and we are on the main thread.
        let w: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        let can = w.canBecomeKeyWindow();
        w.makeKeyWindow();
        let mut key = w.isKeyWindow();
        if !key {
            w.makeKeyAndOrderFront(None);
            key = w.isKeyWindow();
            eprintln!(
                "notch: makeKeyWindow refused (canBecomeKey={can}); \
                 makeKeyAndOrderFront fallback → isKeyWindow={key}"
            );
        } else {
            eprintln!("notch: makeKeyWindow ok (canBecomeKey={can})");
        }
        Ok(key)
    }

    pub fn rect(r: objc2_foundation::NSRect) -> ScreenRect {
        ScreenRect {
            x: r.origin.x,
            y: r.origin.y,
            w: r.size.width,
            h: r.size.height,
        }
    }

    /// Is the pointer on the notch (or, once open, still on the card)?
    ///
    /// Opening is decided by the HARDWARE CUTOUT rect — never by the
    /// window frame. The frame is 252×170 while open and stays that size
    /// through the fold delay, so testing it made a region far below the
    /// notch re-open the panel on the way past: the owner's "노치보다 멀리
    /// 있는데도 켜져서 업무에 방해가 돼".
    ///
    /// Staying open is the generous test (`inside` = true): the frame plus a
    /// 12pt slop, unioned with the cutout, so the card the pointer
    /// walked down into never folds under it.
    pub fn hover_hit(
        window: &tauri::WebviewWindow,
        mtm: MainThreadMarker,
        inside: bool,
    ) -> Option<bool> {
        use objc2_app_kit::NSEvent;
        let screen = notch_screen(mtm)?;
        let target = collapsed_rect(rect(screen.frame()), read_geometry(mtm));
        let p = NSEvent::mouseLocation();
        let on_surface = target.contains(p.x, p.y, 0.0);
        if !inside {
            return Some(on_surface);
        }
        let ptr = window.ns_window().ok()?;
        if ptr.is_null() {
            return None;
        }
        let f = unsafe { &*(ptr as *const NSWindow) }.frame();
        const SLOP: f64 = 12.0;
        Some(on_surface || rect(f).contains(p.x, p.y, SLOP))
    }

    /// The pointer in the panel's own coordinates: points from the window's
    /// top-left, y down — the webview's clientX/clientY. Outside the window
    /// it simply runs past 0 or the window's size.
    pub fn panel_cursor(
        window: &tauri::WebviewWindow,
        _mtm: MainThreadMarker,
    ) -> Option<(f64, f64)> {
        use objc2_app_kit::NSEvent;
        let ptr = window.ns_window().ok()?;
        if ptr.is_null() {
            return None;
        }
        // Safe: Tauri hands out the live NSWindow, and we are on the main thread.
        let f = unsafe { &*(ptr as *const NSWindow) }.frame();
        let p = NSEvent::mouseLocation();
        Some((p.x - f.origin.x, f.origin.y + f.size.height - p.y))
    }

    /// Size the window and park it flush against the top of the notched
    /// screen: centred on the notch (screen-centre IS notch-centre, and the
    /// menu-bar centre on a notch-less Mac).
    /// One AppKit `setFrame:` in screen coordinates: Tauri's
    /// `set_position` ran a multi-display conversion that placed the window
    /// off-screen on this machine (see `pin_to_top`), and a separate resize
    /// would let AppKit's bottom-left origin drop the top edge for a frame.
    pub fn place_over_notch(
        window: &tauri::WebviewWindow,
        mtm: MainThreadMarker,
        width: f64,
        height: f64,
    ) -> Result<(), String> {
        let screen = notch_screen(mtm).ok_or("no screen")?;
        let sf = screen.frame();
        let ptr = window.ns_window().map_err(|e| e.to_string())?;
        if ptr.is_null() {
            return Err("ns_window returned null".into());
        }
        // Safe: Tauri hands out the live NSWindow, and we are on the main thread.
        let w: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        // setContentSize + setFrameTopLeftPoint instead of hand-built frame
        // math: the first live run ended with the panel at y=832 mid-screen —
        // whatever produced that, pinning the TOP-left through AppKit's own
        // API removes the bottom-left-origin arithmetic from this code
        // entirely. The top-left point's y is the screen's top edge
        // (origin.y + height, in AppKit's bottom-up coords).
        w.setContentSize(objc2_foundation::NSSize { width, height });
        let top = objc2_foundation::NSPoint {
            x: frame_x(rect(sf), width),
            y: sf.origin.y + sf.size.height,
        };
        w.setFrameTopLeftPoint(top);
        let placed = w.frame();
        eprintln!(
            "notch: placed {}x{} at bottom-left ({}, {}) on screen {}x{}+{}+{}",
            placed.size.width,
            placed.size.height,
            placed.origin.x,
            placed.origin.y,
            sf.size.width,
            sf.size.height,
            sf.origin.x,
            sf.origin.y
        );
        Ok(())
    }

    /// The probe's promotion: the production `promote` plus the spike A/B
    /// levers (env-gated) and the AppKit state string the spike logs.
    // Probe-only (see `spawn_probe`): compiled out of a normal build.
    #[cfg(feature = "notch-probe")]
    pub fn probe_promote(
        window: &tauri::WebviewWindow,
        mtm: MainThreadMarker,
    ) -> Result<String, String> {
        promote(window, mtm)?;
        let ptr = window.ns_window().map_err(|e| e.to_string())?;
        // Safe: promote() above already validated this pointer.
        let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        let obj: &AnyObject = unsafe { &*(ptr as *const AnyObject) };
        // Spike A/B levers, env-gated so one build can bisect what actually
        // stops the app from activating on a click.
        if std::env::var("MYCO_NOTCH_REORDER").as_deref() == Ok("1") {
            ns_window.orderOut(None);
            ns_window.orderFrontRegardless();
        }
        if std::env::var("MYCO_NOTCH_PREVENT_ACTIVATION").as_deref() == Ok("1") {
            let sel = objc2::sel!(_setPreventsActivation:);
            if obj.class().responds_to(sel) {
                // Private AppKit selector; the public route (creating the
                // window as a non-activating NSPanel) is not reachable from
                // Tauri, which owns window creation.
                let _: () = unsafe { objc2::msg_send![obj, _setPreventsActivation: true] };
                eprintln!("notch-probe: _setPreventsActivation: applied");
            } else {
                eprintln!("notch-probe: _setPreventsActivation: not available");
            }
        }
        let dragged_types = window
            .ns_view()
            .ok()
            .filter(|p| !p.is_null())
            .map(|p| {
                // Safe: Tauri's ns_view is the live content NSView.
                let view: &NSView = unsafe { &*(p as *const NSView) };
                view.registeredDraggedTypes()
                    .iter()
                    .map(|t| t.to_string())
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_default();
        Ok(format!(
            "class={} level={} styleMask={:#x} canBecomeKey={} draggedTypes=[{dragged_types}]",
            obj.class().name().to_string_lossy(),
            ns_window.level(),
            ns_window.styleMask().0,
            ns_window.canBecomeKeyWindow(),
        ))
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn notch_geometry(app: AppHandle) -> Result<NotchGeometry, String> {
    imp::on_main(&app, imp::read_geometry)
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn notch_geometry(_app: AppHandle) -> Result<NotchGeometry, String> {
    Ok(NotchGeometry::default())
}

// ─── production notch window ─────────────────────────────────────────────────

/// Window label for the notch drop surface (frontend routes on `?window=notch`;
/// `capabilities/default.json` already lists it).
pub const NOTCH_LABEL: &str = "notch";

/// Transparent input target on a Mac without a hardware notch.
#[cfg(target_os = "macos")]
const PILL_W: f64 = 172.0;
#[cfg(target_os = "macos")]
const PILL_H: f64 = 26.0;
/// Transparent drop strip below the cutout, mirrored by notchDriver.ts.
#[cfg(target_os = "macos")]
const NOTCH_PEEK_PX: f64 = 14.0;

/// Initial and re-shown windows never cover adjacent menu-bar controls.
#[cfg(target_os = "macos")]
fn shown_fit(geometry: NotchGeometry) -> (f64, f64) {
    if geometry.has_notch {
        (geometry.notch_w, geometry.notch_h + NOTCH_PEEK_PX)
    } else {
        (PILL_W, PILL_H)
    }
}

/// Create (once) the notch drop surface: spotlight's window recipe, promoted
/// above the menu bar as a non-activating NSPanel (the P0-proven promotion,
/// public bits only) and parked flush over the notch. Returns the live window,
/// or None when it cannot be built — like the tray, a failure here must never
/// take the app down.
#[cfg(target_os = "macos")]
pub fn ensure_notch_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    use tauri::{Manager as _, WebviewUrl, WebviewWindowBuilder};
    if let Some(w) = app.get_webview_window(NOTCH_LABEL) {
        return Some(w);
    }
    let geometry = imp::on_main(app, imp::read_geometry).unwrap_or_default();
    let (width, height) = shown_fit(geometry);
    // Drag-drop must reach this window. Tauri's drag-drop handler is ON by
    // default (verified in tauri-runtime 2.11.1: `WebviewAttributes::new` sets
    // `drag_drop_handler_enabled: true`; the only knobs are the opt-out
    // `disable_drag_drop_handler()` and a Windows-only `drag_and_drop()`,
    // neither used here), so the frontend receives Enter/Over/Drop through
    // `onDragDropEvent` — exactly what the P0 spike measured.
    let built = WebviewWindowBuilder::new(
        app,
        NOTCH_LABEL,
        WebviewUrl::App("index.html?window=notch".into()),
    )
    .decorations(false)
    .transparent(true)
    // OS shadow OFF, same reason as the tray panel: it hugs the transparent
    // window rect, not what the webview draws inside it.
    .shadow(false)
    .always_on_top(true)
    .resizable(false)
    .skip_taskbar(true)
    // Built hidden, shown only after promotion below — a frame drawn at the
    // ordinary window level would flash below the menu bar first.
    .visible(false)
    .inner_size(width, height)
    .build();
    let window = match built {
        Ok(w) => w,
        Err(e) => {
            eprintln!("notch window failed: {e}");
            return None;
        }
    };
    let outcome = imp::on_main(app, {
        let win = window.clone();
        move |mtm| {
            imp::promote(&win, mtm)?;
            imp::place_over_notch(&win, mtm, width, height)
        }
    });
    if let Ok(Err(e)) | Err(e) = outcome {
        // Still shown: an unpromoted window floats below the menu bar, which
        // is degraded but usable — and the failure is logged, not swallowed.
        eprintln!("notch window promote/place failed: {e}");
    }
    let _ = window.show();
    spawn_hover_watch(app);
    Some(window)
}

/// Event sent to the notch webview whenever the pointer crosses the panel's
/// frame. WKWebView's own hover tracking runs only while THIS app is active,
/// and the notch lives over other apps' sessions — clicks arrived, hover
/// never did (both headed runs). So the pointer is polled natively instead:
/// NSEvent.mouseLocation and NSWindow.frame share the same bottom-left screen
/// space, making containment one rect test. 8 Hz, no drawing — the panel only
/// redraws when the state actually flips.
#[cfg(target_os = "macos")]
const NOTCH_HOVER_EVENT: &str = "notch-hover";

/// The pointer, panel-local `[x, y]` in points, for the mascot's eyes (spec
/// 2026-10-02 decision 5). Sent only while hovered and only when it moved, so
/// a hidden or collapsed notch gets no events and starts no frames.
#[cfg(target_os = "macos")]
const NOTCH_CURSOR_EVENT: &str = "notch-cursor";

/// The watch's pace away from the notch: 8 Hz, as it always was.
#[cfg(target_os = "macos")]
const HOVER_POLL_MS: u64 = 125;
/// Hovered, it samples (and sends the cursor) at most every 34 ms: ≤ 30 Hz.
#[cfg(target_os = "macos")]
pub(crate) const CURSOR_GAP_MS: u64 = 34;
/// Leave once the pointer has been off the panel this long — three 8 Hz
/// samples, the rule from before the cursor feed made sampling faster.
#[cfg(target_os = "macos")]
const LEAVE_MS: u64 = 250;

/// What one sample of the hover watch sends: a hover flip, a cursor, both or
/// neither.
#[cfg(target_os = "macos")]
#[derive(Debug, Default, PartialEq)]
struct HoverEmit {
    hover: Option<bool>,
    cursor: Option<(f64, f64)>,
}

/// The pointer feed's throttle, shared by the hover watch and the roam
/// window's feed (roam.rs): the first cursor goes at once, then only one
/// that moved, at most every `CURSOR_GAP_MS` (≤ 30 Hz).
#[cfg(target_os = "macos")]
#[derive(Debug, Default)]
pub(crate) struct CursorFeed {
    /// The last cursor sent, and when.
    sent: Option<((f64, f64), u64)>,
}

#[cfg(target_os = "macos")]
impl CursorFeed {
    /// The next one sent goes at once.
    pub(crate) fn reset(&mut self) {
        self.sent = None;
    }

    /// `p` sampled at `now_ms`: the cursor to send, if it is due.
    pub(crate) fn offer(&mut self, now_ms: u64, p: (f64, f64)) -> Option<(f64, f64)> {
        let due = match self.sent {
            None => true,
            Some((last, at)) => last != p && now_ms.saturating_sub(at) >= CURSOR_GAP_MS,
        };
        if due {
            self.sent = Some((p, now_ms));
        }
        due.then_some(p)
    }
}

/// The hover watch's rules without AppKit, so they are testable: the
/// enter/leave debounce and the eyes' cursor feed, with its throttle and its
/// gating on hover.
#[cfg(target_os = "macos")]
#[derive(Debug, Default)]
struct HoverGate {
    inside: bool,
    /// When the current run of off-panel samples began.
    outside_since: Option<u64>,
    sent: CursorFeed,
}

#[cfg(target_os = "macos")]
impl HoverGate {
    /// The window is hidden: forget the hover. Nothing is sent, as before.
    fn hidden(&mut self) {
        *self = Self::default();
    }

    /// One sample at `now_ms`: `hit` is `imp::hover_hit`'s answer for the
    /// current `inside`, `cursor` the panel-local pointer.
    fn sample(&mut self, now_ms: u64, hit: bool, cursor: Option<(f64, f64)>) -> HoverEmit {
        let was = self.inside;
        // Enter fires on the first inside sample; leave waits LEAVE_MS, so
        // grazing the edge on the way in never folds a panel that just grew
        // under the pointer.
        if hit {
            self.outside_since = None;
            self.inside = true;
        } else {
            let since = *self.outside_since.get_or_insert(now_ms);
            self.inside = was && now_ms.saturating_sub(since) < LEAVE_MS;
        }
        let mut out = HoverEmit {
            hover: (self.inside != was).then_some(self.inside),
            cursor: None,
        };
        if !self.inside {
            // The next hover sends its first cursor at once.
            self.sent.reset();
            return out;
        }
        out.cursor = cursor.and_then(|p| self.sent.offer(now_ms, p));
        out
    }

    /// How long to sleep before the next sample.
    fn poll_ms(&self) -> u64 {
        if self.inside {
            CURSOR_GAP_MS
        } else {
            HOVER_POLL_MS
        }
    }
}

#[cfg(target_os = "macos")]
fn spawn_hover_watch(app: &AppHandle) {
    use tauri::{Emitter as _, Manager as _};
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let start = std::time::Instant::now();
        let mut gate = HoverGate::default();
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(gate.poll_ms())).await;
            let Some(win) = app.get_webview_window(NOTCH_LABEL) else {
                break;
            };
            if !matches!(win.is_visible(), Ok(true)) {
                gate.hidden();
                continue;
            }
            // Opening tests the cutout only; staying open tests the card too
            // (see `imp::hover_hit`). The 12pt slop lives on the staying-open
            // side, where an edge wobble would otherwise strobe the panel.
            let was_inside = gate.inside;
            let probe = imp::on_main(&app, {
                let win = win.clone();
                move |mtm| {
                    let hit = imp::hover_hit(&win, mtm, was_inside) == Some(true);
                    // Away from the notch the sample is exactly what it was.
                    let cursor = if hit || was_inside {
                        imp::panel_cursor(&win, mtm)
                    } else {
                        None
                    };
                    (hit, cursor)
                }
            });
            let (hit, cursor) = probe.unwrap_or((false, None));
            let out = gate.sample(start.elapsed().as_millis() as u64, hit, cursor);
            if let Some(inside) = out.hover {
                let _ = win.emit(NOTCH_HOVER_EVENT, inside);
            }
            if let Some(p) = out.cursor {
                let _ = win.emit(NOTCH_CURSOR_EVENT, p);
            }
        }
    });
}

#[cfg(not(target_os = "macos"))]
pub fn ensure_notch_window(_app: &AppHandle) -> Option<tauri::WebviewWindow> {
    None
}

/// Fit the notch window to the frontend's collapsed/expanded state — the same
/// contract as `resize_tray_panel` (logical px from the webview's measurement)
/// — flush with the top of the screen and centred by `frame_x`.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn notch_resize(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    use tauri::Manager as _;
    let Some(win) = app.get_webview_window(NOTCH_LABEL) else {
        return Ok(()); // window not created yet — the builder size applies
    };
    if !win.is_visible().map_err(|e| e.to_string())? {
        return Ok(());
    }
    // Clamped like resize_tray_panel: a broken measurement must not produce a
    // zero-size or screen-swallowing invisible surface.
    let width = width.clamp(24.0, 1200.0);
    let height = height.clamp(20.0, 800.0);
    imp::on_main(&app, move |mtm| {
        imp::place_over_notch(&win, mtm, width, height)
    })?
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn notch_resize(_app: AppHandle, _width: f64, _height: f64) -> Result<(), String> {
    Ok(())
}

/// S7 capture entry: the frontend asks the panel to take key focus so its
/// input can type. Resolves whether the panel actually became key — the
/// caller logs it; a nonactivating panel is allowed to refuse (see
/// `imp::focus_capture`).
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn notch_focus_capture(app: AppHandle) -> Result<bool, String> {
    use tauri::Manager as _;
    let Some(win) = app.get_webview_window(NOTCH_LABEL) else {
        return Err("notch window does not exist".into());
    };
    imp::on_main(&app, move |mtm| imp::focus_capture(&win, mtm))?
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn notch_focus_capture(_app: AppHandle) -> Result<bool, String> {
    Ok(false)
}

/// Apply visibility before persisting; restore it if either operation fails.
fn apply_notch_preference(
    previous: bool,
    enabled: bool,
    mut set_visible: impl FnMut(bool) -> Result<(), String>,
    persist: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if let Err(error) = set_visible(enabled).and_then(|()| persist()) {
        return match set_visible(previous) {
            Ok(()) => Err(error),
            Err(rollback) => Err(format!("{error}; restore notch visibility: {rollback}")),
        };
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn set_notch_visible(app: &AppHandle, enabled: bool) -> Result<(), String> {
    use tauri::{Emitter as _, Manager as _};
    if enabled {
        let window = ensure_notch_window(app).ok_or("Could not create notch window")?;
        let win = window.clone();
        imp::on_main(app, move |mtm| {
            let (width, height) = shown_fit(imp::read_geometry(mtm));
            imp::place_over_notch(&win, mtm, width, height)
        })??;
        window
            .emit("notch-visibility", true)
            .map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())
    } else if let Some(window) = app.get_webview_window(NOTCH_LABEL) {
        // Destroying a promoted NSPanel detaches WKWebView from its KVO window
        // observer and can raise an uncaught Objective-C exception. Retain the
        // window and its one hover watcher; hide/show never detaches the view.
        window
            .emit("notch-visibility", false)
            .map_err(|e| e.to_string())?;
        window.hide().map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
fn set_notch_visible(_app: &AppHandle, _enabled: bool) -> Result<(), String> {
    Ok(())
}

/// The Settings toggle keeps the promoted window alive and reuses it on enable.
#[tauri::command]
pub fn update_notch_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut settings = crate::settings::load();
    let previous = settings.notch_enabled;
    settings.notch_enabled = enabled;
    apply_notch_preference(
        previous,
        enabled,
        |visible| set_notch_visible(&app, visible),
        || crate::settings::save(&settings),
    )
}

/// P0 spike probe: opens a small window over the notch, promotes it above the
/// menu bar, and logs every drag-drop event to stderr — the three things the
/// spike has to prove, in one launch.
///
/// Behind the `notch-probe` cargo feature (off by default), NOT just an env
/// var: it drives a private AppKit selector (`_setPreventsActivation:`) and
/// paints a debug window, neither of which belongs in a shipped binary. Same
/// treatment as the retired `rerank` experiment. Build it with
/// `cargo run --features notch-probe`, then `MYCO_NOTCH_PROBE=1`.
#[cfg(all(target_os = "macos", feature = "notch-probe"))]
pub fn spawn_probe(app: &AppHandle) {
    use tauri::{Manager as _, WebviewUrl, WebviewWindowBuilder};

    if std::env::var("MYCO_NOTCH_PROBE").as_deref() != Ok("1") {
        return;
    }
    let geometry = match imp::on_main(app, imp::read_geometry) {
        Ok(g) => g,
        Err(e) => {
            eprintln!("notch-probe: geometry read failed: {e}");
            return;
        }
    };
    eprintln!("notch-probe: geometry {geometry:?}");
    if let Ok(screens) = imp::on_main(app, imp::screens_summary) {
        eprintln!("notch-probe: screens {screens}");
    }

    // Overhang the notch on both sides so the screenshot shows the panel
    // drawing over the menu bar, not just filling the black cutout.
    let width = if geometry.has_notch {
        geometry.notch_w + 320.0
    } else {
        480.0
    };
    // Taller than the menu bar on purpose: the overhang below it is the only
    // part of a screenshot that can prove the panel is drawing, since a black
    // window flush inside the menu bar is indistinguishable from the menu bar.
    let height = geometry.notch_h.max(38.0) + 60.0;
    let built = WebviewWindowBuilder::new(
        app,
        "notch-probe",
        WebviewUrl::External("about:blank".parse().expect("static url")),
    )
    .decorations(false)
    .transparent(false)
    .shadow(false)
    .always_on_top(true)
    .resizable(false)
    .skip_taskbar(true)
    .visible(false)
    .inner_size(width, height)
    .position((geometry.screen_w - width) / 2.0, 0.0)
    .initialization_script(
        "const paint=()=>{if(!document.body){return setTimeout(paint,10);}\
         document.body.style.cssText='margin:0;height:100vh;background:#c0392b;\
         color:#fff;font:600 13px -apple-system;display:flex;\
         align-items:center;justify-content:center';\
         document.body.textContent='NOTCH PROBE';};paint();",
    )
    .build();
    let window = match built {
        Ok(w) => w,
        Err(e) => {
            eprintln!("notch-probe: window build failed: {e}");
            return;
        }
    };
    window.on_window_event(|event| {
        if let tauri::WindowEvent::DragDrop(e) = event {
            eprintln!("notch-probe: panel drag-drop {e:?}");
        }
    });
    // Control: the same listener on the ordinary main window, so a silent
    // panel can be told apart from drag-drop being broken in this build.
    if let Some(main) = app.get_webview_window("main") {
        main.on_window_event(|event| {
            if let tauri::WindowEvent::DragDrop(e) = event {
                eprintln!("notch-probe: MAIN drag-drop {e:?}");
            }
        });
    }
    if std::env::var("MYCO_NOTCH_NO_PROMOTE").as_deref() == Ok("1") {
        eprintln!("notch-probe: promotion skipped (MYCO_NOTCH_NO_PROMOTE=1)");
    } else {
        match imp::on_main(app, {
            let window = window.clone();
            move |mtm| imp::probe_promote(&window, mtm)
        }) {
            Ok(Ok(state)) => eprintln!("notch-probe: promoted — {state}"),
            Ok(Err(e)) | Err(e) => eprintln!("notch-probe: promote failed: {e}"),
        }
    }
    let _ = window.show();
    let _ = imp::on_main(app, {
        let window = window.clone();
        move |mtm| {
            if let Err(e) = imp::pin_to_top(&window, mtm) {
                eprintln!("notch-probe: pin failed: {e}");
            }
            eprintln!("notch-probe: onscreen — {}", imp::describe(&window, mtm));
        }
    });
}

#[cfg(not(all(target_os = "macos", feature = "notch-probe")))]
pub fn spawn_probe(_app: &AppHandle) {}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::{
        apply_notch_preference, collapsed_rect, compute, frame_x, shown_fit, HoverGate,
        NotchGeometry, ScreenRect, CURSOR_GAP_MS, HOVER_POLL_MS,
    };
    use std::cell::RefCell;

    // devMock's 14" MacBook Pro shape: a 1512pt screen whose 204×37 cutout
    // spans x 654..858 at the top edge (y 945..982, AppKit is bottom-up).
    const SCREEN: ScreenRect = ScreenRect {
        x: 0.0,
        y: 0.0,
        w: 1512.0,
        h: 982.0,
    };
    const NOTCH: NotchGeometry = NotchGeometry {
        has_notch: true,
        notch_w: 204.0,
        notch_h: 37.0,
        screen_w: 1512.0,
    };

    #[test]
    fn initial_and_reshown_windows_do_not_reserve_a_menu_bar_attachment() {
        assert_eq!(shown_fit(NOTCH), (204.0, 51.0));
        assert_eq!(shown_fit(NOTCH), (204.0, 51.0));
        let none = NotchGeometry {
            has_notch: false,
            ..NotchGeometry::default()
        };
        assert_eq!(shown_fit(none), (172.0, 26.0));
    }

    #[test]
    fn collapsed_and_open_windows_stay_centred_on_the_notch() {
        assert_eq!(frame_x(SCREEN, 314.0), 599.0);
        assert_eq!(frame_x(SCREEN, 204.0), 654.0);
        assert_eq!(frame_x(SCREEN, 172.0), 670.0);
    }

    #[test]
    fn placement_follows_the_screen_the_notch_is_on() {
        let left = ScreenRect {
            x: -1512.0,
            ..SCREEN
        };
        assert_eq!(frame_x(left, 204.0), -1512.0 + 654.0);
    }

    #[test]
    fn only_the_cutout_opens_the_panel_without_covering_adjacent_menus() {
        let r = collapsed_rect(SCREEN, NOTCH);
        assert!(!r.contains(653.0, 982.0 - 10.0, 0.0));
        assert!(r.contains(654.0, 982.0 - 10.0, 0.0));
        assert!(r.contains(858.0, 982.0 - 37.0, 0.0));
        assert!(!r.contains(859.0, 982.0 - 10.0, 0.0));
        assert!(!r.contains(858.0, 982.0 - 38.0, 0.0));
    }

    #[test]
    fn hover_enters_on_the_first_hit_and_leaves_after_three_8hz_misses() {
        // Today's debounce, unchanged by the faster sampling while hovered.
        let mut g = HoverGate::default();
        assert_eq!(g.sample(0, true, None).hover, Some(true));
        assert_eq!(g.sample(125, false, None).hover, None);
        assert_eq!(g.sample(250, false, None).hover, None);
        // A hit in between resets the count.
        assert_eq!(g.sample(375, true, None).hover, None);
        assert_eq!(g.sample(500, false, None).hover, None);
        assert_eq!(g.sample(625, false, None).hover, None);
        assert_eq!(g.sample(750, false, None).hover, Some(false));
        assert_eq!(g.sample(875, false, None).hover, None);
    }

    #[test]
    fn leaving_takes_the_same_time_at_the_hovered_rate() {
        let mut g = HoverGate::default();
        g.sample(0, true, None);
        let mut t = 0;
        let left = loop {
            t += CURSOR_GAP_MS;
            if g.sample(t, false, None).hover == Some(false) {
                break t;
            }
        };
        // First miss at 34 ms; three 8 Hz misses span 250 ms after it.
        assert!(
            (250 + CURSOR_GAP_MS..250 + 2 * CURSOR_GAP_MS).contains(&left),
            "{left}"
        );
    }

    #[test]
    fn the_cursor_is_never_sent_unless_hovered() {
        let mut g = HoverGate::default();
        for t in (0..1000).step_by(125) {
            let p = (t as f64, 3.0);
            assert_eq!(g.sample(t, false, Some(p)).cursor, None);
        }
        // Hidden is the other half: nothing at all, and the hover state resets.
        g.sample(1000, true, Some((1.0, 1.0)));
        g.hidden();
        assert!(!g.inside);
        assert_eq!(g.poll_ms(), HOVER_POLL_MS);
    }

    #[test]
    fn the_cursor_feed_stays_at_or_under_30_hz() {
        let mut g = HoverGate::default();
        let mut sent = 0;
        for t in (0..1000).step_by(5) {
            if g.sample(t, true, Some((t as f64, 0.0))).cursor.is_some() {
                sent += 1;
            }
        }
        assert!((25..=30).contains(&sent), "{sent}");
    }

    #[test]
    fn a_still_cursor_sends_once_and_the_last_move_is_not_lost() {
        let mut g = HoverGate::default();
        assert_eq!(g.sample(0, true, Some((5.0, 5.0))).cursor, Some((5.0, 5.0)));
        assert_eq!(g.sample(20, true, Some((5.0, 5.0))).cursor, None);
        // Moved inside the gap: held back, then sent by the next sample even
        // though the pointer has stopped there.
        assert_eq!(g.sample(25, true, Some((9.0, 5.0))).cursor, None);
        assert_eq!(
            g.sample(40, true, Some((9.0, 5.0))).cursor,
            Some((9.0, 5.0))
        );
        assert_eq!(g.sample(80, true, Some((9.0, 5.0))).cursor, None);
    }

    #[test]
    fn re_entry_sends_the_cursor_at_once_and_polls_fast_only_while_hovered() {
        let mut g = HoverGate::default();
        assert_eq!(g.poll_ms(), HOVER_POLL_MS);
        let first = g.sample(0, true, Some((5.0, 5.0)));
        assert_eq!(first.hover, Some(true));
        assert_eq!(first.cursor, Some((5.0, 5.0)));
        assert_eq!(g.poll_ms(), CURSOR_GAP_MS);
        g.hidden();
        // Same spot, right away: a fresh hover always tells the eyes where to look.
        let again = g.sample(10, true, Some((5.0, 5.0)));
        assert_eq!(again.hover, Some(true));
        assert_eq!(again.cursor, Some((5.0, 5.0)));
    }

    #[test]
    fn visibility_is_applied_before_saving_in_both_directions() {
        for enabled in [false, true] {
            let calls = RefCell::new(Vec::new());
            apply_notch_preference(
                !enabled,
                enabled,
                |visible| {
                    calls.borrow_mut().push(format!("visible:{visible}"));
                    Ok(())
                },
                || {
                    calls.borrow_mut().push("save".into());
                    Ok(())
                },
            )
            .unwrap();
            assert_eq!(
                *calls.borrow(),
                [format!("visible:{enabled}"), "save".into()]
            );
        }
    }

    #[test]
    fn save_failure_restores_previous_visibility_in_both_directions() {
        for enabled in [false, true] {
            let mut visibility = Vec::new();
            let result = apply_notch_preference(
                !enabled,
                enabled,
                |visible| {
                    visibility.push(visible);
                    Ok(())
                },
                || Err("synthetic write failure".into()),
            );
            assert_eq!(visibility, [enabled, !enabled]);
            assert_eq!(result, Err("synthetic write failure".into()));
        }
    }

    #[test]
    fn visibility_failure_does_not_persist_and_restores_the_previous_state() {
        let mut visibility = Vec::new();
        let result = apply_notch_preference(
            true,
            false,
            |visible| {
                visibility.push(visible);
                if visible {
                    Ok(())
                } else {
                    Err("synthetic hide failure".into())
                }
            },
            || panic!("failed visibility must not be saved"),
        );
        assert_eq!(visibility, [false, true]);
        assert_eq!(result, Err("synthetic hide failure".into()));
    }

    #[test]
    fn rollback_failure_is_reported_with_the_original_failure() {
        let result = apply_notch_preference(
            true,
            false,
            |visible| {
                if visible {
                    Err("synthetic show failure".into())
                } else {
                    Ok(())
                }
            },
            || Err("synthetic write failure".into()),
        );
        assert_eq!(
            result,
            Err("synthetic write failure; restore notch visibility: synthetic show failure".into())
        );
    }

    #[test]
    fn notch_width_is_the_gap_between_the_menu_bar_areas() {
        // 14" MacBook Pro shape: 1512pt wide, 74pt/1234pt aux areas.
        let g = compute(1512.0, 74.0, 1234.0, 37.0);
        assert!(g.has_notch);
        assert_eq!(g.notch_w, 204.0);
        assert_eq!(g.notch_h, 37.0);
    }

    #[test]
    fn no_top_inset_means_no_notch() {
        let g = compute(1920.0, 0.0, 0.0, 0.0);
        assert!(!g.has_notch);
        assert_eq!(g.notch_w, 0.0);
        assert_eq!(g.screen_w, 1920.0);
    }

    #[test]
    fn top_inset_without_aux_areas_is_not_a_notch() {
        // Guard against reporting a full-screen-wide "notch" when the
        // auxiliary areas come back empty.
        let g = compute(1920.0, 0.0, 0.0, 37.0);
        assert!(!g.has_notch);
        assert_eq!(g.notch_w, 0.0);
    }
}
