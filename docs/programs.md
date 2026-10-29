# Running AgentOrg's parts, and connecting programs

[setup.md](setup.md) sets AgentOrg up, with the core and the web app as services. This page covers what those services run, the credentials, the command line, and how a program fills a position.

## The home and the addresses

AgentOrg runs as one local core per user. The core keeps its database and the root's credential in the agentorg home, `~/.local/share/agentorg`, readable only by you, and creates the root and its credential on its first start. These variables change the defaults, for every command:
- `AGENTORG_HOME`, the home;
- `AGENTORG_PORT`, the core's port on 127.0.0.1, by default 8740;
- `AGENTORG_URL`, where actors find the core, by default `http://127.0.0.1:` and that port;
- `AGENTORG_HUMAN_PORT`, the web app's port, by default 8741.

`agentorg service install` keeps those set when it runs in the launcher, `<home>/bin/agentorg`, which the services and connected projects run.

## The core and the human actor

`agentorg core` runs the core in the foreground, which is what its service runs. It logs to stderr and stops on SIGINT or SIGTERM.

The human actor, `agentorg human`, is your side of the organization. It connects to the core as the root, with the root's credential from `AGENTORG_CREDENTIAL` or else `root-credential` in the home, and serves the web app on `http://127.0.0.1:8741`; `--port` or `AGENTORG_HUMAN_PORT` moves it.

`agentorg ui` signs your browser in to the web app with a one-time link, and opens it. The link works once, within five minutes. The session it starts lasts seven days, including across restarts of the human actor.

## Credentials and the command line

Every actor has its own credential, a random secret that only it holds; the core stores only its hash.
- **The root.** The root's credential is in `<home>/root-credential`. If you delete that file, the core mints a new credential at its next start, and the old one stops working.
- **Other actors.** An actor's credential comes from `actor_create`, once, when its manager creates it. When the manager is an agent session, the agent actor keeps the credential in `<home>/actors/` for the session that fills the position, and neither session sees it.

From a terminal, the built-in tools run as commands over `/mcp`. Each command acts as the actor whose credential is in `AGENTORG_CREDENTIAL`, else as the root. To create a position under you and get its credential:

```bash
agentorg actor create --name builds --purpose "Run the nightly builds"
```

It prints the new actor and its `credential` as JSON. `agentorg team` shows your position and its reports, and `agentorg activity` shows the audit trail. `agentorg --help` lists every command, and `agentorg <command> --help` shows its flags.

A position created this way is for a program: the agent actor keeps no copy of its credential, so no session can attach to it. Sessions get their positions by appointment, attaching with a name and a purpose, or from a manager session's `actor_create`.

## Connect a program

A program fills a position by dialing the core's two endpoints with that position's credential, in the header `Authorization: Bearer <credential>`:

- `http://127.0.0.1:8740/mcp`, Streamable HTTP, where the program is the MCP client. Its tools are the core's built-ins, its manager's tools as `manager.<tool>`, and each direct report's as `<handle>.<tool>`.
- `ws://127.0.0.1:8740/mcp/reverse`, a WebSocket with subprotocol `mcp`, where the program is the MCP server. Its tools are the calls into it.

The core refuses requests that carry a browser `Origin` header, so connect from a local process, not from a web page. A Node program can use the actor library's `connectActor`, from `@agentorg/cli/actor`, and never meets MCP itself. It exposes interfaces with their handlers, calls the ones available, and reconnects when its connection drops. A long-running handler just returns a promise that settles when it is ready. [design.md](design.md) describes the layers and the protocol.
