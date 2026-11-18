//! AgentOrg.app's one program, which runs these ways: the window and the menu-bar item, as a person
//! opens the app, or with the item alone as the provider starts it after a login (`menu-bar`); the
//! provider, as macOS starts its background item (`--provider`); asking for the screen's grants, as
//! the service opens the app to (`grant <need>...`); `register`, which registers the background
//! item with no window, as the line that installs AgentOrg runs it; `unregister`, which takes the
//! background item away; and `uninstall`, which removes the app and what it keeps. A grant's
//! instance reads each grant through a fresh one of itself (`granted <need>`), which answers by its
//! exit code.

mod dashboard;
mod grant;
mod log;
mod macos;
mod menu_bar;
mod places;
mod provider;
mod seam;
mod uninstall;

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
        Some("register") => {
            let registered = macos::register_background_item();
            let said = registered.words();
            log::log("register", &said);
            println!("{said}");
            std::process::exit(registered.exit_code());
        }
        Some("unregister") => match unregister() {
            Ok(said) => println!("{said}"),
            Err(said) => {
                eprintln!("{said}");
                std::process::exit(1);
            }
        },
        Some("uninstall") => uninstall::run(args.iter().any(|arg| arg == "--reset-privacy")),
        Some("granted") => std::process::exit(match args.get(1) {
            Some(need) if macos::granted(need) => 0,
            _ => 1,
        }),
        Some("menu-bar") => seam::window(false),
        _ => seam::window(true),
    }
}

/// Takes the background item away, which stops the provider and what it runs; removes the driver's
/// default, what the app keeps outside its folders; and ends the menu-bar item where it runs. Says
/// what was done, as the log has it, or why it couldn't be.
pub fn unregister() -> Result<String, String> {
    let said = match macos::unregister_background_item() {
        Ok(said) => said,
        Err(said) => {
            log::log("unregister", &said);
            return Err(said);
        }
    };
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
    Ok(said)
}
