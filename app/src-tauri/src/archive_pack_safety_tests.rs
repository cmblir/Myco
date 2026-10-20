//! Supplementary archive confinement/retained-identity regressions.
//! Run serially; the global writer try-lock is not a parallel-test attribution.

use super::*;

const ORIGINAL: &str = "Synthetic archived original.\n";
const NEWER: &str = "A newer synthetic human edit; preserve this.\n";
const BUCKET: &str = "sessions/archive/2026-01";
const NOW: i64 = 1_787_184_000;

struct ClearHook;
impl Drop for ClearHook {
    fn drop(&mut self) {
        MUTATION_HOOK.with(|hook| *hook.borrow_mut() = None);
    }
}
fn install(hook: impl Fn(MutationCheckpoint) -> Result<(), String> + 'static) -> ClearHook {
    MUTATION_HOOK.with(|stored| *stored.borrow_mut() = Some(Box::new(hook)));
    ClearHook
}
fn fixture(files: &[(&str, &str)]) -> (tempfile::TempDir, PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    std::fs::create_dir_all(root.join(BUCKET)).unwrap();
    for (name, body) in files {
        std::fs::write(root.join(BUCKET).join(name), body).unwrap();
    }
    std::fs::create_dir(root.join("raw")).unwrap();
    std::fs::write(root.join("raw/sentinel.md"), "Immutable synthetic raw.\n").unwrap();
    (directory, root)
}
fn archive_body(root: &Path, name: &str) -> String {
    let mut archive =
        zip::ZipArchive::new(std::fs::File::open(root.join(format!("{BUCKET}.zip"))).unwrap())
            .unwrap();
    let mut entry = archive.by_name(name).unwrap();
    let mut bytes = String::new();
    entry.read_to_string(&mut bytes).unwrap();
    bytes
}
fn raw_unchanged(root: &Path) {
    assert_eq!(
        std::fs::read_to_string(root.join("raw/sentinel.md")).unwrap(),
        "Immutable synthetic raw.\n"
    );
}

#[cfg(unix)]
#[test]
fn pack_refuses_archive_parent_symlink_into_raw() {
    let (_directory, root) = fixture(&[("a.md", ORIGINAL)]);
    std::fs::rename(
        root.join("sessions/archive"),
        root.join("sessions/captured-archive"),
    )
    .unwrap();
    std::fs::create_dir(root.join("raw/2026-01")).unwrap();
    std::fs::write(root.join("raw/2026-01/a.md"), ORIGINAL).unwrap();
    std::os::unix::fs::symlink(root.join("raw"), root.join("sessions/archive")).unwrap();
    let result = compress(&root, 3, NOW);
    assert_eq!(result.buckets, 0);
    assert_eq!(result.failed.len(), 1, "{result:?}");
    assert_eq!(
        std::fs::read_to_string(root.join("raw/2026-01/a.md")).unwrap(),
        ORIGINAL
    );
    assert!(!root.join("raw/2026-01.zip").exists());
    raw_unchanged(&root);
}

#[cfg(unix)]
#[test]
fn restore_refuses_archive_parent_symlink_into_raw() {
    let (_directory, root) = fixture(&[("a.md", ORIGINAL)]);
    assert_eq!(compress(&root, 3, NOW).buckets, 1);
    let backing = std::fs::read(root.join(format!("{BUCKET}.zip"))).unwrap();
    std::fs::rename(
        root.join(format!("{BUCKET}.zip")),
        root.join("raw/2026-01.zip"),
    )
    .unwrap();
    std::fs::rename(
        root.join("sessions/archive"),
        root.join("sessions/captured-archive"),
    )
    .unwrap();
    std::os::unix::fs::symlink(root.join("raw"), root.join("sessions/archive")).unwrap();
    assert!(restore(&root, "sessions", "2026-01").is_err());
    assert_eq!(
        std::fs::read(root.join("raw/2026-01.zip")).unwrap(),
        backing
    );
    assert!(!root.join("raw/2026-01").exists());
    raw_unchanged(&root);
}

