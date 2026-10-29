/**
 * Setting AgentOrg up, run as its users run it: `agentorg connect` and `disconnect` against project
 * folders that already hold the user's own entries, and `agentorg service` against a fake service
 * manager on PATH, so that no test loads a real service.
 */

import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn, spawnSync } from "node:child_process";
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
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { nodeSupported, readLauncher } from "../src/setup/launcher.ts";
import { services } from "../src/setup/services.ts";
import { VERSION } from "../src/version.ts";

const BIN = fileURLToPath(new URL("../src/cli/bin.js", import.meta.url));
const SKILL = fileURLToPath(new URL("../../skills/agentorg", import.meta.url)).replace(/\/$/, "");

interface Ran {
  status: number;
  stdout: string;
  stderr: string;
}

async function agentorg(args: string[], env: Record<string, string>): Promise<Ran> {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [BIN, ...args], {
      env: { PATH: process.env.PATH ?? "", ...env },
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string };
    return { status: code, stdout, stderr };
  }
}

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
      services().map((service) => service.name),
      ["agentorg", "agentorg-human"],
    );
    process.env.AGENTORG_HOME = join(tmpdir(), "elsewhere");
    const [core, human] = services().map((service) => service.name);
    assert.match(core ?? "", /^agentorg-[0-9a-f]{8}$/);
    assert.equal(human, `${core}-human`);
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
    const original = snapshot(project);

    for (const client of ["claude-code", "codex"]) {
      const connected = await agentorg(["connect", client, "--project", project], env);
      assert.match(connected.stdout, new RegExp(`connected ${client} in`));
      // The check runs the launcher with only /usr/bin and /bin on PATH, and finds no core.
      assert.match(connected.stdout, /checking through the launcher/);
      assert.match(connected.stdout, new RegExp(`^  ${client}: connected$`, "m"));
      assert.match(connected.stdout, /the core: not answering/);
      assert.equal(connected.status, 1);
    }

    const launcher = join(env.AGENTORG_HOME, "bin", "agentorg");
    const servers = JSON.parse(readFileSync(join(project, ".mcp.json"), "utf8")).mcpServers;
    assert.deepEqual(servers.docs, { command: "docs-server" });
    assert.deepEqual(servers.org, {
      command: launcher,
      args: ["agent", "--client", "claude-code"],
    });
    const local = JSON.parse(readFileSync(join(project, ".claude", "settings.local.json"), "utf8"));
    assert.deepEqual(local.permissions, { allow: ["Bash(ls)"] });
    assert.deepEqual(local.enabledMcpjsonServers, ["docs", "org"]);
    const started = local.hooks.SessionStart.flatMap((group: { hooks: unknown[] }) => group.hooks);
    assert.deepEqual(started[0], userHook);
    assert.equal(started[1].command, `'${launcher}' agent context --client claude-code`);
    assert.equal(started[2].command, `'${launcher}' agent wait --client claude-code`);
    assert.equal(started[2].asyncRewake, true);
    assert.equal(local.hooks.Stop[0].hooks[0].command, started[2].command);
    assert.match(local.hooks.UserPromptSubmit[0].hooks[0].command, /agent prompt --client/);
    const codex = readFileSync(join(project, ".codex", "config.toml"), "utf8");
    assert.ok(codex.startsWith(toml.trimEnd()), "the user's tables stay first");
    assert.match(codex, /\[mcp_servers\.org\]\ncommand = ".*\/bin\/agentorg"\nargs = \["agent"/);
    for (const skills of [".claude/skills", ".agents/skills"]) {
      assert.equal(readlinkSync(join(project, skills, "agentorg")), SKILL);
    }

    const connectedOnce = snapshot(project);
    await agentorg(["connect", "claude-code", "--project", project], env);
    await agentorg(["connect", "codex", "--project", project], env);
    assert.deepEqual(snapshot(project), connectedOnce, "connecting again changes nothing");

    const status = await agentorg(["status", "--project", project], env);
    assert.match(status.stdout, /^ {2}claude-code: connected$/m);
    assert.match(status.stdout, /^ {2}codex: connected$/m);

    for (const client of ["claude-code", "codex"]) {
      const disconnected = await agentorg(["disconnect", client, "--project", project], env);
      assert.equal(disconnected.status, 0, disconnected.stderr);
    }
    assert.deepEqual(snapshot(project), original);
    const again = await agentorg(["disconnect", "codex", "--project", project], env);
    assert.match(again.stdout, /codex was not connected/);
  } finally {
    done();
  }
});

