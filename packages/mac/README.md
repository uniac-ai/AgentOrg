# @agentorg/mac

The AgentOrg Mac app, `AgentOrg.app`, built with Tauri. Its one program runs four ways:

- **The window and the menu-bar item,** as a person opens the app: the page from [`@agentorg/mac-window`](../mac-window), built in, and the commands that page's seam calls. After a login the provider starts it with the item alone (`menu-bar`).
- **The provider** (`--provider`), as macOS starts the app's background item: it runs Cua Driver and the service, and starts either one again when it ends.
- **A grant** (`grant <need>...`), as the service opens the app to ask for the screen's grants, so that what macOS asks names AgentOrg.
- **Unregister** (`unregister`), as a person removing the app runs it: see [Removing it](#removing-it).

Its identifier, `dev.agentorg.mac`, is provisional until the app has its signing identity.

## The window

The page calls the app's commands through what Tauri gives it (`withGlobalTauri`), in [`../mac-window/src/tauri.ts`](../mac-window/src/tauri.ts). Each command reads the service on this Mac from the record the service leaves while it runs, in its data folder, `~/Library/Application Support/AgentOrg/computer`. Its address is in `server.json`, and its control token in `control-token`. The token stays in the app; the page never sees it.

| Command                       | What it answers                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------- |
| `setup`                       | the service's `GET /v1/setup`                                                           |
| `set_switch {capability, on}` | `PUT /v1/setup/{capability}`                                                            |
| `ask {capability, need?}`     | `POST /v1/setup/{capability}/ask`: a need's setup, on the person's click                |
| `open_settings {need}`        | `POST /v1/setup/screen/settings`: that grant's pane; the window's rows use `ask` now    |
| `open_login_items`            | opens Login Items in System Settings, on the person's click                             |
| `connection`                  | `GET /v1/connection`                                                                    |
| `computers`                   | `GET /v1/computers`, those running or starting, as one being brought back is still lent |
| `acting`                      | `GET /v1/acting`                                                                        |
| `app_state`                   | the provider's state while one runs; without one, as below                              |
| `fit {height}`                | sets the window's height to the page's, its top edge where it is, 460 wide              |

- **The app's state** is `starting` until the service is first up, `running` while it is, and `starting again` while the provider brings the driver or the service back. With no provider, it is `turned off` while macOS doesn't allow the background item: switched off in Login Items, or not allowed yet. The provider counts the service up once its record names it, which is what the window and AgentOrg's core read. Without a provider, the window counts the service up while it answers, and `starting again` once it has stopped answering.
- **`changed`** is sent to the page when the provider's state changes, or whether macOS allows the background item; the window looks each second.
- **A refusal** rejects with `{ code, message }`: the service's own where it gives its words, as its 409s do; 503 while there is no service to answer; 400 for a capability that isn't a single lowercase word.
- **The token goes only to this Mac.** The whole request's address is read with the parser the request itself uses, and must be plain http, with no user information, and a host of 127.0.0.1, ::1 or localhost. A record naming any other is no service.

**The app is an agent, and its window a regular app.** The app's Info.plist (`src-tauri/Info.plist`, which Tauri merges) sets `LSUIElement`, so that what else of it macOS opens has no Dock tile: the copy that asks for a grant would otherwise bounce in the Dock while it waits. While its window shows, the window's process is a regular app: its Dock icon and its menu appear, and it comes to the front. Cmd-Q, the app menu's "Quit AgentOrg", or closing the window closes the window: the Dock icon goes, the process stays as an agent with the menu-bar item, and the provider runs on, lending. Opening AgentOrg again, from Finder or the Dock, or the item's "Open AgentOrg", opens the window. One such process runs at a time: it names itself in `~/Library/Application Support/AgentOrg/menu-bar.json`.

**The menu-bar item** is the draft's: a monitor glyph with a dot, and a menu with the heading "AgentOrg", a status line, "Open AgentOrg" and "Quit AgentOrg (stops lending)". The menu is macOS's own, so the heading is greyed as the status line is.

| Dot                                 | Status line, first match winning                                                                                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| amber                               | "Starting again", also when the first reading is 5 s late, as the window says; "Not allowed in the background"; "Something to set up", where Screen or Your browser is on and not ready |
| green                               | "Connected to AgentOrg"                                                                                                                                                                 |
| white, or black on a light menu bar | "Waiting for AgentOrg to connect", the first 5 s included                                                                                                                               |

- **Its reads** are the window's own, and kept as the page keeps them, a failed read leaving the last answer: the provider's state and whether macOS allows the background item, the service's `GET /v1/connection` each second, and its `GET /v1/setup` every 5 s, but not while starting again.
- **Its picture** is drawn in code, 36 pixels tall as the menu bar shows it, when the process starts and when the state or the menu bar's appearance changes. The glyph takes the menu bar's text colour, white at 90% or black at 85%, from the item's own appearance, which follows the menu bar and its wallpaper.
- **The window** is drawn dark, as the draft draws it, and only the window: the item's menu follows macOS's appearance.
- **"Quit AgentOrg (stops lending)"** unregisters the background item, as `unregister` does, and quits. macOS stops the provider, which stops the driver and the service, and nothing starts at the next login. Opening AgentOrg registers the item again. Where the item couldn't be unregistered, nothing changes and the item stays.
- **After a login,** macOS starts the provider, which starts the item's process with no window, taking no one's focus (`open -g -a AgentOrg.app --args menu-bar`), where none runs and macOS allows the background item. It looks every 2 s. While none comes up it starts one again after 10 s, then 30 s, up to 5 minutes, since asking the system again would bring one just starting forward with its window. One that was running and has gone, as at a logout or a Dock "Quit", which ends the whole process, is started again 10 s after it was last seen.

Opening the app, the window or the item's "Open AgentOrg", registers the background item unless it is already on or waiting for the person's approval, so that a person's choice in Login Items stands. Login Items then lists AgentOrg, and the log says where it stands. With no service, the window starts nothing and writes nothing in the service's folder; the page shows its title bar, then "Starting again", or "Not allowed in the background" while macOS doesn't allow the background item.

## The provider

The background item is `Contents/Library/LaunchAgents/dev.agentorg.mac.provider.plist`. macOS starts it at login and keeps it running. The provider runs what the bundle carries: Node beside its own program, in `Contents/MacOS`, and Cua Driver and the service among its resources, `Contents/Resources/cua-driver` and `Contents/Resources/agentcomputer`. The driver is kept out of `Contents/MacOS`: it draws windows, and macOS takes a program there that does for the app itself, so opening AgentOrg would only bring the driver forward. A build without them, such as `npm run dev`'s, logs what is missing and runs nothing.

- **Cua Driver,** embedded, as its embedding guide has a host run it: `cua-driver serve --embedded --no-automation-prompts --socket` on a socket in `~/Library/Application Support/AgentOrg/driver`. Its home is that folder, so what it keeps stays in the app's. Before starting it, the provider turns off AppKit's window restoration for it, `ApplePersistenceIgnoreState` in its defaults domain, `cua-driver`: restoring windows as it started, the driver reached a file macOS keeps for Full Disk Access, which listed AgentOrg there, off. That one default is the person's, in `~/Library/Preferences/cua-driver.plist`, outside the app's folders. It's told it is embedded and whose (`CUA_DRIVER_EMBEDDED`, `CUA_DRIVER_HOST_BUNDLE_ID`), and checks for no updates (`CUA_DRIVER_RS_UPDATE_CHECK=false`). It raises no Automation prompt: an action that needs an app's Automation consent, not yet given, is refused with `automation_consent_required`, naming the app. macOS lists an app under Automation only once it has asked, so there is no way yet to give that consent.
- **The service,** once the driver's socket is there: `node agentcomputer/dist/agentcomputer.js serve --lend --listen 127.0.0.1:0`, with its data folder, the driver and its socket.
- **Each gets a small environment,** never the app's own: `HOME`, `USER`, `LOGNAME`, `SHELL` (the account's login shell), `TMPDIR`, `LANG`, `PATH=/usr/bin:/bin:/usr/sbin:/sbin` and `DO_NOT_TRACK=1`.
- **One that ends** is started again: at once, then after 1, 2, 4, 8, 16 and 30 s while it keeps ending within a minute.
- **A grant's change** starts the driver again, since the driver reads its grants once. That ends the screen's connections of computers using it, as AgentComputer says. The provider reads both grants, by a fresh process of the app's own, when it starts the driver, when a grant step or the window's setup of a screen grant tells it to, and, while one is missing, 5 s later, the wait doubling to 5 minutes, as the person may switch one in System Settings at any time. Where they differ from what the driver read, it starts the driver again. A grant taken away needs no restart: the service reads the driver's grants afresh, and shows it.
- **Its state** is in `~/Library/Application Support/AgentOrg/provider.json`: its process, its state, and its two programs' processes. The window believes it only while that process is alive and runs the app's own program.
- **One at a time:** it holds `provider.lock` in the same folder while it runs, and another copy's provider waits for it.
- **The app's folder,** `~/Library/Application Support/AgentOrg`, is kept to its owner (0700), so that no other account can reach what is in it, the driver's socket among it.
- **What an earlier run left** is stopped when it starts: a process its state file or the service's record names, where that runs the app's own program.
- **Stopped,** it asks both to end at once, ends either after 25 s, and removes its state. The background item gives it 40 s.

