# agentorg: design

Status: draft. The code builds toward this design.

## What it is

agentorg organizes AI agents and programs the way a company organizes people.
- **Actors are positions.** An actor is a position with a manager. The user is the root, the one actor without a manager.
- **Calls go up and down.** An actor calls its manager's tools and its direct reports' tools. The root calls any actor's.
- **Processing a call is the actor's own business.** The core routes and records calls; what an actor does with one is up to it.
- **Nothing subscribes.** A manager reads its reports' status and calls when it chooses.

## Components

| Component | Role |
|---|---|
| **The core** | It manages everything: actors and their credentials, connections, the wiring of who calls whom, routing, call records and the audit trail. It holds no UI. |
| **Actors** | Each is a process that fills a position. To the core it is an MCP client, whose calls out are its *available* tools, and an MCP server, whose tools are its *exposed* tools: the calls into it. |

## The protocol: MCP in both directions

The core serves two endpoints, and an actor dials both with its credential, `Authorization: Bearer <credential>`. The core never dials out.

| Endpoint | MCP roles | Transport |
|---|---|---|
| `/mcp` | the core is the server, the actor its client | Streamable HTTP. Each request stands alone, without an MCP session. |
| `/mcp/reverse` | the core is the client, the actor its server | A WebSocket the actor opens, with subprotocol `mcp` and one JSON-RPC message per text frame. The core runs an MCP client over it. |

- **An actor's tool list is its manifest.** The core learns an actor's exposed tools with `tools/list` over the reverse connection, and lists them again on `notifications/tools/list_changed`. There is no other descriptor format: the MCP `Tool` object is the standard. A tool name holds letters, digits, `_` and `-`, since dots join handles and tool names.
- **The connection layer is its own module.** It turns a credential into an actor, holds each actor's reverse connection, and tracks whether the actor is online: from the moment its tools are listed until its reverse connection ends. A newer reverse connection replaces the older, which the core closes with code 4000. Closing an actor closes its connection with code 4001. Each time an actor comes online, routing delivers what is pending on it.
- **The shared code is `src/protocol/`:** the endpoint contract, the records and the built-ins' schemas, the WebSocket transport both ends use, and `ActorConnection`. A Node actor built on the MCP SDK uses `ActorConnection` to dial both endpoints. It dials the reverse connection again after a drop, but not after code 4000 or 4001.

## Records

