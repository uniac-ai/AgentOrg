//! The menu-bar item, held by the window's process for as long as it runs: a monitor glyph with a
//! dot for the app's state, and a menu with that state in words, "Open AgentOrg" (the dashboard,
//! while AgentOrg is connected), "Agent Control…" (the window) and "Quit AgentOrg (stops
//! lending)". The process stays when its window closes, so the item stays. After a login,
//! the provider starts it with no window (`menu-bar`). Quitting from the item unregisters the
//! background item, so nothing of the app runs or starts at login until it is opened again.

use crate::log::log;
use crate::places;
use crate::provider::AppState;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::{Duration, Instant};

/// The dot's state and the menu's status line, first match winning, as the window's own phase
/// reads them (`mac-window`'s `phaseOf`), with "Something to set up" the item's own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dot {
    StartingAgain,
    TurnedOff,
    SetUp,
    Connected,
    Waiting,
}

impl Dot {
    pub fn words(self) -> &'static str {
        match self {
            Dot::StartingAgain => "Starting again",
            Dot::TurnedOff => "Not allowed in the background",
            Dot::SetUp => "Something to set up",
            Dot::Connected => "Connected to AgentOrg",
            Dot::Waiting => "Waiting for AgentOrg to connect",
        }
    }
}

/// From the app's state, whether a part the person switched on isn't ready, as last read (none
/// before the service first answers), whether AgentOrg held a connection at the last answer, and
/// whether the first reading is late. As the window: before its first reading it shows only its
/// title, and starting again once that is 5 s late; the item waits until then.
pub fn dot(app: AppState, short: Option<bool>, connected: bool, late: bool) -> Dot {
    match (app, short) {
        (AppState::TurnedOff, _) => Dot::TurnedOff,
        (_, None) if late => Dot::StartingAgain,
        (_, None) => Dot::Waiting,
        (AppState::Starting | AppState::StartingAgain, Some(_)) => Dot::StartingAgain,
        (AppState::Running, Some(true)) => Dot::SetUp,
        (AppState::Running, Some(false)) if connected => Dot::Connected,
        (AppState::Running, Some(false)) => Dot::Waiting,
    }
}

/// How long the first reading may take before the item, as the window, says it starts again.
pub const FIRST: std::time::Duration = std::time::Duration::from_secs(5);

/// Whether the screen or the browser is switched on and not ready, from the service's setup: what
/// the window shows as rows to set up on their cards.
pub fn short(setup: &Value) -> bool {
    setup["capabilities"].as_array().into_iter().flatten().any(|part| {
        matches!(part["capability"].as_str(), Some("screen" | "browser"))
            && part["on"] == true
            && part["ready"] == false
    })
}

