//! Explicit pinned-artifact preparation for the isolated native QA profile.

#[cfg(unix)]
pub(super) use super::artifact_io::identity;
use super::artifact_io::publish_stage;
pub(super) use super::artifact_io::{
    close_stage, create_owner, create_stage, open_directory, verify_destination, verify_directory,
};
use super::require;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Read;
#[cfg(not(target_os = "macos"))]
use std::io::Write;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::path::Path;

pub(super) fn seed_artifact(
    source: &Path,
    manifest: &'static crate::local_model::ModelManifest,
) -> Result<Value, String> {
    require(
        source.is_absolute(),
        "control artifact requires an explicit absolute path",
    )?;
    let named = std::fs::symlink_metadata(source).map_err(|error| error.to_string())?;
    require(
        named.is_file() && !named.file_type().is_symlink(),
        "control artifact is not a regular non-symlink file",
    )?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut input = options.open(source).map_err(|error| error.to_string())?;
    let before = input.metadata().map_err(|error| error.to_string())?;
    #[cfg(unix)]
    require(
        identity(&named) == identity(&before) && before.nlink() == 1,
        "control artifact changed or is hardlinked",
    )?;
    require(
        before.len() == manifest.bytes,
        "control artifact size does not match pinned manifest",
    )?;
    let directory = crate::local_model::model_dir()?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let target = directory.join(manifest.file);
    let parent = open_directory(&directory)?;
    verify_directory(&directory, &parent, false)?;
    let (owner, stage) = create_owner(&directory, &parent)?;
    let staging = owner.join("artifact.part");
    let mut retained_stage = None;
    let result = (|| {
        verify_directory(&directory, &parent, false)?;
        verify_directory(&owner, &stage, true)?;
        let output = create_stage(&input, &stage, &staging)?;
        retained_stage = Some(output.try_clone().map_err(|error| error.to_string())?);
        #[cfg(not(target_os = "macos"))]
        let mut output = output;
        let mut digest = Sha256::new();
        let mut buffer = vec![0_u8; 1024 * 1024];
        let mut total = 0_u64;
        loop {
            let count = input.read(&mut buffer).map_err(|error| error.to_string())?;
            if count == 0 {
                break;
            }
            total = total
                .checked_add(count as u64)
                .ok_or("control artifact copy length overflow")?;
            require(total <= manifest.bytes, "control artifact grew during copy")?;
            digest.update(&buffer[..count]);
            #[cfg(not(target_os = "macos"))]
            output
                .write_all(&buffer[..count])
                .map_err(|error| error.to_string())?;
        }
        output.sync_all().map_err(|error| error.to_string())?;
        let after = input.metadata().map_err(|error| error.to_string())?;
        let named_after = std::fs::symlink_metadata(source).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        require(
            identity(&before) == identity(&after)
                && identity(&after) == identity(&named_after)
                && !named_after.file_type().is_symlink(),
            "control artifact changed during copy",
        )?;
        require(
            total == manifest.bytes && format!("{:x}", digest.finalize()) == manifest.sha256,
            "control artifact SHA does not match pinned manifest",
        )?;
        #[cfg(unix)]
        {
            let stage_named =
                std::fs::symlink_metadata(&staging).map_err(|error| error.to_string())?;
            let stage_opened = output.metadata().map_err(|error| error.to_string())?;
            require(
                stage_named.is_file()
                    && !stage_named.file_type().is_symlink()
                    && identity(&stage_named) == identity(&stage_opened),
                "control stage changed before publication",
            )?;
        }
        verify_directory(&directory, &parent, false)?;
        verify_directory(&owner, &stage, true)?;
        let published = publish_stage(output, &stage, &parent, &staging, &target)?;
        let copied = std::fs::symlink_metadata(&target).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        require(
            copied.is_file()
                && !copied.file_type().is_symlink()
                && copied.nlink() == 1
                && copied.uid() == unsafe { libc::geteuid() }
                && identity(&copied)
                    == identity(&published.metadata().map_err(|error| error.to_string())?)
                && (copied.dev(), copied.ino()) != (before.dev(), before.ino()),
            "control copy shares source inode",
        )?;
        let verified = crate::local_model::resolve_verified_artifact(&directory, manifest)?;
        require(
            verified == target,
            "native verification escaped isolated model directory",
        )?;
        verify_directory(&directory, &parent, false)?;
        verify_directory(&owner, &stage, true)?;
        verify_destination(&target, &published, &copied)?;
        #[cfg(unix)]
        require(
            identity(&before) == identity(&input.metadata().map_err(|error| error.to_string())?)
                && identity(&before)
                    == identity(
                        &std::fs::symlink_metadata(source).map_err(|error| error.to_string())?,
                    ),
            "control artifact changed during destination verification",
        )?;
        Ok(
            json!({"modelId":manifest.id,"repository":manifest.repository,"revision":manifest.revision,
        "sha256":manifest.sha256,"bytes":manifest.bytes,"independentRegularFileCopy":true,
        "nativeArtifactVerification":true,"preparationMethod":if cfg!(target_os="macos") {
            "apfs_copy_on_write"
        } else {"streamed_copy"}}),
        )
    })();
    match (
        result,
        close_stage(&owner, &directory, &parent, &stage, retained_stage.as_ref()),
    ) {
        (Ok(receipt), Ok(())) => Ok(receipt),
        (Err(error), Ok(())) | (Ok(_), Err(error)) => Err(error),
        (Err(error), Err(cleanup)) => Err(format!("{error}; stage cleanup refused: {cleanup}")),
    }
}
