/** Project integration and independent services, with scratch homes and a fake service manager. */

import assert from "node:assert/strict";
import { type ChildProcess, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import { nodeSupported, readLauncher } from "../src/runtime/launcher.ts";
import { service } from "../src/runtime/services.ts";
import { VERSION } from "../src/version.ts";

import { command, freePort, serving } from "./process.ts";

const SKILL = fileURLToPath(new URL("../../skills/agentorg", import.meta.url)).replace(/\/$/, "");

/** A scratch folder holding a HOME and a project, removed by `done`. */
function scratch() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-setup-")));
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home);
  mkdirSync(project);
  const env = { HOME: home, AGENTORG_HOME: join(home, "agentorg"), AGENTORG_PORT: "1" };
  return { root, home, project, env, done: () => rmSync(root, { recursive: true, force: true }) };
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Every file and link under a folder, with its contents or target. */
function snapshot(folder: string): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      const key = path.slice(folder.length + 1);
      if (entry.isSymbolicLink()) found[key] = `-> ${readlinkSync(path)}`;
      else if (entry.isDirectory()) walk(path);
      else found[key] = readFileSync(path, "utf8");
    }
  };
  walk(folder);
  return found;
}

test("Node 22.13 and later are supported, earlier ones are not", () => {
  for (const version of ["22.13.0", "22.20.1", "23.0.0", "24.22.1"]) {
    assert.equal(nodeSupported(version), true, version);
  }
  for (const version of ["20.20.2", "22.12.9", "18.0.0"]) {
    assert.equal(nodeSupported(version), false, version);
  }
});

test("the default home's services keep plain names, and any other home's carry its hash", () => {
  const before = process.env.AGENTORG_HOME;
  try {
    process.env.AGENTORG_HOME = join(userInfo().homedir, ".local", "share", "agentorg");
    assert.deepEqual(
      [service("agentorg-server", "core").name, service("agentorg-web", "web").name],
      ["agentorg-server", "agentorg-web"],
    );
    process.env.AGENTORG_HOME = join(tmpdir(), "elsewhere");
    const core = service("agentorg-server", "core").name;
    const web = service("agentorg-web", "web").name;
    assert.match(core, /^agentorg-server-[0-9a-f]{8}$/);
    assert.equal(web, core.replace("agentorg-server", "agentorg-web"));
  } finally {
    if (before === undefined) delete process.env.AGENTORG_HOME;
    else process.env.AGENTORG_HOME = before;
  }
});