/// The item's picture, as v9 draws it: lucide's `monitor` glyph, 16 points in a 20-point box, and
/// a 6-point dot at the box's top right, 2 points out. The menu bar shows an item's picture 18
/// points tall (tray-icon), so it is drawn 36 pixels tall, for a Retina menu bar, and as tight as
/// glyph and dot allow: the box's x from 2 to 22 and y from -2 to 17, which leaves the glyph about
/// 15 points tall. The glyph takes the menu bar's text colour, light or dark, and the dot its
/// state's colour. Returned as straight RGBA rows.
pub const WIDTH: u32 = 38;
pub const HEIGHT: u32 = 36;
pub fn icon(dot: Dot, dark: bool) -> Vec<u8> {
    // Pixels for each point, and the drawing's corner in the box's points.
    let scale = HEIGHT as f32 / 19.0;
    let (x0, y0) = (2.0, -2.0);
    const SAMPLES: usize = 4;
    // The glyph's 24 units, mapped to the box's points: 16 points, from (2, 2).
    let unit = 16.0 / 24.0;
    let at = |x: f32, y: f32| (2.0 + x * unit, 2.0 + y * unit);
    let half_stroke = unit;
    let (cx, cy) = at(12.0, 10.0);
    let (half_w, half_h, radius) = (10.0 * unit, 7.0 * unit, 2.0 * unit);
    let segments = [(at(8.0, 21.0), at(16.0, 21.0)), (at(12.0, 17.0), at(12.0, 21.0))];
    let in_glyph = |x: f32, y: f32| {
        // The screen: a rounded rectangle's outline.
        let (qx, qy) = ((x - cx).abs() - half_w + radius, (y - cy).abs() - half_h + radius);
        let outside = (qx.max(0.0).powi(2) + qy.max(0.0).powi(2)).sqrt();
        let edge = outside + qx.max(qy).min(0.0) - radius;
        edge.abs() <= half_stroke
            || segments.iter().any(|&((ax, ay), (bx, by))| {
                let (dx, dy) = (bx - ax, by - ay);
                let t = (((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)).clamp(0.0, 1.0);
                ((x - ax - t * dx).powi(2) + (y - ay - t * dy).powi(2)).sqrt() <= half_stroke
            })
    };
    let in_dot = |x: f32, y: f32| (x - 19.0).powi(2) + (y - 1.0).powi(2) <= 9.0;
    // v9's menu bar draws the glyph white at 90%; on a light menu bar, black at 85%.
    let ink = if dark { [255, 255, 255, 230] } else { [0, 0, 0, 217] };
    let paint = match dot {
        Dot::StartingAgain | Dot::TurnedOff | Dot::SetUp => [251, 191, 36, 255],
        Dot::Connected => [16, 185, 129, 255],
        Dot::Waiting if dark => [255, 255, 255, 153],
        Dot::Waiting => [0, 0, 0, 115],
    };
    let mut rgba = vec![0u8; (WIDTH * HEIGHT * 4) as usize];
    for py in 0..HEIGHT {
        for px in 0..WIDTH {
            let (mut glyph, mut round) = (0.0, 0.0);
            for sy in 0..SAMPLES {
                for sx in 0..SAMPLES {
                    let x = x0 + (px as f32 + (sx as f32 + 0.5) / SAMPLES as f32) / scale;
                    let y = y0 + (py as f32 + (sy as f32 + 0.5) / SAMPLES as f32) / scale;
                    glyph += in_glyph(x, y) as u8 as f32;
                    round += in_dot(x, y) as u8 as f32;
                }
            }
            let n = (SAMPLES * SAMPLES) as f32;
            let glyph_a = glyph / n * ink[3] as f32 / 255.0;
            let dot_a = round / n * paint[3] as f32 / 255.0;
            // The dot over the glyph, straight alpha.
            let a = dot_a + glyph_a * (1.0 - dot_a);
            let out = &mut rgba[((py * WIDTH + px) * 4) as usize..][..4];
            if a > 0.0 {
                for c in 0..3 {
                    let v = (paint[c] as f32 * dot_a + ink[c] as f32 * glyph_a * (1.0 - dot_a)) / a;
                    out[c] = v.round() as u8;
                }
                out[3] = (a * 255.0).round() as u8;
            }
        }
    }
    rgba
}

/// What the menu-bar process says of itself, in its state file.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct Said {
    pid: i32,
}

/// The process named in the state file, where it is alive and runs this same program.
pub fn running(state: &Path) -> Option<i32> {
    let said: Said = serde_json::from_slice(&fs::read(state).ok()?).ok()?;
    let own = std::env::current_exe().ok()?.canonicalize().ok()?;
    let runs = crate::macos::program_of(said.pid).and_then(|at| at.canonicalize().ok());
    (crate::macos::alive(said.pid) && runs == Some(own)).then_some(said.pid)
}

/// Names this process in the state file, in the app's folder, kept to its owner.
pub fn say_running(state: &Path) {
    if let Some(folder) = state.parent() {
        let _ = fs::create_dir_all(folder);
        let _ = fs::set_permissions(folder, fs::Permissions::from_mode(0o700));
    }
    let said = Said { pid: std::process::id() as i32 };
    let fresh = state.with_extension("json.new");
    if fs::write(&fresh, serde_json::to_vec(&said).unwrap_or_default()).is_ok() {
        let _ = fs::rename(&fresh, state);
    }
}

/// Removes the state file, where it names this process.
pub fn say_gone(state: &Path) {
    let ours = fs::read(state)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Said>(&bytes).ok())
        .is_some_and(|said| said.pid == std::process::id() as i32);
    if ours {
        let _ = fs::remove_file(state);
    }
}

/// Ends the menu-bar process, where one runs and isn't this one: for `unregister`, so that a
/// removed app leaves nothing running.
pub fn end_running(state: &Path) -> Option<i32> {
    let pid = running(state).filter(|&pid| pid != std::process::id() as i32)?;
    unsafe { libc::kill(pid, libc::SIGTERM) };
    let _ = fs::remove_file(state);
    Some(pid)
}

