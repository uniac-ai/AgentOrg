# AgentOrg

## Install

```sh
npx @agentorg/cli
```

It needs Node.js 22.15 or later. It runs AgentOrg on this computer and opens it in your browser; see "The `agentorg` command".

AgentOrg creates and manages agents. Each part is a program that joins a Hub as an Actor, connected to the others through named, versioned interfaces: a model, agent providers, MCP providers, and management.

## Packages

- `@agentorg/sdk`: `defineInterface` (with `method` and `event`) for interfaces, with typed slot and export handles; the errors `NotConnected`, `Refused` and `OutcomeUnknown`; and `createTestContext` (`@agentorg/sdk/testing`), which runs a program's handlers without a Hub. An `rpc` handler gets its input and `{ caller }`, the calling Actor as the Hub names it, and `emit(event, payload, { to })` sends an event only to the subscriptions of the Actor `to` names, so a provider serving several consumers keeps each one's events its own. `@agentorg/sdk/client` connects a program outside the Hub as an Actor: `connect({hubUrl, actorId, credential, slots, exports})` gives typed handles, with slots bound as the Hub's notices say; implement in `start` (run before the channel opens) and use slots from `onBind`, which runs when a slot becomes usable: bound, or its provider back. `openChannel` is the wire layer beneath it, without local checks.
- `@agentorg/interfaces`: the standard interfaces `kv@1`, `chat@1` (an agent's chats: `send` starts one or goes on in one, a chat's `history`, `state`, `cancel` and `retry` name it, as its events do, and `list`, `rename` and `archive` manage them; a `tool` message may carry the call it stands for, its name, `running`/`done`/`refused`, input and output, sent as `running` when it starts and again under the same id when it ends; `models` lists the models it can use and the one chosen, and `setModel` chooses, kept with the agent), `llm.session@1` (stateless model inference, with function tools), `account.login@1` (signing in to an outside account, driven by a person or a program), `tools@1` (a set of tools known only at run time, as one fixed contract), `agent.settings@1` (what a running agent reads for its instructions and skills), `mcp.provider@1` and `agent.provider@1` (programs that make connections to MCP servers and agents), and `unit.provider@1` (a program that offers units of an agent's stack, each with its form as data), and `agents@1`, `connections@1` and `skills@1` (what the person calls to manage them), and the Hub's management interfaces `hub.actors@1`, `hub.grants@1`, `hub.bindings@1`, `hub.exports@1` and `hub.audit@1`.
- `@agentorg/wire`: the channel: yamux streams, length-prefixed JSON frames, stream headers and transports.
- `@agentorg/hub`: the core. Its state, in `node:sqlite` in a private home: Actors, what each takes and offers, bindings and an audit trail. An Actor is a program that connects itself, with a credential. A binding is the grant, and it needs both ends: the export side (the provider, an Actor already bound to that export, or a manager) and the slot side (the consumer itself, or a manager). Through `hub.grants@1`, a caller with both ends binds; any other is refused. `hub.grants.expose({provider, export, to, as?})` exposes an `rpc` export to one Actor: a slot made on `to` at run time, typed by the export's interface and bound to it in one step, named `as` (one word of at most 48 characters) or by default the provider's name camelCased, `_` and the export's last part, made unique on `to` with `_2`, `_3`…. Its authority is a binding's, `to` being the consumer. Exposing the same export to the same Actor again gives its slot back. The slot goes with its binding: `unexpose({to, slot})`, `unbind`, the export no longer declared or either end closed; `hub.bindings` marks such a binding `exposed: true`. A manager is any Actor bound to `hub.bindings@1`. `hub.actors.create` can bind the new Actor's slots at once, with the creator's export side. The router serves it over WebSocket (`listen`), one yamux channel per Actor: a client's first stream is `hello` with its credential, then every `call` and `subscribe` stream is resolved through its binding, validated against the interface's JSON Schemas in both directions (ajv, 2020-12, in a pool of worker threads, each check under a time budget, since schemas come from Actors), forwarded to the provider with the caller named, and audited. An Actor learns which of its slots are bound from hello's result, then from a `slot` notice on each change. Every Actor's record in `hub.actors` says whether it is `connected`, holding a channel to the Hub now, and `hub.actors`' `changed` event names an Actor whose record may differ. When a redeclaration changes the interface of a bound name, the bindings whose other end doesn't declare the new one are dropped (audited as `binding.drop`). A refusal that names an Actor names it as "Name (id)", and says what the caller can do instead.
- `@agentorg/cli`: AgentOrg as one app. `agentorg` runs a Hub, the person's gateway and the shell on loopback; see "The app: the person's gateway".
- `@agentorg/mcp`: the built-in MCP provider, an external Actor exporting `unit.provider@1` as `provider`, and the only code that imports the MCP client (`@modelcontextprotocol/client`). `startMcpProvider({hubUrl, actorId, credential, dir})` runs it; its slot `actors` is bound to `hub.actors@1`. It offers two kinds: `url` attaches to a server over Streamable HTTP, sending `secrets.token` as a bearer token on every request (only over https or to this machine), and `command` starts a local server over stdio, with the basic environment and each of its `secrets` as an environment variable. Each connection joins the Hub as its own Actor exporting `tools@1` as `tools`: `list` and `call` go to the server, a tool's result comes back as text, with `failed` when the tool reported an error, and `changed` fires when the server's tools change or it goes or comes back. While a server is away `list` and `call` are refused `not_connected`, and the provider tries again after a backoff from 1 s doubling to 60 s (starting over after 10 minutes up). `create`'s `secrets` are write-only: the values cross once and go only to the provider's private `dir`, never into `params`, `target`, `detail`, status or a log (what a server prints is scrubbed of them). Each connection's Hub credential, parameters and secrets are kept in that folder, and connections rejoin at its next start. A server started by `command` is an ordinary process with the person's rights, outside the Hub's sandbox.
- `@agentorg/manager`: management, an external Actor exporting `agents@1`, `connections@1`, `skills@1` and, as `settings`, `agent.settings@1`. `startManager({hubUrl, actorId, credential, dir})` runs it; bound to `hub.actors@1`, `hub.grants@1` and `hub.bindings@1`, it is a manager. A provider of either sort is connected by exposing its export to it: the Hub's slots are the only list. It keeps what the Hub can't know, in its private `dir`: each connection's origin, each agent's provider, creatable, instructions and skills, and the skills as `SKILL.md` folders. Status is read when asked, what a connection is exposed to is the Hub's bindings, and `secrets` go straight to the provider. `agents.create` is all or none: the provider makes the agent, its `settings` are bound, its skills added (one whose name is here keeps the one here), each connection it needs made or picked and exposed under its slot, and its chats exposed to the person; if a step fails, what this creation made is removed. The Hub drops that exposure when an agent comes back offering its chats in another shape, as after an upgrade, so management makes it again each time an agent connects. An agent reads only its own instructions and skills, and only it hears that they changed.
- `chatgpt`: the model, a program. It signs in with ChatGPT for the person's plan (`account.login@1`: OpenAI's OAuth for open-source apps, with dynamic registration, PKCE and a verified id_token; refresh tokens rotate, one refresh at a time) and serves `llm.session@1` on that plan through the Responses API, streamed and stored nowhere. The tokens never leave it: never in a reply, an event, a log or a refusal. It never uses an API key or API billing: a usage limit is refused `usage_limit`, with where to manage it. `startChatGPT({hubUrl, actorId, credential, dir})` runs it as an Actor exporting `login` and `session` with no slots at all: the sign-in is in `sign-in.json` in its private `dir` (mode 0600, written through before a change is acknowledged, since a rotated refresh token can't be had again), and it reaches OpenAI over the network directly, https only, with redirects returned as they are. Its tests run against an in-process fake of OpenAI, so none reaches OpenAI.
- `assistant`: the agent engine and the bundled agent provider. `startAgentProvider` runs an external Actor exporting `agent.provider@1` as `provider`, which offers one creatable, Assistant. Each agent is its own Actor on its own channel in that process, exporting `chat@1`, with the model behind `model: llm.session@1`, instructions and skills from an optional `settings: agent.settings@1`, and tools from each `tools@1` slot exposed to it. Its chats and model choice stay in the provider's private folder. A stopped agent stays on its channel and runs no turn: its chats can still be read, and a message is refused `busy`.

## Errors

- `NotConnected`: the slot is unbound, or the export is no longer declared.
- `Refused` with code `invalid`: the caller's input broke the interface's schema. Nothing ran.
- `Refused` with code `bad_output`: the provider ran, and its reply or event broke the contract. The call may have had its effect; read state before retrying.
- `Refused` with code `unimplemented`: the export has no handler for that method yet.
- `OutcomeUnknown`: the channel dropped mid-call. Read state before retrying.

## The `agentorg` command

`@agentorg/cli` provides `agentorg`.

- **`agentorg`**, with no command, runs AgentOrg: a Hub in its home, the person's gateway and the shell, on `127.0.0.1` (`--port N`, else any free port). It opens the browser already signed in, and prints only its address, never a sign-in code. `--no-open` doesn't open a browser. The code is in the address it hands the system's opener; on Linux, other local users can see that program's arguments for the moment it runs, and the code works for 60 s.
- **`agentorg --version`** prints the version. An option the command doesn't know is refused with the usage (exit 2); it never starts the app.
- **`agentorg open`** signs a browser in to the running app again.
- **`agentorg hub [--port N]`** runs a bare Hub in its home, without the gateway or the shell, serving WebSocket on loopback, and writes the address to `<home>/url`.
- **The person's commands**, one per hub method:
  - `agentorg actors|bindings|exports|audit`;
  - `agentorg bind <consumer.slot> <provider.export>`;
  - `agentorg call <slot> <method> [json]`.

  While the app runs, they go through it, with the CLI's token in `<home>/cli-token`. Otherwise they connect as the person with `<home>/person-credential`, and never take over a channel something else holds (hello's `replace: false`).
