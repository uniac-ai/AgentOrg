//! What the app asks of macOS: its background item, the screen's two grants, and a few facts about
//! this account and its processes.

use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject};
use objc2::{msg_send, AllocAnyThread};
use objc2_foundation::{NSBundle, NSDictionary, NSError, NSNumber, NSString, NSUserDefaults};
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

/// The name of the background item's plist, which the bundle carries in
/// `Contents/Library/LaunchAgents`.
pub fn provider_plist(identifier: &str) -> String {
    format!("{identifier}.provider.plist")
}

/// The background item the bundle carries.
fn background_item() -> Option<Retained<AnyObject>> {
    let class = AnyClass::get(c"SMAppService")?;
    let plist = NSString::from_str(&provider_plist(&identifier()?));
    unsafe { msg_send![class, agentServiceWithPlistName: &*plist] }
}

/// Unregisters the background item: macOS stops the provider, which stops what it runs. Says
/// where it then stands, as the log reads it, or why it couldn't.
pub fn unregister_background_item() -> Result<String, String> {
    let Some(item) = background_item() else {
        return Err("no background item in this build".into());
    };
    let status: isize = unsafe { msg_send![&*item, status] };
    if status == 0 {
        return Ok("the background item isn't registered".into());
    }
    let done: Result<(), Retained<NSError>> =
        unsafe { msg_send![&*item, unregisterAndReturnError: _] };
    match done {
        Ok(()) => Ok("the background item is unregistered".into()),
        Err(error) => {
            let why = error.localizedDescription();
            Err(format!("the background item couldn't be unregistered: {why}"))
        }
    }
}

/// The background item's status, as macOS gives it: 0 not registered, 1 on, 2 waiting for the
/// person's approval (switched off in Login Items, or not allowed yet), 3 not in this build.
/// The window reads it every second off the main thread, so in a pool of its own.
pub fn background_item_status() -> Option<isize> {
    objc2::rc::autoreleasepool(|_| {
        let item = background_item()?;
        Some(unsafe { msg_send![&*item, status] })
    })
}

/// The driver's defaults domain: a program outside a bundle has its name for one. It is the
/// person's, in `~/Library/Preferences/cua-driver.plist`.
const DRIVER_DEFAULTS: &str = "cua-driver";

/// Turns AppKit's window restoration off for the driver, or back to its default, and says whether
/// its defaults could be reached: restoring windows as it starts, the driver reached a file macOS
/// keeps for Full Disk Access.
pub fn driver_restores_windows(restores: bool) -> bool {
    let suite = NSString::from_str(DRIVER_DEFAULTS);
    let Some(defaults) = NSUserDefaults::initWithSuiteName(NSUserDefaults::alloc(), Some(&suite))
    else {
        return false;
    };
    let key = NSString::from_str("ApplePersistenceIgnoreState");
    if restores {
        defaults.removeObjectForKey(&key);
    } else {
        defaults.setBool_forKey(true, &key);
    }
    defaults.synchronize()
}

/// Opens Login Items in System Settings, where the person allows the background item.
pub fn open_login_items() {
    if let Some(class) = AnyClass::get(c"SMAppService") {
        let _: () = unsafe { msg_send![class, openSystemSettingsLoginItems] };
    }
}

/// Where the background item stands after registering it.
#[derive(Debug, PartialEq, Eq)]
pub enum Registered {
    On,
    WaitsForApproval,
    NotRegistered,
    NotInBuild,
    Failed(String),
}

impl Registered {
    /// As the log, and `register`, say it.
    pub fn words(&self) -> String {
        match self {
            Registered::On => "the background item is on".into(),
            Registered::WaitsForApproval => {
                "the background item waits for the person's approval in Login Items".into()
            }
            Registered::NotRegistered => "the background item isn't registered".into(),
            Registered::NotInBuild => "no background item in this build".into(),
            Registered::Failed(why) => format!("the background item couldn't be registered: {why}"),
        }
    }

    /// `register`'s exit code: 0 on, 2 waiting for the person in Login Items, 1 otherwise.
    pub fn exit_code(&self) -> i32 {
        match self {
            Registered::On => 0,
            Registered::WaitsForApproval => 2,
            _ => 1,
        }
    }
}

/// Registers the background item unless it is on or waiting for the person's approval, so that a
/// person's choice in Login Items stands, and says where it stands.
pub fn register_background_item() -> Registered {
    let Some(item) = background_item() else { return Registered::NotInBuild };
    let status = |item: &AnyObject| -> isize { unsafe { msg_send![item, status] } };
    if !matches!(status(&item), 1 | 2) {
        let done: Result<(), Retained<NSError>> =
            unsafe { msg_send![&*item, registerAndReturnError: _] };
        if let Err(error) = done {
            return Registered::Failed(error.localizedDescription().to_string());
        }
    }
    match status(&item) {
        0 => Registered::NotRegistered,
        1 => Registered::On,
        2 => Registered::WaitsForApproval,
        _ => Registered::NotInBuild,
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

/// Whether macOS draws in its dark appearance: for the menu-bar item's glyph, where its menu bar
/// can't be read.
pub fn dark_appearance() -> bool {
    objc2::rc::autoreleasepool(|_| {
        let key = NSString::from_str("AppleInterfaceStyle");
        let style = NSUserDefaults::standardUserDefaults().stringForKey(&key);
        style.is_some_and(|style| style.to_string() == "Dark")
    })
}

/// Names a status item's button, which shows only a picture, for VoiceOver and the accessibility
/// tree. On the main thread.
pub fn name_status_item(item: &AnyObject, name: &str) {
    let button: Option<Retained<AnyObject>> = unsafe { msg_send![item, button] };
    if let Some(button) = button {
        let name = NSString::from_str(name);
        let _: () = unsafe { msg_send![&*button, setAccessibilityLabel: &*name] };
    }
}

/// Whether a status item is drawn on a dark menu bar, from its button's appearance, which follows
/// the menu bar, its wallpaper included. On the main thread.
pub fn status_item_dark(item: &AnyObject) -> Option<bool> {
    let button: Option<Retained<AnyObject>> = unsafe { msg_send![item, button] };
    let appearance: Option<Retained<AnyObject>> =
        unsafe { msg_send![&*button?, effectiveAppearance] };
    let name: Option<Retained<NSString>> = unsafe { msg_send![&*appearance?, name] };
    Some(name?.to_string().contains("Dark"))
}

/// Draws a window in macOS's dark appearance, and only that window.
pub fn dark_window(ns_window: *mut c_void) {
    let Some(class) = AnyClass::get(c"NSAppearance") else { return };
    let name = NSString::from_str("NSAppearanceNameDarkAqua");
    let dark: Option<Retained<AnyObject>> = unsafe { msg_send![class, appearanceNamed: &*name] };
    if let (Some(dark), Some(window)) = (dark, unsafe { (ns_window as *mut AnyObject).as_ref() }) {
        let _: () = unsafe { msg_send![window, setAppearance: &*dark] };
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

#[cfg(test)]
mod tests {
    use super::Registered;

    #[test]
    fn register_exits_0_when_on_2_when_waiting_for_the_person_and_1_otherwise() {
        assert_eq!(Registered::On.exit_code(), 0);
        assert_eq!(Registered::WaitsForApproval.exit_code(), 2);
        for other in [
            Registered::NotRegistered,
            Registered::NotInBuild,
            Registered::Failed("Operation not permitted".into()),
        ] {
            assert_eq!(other.exit_code(), 1);
        }
        assert_eq!(
            Registered::Failed("Operation not permitted".into()).words(),
            "the background item couldn't be registered: Operation not permitted"
        );
    }
}
