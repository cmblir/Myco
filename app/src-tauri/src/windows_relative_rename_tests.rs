//! Native parent-handle rename probes; not production custody or durability.
use super::*;
use std::mem::offset_of;
use std::os::windows::ffi::OsStrExt;
use windows_sys::Wdk::Storage::FileSystem::{
    FileRenameInformationEx, NtSetInformationFile, FILE_RENAME_INFORMATION,
    FILE_RENAME_POSIX_SEMANTICS, FILE_RENAME_REPLACE_IF_EXISTS,
};
use windows_sys::Win32::Foundation::RtlNtStatusToDosError;
use windows_sys::Win32::Storage::FileSystem::{
    DELETE, FILE_GENERIC_READ, FILE_GENERIC_WRITE, FILE_READ_ATTRIBUTES, FILE_TRAVERSE, SYNCHRONIZE,
};
use windows_sys::Win32::System::IO::IO_STATUS_BLOCK;

fn parent_handle(path: &Path) -> File {
    OpenOptions::new()
        .access_mode(FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .unwrap()
}

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

fn rename_relative(file: &File, parent: &File, name: &str, replace: bool) -> io::Result<()> {
    assert!(!name.is_empty() && !matches!(name, "." | ".."));
    assert!(!name.contains(['/', '\\', '\0', ':']));
    let name: Vec<u16> = std::ffi::OsStr::new(name).encode_wide().collect();
    let bytes = size_of::<FILE_RENAME_INFORMATION>() + name.len() * 2;
    let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
    let request = storage.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
    let mut completion = IO_STATUS_BLOCK::default();
    // SAFETY: aligned storage covers the native header and UTF-16 tail. Both
    // handles remain owned through this synchronous call (no OVERLAPPED flag).
    let status = unsafe {
        (*request).Anonymous.Flags = FILE_RENAME_POSIX_SEMANTICS
            | if replace {
                FILE_RENAME_REPLACE_IF_EXISTS
            } else {
                0
            };
        (*request).RootDirectory = parent.as_raw_handle();
        (*request).FileNameLength = (name.len() * 2) as u32;
        std::ptr::copy_nonoverlapping(
            name.as_ptr(),
            storage
                .as_mut_ptr()
                .cast::<u8>()
                .add(offset_of!(FILE_RENAME_INFORMATION, FileName))
                .cast::<u16>(),
            name.len(),
        );
        NtSetInformationFile(
            file.as_raw_handle(),
            &mut completion,
            request.cast(),
            bytes as u32,
            FileRenameInformationEx,
        )
    };
    if status < 0 {
        // SAFETY: pure NTSTATUS conversion; no borrowed pointers or handles.
        return Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(status) } as i32,
        ));
    }
    assert_eq!(
        status, 0,
        "synchronous rename returned nonterminal status {status:#x}"
    );
    Ok(())
}

#[test]
fn retained_parent_receives_rename_after_its_old_path_is_replaced() {
    let root = tempfile::tempdir().unwrap();
    let named = root.path().join("Synthetic 한글 parent");
    let retained = root.path().join("retained-parent");
    fs::create_dir(&named).unwrap();
    let parent = parent_handle(&named);
    let parent_id = identity(&parent).unwrap();
    fs::rename(&named, &retained).unwrap();
    fs::create_dir(&named).unwrap();
    fs::write(named.join("target.md"), b"unrelated original").unwrap();
    let staged = root.path().join("stage.md");
    let mut file = stage(&staged);
    std::io::Write::write_all(&mut file, b"intended bytes").unwrap();
    file.sync_all().unwrap();
    let staged_id = identity(&file).unwrap();
    rename_relative(&file, &parent, "target.md", false).unwrap();
    assert_eq!(
        identity(&open_shared(&retained).unwrap()).unwrap(),
        parent_id
    );
    assert_eq!(
        identity(&open_shared(&retained.join("target.md")).unwrap()).unwrap(),
        staged_id
    );
    assert_eq!(
        fs::read(retained.join("target.md")).unwrap(),
        b"intended bytes"
    );
    assert_eq!(
        fs::read(named.join("target.md")).unwrap(),
        b"unrelated original"
    );
    assert!(!staged.exists());
}

#[test]
fn relative_replace_retains_old_reader_and_no_replace_preserves_collision() {
    use std::io::Read;
    let root = tempfile::tempdir().unwrap();
    let parent = parent_handle(root.path());
    let target = root.path().join("Synthetic 한글 target.md");
    fs::write(&target, b"old bytes").unwrap();
    let mut old = open_shared(&target).unwrap();
    let staged = root.path().join("stage.md");
    let mut file = stage(&staged);
    std::io::Write::write_all(&mut file, b"new bytes").unwrap();
    file.sync_all().unwrap();
    let error = rename_relative(&file, &parent, "Synthetic 한글 target.md", false).unwrap_err();
    assert!(matches!(error.raw_os_error(), Some(80 | 183)), "{error}");
    assert_eq!(fs::read(&target).unwrap(), b"old bytes");
    assert_eq!(fs::read(&staged).unwrap(), b"new bytes");
    let staged_id = identity(&file).unwrap();
    rename_relative(&file, &parent, "Synthetic 한글 target.md", true).unwrap();
    let mut held_bytes = Vec::new();
    old.read_to_end(&mut held_bytes).unwrap();
    assert_eq!(held_bytes, b"old bytes");
    assert_eq!(fs::read(&target).unwrap(), b"new bytes");
    assert_eq!(identity(&open_shared(&target).unwrap()).unwrap(), staged_id);
    assert!(!staged.exists());
}
