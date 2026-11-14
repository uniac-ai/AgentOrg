//! `AgentOrg grant <need>...`: the app asking for the screen's grants itself, as the service opens
//! it through the system, `open -n -g -a AgentOrg.app --args grant accessibility screen-recording`,
//! so that what macOS asks names AgentOrg whatever started the service. Each is asked for in turn:
//! macOS's own request, then its pane in System Settings, then up to 3 minutes for an answer.
//! macOS keeps each process's answer, so each grant is read by a fresh process of the app's own.

use crate::log::log;
use crate::{macos, provider};
use std::process::Command;
use std::thread::sleep;
use std::time::{Duration, Instant};

const SETTINGS: &str = "x-apple.systempreferences:com.apple.preference.security";
const PANES: [(&str, &str); 2] =
    [("accessibility", "Privacy_Accessibility"), ("screen-recording", "Privacy_ScreenCapture")];

pub fn ask(needs: &[String]) {
    let mut given = false;
    for need in needs {
        let Some((_, pane)) = PANES.iter().find(|(name, _)| name == need) else {
            log("grant", &format!("there's no grant called \"{need}\""));
            continue;
        };
        // One already given is one the driver may not have read yet: it counts as given.
        if granted(need) {
            log("grant", &format!("{need}: already granted"));
            given = true;
            continue;
        }
        log("grant", &format!("{need}: asking"));
        macos::request(need);
        let _ = Command::new("/usr/bin/open").arg(format!("{SETTINGS}?{pane}")).status();
        let end = Instant::now() + Duration::from_secs(180);
        while !granted(need) && Instant::now() < end {
            sleep(Duration::from_secs(1));
        }
        let now = granted(need);
        given |= now;
        let answer = if now { "granted" } else { "not granted after waiting" };
        log("grant", &format!("{need}: {answer}"));
    }
    // The driver reads its grants once: the provider starts it again to read them.
    if given {
        provider::grants_changed();
    }
}

/// Whether a grant is given, as a fresh process of the app reads it.
fn granted(need: &str) -> bool {
    let Ok(own) = std::env::current_exe() else { return false };
    Command::new(own).args(["granted", need]).status().is_ok_and(|status| status.success())
}
