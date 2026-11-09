// The computer unit against a real Hub. Its server is a stand-in for AgentExec unless
// AGENTEXEC_BUILD names a built file, which adds the tests that need the real tools.
import assert from "node:assert/strict";
import { once } from "node:events";
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
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Hub, listen, PERSON } from "@agentorg/hub";
import { tools, Unit, unitProvider } from "@agentorg/interfaces";
import { Refused } from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";
import { startComputerProvider } from "../src/index.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const standIn = join(fixtures, "agentexec.js");
const browserStandIn = join(fixtures, "playwright.js");
const real = process.env.AGENTEXEC_BUILD;
const liveWeb = process.env.AGENTORG_LIVE_WEB === "1";
/** A real Playwright MCP and browser, as `{cli, args}` in JSON, for the test that needs them. */
const realBrowser = process.env.AGENTORG_PLAYWRIGHT
  ? (JSON.parse(process.env.AGENTORG_PLAYWRIGHT) as { cli: string; args: string[] })
  : undefined;
const refused = (code: string) => (error: unknown) =>
  error instanceof Refused && error.code === code;
const until = async (condition: () => boolean | Promise<boolean>, ms = 20_000) => {
  for (let waited = 0; !(await condition()); waited += 20) {
    if (waited > ms) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

async function setup(t: test.TestContext, agentexec = standIn, webUrl?: string) {
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
      playwright: realBrowser ?? { cli: browserStandIn, args: ["--browser", "stand-in"] },
      ...(webUrl ? { webUrl } : {}),
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
  const apply = (access: string, more: Record<string, boolean> = {}) =>
    units.apply({
      unit: "computer",
      values: { ...values(access), ...more },
      secrets: {},
      needs: {},
      agent: "act_agent",
      name: "Scout's computer",
    });
  /** What management does next: expose the connection, here to a stand-in agent. */
  const asAgentSlot = async (connection: string) => {
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
  const asAgent = asAgentSlot;
  return { hub, units, values, apply, asAgent, asAgentSlot, connected, restart, workspace, dir };
}

test("the unit's form says what each answer grants and adds, with nothing preselected", async (t) => {
  const { units } = await setup(t);
  const { units: offered } = await units.units({});
  assert.deepEqual(
    offered.map((unit) => unit.id),
    ["computer", "web"],
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
  assert.match(option("terminal")?.description ?? "", /reach every file and program you can/);
  assert.match(option("read")?.description ?? "", /can't change them or run anything/);
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
  // Each shown by `where`, so no host needs to know a field by name.
  assert.equal(field("workspace")?.type, "directory");
  // `check` asks for each, since being needed depends on two answers and `visible` takes one.
  assert.equal(field("workspace")?.required, undefined);
  assert.equal(field("containerPath")?.required, undefined);
  assert.deepEqual(field("workspace")?.visible, { field: "where", in: ["local"] });
  assert.equal(field("containerPath")?.type, "text");
  assert.deepEqual(field("containerPath")?.visible, { field: "where", in: ["container"] });
});

test("each skill the form names can be read, and an unknown one is refused", async (t) => {
  const { units } = await setup(t);
  for (const name of ["terminal", "files", "computer"]) {
    const { text } = await units.skill({ unit: "computer", name, path: "SKILL.md" });
    assert.match(text, new RegExp(`^---\\nname: ${name}\\ndescription: .+\\n---\\n`));
  }
  await assert.rejects(
    units.skill({ unit: "computer", name: "web-research", path: "SKILL.md" }),
    refused("unknown"),
  );
  for (const [unit, name] of [
    ["computer", "browser"],
    ["web", "web-research"],
  ] as const) {
    const { text } = await units.skill({ unit, name, path: "SKILL.md" });
    assert.match(text, new RegExp(`^---\\nname: ${name}\\n`));
  }
  await assert.rejects(
    units.skill({ unit: "computer", name: "files", path: "other.md" }),
    refused("unknown"),
  );
});

test("check says what's wrong by field, and changes nothing", async (t) => {
  const { units, values, workspace } = await setup(t);
  const check = (filled: Record<string, string | boolean>) =>
    units.check({ unit: "computer", values: filled, secrets: [] });
  assert.deepEqual(await check(values("terminal")), { problems: [] });
  const fields = async (filled: Record<string, string>) =>
    (await check(filled)).problems.map((problem) => problem.field);
  assert.deepEqual(await fields({ ...values("read"), where: "elsewhere" }), ["where"]);
  // The folder is asked for only when there is something to do in it.
  assert.deepEqual(await fields({ where: "local", access: "none" }), ["access"]);
  const browserOnly = { where: "local", access: "none", browser: true };
  assert.deepEqual(
    (await units.check({ unit: "computer", values: browserOnly, secrets: [] })).problems,
    [],
  );
  assert.deepEqual(await fields({ where: "local", access: "read" }), ["workspace"]);
  assert.deepEqual(await fields({ where: "local", access: "read", workspace: "" }), ["workspace"]);
  assert.deepEqual(await fields({ where: "container", access: "read" }), [
    "where",
    "containerPath",
  ]);
  assert.deepEqual(await fields({ where: "container", access: "read", containerPath: "/work" }), [
    "where",
  ]);
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

const toolNames = (status: { connections: { tools: { name: string }[] }[] }, at: number) =>
  status.connections[at]?.tools.map((tool) => tool.name);

test("the browser switch adds its slot and skill, and nothing runs without it", async (t) => {
  const { units, apply, connected, hub } = await setup(t);
  const [unit] = (await units.units({})).units;
  const toggle = unit?.form.find((one) => one.id === "browser");
  assert.equal(toggle?.default, false);
  assert.deepEqual(toggle?.adds?.slots, [{ name: "browser" }]);

  const without = await apply("files");
  assert.deepEqual(
    without.connections.map((one) => one.slot),
    ["computer"],
  );
  assert.equal(hub.state.actors().filter((actor) => actor.name.includes("(browser)")).length, 0);

  const both = await apply("terminal", { browser: true });
  assert.deepEqual(
    both.connections.map((one) => one.slot),
    ["computer", "browser"],
  );
  await connected(both.instance);
  assert.ok(
    toolNames(await units.status({ instance: both.instance }), 1)?.includes("browser_navigate"),
  );
});

test("the tool that runs code is hidden below a terminal, and can't be called", async (t) => {
  const { apply, asAgentSlot, connected, units } = await setup(t);
  const below = await apply("files", { browser: true });
  await connected(below.instance);
  assert.deepEqual(toolNames(await units.status({ instance: below.instance }), 1), [
    "browser_navigate",
    "browser_snapshot",
  ]);
  const browser = await asAgentSlot(below.connections[1]?.connection as string);
  await assert.rejects(
    browser.call({ name: "browser_run_code_unsafe", arguments: {} }),
    refused("unknown"),
  );

  const full = await apply("terminal", { browser: true });
  await connected(full.instance);
  assert.ok(
    toolNames(await units.status({ instance: full.instance }), 1)?.includes(
      "browser_run_code_unsafe",
    ),
  );
});

test("a browser-only computer works in a folder of its own, gone with it, and the workspace is never asked", async (t) => {
  const { units, connected, asAgentSlot, dir } = await setup(t);
  const { instance, connections } = await units.apply({
    unit: "computer",
    values: { where: "local", access: "none", browser: true },
    secrets: {},
    needs: {},
    agent: "act_agent",
    name: "Reader's computer",
  });
  assert.deepEqual(
    connections.map((one) => one.slot),
    ["browser"],
  );
  await connected(instance);
  const browser = await asAgentSlot(connections[0]?.connection as string);
  const { output } = await browser.call({ name: "browser_navigate", arguments: {} });
  const own = join(dir, "browsers", instance);
  assert.ok(output.startsWith(realpathSync(own)), output);
  assert.match(output, /--headless/);
  assert.ok(output.includes(`--user-data-dir ${join(own, "profile")}`), output);
  await units.remove({ instance });
  assert.equal(existsSync(own), false);
});

test("the browser's folder of its own is removed, and the workspace it worked in stays", async (t) => {
  const { apply, connected, units, dir, workspace, asAgentSlot } = await setup(t);
  const { instance, connections } = await apply("terminal", { browser: true });
  await connected(instance);
  const browser = await asAgentSlot(connections[1]?.connection as string);
  // Started in the workspace, so its own file checks are kept to it.
  assert.ok(
    (await browser.call({ name: "browser_navigate", arguments: {} })).output.startsWith(workspace),
  );
  await units.remove({ instance });
  assert.equal(existsSync(join(dir, "browsers", instance)), false);
  assert.ok(existsSync(join(workspace, "seen.txt")));
});

test("the web unit gives its slot and skill, at the service's address", async (t) => {
  const { units } = await setup(t, standIn, "http://127.0.0.1:9/mcp?tools=web_search_exa");
  const web = (await units.units({})).units.find((unit) => unit.id === "web");
  assert.deepEqual(web?.gives.slots, [{ name: "web" }]);
  assert.match(web?.form[0]?.options?.[0]?.description ?? "", /sees what it looks for/);
  assert.deepEqual(
    (await units.check({ unit: "web", values: { service: "other" }, secrets: [] })).problems.map(
      (problem) => problem.field,
    ),
    ["service"],
  );
  const { instance, connections } = await units.apply({
    unit: "web",
    values: { service: "exa" },
    secrets: {},
    needs: {},
    agent: "act_agent",
    name: "Scout's web",
  });
  assert.deepEqual(
    connections.map((one) => [one.slot, one.target]),
    [["web", "127.0.0.1:9"]],
  );
  await until(async () => (await units.status({ instance })).state === "down");
  await units.remove({ instance });
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

test("live: the web unit searches through Exa's own server", { skip: !liveWeb }, async (t) => {
  const { units, asAgentSlot } = await setup(t);
  const { instance, connections } = await units.apply({
    unit: "web",
    values: { service: "exa" },
    secrets: {},
    needs: {},
    agent: "act_agent",
    name: "Scout's web",
  });
  await until(async () => (await units.status({ instance })).state === "connected");
  const web = await asAgentSlot(connections[0]?.connection as string);
  const { output } = await web.call({
    name: "web_search_exa",
    arguments: { query: "Node.js release schedule", objective: "the official page", numResults: 1 },
  });
  assert.match(output, /^Title: .+\nURL: https?:/m);
});

test("real: the browser opens a page and reads it", { skip: !realBrowser }, async (t) => {
  const site = createServer((_, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<!doctype html><title>Checkout</title><h1>Checkout</h1><button>Pay now</button>");
  }).listen(0, "127.0.0.1");
  await once(site, "listening");
  t.after(() => site.close());
  const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
  const { apply, asAgentSlot, connected } = await setup(t);
  const { instance, connections } = await apply("files", { browser: true });
  await connected(instance);
  const browser = await asAgentSlot(connections[1]?.connection as string);
  const opened = await browser.call({ name: "browser_navigate", arguments: { url } });
  assert.match(opened.output, /- Page Title: Checkout/);
  const { output } = await browser.call({ name: "browser_snapshot", arguments: {} });
  assert.match(output, /button "Pay now"/);
});
