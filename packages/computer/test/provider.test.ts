// The computer unit against a real Hub. Its server is a stand-in for AgentExec unless
// AGENTEXEC_BUILD names a built file, which adds the tests that need the real tools.
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Hub, listen, PERSON } from "@agentorg/hub";
import { tools, Unit, unitProvider } from "@agentorg/interfaces";
import { Refused } from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";
import { startComputerProvider } from "../src/index.ts";

const standIn = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "agentexec.js");
const real = process.env.AGENTEXEC_BUILD;
const refused = (code: string) => (error: unknown) =>
  error instanceof Refused && error.code === code;
const until = async (condition: () => boolean | Promise<boolean>, ms = 20_000) => {
  for (let waited = 0; !(await condition()); waited += 20) {
    if (waited > ms) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

async function setup(t: test.TestContext, agentexec = standIn) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-computer-")));
  const dir = join(root, "provider");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "seen.txt"), "the person's file\n");
  const hub = Hub.open(join(root, "home"));
  const server = await listen(hub);
  const leaving: (() => void | Promise<void>)[] = [];
  t.after(async () => {
    for (const leave of leaving.reverse()) await leave();
    await server.close();
    hub.close();
    rmSync(root, { recursive: true, force: true });
  });
  const made = hub.state.createActor(PERSON, {
    name: "Computers",
    bindings: [{ slot: "actors", provider: "hub", export: "actors" }],
  });
  const start = () =>
    startComputerProvider({
      hubUrl: server.url,
      actorId: made.actorId,
      credential: made.credential as string,
      dir,
      agentexec,
      timing: { firstDelayMs: 50, pingEveryMs: 200 },
    });
  const provider = { current: await start() };
  leaving.push(() => provider.current.close());
  const asks = hub.state.createActor(PERSON, {
    name: "Management stand-in",
    bindings: [{ slot: "units", provider: made.actorId, export: "provider" }],
  });
  const caller = await connect({
    hubUrl: server.url,
    actorId: asks.actorId,
    credential: asks.credential as string,
    slots: { units: unitProvider },
  });
  leaving.push(() => caller.close());
  await until(() => caller.slots.units.bound);
  const units = caller.slots.units.call;
  const values = (access: string) => ({ where: "local", access, workspace });
  const apply = (access: string) =>
    units.apply({
      unit: "computer",
      values: values(access),
      secrets: {},
      needs: {},
      agent: "act_agent",
      name: "Scout's computer",
    });
  /** What management does next: expose the connection, here to a stand-in agent. */
  const asAgent = async (connection: string) => {
    const agent = hub.state.createActor(PERSON, {
      name: "Agent",
      bindings: [{ slot: "computer", provider: connection, export: "tools" }],
    });
    const client = await connect({
      hubUrl: server.url,
      actorId: agent.actorId,
      credential: agent.credential as string,
      slots: { computer: tools },
    });
    leaving.push(() => client.close());
    await until(() => client.slots.computer.bound);
    return client.slots.computer.call;
  };
  const connected = (instance: string) =>
    until(async () => (await units.status({ instance })).state === "connected");
  const restart = async () => {
    await provider.current.close();
    provider.current = await start();
  };
  return { hub, units, values, apply, asAgent, connected, restart, workspace, dir };
}

test("the unit's form says what each answer grants and adds, with nothing preselected", async (t) => {
  const { units } = await setup(t);
  const { units: offered } = await units.units({});
  assert.deepEqual(
    offered.map((unit) => unit.id),
    ["computer"],
  );
  const [unit] = offered;
  Unit.parse(unit);
  const field = (id: string) => unit?.form.find((one) => one.id === id);
  // Never preselected: neither has a default, and both must be answered.
  for (const id of ["where", "access"]) {
    assert.equal(field(id)?.default, undefined);
    assert.equal(field(id)?.required, true);
  }
  const option = (value: string) => field("access")?.options?.find((one) => one.value === value);
  assert.match(option("terminal")?.description ?? "", /every file and program you can/);
  assert.match(option("read")?.description ?? "", /Cannot change them or run anything/);
  assert.deepEqual(option("none")?.adds, undefined);
  assert.deepEqual(option("read")?.adds?.slots, [{ name: "computer" }]);
  assert.deepEqual(
    option("read")?.adds?.skills.map((skill) => ("name" in skill ? skill.name : "")),
    ["files", "computer"],
  );
  assert.deepEqual(
    option("terminal")?.adds?.skills.map((skill) => ("name" in skill ? skill.name : "")),
    ["terminal", "files", "computer"],
  );
  assert.deepEqual(field("workspace")?.visible, {
    field: "access",
    in: ["read", "files", "terminal"],
  });
});

