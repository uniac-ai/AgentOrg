//! The app's window: the page in `packages/mac-window`, and the seam's commands it calls. They read
//! the service on this Mac from the record it leaves in its data folder, with its control token,
//! which the page never sees.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use crate::log::log;
use crate::menu_bar::{self, Dot};
use crate::places::data;
use crate::provider::AppState;
use crate::{macos, provider};
use std::time::Instant;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{ActivationPolicy, AppHandle, Emitter, LogicalSize, Manager, RunEvent, WebviewWindow};
use tauri::{WebviewWindowBuilder, WindowEvent};
use url::{Host, Url};

/// The window's width, as the design draws it; its height fits the page.
const WIDTH: f64 = 460.0;

/// A refusal, as the page's seam rejects with it: the service's own `{ code, message }`, or 503
/// while there is no service to answer.
#[derive(Serialize, Debug)]
struct Refusal {
    code: u16,
    message: String,
}

impl From<tauri::Error> for Refusal {
    fn from(error: tauri::Error) -> Self {
        Refusal { code: 500, message: error.to_string() }
    }
}

fn no_service() -> Refusal {
    Refusal { code: 503, message: "AgentOrg's service isn't running.".into() }
}

/// The service's address and control token. Nothing is written here: with no record, or one it
/// left when it stopped, there is no service to answer.
fn service() -> Result<(String, String), Refusal> {
    let record: Value =
        serde_json::from_slice(&fs::read(data().join("server.json")).map_err(|_| no_service())?)
            .map_err(|_| no_service())?;
    let url = record["url"].as_str().ok_or_else(no_service)?.to_owned();
    let token = fs::read_to_string(data().join("control-token")).map_err(|_| no_service())?;
    Ok((url, token.trim().to_owned()))
}

/// Whether an address is on this Mac over plain http, read with the parser the request itself
/// uses: no user information, and a host of 127.0.0.1, ::1 or localhost.
fn here(address: &str) -> bool {
    let Ok(url) = Url::parse(address) else { return false };
    url.scheme() == "http"
        && url.username().is_empty()
        && url.password().is_none()
        && match url.host() {
            Some(Host::Ipv4(ip)) => ip == Ipv4Addr::LOCALHOST,
            Some(Host::Ipv6(ip)) => ip == Ipv6Addr::LOCALHOST,
            Some(Host::Domain(name)) => name == "localhost",
            None => false,
        }
}

/// One call to the service, answered with its JSON, or refused with its words. The token goes
/// only to an address on this Mac: a record naming any other is no service.
fn call(method: &str, path: &str, body: Option<Value>) -> Result<Value, Refusal> {
    let (url, token) = service()?;
    let address = format!("{url}{path}");
    if !here(&address) {
        return Err(no_service());
    }
    let request = ureq::request(method, &address)
        .set("Authorization", &format!("Bearer {token}"))
        .timeout(Duration::from_secs(20));
    let answer = match body {
        Some(body) => request.send_json(body),
        None => request.call(),
    };
    match answer {
        Ok(answer) => answer
            .into_json()
            .map_err(|error| Refusal { code: 502, message: error.to_string() }),
        Err(ureq::Error::Status(code, answer)) => {
            let said: Option<Value> = answer.into_json().ok();
            let message = said.as_ref().and_then(|said| said["message"].as_str());
            Err(Refusal {
                code,
                message: message.map_or(format!("The service answered {code}."), str::to_owned),
            })
        }
        Err(_) => Err(no_service()),
    }
}

/// A part's name, as it goes into the service's path: a word, so the page reaches no other
/// endpoint with the token.
fn part(capability: &str) -> Result<&str, Refusal> {
    if !capability.is_empty() && capability.chars().all(|c| c.is_ascii_lowercase()) {
        Ok(capability)
    } else {
        Err(Refusal { code: 400, message: format!("There's no part called \"{capability}\".") })
    }
}

/// A call off the window's thread.
async fn called(
    method: &'static str,
    path: String,
    body: Option<Value>,
) -> Result<Value, Refusal> {
    let answer = tauri::async_runtime::spawn_blocking(move || call(method, &path, body))
        .await
        .unwrap_or_else(|error| Err(Refusal { code: 500, message: error.to_string() }));
    if answer.is_ok() {
        ANSWERED.store(true, Ordering::Relaxed);
    }
    answer
}

