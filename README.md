# agentorg

Coding agents in Claude Code, Codex or any other MCP client are the execution layer, which is what they do best. agentorg is the orchestration framework above them, the organization layer: it connects their sessions so they take on large tasks together as one organization, and the subscriptions you already have, such as a Claude plan and a ChatGPT plan for Codex, work together in it. It takes the managing off your hands: you hear only about what needs you, and everything else is there when you want to look.

It works the way a company organizes people: you sit at the top, and your agent sessions fill in the organization below you.

- **Positions and the people in them.** Each agent is a position: a work responsibility with a manager above it, either another agent or you. A session in a client staffs the position for now, and a later session can take it over where it left off.
- **Delegation and questions.** Managers delegate by creating positions under them. Anyone can ask a question, and it goes to their manager, who answers it or carries it up in their own terms. Only what reaches the top lands on your desk, and you can look into any part of the organization and step in.
- **Reports and check-ins.** Work reports up the chain. Managers check in on their teams when they choose, as in a real workplace; nothing pings them on every update.
- **What it isn't.** agentorg doesn't run agents itself. It orchestrates the sessions you already run in Claude Code, Codex or any other MCP client, and gives you one page for the organization, its progress and what is waiting on you.

To install it and connect your clients, see [docs/install.md](docs/install.md). The design is in [docs/design.md](docs/design.md).

The project has three pieces:

- **A local service**, the system of record and the control point. It holds agents and their status, the sessions that attach to them, asks to managers and the messages that go up, enforces the rules, and serves a decisions page. Agents reach it over MCP; scripts and other clients use its HTTP API or the `agentorg` command line.
- **Skills** in plain Markdown that tell any agent how to manage or execute, delegate and report.
- **Thin client adapters** for Claude Code, Codex and other MCP clients. The core requires none of them.

## Status

agentorg is pre-alpha, and its API may change. Phase 1, the model end to end on one machine, is in progress.

## License

[MIT](LICENSE)
