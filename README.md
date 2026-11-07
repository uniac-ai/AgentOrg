# agentorg-next

AgentOrg as a dynamic system: Actors and widgets are modules in content-addressed packages, connected through named, versioned interfaces. This repository holds the fresh core, starting with the SDK a package author writes against (`@agentorg/sdk`) and the standard interfaces (`@agentorg/interfaces`).

## Packages

- `@agentorg/sdk`: `defineInterface` (with `method` and `event`) for `rpc`, `stream` and `http` interfaces; `defineActor` for host modules and `defineWidget` for view modules, with typed slot and export handles; the errors `NotConnected`, `Refused` and `OutcomeUnknown`; and `createTestContext` (`@agentorg/sdk/testing`), which runs a module without a Hub. An `rpc` handler gets its input and `{ caller }`, the calling Actor as the Hub names it, and `emit(event, payload, { to })` sends an event only to the subscriptions of the Actor `to` names, so a provider serving several consumers keeps each one's events its own. In `createTestContext`, `call` takes the caller as a fourth argument (the module's own Actor by default) and `emitted` records each event's `to`. `@agentorg/sdk/client` connects a program outside the Hub as an Actor: `connect({hubUrl, actorId, credential, slots, exports})` gives the same handles as a module's context, on the same runtime, with slots bound as the Hub's notices say and `exports.add`/`withdraw()` over the channel; As in a module, implement in `start` (run before the channel opens) and use slots from `onBind`, which runs when a slot becomes usable: bound, or its provider back. `openChannel` is the wire layer beneath it, without local checks. `http` slots `fetch` and `http` exports `serve` over the Hub's stream (HTTP/1.1, one request per stream, `node:http` loaded only when used). The request line carries the consumer's absolute URL, so a handler's `request.url` is exactly the URL the consumer fetched, scheme included; a request line that isn't absolute, or whose host isn't the `Host` header's, is answered 400. A handler that throws `Refused`, `NotConnected` or `OutcomeUnknown` reaches the consumer's `fetch` as that same error (carried as a 502 with an `agentorg-error` header); any other throw is a plain 500 response. `@agentorg/sdk/host` runs a package Actor's host modules in one process, on the same runtime: `runHost({packageDir, actorId, channel, log})` imports each `host` module's bundle, runs every `start`, then says hello over the channel, with each module's slots and exports named `<module>.<name>`. The program the Hub runs is `@agentorg/sdk/host/runner.js`, one self-contained file: it takes `<packageDir> <actorId>`, uses fd 3 as the channel, writes `ctx.log` as JSON lines on stderr, and exits non-zero if a `start` throws or an exception goes uncaught. The SDK's errors keep their class and code between a package's bundle and the runner, though each carries its own copy of the SDK. It reads only itself and the package's folder, so it runs under Node's permission model with exactly those two paths allowed (as real paths: the allow list doesn't follow symlinks).
- `@agentorg/interfaces`: the standard interfaces `kv@1`, `ui.view@1`, `chat@1` (a conversation with an agent), `llm.session@1` (stateless model inference, with function tools), `account.login@1` (signing in to an outside account, driven by a person or a program), `http.egress@1` (HTTPS to the public internet), `storage.admin@1` (seeding a new Actor's empty stores), `layout@1` (the person's dashboard), `installer@1` (planning and installing a package) and `ui.shell@1` (what the shell offers a view in its frame: opening an https address and starting sign-in), and the Hub's management interfaces `hub.packages@1`, `hub.actors@1`, `hub.grants@1`, `hub.bindings@1`, `hub.exports@1` and `hub.audit@1`.
- `@agentorg/wire`: the channel: yamux streams, length-prefixed JSON frames, stream headers and transports.
- `installer`: a bundled host package that turns packages into working Actors, exporting `installer@1`. Bound to the Hub's management (`hub.packages`, `hub.actors`, `hub.grants`, `hub.exports` and `hub.bindings`, which makes it the person's delegated manager) and to `storage.admin@1`, it proposes and installs. `plan({package})` lists each slot the package doesn't wire itself, with the exports that could serve it now: exactly its interface and schema hash, on Actors that aren't stopped or closed. `install({package, name, connections, start?})` makes the Actor with exactly those connections, all or none. It grants nothing its caller couldn't: each connection's export side must be the caller's (the provider, bound to that export, or a manager), else the whole install is refused (`forbidden`, listing every such connection) and nothing is made. It seeds each store bound to `storage.kv` from the package's `seed` (an object of key to value per `module.slot`), starts the Actor if asked (a seed or start that fails closes it), and lists the slots left unbound and the seeds that couldn't land (`unseeded`). It never picks a connection itself. Bound to the person's `layout@1` too, it carries a system between homes as data: `exportSystem()` gives an `agentorg.system/1` composition (every package Actor that isn't closed, by a name of its own, with its package as `name@version#hash` and whether it runs; the connections among them and to the built-in Actors, as `{consumer, slot, provider, export}` by names; and the layout's placements), never credentials, tokens, stores or logs, and lists what it leaves out (external Actors and what connects to them). `importSystem({composition})` makes it again with the caller's authority (connecting the new Actors to each other takes a manager): it creates the Actors whose packages are here (a taken name gets a suffix), binds the connections, seeds, starts what ran and places the layout, all or nothing, and lists what it couldn't: a package that isn't here or is another version (whoever holds the composition's folder adds its archives first) and what depends on it, an Actor that needs a sign-in, a seed that can't land, and the placements unless the caller holds the person's layout. The exporting home's installer stays out: every home has its own. An import never grants management: a connection to `hub` or to `storage.admin` is recorded by an export but never made by an import, even a manager's (a composition may come from anyone); it comes back in `ungranted`, for the person to grant one by one.
- `@agentorg/hub`: the core. Its state, in `node:sqlite` in a private home: Actors, a verified package store (`hub.packages.add` takes an archive by path; `hub.packages.build` takes a package's source as data, `package.json` and files under `src/` up to 768 KiB, builds it as `agentorg build` does, but reading no tsconfig, in a scratch folder of the home that is always removed: its files import only `@agentorg/sdk`, `@agentorg/interfaces` and `zod` by name, nothing outside the package's folder, and nothing by a pattern; at most 16 modules, 16 MiB built and 60 s; one build per caller at a time; and it adds the result. Reading each module's definition runs the source's code, so the Hub runs it in the same OS sandbox as host processes, and where those can't start, `build` is refused `unsupported` with the same reason. A failed build is `Refused("build")` with the build's message, which names no path outside the package), what each Actor takes and offers, bindings, binding requests and an audit trail. A binding is the grant, and it needs both ends: the export side (the provider, an Actor already bound to that export, or a manager) and the slot side (the consumer itself, or a manager). Through `hub.grants@1`, a caller with both ends binds; one with a single end approves the other end's open request or asks that end's approvers; one with neither is refused. A decision goes to the request's approvers and its requester, which can also read its requests' outcomes with `mine`. A manager is any Actor bound to `hub.bindings@1`. `hub.actors.create` can bind the new Actor's slots at once, with the creator's export side. The router serves it over WebSocket (`listen`), one yamux channel per Actor: a client's first stream is `hello` with its credential, then every `call`, `subscribe`, `open` and `http` stream is resolved through its binding, validated against the interface's JSON Schemas in both directions (ajv, 2020-12, in a pool of worker threads, each check under a time budget, since schemas come from Actors), forwarded to the provider with the caller named, and audited. A provider accepts or refuses an `open` or `http` stream with one body before any raw bytes. An Actor offers and withdraws exports at run time on its own channel (`offer`, `withdraw`). An Actor learns which of its slots are bound from hello's result, then from a `slot` notice on each change. A pipe the Hub makes for a package Actor's process says hello as that Actor without a credential (the pipe is the proof) and declares nothing (the manifest does). Every `serve` stream names the caller and the caller's slot, so a provider can keep state per consumer slot. `hub.actors.start` runs a package Actor's host modules in their own process: `node` under its permission model (reading only the runner and the package's folder, no child processes or workers), with an empty environment, a 256 MB heap and the channel on fd 3, inside the OS sandbox (`sandbox-exec` on macOS, a user, network and PID namespace with `unshare` on Linux), so it has no network, no DNS and no other process to signal. The Actor is running once its process says hello, within 30 s. `stop` sends SIGTERM, then SIGKILL after 5 s. A process that exits otherwise has crashed: it is restarted after a backoff from 1 s doubling to 60 s (starting over after 10 minutes up), and `hub.actors.get` counts `restarts` and keeps the `lastExit`. Actors running when the Hub stopped are started again when it opens. Where the sandbox can't run (stock Ubuntu restricts unprivileged user namespaces), `start` is refused with `unsupported` and every package Actor's `host` says why and what to change; the Hub probes again at each start. `hub.actors.logs` reads an Actor's log lines: its `ctx.log` entries and anything else its process writes (stdout as `info`, stderr as `error`). For the person's shell, `Hub.viewCall` and `Hub.viewSubscribe` run a package Actor's view module's calls and events in the Hub's process, as that Actor, through `<module>.<slot>`; `hub.actors.get` lists a package Actor's `views`. `Hub.viewLog` writes a view module's log line to its Actor's log, marked with the module; the Hub bounds each line itself (a known level, 4 KiB of text, 16 fields of 1 KiB) and rotates each Actor's log once at 1 MiB. The built-in `storage` Actor exports `kv@1`: one store per consumer slot (keyed by the consumer and slot the router names), in `<home>/storage.db`; values up to 256 KiB and 64 MiB per Actor, past which `Refused("quota")`; stores outlive unbinding and go when their Actor is closed. Its `admin` export (`storage.admin@1`, bound only to the installer) seeds a new Actor's store from its package's `seed`: all entries or none, into an empty store only, within the same limits, and audited as `storage.seed` with the consumer, the slot and how many entries. The built-in `net` Actor exports `egress` (`http.egress@1`): a consumer's request, made from the Hub's process to the public internet over HTTPS only. Its host is resolved and every address checked (loopback, private, shared, link-local including the cloud metadata address, multicast, reserved and documentation ranges, and their IPv4-mapped forms are refused), and the connection goes to the checked address with the name for SNI and the certificate, so a second resolution can't move it. Plain `http:`, a refused address and a name that resolves to one throw `Refused("forbidden")` at the consumer's `fetch`; a host that can't be reached before anything is sent throws `Refused("unreachable")`, and a failure after, or 5 minutes without a byte, throws `OutcomeUnknown`. Redirects come back as they are. Each request's method, host and status are audited as `net`'s; paths, queries and bodies never are. The `hub` Actor's six exports are served through the same path.
- `@agentorg/app`: AgentOrg as one app. `agentorg` runs a Hub, the person's gateway and the shell on loopback; see "The app: the person's gateway".
- `chatgpt`: the model Actor, a package with one host module. It signs in with ChatGPT for the person's plan (`account.login@1`: OpenAI's OAuth for open-source apps, with dynamic registration, PKCE and a verified id_token; refresh tokens rotate, one refresh at a time) and serves `llm.session@1` on that plan through the Responses API, streamed and stored nowhere. Its whole network is its `web: http.egress@1` slot and its sign-in lives in its `store: kv@1` slot; the tokens never leave it except to that store: never in a reply, an event, a log or a refusal. It never uses an API key or API billing: a usage limit is refused `usage_limit`, with where to manage it. Its tests run against an in-process fake of OpenAI, so none reaches OpenAI.
- `assistant`: an agent, a package whose host module `logic` exports `chat@1` and runs the agent loop itself, with the model behind its `model: llm.session@1` slot. Its tools are its other bound slots (`layout`, `packages`, `actors`, `grants` and `exports`): each method becomes a function tool named `<slot>__<method>` with the method's input JSON Schema, so it can do exactly what it is connected to, and a call runs through the slot, checked and audited by the Hub. A turn makes at most 20 tool calls, and a function's output is cut at 16 KiB. Its chat is kept in its `store: kv@1` slot: each message once, its text and a call's arguments cut to fit a stored value, and the newest 2,000 messages (16 MiB) kept. The model is sent the newest whole exchanges that fit 400 KB of JSON (instructions and tool schemas aside), and always the latest one; if that alone is over, its oldest function outputs are left out, each call keeping an output. Its view module `chat` is the chat itself: the messages as they stream and a composer, with "Using ChatGPT plan" and "Manage usage" beside it, and the action each refusal calls for (Manage usage, Continue with ChatGPT, Retry), which it asks of the shell through its `shell: ui.shell@1` slot.

