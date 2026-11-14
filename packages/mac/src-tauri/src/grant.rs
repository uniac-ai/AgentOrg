//! `AgentOrg grant <need>...`: the app asking for the screen's grants itself, as the service opens
//! it through the system, `open -n -g -a AgentOrg.app --args grant accessibility screen-recording`,
//! so that what macOS asks names AgentOrg whatever started the service. Each is asked for in turn:
//! macOS's own request, then up to 3 minutes for an answer. No pane of System Settings opens: the
//! person opens one from the window, on their own click. macOS keeps each process's answer, so
//! each grant is read by a fresh process of the app's own.

use crate::log::log;
use crate::{macos, provider};
use std::process::Command;
use std::thread::sleep;
use std::time::{Duration, Instant};

/// The screen's two grants.
const NEEDS: [&str; 2] = ["accessibility", "screen-recording"];

pub fn ask(needs: &[String]) {
    for need in needs {
        if !NEEDS.contains(&need.as_str()) {
            log("grant", &format!("there's no grant called \"{need}\""));
            continue;
        }
        // One already given is one the driver may not have read yet: the provider reads them again.
        if granted(need) {
            log("grant", &format!("{need}: already granted"));
            provider::grants_changed();
            continue;
        }
        log("grant", &format!("{need}: asking"));
        macos::request(need);
        let end = Instant::now() + Duration::from_secs(180);
        while !granted(need) && Instant::now() < end {
            sleep(Duration::from_secs(1));
        }
        let now = granted(need);
        let answer = if now { "granted" } else { "not granted after waiting" };
        log("grant", &format!("{need}: {answer}"));
        // Told at once, so that a grant given isn't lost if this instance is ended before the next.
        if now {
            provider::grants_changed();
        }
    }
}

/// Whether a grant is given, as a fresh process of the app reads it.
pub fn granted(need: &str) -> bool {
    let Ok(own) = std::env::current_exe() else { return false };
    Command::new(own).args(["granted", need]).status().is_ok_and(|status| status.success())
}
