//! Real Windows handle experiments; these tests grant no publication authority.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::mem::{size_of, MaybeUninit};
use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
use std::path::Path;
use windows_sys::Win32::Foundation::ERROR_SHARING_VIOLATION;
use windows_sys::Win32::Storage::FileSystem::{
    FileIdInfo, FileStandardInfo, GetFileInformationByHandleEx, GetVolumeInformationByHandleW,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_STANDARD_INFO,
};

fn open_shared(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

fn identity(file: &File) -> io::Result<(u64, [u8; 16])> {
    let mut value = MaybeUninit::<FILE_ID_INFO>::uninit();
    // SAFETY: the live borrowed handle and buffer match FileIdInfo exactly.
    let success = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileIdInfo,
            value.as_mut_ptr().cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if success == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: success guarantees that the requested FILE_ID_INFO was written.
    let value = unsafe { value.assume_init() };
    Ok((value.VolumeSerialNumber, value.FileId.Identifier))
}

fn standard(file: &File) -> io::Result<FILE_STANDARD_INFO> {
    let mut value = MaybeUninit::<FILE_STANDARD_INFO>::uninit();
    // SAFETY: the live borrowed handle and buffer match FileStandardInfo.
    let success = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileStandardInfo,
            value.as_mut_ptr().cast(),
            size_of::<FILE_STANDARD_INFO>() as u32,
        )
    };
    if success == 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: success guarantees initialization of this exact native structure.
    Ok(unsafe { value.assume_init() })
}

fn report_filesystem(file: &File) -> io::Result<()> {
    let mut name = [0u16; 64];
    // SAFETY: the handle is live, optional outputs are null, and the output
    // buffer has the declared number of UTF-16 code units.
    let success = unsafe {
        GetVolumeInformationByHandleW(
            file.as_raw_handle(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            name.as_mut_ptr(),
            name.len() as u32,
        )
    };
    if success == 0 {
        return Err(io::Error::last_os_error());
    }
    let end = name
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(name.len());
    println!(
        "Windows identity fixture filesystem: {}",
        String::from_utf16_lossy(&name[..end])
    );
    Ok(())
}

#[test]
fn windows_handle_identity_distinguishes_same_byte_replacement_and_survives_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("한글 synthetic source.md");
    let retained_path = directory.path().join("retained.md");
    let original = b"synthetic original";
    fs::write(&path, original).unwrap();
    let held = open_shared(&path).unwrap();
    report_filesystem(&held).unwrap();
    let original_id = identity(&held).unwrap();
    assert_ne!(original_id.1, [0; 16]);
    assert_eq!(identity(&open_shared(&path).unwrap()).unwrap(), original_id);
    fs::write(&path, b"synthetic changed").unwrap();
    assert_eq!(identity(&held).unwrap(), original_id);
    fs::write(&path, original).unwrap();
    fs::rename(&path, &retained_path).unwrap();
    fs::write(&path, original).unwrap();
    assert_ne!(identity(&open_shared(&path).unwrap()).unwrap(), original_id);
    assert_eq!(identity(&held).unwrap(), original_id);
    drop(held);
    assert_eq!(
        identity(&open_shared(&retained_path).unwrap()).unwrap(),
        original_id
    );
    assert_eq!(fs::read(&path).unwrap(), original);
    assert_eq!(fs::read(&retained_path).unwrap(), original);
}

#[test]
fn windows_handle_reports_an_added_hard_link() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("source.md");
    let alias = directory.path().join("alias.md");
    fs::write(&path, b"synthetic original").unwrap();
    let held = open_shared(&path).unwrap();
    assert_eq!(standard(&held).unwrap().NumberOfLinks, 1);
    fs::hard_link(&path, &alias).unwrap();
    assert_eq!(standard(&held).unwrap().NumberOfLinks, 2);
    assert_eq!(
        identity(&held).unwrap(),
        identity(&open_shared(&alias).unwrap()).unwrap()
    );
}

#[test]
fn windows_retained_directory_detects_replacement() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("private directory");
    let renamed = directory.path().join("retained directory");
    fs::create_dir(&path).unwrap();
    let held = open_shared(&path).unwrap();
    assert!(standard(&held).unwrap().Directory);
    let original_id = identity(&held).unwrap();
    fs::rename(&path, &renamed).unwrap();
    fs::create_dir(&path).unwrap();
    assert_ne!(identity(&open_shared(&path).unwrap()).unwrap(), original_id);
    assert_eq!(
        identity(&held).unwrap(),
        identity(&open_shared(&renamed).unwrap()).unwrap()
    );
}

#[test]
fn windows_sharing_denial_preserves_source_until_handle_release() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("source.md");
    let original = b"synthetic original";
    fs::write(&path, original).unwrap();
    let held = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(&path)
        .unwrap();
    // Rust need not map a sharing violation to PermissionDenied. Require the
    // specific native denial instead of conflating it with an ACL failure.
    let write_error = fs::write(&path, b"replacement").unwrap_err();
    assert_eq!(
        write_error.raw_os_error(),
        Some(ERROR_SHARING_VIOLATION as i32),
        "{write_error:?}"
    );
    let delete_error = fs::remove_file(&path).unwrap_err();
    assert_eq!(
        delete_error.raw_os_error(),
        Some(ERROR_SHARING_VIOLATION as i32),
        "{delete_error:?}"
    );
    assert_eq!(fs::read(&path).unwrap(), original);
    drop(held);
    fs::write(&path, b"replacement").unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"replacement");
    fs::remove_file(&path).unwrap();
    assert!(!path.exists());
}

#[path = "windows_rename_tests.rs"]
mod rename;