#[cfg(unix)]
#[test]
fn pack_refuses_dangling_and_special_loose_files() {
    for special in [false, true] {
        let (_directory, root) = fixture(&[("a.md", ORIGINAL)]);
        let unexpected = root.join(BUCKET).join("s");
        let _socket = if special {
            Some(std::os::unix::net::UnixListener::bind(&unexpected).unwrap())
        } else {
            std::os::unix::fs::symlink(root.join("raw/missing.md"), &unexpected).unwrap();
            None
        };
        assert!(pack_bucket(
            &root,
            &root.join(BUCKET),
            &root.join(format!("{BUCKET}.zip"))
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(root.join(BUCKET).join("a.md")).unwrap(),
            ORIGINAL
        );
        assert!(std::fs::symlink_metadata(unexpected).is_ok());
        assert!(!root.join(format!("{BUCKET}.zip")).exists());
        raw_unchanged(&root);
    }
}

#[cfg(unix)]
#[test]
fn restore_refuses_dangling_and_special_destinations() {
    for special in [false, true] {
        let (_directory, root) = fixture(&[("a.md", ORIGINAL)]);
        assert_eq!(compress(&root, 3, NOW).buckets, 1);
        let backing = std::fs::read(root.join(format!("{BUCKET}.zip"))).unwrap();
        std::fs::create_dir(root.join(BUCKET)).unwrap();
        let unexpected = root.join(BUCKET).join("a.md");
        let _socket = if special {
            Some(std::os::unix::net::UnixListener::bind(&unexpected).unwrap())
        } else {
            std::os::unix::fs::symlink(root.join("raw/missing.md"), &unexpected).unwrap();
            None
        };
        assert!(restore(&root, "sessions", "2026-01").is_err());
        assert!(std::fs::symlink_metadata(unexpected).is_ok());
        assert_eq!(
            std::fs::read(root.join(format!("{BUCKET}.zip"))).unwrap(),
            backing
        );
        assert!(!root.join("raw/missing.md").exists());
        raw_unchanged(&root);
    }
}

#[cfg(unix)]
#[test]
fn pack_and_restore_refuse_an_existing_zip_symlink() {
    let (_directory, root) = fixture(&[("a.md", ORIGINAL)]);
    assert_eq!(compress(&root, 3, NOW).buckets, 1);
    let archive = root.join(format!("{BUCKET}.zip"));
    let backing = root.join("backing.zip");
    std::fs::rename(&archive, &backing).unwrap();
    let original_zip = std::fs::read(&backing).unwrap();
    std::os::unix::fs::symlink(&backing, &archive).unwrap();
    std::fs::create_dir(root.join(BUCKET)).unwrap();
    std::fs::write(root.join(BUCKET).join("a.md"), ORIGINAL).unwrap();
    assert!(pack_bucket(&root, &root.join(BUCKET), &archive).is_err());
    assert!(restore(&root, "sessions", "2026-01").is_err());
    assert_eq!(
        std::fs::read_to_string(root.join(BUCKET).join("a.md")).unwrap(),
        ORIGINAL
    );
    assert!(std::fs::symlink_metadata(&archive)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(std::fs::read(backing).unwrap(), original_zip);
    raw_unchanged(&root);
}

#[test]
fn pack_rechecks_same_bytes_native_source_replacement() {
    let (_directory, root) = fixture(&[("a.md", ORIGINAL)]);
    let edit = root.join(BUCKET).join("a.md");
    let _hook = install(move |phase| {
        if phase == MutationCheckpoint::PackPrepared {
            crate::vault::write_file(&edit.to_string_lossy(), ORIGINAL)?;
        }
        Ok(())
    });
    let report = compress(&root, 3, NOW);
    assert_eq!(report.buckets, 0);
    assert_eq!(report.failed.len(), 1, "{report:?}");
    assert_eq!(
        std::fs::read_to_string(root.join(BUCKET).join("a.md")).unwrap(),
        ORIGINAL
    );
    assert!(!root.join(format!("{BUCKET}.zip")).exists());
    raw_unchanged(&root);
}

#[test]
fn restore_rechecks_an_earlier_destination_before_removing_zip() {
    let (_directory, root) =
        fixture(&[("a.md", ORIGINAL), ("b.md", "Second synthetic original.\n")]);
    assert_eq!(compress(&root, 3, NOW).buckets, 1);
    let edit = root.join(BUCKET).join("a.md");
    let _hook = install(move |phase| {
        if phase == MutationCheckpoint::RestoreFinalize {
            assert!(crate::vault::try_lock_file_mutation()?.is_some());
            crate::vault::write_file(&edit.to_string_lossy(), NEWER)?;
        }
        Ok(())
    });
    assert!(restore(&root, "sessions", "2026-01").is_err());
    assert_eq!(
        std::fs::read_to_string(root.join(BUCKET).join("a.md")).unwrap(),
        NEWER
    );
    assert_eq!(
        std::fs::read_to_string(root.join(BUCKET).join("b.md")).unwrap(),
        "Second synthetic original.\n"
    );
    assert_eq!(archive_body(&root, "a.md"), ORIGINAL);
    raw_unchanged(&root);
}

#[test]
fn partial_pack_retry_reads_the_zip_member_with_no_remaining_original() {
    let (_directory, root) =
        fixture(&[("a.md", ORIGINAL), ("b.md", "Second synthetic original.\n")]);
    assert_eq!(compress(&root, 3, NOW).buckets, 1);
    std::fs::create_dir(root.join(BUCKET)).unwrap();
    std::fs::write(
        root.join(BUCKET).join("b.md"),
        "Second synthetic original.\n",
    )
    .unwrap();
    let archive_path = root.join(format!("{BUCKET}.zip"));
    let mut archive = zip::ZipArchive::new(std::fs::File::open(&archive_path).unwrap()).unwrap();
    let offset = archive.by_name("a.md").unwrap().data_start() as usize;
    drop(archive);
    let mut corrupted = std::fs::read(&archive_path).unwrap();
    corrupted[offset] ^= 0x40;
    std::fs::write(&archive_path, &corrupted).unwrap();
    let report = compress(&root, 3, NOW);
    assert_eq!(report.buckets, 0);
    assert_eq!(report.failed.len(), 1, "{report:?}");
    assert_eq!(
        std::fs::read_to_string(root.join(BUCKET).join("b.md")).unwrap(),
        "Second synthetic original.\n"
    );
    assert_eq!(std::fs::read(archive_path).unwrap(), corrupted);
    raw_unchanged(&root);
}

#[test]
fn pack_rechecks_preparation_time_bucket_directory_identity() {
    let (_directory, root) = fixture(&[("a.md", ORIGINAL)]);
    let replacement = root.join(BUCKET);
    let captured = root.join("sessions/archive/captured-before-replacement");
    let captured_for_hook = captured.clone();
    let _hook = install(move |phase| {
        if phase == MutationCheckpoint::PackPrepared {
            // This deterministic outside-writer replacement is detected by the
            // retained handle. It does not prove atomic external-editor exclusion.
            std::fs::rename(&replacement, &captured_for_hook).map_err(|error| error.to_string())?;
            std::fs::create_dir(&replacement).map_err(|error| error.to_string())?;
            std::fs::write(replacement.join("a.md"), ORIGINAL)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    });
    let report = compress(&root, 3, NOW);
    assert_eq!(report.buckets, 0);
    assert_eq!(report.failed.len(), 1, "{report:?}");
    assert_eq!(
        std::fs::read_to_string(root.join(BUCKET).join("a.md")).unwrap(),
        ORIGINAL
    );
    assert_eq!(
        std::fs::read_to_string(captured.join("a.md")).unwrap(),
        ORIGINAL
    );
    assert!(!root.join(format!("{BUCKET}.zip")).exists());
    raw_unchanged(&root);
}

fn stages(parent: &Path, prefix: &str) -> Vec<PathBuf> {
    let mut paths: Vec<_> = std::fs::read_dir(parent)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with(prefix)
        })
        .collect();
    paths.sort();
    paths
}

fn one_stage(parent: &Path, prefix: &str) -> PathBuf {
    let paths = stages(parent, prefix);
    assert_eq!(paths.len(), 1, "expected one {prefix} stage, got {paths:?}");
    paths.into_iter().next().unwrap()
}

fn body_in_zip(path: &Path, name: &str) -> String {
    let mut archive = zip::ZipArchive::new(std::fs::File::open(path).unwrap()).unwrap();
    let mut body = String::new();
    archive
        .by_name(name)
        .unwrap()
        .read_to_string(&mut body)
        .unwrap();
    body
}

#[test]
fn pack_preserves_replaced_stage_before_path_publication_and_cleanup() {
    let (_directory, root) = fixture(&[("a.md", ORIGINAL)]);
    let parent = root.join("sessions/archive");
    let saved = parent.join("owned-stage-held.part");
    let hook_parent = parent.clone();
    let hook_saved = saved.clone();
    let _hook = install(move |phase| {
        if phase == MutationCheckpoint::PackPrepared {
            let stage = one_stage(&hook_parent, ".myco-pack-");
            std::fs::rename(&stage, &hook_saved).map_err(|error| error.to_string())?;
            std::fs::write(&stage, NEWER).map_err(|error| error.to_string())?;
        }
        Ok(())
    });
    let report = compress(&root, 3, NOW);
    assert_eq!(report.buckets, 0);
    assert_eq!(report.failed.len(), 1, "{report:?}");
    assert!(report.failed[0].contains("cleanup refused"), "{report:?}");
    assert_eq!(
        std::fs::read_to_string(one_stage(&parent, ".myco-pack-")).unwrap(),
        NEWER
    );
    assert_eq!(body_in_zip(&saved, "a.md"), ORIGINAL);
    assert_eq!(
        std::fs::read_to_string(root.join(BUCKET).join("a.md")).unwrap(),
        ORIGINAL
    );
    assert!(!root.join(format!("{BUCKET}.zip")).exists());
    raw_unchanged(&root);
}

#[cfg(unix)]
#[test]
fn pack_preserves_foreign_stage_under_substituted_raw_parent() {
    let (_directory, root) = fixture(&[("a.md", ORIGINAL)]);
    let parent = root.join("sessions/archive");
    let saved_parent = root.join("sessions/captured-archive");
    let hook_parent = parent.clone();
    let hook_saved = saved_parent.clone();
    let raw = root.join("raw");
    let hook_raw = raw.clone();
    let _hook = install(move |phase| {
        if phase == MutationCheckpoint::PackPrepared {
            let stage = one_stage(&hook_parent, ".myco-pack-");
            let name = stage.file_name().unwrap();
            std::fs::rename(&hook_parent, &hook_saved).map_err(|error| error.to_string())?;
            std::os::unix::fs::symlink(&hook_raw, &hook_parent)
                .map_err(|error| error.to_string())?;
            std::fs::write(hook_raw.join(name), NEWER).map_err(|error| error.to_string())?;
        }
        Ok(())
    });
    let report = compress(&root, 3, NOW);
    assert_eq!(report.buckets, 0);
    assert_eq!(report.failed.len(), 1, "{report:?}");
    assert!(report.failed[0].contains("cleanup refused"), "{report:?}");
    assert_eq!(
        std::fs::read_to_string(one_stage(&raw, ".myco-pack-")).unwrap(),
        NEWER
    );
    assert_eq!(
        body_in_zip(&one_stage(&saved_parent, ".myco-pack-"), "a.md"),
        ORIGINAL
    );
    assert_eq!(
        std::fs::read_to_string(saved_parent.join("2026-01/a.md")).unwrap(),
        ORIGINAL
    );
    assert!(!raw.join("2026-01.zip").exists());
    assert!(!saved_parent.join("2026-01.zip").exists());
    raw_unchanged(&root);
}

#[test]
fn restore_preserves_replaced_stage_before_path_publication_and_cleanup() {
    let (_directory, root) = fixture(&[("a.md", ORIGINAL)]);
    assert_eq!(compress(&root, 3, NOW).buckets, 1);
    let backing = std::fs::read(root.join(format!("{BUCKET}.zip"))).unwrap();
    let parent = root.join("sessions/archive");
    let saved = parent.join("owned-restore-held.part");
    let hook_parent = parent.clone();
    let hook_saved = saved.clone();
    let _hook = install(move |phase| {
        if phase == MutationCheckpoint::RestoreWrite {
            let stage = one_stage(&hook_parent, ".myco-restore-");
            std::fs::rename(&stage, &hook_saved).map_err(|error| error.to_string())?;
            std::fs::write(&stage, NEWER).map_err(|error| error.to_string())?;
        }
        Ok(())
    });
    let error = restore(&root, "sessions", "2026-01").unwrap_err();
    assert!(error.contains("cleanup refused"), "{error}");
    assert_eq!(
        std::fs::read_to_string(one_stage(&parent, ".myco-restore-")).unwrap(),
        NEWER
    );
    assert_eq!(std::fs::read_to_string(saved).unwrap(), ORIGINAL);
    assert!(!root.join(BUCKET).join("a.md").exists());
    assert_eq!(
        std::fs::read(root.join(format!("{BUCKET}.zip"))).unwrap(),
        backing
    );
    raw_unchanged(&root);
}

#[cfg(unix)]
#[test]
fn restore_preserves_foreign_stage_under_substituted_raw_parent() {
    let (_directory, root) = fixture(&[("a.md", ORIGINAL)]);
    assert_eq!(compress(&root, 3, NOW).buckets, 1);
    let backing = std::fs::read(root.join(format!("{BUCKET}.zip"))).unwrap();
    let parent = root.join("sessions/archive");
    let saved_parent = root.join("sessions/captured-archive");
    let hook_parent = parent.clone();
    let hook_saved = saved_parent.clone();
    let raw = root.join("raw");
    let hook_raw = raw.clone();
    let _hook = install(move |phase| {
        if phase == MutationCheckpoint::RestoreWrite {
            let stage = one_stage(&hook_parent, ".myco-restore-");
            let name = stage.file_name().unwrap();
            std::fs::rename(&hook_parent, &hook_saved).map_err(|error| error.to_string())?;
            std::os::unix::fs::symlink(&hook_raw, &hook_parent)
                .map_err(|error| error.to_string())?;
            std::fs::write(hook_raw.join(name), NEWER).map_err(|error| error.to_string())?;
        }
        Ok(())
    });
    let error = restore(&root, "sessions", "2026-01").unwrap_err();
    assert!(error.contains("cleanup refused"), "{error}");
    assert_eq!(
        std::fs::read_to_string(one_stage(&raw, ".myco-restore-")).unwrap(),
        NEWER
    );
    assert_eq!(
        std::fs::read_to_string(one_stage(&saved_parent, ".myco-restore-")).unwrap(),
        ORIGINAL
    );
    assert_eq!(
        std::fs::read(saved_parent.join("2026-01.zip")).unwrap(),
        backing
    );
    assert!(!raw.join("2026-01/a.md").exists());
    assert!(!saved_parent.join("2026-01/a.md").exists());
    raw_unchanged(&root);
}

#[test]
fn restore_persist_error_preserves_replacement_stage_and_competing_destination() {
    let (_directory, root) = fixture(&[("a.md", ORIGINAL)]);
    assert_eq!(compress(&root, 3, NOW).buckets, 1);
    let backing = std::fs::read(root.join(format!("{BUCKET}.zip"))).unwrap();
    let parent = root.join("sessions/archive");
    let saved = parent.join("owned-failed-publish-held.part");
    let destination = root.join(BUCKET).join("a.md");
    let hook_destination = destination.clone();
    let hook_parent = parent.clone();
    let hook_saved = saved.clone();
    let failed = std::rc::Rc::new(std::cell::Cell::new(false));
    let failed_hook = failed.clone();
    let _hook = install(move |phase| {
        if phase == MutationCheckpoint::RestoreWrite {
            // An actual independent namespace edit, not a cooperating writer.
            std::fs::write(&hook_destination, NEWER).map_err(|error| error.to_string())?;
        } else if phase == MutationCheckpoint::StagePublishFailed {
            failed_hook.set(true);
            let stage = one_stage(&hook_parent, ".myco-restore-");
            std::fs::rename(&stage, &hook_saved).map_err(|error| error.to_string())?;
            std::fs::write(&stage, "Foreign replacement stage.\n")
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    });
    let error = restore(&root, "sessions", "2026-01").unwrap_err();
    assert!(
        failed.get(),
        "persist failure checkpoint was not reached: {error}"
    );
    assert!(error.contains("already exists"), "{error}");
    assert!(error.contains("cleanup refused"), "{error}");
    assert_eq!(
        std::fs::read_to_string(one_stage(&parent, ".myco-restore-")).unwrap(),
        "Foreign replacement stage.\n"
    );
    assert_eq!(std::fs::read_to_string(destination).unwrap(), NEWER);
    assert_eq!(std::fs::read_to_string(saved).unwrap(), ORIGINAL);
    assert_eq!(
        std::fs::read(root.join(format!("{BUCKET}.zip"))).unwrap(),
        backing
    );
    raw_unchanged(&root);
}

#[test]
fn pack_verification_failure_cleans_unchanged_owned_stage() {
    let (_directory, root) = fixture(&[("a.md", ORIGINAL)]);
    struct ClearVerify;
    impl Drop for ClearVerify {
        fn drop(&mut self) {
            FAIL_VERIFY_FOR_TEST.with(|flag| flag.set(false));
        }
    }
    FAIL_VERIFY_FOR_TEST.with(|flag| flag.set(true));
    let _reset = ClearVerify;
    let report = compress(&root, 3, NOW);
    assert_eq!(report.buckets, 0);
    assert_eq!(report.failed.len(), 1, "{report:?}");
    assert!(
        report.failed[0].contains("injected verification failure"),
        "{report:?}"
    );
    assert!(stages(&root.join("sessions/archive"), ".myco-pack-").is_empty());
    assert_eq!(
        std::fs::read_to_string(root.join(BUCKET).join("a.md")).unwrap(),
        ORIGINAL
    );
    assert!(!root.join(format!("{BUCKET}.zip")).exists());
    raw_unchanged(&root);
}

#[test]
fn restore_prepublish_failure_cleans_unchanged_owned_stage() {
    let (_directory, root) = fixture(&[("a.md", ORIGINAL)]);
    assert_eq!(compress(&root, 3, NOW).buckets, 1);
    let backing = std::fs::read(root.join(format!("{BUCKET}.zip"))).unwrap();
    let _hook = install(|phase| {
        if phase == MutationCheckpoint::RestoreWrite {
            return Err("injected restore prepublication failure".into());
        }
        Ok(())
    });
    let error = restore(&root, "sessions", "2026-01").unwrap_err();
    assert!(
        error.contains("injected restore prepublication failure"),
        "{error}"
    );
    assert!(stages(&root.join("sessions/archive"), ".myco-restore-").is_empty());
    assert!(!root.join(BUCKET).join("a.md").exists());
    assert_eq!(
        std::fs::read(root.join(format!("{BUCKET}.zip"))).unwrap(),
        backing
    );
    raw_unchanged(&root);
}

#[test]
fn pack_and_independent_zip_restore_96_members_with_bounded_handles() {
    // The parent may run this compiled test alone under RLIMIT_NOFILE=64.
    // This test does not change process limits and needs no new dependencies.
    let (_packed_directory, packed_root) = fixture(&[]);
    for index in 0..96 {
        std::fs::write(
            packed_root.join(BUCKET).join(format!("note-{index:03}.md")),
            format!("Synthetic member {index}.\n"),
        )
        .unwrap();
    }
    let report = compress(&packed_root, 3, NOW);
    assert_eq!(report.buckets, 1, "{report:?}");
    assert_eq!(report.files, 96);
    assert!(!packed_root.join(BUCKET).exists());
    let packed_zip = packed_root.join(format!("{BUCKET}.zip"));
    assert_eq!(
        zip::ZipArchive::new(std::fs::File::open(&packed_zip).unwrap())
            .unwrap()
            .len(),
        96
    );
    for index in 0..96 {
        assert_eq!(
            body_in_zip(&packed_zip, &format!("note-{index:03}.md")),
            format!("Synthetic member {index}.\n")
        );
    }
    raw_unchanged(&packed_root);

    // Build the restore fixture directly; pack's output cannot mask a restore bug.
    let (_restore_directory, restore_root) = fixture(&[]);
    let independent_zip = restore_root.join(format!("{BUCKET}.zip"));
    let mut writer = zip::ZipWriter::new(std::fs::File::create(&independent_zip).unwrap());
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for index in 0..96 {
        writer
            .start_file(format!("independent-{index:03}.md"), options)
            .unwrap();
        writer
            .write_all(format!("Independent synthetic member {index}.\n").as_bytes())
            .unwrap();
    }
    writer.finish().unwrap().sync_all().unwrap();
    let report = restore(&restore_root, "sessions", "2026-01").unwrap();
    assert_eq!(report.files, 96);
    assert!(!independent_zip.exists());
    for index in 0..96 {
        assert_eq!(
            std::fs::read_to_string(
                restore_root
                    .join(BUCKET)
                    .join(format!("independent-{index:03}.md"))
            )
            .unwrap(),
            format!("Independent synthetic member {index}.\n")
        );
    }
    assert!(stages(&restore_root.join("sessions/archive"), ".myco-restore-").is_empty());
    raw_unchanged(&restore_root);
}

#[test]
fn pack_preseal_source_change_cleans_unchanged_owned_stage() {
    let (_directory, root) = fixture(&[("a.md", ORIGINAL)]);
    let edit = root.join(BUCKET).join("a.md");
    let _hook = install(move |phase| {
        if phase == MutationCheckpoint::PackStageCreated {
            // The stage exists, but the writer and source-read phase have not
            // begun. Use the real cooperating API rather than an injected Err.
            assert!(crate::vault::try_lock_file_mutation()?.is_some());
            crate::vault::write_file(&edit.to_string_lossy(), NEWER)?;
        }
        Ok(())
    });
    let report = compress(&root, 3, NOW);
    assert_eq!(report.buckets, 0);
    assert_eq!(report.failed.len(), 1, "{report:?}");
    assert_eq!(
        std::fs::read_to_string(root.join(BUCKET).join("a.md")).unwrap(),
        NEWER
    );
    assert!(!root.join(format!("{BUCKET}.zip")).exists());
    assert!(
        stages(&root.join("sessions/archive"), ".myco-pack-").is_empty(),
        "unchanged owned unsealed stage leaked: {report:?}"
    );
    assert!(!report.failed[0].contains("cleanup refused"), "{report:?}");
    raw_unchanged(&root);
}
