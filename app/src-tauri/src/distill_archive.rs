//! Revision-bound archive journal. Filesystem recovery is explicit and limited
//! to this journal; it does not transact the earlier note/coverage publication.

use super::*;
use sha2::{Digest, Sha256};
use std::sync::Mutex;

static MANIFEST_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
#[path = "distill_archive_mutation_tests.rs"]
mod mutation_tests;

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ArchivePublication {
    pub path: String,
    pub revision: String,
    pub created: bool,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveMove {
    pub from: String,
    pub to: String,
    pub revision: String,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct ArchivePending {
    pub path: String,
    pub reason: String,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveReceipt {
    pub manifest_id: String,
    pub moved: Vec<ArchiveMove>,
    pub pending: Vec<ArchivePending>,
    pub skipped: Vec<ArchivePending>,
    pub created_note_paths: Vec<String>,
    pub retryable: bool,
}

pub(crate) struct ArchiveContext {
    pub manifest_id: String,
    pub publications: Vec<ArchivePublication>,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub(super) struct ArchivePlan {
    pub from: String,
    pub to: String,
    pub fingerprint: String,
    pub revision: String,
}

#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub(super) struct ArchiveJournal {
    kind: String,
    bucket: String,
    files: Vec<String>,
    fingerprints: Option<Vec<String>>,
    publications: Vec<ArchivePublication>,
    #[serde(default)]
    pub plans: Vec<ArchivePlan>,
}

pub(super) fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn checked_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let path = crate::myco_pro::safe_join(root, rel)?;
    crate::vault::confine_delete_path(root, &path.to_string_lossy())
}

fn is_raw(rel: &str) -> bool {
    rel.trim()
        .split('/')
        .next()
        .is_some_and(|component| component.eq_ignore_ascii_case("raw"))
}

fn read_optional(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

fn load(root: &Path, id: &str) -> Result<(RunManifest, Option<String>), String> {
    if !valid_lookup_id(id) {
        return Err(format!("bad manifest id `{id}`"));
    }
    let path = crate::vault::confine_delete_path(root, &manifest_path(root, id).to_string_lossy())?;
    match read_optional(&path)? {
        Some(bytes) => {
            let manifest: RunManifest =
                serde_json::from_slice(&bytes).map_err(|e| format!("parse manifest {id}: {e}"))?;
            if manifest.id != id {
                return Err("manifest identity differs from its file name".into());
            }
            Ok((manifest, Some(sha(&bytes))))
        }
        None => Ok((
            RunManifest {
                id: id.into(),
                started_at: now_secs(),
                ..Default::default()
            },
            None,
        )),
    }
}

fn persist(
    root: &Path,
    manifest: &RunManifest,
    expected: &mut Option<String>,
) -> Result<(), String> {
    let target = crate::vault::confine_delete_path(
        root,
        &manifest_path(root, &manifest.id).to_string_lossy(),
    )?;
    std::fs::create_dir_all(target.parent().ok_or("manifest has no parent")?)
        .map_err(|e| format!("create manifest directory: {e}"))?;
    let raw =
        serde_json::to_string_pretty(manifest).map_err(|e| format!("serialize manifest: {e}"))?;
    crate::vault::write_file_if_unchanged(&target.to_string_lossy(), &raw, expected.as_deref())?;
    *expected = Some(sha(raw.as_bytes()));
    Ok(())
}

fn verify_publications(root: &Path, publications: &[ArchivePublication]) -> Result<(), String> {
    for publication in publications {
        if publication.revision.len() != 64
            || !publication
                .revision
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("publication revision must be lowercase SHA256".into());
        }
        let path = checked_path(root, &publication.path)?;
        let bytes = read_optional(&path)?.ok_or("publication is missing")?;
        if sha(&bytes) != publication.revision {
            return Err(format!("publication changed: {}", publication.path));
        }
    }
    Ok(())
}

fn record_created(
    manifest: &mut RunManifest,
    publications: &[ArchivePublication],
) -> Result<(), String> {
    for publication in publications.iter().filter(|p| p.created) {
        if manifest
            .created_revisions
            .get(&publication.path)
            .is_some_and(|revision| revision != &publication.revision)
        {
            return Err(format!(
                "created note lineage changed: {}",
                publication.path
            ));
        }
        if !manifest.created.contains(&publication.path) {
            manifest.created.push(publication.path.clone());
        }
        manifest
            .created_revisions
            .insert(publication.path.clone(), publication.revision.clone());
    }
    Ok(())
}

pub(super) fn append_checked(
    root: &Path,
    id: &str,
    moves: Vec<MoveEntry>,
    publications: Vec<ArchivePublication>,
) -> Result<(), String> {
    let _guard = MANIFEST_LOCK.lock().map_err(|_| "manifest lock poisoned")?;
    if !valid_manifest_id(id) {
        return Err(format!("bad manifest id `{id}`"));
    }
    verify_publications(root, &publications)?;
    let (mut manifest, mut revision) = load(root, id)?;
    record_created(&mut manifest, &publications)?;
    for moved in moves {
        if is_raw(&moved.from) || is_raw(&moved.to) {
            return Err("raw origins cannot be moved by manifest bookkeeping".into());
        }
        let from = checked_path(root, &moved.from)?;
        let to = checked_path(root, &moved.to)?;
        if read_optional(&from)?.is_some() {
            return Err("manifest move source still exists".into());
        }
        let bytes = read_optional(&to)?.ok_or("manifest move destination is missing")?;
        let hash = sha(&bytes);
        if manifest
            .move_revisions
            .get(&moved.to)
            .is_some_and(|revision| revision != &hash)
        {
            return Err("manifest move destination changed".into());
        }
        if !manifest
            .moves
            .iter()
            .any(|m| m.from == moved.from && m.to == moved.to)
        {
            manifest.moves.push(moved.clone());
        }
        manifest.move_revisions.insert(moved.to, hash);
    }
    persist(root, &manifest, &mut revision)
}

#[cfg(test)]
pub(super) fn append_legacy(
    root: &Path,
    id: &str,
    moves: Vec<MoveEntry>,
    created: Vec<String>,
) -> Result<(), String> {
    let publications = created
        .into_iter()
        .map(|path| {
            let target = checked_path(root, &path)?;
            let bytes = read_optional(&target)?.ok_or("created note is missing")?;
            Ok(ArchivePublication {
                path,
                revision: sha(&bytes),
                created: true,
            })
        })
        .collect::<Result<_, String>>()?;
    append_checked(root, id, moves, publications)
}

fn validate_plans(root: &Path, journal: &ArchiveJournal, archive_dir: &Path) -> Result<(), String> {
    let mut destinations = std::collections::HashSet::new();
    let mut sources = std::collections::HashSet::new();
    for plan in &journal.plans {
        let index = journal
            .files
            .iter()
            .position(|source| source == &plan.from)
            .ok_or("archive plan source is outside its request")?;
        if !sources.insert(&plan.from) || !destinations.insert(&plan.to) {
            return Err("duplicate archive journal plan".into());
        }
        let destination = checked_path(root, &plan.to)?;
        if destination.parent() != Some(archive_dir) || is_raw(&plan.to) {
            return Err("archive plan destination is outside its archive bucket".into());
        }
        if plan.revision.len() != 64
            || !plan
                .revision
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("archive plan revision must be lowercase SHA256".into());
        }
        if journal
            .fingerprints
            .as_ref()
            .is_some_and(|fingerprints| fingerprints.get(index) != Some(&plan.fingerprint))
        {
            return Err("archive plan fingerprint differs from published evidence".into());
        }
    }
    Ok(())
}

fn receipt(manifest: &RunManifest) -> ArchiveReceipt {
    ArchiveReceipt {
        manifest_id: manifest.id.clone(),
        created_note_paths: manifest.created.clone(),
        retryable: true,
        ..Default::default()
    }
}

fn pending(receipt: &mut ArchiveReceipt, path: &str, reason: impl Into<String>) {
    receipt.pending.push(ArchivePending {
        path: path.into(),
        reason: reason.into(),
    });
}

#[cfg(test)]
#[derive(Clone, Copy, PartialEq)]
enum MoveCheckpoint {
    WriterLock,
    Link,
    Unlink,
}

/// Link before unlink makes destination creation non-overwriting. The durable
/// intent precedes either step, so recovery can recognize both names after a
/// crash. Hash/inode checks cover cooperating app writers; this is not an OS
/// transaction against arbitrary external writers changing directory entries.
fn move_planned(
    root: &Path,
    plan: &ArchivePlan,
    #[cfg(test)] mut checkpoint: impl FnMut(MoveCheckpoint),
) -> Result<(), String> {
    #[cfg(test)]
    checkpoint(MoveCheckpoint::WriterLock);
    let _writer = crate::vault::lock_file_mutation()?;
    let from = checked_path(root, &plan.from)?;
    let to = checked_path(root, &plan.to)?;
    let source = read_optional(&from)?;
    let destination = read_optional(&to)?;
    if source.is_none() {
        return if destination.as_ref().is_some_and(|bytes| {
            sha(bytes) == plan.revision && content_fingerprint(bytes) == plan.fingerprint
        }) {
            Ok(())
        } else {
            Err("source missing without a verified archive destination".into())
        };
    }
    if !source.as_ref().is_some_and(|bytes| {
        sha(bytes) == plan.revision && content_fingerprint(bytes) == plan.fingerprint
    }) {
        return Err("source revision changed".into());
    }
    if destination.is_none() {
        #[cfg(test)]
        checkpoint(MoveCheckpoint::Link);
        std::fs::hard_link(&from, &to)
            .map_err(|e| format!("create non-overwriting archive link: {e}"))?;
    }
    let archived = read_optional(&to)?.ok_or("archive destination disappeared")?;
    if sha(&archived) != plan.revision {
        return Err("archive destination revision changed".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let a = std::fs::metadata(&from).map_err(|e| format!("inspect source: {e}"))?;
        let b = std::fs::metadata(&to).map_err(|e| format!("inspect archive: {e}"))?;
        if a.dev() != b.dev() || a.ino() != b.ino() {
            return Err("source and archive are distinct files; manual recovery required".into());
        }
    }
    #[cfg(not(unix))]
    if destination.is_some() {
        return Err("two-name archive recovery requires file identity support".into());
    }
    if !read_optional(&from)?.is_some_and(|bytes| sha(&bytes) == plan.revision) {
        return Err("source revision changed before unlink".into());
    }
    #[cfg(test)]
    checkpoint(MoveCheckpoint::Unlink);
    std::fs::remove_file(&from).map_err(|e| format!("remove archived source name: {e}"))?;
    if !read_optional(&to)?.is_some_and(|bytes| sha(&bytes) == plan.revision) {
        // Restore only into an absent source name. Never overwrite a new source.
        std::fs::hard_link(&to, &from)
            .map_err(|e| format!("changed archive needs manual recovery: {e}"))?;
        return Err("archive bytes changed; source name restored for retry".into());
    }
    Ok(())
}

pub(super) struct ArchiveInput<'a> {
    pub kind: &'a str,
    pub bucket: &'a str,
    pub archive_dir: String,
    pub files: &'a [String],
    pub fingerprints: Option<&'a [String]>,
    pub recorded: &'a std::collections::HashSet<String>,
    pub payload_ok: fn(&str) -> bool,
    pub context: Option<&'a ArchiveContext>,
}

pub(super) fn archive(root: &Path, input: ArchiveInput<'_>) -> Result<ArchiveReceipt, String> {
    let _guard = MANIFEST_LOCK.lock().map_err(|_| "manifest lock poisoned")?;
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("canonicalize archive vault: {e}"))?;
    let root = canonical_root.as_path();
    if input
        .fingerprints
        .is_some_and(|fps| fps.len() != input.files.len())
    {
        return Err("fingerprint count differs from source count".into());
    }
    if input
        .files
        .iter()
        .collect::<std::collections::HashSet<_>>()
        .len()
        != input.files.len()
    {
        return Err("duplicate archive source".into());
    }
    for path in input.files {
        if !(input.payload_ok)(path) {
            return Err(format!("invalid {} archive source: {path}", input.kind));
        }
        checked_path(root, path)?;
    }
    let archive_dir = checked_path(root, &input.archive_dir)?;
    let id = input
        .context
        .map(|c| c.manifest_id.clone())
        .unwrap_or_else(|| free_manifest_id(root, &format!("digest-{}", now_secs())));
    if !valid_manifest_id(&id) {
        return Err(format!("bad manifest id `{id}`"));
    }
    let publications = input
        .context
        .map(|c| c.publications.clone())
        .unwrap_or_default();
    verify_publications(root, &publications)?;
    let journal = ArchiveJournal {
        kind: input.kind.into(),
        bucket: input.bucket.into(),
        files: input.files.into(),
        fingerprints: input.fingerprints.map(<[String]>::to_vec),
        publications,
        plans: Vec::new(),
    };
    let (mut manifest, mut revision) = load(root, &id)?;
    if let Some(existing) = &manifest.archive {
        let mut expected = journal.clone();
        let mut actual = existing.clone();
        actual.plans.clear();
        // `created` changes to false on a retry of a previously created note.
        for p in &mut actual.publications {
            p.created = false;
        }
        for p in &mut expected.publications {
            p.created = false;
        }
        if actual != expected {
            return Err("archive manifest is bound to a different request".into());
        }
        validate_plans(root, existing, &archive_dir)?;
    } else {
        if !manifest.moves.is_empty() || !manifest.created.is_empty() {
            return Err("archive manifest id already belongs to another operation".into());
        }
        record_created(&mut manifest, &journal.publications)?;
        manifest.archive = Some(journal);
        persist(root, &manifest, &mut revision)?;
    }
    let mut result = receipt(&manifest);
    if input.files.is_empty() {
        result.retryable = false;
        return Ok(result);
    }
    if let Err(error) = std::fs::create_dir_all(&archive_dir) {
        for source in input.files {
            pending(
                &mut result,
                source,
                format!("create archive directory: {error}"),
            );
        }
        return Ok(result);
    }
    for (index, source) in input.files.iter().enumerate() {
        if let Err(error) =
            verify_publications(root, &manifest.archive.as_ref().unwrap().publications)
        {
            pending(&mut result, source, error);
            continue;
        }
        let existing_plan = manifest
            .archive
            .as_ref()
            .unwrap()
            .plans
            .iter()
            .find(|p| &p.from == source)
            .cloned();
        let plan = match existing_plan {
            Some(plan) => plan,
            None => {
                let from = match checked_path(root, source) {
                    Ok(from) => from,
                    Err(error) => {
                        pending(&mut result, source, error);
                        continue;
                    }
                };
                let bytes = match read_optional(&from) {
                    Ok(Some(bytes)) => bytes,
                    Ok(None) => {
                        pending(
                            &mut result,
                            source,
                            "source missing without a journaled move",
                        );
                        continue;
                    }
                    Err(error) => {
                        pending(&mut result, source, error);
                        continue;
                    }
                };
                let fingerprint = content_fingerprint(&bytes);
                if let Some(expected) = input.fingerprints {
                    if fingerprint != expected[index] {
                        pending(
                            &mut result,
                            source,
                            "source fingerprint changed since evidence publication",
                        );
                        continue;
                    }
                } else if !is_recorded(
                    input.recorded,
                    from.file_stem().and_then(|s| s.to_str()).unwrap_or(""),
                    &fingerprint,
                ) {
                    pending(
                        &mut result,
                        source,
                        "source revision is not covered by a digest marker",
                    );
                    continue;
                }
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    let metadata = match std::fs::metadata(&from) {
                        Ok(metadata) => metadata,
                        Err(error) => {
                            pending(&mut result, source, format!("inspect source: {error}"));
                            continue;
                        }
                    };
                    if metadata.nlink() > 1 {
                        pending(&mut result, source, "source has unowned hard links");
                        continue;
                    }
                }
                let to = free_path(
                    &archive_dir.join(from.file_name().ok_or("archive source has no name")?),
                );
                if let Err(error) = checked_path(root, &rel_string(root, &to)) {
                    pending(&mut result, source, error);
                    continue;
                }
                let plan = ArchivePlan {
                    from: source.clone(),
                    to: rel_string(root, &to),
                    fingerprint,
                    revision: sha(&bytes),
                };
                manifest.archive.as_mut().unwrap().plans.push(plan.clone());
                if let Err(error) = persist(root, &manifest, &mut revision) {
                    pending(
                        &mut result,
                        source,
                        format!("journal intent not persisted: {error}"),
                    );
                    for remaining in &input.files[index + 1..] {
                        pending(&mut result, remaining, "journal conflict stopped archive");
                    }
                    break;
                }
                plan
            }
        };
        if let Err(error) = move_planned(
            root,
            &plan,
            #[cfg(test)]
            |_| {},
        ) {
            pending(&mut result, source, error);
            continue;
        }
        result.moved.push(ArchiveMove {
            from: plan.from.clone(),
            to: plan.to.clone(),
            revision: plan.revision.clone(),
        });
        if !manifest
            .moves
            .iter()
            .any(|m| m.from == plan.from && m.to == plan.to)
        {
            manifest.moves.push(MoveEntry {
                from: plan.from.clone(),
                to: plan.to.clone(),
            });
            manifest.move_revisions.insert(plan.to, plan.revision);
            if let Err(error) = persist(root, &manifest, &mut revision) {
                pending(
                    &mut result,
                    source,
                    format!("move completed; journal completion pending: {error}"),
                );
                for remaining in &input.files[index + 1..] {
                    pending(&mut result, remaining, "journal conflict stopped archive");
                }
                break;
            }
        }
    }
    result.retryable = !result.pending.is_empty();
    Ok(result)
}

