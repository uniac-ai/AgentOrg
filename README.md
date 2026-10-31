# agentorg

AgentOrg connects Actors into an organization. Each Actor is a position with a responsibility and
a manager; the user is at the root. Hub keeps organizational state and exposes explicit Tools.
Actors decide how to use those Tools independently of any native execution implementation.

Actors exchange private Messages, track Work and collect structured Form responses through Hub
Tools backed by `@uniac/agentic-workspace`. Hub supplies the canonical Actor directory, actual
connection presence and shared resource claims. An enrolled Provider can provision an implementation
when requested at Actor creation. Human applications, agent sessions and programs share the same authority.

## Applications

The package `@agentorg/cli` distributes three independent entry points:

| Executable | Responsibility |
|---|---|
| `agentorg-server` | Run the core and manage its user service. |
| `agentorg` | Call organization operations from a terminal as an actor. |
| `agentorg-mcp` | Present an actor's operations over stdio; configure project integrations and hooks. |

The public Node Actor library (`@agentorg/cli/actor`, in `src/actor/`) lets programs connect as an
Actor, list Hub Tools and call their interfaces. The [Human client](https://github.com/uniac-ai/OrgActor-Human)
owns the browser application and its local HTTP service in a separate repository.
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
[Workspace storage](docs/workspace-storage.md) covers the dependency pin, retained history and coordinated backups.

## Development

Use Node 22.13 or later. Run `npm ci`, `npm run check` and `npm test`; tests build the
server, clients and Actor library before running. AgentOrg is pre-alpha; its protocol may change.

[MIT license](LICENSE).