### Why `ui.view@1` is different

Every interface crosses the wire as schemas, and a module's handles are derived from them, with one exception. `ui.view@1` is a view module's render surface: the view draws into its own frame's DOM, which no message can carry. So its export handle is `implement({ mount(el, { theme, size }), resize?(size) })`, where `el` is the frame's root element, and the frame runtime maps the wire methods `mount`, `resize` and `unmount` onto it. Don't copy this shape for another interface; anything a module offers to others belongs in schemas.

### A view's frame

A shell runs each view module in its own sandboxed frame, with an opaque origin and no network. The frame holds only the SDK's frame runtime, `@agentorg/sdk/frame/runtime.js`, one self-contained script, and the view's bundle. The shell hands the frame one `MessagePort` (`openFrame`, then `new FrameHost(port, handlers)` from `@agentorg/sdk/frame/host`). Everything the view reaches crosses that port:

- **Load:** the shell names the view's bundle and which of its slots are bound. The frame imports it, runs `start` on the same runtime a host module uses, then binds the slots, so `onBind` runs for each one bound. A frame loads one view, only a `view` module, and takes one port, from its parent window only.
- **Slots:** a call or subscription on a slot goes to the shell, which runs it as the view's Actor; the shell says when a slot is bound, unbound or usable again. A view's `stream` and `http` slots aren't served yet.
- **`ui.view@1`:** the shell drives `mount`, `resize` and `unmount`. At mount, the theme's CSS variables (names starting `--`) are set on the frame's document.
- **`ui.shell@1`:** the shell's own interface, the mirror of `ui.view@1`. A view's slot of it is bound by the frame runtime itself, never by the Hub, so it is always bound. `openExternal({url})` takes only an `https:` URL, which the host checks; the shell's handler must open it in a new tab with no opener (`noopener`). `signIn()` starts the shell's own sign-in. Each method has one call in flight at a time. A frame can't open windows itself.
- **Logs:** the view's `ctx.log` and any error it doesn't catch go to the shell, for its Actor's log.