test("connect writes each client's entries beside the user's own, and disconnect restores the files", async () => {
  const { project, env, done } = scratch();
  try {
    const mcp = json({ mcpServers: { docs: { command: "docs-server" } } });
    const userHook = { type: "command", command: "echo hello" };
    const settings = json({
      permissions: { allow: ["Bash(ls)"] },
      enabledMcpjsonServers: ["docs"],
      hooks: { SessionStart: [{ hooks: [userHook] }] },
    });
    const toml = 'model = "o4"\n\n[mcp_servers.docs]\ncommand = "docs-server"\n';
    mkdirSync(join(project, ".claude", "skills", "mine"), { recursive: true });
    writeFileSync(join(project, ".claude", "skills", "mine", "SKILL.md"), "mine\n");
    writeFileSync(join(project, ".mcp.json"), mcp);
    writeFileSync(join(project, ".claude", "settings.local.json"), settings);
    mkdirSync(join(project, ".codex"));
    writeFileSync(join(project, ".codex", "config.toml"), toml);
    writeFileSync(
      join(project, ".codex", "hooks.json"),
      json({
        description: "My project hooks",
        hooks: { SessionStart: [{ matcher: "startup", hooks: [userHook] }] },
      }),
    );
    const original = snapshot(project);

    for (const client of ["claude-code", "codex"]) {
      const connected = await command("mcp", ["connect", client, "--project", project], env);
      assert.match(connected.stdout, new RegExp(`connected ${client} in`));
      // The check runs the launcher with only /usr/bin and /bin on PATH, and finds no core.
      assert.match(connected.stdout, /checking through the launcher/);
      assert.match(connected.stdout, new RegExp(`^  ${client}: connected$`, "m"));
      assert.match(connected.stdout, /the core: not answering/);
      assert.equal(connected.status, 1);
    }

    const launcher = join(env.AGENTORG_HOME, "bin", "agentorg-mcp");
    const servers = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8")).mcpServers;
    assert.deepEqual(servers.docs, { command: "docs-server" });
    assert.deepEqual(servers.org, {
      command: launcher,
      args: ["--client", "claude-code"],
    });
    const local = JSON.parse(readFileSync(join(project, ".claude", "settings.local.json"), "utf8"));
    assert.deepEqual(local.permissions, { allow: ["Bash(ls)"] });
    assert.deepEqual(local.enabledMcpjsonServers, ["docs", "org"]);
    const started = local.hooks.SessionStart.flatMap((group: { hooks: unknown[] }) => group.hooks);
    assert.deepEqual(started[0], userHook);
    assert.equal(started[1].command, `'${launcher}' context --client claude-code`);
    assert.equal(started[2].command, `'${launcher}' wait --client claude-code`);
    assert.equal(started[2].asyncRewake, true);
    assert.equal(local.hooks.Stop[0].hooks[0].command, started[2].command);
    assert.match(local.hooks.UserPromptSubmit[0].hooks[0].command, /prompt --client/);
    const codex = readFileSync(join(project, ".codex", "config.toml"), "utf8");
    assert.ok(codex.startsWith(toml.trimEnd()), "the user's tables stay first");
    assert.match(
      codex,
      /\[mcp_servers\.org\]\ncommand = ".*\/bin\/agentorg-mcp"\nargs = \["--client"/,
    );
    const codexHooks = JSON.parse(readFileSync(join(project, ".codex", "hooks.json"), "utf8"));
    assert.equal(codexHooks.description, "My project hooks");
    assert.deepEqual(codexHooks.hooks.SessionStart[0], { matcher: "startup", hooks: [userHook] });
    assert.deepEqual(codexHooks.hooks.SessionStart[1].hooks, [
      {
        type: "command",
        command: `'${launcher}' context --client codex`,
        timeout: 10,
      },
    ]);
    assert.deepEqual(codexHooks.hooks.UserPromptSubmit[0].hooks, [
      {
        type: "command",
        command: `'${launcher}' prompt --client codex`,
        timeout: 10,
      },
    ]);
    assert.equal(codexHooks.hooks.Stop, undefined);
    for (const skills of [".claude/skills", ".agents/skills"]) {
      assert.equal(readlinkSync(join(project, skills, "agentorg")), SKILL);
    }

    const connectedOnce = snapshot(project);
    await command("mcp", ["connect", "claude-code", "--project", project], env);
    await command("mcp", ["connect", "codex", "--project", project], env);
    assert.deepEqual(snapshot(project), connectedOnce, "connecting again changes nothing");

    const codexPath = join(project, ".codex", "config.toml");
    writeFileSync(
      codexPath,
      `${readFileSync(codexPath, "utf8")}\n[mcp_servers.org.tools.call]\napproval_mode = "prompt"\n`,
    );
    await command("mcp", ["connect", "codex", "--project", project], env);
    assert.match(
      readFileSync(codexPath, "utf8"),
      /\[mcp_servers.org.tools.call\]\napproval_mode = "prompt"/,
    );
    const withPolicy = snapshot(project);
    await command("mcp", ["connect", "codex", "--project", project], env);
    assert.deepEqual(
      snapshot(project),
      withPolicy,
      "reconnecting preserves per-tool policy deterministically",
    );

    const status = await command("mcp", ["status", "--project", project], env);
    assert.match(status.stdout, /^ {2}claude-code: connected$/m);
    assert.match(status.stdout, /^ {2}codex: connected$/m);

    for (const client of ["claude-code", "codex"]) {
      const disconnected = await command("mcp", ["disconnect", client, "--project", project], env);
      assert.equal(disconnected.status, 0, disconnected.stderr);
    }
    assert.deepEqual(snapshot(project), original);
    const again = await command("mcp", ["disconnect", "codex", "--project", project], env);
    assert.match(again.stdout, /codex was not connected/);
  } finally {
    done();
  }
});

test("Codex reconnect replaces complete multiline values and preserves other settings and comments", async () => {
  const { project, env, done } = scratch();
  const prefix = '# Keep my defaults.\nmodel = "o4"\n\n';
  const suffix =
    "\n[mcp_servers.docs] # Keep this server.\ncommand = \"docs-server\"\n\n[mcp_servers.docs.env]\nDESCRIPTION = '''\n[mcp_servers.org.not_a_table]\n'''\n";
  const source = `${prefix}[mcp_servers.org] # Keep this comment.\ncommand = "/previous/bin/agentorg-mcp" # Pinned executable.\nargs = [\n  "--client",\n  "codex",\n] # Adapter arguments.\nrequired = true\n\n[mcp_servers.org.tools.call] # Keep this policy.\napproval_mode = "prompt"\noutput_token_limit = 1000\n${suffix}`;
  const read = (text: string) =>
    getStaticTOMLValue(parseTOML(text, { tomlVersion: "1.0" })) as {
      mcp_servers: Record<string, Record<string, unknown>>;
    };
  const original = read(source);
  try {
    mkdirSync(join(project, ".codex"));
    const path = join(project, ".codex", "config.toml");
    writeFileSync(path, source);
    await command("mcp", ["connect", "codex", "--project", project], env);
    const updated = readFileSync(path, "utf8");
    const parsed = read(updated);
    assert.deepEqual(parsed.mcp_servers.org, {
      ...original.mcp_servers.org,
      command: join(env.AGENTORG_HOME, "bin", "agentorg-mcp"),
      args: ["--client", "codex"],
    });
    assert.deepEqual(parsed.mcp_servers.docs, original.mcp_servers.docs);
    assert.ok(updated.startsWith(prefix));
    assert.ok(updated.endsWith(suffix));
    for (const comment of [
      "# Keep this comment.",
      "# Pinned executable.",
      "# Adapter arguments.",
      "# Keep this policy.",
    ]) {
      assert.ok(updated.includes(comment));
    }
    await command("mcp", ["connect", "codex", "--project", project], env);
    assert.equal(readFileSync(path, "utf8"), updated);
    const disconnected = await command("mcp", ["disconnect", "codex", "--project", project], env);
    assert.equal(disconnected.status, 0, disconnected.stderr);
    const left = read(readFileSync(path, "utf8"));
    assert.equal(left.mcp_servers.org, undefined);
    assert.deepEqual(left.mcp_servers.docs, original.mcp_servers.docs);
    const malformed =
      '[mcp_servers.org]\ncommand = "/previous/bin/agentorg-mcp"\nargs = ["sentinel-credential"';
    writeFileSync(path, malformed);
    const refused = await command("mcp", ["connect", "codex", "--project", project], env);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /is not valid TOML/);
    assert.equal((refused.stdout + refused.stderr).includes("sentinel-credential"), false);
    assert.equal(readFileSync(path, "utf8"), malformed);
  } finally {
    done();
  }
});