- **The home** is `--home`, else `$AGENTORG_HUB_HOME`, else `$XDG_DATA_HOME/agentorg` when `XDG_DATA_HOME` is an absolute path, else `~/.local/share/agentorg`, on Linux and macOS alike.
- **Output:** results are JSON on stdout. A refusal exits 1 with its reason on stderr, and a usage mistake exits 2.

`@agentorg/sdk`'s own bin is `agentorg-sdk`, with the same commands but no app.

## Try it

From a clone, after `npm ci` and `npm run build`, with `agentorg` being `node packages/app/dist/src/cli.js`:

1. **Run the app:** `agentorg`. It prints its address and opens the shell in the browser, already signed in; `agentorg open` signs a browser in again.
2. **See what can be created:** `agentorg call agents creatable`. It lists the Assistant, with the id of the provider offering it.
3. **Create an agent:**

   ```sh
   agentorg call agents create '{"stack":{"base":{"provider":"<provider>","creatable":"assistant"},"units":[]},"name":"Scout"}'
   ```
4. **Open it in the shell,** sign in to ChatGPT there, and chat with it.

To run the tests, install the browser they drive once, with `npx playwright install --only-shell chromium`, then `npm test`. The shell's, the connector's and the app's tests use Playwright's headless shell, never a browser installed on the machine.

