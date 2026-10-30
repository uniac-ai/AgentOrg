/** The command line, run as its users run it: `agentorg-server`, then the built-ins against it. */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fakeActor, iface, startCore, until } from "./harness.ts";

import { command, serving } from "./process.ts";

const agentorg = (args: string[], env: Record<string, string>) => command("cli", args, env);

test("help lists only actor operations, and asking for it acts on nothing", async () => {
  const home = join(mkdtempSync(join(tmpdir(), "agentorg-cli-")), "home");
  try {
    const help = await agentorg(["--help"], { AGENTORG_HOME: home });
    assert.equal(help.status, 0);
    const commands = [
      "interfaces",
      "call",
      "actor create",
      "actor close",
      "progress set",
      "progress",
      "team",
    ];
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
    assert.match(createHelp.stdout, /--execution <json>/);
    assert.equal(existsSync(home), false, "help created no home");

    const unknown = await agentorg(["frobnicate"], { AGENTORG_HOME: home });
    assert.equal(unknown.status, 2);
  } finally {
    rmSync(join(home, ".."), { recursive: true, force: true });
  }
});

test("generic CLI access lists and invokes routed interfaces with the same actor permissions", async () => {
  const core = await startCore();
  try {
    const root = await core.client(core.root);
    const answer = await root.call("actor_create", {
      name: "worker",
      purpose: "Serve a routed interface.",
    });
    assert.equal(answer.state, "done");
    const created = (answer as { value: { actor: { id: string }; credential: string } }).value;
    const echo = iface("echo", {
      input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      output: { type: "object", properties: { echoed: { type: "string" } }, required: ["echoed"] },
    });
    await core.connect(
      created.credential,
      fakeActor([echo], async (input) => ({ value: { echoed: input.text } })),
    );
    const env = {
      AGENTORG_URL: core.url,
      AGENTORG_ACTOR_ID: core.rootId,
      AGENTORG_CREDENTIAL: core.root,
    };
    const listed = await agentorg(["interfaces"], env);
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout).interfaces, await root.available());
    const result = await agentorg(["call", "worker.echo", "--json", '{"text":"hello"}'], env);
    assert.equal(result.status, 0, result.stderr);
    const called = JSON.parse(result.stdout);
    assert.equal(called.state, "done");
    assert.match(called.call, /^call_/);
    assert.deepEqual(called.value, { echoed: "hello" });
    const refused = await agentorg(["call", "activity"], {
      ...env,
      AGENTORG_ACTOR_ID: created.actor.id,
      AGENTORG_CREDENTIAL: created.credential,
    });
    assert.equal(refused.status, 1);
    assert.equal(JSON.parse(refused.stdout).code, "not_found");
    for (const input of ["[]", '"sentinel-credential"', '{"secret":"sentinel-credential"']) {
      const invalid = await agentorg(["call", "worker.echo", "--json", input], env);
      assert.equal(invalid.status, 1);
      assert.equal((invalid.stdout + invalid.stderr).includes("sentinel-credential"), false);
    }
  } finally {
    await core.close();
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

test("call result and withdraw conveniences coexist with generic call dispatch", async () => {
  const core = await startCore({ waitMs: 50, stepMs: 10 });
  try {
    const root = await core.client(core.root);
    const created = await root.call("actor_create", { name: "held", purpose: "Hold a call." });
    const { credential } = (created as { value: { credential: string } }).value;
    await core.connect(credential, fakeActor([iface("hold", { long_running: true })]));
    await until("the held interface is available", async () =>
      (await root.available()).some((offer) => offer.interface.name === "held.hold"),
    );
    const pending = await root.call("held.hold");
    assert.equal(pending.state, "pending");
    const id = (pending as { call: string }).call;
    const env = {
      AGENTORG_URL: core.url,
      AGENTORG_ACTOR_ID: core.rootId,
      AGENTORG_CREDENTIAL: core.root,
    };
    for (const args of [["--call", id], [id]]) {
      const result = await agentorg(["call", "result", ...args], env);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).state, "pending");
    }
    const withdrawn = await agentorg(["call", "withdraw", "--call", id], env);
    assert.equal(withdrawn.status, 0, withdrawn.stderr);
    assert.equal(JSON.parse(withdrawn.stdout).state, "withdrawn");
    const generic = await agentorg(
      ["call", "call_result", "--json", JSON.stringify({ call: id })],
      env,
    );
    assert.equal(generic.status, 0, generic.stderr);
    assert.equal(JSON.parse(generic.stdout).state, "done");
    assert.equal(JSON.parse(generic.stdout).value.state, "withdrawn");
    for (const operation of ["result", "withdraw"]) {
      const help = await agentorg(["call", operation, "--help"], env);
      assert.equal(help.status, 0);
      assert.match(help.stdout, new RegExp(`usage: agentorg call ${operation}`));
      assert.match(help.stdout, /--call <value>/);
    }
  } finally {
    await core.close();
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
    const asProg = {
      AGENTORG_URL: core.url,
      AGENTORG_ACTOR_ID: actor.id,
      AGENTORG_CREDENTIAL: credential,
    };

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
