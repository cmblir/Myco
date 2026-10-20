//! Absence-CAS publication of the exact private native draft and target.

use super::{AudioOverviewRegistry, DraftContext, Publication, PublicationState};
use crate::vault_session::VaultRoot;
use std::path::Path;

fn target(root: &Path, relative: &str) -> Result<std::path::PathBuf, String> {
    let directory = crate::vault::confine_delete_path(root, &root.join("audio").to_string_lossy())?;
    match std::fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => return Err("audio publication directory is not a real directory".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(&directory)
                .map_err(|error| format!("create audio publication directory: {error}"))?;
        }
        Err(error) => return Err(format!("inspect audio publication directory: {error}")),
    }
    let target = crate::vault::confine_delete_path(root, &root.join(relative).to_string_lossy())?;
    if target.parent() != Some(directory.as_path()) {
        return Err("invalid private audio target".into());
    }
    Ok(target)
}

pub(crate) fn publish(
    state: &VaultRoot,
    registry: &AudioOverviewRegistry,
    context: &DraftContext,
) -> Result<Publication, String> {
    publish_impl(state, registry, context, || {}, |_, _| Ok(None))
}

#[cfg(test)]
pub(crate) fn publish_with(
    state: &VaultRoot,
    registry: &AudioOverviewRegistry,
    context: &DraftContext,
    before_writer: impl FnOnce(),
    after_persist: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<Publication, String> {
    publish_impl(state, registry, context, before_writer, |writer, target| {
        crate::vault::write_file_if_unchanged_recorded_locked_impl(
            writer,
            &target.0.to_string_lossy(),
            target.1,
            None,
            after_persist,
        )
        .map(Some)
    })
}

type StoredReceipt = crate::vault::RecordedWriteReceipt;

fn publish_impl(
    state: &VaultRoot,
    registry: &AudioOverviewRegistry,
    context: &DraftContext,
    before_writer: impl FnOnce(),
    write_override: impl FnOnce(
        &std::sync::MutexGuard<'_, ()>,
        (&Path, &str),
    ) -> Result<Option<StoredReceipt>, String>,
) -> Result<Publication, String> {
    let (publication, index_root, index_relative) =
        super::with_job(state, registry, &context.job(), |root, job| {
            let mut lifecycle = job
                .lifecycle
                .lock()
                .map_err(|_| "audio lifecycle lock poisoned")?;
            let stored = lifecycle
                .draft
                .as_ref()
                .ok_or("audio publication requires its private native draft")?
                .clone();
            if stored.draft.context.draft_id != context.draft_id {
                return Err("audio draft differs from its native issued authority".into());
            }
            if let Some(publication) = &lifecycle.publication {
                if publication.state == PublicationState::Persisted {
                    crate::vault::with_root_mutation(root, |root, _writer| {
                        job.sources.verify(root)?;
                        let receipt = lifecycle
                            .receipt
                            .as_ref()
                            .ok_or("audio persisted publication lost its private receipt")?;
                        let target = crate::vault::confine_delete_path(
                            root,
                            &root.join(&job.target_rel).to_string_lossy(),
                        )?;
                        if receipt.path != target {
                            return Err("audio private publication target changed".into());
                        }
                        crate::vault::verify_recorded_file_unlocked(receipt)
                    })?;
                }
                return Ok((
                    publication.clone(),
                    root.to_path_buf(),
                    job.target_rel.clone(),
                ));
            }
            // Opening -> foreground Audio role -> private registry/lifecycle ->
            // common writer. The hook is immediately before waiting for writer.
            before_writer();
            crate::vault::with_root_mutation(root, |root, writer| {
                job.sources.verify(root)?;
                let target = target(root, &job.target_rel)?;
                let written = match write_override(writer, (&target, &stored.markdown)) {
                    Ok(Some(receipt)) => Ok(receipt),
                    Ok(None) => crate::vault::write_file_if_unchanged_recorded_locked(
                        writer,
                        &target.to_string_lossy(),
                        &stored.markdown,
                        None,
                    ),
                    Err(error) => Err(error),
                };
                let (receipt, error) = match written {
                    Ok(receipt) => {
                        let checked = job
                            .sources
                            .verify(root)
                            .and_then(|()| crate::vault::verify_recorded_file_unlocked(&receipt));
                        (Some(receipt), checked.err())
                    }
                    Err(error) if error.starts_with("write persisted but ") => (None, Some(error)),
                    Err(error) => return Err(error),
                };
                let publication = Publication {
                    job_id: context.job_id.clone(),
                    draft_id: context.draft_id.clone(),
                    origin: context.origin.clone(),
                    path: target.to_string_lossy().into_owned(),
                    revision: receipt.as_ref().map(|receipt| receipt.revision.clone()),
                    state: if error.is_some() {
                        PublicationState::Partial
                    } else {
                        PublicationState::Persisted
                    },
                    error,
                };
                // A post-persist failure is sticky: retain the private draft and
                // never silently issue a generic overwrite or a second create.
                lifecycle.receipt = receipt;
                lifecycle.publication = Some(publication.clone());
                Ok((publication, root.to_path_buf(), job.target_rel.clone()))
            })
        })?;
    if let Some(updater) = crate::INDEX_UPDATER.get() {
        updater.mark_dirty(&index_root, index_relative);
    }
    Ok(publication)
}
