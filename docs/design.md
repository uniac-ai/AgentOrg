# agentorg: design

## Components and entry points

AgentOrg's server and clients are separate applications. The server owns the organization;
clients act through its gateway with the identity and authority of an actor. A human, an agent
session and a program are ways of operating an actor, rather than kinds of actor.

| Application | Entry point | Responsibility |
|---|---|---|
| Server | `agentorg-server [--port <n>]` | Run the core. Its `service install`, `service uninstall` and `status` operate only this service. |
| Actor CLI | `agentorg <operation>` | Call the organization's built-ins as an actor. |
| MCP client adapter | `agentorg-mcp [--client <name>]` | Present an actor's operations over stdio. Its `connect`, `disconnect` and `status` own project integrations; `context`, `prompt` and `wait` own client hooks. |

The package distributes these three executables and the public `@agentorg/cli/actor` library.
Their source boundaries are `src/server/` and `src/clients/{cli,mcp}/`. Each application owns
its entry point and setup. Server code imports no client application, and clients import neither
the server nor sibling applications. Clients reach the organization through the actor library.
The shared domain model supplies their types.

`@agentorg/cli/contract` exposes an explicit selection of public wire schemas and types from
`src/domain/model/`. It depends only on that model; external clients use it to validate and type
requests and responses. `BUILTINS` is the existing derived schema inventory, while feature
modules continue to own runtime operations. Storage records and bound operations stay internal.