## A grant

The service opens the app through the system, `open -n -g -a AgentOrg.app --args grant` and one grant: Screen Recording at the switch from macOS 26, where its request draws nothing and only lists the app in its pane, and either one when the person clicks its "Set up". It makes macOS's request for each named, Screen Recording's first, 1 s before Accessibility's: a Screen Recording request made while Accessibility's alert waits isn't listed until the alert is answered. Then it waits up to 3 minutes for the person. The app opens no pane of System Settings. On a click, after the request, the service opens the grant's pane, except at the first request it has made of one whose request may draw macOS's alert, whose own button opens it. macOS keeps each process's answer, so each grant is read by a fresh process of the app's own (`granted <need>`, which answers by its exit code). As each grant is given, or was already, it tells the provider at once, which reads the grants again.

## The log

`~/Library/Logs/AgentOrg/AgentOrg.log`, each line with its time and which of them wrote it:

- **The window:** when it starts, opens and closes, the background item's standing, each change of the menu-bar item's status line, and each time a command goes from answered to refused or back, or from one refusal to another, or the window's height changes.
- **The menu bar:** "Quit AgentOrg (stops lending)", and where the background item then stands; a second one started while one runs, and which process holds the item.
- **The provider:** each program it starts, stops, or finds ended, with that program's last lines and the wait before it starts again, and each change of its state.
- **A grant:** each grant asked for, and its answer.
- **Unregister:** where the background item then stands, or why it couldn't be unregistered.

