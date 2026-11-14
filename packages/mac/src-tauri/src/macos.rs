//! What the app asks of macOS: its background item, the screen's two grants, and a few facts about
//! this account and its processes.

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject};
use objc2::msg_send;
use objc2_foundation::{NSBundle, NSDictionary, NSError, NSNumber, NSString};
use std::ffi::{c_void, CStr};
use std::path::PathBuf;

#[link(name = "ServiceManagement", kind = "framework")]
unsafe extern "C" {}

#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> u8;
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> u8;
    static kAXTrustedCheckOptionPrompt: *const c_void;
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

/// The app's identifier, from its bundle.
pub fn identifier() -> Option<String> {
    NSBundle::mainBundle().bundleIdentifier().map(|id| id.to_string())
}

/// The background item the bundle carries:
/// `Contents/Library/LaunchAgents/<identifier>.provider.plist`.
fn background_item() -> Option<Retained<AnyObject>> {
    let class = AnyClass::get(c"SMAppService")?;
    let plist = NSString::from_str(&format!("{}.provider.plist", identifier()?));
    unsafe { msg_send![class, agentServiceWithPlistName: &*plist] }
}

/// Registers the background item unless it is on or waiting for the person's approval, so that a
/// person's choice in Login Items stands, and says where it stands, as the log reads it.
pub fn register_background_item() -> String {
    let Some(item) = background_item() else { return "no background item in this build".into() };
    let status = |item: &AnyObject| -> isize { unsafe { msg_send![item, status] } };
    if !matches!(status(&item), 1 | 2) {
        let done: Result<(), Retained<NSError>> =
            unsafe { msg_send![&*item, registerAndReturnError: _] };
        if let Err(error) = done {
            let why = error.localizedDescription();
            return format!("the background item couldn't be registered: {why}");
        }
    }
    match status(&item) {
        0 => "the background item isn't registered".into(),
        1 => "the background item is on".into(),
        2 => "the background item waits for the person's approval in Login Items".into(),
        _ => "the background item isn't in this build".into(),
    }
}

/// Whether this process has a grant, as macOS answers this process.
pub fn granted(need: &str) -> bool {
    match need {
        "accessibility" => unsafe { AXIsProcessTrusted() != 0 },
        "screen-recording" => unsafe { CGPreflightScreenCaptureAccess() },
        _ => false,
    }
}

/// macOS's own request for a grant: Accessibility's alert, or Screen Recording's, which only adds
/// the app to its list.
pub fn request(need: &str) {
    match need {
        "accessibility" => unsafe {
            let key = &*(kAXTrustedCheckOptionPrompt as *const NSString);
            let options = NSDictionary::from_slices(&[key], &[&*NSNumber::new_bool(true)]);
            AXIsProcessTrustedWithOptions(Retained::as_ptr(&options) as *const c_void);
        },
        "screen-recording" => unsafe {
            CGRequestScreenCaptureAccess();
        },
        _ => {}
    }
}

/// The account's login shell, from its user record.
pub fn login_shell() -> Option<String> {
    let user = unsafe { libc::getpwuid(libc::getuid()) };
    if user.is_null() {
        return None;
    }
    let shell = unsafe { CStr::from_ptr((*user).pw_shell) };
    shell.to_str().ok().filter(|shell| !shell.is_empty()).map(str::to_owned)
}

pub fn alive(pid: i32) -> bool {
    pid > 0 && unsafe { libc::kill(pid, 0) } == 0
}

/// The program a process runs, by its path.
pub fn program_of(pid: i32) -> Option<PathBuf> {
    let mut path = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let length = unsafe { libc::proc_pidpath(pid, path.as_mut_ptr().cast(), path.len() as u32) };
    let path = String::from_utf8_lossy(&path[..length.max(0) as usize]).into_owned();
    (length > 0).then(|| PathBuf::from(path))
}