/// How a call ended, as the log says it.
fn outcome(answer: &Result<Value, Refusal>) -> String {
    match answer {
        Ok(_) => "answered".into(),
        Err(refusal) => format!("{} {}", refusal.code, refusal.message),
    }
}

/// A call off the window's thread, its answer noted in the log when it changes.
async fn read(
    what: &'static str,
    method: &'static str,
    path: String,
    body: Option<Value>,
) -> Result<Value, Refusal> {
    let answer = called(method, path, body).await;
    noted(what, outcome(&answer));
    answer
}

#[tauri::command]
async fn setup() -> Result<Value, Refusal> {
    read("setup", "GET", "/v1/setup".into(), None).await
}

/// A switch the person sets, each time in the log with its part and which way, as it is the
/// person's own act.
#[tauri::command]
async fn set_switch(capability: String, on: bool) -> Result<Value, Refusal> {
    let path = format!("/v1/setup/{}", part(&capability)?);
    let answer = called("PUT", path, Some(json!({ "on": on }))).await;
    let way = if on { "on" } else { "off" };
    log("window", &format!("set_switch {capability} {way}: {}", outcome(&answer)));
    answer
}

/// A need's own setup control, on the person's click, through the service: for a screen grant,
/// macOS's request and that grant's pane, but for the first request of one whose request may draw
/// macOS's alert. Then the provider is told to read the grants again, and soon after, as the person
/// may switch one there.
#[tauri::command]
async fn ask(capability: String, need: Option<String>) -> Result<Value, Refusal> {
    let path = format!("/v1/setup/{}/ask", part(&capability)?);
    let body = need.map_or(json!({}), |need| json!({ "need": need }));
    let answer = read("ask", "POST", path, Some(body)).await;
    if capability == "screen" && answer.is_ok() {
        provider::grants_changed();
    }
    answer
}

/// A grant's pane of System Settings, on the person's click, opened by the service. The provider
/// is told to read the grants again, and soon after, as the person may switch one there.
#[tauri::command]
async fn open_settings(need: String) -> Result<Value, Refusal> {
    let body = Some(json!({ "need": need }));
    let answer = read("open_settings", "POST", "/v1/setup/screen/settings".into(), body).await;
    if answer.is_ok() {
        provider::grants_changed();
    }
    answer
}

/// Login Items in System Settings, on the person's click, where they allow the background item.
#[tauri::command]
fn open_login_items() {
    macos::open_login_items();
    noted("open_login_items", "asked".into());
}

#[tauri::command]
async fn connection() -> Result<Value, Refusal> {
    read("connection", "GET", "/v1/connection".into(), None).await
}

/// The computers this Mac is lent to now: those running, and those starting, as one being brought
/// back is still lent to its agent.
#[tauri::command]
async fn computers() -> Result<Value, Refusal> {
    let listed = read("computers", "GET", "/v1/computers".into(), None).await?;
    let lent = listed
        .as_array()
        .into_iter()
        .flatten()
        .filter(|one| one["state"] == "running" || one["state"] == "starting");
    Ok(Value::Array(lent.cloned().collect()))
}

#[tauri::command]
async fn acting() -> Result<Value, Refusal> {
    read("acting", "GET", "/v1/acting".into(), None).await
}

/// Whether the service has answered since the app opened.
static ANSWERED: AtomicBool = AtomicBool::new(false);

/// The provider's state while one runs. Without one: turned off where macOS doesn't allow the
/// background item, and otherwise running while the service answers, starting until it first does,
/// and starting again once it has stopped answering.
#[tauri::command]
async fn app_state() -> &'static str {
    if let Some(state) = provider::state_now() {
        return state.name();
    }
    if macos::background_item_status() == Some(2) {
        return AppState::TurnedOff.name();
    }
    let state = match read("app_state", "GET", "/v1/connection".into(), None).await {
        Ok(_) => AppState::Running,
        Err(_) => without_provider(),
    };
    state.name()
}

