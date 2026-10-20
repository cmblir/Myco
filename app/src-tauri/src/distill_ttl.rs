//! Automatic quarantine expiry; proposal and historical trash paths are separate.

use super::*;
use std::io::Read;

#[cfg(test)]
type PreparedHook = Box<dyn Fn() -> Result<(), String>>;

#[cfg(test)]
thread_local! {
    static PREPARED_HOOK: std::cell::RefCell<Option<PreparedHook>> = const {
        std::cell::RefCell::new(None)
    };
    static COMMIT_HOOK: std::cell::RefCell<Option<CommitHook>> = const {
        std::cell::RefCell::new(None)
    };
}

#[cfg(test)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum CommitCheckpoint {
    ContentDeleted,
    BeforeManifest,
    BeforeTrashLink,
    TrashLinked,
    ContentTrashed,
    BeforeTrashManifest,
}

#[cfg(test)]
type CommitHook = Box<dyn Fn(CommitCheckpoint, &Path) -> Result<(), String>>;

#[cfg(test)]
fn commit_checkpoint(checkpoint: CommitCheckpoint, path: &Path) -> Result<(), String> {
    COMMIT_HOOK.with(|hook| {
        hook.borrow()
            .as_ref()
            .map_or(Ok(()), |hook| hook(checkpoint, path))
    })
}

fn observe_expired_pair(
    root: &Path,
    content: &Path,
    sidecar: &Path,
    observed_sidecar: &str,
    now: i64,
    conservative: bool,
) -> Result<[ObservedFile; 2], String> {
    let content = crate::vault::confine_delete_path(root, &content.to_string_lossy())?;
    let sidecar = crate::vault::confine_delete_path(root, &sidecar.to_string_lossy())?;
    let relative = rel_string(root, &content);
    if !is_quarantine_payload_path(&relative) || sidecar_path(&content) != sidecar {
        return Err("expiry pair is outside quarantine".into());
    }
    let verdict: serde_json::Value = serde_json::from_str(observed_sidecar)
        .map_err(|error| format!("parse expiry verdict: {error}"))?;
    let from = verdict.get("from").and_then(|value| value.as_str());
    let allowed_origin = from.is_some_and(|origin| {
        origin.starts_with("_inbox/")
            && is_restore_target(origin)
            && Path::new(origin)
                .extension()
                .and_then(|extension| extension.to_str())
                == Some("md")
            && Path::new(origin)
                .components()
                .all(|component| matches!(component, std::path::Component::Normal(_)))
    });
    if !allowed_origin || expiry_asks(conservative, from) {
        return Err("expiry origin requires owner review".into());
    }
    if verdict.get("tier").and_then(|value| value.as_str()) != Some("quarantine")
        || !verdict
            .get("expires")
            .and_then(|value| value.as_i64())
            .is_some_and(|expires| expires <= now)
    {
        return Err("verdict does not authorize expired quarantine cleanup".into());
    }
    let revision = verdict
        .get("source_sha256")
        .and_then(|value| value.as_str())
        .filter(|revision| admission::valid_digest(revision))
        .ok_or("expiry source revision is missing or malformed")?;
    Ok([
        ObservedFile::capture(content, revision)?,
        ObservedFile::capture(sidecar, &admission::sha256(observed_sidecar.as_bytes()))?,
    ])
}

pub(super) fn delete_expired(
    root: &Path,
    content: &Path,
    sidecar: &Path,
    observed_sidecar: &str,
    now: i64,
    conservative: bool,
    manifest: &mut RunManifest,
) -> Result<(), String> {
    let retained_error = |error| {
        format!(
            "automatic expiry refused; retained {} and {}: {error}",
            content.display(),
            sidecar.display()
        )
    };
    let observed =
        observe_expired_pair(root, content, sidecar, observed_sidecar, now, conservative)
            .map_err(retained_error)?;
    #[cfg(test)]
    PREPARED_HOOK.with(|hook| hook.borrow().as_ref().map_or(Ok(()), |hook| hook()))?;
    let (deleted, failure) = crate::role_authorization::with_deletion_policy(true, || {
        crate::vault::with_root_mutation(root, |canonical_root, guard| {
            // Admit the complete pair before the first unlink. Save_manifest is a
            // locking CAS writer and must run after this transaction releases it.
            for file in &observed {
                file.verify(canonical_root)?;
            }
            let mut deleted = Vec::new();
            let mut failure = None;
            for file in &observed {
                let result = file.verify(canonical_root).and_then(|()| {
                    crate::vault::remove_all_locked(guard, std::slice::from_ref(&file.path))
                });
                match result {
                    Ok(()) => {
                        deleted.push(rel_string(canonical_root, &file.path));
                        #[cfg(test)]
                        if deleted.len() == 1 {
                            if let Err(error) =
                                commit_checkpoint(CommitCheckpoint::ContentDeleted, sidecar)
                            {
                                failure = Some(error);
                                break;
                            }
                        }
                    }
                    Err(error) => {
                        failure = Some(error);
                        break;
                    }
                }
            }
            Ok((deleted, failure))
        })
    })
    .map_err(retained_error)?;
    if !deleted.is_empty() {
        manifest.deleted.extend(deleted.iter().cloned());
        #[cfg(test)]
        commit_checkpoint(
            CommitCheckpoint::BeforeManifest,
            &manifest_path(root, &manifest.id),
        )?;
        save_manifest(root, manifest).map_err(|error| format!(
            "expiry deleted {}; deletion manifest save failed: {error}; any remaining files require manual review",
            deleted.join(", ")
        ))?;
    }
    if let Some(error) = failure {
        return Err(format!(
            "expiry incomplete; deleted [{}]; remaining copies retained for review: {error}",
            deleted.join(", ")
        ));
    }
    Ok(())
}

