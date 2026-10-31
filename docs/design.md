# agentorg: design

The Hub exposes only the Tools composed from its own feature modules. Every open Actor receives
that catalog and initiates its own calls to the Hub. Actor presence means an admitted connection;
it says nothing about a native agent or control endpoint. Provider provisioning is a separate role.

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
configuration, launcher and service in a separate repository. It depends on the public Actor library
and Hub contract; browser users depend on its HTTP interface. The Hub has no dependency on that
application or its build, and organizational authority stays in the Hub's domain.

`src/runtime/` contains host mechanics: pinning an executable and its environment in a launcher,
managing one user service, reporting launcher and HTTP availability, and reporting command
errors. It imports no application and performs no organization operation. Executable paths come
from the package's `bin` map. Each service has its own launcher, service name and lifecycle, and
MCP project setup checks its own launcher and the core.

The applications share the actor, credential and attachment contracts described below.

## Layers

The domain defines its storage and Actor-connection ports. Protocol and storage adapters depend on
those contracts; the network supplies bidirectional JSON-RPC transport without domain knowledge.
The server composition root wires the concrete adapters to the domain's clients.

| Layer | Folder | Responsibility |
|---|---|---|
| Network | `src/network/` | Loopback listener, connector and duplex text channels. |
| Connection | `src/connection/` | Admission of an existing Actor or Provider and immutable identity. |
| MCP binding | `src/bindings/mcp/` | Actor client, Hub server, Tool metadata and operation results. Only this binding imports MCP. |
| Provider client | `src/provider/` | Hub's typed factory methods on an admitted Provider connection. |
| Domain | `src/domain/` | Identity, presence, explicit Hub Tools, organization and communication state. |
| Storage | `src/storage/sqlite/` | Domain records through the Store port, using `node:sqlite`. |
| Clients | `src/actor/`, `src/clients/`, external clients | List and invoke the Hub's explicit Tools as an Actor. |

`src/domain/ports.ts` defines Application, ActorConnection, Invocation, Waiting and Store. An
ActorConnection exposes only revocation. `test/layers.test.ts` checks module boundaries, the
acyclic domain import graph and the domain's independence from Node and protocol libraries.

## The domain

`src/domain/index.ts` composes peer state owners and their explicit feature Tools:

| Owner | Responsibility |
|---|---|
| `registry.ts` | Actor identity, hierarchy, credentials and lifecycle authority. |
| `connections.ts` | All admitted Actor connections, presence and revocation. |
| `execution.ts` | One optional Provider provisioning outcome for an already-created Actor. |
| `actors.ts` | Actor lifecycle and public projection, using Registry, Connections and Execution. |
| `progress.ts`, `team.ts` | Progress versions and composed organization views. |
| `communication.ts` | Questions and private messages, with their shared cursor and waiting reads. |
| `claims.ts`, `audit.ts` | Shared resource claims and append-only audit metadata. |
| `calls.ts` | Read-only historical Actor-call results, visible to the original caller. |
| `tools.ts` | Schema contracts bound to their module-owned typed operations. |
| `capabilities.ts` | Project supplied Hub Tools into public descriptors and private operations. |
| `application.ts` | Validate and invoke those operations as the admitted Actor, enforcing domain refusals and write audit. |

### Tools and interfaces

A Tool is `{id, name, interfaces}`. Each interface contains its local descriptor, a `call` alias and
an optional `read_only` hint. `(tool.id, interface.name)` identifies it. `Actor.available()` returns
these Tools; the CLI and MCP adapter's `interfaces` operation return `{tools: [...]}`.

Every open Actor receives the same seven Hub Tools and fifteen interfaces:

| Tool | Interfaces |
|---|---|
| `actors` | `actor_create`, `actor_close` |
| `team` | `team`, `progress`, `progress_set` |
| `questions` | `question_ask`, `question_answer`, `questions` |
| `messages` | `message_send`, `messages`, `message_read` |
| `claims` | `claim`, `release` |
| `calls` | `call_result` |
| `activity` | `activity` |

IDs are `hub:<name>`. Discovery and invocation use the same module-owned operations. The caller's
hierarchy and the operation's records govern domain authority; they do not add Tools. Actor IDs,
paths, cached advertisements and guessed aliases cannot introduce callable interfaces. A closed
Actor receives no Tools. `BUILTINS` is a derived schema inventory for CLI and typed consumers,
while feature modules own runtime registration.

