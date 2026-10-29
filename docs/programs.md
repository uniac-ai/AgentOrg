# Running applications and connecting programs

[setup.md](setup.md) owns service and project setup. `agentorg-server`, `agentorg-mcp` and
`agentorg-web` also run directly as independent processes.

## Home and addresses

| Variable | Default and purpose |
|---|---|
| `AGENTORG_HOME` | `~/.local/share/agentorg`, holding the database and credentials, readable only by its owner. |
| `AGENTORG_PORT` | `8740`, the core's port on 127.0.0.1. |
| `AGENTORG_URL` | `http://127.0.0.1:<core port>`, where clients find the core. |
| `AGENTORG_WEB_PORT` | `8741`, the web client's port on 127.0.0.1. |

The default home's services are `agentorg-server` and `agentorg-web`. An alternate home adds
its path's hash to each service name. Pinned launchers retain the home and addresses and run with
only `/usr/bin:/bin` on PATH.

## Actor credentials and the CLI

Every actor has a random credential; the core stores only its hash. The first server start creates
root and writes `<home>/root-credential`. Removing that file rotates the credential on the next
start. A file holding a different credential makes startup fail.

`actor_create` returns a credential once. MCP adapters keep credentials they create in
`<home>/actors/<id>` for sessions to attach, without showing them to the model. CLI creation
prints the credential and keeps no session copy. A program connects with that credential; a
session attaches through its MCP adapter or creates a position under root on first attachment.

The actor CLI uses `AGENTORG_CREDENTIAL` when set, otherwise root's local credential. Its identity
is independent of an MCP session's attachment. Creation makes a direct report of the caller:

```sh
agentorg actor create --name builds --purpose "Run the nightly builds"
agentorg team
agentorg activity
```

## Browser client

The web client currently uses `AGENTORG_CREDENTIAL` or root's local credential and presents the
root view. `agentorg-web open` mints a one-time link valid for five minutes, establishing a
seven-day cookie session that survives web-process restarts. Writes carry its CSRF token.
`GET /api/session` bootstraps that token; `GET /api/interfaces` lists offers, and
`POST /api/interfaces/<name>` calls one. The web process reaches the core through the actor library.

## Program clients

A program connects with `Authorization: Bearer <credential>`:

- `http://127.0.0.1:8740/mcp`: Streamable HTTP, with the program as MCP client. Tools include
  built-ins, its manager's as `manager.<tool>`, and each report's as `<handle>.<tool>`.
- `ws://127.0.0.1:8740/mcp/reverse`: WebSocket with subprotocol `mcp`, with the program
  as MCP server exposing its own interfaces.

The core refuses an `Origin` header, so these endpoints are for local processes. Node programs
can use `connectActor` from `@agentorg/cli/actor` to expose handlers, call interfaces and
reconnect after a drop. A long-running handler returns a promise that settles when ready.
[design.md](design.md) owns the ports and protocol.
