//! The app's log, `~/Library/Logs/AgentOrg/AgentOrg.log`, each line with its time and which of the
//! app's ways of running wrote it. At 10 MB it moves to `AgentOrg.1.log`, replacing the one before:
//! only the provider moves it, since the window and a grant's instance write the same file.

use crate::places::logs;
use std::fs;
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn log(who: &str, line: &str) {
    let folder = logs();
    let _ = fs::create_dir_all(&folder);
    let file = folder.join("AgentOrg.log");
    if let Ok(mut out) = fs::OpenOptions::new().create(true).append(true).open(file) {
        // One write each, so that lines from the app's processes don't mix.
        let _ = out.write_all(format!("{} {who}: {line}\n", now()).as_bytes());
    }
}

/// Moves the log aside once it reaches 10 MB.
pub fn rotate() {
    let file = logs().join("AgentOrg.log");
    if fs::metadata(&file).is_ok_and(|kept| kept.len() >= 10 << 20) {
        let _ = fs::rename(&file, logs().join("AgentOrg.1.log"));
    }
}

fn now() -> String {
    stamp(SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_secs()))
}

/// A time in seconds since 1970, in UTC, as 2026-11-14T09:30:00Z.
pub fn stamp(secs: u64) -> String {
    // The civil date from a count of days: the civil-from-days algorithm.
    let days = (secs / 86_400) as i64 + 719_468;
    let era = days.div_euclid(146_097);
    let of_era = days - era * 146_097;
    let year_of_era = (of_era - of_era / 1_460 + of_era / 36_524 - of_era / 146_096) / 365;
    let of_year = of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted = (5 * of_year + 2) / 153;
    let day = of_year - (153 * shifted + 2) / 5 + 1;
    let month = if shifted < 10 { shifted + 3 } else { shifted - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    let rest = secs % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3_600,
        rest / 60 % 60,
        rest % 60
    )
}

#[cfg(test)]
mod tests {
    use super::stamp;

    #[test]
    fn times_are_stamped_in_utc() {
        assert_eq!(stamp(0), "1970-01-01T00:00:00Z");
        assert_eq!(stamp(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(stamp(1_763_112_600), "2025-11-14T09:30:00Z");
    }
}