Each line is one write, so they don't mix. At 10 MB the provider moves it to `AgentOrg.1.log`, replacing the one before. macOS and WebKit also keep what they keep for any app, under `dev.agentorg.mac`, in the person's Library. The page's own storage is among it: the page keeps there the grants it last saw, to tell a grant taken away from one never given.

## Removing it

1. "Quit AgentOrg (stops lending)" in the menu bar unregisters the background item and quits. Or, from a terminal, `AgentOrg.app/Contents/MacOS/AgentOrg unregister` takes the background item away, and ends the menu-bar item's process where one runs: macOS stops the provider, which stops the driver and the service. It exits 1 where it couldn't, saying why. Where it unregisters the item, it also removes the driver's default, `ApplePersistenceIgnoreState` in `~/Library/Preferences/cua-driver.plist`, and says so (by hand: `defaults delete cua-driver ApplePersistenceIgnoreState`). macOS may leave that file behind empty; it can be removed. It doesn't wait for the provider, which can take up to 40 s to stop: the provider's last line in the log is then "stopped".
2. `tccutil reset Accessibility dev.agentorg.mac` and `tccutil reset ScreenCapture dev.agentorg.mac` remove its grants, while the app still exists.
3. Remove `~/Library/Application Support/AgentOrg`, `~/Library/Logs/AgentOrg`, and what macOS and WebKit keep under `dev.agentorg.mac` in the person's Library (its WebKit, Caches, HTTPStorages and Saved Application State folders). `defaults delete dev.agentorg.mac` removes its preferences where there are any.
4. Before deleting the app, `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u` with its path makes Launch Services forget it.

Login Items may still list an "AgentOrg" entry, switched off. macOS offers no way to remove one alone.

## Building it

