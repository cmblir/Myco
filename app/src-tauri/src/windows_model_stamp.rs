//! Native change observations for the pinned model verification cache.
use std::fs::{File, OpenOptions};
use std::io;
use std::mem::{size_of, MaybeUninit};
use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
use std::path::Path;
use windows_sys::Win32::Storage::FileSystem::{
    FileBasicInfo, GetFileInformationByHandleEx, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_BASIC_INFO, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Stamp {
    pub(crate) object: (u64, [u8; 16]),
    changed: i64,
}

impl Stamp {
    /// Observe the same open object that supplies model bytes, not a path cache.
    pub(crate) fn read(file: &File) -> Result<Self, String> {
        let mut basic = MaybeUninit::<FILE_BASIC_INFO>::uninit();
        // SAFETY: the borrowed handle and buffer exactly match FileBasicInfo.
        let success = unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileBasicInfo,
                basic.as_mut_ptr().cast(),
                size_of::<FILE_BASIC_INFO>() as u32,
            )
        };
        if success == 0 {
            return Err(format!(
                "inspect native model change time: {}",
                io::Error::last_os_error()
            ));
        }
        // SAFETY: success initialized this exact FILE_BASIC_INFO buffer.
        let basic = unsafe { basic.assume_init() };
        if basic.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY) != 0 {
            return Err("local model handle is not a regular non-reparse file".into());
        }
        Ok(Self {
            object: crate::windows_source::identity(file)
                .map_err(|error| format!("identify native model file: {error}"))?,
            changed: basic.ChangeTime,
        })
    }
}

/// Open the final component without following a reparse target.
pub(crate) fn open(path: &Path) -> Result<File, String> {
    let file = OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|error| format!("open native model file: {error}"))?;
    Stamp::read(&file)?;
    Ok(file)
}
