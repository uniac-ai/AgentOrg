import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
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
import { hubActors, hubExports, hubGrants, tools, unitProvider } from "@agentorg/interfaces";
import { Refused } from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Timing } from "../src/connection.ts";
import { startMcpProvider } from "../src/index.ts";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "server.js");
const command = { command: process.execPath, args: [fixture] };
const refused = (code: string) => (error: unknown) =>
  error instanceof Refused && error.code === code;
const until = async (condition: () => boolean | Promise<boolean>, ms = 20_000) => {
  for (let waited = 0; !(await condition()); waited += 20) {
    if (waited > ms) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** A Hub, the person on it, and a way to start the provider on one private folder. */
async function setup(t: test.TestContext, timing?: Timing) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-mcp-")));
  const home = join(root, "home");
  const dir = join(root, "provider");
  const hub = Hub.open(home);
  const server = await listen(hub);
  const leaving: (() => void | Promise<void>)[] = [];
  t.after(async () => {
    for (const leave of leaving.reverse()) await leave();
    await server.close();
    hub.close();
    rmSync(root, { recursive: true, force: true });
  });
  const person = await connect({
    hubUrl: server.url,
    actorId: PERSON,
    credential: readFileSync(join(home, "person-credential"), "utf8").trim(),
    slots: { actors: hubActors, grants: hubGrants, exports: hubExports },
    declare: false,
  });
  leaving.push(() => person.close());
  const logged: string[] = [];
  const note = (message: string, fields?: unknown) => {
    logged.push(`${message} ${JSON.stringify(fields ?? {})}`);
  };
  const made = hub.state.createActor(PERSON, {
    name: "MCP",
    bindings: [{ slot: "actors", provider: "hub", export: "actors" }],
  });
  const start = () =>
    startMcpProvider({
      hubUrl: server.url,
      actorId: made.actorId,
      credential: made.credential as string,
      dir,
      log: { info: note, warn: note, error: note },
      ...(timing ? { timing } : {}),
    });
  const provider = { current: await start() };
  leaving.push(() => provider.current.close());
  const asked = hub.state.createActor(PERSON, {
    name: "Asks",
    bindings: [{ slot: "mcp", provider: made.actorId, export: "provider" }],
  });
  const caller = await connect({
    hubUrl: server.url,
    actorId: asked.actorId,
    credential: asked.credential as string,
    slots: { mcp: unitProvider },
  });
  leaving.push(() => caller.close());
  await until(() => caller.slots.mcp.bound);
  const units = caller.slots.mcp.call;
  /** A connection as one is made and read: the unit's instance is its connection. */
  const mcp = {
    async create(input: {
      kind: string;
      params: Record<string, unknown>;
      secrets?: Record<string, string>;
      name: string;
    }) {
      const { connections } = await units.apply({
        unit: input.kind,
        values: { ...input.params, slot: "tools" } as never,
        secrets: input.secrets ?? {},
        needs: {},
        agent: "person",
        name: input.name,
      });
      const made = connections[0] as (typeof connections)[number];
      return { connection: made.connection, target: made.target };
    },
    async status({ connection }: { connection: string }) {
      const { connections } = await units.status({ instance: connection });
      const { connection: _, ...status } = connections[0] as (typeof connections)[number];
      return status;
    },
    remove: ({ connection }: { connection: string }) => units.remove({ instance: connection }),
  };

  /** An Actor bound to a connection's `tools`, counting what it hears. */
  const consumerOf = async (connection: string) => {
    const user = hub.state.createActor(PERSON, {
      name: `User ${randomUUID()}`,
      bindings: [{ slot: "tools", provider: connection, export: "tools" }],
    });
    const heard = { changed: 0 };
    const client = await connect({
      hubUrl: server.url,
      actorId: user.actorId,
      credential: user.credential as string,
      slots: { tools },
      start(ctx) {
        ctx.slots.tools.on("changed", () => {
          heard.changed += 1;
        });
      },
    });
    leaving.push(() => client.close());
    await until(() => client.slots.tools.bound);
    // Bound first, then subscribed: nothing says when that has reached the provider.
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { call: client.slots.tools.call, heard };
  };
  const connected = (connection: string) =>
    until(async () => (await mcp.status({ connection })).state === "connected");
  return { hub, person, mcp, units, dir, logged, provider, start, consumerOf, connected };
}

test("the provider offers its two kinds as units, each making one connection", async (t) => {
  const { units } = await setup(t);
  const offered = (await units.units({})).units;
  assert.deepEqual(
    offered.map((unit) => [unit.id, unit.gives.slots, unit.needs]),
    [
      ["url", [{ field: "slot" }], []],
      ["command", [{ field: "slot" }], []],
    ],
  );
  assert.deepEqual(
    offered.map((unit) => unit.form.map((field) => field.title)),
    [
      ["Address", "Token", "Name"],
      ["Command", "Arguments", "Working folder", "Secrets", "Name"],
    ],
  );
  await assert.rejects(
    units.skill({ unit: "url", name: "x", path: "SKILL.md" }),
    refused("unknown"),
  );
});

test("what doesn't fit its kind is refused", async (t) => {
  const { mcp } = await setup(t);
  await assert.rejects(mcp.create({ kind: "smoke", params: {}, name: "X" }), refused("invalid"));
  await assert.rejects(mcp.create({ kind: "url", params: {}, name: "X" }), refused("invalid"));
  await assert.rejects(
    mcp.create({ kind: "url", params: { url: "ftp://example.com/" }, name: "X" }),
    refused("invalid"),
  );
  await assert.rejects(
    mcp.create({ kind: "command", params: { command: "x", shell: true }, name: "X" }),
    refused("invalid"),
  );
  await assert.rejects(
    mcp.create({ kind: "url", params: { url: "https://u:p@example.com/" }, name: "X" }),
    refused("invalid"),
  );
  await assert.rejects(
    mcp.create({
      kind: "url",
      params: { url: "https://example.com/" },
      secrets: { other: "value-kept-out" },
      name: "X",
    }),
    (error: Error) => refused("invalid")(error) && !error.message.includes("value-kept-out"),
  );
  // A token never goes over plain http to another machine.
  await assert.rejects(
    mcp.create({
      kind: "url",
      params: { url: "http://example.com/" },
      secrets: { token: "t" },
      name: "X",
    }),
    refused("invalid"),
  );
});

test("its own check says what can't connect, without being given a secret", async (t) => {
  const { units } = await setup(t);
  const check = (unit: string, values: object, secrets: string[] = []) =>
    units.check({ unit, values: { ...values, slot: "a" } as never, secrets });
  assert.deepEqual((await check("url", { url: "https://x.example/" }, ["token"])).problems, []);
  assert.equal((await check("url", { url: "ftp://x.example/" })).problems.length, 1);
  assert.match(
    (await check("url", { url: "http://x.example/" }, ["token"])).problems[0]?.message as string,
    /only over https/,
  );
  assert.deepEqual(
    (await check("command", { command: "x" }, ["agentorgEnvironmentLines"])).problems,
    [],
  );
});

test("a command's secrets come as lines or by name, and are its environment", async (t) => {
  const { mcp, units, connected, dir } = await setup(t);
  const secret = `value=${randomUUID()}`;
  const made = await units.apply({
    unit: "command",
    values: { ...command, slot: "tools" },
    secrets: { agentorgEnvironmentLines: `FIRST=${secret}\r\n\nSECOND=2\n` },
    needs: {},
    agent: "person",
    name: "Lines",
  });
  await connected(made.instance);
  const kept = JSON.parse(readFileSync(join(dir, "connections.json"), "utf8"));
  assert.deepEqual(kept[made.instance].secrets, { FIRST: secret, SECOND: "2" });
  assert.deepEqual(kept[made.instance].params, command, "its name isn't a parameter");
  await assert.rejects(
    units.apply({
      unit: "command",
      values: { ...command, slot: "tools" },
      secrets: { agentorgEnvironmentLines: "no equals sign" },
      needs: {},
      agent: "person",
      name: "Bad",
    }),
    (error: unknown) =>
      refused("invalid")(error) && !(error as Error).message.includes("no equals"),
  );
  await mcp.remove({ connection: made.instance });
  // A variable called `env` is one like any other.
  const plain = await mcp.create({
    kind: "command",
    params: command,
    secrets: { env: "plainvalue" },
    name: "Named env",
  });
  const after = JSON.parse(readFileSync(join(dir, "connections.json"), "utf8"));
  assert.deepEqual(after[plain.connection].secrets, { env: "plainvalue" });
  await mcp.remove(plain);
});

test("a server connected by hand shows in hub.exports as tools@1, and its tools run", async (t) => {
  const { person, mcp, consumerOf, connected } = await setup(t);
  process.env.AGENTORG_TEST_KEPT = "kept";
  t.after(() => {
    delete process.env.AGENTORG_TEST_KEPT;
  });
  const { connection, target } = await mcp.create({
    kind: "command",
    params: command,
    secrets: { AGENTORG_TEST_GIVEN: "given" },
    name: "Fixture",
  });
  assert.equal(target, `${process.execPath} ${fixture}`);

  const { exports } = await person.slots.exports.call.list({ actor: connection });
  assert.deepEqual(
    exports.map((e) => [e.export, e.interface]),
    [["tools", "tools@1"]],
  );
  const actor = await person.slots.actors.call.get({ actorId: connection });
  assert.equal(actor.name, "Fixture");
  assert.equal(actor.package, "external");

  await connected(connection);
  const status = await mcp.status({ connection });
  assert.deepEqual(
    status.tools.map((tool) => tool.name),
    ["echo", "refuse", "env", "grow", "pid", "die"],
  );
  const { call } = await consumerOf(connection);
  const listed = await call.list({});
  const echo = listed.tools.find((tool) => tool.name === "echo");
  assert.equal(echo?.description, "Says it back.");
  assert.equal(echo?.inputSchema.type, "object");
  assert.deepEqual(await call.call({ name: "echo", arguments: { text: "hi" } }), { output: "hi" });
  // A tool that failed answers, for the model to read; a tool that isn't there is refused.
  assert.deepEqual(await call.call({ name: "refuse", arguments: {} }), {
    output: "It can't be done.",
    failed: true,
  });
  await assert.rejects(call.call({ name: "nothing", arguments: {} }), refused("unknown"));
  const invalid = await call.call({ name: "echo", arguments: { text: 1 } });
  assert.equal(invalid.failed, true);
  // The server gets its secrets as variables, and none of the provider's own.
  const variable = (name: string) => call.call({ name: "env", arguments: { name } });
  assert.equal((await variable("AGENTORG_TEST_GIVEN")).output, "given");
  assert.equal((await variable("AGENTORG_TEST_KEPT")).output, "(unset)");
});

test("changed fires when the server's tools change, and when it goes and comes back", async (t) => {
  // The first retry is put off, so the time the server is away can be looked at.
  const { mcp, consumerOf, connected } = await setup(t, { firstDelayMs: 3_000 });
  const { connection } = await mcp.create({ kind: "command", params: command, name: "Fixture" });
  await connected(connection);
  const { call, heard } = await consumerOf(connection);
  assert.equal(heard.changed, 0);

  await call.call({ name: "grow", arguments: {} });
  await until(() => heard.changed === 1);
  assert.ok((await call.list({})).tools.some((tool) => tool.name === "grown"));
  assert.ok((await mcp.status({ connection })).tools.some((tool) => tool.name === "grown"));

  // The server dies: its tools are gone and calls say so, until the provider has it back.
  await call.call({ name: "die", arguments: {} });
  await until(() => heard.changed === 2);
  const down = await mcp.status({ connection });
  assert.equal(down.state, "down");
  assert.ok(down.detail);
  assert.deepEqual(down.tools, []);
  await assert.rejects(call.list({}), refused("not_connected"));
  await assert.rejects(
    call.call({ name: "echo", arguments: { text: "x" } }),
    refused("not_connected"),
  );
  await until(() => heard.changed === 3);
  await connected(connection);
  assert.deepEqual(await call.call({ name: "echo", arguments: { text: "back" } }), {
    output: "back",
  });
});

/** A real MCP server over HTTP that takes only one bearer token. */
async function httpServer(t: test.TestContext, token: string) {
  const mcp = new McpServer({ name: "http-fixture", version: "1.0.0" });
  mcp.registerTool(
    "ping",
    { description: "Answers.", inputSchema: { n: z.number() } },
    ({ n }) => ({
      content: [{ type: "text", text: `pong ${n}` }],
    }),
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcp.connect(transport);
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`)
      return void response.writeHead(401).end();
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const reply = await transport.handleRequest(
      new Request(`http://127.0.0.1${request.url}`, {
        method: request.method as string,
        headers: request.headers as Record<string, string>,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      }),
    );
    response.writeHead(reply.status, Object.fromEntries(reply.headers));
    if (reply.body) for await (const chunk of reply.body) response.write(chunk);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const stop = () => {
    server.closeAllConnections();
    server.close();
  };
  t.after(stop);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, stop };
}

