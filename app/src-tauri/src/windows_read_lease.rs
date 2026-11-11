//! Advisory native read invalidation; this grants no write or publication authority.
use std::cell::UnsafeCell;
use std::fs::{File, OpenOptions};
use std::io;
use std::mem::size_of;
use std::os::windows::io::{FromRawHandle, OwnedHandle};
use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
use std::path::Path;
use windows_sys::Win32::Foundation::{
    ERROR_IO_PENDING, ERROR_NOT_FOUND, ERROR_OPERATION_ABORTED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Storage::FileSystem::{
    FILE_FLAG_OPEN_REPARSE_POINT, FILE_FLAG_OVERLAPPED, FILE_SHARE_DELETE, FILE_SHARE_READ,
    FILE_SHARE_WRITE,
};
use windows_sys::Win32::System::Ioctl::{
    FSCTL_REQUEST_OPLOCK, OPLOCK_LEVEL_CACHE_READ, REQUEST_OPLOCK_CURRENT_VERSION,
    REQUEST_OPLOCK_INPUT_BUFFER, REQUEST_OPLOCK_INPUT_FLAG_REQUEST, REQUEST_OPLOCK_OUTPUT_BUFFER,
};
use windows_sys::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows_sys::Win32::System::IO::{
    CancelIoEx, DeviceIoControl, GetOverlappedResult, OVERLAPPED,
};

pub(crate) struct ReadLease {
    file: File,
    event: OwnedHandle,
    input: Box<REQUEST_OPLOCK_INPUT_BUFFER>,
    output: Box<UnsafeCell<REQUEST_OPLOCK_OUTPUT_BUFFER>>,
    overlapped: Box<UnsafeCell<OVERLAPPED>>,
    is_pending: bool,
}

impl ReadLease {
    /// Bind a read-only lease to the exact retained object supplying the bytes.
    /// Refuse unsupported or immediately broken leases instead of trusting timestamps.
    pub(crate) fn acquire(path: &Path, expected: &File) -> io::Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OVERLAPPED | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        let retained =
            crate::windows_file_stamp::Stamp::read(expected).map_err(io::Error::other)?;
        let observed = crate::windows_file_stamp::Stamp::read(&file).map_err(io::Error::other)?;
        if retained.object != observed.object {
            return Err(io::Error::other(
                "read lease opened a different file object",
            ));
        }
        // SAFETY: no security descriptor/name; the resulting manual-reset event
        // is exclusively owned below and outlives the pending request.
        let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        if event.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: successful CreateEventW returns a fresh owned handle.
        let event = unsafe { OwnedHandle::from_raw_handle(event) };
        let mut lease = Self {
            file,
            input: Box::new(REQUEST_OPLOCK_INPUT_BUFFER {
                StructureVersion: REQUEST_OPLOCK_CURRENT_VERSION as u16,
                StructureLength: size_of::<REQUEST_OPLOCK_INPUT_BUFFER>() as u16,
                RequestedOplockLevel: OPLOCK_LEVEL_CACHE_READ,
                Flags: REQUEST_OPLOCK_INPUT_FLAG_REQUEST,
            }),
            output: Box::new(UnsafeCell::new(REQUEST_OPLOCK_OUTPUT_BUFFER::default())),
            overlapped: Box::new(UnsafeCell::new(OVERLAPPED {
                hEvent: event.as_raw_handle(),
                ..OVERLAPPED::default()
            })),
            event,
            is_pending: false,
        };
        // SAFETY: all asynchronous buffers have stable heap addresses and stay
        // alive until Drop cancels/drains completion. UnsafeCell permits OS writes;
        // Rust does not read output/OVERLAPPED while the operation is pending.
        let result = unsafe {
            DeviceIoControl(
                lease.file.as_raw_handle(),
                FSCTL_REQUEST_OPLOCK,
                (&*lease.input as *const REQUEST_OPLOCK_INPUT_BUFFER).cast(),
                size_of::<REQUEST_OPLOCK_INPUT_BUFFER>() as u32,
                lease.output.get().cast(),
                size_of::<REQUEST_OPLOCK_OUTPUT_BUFFER>() as u32,
                std::ptr::null_mut(),
                lease.overlapped.get(),
            )
        };
        if result != 0 {
            return Err(io::Error::other(
                "oplock completed without a retained read lease",
            ));
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_IO_PENDING as i32) {
            return Err(error);
        }
        lease.is_pending = true;
        if !lease.is_valid()? {
            return Err(io::Error::other(
                "native read lease was invalidated during acquisition",
            ));
        }
        Ok(lease)
    }

    /// An event completion invalidates the observation, regardless of its reason.
    pub(crate) fn is_valid(&self) -> io::Result<bool> {
        // SAFETY: this live event belongs to the retained request; zero timeout
        // observes invalidation without waiting or reading asynchronous buffers.
        match unsafe { WaitForSingleObject(self.event.as_raw_handle(), 0) } {
            WAIT_TIMEOUT => Ok(true),
            WAIT_OBJECT_0 => Ok(false),
            result => Err(io::Error::other(format!(
                "unexpected native read-lease wait result {result}: {}",
                io::Error::last_os_error()
            ))),
        }
    }

    #[cfg(test)]
    pub(crate) fn assert_broken_without_ack(&self) {
        use windows_sys::Win32::System::Ioctl::REQUEST_OPLOCK_OUTPUT_FLAG_ACK_REQUIRED;
        assert!(!self.is_valid().unwrap());
        let mut transferred = 0;
        // SAFETY: a signaled event means this request completed, and the file,
        // event, buffers and OVERLAPPED still belong to this lease.
        let result = unsafe {
            GetOverlappedResult(
                self.file.as_raw_handle(),
                self.overlapped.get(),
                &mut transferred,
                0,
            )
        };
        assert_ne!(result, 0, "{}", io::Error::last_os_error());
        // SAFETY: completion has been observed; the OS no longer writes output.
        let output = unsafe { *self.output.get() };
        assert_eq!(output.NewOplockLevel, 0);
        assert_eq!(output.Flags & REQUEST_OPLOCK_OUTPUT_FLAG_ACK_REQUIRED, 0);
    }
}

impl Drop for ReadLease {
    fn drop(&mut self) {
        if !self.is_pending {
            return;
        }
        // SAFETY: cancel only this request, then wait for terminal completion
        // before releasing any of its stable buffers or handles, even on panic.
        let cancelled = unsafe { CancelIoEx(self.file.as_raw_handle(), self.overlapped.get()) };
        if cancelled == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_NOT_FOUND as i32) {
                eprintln!("oplock cancellation failed: {error}");
            }
        }
        let mut transferred = 0;
        // SAFETY: buffers and handle remain live until this completion returns.
        let completed = unsafe {
            GetOverlappedResult(
                self.file.as_raw_handle(),
                self.overlapped.get(),
                &mut transferred,
                1,
            )
        };
        if completed == 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_OPERATION_ABORTED as i32) {
                eprintln!("oplock completion failed: {error}");
            }
        }
    }
}