test("connect and disconnect leave an empty project empty, and refuse a server named org that isn't AgentOrg's", async () => {
  const { project, env, done } = scratch();
  try {
    await command("mcp", ["connect", "claude-code", "--project", project], env);
    await command("mcp", ["connect", "codex", "--project", project], env);
    await command("mcp", ["disconnect", "claude-code", "--project", project], env);
    await command("mcp", ["disconnect", "codex", "--project", project], env);
    assert.deepEqual(readdirSync(project), []);

    const theirs = json({ mcpServers: { org: { command: "their-org-server" } } });
    writeFileSync(join(project, ".mcp.json"), theirs);
    const refused = await command("mcp", ["connect", "claude-code", "--project", project], env);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /already has an MCP server named org that isn't AgentOrg's/);
    assert.deepEqual(snapshot(project), { ".mcp.json": theirs });

    const unknown = await command("mcp", ["connect", "cursor", "--project", project], env);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /name a client: claude-code or codex/);
  } finally {
    done();
  }
});

test("the launcher pins the home and addresses, quotes its paths, and runs this agentorg on a bare PATH", async () => {
  const { root, project, env, done } = scratch();
  try {
    const home = join(root, "it's a home");
    const environment = { ...env, AGENTORG_HOME: home, AGENTORG_WEB_PORT: "2" };
    await command("mcp", ["connect", "codex", "--project", project], environment);
    const launcher = join(home, "bin", "agentorg-mcp");
    const text = readFileSync(launcher, "utf8");
    assert.match(text, /AGENTORG_PORT='1'/);
    assert.match(text, /AGENTORG_WEB_PORT='2'/);
    assert.doesNotMatch(text, /AGENTORG_URL|AGENTORG_CREDENTIAL/);

    const previous = process.env.AGENTORG_HOME;
    process.env.AGENTORG_HOME = home;
    try {
      const pinned = readLauncher("agentorg-mcp");
      assert.equal(pinned?.version, VERSION);
      assert.equal(realpathSync(pinned?.node ?? ""), realpathSync(process.execPath));
    } finally {
      if (previous === undefined) delete process.env.AGENTORG_HOME;
      else process.env.AGENTORG_HOME = previous;
    }

    const bare = { env: { PATH: "/usr/bin:/bin", HOME: env.HOME }, encoding: "utf8" } as const;
    assert.equal(spawnSync(launcher, ["--version"], bare).stdout.trim(), VERSION);
    const status = spawnSync(launcher, ["status", "--project", project], bare).stdout;
    assert.ok(status.includes(`launcher: ${launcher}, on Node at `), status);
  } finally {
    done();
  }
});

