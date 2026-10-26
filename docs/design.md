# agentorg: design

Status: draft. Phase 1 is in progress, and the code builds toward this design.

## What it is

agentorg organizes agent execution the way a company organizes work:
- **Sessions form a hierarchy** under one human, the user.
- **A session manages or executes.** Managers delegate one level down. Reports and decisions travel one level up.
- **Everything that waits on the user lands in one place.**

The project has three pieces:
1. **The service.** It holds the record (tasks, sessions, asks, workstreams, evidence, reports), enforces the reporting rules, and serves the decisions page.
2. **The skills.** `task-execution` covers how a session manages or executes, delegates and reports. `reporting` covers what a report says. Both are plain Markdown, usable by any agent that loads skills.
3. **Thin client adapters** for Claude Code, Codex and others. None of them is required by the core.

## Goals

1. **One place for every open decision**, across all sessions and tasks, answerable there. The answer reaches the session that asked.
2. **One record**, readable and writable by any client.
3. **Rules as code.** The service validates the reporting structure: asks with context, options and a recommendation; only open items; no logs.
4. **Durable reports from child to parent.** Unreviewed reports keep coming back until the parent acknowledges them.
5. **Context at start.** Each session gets its parent, task, owed asks and inbox before it acts.
6. **Nothing tied to one client or host.** The service is a plain local process that can move to a shared host unchanged.

## The service

### One local process, four surfaces

It runs as a user service (launchd on macOS, a systemd user unit on Linux), listening on `127.0.0.1`. Every surface shares one contract.

| Surface | For | Notes |
|---|---|---|
| **MCP over Streamable HTTP**, at `/mcp` | Any MCP client that speaks HTTP | The agents' tool set |
| **MCP over stdio**, as `agentorg mcp` | Clients that only spawn stdio servers | A thin proxy to the service. It reads the client's environment, so a client-provided session id arrives without the agent passing it. |
| **HTTP JSON API**, described by a committed `openapi.json` | Scripts, non-MCP agents | The contract itself; CI fails if the document drifts from the models |
| **The decisions page**, at `/` | The user, in any browser | Every open ask with answer buttons, then open workstreams. Server-rendered, with no build step and no CDN. |

The **`agentorg` CLI** is generated from the contract. It covers every agent and API operation, plus `agentorg ask wait`, `agentorg session start`, `agentorg session context`, `agentorg mcp` and `agentorg ui`.

### Stack

- **Python 3.11+, FastAPI and Pydantic.** The OpenAPI document comes from the models, and the official MCP Python SDK mounts in the same app.
- **Storage:** SQLite in WAL mode, plus a files directory for evidence, under `~/.local/share/agentorg/`. Backing up means copying that directory.
- **Distribution:** published to PyPI as `agentorg`.

### Records

