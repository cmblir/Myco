// Archive compaction for the cold tier (Settings → Distill).
//
// Cold buckets in sessions/archive, daily/archive, and weekly/archive grow
// outside the live index. This packs one flat bucket into a deflated ZIP
// beside it and restores its members when requested.
//
// The closed TREES list and exact bucket shape limit paths relative to an
// already admitted real vault root. Mutation rechecks reject symbolic
// descendants and raw/ relative to that root. This helper cannot establish
// that a caller root is the currently open vault rather than its raw/ child.
// Product entry points use authority admission and recheck the native opening
// for every short mutation; filesystem-only controls are test-only.
//
// Zip, not tar.gz: `zip` is already a direct dependency (Cargo.toml, used by
// `extract.rs` and `mcp_native.rs`), so this adds no dependency at all, and
// its central directory makes the post-write verification below a cheap
// per-entry read instead of a full stream decode.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[path = "archive_pack_authority.rs"]
mod authority;
use authority::ArchiveOperation;
pub(crate) use authority::{compress_for_origin, restore_for_origin, usage_for_origin};

/// The three allowed trees, `(tree name, admitted-vault-relative directory)`.
/// `raw` is absent; exact vault-root authorization is the caller's responsibility.
const TREES: [(&str, &str); 3] = [
    ("sessions", "sessions/archive"),
    ("daily", "daily/archive"),
    ("weekly", "weekly/archive"),
];

/// One archive bucket, loose or already packed.
#[derive(serde::Serialize, Debug, PartialEq)]
pub struct BucketUsage {
    /// `"sessions"`, `"daily"` or `"weekly"`.
    pub tree: String,
    /// `YYYY-Www` (daily, one bucket per rolled-up week) or `YYYY-MM`
    /// (sessions and weekly, one per month).
    pub bucket: String,
    /// Loose files in the bucket directory, or entries in its zip.
    pub files: usize,
    /// Bytes on disk: the sum of the loose files, or the zip's own size.
    pub bytes: u64,
    pub packed: bool,
}

/// What one `compress` call did.
#[derive(serde::Serialize, Debug, Default)]
pub struct PackReport {
    pub buckets: usize,
    pub files: usize,
    /// Loose bytes that were removed minus the zip bytes written.
    pub reclaimed: u64,
    /// Buckets that failed, `"<tree>/<bucket>: <error>"`. Before publication
    /// originals remain; partial unlink retains the complete ZIP and remaining files.
    pub failed: Vec<String>,
}

/// What one `restore` call did.
#[derive(serde::Serialize, Debug)]
pub struct RestoreReport {
    pub files: usize,
    pub bytes: u64,
}

fn tree_dir(tree: &str) -> Result<&'static str, String> {
    TREES
        .iter()
        .find(|(name, _)| *name == tree)
        .map(|(_, dir)| *dir)
        .ok_or_else(|| format!("unknown archive tree `{tree}` (sessions|daily|weekly only)"))
}

/// Exact bucket shape per tree — these become directory and file names, so a
/// bucket that is not literally `YYYY-MM` / `YYYY-Www` is refused outright
/// rather than normalized.
fn valid_bucket(tree: &str, bucket: &str) -> bool {
    let b = bucket.as_bytes();
    match tree {
        // `weekly/archive/` buckets are months, like `sessions/archive/`:
        // `archive_rolled` names each one after the month whose weeklies it
        // holds.
        "sessions" | "weekly" => {
            bucket.len() == 7
                && b[0..4].iter().all(u8::is_ascii_digit)
                && b[4] == b'-'
                && b[5..7].iter().all(u8::is_ascii_digit)
        }
        "daily" => {
            bucket.len() == 8
                && b[0..4].iter().all(u8::is_ascii_digit)
                && b[4] == b'-'
                && b[5] == b'W'
                && b[6..8].iter().all(u8::is_ascii_digit)
        }
        _ => false,
    }
}

/// `(bucket directory, bucket zip)` for a validated `tree`/`bucket` pair.
/// The single choke point every public entry point goes through.
fn bucket_paths(root: &Path, tree: &str, bucket: &str) -> Result<(PathBuf, PathBuf), String> {
    let dir = tree_dir(tree)?;
    if !valid_bucket(tree, bucket) {
        return Err(format!("bad archive bucket `{bucket}` for tree `{tree}`"));
    }
    Ok((
        crate::myco_pro::safe_join(root, &format!("{dir}/{bucket}"))?,
        crate::myco_pro::safe_join(root, &format!("{dir}/{bucket}.zip"))?,
    ))
}

/// Loose files directly inside a bucket, sorted by name for a deterministic
/// zip. A bucket is flat by construction (`distill::archive_digested_sessions`
/// and `archive_rolled_days` both move by file name), so a nested directory
/// means something unexpected put it there — the caller refuses to pack it
/// rather than silently drop it.
fn loose_files(dir: &Path) -> Result<(Vec<PathBuf>, bool), String> {
    let mut files = Vec::new();
    let mut has_subdir = false;
    for entry in std::fs::read_dir(dir).map_err(|e| format!("read {}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| format!("read {}: {e}", dir.display()))?;
        let path = entry.path();
        if path.is_dir() {
            has_subdir = true;
        } else {
            files.push(path);
        }
    }
    files.sort();
    Ok((files, has_subdir))
}

/// Current size of every archive bucket in the three trees. Walks shallow
/// directories, so it is cheap — but still on demand only (one IPC command,
/// never a render-time call).
pub fn usage(root: &Path) -> Vec<BucketUsage> {
    let mut out = Vec::new();
    for (tree, rel) in TREES {
        let Ok(entries) = std::fs::read_dir(root.join(rel)) else {
            continue; // tree does not exist yet — nothing archived
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.is_dir() {
                if !valid_bucket(tree, &name) {
                    continue;
                }
                let Ok((files, _)) = loose_files(&path) else {
                    continue;
                };
                out.push(BucketUsage {
                    tree: tree.into(),
                    bucket: name,
                    files: files.len(),
                    bytes: files
                        .iter()
                        .filter_map(|f| std::fs::metadata(f).ok())
                        .map(|m| m.len())
                        .sum(),
                    packed: false,
                });
            } else if let Some(bucket) = name.strip_suffix(".zip") {
                if !valid_bucket(tree, bucket) {
                    continue;
                }
                let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                let files = std::fs::File::open(&path)
                    .ok()
                    .and_then(|f| zip::ZipArchive::new(f).ok())
                    .map(|z| z.len())
                    .unwrap_or(0);
                out.push(BucketUsage {
                    tree: tree.into(),
                    bucket: bucket.into(),
                    files,
                    bytes,
                    packed: true,
                });
            }
        }
    }
    out.sort_by(|a, b| (&a.tree, &a.bucket).cmp(&(&b.tree, &b.bucket)));
    out
}

// Test-only hook that makes `pack_bucket`'s verification fail AFTER the zip
// has been written but BEFORE anything is deleted — the one moment the
// write-verify-then-delete ordering actually has to hold. There is no
// seam-free way to corrupt a file the same function just wrote.
// Thread-local, not a global: `cargo test` runs tests in parallel threads, and
// a shared flag would inject the fault into whatever other test happened to be
// packing at the same moment.
#[cfg(test)]
thread_local! {
    static FAIL_VERIFY_FOR_TEST: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

// Synthetic regression checkpoints only. Production code has no hook registry.
#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MutationCheckpoint {
    PackStageCreated,
    PackPrepared,
    PackVerified,
    PackBeforeDelete(usize),
    RestoreWrite,
    RestorePrepared,
    RestoreFinalize,
    StagePublishFailed,
}

#[cfg(test)]
pub(crate) type MutationHook = Box<dyn Fn(MutationCheckpoint) -> Result<(), String>>;

#[cfg(test)]
thread_local! {
    pub(crate) static MUTATION_HOOK: std::cell::RefCell<Option<MutationHook>> = const {
        std::cell::RefCell::new(None)
    };
}

#[cfg(test)]
fn mutation_checkpoint(phase: MutationCheckpoint) -> Result<(), String> {
    MUTATION_HOOK.with(|hook| hook.borrow().as_ref().map_or(Ok(()), |hook| hook(phase)))
}

#[cfg(test)]
#[path = "archive_pack_mutation_tests.rs"]
mod mutation_tests;

#[cfg(test)]
#[path = "archive_pack_safety_tests.rs"]
mod safety_tests;

// These retained handles are private to one archive operation. They do not
// authorize arbitrary callers or make external filesystem edits atomic.
struct RetainedDirectory {
    path: PathBuf,
    file: std::fs::File,
}

fn same_identity(left: &std::fs::Metadata, right: &std::fs::Metadata) -> Result<bool, String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(left.dev() == right.dev() && left.ino() == right.ino())
    }
    #[cfg(not(unix))]
    {
        let _ = (left, right);
        Err("archive file identity is unsupported on this platform".into())
    }
}