An interface descriptor contains name, optional title/description, input/output JSON Schemas and
generic `one_way`/`long_running` flags. The MCP binding flattens the catalog and carries semantic
identity through `_meta["agentorg/tool"] = {id, name, interface, one_way, long_running}`. The Actor
client reconstructs the nested catalog from that metadata. Operation results are `done {value}`
or `refused {code, message}`; they carry no Actor-call receipt or destination.

### Records and storage

An Actor has id, name, path, purpose, manager, online state and creation/closure timestamps.
The durable identity also holds a credential hash that public views omit. Online means at least
one admitted Actor connection; multiple caller connections coexist. Closing an Actor revokes
all its connections while preserving independent Provider connections.

SQLite schema 8 stores Actor identity, progress, questions, messages, claims, historical calls
and audit records. Opening schema 7 performs one transaction: remove cached advertisements and
the session-creation marker, append failed outcomes for pending Actor calls, mark those calls
failed with an explicit retirement reason, and advance the version. Their inputs, destinations,
run references and other records remain. No historical execution is replayed or cancelled at an
external runtime. Reopening schema 8 does not repeat retirement. Other nonzero versions are
refused without migration. Fresh databases start directly at schema 8.

`call_result {call}` reads an existing receipt only for its original caller. It performs no wait,
delivery or remote action. Actor handles remain unique among open siblings, and paths describe
the organization. Actor and Team metadata contain no callable-interface or native-session fields.

### Built-ins

| Built-in | Responsibility |
|---|---|
| `actor_create {name, purpose, execution?}` | Create a report, returning its one-time credential and optional separate Provider outcome. |
| `actor_close {actor}` | The manager or root closes a leaf Actor and revokes its Hub connections. Root cannot be closed. |
| `team {actor?, depth?}` | Read organization, presence, progress, open questions and claims. Anyone may read any position. |
| `progress {actor, history?}` | Read current and optional historical progress. |
| `progress_set {state?, summary?, items?, links?}` | Replace supplied fields of the caller's progress. |
| `question_ask {to?, text, links?, options?, recommendation?, answerer?, cause?}` | Publish a question under the communication rules below. |
| `question_answer {questions, choice?, text?, recorded?}` | Answer authorized questions or record the asking session's own user answer. |
| `questions {to?, from?, open?, since?, limit?, wait?}` | Read questions, optionally waiting for a matching cursor change. |
| `message_send {to, text, links?, reply_to?}` | Send a private message. |
| `messages {box?, unread?, actor?, with?, since?, limit?, wait?}` | Read authorized correspondence, optionally waiting for a cursor change. |
| `message_read {ids}` | Mark messages addressed to the caller read. |
| `claim {resource, note, until?}` | Hold a shared resource. |
| `release {resource}` | Release the caller's claim; root may release any. |
| `call_result {call}` | Read a historical call made by the caller. |
| `activity {since?, limit?}` | Read audit metadata as any open Actor. |

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

## Actor-to-Hub MCP

Each Actor initiates a WebSocket at `/connection`, sends
`connection.connect({actorId, credential?})`, and receives `{connectionId}`. Admission requires an
existing open identity and matching credential under the default policy. The admitted principal
is immutable. Admission creates no Actor and returns no catalog.

The Actor's MCP client then initializes on that bidirectional JSON-RPC channel and calls the Hub's
MCP server. The Hub publishes its explicit Tools through `tools/list`; `tools/call` invokes one as
the admitted principal. Actors need no MCP server. Their messages cannot register advertisements
or a reverse invocation endpoint. The SDK's `connectClient` requires `url` and `actorId`, with a
credential under the default policy. It lists Tools, calls their interfaces and reconnects after
a transport drop. Progress notifications support waiting Hub reads. A request's caller identity
does not depend on an incoming call, native session or RPC cause.

## The MCP adapter

The MCP adapter, `agentorg-mcp` in `src/clients/mcp/`, is an optional client for Claude Code or Codex. Its local attachment records connect a session to an Actor; the Hub stores no native-session marker. The client starts it over stdio and it calls the Hub through the Actor library. Project integration and hooks belong to this adapter.

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

- **Opening.** A WebSocket opening error or closure rejects the initial connection and closes its socket.
- **Origin.** Upgrades with an Origin header are refused.
- **Admission.** Identity owners check credentials; the listener admits no identity itself.
- **Reconnect.** The client repeats admission and MCP initialization after a drop. Revocation code 4001 ends reconnection.

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
the Actor client initiates its own independent connection to the Hub.
