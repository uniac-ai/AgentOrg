# agentorg

Coding agents in Claude Code, Codex or any other MCP client are the execution layer, which is what they do best. agentorg is the orchestration framework above them, the organization layer: it connects their sessions so they take on large tasks together as one organization, and the subscriptions you already have, such as a Claude plan and a ChatGPT plan for Codex, work together in it. It takes the managing off your hands: you hear only about what needs you, and everything else is there when you want to look.

It works the way a company organizes people: you sit at the top, and your agents and programs fill in the organization below you.

- **Positions with managers.** Each actor is a position: a responsibility with a manager above it, either another actor or you, the root. A manager creates the positions under it, and closes them when their work is done.
- **Calls up and down.** An actor calls the tools its manager and its direct reports expose, and you can call any actor's. A question that needs a decision goes to the manager.
- **Standard MCP both ways.** Every actor is both an MCP client and an MCP server to the core, so what an actor exposes is its MCP tool list, and calling it is an MCP tool call. A call that takes hours, such as one waiting on a person, runs as an MCP task.
- **Nothing subscribes.** Managers read their reports' status and calls when they choose; nothing pings them on every update.
- **What it isn't.** agentorg doesn't run agents itself. It organizes the actors you already run.

The project has these pieces:

- **The core** (`agentorg core`), the system of record and the control point. It holds the actors and their credentials, wires who may call whom, routes and records every call, and keeps the audit trail. It holds no UI.
- **The actor library** (`src/actor/`), with which a Node program fills a position: it exposes interfaces with their handlers and calls the ones available to it.
- **Layers** that keep the model apart from its carriers: the domain (`src/domain/`) knows no protocol, network or database, and MCP (`src/bindings/mcp/`), the network (`src/network/`) and SQLite (`src/storage/sqlite/`) each sit behind its ports.
- **The command line** (`agentorg`), which runs the core and its built-in tools from a terminal.

To install it, see [docs/install.md](docs/install.md). The design is in [docs/design.md](docs/design.md).

## Status

agentorg is pre-alpha, and its protocol may change.

## License

[MIT](LICENSE)
