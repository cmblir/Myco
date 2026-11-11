//! Real relative creation and handle-only cleanup; no production authority.
use super::*;
use std::os::windows::io::FromRawHandle;
use windows_sys::Wdk::Foundation::OBJECT_ATTRIBUTES;
use windows_sys::Wdk::Storage::FileSystem::{
    FileDispositionInformationEx, NtCreateFile, FILE_CREATE, FILE_DISPOSITION_DELETE,
    FILE_DISPOSITION_INFORMATION_EX, FILE_DISPOSITION_POSIX_SEMANTICS, FILE_NON_DIRECTORY_FILE,
    FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT,
};
use windows_sys::Win32::Foundation::{OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE, UNICODE_STRING};
use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;

fn create_relative(parent: &File, leaf: &str) -> io::Result<File> {
    assert!(!leaf.is_empty() && !matches!(leaf, "." | ".."));
    assert!(!leaf.contains(['/', '\\', '\0', ':']));
    let mut name_units: Vec<u16> = std::ffi::OsStr::new(leaf).encode_wide().collect();
    let length = u16::try_from(name_units.len() * 2).unwrap();
    let name = UNICODE_STRING {
        Length: length,
        MaximumLength: length,
        Buffer: name_units.as_mut_ptr(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: parent.as_raw_handle(),
        ObjectName: &name,
        Attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
        ..OBJECT_ATTRIBUTES::default()
    };
    let mut handle = std::ptr::null_mut();
    let mut completion = IO_STATUS_BLOCK::default();
    // SAFETY: all inputs remain live through the synchronous call. CREATE refuses
    // collisions; a single relative leaf and no-reparse flags avoid path traversal.
    let status = unsafe {
        NtCreateFile(
            &mut handle,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE,
            &attributes,
            &mut completion,
            std::ptr::null(),
            FILE_ATTRIBUTE_NORMAL,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            FILE_CREATE,
            FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT,
            std::ptr::null(),
            0,
        )
    };
    if status < 0 {
        // SAFETY: pure status conversion.
        return Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(status) } as i32,
        ));
    }
    assert_eq!(status, 0, "synchronous create returned {status:#x}");
    assert!(!handle.is_null());
    // SAFETY: successful creation returns a fresh exclusively owned handle.
    Ok(unsafe { File::from_raw_handle(handle) })
}

fn remove_held(file: File) -> io::Result<()> {
    let disposition = FILE_DISPOSITION_INFORMATION_EX {
        Flags: FILE_DISPOSITION_DELETE | FILE_DISPOSITION_POSIX_SEMANTICS,
    };
    let mut completion = IO_STATUS_BLOCK::default();
    // SAFETY: live owned synchronous handle and initialized fixed-size request.
    let status = unsafe {
        NtSetInformationFile(
            file.as_raw_handle(),
            &mut completion,
            (&disposition as *const FILE_DISPOSITION_INFORMATION_EX).cast(),
            size_of::<FILE_DISPOSITION_INFORMATION_EX>() as u32,
            FileDispositionInformationEx,
        )
    };
    if status < 0 {
        // SAFETY: pure status conversion.
        return Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(status) } as i32,
        ));
    }
    assert_eq!(status, 0);
    // Closing this particular delete handle completes POSIX unlink.
    drop(file);
    Ok(())
}

#[test]
fn relative_create_uses_retained_parent_and_never_overwrites_a_collision() {
    use std::io::Write;
    let root = tempfile::tempdir().unwrap();
    let named = root.path().join("Synthetic parent");
    let retained = root.path().join("retained");
    fs::create_dir(&named).unwrap();
    let parent = parent_handle(&named);
    fs::rename(&named, &retained).unwrap();
    fs::create_dir(&named).unwrap();
    fs::write(named.join("Synthetic 한글 stage.md"), b"unrelated bytes").unwrap();
    let mut file = create_relative(&parent, "Synthetic 한글 stage.md").unwrap();
    file.write_all(b"owned stage").unwrap();
    file.sync_all().unwrap();
    let error = create_relative(&parent, "Synthetic 한글 stage.md").unwrap_err();
    assert!(matches!(error.raw_os_error(), Some(80 | 183)), "{error}");
    assert_eq!(
        fs::read(retained.join("Synthetic 한글 stage.md")).unwrap(),
        b"owned stage"
    );
    assert_eq!(
        fs::read(named.join("Synthetic 한글 stage.md")).unwrap(),
        b"unrelated bytes"
    );
    remove_held(file).unwrap();
    assert!(!retained.join("Synthetic 한글 stage.md").exists());
    assert_eq!(
        fs::read(named.join("Synthetic 한글 stage.md")).unwrap(),
        b"unrelated bytes"
    );
}

#[test]
fn handle_cleanup_preserves_a_replacement_at_the_old_stage_name() {
    use std::io::{Read, Write};
    let root = tempfile::tempdir().unwrap();
    let parent = parent_handle(root.path());
    let mut file = create_relative(&parent, "stage.md").unwrap();
    file.write_all(b"owned stage").unwrap();
    file.sync_all().unwrap();
    rename_relative(&file, &parent, "retained.md", false).unwrap();
    fs::write(root.path().join("stage.md"), b"unrelated replacement").unwrap();
    let mut reader = open_shared(&root.path().join("retained.md")).unwrap();
    remove_held(file).unwrap();
    assert!(!root.path().join("retained.md").exists());
    let mut held = Vec::new();
    reader.read_to_end(&mut held).unwrap();
    assert_eq!(held, b"owned stage");
    assert_eq!(
        fs::read(root.path().join("stage.md")).unwrap(),
        b"unrelated replacement"
    );
}

#[test]
fn handle_cleanup_does_not_override_a_readonly_file() {
    use std::io::Write;
    let root = tempfile::tempdir().unwrap();
    let parent = parent_handle(root.path());
    let path = root.path().join("stage.md");
    let mut file = create_relative(&parent, "stage.md").unwrap();
    file.write_all(b"preserved readonly stage").unwrap();
    let original = file.metadata().unwrap().permissions();
    let mut readonly = original.clone();
    readonly.set_readonly(true);
    file.set_permissions(readonly).unwrap();
    let result = remove_held(file);
    fs::set_permissions(&path, original).unwrap();
    let error = result.unwrap_err();
    assert_eq!(error.raw_os_error(), Some(5), "{error}");
    assert_eq!(fs::read(path).unwrap(), b"preserved readonly stage");
}
