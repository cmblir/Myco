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

#[cfg(target_os = "macos")]
mod imp {
    use super::{compute, NotchGeometry};
    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSScreen;
    use tauri::AppHandle;

    // Everything the window-promotion probe needs, and nothing the geometry
    // read does — so it follows the probe behind the feature.
    #[cfg(feature = "notch-probe")]
    use objc2::runtime::AnyObject;
    #[cfg(feature = "notch-probe")]
    use objc2::ClassType;
    #[cfg(feature = "notch-probe")]
    use objc2_app_kit::{NSPanel, NSView, NSWindow, NSWindowCollectionBehavior, NSWindowStyleMask};

    /// NSStatusWindowLevel. The menu bar is NSMainMenuWindowLevel (24), so 25
    /// is the lowest level that covers it.
    // Probe-only (see `spawn_probe`): compiled out of a normal build.
    #[cfg(feature = "notch-probe")]
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
    fn notch_screen(mtm: MainThreadMarker) -> Option<Retained<NSScreen>> {
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
    /// Returns the resulting AppKit state — the flags are set behind Tauri's
    /// back, so a caller that cannot see them has no way to tell it worked.
    // Probe-only (see `spawn_probe`): compiled out of a normal build.
    #[cfg(feature = "notch-probe")]
    pub fn promote(window: &tauri::WebviewWindow, mtm: MainThreadMarker) -> Result<String, String> {
        let ptr = window.ns_window().map_err(|e| e.to_string())?;
        if ptr.is_null() {
            return Err("ns_window returned null".into());
        }
        // Safe: Tauri hands out the live NSWindow for this window, and we are
        // on the main thread (MainThreadMarker).
        let ns_window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        let obj: &AnyObject = unsafe { &*(ptr as *const AnyObject) };
        unsafe { AnyObject::set_class(obj, NSPanel::class()) };
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
        let _ = mtm;
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
            move |mtm| imp::promote(&window, mtm)
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
    use super::compute;

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