impl RetainedDirectory {
    fn capture(path: &Path) -> Result<Self, String> {
        let named = std::fs::symlink_metadata(path)
            .map_err(|error| format!("inspect archive directory {}: {error}", path.display()))?;
        if !named.file_type().is_dir() {
            return Err(format!("archive directory is not real: {}", path.display()));
        }
        let retained = Self {
            path: path.to_path_buf(),
            file: std::fs::File::open(path)
                .map_err(|error| format!("open archive directory {}: {error}", path.display()))?,
        };
        retained.verify()?;
        Ok(retained)
    }

    fn verify(&self) -> Result<(), String> {
        let held = self
            .file
            .metadata()
            .map_err(|error| format!("inspect held directory: {error}"))?;
        let named = std::fs::symlink_metadata(&self.path).map_err(|error| {
            format!(
                "reinspect archive directory {}: {error}",
                self.path.display()
            )
        })?;
        if !held.is_dir() || !named.file_type().is_dir() || !same_identity(&held, &named)? {
            return Err(format!(
                "archive directory changed: {}",
                self.path.display()
            ));
        }
        Ok(())
    }
}

struct RetainedFile {
    path: PathBuf,
    file: std::fs::File,
    metadata: std::fs::Metadata,
    revision: String,
}

fn archive_digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}

fn read_held(file: &std::fs::File) -> Result<Vec<u8>, String> {
    use std::io::{Seek, SeekFrom};
    let mut reader = file
        .try_clone()
        .map_err(|error| format!("clone archive handle: {error}"))?;
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|error| format!("seek archive handle: {error}"))?;
    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(|error| format!("read archive handle: {error}"))?;
    Ok(bytes)
}

impl RetainedFile {
    fn capture(path: &Path) -> Result<Self, String> {
        let named = std::fs::symlink_metadata(path)
            .map_err(|error| format!("inspect archive file {}: {error}", path.display()))?;
        if !named.file_type().is_file() {
            return Err(format!(
                "archive target is not a regular file: {}",
                path.display()
            ));
        }
        let file = std::fs::File::open(path)
            .map_err(|error| format!("open archive file {}: {error}", path.display()))?;
        if !same_identity(
            &named,
            &file
                .metadata()
                .map_err(|error| format!("inspect opened file: {error}"))?,
        )? {
            return Err(format!(
                "archive file changed while opening: {}",
                path.display()
            ));
        }
        Self::from_file(path, file)
    }

    fn from_file(path: &Path, file: std::fs::File) -> Result<Self, String> {
        let metadata = file
            .metadata()
            .map_err(|error| format!("inspect held archive file: {error}"))?;
        let mut retained = Self {
            path: path.to_path_buf(),
            file,
            metadata,
            revision: String::new(),
        };
        retained.verify_identity()?;
        retained.revision = archive_digest(&read_held(&retained.file)?);
        retained.verify_identity()?;
        Ok(retained)
    }