/**
 * A fake launchctl or systemctl, keeping what is "loaded" as a file per service in `state`, which
 * holds the program it runs, and logging each call.
 */
function fakeManager(bin: string, state: string, log: string): string {
  mkdirSync(bin);
  mkdirSync(state);
  const name = process.platform === "darwin" ? "launchctl" : "systemctl";
  const script =
    process.platform === "darwin"
      ? `case "$1" in
  print) f="${state}/\${2##*/}"; [ -f "$f" ] || exit 113; printf '\\tstate = running\\n\\tprogram = %s\\n' "$(cat "$f")";;
  bootstrap) sed -n '/ProgramArguments/{n;n;s/.*<string>\\(.*\\)<\\/string>.*/\\1/p;}' "$3" > "${state}/$(basename "$3" .plist)";;
  bootout) rm -f "${state}/\${2##*/}";;
esac`
      : `unit="$3"; [ "$2" = disable ] && unit="$4"; f="${state}/\${unit%.service}"
case "$2" in
  show) if [ -f "$f" ]; then printf 'LoadState=loaded\\nActiveState=active\\nExecStart={ path=%s ; }\\n' "$(cat "$f")"; else echo LoadState=not-found; fi;;
  enable) sed -n 's/^ExecStart="\\(.*\\)"$/\\1/p' "$XDG_CONFIG_HOME/systemd/user/$unit" > "$f";;
  disable) rm -f "$f";;
esac`;
  writeFileSync(join(bin, name), `#!/bin/sh\necho "$*" >> "${log}"\n${script}\n`);
  chmodSync(join(bin, name), 0o755);
  return name;
}