pub(super) fn undo_checked(root: &Path, id: &str) -> Result<usize, String> {
    let _guard = MANIFEST_LOCK.lock().map_err(|_| "manifest lock poisoned")?;
    let (manifest, _) = load(root, id)?;
    let mut reversed = 0;
    for entry in manifest.trashed.iter().chain(manifest.moves.iter()).rev() {
        if is_raw(&entry.from) || is_raw(&entry.to) {
            eprintln!("distill undo {id}: raw origin preserved");
            continue;
        }
        let from = checked_path(root, &entry.from)?;
        let to = checked_path(root, &entry.to)?;
        if let Some(revision) = manifest.move_revisions.get(&entry.to) {
            if read_optional(&from)?.is_some()
                || !read_optional(&to)?.is_some_and(|bytes| sha(&bytes) == *revision)
            {
                eprintln!(
                    "distill undo {id}: move revision or destination changed: {}",
                    entry.to
                );
                continue;
            }
            std::fs::create_dir_all(from.parent().ok_or("restore source has no parent")?)
                .map_err(|e| format!("create restore parent: {e}"))?;
            std::fs::hard_link(&to, &from)
                .map_err(|e| format!("restore non-overwriting source: {e}"))?;
            std::fs::remove_file(&to)
                .map_err(|e| format!("remove archive name after restore: {e}"))?;
            reversed += 1;
        } else {
            eprintln!(
                "distill undo {id}: move has no byte revision; manual recovery required: {}",
                entry.to
            );
        }
    }
    for rel in manifest.created.iter().rev() {
        if is_raw(rel) {
            eprintln!("distill undo {id}: raw origin preserved");
            continue;
        }
        let path = checked_path(root, rel)?;
        let Some(bytes) = read_optional(&path)? else {
            continue;
        };
        let unchanged = match manifest.created_revisions.get(rel) {
            Some(revision) => sha(&bytes) == *revision,
            // A timestamp cannot establish ownership of the current bytes.
            None => false,
        };
        if !unchanged {
            eprintln!("distill undo {id}: created note changed: {rel}");
            continue;
        }
        std::fs::remove_file(&path).map_err(|e| format!("remove unchanged created note: {e}"))?;
        reversed += 1;
    }
    Ok(reversed)
}