pub(super) fn trash_expired(
    root: &Path,
    content: &Path,
    sidecar: &Path,
    observed_sidecar: &str,
    now: i64,
    conservative: bool,
    manifest: &mut RunManifest,
) -> Result<(), String> {
    let retained_error = |error| {
        format!(
            "automatic recoverable expiry refused; retained {} and {}: {error}",
            content.display(),
            sidecar.display()
        )
    };
    let observed =
        observe_expired_pair(root, content, sidecar, observed_sidecar, now, conservative)
            .map_err(retained_error)?;
    #[cfg(test)]
    PREPARED_HOOK.with(|hook| hook.borrow().as_ref().map_or(Ok(()), |hook| hook()))?;
    let (moved, failure) = crate::role_authorization::with_deletion_policy(false, || {
        crate::vault::with_root_mutation(root, |canonical_root, _guard| {
            for file in &observed {
                file.verify(canonical_root)?;
            }
            let trash = crate::vault::confine_delete_path(
                canonical_root,
                &dir(canonical_root)
                    .join("trash")
                    .join(&manifest.id)
                    .to_string_lossy(),
            )
            .map_err(|error| format!("inspect trash dir: {error}"))?;
            std::fs::create_dir_all(&trash)
                .map_err(|error| format!("create trash dir: {error}"))?;
            crate::vault::confine_delete_path(canonical_root, &trash.to_string_lossy())?;
            let mut moved = Vec::new();
            let mut failure = None;
            for file in &observed {
                let prepare_destination = || {
                    crate::vault::confine_delete_path(
                        canonical_root,
                        &free_path(
                            &trash.join(file.path.file_name().ok_or("expiry file has no name")?),
                        )
                        .to_string_lossy(),
                    )
                };
                let destination = match prepare_destination() {
                    Ok(destination) => destination,
                    Err(error) => {
                        failure = Some(error);
                        break;
                    }
                };
                let attempt = || {
                    #[cfg(test)]
                    commit_checkpoint(CommitCheckpoint::BeforeTrashLink, &destination)?;
                    file.verify(canonical_root)?;
                    // Creation fails atomically if this name became occupied.
                    // A failed intermediate check leaves both names for review.
                    std::fs::hard_link(&file.path, &destination)
                        .map_err(|error| format!("create non-overwriting trash link: {error}"))?;
                    #[cfg(test)]
                    commit_checkpoint(CommitCheckpoint::TrashLinked, &destination)?;
                    file.verify_link_names(canonical_root, &[&file.path, &destination], 2)?;
                    std::fs::remove_file(&file.path)
                        .map_err(|error| format!("remove trashed source name: {error}"))
                };
                if let Err(error) = attempt() {
                    failure = Some(format!(
                        "{} -> {}: {error}; any additional copy is retained for manual recovery",
                        file.path.display(),
                        destination.display()
                    ));
                    break;
                }
                // Record the actual unlink before any subsequent check can fail.
                moved.push(MoveEntry {
                    from: rel_string(canonical_root, &file.path),
                    to: rel_string(canonical_root, &destination),
                });
                let verification = || {
                    #[cfg(test)]
                    if moved.len() == 1 {
                        commit_checkpoint(CommitCheckpoint::ContentTrashed, sidecar)?;
                    }
                    file.verify_link_names(canonical_root, &[&destination], 1)
                };
                if let Err(error) = verification() {
                    failure = Some(error);
                    break;
                }
            }
            Ok((moved, failure))
        })
    })
    .map_err(retained_error)?;
    let paths = moved
        .iter()
        .map(|entry| format!("{} -> {}", entry.from, entry.to))
        .collect::<Vec<_>>()
        .join(", ");
    if !moved.is_empty() {
        manifest.trashed.extend(moved);
        #[cfg(test)]
        commit_checkpoint(
            CommitCheckpoint::BeforeTrashManifest,
            &manifest_path(root, &manifest.id),
        )?;
        // Save_manifest uses the locking CAS writer, after the pair transaction.
        save_manifest(root, manifest).map_err(|error| format!(
            "expiry moved [{paths}]; trash manifest save failed: {error}; retained copies require manual recovery"
        ))?;
    }
    if let Some(error) = failure {
        return Err(format!(
            "recoverable expiry incomplete; moved [{paths}]; remaining copies retained for review: {error}"
        ));
    }
    Ok(())
}

