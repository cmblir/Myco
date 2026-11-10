use super::*;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;

struct Fixture {
    _temp: tempfile::TempDir,
    directory: CompilerPinDirectory,
    leaf: String,
}
impl Fixture {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        std::fs::set_permissions(temp.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        let directory =
            crate::vault::open_compiler_pin_directory(&temp.path().canonicalize().unwrap())
                .unwrap();
        Self {
            _temp: temp,
            directory,
            leaf: format!("{}.{}.json", "a".repeat(64), "b".repeat(32)),
        }
    }
    fn path(&self) -> std::path::PathBuf {
        self.directory.path().join(&self.leaf)
    }
    fn write(&self, bytes: &[u8]) -> File {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(self.path())
            .unwrap();
        file.write_all(bytes).unwrap();
        file.sync_all().unwrap();
        file
    }
}

#[test]
fn record_bytes_survive_writer_close_without_restoring_any_authority() {
    let fixture = Fixture::new();
    let written = fixture.write(b"synthetic baseline");
    verify_held_record(
        &fixture.directory,
        &fixture.leaf,
        &written,
        b"synthetic baseline",
    )
    .unwrap();
    drop(written);
    let (_, bytes) = read_record(&fixture.directory, &fixture.leaf).unwrap();
    assert_eq!(bytes, b"synthetic baseline");
}

#[test]
fn rejects_same_bytes_record_replacement_and_changed_readback() {
    let fixture = Fixture::new();
    let written = fixture.write(b"synthetic baseline");
    std::fs::rename(fixture.path(), fixture.path().with_extension("old")).unwrap();
    let replacement = fixture.write(b"synthetic baseline");
    assert!(verify_held_record(
        &fixture.directory,
        &fixture.leaf,
        &written,
        b"synthetic baseline"
    )
    .is_err());
    assert!(verify_held_record(
        &fixture.directory,
        &fixture.leaf,
        &replacement,
        b"different baseline"
    )
    .is_err());
}

#[test]
fn rejects_aliases_permissions_budget_and_unsafe_leaf() {
    for case in [
        "symlink",
        "hardlink",
        "mode",
        "oversize",
        "directory",
        "fifo",
    ] {
        let fixture = Fixture::new();
        match case {
            "directory" => std::fs::create_dir(fixture.path()).unwrap(),
            "fifo" => {
                let name = std::ffi::CString::new(fixture.path().to_str().unwrap()).unwrap();
                assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
            }
            _ => {
                let file = fixture.write(b"synthetic");
                match case {
                    "symlink" => {
                        let original = fixture.path().with_extension("original");
                        std::fs::rename(fixture.path(), &original).unwrap();
                        std::os::unix::fs::symlink(original, fixture.path()).unwrap();
                    }
                    "hardlink" => {
                        std::fs::hard_link(fixture.path(), fixture.path().with_extension("alias"))
                            .unwrap()
                    }
                    "mode" => std::fs::set_permissions(
                        fixture.path(),
                        std::fs::Permissions::from_mode(0o644),
                    )
                    .unwrap(),
                    "oversize" => file.set_len(MAX_BYTES as u64 + 1).unwrap(),
                    _ => unreachable!(),
                }
            }
        }
        assert!(
            read_record(&fixture.directory, &fixture.leaf).is_err(),
            "{case}"
        );
    }
    let fixture = Fixture::new();
    assert!(read_record(&fixture.directory, "../synthetic.json").is_err());
}

#[test]
fn rejects_mutation_during_read() {
    for replace in [false, true] {
        let fixture = Fixture::new();
        fixture.write(b"synthetic baseline");
        let result = read_at(&fixture.directory, &fixture.leaf, || {
            if replace {
                std::fs::rename(fixture.path(), fixture.path().with_extension("old"))
                    .map_err(|error| error.to_string())?;
                fixture.write(b"synthetic baseline");
                Ok(())
            } else {
                assert_eq!(b"synthetic baseline".len(), b"synthetic modified".len());
                std::fs::write(fixture.path(), b"synthetic modified")
                    .map_err(|error| error.to_string())
            }
        });
        assert!(result.is_err(), "replace={replace}");
    }
}

#[test]
fn publishes_synced_private_bytes_without_clobbering_existing_records() {
    let fixture = Fixture::new();
    let file = write_record(
        &fixture.directory,
        &fixture.leaf,
        b"Synthetic complete record",
    )
    .unwrap();
    verify_held_record(
        &fixture.directory,
        &fixture.leaf,
        &file,
        b"Synthetic complete record",
    )
    .unwrap();
    assert!(write_record(&fixture.directory, &fixture.leaf, b"Replacement").is_err());
    assert_eq!(
        read_record(&fixture.directory, &fixture.leaf).unwrap().1,
        b"Synthetic complete record"
    );
    assert_eq!(
        std::fs::read_dir(fixture.directory.path()).unwrap().count(),
        1
    );
    assert!(write_record(&fixture.directory, "../escape.json", b"Invalid").is_err());
}

