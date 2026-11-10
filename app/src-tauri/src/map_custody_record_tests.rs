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
    verify_written_record(
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
    assert!(verify_written_record(
        &fixture.directory,
        &fixture.leaf,
        &written,
        b"synthetic baseline"
    )
    .is_err());
    assert!(verify_written_record(
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
