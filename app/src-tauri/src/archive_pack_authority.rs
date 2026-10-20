//! Opening-bound admission and short mutation dispatch for archive compaction.

use crate::vault_session::{AgentVaultSession, VaultRoot};
use std::path::{Path, PathBuf};

#[cfg(test)]
#[path = "archive_pack_authority_tests.rs"]
mod tests;

pub(super) struct ArchiveOperation<'a> {
    pub(super) root: PathBuf,
    opening: Option<(&'a VaultRoot, &'a AgentVaultSession)>,
}

impl<'a> ArchiveOperation<'a> {
    fn admitted(
        state: &'a VaultRoot,
        origin: &'a AgentVaultSession,
        vault: &str,
    ) -> Result<Self, String> {
        let root = state.with_origin(origin, |active_root| {
            let requested = Path::new(vault)
                .canonicalize()
                .map_err(|error| format!("canonicalize archive root: {error}"))?;
            if requested != active_root {
                return Err("archive requires the exact open vault root".into());
            }
            Ok(active_root.to_path_buf())
        })?;
        Ok(Self {
            root,
            opening: Some((state, origin)),
        })
    }

    // Legacy filesystem controls cannot create an unbound production operation.
    #[cfg(test)]
    pub(super) fn detached(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            opening: None,
        }
    }

    fn check(&self) -> Result<(), String> {
        match self.opening {
            Some((state, origin)) => state.with_origin(origin, |root| {
                if root != self.root {
                    return Err("archive operation root changed".into());
                }
                Ok(())
            }),
            None => Ok(()),
        }
    }

    pub(super) fn mutate<T>(
        &self,
        operation: impl FnOnce(&Path, &std::sync::MutexGuard<'_, ()>) -> Result<T, String>,
    ) -> Result<T, String> {
        let dispatch = |active_root: &Path| {
            if active_root != self.root {
                return Err("archive operation root changed".into());
            }
            crate::vault::with_root_mutation(active_root, operation)
        };
        match self.opening {
            Some((state, origin)) => state.with_origin(origin, dispatch),
            None => dispatch(&self.root),
        }
    }
}

pub(crate) fn usage_for_origin(
    state: &VaultRoot,
    origin: &AgentVaultSession,
    vault: &str,
) -> Result<Vec<super::BucketUsage>, String> {
    let operation = ArchiveOperation::admitted(state, origin, vault)?;
    let usage = super::usage(&operation.root);
    operation.check()?;
    Ok(usage)
}

pub(crate) fn compress_for_origin(
    state: &VaultRoot,
    origin: &AgentVaultSession,
    vault: &str,
    older_than_months: u32,
    now: i64,
) -> Result<super::PackReport, String> {
    let operation = ArchiveOperation::admitted(state, origin, vault)?;
    let report = super::compress_impl(&operation, older_than_months, now);
    operation.check().map_err(|error| {
        format!(
            "{error}; archive work stopped with available copies retained: {}",
            report.failed.join("; ")
        )
    })?;
    Ok(report)
}

pub(crate) fn restore_for_origin(
    state: &VaultRoot,
    origin: &AgentVaultSession,
    vault: &str,
    tree: &str,
    bucket: &str,
) -> Result<super::RestoreReport, String> {
    let operation = ArchiveOperation::admitted(state, origin, vault)?;
    let report = super::restore_impl(&operation, tree, bucket)?;
    operation.check()?;
    Ok(report)
}
