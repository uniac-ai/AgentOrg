# agentorg: design

Status: draft. The code builds toward this design.

## Components and entry points

AgentOrg's server and clients are separate applications. The server owns the organization;
clients act through its gateway with the identity and authority of an actor. A human, an agent
session and a program are ways of operating an actor, rather than kinds of actor.

| Application | Entry point | Responsibility |
|---|---|---|
| Server | `agentorg-server [--port <n>]` | Run the core. Its `service install`, `service uninstall` and `status` operate only this service. |
| Actor CLI | `agentorg <operation>` | Call the organization's built-ins as an actor. |
| MCP client adapter | `agentorg-mcp [--client <name>]` | Present an actor's operations over stdio. Its `connect`, `disconnect` and `status` own project integrations; `context`, `prompt` and `wait` own client hooks. |
| Web client | `agentorg-web [--port <n>]` | Serve the existing browser client. `open` signs a browser in; `service install`, `service uninstall` and `status` operate only this service. |

The package distributes all four executables. Their source boundaries are `src/server/` and
`src/clients/{cli,mcp,web}/`. Each application owns its entry point and setup. Server code imports
no client application, and clients import neither the server nor sibling applications. Clients
reach the organization through the actor library. The shared domain model supplies their types.

`src/runtime/` contains host mechanics: pinning an executable and its environment in a launcher,
managing one user service, reporting launcher and HTTP availability, and reporting command
errors. It imports no application and performs no organization operation. Executable paths come
from the package's `bin` map. Each service has its own launcher, service name and lifecycle, and
MCP project setup checks its own launcher and the core without requiring a web client.

The applications share the actor, credential and attachment contracts described below.

## Layers

The code is in layers. Each depends only on the one below it, through a small interface (a port), so any layer can be replaced without touching the others. MCP is today's protocol, not the model: another binding, such as plain HTTP JSON or gRPC, would implement the same ports.

| Layer | Folder | What it owns | Today's choice |
|---|---|---|---|
| **Network** | `src/network/` | Moving text between a party and the core: the listener, credential to identity, one channel per party, dialing again. It knows no tools, calls or actors. | HTTP and a WebSocket on 127.0.0.1 |
| **Protocol binding** | `src/bindings/mcp/` | Encoding the domain's operations on the wire, both ways: listing interfaces, calls, runs, cancellation, change notices, metadata. It is the only code that imports MCP. | MCP |
| **Domain** | `src/domain/` | Actors and their interfaces, calls and their lifecycle, the wiring, progress and messages, the built-ins, the audit trail. | agentorg's own model |
| **Storage** | `src/storage/sqlite/` | Keeping the domain's records, behind the domain's `Store` port. | SQLite through `node:sqlite` |
| **Actors** | `src/actor/`, `src/clients/web/`, `src/clients/mcp/`, programs | What a party does with a call. The actor library gives an actor an API that names no protocol or network. | the web client, the agent actor, programs |

How the layers meet:
- **The domain's ports** are in `src/domain/ports.ts`:
  - `ActorLink`, the way to one reachable actor: deliver a call, wait on a run, cancel a run, and close. A binding implements it.
  - `Presence`, which a binding tells when an actor can be reached through which link, and what it exposes.
  - `Application`, which a binding serves to callers: what an actor may call, and calling it.
  - `Store`, the record reads and writes the domain needs. The storage layer implements it.
- **The composition root**, `src/server/index.ts`, assembles the core from the domain, SQLite storage, the MCP binding and the network listener.
- **The actor library** (`src/actor/`) assembles the network's connector with the binding on an actor's side, and the binding's server for the session that fills a position (`occupant.ts`), behind its `Presented` port.
- **`test/layers.test.ts` enforces the rules:**
  - The domain imports no MCP, web framework, WebSocket, database or Node built-in, and uses no Node globals. Its secrets and hashes come from Web Crypto, so it runs on any JavaScript runtime that has that, and the web app type-checks through its model.
  - The network imports no domain, binding or storage.
  - Only the MCP binding imports MCP.

## The domain

### Interfaces

The domain's interface descriptor is its own: name, title and description, input schema, output schema, whether it is one-way, and whether it is long-running.
- **Schemas** are JSON Schema, the domain's schema language. The domain checks inputs and outputs against them with Ajv.
- **A one-way interface's caller** does not wait for its result.
- **A long-running interface** may take a call as a run, which it finishes hours later.

### Records

