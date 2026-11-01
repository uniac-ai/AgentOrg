/** The command line, run as its users run it: `agentorg-server`, then the built-ins against it. */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolDescriptor } from "../src/domain/model/index.ts";
import { HUB_INTERFACES, historicalCall, startCore } from "./harness.ts";

import { command, serving } from "./process.ts";

const agentorg = (args: string[], env: Record<string, string>) => command("cli", args, env);

test("help lists only actor operations, and asking for it acts on nothing", async () => {
  const home = join(mkdtempSync(join(tmpdir(), "agentorg-cli-")), "home");
  try {
    const help = await agentorg(["--help"], { AGENTORG_HOME: home });
    assert.equal(help.status, 0);
    const commands = ["interfaces", "call", "actor create", "actor close", "team"];
    const communication = [
      "actor get",
      "actor list",
      "message send",
      "message get",
      "message list",
      "work create",
      "form create",
      "claim",
      "release",
    ];
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
    assert.match(createHelp.stdout, /--execution <json>/);
    assert.equal(existsSync(home), false, "help created no home");

    const unknown = await agentorg(["frobnicate"], { AGENTORG_HOME: home });
    assert.equal(unknown.status, 2);
  } finally {
    rmSync(join(home, ".."), { recursive: true, force: true });
  }
});

test("CLI lists the same explicit Hub catalog for every Actor and invokes its operations", async (t) => {
  const core = await startCore();
  t.after(() => core.close());
  const root = await core.client(core.root);
  const created = await root.call("actor_create", { name: "worker", purpose: "Work" });
  assert.equal(created.state, "done");
  if (created.state !== "done") return;
  const { actor, credential } = created.value as { actor: { id: string }; credential: string };
  const env = {
    AGENTORG_URL: core.url,
    AGENTORG_ACTOR_ID: core.rootId,
    AGENTORG_CREDENTIAL: core.root,
  };
  const worker = { ...env, AGENTORG_ACTOR_ID: actor.id, AGENTORG_CREDENTIAL: credential };
  const listed = await agentorg(["interfaces"], env);
  assert.equal(listed.status, 0, listed.stderr);
  const catalog = JSON.parse(listed.stdout);
  assert.deepEqual(Object.keys(catalog), ["tools"]);
  assert.deepEqual(catalog.tools, await root.available());
  assert.deepEqual(
    catalog.tools
      .flatMap((tool: ToolDescriptor) => tool.interfaces.map((offer) => offer.call))
      .sort(),
    Object.values(HUB_INTERFACES).flat().sort(),
  );
  const workerCatalog = await agentorg(["interfaces"], worker);
  assert.equal(workerCatalog.status, 0, workerCatalog.stderr);
  assert.deepEqual(JSON.parse(workerCatalog.stdout), catalog);
  const called = await agentorg(
    ["call", "work_create", "--json", JSON.stringify({ ownerID: core.rootId, goal: "Working" })],
    worker,
  );
  assert.equal(called.status, 0, called.stderr);
  const answer = JSON.parse(called.stdout);
  assert.deepEqual(Object.keys(answer).sort(), ["state", "value"]);
  assert.equal(answer.value.goal, "Working");
  const denied = await agentorg(
    ["call", "actor_close", "--json", JSON.stringify({ actor: actor.id })],
    worker,
  );
  assert.equal(denied.status, 1);
  assert.equal(JSON.parse(denied.stdout).code, "forbidden");
  const guessed = await agentorg(["call", "worker.review"], env);
  assert.equal(guessed.status, 1);
  assert.equal(JSON.parse(guessed.stdout).code, "not_found");
  for (const input of ["[]", '"sentinel-credential"', '{"secret":"sentinel-credential"']) {
    const invalid = await agentorg(["call", "team", "--json", input], env);
    assert.equal(invalid.status, 1);
    assert.equal((invalid.stdout + invalid.stderr).includes("sentinel-credential"), false);
  }
});

