//! AgentOrg.app's one program, which runs three ways: the window, as a person opens the app; the
//! provider, as macOS starts its background item (`--provider`); and asking for the screen's
//! grants, as the service opens the app to (`grant <need>...`). A grant's instance reads each grant
//! through a fresh one of itself (`granted <need>`), which answers by its exit code.

mod grant;
mod log;
mod macos;
mod places;
mod provider;
mod seam;

/// A home of the tests' own, set once for every test, so that what they log stays out of the
/// person's.
#[cfg(test)]
pub fn test_home() -> std::path::PathBuf {
    static HOME: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();
    HOME.get_or_init(|| {
        let home = std::env::temp_dir().join(format!("agentorg-test-{}", std::process::id()));
        std::fs::create_dir_all(&home).unwrap();
        std::env::set_var("HOME", &home);
        home
    })
    .clone()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("--provider") => provider::run_as_background_item(),
        Some("grant") => grant::ask(&args[1..]),
        Some("granted") => std::process::exit(match args.get(1) {
            Some(need) if macos::granted(need) => 0,
            _ => 1,
        }),
        _ => seam::window(),
    }
}