| Record | Fields | Rules |
|---|---|---|
| **Actor** | id; name, a handle unique among its open siblings; purpose; manager (an actor id, or null for the root); credential hash; online; its exposed interfaces as last listed; created at attach; created at; closed at | Its manager creates it, and its manager or the root closes it, once its own reports are closed. Its path is its handles from the root's report down, as `release.storage`. An interface name holds letters, digits, `_` and `-`, since dots join handles and names. A handle that begins a built-in's name, as `call` begins `call_result`, is refused, since clients turn a routed name's dot into `_`. |
| **Call** | id; from; to; interface (the callee's own name for it); input; state (`pending`, `done`, `failed` or `withdrawn`); output, as a structured value and parts, or error; cause (the call that led to this one); run (the callee's handle for it while it runs long); created, delivered and settled at | It is recorded before it is delivered, and settles once. A result that arrives after it settled is dropped. |
| **Progress** | actor; version; state (`running`, `waiting`, `blocked` or `review`); summary; items, each with a title, a state (`planned`, `running`, `waiting`, `blocked` or `review`) and optionally a summary, links, an owner and what it waits on; links; updated at | Each set adds a version, and reads leave earlier versions out unless asked. Item titles are unique, and done items drop off. A link is an http, https or file URL. |
| **Question** | id; cursor; from; to; text; links; options and a recommendation; answerer; cause; answer (who answered, the choice, the words, whether the asker recorded them, and when); created at | It is answered once. |
| **Message** | id; cursor; from; to; text; links; reply to; created and read at | |
| **Claim** | resource; holder; note; until; claimed at | A resource has at most one current claim. It ends when released, when `until` passes, or when its holder is closed. |
| **Audit entry** | id; at; actor; operation; target; outcome | One line for each write, and for each routed call when it is created, refused and settled. |

### Wiring: who calls what

An actor's available interfaces are:
- the core's built-ins;
- its manager's exposed interfaces, named `manager.<name>`, as in `manager.decide`;
- each direct report's exposed interfaces, named `<handle>.<name>`, as in `storage.review`;
- for the root, every actor's exposed interfaces, named by its path, as in `release.storage.review`.

Lateral grants are deferred; they would be one table the root writes.

### Routing a call

When actor A calls `B.name`:
1. The core finds the interface among A's and checks the input against its input schema. A refused call is not recorded.
2. It records the call as `pending`, with the cause A names, which must be a call into A.
3. It delivers the call through B's link while B is reachable, and again each time B comes back while the call is pending. So delivery is at least once, and a handler must tolerate a repeat. A call to an unreachable actor waits.
4. It checks B's structured value against the output schema and records the call as `done`. A value that breaks the schema, a missing value where there is a schema, or a failure records it as `failed`.
5. A waits up to 30 seconds, with progress. If the call is done by then, A gets B's result. Otherwise A's answer is pending, and A reads the call later with `call_result`. A call into a one-way interface answers pending at once.

### Long-running calls

A human may answer hours later, so a long-running interface may take a call as a run:
- **The wait.** The core records the run and waits on it.
- **After a reconnect.** The core waits on the same run again. If the actor no longer knows the run, as after a restart, the core delivers the call again and the actor takes it as a new run. So an actor can rebuild its queue from the calls pending on it, and a reconnect alone does not deliver a call twice.
- **Withdrawal.** A withdrawn call's run is cancelled.
- **Interfaces that are not long-running** answer within 60 seconds, or the call fails.

### Communication

| Kind | Who reads it | Who it waits on |
|---|---|---|
| **Progress** | anyone in the organization | nobody |
| **Question** | anyone, with its answer | its addressee, until answered |
| **Message** | its two parties, the manager of either, and the root | its addressee, until read |

- **Progress** is where an actor stands: its state, a short summary at its own level, its open workstreams or steps, and links to what it produced. An actor publishes only what it chooses; its transcript and reasoning stay in its client.
- **Asking.** A question goes to the asker's manager by default, or to a direct report, so decisions follow the chain. The root asks anyone.
- **Escalation** is a new question. A manager asks its own manager in its own terms, with `cause` naming the question it carries up, and answers the original once it has the answer.
- **Answering:**
  - A question's addressee answers it, or the answerer it names, as the root for an approval only the user gives. The root may answer any question.
  - The answer records the actor whose credential gave it, so a relayed approval does not count.
  - When the user answers inside the asking session, the asker records their words for its own question, and the answer is marked as recorded. A question with an answerer refuses that: the user answers it through the core.
  - One answer may resolve several questions. Its choice is optional, and its words may reject the options.