/// With no provider and the service not answering: starting until it first answered, and starting
/// again once it has stopped.
fn without_provider() -> AppState {
    if ANSWERED.load(Ordering::Relaxed) {
        AppState::StartingAgain
    } else {
        AppState::Starting
    }
}

/// What the menu-bar item last read, kept as the window's page keeps its readings: a read that
/// fails leaves the last answer.
struct Read {
    short: Option<bool>,
    connected: bool,
    setup_at: Option<Instant>,
}

/// The menu-bar item's state now, from the reads the window makes: the app's state, the setup,
/// read every 5 s and not while starting again (as the page skips it then), and the connection.
/// Blocking, off the main thread.
fn dot_now(read: &mut Read, started: Instant) -> Dot {
    let connection = call("GET", "/v1/connection", None);
    if let Ok(said) = &connection {
        ANSWERED.store(true, Ordering::Relaxed);
        read.connected = said["connected"] == true;
    }
    let app = match provider::state_now() {
        Some(state) => state,
        None if macos::background_item_status() == Some(2) => AppState::TurnedOff,
        None if connection.is_ok() => AppState::Running,
        None => without_provider(),
    };
    let due = read.setup_at.is_none_or(|at| at.elapsed() >= Duration::from_secs(5));
    if connection.is_ok() && app != AppState::StartingAgain && due {
        if let Ok(said) = call("GET", "/v1/setup", None) {
            (read.short, read.setup_at) = (Some(menu_bar::short(&said)), Some(Instant::now()));
        }
    }
    menu_bar::dot(app, read.short, read.connected, started.elapsed() >= menu_bar::FIRST)
}

/// The window's height to the page's, its top edge where it is.
#[tauri::command]
fn fit(window: WebviewWindow, height: f64) -> Result<(), Refusal> {
    let top = window.outer_position()?;
    window.set_size(LogicalSize::new(WIDTH, height))?;
    window.set_position(top)?;
    noted("fit", format!("{height}"));
    Ok(())
}

/// What each call answered last, so that the log has a line only when that changes.
static LAST: Mutex<BTreeMap<&str, String>> = Mutex::new(BTreeMap::new());

fn noted(what: &'static str, outcome: String) {
    let mut last = LAST.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if last.get(what) != Some(&outcome) {
        log("window", &format!("{what}: {outcome}"));
        last.insert(what, outcome);
    }
}

/// The window, the label tauri.conf.json gives it.
const MAIN: &str = "main";

/// Shows the window, making it where it was closed, and the app with it: a regular app, with its
/// Dock icon and menu, in front.
fn show_window(app: &AppHandle) {
    // As every open of the app has: a background item not yet registered, or refused before, is
    // registered now.
    log("window", &macos::register_background_item());
    let _ = app.set_activation_policy(ActivationPolicy::Regular);
    let window = match app.get_webview_window(MAIN) {
        Some(window) => Some(window),
        None => {
            let config = app.config().app.windows.iter().find(|config| config.label == MAIN);
            let made = config.and_then(|config| {
                WebviewWindowBuilder::from_config(app, config).ok()?.visible(false).build().ok()
            });
            // The window is drawn dark, as v9 draws it, but only the window: the app's other
            // parts, its menu-bar item's menu among them, follow macOS's appearance.
            if let Some(ns_window) = made.as_ref().and_then(|window| window.ns_window().ok()) {
                macos::dark_window(ns_window);
            }
            made
        }
    };
    match window {
        Some(window) => {
            let _ = window.show();
            let _ = window.set_focus();
            log("window", "opened");
        }
        None => log("window", "couldn't be made"),
    }
}

/// The app's menu: Tauri's own, but for its Quit, which here closes the window as Cmd-Q always has,
/// and lending goes on. Stopping lending is the menu-bar item's own.
fn app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    if let Some(MenuItemKind::Submenu(own)) = menu.items()?.into_iter().next() {
        for item in own.items()? {
            if let MenuItemKind::Predefined(quit) = &item {
                if quit.text()?.starts_with("Quit") {
                    own.remove(quit)?;
                }
            }
        }
        let keys = Some("CmdOrCtrl+Q");
        let quit = MenuItem::with_id(app, "quit-window", "Quit AgentOrg", true, keys)?;
        own.append(&quit)?;
    }
    Ok(menu)
}