The frame isn't trusted: `FrameHost` checks every message, drops what doesn't fit, and refuses what it can't serve. A frame holds one subscription per slot and event, 64 at most, and 64 calls in flight, past which a call is refused `busy`; its log lines are cut, their fields rebuilt as a small fresh object, and past 50 lines in 10 s the rest are dropped.

## Building a package

A package's `package.json` names its modules, its own wiring and any seed state:

```json
"agentorg": {
  "modules": { "logic": "src/logic.ts", "panel": "src/panel.ts" },
  "connections": [["panel.board", "logic.board"]],
  "seed": { "logic.store": { "cards": [] } }
}
```

`seed` is optional initial state for state slots, keyed by `"module.slot"`; the build checks each slot exists. It is the only runtime state a package may carry.

`agentorg build [dir]` (from `@agentorg/sdk`; `buildPackage` in `@agentorg/sdk/build`) then:

- bundles each module, with every library it uses, into one ESM file, `dist/<module>.js`, with no imports at run time and no Node built-ins;
- reads each module's definition from its code and writes `agentorg.json`: each module's placement, slots and exports, every interface's JSON Schemas and hash, the package's `connections` and `seed`;
- hashes the tree, `agentorg.json` and `dist/`, as SHA-256 over the canonical list of each file's path and SHA-256, and archives it as `<hash>.agentorg`, a deterministic tar. The tree goes to `agentorg-build/package/` and the archive beside it.

