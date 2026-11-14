//! `AgentOrg --provider`, started by macOS as the app's background item. It hosts Cua Driver,
//! embedded on a private socket as the driver's embedding guide has a host run it, and the service,
//! which reaches the driver there, each with a small environment, never the app's own. Either one
//! that ends is started again: at once, then with waits growing to 30 s. Once a grant changes, the
//! driver is started again, since it reads its grants once. What it does goes to the app's log.

use crate::log::{log, rotate};
use crate::{macos, places};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::os::fd::AsRawFd;
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
}

impl AppState {
    pub fn name(self) -> &'static str {
        match self {
            AppState::Starting => "starting",
            AppState::Running => "running",
            AppState::StartingAgain => "starting again",
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
}

impl Programs {
    fn in_bundle(app: &Path) -> Self {
        let resources = app.join("Contents/Resources");
        Programs {
            node: resources.join("node"),
            service: resources.join("agentcomputer/agentcomputer.js"),
            driver: resources.join("cua-driver"),
        }
    }

    fn missing(&self) -> Vec<&Path> {
        [&self.node, &self.service, &self.driver]
            .into_iter()
            .map(PathBuf::as_path)
            .filter(|at| !at.exists())
            .collect()
    }
}

/// Where the provider keeps what it keeps.
pub struct Places {
    pub home: PathBuf,
    pub data: PathBuf,
    pub driver_home: PathBuf,
    pub socket: PathBuf,
    pub state: PathBuf,
}

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
        home: places::home(),
        data: places::data(),
        driver_home: places::driver_home(),
        socket: places::driver_socket(),
        state: places::provider_state(),
    };
    let identifier = macos::identifier().unwrap_or_default();
    provide(&Programs::in_bundle(&app), &places, &identifier, &STOP, &REGRANT);
}

/// Holds a lock for as long as what it returns is kept, waiting for it first.
fn hold(lock: &Path) -> Option<fs::File> {
    let _ = fs::create_dir_all(lock.parent()?);
    let file = fs::OpenOptions::new().create(true).truncate(false).write(true).open(lock).ok()?;
    (unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0).then_some(file)
}

/// Tells the provider a grant has changed, so that it starts its driver again.
pub fn grants_changed() {
    match provider_now() {
        Some(said) => {
            unsafe { libc::kill(said.pid, libc::SIGUSR1) };
            log("grant", "the provider starts its driver again, to read the grants");
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
    command
        .args(["serve", "--embedded", "--socket"])
        .arg(&places.socket)
        .env_clear()
        .envs(small_env(&places.driver_home))
        .envs([
            ("CUA_DRIVER_EMBEDDED", "1"),
            ("CUA_DRIVER_HOST_BUNDLE_ID", identifier),
            ("CUA_DRIVER_RS_UPDATE_CHECK", "false"),
        ]);
    command
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

/// Keeps the driver and the service running until asked to stop.
pub fn provide(
    programs: &Programs,
    places: &Places,
    identifier: &str,
    stop_now: &AtomicBool,
    regrant: &AtomicBool,
) {
    for folder in [&places.data, &places.driver_home] {
        let _ = fs::create_dir_all(folder);
    }
    let missing = programs.missing();
    if !missing.is_empty() {
        let names: Vec<String> = missing.iter().map(|at| at.display().to_string()).collect();
        let names = names.join(", ");
        log("provider", &format!("this build carries no service to run: {names} missing"));
    }
    stop_left(places, programs);
    let (mut driver, mut service) = (Kept::new("driver"), Kept::new("service"));
    let (mut said, mut ran, mut rotated) = (None, false, Instant::now());
    while !stop_now.load(Ordering::Relaxed) {
        if regrant.swap(false, Ordering::Relaxed) {
            log("provider", "a grant changed: the driver starts again, to read it");
            stop(&mut [&mut driver]);
        }
        driver.reap();
        service.reap();
        if missing.is_empty() && driver.due() {
            let _ = fs::remove_file(&places.socket);
            driver.start(driver_command(programs, places, identifier));
        }
        let socket = driver.pid().is_some() && places.socket.exists();
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
            home: root.join("home"),
            data: root.join("data"),
            driver_home: root.join("driver"),
            socket: root.join("driver/d.sock"),
            state: root.join("provider.json"),
        }
    }

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
        };
        let h = heard.display();
        // Stand-ins: the driver makes its socket, and the service writes its record, as each does;
        // each says what it was given.
        let says = |name: &str| format!("env > '{h}/{name}.env'\necho \"$@\" > '{h}/{name}.args'");
        program(&programs.driver, &format!("{}\n: > \"$4\"\nexec sleep 600", says("driver")));
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
            scope.spawn(|| provide(&programs, &places, "test.id", &stop_now, &regrant));
            until("both running", || state() == Some(AppState::Running));

            // The driver: embedded on its socket, as its host's, with no update check, in a small
            // environment of the provider's own, its home in the app's folder.
            let socket = places.socket.display().to_string();
            assert_eq!(said("driver.args").trim(), format!("serve --embedded --socket {socket}"));
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

            // A service that ends is started again; a grant's change starts the driver again.
            let again = |key: &str, was: i32| {
                pid(key).is_some_and(|now| now != was) && state() == Some(AppState::Running)
            };
            let service = pid("service").unwrap();
            unsafe { libc::kill(service, libc::SIGKILL) };
            until("the service again", || again("service", service));
            let driver = pid("driver").unwrap();
            regrant.store(true, Ordering::Relaxed);
            until("the driver again", || again("driver", driver));

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
        let programs = Programs { node, service, driver: ours };
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
    fn the_state_file_names_the_states_as_the_page_does() {
        let said = Said { pid: 7, state: AppState::StartingAgain, driver: Some(8), service: None };
        let written = serde_json::to_value(&said).unwrap();
        assert_eq!(written["state"], "starting again");
        assert_eq!(serde_json::from_value::<Said>(written).unwrap(), said);
        for state in [AppState::Starting, AppState::Running, AppState::StartingAgain] {
            assert_eq!(serde_json::to_value(state).unwrap(), state.name());
        }
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
        let item = format!("Library/LaunchAgents/{identifier}.provider.plist");
        assert_eq!(files[item], "provider.plist");
    }
}
