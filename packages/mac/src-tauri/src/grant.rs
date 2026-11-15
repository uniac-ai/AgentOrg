//! `AgentOrg grant <need>...`: the app asking for the screen's grants itself, as the service opens
//! it through the system, `open -n -g -a AgentOrg.app --args grant <need>`, so that what macOS asks
//! names AgentOrg whatever started the service. The service names one grant at a time: Screen
//! Recording at the switch from macOS 26, where its request draws nothing and only lists the app in
//! its pane, and either one on the person's click. It makes macOS's request for each named, Screen Recording's
//! first: one made while Accessibility's alert waits for the person isn't listed until the alert is
//! answered. Then it waits up to 3 minutes for the person, telling the provider as each is given.
//! It opens no pane of System Settings: the service opens one after the request, on the person's
//! click. macOS keeps each process's answer, so each grant is read by a fresh process of the app's
//! own.

use crate::log::log;
use crate::{macos, provider};
use std::process::Command;
use std::thread::sleep;
use std::time::{Duration, Instant};

/// The screen's two grants, in the order they are asked for.
const NEEDS: [&str; 2] = ["screen-recording", "accessibility"];
/// How long after one request the next is made, where both are asked for at once: macOS lists the
/// app for Screen Recording some 40 ms after its request, unless Accessibility's alert waits by then.
const GAP: Duration = Duration::from_secs(1);

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
            if !waiting.is_empty() {
                sleep(GAP);
            }
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