test("connect and disconnect leave an empty project empty, and refuse a server named org that isn't AgentOrg's", async () => {
  const { project, env, done } = scratch();
  try {
    await agentorg(["connect", "claude-code", "--project", project], env);
    await agentorg(["connect", "codex", "--project", project], env);
    await agentorg(["disconnect", "claude-code", "--project", project], env);
    await agentorg(["disconnect", "codex", "--project", project], env);
    assert.deepEqual(readdirSync(project), []);

    const theirs = json({ mcpServers: { org: { command: "their-org-server" } } });
    writeFileSync(join(project, ".mcp.json"), theirs);
    const refused = await agentorg(["connect", "claude-code", "--project", project], env);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /already has an MCP server named org that isn't AgentOrg's/);
    assert.deepEqual(snapshot(project), { ".mcp.json": theirs });

    const unknown = await agentorg(["connect", "cursor", "--project", project], env);
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
    const environment = { ...env, AGENTORG_HOME: home, AGENTORG_HUMAN_PORT: "2" };
    await agentorg(["connect", "codex", "--project", project], environment);
    const launcher = join(home, "bin", "agentorg");
    const text = readFileSync(launcher, "utf8");
    assert.match(text, /AGENTORG_PORT='1'/);
    assert.match(text, /AGENTORG_HUMAN_PORT='2'/);
    assert.doesNotMatch(text, /AGENTORG_URL|AGENTORG_CREDENTIAL/);

    const previous = process.env.AGENTORG_HOME;
    process.env.AGENTORG_HOME = home;
    try {
      const pinned = readLauncher();
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

/** A port nothing listens on yet. */
async function freePort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** Start an agentorg command and wait until its stderr says it serves. */
async function serving(args: string[], env: Record<string, string>): Promise<ChildProcess> {
  const child = spawn(process.execPath, [BIN, ...args], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  await new Promise<void>((resolve, reject) => {
    child.stderr?.on("data", (chunk: Buffer) => {
      log += chunk.toString();
      if (/serving on/.test(log)) resolve();
    });
    child.once("exit", (status) =>
      reject(new Error(`agentorg ${args[0]} exited ${status}: ${log}`)),
    );
  });
  return child;
}

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
  enable) sed -n 's/^ExecStart="\\(.*\\)" .*/\\1/p' "$XDG_CONFIG_HOME/systemd/user/$unit" > "$f";;
  disable) rm -f "$f";;
esac`;
  writeFileSync(join(bin, name), `#!/bin/sh\necho "$*" >> "${log}"\n${script}\n`);
  chmodSync(join(bin, name), 0o755);
  return name;
}

test("service install writes the launcher and both services, waits for them, and uninstall removes them", async () => {
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
    AGENTORG_HUMAN_PORT: String(await freePort()),
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  // The fake loads nothing, so the core and the web app it waits for run here.
  const core = await serving(["core"], env);
  const human = await serving(["human"], env);
  try {
    const [coreService, humanService] = (() => {
      process.env.AGENTORG_HOME = env.AGENTORG_HOME;
      try {
        return services();
      } finally {
        delete process.env.AGENTORG_HOME;
      }
    })();
    const launcher = join(env.AGENTORG_HOME, "bin", "agentorg");
    const file = (service: { name: string }) =>
      name === "launchctl"
        ? join(home, "Library", "LaunchAgents", `${service.name}.plist`)
        : join(env.XDG_CONFIG_HOME, "systemd", "user", `${service.name}.service`);

    // A service of the same name that runs something else is never replaced.
    writeFileSync(join(state, coreService?.name ?? ""), "/usr/local/bin/node\n");
    const refused = await agentorg(["service", "install"], env);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /runs \/usr\/local\/bin\/node, not .*; stop and remove it first/);
    assert.equal(existsSync(launcher), false);
    rmSync(join(state, coreService?.name ?? ""));

    const installed = await agentorg(["service", "install"], env);
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /the core: answering at .*, as service agentorg-[0-9a-f]{8}$/m);
    assert.match(installed.stdout, /the web app: answering at/);
    assert.ok(existsSync(launcher));
    for (const [service, command] of [
      [coreService, "core"],
      [humanService, "human"],
    ] as const) {
      const text = readFileSync(file(service ?? { name: "" }), "utf8");
      assert.ok(text.includes(launcher), `${service?.name} runs the launcher`);
      assert.match(text, new RegExp(`\\b${command}\\b`));
      assert.equal(readFileSync(join(state, service?.name ?? ""), "utf8").trim(), launcher);
    }

    const status = await agentorg(["status", "--project", project], env);
    assert.equal(status.status, 0, status.stdout);
    assert.match(status.stdout, /^the core: answering at .*; service agentorg-/m);
    assert.match(status.stdout, /^launcher: .*, on Node at /m);

    const removed = await agentorg(["service", "uninstall"], env);
    assert.equal(removed.status, 0, removed.stderr);
    assert.match(removed.stdout, /removed service .*-human, the web app\nremoved service/);
    assert.deepEqual(readdirSync(state), []);
    assert.equal(existsSync(file(coreService ?? { name: "" })), false);
    assert.ok(existsSync(env.AGENTORG_HOME), "the home stays");
  } finally {
    core.kill();
    human.kill();
    done();
  }
});
