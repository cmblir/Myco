//! Retirement preserves originals through commit, then verifies content-free completion.

use super::{capture_bytes, hash, identity, is_hex, Journal, PrivateDirectory, Scope};
use crate::vault;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[path = "editor_recovery_compaction.rs"]
mod compaction;
#[path = "editor_recovery_completion.rs"]
mod completion;
use completion::CompletionReceipt;

struct Record {
    journal: Journal,
    digest: String,
    raw: String,
}

enum Stored {
    Full(Record),
    Compact(CompletionReceipt),
}

impl Stored {
    fn revision(&self) -> &str {
        match self {
            Self::Full(record) => &record.journal.recovery.revision,
            Self::Compact(receipt) => &receipt.revision,
        }
    }

    fn matches(&self, original: &Record) -> bool {
        match self {
            Self::Full(record) => record.digest == original.digest,
            Self::Compact(receipt) => receipt.matches_original(&original.journal, &original.digest),
        }
    }
}

pub(super) struct Prepared {
    record: Record,
    pending: PathBuf,
    committed: PathBuf,
    pub(super) has_primary: bool,
}

/// Both supporting files contain the exact closed version-one primary bytes.
pub(super) fn paths(
    directory: &PrivateDirectory,
    target: &Path,
    revision: &str,
) -> Result<(PathBuf, PathBuf), String> {
    let key = target
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("invalid recovery key")?;
    if !is_hex(key, 64) || !is_hex(revision, 32) {
        return Err("invalid recovery retirement identity".into());
    }
    Ok((
        directory
            .path
            .join(format!("{key}.{revision}.pending.json")),
        directory
            .path
            .join(format!("{key}.{revision}.committed.json")),
    ))
}

pub(super) fn primary_for_entry(
    directory: &PrivateDirectory,
    path: &Path,
) -> Result<PathBuf, String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("recovery entry name is not UTF-8")?;
    let fields: Vec<_> = name.split('.').collect();
    let valid = match fields.as_slice() {
        [key, "json"] => is_hex(key, 64),
        [key, revision, "pending" | "committed" | "compacting", "json"] => {
            is_hex(key, 64) && is_hex(revision, 32)
        }
        _ => false,
    };
    if !valid {
        return Err("unrecognized recovery journal entry".into());
    }
    Ok(directory.path.join(format!("{}.json", fields[0])))
}

fn read(
    directory: &PrivateDirectory,
    path: &Path,
    scope: &Scope,
) -> Result<Option<Record>, String> {
    match read_stored(directory, path, Some(scope))? {
        Some(Stored::Full(record)) => Ok(Some(record)),
        Some(Stored::Compact(_)) => {
            Err("compact completion cannot replace an original recovery record".into())
        }
        None => Ok(None),
    }
}

fn read_stored(
    directory: &PrivateDirectory,
    path: &Path,
    expected: Option<&Scope>,
) -> Result<Option<Stored>, String> {
    let Some(bytes) = capture_bytes(directory, path)? else {
        return Ok(None);
    };
    let version: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|error| format!("parse recovery retirement: {error}"))?;
    let (stored, scope) = match version.get("version").and_then(|version| version.as_u64()) {
        Some(1) => {
            let journal: Journal = serde_json::from_slice(&bytes)
                .map_err(|error| format!("parse recovery retirement: {error}"))?;
            let scope = completion::scope(
                &journal.canonical_vault,
                &journal.vault_identity,
                &journal.relative_path,
            )?;
            scope.validate(&journal)?;
            (
                Stored::Full(Record {
                    journal,
                    digest: hash(&bytes),
                    raw: String::from_utf8(bytes).map_err(|error| {
                        format!("recovery retirement JSON is not UTF-8: {error}")
                    })?,
                }),
                scope,
            )
        }
        Some(2) => {
            if !path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(".committed.json"))
            {
                return Err("compact completion is only valid at its committed path".into());
            }
            let receipt: CompletionReceipt = serde_json::from_slice(&bytes)
                .map_err(|error| format!("parse recovery completion: {error}"))?;
            let scope = receipt.scope()?;
            receipt.validate(&scope)?;
            (Stored::Compact(receipt), scope)
        }
        _ => return Err("unsupported recovery retirement version".into()),
    };
    if expected.is_some_and(|expected| {
        expected.root != scope.root
            || expected.object != scope.object
            || expected.relative != scope.relative
            || expected.path != scope.path
    }) {
        return Err("recovery retirement scope differs from its original".into());
    }
    let primary = scope.journal_path(directory)?;
    if primary_for_entry(directory, path)? != primary {
        return Err("recovery retirement key differs from its original".into());
    }
    if path != primary {
        let (pending, committed) = paths(directory, &primary, stored.revision())?;
        let compacting = compacting_path(directory, &primary, stored.revision())?;
        if path != pending && path != committed && path != compacting {
            return Err("recovery retirement nonce differs from its original".into());
        }
    }
    Ok(Some(stored))
}

