//! Durable native creation/refresh observations. Fresh source authorization and
//! target checks are required for refresh; no old update/undo grant is restored.

/// Issued only after a checked live creation record; never deserialized from disk.
#[derive(Clone)]
pub(crate) struct MapCreationUndo {
    receipt: crate::vault::RecordedWriteReceipt,
}
impl MapCreationUndo {
    pub(crate) fn receipt(&self) -> &crate::vault::RecordedWriteReceipt {
        &self.receipt
    }
}

#[cfg(unix)]
mod platform {
    use crate::vault::{CompilerPinDirectory, RecordedWriteReceipt};
    use serde::Serialize;
    use sha2::{Digest, Sha256};
    use std::fs::File;
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    use std::path::Path;
    use std::sync::MutexGuard;

    #[derive(Serialize)]
    struct Scope {
        vault: String,
        device: u64,
        inode: u64,
        path: String,
    }

    pub(crate) struct MapCreationStore {
        directory: CompilerPinDirectory,
        scope: Scope,
        key: String,
    }

    impl MapCreationStore {
        pub(crate) fn open(root: &Path, relative: &str) -> Result<Self, String> {
            let key = relative
                .strip_prefix("wiki/maps/")
                .and_then(|name| name.strip_suffix(".md"))
                .ok_or("map custody target is outside wiki/maps")?;
            let artifact = crate::distill_publication::ManagedArtifact::Map { key: key.into() };
            if artifact.path()? != relative {
                return Err("map custody target is not canonical".into());
            }
            let base = crate::settings::settings_dir()?
                .canonicalize()
                .map_err(|e| e.to_string())?;
            let vault = root.canonicalize().map_err(|e| e.to_string())?;
            let path = base.join("map-creation-custody");
            if path.starts_with(&vault) {
                return Err("map custody app-data cannot be inside the vault".into());
            }
            match std::fs::DirBuilder::new().mode(0o700).create(&path) {
                Ok(()) => File::open(&base)
                    .and_then(|file| file.sync_all())
                    .map_err(|e| e.to_string())?,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
                Err(error) => return Err(format!("create map custody directory: {error}")),
            }
            let directory = crate::vault::open_compiler_pin_directory(&path)?;
            let metadata = std::fs::symlink_metadata(&vault).map_err(|e| e.to_string())?;
            let scope = Scope {
                vault: vault.to_str().ok_or("map vault path is not UTF-8")?.into(),
                device: metadata.dev(),
                inode: metadata.ino(),
                path: relative.into(),
            };
            let mut entropy = [0u8; 16];
            getrandom::fill(&mut entropy)
                .map_err(|error| format!("map custody generation entropy: {error}"))?;
            let generation: String = entropy.iter().map(|byte| format!("{byte:02x}")).collect();
            // Preserve old observations after undo; a fresh creation gets its
            // own generation. A live publication retry never writes this store.
            let key = format!(
                "{:x}.{generation}",
                Sha256::digest(serde_json::to_vec(&scope).map_err(|e| e.to_string())?)
            );
            Ok(Self {
                directory,
                scope,
                key,
            })
        }

        pub(crate) fn write(
            &self,
            guard: &MutexGuard<'_, ()>,
            path: &str,
            content: &str,
        ) -> Result<RecordedWriteReceipt, String> {
            if Path::new(path) != Path::new(&self.scope.vault).join(&self.scope.path) {
                return Err("map custody target differs from its scope".into());
            }
            crate::vault::write_compiler_file_anchored_locked(
                guard,
                path,
                content,
                None,
                None,
                &self.directory,
                &format!("{}.anchor", self.key),
            )
        }

        pub(crate) fn record(
            &self,
            guard: &MutexGuard<'_, ()>,
            written: &RecordedWriteReceipt,
            content: &str,
        ) -> Result<super::MapCreationUndo, String> {
            self.record_observation(guard, written, content, None)?;
            Ok(super::MapCreationUndo {
                receipt: written.clone(),
            })
        }