A signature is detached: a file named `agentorg.sig` beside the package, signing the package hash, so it is never inside what it signs. The manifest has no signature field.

The build bundles; it doesn't type-check. Run `tsc --noEmit` on the package first.

`@agentorg/sdk/manifest` reads packages without esbuild, for a Hub or an installer: `verifyArchive(bytes, hash)` checks an archive holds exactly `agentorg.json` and each module's entry, hashes to the expected hash, and has a sound manifest (`checkManifest`: its shape, each interface's recorded hash against its schemas, and its connections). Problems are returned, not thrown.

The examples folder holds the spec's board package; its tests build it.

### Module top levels have no side effects

To read a module's definition, the build runs the module's code in a separate Node process (Node 22.15 or later) under the permission model: it can read only its own scratch folder, write nothing, and start no processes; Node built-ins can't be imported, and the network globals are gone. A definition that takes over 30 seconds to read is stopped. Widget bundles run there too, in Node, not a browser. So a module's top level must only define: no I/O, no timers that do work, no DOM globals such as `document` or `window`. Do that work in `start()`. A top level that tries fails the build with a message naming the module and what it touched.

### Errors

- `NotConnected`: the slot is unbound, or the export was withdrawn.
- `Refused` with code `invalid`: the caller's input broke the interface's schema. Nothing ran.
- `Refused` with code `bad_output`: the provider ran, and its reply or event broke the contract. The call may have had its effect; read state before retrying.
- `Refused` with code `unimplemented`: the export has no handler for that method yet.
- `OutcomeUnknown`: the channel dropped mid-call. Read state before retrying.

