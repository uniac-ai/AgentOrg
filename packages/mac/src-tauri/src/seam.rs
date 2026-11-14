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
use crate::places::data;
use crate::provider::AppState;
use crate::{macos, provider};
use tauri::{Emitter, LogicalSize, WebviewWindow};
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

/// A call off the window's thread, its answer noted in the log when it changes.
async fn read(
    what: &'static str,
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
    noted(
        what,
        match &answer {
            Ok(_) => "answered".into(),
            Err(refusal) => format!("{} {}", refusal.code, refusal.message),
        },
    );
    answer
}

#[tauri::command]
async fn setup() -> Result<Value, Refusal> {
    read("setup", "GET", "/v1/setup".into(), None).await
}

#[tauri::command]
async fn set_switch(capability: String, on: bool) -> Result<Value, Refusal> {
    let path = format!("/v1/setup/{}", part(&capability)?);
    read("set_switch", "PUT", path, Some(json!({ "on": on }))).await
}

#[tauri::command]
async fn ask(capability: String, need: Option<String>) -> Result<Value, Refusal> {
    let path = format!("/v1/setup/{}/ask", part(&capability)?);
    let body = need.map_or(json!({}), |need| json!({ "need": need }));
    read("ask", "POST", path, Some(body)).await
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

/// The provider's state while one runs. Without one: running while the service answers, starting
/// until it first does, and starting again once it has stopped answering.
#[tauri::command]
async fn app_state() -> &'static str {
    if let Some(state) = provider::state_now() {
        return state.name();
    }
    let state = match read("app_state", "GET", "/v1/connection".into(), None).await {
        Ok(_) => AppState::Running,
        Err(_) if ANSWERED.load(Ordering::Relaxed) => AppState::StartingAgain,
        Err(_) => AppState::Starting,
    };
    state.name()
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

/// The window. Opening it registers the app's background item, and while it shows, a change of
/// the provider's state is sent to the page as `changed`.
pub fn window() {
    log("window", "opened");
    log("window", &macos::register_background_item());
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            setup, set_switch, ask, connection, computers, acting, app_state, fit
        ])
        .setup(|app| {
            let app = app.handle().clone();
            thread::spawn(move || {
                let mut said = provider::state_now();
                loop {
                    thread::sleep(Duration::from_secs(1));
                    let now = provider::state_now();
                    if now != said {
                        said = now;
                        let _ = app.emit("changed", ());
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("AgentOrg's window couldn't start");
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
