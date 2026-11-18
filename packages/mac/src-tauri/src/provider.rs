//! `AgentOrg --provider`, started by macOS as the app's background item. It hosts Cua Driver,
//! embedded on a private socket as the driver's embedding guide has a host run it, and the service,
//! which reaches the driver there, each with a small environment, never the app's own. Either one
//! that ends is started again: at once, then with waits growing to 30 s. Once a grant changes, the
//! driver is started again, since it reads its grants once. Started again for Screen Recording
//! just given, it takes one picture of the whole screen, so that macOS's alert on a first capture
//! follows the person's own step rather than an agent's later one. What it does goes to the app's
//! log.

use crate::log::{log, rotate};
use crate::{grant, macos, places};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, sleep};
use std::time::{Duration, Instant};

/// The waits before starting again one that ended soon after it started, in seconds, by how many
/// times in a row it has: at once, then growing to 30 s.
const WAITS: [u64; 7] = [0, 1, 2, 4, 8, 16, 30];
/// One that ran this long before it ended is started again at once.
const SETTLED: Duration = Duration::from_secs(60);
/// How long a program asked to end has, before it is ended. The background item gives the
/// provider longer than this to stop (its `ExitTimeOut`).
const GRACE: Duration = Duration::from_secs(25);

/// The app's state, as the window and the page name it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum AppState {
    #[serde(rename = "starting")]
    Starting,
    #[serde(rename = "running")]
    Running,
    #[serde(rename = "starting again")]
    StartingAgain,
    /// No provider runs, as macOS doesn't allow the background item: the window says so.
    #[serde(rename = "turned off")]
    TurnedOff,
}

impl AppState {
    pub fn name(self) -> &'static str {
        match self {
            AppState::Starting => "starting",
            AppState::Running => "running",
            AppState::StartingAgain => "starting again",
            AppState::TurnedOff => "turned off",
        }
    }
}

/// What the provider says of itself, in its state file: its process, its state, and the processes
/// of the two programs it runs.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct Said {
    pid: i32,
    state: AppState,
    driver: Option<i32>,
    service: Option<i32>,
}

/// What the provider runs, inside the app's bundle.
pub struct Programs {
    pub node: PathBuf,
    pub service: PathBuf,
    pub driver: PathBuf,
    /// The folder of the agents' pointer, the cursor theme the driver draws in place of its own.
    pub themes: PathBuf,
}

/// The agents' pointer: its theme's id, and its file's name in `themes`, `<id>.cua-theme`.
pub const CURSOR_THEME: &str = "ai.uniac.agentorg.pointer";

impl Programs {
    /// Where the bundle puts them (tauri.conf.json's `bundle.macOS.files`): Node beside the app's
    /// own program, and the driver and the service among its resources. The driver draws windows,
    /// and macOS takes a program in Contents/MacOS that does for the app itself: opening the app
    /// would then only bring the driver forward.
    fn in_bundle(app: &Path) -> Self {
        let contents = app.join("Contents");
        Programs {
            node: contents.join("MacOS/node"),
            service: contents.join("Resources/agentcomputer/dist/agentcomputer.js"),
            driver: contents.join("Resources/cua-driver"),
            themes: contents.join("Resources/cursor-themes"),
        }
    }

    /// The agents' pointer, where the bundle carries it.
    fn pointer(&self) -> Option<PathBuf> {
        Some(self.themes.join(format!("{CURSOR_THEME}.cua-theme"))).filter(|at| at.is_file())
    }

    fn missing(&self) -> Vec<&Path> {
        [&self.node, &self.service, &self.driver]
            .into_iter()
            .map(PathBuf::as_path)
            .filter(|at| !at.exists())
            .collect()
    }
}

/// Where the provider keeps what it keeps: all in the app's folder, but for the person's home.
pub struct Places {
    pub folder: PathBuf,
    pub home: PathBuf,
    pub data: PathBuf,
    pub driver_home: PathBuf,
    pub socket: PathBuf,
    pub state: PathBuf,
}

/// How soon the provider reads the screen's grants again while one is missing, at first: the wait
/// doubles at each read that finds no change, to at most 60 times this, and starts over when a
/// grant step or the window tells it to read them.
const WATCH: Duration = Duration::from_secs(5);

/// The screen's two grants, Accessibility and Screen Recording, as a fresh process reads them.
pub type Grants = (bool, bool);

static STOP: AtomicBool = AtomicBool::new(false);
static REGRANT: AtomicBool = AtomicBool::new(false);

extern "C" fn on_signal(signal: libc::c_int) {
    if signal == libc::SIGUSR1 {
        REGRANT.store(true, Ordering::Relaxed);
    } else {
        STOP.store(true, Ordering::Relaxed);
    }
}