| Record | Fields | Rules |
|---|---|---|
| **Actor** | id; name, a handle unique among its open siblings; purpose; manager (an actor id, or null for the root); credential hash; online; exposed tools as last listed; status (`running`, `waiting`, `blocked` or `review`, with a plain-text summary); created at; closed at | Its manager creates it, and its manager or the root closes it, once its own reports are closed. Its path is its handles from the root's report down, as `release.storage`. |
| **Call** | id; from; to; tool (the callee's own name for it); input; state (`pending`, `done`, `failed` or `withdrawn`); output or error; cause (the call that led to this one); task (the MCP task the callee runs it as); created, delivered and settled at | It is recorded before it is delivered, and settles once. A result that arrives after it settled is dropped. |
| **Audit entry** | id; at; actor; operation; target; outcome | One line for each write, and for each routed call when it is created, refused and settled. |

## Wiring: who calls what

An actor's available tools, its `tools/list` on `/mcp`, are:
- the core's built-ins;
- its manager's exposed tools, named `manager.<tool>`, as in `manager.decide`;
- each direct report's exposed tools, named `<handle>.<tool>`, as in `storage.review`;
- for the root, every actor's exposed tools, named by its path, as in `release.storage.review`.

Lateral grants are deferred; they would be one table the root writes.

## Routing a call

When actor A calls `B.tool` on `/mcp`:
1. The core finds the tool in A's list and checks the input against B's `inputSchema`. A refused call is not recorded.
2. It records the call as `pending`. If A sets `_meta["agentorg/cause"]` to the id of a call into A, that call is recorded as the cause.
3. It delivers the call over B's reverse connection as `tools/call`, with `_meta["agentorg/call"] = {id, from, cause}`. It delivers it again each time B comes online while the call is pending, so delivery is at least once, and a handler must tolerate a repeat. A call to an offline actor waits.
4. It checks B's result against B's `outputSchema` and records the call as `done`. A result that breaks the schema, an `isError` result or a JSON-RPC error records it as `failed`.
5. How A's `tools/call` returns:
   - **Within the bounded wait.** A's call waits up to 30 seconds, sending progress notifications when A passed a progress token. If the call is done by then, A gets B's own result, with `_meta["agentorg/call"] = {id, state}`.
   - **Still pending.** A gets `{call, state: "pending"}`, and reads the call later with `call_result`. So that clients checking results accept both, a routed tool's listed `outputSchema` is B's or that pending shape.
   - **One-way.** A call into a one-way tool, whose output schema is the empty object, returns pending at once.

### Long-running calls

A human may answer hours later, so calls into an actor can run as MCP tasks.
- **Declaring it.** A tool declares `execution.taskSupport`, and its server declares `tasks.requests.tools.call`.
- **Delivery.** The core then sends the call with `params.task`. The actor returns a task at once, and finishes it whenever it is ready. The core waits on `tasks/result`, which returns once the task is finished.
- **Reconnects.** After a reconnect, the core asks for the same task's result again. If the actor no longer knows the task, as after a restart with an in-memory task store, the core delivers the call again, and the actor holds a fresh task. So an actor can rebuild its queue from the calls pending on it, and a reconnect alone does not deliver a call twice.
- **Withdrawal.** A withdrawn call's task is cancelled with `tasks/cancel`.
- **Tools without task support** answer within 60 seconds, or the call fails.

## Built-in tools

| Tool | What it does |
|---|---|
| `actor_create {name, purpose}` | Creates a report of the caller, and returns it with its credential. The credential is shown only once. |
| `actor_close {actor}` | The manager, or the root, closes an actor. It is refused while the actor has open reports of its own. The actor's own pending calls are withdrawn, the calls into it fail, and its connection closes. The root is never closed. |
| `status_set {state, summary}` | Sets the caller's own status. |
| `view {actor?}` | The caller's own position, or a direct report's; the root may view anyone. It holds what is pending on that actor and from whom, its own open calls, its reports with their status, its manager, and its 50 most recent settled calls. |
| `call_result {call, wait?}` | Reads a call the caller made, optionally waiting up to 600 seconds for it to settle, with progress. |
| `call_withdraw {call}` | The caller withdraws a pending call. |
| `activity {since?, limit?}` | The audit trail, newest first. Listed to the root only. |

## The core process

- **Process:** `agentorg core`, one local process under launchd or systemd, at `127.0.0.1:8740`. Its home is `~/.local/share/agentorg`, mode 700, holding the database `core.db` and the root's credential.
- **The root's credential:**
  - The first start creates the root and writes its credential to `root-credential`, mode 600.
  - Only hashes of credentials are stored, so when that file is gone the core mints a new credential.
  - When the file holds something else, the core refuses to start.
- **Security:**
  - Each actor proves its identity with its own credential, a random secret.
  - Both endpoints refuse any request that carries an `Origin` header. That blocks web pages, which could otherwise reach a local port by DNS rebinding or open a WebSocket to it.
  - Separation between actors is the wiring above, and the audit trail records every write.
- **The command line:**
  - `agentorg core` runs the core.
  - A command for each built-in, generated from its schema, runs it over `/mcp`: `agentorg actor create`, `agentorg actor close`, `agentorg status set`, `agentorg view`, `agentorg call result`, `agentorg call withdraw` and `agentorg activity`.
  - A command acts as the actor whose credential is in `AGENTORG_CREDENTIAL`, else as the root.

## Stack

- **Language and runtime:** TypeScript on Node 22.13 or later (an LTS release).
- **Libraries:**
  - **MCP:** the official TypeScript SDK, `@modelcontextprotocol/sdk`, including its experimental tasks and its JSON Schema validator.
  - **Records and requests:** Zod schemas, from which the built-ins' JSON Schemas are generated.
  - **HTTP:** Hono on `@hono/node-server`, with `ws` for the WebSocket upgrade.
  - **SQLite:** `node:sqlite`, built into Node 22.13 and later, so nothing needs a native build.
  - **CLI parsing and tests:** Node's own `util.parseArgs` and `node:test`.
  - **Lint and format:** Biome. TypeScript compiles to `dist/` for the package.
- **Distribution:** npm, as `@agentorg/cli`. The command is `agentorg`. A release workflow publishes on `v*` tags through npm Trusted Publishing, with no token.
