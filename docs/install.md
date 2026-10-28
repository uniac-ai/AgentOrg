# Install agentorg

agentorg runs as one local service per user. Agents reach it over MCP, either through `agentorg mcp`, a stdio proxy, or directly over HTTP. This guide installs the package, keeps the service running, and connects Claude Code, Codex or any other MCP client.

## 1. Install the package

agentorg needs Node.js 22.13 or later. Clone the repository, build it, and install it globally with npm:

```bash
git clone https://github.com/uniac-ai/AgentOrg agentorg
```

```bash
cd agentorg
```

```bash
npm ci
```

```bash
npm run build
```

```bash
npm install -g .
```

npm links the clone into its global folder as `$(npm root -g)/@agentorg/cli` and puts the `agentorg` command in its global bin directory. Later steps take the service files and the skills from that folder. To upgrade, run `git pull`, `npm ci` and `npm run build` in the clone.

## 2. Run the core

`agentorg core` runs the core in the foreground. It listens on `127.0.0.1:8740` and keeps its database and the root's credential in the agentorg home, `~/.local/share/agentorg`, creating the root and its credential on its first start. `AGENTORG_PORT` and `AGENTORG_HOME` change those defaults, and actors then find the core through `AGENTORG_URL`. To keep it running, install it as a user service.

### macOS (launchd)

launchd expands neither `~` nor environment variables, and it runs jobs with only the system directories on `PATH`, where it finds no `node` installed by Homebrew or a version manager. So the plist in the package's `service/` folder holds placeholders for the paths of `node`, `agentorg` and the agentorg home. These commands create the home readable by you only, since it holds the root's credential and the database, then fill in the placeholders, install the plist as a user agent, and load it:

```bash
mkdir -p -m 700 ~/.local/share/agentorg ~/.local/share/agentorg/logs
```

```bash
sed -e "s|@NODE@|$(command -v node)|" -e "s|@AGENTORG@|$(command -v agentorg)|" -e "s|@AGENTORG_HOME@|$HOME/.local/share/agentorg|" "$(npm root -g)/@agentorg/cli/service/agentorg.plist" > ~/Library/LaunchAgents/agentorg.plist
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/agentorg.plist
```

launchd restarts the service whenever it exits and starts it at login. Its output goes to `~/.local/share/agentorg/logs/core.log`. To stop it, run `launchctl bootout gui/$(id -u)/agentorg`. The plist pins the paths of `node` and `agentorg` from when you filled it in, so after upgrading or switching Node.js, stop the service, fill in the plist again and load it.

### Linux (systemd)

The unit names `node` and `agentorg` by their absolute paths too, since the systemd user manager's `PATH` may hold neither:

```bash
mkdir -p ~/.config/systemd/user
```

```bash
sed -e "s|@NODE@|$(command -v node)|" -e "s|@AGENTORG@|$(command -v agentorg)|" "$(npm root -g)/@agentorg/cli/service/agentorg.service" > ~/.config/systemd/user/agentorg.service
```

```bash
systemctl --user daemon-reload
```

```bash
systemctl --user enable --now agentorg
```

systemd restarts the service whenever it exits and starts it with your user session. Read its output with `journalctl --user -u agentorg`. To keep it running while you are logged out, run `loginctl enable-linger`. The unit pins the same paths, so after upgrading or switching Node.js, fill it in again and run `systemctl --user daemon-reload` and `systemctl --user restart agentorg`.

### The decisions page

`agentorg ui` opens the decisions page in your browser, signed in.

## 3. Connect Claude Code

The repository is a Claude Code plugin marketplace with one plugin, `agentorg`:

```bash
claude plugin marketplace add uniac-ai/AgentOrg
```

```bash
claude plugin install agentorg@agentorg
```

The plugin adds:

- **The skills** `agentorg:task-execution` and `agentorg:reporting`.
- **The MCP server** `agentorg`, over stdio through `agentorg mcp`. The proxy reads the token from the agentorg home, and Claude Code's session id from the `CLAUDE_CODE_SESSION_ID` variable that Claude Code sets.
- **A SessionStart hook.** When the session is already attached to an agent, the hook prints its facts at start, resume, clear and compaction: the agent, its manager, its children with their status, the open asks addressed to it, its own asks with any answers, and its inbox. A session not yet attached gets nothing, and neither does any session while the service is down. Sessions attach by calling `session_attach`, as the task-execution skill tells them to.

The plugin carries no version number, so each install takes the repository's latest commit, and `claude plugin update agentorg@agentorg` brings later changes to the skills. `claude plugin validate` warns about the missing version; that is expected.

### Over HTTP instead

To connect Claude Code to the service over HTTP, add a user-scope server and turn off the plugin's `agentorg` server in `/mcp`:

```bash
claude mcp add --scope user --transport http agentorg-http http://127.0.0.1:8740/mcp --header 'Authorization: Bearer ${AGENTORG_TOKEN}' --header 'Agentorg-Client: claude-code'
```

Keep the single quotes. Claude Code stores `${AGENTORG_TOKEN}` as written and reads the variable each time it connects, so the token stays out of its configuration file. Start Claude Code with the variable set:

```bash
export AGENTORG_TOKEN="$(cat ~/.local/share/agentorg/token)"
```

## 4. Connect Codex

Add one of the two tables in [`adapters/codex/config.toml`](../adapters/codex/config.toml) to `~/.codex/config.toml`:

- **stdio**, the default: Codex starts `agentorg mcp`. Codex passes a stdio server only a fixed set of environment variables, among them `HOME`, which is all the proxy needs to find the token. If you set `AGENTORG_HOME` or `AGENTORG_URL`, list them in the table's `env_vars`.
- **HTTP**: Codex connects to the service and sends the token from the `AGENTORG_TOKEN` variable, set as shown above.

Codex loads skills from `~/.agents/skills` and follows symlinked skill folders. Link the two skills from the installed package, so they change only when agentorg is upgraded:

```bash
mkdir -p ~/.agents/skills
```

```bash
ln -s "$(npm root -g)/@agentorg/cli/skills/task-execution" "$(npm root -g)/@agentorg/cli/skills/reporting" ~/.agents/skills/
```

## 5. Connect any other MCP client

Point the client at the service's Streamable HTTP endpoint, `http://127.0.0.1:8740/mcp`, with the header `Authorization: Bearer <token>`. The token is in `~/.local/share/agentorg/token`. The optional headers `Agentorg-Client` and `Agentorg-Client-Session-Id` name the client and its own session id. The service refuses requests that carry a browser `Origin` header, so connect from a local process, not from a web page.

A client that only starts stdio servers runs `agentorg mcp --client <name>` instead. If the client puts its session id in an environment variable, add `--client-session-env <variable>`.

Agents that load skills get them from the `skills/` folder in `$(npm root -g)/@agentorg/cli`.
