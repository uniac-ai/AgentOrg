# Set up AgentOrg's server and clients

Install the package, start the server, and configure the clients the user wants. Connect only
project folders they name; ask which if none was named. Creating positions and work are separate.

## Install

Node.js 22.13 or later and macOS or Linux are required. Check `node --version`; ask before changing
the user's Node installation. An existing newer Node can be selected through PATH. Component
launchers retain the Node they were configured with.

Install from the repository in a temporary folder:

```sh
cd "$(mktemp -d)" && git clone --depth 1 https://github.com/uniac-ai/AgentOrg . && npm ci && npm pack && npm install -g ./agentorg-cli-*.tgz
```

## Server

```sh
agentorg-server service install
agentorg-server status
```

This keeps only the core running across restarts and logins, through launchd on macOS or systemd
on Linux. It creates the organization's home, database and root credential, and pins its launcher
at `<home>/bin/agentorg-server`. Reinstall after upgrading the package or Node.

## MCP clients

Run the command for each client the user uses in a project:

```sh
agentorg-mcp connect claude-code --project <dir>
agentorg-mcp connect codex --project <dir>
```

Connect pins `<home>/bin/agentorg-mcp`, configures the project and checks through that launcher.
It requires the core, with no web-client dependency. Other project entries stay as they are:

- Claude Code gets the `org` server in `.mcp.json`, approval and hooks in
  `.claude/settings.local.json`, and the skill in `.claude/skills/`.
- Codex gets `[mcp_servers.org]` in `.codex/config.toml`, `SessionStart` context and
  `UserPromptSubmit` capture hooks in `.codex/hooks.json`, and the skill in `.agents/skills/`.

These entries name machine-local paths. The user starts a new session to pick them up; Codex also
requires project trust, enabled hooks (`features.hooks`), and review and trust of the hook
definitions through `/hooks`. Codex's MCP tool approvals apply to `attach` and actor operations;
`connect` leaves that approval policy to the user. For authorized noninteractive work, Codex
supports per-tool `mcp_servers.org.tools.<tool>.approval_mode = "approve"` configuration.
See the [official MCP configuration](https://learn.chatgpt.com/docs/extend/mcp) and
[hook documentation](https://learn.chatgpt.com/docs/hooks). Codex's hooks do not wake idle turns.
Reconnect after upgrading the package or Node.
`agentorg-mcp status --project <dir>` checks again and exits non-zero on a fault.

For another MCP client, configure a stdio server named `org` using `agentorg-mcp`, and give
its skill mechanism the package's `skills/agentorg` folder.

## Web client

When the user wants the browser client:

```sh
agentorg-web service install
agentorg-web status
```

This installs only the web service and pins `<home>/bin/agentorg-web`; it connects to the existing
core. The user runs `agentorg-web open` in their own terminal to sign in. Do not open their
one-time sign-in link for them.

## Remove components

- `agentorg-mcp disconnect <claude-code|codex> --project <dir>` removes its project entries.
- `agentorg-web service uninstall` removes the web service.
- `agentorg-server service uninstall` removes the core service.
- `npm uninstall -g @agentorg/cli` removes the package.

The home retains records and credentials; delete it only if asked.
[programs.md](programs.md) owns addresses and credentials. Every executable supports `--help` and
`--version`; `agentorg --help` lists actor operations.
