//! The per-vault state directory: `<vault>/.myco/`.
//!
//! Holds `schedules.json`, the import `ledger.json`, and per-schedule digest
//! logs. Unlike the app-data directory this lives INSIDE
//! the user's own vault, so a botched move is something they see immediately —
//! and if the vault is a git repo, in their diff.
//!
//! Ownership mirrors M1: the desktop app is the only thing allowed to MOVE it.
//! `automation/digest.py` runs from a checkout that a `git pull` can update
//! ahead of the installed app, so it only ever READS whichever directory is
//! there.

use std::path::{Path, PathBuf};

pub const DIR_NAME: &str = ".myco";

/// What installs from before the myco rename wrote. Read-only, and still
/// recognised: a vault opened by an old build after this one has run keeps
/// working, it just writes into the legacy directory again.
pub const LEGACY_DIR_NAME: &str = ".memex";

pub fn dir(vault_root: &Path) -> PathBuf {
    vault_root.join(DIR_NAME)
}

/// Move `<vault>/.memex/` to `<vault>/.myco/`, once, when a vault is opened.
///
/// Refuses to do anything clever:
/// - no legacy directory → nothing to do,
/// - the new directory already exists → skip, and leave the legacy one alone
///   rather than merging two states or overwriting the newer one,
/// - otherwise a single `rename`, which is atomic within a filesystem.
///
/// Returns `Ok(true)` when a move happened. Errors are for the caller to log:
/// failing to migrate must never stop the user opening their vault.
pub fn migrate(vault_root: &Path) -> Result<bool, String> {
    let legacy = vault_root.join(LEGACY_DIR_NAME);
    if !legacy.is_dir() {
        return Ok(false);
    }
    let current = dir(vault_root);
    if current.exists() {
        return Ok(false);
    }
    std::fs::rename(&legacy, &current)
        .map_err(|e| format!("move {LEGACY_DIR_NAME} to {DIR_NAME}: {e}"))?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("myco-vaultdir-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn moves_the_legacy_directory_with_its_contents() {
        let root = vault("move");
        std::fs::create_dir_all(root.join(".memex")).unwrap();
        std::fs::write(root.join(".memex/schedules.json"), "[]").unwrap();

        assert!(migrate(&root).unwrap());
        assert_eq!(
            std::fs::read_to_string(root.join(".myco/schedules.json")).unwrap(),
            "[]"
        );
        assert!(!root.join(".memex").exists());

        // Second open is a no-op.
        assert!(!migrate(&root).unwrap());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn never_overwrites_an_existing_new_directory() {
        let root = vault("both");
        std::fs::create_dir_all(root.join(".memex")).unwrap();
        std::fs::write(root.join(".memex/schedules.json"), "OLD").unwrap();
        std::fs::create_dir_all(root.join(".myco")).unwrap();
        std::fs::write(root.join(".myco/schedules.json"), "NEW").unwrap();

        assert!(!migrate(&root).unwrap());
        assert_eq!(
            std::fs::read_to_string(root.join(".myco/schedules.json")).unwrap(),
            "NEW"
        );
        assert!(
            root.join(".memex").exists(),
            "the old state is left, not deleted"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_vault_that_never_had_one_is_untouched() {
        let root = vault("none");
        assert!(!migrate(&root).unwrap());
        assert!(
            !root.join(".myco").exists(),
            "an empty dir must not be created"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
