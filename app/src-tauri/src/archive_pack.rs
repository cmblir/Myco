// Archive compaction for the cold tier (Settings → Distill).
//
// `sessions/archive/<YYYY-MM>/` and `daily/archive/<YYYY-Www>/` only ever
// grow: `vector_index::is_cold` keeps them out of the index, the prune drops
// their records, and nothing ever reclaims the disk. This packs a whole
// bucket into one deflated zip beside it, and unpacks it again.
//
// SCOPE, ENFORCED: this module touches `sessions/archive/` and
// `daily/archive/` and NOTHING else. `raw/` — including `raw/archive/` — is
// immutable through every path in this app, and it is deliberately absent
// from `TREES` below, which is the ONLY place a tree name becomes a
// directory. Both untrusted inputs (`tree`, `bucket`) go through
// `bucket_paths`, which checks the tree against that closed list and the
// bucket against its exact `YYYY-MM` / `YYYY-Www` shape before
// `myco_pro::safe_join` is ever called, so neither `raw` nor `..` is
// spellable.
//
// Zip, not tar.gz: `zip` is already a direct dependency (Cargo.toml, used by
// `extract.rs` and `mcp_native.rs`), so this adds no dependency at all, and
// its central directory makes the post-write verification below a cheap
// per-entry read instead of a full stream decode.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};

/// The two archive trees this module owns, `(tree name, vault-relative dir)`.
/// `raw` is NOT here and must never be added: `raw/` is immutable.
const TREES: [(&str, &str); 2] = [("sessions", "sessions/archive"), ("daily", "daily/archive")];

/// One archive bucket, loose or already packed.
#[derive(serde::Serialize, Debug, PartialEq)]
pub struct BucketUsage {
    /// `"sessions"` or `"daily"`.
    pub tree: String,
    /// `YYYY-MM` (sessions) or `YYYY-Www` (daily).
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
    /// Buckets that failed, `"<tree>/<bucket>: <error>"`. Their originals are
    /// untouched — see `pack_bucket`'s ordering.
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
        .ok_or_else(|| format!("unknown archive tree `{tree}` (sessions|daily only)"))
}