## The app: the person's gateway

`agentorg` runs the person's Actor as the app's gateway: its single running instance, holding the person's one channel to the Hub, in this process. Browser tabs and the CLI are the person's UIs, not channels: they reach the gateway, not the Hub.

- **Sign-in:** the browser opens `/signin#<code>`. The code is one-time, lasts 60 s, and sits in the fragment, which no request carries; the page drops it from the address at once. It trades the code, with a same-origin POST, for a session, which it keeps in the shell origin's `localStorage`. That's no cookie, because browsers send a `127.0.0.1` cookie to every port there; storage is the origin's alone, port included. Sessions live in the gateway's memory, so a restart signs every tab out.
- **`/api`:** one WebSocket per tab, with the same calls a channel carries, as JSON:
  - `{id, op: "call", slot, method, input}` is answered `{id, result}` or `{id, error}`;
  - `{sub, op: "subscribe", slot, event}` gets `{sub, payload}` per event, and `{sub, end: true}` when it ends; `{sub, op: "unsubscribe"}` stops it.

  A socket holds 256 subscriptions and 64 calls in flight at most (past it, `busy`). A tab's socket must come from the gateway's own `Origin`, and its first message must be `{op: "hello", session}` with a live session, answered `{op: "hello"}`; otherwise it's closed with code 4401, and the tab signs in again. The CLI gets in with the token in `<home>/cli-token` (0600, new at each start) as a bearer. The gateway answers only to `127.0.0.1:<port>` in `Host`, so a page that rebinds DNS to loopback gets nothing.
- **What the calls reach:** the person's slots: `actors`, `bindings`, `grants`, `exports`, `audit`, and the four the first run binds: `login` (`account.login@1`, the model's sign-in), `agents`, `connections` and `skills`. A slot exposed to the person at run time, such as an agent's `chat@1`, is reached under its name from `bindings.list`. `store` answers from the app's own notes, `<home>/app-notes.json`.
- **The first run,** at every start, beside serving (`startPrograms` in `src/programs.ts`; `app.firstRun` settles with what it started): ChatGPT, the agent provider, the MCP provider and management, each an Actor of its own run in this process, with a private folder and a credential under `<home>/programs`. Each provider is connected by exposing its export to management. Each step reads what is there first, so a restart, or a first run that stopped half way, makes nothing twice. Any package Actor an earlier release left is closed before the Hub opens, and its files are left where they are.
- **`/oauth/chatgpt`:** where ChatGPT sends the browser back after sign-in. It takes `GET` only and hands the whole address, which holds the sign-in's code, to `login.complete`. Then it sends the tab on (303) to `/oauth/chatgpt?result=<outcome>`, so the code leaves the tab's address and history; that page says how it went and links back to the shell. The code is never logged or shown, and no referrer is sent.
- **The app's own pages** carry a policy of their own: scripts and styles from the app only, framed by nothing.
- **The shell,** `@agentorg/shell`, is what the gateway serves at `/`: one socket to `/api`, and nothing it decides on its own. Its pages are fixed: Agents, one agent, Chat, Skills, MCP connections and Settings, each reading the person's slots and what is exposed to the person.
