# agentorg: design

Status: draft. Phase 1 is in progress, and the code builds toward this design.

## What it is

agentorg organizes agent execution the way a company organizes work.
- **Agents are the organization.** An agent is a work responsibility, such as "migrate session storage", with a manager: either another agent or the user.
- **Sessions do the work.** A session is a conversation in a client (Claude Code, Codex, any MCP client) that attaches to one agent and acts for it.
- **Decisions go to the manager.** Any session can ask a question, and it goes to its agent's manager.
- **One place for the user.** Everything that waits on the user lands on one page, and the user can inspect the rest of the organization from there.

agentorg ships three things:
1. **The service:** the record, its rules, and the decisions page.
2. **The skills:** `task-execution` and `reporting`, in plain Markdown.
3. **Thin client adapters.**

## Records

| Record | Fields | Rules |
|---|---|---|
| **Agent** | id; title; purpose; manager (an agent id, or null for the user); created by (session); created at attach (true when a session created it under the user as it attached); state (`pending` until a session first attaches, then `active`, then `closed`); status: state (`running` / `waiting` / `blocked` / `review`), summary (plain text), links, blockers, updated at; created at; closed at | Its manager creates it and closes it. Closing withdraws its open asks and returns the cleanup list. Its status is set by its attached session and shows in the organization view; each status set joins the agent's status history. |
| **Session** | id; agent; client kind; client session id; machine; attached at; detached at | One attached session per agent. A new attachment (restart, resume, another machine) ends the old one. The agent's records outlive any session. |
| **Ask** | id; asking agent; asking session; to (the asking agent's manager: an agent id, or the user); title; context; options (2–6); recommendation; escalates (the child asks this one carries up); state (`open` / `answered` / `withdrawn`); answer: choice, words, by (an agent id or the user), channel (`page` / `session` / `agent`), at | It is addressed to the asker's manager automatically. Only its addressee answers it, except that the user may step in on any open ask; the answer then records `by: user`, visibly. Only the asker withdraws it. Answering or withdrawing wakes anyone waiting on it. |
| **Message** | id; from agent; to (its manager); kind (`note` or `report`); body (plain text with line breaks); evidence; sent at; read at; acknowledged at (reports only) | It only ever goes up, to the sender's manager. The recipient reads it when it chooses; nothing pushes it. A report waits until its recipient acknowledges it after review. |
| **Evidence** (phase 2) | id; message; kind (before / after / single); width; caption; file | Attached to a message. |
| **Audit** | at; session; agent; client; operation; target; channel; outcome | One line per write. |

Tasks and items are gone. An agent is the unit of work, and its status is its workstream.

## Who sees what

- **A session** sees its own agent: its status, its asks, and messages to it. It also sees its agent's direct children: their status, their asks addressed to it, and their messages.
- **The user** sees everything:
  - *"Waiting on you"*: open asks addressed to the user, which come from agents directly under them. An ask that escalates a child's ask shows the chain. Below the asks: unacknowledged reports and unread notes from those agents, with "Acknowledge" or "Mark read".
  - *The organization view*: the agent tree, each agent with its status and its counts of open asks and unread messages.
  - *Inspection*: open any agent to see its asks (with the manager each is addressed to), its messages and its sessions. The user can step in and answer any open ask from there.

## Operations

Every operation is in one contract, which the HTTP API, MCP and the CLI derive from. A session acts for the agent it is attached to; writes name the session, and the service resolves its agent.

Each operation has one of three kinds, which decides where it is served:
- **Agent operations** are MCP tools, and are also on the HTTP API and the CLI.
- **API operations** are on the HTTP API and the CLI only, for scripts, the page and the user's terminal.
- **User operations** are served only to a signed-in decisions page session, never on the API, MCP or the CLI, so the agents' bearer token cannot reach them.

An operation's name, such as `ask_open`, is its MCP tool name; the API serves it at `POST /api/ask/open`, and the CLI runs it as `agentorg ask open`.

| Operation | Kind | What it does |
|---|---|---|
| `agent_create(session, title, purpose)` | agent | Creates a child of the session's agent, and returns it for the child's brief. Agents directly under the user come only from `new_agent` at attach. |
| `agent_close(session, agent)` | agent | The manager closes a child. Refused while the child has open children, so closing goes bottom-up. Detaches its session, withdraws its open asks and returns the cleanup list. |
| `agent_close_as_user(agent)` | user | Page only: the user closes any agent, under the same bottom-up rule, such as a top-level agent created at attach by mistake. |
| `agent_list` | api | The tree. Each agent comes with two counts of what waits on it (open asks addressed to it, and unread messages to it), its attached session if any, and the time of the latest write by any of its sessions. |
| `agent_get(agent)` | api | One agent, with its sessions (current and past), its asks (opened by it and addressed to it), its messages (from it and to it), and its status history, the newest 100. It marks nothing read. |
| `session_attach(agent \| new_agent, client, client_session_id)` | agent | Attaches, ending any earlier attachment. `new_agent: {title, purpose}` creates an agent directly under the user, for a session the user started with an appointment in words; it is allowed only on a client session's first attach, and the agent is marked as created at attach. Returns facts only: the agent, its manager, its children with their status, open asks addressed to it, its own asks with any answers, and its inbox. Gives no role verdict. |
| `session_context(client, client_session_id)` | agent | Returns the same facts, read-only. `facts: null` when the session is unknown. |
| `status_set(session, state, summary, links, blockers)` | agent | Sets the status of the session's agent. |
| `ask_open(session, title, context, options, recommendation, escalates?)` | agent | Opens an ask to the agent's manager. `escalates` lists open asks addressed to the agent that this one carries up. |
| `ask_get`, `ask_wait`, `ask_withdraw` | agent | `ask_wait` returns once the ask is answered or withdrawn, and sends MCP progress notifications while it waits. Only the asking agent withdraws. |
| `ask_answer(session, ask, choice?, words?)` | agent | Answers an open ask addressed to the session's agent, with channel `agent`. |
| `ask_record_answer(session, ask, words, choice?)` | agent | Records an answer the user gave inside the asking session, for an ask addressed to the user, with channel `session`. |
| `ask_answer_as_user(ask, choice?, words?)` | user | Page only: any open ask, with channel `page` and `by: user`. |
| `ask_list(state)` | api | Every ask in that state, whoever it is addressed to, with the agents it refers to, so the page can build escalation chains. |
| `message_send(session, kind, body)` | agent | Sends a note or a report to the agent's manager. |
| `inbox_read(session)` | agent | Reads the agent's unread messages and its unacknowledged reports, and marks them read. |
| `message_ack(session, message)` | agent | The recipient acknowledges a report after review. |
| `message_read_as_user(message)`, `message_ack_as_user(message)` | user | Page only: mark a note read, or acknowledge a report, from an agent directly under the user. |
| `audit_list`, `ui_login_link` | api | Read the audit trail; mint the page's sign-in link. |

No operation subscribes. A session that needs an answer before it can go on may wait on its own ask with `ask_wait`, or with `agentorg ask wait`. Managers read their children's status, asks and messages when they check in.

## The service

- **Process:** one local process under launchd or systemd, at `127.0.0.1:8740`, with its home in `~/.local/share/agentorg` (database, token, logs).
- **Surfaces:**
  - MCP over Streamable HTTP at `/mcp`;
  - the stdio proxy, `agentorg mcp --client <kind> --client-session-env <VAR>`;
  - the HTTP API at `POST /api/{subject}/{verb}`;
  - the decisions page at `/`.
- **Security:**
  - The MCP and API surfaces require a bearer token from a mode-600 file, and refuse any request that carries a browser `Origin` header.
  - The page signs in with a one-time link from `agentorg ui`, then uses an HttpOnly, SameSite=Strict cookie and CSRF tokens on every form. A strict Content-Security-Policy runs no scripts.
  - Separation between sessions and the user is by convention, made visible by the audit trail.
- **CLI:**
  - generated from the contract, plus `serve`, `mcp`, `ui` and `ask wait`;
  - `ask wait` exits 0 when the ask is answered, 2 when it's withdrawn, and 1 on timeout or error;
  - `session context` prints nothing and exits 0 when the session is unknown or the service is down.

## Stack

- **Language and runtime:** TypeScript on Node 22.13 or later (an LTS release).
- **Libraries:**
  - MCP: the official TypeScript SDK, `@modelcontextprotocol/sdk`.
  - The contract: Zod schemas, with the committed `openapi.json` generated from them and CI failing on drift.
  - HTTP: Hono, which the MCP SDK already depends on. The page renders with Hono's JSX, which escapes by default.
  - SQLite: `node:sqlite`, built into Node 22.13 and later, so nothing needs a native build.
  - CLI parsing and tests: Node's own `util.parseArgs` and `node:test`.
  - Lint and format: Biome. TypeScript compiles to `dist/` for the package.
- **Distribution:** npm, as `@agentorg/cli`. The command is `agentorg`. A release workflow publishes on `v*` tags through npm Trusted Publishing, with no token.

## Client adapters

- **Claude Code:** a plugin from this repository. It brings the skills, the stdio MCP server, and a SessionStart hook that calls `agentorg session context`.
- **Codex:** a `config.toml` snippet for stdio or HTTP, and installing the skills.
- **Any MCP client:** HTTP plus the token.

## Phases

1. **The model end to end on one machine:**
   - the contract, store, service, MCP, API, CLI, page and adapters in TypeScript;
   - Python removed;
   - an end-to-end check covering:
     - a manager creates a child, and a session attaches to it;
     - the child asks its manager, and the manager answers;