/// Exact bucket shape per tree — these become directory and file names, so a
/// bucket that is not literally `YYYY-MM` / `YYYY-Www` is refused outright
/// rather than normalized.
fn valid_bucket(tree: &str, bucket: &str) -> bool {
    let b = bucket.as_bytes();
    match tree {
        "sessions" => {
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

/// Current size of every archive bucket in both trees. Walks two shallow
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

/// Pack one bucket directory into `zip_path` and delete the originals.
///
/// ORDERING IS THE SAFETY PROPERTY, in this exact sequence:
///   1. write every file into `<zip_path>.part` (never the final name, so a
///      crash mid-write leaves no file that looks like a finished archive);
///   2. `finish()` + `sync_all()` — the bytes are on the platter;
///   3. reopen the `.part` as a `ZipArchive` and read EVERY entry back,
///      comparing against the original file's bytes;
///   4. only then rename `.part` → `zip_path`;
///   5. only then delete the loose files and the empty directory.
///
/// Any failure before step 4 removes the `.part` and returns `Err` with every
/// original still in place.
///
/// Returns `(files packed, loose bytes, zip bytes)`.
fn pack_bucket(dir: &Path, zip_path: &Path) -> Result<(usize, u64, u64), String> {
    if zip_path.exists() {
        // A zip AND loose files means a previous pack was interrupted between
        // "archive verified and renamed into place" and "originals removed"
        // (SIGKILL, a read-only file). Refusing both ways left the bucket
        // permanently stuck: pack said "restore first", restore said "already
        // exists". The archive was verified before it got its final name, so
        // finishing that deletion is the safe move — but re-verify against
        // what is on disk NOW rather than trusting the earlier run.
        let (files, has_subdir) = loose_files(dir)?;
        if has_subdir || files.is_empty() {
            return Err(format!(
                "{} already exists — restore it before packing again",
                zip_path.display()
            ));
        }
        // Only the exact set the archive already holds may be dropped. A
        // loose file that is NOT in the zip (e.g. a backdated session landed
        // in a packed month) is new data — refuse and let the user restore.
        if verify_pack(zip_path, &files).is_err() {
            return Err(format!(
                "{} already exists — restore it before packing again",
                zip_path.display()
            ));
        }
        let loose_bytes = files
            .iter()
            .filter_map(|f| std::fs::metadata(f).ok().map(|m| m.len()))
            .sum();
        for f in &files {
            std::fs::remove_file(f).map_err(|e| format!("remove {}: {e}", f.display()))?;
        }
        let _ = std::fs::remove_dir(dir);
        let zip_bytes = std::fs::metadata(zip_path).map(|m| m.len()).unwrap_or(0);
        return Ok((files.len(), loose_bytes, zip_bytes));
    }
    let (files, has_subdir) = loose_files(dir)?;
    if has_subdir {
        return Err("bucket contains a subdirectory — packing it would flatten it".into());
    }
    if files.is_empty() {
        return Err("bucket is empty".into());
    }

    let part = zip_path.with_extension("zip.part");
    let mut loose_bytes = 0u64;
    let result = (|| -> Result<(), String> {
        let file =
            std::fs::File::create(&part).map_err(|e| format!("create {}: {e}", part.display()))?;
        let mut zw = zip::ZipWriter::new(file);
        let opts = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for f in &files {
            let name = f
                .file_name()
                .and_then(|n| n.to_str())
                .ok_or_else(|| format!("non-UTF-8 file name in {}", dir.display()))?;
            let bytes = std::fs::read(f).map_err(|e| format!("read {}: {e}", f.display()))?;
            loose_bytes += bytes.len() as u64;
            zw.start_file(name, opts)
                .map_err(|e| format!("zip entry {name}: {e}"))?;
            zw.write_all(&bytes)
                .map_err(|e| format!("write entry {name}: {e}"))?;
        }
        let finished = zw.finish().map_err(|e| format!("finish zip: {e}"))?;
        finished
            .sync_all()
            .map_err(|e| format!("sync {}: {e}", part.display()))?;
        verify_pack(&part, &files)
    })();

    if let Err(e) = result {
        let _ = std::fs::remove_file(&part); // originals untouched
        return Err(e);
    }

    let zip_bytes = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    std::fs::rename(&part, zip_path).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        format!("rename {}: {e}", part.display())
    })?;

    // Verified and in place — now, and only now, the originals go.
    for f in &files {
        std::fs::remove_file(f).map_err(|e| format!("remove {}: {e}", f.display()))?;
    }
    let _ = std::fs::remove_dir(dir); // best effort; a stray dotfile keeps it
    Ok((files.len(), loose_bytes, zip_bytes))
}

/// Read the freshly-written archive back and prove every original is in it,
/// byte for byte. This is what makes the deletion in `pack_bucket` safe.
fn verify_pack(zip_path: &Path, originals: &[PathBuf]) -> Result<(), String> {
    #[cfg(test)]
    if FAIL_VERIFY_FOR_TEST.with(std::cell::Cell::get) {
        return Err("injected verification failure".into());
    }
    let file =
        std::fs::File::open(zip_path).map_err(|e| format!("reopen {}: {e}", zip_path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("{} is not readable: {e}", zip_path.display()))?;
    if archive.len() != originals.len() {
        return Err(format!(
            "archive holds {} entries, expected {}",
            archive.len(),
            originals.len()
        ));
    }
    for (i, original) in originals.iter().enumerate() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("entry {i} unreadable: {e}"))?;
        let name = entry.name().to_string();
        let mut got = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut got)
            .map_err(|e| format!("entry {name} unreadable: {e}"))?;
        let want =
            std::fs::read(original).map_err(|e| format!("re-read {}: {e}", original.display()))?;
        if got != want {
            return Err(format!(
                "entry {name} does not match {}",
                original.display()
            ));
        }
    }
    Ok(())
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

