/** The command line, run as its users run it: `agentorg core`, then the built-ins against it. */

import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const BIN = fileURLToPath(new URL("../src/cli/bin.js", import.meta.url));

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

/** Start `agentorg core` on a free port and return its address once it serves. */
async function startCore(home: string): Promise<{ process: ChildProcess; url: string }> {
  const child = spawn(process.execPath, [BIN, "core", "--port", "0"], {
    env: { PATH: process.env.PATH ?? "", AGENTORG_HOME: home },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  const url = await new Promise<string>((resolve, reject) => {
    child.stderr?.on("data", (chunk: Buffer) => {
      log += chunk.toString();
      const served = /core serving on (http:\/\/[\d.:]+)/.exec(log);
      if (served?.[1]) resolve(served[1]);
    });
    child.once("exit", (status) => reject(new Error(`agentorg core exited ${status}: ${log}`)));
  });
  return { process: child, url };
}

test("help lists the core and every built-in, and asking for it acts on nothing", async () => {
  const home = join(mkdtempSync(join(tmpdir(), "agentorg-cli-")), "home");
  try {
    const help = await agentorg(["--help"], { AGENTORG_HOME: home });
    assert.equal(help.status, 0);
    const commands = ["core", "actor create", "actor close", "status set", "view", "progress set"];
    for (const command of [...commands, "progress", "team", "message send", "claim", "release"]) {
      assert.match(help.stdout, new RegExp(`^  ${command} `, "m"));
    }
    const coreHelp = await agentorg(["core", "--help"], { AGENTORG_HOME: home });
    assert.match(coreHelp.stdout, /^usage: agentorg core/);
    const createHelp = await agentorg(["actor", "create", "--help"], { AGENTORG_HOME: home });
    assert.match(createHelp.stdout, /--name <value>/);
    assert.equal(existsSync(home), false, "help created no home");

    const unknown = await agentorg(["frobnicate"], { AGENTORG_HOME: home });
    assert.equal(unknown.status, 2);
  } finally {
    rmSync(join(home, ".."), { recursive: true, force: true });
  }
});

test("agentorg core creates the root's credential, and the built-ins run as the root or as an actor", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentorg-cli-"));
  const core = await startCore(home);
  try {
    assert.equal(statSync(join(home, "root-credential")).mode & 0o777, 0o600);
    const asRoot = { AGENTORG_HOME: home, AGENTORG_URL: core.url };

    const created = await agentorg(
      ["actor", "create", "--name", "prog", "--purpose", "A program"],
      asRoot,
    );
    assert.equal(created.status, 0, created.stderr);
    const { actor, credential } = JSON.parse(created.stdout);
    const asProg = { AGENTORG_URL: core.url, AGENTORG_CREDENTIAL: credential };

    const view = await agentorg(["view"], asProg);
    assert.equal(view.status, 0, view.stderr);
    const seen = JSON.parse(view.stdout);
    assert.equal(seen.actor.name, "prog");
    assert.equal(seen.manager.name, "root");

    const refused = await agentorg(["activity"], asProg);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /not_found: there is no interface activity/);
    const activity = await agentorg(["activity", "--limit", "5"], asRoot);
    assert.equal(JSON.parse(activity.stdout).entries[0].operation, "actor_create");

    const set = await agentorg(
      ["progress", "set", "--state", "running", "--summary", "Up"],
      asProg,
    );
    assert.equal(set.status, 0, set.stderr);
    const progress = await agentorg(["progress", "--actor", actor.id], asRoot);
    assert.equal(JSON.parse(progress.stdout).progress.summary, "Up");

    const invalid = await agentorg(["status", "set", "--state", "asleep"], asProg);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /invalid: state/);

    const closed = await agentorg(["actor", "close", actor.id], asRoot);
    assert.notEqual(JSON.parse(closed.stdout).actor.closed_at, null);
    const gone = await agentorg(["view"], asProg);
    assert.equal(gone.status, 1);
    assert.match(gone.stderr, /did not accept the connection/);
  } finally {
    core.process.kill("SIGTERM");
    if (core.process.exitCode === null)
      await new Promise((resolve) => core.process.once("exit", resolve));
    assert.equal(core.process.exitCode, 0);
    rmSync(home, { recursive: true, force: true });
  }
});
