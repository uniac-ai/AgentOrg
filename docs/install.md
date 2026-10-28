# Install agentorg

agentorg runs as one local core per user, and actors connect to it over MCP: the human actor for you, and programs that fill positions under you. This guide installs the package, keeps the core running, and connects actors.

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

## 3. Run the human actor

<!-- agentorg human, agentorg ui and the web app. -->

## 4. Credentials and the command line

Every actor has its own credential, a random secret that only it holds; the core stores only its hash.
- **The root.** The root's credential is in `~/.local/share/agentorg/root-credential`. If you delete that file, the core mints a new credential at its next start, and the old one stops working.
- **Other actors.** An actor's credential comes from `actor_create`, once, when its manager creates it.

From a terminal, the built-in tools run as commands over `/mcp`. Each command acts as the actor whose credential is in `AGENTORG_CREDENTIAL`, else as the root. To create a position under you and get its credential:

```bash
agentorg actor create --name builds --purpose "Run the nightly builds"
```

It prints the new actor and its `credential` as JSON. `agentorg view` shows your position, and `agentorg activity` shows the audit trail. `agentorg --help` lists every command, and `agentorg <command> --help` shows its flags.

## 5. Connect a program

A program fills a position by dialing the core's two endpoints with that position's credential, in the header `Authorization: Bearer <credential>`:

- `http://127.0.0.1:8740/mcp`, Streamable HTTP, where the program is the MCP client. Its tools are the core's built-ins, its manager's tools as `manager.<tool>`, and each direct report's as `<handle>.<tool>`.
- `ws://127.0.0.1:8740/mcp/reverse`, a WebSocket with subprotocol `mcp`, where the program is the MCP server. Its tools are the calls into it.

The core refuses requests that carry a browser `Origin` header, so connect from a local process, not from a web page. A Node program can use the actor library's `connectActor`, from `dist/src/actor/index.js` in the installed package, and never meets MCP itself. It exposes interfaces with their handlers, calls the ones available, and reconnects when its connection drops. A long-running handler just returns a promise that settles when it is ready. [design.md](design.md) describes the layers and the protocol.