/// "Quit AgentOrg (stops lending)": the background item is unregistered, so macOS stops the
/// provider, which stops the driver and the service, and nothing starts at the next login; the
/// driver's default is taken back; this process's state file goes. Opening the app registers the
/// item again. Where the item couldn't be unregistered, nothing else changes: lending goes on, and
/// the item stays, so as not to say it stopped. Returns whether to quit.
pub fn quit_lending(
    unregister: impl FnOnce() -> Result<String, String>,
    restore_driver_default: impl FnOnce() -> bool,
    state: &Path,
) -> bool {
    match unregister() {
        Ok(said) => {
            let removed = if restore_driver_default() {
                "the driver's default removed"
            } else {
                "the driver's default couldn't be reached"
            };
            log("menu bar", &format!("quit, lending stopped: {said}; {removed}"));
            say_gone(state);
            true
        }
        Err(said) => {
            log("menu bar", &format!("quit, but lending couldn't stop: {said}"));
            false
        }
    }
}

/// The waits before the provider starts the menu-bar process again, in seconds, by how many times
/// in a row it has without one coming up: long enough for one just started to say so, as starting
/// a second through the system would only bring the first forward with its window.
const STARTS: [u64; 6] = [0, 10, 30, 60, 120, 300];

/// When the provider starts the menu-bar process: while none runs and macOS allows the background
/// item, at once, then after waits that grow while none comes up.
#[derive(Default)]
pub struct Starts {
    tries: usize,
    last: Option<Instant>,
}

impl Starts {
    pub fn due(&mut self, running: bool, allowed: bool, now: Instant) -> bool {
        // One that was running and has gone, as at a logout or a Dock Quit, is given the second
        // wait from when it was last seen, so as not to be started as the session ends.
        if running {
            (self.tries, self.last) = (1, Some(now));
            return false;
        }
        let wait = Duration::from_secs(STARTS[self.tries.min(STARTS.len() - 1)]);
        if !allowed || self.last.is_some_and(|last| now.duration_since(last) < wait) {
            return false;
        }
        self.tries += 1;
        self.last = Some(now);
        true
    }
}

/// Starts the menu-bar process through the system, in the background, with no window, without
/// waiting for the system: the provider's loop goes on.
pub fn start(app: &Path) {
    let started =
        std::process::Command::new("/usr/bin/open")
            .args(["-g", "-a"])
            .arg(app)
            .args(["--args", "menu-bar"])
            .spawn();
    match started {
        Ok(mut open) => {
            std::thread::spawn(move || match open.wait() {
                Ok(status) if status.success() => log("provider", "the menu bar item started"),
                Ok(status) => log("provider", &format!("the menu bar item didn't start: {status}")),
                Err(error) => log("provider", &format!("the menu bar item didn't start: {error}")),
            });
        }
        Err(error) => log("provider", &format!("the menu bar item didn't start: {error}")),
    }
}