pub(super) fn scope_for_entry(directory: &PrivateDirectory, path: &Path) -> Result<Scope, String> {
    match read_stored(directory, path, None)?.ok_or("recovery entry disappeared during guard")? {
        Stored::Full(record) => completion::scope(
            &record.journal.canonical_vault,
            &record.journal.vault_identity,
            &record.journal.relative_path,
        ),
        Stored::Compact(receipt) => receipt.scope(),
    }
}

pub(super) fn compacting_path(
    directory: &PrivateDirectory,
    target: &Path,
    revision: &str,
) -> Result<PathBuf, String> {
    let (_, committed) = paths(directory, target, revision)?;
    let name = committed
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("invalid recovery completion path")?;
    Ok(directory
        .path
        .join(name.replace(".committed.json", ".compacting.json")))
}

struct State {
    primary: Option<Record>,
    pending: Option<Record>,
    has_full_completed: bool,
}

fn state(directory: &PrivateDirectory, target: &Path, scope: &Scope) -> Result<State, String> {
    let primary = read(directory, target, scope)?;
    let key = target
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("invalid recovery key")?;
    let prefix = format!("{key}.");
    let mut pending = HashMap::new();
    let mut committed = HashMap::new();
    let mut compacting = HashMap::new();
    let mut has_full_completed = false;
    for entry in std::fs::read_dir(&directory.path)
        .map_err(|error| format!("list recovery retirement records: {error}"))?
    {
        let path = entry
            .map_err(|error| format!("inspect recovery retirement entry: {error}"))?
            .path();
        if path == target {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or("recovery retirement name is not UTF-8")?;
        if !name.starts_with(&prefix) {
            continue;
        }
        primary_for_entry(directory, &path)?;
        let record = read_stored(directory, &path, Some(scope))?
            .ok_or("recovery retirement disappeared during read")?;
        let revision = record.revision().to_owned();
        if name.ends_with(".pending.json") {
            if let Stored::Full(record) = record {
                pending.insert(revision, record);
            } else {
                return Err("pending recovery cannot be a compact receipt".into());
            }
        } else if name.ends_with(".committed.json") {
            has_full_completed |= matches!(&record, Stored::Full(_));
            committed.insert(revision, record);
        } else if name.ends_with(".compacting.json") {
            if let Stored::Full(record) = record {
                compacting.insert(revision, record);
            } else {
                return Err("compacting recovery cannot be a compact receipt".into());
            }
        } else {
            return Err("unrecognized recovery retirement phase".into());
        }
    }
    for (revision, done) in &committed {
        if pending
            .get(revision)
            .is_some_and(|record| !done.matches(record))
        {
            return Err("recovery pending and committed copies differ".into());
        }
        if primary
            .as_ref()
            .is_some_and(|record| &record.journal.recovery.revision == revision)
        {
            return Err("committed recovery primary reappeared".into());
        }
        if pending.remove(revision).is_some() {
            has_full_completed = true;
        }
        if let Some(record) = compacting.remove(revision) {
            if !done.matches(&record) {
                return Err("recovery compacting copy differs from completion".into());
            }
            has_full_completed = true;
        }
    }
    if !compacting.is_empty() {
        return Err("recovery compacting copy has no confirmed completion".into());
    }
    if pending.len() > 1 {
        return Err("multiple unresolved recovery retirements conflict".into());
    }
    let pending = pending.into_values().next();
    if let (Some(active), Some(fallback)) = (&primary, &pending) {
        if active.digest != fallback.digest
            || active.journal.recovery.revision != fallback.journal.recovery.revision
        {
            return Err("recovery primary conflicts with its pending retirement".into());
        }
    }
    directory.check()?;
    Ok(State {
        primary,
        pending,
        has_full_completed,
    })
}

pub(super) fn load(
    directory: &PrivateDirectory,
    target: &Path,
    scope: &Scope,
) -> Result<Option<(Journal, String)>, String> {
    let state = state(directory, target, scope)?;
    Ok(state
        .primary
        .or(state.pending)
        .map(|record| (record.journal, record.digest)))
}

pub(super) fn assert_stage_clear(
    directory: &PrivateDirectory,
    target: &Path,
    scope: &Scope,
) -> Result<(), String> {
    if state(directory, target, scope)?.pending.is_some() {
        return Err(
            "recovery retirement is unresolved; preserve the acknowledged draft before staging"
                .into(),
        );
    }
    Ok(())
}

/// Confirm this retired nonce and explicitly repair only its completed raw custody.
pub(super) fn acknowledge_committed(
    directory: &PrivateDirectory,
    target: &Path,
    scope: &Scope,
    expected_revision: &str,
    guard: &std::sync::MutexGuard<'_, ()>,
) -> Result<bool, String> {
    let current = state(directory, target, scope)?;
    if current.primary.is_some() || current.pending.is_some() {
        return Ok(false);
    }
    let (_, committed) = paths(directory, target, expected_revision)?;
    if read_stored(directory, &committed, Some(scope))?.is_none() {
        return Ok(false);
    }
    compaction::maintain_completed(directory, target, scope, guard, expected_revision);
    Ok(true)
}

pub(super) fn assert_path_change_clear(
    directory: &PrivateDirectory,
    target: &Path,
    scope: &Scope,
) -> Result<(), String> {
    let current = state(directory, target, scope)?;
    if current.primary.is_some() || current.pending.is_some() {
        return Err(
            "refused: pending editor recovery must be resolved before this path changes".into(),
        );
    }
    if current.has_full_completed {
        return Err("refused: completed editor recovery raw custody must be resolved before this path changes".into());
    }
    Ok(())
}

#[cfg(test)]
pub(super) fn compact_with_hook(
    directory: &PrivateDirectory,
    target: &Path,
    scope: &Scope,
    guard: &std::sync::MutexGuard<'_, ()>,
    revision: &str,
    after_publish: impl FnOnce(&Path, &Path) -> Result<(), String>,
) -> Result<(), String> {
    compaction::compact_completed(directory, target, scope, guard, revision, after_publish)
}

pub(super) fn prepare(
    directory: &PrivateDirectory,
    target: &Path,
    scope: &Scope,
    guard: &std::sync::MutexGuard<'_, ()>,
    expected_revision: &str,
) -> Result<Prepared, String> {
    let state = state(directory, target, scope)?;
    let has_primary = state.primary.is_some();
    let record = state
        .primary
        .or(state.pending)
        .ok_or("recovery journal is absent")?;
    if record.journal.recovery.revision != expected_revision {
        return Err("recovery conflict: journal changed before retirement".into());
    }
    let (pending, committed) = paths(directory, target, expected_revision)?;
    if let Some(existing) = read(directory, &pending, scope)? {
        if existing.digest != record.digest {
            return Err("recovery retirement copy differs from its original".into());
        }
    } else {
        vault::write_file_if_unchanged_recorded_locked(
            guard,
            &pending.to_string_lossy(),
            &record.raw,
            None,
        )?;
    }
    let copied = read(directory, &pending, scope)?.ok_or("recovery retirement copy disappeared")?;
    if copied.digest != record.digest {
        return Err("recovery retirement copy differs from its original bytes".into());
    }
    #[cfg(unix)]
    if has_primary {
        use std::os::unix::fs::MetadataExt;
        let original = std::fs::symlink_metadata(target)
            .map_err(|error| format!("inspect recovery original: {error}"))?;
        let copied = std::fs::symlink_metadata(&pending)
            .map_err(|error| format!("inspect recovery copy: {error}"))?;
        if (original.dev(), original.ino()) == (copied.dev(), copied.ino()) {
            return Err("recovery retirement copy is not an independent file".into());
        }
    }
    // The full independent A/D copy is acknowledged before primary removal.
    directory.sync()?;
    let current = read(directory, target, scope)?;
    if current.as_ref().map(|record| record.digest.as_str())
        != has_primary.then_some(record.digest.as_str())
    {
        return Err("recovery journal changed before retirement".into());
    }
    Ok(Prepared {
        record,
        pending,
        committed,
        has_primary,
    })
}

pub(super) fn commit(
    directory: &PrivateDirectory,
    target: &Path,
    scope: &Scope,
    guard: &std::sync::MutexGuard<'_, ()>,
    prepared: &Prepared,
    committed: &mut bool,
    #[cfg(test)] pending_cleanup: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    if read(directory, target, scope)?.is_some() {
        return Err("new recovery primary appeared before retirement commit".into());
    }
    let pending = read(directory, &prepared.pending, scope)?
        .ok_or("pending recovery retirement disappeared before commit")?;
    if pending.digest != prepared.record.digest {
        return Err("pending recovery retirement changed before commit".into());
    }
    directory.check()?;
    if identity(Path::new(&scope.root))? != scope.object {
        return Err("recovery vault changed before retirement commit".into());
    }
    let publication = vault::write_file_if_unchanged_recorded_locked(
        guard,
        &prepared.committed.to_string_lossy(),
        &prepared.record.raw,
        None,
    );
    match publication {
        Ok(receipt) if receipt.revision == prepared.record.digest => {},
        Ok(_) => return Err("retirement commit publication is uncertain; persisted receipt digest differs; full copies retained".into()),
        Err(error) => {
            return match read(directory, &prepared.committed, scope) {
                Ok(Some(actual)) if actual.digest == prepared.record.digest => {
                    *committed = true;
                    Err(format!("retirement committed but receipt confirmation failed: {error}"))
                }
                Ok(None) => Err(error),
                _ => Err(format!("retirement commit publication is uncertain; full copies retained: {error}")),
            };
        }
    }
    let published = read(directory, &prepared.committed, scope).map_err(|error| {
        format!("retirement commit publication is uncertain; full copies retained: {error}")
    })?;
    if !published.is_some_and(|record| record.digest == prepared.record.digest) {
        return Err(
            "retirement commit publication is uncertain; marker bytes differ; full copies retained"
                .into(),
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let separate = (|| {
            let pending =
                std::fs::symlink_metadata(&prepared.pending).map_err(|error| error.to_string())?;
            let marker = std::fs::symlink_metadata(&prepared.committed)
                .map_err(|error| error.to_string())?;
            if (pending.dev(), pending.ino()) == (marker.dev(), marker.ino()) {
                return Err("commit marker is not an independent full copy".to_owned());
            }
            Ok(())
        })();
        separate.map_err(|error| {
            format!("retirement commit publication is uncertain; full copies retained: {error}")
        })?;
    }
    // Atomic absence-CAS publication plus the native exact persisted receipt is commit.
    // Process restart is covered; this is not a power-loss or IPC-delivery promise.
    *committed = true;
    if let Err(error) = directory.sync() {
        eprintln!("editor recovery retirement committed; marker sync incomplete: {error}");
        return Ok(());
    }
    // A validated full committed copy remains even when cleanup is successful.
    let cleanup = (|| {
        let pending = read(directory, &prepared.pending, scope)?
            .ok_or("pending recovery cleanup copy is absent")?;
        if pending.digest != prepared.record.digest {
            return Err("pending recovery copy changed before cleanup".into());
        }
        #[cfg(test)]
        pending_cleanup(&prepared.pending)?;
        #[cfg(not(test))]
        std::fs::remove_file(&prepared.pending)
            .map_err(|error| format!("remove retired pending copy: {error}"))?;
        directory.sync()
    })();
    if let Err(error) = cleanup {
        eprintln!("editor recovery retirement committed; pending cleanup incomplete: {error}");
        return Ok(());
    }
    compaction::maintain_completed(
        directory,
        target,
        scope,
        guard,
        &prepared.record.journal.recovery.revision,
    );
    Ok(())
}
