# @agentorg/mac

The AgentOrg Mac app, `AgentOrg.app`, built with Tauri: its window, showing the page from [`@agentorg/mac-window`](../mac-window), built in, and the commands that page's seam calls.

Its identifier, `dev.agentorg.mac`, is provisional until the app has its signing identity.

## The seam

The page calls the app's commands through what Tauri gives it (`withGlobalTauri`), in [`../mac-window/src/tauri.ts`](../mac-window/src/tauri.ts). Each command reads the service on this Mac from the record the service leaves while it runs, in its data folder, `~/Library/Application Support/AgentOrg/computer`. Its address is in `server.json`, and its control token in `control-token`. The token stays in the app; the page never sees it.

| Command                       | What it answers                                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `setup`                       | the service's `GET /v1/setup`                                                                                           |
| `set_switch {capability, on}` | `PUT /v1/setup/{capability}`                                                                                            |
| `ask {capability, need?}`     | `POST /v1/setup/{capability}/ask`                                                                                       |
| `connection`                  | `GET /v1/connection`                                                                                                    |
| `computers`                   | `GET /v1/computers?state=running`                                                                                       |
| `acting`                      | `GET /v1/acting`                                                                                                        |
| `app_state`                   | `running` while the service answers, `starting` until it first does, and `starting again` once it has stopped answering |
| `fit {height}`                | sets the window's height to the page's, its top edge where it is, 460 wide                                              |

A refusal rejects with `{ code, message }`: the service's own where it gives its words, as its 409s do; 503 while there is no service to answer; 400 for a capability that isn't a single lowercase word, so the page reaches no other endpoint with the token.

The page listens for the app's `changed` event. Nothing sends it yet; the page reads every 2 s anyway.

## Opened with no service

With no record in the data folder, or one left by a service that has stopped, the app is `starting`, and the service's parts reject with 503. The page shows its title bar, then "Starting again". The app writes nothing in the service's data folder, and starts nothing.

What it does write:

- **Its log,** `~/Library/Logs/AgentOrg/AgentOrg.log`: a line when it opens, then a line each time a command goes from answered to refused or back, or from one refusal to another, and each time the window's height changes, each with its time. At 10 MB it moves to `AgentOrg.1.log`.
- **What macOS and WebKit keep for any app,** under its identifier, `dev.agentorg.mac`, in the user's Library: the page's own storage among them, where it keeps the grants it last saw, to tell a grant taken away from one never given.

## Building it

It needs Xcode and Rust. `npm run app --workspace @agentorg/mac` builds the page, then `src-tauri/target/release/bundle/macos/AgentOrg.app`, signed ad hoc. `npm run dev --workspace @agentorg/mac` runs it against the page's dev server. Cargo's downloads and build output can stay in this folder: set `CARGO_HOME` to `src-tauri/target/cargo-home`. Neither is checked in.

The app has no icon of its own yet. `src-tauri/icons/icon.png` is a transparent stand-in that Tauri needs to build, so the built app shows the Mac's generic app icon; under `npm run dev` its Dock icon is blank.

`cargo test` in `src-tauri` runs the app's own tests. CI runs on Linux and neither builds nor tests the app: this package has no `build` or `test` script for the workspace's scripts to run. The page's test of the commands it calls, in `@agentorg/mac-window`, runs there.