    fn verify_identity(&self) -> Result<(), String> {
        let held = self
            .file
            .metadata()
            .map_err(|error| format!("inspect held archive file: {error}"))?;
        let named = std::fs::symlink_metadata(&self.path)
            .map_err(|error| format!("reinspect archive file {}: {error}", self.path.display()))?;
        if !held.is_file()
            || !named.file_type().is_file()
            || !same_identity(&self.metadata, &held)?
            || !same_identity(&held, &named)?
        {
            return Err(format!(
                "archive file identity changed: {}",
                self.path.display()
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if named.nlink() != 1
                || held.len() != self.metadata.len()
                || held.ctime() != self.metadata.ctime()
                || held.ctime_nsec() != self.metadata.ctime_nsec()
                || named.ctime() != held.ctime()
                || named.ctime_nsec() != held.ctime_nsec()
            {
                return Err(format!(
                    "archive file changed or has unowned links: {}",
                    self.path.display()
                ));
            }
        }
        Ok(())
    }

    fn read(&self) -> Result<Vec<u8>, String> {
        self.verify_identity()?;
        let bytes = read_held(&self.file)?;
        self.verify_identity()?;
        if archive_digest(&bytes) != self.revision {
            return Err(format!(
                "archive file content changed: {}",
                self.path.display()
            ));
        }
        Ok(bytes)
    }

    fn verify(&self) -> Result<(), String> {
        self.read().map(|_| ())
    }
}

// Per-member observations have no descriptors. Reopen and compare one member
// at a time; this does not prove exclusion of arbitrary external inode ABA.
struct ObservedFile {
    path: PathBuf,
    metadata: std::fs::Metadata,
    revision: String,
}

impl ObservedFile {
    fn from_retained(retained: RetainedFile) -> Self {
        Self {
            path: retained.path,
            metadata: retained.metadata,
            revision: retained.revision,
        }
    }

    fn capture(path: &Path) -> Result<Self, String> {
        Ok(Self::from_retained(RetainedFile::capture(path)?))
    }

    fn compare(&self, current: &RetainedFile) -> Result<(), String> {
        if !same_identity(&self.metadata, &current.metadata)?
            || self.metadata.len() != current.metadata.len()
            || self.revision != current.revision
        {
            return Err(format!(
                "archive observation changed: {}",
                self.path.display()
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if self.metadata.ctime() != current.metadata.ctime()
                || self.metadata.ctime_nsec() != current.metadata.ctime_nsec()
            {
                return Err(format!(
                    "archive observation changed: {}",
                    self.path.display()
                ));
            }
        }
        Ok(())
    }

    fn read(&self) -> Result<Vec<u8>, String> {
        let current = RetainedFile::capture(&self.path)?;
        self.compare(&current)?;
        current.read()
    }

    fn verify(&self) -> Result<(), String> {
        self.read().map(|_| ())
    }
}

// Never let TempPath::drop remove a saved pathname after namespace replacement.
// Cleanup is explicit, under the existing writer or after its transaction ends.
struct ArchiveStage {
    temporary: Option<tempfile::NamedTempFile>,
    path: PathBuf,
    created: std::fs::Metadata,
    sealed: Option<ObservedFile>,
}

fn verify_stage_namespace(
    canonical_root: &Path,
    admitted_root: &RetainedDirectory,
    parent: &RetainedDirectory,
) -> Result<(), String> {
    admitted_root.verify()?;
    parent.verify()?;
    if admitted_root
        .path
        .canonicalize()
        .map_err(|error| error.to_string())?
        != canonical_root
        || crate::vault::confine_parent(canonical_root, &parent.path.to_string_lossy())?
            != parent.path
        || crate::vault::is_raw_path(canonical_root, &parent.path)
    {
        return Err("archive stage namespace changed; available copies retained".into());
    }
    Ok(())
}

impl ArchiveStage {
    fn create_locked(
        _guard: &std::sync::MutexGuard<'_, ()>,
        canonical_root: &Path,
        admitted_root: &RetainedDirectory,
        parent: &RetainedDirectory,
        prefix: &str,
        suffix: &str,
    ) -> Result<Self, String> {
        verify_stage_namespace(canonical_root, admitted_root, parent)?;
        let temporary = tempfile::Builder::new()
            .prefix(prefix)
            .suffix(suffix)
            .disable_cleanup(true)
            .tempfile_in(&parent.path)
            .map_err(|error| format!("create archive stage: {error}"))?;
        let path = temporary.path().to_path_buf();
        let created = temporary.as_file().metadata().map_err(|error| {
            format!(
                "inspect archive stage; retained at {}: {error}",
                path.display()
            )
        })?;
        let stage = Self {
            temporary: Some(temporary),
            path,
            created,
            sealed: None,
        };
        stage.verify_created()?;
        Ok(stage)
    }

    fn temporary(&self) -> Result<&tempfile::NamedTempFile, String> {
        self.temporary
            .as_ref()
            .ok_or_else(|| "archive stage is missing".into())
    }

    fn temporary_mut(&mut self) -> Result<&mut tempfile::NamedTempFile, String> {
        self.temporary
            .as_mut()
            .ok_or_else(|| "archive stage is missing".into())
    }

    fn verify_created(&self) -> Result<(), String> {
        let held = self
            .temporary()?
            .as_file()
            .metadata()
            .map_err(|error| error.to_string())?;
        let named = std::fs::symlink_metadata(&self.path).map_err(|error| error.to_string())?;
        if !held.is_file()
            || !named.file_type().is_file()
            || !same_identity(&self.created, &held)?
            || !same_identity(&held, &named)?
        {
            return Err(format!(
                "archive stage identity changed; retained at {}",
                self.path.display()
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if held.nlink() != 1
                || named.nlink() != 1
                || held.len() != named.len()
                || held.ctime() != named.ctime()
                || held.ctime_nsec() != named.ctime_nsec()
            {
                return Err(format!(
                    "archive stage changed or has unowned links; retained at {}",
                    self.path.display()
                ));
            }
        }
        Ok(())
    }

    fn seal(&mut self) -> Result<(), String> {
        self.verify_created()?;
        let file = self
            .temporary()?
            .as_file()
            .try_clone()
            .map_err(|error| error.to_string())?;
        self.sealed = Some(ObservedFile::from_retained(RetainedFile::from_file(
            &self.path, file,
        )?));
        Ok(())
    }

    fn verify_sealed(&self) -> Result<(), String> {
        self.verify_created()?;
        let expected = self
            .sealed
            .as_ref()
            .ok_or_else(|| format!("unsealed archive stage retained at {}", self.path.display()))?;
        let file = self
            .temporary()?
            .as_file()
            .try_clone()
            .map_err(|error| error.to_string())?;
        let current = RetainedFile::from_file(&self.path, file)?;
        expected.compare(&current)
    }

    fn cleanup_locked(
        &mut self,
        _guard: &std::sync::MutexGuard<'_, ()>,
        canonical_root: &Path,
        admitted_root: &RetainedDirectory,
        parent: &RetainedDirectory,
    ) -> Result<(), String> {
        if self.temporary.is_none() {
            return Ok(());
        }
        verify_stage_namespace(canonical_root, admitted_root, parent)?;
        if crate::vault::confine_delete_path(canonical_root, &self.path.to_string_lossy())?
            != self.path
            || self.path.parent() != Some(parent.path.as_path())
        {
            return Err("archive stage cleanup path changed; available copies retained".into());
        }
        // Writes can fail before sealing. The still-open creation handle owns
        // that inode even if its partial bytes changed during our own writes.
        // Sealed stages additionally require their immutable revision snapshot.
        self.verify_created()?;
        if self.sealed.is_some() {
            self.verify_sealed()?;
        }
        std::fs::remove_file(&self.path)
            .map_err(|error| format!("remove owned stage {}: {error}", self.path.display()))?;
        drop(self.temporary.take());
        Ok(())
    }
}

fn cleanup_archive_stage(
    authority: &ArchiveOperation<'_>,
    canonical_root: &Path,
    admitted_root: &RetainedDirectory,
    parent: &RetainedDirectory,
    stage: &mut Option<ArchiveStage>,
) -> Result<(), String> {
    let Some(stage) = stage.as_mut().filter(|stage| stage.temporary.is_some()) else {
        return Ok(());
    };
    authority
        .mutate(|rechecked_root, guard| {
            if rechecked_root != canonical_root {
                return Err(
                    "archive root changed before stage cleanup; available copies retained".into(),
                );
            }
            stage.cleanup_locked(guard, canonical_root, admitted_root, parent)
        })
        .map_err(|error| {
            format!(
                "stage cleanup refused; retained at {}: {error}",
                stage.path.display()
            )
        })
}

fn checked_archive_paths(
    root: &Path,
    requested_root: &Path,
    dir: &Path,
    zip_path: &Path,
) -> Result<(PathBuf, PathBuf), String> {
    let dir = crate::vault::confine_mutation_path(root, requested_root, &dir.to_string_lossy())?;
    let zip_path =
        crate::vault::confine_mutation_path(root, requested_root, &zip_path.to_string_lossy())?;
    let parent = dir.parent().ok_or("archive bucket has no parent")?;
    let parent = crate::vault::confine_parent(root, &parent.to_string_lossy())?;
    if crate::vault::is_raw_path(root, &parent) {
        return Err("refused: raw/ is immutable".into());
    }
    let zip_parent = crate::vault::confine_parent(
        root,
        &zip_path
            .parent()
            .ok_or("archive zip has no parent")?
            .to_string_lossy(),
    )?;
    if zip_parent != parent {
        return Err("archive directory and zip have different parents".into());
    }
    let bucket = dir
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("archive bucket is not UTF-8")?;
    let allowed = TREES.iter().any(|(tree, rel)| {
        root.join(rel).canonicalize().ok().as_ref() == Some(&parent) && valid_bucket(tree, bucket)
    });
    if !allowed
        || zip_path.file_name().and_then(|name| name.to_str())
            != Some(format!("{bucket}.zip").as_str())
    {
        return Err("archive paths do not name an allowed bucket".into());
    }
    Ok((parent.join(bucket), parent.join(format!("{bucket}.zip"))))
}

fn plain_archive_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\'])
        && !name.chars().any(char::is_control)
}

type ArchiveContents = std::collections::BTreeMap<String, (String, u64)>;

// This validates every member exposed by zip 4.6.1. Hidden duplicate central
// records need a separate container-format gate; this helper does not claim it.
fn archive_contents(file: &std::fs::File) -> Result<ArchiveContents, String> {
    #[cfg(test)]
    if FAIL_VERIFY_FOR_TEST.with(std::cell::Cell::get) {
        return Err("injected verification failure".into());
    }
    let mut archive = zip::ZipArchive::new(
        file.try_clone()
            .map_err(|error| format!("clone archive: {error}"))?,
    )
    .map_err(|error| format!("archive is not readable: {error}"))?;
    let mut contents = ArchiveContents::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("entry {index} unreadable: {error}"))?;
        let name = entry.name().to_string();
        let file_type = entry.unix_mode().map(|mode| mode & 0o170000).unwrap_or(0);
        if !plain_archive_name(&name)
            || !entry.is_file()
            || (file_type != 0 && file_type != 0o100000)
        {
            return Err(format!(
                "archive entry `{name}` is not a plain regular file"
            ));
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|error| format!("entry {name} unreadable: {error}"))?;
        if bytes.len() as u64 != entry.size()
            || contents
                .insert(name, (archive_digest(&bytes), bytes.len() as u64))
                .is_some()
        {
            return Err("archive entry size or uniqueness differs".into());
        }
    }
    Ok(contents)
}

fn publish_archive_stage(
    _guard: &std::sync::MutexGuard<'_, ()>,
    canonical_root: &Path,
    admitted_root: &RetainedDirectory,
    parent: &RetainedDirectory,
    stage: &mut ArchiveStage,
    destination: &Path,
) -> Result<RetainedFile, String> {
    // persist_noclobber uses a saved path, so validate ownership BEFORE it.
    // The cooperating writer excludes app edits, not arbitrary external edits.
    verify_stage_namespace(canonical_root, admitted_root, parent)?;
    if crate::vault::confine_delete_path(canonical_root, &stage.path.to_string_lossy())?
        != stage.path
        || stage.path.parent() != Some(parent.path.as_path())
        || crate::vault::confine_delete_path(canonical_root, &destination.to_string_lossy())?
            != destination
        || crate::vault::is_raw_path(canonical_root, destination)
    {
        return Err("archive publication path changed; available copies retained".into());
    }
    stage.verify_sealed()?;
    let expected = stage.sealed.as_ref().ok_or("archive stage is not sealed")?;
    let expected_identity = expected.metadata.clone();
    let expected_revision = expected.revision.clone();
    let temporary = stage.temporary.take().ok_or("archive stage is missing")?;
    let file = match temporary.persist_noclobber(destination) {
        Ok(file) => file,
        Err(error) => {
            // PersistError owns the disarmed temporary. Return it to the explicit
            // cleanup path; consuming the error must never unlink its saved path.
            let message = if error.error.kind() == std::io::ErrorKind::AlreadyExists {
                format!(
                    "{} already exists; archive publication refused",
                    destination.display()
                )
            } else {
                format!("publish {}: {}", destination.display(), error.error)
            };
            stage.temporary = Some(error.file);
            #[cfg(test)]
            mutation_checkpoint(MutationCheckpoint::StagePublishFailed)?;
            return Err(message);
        }
    };
    // A successful fallback may leave a second owned link. Only remove that
    // link after namespace/held-file/named-file checks under this same guard.
    verify_stage_namespace(canonical_root, admitted_root, parent)?;
    let held = file
        .metadata()
        .map_err(|error| format!("inspect published file: {error}"))?;
    let named = std::fs::symlink_metadata(destination)
        .map_err(|error| format!("inspect published destination: {error}"))?;
    if !held.is_file()
        || !named.file_type().is_file()
        || !same_identity(&expected_identity, &held)?
        || !same_identity(&held, &named)?
        || archive_digest(&read_held(&file)?) != expected_revision
    {
        return Err("publication identity or contents changed; available copies retained".into());
    }
    match std::fs::symlink_metadata(&stage.path) {
        Ok(metadata) => {
            if !metadata.file_type().is_file()
                || !same_identity(&held, &metadata)?
                || crate::vault::confine_delete_path(canonical_root, &stage.path.to_string_lossy())?
                    != stage.path
            {
                return Err("publication persisted but leftover stage identity changed; available copies retained".into());
            }
            std::fs::remove_file(&stage.path).map_err(|error| {
                format!("publication persisted but owned stage cleanup failed: {error}")
            })?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "publication persisted but stage inspection failed: {error}"
            ))
        }
    }
    // Rename/link can legitimately change ctime, so record the published
    // revision after ownership and fallback-link cleanup have been verified.
    let retained = RetainedFile::from_file(destination, file)?;
    if retained.revision != expected_revision {
        return Err("publication contents changed; available copies retained".into());
    }
    Ok(retained)
}

/// Stage a complete bucket outside the cooperating writer. Short transactions
/// admit the stage and commit after rechecking root/directories/source snapshots.
/// Partial unlink keeps the complete ZIP; member observations hold no handles.
#[cfg(test)]
fn pack_bucket(root: &Path, dir: &Path, zip_path: &Path) -> Result<(usize, u64, u64), String> {
    pack_bucket_impl(&ArchiveOperation::detached(root), dir, zip_path)
}

fn pack_bucket_impl(
    authority: &ArchiveOperation<'_>,
    requested_dir: &Path,
    requested_zip: &Path,
) -> Result<(usize, u64, u64), String> {
    let root = authority.root.as_path();
    let admitted_root = RetainedDirectory::capture(root)?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("canonicalize archive root: {error}"))?;
    let (dir, zip_path) =
        checked_archive_paths(&canonical_root, root, requested_dir, requested_zip)?;
    let parent = RetainedDirectory::capture(dir.parent().ok_or("archive bucket has no parent")?)?;
    let bucket = RetainedDirectory::capture(&dir)?;
    let (files, has_subdir) = loose_files(&dir)?;
    if has_subdir {
        return Err("bucket contains a subdirectory — packing it would flatten it".into());
    }
    if files.is_empty() {
        return Err("bucket is empty".into());
    }
    let sources = files
        .iter()
        .map(|path| ObservedFile::capture(path))
        .collect::<Result<Vec<_>, _>>()?;
    for source in &sources {
        let name = source
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("source filename is not UTF-8")?;
        if !plain_archive_name(name) {
            return Err("source filename is not a plain archive name".into());
        }
    }
    let loose_bytes = sources.iter().map(|source| source.metadata.len()).sum();
    let existing = match std::fs::symlink_metadata(&zip_path) {
        Ok(_) => Some(RetainedFile::capture(&zip_path)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("inspect archive: {error}")),
    };
    let mut staged: Option<ArchiveStage> = None;
    let preparation = (|| -> Result<(ArchiveContents, u64, String), String> {
        if let Some(archive) = &existing {
            let contents = archive_contents(&archive.file)?;
            archive.verify()?;
            return Ok((contents, archive.metadata.len(), archive.revision.clone()));
        }
        staged = Some(authority.mutate(|rechecked_root, guard| {
            if rechecked_root != canonical_root {
                return Err("archive root changed before stage creation".into());
            }
            bucket.verify()?;
            if checked_archive_paths(rechecked_root, root, requested_dir, requested_zip)?
                != (dir.clone(), zip_path.clone())
            {
                return Err("archive paths changed before stage creation".into());
            }
            ArchiveStage::create_locked(
                guard,
                &canonical_root,
                &admitted_root,
                &parent,
                ".myco-pack-",
                ".zip.part",
            )
        })?);
        #[cfg(test)]
        mutation_checkpoint(MutationCheckpoint::PackStageCreated)?;
        let stage = staged.as_mut().ok_or("archive stage is missing")?;
        {
            let mut writer = zip::ZipWriter::new(stage.temporary_mut()?.as_file_mut());
            let options = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            for source in &sources {
                let name = source
                    .path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or("source filename is not UTF-8")?;
                writer
                    .start_file(name, options)
                    .map_err(|error| format!("zip entry {name}: {error}"))?;
                writer
                    .write_all(&source.read()?)
                    .map_err(|error| format!("write entry {name}: {error}"))?;
            }
            writer
                .finish()
                .map_err(|error| format!("finish zip: {error}"))?
                .sync_all()
                .map_err(|error| format!("sync archive stage: {error}"))?;
        }
        stage.seal()?;
        verify_pack(&stage.path, &files)?;
        let contents = archive_contents(stage.temporary()?.as_file())?;
        let expected = stage.sealed.as_ref().ok_or("archive stage is not sealed")?;
        let prepared = (contents, expected.metadata.len(), expected.revision.clone());
        #[cfg(test)]
        mutation_checkpoint(MutationCheckpoint::PackPrepared)?;
        Ok(prepared)
    })();
    let (contents, zip_bytes, expected_zip_revision) = match preparation {
        Ok(prepared) => prepared,
        Err(error) => {
            return Err(
                match cleanup_archive_stage(
                    authority,
                    &canonical_root,
                    &admitted_root,
                    &parent,
                    &mut staged,
                ) {
                    Ok(()) => error,
                    Err(cleanup) => format!("{error}; {cleanup}"),
                },
            );
        }
    };
    let operation = authority.mutate(|rechecked_root, guard| {
        admitted_root.verify()?;
        parent.verify()?;
        bucket.verify()?;
        if rechecked_root != canonical_root
            || checked_archive_paths(rechecked_root, root, requested_dir, requested_zip)?
                != (dir.clone(), zip_path.clone())
        {
            return Err("archive paths changed during preparation".into());
        }
        let (current, subdir) = loose_files(&dir)?;
        if subdir || current != files {
            return Err("archive source set changed during preparation".into());
        }
        for source in &sources {
            source.verify()?;
            let name = source
                .path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or("source filename is not UTF-8")?;
            if contents.get(name) != Some(&(source.revision.clone(), source.metadata.len())) {
                return Err(format!(
                    "{} already exists but does not match {}",
                    zip_path.display(),
                    source.path.display()
                ));
            }
        }
        let published;
        let archive = if let Some(archive) = &existing {
            archive.verify()?;
            archive
        } else {
            published = publish_archive_stage(
                guard,
                &canonical_root,
                &admitted_root,
                &parent,
                staged.as_mut().ok_or("archive stage is missing")?,
                &zip_path,
            )?;
            &published
        };
        if archive.revision != expected_zip_revision {
            return Err(
                "published archive differs from its verified stage; originals retained".into(),
            );
        }
        archive.verify()?;
        #[cfg(test)]
        mutation_checkpoint(MutationCheckpoint::PackVerified)?;
        for (index, source) in sources.iter().enumerate() {
            #[cfg(not(test))]
            let _ = index;
            #[cfg(test)]
            mutation_checkpoint(MutationCheckpoint::PackBeforeDelete(index))?;
            crate::vault::confine_delete_path(rechecked_root, &source.path.to_string_lossy())?;
            archive.verify_identity()?;
            source.verify()?;
            std::fs::remove_file(&source.path)
                .map_err(|error| format!("remove {}: {error}", source.path.display()))?;
        }
        let _ = std::fs::remove_dir(&dir);
        Ok((sources.len(), loose_bytes, zip_bytes))
    });
    // The operation guard is released before cleanup takes the writer again.
    let cleanup = cleanup_archive_stage(
        authority,
        &canonical_root,
        &admitted_root,
        &parent,
        &mut staged,
    );
    match (operation, cleanup) {
        (Ok(result), Ok(())) => Ok(result),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(cleanup)) => Err(cleanup),
        (Err(error), Err(cleanup)) => Err(format!("{error}; {cleanup}")),
    }
}

