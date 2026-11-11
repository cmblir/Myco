//! Runtime checks for the same lease used by bounded production index reads.
use super::*;
use crate::windows_read_lease::ReadLease;
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use windows_sys::Win32::System::Memory::{
    CreateFileMappingW, MapViewOfFile, UnmapViewOfFile, FILE_MAP_WRITE, MEMORY_MAPPED_VIEW_ADDRESS,
    PAGE_READWRITE,
};

#[test]
fn read_lease_can_be_observed_and_cancelled_on_another_thread() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("Synthetic cross-thread index.mxb");
    fs::write(&path, b"alpha").unwrap();
    let lease = ReadLease::acquire(&path, &open_shared(&path).unwrap()).unwrap();
    std::thread::spawn(move || {
        assert!(lease.is_valid().unwrap());
        drop(lease);
    })
    .join()
    .unwrap();
    fs::write(&path, b"bravo").unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"bravo");
    let lease = ReadLease::acquire(&path, &open_shared(&path).unwrap()).unwrap();
    fs::write(&path, b"alpha").unwrap();
    std::thread::spawn(move || {
        lease.assert_broken_without_ack();
        drop(lease);
    })
    .join()
    .unwrap();
}

struct WritableView {
    view: MEMORY_MAPPED_VIEW_ADDRESS,
    _mapping: OwnedHandle,
}

impl WritableView {
    fn open(file: &File) -> Self {
        // SAFETY: the test file is nonempty and writable; no named/shared mapping.
        let mapping = unsafe {
            CreateFileMappingW(
                file.as_raw_handle(),
                std::ptr::null(),
                PAGE_READWRITE,
                0,
                0,
                std::ptr::null(),
            )
        };
        assert!(!mapping.is_null(), "{}", std::io::Error::last_os_error());
        // SAFETY: a successful creation returns a fresh owned handle.
        let mapping = unsafe { OwnedHandle::from_raw_handle(mapping) };
        // SAFETY: map the five-byte test file and retain the mapping until unmap.
        let view = unsafe { MapViewOfFile(mapping.as_raw_handle(), FILE_MAP_WRITE, 0, 0, 5) };
        assert!(!view.Value.is_null(), "{}", std::io::Error::last_os_error());
        Self {
            view,
            _mapping: mapping,
        }
    }
}

impl Drop for WritableView {
    fn drop(&mut self) {
        // SAFETY: this view is live and owned exclusively by this test wrapper.
        if unsafe { UnmapViewOfFile(self.view) } == 0 {
            eprintln!(
                "test view unmap failed: {}",
                std::io::Error::last_os_error()
            );
        }
    }
}

#[test]
fn existing_writable_mapping_prevents_read_lease() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("Synthetic mapped index.mxb");
    fs::write(&path, b"alpha").unwrap();
    let writer = File::options().read(true).write(true).open(&path).unwrap();
    let view = WritableView::open(&writer);
    assert!(ReadLease::acquire(&path, &writer).is_err());
    drop(view);
    drop(writer);
    assert!(ReadLease::acquire(&path, &open_shared(&path).unwrap()).is_ok());
}

#[test]
fn new_writable_mapping_breaks_existing_read_lease() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("Synthetic mapped index.mxb");
    fs::write(&path, b"alpha").unwrap();
    let writer = File::options().read(true).write(true).open(&path).unwrap();
    let lease = ReadLease::acquire(&path, &writer).unwrap();
    let view = WritableView::open(&writer);
    lease.assert_broken_without_ack();
    // SAFETY: the exclusively owned writable view spans five initialized bytes.
    unsafe { std::ptr::copy_nonoverlapping(b"bravo".as_ptr(), view.view.Value.cast(), 5) };
    assert!(!lease.is_valid().unwrap());
    assert_eq!(fs::read(&path).unwrap(), b"bravo");
}

#[test]
fn read_lease_survives_reads_and_cancels_without_blocking_a_later_writer() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("Synthetic 한글 index.mxb");
    fs::write(&path, b"alpha").unwrap();
    let lease = ReadLease::acquire(&path, &open_shared(&path).unwrap()).unwrap();
    for _ in 0..16 {
        assert_eq!(fs::read(&path).unwrap(), b"alpha");
        assert!(lease.is_valid().unwrap());
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
        let lease = ReadLease::acquire(&path, &open_shared(&path).unwrap()).unwrap();
        assert!(lease.is_valid().unwrap());
        assert_eq!(
            identity(&held_reader).unwrap(),
            identity(&open_shared(&path).unwrap()).unwrap()
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
    let first = ReadLease::acquire(&path, &open_shared(&path).unwrap()).unwrap();
    let second = ReadLease::acquire(&path, &open_shared(&path).unwrap()).unwrap();
    assert!(first.is_valid().unwrap() && second.is_valid().unwrap());
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
        let lease = ReadLease::acquire(&path, &open_shared(&path).unwrap()).unwrap();
        assert!(lease.is_valid().unwrap());
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

#[test]
fn lease_rejects_a_different_retained_object_even_with_matching_bytes() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("Synthetic index.mxb");
    let old = root.path().join("retained.mxb");
    fs::write(&path, b"alpha").unwrap();
    let held = open_shared(&path).unwrap();
    fs::rename(&path, &old).unwrap();
    fs::write(&path, b"alpha").unwrap();
    assert!(ReadLease::acquire(&path, &held).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"alpha");
    assert_eq!(fs::read(&old).unwrap(), b"alpha");
}