test("a url connection sends its token, and is seen to go when its server dies", async (t) => {
  const { mcp, consumerOf, connected } = await setup(t, { pingEveryMs: 100, firstDelayMs: 200 });
  const token = randomUUID();
  const server = await httpServer(t, token);
  const { connection, target } = await mcp.create({
    kind: "url",
    params: { url: `${server.url}?key=abc` },
    secrets: { token },
    name: "Remote",
  });
  assert.equal(target, server.url, "the query isn't shown");
  await connected(connection);
  const { call, heard } = await consumerOf(connection);
  assert.deepEqual(await call.call({ name: "ping", arguments: { n: 1 } }), { output: "pong 1" });

  // Nothing tells a url connection its server has gone: it asks, and notices.
  server.stop();
  await until(() => heard.changed === 1);
  await until(async () => (await mcp.status({ connection })).state === "down");
  await assert.rejects(call.list({}), refused("not_connected"));
  const { detail } = await mcp.status({ connection });
  assert.ok(detail && !detail.includes("key=abc"), detail);

  // The wrong token never connects.
  const { connection: wrong } = await mcp.create({
    kind: "url",
    params: { url: (await httpServer(t, token)).url },
    secrets: { token: "not-the-token" },
    name: "Wrong",
  });
  await until(async () => (await mcp.status({ connection: wrong })).state === "down");
  const refusedBy = await mcp.status({ connection: wrong });
  assert.doesNotMatch(refusedBy.detail ?? "", /ended/, "it says why, not just that it ended");
  assert.equal(heard.changed, 1, "a connection that never came up changes nothing");
});