It needs Xcode and Rust. `npm run app --workspace @agentorg/mac` assembles what the app carries, builds the page, then builds `src-tauri/target/release/bundle/macos/AgentOrg.app`, signed ad hoc. `npm run dev --workspace @agentorg/mac` runs the window against the page's dev server, without the assembly. Cargo's downloads and build output can stay in this folder: set `CARGO_HOME` to `src-tauri/target/cargo-home`. Neither is checked in.

**The assembly,** `scripts/assemble.mjs`, makes `src-tauri/target/assembly/bundle`, which the bundle takes its files from (`bundle.macOS.files`). They aren't Tauri's sidecars, though `node` sits where sidecars do: Tauri copies sidecars when the Rust is compiled, so every `cargo build` and `cargo test` would need the fetched files. The bundle copies these as they are and signs none of them, so the assembly signs them.

- **Node** and **Cua Driver,** as [`assembly.json`](assembly.json) pins them: Node 24.22.1 for Apple silicon from nodejs.org, and Cua Driver 0.49.7's release from its GitHub, which is MIT. Never its AGPL perception extension.
  - Each is fetched into a new, empty folder of its own, in `src-tauri/target/assembly/downloads`.
  - Nothing of it is used until its sha256 matches the pin and the release's own sums, and, for the driver, GitHub's digest too, checked on every build, so a build needs the network. On a mismatch, the build stops, saying which.
  - Of each, only the files `assembly.json` names, by their path in the release, each a file of its own: `node` and its `LICENSE`; the bare `cua-driver`, its `LICENSE` and its `THIRD_PARTY_NOTICES.md`. Not the program inside its `CuaDriver.app`, whose entitlements are tied to its makers' Team ID, and which macOS refuses once it is signed as ours.
  - `fetched.json` beside them says what was fetched: each file's name, address, size and sha256.
- **The service,** `@agentorg/computer` at the version this package depends on, from the workspace's install, which its lockfile checked. Its `package.json`, `LICENSE`, `NOTICE`, `dist/agentcomputer.js` and `dist/THIRD_PARTY_LICENSES.txt`; its own `playwright-core`, whole; and `node-pty`'s `package.json`, `LICENSE`, `lib` and native files for Apple silicon. Each package must be the version the service names, or the build stops.
- **Signed:** `node`, `cua-driver` and `node-pty`'s two native files are marked executable where they are programs, and signed with the app's identity before the bundle around them. Their entitlements are those in `entitlements/`: for `node`, JIT and its own unsigned native code; for `cua-driver`, Apple Events only, which it needs to run a menu item through a background app's scripting interface once that app's Automation consent is given (see the provider). The driver's own signature also asks for `com.apple.security.device.screen-capture`, which isn't an entitlement macOS defines for the hardened runtime: Screen Recording is a grant. So it is left out. That identity is `APPLE_SIGNING_IDENTITY` where it's set, otherwise `tauri.conf.json`'s.
- **In the bundle:** `node` in `Contents/MacOS`, `cua-driver` in `Contents/Resources`. The service in `Contents/Resources/agentcomputer`, with its own licences (`LICENSE`, `NOTICE`, `dist/THIRD_PARTY_LICENSES.txt`). Node's and the driver's licences in `Contents/Resources/licenses`.

**The icon.** Its masters are in `src-tauri/icons`: `icon-1024.png`, the picture at 1024 px, with its margins and shadow, and `icon.svg`, the same icon as vectors. `icon.icns`, which the bundle carries, holds every size from 16 to 1024 px, each the picture scaled down, never redrawn: `sips -z <size> <size> icon-1024.png` for each of an iconset's files, then `iconutil -c icns`. `icon.png`, the picture at 128 px, is the PNG Tauri's build needs, embedded as the window's own icon, which macOS doesn't draw; under `npm run dev` the Dock icon comes from `icon.icns`. The SVG's surface comes from filters that renderers draw differently, so a size is made from it only where its rendering matches the picture.

`cargo test` in `src-tauri` runs the app's own tests: the provider is run there against stand-ins for the driver and the service. `npm test` runs the assembly's tests, over stand-ins for both releases and the workspace, with nothing fetched. CI runs on Linux: it runs the assembly's tests and the page's test of the commands it calls, in `@agentorg/mac-window`. It doesn't build the app or run `cargo test`, as this package has no `build` script.