pub fn run_as_background_item() {
    let mut starts = crate::menu_bar::Starts::default();
    let mut checked: Option<Instant> = None;
    unsafe {
        for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGUSR1] {
            libc::signal(signal, on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t);
        }
    }
    log("provider", "started by macOS as the app's background item");
    let Some(app) = places::bundle() else { return log("provider", "it isn't inside an app") };
    // One provider at a time: another copy of the app's waits here until this one has ended.
    let _held = hold(&places::provider_lock());
    let places = Places {
        folder: places::agentorg(),
        home: places::home(),
        data: places::data(),
        driver_home: places::driver_home(),
        socket: places::driver_socket(),
        state: places::provider_state(),
    };
    let identifier = macos::identifier().unwrap_or_default();
    // Restoring no windows, the driver reaches no file kept for Full Disk Access as it starts.
    macos::driver_restores_windows(false);
    let grants = || (grant::granted("accessibility"), grant::granted("screen-recording"));
    // The menu-bar item, which the window's process holds: started with no window where none runs,
    // as after a login. Looked for every 2 s, and only while macOS allows the background item, so
    // that one quitting with the item unregistered isn't started again.
    let mut menu_bar = || {
        if checked.is_some_and(|at| at.elapsed() < Duration::from_secs(2)) {
            return;
        }
        checked = Some(Instant::now());
        let running = crate::menu_bar::running(&crate::menu_bar::state()).is_some();
        let allowed = || macos::background_item_status() == Some(1);
        if !running && starts.due(running, allowed(), Instant::now()) {
            crate::menu_bar::start(&app);
        } else if running {
            starts.due(true, true, Instant::now());
        }
    };
    let programs = Programs::in_bundle(&app);
    provide(&programs, &places, &identifier, &STOP, &REGRANT, &grants, WATCH, &mut menu_bar);
}

/// Holds a lock for as long as what it returns is kept, waiting for it first.
fn hold(lock: &Path) -> Option<fs::File> {
    let _ = fs::create_dir_all(lock.parent()?);
    let file = fs::OpenOptions::new().create(true).truncate(false).write(true).open(lock).ok()?;
    (unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0).then_some(file)
}

/// Tells the provider a grant may have changed, so that it reads them, and starts its driver again
/// where they differ from what the driver read.
pub fn grants_changed() {
    match provider_now() {
        Some(said) => {
            unsafe { libc::kill(said.pid, libc::SIGUSR1) };
            log("grant", "the provider reads the grants again");
        }
        None => log("grant", "no provider is running to start its driver again"),
    }
}

/// The provider's state, where one is running.
pub fn state_now() -> Option<AppState> {
    provider_now().map(|said| said.state)
}

/// What the provider says of itself, where it is a live process running this same program: a
/// state file left by one that was ended outright names no other.
fn provider_now() -> Option<Said> {
    let said = read::<Said>(&places::provider_state())?;
    let own = std::env::current_exe().ok()?;
    runs(said.pid, &own).then_some(said)
}

fn read<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// Whether a process is alive and running that program.
fn runs(pid: i32, program: &Path) -> bool {
    let Ok(program) = program.canonicalize() else { return false };
    macos::alive(pid)
        && macos::program_of(pid).and_then(|running| running.canonicalize().ok()) == Some(program)
}