/// Fresh packs require all originals by name and bytes. Interrupted resume
/// separately permits the exact remaining subset of a fully validated ZIP.
fn verify_pack(zip_path: &Path, originals: &[PathBuf]) -> Result<(), String> {
    let retained = RetainedFile::capture(zip_path)?;
    let contents = archive_contents(&retained.file)?;
    if contents.len() != originals.len() {
        return Err(format!(
            "archive holds {} entries, expected {}",
            contents.len(),
            originals.len()
        ));
    }
    for original in originals {
        let name = original
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("source filename is not UTF-8")?;
        let bytes = std::fs::read(original)
            .map_err(|error| format!("re-read {}: {error}", original.display()))?;
        if contents.get(name) != Some(&(archive_digest(&bytes), bytes.len() as u64)) {
            return Err(format!(
                "entry {name} does not match {}",
                original.display()
            ));
        }
    }
    retained.verify()
}

/// The `(YYYY-MM, YYYY-Www)` cutoff `older_than_months` before `now`. A bucket
/// compresses only when it sorts strictly BEFORE its tree's cutoff — both
/// formats are zero-padded, so lexicographic order is chronological order.
///
/// The day of month is clamped to 28 so the subtraction can never produce a
/// non-date like Feb 30. This is a month-granularity policy; being up to
/// three days off at the boundary of one ISO week is immaterial.
fn cutoff(now: i64, older_than_months: u32) -> (String, String) {
    let (y, m, ..) = crate::distill::civil_datetime(now);
    let total = y * 12 + i64::from(m) - 1 - i64::from(older_than_months);
    let (cy, cm) = (total.div_euclid(12), total.rem_euclid(12) as u32 + 1);
    let month = format!("{cy:04}-{cm:02}");
    let week = crate::distill::iso_week(&format!("{month}-28")).unwrap_or_default();
    (month, week)
}