The [Human client](https://github.com/uniac-ai/OrgActor-Human) owns its browser UI, local HTTP API,
sign-in, launcher and service in a separate repository. It depends on the public Actor library
and Hub contract; browser users depend on its HTTP interface. The Hub has no dependency on that
application or its build, and organizational authority stays in the Hub's domain.

`src/runtime/` contains host mechanics: pinning an executable and its environment in a launcher,
managing one user service, reporting launcher and HTTP availability, and reporting command
errors. It imports no application and performs no organization operation. Executable paths come
from the package's `bin` map. Each service has its own launcher, service name and lifecycle, and
MCP project setup checks its own launcher and the core.

The applications share the actor, credential and attachment contracts described below.

## Layers

The domain defines its storage and actor-link ports and exposes Application and Presence. Storage and protocol adapters depend on those contracts, and the network supplies transport without importing the domain. Composition roots wire the concrete adapters and domain owner clients. MCP is today's protocol binding; a replacement implements the same ports.

| Layer | Folder | What it owns | Today's choice |
|---|---|---|---|
| **Network** | `src/network/` | The loopback listener and bidirectional text frames. It knows no identities or application operations. | WebSocket on 127.0.0.1 |
| **Connection** | `src/connection/` | JSON-RPC admission of an existing Actor or Provider, immutable identity context, and client reconnection. | `connection.connect` on `/connection` |
| **Protocol binding** | `src/bindings/mcp/` | Encoding the domain's operations on the wire, both ways: listing interfaces, calls, runs, cancellation, change notices, metadata. It is the only code that imports MCP. | MCP |
| **Provider client** | `src/provider/` | The Hub's typed client for the fixed factory methods on an admitted Provider connection. | JSON-RPC |
| **Domain** | `src/domain/` | Actors and their interfaces, calls and their lifecycle, the wiring, progress and messages, the built-ins, the audit trail. | agentorg's own model |
| **Storage** | `src/storage/sqlite/` | Keeping the domain's records, behind the domain's `Store` port. | SQLite through `node:sqlite` |
| **Actors** | `src/actor/`, `src/clients/{cli,mcp}/`, external clients | What a party does with a call. The actor library gives an actor an API that names no protocol or network. | CLI, MCP adapter, Human client, programs |

How the layers meet:
- **The domain's ports** are in `src/domain/ports.ts`:
  - `ActorLink`, the way to one reachable actor: deliver a call, wait on a run, cancel a run, and close. A binding implements it.
  - `Presence`, which a binding tells when an actor can be reached through which link, and what it exposes.
  - `Application`, which a binding serves to callers: what an actor may call, and calling it.
  - `Store`, the record reads and writes the domain needs. The storage layer implements it.
- **The composition root**, `src/server/index.ts`, assembles the core from the domain, SQLite storage, the MCP binding and the network listener.
- **The actor library** (`src/actor/`) assembles the network's connector with the binding on an actor's side, and the binding's server for the session that fills a position (`occupant.ts`), behind its `Presented` port.
- **`test/layers.test.ts` enforces the rules:**
  - The domain imports no MCP, web framework, WebSocket, database or Node built-in, and uses no Node globals. Its secrets and hashes come from Web Crypto, so it runs on any JavaScript runtime that has that.
  - The network imports no domain, binding or storage.
  - Only the MCP binding imports MCP.

## The domain

`src/domain/index.ts` assembles owner clients and binds the connection-online trigger
to call redelivery. It contains no connection or call policy. The import graph,
including types, is acyclic and checked by `test/layers.test.ts`.

| Owner | Inputs and outputs | State |
|---|---|---|
| `registry.ts` | Credentials identify open positions; creation returns identity and a one-time credential; closure checks authority and open reports. | Identity, actor tree and lifecycle. |
| `execution.ts` | Accepts an existing Actor identity, private bootstrap credential, Provider and configuration; validates configuration and reports one Provider creation outcome. | None. |
| `connections.ts` | Accepts link-specific presence and advertisements; supplies live links and the latest descriptors; disconnects closed actors. Stale-link reports have no effect. | Live links in memory; advertised interfaces in storage. |
| `capabilities.ts` | Projects supplied feature Tools and Actor advertisements into caller-relative exposures. Listing, dispatch and team use the same projection. | None. |
| `calls.ts` | Creates, delivers, cancels, settles and waits on calls through Connections; records audit outcomes. | Durable calls; active delivery attempts and waiters. |
| `progress.ts` | Validates actor references, versions partial replacements and supplies current/history reads. | Progress versions. |
| `communication.ts` | Authorizes questions, answers and private messages, and supplies correspondence reads and waits. | Questions/messages with one cursor; waiting reads. |
| `claims.ts`, `audit.ts` | Manage current resource claims and append/read the audit trail. | Their durable records. |
| `actors.ts` | Owns the Actors Tool, Actor read projection and lifecycle orchestration over Registry, Execution, Calls and Connections. | None beyond its state-owner clients. |
| `team.ts` | Owns the Team Tool, progress publication and composed organization/progress views. Receives callable interfaces from core's invocation catalog. | Progress belongs to `progress.ts`. |
| `tools.ts` | Binds each feature's schema contract to its typed operations; the resulting objects supply exposure and invocation together. | None. |
| `application.ts` | Validates, audits and dispatches bound feature operations or routes calls through Calls, with bounded waits. | Request timing policy. |

SQLite schema 7 stores identity in `actors` and the last advertised descriptors in
`exposures`. Online state is derived from live links, so a fresh core starts offline
while retaining advertisements. Public actor responses combine identity and
connection state without exposing credential hashes. A database with another
nonzero schema version is refused with its version and the required version; its
records are neither migrated nor deleted.

### Tools and interfaces

The Hub gives each Actor a catalog of Tools. A Tool is `{id, name, interfaces}`; each interface
contains its descriptor, `call` alias, `routed` flag and optional `read_only` hint. The descriptor's
name is local to the Tool. `(tool.id, interface.name)` identifies an interface independently of
the caller's alias; `Actor.call(interface.call, input)` invokes it with the existing call names.
`Actor.available()`, the CLI's `interfaces`, and the agent adapter's `interfaces` carry these
nested Tools. The CLI and adapter return `{tools: [...]}`.

Every open Actor receives the same seven built-in Tools and sixteen interfaces. Their IDs are
`hub:<name>`, with these names and interfaces:

| Tool | Interfaces |
|---|---|
| `actors` | `actor_create`, `actor_close` |
| `team` | `team`, `progress`, `progress_set` |
| `questions` | `question_ask`, `question_answer`, `questions` |
| `messages` | `message_send`, `messages`, `message_read` |
| `claims` | `claim`, `release` |
| `calls` | `call_result`, `call_withdraw` |
| `activity` | `activity` |

Each other visible Actor with advertisements supplies one Tool, using its existing Actor ID.
Its Tool name is `manager`, a direct report's handle, or, for the root, the Actor's full path.
The interfaces keep their local names, while `call` joins that alias and the local name.
Advertisements remain visible while offline. A closed Actor receives no Tools.

Feature modules own their Tool contracts and bound operations. Actors owns lifecycle orchestration
and its read projection; Team composes progress and organization views; Questions and Messages
share communication's cursor and waiting primitive; Claims, Calls and Activity expose their state
owners. Core composes these peers and supplies their bound Tools to `capabilities.ts`. The combined
built-in schema export is derived for CLI and type consumers, rather than runtime registration.

`capabilities.ts` owns the Actor-relative projection over those supplied Tools, Registry identity
and Connections advertisements. Its exposures keep dispatch destinations private. Application
validates, audits and invokes the selected bound operation without feature handlers of its own.
Team receives that same projected catalog as invocation input for its callable interface views,
keeping the dependency graph acyclic. Connections retains the first valid descriptor per local
interface name on both advertisement writes and cached reads, including offline advertisements.
No separate catalog state or storage is needed. Clients depend on the shared domain descriptor
and Actor API, independently of how an Actor was created or which Provider executes it.

The MCP binding alone flattens a Tool into MCP Tools, one per callable interface. Each carries
`_meta["agentorg/tool"]` with the semantic Tool's identity and name, the local interface name,
and existing routing and interface flags. The Actor-side binding reconstructs the nested catalog
from this metadata and rejects missing or inconsistent metadata. MCP method and call names stay
the same; admission carries no catalog. Verification covers the concrete catalog payloads,
visibility and call authorization, identity across aliases, advertisement lifecycle, and metadata
round-trip through the assembled clients.

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

### Routing a call

When actor A calls `B.name`:
1. The core finds the interface among A's and checks the input against its input schema. A refused call is not recorded.
2. It records the call as `pending`, with the cause A names, which must be a call into A.
3. It delivers the call through B's link while B is reachable, and again each time B comes back while the call is pending. So delivery is at least once, and a handler must tolerate a repeat. A call to an unreachable actor waits.
4. It checks B's structured value against the latest advertised output schema and records the call as `done`. A value that breaks the schema, a missing value where there is a schema, or a failure records it as `failed`. Delivery likewise uses the latest advertisement's long-running support; calls do not snapshot a descriptor when created.
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
| `actor_create {name, purpose, execution?, created_at_attach?}` | Creates a report of the caller, returning it with its one-time credential. Optional `execution: {providerId, config}` requests an implementation through that Provider and adds its outcome to the result. The root alone may mark a position created as a session the user started attaches to it. |
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
| `activity {since?, limit?}` | Audit metadata for every open Actor, newest first: id, time, acting Actor, operation, target and outcome. |

When execution is requested, the Actors module creates the organizational Actor through Registry
before calling Execution. The execution client uses the selected Provider's configuration schema and
creation interface; `config` is a required JSON object. Its result is
`{providerId, status: "ready" | "failed" | "unknown", error?: {code, message}}`. The returned Actor
view is read after that call, so it includes any connection established while the Provider worked.
The Actor, credential and independently established connection survive a failed or unknown outcome.
Without `execution`, creation returns only the Actor and credential.

`ready` means the Provider returned a valid successful creation reply for execution of the
Hub-owned Actor. Provider owns local execution readiness and protected bootstrap before that reply;
native bookkeeping is its implementation detail. Hub observes the reply; Actor connectivity, MCP
initialization and model activity are separate. Hub sends one creation request, retains no retry
inputs and performs no automatic replay after uncertainty. Native resource management belongs to
the external Provider.

The Hub gives configuration description and execution creation one combined 45-second budget,
within the 60-second default caller budget. Expiry before launch returns `failed` and a late
description cannot start execution. Expiry after launch may have been sent returns `unknown`;
the Hub neither cancels nor replays it. Explicit caller timeouts retain their chosen behavior.

## Today's binding: MCP in both directions

Each Actor initiates a WebSocket at `/connection`, then sends
`connection.connect({actorId, credential?})` and receives `{connectionId}`. The handshake admits
an existing identity only. The supplied identity is immutable and the reply carries no catalog.
Credentials are required by default; omission is allowed only by explicit Hub policy, and a
supplied invalid credential always fails. Actor and Provider IDs occupy distinct namespaces.

MCP initializes separately on that same socket, with one JSON-RPC message per text frame. The
Actor's MCP client calls the Hub's server. An Actor that exposes interfaces also serves reverse
MCP requests from the Hub's client. Fixed direction dispatch sends incoming requests to the local
server and replies to the local client; request IDs remain independent in each direction.
Initialized/cancelled notifications go to the server; tool-list changes, task status and progress
go to the client. This binding uses no additional envelope or service registry.

Admission does not register Actor exposure. `connectClient` supplies no reverse MCP server and
coexists with other connections. `connectActor` explicitly advertises its interfaces, including
an empty list. Only a successful reverse initialization and tool listing replaces the delivery
owner. Candidate order is reserved before initialization, so a delayed older initialization cannot
replace a newer advertisement. Stale changes, disconnects and delivery results have no effect on
the current owner. Replacing an advertising connection closes it with 4000; closing the Actor
revokes all its admitted connections with 4001. A caller socket closes independently.

How the domain is encoded:
- **An interface is one MCP `Tool`.** The Hub's semantic Tools remain grouped in the domain and Actor API; the binding flattens them into `tools/list` entries with explicit semantic metadata. Advertisements from Actors are ordinary MCP interfaces: the Hub assigns their semantic Tool identity from the admitted Actor and ignores advertiser metadata. The core lists an Actor's interfaces again on `notifications/tools/list_changed`.
  - A tool is one-way when its output schema is the empty object.
  - It is long-running when it declares `execution.taskSupport` and its server declares `tasks.requests.tools.call`.
- **A call is `tools/call`**, with `_meta["agentorg/call"] = {id, from, cause}`. A caller names its cause with `_meta["agentorg/cause"]`.
- **A run is an MCP task.** The core sends a long-running call with `params.task`, waits on `tasks/result`, and asks again at once when the actor's `notifications/tasks/status` says the task finished. Cancelling is `tasks/cancel`, and an unknown task is a lost run.
- **An answer is a `CallToolResult`.** A done call returns B's own result, with `_meta["agentorg/call"] = {id, state}`. A pending one returns `{call, state: "pending"}`. A routed tool's listed `outputSchema` is B's or that pending shape, so that clients checking results accept both.

## The MCP adapter

The MCP adapter, `agentorg-mcp` in `src/clients/mcp/`, lets a Claude Code or Codex session fill a position. The client starts it over stdio for each session, and it connects to the core as that position with the actor library. Its project integration and hooks belong to this adapter.

- **What the session sees.** The stdio adapter has three fixed MCP tools: `attach`, `interfaces`, and `call {name, input}`. `interfaces` returns `{tools: [...]}` from the attached actor's library, with stable Tool identities, local interface descriptors and their call aliases. `call` invokes an interface using its `call` alias as `name`. The presentation's fixed controls form one semantic `agentorg` Tool, separate from the Hub catalog. Before its first turn, the client's session-start hook runs `agentorg-mcp context`, so a session that fills no position reads that it loads the `agentorg` skill and attaches before any other action. The adapter's instructions say the same.
  - `attach {actor}` fills the position the session's brief names.
  - `attach {name, purpose}`, allowed only on a session's first attach, creates its position directly under the root. The agent actor uses the root's credential for that one call.
  - The MCP controls remain fixed across attachment and resuming. The current Hub catalog is read on each `interfaces` invocation, with no adapter cache. Logical operations such as `team` are invoked as `call {name: "team", input: {}}`.
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

- **Web pages are refused.** An upgrade with an `Origin` header is refused, blocking cross-site WebSockets and DNS rebinding.
- **Admission.** `src/connection/` checks credentials through the identity owners. The network listener admits no identity itself.
- **Reconnect.** The connector dials again after a drop, performs fresh admission and initializes MCP again. It stops after 4000 or 4001.

## Provider connections

Providers initiate the same `/connection` socket with
`connection.connect({providerId, credential?})`. Exactly one Actor or Provider identity is required;
connecting registers neither. The server administrator enrolls Provider IDs and SHA-256 credential
hashes in private `<home>/providers.json` (mode 600), an array of
`{providerId, credentialHash}`. Missing configuration admits no Providers. Provider credentials and
Actor bootstrap credentials are independent opaque values.

The Hub's internal typed client calls `provider.describe({}) -> {configSchema}` and
`provider.createActor({actorId, credential?, config}) -> {actorId}` on the initiating Provider socket.
Configuration is a required JSON object; the returned Actor ID must match. Provider messages cross
the client boundary as validated results or sanitized errors, with numeric JSON-RPC codes and stable
semantic names in `error.data.code`. A lost creation reply leaves the outcome unknown and sends no
cancellation. The client performs no automatic replay.

The Provider client owns only wire interaction. Hub owns organizational identity, state and authority;
an Actor's identity survives executor replacement. Provider owns native execution management, and
the Actor client owns its separate Hub connection. The Provider contract does not define Actor
connection routing.