        /// Refresh only a privately retained, unedited generated section. This
        /// path never issues a creation or deletion permit.
        pub(crate) fn refresh(
            &self,
            guard: &MutexGuard<'_, ()>,
            candidate: &str,
            expected: &str,
            verify_sources: &dyn Fn() -> Result<(), String>,
        ) -> Result<Option<RecordedWriteReceipt>, String> {
            let observation = crate::map_creation_observation::discover_creation(
                &self.directory,
                Path::new(&self.scope.vault),
                &self.scope.path,
                guard,
            )?;
            if expected != format!("{:x}", Sha256::digest(observation.current.as_bytes())) {
                return Err("map revision changed since preview; current content preserved".into());
            }
            let merged = crate::map_content::merge_owned_sections(
                &observation.baseline,
                &observation.current,
                candidate,
            )?;
            verify_sources()?;
            let prior = observation.checked_prior(guard)?;
            if merged == observation.current {
                verify_sources()?;
                observation.checked_prior(guard)?;
                return Ok(None);
            }
            // Ensure both snapshots fit before replacing the canonical file.
            // Maximum-width identity fields conservatively bound the later receipt.
            self.observation_bytes(
                &merged,
                Some(&observation.current),
                serde_json::json!({
                    "device": u64::MAX, "inode": u64::MAX,
                    "changedSeconds": i64::MIN, "changedNanoseconds": i64::MIN,
                }),
            )?;
            let mut prepared = None;
            let written = crate::vault::write_compiler_file_anchored_observed_locked(
                guard,
                Path::new(&self.scope.vault)
                    .join(&self.scope.path)
                    .to_str()
                    .ok_or("map path is not UTF-8")?,
                &merged,
                Some(prior),
                Some(expected),
                &self.directory,
                &format!("{}.anchor", self.key),
                |identity| {
                    let bytes = self.observation_bytes(
                        &merged,
                        Some(&observation.current),
                        serde_json::to_value(identity).map_err(|e| e.to_string())?,
                    )?;
                    let file = self.persist_observation(&bytes)?;
                    prepared = Some((file, bytes));
                    Ok(())
                },
            )?;
            let retained = |error| {
                format!("map refresh bytes persisted but verification failed: {error}; output retained for manual recovery")
            };
            let (file, bytes) =
                prepared.ok_or_else(|| retained("map preparation record is missing".into()))?;
            crate::map_custody_record::verify_held_record(
                &self.directory,
                &format!("{}.json", self.key),
                &file,
                &bytes,
            )
            .map_err(retained)?;
            self.verify_observation(guard, &written, &merged)
                .map_err(retained)?;
            verify_sources().map_err(retained)?;
            crate::vault::verify_recorded_file_unlocked(&written).map_err(retained)?;
            Ok(Some(written))
        }

        fn observation_bytes(
            &self,
            content: &str,
            previous: Option<&str>,
            identity: serde_json::Value,
        ) -> Result<Vec<u8>, String> {
            let record = serde_json::json!({
                "version": if previous.is_some() { 4 } else { 1 },
                "state": if previous.is_some() { "refreshPrepared" } else { "creationObserved" },
                "scope": self.scope, "anchor": format!("{}.anchor", self.key),
                "revision": format!("{:x}", Sha256::digest(content.as_bytes())),
                "fileIdentity": identity, "baseline": content,
                "previous": previous.map(|before| serde_json::json!({
                    "revision": format!("{:x}", Sha256::digest(before.as_bytes())), "content": before,
                })),
            });
            let bytes = serde_json::to_vec(&record).map_err(|e| e.to_string())?;
            if bytes.len() > crate::map_custody_record::MAX_BYTES {
                return Err("map custody record exceeds its byte budget".into());
            }
            Ok(bytes)
        }

        fn record_observation(
            &self,
            guard: &MutexGuard<'_, ()>,
            written: &RecordedWriteReceipt,
            content: &str,
            previous: Option<&str>,
        ) -> Result<(), String> {
            self.directory.verify()?;
            crate::vault::verify_recorded_file_unlocked(written)?;
            if written.native_created != previous.is_none()
                || written.compiler_anchor_leaf() != Some(format!("{}.anchor", self.key).as_str())
                || written.path != Path::new(&self.scope.vault).join(&self.scope.path)
                || written.revision != format!("{:x}", Sha256::digest(content.as_bytes()))
            {
                return Err("map custody record differs from native creation".into());
            }
            // This is an observation of exact native-written bytes, not a
            // serialized capability, publication completion or source review.
            let bytes = self.observation_bytes(
                content,
                previous,
                serde_json::to_value(&written.file_identity).map_err(|e| e.to_string())?,
            )?;
            self.persist_observation(&bytes)?;
            self.verify_observation(guard, written, content)
        }

        fn persist_observation(&self, bytes: &[u8]) -> Result<File, String> {
            crate::map_custody_record::write_record(
                &self.directory,
                &format!("{}.json", self.key),
                bytes,
            )
        }

        fn verify_observation(
            &self,
            guard: &MutexGuard<'_, ()>,
            written: &RecordedWriteReceipt,
            content: &str,
        ) -> Result<(), String> {
            let observation = crate::map_creation_observation::discover_creation(
                &self.directory,
                Path::new(&self.scope.vault),
                &self.scope.path,
                guard,
            )?;
            if observation.has_owned_content_edits
                || observation.baseline != content
                || observation.current != content
            {
                return Err("map creation observation differs from native output".into());
            }
            crate::vault::verify_recorded_file_unlocked(written)?;
            Ok(())
        }
    }
}

#[cfg(unix)]
pub(crate) use platform::MapCreationStore;

#[cfg(not(unix))]
pub(crate) struct MapCreationStore;
#[cfg(not(unix))]
impl MapCreationStore {
    pub(crate) fn open(_: &std::path::Path, _: &str) -> Result<Self, String> {
        Err("native publication identity is not yet supported on this platform; map custody unavailable".into())
    }
}