test("a secret reaches its server and the provider's file, and nothing that is read back", async (t) => {
  const { hub, person, mcp, dir, logged, connected } = await setup(t, { firstDelayMs: 100 });
  const secret = `secret-${randomUUID()}\nsecond-line-${randomUUID()}`;
  // Connected through a server that gets it as a variable, and one that prints it and dies.
  const { connection, target } = await mcp.create({
    kind: "command",
    params: command,
    secrets: { GIVEN: secret },
    name: "Holds it",
  });
  await connected(connection);
  const printing = await mcp.create({
    kind: "command",
    params: {
      command: process.execPath,
      args: ["-e", "console.error('it is', process.env.GIVEN); process.exit(1)"],
    },
    secrets: { GIVEN: secret },
    name: "Prints it",
  });
  await until(async () => (await mcp.status({ connection: printing.connection })).state === "down");
  await until(() => logged.some((line) => line.includes("it is")));

  const seen = JSON.stringify({
    target,
    printing,
    statuses: [
      await mcp.status({ connection }),
      await mcp.status({ connection: printing.connection }),
    ],
    actors: await person.slots.actors.call.list({}),
    audit: hub.state.audit(0, 100_000),
    logged,
  });
  for (const part of [secret, ...secret.split("\n")])
    assert.ok(!seen.includes(JSON.stringify(part).slice(1, -1)), "the secret was read back");
  assert.ok(logged.some((line) => line.includes("[hidden]")));
  const file = join(dir, "connections.json");
  assert.ok(
    readFileSync(file, "utf8").includes(JSON.stringify(secret)),
    "it is kept for the next start",
  );
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("an unreadable file is set aside, and one bad entry doesn't stop the rest", async (t) => {
  const { mcp, dir, provider, start, connected } = await setup(t);
  const { connection } = await mcp.create({ kind: "command", params: command, name: "Fixture" });
  await connected(connection);
  await provider.current.close();
  const file = join(dir, "connections.json");
  const stored = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...stored, act_bad: { credential: 1 } }));
  provider.current = await start();
  await until(() =>
    mcp.status({ connection }).then(
      (s) => s.state === "connected",
      () => false,
    ),
  );
  await provider.current.close();
  writeFileSync(file, "{ not json");
  provider.current = await start();
  await assert.rejects(mcp.status({ connection }), refused("unknown"));
  assert.ok(readdirSync(dir).some((name) => name.startsWith("connections.json.unreadable-")));
});