/// The menu-bar process's state file.
pub fn state() -> std::path::PathBuf {
    places::menu_bar_state()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_dot_reads_as_the_window_does_first_match_winning() {
        use AppState::*;
        // The app's state, the setup's shortfall as last read, the connection as last read,
        // whether the first reading is late, and what the item says.
        let cases = [
            (TurnedOff, Some(true), true, false, Dot::TurnedOff),
            (TurnedOff, None, false, true, Dot::TurnedOff),
            (Starting, None, false, false, Dot::Waiting),
            (StartingAgain, None, false, false, Dot::Waiting),
            (Starting, None, false, true, Dot::StartingAgain),
            (Running, None, true, true, Dot::StartingAgain),
            (StartingAgain, Some(true), true, false, Dot::StartingAgain),
            (Starting, Some(false), false, false, Dot::StartingAgain),
            (Running, Some(true), true, false, Dot::SetUp),
            (Running, Some(false), true, false, Dot::Connected),
            (Running, Some(false), false, false, Dot::Waiting),
        ];
        for (app, short, connected, late, said) in cases {
            let at = format!("{app:?} {short:?} {connected} {late}");
            assert_eq!(dot(app, short, connected, late), said, "{at}");
        }
        assert_eq!(Dot::SetUp.words(), "Something to set up");
        assert_eq!(Dot::TurnedOff.words(), "Not allowed in the background");
    }

    #[test]
    fn something_to_set_up_is_the_screen_or_the_browser_on_and_not_ready() {
        let setup = |screen: (bool, bool), browser: (bool, bool), files: (bool, bool)| {
            json!({ "capabilities": [
                { "capability": "terminal", "on": true, "ready": true, "needs": [] },
                { "capability": "files", "on": files.0, "ready": files.1, "needs": [] },
                { "capability": "screen", "on": screen.0, "ready": screen.1, "needs": [] },
                { "capability": "browser", "on": browser.0, "ready": browser.1, "needs": [] },
            ]})
        };
        assert!(short(&setup((true, false), (false, false), (true, true))));
        assert!(short(&setup((false, false), (true, false), (true, true))));
        assert!(!short(&setup((false, false), (false, false), (true, false))));
        assert!(!short(&setup((true, true), (true, true), (true, true))));
        assert!(!short(&json!({})));
    }

    #[test]
    fn the_icon_is_the_glyph_with_the_dot_in_its_state_colour() {
        let pixel = |rgba: &[u8], x: u32, y: u32| {
            let at = ((y * WIDTH + x) * 4) as usize;
            [rgba[at], rgba[at + 1], rgba[at + 2], rgba[at + 3]]
        };
        for dark in [true, false] {
            let connected = icon(Dot::Connected, dark);
            assert_eq!(connected.len(), (WIDTH * HEIGHT * 4) as usize);
            // The dot's middle, at the box's (19, 1); the bottom left corner, empty.
            assert_eq!(pixel(&connected, 32, 5), [16, 185, 129, 255]);
            assert_eq!(pixel(&icon(Dot::SetUp, dark), 32, 5), [251, 191, 36, 255]);
            assert_eq!(pixel(&connected, 0, 35), [0, 0, 0, 0]);
            // The stand, where its bar meets its post, at the glyph's (12, 21): the menu bar's
            // text colour.
            let stand = pixel(&connected, 15, 34);
            assert_eq!(stand, if dark { [255, 255, 255, 230] } else { [0, 0, 0, 217] });
        }
        assert_eq!(pixel(&icon(Dot::Waiting, true), 32, 5), [255, 255, 255, 153]);
        assert_eq!(pixel(&icon(Dot::Waiting, false), 32, 5), [0, 0, 0, 115]);
    }

    #[test]
    fn the_provider_starts_the_item_while_none_runs_waiting_longer_each_time() {
        let mut starts = Starts::default();
        let t = Instant::now();
        let at = |s: u64| t + Duration::from_secs(s);
        // macOS not allowing the background item: nothing is started.
        assert!(!starts.due(false, false, at(0)));
        // None ever seen: at once, then not again until 10 s have passed, then 30 more.
        assert!(starts.due(false, true, at(0)));
        assert!(!starts.due(false, true, at(9)));
        assert!(starts.due(false, true, at(10)));
        assert!(!starts.due(false, true, at(39)));
        assert!(starts.due(false, true, at(40)));
        // One running is left alone; one seen running and gone, as at a logout, waits 10 s from
        // when it was last seen.
        assert!(!starts.due(true, true, at(41)));
        assert!(!starts.due(false, true, at(42)));
        assert!(starts.due(false, true, at(51)));
    }

    #[test]
    fn quitting_unregisters_takes_back_the_default_and_leaves_no_state_file() {
        let home = crate::test_home().join("menu-bar-quit");
        let state = home.join("menu-bar.json");
        say_running(&state);
        assert!(state.exists());
        let (mut unregistered, mut restored) = (false, false);
        let quit = quit_lending(
            || {
                unregistered = true;
                Ok("the background item is unregistered".into())
            },
            || {
                restored = true;
                true
            },
            &state,
        );
        assert!(quit && unregistered && restored);
        assert!(!state.exists());
        // One that couldn't unregister changes nothing, and stays.
        say_running(&state);
        let kept = quit_lending(|| Err("refused".into()), || panic!("not reached"), &state);
        assert!(!kept && state.exists());
        // Another's state file isn't removed by this one going.
        fs::write(&state, serde_json::to_vec(&json!({ "pid": 1 })).unwrap()).unwrap();
        say_gone(&state);
        assert!(state.exists());
        let _ = fs::remove_dir_all(&home);
    }
}
