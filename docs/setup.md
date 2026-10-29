# Set up AgentOrg for your agent

AgentOrg organizes coding agent sessions the way a company organizes people: each session fills a position with a manager, and the user is at the root. Setup installs the `agentorg` command, keeps AgentOrg's core and its web app running as user services, and connects the project folders the user names, so that Claude Code or Codex sessions there can fill positions. Sessions in other folders are unaffected. Connect only the folders the user asked for, and ask which if they named none. Creating positions and starting work are separate tasks.

The `agentorg` commands below do every step; none needs a file edited by hand.

## Requirements

- **Node.js 22.13 or later.** Check with `node --version`. If it's older, don't change the user's default Node: tell the user, and with their agreement install Node 22 or later with the version manager they already use (nvm, fnm, Volta or Homebrew), then run the commands below with that Node's `bin` folder first on `PATH`. AgentOrg keeps using the Node it was installed with, whichever Node is the default.
- **macOS or Linux.** The services are launchd user agents on macOS and systemd user units on Linux.

## Install the command

Install the `agentorg` command from the repository, in a temporary folder:

```sh
cd "$(mktemp -d)" && git clone --depth 1 https://github.com/uniac-ai/AgentOrg . && npm ci && npm pack && npm install -g ./agentorg-cli-*.tgz
```

Running it again installs the latest version over the installed one.

## Run AgentOrg

```sh
agentorg service install
```

This starts the core, which keeps the organization's records, and the web app, and keeps both running across restarts and logins. It writes the launcher, `~/.local/share/agentorg/bin/agentorg`, through which the services and connected projects start AgentOrg on this Node, then waits until both answer. Run it again after upgrading AgentOrg or Node.

## Connect a project

Run one command per client the user uses in the project:

```sh
agentorg connect claude-code --project <dir>
```

```sh
agentorg connect codex --project <dir>
```

- **Claude Code:** the `org` MCP server in `.mcp.json`, its approval and AgentOrg's hooks in `.claude/settings.local.json`, and the `agentorg` skill in `.claude/skills/`.
- **Codex:** the `[mcp_servers.org]` table in `.codex/config.toml`, and the `agentorg` skill in `.agents/skills/`.

Each command leaves the files' other entries as they are. Its entries name paths on this machine, so they aren't for committing. It ends by checking, through the launcher, that everything answers, and exits non-zero if not.

**Another MCP client:** configure a stdio MCP server named `org` whose command is the launcher, with arguments `agent`, and give the client the skill folder `skills/agentorg` in the installed package (`npm root -g` shows where packages are installed) through its skills mechanism, or that folder's `SKILL.md` as instructions.

## The user's steps

Tell the user about these steps, since they're theirs to take:
- **Start a new session in the project.** A session that was already running doesn't pick up the new server, hooks or skill.
- **In Codex, trust the project** when Codex asks. Until then Codex ignores the project's `.codex/config.toml`.
- **Open the web app** by running `agentorg ui` in their own terminal. It opens a one-time sign-in link in their browser. Don't run it for them, since the link signs in whoever opens it.

## Setup state

| Command | Information available |
|---|---|
| `agentorg --version` | Version of the command on `PATH`. |
| `agentorg status --project <dir>` | The Node it runs on, the launcher, whether the core and the web app answer and run as services, and which clients are connected in the project. It exits non-zero on a fault and says what fixes it. |
| `agentorg <command> --help` | What a command does and which files it writes. |

## Undoing it

- `agentorg disconnect <claude-code|codex> --project <dir>` removes what `connect` wrote, and nothing else.
- `agentorg service uninstall` stops and removes the services.
- `npm uninstall -g @agentorg/cli` removes the command.

The home, `~/.local/share/agentorg`, keeps the organization's records and the root's credential. Delete it only if the user asks to.

The design is in [design.md](design.md), and connecting programs and using the command line are in [programs.md](programs.md). Problems and questions go to https://github.com/uniac-ai/AgentOrg/issues.
