# agentorg

agentorg organizes AI agent execution the way a company organizes work. Agents are work responsibilities, each with a manager: another agent, or the one human at the top, the user. Sessions in a client attach to an agent and act for it. Questions go to the manager, which answers them or carries them up, and notes and reports only go up, so everything that waits on the user lands in one place.

agentorg does not run agents. It organizes the sessions you already run, in Claude Code, Codex or any other MCP client, into one tree under you, with one page for every decision waiting on you and reports that stay in each manager's inbox until the manager acknowledges them. To install it and connect your clients, see [docs/install.md](docs/install.md).

The project has three pieces:

- **A local service**, the system of record and the control point. It holds agents and their status, the sessions that attach to them, asks to managers and the messages that go up, enforces the rules, and serves a decisions page. Agents reach it over MCP; scripts and other clients use its HTTP API or the `agentorg` command line.
- **Skills** in plain Markdown that tell any agent how to manage or execute, delegate and report.
- **Thin client adapters** for Claude Code, Codex and other MCP clients. The core requires none of them.

## Status

agentorg is pre-alpha, and its API may change. Phase 1, the model end to end on one machine, is in progress.

## Design

The design is in [docs/design.md](docs/design.md).

## License

[MIT](LICENSE)
