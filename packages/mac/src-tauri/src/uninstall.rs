//! `AgentOrg uninstall [--reset-privacy]`: the app removed from this Mac, as `agentorg uninstall`
//! offers it. The background item is taken away, as `unregister` does, which stops the provider
//! and what it runs. With `--reset-privacy`, given on the person's say, macOS's privacy entries for
//! the app are reset, while the app is still there for `tccutil` to name. Then what the app keeps
//! in the person's Library goes, and the app itself, once Launch Services has forgotten it. macOS
//! keeps a switched-off "AgentOrg" in Login Items, which nothing here can remove.

use crate::{log, macos, places};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const LSREGISTER: &str = concat!(
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework",
    "/Support/lsregister"
);

/// What the app keeps in the person's Library: its folder, with the service's data and the driver's
/// home; its logs; and what macOS and its window's web view keep under its identifier.
pub fn kept(home: &Path, identifier: &str) -> Vec<PathBuf> {
    let library = home.join("Library");
    vec![
        library.join("Application Support/AgentOrg"),
        library.join("Logs/AgentOrg"),
        library.join("WebKit").join(identifier),
        library.join("Caches").join(identifier),
        library.join("HTTPStorages").join(identifier),
        library.join("Saved Application State").join(format!("{identifier}.savedState")),
    ]
}

pub fn run(reset_privacy: bool) {
    let Some(identifier) = macos::identifier() else {
        eprintln!("this program isn't inside the app");
        std::process::exit(1);
    };
    let mut done = match crate::unregister() {
        Ok(said) => vec![said],
        Err(said) => {
            eprintln!("{said}; nothing removed");
            std::process::exit(1);
        }
    };
    if reset_privacy {
        let reset = Command::new("/usr/bin/tccutil").args(["reset", "All", &identifier]).status();
        let entries = format!("macOS's privacy entries for {identifier}");
        done.push(match reset {
            Ok(status) if status.success() => format!("{entries} reset"),
            _ => format!("{entries} couldn't be reset"),
        });
    }
    // Its preferences, where it has any, through macOS, which caches them.
    let _ = Command::new("/usr/bin/defaults").args(["delete", &identifier]).output();
    log::log("uninstall", &done.join("; "));
    // The log goes too, so nothing more is written there.
    for path in kept(&places::home(), &identifier) {
        if path.exists() {
            match fs::remove_dir_all(&path) {
                Ok(()) => done.push(format!("{} removed", path.display())),
                Err(error) => done.push(format!("{} couldn't be removed: {error}", path.display())),
            }
        }
    }
    if let Some(app) = places::bundle() {
        let _ = Command::new(LSREGISTER).arg("-u").arg(&app).status();
        match fs::remove_dir_all(&app) {
            Ok(()) => done.push(format!("{} removed", app.display())),
            Err(error) => done.push(format!("{} couldn't be removed: {error}", app.display())),
        }
    }
    for line in done {
        println!("{line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_the_app_keeps_is_in_the_persons_library_under_its_folder_and_identifier() {
        let home = Path::new("/Users/person");
        let kept: Vec<String> =
            kept(home, "ai.uniac.agentorg").iter().map(|path| path.display().to_string()).collect();
        assert_eq!(
            kept,
            [
                "/Users/person/Library/Application Support/AgentOrg",
                "/Users/person/Library/Logs/AgentOrg",
                "/Users/person/Library/WebKit/ai.uniac.agentorg",
                "/Users/person/Library/Caches/ai.uniac.agentorg",
                "/Users/person/Library/HTTPStorages/ai.uniac.agentorg",
                "/Users/person/Library/Saved Application State/ai.uniac.agentorg.savedState",
            ]
        );
        // Each is the app's own: nothing else of the person's Library.
        assert!(kept.iter().all(|path| path.contains("AgentOrg") || path.contains("agentorg")));
    }
}
