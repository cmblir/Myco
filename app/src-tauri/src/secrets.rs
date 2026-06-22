// OS-keychain backed secret storage. We never write provider API keys to
// disk in plaintext; they live in the user's keychain under a
// Memex-specific service name and are looked up by provider id.

use keyring::Entry;

const SERVICE: &str = "dev.cmblir.memex";

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
