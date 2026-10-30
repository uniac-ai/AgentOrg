# agentorg

AgentOrg connects coding agent sessions and programs into an organization. Each actor is a position
with a responsibility and a manager; the user is at the root. Claude Code, Codex and other clients
supply the execution. AgentOrg keeps the organization, routes calls and records its work.

Actors call their manager and direct reports; the root reaches every actor. They publish progress
and questions, exchange private messages, and claim shared resources. Standard MCP carries calls
in both directions, including long-running tasks. Managers read progress when they choose.

## Applications

The package `@agentorg/cli` distributes four independent entry points:

| Executable | Responsibility |
|---|---|
| `agentorg-server` | Run the core and manage its user service. |
| `agentorg` | Call organization operations from a terminal as an actor. |
| `agentorg-mcp` | Present an actor's operations over stdio; configure project integrations and hooks. |
| `agentorg-web` | Serve the web client, sign a browser in, and manage its own user service. |

The Node actor library (`src/actor/`) lets programs expose handlers, list Tools and call their interfaces.
The `agentorg` skill (`skills/agentorg/`) describes how a session works in a position; an
organization can add its conventions beside it.

## Set up

Ask your coding agent in the project whose sessions should join:

```
Set up AgentOrg for me in this project, following https://raw.githubusercontent.com/uniac-ai/AgentOrg/main/docs/setup.md
```

[Setup](docs/setup.md) covers services and project integrations.
[Programs](docs/programs.md) covers credentials and client connections.
[Design](docs/design.md) covers the component and layer boundaries.

## Development

Use Node 22.13 or later. Run `npm ci`, `npm run check` and `npm test`; tests build the
applications and browser app before running. AgentOrg is pre-alpha; its protocol may change.

[MIT license](LICENSE).
