//! The AgentOrg Mac app's window: the page in `packages/mac-window`, and the seam's commands it
//! calls. They read the service on this Mac from the record it leaves in its data folder, with its
//! control token, which the page never sees.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{LogicalSize, WebviewWindow};

/// The window's width, as the design draws it; its height fits the page.
const WIDTH: f64 = 460.0;

/// A refusal, as the page's seam rejects with it: the service's own `{ code, message }`, or 503
/// while there is no service to answer.
#[derive(Serialize)]
struct Refusal {
    code: u16,
    message: String,
}

impl From<tauri::Error> for Refusal {
    fn from(error: tauri::Error) -> Self {
        Refusal { code: 500, message: error.to_string() }
    }
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
}

/// Where the service keeps its data, with the record it leaves while it runs and its control
/// token: the folder agreed with AgentOrg's core.
fn data() -> PathBuf {
    home().join("Library/Application Support/AgentOrg/computer")
}

/// The service's address and control token. Nothing is written here: with no record, or one it
/// left when it stopped, there is no service to answer.
fn service() -> Result<(String, String), Refusal> {
    let none = || Refusal { code: 503, message: "AgentOrg's service isn't running.".into() };
    let record: Value =
        serde_json::from_slice(&fs::read(data().join("server.json")).map_err(|_| none())?)
            .map_err(|_| none())?;
    let url = record["url"].as_str().ok_or_else(none)?.to_owned();
    let token = fs::read_to_string(data().join("control-token")).map_err(|_| none())?;
    Ok((url, token.trim().to_owned()))
}

/// One call to the service, answered with its JSON, or refused with its words.
fn call(method: &str, path: &str, body: Option<Value>) -> Result<Value, Refusal> {
    let (url, token) = service()?;
    let request = ureq::request(method, &format!("{url}{path}"))
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
        Err(_) => Err(Refusal { code: 503, message: "AgentOrg's service isn't running.".into() }),
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

#[tauri::command]
async fn computers() -> Result<Value, Refusal> {
    read("computers", "GET", "/v1/computers?state=running".into(), None).await
}

#[tauri::command]
async fn acting() -> Result<Value, Refusal> {
    read("acting", "GET", "/v1/acting".into(), None).await
}

/// Whether the service has answered since the app opened.
static ANSWERED: AtomicBool = AtomicBool::new(false);

/// Running while the service answers; starting until it first does, and starting again once it
/// has stopped answering.
#[tauri::command]
async fn app_state() -> &'static str {
    match read("app_state", "GET", "/v1/connection".into(), None).await {
        Ok(_) => "running",
        Err(_) if ANSWERED.load(Ordering::Relaxed) => "starting again",
        Err(_) => "starting",
    }
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
        log(&format!("{what}: {outcome}"));
        last.insert(what, outcome);
    }
}

/// The app's log, `~/Library/Logs/AgentOrg/AgentOrg.log`, each line with its time. At 10 MB it
/// moves to `AgentOrg.1.log`, replacing the one before.
fn log(line: &str) {
    let folder = home().join("Library/Logs/AgentOrg");
    let file = folder.join("AgentOrg.log");
    let _ = fs::create_dir_all(&folder);
    if fs::metadata(&file).is_ok_and(|kept| kept.len() >= 10 << 20) {
        let _ = fs::rename(&file, folder.join("AgentOrg.1.log"));
    }
    if let Ok(mut out) = fs::OpenOptions::new().create(true).append(true).open(&file) {
        let _ = writeln!(out, "{} window: {line}", now());
    }
}

fn now() -> String {
    stamp(SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_secs()))
}

/// A time in seconds since 1970, in UTC, as 2026-11-14T09:30:00Z.
fn stamp(secs: u64) -> String {
    // The civil date from a count of days: the civil-from-days algorithm.
    let days = (secs / 86_400) as i64 + 719_468;
    let era = days.div_euclid(146_097);
    let of_era = days - era * 146_097;
    let year_of_era = (of_era - of_era / 1_460 + of_era / 36_524 - of_era / 146_096) / 365;
    let of_year = of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let shifted = (5 * of_year + 2) / 153;
    let day = of_year - (153 * shifted + 2) / 5 + 1;
    let month = if shifted < 10 { shifted + 3 } else { shifted - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    let rest = secs % 86_400;
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3_600,
        rest / 60 % 60,
        rest % 60
    )
}

fn main() {
    log("opened");
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            setup, set_switch, ask, connection, computers, acting, app_state, fit
        ])
        .run(tauri::generate_context!())
        .expect("AgentOrg's window couldn't start");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read};
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
        let home = std::env::temp_dir().join(format!("agentorg-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        std::env::set_var("HOME", &home);
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

        // Asking with no need names none; the computers are those running; a switch is its own.
        for (step, first, last) in [
            (0, "POST /v1/setup/screen/ask HTTP/1.1\r\n", "{}"),
            (1, "GET /v1/computers?state=running HTTP/1.1\r\n", ""),
            (2, "PUT /v1/setup/terminal HTTP/1.1\r\n", r#"{"on":true}"#),
        ] {
            let (url, heard) = service_answering("200 OK", "{}");
            record(&url);
            let answered = match step {
                0 => run(ask("screen".into(), None)),
                1 => run(computers()),
                _ => run(set_switch("terminal".into(), true)),
            };
            assert!(answered.is_ok());
            let sent = heard.join().unwrap();
            assert!(sent.starts_with(first) && sent.ends_with(last), "{sent}");
        }

        // A part that isn't one is refused before anything is sent.
        assert_eq!(run(set_switch("../computers".into(), true)).unwrap_err().code, 400);

        // A record left by a service that has stopped: no service to answer, and the app, which
        // has had answers, is starting again.
        assert_eq!(run(acting()).unwrap_err().code, 503);
        assert_eq!(run(app_state()), "starting again");

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn a_part_is_a_word() {
        assert_eq!(part("screen").ok(), Some("screen"));
        for refused in ["", "../computers", "screen/ask", "Screen"] {
            assert_eq!(part(refused).unwrap_err().code, 400, "{refused}");
        }
    }

    #[test]
    fn times_are_stamped_in_utc() {
        assert_eq!(stamp(0), "1970-01-01T00:00:00Z");
        assert_eq!(stamp(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(stamp(1_763_112_600), "2025-11-14T09:30:00Z");
    }
}