/// Ends processes: each asked to end, then ended after the grace period. `ended` says whether one
/// has, and reaps it where it is a child.
fn end_all(pids: &[i32], mut ended: impl FnMut(i32) -> bool) {
    for &pid in pids {
        unsafe { libc::kill(pid, libc::SIGTERM) };
    }
    let deadline = Instant::now() + GRACE;
    for &pid in pids {
        while !ended(pid) && Instant::now() < deadline {
            sleep(Duration::from_millis(100));
        }
        if !ended(pid) {
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
    }
}

/// One of the two programs the provider keeps running, with the last lines it wrote.
struct Kept {
    name: &'static str,
    child: Option<Child>,
    started: Instant,
    ended: Option<Instant>,
    quick_ends: usize,
    last: Arc<Mutex<VecDeque<String>>>,
}

impl Kept {
    fn new(name: &'static str) -> Self {
        let (started, last) = (Instant::now(), Arc::default());
        Kept { name, child: None, started, ended: None, quick_ends: 0, last }
    }

    fn pid(&self) -> Option<i32> {
        self.child.as_ref().map(|child| child.id() as i32)
    }

    /// The wait before it is started again.
    fn wait(&self) -> Duration {
        Duration::from_secs(WAITS[self.quick_ends.saturating_sub(1).min(WAITS.len() - 1)])
    }

    /// Whether it is time to start it: not running, and its wait since it ended is over.
    fn due(&self) -> bool {
        self.child.is_none() && self.ended.is_none_or(|ended| ended.elapsed() >= self.wait())
    }

    /// Starts it, keeping its last lines.
    fn start(&mut self, mut command: Command) {
        self.last.lock().unwrap_or_else(|held| held.into_inner()).clear();
        command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        match command.spawn() {
            Ok(mut child) => {
                let out = child.stdout.take().map(|out| Box::new(out) as Box<dyn Read + Send>);
                let err = child.stderr.take().map(|err| Box::new(err) as Box<dyn Read + Send>);
                for stream in [out, err].into_iter().flatten() {
                    let last = self.last.clone();
                    thread::spawn(move || {
                        for line in BufReader::new(stream).lines().map_while(Result::ok) {
                            let mut last = last.lock().unwrap_or_else(|held| held.into_inner());
                            last.push_back(line);
                            if last.len() > 20 {
                                last.pop_front();
                            }
                        }
                    });
                }
                log("provider", &format!("the {} started, as process {}", self.name, child.id()));
                self.child = Some(child);
                self.started = Instant::now();
            }
            Err(error) => {
                self.ended(Duration::ZERO);
                let wait = self.wait().as_secs();
                let why = format!("the {} didn't start: {error}; again in {wait} s", self.name);
                log("provider", &why);
            }
        }
    }

    /// Whether it has ended by itself; if so, the log says how, with its last lines and the
    /// wait before it starts again.
    fn reap(&mut self) -> bool {
        let Some(child) = self.child.as_mut() else { return false };
        let Ok(Some(status)) = child.try_wait() else { return false };
        let ran = self.started.elapsed();
        self.child = None;
        self.ended(ran);
        let mut kept = self.last.lock().unwrap_or_else(|held| held.into_inner());
        let lines = kept.drain(..).collect::<Vec<_>>().join(" | ");
        drop(kept);
        let (name, secs, wait) = (self.name, ran.as_secs(), self.wait().as_secs());
        let line = format!(
            "the {name} ended ({status}) after {secs} s, its last lines: {lines}; again in {wait} s"
        );
        log("provider", &line);
        true
    }

    /// One that ran a while is started again at once; one that ended soon, after a wait that
    /// grows each time in a row.
    fn ended(&mut self, ran: Duration) {
        self.quick_ends = if ran >= SETTLED { 0 } else { self.quick_ends + 1 };
        self.ended = Some(Instant::now());
    }
}

/// Stops what it runs, all at once, each given the grace period.
fn stop(kept: &mut [&mut Kept]) {
    let pids: Vec<i32> = kept.iter().filter_map(|one| one.pid()).collect();
    let mut children: Vec<(&'static str, Child)> =
        kept.iter_mut().filter_map(|one| Some((one.name, one.child.take()?))).collect();
    end_all(&pids, |pid| {
        let child = children.iter_mut().find(|(_, child)| child.id() as i32 == pid);
        child.is_none_or(|(_, child)| !matches!(child.try_wait(), Ok(None)))
    });
    for (name, mut child) in children {
        let _ = child.wait();
        log("provider", &format!("the {name} was stopped"));
    }
}

/// The environment the provider gives what it starts: a small one of its own, never the app's.
fn small_env(home: &Path) -> Vec<(String, String)> {
    let own = |name: &str, otherwise: &str| {
        std::env::var(name).unwrap_or_else(|_| otherwise.into())
    };
    let user = own("USER", "");
    vec![
        ("HOME".into(), home.display().to_string()),
        ("USER".into(), user.clone()),
        ("LOGNAME".into(), own("LOGNAME", &user)),
        ("SHELL".into(), macos::login_shell().unwrap_or_else(|| "/bin/zsh".into())),
        ("TMPDIR".into(), own("TMPDIR", "/tmp")),
        ("LANG".into(), own("LANG", "en_US.UTF-8")),
        ("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into()),
        ("DO_NOT_TRACK".into(), "1".into()),
    ]
}

fn driver_command(programs: &Programs, places: &Places, identifier: &str) -> Command {
    let mut command = Command::new(&programs.driver);
    // No Automation prompt: where an app's consent isn't given, the agent is refused instead.
    command
        .args(["serve", "--embedded", "--no-automation-prompts", "--socket"])
        .arg(&places.socket)
        .env_clear()
        .envs(small_env(&places.driver_home))
        .envs([
            ("CUA_DRIVER_EMBEDDED", "1"),
            ("CUA_DRIVER_HOST_BUNDLE_ID", identifier),
            ("CUA_DRIVER_RS_UPDATE_CHECK", "false"),
        ]);
    // Each agent drawn with the app's pointer, from where the bundle carries it. A build without it
    // leaves the driver's own.
    if programs.pointer().is_some() {
        command
            .args(["--cursor-theme", CURSOR_THEME])
            .env("CUA_DRIVER_CURSOR_THEME_DIR", &programs.themes);
    }
    command
}

/// The object at `key` in `map`, made one where there is none or something else.
fn object<'a>(map: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    let entry = map.entry(key).or_insert_with(|| Value::Object(Map::new()));
    if !entry.is_object() {
        *entry = Value::Object(Map::new());
    }
    entry.as_object_mut().expect("an object")
}

/// The driver's cursor settings, written into its config before each start, keeping all else it
/// holds: the pointer drawn alone, upright, with no halo, badge, or effect when it moves or clicks.
/// The driver reads them at its start; the size, the glide, and the 15 s before an idle pointer
/// fades are its own.
pub fn cursor_settings(driver_home: &Path) -> std::io::Result<()> {
    let path = driver_home.join(".cua-driver/config.json");
    let mut config: Map<String, Value> = fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    let cursor = object(&mut config, "cursor");
    cursor.insert("halo".into(), false.into());
    cursor.insert("float".into(), false.into());
    cursor.insert("rotate".into(), "off".into());
    cursor.insert("badges".into(), "off".into());
    let effects = object(object(cursor, "motion"), "effects");
    for effect in ["trail", "glow", "magnet", "ripple", "squish"] {
        effects.insert(effect.into(), false.into());
    }
    fs::create_dir_all(path.parent().expect("a folder"))?;
    let written = path.with_extension("json.new");
    fs::write(&written, format!("{:#}\n", Value::Object(config)))?;
    fs::rename(&written, &path)
}

fn service_command(programs: &Programs, places: &Places) -> Command {
    let mut command = Command::new(&programs.node);
    command
        .arg(&programs.service)
        .args(["serve", "--lend", "--listen", "127.0.0.1:0", "--data"])
        .arg(&places.data)
        .arg("--screen-driver")
        .arg(&programs.driver)
        .arg("--screen-socket")
        .arg(&places.socket)
        .env_clear()
        .envs(small_env(&places.home));
    command
}

/// The process the service's record names, while it runs.
fn recorded(places: &Places) -> Option<i32> {
    let record = read::<Value>(&places.data.join("server.json"))?;
    i32::try_from(record["pid"].as_i64()?).ok()
}

/// Ends what an earlier run left running: a process the state file or the service's record names,
/// where it runs one of the app's own programs.
fn stop_left(places: &Places, programs: &Programs) {
    let said = read::<Value>(&places.state).unwrap_or_default();
    let pid = |key: &str| said[key].as_i64().and_then(|pid| i32::try_from(pid).ok());
    let left: Vec<i32> = [
        (pid("driver"), &programs.driver),
        (pid("service"), &programs.node),
        (recorded(places), &programs.node),
    ]
    .into_iter()
    .filter_map(|(pid, program)| pid.filter(|&pid| runs(pid, program)))
    .collect();
    for pid in &left {
        log("provider", &format!("process {pid}, which an earlier run left, is stopped"));
    }
    end_all(&left, |pid| !macos::alive(pid));
}

fn write_state(places: &Places, said: &Said) {
    let fresh = places.state.with_extension("json.new");
    if fs::write(&fresh, serde_json::to_vec(said).unwrap_or_default()).is_ok() {
        let _ = fs::rename(&fresh, &places.state);
    }
}

/// How long the first picture is waited for before it is ended: the driver answers in well under a
/// second, so one still running then is stuck.
const PICTURE_MS: u64 = 30_000;

/// One picture of the whole screen through the driver, as small as it takes one, which nothing
/// keeps: the first capture after Screen Recording is given, which macOS may answer with its alert.
/// It runs by itself, and is waited for off this thread, for `wait` at most, then ended.
fn first_picture(programs: &Programs, places: &Places, wait: Duration) {
    let mut command = Command::new(&programs.driver);
    command
        .args(["call", "get_desktop_state", r#"{"max_image_dimension":64}"#, "--socket"])
        .arg(&places.socket)
        .env_clear()
        .envs(small_env(&places.driver_home))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    match command.spawn() {
        Ok(mut picture) => {
            log("provider", "Screen Recording given: one picture of the screen, as macOS may ask");
            thread::spawn(move || {
                let end = Instant::now() + wait;
                while matches!(picture.try_wait(), Ok(None)) {
                    if Instant::now() >= end {
                        let _ = picture.kill();
                        let _ = picture.wait();
                        log("provider", "the first picture took too long, and was ended");
                        return;
                    }
                    sleep(Duration::from_millis(100));
                }
            });
        }
        Err(error) => log("provider", &format!("the first picture couldn't be taken: {error}")),
    }
}

/// Keeps the driver and the service running until asked to stop. The driver reads the grants
/// once, at its start: so where they differ from what it read, it is started again. While it runs
/// they are read when `regrant` is set, and, while one is missing, again after `every`, doubling to
/// at most 60 times that, as the person may switch one in System Settings at any time. Where the
/// driver starts again with Screen Recording that the one before it didn't have, it takes one
/// picture once it answers.
pub fn provide(
    programs: &Programs,
    places: &Places,
    identifier: &str,
    stop_now: &AtomicBool,
    regrant: &AtomicBool,
    grants: &dyn Fn() -> Grants,
    every: Duration,
    menu_bar: &mut dyn FnMut(),
) {
    for folder in [&places.data, &places.driver_home] {
        let _ = fs::create_dir_all(folder);
    }
    // The app's folder is its owner's alone, the driver's socket in it among what no other account
    // can reach.
    let _ = fs::set_permissions(&places.folder, fs::Permissions::from_mode(0o700));
    let missing = programs.missing();
    if !missing.is_empty() {
        let names: Vec<String> = missing.iter().map(|at| at.display().to_string()).collect();
        let names = names.join(", ");
        log("provider", &format!("this build carries no service to run: {names} missing"));
    }
    if missing.is_empty() && programs.pointer().is_none() {
        log("provider", "this build carries no pointer for the agents: Cua Driver draws its own");
    }
    stop_left(places, programs);
    let (mut driver, mut service) = (Kept::new("driver"), Kept::new("service"));
    let (mut said, mut ran, mut rotated) = (None, false, Instant::now());
    // What the running driver read at its start, when the grants were last read since, and how
    // long until they are read again.
    let (mut read_by_driver, mut read_at, mut wait): (Option<Grants>, _, _) =
        (None, Instant::now(), every);
    // Whether the driver now starting is the first with Screen Recording just given.
    let mut picture_due = false;
    while !stop_now.load(Ordering::Relaxed) {
        let told = regrant.swap(false, Ordering::Relaxed);
        let missing_one = read_by_driver.is_some_and(|read| read != (true, true));
        let due = missing_one && read_at.elapsed() >= wait;
        if driver.pid().is_some() && (told || due) {
            wait = if told { every } else { (wait * 2).min(every * 60) };
            read_at = Instant::now();
            if read_by_driver.is_some_and(|read| read != grants()) {
                log("provider", "a grant changed: the driver starts again, to read it");
                stop(&mut [&mut driver]);
            }
        }
        driver.reap();
        service.reap();
        if missing.is_empty() && driver.due() {
            let before = read_by_driver;
            read_by_driver = Some(grants());
            // Given since the driver before read them: not at the provider's own start.
            picture_due = before.is_some_and(|(_, screen)| !screen)
                && read_by_driver.is_some_and(|(_, screen)| screen);
            (read_at, wait) = (Instant::now(), every);
            let _ = fs::remove_file(&places.socket);
            if let Err(error) = cursor_settings(&places.driver_home) {
                log("provider", &format!("the pointer's settings couldn't be written: {error}"));
            }
            driver.start(driver_command(programs, places, identifier));
        }
        let socket = driver.pid().is_some() && places.socket.exists();
        if socket && picture_due {
            picture_due = false;
            first_picture(programs, places, Duration::from_millis(PICTURE_MS));
        }
        if missing.is_empty() && socket && service.due() {
            service.start(service_command(programs, places));
        }
        // The service is up once its record names it: what the window and the core read.
        let up = socket && service.pid().is_some() && recorded(places) == service.pid();
        ran |= up;
        let state = match (up, ran) {
            (true, _) => AppState::Running,
            (false, true) => AppState::StartingAgain,
            (false, false) => AppState::Starting,
        };
        let now = Said {
            pid: std::process::id() as i32,
            state,
            driver: driver.pid(),
            service: service.pid(),
        };
        if said.as_ref() != Some(&now) {
            if said.as_ref().is_none_or(|was: &Said| was.state != state) {
                log("provider", state.name());
            }
            write_state(places, &now);
            said = Some(now);
        }
        menu_bar();
        if rotated.elapsed() >= Duration::from_secs(60) {
            rotate();
            rotated = Instant::now();
        }
        sleep(Duration::from_millis(250));
    }
    stop(&mut [&mut service, &mut driver]);
    let _ = fs::remove_file(&places.state);
    log("provider", "stopped");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn program(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn until(what: &str, check: impl Fn() -> bool) {
        let end = Instant::now() + Duration::from_secs(20);
        while !check() {
            assert!(Instant::now() < end, "waited too long for {what}");
            sleep(Duration::from_millis(50));
        }
    }

    fn places_in(root: &Path) -> Places {
        Places {
            folder: root.to_path_buf(),
            home: root.join("home"),
            data: root.join("data"),
            driver_home: root.join("driver"),
            socket: root.join("driver/d.sock"),
            state: root.join("provider.json"),
        }
    }

    /// No menu-bar item in these tests: the provider's start decision is `menu_bar`'s.
    fn no_menu_bar() {}

    /// Stops the provider when a test ends, so that one that fails ends too.
    struct Stops<'a>(&'a AtomicBool);
    impl Drop for Stops<'_> {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Relaxed);
        }
    }

    #[test]
    fn the_driver_and_the_service_are_kept_running() {
        crate::test_home();
        let root = std::env::temp_dir().join(format!("agentorg-provider-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let heard = root.join("heard");
        fs::create_dir_all(&heard).unwrap();
        let programs = Programs {
            node: root.join("app/node"),
            service: root.join("app/agentcomputer/agentcomputer.js"),
            driver: root.join("app/cua-driver"),
            themes: root.join("app/cursor-themes"),
        };
        let h = heard.display();
        // Stand-ins: the driver makes its socket, and the service writes its record, as each does;
        // each says what it was given.
        let says = |name: &str| format!("env > '{h}/{name}.env'\necho \"$@\" > '{h}/{name}.args'");
        program(&programs.driver, &format!("{}\n: > \"$5\"\nexec sleep 600", says("driver")));
        let record = r#"echo "{\"url\":\"http://127.0.0.1:1\",\"pid\":$$}" > "$7/server.json""#;
        program(&programs.node, &format!("{}\n{record}\nexec sleep 600", says("service")));
        program(&programs.service, "");
        let places = places_in(&root);
        let (stop_now, regrant) = (AtomicBool::new(false), AtomicBool::new(false));
        let said = |name: &str| fs::read_to_string(heard.join(name)).unwrap_or_default();
        let now = || read::<Said>(&places.state);
        let state = || now().map(|said| said.state);
        let pid = |key: &str| {
            now().and_then(|said| if key == "driver" { said.driver } else { said.service })
        };
        thread::scope(|scope| {
            let _stops = Stops(&stop_now);
            scope.spawn(|| {
                let (grants, every) = (|| (true, true), Duration::from_secs(5));
                let (stop, menu_bar) = (&stop_now, &mut no_menu_bar);
                provide(&programs, &places, "test.id", stop, &regrant, &grants, every, menu_bar)
            });
            until("both running", || state() == Some(AppState::Running));
            // The app's folder is its owner's alone.
            assert_eq!(fs::metadata(&root).unwrap().permissions().mode() & 0o777, 0o700);

            // The driver: embedded on its socket, as its host's, with no update check, in a small
            // environment of the provider's own, its home in the app's folder.
            let socket = places.socket.display().to_string();
            let serve = "serve --embedded --no-automation-prompts --socket";
            assert_eq!(said("driver.args").trim(), format!("{serve} {socket}"));
            let env = said("driver.env");
            for line in [
                "CUA_DRIVER_EMBEDDED=1",
                "CUA_DRIVER_HOST_BUNDLE_ID=test.id",
                "CUA_DRIVER_RS_UPDATE_CHECK=false",
                "DO_NOT_TRACK=1",
                "PATH=/usr/bin:/bin:/usr/sbin:/sbin",
                &format!("HOME={}", places.driver_home.display()),
            ] {
                assert!(env.lines().any(|kept| kept == line), "{line} in {env}");
            }
            assert!(!env.contains("CARGO"), "{env}");
            // Its settings for the pointer, in its home's config, before it started.
            let config = fs::read_to_string(places.driver_home.join(".cua-driver/config.json"));
            let config: Value = serde_json::from_str(&config.unwrap()).unwrap();
            assert_eq!(config["cursor"]["halo"], false);

            // The service: lending only, reaching the driver on its socket, its home the person's.
            let (service, data) = (programs.service.display(), places.data.display());
            let lend = "serve --lend --listen 127.0.0.1:0";
            assert_eq!(
                said("service.args").trim(),
                format!(
                    "{service} {lend} --data {data} --screen-driver {} --screen-socket {socket}",
                    programs.driver.display()
                )
            );
            let env = said("service.env");
            let home = format!("HOME={}", places.home.display());
            assert!(env.lines().any(|kept| kept == home), "{env}");
            assert!(!env.contains("CARGO") && !env.contains("CUA_DRIVER"), "{env}");

            // A service that ends is started again.
            let again = |key: &str, was: i32| {
                pid(key).is_some_and(|now| now != was) && state() == Some(AppState::Running)
            };
            let service = pid("service").unwrap();
            unsafe { libc::kill(service, libc::SIGKILL) };
            until("the service again", || again("service", service));

            // Stopped, it stops both, and says nothing more of itself.
            let (driver, service) = (pid("driver").unwrap(), pid("service").unwrap());
            stop_now.store(true, Ordering::Relaxed);
            until("it stopped", || !places.state.exists());
            assert!(!macos::alive(driver) && !macos::alive(service));
        });
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn what_an_earlier_run_left_is_stopped_only_where_it_is_the_apps_own() {
        crate::test_home();
        let root = std::env::temp_dir().join(format!("agentorg-left-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        // A copy of sleep stands for the app's driver; the system's own sleep is someone else's.
        let ours = root.join("cua-driver");
        fs::copy("/bin/sleep", &ours).unwrap();
        // Each started apart from this process, as what a run left is no child of the next.
        let left = |program: &Path| -> i32 {
            let started = format!("'{}' 600 >/dev/null 2>&1 & echo $!", program.display());
            let out = Command::new("/bin/sh").args(["-c", &started]).output().unwrap();
            String::from_utf8(out.stdout).unwrap().trim().parse().unwrap()
        };
        let (driver, someone_elses) = (left(&ours), left(Path::new("/bin/sleep")));
        let places = places_in(&root);
        let said = serde_json::json!({ "pid": 1, "driver": driver, "service": someone_elses });
        fs::write(&places.state, said.to_string()).unwrap();
        let (node, service) = (root.join("node"), root.join("service.js"));
        let themes = root.join("cursor-themes");
        let programs = Programs { node, service, driver: ours, themes };
        stop_left(&places, &programs);
        until("ours stopped", || !macos::alive(driver));
        assert!(macos::alive(someone_elses));
        unsafe { libc::kill(someone_elses, libc::SIGTERM) };
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_state_file_names_only_a_live_process_running_this_program() {
        let own = std::env::current_exe().unwrap();
        assert!(runs(std::process::id() as i32, &own));
        // The system's sleep, alive, runs another program; a process that has ended runs none.
        let mut other = Command::new("/bin/sleep").arg("600").spawn().unwrap();
        assert!(!runs(other.id() as i32, &own));
        let _ = other.kill();
        let _ = other.wait();
        assert!(!runs(other.id() as i32, Path::new("/bin/sleep")));
    }

    #[test]
    fn the_driver_starts_again_when_the_grants_it_read_change() {
        crate::test_home();
        let root = std::env::temp_dir().join(format!("agentorg-grants-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let programs = Programs {
            node: root.join("app/node"),
            service: root.join("app/agentcomputer/agentcomputer.js"),
            driver: root.join("app/cua-driver"),
            themes: root.join("app/cursor-themes"),
        };
        // The stand-in keeps the pointer's settings as it found them when it started.
        let seen = root.join("seen.json");
        let keeps = format!("cp \"$HOME/.cua-driver/config.json\" '{}'", seen.display());
        // Called, as for the first picture once Screen Recording is given, it answers at once.
        let called = "if [ \"$1\" = call ]; then exit 0; fi";
        program(&programs.driver, &format!("{called}\n{keeps}\n: > \"$5\"\nexec sleep 600"));
        let record = r#"echo "{\"url\":\"http://127.0.0.1:1\",\"pid\":$$}" > "$7/server.json""#;
        program(&programs.node, &format!("{record}\nexec sleep 600"));
        program(&programs.service, "");
        let places = places_in(&root);
        // The grants, as the test sets them, and how often they are read.
        let (accessibility, screen_recording) = (AtomicBool::new(false), AtomicBool::new(false));
        let reads = std::sync::atomic::AtomicUsize::new(0);
        let grants = || {
            reads.fetch_add(1, Ordering::Relaxed);
            (accessibility.load(Ordering::Relaxed), screen_recording.load(Ordering::Relaxed))
        };
        let driver = || read::<Said>(&places.state).and_then(|said| said.driver);
        let again = |was: i32| driver().is_some_and(|now| now != was);
        // Each run: started, then this, then stopped.
        let run = |every: Duration, check: &dyn Fn(&AtomicBool)| {
            let (stop_now, regrant) = (AtomicBool::new(false), AtomicBool::new(false));
            thread::scope(|scope| {
                let _stops = Stops(&stop_now);
                scope.spawn(|| {
                    let (stop, menu_bar) = (&stop_now, &mut no_menu_bar);
                    provide(&programs, &places, "test.id", stop, &regrant, &grants, every, menu_bar)
                });
                until("the driver", || driver().is_some());
                check(&regrant);
                stop_now.store(true, Ordering::Relaxed);
                until("it stopped", || !places.state.exists());
            });
        };
        // Told, it reads them: with no change the driver is left as it is, and with a grant given
        // it starts again. Nothing is read unasked here, as the wait is an hour.
        run(Duration::from_secs(3600), &|regrant| {
            let was = driver().unwrap();
            regrant.store(true, Ordering::Relaxed);
            until("the grants read", || !regrant.load(Ordering::Relaxed));
            sleep(Duration::from_millis(500));
            assert_eq!(driver(), Some(was));
            // Whatever changed the settings meanwhile, the driver started again has them as set.
            let config = places.driver_home.join(".cua-driver/config.json");
            fs::write(&config, r#"{"cursor":{"halo":true,"badges":"minimal"}}"#).unwrap();
            fs::remove_file(&seen).unwrap();
            accessibility.store(true, Ordering::Relaxed);
            regrant.store(true, Ordering::Relaxed);
            // Its pid is known as it is started, before it has read its settings.
            until("the driver again, its settings read", || again(was) && seen.exists());
            let found: Value = serde_json::from_str(&fs::read_to_string(&seen).unwrap()).unwrap();
            assert_eq!(found["cursor"]["halo"], false);
            assert_eq!(found["cursor"]["badges"], "off");
        });
        // Unasked, while one is missing: a grant given in System Settings, with nothing told,
        // starts the driver again too. Both given, they are no longer read unasked.
        accessibility.store(false, Ordering::Relaxed);
        run(Duration::from_millis(100), &|_| {
            let was = driver().unwrap();
            accessibility.store(true, Ordering::Relaxed);
            screen_recording.store(true, Ordering::Relaxed);
            until("the driver again, unasked", || again(was));
            let read = reads.load(Ordering::Relaxed);
            sleep(Duration::from_millis(1_000));
            assert_eq!(reads.load(Ordering::Relaxed), read);
        });
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn screen_recording_just_given_is_followed_by_one_picture_once_the_driver_answers() {
        crate::test_home();
        let root = std::env::temp_dir().join(format!("agentorg-picture-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let programs = Programs {
            node: root.join("app/node"),
            service: root.join("app/agentcomputer/agentcomputer.js"),
            driver: root.join("app/cua-driver"),
            themes: root.join("app/cursor-themes"),
        };
        // The stand-in driver: served, it makes its socket and runs on; called, it notes the call.
        let calls = root.join("calls");
        let driver = format!(
            "if [ \"$1\" = call ]; then echo \"$2 $3 $4 $5\" >> '{}'; exit 0; fi\n\
             : > \"$5\"\nexec sleep 600",
            calls.display()
        );
        program(&programs.driver, &driver);
        let record = r#"echo "{\"url\":\"http://127.0.0.1:1\",\"pid\":$$}" > "$7/server.json""#;
        program(&programs.node, &format!("{record}\nexec sleep 600"));
        program(&programs.service, "");
        let places = places_in(&root);
        let (accessibility, screen_recording) = (AtomicBool::new(true), AtomicBool::new(false));
        let grants =
            || (accessibility.load(Ordering::Relaxed), screen_recording.load(Ordering::Relaxed));
        let started = || read::<Said>(&places.state).and_then(|said| said.driver);
        let noted = || fs::read_to_string(&calls).unwrap_or_default();
        let (stop_now, regrant) = (AtomicBool::new(false), AtomicBool::new(false));
        thread::scope(|scope| {
            let _stops = Stops(&stop_now);
            scope.spawn(|| {
                let (stop, menu_bar) = (&stop_now, &mut no_menu_bar);
                let every = Duration::from_secs(3600);
                provide(&programs, &places, "test.id", stop, &regrant, &grants, every, menu_bar)
            });
            until("the driver", || started().is_some());
            // At the provider's start, nothing is pictured, whatever the grants.
            sleep(Duration::from_millis(500));
            assert_eq!(noted(), "");
            // Accessibility given alone: the driver starts again, with no picture.
            accessibility.store(false, Ordering::Relaxed);
            let was = started().unwrap();
            regrant.store(true, Ordering::Relaxed);
            until("the driver again", || started().is_some_and(|now| now != was));
            accessibility.store(true, Ordering::Relaxed);
            let was = started().unwrap();
            regrant.store(true, Ordering::Relaxed);
            until("the driver again", || started().is_some_and(|now| now != was));
            sleep(Duration::from_millis(500));
            assert_eq!(noted(), "");
            // Screen Recording given: one picture, through the new driver's socket.
            screen_recording.store(true, Ordering::Relaxed);
            let was = started().unwrap();
            regrant.store(true, Ordering::Relaxed);
            until("the picture", || !noted().is_empty());
            assert!(started().is_some_and(|now| now != was));
            let socket = places.socket.display().to_string();
            let picture =
                format!("get_desktop_state {{\"max_image_dimension\":64}} --socket {socket}\n");
            assert_eq!(noted(), picture);
            // Read again with nothing changed, nothing more.
            regrant.store(true, Ordering::Relaxed);
            until("the grants read", || !regrant.load(Ordering::Relaxed));
            sleep(Duration::from_millis(500));
            assert_eq!(noted(), picture);
            stop_now.store(true, Ordering::Relaxed);
            until("it stopped", || !places.state.exists());
        });
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_first_picture_that_doesnt_answer_is_ended() {
        crate::test_home();
        let root = std::env::temp_dir().join(format!("agentorg-stuck-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let programs = Programs {
            node: root.join("app/node"),
            service: root.join("app/agentcomputer/agentcomputer.js"),
            driver: root.join("app/cua-driver"),
            themes: root.join("app/cursor-themes"),
        };
        // A driver that never answers the call, saying which process it is.
        let pid = root.join("pid");
        program(&programs.driver, &format!("echo $$ > '{}'\nexec sleep 600", pid.display()));
        let places = places_in(&root);
        first_picture(&programs, &places, Duration::from_millis(300));
        until("the picture", || fs::read_to_string(&pid).is_ok_and(|said| !said.trim().is_empty()));
        let pid: i32 = fs::read_to_string(&pid).unwrap().trim().parse().unwrap();
        // Ended once the wait is over, and reaped: no process is left.
        until("the picture ended", || unsafe { libc::kill(pid, 0) } != 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_state_file_names_the_states_as_the_page_does() {
        let said = Said { pid: 7, state: AppState::StartingAgain, driver: Some(8), service: None };
        let written = serde_json::to_value(&said).unwrap();
        assert_eq!(written["state"], "starting again");
        assert_eq!(serde_json::from_value::<Said>(written).unwrap(), said);
        use AppState::*;
        for state in [Starting, Running, StartingAgain, TurnedOff] {
            assert_eq!(serde_json::to_value(state).unwrap(), state.name());
        }
    }

    #[test]
    fn the_provider_finds_its_three_programs_where_the_bundle_puts_them() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let files = config["bundle"]["macOS"]["files"].as_object().unwrap();
        let programs = Programs::in_bundle(Path::new("/A.app"));
        for program in [&programs.node, &programs.driver, &programs.service, &programs.themes] {
            let inside = program.strip_prefix("/A.app/Contents").unwrap();
            let carried = files.keys().any(|key| inside.starts_with(key));
            assert!(carried, "{} isn't in the bundle's files", inside.display());
        }
        assert!(!programs.driver.starts_with("/A.app/Contents/MacOS"));
    }

    #[test]
    fn the_driver_draws_the_apps_pointer_where_the_bundle_carries_it() {
        let root = std::env::temp_dir().join(format!("agentorg-pointer-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let programs = Programs::in_bundle(&root.join("A.app"));
        let places = places_in(&root);
        let started = |programs: &Programs| {
            let command = driver_command(programs, &places, "test.id");
            let args: Vec<String> =
                command.get_args().map(|arg| arg.to_string_lossy().into()).collect();
            let dir = command
                .get_envs()
                .find(|(key, _)| *key == "CUA_DRIVER_CURSOR_THEME_DIR")
                .and_then(|(_, value)| value.map(PathBuf::from));
            (args.join(" "), dir)
        };
        // Without it, the driver's own.
        let (args, dir) = started(&programs);
        assert!(!args.contains("--cursor-theme"), "{args}");
        assert_eq!(dir, None);
        // With it, by its id, from its folder in the bundle.
        fs::create_dir_all(&programs.themes).unwrap();
        fs::write(programs.themes.join(format!("{CURSOR_THEME}.cua-theme")), "a theme").unwrap();
        let (args, dir) = started(&programs);
        assert!(args.ends_with(&format!("--cursor-theme {CURSOR_THEME}")), "{args}");
        let themes = root.join("A.app/Contents/Resources/cursor-themes");
        assert_eq!(dir.as_deref(), Some(themes.as_path()));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_pointers_settings_turn_every_extra_off_and_keep_the_rest_of_the_config() {
        let home = std::env::temp_dir().join(format!("agentorg-settings-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        let path = home.join(".cua-driver/config.json");
        let read = || serde_json::from_str::<Value>(&fs::read_to_string(&path).unwrap()).unwrap();
        // None yet: made.
        cursor_settings(&home).unwrap();
        let off = serde_json::json!({
            "halo": false,
            "float": false,
            "rotate": "off",
            "badges": "off",
            "motion": { "effects": {
                "trail": false, "glow": false, "magnet": false, "ripple": false, "squish": false
            } }
        });
        assert_eq!(read(), serde_json::json!({ "cursor": off }));
        // What the driver keeps, and what an agent turned back on, as the driver writes them.
        fs::write(
            &path,
            r#"{"max_image_dimension":1280,"cursor":{"halo":true,"rotate":"heading",
               "motion":{"style":"magnetic","effects":{"ripple":true}}}}"#,
        )
        .unwrap();
        cursor_settings(&home).unwrap();
        let config = read();
        assert_eq!(config["max_image_dimension"], 1280);
        assert_eq!(config["cursor"]["motion"]["style"], "magnetic");
        let mut cursor = config["cursor"].clone();
        cursor["motion"].as_object_mut().unwrap().remove("style");
        assert_eq!(cursor, off);
        // Something else where an object goes, or no JSON at all: made afresh.
        fs::write(&path, r#"{"cursor":5}"#).unwrap();
        cursor_settings(&home).unwrap();
        assert_eq!(read()["cursor"], off);
        fs::write(&path, "not JSON").unwrap();
        cursor_settings(&home).unwrap();
        assert_eq!(read(), serde_json::json!({ "cursor": off }));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn the_app_is_an_agent() {
        // What the Info.plist Tauri merges sets; what the window shows of it only a run shows.
        let plist = include_str!("../Info.plist");
        let value = plist.split("<key>LSUIElement</key>").nth(1).map(str::trim_start);
        assert!(value.is_some_and(|value| value.starts_with("<true/>")), "{plist}");
    }

    #[test]
    fn the_background_item_is_the_apps_own() {
        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let identifier = config["identifier"].as_str().unwrap();
        let plist = include_str!("../provider.plist");
        assert!(plist.contains(&format!("<key>Label</key><string>{identifier}.provider</string>")));
        let associated = "<key>AssociatedBundleIdentifiers</key><array><string>";
        assert!(plist.contains(&format!("{associated}{identifier}</string></array>")));
        assert!(plist.contains("<string>--provider</string>"));
        // The background item gives the provider longer to stop than it gives what it runs.
        assert!(plist.contains("<key>ExitTimeOut</key><integer>40</integer>"));
        let files = &config["bundle"]["macOS"]["files"];
        // Registering and unregistering both reach the item the bundle carries.
        let item = format!("Library/LaunchAgents/{}", macos::provider_plist(identifier));
        assert_eq!(files[item], "provider.plist");
    }
}
