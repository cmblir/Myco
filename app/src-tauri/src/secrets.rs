// OS-keychain backed secret storage. We never write provider API keys to
// disk in plaintext; they live in the user's keychain under a
// myco-specific service name and are looked up by provider id.

use keyring::Entry;

const SERVICE: &str = "dev.cmblir.myco";

/// The service name used before the myco rename. Read-only: it exists solely so
/// `migrate_legacy_service()` can move entries an existing install already has.
const LEGACY_SERVICE: &str = "dev.cmblir.memex";

/// Every account name a key can be stored under. The keychain cannot be
/// enumerated by service through this crate, so the migration has to walk a
/// known list — anything missing here is a key the user silently loses.
///
/// The list is the provider id set (`app/src/lib/icons.tsx::ProviderId`, mirrored
/// by `app/src/lib/providers.ts::PROVIDERS`), which is what `set_provider_key` /
/// `delete_provider_key` are called with, plus `myco-pro` (commands.rs, the
/// myco Pro login). Providers that need no key today are included anyway: they
/// cost one absent-entry lookup and cover a key stored by an older build.
/// These are the CURRENT names; `legacy_account` below maps the one that was
/// renamed back to what an older build wrote.
pub const KNOWN_ACCOUNTS: &[&str] = &[
    "anthropic-cli",
    "gemini-cli",
    "codex-cli",
    "anthropic-api",
    "openai-api",
    "google-api",
    "ollama",
    "openrouter",
    "myco-pro",
    "builtin-local",
];

pub fn set_key(provider_id: &str, value: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE, provider_id).map_err(|e| e.to_string())?;
    entry.set_password(value).map_err(|e| e.to_string())
}

