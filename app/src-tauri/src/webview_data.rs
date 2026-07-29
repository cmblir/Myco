//! M8: move the webview's per-identifier data container across the bundle
//! identifier rename (`dev.cmblir.memex` -> `dev.cmblir.myco`).
//!
//! Why this exists at all. `app/src/lib/storageMigration.ts` renames the
//! persisted `memex.*` localStorage keys to `myco.*`, and on its own that is
//! useless on macOS: WKWebView stores localStorage under
//! `~/Library/WebKit/<bundle identifier>/`, so flipping the identifier points
//! the app at a brand-new, EMPTY container. The key-rename then finds nothing,
//! onboarding re-appears, the last vault is forgotten and saved graph looks are
//! gone — exactly what it was written to prevent.
//!
//! So the two halves have to run in order: this moves the container, and the
//! frontend then renames the keys inside it.
//!
//! TIMING: this must run before the webview is created, i.e. before
//! `tauri::Builder::run`, because WebKit creates the directory eagerly on
//! startup and an existing (empty) destination makes the move skip forever.
//! `.setup()` is already too late — windows declared in tauri.conf.json are
//! built before it runs.
//!
//! Windows and Linux need nothing here: WebView2's user-data folder and the
//! WebKitGTK data dir both live under the app-data directory that `settings.rs`
//! already migrates.

#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
const LEGACY_IDENTIFIER: &str = "dev.cmblir.memex";
#[cfg(target_os = "macos")]
const IDENTIFIER: &str = "dev.cmblir.myco";

/// Move the webview container from the pre-rename identifier to the current
/// one. Best effort — every failure is a warning line for the caller to log,
/// never an error that blocks startup. Losing the move costs the user their
/// onboarding flag and graph looks; refusing to launch costs them the app.
#[cfg(target_os = "macos")]
pub fn migrate_legacy_container() -> Vec<String> {
    let Some(home) = std::env::var_os("HOME") else {
        return vec!["no HOME; skipped webview container migration".to_string()];
    };
    let webkit = PathBuf::from(home).join("Library").join("WebKit");
    migrate_container_in(&webkit)
}

#[cfg(not(target_os = "macos"))]
pub fn migrate_legacy_container() -> Vec<String> {
    Vec::new()
}

/// The move itself, against a parent directory, so it is testable without
/// touching `~/Library`.
///
/// Deliberately refuses to be clever, matching `settings.rs::migrate_data_dir`:
/// - no legacy container: nothing to do;
/// - destination already exists AND holds data: already migrated, leave both;
/// - destination exists but is EMPTY: WebKit created it eagerly before us, so
///   remove that empty shell and let the move proceed. Without this the very
///   first launch under the new identifier would latch "already migrated"
///   permanently and strand the real data;
/// - a failed rename leaves the legacy container untouched.
#[cfg(target_os = "macos")]
pub fn migrate_container_in(webkit_dir: &Path) -> Vec<String> {
    let legacy = webkit_dir.join(LEGACY_IDENTIFIER);
    if !legacy.is_dir() {
        return Vec::new();
    }
    let current = webkit_dir.join(IDENTIFIER);
    if current.exists() {
        match is_empty_dir(&current) {
            Some(true) => {
                if let Err(e) = std::fs::remove_dir_all(&current) {
                    return vec![format!(
                        "webview container: empty {IDENTIFIER} could not be cleared, \
                         keeping the old one: {e}"
                    )];
                }
            }
            // Real data under the new identifier: a previous launch already
            // migrated (or the user started fresh). Never overwrite it.
            Some(false) => return Vec::new(),
            None => {
                return vec![
                    "webview container: cannot inspect the destination; skipped".to_string(),
                ]
            }
        }
    }
    match std::fs::rename(&legacy, &current) {
        Ok(()) => Vec::new(),
        Err(e) => vec![format!(
            "webview container: {LEGACY_IDENTIFIER} -> {IDENTIFIER} failed ({e}); \
             onboarding and saved graph looks will start empty"
        )],
    }
}

/// `Some(true)` if the directory has no entries, `None` if it cannot be read.
#[cfg(target_os = "macos")]
fn is_empty_dir(path: &Path) -> Option<bool> {
    Some(std::fs::read_dir(path).ok()?.next().is_none())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    fn webkit(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("myco-m8-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn seed(dir: &Path, identifier: &str, marker: &str) {
        let store = dir.join(identifier).join("WebsiteData/LocalStorage");
        std::fs::create_dir_all(&store).unwrap();
        std::fs::write(store.join("localstorage.sqlite3"), marker).unwrap();
    }

    fn stored(dir: &Path, identifier: &str) -> Option<String> {
        std::fs::read_to_string(
            dir.join(identifier)
                .join("WebsiteData/LocalStorage/localstorage.sqlite3"),
        )
        .ok()
    }

    #[test]
    fn moves_the_legacy_container() {
        let d = webkit("move");
        seed(&d, LEGACY_IDENTIFIER, "OLD");

        assert!(migrate_container_in(&d).is_empty());
        assert_eq!(stored(&d, IDENTIFIER).as_deref(), Some("OLD"));
        assert!(!d.join(LEGACY_IDENTIFIER).exists());

        // Second launch is a no-op.
        assert!(migrate_container_in(&d).is_empty());
        assert_eq!(stored(&d, IDENTIFIER).as_deref(), Some("OLD"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn an_empty_destination_created_by_webkit_does_not_block_the_move() {
        // The case that made the whole migration a no-op in the first place:
        // WebKit creates ~/Library/WebKit/<id>/ eagerly at startup.
        let d = webkit("empty-dest");
        seed(&d, LEGACY_IDENTIFIER, "OLD");
        std::fs::create_dir_all(d.join(IDENTIFIER)).unwrap();

        assert!(migrate_container_in(&d).is_empty());
        assert_eq!(stored(&d, IDENTIFIER).as_deref(), Some("OLD"));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_destination_with_real_data_is_never_overwritten() {
        let d = webkit("both");
        seed(&d, LEGACY_IDENTIFIER, "OLD");
        seed(&d, IDENTIFIER, "NEW");

        assert!(migrate_container_in(&d).is_empty());
        assert_eq!(stored(&d, IDENTIFIER).as_deref(), Some("NEW"));
        assert!(
            d.join(LEGACY_IDENTIFIER).exists(),
            "the old container is left in place, not deleted"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn a_fresh_install_is_untouched() {
        let d = webkit("fresh");
        assert!(migrate_container_in(&d).is_empty());
        assert!(
            !d.join(IDENTIFIER).exists(),
            "must not create a container WebKit has not asked for"
        );
        let _ = std::fs::remove_dir_all(&d);
    }
}