| Record | Fields | Notes |
|---|---|---|
| Task | id, title, project (free text: a repo, an area), owner session, parent task, state | |
| Session | id (issued by the service), client kind, client session id (if the client has one), title, parent session, task, machine, started, archived | The hierarchy as data. The session names its role itself; the record holds none. |
| Ask | task, asking session, title, context (two or three sentences), options[], recommendation, state (open / answered / withdrawn), answer {choice, the user's words, channel, time} | The unit of the decisions page |
| Item | task, title, state (waiting / review / running / blocked), summary (short plain text), links, evidence[], blockers (who unblocks), child session | Resolving it removes it, so only open items show |
| Evidence | id, item, kind (before / after / single), width, caption, file, content type | Uploaded once; parent and child reference the same file |
| Report | from, to, outcome, open asks, evidence[], sent, acknowledged | A durable mailbox; acknowledging is the parent's review |

### Operations

Every operation has one of three kinds, which decides where it is served:
- **Agent operations** are MCP tools, and are also on the HTTP API and the CLI.
- **API operations** are on the HTTP API and the CLI only, for scripts and the user's terminal: `ask.list`, `item.list` and `audit.list`, which return the tasks and sessions they refer to, and `ui.login_link`.
- **User operations** are served only to a signed-in decisions page session, never on the API, MCP or the CLI, so the agents' bearer token cannot reach them. Answering an ask, `ask.answer`, is the only one.

On MCP and in the API, an operation's name uses an underscore (`session_start`); the CLI runs it as `agentorg session start`. Writes name the acting session in the request, and the audit trail records it.

### Agent tools (MCP and CLI)

- `session.start(client, client_session_id?, title, parent?, task?)` → a session id and facts only: parent, task, owed asks with any answers, unacknowledged reports. The skill decides the session's role from these facts; the service gives no verdict. Starting again with the same client and client session id resumes the session.
- `session.context(client, client_session_id)` → the same facts for a client session already started, and nothing otherwise. It never starts or changes anything, so a client hook can call it on startup, resume and compaction.
- `task.open` / `task.close`
- `ask.open` → an ask id. `ask.get` reads its state.
- `ask.wait(id)` blocks until the ask is answered or withdrawn. Over MCP it sends progress notifications so the call isn't timed out. `agentorg ask wait <id>` is the same as a long poll, meant to run in the background.
- `ask.record_answer` stores an answer the user gave inside the asking session: their words quoted, channel `session`, only for asks that session opened.
- `ask.withdraw` withdraws an open ask that no longer needs the user, only for asks that session opened. It leaves the page.
- `item.put` / `item.resolve`
- `evidence.add` → a local file path, or bytes over the HTTP API
- `report.send` / `inbox.read` / `report.ack`
- `session.archive` → the cleanup list: the session's open items and their evidence, plus the open asks archiving withdrew

The agents' tool set can't answer asks in general. Answers come from the decisions page, through the user operation `ask.answer`, or from `ask.record_answer` for the asking session's own conversation.

### How an answer reaches the session that asked

Each client uses whichever it supports:
1. **Background wait.** `agentorg ask wait <id>` exits when the ask is answered. Any agent that runs a background process and is woken when it exits gets the answer that way.
2. **Blocking tool.** `ask.wait` over MCP, for a session with nothing else to do.
3. **Pull.** The next `session.start`, `session.context` or `ask.get` returns it.

### The decisions page

- **It lists every open ask**, grouped by project and task, oldest first. Each shows its context, its options as buttons with the recommendation marked, and the session that asked.
- **Answering** records the choice, an optional note in the user's words, and channel `page`. Any wait on that ask then returns.
- **Below the asks**, open workstreams by task, with state, links and evidence images.

### Control over sessions

- **Validation:** refuses an ask without context, options and a recommendation; an item without a state; a summary past a size cap.
- **Start context:** `session.start` returns the facts above, and `session.context` returns them without starting a session. The `task-execution` skill tells every agent to call `session.start` first.
- **Instructions:** the MCP server's instructions carry the short contract, under 4,096 characters, the smallest cap among known clients.
- **Review tracking:** unacknowledged child reports and open asks return on every `session.start` and `inbox.read`.
- **Cleanup:** `session.archive` withdraws the child's open asks and gives its manager the list it clears.

### Security

- **Binding:** `127.0.0.1` only.
- **Agent access:** the MCP and API surfaces require a bearer token read from a mode-600 file. They reject requests carrying a browser `Origin` header, which blocks DNS rebinding from web pages.
- **The decisions page** uses a cookie set from a one-time link that `agentorg ui` opens. Answers carry a CSRF token. User operations, such as answering an ask, are served only there.
- **Separation is by convention, made visible by an audit trail.** Agents run as the same OS user, so a determined agent could reach anything the user can. Every write logs `{session, client, operation, target, channel, outcome}`.

### Beyond one machine

The default serves one machine. A tunnel (SSH, Tailscale) or running the same process on a shared host extends it. Both are deploy choices; neither changes the code.

## The skills

- **`skills/task-execution/`:** the session hierarchy, manage or execute, creating children, reporting up, decisions, and per-client notes (Claude Code, Codex). It refers to "the user" and loads no organization's specifics.
- **`skills/reporting/`:** a message every time; the service holds the record. It covers what an ask, an item and a report contain, and when to open, resolve and acknowledge each.
- **Organization specifics** live in the adopter's own layer, such as names and pronouns, where status documents live, and naming conventions. The skills say where that layer plugs in.

## Client adapters

- **Claude Code** (`adapters/claude-code/`), packaged as a Claude Code plugin from this repository: the skills, the MCP server entry, and an optional SessionStart command hook that runs `agentorg session context` and injects its output.
  - Claude Code wakes a session when a background command exits, so `agentorg ask wait` delivers answers.
  - `CLAUDE_CODE_SESSION_ID` reaches the stdio proxy and hooks.
- **Codex** (`adapters/codex/`): a `config.toml` snippet for stdio or HTTP (`bearer_token_env_var`), and the skills directory.
- **Any MCP client:** the HTTP endpoint and its token.

## Repository layout

```
agentorg/
  LICENSE                MIT
  README.md
  pyproject.toml         package `agentorg`: service and CLI
  openapi.json           the contract, CI-checked against the models
  src/agentorg/
    models/              Pydantic records and requests
    store/               SQLite
    api/                 FastAPI routes
    mcp/                 MCP tools, mounted in the app; stdio proxy
    page/                the decisions page
    cli/                 generated from the contract
  skills/
    task-execution/SKILL.md
    reporting/SKILL.md
  adapters/
    claude-code/         plugin manifest, MCP entry, hook
    codex/               config snippet
  service/               launchd plist, systemd user unit
  tests/
```

## Phases

1. **Decisions end to end on one machine:**
   - the models, store, API, MCP (HTTP and stdio), decisions page, CLI with `ask wait`, and service units;
   - the two skills in generic form;
   - the Claude Code and Codex adapters.
2. **Evidence:** `evidence.add`, images on the page, and a screenshot capture helper with naming.
3. **When needed:** reach beyond one machine, and optional extra views.