- **Messaging.** A message goes to any open position. A reply names the message it replies to, between the same two actors, and marks it read. A message the caller may not read is not found, so a private message's existence stays private.
- **Claims.** An actor claims a shared resource, such as a release lane or a cluster, while it uses it, and anyone sees current claims in `team`. Claiming a resource another actor holds is refused, naming the holder.
- **The cursor.** Questions and messages share one sequence. A question takes a new cursor when it is answered. So a read since a cursor finds new messages, new questions and new answers. A read with `wait` holds until a match exists, for up to 600 seconds, and every write wakes it.

### Built-ins

| Built-in | What it does |
|---|---|
| `actor_create {name, purpose, created_at_attach?}` | Creates a report of the caller, and returns it with its credential. The credential is shown only once. The root alone may mark a position created as a session the user started attaches to it. |
| `actor_close {actor}` | The manager, or the root, closes an actor. It is refused while the actor has open reports of its own. The actor's own pending calls are withdrawn, the calls into it fail, and its connection closes. The root is never closed. |
| `progress_set {state?, summary?, items?, links?}` | Replaces the fields given of the caller's progress. The first set names its state. |
| `team {actor?, depth?}` | A position and its reports down to a depth, by default the caller and its direct reports: each one's purpose, presence, progress state and summary, open questions, claims, and its interfaces the caller can call, with the root's id. Anyone may read any position. |
| `progress {actor, history?}` | An actor's full progress, with its open questions and, when asked, earlier versions. Anyone may read it. |
| `question_ask {to?, text, links?, options?, recommendation?, answerer?, cause?}` | Publishes a question. |
| `question_answer {questions, choice?, text?, recorded?}` | Answers one or more open questions. |
| `questions {to?, from?, open?, since?, limit?, wait?}` | Questions, newest first, with the newest cursor. Anyone may read them. |
| `message_send {to, text, links?, reply_to?}` | Sends a private message. |
| `messages {box?, unread?, actor?, with?, since?, limit?, wait?}` | The messages the caller may see, newest first, with the newest cursor: by default those addressed to it. It changes nothing. |
| `message_read {ids}` | Marks messages addressed to the caller read; each sender sees when. |
| `claim {resource, note, until?}` | Claims a shared resource, or renews the caller's claim. It is refused while another actor holds it. |
| `release {resource}` | Releases a resource the caller holds; the root may release any. |
| `call_result {call, wait?}` | Reads a call the caller made, optionally waiting up to 600 seconds for it to settle, with progress. |
| `call_withdraw {call}` | The caller withdraws a pending call. |
| `activity {since?, limit?}` | The audit trail, newest first. Offered to the root only. |

## Today's binding: MCP in both directions

The network gives each party two endpoints, and the MCP binding names them:

| Endpoint | MCP roles | Transport |
|---|---|---|
| `/mcp`, the request endpoint | the core is the server, the actor its client | Streamable HTTP. Each request stands alone, without an MCP session. |
| `/mcp/reverse`, the channel endpoint | the core is the client, the actor its server | A WebSocket the actor opens, with subprotocol `mcp` and one JSON-RPC message per text frame. |

How the domain is encoded:
- **An interface is an MCP `Tool`.** The core learns an actor's interfaces with `tools/list` over the channel, and lists them again on `notifications/tools/list_changed`.
  - A tool is one-way when its output schema is the empty object.
  - It is long-running when it declares `execution.taskSupport` and its server declares `tasks.requests.tools.call`.
- **A call is `tools/call`**, with `_meta["agentorg/call"] = {id, from, cause}`. A caller names its cause with `_meta["agentorg/cause"]`.
- **A run is an MCP task.** The core sends a long-running call with `params.task`, waits on `tasks/result`, and asks again at once when the actor's `notifications/tasks/status` says the task finished. Cancelling is `tasks/cancel`, and an unknown task is a lost run.
- **An answer is a `CallToolResult`.** A done call returns B's own result, with `_meta["agentorg/call"] = {id, state}`. A pending one returns `{call, state: "pending"}`. A routed tool's listed `outputSchema` is B's or that pending shape, so that clients checking results accept both.

## The MCP adapter

The MCP adapter, `agentorg-mcp` in `src/clients/mcp/`, lets a Claude Code or Codex session fill a position. The client starts it over stdio for each session, and it connects to the core as that position with the actor library. Its project integration and hooks belong to this adapter.

