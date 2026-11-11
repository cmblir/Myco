//! Retained Windows source identity; this grants no publication authority.
use std::fs::{File, OpenOptions};
use std::io;
use std::mem::{size_of, MaybeUninit};
use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
use std::path::Path;
use windows_sys::Win32::Storage::FileSystem::{
    FileIdInfo, FileStandardInfo, GetFileInformationByHandleEx, FILE_FLAG_BACKUP_SEMANTICS,
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE, FILE_STANDARD_INFO,
};

/// Read native object identity only; this does not establish content or custody.
pub(crate) fn identity(file: &File) -> io::Result<(u64, [u8; 16])> {
    let mut value = MaybeUninit::<FILE_ID_INFO>::uninit();
    // SAFETY: the borrowed live handle, information class and output layout match.
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
    // SAFETY: the successful call initialized this exact FILE_ID_INFO buffer.
    let value = unsafe { value.assume_init() };
    Ok((value.VolumeSerialNumber, value.FileId.Identifier))
}

fn validate(file: &File) -> Result<(), String> {
    use std::os::windows::fs::MetadataExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
    let metadata = file
        .metadata()
        .map_err(|error| format!("inspect Windows source: {error}"))?;
    if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("Windows source is not a regular non-reparse file".into());
    }
    let mut value = MaybeUninit::<FILE_STANDARD_INFO>::uninit();
    // SAFETY: the borrowed handle and output buffer match FileStandardInfo.
    let success = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileStandardInfo,
            value.as_mut_ptr().cast(),
            size_of::<FILE_STANDARD_INFO>() as u32,
        )
    };
    if success == 0 {
        return Err(format!(
            "inspect Windows source links: {}",
            io::Error::last_os_error()
        ));
    }
    // SAFETY: success initialized the exact requested native structure.
    let value = unsafe { value.assume_init() };
    if value.Directory || value.DeletePending || value.NumberOfLinks != 1 {
        return Err("Windows source is deleted, non-regular or has unowned hard links".into());
    }
    Ok(())
}

/// Open the final component itself and retain sharing needed to detect replacement.
/// Callers must confine the complete path before calling this function.
pub(crate) fn open(path: &Path) -> Result<File, String> {
    let file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| format!("open Windows source: {error}"))?;
    validate(&file)?;
    Ok(file)
}

/// Compare volume and 128-bit file ID while both objects remain retained.
pub(crate) fn verify(file: &File, path: &Path) -> Result<(), String> {
    validate(file)?;
    let named = open(path)?;
    let held_id =
        identity(file).map_err(|error| format!("identify retained Windows source: {error}"))?;
    let named_id =
        identity(&named).map_err(|error| format!("identify named Windows source: {error}"))?;
    if held_id != named_id {
        return Err("Windows source identity changed".into());
    }
    validate(file)?;
    validate(&named)
}

#[cfg(test)]
#[path = "windows_source_tests.rs"]
mod tests;
