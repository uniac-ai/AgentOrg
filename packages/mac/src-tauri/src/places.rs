//! Where the app keeps what it keeps, all in the person's Library.

use std::path::{Path, PathBuf};

pub fn home() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
}

/// The app's own folder.
pub fn agentorg() -> PathBuf {
    home().join("Library/Application Support/AgentOrg")
}

/// Where the service keeps its data, with the record it leaves while it runs and its control
/// token: the folder agreed with AgentOrg's core.
pub fn data() -> PathBuf {
    agentorg().join("computer")
}

/// The driver's home, so that what it keeps stays in the app's folder.
pub fn driver_home() -> PathBuf {
    agentorg().join("driver")
}

/// The socket the provider runs the driver on.
pub fn driver_socket() -> PathBuf {
    driver_home().join("d.sock")
}

/// What the provider says of itself: its process and its state.
pub fn provider_state() -> PathBuf {
    agentorg().join("provider.json")
}

/// Held by the provider while it runs, so that one runs at a time.
pub fn provider_lock() -> PathBuf {
    agentorg().join("provider.lock")
}

pub fn logs() -> PathBuf {
    home().join("Library/Logs/AgentOrg")
}

/// The app's bundle, from wherever in it this program is.
pub fn bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    exe.ancestors().find(|at| at.extension().is_some_and(|ext| ext == "app")).map(Path::to_path_buf)
}