/// Pack every allowed archive-tree bucket older than
/// `older_than_months`. Never automatic: only ever reached from the explicit
/// button in Settings → Distill.
#[cfg(test)]
pub fn compress(root: &Path, older_than_months: u32, now: i64) -> PackReport {
    compress_impl(&ArchiveOperation::detached(root), older_than_months, now)
}

fn compress_impl(authority: &ArchiveOperation<'_>, older_than_months: u32, now: i64) -> PackReport {
    let root = authority.root.as_path();
    let (cut_month, cut_week) = cutoff(now, older_than_months);
    let mut report = PackReport::default();
    for b in usage(root) {
        if b.packed {
            continue;
        }
        // `daily/archive/` buckets are ISO weeks; every other tree's are
        // months. Comparing a `YYYY-Www` id against a `YYYY-MM` cutoff would
        // never match ('W' sorts above every digit), so each tree is compared
        // against a cutoff in its own format.
        let cut = if b.tree == "daily" {
            &cut_week
        } else {
            &cut_month
        };
        if cut.is_empty() || b.bucket.as_str() >= cut.as_str() {
            continue; // inside the retention window — untouched
        }
        let Ok((dir, zip_path)) = bucket_paths(root, &b.tree, &b.bucket) else {
            continue; // `usage` already validated the shape; unreachable
        };
        match pack_bucket_impl(authority, &dir, &zip_path) {
            Ok((files, loose, packed)) => {
                report.buckets += 1;
                report.files += files;
                report.reclaimed += loose.saturating_sub(packed);
            }
            Err(e) => report.failed.push(format!("{}/{}: {e}", b.tree, b.bucket)),
        }
    }
    report
}

