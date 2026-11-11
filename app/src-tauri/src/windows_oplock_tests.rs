//! Native invalidation experiments; timestamps and journal records are not leases.
use super::*;
use std::cell::UnsafeCell;
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::windows::io::{FromRawHandle, OwnedHandle};
use windows_sys::Win32::Foundation::{
    ERROR_IO_PENDING, ERROR_NOT_FOUND, ERROR_OPERATION_ABORTED, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OVERLAPPED;
use windows_sys::Win32::System::Ioctl::{
    FSCTL_REQUEST_OPLOCK, OPLOCK_LEVEL_CACHE_READ, REQUEST_OPLOCK_CURRENT_VERSION,
    REQUEST_OPLOCK_INPUT_BUFFER, REQUEST_OPLOCK_INPUT_FLAG_REQUEST, REQUEST_OPLOCK_OUTPUT_BUFFER,
    REQUEST_OPLOCK_OUTPUT_FLAG_ACK_REQUIRED,
};
use windows_sys::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows_sys::Win32::System::IO::{
    CancelIoEx, DeviceIoControl, GetOverlappedResult, OVERLAPPED,
};

struct ReadLease {
    file: File,
    event: OwnedHandle,
    input: Box<REQUEST_OPLOCK_INPUT_BUFFER>,
    output: Box<UnsafeCell<REQUEST_OPLOCK_OUTPUT_BUFFER>>,
    overlapped: Box<UnsafeCell<OVERLAPPED>>,
    is_pending: bool,
}

impl ReadLease {
    fn request(path: &Path) -> io::Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OVERLAPPED | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
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
        Ok(lease)
    }

    fn is_valid(&self) -> bool {
        // SAFETY: this live event belongs to the retained request; zero timeout
        // observes invalidation without waiting or reading asynchronous buffers.
        match unsafe { WaitForSingleObject(self.event.as_raw_handle(), 0) } {
            WAIT_TIMEOUT => true,
            WAIT_OBJECT_0 => false,
            result => panic!("unexpected oplock wait result: {result}"),
        }
    }

    fn assert_broken_without_ack(&self) {
        assert!(!self.is_valid());
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

#[test]
fn read_lease_survives_reads_and_cancels_without_blocking_a_later_writer() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("Synthetic 한글 index.mxb");
    fs::write(&path, b"alpha").unwrap();
    let lease = ReadLease::request(&path).unwrap();
    for _ in 0..16 {
        assert_eq!(fs::read(&path).unwrap(), b"alpha");
        assert!(lease.is_valid());
    }
    drop(lease);
    fs::write(&path, b"bravo").unwrap();
    assert_eq!(fs::read(path).unwrap(), b"bravo");
}

#[test]
fn same_size_restored_time_writes_break_every_new_read_lease() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("Synthetic index.mxb");
    fs::write(&path, b"alpha").unwrap();
    let modified = fs::metadata(&path).unwrap().modified().unwrap();
    let held_reader = open_shared(&path).unwrap();
    for replacement in [b"bravo", b"alpha"].into_iter().cycle().take(16) {
        let lease = ReadLease::request(&path).unwrap();
        assert!(lease.is_valid());
        assert_eq!(
            identity(&lease.file).unwrap(),
            identity(&held_reader).unwrap()
        );
        fs::write(&path, replacement).unwrap();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        lease.assert_broken_without_ack();
        assert_eq!(fs::read(&path).unwrap(), replacement);
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
    }
}

#[test]
fn both_read_leases_invalidate_before_written_bytes_are_reused() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("Synthetic model.gguf");
    fs::write(&path, b"alpha").unwrap();
    let first = ReadLease::request(&path).unwrap();
    let second = ReadLease::request(&path).unwrap();
    assert!(first.is_valid() && second.is_valid());
    fs::write(&path, b"bravo").unwrap();
    first.assert_broken_without_ack();
    second.assert_broken_without_ack();
    assert_eq!(fs::read(path).unwrap(), b"bravo");
}

#[test]
fn retained_writer_cannot_change_bytes_under_an_unbroken_read_lease() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("Synthetic model.gguf");
    fs::write(&path, b"alpha").unwrap();
    let mut writer = File::options().read(true).write(true).open(&path).unwrap();
    for replacement in [b"bravo", b"alpha"] {
        let lease = ReadLease::request(&path).unwrap();
        assert!(lease.is_valid());
        writer.seek(SeekFrom::Start(0)).unwrap();
        writer.write_all(replacement).unwrap();
        writer.flush().unwrap();
        lease.assert_broken_without_ack();
        writer.seek(SeekFrom::Start(0)).unwrap();
        let mut actual = Vec::new();
        writer.read_to_end(&mut actual).unwrap();
        assert_eq!(actual, replacement);
    }
}
