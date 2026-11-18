//! "Open AgentOrg", in the menu-bar item's menu: the dashboard in the person's browser, signed in,
//! through the core's own launcher, `~/.local/bin/agentorg open`, which the line that installs
//! AgentOrg puts there. It runs as the person, with the provider's small environment and no
//! terminal, for 30 s at most. The app shows nothing of its own: where it didn't open, the log has
//! the launcher's first line, such as that AgentOrg isn't running.

use crate::provider;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread::sleep;
use std::time::{Duration, Instant};

/// How long the launcher is given: it reads the core's address, asks it for a sign-in code and
/// opens the browser.
const WAIT: Duration = Duration::from_secs(30);

/// The core's launcher, where the line puts it.
pub fn launcher(home: &Path) -> PathBuf {
    home.join(".local/bin/agentorg")
}

/// Opens the dashboard, or says why it didn't.
pub fn open(home: &Path) -> Result<(), String> {
    open_with(&launcher(home), home, WAIT)
}

/// `launcher open`, waited for `wait` at most: Ok where it exits 0, else its first line on stderr,
/// or why it couldn't run.
pub fn open_with(launcher: &Path, home: &Path, wait: Duration) -> Result<(), String> {
    if !launcher.exists() {
        return Err(format!("no AgentOrg launcher at {}", launcher.display()));
    }
    let mut child = Command::new(launcher)
        .arg("open")
        .env_clear()
        .envs(provider::small_env(home))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("the launcher didn't start: {error}"))?;
    let end = Instant::now() + wait;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < end => sleep(Duration::from_millis(100)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("the launcher didn't finish within {} s", wait.as_secs()));
            }
        }
    };
    if status.success() {
        return Ok(());
    }
    let mut said = String::new();
    if let Some(mut err) = child.stderr.take() {
        let _ = err.read_to_string(&mut said);
    }
    Err(said.lines().find(|line| !line.trim().is_empty()).map_or_else(
        || format!("the launcher ended ({status})"),
        |line| line.trim().to_string(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    fn launcher_in(home: &Path, body: &str) -> PathBuf {
        let path = launcher(home);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[test]
    fn the_launcher_is_run_with_open_and_its_first_line_is_said_where_it_fails() {
        let home = std::env::temp_dir().join(format!("agentorg-open-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        // None there: said so, and nothing run.
        assert_eq!(
            open(&home),
            Err(format!("no AgentOrg launcher at {}", home.join(".local/bin/agentorg").display()))
        );
        // Opened: given `open` alone, with the person's home and no more on the path than the
        // system's.
        let heard = home.join("heard");
        let says = format!("echo \"$@ $HOME $PATH\" > '{}'", heard.display());
        launcher_in(&home, &says);
        assert_eq!(open(&home), Ok(()));
        let path = "/usr/bin:/bin:/usr/sbin:/sbin";
        let said = fs::read_to_string(&heard).unwrap();
        assert_eq!(said.trim(), format!("open {} {path}", home.display()));
        // Not running: its first line, as it says it.
        let not_running = concat!(
            "echo 'AgentOrg isn'\\''t running in ~/.agentorg/home. Run agentorg start.' >&2\n",
            "exit 1"
        );
        launcher_in(&home, not_running);
        assert_eq!(
            open(&home),
            Err("AgentOrg isn't running in ~/.agentorg/home. Run agentorg start.".into())
        );
        // Silent and failing: its exit.
        launcher_in(&home, "exit 3");
        assert!(open(&home).unwrap_err().starts_with("the launcher ended"));
        // Stuck: ended once the wait is over.
        let stuck = launcher_in(&home, "exec sleep 600");
        let began = Instant::now();
        let said = open_with(&stuck, &home, Duration::from_millis(300)).unwrap_err();
        assert!(said.starts_with("the launcher didn't finish within"), "{said}");
        assert!(began.elapsed() < Duration::from_secs(5));
        let _ = fs::remove_dir_all(&home);
    }
}
