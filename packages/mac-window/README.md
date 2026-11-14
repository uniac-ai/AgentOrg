# @agentorg/mac-window

The AgentOrg Mac app's window: whether AgentOrg has connected, and "Agent Control", a card for each part of this Mac an agent can use (Terminal, Files, Screen, Your browser), each with the person's switch. It is drawn to the design, dark only, in the client's colours.

`npm run build` makes it a folder of static files in `dist`: `index.html`, `app.js` and `app.css`. The app builds that folder into its window (`frontendDist`). `npm run dev` rebuilds on each change and serves it at `http://localhost:5180/`, for the app's dev mode (`devUrl`).

## The seam

The page knows the app only through one interface, `Mac` in [src/mac.ts](src/mac.ts). The app holds the service's control token, so the page never sees it.

| The page calls              | What the app answers from                                                                                  |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `setup()`                   | the service's `GET /v1/setup`                                                                              |
| `setSwitch(capability, on)` | `PUT /v1/setup/{capability}`; a 409 rejects with its `{ code, message }`, which the card shows as its line |
| `ask(capability, need?)`    | `POST /v1/setup/{capability}/ask`; a 409 the same way                                                      |
| `connection()`              | `GET /v1/connection`                                                                                       |
| `computers()`               | `GET /v1/computers`, those running or starting: each one's `name`, and `metadata.agent`, the agent's id    |
| `acting()`                  | `GET /v1/acting`                                                                                           |
| `appState()`                | the app itself: `starting`, `running` or `starting again`                                                  |
| `onChanged(listener)`       | the app's event when its state changes                                                                     |
| `fit(height)`               | the app sets the window's height to the page's, as the design's window fits its content                    |

The page reads every part every 2 seconds while the window shows, at once on focus, and at once when the app says something changed. What doesn't answer keeps its last reading, and while the app starts the driver again, the cards keep theirs. Until the first reading, the window shows only its title bar; with none after 5 seconds, it shows "Starting again", with the cards greyed.

The page draws its own header, "AgentOrg", under macOS's window buttons, and the window is dragged by it (`data-tauri-drag-region`).

The app's implementation, Tauri commands, takes the stand-in's place on one line in [src/main.tsx](src/main.tsx).

## In a browser

Outside the app, the page runs on a stand-in, [src/stand-in.ts](src/stand-in.ts), which answers in the service's shapes with one canned state of the design each, chosen by `?state=`:

`first-open` (the default), `all-on`, `screen-needs-more`, `browser-needs-more`, `no-browser-installed`, `connected`, `connected-acting`, `permission-withdrawn`, `starting`, `starting-again`.

Asking acts as if the person allowed it: a moment later the need reads granted or on, and after a grant the app starts the driver again for a moment.

`npm test` runs its tests in a browser against the stand-in.
