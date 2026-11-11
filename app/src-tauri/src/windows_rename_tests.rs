//! Native rename experiments only; no production publication authority.
use super::*;
use std::io::Read;
use std::mem::offset_of;
use windows_sys::Win32::Storage::FileSystem::{
    FileRenameInfoEx, SetFileInformationByHandle, DELETE, FILE_GENERIC_READ, FILE_GENERIC_WRITE,
    FILE_RENAME_INFO,
};

fn stage(path: &Path) -> File {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .access_mode(FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .open(path)
        .unwrap()
}

fn rename_by_handle(file: &File, parent: &Path, name: &str, replace: bool) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    // Values documented by FILE_RENAME_INFORMATION / FileRenameInfoEx.
    const REPLACE_IF_EXISTS: u32 = 0x00000001;
    const POSIX_SEMANTICS: u32 = 0x00000002;
    assert!(!name.contains(['/', '\\', '\0', ':']));
    // The hosted Win32 call rejected the root-handle/relative-name form with
    // ERROR_INVALID_PARAMETER. Probe the documented absolute-path form instead;
    // this is not production parent-directory confinement authority.
    let destination = parent.canonicalize()?.join(name);
    let name: Vec<u16> = destination.as_os_str().encode_wide().collect();
    assert!(!name.is_empty() && name.len() <= 1024);
    let bytes = size_of::<FILE_RENAME_INFO>()
        .max(offset_of!(FILE_RENAME_INFO, FileName) + (name.len() + 1) * 2);
    // usize storage has the native pointer alignment required by this structure.
    let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
    let request = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    // SAFETY: the zeroed aligned buffer covers the header and complete UTF-16
    // tail. The source handle remains live through the call.
    let success = unsafe {
        (*request).Anonymous.Flags = POSIX_SEMANTICS | if replace { REPLACE_IF_EXISTS } else { 0 };
        (*request).RootDirectory = std::ptr::null_mut();
        (*request).FileNameLength = (name.len() * 2) as u32;
        std::ptr::copy_nonoverlapping(
            name.as_ptr(),
            std::ptr::addr_of_mut!((*request).FileName).cast::<u16>(),
            name.len(),
        );
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileRenameInfoEx,
            request.cast(),
            bytes as u32,
        )
    };
    if success == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[test]
fn posix_replace_keeps_old_reader_bytes_and_changes_named_identity() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("Synthetic 한글 target.md");
    let staged = root.path().join("stage.md");
    fs::write(&target, b"Synthetic original.").unwrap();
    let mut original = crate::windows_source::open(&target).unwrap();
    let original_id = identity(&original).unwrap();
    let mut replacement = stage(&staged);
    std::io::Write::write_all(&mut replacement, b"Synthetic replacement.").unwrap();
    replacement.sync_all().unwrap();
    let replacement_id = identity(&replacement).unwrap();
    rename_by_handle(&replacement, root.path(), "Synthetic 한글 target.md", true).unwrap();
    assert!(!staged.exists());
    assert_eq!(
        identity(&open_shared(&target).unwrap()).unwrap(),
        replacement_id
    );
    assert_ne!(original_id, replacement_id);
    let mut retained = String::new();
    original.read_to_string(&mut retained).unwrap();
    assert_eq!(retained, "Synthetic original.");
    assert_eq!(fs::read(&target).unwrap(), b"Synthetic replacement.");
    assert!(crate::windows_source::verify(&original, &target).is_err());
}

#[test]
fn no_replace_preserves_existing_target_and_staging_file() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("target.md");
    let staged = root.path().join("stage.md");
    fs::write(&target, b"Synthetic original.").unwrap();
    let mut replacement = stage(&staged);
    std::io::Write::write_all(&mut replacement, b"Synthetic replacement.").unwrap();
    let error = rename_by_handle(&replacement, root.path(), "target.md", false).unwrap_err();
    assert!(matches!(error.raw_os_error(), Some(80 | 183)), "{error}");
    assert_eq!(fs::read(&target).unwrap(), b"Synthetic original.");
    assert_eq!(fs::read(&staged).unwrap(), b"Synthetic replacement.");
}

