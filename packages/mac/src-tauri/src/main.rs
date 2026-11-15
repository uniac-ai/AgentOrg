//! AgentOrg.app's one program, which runs four ways: the window and the menu-bar item, as a person
//! opens the app, or with the item alone as the provider starts it after a login (`menu-bar`); the
//! provider, as macOS starts its background item (`--provider`); asking for the screen's grants, as
//! the service opens the app to (`grant <need>...`); and `unregister`, which takes the background
//! item away, for a person removing the app. A grant's instance reads each grant through a fresh
//! one of itself (`granted <need>`), which answers by its exit code.

mod grant;
mod log;
mod macos;
mod menu_bar;
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
        Some("unregister") => match macos::unregister_background_item() {
            Ok(said) => {
                // What the app keeps outside its folders: the driver's default.
                let removed = if macos::driver_restores_windows(true) {
                    "the driver's default removed"
                } else {
                    "the driver's default couldn't be reached"
                };
                let mut said = format!("{said}; {removed}");
                if let Some(pid) = menu_bar::end_running(&menu_bar::state()) {
                    said.push_str(&format!("; the menu bar item, process {pid}, ended"));
                }
                log::log("unregister", &said);
                println!("{said}");
            }
            Err(said) => {
                log::log("unregister", &said);
                eprintln!("{said}");
                std::process::exit(1);
            }
        },
        Some("granted") => std::process::exit(match args.get(1) {
            Some(need) if macos::granted(need) => 0,
            _ => 1,
        }),
        Some("menu-bar") => seam::window(false),
        _ => seam::window(true),
    }
}