test("each skill the form names can be read, and an unknown one is refused", async (t) => {
  const { units } = await setup(t);
  for (const name of ["terminal", "files", "computer"]) {
    const { text } = await units.skill({ unit: "computer", name, path: "SKILL.md" });
    assert.match(text, new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---\\n`));
  }
  await assert.rejects(
    units.skill({ unit: "computer", name: "browser", path: "SKILL.md" }),
    refused("unknown"),
  );
  await assert.rejects(
    units.skill({ unit: "computer", name: "files", path: "other.md" }),
    refused("unknown"),
  );
});

test("check says what's wrong by field, and changes nothing", async (t) => {
  const { units, values, workspace } = await setup(t);
  const check = (filled: Record<string, string>) =>
    units.check({ unit: "computer", values: filled, secrets: [] });
  assert.deepEqual(await check(values("terminal")), { problems: [] });
  const fields = async (filled: Record<string, string>) =>
    (await check(filled)).problems.map((problem) => problem.field);
  assert.deepEqual(await fields({ ...values("read"), where: "elsewhere" }), ["where"]);
  assert.deepEqual(await fields({ where: "local", access: "none" }), ["access", "workspace"]);
  assert.deepEqual(await fields({ ...values("read"), workspace: "relative/path" }), ["workspace"]);
  assert.deepEqual(await fields({ ...values("read"), workspace: `${workspace}/nope` }), [
    "workspace",
  ]);
  assert.deepEqual(await fields({ ...values("read"), workspace: `${workspace}/seen.txt` }), [
    "workspace",
  ]);
  await assert.rejects(units.check({ unit: "other", values: {}, secrets: [] }), refused("unknown"));
});

for (const [access, listed] of [
  ["read", ["read", "list", "search"]],
  ["files", ["read", "list", "search", "edit"]],
  ["terminal", ["read", "list", "search", "edit", "exec_command", "write_stdin"]],
] as const)
  test(`applied at ${access}, its connection offers those tools in the chosen folder`, async (t) => {
    const { apply, asAgent, connected, units, workspace } = await setup(t);
    const { instance, connections, results } = await apply(access);
    assert.deepEqual(results, []);
    assert.equal(connections.length, 1);
    const [made] = connections;
    assert.equal(made?.slot, "computer");
    assert.ok(made?.target.includes(workspace));
    assert.match(made?.target ?? "", /this computer, as you/);
    await connected(instance);
    const status = await units.status({ instance });
    assert.deepEqual(
      status.connections[0]?.tools.map((tool) => tool.name),
      listed,
    );
    const computer = await asAgent(made?.connection as string);
    const { output } = await computer.call({ name: "read", arguments: {} });
    assert.ok(output.includes(workspace) && output.includes("the person's file"));
  });

test("apply refuses what check refuses, and makes nothing", async (t) => {
  const { units, hub, values } = await setup(t);
  const before = hub.state.actors().length;
  await assert.rejects(
    units.apply({
      unit: "computer",
      values: { ...values("files"), access: "none" },
      secrets: {},
      needs: {},
      agent: "act_agent",
      name: "Scout's computer",
    }),
    refused("invalid"),
  );
  assert.equal(hub.state.actors().length, before);
});

test("a computer comes back after a restart, and remove closes it and leaves the folder", async (t) => {
  const { apply, connected, restart, units, hub, workspace, dir } = await setup(t);
  const { instance, connections } = await apply("files");
  await connected(instance);
  assert.equal(statSync(join(dir, "instances.json")).mode & 0o777, 0o600);

  await restart();
  await until(() =>
    units.status({ instance }).then(
      () => true,
      () => false,
    ),
  );
  await connected(instance);

  await units.remove({ instance });
  assert.equal(hub.state.actor(connections[0]?.connection as string).state, "closed");
  await assert.rejects(units.status({ instance }), refused("unknown"));
  await assert.rejects(units.remove({ instance }), refused("unknown"));
  // The workspace is the person's, whatever else goes.
  assert.equal(readFileSync(join(workspace, "seen.txt"), "utf8"), "the person's file\n");
  assert.ok(existsSync(workspace));
});

test("a server that can't start shows as down with the Actor still there", async (t) => {
  const { apply, units } = await setup(t, "/nowhere/agentexec.js");
  const { instance, connections } = await apply("read");
  await until(async () => (await units.status({ instance })).state === "down");
  assert.ok(connections[0]?.connection);
});

test("with the real AgentExec, an agent runs a command and edits a file", {
  skip: !real,
}, async (t) => {
  const { apply, asAgent, connected, workspace } = await setup(t, real);
  const { instance, connections } = await apply("terminal");
  await connected(instance);
  const computer = await asAgent(connections[0]?.connection as string);
  const ran = await computer.call({ name: "exec_command", arguments: { cmd: "pwd" } });
  assert.match(ran.output, /^exit_code: 0\n/);
  assert.ok(ran.output.includes(realpathSync(workspace)));
  const edited = await computer.call({
    name: "edit",
    arguments: { path: "seen.txt", old_text: "the person's", new_text: "an agent's" },
  });
  assert.match(edited.output, /\+an agent's file/);
  assert.equal(readFileSync(join(workspace, "seen.txt"), "utf8"), "an agent's file\n");
});

test("with the real AgentExec, a read-only computer can't change a file", {
  skip: !real,
}, async (t) => {
  const { apply, asAgent, connected, workspace } = await setup(t, real);
  const { instance, connections } = await apply("read");
  await connected(instance);
  const computer = await asAgent(connections[0]?.connection as string);
  assert.deepEqual(
    (await computer.list({})).tools.map((tool) => tool.name),
    ["read", "list", "search"],
  );
  await assert.rejects(
    computer.call({
      name: "edit",
      arguments: { path: "seen.txt", old_text: "the", new_text: "x" },
    }),
    refused("unknown"),
  );
  assert.equal(readFileSync(join(workspace, "seen.txt"), "utf8"), "the person's file\n");
  const outside = await computer.call({ name: "read", arguments: { path: "/etc/hosts" } });
  assert.equal(outside.failed, true);
  assert.match(outside.output, /outside the workspace/);
});