test("connections stay across a restart, kept privately; removing one closes its Actor", async (t) => {
  const { hub, person, mcp, dir, provider, start, consumerOf, connected } = await setup(t);
  const { connection } = await mcp.create({ kind: "command", params: command, name: "Fixture" });
  const { connection: other } = await mcp.create({
    kind: "command",
    params: command,
    name: "Other",
  });
  await connected(connection);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, "connections.json")).mode & 0o777, 0o600);

  await provider.current.close();
  await until(() => !hub.connected(connection));
  // Closed while the provider was away: it isn't joined again, and is forgotten.
  await person.slots.actors.call.close({ actorId: other });
  provider.current = await start();
  await until(() => hub.connected(connection));
  const stored = JSON.parse(readFileSync(join(dir, "connections.json"), "utf8"));
  assert.deepEqual(Object.keys(stored), [connection]);
  await until(() =>
    mcp.status({ connection }).then(
      (s) => s.state === "connected",
      () => false,
    ),
  );
  await assert.rejects(mcp.status({ connection: other }), refused("unknown"));

  const { call } = await consumerOf(connection);
  const pid = Number((await call.call({ name: "pid", arguments: {} })).output);
  assert.ok(pid > 0);
  await mcp.remove({ connection });
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  assert.equal((await person.slots.actors.call.get({ actorId: connection })).state, "closed");
  await assert.rejects(mcp.status({ connection }), refused("unknown"));
  await assert.rejects(mcp.remove({ connection }), refused("unknown"));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "connections.json"), "utf8")), {});
});