/// Pack every `sessions/archive/` and `daily/archive/` bucket older than
/// `older_than_months`. Never automatic: only ever reached from the explicit
/// button in Settings → Distill.
pub fn compress(root: &Path, older_than_months: u32, now: i64) -> PackReport {
    let (cut_month, cut_week) = cutoff(now, older_than_months);
    let mut report = PackReport::default();
    for b in usage(root) {
        if b.packed {
            continue;
        }
        let cut = if b.tree == "sessions" {
            &cut_month
        } else {
            &cut_week
        };
        if cut.is_empty() || b.bucket.as_str() >= cut.as_str() {
            continue; // inside the retention window — untouched
        }
        let Ok((dir, zip_path)) = bucket_paths(root, &b.tree, &b.bucket) else {
            continue; // `usage` already validated the shape; unreachable
        };
        match pack_bucket(&dir, &zip_path) {
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

/// Write `bytes` to `path` and fsync the file before returning — the caller
/// deletes the only other copy right after.
fn write_synced(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut f =
        std::fs::File::create(path).map_err(|e| format!("write {}: {e}", path.display()))?;
    f.write_all(bytes)
        .map_err(|e| format!("write {}: {e}", path.display()))?;
    f.sync_all()
        .map_err(|e| format!("sync {}: {e}", path.display()))?;
    Ok(())
}

/// Unpack one bucket back into its directory and drop the zip.
///
/// Same ordering discipline as `pack_bucket`, in reverse, and it has to be
/// real: every entry is written, fsynced, and read back byte-for-byte before
/// the zip is removed. Without the fsync the unlink is a journaled metadata
/// op while the file bodies are still in page cache — power loss in that
/// window leaves zero-length notes and no archive to restore from.
///
/// Restore is also RESUMABLE. An entry already on disk with exactly the
/// archived bytes is treated as done (a retry after a mid-restore failure
/// must not dead-end); an entry that exists with DIFFERENT bytes stops the
/// restore rather than clobbering the user's file.
pub fn restore(root: &Path, tree: &str, bucket: &str) -> Result<RestoreReport, String> {
    let (dir, zip_path) = bucket_paths(root, tree, bucket)?;
    let file =
        std::fs::File::open(&zip_path).map_err(|e| format!("open {}: {e}", zip_path.display()))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("{} is not readable: {e}", zip_path.display()))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;

    let mut bytes = 0u64;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("entry {i} unreadable: {e}"))?;
        let name = entry.name().to_string();
        // Packs written here are flat file names. Anything else is refused
        // rather than joined — a zip-slip guard that does not need to reason
        // about `..` at all.
        if name.is_empty() || name.contains('/') || name.contains('\\') {
            return Err(format!("archive entry `{name}` is not a plain file name"));
        }
        let dest = dir.join(&name);
        let mut buf = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut buf)
            .map_err(|e| format!("entry {name} unreadable: {e}"))?;
        if dest.exists() {
            match std::fs::read(&dest) {
                // Already restored (a retry after a partial run) — skip it.
                Ok(existing) if existing == buf => {
                    bytes += buf.len() as u64;
                    continue;
                }
                _ => {
                    return Err(format!(
                        "{} already exists with different contents",
                        dest.display()
                    ))
                }
            }
        }
        write_synced(&dest, &buf)?;
        // Read back: the zip is about to be deleted, so "written" must mean
        // "readable as these exact bytes", not "the write call returned".
        match std::fs::read(&dest) {
            Ok(back) if back == buf => {}
            _ => {
                return Err(format!(
                    "{} did not read back as written — leaving the archive in place",
                    dest.display()
                ))
            }
        }
        bytes += buf.len() as u64;
    }
    let files = archive.len();
    drop(archive);
    // Everything is back on disk AND durable — only now is the archive
    // redundant.
    std::fs::remove_file(&zip_path).map_err(|e| format!("remove {}: {e}", zip_path.display()))?;
    Ok(RestoreReport { files, bytes })
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
        pack_bucket(&dir, &zip).unwrap();
        // Re-create exactly the archived files: the interrupted-unlink state.
        seed(
            root,
            "sessions/archive/2026-01",
            &[("a.md", "one"), ("b.md", "two")],
        );
        assert!(zip.is_file() && dir.join("a.md").is_file());

        let (files, _, _) = pack_bucket(&dir, &zip).expect("must finish the interrupted pack");
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
        pack_bucket(&dir, &root.join("sessions/archive/2026-02.zip")).unwrap();
        // Simulate a restore that got one file out before dying.
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.md"), "one").unwrap();

        let report = restore(root, "sessions", "2026-02").expect("retry must succeed");
        assert_eq!(report.files, 2);
        assert_eq!(std::fs::read_to_string(dir.join("b.md")).unwrap(), "two");

        // But a file that exists with DIFFERENT bytes is the user's, not ours.
        seed(root, "sessions/archive/2026-03", &[("c.md", "orig")]);
        let dir3 = root.join("sessions/archive/2026-03");
        pack_bucket(&dir3, &root.join("sessions/archive/2026-03.zip")).unwrap();
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
