//! `AgentOrg grant <need>...`: the app asking for the screen's grants itself, as the service opens
//! it through the system, `open -n -g -a AgentOrg.app --args grant <need>...` with the grants
//! missing, so that what macOS asks names AgentOrg whatever started the service. It makes macOS's
//! request for each, Accessibility first, as its request draws macOS's alert where Screen
//! Recording's often draws nothing and only lists the app in its pane. Then it waits up to 3
//! minutes for the person, telling the provider as each is given. No pane of System Settings opens:
//! the person opens one from the window, on their own click. macOS keeps each process's answer, so
//! each grant is read by a fresh process of the app's own.

use crate::log::log;
use crate::{macos, provider};
use std::process::Command;
use std::thread::sleep;
use std::time::{Duration, Instant};

/// The screen's two grants, in the order they are asked for.
const NEEDS: [&str; 2] = ["accessibility", "screen-recording"];

pub fn ask(needs: &[String]) {
    for need in needs.iter().filter(|need| !NEEDS.contains(&need.as_str())) {
        log("grant", &format!("there's no grant called \"{need}\""));
    }
    let mut waiting = Vec::new();
    for need in NEEDS.into_iter().filter(|need| needs.iter().any(|one| one == need)) {
        // One already given is one the driver may not have read yet: the provider reads them again.
        if granted(need) {
            log("grant", &format!("{need}: already granted"));
            provider::grants_changed();
        } else {
            log("grant", &format!("{need}: asking"));
            macos::request(need);
            waiting.push(need);
        }
    }
    // Each is told to the provider at once, so that a grant given isn't lost if this instance is
    // ended before the other.
    let end = Instant::now() + Duration::from_secs(180);
    while !waiting.is_empty() && Instant::now() < end {
        sleep(Duration::from_secs(1));
        waiting.retain(|need| {
            let now = granted(need);
            if now {
                log("grant", &format!("{need}: granted"));
                provider::grants_changed();
            }
            !now
        });
    }
    for need in waiting {
        log("grant", &format!("{need}: not granted after waiting"));
    }
}

/// Whether a grant is given, as a fresh process of the app reads it.
pub fn granted(need: &str) -> bool {
    let Ok(own) = std::env::current_exe() else { return false };
    Command::new(own).args(["granted", need]).status().is_ok_and(|status| status.success())
}