/// The app's window and its menu-bar item. The app is an agent (LSUIElement, in its Info.plist), so
/// that what else of it macOS opens has no Dock tile; with its window shown it is a regular app,
/// with its Dock icon and menu, and with the window closed an agent again, the item staying. Opened
/// by a person, it shows the window; started by the provider after a login (`with_window` false),
/// only the item. One runs at a time. Opening it registers the app's background item, and while it
/// runs, a change of the provider's state, or of whether macOS allows the background item, is sent
/// to the page as `changed`, and the item's dot and words follow the app's state.
pub fn window(with_window: bool) {
    let state = menu_bar::state();
    if let Some(pid) = menu_bar::running(&state).filter(|&pid| pid != std::process::id() as i32) {
        return log("menu bar", &format!("already held by process {pid}"));
    }
    menu_bar::say_running(&state);
    log("window", if with_window { "started" } else { "started for the menu bar item alone" });
    let built = tauri::Builder::default()
        // Started for the item alone, it takes no one's focus as it starts.
        .activate_ignoring_other_apps(with_window)
        .menu(app_menu)
        .invoke_handler(tauri::generate_handler![
            setup,
            set_switch,
            ask,
            open_settings,
            open_login_items,
            connection,
            computers,
            acting,
            app_state,
            fit
        ])
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_window(app),
            "quit-window" => {
                if let Some(window) = app.get_webview_window(MAIN) {
                    let _ = window.close();
                }
            }
            "quit-lending" => {
                let state = menu_bar::state();
                let unregister = macos::unregister_background_item;
                let restore = || macos::driver_restores_windows(true);
                if menu_bar::quit_lending(unregister, restore, &state) {
                    app.exit(0);
                }
            }
            _ => {}
        })
        .setup(move |app| {
            let handle = app.handle().clone();
            let none = None::<&str>;
            let heading = MenuItem::with_id(app, "heading", "AgentOrg", false, none)?;
            let status = MenuItem::with_id(app, "status", Dot::Waiting.words(), false, none)?;
            let open = MenuItem::with_id(app, "open", "Open AgentOrg", true, none)?;
            let quit_words = "Quit AgentOrg (stops lending)";
            let quit = MenuItem::with_id(app, "quit-lending", quit_words, true, none)?;
            let menu = Menu::with_items(
                app,
                &[
                    &heading,
                    &status,
                    &PredefinedMenuItem::separator(app)?,
                    &open,
                    &PredefinedMenuItem::separator(app)?,
                    &quit,
                ],
            )?;
            let (width, height) = (menu_bar::WIDTH, menu_bar::HEIGHT);
            let picture = move |dot: Dot, dark: bool| {
                Image::new_owned(menu_bar::icon(dot, dark), width, height)
            };
            let tray = TrayIconBuilder::with_id("menu-bar")
                .icon(picture(Dot::Waiting, macos::dark_appearance()))
                .icon_as_template(false)
                .menu(&menu)
                .show_menu_on_left_click(true)
                .build(app)?;
            // Named, as the draft's button is: its picture alone says nothing to VoiceOver or to
            // the accessibility tree.
            let _ = tray.with_inner_tray_icon(|inner| {
                if let Some(item) = inner.ns_status_item() {
                    macos::name_status_item(&item, "AgentOrg");
                }
            });
            if with_window {
                show_window(&handle);
            }
            let started = Instant::now();
            thread::spawn(move || {
                let state = || (provider::state_now(), macos::background_item_status());
                let mut said = state();
                let mut read = Read { short: None, connected: false, setup_at: None };
                let mut shown = None;
                // Light or dark as the menu bar itself is drawn, read on the main thread from the
                // item; macOS's own appearance where it can't be.
                let menu_bar_dark = |tray: &tauri::tray::TrayIcon| {
                    let item = tray.with_inner_tray_icon(|inner| {
                        inner.ns_status_item().and_then(|item| macos::status_item_dark(&item))
                    });
                    item.ok().flatten().unwrap_or_else(macos::dark_appearance)
                };
                loop {
                    let now = state();
                    if now != said {
                        said = now;
                        let _ = handle.emit("changed", ());
                    }
                    let dot = dot_now(&mut read, started);
                    let dark = menu_bar_dark(&tray);
                    if shown != Some((dot, dark)) {
                        let _ = tray.set_icon(Some(picture(dot, dark)));
                        let _ = status.set_text(dot.words());
                        if shown.is_none_or(|(was, _)| was != dot) {
                            noted("menu bar", dot.words().into());
                        }
                        shown = Some((dot, dark));
                    }
                    thread::sleep(Duration::from_secs(1));
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!());
    let mut app = match built {
        Ok(app) => app,
        Err(error) => {
            menu_bar::say_gone(&state);
            return log("window", &format!("couldn't start: {error}"));
        }
    };
    // Started for the item alone, an agent from its launch: no Dock icon or menu shows as it
    // starts. Set before it runs, so that it holds from the start.
    if !with_window {
        app.set_activation_policy(ActivationPolicy::Accessory);
    }
    app.run(move |app, event| match event {
        // The window closed: the app turns back into an agent, and the item stays.
        RunEvent::WindowEvent { label, event: WindowEvent::Destroyed, .. } if label == MAIN => {
            let _ = app.set_activation_policy(ActivationPolicy::Accessory);
            log("window", "closed; the menu bar item stays");
        }
        // Closing the last window ends nothing: only the item's Quit does.
        RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
        // Opening the app while it runs, from Finder or the Dock: the window.
        RunEvent::Reopen { has_visible_windows: false, .. } => show_window(app),
        RunEvent::Exit => menu_bar::say_gone(&menu_bar::state()),
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::thread::{self, JoinHandle};

    /// A stand-in for the service on loopback: it answers one request, and hands back what it
    /// was sent.
    fn service_answering(status: &'static str, body: &'static str) -> (String, JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let heard = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut head = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
                head.push_str(&line);
            }
            let length = head
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase().strip_prefix("content-length: ")?.trim().parse().ok()
                })
                .unwrap_or(0);
            let mut sent = vec![0; length];
            reader.read_exact(&mut sent).unwrap();
            write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            head + &String::from_utf8(sent).unwrap()
        });
        (url, heard)
    }

    #[test]
    fn the_commands_read_the_service_from_its_record_with_its_token() {
        // The only test that reaches the record, found through HOME, so its steps go in order.
        crate::test_home();
        let _ = fs::remove_dir_all(data());
        use tauri::async_runtime::block_on as run;

        // No record: no service to answer, and the app is starting.
        let refused = run(setup()).unwrap_err();
        let said = (refused.code, refused.message.as_str());
        assert_eq!(said, (503, "AgentOrg's service isn't running."));
        assert_eq!(run(app_state()), "starting");

        // The record's address, with its control token, which the page never sees.
        let record = |url: &str| {
            fs::create_dir_all(data()).unwrap();
            let kept = json!({ "url": url, "pid": 1 }).to_string();
            fs::write(data().join("server.json"), kept).unwrap();
            fs::write(data().join("control-token"), "the-token\n").unwrap();
        };
        let (url, heard) = service_answering("200 OK", r#"{"capabilities":[]}"#);
        record(&url);
        assert_eq!(run(setup()).ok(), Some(json!({ "capabilities": [] })));
        let sent = heard.join().unwrap();
        assert!(sent.starts_with("GET /v1/setup HTTP/1.1\r\n"), "{sent}");
        let token = "authorization: bearer the-token\r\n";
        assert!(sent.to_ascii_lowercase().contains(token), "{sent}");

        // A refusal comes back with the service's own words.
        let words = "Chrome isn't installed on this machine.";
        let (url, heard) = service_answering(
            "409 Conflict",
            r#"{"code":409,"message":"Chrome isn't installed on this machine."}"#,
        );
        record(&url);
        let refused = run(ask("browser".into(), Some("chrome".into()))).unwrap_err();
        assert_eq!((refused.code, refused.message.as_str()), (409, words));
        let sent = heard.join().unwrap();
        assert!(sent.starts_with("POST /v1/setup/browser/ask HTTP/1.1\r\n"), "{sent}");
        assert!(sent.ends_with(r#"{"need":"chrome"}"#), "{sent}");

        // Asking with no need names none; a switch is its own.
        for (step, first, last) in [
            (0, "POST /v1/setup/screen/ask HTTP/1.1\r\n", "{}"),
            (1, "PUT /v1/setup/terminal HTTP/1.1\r\n", r#"{"on":true}"#),
        ] {
            let (url, heard) = service_answering("200 OK", "{}");
            record(&url);
            let answered = match step {
                0 => run(ask("screen".into(), None)),
                _ => run(set_switch("terminal".into(), true)),
            };
            assert!(answered.is_ok());
            let sent = heard.join().unwrap();
            assert!(sent.starts_with(first) && sent.ends_with(last), "{sent}");
        }

        // The computers lent to now: those running, and those starting.
        let (url, heard) = service_answering(
            "200 OK",
            r#"[{"name":"Research","state":"running"},{"name":"Inbox","state":"starting"},
                {"name":"Old","state":"stopped"},{"name":"Broke","state":"failed"}]"#,
        );
        record(&url);
        let lent = run(computers()).unwrap();
        let names: Vec<&Value> = lent.as_array().unwrap().iter().map(|one| &one["name"]).collect();
        assert_eq!(names, [&json!("Research"), &json!("Inbox")]);
        assert!(heard.join().unwrap().starts_with("GET /v1/computers HTTP/1.1\r\n"));

        // A record naming an address off this Mac is no service: the token isn't sent there.
        record("http://192.0.2.1:7878");
        assert_eq!(run(setup()).unwrap_err().code, 503);

        // Each switch set is in the log, with its part and which way, the same way twice too: it
        // is the person's own act. One refused says why.
        let lines = || fs::read_to_string(crate::places::logs().join("AgentOrg.log"));
        let before = lines().unwrap_or_default().lines().count();
        for (on, status, body) in [
            (false, "200 OK", "{}"),
            (true, "200 OK", "{}"),
            (true, "200 OK", "{}"),
            (false, "409 Conflict", r#"{"code":409,"message":"The screen isn't ready."}"#),
        ] {
            let (url, heard) = service_answering(status, body);
            record(&url);
            let _ = run(set_switch("screen".into(), on));
            heard.join().unwrap();
        }
        let said: Vec<String> = lines()
            .unwrap()
            .lines()
            .skip(before)
            .filter_map(|line| line.split_once(" window: ").map(|(_, words)| words.to_owned()))
            .filter(|words| words.starts_with("set_switch "))
            .collect();
        assert_eq!(
            said,
            [
                "set_switch screen off: answered",
                "set_switch screen on: answered",
                "set_switch screen on: answered",
                "set_switch screen off: 409 The screen isn't ready.",
            ]
        );

        // A part that isn't one is refused before anything is sent.
        assert_eq!(run(set_switch("../computers".into(), true)).unwrap_err().code, 400);

        // A record left by a service that has stopped, on this Mac: no service to answer, and the
        // app, which has had answers, is starting again.
        let gone = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap();
        record(&format!("http://{gone}"));
        assert_eq!(run(acting()).unwrap_err().code, 503);
        assert_eq!(run(app_state()), "starting again");

        let _ = fs::remove_dir_all(data());
    }

    #[test]
    fn the_token_goes_only_to_this_mac() {
        for here_ in ["http://127.0.0.1:7878", "http://localhost:7878", "http://[::1]:7878"] {
            assert!(here(here_), "{here_}");
        }
        for elsewhere in [
            "http://192.0.2.1:7878",
            "https://127.0.0.1:7878",
            "http://localhost.example.com:7878",
            "http://127.0.0.1@example.com/",
            "http://127.0.0.1:7878@example.com/",
            "http://localhost:1@example.com:7878",
            "http://example.com/127.0.0.1:7878",
            "",
        ] {
            assert!(!here(elsewhere), "{elsewhere}");
        }
    }

    #[test]
    fn a_part_is_a_word() {
        assert_eq!(part("screen").ok(), Some("screen"));
        for refused in ["", "../computers", "screen/ask", "Screen"] {
            assert_eq!(part(refused).unwrap_err().code, 400, "{refused}");
        }
    }
}