/// Restore entries with short cooperating-writer transactions. Create stages
/// under the writer, write outside it, never replace a destination, and retain
/// the ZIP if any observed destination changes before the final recheck. This is not a power-loss or
/// arbitrary external filesystem transaction guarantee.
#[cfg(test)]
pub fn restore(root: &Path, tree: &str, bucket: &str) -> Result<RestoreReport, String> {
    restore_impl(&ArchiveOperation::detached(root), tree, bucket)
}

fn restore_impl(
    authority: &ArchiveOperation<'_>,
    tree: &str,
    bucket: &str,
) -> Result<RestoreReport, String> {
    let root = authority.root.as_path();
    let (requested_dir, requested_zip) = bucket_paths(root, tree, bucket)?;
    let admitted_root = RetainedDirectory::capture(root)?;
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("canonicalize archive root: {error}"))?;
    let (dir, zip_path) =
        checked_archive_paths(&canonical_root, root, &requested_dir, &requested_zip)?;
    let parent = RetainedDirectory::capture(dir.parent().ok_or("archive bucket has no parent")?)?;
    let admitted_bucket = match std::fs::symlink_metadata(&dir) {
        Ok(_) => Some(RetainedDirectory::capture(&dir)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(format!("inspect restore bucket: {error}")),
    };
    let retained_zip = RetainedFile::capture(&zip_path)?;
    let contents = archive_contents(&retained_zip.file)?;
    retained_zip.verify()?;
    #[cfg(test)]
    mutation_checkpoint(MutationCheckpoint::RestorePrepared)?;
    let held_bucket = authority.mutate(|rechecked_root, _guard| {
        admitted_root.verify()?;
        parent.verify()?;
        retained_zip.verify_identity()?;
        if rechecked_root != canonical_root
            || checked_archive_paths(rechecked_root, root, &requested_dir, &requested_zip)?
                != (dir.clone(), zip_path.clone())
        {
            return Err("restore paths changed during preparation".into());
        }
        if let Some(bucket) = &admitted_bucket {
            bucket.verify()?;
        }
        match std::fs::symlink_metadata(&dir) {
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&dir)
                    .map_err(|error| format!("create {}: {error}", dir.display()))?;
            }
            Err(error) => return Err(format!("inspect restore bucket: {error}")),
        }
        RetainedDirectory::capture(&dir)
    })?;
    let mut archive = zip::ZipArchive::new(
        retained_zip
            .file
            .try_clone()
            .map_err(|error| format!("clone restore archive: {error}"))?,
    )
    .map_err(|error| format!("archive is not readable: {error}"))?;
    let mut restored: Vec<ObservedFile> = Vec::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("entry {index} unreadable: {error}"))?;
        let name = entry.name().to_string();
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|error| format!("entry {name} unreadable: {error}"))?;
        if contents.get(&name) != Some(&(archive_digest(&bytes), bytes.len() as u64)) {
            return Err(format!("archive entry {name} changed during restore"));
        }
        // Create beside the ZIP in a short writer transaction. The loose bucket
        // never includes temporary notes; writing and sync occur outside writer.
        let mut stage = Some(authority.mutate(|rechecked_root, guard| {
            if rechecked_root != canonical_root {
                return Err("restore root changed before stage creation".into());
            }
            held_bucket.verify()?;
            retained_zip.verify_identity()?;
            if checked_archive_paths(rechecked_root, root, &requested_dir, &requested_zip)?
                != (dir.clone(), zip_path.clone())
            {
                return Err("restore paths changed before stage creation".into());
            }
            ArchiveStage::create_locked(
                guard,
                &canonical_root,
                &admitted_root,
                &parent,
                ".myco-restore-",
                ".part",
            )
        })?);
        let preparation = (|| -> Result<(), String> {
            let stage = stage.as_mut().ok_or("restore stage is missing")?;
            stage
                .temporary_mut()?
                .write_all(&bytes)
                .map_err(|error| format!("write restore stage: {error}"))?;
            stage
                .temporary()?
                .as_file()
                .sync_all()
                .map_err(|error| format!("sync restore stage: {error}"))?;
            stage.seal()
        })();
        if let Err(error) = preparation {
            return Err(
                match cleanup_archive_stage(
                    authority,
                    &canonical_root,
                    &admitted_root,
                    &parent,
                    &mut stage,
                ) {
                    Ok(()) => error,
                    Err(cleanup) => format!("{error}; {cleanup}"),
                },
            );
        }
        let destination = dir.join(&name);
        let operation = authority.mutate(|rechecked_root, guard| {
            admitted_root.verify()?;
            parent.verify()?;
            held_bucket.verify()?;
            retained_zip.verify_identity()?;
            if rechecked_root != canonical_root
                || checked_archive_paths(rechecked_root, root, &requested_dir, &requested_zip)?
                    != (dir.clone(), zip_path.clone())
            {
                return Err("restore paths changed before publication".into());
            }
            crate::vault::confine_delete_path(rechecked_root, &destination.to_string_lossy())?;
            let retained = match std::fs::symlink_metadata(&destination) {
                Ok(_) => {
                    let existing = RetainedFile::capture(&destination)?;
                    if existing.read()? != bytes {
                        return Err(format!(
                            "{} already exists with different contents",
                            destination.display()
                        ));
                    }
                    existing
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    #[cfg(test)]
                    mutation_checkpoint(MutationCheckpoint::RestoreWrite)?;
                    // Recheck held directories after the test checkpoint as well.
                    // External namespace replacement is refused before path publish.
                    held_bucket.verify()?;
                    retained_zip.verify_identity()?;
                    publish_archive_stage(
                        guard,
                        &canonical_root,
                        &admitted_root,
                        &parent,
                        stage.as_mut().ok_or("restore stage is missing")?,
                        &destination,
                    )?
                }
                Err(error) => return Err(format!("inspect restore target: {error}")),
            };
            if retained.read()? != bytes {
                return Err(format!(
                    "{} did not read back as written; archive retained",
                    destination.display()
                ));
            }
            Ok(ObservedFile::from_retained(retained))
        });
        // No locking destructor: release publication guard before explicit cleanup.
        let cleanup = cleanup_archive_stage(
            authority,
            &canonical_root,
            &admitted_root,
            &parent,
            &mut stage,
        );
        let observed = match (operation, cleanup) {
            (Ok(observed), Ok(())) => observed,
            (Err(error), Ok(())) => return Err(error),
            (Ok(_), Err(cleanup)) => return Err(cleanup),
            (Err(error), Err(cleanup)) => return Err(format!("{error}; {cleanup}")),
        };
        for previous in &restored {
            if same_identity(&previous.metadata, &observed.metadata)? {
                return Err(
                    "archive entries resolve to the same destination; archive retained".into(),
                );
            }
        }
        restored.push(observed);
    }
    drop(archive);
    // The checkpoint allows a queued legitimate writer to settle before the
    // final transaction. Holding the writer here would deadlock that witness.
    #[cfg(test)]
    mutation_checkpoint(MutationCheckpoint::RestoreFinalize)?;
    authority.mutate(|rechecked_root, _guard| {
        admitted_root.verify()?;
        parent.verify()?;
        held_bucket.verify()?;
        if rechecked_root != canonical_root
            || checked_archive_paths(rechecked_root, root, &requested_dir, &requested_zip)?
                != (dir.clone(), zip_path.clone())
        {
            return Err("restore paths changed before finalization".into());
        }
        retained_zip.verify()?;
        for destination in &restored {
            crate::vault::confine_delete_path(rechecked_root, &destination.path.to_string_lossy())?;
            destination.verify()?;
        }
        std::fs::remove_file(&zip_path)
            .map_err(|error| format!("remove {}: {error}", zip_path.display()))?;
        Ok(RestoreReport {
            files: contents.len(),
            bytes: contents.values().map(|(_, size)| size).sum(),
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn seed(root: &Path, rel: &str, files: &[(&str, &str)]) {
        let dir = root.join(rel);
        std::fs::create_dir_all(&dir).unwrap();
        for (name, body) in files {
            std::fs::write(dir.join(name), body).unwrap();
        }
    }

    // 2026-08-20T00:00:00Z.
    const NOW: i64 = 1_787_184_000;

    #[test]
    fn compress_then_restore_round_trips_byte_identically() {
        let tmp = vault();
        let root = tmp.path();
        let bodies = [
            ("a.md", "# one\nbody\n"),
            ("b.md", "# two\n\u{d55c}\u{ae00} \u{1f331}\n"),
            ("c.md", ""),
        ];
        seed(root, "sessions/archive/2026-01", &bodies);
        seed(root, "daily/archive/2026-W02", &bodies);

        let report = compress(root, 3, NOW);
        assert_eq!(report.buckets, 2, "failed: {:?}", report.failed);
        assert_eq!(report.files, 6);
        assert!(root.join("sessions/archive/2026-01.zip").is_file());
        assert!(!root.join("sessions/archive/2026-01").exists());
        assert!(root.join("daily/archive/2026-W02.zip").is_file());

        for (tree, bucket, rel) in [
            ("sessions", "2026-01", "sessions/archive/2026-01"),
            ("daily", "2026-W02", "daily/archive/2026-W02"),
        ] {
            let out = restore(root, tree, bucket).unwrap();
            assert_eq!(out.files, 3);
            for (name, body) in &bodies {
                let got = std::fs::read(root.join(rel).join(name)).unwrap();
                assert_eq!(got, body.as_bytes(), "{rel}/{name}");
            }
            assert!(!root.join(format!("{rel}.zip")).exists(), "zip not removed");
        }
    }

    #[test]
    fn the_weekly_archive_tree_compresses_on_the_month_cutoff() {
        let tmp = vault();
        let root = tmp.path();
        // `weekly/archive/` holds rolled-up weeklies bucketed by MONTH (see
        // `distill::MONTHLY`), so it is compared against the month cutoff like
        // `sessions/`, not against the week cutoff `daily/` uses.
        seed(root, "weekly/archive/2026-02", &[("2026-W06.md", "# w6\n")]);
        seed(
            root,
            "weekly/archive/2026-07",
            &[("2026-W28.md", "# w28\n")],
        );

        let report = compress(root, 3, NOW);
        assert_eq!(report.buckets, 1, "failed: {:?}", report.failed);
        assert!(root.join("weekly/archive/2026-02.zip").is_file());
        assert!(
            root.join("weekly/archive/2026-07/2026-W28.md").is_file(),
            "inside the retention window — untouched"
        );

        let out = restore(root, "weekly", "2026-02").unwrap();
        assert_eq!(out.files, 1);
        assert_eq!(
            std::fs::read_to_string(root.join("weekly/archive/2026-02/2026-W06.md")).unwrap(),
            "# w6\n"
        );
    }

    #[test]
    fn a_bucket_newer_than_the_cutoff_is_untouched() {
        let tmp = vault();
        let root = tmp.path();
        // NOW is 2026-08; a 3-month cutoff lands on 2026-05.
        seed(root, "sessions/archive/2026-05", &[("keep.md", "x")]);
        seed(root, "sessions/archive/2026-07", &[("keep.md", "x")]);
        seed(root, "sessions/archive/2026-04", &[("go.md", "x")]);
        seed(root, "daily/archive/2026-W30", &[("keep.md", "x")]);

        let report = compress(root, 3, NOW);
        assert_eq!(report.buckets, 1, "failed: {:?}", report.failed);
        assert!(root.join("sessions/archive/2026-04.zip").is_file());
        assert!(root.join("sessions/archive/2026-05/keep.md").is_file());
        assert!(root.join("sessions/archive/2026-07/keep.md").is_file());
        assert!(root.join("daily/archive/2026-W30/keep.md").is_file());
    }

    #[test]
    fn raw_and_traversal_paths_are_refused() {
        let tmp = vault();
        let root = tmp.path();
        for (tree, bucket) in [
            ("raw", "2026-01"),
            ("raw/archive", "2026-01"),
            ("..", "2026-01"),
            ("wiki", "2026-01"),
        ] {
            let err = bucket_paths(root, tree, bucket).unwrap_err();
            assert!(err.contains("unknown archive tree"), "{tree}: {err}");
        }
        for bad in ["../../raw", "2026-1", "2026-01/../..", "2026-W01"] {
            assert!(bucket_paths(root, "sessions", bad).is_err(), "{bad}");
        }
        // `restore` refuses through the same choke point.
        assert!(restore(root, "raw", "2026-01").is_err());
    }

    #[test]
    fn raw_archive_is_never_compressed() {
        let tmp = vault();
        let root = tmp.path();
        seed(root, "raw/archive/2026-01", &[("source.pdf.md", "x")]);
        seed(root, "sessions/archive/2026-01", &[("s.md", "x")]);

        let report = compress(root, 3, NOW);
        assert_eq!(report.buckets, 1);
        assert!(root.join("raw/archive/2026-01/source.pdf.md").is_file());
        assert!(!root.join("raw/archive/2026-01.zip").exists());
        assert!(usage(root).iter().all(|b| b.tree != "raw"));
    }

    #[test]
    fn a_failed_verification_leaves_every_original_in_place() {
        let tmp = vault();
        let root = tmp.path();
        seed(
            root,
            "sessions/archive/2026-01",
            &[("a.md", "one"), ("b.md", "two")],
        );

        FAIL_VERIFY_FOR_TEST.set(true);
        let report = compress(root, 3, NOW);
        FAIL_VERIFY_FOR_TEST.set(false);

        assert_eq!(report.buckets, 0);
        assert_eq!(report.reclaimed, 0);
        assert_eq!(report.failed.len(), 1, "{:?}", report.failed);
        assert_eq!(
            std::fs::read_to_string(root.join("sessions/archive/2026-01/a.md")).unwrap(),
            "one"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("sessions/archive/2026-01/b.md")).unwrap(),
            "two"
        );
        assert!(
            !root.join("sessions/archive/2026-01.zip").exists(),
            "no half-archive left"
        );
        assert!(
            !root.join("sessions/archive/2026-01.zip.part").exists(),
            "part not cleaned up"
        );

        // And the retry after the fault clears succeeds.
        assert_eq!(compress(root, 3, NOW).buckets, 1);
    }

    #[test]
    fn verify_pack_rejects_a_truncated_archive() {
        let tmp = vault();
        let root = tmp.path();
        seed(
            root,
            "sessions/archive/2026-01",
            &[("a.md", "one"), ("b.md", "two")],
        );
        let (dir, zip_path) = bucket_paths(root, "sessions", "2026-01").unwrap();
        let (files, _) = loose_files(&dir).unwrap();

        // An archive holding only the FIRST of the two originals.
        let f = std::fs::File::create(&zip_path).unwrap();
        let mut zw = zip::ZipWriter::new(f);
        let opts = zip::write::SimpleFileOptions::default();
        zw.start_file("a.md", opts).unwrap();
        zw.write_all(b"one").unwrap();
        zw.finish().unwrap();
        assert!(verify_pack(&zip_path, &files)
            .unwrap_err()
            .contains("expected 2"));

        // And a full-count archive whose bytes disagree.
        std::fs::remove_file(&zip_path).unwrap();
        let f = std::fs::File::create(&zip_path).unwrap();
        let mut zw = zip::ZipWriter::new(f);
        for (name, body) in [("a.md", "one"), ("b.md", "WRONG")] {
            zw.start_file(name, opts).unwrap();
            zw.write_all(body.as_bytes()).unwrap();
        }
        zw.finish().unwrap();
        assert!(verify_pack(&zip_path, &files)
            .unwrap_err()
            .contains("does not match"));
    }

    #[test]
    fn usage_reports_loose_and_packed_buckets() {
        let tmp = vault();
        let root = tmp.path();
        seed(root, "sessions/archive/2026-01", &[("a.md", "0123456789")]);
        seed(root, "sessions/archive/2026-07", &[("b.md", "01234")]);
        seed(root, "daily/archive/2026-W02", &[("c.md", "012")]);
        seed(
            root,
            "sessions/archive/not-a-bucket",
            &[("x.md", "ignored")],
        );

        let before = usage(root);
        assert_eq!(before.len(), 3, "{before:?}");
        assert!(before.iter().all(|b| !b.packed));
        assert_eq!(
            before.iter().find(|b| b.bucket == "2026-01").unwrap().bytes,
            10
        );

        compress(root, 3, NOW);
        let after = usage(root);
        let packed: Vec<_> = after.iter().filter(|b| b.packed).collect();
        assert_eq!(packed.len(), 2, "{after:?}");
        assert!(packed.iter().all(|b| b.files == 1 && b.bytes > 0));
        assert_eq!(after.iter().filter(|b| !b.packed).count(), 1);
    }

    #[test]
    fn an_interrupted_pack_finishes_instead_of_deadlocking() {
        // Kill (or one failed unlink) between "archive renamed into place" and
        // "originals removed" used to leave BOTH: pack said "restore first",
        // restore said "already exists", and the bucket was stuck for good.
        let tmp = vault();
        let root = tmp.path();
        let dir = root.join("sessions/archive/2026-01");
        seed(
            root,
            "sessions/archive/2026-01",
            &[("a.md", "one"), ("b.md", "two")],
        );
        let zip = root.join("sessions/archive/2026-01.zip");
        pack_bucket(root, &dir, &zip).unwrap();
        // Re-create exactly the archived files: the interrupted-unlink state.
        seed(
            root,
            "sessions/archive/2026-01",
            &[("a.md", "one"), ("b.md", "two")],
        );
        assert!(zip.is_file() && dir.join("a.md").is_file());

        let (files, _, _) =
            pack_bucket(root, &dir, &zip).expect("must finish the interrupted pack");
        assert_eq!(files, 2);
        assert!(!dir.exists(), "loose files must be gone once verified");
        assert!(zip.is_file());
        // And the archive still restores.
        let report = restore(root, "sessions", "2026-01").unwrap();
        assert_eq!(report.files, 2);
        assert_eq!(std::fs::read_to_string(dir.join("a.md")).unwrap(), "one");
    }

    #[test]
    fn a_partial_restore_can_be_retried() {
        // Disk full at file N left the already-written files in place and
        // every retry failing on entry 0 ("already exists").
        let tmp = vault();
        let root = tmp.path();
        let dir = root.join("sessions/archive/2026-02");
        seed(
            root,
            "sessions/archive/2026-02",
            &[("a.md", "one"), ("b.md", "two")],
        );
        pack_bucket(root, &dir, &root.join("sessions/archive/2026-02.zip")).unwrap();
        // Simulate a restore that got one file out before dying.
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.md"), "one").unwrap();

        let report = restore(root, "sessions", "2026-02").expect("retry must succeed");
        assert_eq!(report.files, 2);
        assert_eq!(std::fs::read_to_string(dir.join("b.md")).unwrap(), "two");

        // But a file that exists with DIFFERENT bytes is the user's, not ours.
        seed(root, "sessions/archive/2026-03", &[("c.md", "orig")]);
        let dir3 = root.join("sessions/archive/2026-03");
        pack_bucket(root, &dir3, &root.join("sessions/archive/2026-03.zip")).unwrap();
        std::fs::create_dir_all(&dir3).unwrap();
        std::fs::write(dir3.join("c.md"), "edited by hand").unwrap();
        let err = restore(root, "sessions", "2026-03").expect_err("must refuse to clobber");
        assert!(err.contains("different contents"), "{err}");
        assert_eq!(
            std::fs::read_to_string(dir3.join("c.md")).unwrap(),
            "edited by hand"
        );
    }

    #[test]
    fn packing_over_an_existing_archive_is_refused() {
        let tmp = vault();
        let root = tmp.path();
        seed(root, "sessions/archive/2026-01", &[("a.md", "one")]);
        compress(root, 3, NOW);
        // A later run re-creates the month directory (a backdated session).
        seed(root, "sessions/archive/2026-01", &[("b.md", "two")]);

        let report = compress(root, 3, NOW);
        assert_eq!(report.buckets, 0);
        assert!(
            report.failed[0].contains("already exists"),
            "{:?}",
            report.failed
        );
        assert!(root.join("sessions/archive/2026-01/b.md").is_file());
    }

    #[test]
    fn cutoff_walks_back_across_the_year_boundary() {
        assert_eq!(cutoff(NOW, 3).0, "2026-05");
        assert_eq!(cutoff(NOW, 8).0, "2025-12");
        assert_eq!(cutoff(NOW, 20).0, "2024-12");
        assert_eq!(cutoff(NOW, 0).0, "2026-08");
        // 2026-05-28 is a Thursday in ISO week 22.
        assert_eq!(cutoff(NOW, 3).1, "2026-W22");
    }
}
