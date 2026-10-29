/** The command line, run as its users run it: `agentorg-server`, then the built-ins against it. */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { command, serving } from "./process.ts";

const agentorg = (args: string[], env: Record<string, string>) => command("cli", args, env);

test("help lists only actor operations, and asking for it acts on nothing", async () => {
  const home = join(mkdtempSync(join(tmpdir(), "agentorg-cli-")), "home");
  try {
    const help = await agentorg(["--help"], { AGENTORG_HOME: home });
    assert.equal(help.status, 0);
    const commands = ["actor create", "actor close", "progress set", "progress", "team"];
    const communication = ["question ask", "questions", "message send", "claim", "release"];
    for (const command of [...commands, ...communication]) {
      assert.match(help.stdout, new RegExp(`^  ${command} `, "m"));
    }
    for (const removed of [
      "core",
      "server",
      "human",
      "agent",
      "service",
      "connect",
      "status",
      "ui",
    ]) {
      assert.doesNotMatch(help.stdout, new RegExp(`^  ${removed} `, "m"));
    }
    const createHelp = await agentorg(["actor", "create", "--help"], { AGENTORG_HOME: home });
    assert.match(createHelp.stdout, /--name <value>/);
    assert.equal(existsSync(home), false, "help created no home");

    const unknown = await agentorg(["frobnicate"], { AGENTORG_HOME: home });
    assert.equal(unknown.status, 2);
  } finally {
    rmSync(join(home, ".."), { recursive: true, force: true });
  }
});

test("agentorg-server creates the root's credential, and the built-ins run as the root or as an actor", async () => {
  const home = mkdtempSync(join(tmpdir(), "agentorg-cli-"));
  const core = await serving("server", { AGENTORG_HOME: home }, ["--port", "0"]);
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

    const team = await agentorg(["team", "--depth", "0"], asProg);
    assert.equal(team.status, 0, team.stderr);
    const [seen] = JSON.parse(team.stdout).positions;
    assert.deepEqual([seen.name, seen.manager], [actor.name, JSON.parse(team.stdout).root]);

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

    const invalid = await agentorg(["progress", "set", "--state", "asleep"], asProg);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /invalid: state/);

    const closed = await agentorg(["actor", "close", actor.id], asRoot);
    assert.notEqual(JSON.parse(closed.stdout).actor.closed_at, null);
    const gone = await agentorg(["team"], asProg);
    assert.equal(gone.status, 1);
    assert.match(gone.stderr, /did not accept the connection/);
  } finally {
    assert.equal((await core.close()).status, 0);
    rmSync(home, { recursive: true, force: true });
  }
});
