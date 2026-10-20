//! Closed completion metadata retains acknowledgement identity without note contents.

use super::super::{hash, is_hex, Journal, Scope, VaultIdentity};
use crate::vault_session::AgentVaultSession;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct CompletionReceipt {
    pub(super) version: u32,
    pub(super) canonical_vault: String,
    pub(super) vault_identity: VaultIdentity,
    pub(super) relative_path: String,
    pub(super) revision: String,
    pub(super) journal_sha256: String,
    pub(super) baseline_sha256: String,
    pub(super) draft_sha256: String,
    pub(super) origin_sha256: String,
}

fn origin_sha256(origin: &AgentVaultSession) -> String {
    // The opening token is opaque. Hash its exact value with its vault path.
    hash(
        serde_json::json!([&origin.vault_path, &origin.opening_token])
            .to_string()
            .as_bytes(),
    )
}

pub(super) fn scope(root: &str, object: &VaultIdentity, relative: &str) -> Result<Scope, String> {
    let relative_path = Path::new(relative);
    if !Path::new(root).is_absolute()
        || relative_path.as_os_str().is_empty()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("recovery completion path is invalid".into());
    }
    Ok(Scope {
        root: root.to_owned(),
        object: object.clone(),
        relative: relative.to_owned(),
        path: Path::new(root)
            .join(relative_path)
            .to_str()
            .ok_or("recovery completion path is not UTF-8")?
            .to_owned(),
    })
}

impl CompletionReceipt {
    pub(super) fn from_original(journal: &Journal, exact_digest: &str) -> Result<Self, String> {
        let receipt = Self {
            version: 2,
            canonical_vault: journal.canonical_vault.clone(),
            vault_identity: journal.vault_identity.clone(),
            relative_path: journal.relative_path.clone(),
            revision: journal.recovery.revision.clone(),
            journal_sha256: exact_digest.to_owned(),
            baseline_sha256: journal.recovery.baseline_revision.clone(),
            draft_sha256: journal.draft_sha256.clone(),
            origin_sha256: origin_sha256(&journal.recovery.origin),
        };
        receipt.validate(&receipt.scope()?)?;
        Ok(receipt)
    }

    pub(super) fn scope(&self) -> Result<Scope, String> {
        scope(
            &self.canonical_vault,
            &self.vault_identity,
            &self.relative_path,
        )
    }

    pub(super) fn validate(&self, expected: &Scope) -> Result<(), String> {
        if self.version != 2
            || self.canonical_vault != expected.root
            || self.vault_identity != expected.object
            || self.relative_path != expected.relative
            || !is_hex(&self.origin_sha256, 64)
            || !is_hex(&self.revision, 32)
            || !is_hex(&self.journal_sha256, 64)
            || !is_hex(&self.baseline_sha256, 64)
            || !is_hex(&self.draft_sha256, 64)
        {
            return Err("recovery completion identity, version or hashes are invalid".into());
        }
        self.scope()?;
        Ok(())
    }

    pub(super) fn matches_original(&self, journal: &Journal, exact_digest: &str) -> bool {
        self.canonical_vault == journal.canonical_vault
            && self.vault_identity == journal.vault_identity
            && self.relative_path == journal.relative_path
            && self.revision == journal.recovery.revision
            && self.journal_sha256 == exact_digest
            && self.baseline_sha256 == journal.recovery.baseline_revision
            && self.draft_sha256 == journal.draft_sha256
            && self.origin_sha256 == origin_sha256(&journal.recovery.origin)
    }
}