test("each application installs and removes only its own service, and MCP needs no web client", async () => {
  const { root, home, project, done } = scratch();
  const bin = join(root, "bin");
  const state = join(root, "loaded");
  const log = join(root, "calls.log");
  const name = fakeManager(bin, state, log);
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    AGENTORG_HOME: join(home, "agentorg"),
    AGENTORG_PORT: String(await freePort()),
    AGENTORG_WEB_PORT: String(await freePort()),
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  const owned = (program: string) => {
    const previous = process.env.AGENTORG_HOME;
    process.env.AGENTORG_HOME = env.AGENTORG_HOME;
    try {
      return service(program, program);
    } finally {
      if (previous === undefined) delete process.env.AGENTORG_HOME;
      else process.env.AGENTORG_HOME = previous;
    }
  };
  const coreService = owned("agentorg-server");
  const webService = owned("agentorg-web");
  const file = (entry: { name: string }) =>
    name === "launchctl"
      ? join(home, "Library", "LaunchAgents", `${entry.name}.plist`)
      : join(env.XDG_CONFIG_HOME, "systemd", "user", `${entry.name}.service`);
  const launcher = (program: string) => join(env.AGENTORG_HOME, "bin", program);
  const core = (await serving("server", env)).process;
  let web: ChildProcess | undefined;
  try {
    writeFileSync(join(state, coreService.name), "/usr/local/bin/node\n");
    const refused = await command("server", ["service", "install"], env);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /runs \/usr\/local\/bin\/node, not .*; stop and remove it first/);
    assert.equal(existsSync(launcher("agentorg-server")), false);
    rmSync(join(state, coreService.name));

    const installed = await command("server", ["service", "install"], env);
    assert.equal(installed.status, 0, installed.stderr);
    assert.deepEqual(readdirSync(state), [coreService.name]);
    assert.equal(existsSync(file(webService)), false);
    assert.equal(existsSync(launcher("agentorg-web")), false);
    assert.match(
      installed.stdout,
      /the core: answering at .*, as service agentorg-server-[0-9a-f]{8}$/m,
    );

    const connected = await command("mcp", ["connect", "codex", "--project", project], env);
    assert.equal(connected.status, 0, connected.stdout + connected.stderr);
    assert.match(connected.stdout, /^ {2}codex: connected$/m);
    assert.doesNotMatch(connected.stdout, /^the web/m);
    assert.equal(existsSync(launcher("agentorg-web")), false);

    const serverFile = readFileSync(file(coreService), "utf8");
    const serverLauncher = readFileSync(launcher("agentorg-server"), "utf8");
    web = (await serving("web", env)).process;
    const installedWeb = await command("web", ["service", "install"], env);
    assert.equal(installedWeb.status, 0, installedWeb.stderr);
    assert.deepEqual(readdirSync(state).sort(), [coreService.name, webService.name].sort());
    assert.equal(readFileSync(file(coreService), "utf8"), serverFile);
    assert.equal(readFileSync(launcher("agentorg-server"), "utf8"), serverLauncher);
    for (const entry of [coreService, webService]) {
      assert.ok(readFileSync(file(entry), "utf8").includes(launcher(entry.program)));
      assert.equal(readFileSync(join(state, entry.name), "utf8").trim(), launcher(entry.program));
    }

    for (const program of ["server", "web"] as const) {
      const status = await command(program, ["status"], env);
      assert.equal(status.status, 0, status.stdout + status.stderr);
      assert.match(status.stdout, /^launcher: .*, on Node at /m);
    }
    const removed = await command("server", ["service", "uninstall"], env);
    assert.equal(removed.status, 0, removed.stderr);
    assert.deepEqual(readdirSync(state), [webService.name]);
    assert.equal(existsSync(file(coreService)), false);
    assert.equal(existsSync(file(webService)), true);
    const removedWeb = await command("web", ["service", "uninstall"], env);
    assert.equal(removedWeb.status, 0, removedWeb.stderr);
    assert.deepEqual(readdirSync(state), []);
    assert.equal(existsSync(file(webService)), false);
    assert.ok(existsSync(env.AGENTORG_HOME), "the home stays");
  } finally {
    for (const child of [web, core]) {
      if (!child || child.exitCode !== null) continue;
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    done();
  }
});
