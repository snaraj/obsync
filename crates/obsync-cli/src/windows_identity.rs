//! Owner-approved read-only identity for an already-open file handle.
use std::{ffi::c_void, fs::File, io, os::windows::io::AsRawHandle};

#[repr(C)]
#[derive(Default)]
struct Information {
    attributes: u32,
    creation_time: [u32; 2],
    access_time: [u32; 2],
    write_time: [u32; 2],
    volume: u32,
    size_high: u32,
    size_low: u32,
    links: u32,
    index_high: u32,
    index_low: u32,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetFileInformationByHandle(file: *mut c_void, information: *mut Information) -> i32;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Identity {
    pub volume: u32,
    pub index: u64,
    pub links: u32,
    pub attributes: u32,
}

pub fn identity(file: &File) -> io::Result<Identity> {
    let mut info = Information::default();
    // SAFETY: File owns a live handle throughout the call, and info is writable,
    // aligned storage with the documented BY_HANDLE_FILE_INFORMATION layout.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(Identity {
        volume: info.volume,
        index: (u64::from(info.index_high) << 32) | u64::from(info.index_low),
        links: info.links,
        attributes: info.attributes,
    })
}