- **What the session sees.** The stdio adapter has three fixed tools: `attach`, `interfaces`, and `call {name, input}`. Before attachment, listing and invocation are refused. `interfaces` returns the attached actor's current permitted offers from the actor library, with the core's descriptions and schemas. `call` invokes one of those interfaces through the same library. The core's own MCP catalog and the actor library's dynamic presentation remain separate contracts. Before its first turn, the client's session-start hook runs `agentorg-mcp context`, so a session that fills no position reads that it loads the `agentorg` skill and attaches before any other action. The adapter's instructions say the same.
  - `attach {actor}` fills the position the session's brief names.
  - `attach {name, purpose}`, allowed only on a session's first attach, creates its position directly under the root. The agent actor uses the root's credential for that one call.
  - The tool catalog remains fixed across attachment and resuming. Current offers are read on each `interfaces` invocation, with no adapter cache. Logical operations such as `team` are invoked as `call {name: "team", input: {}}`.
- **What the session is told.** Each kind of guidance has one place:
  - the adapter's tool descriptions say how to attach, list and invoke; the core's interface descriptors define each operation's description and schemas, and the core enforces permissions;
  - the server's instructions, the start hint and the frame around what the waiter delivers say what to do at that moment;
  - the `agentorg` skill, `skills/agentorg/`, carries the operating model the core can't enforce, such as when to ask rather than decide, at what level to write, and when to delegate and close, with a reference per client. It maps logical operation names through `call` without restating their descriptions;
  - an organization's own conventions are a skill of its own, loaded beside it.
- **Credentials.** The session never sees one.
  - Each position's credential is kept in the agentorg home's credential store, `actors/<id>`, mode 600.
  - When the session's `actor_create` creates a report, the agent actor keeps the report's credential there, and the session gets the result with that credential replaced by a note that it was kept.
  - `actor_close` forgets the closed position's credential.
- **Session identity and resuming.** `sessions/<client>-<session id>/position` names the position a conversation fills. Claude Code names the session in `CLAUDE_CODE_SESSION_ID`. Codex identifies it in each tool call's `_meta.threadId`, carried through the presentation boundary as optional occupant-session context. Initialization and listing need no identity; a Codex call requires one, and the adapter refuses a different identity after binding. The first call recovers only that conversation's saved position. `attach {actor}` acknowledges the same actor; a session cannot change actors. A fork with a new thread id attaches independently.
- **Project hooks.** `connect codex` writes AgentOrg's `SessionStart` and `UserPromptSubmit` commands to `.codex/hooks.json`, preserving other entries. Launcher command and arguments are edited by their parsed TOML value ranges, preserving surrounding policy and comments. The commands take identity from stdin's `session_id`, not inherited environment variables. Project configuration requires trust, hooks must be enabled with `features.hooks`, and the definitions require review and trust through `/hooks`. Startup, resume and fork identity behavior is verified against the Codex build in use; thread and session-tree identities are not derived from each other.
- **Delivery and waking.** Claude Code's hooks run the waiter, `agentorg-mcp wait`, when the session starts and whenever its turn ends, as `asyncRewake` hooks. Codex's hooks supply context and capture prompts; its sessions read their inbox when they run, since its background hooks do not wake idle turns.
  - The waiter waits, as the position, for what the session has not seen: unread messages to the position, questions addressed to it, and answers to its own questions. The session's cursor, a place in the sequence questions and messages share, marks what was delivered.
  - It writes them framed as agentorg's, each with its kind, its sender's path and its id, marks the messages read, and exits with status 2. Claude Code hands that output to the session as its next input, starting a turn when the session is idle.
  - A newer waiter replaces an older one, which then ends without writing. Delivery is at least once.
- **Answers recorded from the user's words.** When the user answers a question in the asking session itself, the session records the answer with `question_answer {recorded: true}`.
  - The client's prompt hook, `agentorg-mcp prompt`, keeps the words the user last typed in the session, in `sessions/<client>-<session id>/prompt`. It doesn't keep what the client delivers wrapped in an element, such as the waiter's output or another session's message.
  - The agent actor passes a recorded answer on only when those words came after every question it answers. It puts the words in the answer's text verbatim, in place of the session's own text, and then forgets them.
  - The core refuses a recorded answer to a question that names an answerer.

## The network

- **Access.** Both endpoints take `Authorization: Bearer <credential>`. The domain's registry tells who a credential is.
- **Web pages are refused.** A request with an `Origin` header comes from a web page, so it is refused; that blocks DNS rebinding and cross-site WebSockets.
- **One channel per party.** A newer channel replaces the older, which closes with code 4000. Closing an actor closes its channel with code 4001.
- **The party's side, the connector.** It dials the channel again after a drop, but not after 4000 or 4001.
