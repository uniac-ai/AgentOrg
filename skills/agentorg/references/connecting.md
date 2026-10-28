# Connecting a client to AgentOrg

This is how to connect Claude Code, Codex or another MCP client to an AgentOrg core, so that sessions in a project folder fill positions. AgentOrg's install guide, https://github.com/uniac-ai/AgentOrg/blob/main/docs/install.md, covers the same steps for a person, and installing AgentOrg and running its core besides.

Connect where the user asked, normally one project folder: sessions there join the organization, and sessions anywhere else don't. Every change below is a file in that folder.

## 1. Check that AgentOrg is running

- **The command.** `command -v agentorg node` finds both. AgentOrg needs Node.js 22.13 or later.
- **The core.** `agentorg team` prints the organization, acting as the root with the root's credential from the agentorg home. If it fails, the core isn't running or isn't where `agentorg` looks. Installing and running it are steps 1 and 2 of the install guide: do them only if the user asked you to set up AgentOrg itself, and otherwise tell the user what is missing.
- **The address and home.** The core listens on `http://127.0.0.1:8740` and keeps its home in `~/.local/share/agentorg`. When the user's core uses others, the agent actor needs `AGENTORG_URL` and `AGENTORG_HOME` in the environment its client starts it with. Otherwise leave them unset.
- **The paths.** A client started from a desktop app doesn't inherit your shell's `PATH`, so a configuration names `agentorg` by its absolute path. An `agentorg` installed with npm starts with `#!/usr/bin/env node`, so that client must also find `node`.

## 2. Claude Code

From the project folder, add the marketplace and install the plugin for this project only:

```bash
claude plugin marketplace add uniac-ai/AgentOrg --scope project
```

```bash
claude plugin install agentorg@agentorg --scope project
```

Both write to the project's `.claude/settings.json`; `--scope local` writes `.claude/settings.local.json` instead, for a setting that isn't committed. The plugin brings the agent actor's server, its hooks and this skill. It starts `agentorg` by name, so the `PATH` Claude Code starts with must reach `agentorg` and `node`, and `AGENTORG_URL` and `AGENTORG_HOME`, when needed, are set in that same environment.

**Check:** start a new session in the folder. It is told to attach before any other action, and `/mcp` shows the plugin's `org` server connected, offering `attach`.

## 3. Codex

Codex reads a project's `.codex/config.toml` once the user trusts the project, and skills from its `.agents/skills/` folder.

1. Add the agent actor to the project's `.codex/config.toml`, creating the file if needed. It's the table in AgentOrg's `adapters/codex/config.toml`, with `agentorg` named by its absolute path:

   ```toml
   [mcp_servers.org]
   command = "/absolute/path/to/agentorg"
   args = ["agent", "--client", "codex"]
   # Only when needed: the directory that holds node, and a core other than the default.
   # env = { PATH = "/directory/of/node:/usr/bin:/bin", AGENTORG_URL = "http://127.0.0.1:8740", AGENTORG_HOME = "/path/to/home" }
   ```

2. Link this skill into the project from the installed package, so that it always matches the agent actor's tools (from a clone, link its `skills/agentorg` instead):

   ```bash
   mkdir -p .agents/skills
   ```

   ```bash
   ln -s "$(npm root -g)/@agentorg/cli/skills/agentorg" .agents/skills/agentorg
   ```

3. The user trusts the project when Codex asks; until then Codex ignores the project's `.codex/config.toml`.

Whether to commit `.codex/` and `.agents/` is the user's choice.

**Check:** start a new Codex session in the folder. `/mcp` lists `org`, offering `attach`, and `/skills` lists `agentorg`.

## 4. Another MCP client

Configure a stdio MCP server named `org` for the project: the absolute path of `agentorg` as its command, `agent` as its argument, and the same environment as for Codex when needed. Give the client this skill through its skills mechanism, since the skill is in the Agent Skills format, or else this skill's `SKILL.md` as its instructions. The session then works as [codex-and-other-clients.md](codex-and-other-clients.md) describes.

**Check:** the client lists the server's `attach` tool in a new session.

## 5. Bring sessions in

- **A session the user starts** in the folder attaches by appointment, with a name and a purpose, which creates its position under the user.
- **A report's session** attaches with the actor id its manager's brief names, after the manager created its position with `actor_create`.
- **`agentorg team`** in a terminal shows the positions as they attach.
- **Not from the terminal.** A position created with `agentorg actor create` prints its credential for a program to use, and the agent actor keeps no copy, so no session can attach to it. Sessions get their positions by appointment, or from a manager session's `actor_create`.