### The `agentorg` command

`@agentorg/app` provides `agentorg`.

- **`agentorg`**, with no command, runs AgentOrg: a Hub in its home, the person's gateway and the shell, on `127.0.0.1` (`--port N`, else any free port). It opens the browser already signed in, and prints only its address, never a sign-in code. `--no-open` doesn't open a browser. The code is in the address it hands the system's opener; on Linux, other local users can see that program's arguments for the moment it runs, and the code works for 60 s.
- **`agentorg open`** signs a browser in to the running app again.
- **`agentorg build [dir]`** builds a package, as the SDK's build does.
- **`agentorg hub [--port N]`** runs a bare Hub in its home, without the gateway or the shell, serving WebSocket on loopback, and writes the address to `<home>/url`.
- **The person's commands**, one per hub method:
  - `agentorg add <file.agentorg>`;
  - `agentorg actors|bindings|exports|audit`;
  - `agentorg bind <consumer.slot> <provider.export>`;
  - `agentorg call <slot> <method> [json]`.

  While the app runs, they go through it, with the CLI's token in `<home>/cli-token`. Otherwise they connect as the person with `<home>/person-credential`, and never take over a channel something else holds (hello's `replace: false`).
- **The home** is `--home`, else `$AGENTORG_HUB_HOME`, else `~/.local/share/agentorg-next`.
- **Output:** results are JSON on stdout. A refusal exits 1 with its reason on stderr, and a usage mistake exits 2.

`@agentorg/sdk`'s own bin is `agentorg-sdk`, with the same commands but no app.

### The command's name

`agentorg` is also the bin of the current `@agentorg/cli` package. With both installed, the one found first on `PATH` wins. The name will be settled before anything is published.

## Try it

From a clone, after `npm ci` and `npm run build`, with `agentorg` being `node packages/app/dist/src/cli.js`:

1. **Run the app:** `agentorg`. It prints its address and opens the shell in the browser, already signed in; `agentorg open` signs a browser in again.
2. **Add the board:** `agentorg build examples/board` prints its hash and writes `examples/board/agentorg-build/<hash>.agentorg`; then `agentorg add examples/board/agentorg-build/<hash>.agentorg`.
3. **Create it with its store, and start it:**

   ```sh
   agentorg call actors create '{"name":"Board","package":"<hash>","bindings":[{"slot":"logic.store","provider":"storage","export":"kv"}]}'
   agentorg call actors start '{"actorId":"<actorId>"}'
   ```
4. **Place its panel on home:** `agentorg call layout place '{"actor":"<actorId>","module":"panel","title":"Launch"}'`. It shows in the shell at once.
5. **Add a card** in the panel: type it and press Enter. It is kept in the board's store, so it's there after a reload, and after the board's process restarts (`actors stop`, then `actors start`).

Until the Hub spawns package processes itself, `actors start` marks the board running without running its logic, so step 5's cards need its host process, `@agentorg/sdk/host/runner.js`, run over a pipe the Hub accepts, as `packages/app/test/board.test.ts` does.

## The app: the person's gateway

`agentorg` runs the person's Actor as the app's gateway: its single running instance, holding the person's one channel to the Hub, in this process. Browser tabs and the CLI are the person's UIs, not channels: they reach the gateway, not the Hub.

- **Sign-in:** the browser opens `/signin#<code>`. The code is one-time, lasts 60 s, and sits in the fragment, which no request carries; the page drops it from the address at once. It trades the code, with a same-origin POST, for a session, which it keeps in the shell origin's `localStorage`. That's no cookie, because browsers send a `127.0.0.1` cookie to every port there; storage is the origin's alone, port included. Sessions live in the gateway's memory, so a restart signs every tab out.
- **`/api`:** one WebSocket per tab, with the same calls a channel carries, as JSON:
  - `{id, op: "call", slot, method, input}` is answered `{id, result}` or `{id, error}`;
  - `{sub, op: "subscribe", slot, event}` gets `{sub, payload}` per event, and `{sub, end: true}` when it ends; `{sub, op: "unsubscribe"}` stops it.
  - `{op: "log", view: {actor, module}, level, message, fields?}` adds a line to the view's Actor's log, through the Hub's `viewLog`, which bounds it as a frame's line is; nothing answers.

  A socket holds 256 subscriptions and 64 calls in flight at most (past it, `busy`). A tab's socket must come from the gateway's own `Origin`, and its first message must be `{op: "hello", session}` with a live session, answered `{op: "hello"}`; otherwise it's closed with code 4401, and the tab signs in again. The CLI gets in with the token in `<home>/cli-token` (0600, new at each start) as a bearer. The gateway answers only to `127.0.0.1:<port>` in `Host`, so a page that rebinds DNS to loopback gets nothing.