#[test]
fn readonly_target_is_not_overridden_by_posix_replacement() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("target.md");
    let staged = root.path().join("stage.md");
    fs::write(&target, b"Synthetic original.").unwrap();
    let original_permissions = fs::metadata(&target).unwrap().permissions();
    let mut permissions = original_permissions.clone();
    permissions.set_readonly(true);
    fs::set_permissions(&target, permissions).unwrap();
    let mut replacement = stage(&staged);
    std::io::Write::write_all(&mut replacement, b"Synthetic replacement.").unwrap();
    let outcome = rename_by_handle(&replacement, root.path(), "target.md", true);
    fs::set_permissions(&target, original_permissions).unwrap();
    let error = outcome.unwrap_err();
    assert_eq!(error.raw_os_error(), Some(5), "{error}");
    assert_eq!(fs::read(&target).unwrap(), b"Synthetic original.");
    assert_eq!(fs::read(&staged).unwrap(), b"Synthetic replacement.");
}

#[test]
fn legacy_replace_reports_native_result_with_retained_reader() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("target.md");
    fs::write(&target, b"Synthetic original.").unwrap();
    let mut original = crate::windows_source::open(&target).unwrap();
    let mut replacement = tempfile::NamedTempFile::new_in(root.path()).unwrap();
    std::io::Write::write_all(&mut replacement, b"Synthetic replacement.").unwrap();
    match replacement.persist(&target) {
        Ok(_) => {
            println!("legacy retained-target replacement succeeded");
            assert_eq!(fs::read(&target).unwrap(), b"Synthetic replacement.");
        }
        Err(error) => {
            println!(
                "legacy retained-target replacement failed: {:?}",
                error.error.raw_os_error()
            );
            assert_eq!(fs::read(&target).unwrap(), b"Synthetic original.");
            assert_eq!(
                fs::read(error.file.path()).unwrap(),
                b"Synthetic replacement."
            );
        }
    }
    let mut retained = String::new();
    original.read_to_string(&mut retained).unwrap();
    assert_eq!(retained, "Synthetic original.");
}

#[test]
fn replacement_respects_exclusive_target_handle() {
    let root = tempfile::tempdir().unwrap();
    let target = root.path().join("target.md");
    let staged = root.path().join("stage.md");
    fs::write(&target, b"Synthetic original.").unwrap();
    let exclusive = OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&target)
        .unwrap();
    let mut replacement = stage(&staged);
    std::io::Write::write_all(&mut replacement, b"Synthetic replacement.").unwrap();
    let outcome = rename_by_handle(&replacement, root.path(), "target.md", true);
    drop(exclusive);
    let error = outcome.unwrap_err();
    assert!(matches!(error.raw_os_error(), Some(5 | 32)), "{error}");
    assert_eq!(fs::read(&target).unwrap(), b"Synthetic original.");
    assert_eq!(fs::read(&staged).unwrap(), b"Synthetic replacement.");
}

#[test]
fn absent_target_publication_retains_staged_identity() {
    let root = tempfile::tempdir().unwrap();
    let staged = root.path().join("stage.md");
    let mut replacement = stage(&staged);
    std::io::Write::write_all(&mut replacement, b"Synthetic replacement.").unwrap();
    replacement.sync_all().unwrap();
    let staged_id = identity(&replacement).unwrap();
    rename_by_handle(&replacement, root.path(), "target.md", false).unwrap();
    assert!(!staged.exists());
    let target = root.path().join("target.md");
    assert_eq!(identity(&open_shared(&target).unwrap()).unwrap(), staged_id);
    assert_eq!(fs::read(target).unwrap(), b"Synthetic replacement.");
}