// The handles live for one pair only. These observations are not native
// creation ownership, restart authority, or an external-filesystem transaction.
struct ObservedFile {
    path: PathBuf,
    file: std::fs::File,
    metadata: std::fs::Metadata,
    revision: String,
}

fn same_observation(
    left: &std::fs::Metadata,
    right: &std::fs::Metadata,
    links: u64,
) -> Result<bool, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(left.dev() == right.dev()
            && left.ino() == right.ino()
            && left.ctime() == right.ctime()
            && left.ctime_nsec() == right.ctime_nsec()
            && left.nlink() == links
            && right.nlink() == links)
    }
    #[cfg(not(unix))]
    {
        let _ = (left, right, links);
        Err("automatic expiry file identity is unsupported on this platform".into())
    }
}

impl ObservedFile {
    fn capture(path: PathBuf, revision: &str) -> Result<Self, String> {
        let named = std::fs::symlink_metadata(&path)
            .map_err(|error| format!("inspect expiry file: {error}"))?;
        if !named.file_type().is_file() {
            return Err("expiry target is not a regular file".into());
        }
        let file =
            std::fs::File::open(&path).map_err(|error| format!("open expiry file: {error}"))?;
        let metadata = file
            .metadata()
            .map_err(|error| format!("inspect held expiry file: {error}"))?;
        if !same_observation(&named, &metadata, 1)? {
            return Err("expiry file identity changed while opening".into());
        }
        let observed = Self {
            path,
            file,
            metadata,
            revision: revision.into(),
        };
        observed.verify_bytes()?;
        Ok(observed)
    }

    fn verify(&self, root: &Path) -> Result<(), String> {
        if crate::vault::confine_delete_path(root, &self.path.to_string_lossy())? != self.path {
            return Err("expiry file path changed".into());
        }
        self.verify_bytes()
    }

    fn verify_bytes(&self) -> Result<(), String> {
        self.verify_observation_at(&self.path, &self.metadata, 1)
    }

    fn verify_link_names(&self, root: &Path, names: &[&Path], links: u64) -> Result<(), String> {
        let held = self
            .file
            .metadata()
            .map_err(|error| format!("inspect linked expiry file: {error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if held.dev() != self.metadata.dev() || held.ino() != self.metadata.ino() {
                return Err("linked expiry identity changed".into());
            }
        }
        for name in names {
            if crate::vault::confine_delete_path(root, &name.to_string_lossy())? != *name {
                return Err("linked expiry path changed".into());
            }
            self.verify_observation_at(name, &held, links)?;
        }
        Ok(())
    }

    fn verify_observation_at(
        &self,
        path: &Path,
        observation: &std::fs::Metadata,
        links: u64,
    ) -> Result<(), String> {
        let named = std::fs::symlink_metadata(path)
            .map_err(|error| format!("reinspect expiry file: {error}"))?;
        let held = self
            .file
            .metadata()
            .map_err(|error| format!("reinspect held expiry file: {error}"))?;
        if !named.file_type().is_file()
            || !same_observation(observation, &named, links)?
            || !same_observation(observation, &held, links)?
        {
            return Err("expiry file identity changed".into());
        }
        let mut current =
            std::fs::File::open(path).map_err(|error| format!("reopen expiry file: {error}"))?;
        let before = current
            .metadata()
            .map_err(|error| format!("inspect reopened expiry file: {error}"))?;
        if !same_observation(observation, &before, links)? {
            return Err("expiry file identity changed before reading".into());
        }
        let mut bytes = Vec::new();
        current
            .read_to_end(&mut bytes)
            .map_err(|error| format!("read expiry file: {error}"))?;
        let after = current
            .metadata()
            .map_err(|error| format!("inspect read expiry file: {error}"))?;
        let named = std::fs::symlink_metadata(path)
            .map_err(|error| format!("reinspect read expiry path: {error}"))?;
        if admission::sha256(&bytes) != self.revision
            || !named.file_type().is_file()
            || !same_observation(observation, &after, links)?
            || !same_observation(observation, &named, links)?
        {
            return Err("expiry file revision or identity changed".into());
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "distill_ttl_revision_tests.rs"]
mod revision_tests;

#[cfg(test)]
#[path = "distill_ttl_lifecycle_tests.rs"]
mod lifecycle_tests;

#[cfg(test)]
#[path = "distill_ttl_recoverable_tests.rs"]
mod recoverable_tests;

#[cfg(test)]
#[path = "distill_keep_writer_tests.rs"]
mod keep_writer_tests;

#[cfg(test)]
#[path = "distill_keep_revision_tests.rs"]
mod keep_revision_tests;