- **What the calls reach:**
  - Calls run through the person's slots: `packages`, `actors`, `bindings`, `grants`, `exports`, `audit`, `store`, and `login` (`account.login@1`, the model's sign-in, which may be unbound).
  - `layout` is the person's own export, served by the gateway.
  - With `view: {actor, module}`, a call runs as that view's Actor, through the Hub's view path (`viewCall` and `viewSubscribe`). The Hub refuses a module that isn't one of the Actor's views, or an Actor that isn't running.
- **`layout@1`:** the person exports it, so a program bound to it places a view as the person does. Each placement records `by`, the Actor that placed it, from the call's caller as the Hub names it (the person, through `/api`); no input sets it. The layout is kept in the person's `store` slot (`kv@1`) under the key `layout`, and the app binds that slot to the built-in `storage` where there is one.
  - `place` takes only a `view` module of a package Actor, with no `after` meaning last.
  - `move` with no `after` means first.
  - Every change tells `changed`.
- **Packages and systems, as files:** for the person's UIs only, a tab by its session and the CLI by its token, sent as `Authorization: Bearer`, which no other page can send.
  - `GET /packages/<hash>.agentorg`: a stored package's archive, made again from its stored tree in the SDK's deterministic tar, so the same bytes `agentorg build` writes.
  - `POST /packages`: an archive to add, through a private temporary file in the home, verified by `hub.packages.add`, then deleted. It's answered with the package's hash and manifest.
  - `GET /system`: the system's file, `<name>.agentorg-system`, a tar of `composition.json` (the installer's `exportSystem`) and `packages/<hash>.agentorg` for every package it pins.
  - `POST /system`: a system file. Its entries must be exactly `composition.json` and `packages/sha256-<64 hex>.agentorg`, regular files only. Each package is added under its hash's name, so one whose hash isn't its name is refused. Then the installer's `importSystem` runs with the person's authority.
  - Files are 64 MiB at most (`too_large`, 413 past it), and failures answer `{error}` as `/api` does.
  - The person's `installer` slot, bound by the app's first run, serves both.
- **`/frames/`:** a view's frame, its runtime and its bundle, for `view` modules only, and only by package hash. Every response's policy is `sandbox allow-scripts`, so whatever loads there runs on an opaque origin, even opened as a top page, and never as the shell's origin, where the session is. It allows scripts only from the gateway's `/frames/`, inline styles, and no fetches, forms or windows. The frame's origin is opaque, so its module scripts are CORS requests from `Origin: null`: only those are answered `Access-Control-Allow-Origin: null`, and nothing there reads or needs the session.
- **The app's own pages** carry a policy of their own: scripts and styles from the app only, framed by nothing.
- **The shell,** `@agentorg/shell`, is what the gateway serves at `/`: one socket to `/api`, and nothing it decides on its own.
  - **Agents** are the package Actors with a `chat` view. Selecting one mounts that view in the main container, with the placements beside it whose `actor` is that agent or whose `by` is.
  - **Home** shows the open grant requests, with Allow and Decline, then every placement of `layout@1`, in order. Each event (`layout` `changed`, `grants` `requested` and `decided`, and the audit's lifecycle and binding entries) reads its part again.
  - **Settings** reads the Actors, packages and connections through `hub.*`, and the ChatGPT account through `login` when it's bound.
  - **New agent** is offered once a package named `assistant` is added. It creates one with step 5's bindings, less the grants switched off, then starts and opens it.
  - **Views** each get their own frame and `FrameHost`. Their calls run with `view: {actor, module}`, `openExternal` opens a new tab with no opener, `signIn` is the shell's ChatGPT sign-in, and their log lines go to their Actor's log (`agentorg call actors logs`).
  - **ChatGPT sign-in** calls `login.start`, opens the consent page in a new tab, and moves on when `login` says `signed_in`. The one-time plan notice is remembered in the person's store under `ui/plan-notice`.
