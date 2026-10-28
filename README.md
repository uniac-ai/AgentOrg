# agentorg

agentorg organizes AI agents and programs the way a company organizes people. You sit at the top, and the positions below you are filled by the agents and programs that do the work. Calls that need you come to your position, and you can look into any part of the organization.

- **Positions with managers.** Each actor is a position: a responsibility with a manager above it, either another actor or you, the root. A manager creates the positions under it, and closes them when their work is done.
- **Calls up and down.** An actor calls the tools its manager and its direct reports expose, and you can call any actor's. A question that needs a decision goes to the manager.
- **Standard MCP both ways.** Every actor is both an MCP client and an MCP server to the core, so what an actor exposes is its MCP tool list, and calling it is an MCP tool call. A call that takes hours, such as one waiting on a person, runs as an MCP task.
- **Nothing subscribes.** Managers read their reports' status and calls when they choose; nothing pings them on every update.

The project has these pieces:

- **The core** (`agentorg core`), the system of record and the control point. It holds the actors and their credentials, wires who may call whom, routes and records every call, and keeps the audit trail. It holds no UI.
- **The protocol** (`src/protocol/`), shared by the core and every actor: the two endpoints, the records, and the code a Node actor uses to connect.
- **The command line** (`agentorg`), which runs the core and its built-in tools from a terminal.

To install it, see [docs/install.md](docs/install.md). The design is in [docs/design.md](docs/design.md).

## Status

agentorg is pre-alpha, and its protocol may change.

## License

[MIT](LICENSE)