#[test]
fn staged_record_replacement_is_rejected_without_removing_the_replacement() {
    let fixture = Fixture::new();
    let mut replacement_path = None;
    let error = write_at(
        &fixture.directory,
        &fixture.leaf,
        b"Synthetic bytes",
        |staged| {
            let other = fixture.directory.path().join("replacement.tmp");
            std::fs::write(&other, b"External replacement").unwrap();
            std::fs::rename(other, staged.path()).unwrap();
            replacement_path = Some(staged.path().to_owned());
            Ok(())
        },
    )
    .unwrap_err();
    assert!(error.contains("staging object changed"));
    assert!(!fixture.path().exists());
    assert_eq!(
        std::fs::read(replacement_path.unwrap()).unwrap(),
        b"External replacement"
    );
}

#[test]
#[ignore = "invoked only by the isolated partial-record process test"]
fn synthetic_record_staging_child() {
    let root = std::path::PathBuf::from(std::env::var_os("MYCO_SYNTHETIC_RECORD_ROOT").unwrap());
    assert_eq!(
        std::fs::read_to_string(root.join("synthetic.marker")).unwrap(),
        "Synthetic partial record only"
    );
    let private = root.join("private");
    let directory = crate::vault::open_compiler_pin_directory(&private).unwrap();
    let old_leaf = format!("{}.{}.json", "a".repeat(64), "b".repeat(32));
    let next_leaf = format!("{}.{}.json", "a".repeat(64), "c".repeat(32));
    match std::env::var("MYCO_SYNTHETIC_RECORD_PHASE")
        .unwrap()
        .as_str()
    {
        "write" => {
            write_record(&directory, &old_leaf, b"Synthetic old complete record").unwrap();
            let _ = write_at(
                &directory,
                &next_leaf,
                b"Synthetic next complete record",
                |staged| {
                    staged.write_all(b"{\"partial\":").unwrap();
                    staged.as_file().sync_all().unwrap();
                    // Simulate interruption during staging, before final-name publication.
                    std::process::exit(26);
                },
            );
            panic!("partial-record checkpoint was not reached");
        }
        "inspect" => {
            assert_eq!(
                read_record(&directory, &old_leaf).unwrap().1,
                b"Synthetic old complete record"
            );
            assert!(!private.join(next_leaf).exists());
            let pending = std::fs::read_dir(&private)
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("tmp"))
                .collect::<Vec<_>>();
            assert_eq!(pending.len(), 1);
            assert_eq!(std::fs::read(&pending[0]).unwrap(), b"{\"partial\":");
        }
        other => panic!("unexpected synthetic phase: {other}"),
    }
}

#[test]
fn partial_staging_survives_exit_without_poisoning_final_record_names() {
    let temporary = tempfile::Builder::new()
        .prefix("myco-synthetic-record-stage-")
        .tempdir()
        .unwrap();
    let root = temporary.path().canonicalize().unwrap();
    std::fs::write(
        root.join("synthetic.marker"),
        "Synthetic partial record only",
    )
    .unwrap();
    std::fs::create_dir(root.join("private")).unwrap();
    std::fs::set_permissions(root.join("private"), std::fs::Permissions::from_mode(0o700)).unwrap();
    for (phase, code) in [("write", 26), ("inspect", 0)] {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "map_custody_record::tests::synthetic_record_staging_child",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("MYCO_SYNTHETIC_RECORD_ROOT", &root)
            .env("MYCO_SYNTHETIC_RECORD_PHASE", phase)
            .env("MYCO_DATA_DIR", root.join("isolated-settings"))
            .env_remove("MEMEX_DATA_DIR")
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(code),
            "{phase}: stdout={} stderr={}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn staged_trailing_bytes_are_rejected_before_final_name_publication() {
    let fixture = Fixture::new();
    let error = write_at(
        &fixture.directory,
        &fixture.leaf,
        b"Synthetic bytes",
        |staged| {
            // An external writer changes the inode without changing our file offset.
            std::fs::write(staged.path(), b"Unexpected longer staging contents").unwrap();
            Ok(())
        },
    )
    .unwrap_err();
    assert!(error.contains("staging bytes changed"));
    assert!(!fixture.path().exists());
}