test("an environment credential requires an explicit Actor identity before connecting", async () => {
  const result = await agentorg(["interfaces"], {
    AGENTORG_URL: "http://127.0.0.1:1",
    AGENTORG_CREDENTIAL: "sentinel-private-credential",
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /set both AGENTORG_ACTOR_ID and AGENTORG_CREDENTIAL/);
  assert.doesNotMatch(result.stdout + result.stderr, /sentinel-private-credential/);
});

test("actor create accepts optional execution and retains the Actor when its Provider is unavailable", async (t) => {
  const core = await startCore();
  t.after(() => core.close());
  const env = {
    AGENTORG_URL: core.url,
    AGENTORG_ACTOR_ID: core.rootId,
    AGENTORG_CREDENTIAL: core.root,
  };
  const execution = { providerId: "unavailable", config: {} };
  for (const mode of ["flag", "json"]) {
    const name = `execution-${mode}`;
    const input = { name, purpose: "Create execution through a Provider", execution };
    const args =
      mode === "flag"
        ? ["--name", name, "--purpose", input.purpose, "--execution", JSON.stringify(execution)]
        : ["--json", JSON.stringify(input)];
    const result = await agentorg(["actor", "create", ...args], env);
    assert.equal(result.status, 0, result.stderr);
    const created = JSON.parse(result.stdout);
    assert.equal(created.execution.providerId, execution.providerId);
    assert.equal(created.execution.status, "failed");
    assert.equal(typeof created.execution.error?.code, "string");
    assert.equal(typeof created.execution.error?.message, "string");
    assert.equal((await core.org.registry.byCredential(created.credential))?.id, created.actor.id);
    assert.equal(JSON.stringify(created.execution).includes(created.credential), false);
    const read = await agentorg(["team", "--depth", "0"], {
      AGENTORG_URL: core.url,
      AGENTORG_ACTOR_ID: created.actor.id,
      AGENTORG_CREDENTIAL: created.credential,
    });
    assert.equal(read.status, 0, read.stderr);
    assert.equal(JSON.parse(read.stdout).positions[0].id, created.actor.id);
  }
  const before = core.org.registry.reports(core.rootId).length;
  const missingConfig = await agentorg(
    [
      "actor",
      "create",
      "--name",
      "invalid-execution",
      "--purpose",
      "Invalid config",
      "--execution",
      JSON.stringify({ providerId: execution.providerId }),
    ],
    env,
  );
  assert.equal(missingConfig.status, 1);
  assert.match(missingConfig.stderr, /execution\.config/);
  assert.equal(core.org.registry.reports(core.rootId).length, before);
});

test("CLI call result reads retained history through both convenience and generic forms", async (t) => {
  const core = await startCore();
  t.after(() => core.close());
  const { actor } = await core.org.registry.create(core.rootId, "worker", "Work");
  const history = historicalCall(core, core.rootId, actor.id);
  const env = {
    AGENTORG_URL: core.url,
    AGENTORG_ACTOR_ID: core.rootId,
    AGENTORG_CREDENTIAL: core.root,
  };
  for (const args of [["--call", history.id], [history.id]]) {
    const result = await agentorg(["call", "result", ...args], env);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), history);
  }
  const generic = await agentorg(
    ["call", "call_result", "--json", JSON.stringify({ call: history.id })],
    env,
  );
  assert.equal(generic.status, 0, generic.stderr);
  assert.deepEqual(JSON.parse(generic.stdout), { state: "done", value: history });
  const withdrawn = await agentorg(["call", "withdraw", "--call", history.id], env);
  assert.notEqual(withdrawn.status, 0);
  const help = await agentorg(["call", "result", "--help"], env);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /usage: agentorg call result/);
  assert.match(help.stdout, /--call <value>/);
  assert.doesNotMatch(help.stdout, /--wait/);
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
    const asProg = {
      AGENTORG_URL: core.url,
      AGENTORG_ACTOR_ID: actor.id,
      AGENTORG_CREDENTIAL: credential,
    };

    const team = await agentorg(["team", "--depth", "0"], asProg);
    assert.equal(team.status, 0, team.stderr);
    const [seen] = JSON.parse(team.stdout).positions;
    assert.deepEqual([seen.name, seen.manager], [actor.name, JSON.parse(team.stdout).root]);

    const observed = await agentorg(["activity", "--limit", "5"], asProg);
    assert.notEqual(observed.status, 0);
    assert.match(observed.stderr, /forbidden/);
    const activity = await agentorg(["activity", "--limit", "5"], asRoot);
    assert.equal(JSON.parse(activity.stdout).entries.at(-1).operation, "actor_create");

    const sent = await agentorg(
      ["message", "send", "--recipientID", JSON.parse(team.stdout).root, "--text", "Hello"],
      asProg,
    );
    assert.equal(sent.status, 0, sent.stderr);
    const message = JSON.parse(sent.stdout);
    const read = await agentorg(["message", "get", "--messageID", message.messageID], asRoot);
    assert.equal(JSON.parse(read.stdout).text, "Hello");
    const invalid = await agentorg(
      ["message", "send", "--recipientID", actor.id, "--text", ""],
      asProg,
    );
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /invalid: text/);

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