pub fn get_key(provider_id: &str) -> Result<Option<String>, String> {
    let entry = Entry::new(SERVICE, provider_id).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn delete_key(provider_id: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE, provider_id).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---- M2: keychain service rename (dev.cmblir.memex -> dev.cmblir.myco) ----
// ---- M5: keychain account rename (memex-pro -> myco-pro) ------------------

/// Accounts whose *name* changed with the rebrand. Everything else in
/// `KNOWN_ACCOUNTS` is a provider id that was never spelled "memex".
const RENAMED_ACCOUNTS: &[&str] = &[crate::settings::PRO_PROVIDER_ID];

const LEGACY_PRO_ACCOUNT: &str = "memex-pro";

/// The name an older build stored this account under.
fn legacy_account(account: &str) -> &str {
    if account == crate::settings::PRO_PROVIDER_ID {
        LEGACY_PRO_ACCOUNT
    } else {
        account
    }
}

fn read(service: &str, account: &str) -> Result<Option<String>, String> {
    let entry = Entry::new(service, account).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Move each known account from the old service to the new one.
///
/// The order per account is deliberate and must not be relaxed: read the old
/// entry, write it under the new service, **read it back and compare**, and only
/// then delete the old entry. If anything fails — including a read-back that
/// does not match — the old entry is LEFT IN PLACE. A stale duplicate in the
/// keychain is harmless; a deleted entry whose copy never landed is an API key
/// the user has to find again.
///
/// An account that already has a value under the new service is skipped without
/// touching either side, which is what makes a second launch a no-op.
///
/// Returns one warning line per account that could not be fully migrated (the
/// caller logs them; a keychain that is locked or unavailable must not block
/// startup).
fn migrate_accounts(
    accounts: &[&str],
    read_old: &mut dyn FnMut(&str) -> Result<Option<String>, String>,
    read_new: &mut dyn FnMut(&str) -> Result<Option<String>, String>,
    write_new: &mut dyn FnMut(&str, &str) -> Result<(), String>,
    delete_old: &mut dyn FnMut(&str) -> Result<(), String>,
) -> Vec<String> {
    let mut warnings = Vec::new();
    for account in accounts {
        let old_value = match read_old(account) {
            Ok(Some(v)) => v,
            Ok(None) => continue, // nothing stored under the old service
            Err(e) => {
                warnings.push(format!("{account}: read old entry failed: {e}"));
                continue;
            }
        };
        match read_new(account) {
            // Already migrated (or the user re-entered the key): never
            // overwrite the newer value, and leave the old entry alone.
            Ok(Some(_)) => continue,
            Ok(None) => {}
            Err(e) => {
                warnings.push(format!("{account}: read new entry failed: {e}"));
                continue;
            }
        }
        if let Err(e) = write_new(account, &old_value) {
            warnings.push(format!("{account}: write failed, old entry kept: {e}"));
            continue;
        }
        // Verified read-back: only a byte-identical copy justifies the delete.
        match read_new(account) {
            Ok(Some(v)) if v == old_value => {}
            Ok(_) => {
                warnings.push(format!(
                    "{account}: read-back mismatch, old entry kept (not deleted)"
                ));
                continue;
            }
            Err(e) => {
                warnings.push(format!(
                    "{account}: read-back failed, old entry kept (not deleted): {e}"
                ));
                continue;
            }
        }
        if let Err(e) = delete_old(account) {
            // The copy is verified, so the key is safe; the leftover is cosmetic.
            warnings.push(format!("{account}: old entry left behind: {e}"));
        }
    }
    warnings
}

/// Run the keychain service migration against the real keychain. Best effort:
/// every failure is reported as a warning line, never an error that blocks app
/// startup.
///
/// DEFERRED (I2): this runs unconditionally on EVERY launch and does
/// `KNOWN_ACCOUNTS.len()` keychain reads before the window appears. On a locked
/// keychain each of those can raise a system prompt or block, so startup can
/// stall long after the migration has nothing left to do. A later stage should
/// write a done-marker (next to settings.json) once a full pass completes with
/// no warnings, and skip the whole walk when it is present.
pub fn migrate_legacy_service() -> Vec<String> {
    let write = |service: &str, a: &str, v: &str| -> Result<(), String> {
        Entry::new(service, a)
            .map_err(|e| e.to_string())?
            .set_password(v)
            .map_err(|e| e.to_string())
    };
    let delete = |service: &str, a: &str| -> Result<(), String> {
        let entry = Entry::new(service, a).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    };

    // Hop 1 first, because its source is the NEWER of the two: it was written by
    // a build that had already migrated the service. `migrate_accounts` never
    // overwrites an existing new-side value, so whichever hop runs first wins —
    // and the newer value has to.
    let mut warnings = migrate_accounts(
        RENAMED_ACCOUNTS,
        &mut |a| read(SERVICE, legacy_account(a)),
        &mut |a| read(SERVICE, a),
        &mut |a, v| write(SERVICE, a, v),
        &mut |a| delete(SERVICE, legacy_account(a)),
    );
    // Hop 2: an install from before the rename, where both the service and the
    // account name are old. Reading under the legacy name and writing under the
    // current one takes it all the way in one launch.
    warnings.extend(migrate_accounts(
        KNOWN_ACCOUNTS,
        &mut |a| read(LEGACY_SERVICE, legacy_account(a)),
        &mut |a| read(SERVICE, a),
        &mut |a, v| write(SERVICE, a, v),
        &mut |a| delete(LEGACY_SERVICE, legacy_account(a)),
    ));
    warnings
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn service_name_is_renamed_and_legacy_kept_for_migration() {
        assert_eq!(SERVICE, "dev.cmblir.myco");
        assert_eq!(LEGACY_SERVICE, "dev.cmblir.memex");
        assert_ne!(SERVICE, LEGACY_SERVICE);
    }

    #[test]
    fn known_accounts_cover_every_provider_id_and_the_pro_account() {
        // Mirrors app/src/lib/icons.tsx::ProviderId. A provider added there
        // without being added here would have its key stranded under the old
        // service by the migration.
        let expected = [
            "anthropic-cli",
            "gemini-cli",
            "codex-cli",
            "anthropic-api",
            "openai-api",
            "google-api",
            "ollama",
            "openrouter",
            "myco-pro",
            "builtin-local",
        ];
        for id in expected {
            assert!(
                KNOWN_ACCOUNTS.contains(&id),
                "provider id {id} missing from KNOWN_ACCOUNTS"
            );
        }
        assert_eq!(KNOWN_ACCOUNTS.len(), expected.len());
        // The accounts every key-bearing provider uses today, spelled out so a
        // rename of one is caught here rather than in the field.
        for id in [
            "anthropic-api",
            "openai-api",
            "google-api",
            "openrouter",
            "myco-pro",
        ] {
            assert!(KNOWN_ACCOUNTS.contains(&id));
        }
    }

    #[test]
    fn only_the_pro_account_has_a_legacy_name() {
        assert_eq!(legacy_account("myco-pro"), "memex-pro");
        assert_eq!(RENAMED_ACCOUNTS, &["myco-pro"]);
        for account in KNOWN_ACCOUNTS {
            if *account == "myco-pro" {
                continue;
            }
            assert_eq!(
                legacy_account(account),
                *account,
                "{account} was never renamed; mapping it would strand its key"
            );
        }
    }

    #[test]
    fn the_pro_key_survives_both_hops_of_the_rename() {
        // Hop 2's shape: a pre-rename install, old service AND old account name.
        let old: HashMap<String, String> = [("memex-pro".to_string(), "lic-1".to_string())].into();
        let new = std::cell::RefCell::new(HashMap::<String, String>::new());
        let warnings = migrate_accounts(
            RENAMED_ACCOUNTS,
            &mut |a| Ok(old.get(legacy_account(a)).cloned()),
            &mut |a| Ok(new.borrow().get(a).cloned()),
            &mut |a, v| {
                new.borrow_mut().insert(a.to_string(), v.to_string());
                Ok(())
            },
            &mut |_| Ok(()),
        );
        assert!(warnings.is_empty(), "{warnings:?}");
        let new = new.into_inner();
        assert_eq!(
            new.get("myco-pro").map(String::as_str),
            Some("lic-1"),
            "the license key must land under the new account name"
        );
        assert!(!new.contains_key("memex-pro"));
    }

    /// In-memory keychain pair for the ordering tests.
    struct FakeStore {
        old: HashMap<String, String>,
        new: HashMap<String, String>,
        log: Vec<String>,
    }

    fn run(store: &mut FakeStore, accounts: &[&str], fail_write: Option<&str>) -> Vec<String> {
        use std::cell::RefCell;
        let old = RefCell::new(std::mem::take(&mut store.old));
        let new = RefCell::new(std::mem::take(&mut store.new));
        let log = RefCell::new(Vec::<String>::new());
        let warnings = migrate_accounts(
            accounts,
            &mut |a| {
                log.borrow_mut().push(format!("read_old {a}"));
                Ok(old.borrow().get(a).cloned())
            },
            &mut |a| Ok(new.borrow().get(a).cloned()),
            &mut |a, v| {
                if fail_write == Some(a) {
                    return Err("keychain locked".into());
                }
                log.borrow_mut().push(format!("write_new {a}"));
                new.borrow_mut().insert(a.to_string(), v.to_string());
                Ok(())
            },
            &mut |a| {
                log.borrow_mut().push(format!("delete_old {a}"));
                old.borrow_mut().remove(a);
                Ok(())
            },
        );
        store.old = old.into_inner();
        store.new = new.into_inner();
        store.log.extend(log.into_inner());
        warnings
    }

    fn store(pairs: &[(&str, &str)]) -> FakeStore {
        FakeStore {
            old: pairs
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            new: HashMap::new(),
            log: Vec::new(),
        }
    }

    #[test]
    fn migration_copies_verifies_then_deletes_and_is_idempotent() {
        let mut s = store(&[("openai-api", "sk-1"), ("myco-pro", "lic-2")]);
        let warnings = run(&mut s, &["openai-api", "myco-pro", "google-api"], None);
        assert!(warnings.is_empty(), "{warnings:?}");
        assert_eq!(s.new.get("openai-api").unwrap(), "sk-1");
        assert_eq!(s.new.get("myco-pro").unwrap(), "lic-2");
        assert!(
            s.old.is_empty(),
            "old entries must be gone after a verified copy"
        );
        // The write must precede the delete for every account.
        let w = s
            .log
            .iter()
            .position(|l| l == "write_new openai-api")
            .unwrap();
        let d = s
            .log
            .iter()
            .position(|l| l == "delete_old openai-api")
            .unwrap();
        assert!(w < d, "delete ran before the copy: {:?}", s.log);
        // An account with nothing stored is never written or deleted.
        assert!(!s
            .log
            .iter()
            .any(|l| l.ends_with("google-api") && !l.starts_with("read_old")));

        // Second run: nothing left under the old service, so it is a no-op.
        s.log.clear();
        let warnings = run(&mut s, &["openai-api", "myco-pro"], None);
        assert!(warnings.is_empty());
        assert!(!s.log.iter().any(|l| l.starts_with("write_new")));
        assert_eq!(s.new.get("openai-api").unwrap(), "sk-1");
    }

    #[test]
    fn failed_write_keeps_the_old_entry() {
        let mut s = store(&[("openrouter", "or-1")]);
        let warnings = run(&mut s, &["openrouter"], Some("openrouter"));
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("old entry kept"));
        assert_eq!(
            s.old.get("openrouter").unwrap(),
            "or-1",
            "a key must never be deleted when its copy did not land"
        );
        assert!(s.new.is_empty());
    }

    #[test]
    fn read_back_mismatch_keeps_the_old_entry() {
        // A store that "writes" but returns something else on read-back: the
        // half-moved case the delete must refuse to run for.
        let old: HashMap<String, String> =
            [("anthropic-api".to_string(), "sk-real".to_string())].into();
        let mut deleted: Vec<String> = Vec::new();
        let warnings = migrate_accounts(
            &["anthropic-api"],
            &mut |a| Ok(old.get(a).cloned()),
            &mut |_| Ok(None),
            &mut |_, _| Ok(()), // pretends to succeed; read_new still says None
            &mut |a| {
                deleted.push(a.to_string());
                Ok(())
            },
        );
        assert_eq!(warnings.len(), 1);
        assert!(warnings[0].contains("read-back"));
        assert!(
            deleted.is_empty(),
            "old entry deleted without a verified copy"
        );
    }

    #[test]
    fn existing_new_entry_is_never_overwritten() {
        let mut s = store(&[("google-api", "old-key")]);
        s.new.insert("google-api".into(), "new-key".into());
        let warnings = run(&mut s, &["google-api"], None);
        assert!(warnings.is_empty());
        assert_eq!(s.new.get("google-api").unwrap(), "new-key");
        assert_eq!(
            s.old.get("google-api").unwrap(),
            "old-key",
            "the old entry is left as-is rather than deleted on a skip"
        );
    }
}
