# agentorg

agentorg organizes AI agent execution the way a company organizes work. Agent sessions form a hierarchy under one human, the user. A session either manages, delegating to child sessions one level down, or executes. Reports and decisions travel up one level at a time, and every decision waiting on the user lands in one place, where the user can answer it.

agentorg does not run agents. It organizes the sessions you already run, in Claude Code, Codex or any other MCP client, into one tree under you, with one page for every decision waiting on you and reports that stay in each parent's inbox until the parent acknowledges them. To install it and connect your clients, see [docs/install.md](docs/install.md).

The project has three pieces:

- **A local service**, the system of record and the control point. It holds tasks, sessions, asks, workstreams, evidence and reports, validates the reporting rules, and serves a decisions page. Agents reach it over MCP; scripts and other clients use its HTTP API or the `agentorg` command line.
- **Skills** in plain Markdown that tell any agent how to manage or execute, delegate and report.
- **Thin client adapters** for Claude Code, Codex and other MCP clients. The core requires none of them.

## Status

Phase 1, decisions end to end on one machine, is in progress. Nothing is released yet.

## Design

The design is in [docs/design.md](docs/design.md).

## License

[MIT](LICENSE)
