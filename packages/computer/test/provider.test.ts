// The connector against a real Hub and a real AgentComputer: the published service, on a port and
// in a folder of each test's own, driving the headless shell Playwright installed.
import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Computer } from "@agentorg/computer";
import { Hub, listen, PERSON } from "@agentorg/hub";
import { capability, tools, Unit, unitProvider } from "@agentorg/interfaces";
import { Refused } from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { startComputerProvider } from "../src/index.ts";

const refused = (code: string) => (error: unknown) =>
  error instanceof Refused && error.code === code;
const until = async (condition: () => boolean | Promise<boolean>, ms = 30_000) => {
  for (let waited = 0; !(await condition()); waited += 20) {
    if (waited > ms) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const SERVICE = join(
  dirname(createRequire(import.meta.url).resolve("@agentorg/computer")),
  "agentcomputer.js",
);
/** The browser Playwright installed for the tests. */
function headlessShell(): string {
  const root =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Caches", "ms-playwright")
      : join(homedir(), ".cache", "ms-playwright"));
  // With no browsers installed at all, there is no such folder to read.
  const installed = existsSync(root) ? readdirSync(root) : [];
  for (const entry of installed.filter((one) => one.startsWith("chromium_headless_shell")))
    for (const inner of readdirSync(join(root, entry), { withFileTypes: true }))
      if (inner.isDirectory())
        for (const file of ["chrome-headless-shell", "headless_shell"])
          if (existsSync(join(root, entry, inner.name, file)))
            return join(root, entry, inner.name, file);
  throw new Error(
    `No headless shell under ${root}: run npx playwright install --only-shell chromium`,
  );
}

/** The computer image a container is made from, where the tests are given one. */
const IMAGE = process.env.AGENTCOMPUTER_TEST_IMAGE;

/**
 * A stand-in for a service, which makes computers on paper: it answers what the connector asks as
 * AgentComputer would, and keeps each request with the token it came with. Its computers' tools
 * can't be reached.
 */
async function standIn(
  t: test.TestContext,
  records: Record<string, Record<string, unknown>> = {},
  /**
   * `mcp`: each computer's endpoints answer as an MCP server with no tools, whatever its state, as
   * one whose connection hasn't found it down yet does. `startMs`: how long a start takes.
   */
  { mcp = false, startMs = 0 } = {},
) {
  const token = "the-service-token";
  const asked: {
    method: string;
    path: string;
    at: number;
    token?: string;
    body?: Record<string, unknown>;
  }[] = [];
  const computers = new Map<string, Record<string, unknown>>(Object.entries(records));
  /** What it says of this computer, which a test may change: each part ready, or why not. */
  const thisComputer = {
    ready: true,
    capabilities: [] as { capability: string; ready: boolean; reason?: string }[],
    browsers: [] as { kind: string; ready: boolean; reason?: string }[],
  };
  /** The person's switches, as its setup says them, which a test may set. */
  const setup: { capability: string; on: boolean }[] = [];
  // Its address as it listens: a request that comes as it closes is still answered.
  let base = "";
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const path = new URL(request.url ?? "/", "http://here").pathname;
    const given = request.headers.authorization?.replace(/^Bearer /, "");
    asked.push({
      method: request.method ?? "",
      path,
      at: Date.now(),
      ...(given ? { token: given } : {}),
      ...(raw ? { body: JSON.parse(raw) } : {}),
    });
    const send = (status: number, value?: unknown) => {
      response.statusCode = status;
      response.setHeader("content-type", "application/json");
      response.end(value === undefined ? undefined : JSON.stringify(value));
    };
    const endpoint = /^\/v1\/computers\/[^/]+\/(mcp|browser|screen)$/.test(path);
    if (mcp && endpoint && given === "its-own-token") {
      if (request.method !== "POST") return send(405);
      const message = JSON.parse(raw) as {
        id?: number;
        method: string;
        params?: { protocolVersion?: string };
      };
      if (message.id === undefined) {
        response.statusCode = 202;
        return response.end();
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: message.params?.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "stand-in", version: "0.0.0" },
            }
          : message.method === "tools/list"
            ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
            : message.method === "tools/call"
              ? { content: [{ type: "text", text: "echoed" }] }
              : {};
      return send(200, { jsonrpc: "2.0", id: message.id, result });
    }
    if (given !== token)
      return send(401, { code: 401, message: "That isn't this service's token." });
    if (request.method === "GET" && path === "/v1/setup")
      return send(200, {
        capabilities: setup.map((one) => ({ ...one, ready: one.on, needs: [] })),
      });
    if (request.method === "GET" && path === "/v1/info")
      return send(200, {
        version: "0.0.20",
        thisComputer,
        made: [{ isolation: "container", ready: true, capabilities: [], browsers: [] }],
      });
    if (request.method === "POST" && path === "/v1/computers") {
      const asks = JSON.parse(raw) as Record<string, unknown>;
      // A copy as the service takes one: of a folder that is there, with no workspace or files.
      const from = asks.copyFrom;
      if (
        typeof from === "string" &&
        (asks.workspace !== undefined ||
          asks.access === "none" ||
          !statSync(from, { throwIfNoEntry: false })?.isDirectory())
      )
        return send(400, { code: 400, message: `That copy can't be made from ${from}.` });
      const id = `paper${computers.size + 1}`;
      const made = {
        computerID: id,
        name: asks.name,
        state: "running",
        access: asks.access,
        isolation: asks.isolation ?? "container",
        attached: false,
        browser: asks.browser ?? false,
        workspace:
          asks.workspace ?? (asks.access === "none" ? null : `/service/computers/${id}/workspace`),
        metadata: asks.metadata ?? {},
        surfaces: [],
        endpoints: {
          computer: `${base}/v1/computers/${id}/mcp`,
          ...(asks.browser ? { browser: `${base}/v1/computers/${id}/browser` } : {}),
        },
      };
      computers.set(id, made);
      return send(201, { ...made, accessToken: "its-own-token" });
    }
    if (request.method === "POST" && path === "/v1/computers/attach") {
      const asks = JSON.parse(raw) as Record<string, unknown>;
      const id = `paper${computers.size + 1}`;
      const made = {
        computerID: id,
        name: asks.name,
        state: "running",
        access: asks.access,
        isolation: "none",
        attached: true,
        browser: asks.browser ?? false,
        screen: asks.screen ?? false,
        workspace: asks.workspace,
        metadata: asks.metadata ?? {},
        surfaces: [],
        endpoints: {
          computer: asks.access === "none" ? null : `${base}/v1/computers/${id}/mcp`,
          browser: asks.browser ? `${base}/v1/computers/${id}/browser` : null,
          screen: asks.screen ? `${base}/v1/computers/${id}/screen` : null,
        },
      };
      computers.set(id, made);
      return send(201, { ...made, accessToken: "its-own-token" });
    }
    const [, id, more] = path.match(/^\/v1\/computers\/([^/]+)(\/live|\/stop|\/start)?$/) ?? [];
    const found = id ? computers.get(id) : undefined;
    if (!found || !id) return send(404, { code: 404, message: "There's no computer by that id." });
    if (more === "/stop" && request.method === "POST") {
      found.state = "stopped";
      return send(200, found);
    }
    // It fails as many starts as `failStarts` says, as when Docker isn't answering, and is left
    // stopped.
    if (more === "/start" && request.method === "POST") {
      await new Promise((resolve) => setTimeout(resolve, startMs));
      const failing = Number(found.failStarts ?? 0);
      found.failStarts = Math.max(failing - 1, 0);
      found.state = failing > 0 ? "stopped" : "running";
      return failing > 0
        ? send(409, { code: 409, message: "A container needs Docker, which isn't answering." })
        : send(200, found);
    }
    if (more === "/live" && request.method === "POST")
      return send(201, {
        url: `${base.replace("http", "ws")}/v1/live/once`,
        protocol: "terminal@1",
        surface: "terminal",
        mode: "watch",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    // What of it can be opened live is there while it runs.
    if (request.method === "GET")
      return send(200, { ...found, surfaces: found.state === "running" ? found.surfaces : [] });
    if (request.method === "DELETE") {
      computers.delete(id);
      return send(204);
    }
    send(405, { code: 405, message: "Not here." });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The connection a core holds open, by the name it gives, with the service's own token only.
  const held: { name: string | null; socket: WebSocket }[] = [];
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://here");
    if (url.pathname !== "/v1/connection" || request.headers.authorization !== `Bearer ${token}`)
      return void socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
    sockets.handleUpgrade(request, socket, head, (ws) =>
      held.push({ name: url.searchParams.get("name"), socket: ws }),
    );
  });
  t.after(() => {
    for (const { socket } of held) socket.terminate();
    sockets.close();
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const { port } = server.address() as AddressInfo;
  return {
    apiUrl: base,
    apiKey: token,
    asked,
    computers,
    held,
    thisComputer,
    setup,
    /** Gone, as a service stopped is: nothing answers at its address. */
    stop() {
      for (const { socket } of held.splice(0)) socket.terminate();
      server.closeAllConnections();
      server.close();
    },
    /**
     * Back at the same address, as a service started again is; or, `elsewhere`, on another port,
     * as the AgentOrg app starts its service again. Its address, then.
     */
    listenAgain: async (elsewhere = false) => {
      await new Promise<void>((resolve) =>
        server.listen(elsewhere ? 0 : port, "127.0.0.1", resolve),
      );
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      return base;
    },
  };
}

interface Service {
  data: string;
  apiUrl: string;
  apiKey: string;
  stop(): Promise<void>;
}
/** A real service, as the person would start it, stopped by the process this made. */
async function startService(data: string): Promise<Service> {
  const child: ChildProcess = spawn(
    process.execPath,
    [
      SERVICE,
      "serve",
      "--listen",
      "127.0.0.1:0",
      "--data",
      data,
      "--browser-path",
      headlessShell(),
      ...(IMAGE ? ["--image", IMAGE] : []),
    ],
    { stdio: "ignore" },
  );
  const record = join(data, "server.json");
  await until(() => existsSync(record));
  const { url } = JSON.parse(readFileSync(record, "utf8")) as { url: string };
  return {
    data,
    apiUrl: url,
    apiKey: readFileSync(join(data, "control-token"), "utf8").trim(),
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await once(child, "exit");
    },
  };
}

async function setup(
  t: test.TestContext,
  {
    service = true,
    webUrl = "",
    path = "",
    mendFirstMs = 200,
    mac = false,
    // A connection's first wait before it tries again, and how often it asks its server.
    firstDelayMs = 50,
    pingEveryMs = 200,
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-computer-")));
  // Where AgentOrg Mac keeps its record, for a test that has it; none looked for otherwise.
  const macRecord = join(root, "AgentOrg Mac");
  const dir = join(root, "provider");
  const data = join(root, "service");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "seen.txt"), "the person's file\n");
  const leaving: (() => void | Promise<void>)[] = [];
  /** What the connector logs as an error, as the app's log keeps it. */
  const logged: string[] = [];
  const hub = Hub.open(join(root, "home"));
  const server = await listen(hub);
  t.after(async () => {
    for (const leave of leaving.reverse()) await leave();
    // A service the connector started in this test's folder, if one is still recorded there.
    try {
      process.kill(JSON.parse(readFileSync(join(data, "server.json"), "utf8")).pid);
    } catch {}
    await server.close();
    hub.close();
    rmSync(root, { recursive: true, force: true });
  });
  const running = service ? await startService(data) : undefined;
  if (running) leaving.push(() => running.stop());
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
      dataFolder: data,
      agentsFolder: join(root, "Agents"),
      // No `agentcomputer` to start unless a test gives one.
      path,
      ...(webUrl ? { webUrl } : {}),
      timing: { firstDelayMs, pingEveryMs },
      mendFirstMs,
      macRecord: mac ? macRecord : null,
      log: { info() {}, warn() {}, error: (line: string) => void logged.push(line) },
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
  const apply = (values: Record<string, unknown>, secrets: Record<string, string> = {}) =>
    units.apply({
      unit: "computer",
      values: values as never,
      secrets,
      needs: {},
      agent: "act_agent",
      name: "Scout's computer",
    });
  /** This computer, attached, with its work in the test's folder. */
  const local = (access: string, more: object = {}) => ({
    kind: "this",
    access,
    workspace,
    ...more,
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
  /** What management does for the person: a slot of theirs to the Actor that is the computer. */
  const asPerson = async (actor: string) => {
    const person = hub.state.createActor(PERSON, {
      name: "Person stand-in",
      bindings: [{ slot: "held", provider: actor, export: "capability" }],
    });
    const client = await connect({
      hubUrl: server.url,
      actorId: person.actorId,
      credential: person.credential as string,
      slots: { held: capability },
    });
    leaving.push(() => client.close());
    await until(() => client.slots.held.bound);
    return client.slots.held;
  };
  const restart = async () => {
    await provider.current.close();
    provider.current = await start();
  };
  return {
    hub,
    units,
    apply,
    local,
    asAgent,
    asPerson,
    connected,
    restart,
    workspace,
    dir,
    running,
    root,
    data,
    macRecord,
    logged,
  };
}

const form = (unit: { form: { id: string }[] } | undefined, id: string) =>
  unit?.form.find((field) => field.id === id) as
    | {
        id: string;
        value: string;
        default?: unknown;
        required?: true;
        visible?: { field: string; in: unknown[] };
        options?: {
          value: string;
          description?: string;
          unavailable?: string;
          adds?: { skills: { name: string }[] };
        }[];
      }
    | undefined;

test("the form says which computer, found when it is read, and what each answer grants", async (t) => {
  const { units } = await setup(t);
  const unit = (await units.units({})).units.find((one) => one.id === "computer");
  Unit.parse(unit);
  const kind = form(unit, "kind");
  assert.equal((kind as { default?: unknown }).default, undefined, "the person chooses");
  assert.deepEqual(
    kind?.options?.map((one) => one.value),
    ["this", "new"],
  );
  assert.match(kind?.options?.[0]?.description ?? "", /acts as you/);
  assert.equal(kind?.options?.[0]?.unavailable, undefined);
  assert.deepEqual(
    form(unit, "made")?.options?.map((one) => one.value),
    ["container", "remote"],
  );
  // A container is ready or not as the service here says; either way, the form says which.
  const container = form(unit, "made")?.options?.[0]?.unavailable;
  assert.ok(container === undefined || container.length > 0);
  assert.deepEqual(form(unit, "workspace")?.visible, { field: "kind", in: ["this"] });
  assert.deepEqual(form(unit, "made")?.visible, { field: "kind", in: ["new"] });
  assert.equal(form(unit, "folder"), undefined, "a new computer has no folder of yours");
  for (const id of ["address", "token", "path"])
    assert.deepEqual(form(unit, id)?.visible, { field: "made", in: ["remote"] }, id);
  assert.equal(form(unit, "token")?.value, "secret");
  // What an agent may set: how far it reaches, within bounds. Which computer, never.
  const authority = (id: string) =>
    (form(unit, id) as { authority?: string } | undefined)?.authority;
  assert.deepEqual(
    ["kind", "workspace", "made", "address", "token", "path", "access", "browser"].map(authority),
    [undefined, undefined, undefined, undefined, undefined, undefined, "setting", "setting"],
  );
  assert.deepEqual(
    form(unit, "access")?.options?.[0]?.adds?.skills.map((one) => one.name),
    ["terminal", "files", "computer"],
  );
});

test("each skill the form names can be read, with what it shipped before, and an unknown one is refused", async (t) => {
  const { units } = await setup(t, { service: false });
  for (const name of ["terminal", "files", "computer", "browser"])
    assert.match(
      (await units.skill({ unit: "computer", name, path: "SKILL.md" })).text,
      new RegExp(`name: ${name}`),
    );
  const computer = await units.skill({ unit: "computer", name: "computer", path: "SKILL.md" });
  assert.match(computer.text, /another machine/);
  // With the sha256 of the texts it had before, and not of the one it has now.
  const now = createHash("sha256").update(computer.text).digest("hex");
  assert.ok((computer.shipped?.length ?? 0) > 0);
  assert.ok(!computer.shipped?.includes(now));
  assert.ok(computer.shipped?.every((hash) => /^[0-9a-f]{64}$/.test(hash)));
  await assert.rejects(
    units.skill({ unit: "computer", name: "nothing", path: "SKILL.md" }),
    refused("unknown"),
  );
});

test("with AgentComputer not installed, it says how to install it, and nothing is made", async (t) => {
  const { units, apply, local, hub } = await setup(t, { service: false });
  const unit = (await units.units({})).units.find((one) => one.id === "computer");
  const why = (field: string, value: string) =>
    form(unit, field)?.options?.find((one) => one.value === value)?.unavailable ?? "";
  assert.match(why("kind", "this"), /npm install -g/);
  assert.match(why("made", "container"), /npm install -g/);
  assert.equal(why("made", "remote"), "", "a service elsewhere needs nothing here");
  for (const values of [local("terminal"), { kind: "new", made: "container", access: "files" }]) {
    const { problems } = await units.check({ unit: "computer", values, secrets: [] });
    assert.deepEqual(
      problems.map((one) => one.field),
      ["kind"],
    );
    assert.match(problems[0]?.message ?? "", /npm install -g @agentorg\/computer/);
  }
  const before = hub.state.actors().length;
  await assert.rejects(apply(local("terminal")), refused("invalid"));
  assert.equal(hub.state.actors().length, before);
});

test("with AgentComputer installed and none running, adding a computer starts it, and a restart starts it again for its computer", async (t) => {
  // An install puts `agentcomputer` on the path; this one listens where nothing else does.
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-bin-")));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const command = join(bin, "agentcomputer");
  writeFileSync(
    command,
    `#!/bin/sh\nexec "${process.execPath}" "${SERVICE}" "$@" --listen 127.0.0.1:0\n`,
    { mode: 0o755 },
  );
  const { units, apply, local, connected, restart, data } = await setup(t, {
    service: false,
    path: bin,
  });
  const down = () => promisify(execFile)(command, ["down", "--data", data]);
  try {
    // Nothing of this machine is greyed: it is started when a computer is added.
    const unit = (await units.units({})).units.find((one) => one.id === "computer");
    assert.equal(form(unit, "kind")?.options?.[0]?.unavailable, undefined);
    assert.deepEqual(
      (await units.check({ unit: "computer", values: local("read"), secrets: [] })).problems,
      [],
    );
    assert.equal(existsSync(join(data, "server.json")), false, "nothing is started by reading");
    const { instance } = await apply(local("read"));
    await connected(instance);
    // It is this computer, attached.
    const reached = {
      apiUrl: JSON.parse(readFileSync(join(data, "server.json"), "utf8")).url as string,
      apiKey: readFileSync(join(data, "control-token"), "utf8").trim(),
    };
    assert.deepEqual(
      (await Computer.list(reached)).map((one) => [one.isolation, one.attached]),
      [["none", true]],
    );
    // Gone, the service is started again when the connector starts, and its computer is back.
    await down();
    assert.equal(existsSync(join(data, "server.json")), false);
    await restart();
    await connected(instance);
  } finally {
    await down().catch(() => {});
  }
});

test("the service is started with no isolation asked of it, and one older than this build is said to need an update", async (t) => {
  // An install whose start fails, saying why, after noting what it was asked.
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-bin-")));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const asked = join(bin, "asked");
  writeFileSync(
    join(bin, "agentcomputer"),
    `#!/bin/sh\necho "$@" >> "${asked}"\necho "It couldn't start." >&2\nexit 1\n`,
    { mode: 0o755 },
  );
  const { units, apply, local, data } = await setup(t, { service: false, path: bin });
  const why = async () =>
    form(
      (await units.units({})).units.find((one) => one.id === "computer"),
      "kind",
    )?.options?.[0]?.unavailable;
  // A service answers here as one before this build did, saying only how it isolates.
  const old = createServer((_, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ version: "0.0.18", isolation: "none" }));
  });
  await new Promise<void>((resolve) => old.listen(0, "127.0.0.1", resolve));
  t.after(() => old.close());
  // A live pid, so the record isn't taken for a crashed service's.
  const alive = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"]);
  t.after(() => alive.kill());
  mkdirSync(data, { recursive: true });
  writeFileSync(
    join(data, "server.json"),
    JSON.stringify({
      url: `http://127.0.0.1:${(old.address() as AddressInfo).port}`,
      pid: alive.pid,
    }),
  );
  writeFileSync(join(data, "control-token"), "token");
  assert.match((await why()) ?? "", /older than this AgentOrg needs.*npm install -g/);
  await assert.rejects(apply(local("read")), /older than this AgentOrg needs/);
  // Gone, adding a computer starts one, asking for no isolation: the service's own is used.
  await new Promise((resolve) => old.close(resolve));
  rmSync(join(data, "server.json"));
  assert.equal(await why(), undefined);
  await assert.rejects(apply(local("read")), /It couldn't start/);
  assert.equal(readFileSync(asked, "utf8"), `up --data ${data}\n`);
});

test("check says what's wrong by field, and changes nothing", async (t) => {
  const { units, running, root, workspace } = await setup(t);
  const fields = async (values: object, secrets: string[] = []) =>
    (await units.check({ unit: "computer", values: values as never, secrets })).problems.map(
      (one) => one.field,
    );
  assert.deepEqual(await fields({ kind: "this", access: "terminal" }), []);
  assert.deepEqual(await fields({ kind: "this", access: "none" }), ["access"]);
  // A browser of its own is a made computer's.
  assert.deepEqual(await fields({ kind: "this", access: "none", browser: true }), ["access"]);
  assert.deepEqual(
    await fields({ kind: "new", made: "container", access: "none", browser: true }),
    [],
  );
  // A folder that isn't there yet will do: it is made with the computer. A path that isn't a
  // full one, and one where something that isn't a folder is, won't.
  const typed = (folder: string) => fields({ kind: "this", access: "terminal", workspace: folder });
  assert.deepEqual(await typed(join(root, "not", "yet")), []);
  assert.ok(!existsSync(join(root, "not")), "checking makes nothing");
  assert.deepEqual(await typed("not/a/full/path"), ["workspace"]);
  // What making the computer couldn't make is refused here too: a file in its place or above
  // it, a link to nothing, and a folder that can't be written in.
  symlinkSync(join(root, "nowhere"), join(root, "link"));
  mkdirSync(join(root, "closed"), { mode: 0o500 });
  for (const folder of [
    join(workspace, "seen.txt"),
    `${join(workspace, "seen.txt")}/`,
    join(workspace, "seen.txt", "under"),
    join(root, "link"),
    join(root, "closed", "new"),
  ])
    assert.deepEqual(await typed(folder), ["workspace"], folder);
  assert.deepEqual(await typed(join(root, "closed")), [], "a folder that is there will do");
  // How it's made defaults to a container.
  assert.deepEqual(await fields({ kind: "new", access: "read" }), []);
  assert.deepEqual(await fields({ kind: "other", access: "read" }), ["kind"]);
  assert.deepEqual(await fields({ kind: "new", made: "elsewhere", access: "read" }), ["made"]);
  const away = { kind: "new", made: "remote", access: "read" };
  assert.deepEqual(await fields({ ...away, address: "not an address" }, ["token"]), ["address"]);
  assert.deepEqual(await fields({ ...away, address: "http://far.example/" }, ["token"]), [
    "address",
  ]);
  assert.deepEqual(await fields({ ...away, address: "https://far.example/" }, ["token"]), []);
  await assert.rejects(
    units.check({ unit: "nothing", values: {}, secrets: [] }),
    refused("unknown"),
  );
  const reached = running as Service;
  assert.deepEqual(await Computer.list(reached), []);
});

test("on a real service, an agent runs a command, lists it and edits a file, through tools", async (t) => {
  const { apply, local, asAgent, connected, workspace, units } = await setup(t);
  const { instance, connections } = await apply(local("terminal"));
  assert.deepEqual(
    connections.map((one) => one.slot),
    ["computer"],
  );
  assert.match(connections[0]?.target ?? "", /This computer, as you: files and terminal/);
  await connected(instance);
  const computer = await asAgent(connections[0]?.connection as string);
  const ran = await computer.call({
    name: "exec_command",
    arguments: { cmd: "cat seen.txt && echo from-the-agent > made.txt" },
  });
  assert.equal(ran.failed, undefined);
  assert.match(ran.output, /the person's file/);
  assert.equal(readFileSync(join(workspace, "made.txt"), "utf8"), "from-the-agent\n");
  // It lists its sessions, the command it just ran among them.
  const sessions = await computer.call({ name: "list_sessions", arguments: {} });
  assert.equal(sessions.failed, undefined);
  assert.match(sessions.output, /cat seen\.txt/);
  const edited = await computer.call({
    name: "edit",
    arguments: { path: "seen.txt", old_text: "person's", new_text: "edited" },
  });
  assert.equal(edited.failed, undefined, edited.output);
  assert.equal(readFileSync(join(workspace, "seen.txt"), "utf8"), "the edited file\n");
  await units.remove({ instance });
});

test("on a real service, this computer with its files switched off can't be chosen, and its terminal switched off is the service's to refuse its agent", async (t) => {
  const { apply, local, asAgent, connected, units, running } = await setup(t);
  const service = running as Service;
  // The person's switch, as the AgentOrg app sets it: only the files and the terminal, which
  // need nothing to be asked for.
  const set = async (part: "files" | "terminal", on: boolean) => {
    const response = await fetch(`${service.apiUrl}/v1/setup/${part}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${service.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ on }),
    });
    assert.equal(response.status, 200);
  };
  const thisOne = async () =>
    form(
      (await units.units({})).units.find((one) => one.id === "computer"),
      "kind",
    )?.options?.find((one) => one.value === "this")?.unavailable;
  await set("files", false);
  assert.match(
    (await thisOne()) ?? "",
    /^The person turned off the files for agents on this \w+\.$/,
  );
  await set("files", true);
  await set("terminal", false);
  assert.equal(await thisOne(), undefined);
  const { instance, connections } = await apply(local("terminal"));
  await connected(instance);
  const computer = await asAgent(connections[0]?.connection as string);
  const ran = await computer.call({ name: "exec_command", arguments: { cmd: "echo ran" } });
  assert.match(ran.output, /^The person turned off the terminal for agents on this \w+\.$/m);
  assert.doesNotMatch(ran.output, /^ran$/m);
  await set("terminal", true);
  const again = await computer.call({ name: "exec_command", arguments: { cmd: "echo ran" } });
  assert.match(again.output, /^ran$/m);
  await units.remove({ instance });
});

test("access goes to the service: a read-only computer can't change or run anything", async (t) => {
  const { apply, local, asAgent, connected, workspace, units } = await setup(t);
  const { instance, connections } = await apply(local("read"));
  await connected(instance);
  const computer = await asAgent(connections[0]?.connection as string);
  assert.deepEqual((await computer.list({})).tools.map((one) => one.name).sort(), [
    "about",
    "list",
    "read",
    "search",
  ]);
  assert.equal(readFileSync(join(workspace, "seen.txt"), "utf8"), "the person's file\n");
  await units.remove({ instance });
});

test("on a real service, an agent reads a page with its browser, in a container of its own", {
  skip: !IMAGE && "a container needs AGENTCOMPUTER_TEST_IMAGE",
  timeout: 180_000,
}, async (t) => {
  const page = createServer((_, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<title>A page</title><p>Words only a browser could fetch.</p>");
  });
  page.listen(0, "127.0.0.1");
  await once(page, "listening");
  t.after(() => page.close());
  const { port } = page.address() as AddressInfo;
  const { apply, asAgent, connected, units, running } = await setup(t);
  const { instance, connections } = await apply({
    kind: "new",
    made: "container",
    access: "none",
    browser: true,
  });
  assert.deepEqual(
    connections.map((one) => one.slot),
    ["browser"],
  );
  await connected(instance);
  // Its picture can be opened live: the service says so, and gives a ticket for it. How busy the
  // computer is can only be watched.
  const { surfaces } = await units.status({ instance });
  assert.deepEqual(
    surfaces?.map(({ surface, protocol, operate }) => [surface, protocol, operate]),
    [
      ["browser", "screencast@1", true],
      ["load", "metrics@1", false],
    ],
  );
  const ticket = await units.live({ instance, surface: "browser", mode: "watch" });
  assert.equal(ticket.protocol, "screencast@1");
  assert.match(ticket.url, /^ws:\/\/127\.0\.0\.1:\d+\//);
  const browser = await asAgent(connections[0]?.connection as string);
  const opened = await browser.call({
    name: "browser_navigate",
    arguments: { url: `http://127.0.0.1:${port}/` },
  });
  assert.equal(opened.failed, undefined, opened.output);
  const seen = await browser.call({ name: "browser_snapshot", arguments: {} });
  assert.match(`${opened.output}${seen.output}`, /Words only a browser could fetch/);
  await units.remove({ instance });
  // The service is still there for the next one.
  assert.equal((await Computer.serviceInfo(running as Service)).thisComputer.ready, true);
});

test("a typed workspace folder that is missing is made; one that can't be made is refused and leaves no computer", async (t) => {
  const { apply, root, workspace, running, dir } = await setup(t);
  const folder = join(root, "deep", "er", "work");
  const made = await apply({ kind: "this", access: "files", workspace: folder });
  assert.ok(statSync(folder).isDirectory());
  const kept = JSON.parse(readFileSync(join(dir, "instances.json"), "utf8"));
  const info = await Computer.getInfo(kept[made.instance].computer.id, running as Service);
  assert.equal(info.workspace, folder, "and it is the computer's folder");
  // Under a file nothing can be made.
  const before = (await Computer.list(running as Service)).length;
  await assert.rejects(
    apply({ kind: "this", access: "files", workspace: join(workspace, "seen.txt", "under") }),
    (error: Error & { code?: string }) =>
      error.code === "invalid" && /can't be made/.test(error.message),
  );
  assert.equal((await Computer.list(running as Service)).length, before);
});

test("removing detaches this computer: the service forgets it, and its folder stays", async (t) => {
  const { apply, local, connected, workspace, units, running, dir, root } = await setup(t);
  const reached = running as Service;
  const named = await apply(local("terminal"));
  // With no folder named, its work happens in one with its name.
  const unnamed = await apply({ kind: "this", access: "files" });
  await connected(named.instance);
  const kept = JSON.parse(readFileSync(join(dir, "instances.json"), "utf8"));
  const idOf = (instance: string) => kept[instance].computer.id as string;
  const [namedId, unnamedId] = [idOf(named.instance), idOf(unnamed.instance)];
  const folder = join(root, "Agents", "Scout's computer");
  assert.equal((await Computer.getInfo(unnamedId, reached)).workspace, folder);
  assert.ok(unnamed.connections[0]?.target.endsWith(`in ${folder}`), "so the person can find it");
  assert.ok(named.connections[0]?.target.endsWith(`in ${workspace}`));

  await units.remove({ instance: named.instance });
  await units.remove({ instance: unnamed.instance });
  for (const id of [namedId, unnamedId])
    await assert.rejects(Computer.getInfo(id, reached), /no computer/);
  assert.equal(readFileSync(join(workspace, "seen.txt"), "utf8"), "the person's file\n");
  assert.ok(statSync(folder).isDirectory());
  await assert.rejects(units.status({ instance: named.instance }), refused("unknown"));
});

test("a computer at another address is made there with its token, which stays in the private file", async (t) => {
  const { apply, units, dir, hub } = await setup(t, { service: false });
  const there = await standIn(t);
  const away = {
    kind: "new",
    made: "remote",
    address: there.apiUrl,
    access: "terminal",
    path: "/work",
  };
  const { instance, connections } = await apply(away, { token: there.apiKey });
  // Made there as that service makes them: nothing asks it how.
  const made = there.asked.find((one) => one.method === "POST" && one.path === "/v1/computers");
  assert.equal(made?.token, there.apiKey);
  assert.equal(made?.body?.isolation, undefined);
  assert.equal(made?.body?.workspace, "/work");
  assert.match(connections[0]?.target ?? "", /^127\.0\.0\.1:\d+: files and terminal in \/work$/);
  const status = await units.status({ instance });
  const file = readFileSync(join(dir, "instances.json"), "utf8");
  assert.ok(file.includes(there.apiKey), "kept to reach it again");
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  for (const seen of [
    JSON.stringify(status),
    JSON.stringify(connections),
    JSON.stringify(hub.state.audit(0, 100_000)),
  ])
    assert.ok(!seen.includes(there.apiKey));
  await units.remove({ instance });
  assert.equal(there.computers.size, 0);

  // A wrong token makes nothing.
  const actors = hub.state.actors().length;
  await assert.rejects(apply(away, { token: "wrong" }));
  assert.equal(hub.state.actors().length, actors);
});

test("a computer is named as its agent on its service, which says who acts on it by that name, and its presence opens live", async (t) => {
  const { units, asPerson } = await setup(t, { service: false });
  const there = await standIn(t);
  const made = await units.apply({
    unit: "computer",
    values: { kind: "new", made: "remote", address: there.apiUrl, access: "terminal" },
    secrets: { token: there.apiKey },
    needs: {},
    agent: "act_agent",
    name: "Scout: Computer",
    agentName: "Scout",
  });
  const asked = there.asked.find((one) => one.method === "POST" && one.path === "/v1/computers");
  assert.equal(asked?.body?.name, "Scout");
  // Who acts on it is a live surface of its own, opened as any other.
  const held = await asPerson(made.capability?.actor as string);
  await held.call.live({ surface: "presence", mode: "watch" });
  const live = there.asked.find((one) => one.method === "POST" && one.path.endsWith("/live"));
  assert.deepEqual(live?.body, { surface: "presence", mode: "watch" });
  await units.remove({ instance: made.instance });
});

test("endpoints are at the address given, whatever the service calls itself", async (t) => {
  const { apply, dir, units } = await setup(t, { service: false });
  const there = await standIn(t);
  const { port } = new URL(there.apiUrl);
  const { instance } = await apply(
    { kind: "new", made: "remote", address: `http://localhost:${port}`, access: "terminal" },
    { token: there.apiKey },
  );
  const kept = JSON.parse(readFileSync(join(dir, "instances.json"), "utf8"));
  assert.match(kept[instance].links[0].url, new RegExp(`^http://localhost:${port}/`));
  // So is a live session's socket.
  const ticket = await units.live({ instance, surface: "terminal", mode: "watch" });
  assert.match(ticket.url, new RegExp(`^ws://localhost:${port}/`));
  await units.remove({ instance });
});

test("a computer's connections that are down say why in words: the service's own, or that it isn't running", async (t) => {
  const { apply, units } = await setup(t, { service: false });
  const there = await standIn(t);
  const away = { kind: "new", made: "remote", address: there.apiUrl, access: "terminal" };
  const downOf = async (instance: string) => {
    await until(async () => (await units.status({ instance })).state === "down");
    const { detail, connections } = await units.status({ instance });
    return [detail, ...connections.map((one) => one.detail)];
  };
  // Running, its tools refuse the computer's own token here: the service's message, as it says it.
  const running = await apply(away, { token: there.apiKey });
  assert.deepEqual(await downOf(running.instance), [
    "That isn't this service's token.",
    "That isn't this service's token.",
  ]);
  // One the service says has stopped says so, for it and each of its connections.
  const stopped = await apply(away, { token: there.apiKey });
  const record = [...there.computers.values()].at(-1) as Record<string, unknown>;
  record.state = "stopped";
  assert.deepEqual(await downOf(stopped.instance), [
    "Its computer has stopped.",
    "Its computer has stopped.",
  ]);
  // One being made or started says why in its service's words, or that it is being started.
  record.state = "starting";
  record.reason = "Its image is being fetched.";
  await until(
    async () =>
      (await units.status({ instance: stopped.instance })).detail === "Its image is being fetched.",
  );
  assert.ok(
    (await units.status({ instance: stopped.instance })).connections.every(
      (one) => one.detail === "Its image is being fetched.",
    ),
  );
  delete record.reason;
  await until(
    async () =>
      (await units.status({ instance: stopped.instance })).detail ===
      "Its computer is being started.",
  );
  await units.remove({ instance: running.instance });
  await units.remove({ instance: stopped.instance });
});

test("a computer its service says failed is stopped and started again by itself, after a restart too, until it runs", async (t) => {
  const { apply, units, dir, restart, logged } = await setup(t, {
    service: false,
    mendFirstMs: 60_000,
  });
  const there = await standIn(t);
  const away = { kind: "new", made: "remote", address: there.apiUrl, access: "terminal" };
  const { instance } = await apply(away, { token: there.apiKey });
  const record = [...there.computers.values()].at(-1) as Record<string, unknown>;
  const asked = () =>
    there.asked
      .filter((one) => one.method === "POST" && /\/(stop|start)$/.test(one.path))
      .map((one) => one.path.split("/").at(-1));
  const kept = () => JSON.parse(readFileSync(join(dir, "instances.json"), "utf8"))[instance];
  // It fails, and so does the start it is given at once, which leaves it stopped.
  record.state = "failed";
  record.failStarts = 1;
  await until(async () => (await units.status({ instance })).state === "down");
  await until(() => asked().length === 2);
  await until(
    async () =>
      (await units.status({ instance })).detail ===
      "Its computer failed, and is started again by itself.",
  );
  const between = await units.status({ instance });
  assert.ok(between.connections.every((one) => one.detail === between.detail));
  assert.equal(kept().restarting, true, "stopped here, it is kept to be started again");
  // The next try would be a minute on; a restart meanwhile starts it again at once.
  await restart();
  await until(() => record.state === "running");
  assert.deepEqual(asked(), ["stop", "start", "start"]);
  // Each try is in the app's log, with the one that didn't start and why, naming the instance.
  assert.deepEqual(
    logged.filter((line) => line.startsWith(`${instance}: `)),
    [
      `${instance}: its computer failed, and is stopped and started again.`,
      `${instance}: its computer didn't start again: A container needs Docker, which isn't answering.`,
      `${instance}: its computer failed, and is stopped and started again.`,
    ],
  );
  await until(() => kept().restarting === undefined);
  // Running, it says what its service says, and isn't tried again.
  await until(
    async () => (await units.status({ instance })).detail === "That isn't this service's token.",
  );
  // A mark left on one that runs, as when the app went down before clearing it, is cleared when
  // it is looked at, and nothing is started.
  const file = JSON.parse(readFileSync(join(dir, "instances.json"), "utf8"));
  file[instance].restarting = true;
  writeFileSync(join(dir, "instances.json"), JSON.stringify(file));
  await restart();
  await units.status({ instance });
  await until(() => kept().restarting === undefined);
  assert.equal(asked().length, 3);
  // Stopped by someone else, it is left so, a restart and its connections going down included.
  record.state = "stopped";
  await restart();
  await until(
    async () => (await units.status({ instance })).detail === "Its computer has stopped.",
  );
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(asked().length, 3);
  await units.remove({ instance });
});

test("a computer that keeps failing waits longer each time, and one being made is left to be made", async (t) => {
  const { apply, units, restart } = await setup(t, { service: false, mendFirstMs: 400 });
  const there = await standIn(t);
  const away = { kind: "new", made: "remote", address: there.apiUrl, access: "terminal" };
  const { instance } = await apply(away, { token: there.apiKey });
  const record = [...there.computers.values()].at(-1) as Record<string, unknown>;
  const tries = () =>
    there.asked.filter((one) => one.method === "POST" && /\/(stop|start)$/.test(one.path));
  const starts = () => tries().filter((one) => one.path.endsWith("/start"));
  record.state = "failed";
  record.failStarts = 3;
  await until(async () => (await units.status({ instance })).state === "down");
  await until(() => record.state === "running", 10_000);
  // At once, then after 400 ms, 800 ms and 1.6 s: each wait twice the last.
  const at = starts().map((one) => one.at);
  assert.equal(at.length, 4);
  const waits = at.slice(1).map((time, i) => time - (at[i] as number));
  assert.ok(
    waits.every((wait, i) => wait >= 400 * 2 ** i && wait < 400 * 2 ** i + 1000),
    String(waits),
  );
  // Being made, as a later service says, it is neither stopped nor started when its connections
  // go down, as at a restart.
  const before = tries().length;
  const looked = there.asked.length;
  record.state = "starting";
  await restart();
  await until(() => there.asked.slice(looked).some((one) => one.method === "GET"));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(tries().length, before);
  await units.remove({ instance });
});

test("a computer that isn't running says so at once and keeps its windows' place, sampled as a page reads it through a failure, a start again and a stop", async (t) => {
  const { apply, units, asPerson, connected } = await setup(t, {
    service: false,
    mendFirstMs: 60_000,
  });
  // Its connections stay up throughout, as they did for 18 s in a real run before one found out.
  const there = await standIn(t, {}, { mcp: true, startMs: 500 });
  const away = { kind: "new", made: "remote", address: there.apiUrl, access: "terminal" };
  const made = await apply(away, { token: there.apiKey });
  const { instance } = made;
  const record = [...there.computers.values()].at(-1) as Record<string, unknown>;
  record.surfaces = [{ surface: "terminal", protocol: "terminal@1", operate: true }];
  await connected(instance);
  const held = await asPerson(made.capability?.actor as string);
  let changes = 0;
  held.on("changed", () => void changes++);
  const starts = () =>
    there.asked.filter((one) => one.method === "POST" && one.path.endsWith("/start")).length;
  /**
   * What a page is told at each read, every 100 ms until `done`: its unit's status, as the page's
   * own refresh reads it, then its capability's state, as the page reads it when it changes.
   */
  const sampled = async (done: () => boolean) => {
    const seen: { at: number; down: boolean; detail?: string; windows: boolean }[] = [];
    while (!done()) {
      for (const read of [() => units.status({ instance }), () => held.call.state({})]) {
        const stands = await read();
        seen.push({
          at: Date.now(),
          down: stands.state === "down",
          ...(stands.detail ? { detail: stands.detail } : {}),
          windows: (stands.surfaces?.length ?? 0) > 0,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return seen;
  };
  const FAILED = "Its computer failed, and is started again by itself.";
  const TRYING = "Its computer is being started again.";
  const STOPPED = "Its computer has stopped.";

  // It fails, as a container killed does, and is stopped and started again, which takes a while.
  let back = false;
  const failedAt = Date.now();
  record.state = "failed";
  const failing = sampled(() => back);
  await until(() => record.state === "running");
  await until(async () => (await held.call.state({})).state === "connected");
  back = true;
  const seen = await failing;
  // Each read has its windows, or says it is down: the page keeps its Computer tab throughout.
  assert.ok(
    seen.every((one) => one.windows || one.down),
    JSON.stringify(seen),
  );
  // Down from the first read after it failed, saying what is happening, until it runs again.
  const first = seen.find((one) => one.down);
  assert.ok(first && first.at - failedAt < 2500, JSON.stringify(seen));
  const said = new Set(seen.filter((one) => one.down).map((one) => one.detail));
  assert.ok(said.has(TRYING), [...said].join(" | "));
  assert.ok(
    [...said].every((one) => one === FAILED || one === TRYING),
    [...said].join(" | "),
  );
  // Running again, with its windows.
  assert.ok((await held.call.state({})).surfaces.length > 0);
  assert.equal(starts(), 1);

  // Stopped by someone else: down at once in its words, and a page told so, though nothing is
  // tried on it; and told again when it runs again.
  const before = changes;
  back = false;
  const stoppedAt = Date.now();
  record.state = "stopped";
  const stopping = sampled(() => back);
  await until(async () => (await held.call.state({})).detail === STOPPED);
  await until(() => changes > before);
  record.state = "running";
  await until(async () => (await held.call.state({})).state === "connected");
  await until(() => changes > before + 1);
  back = true;
  const stopped = await stopping;
  assert.ok(
    stopped.every((one) => one.windows || one.down),
    JSON.stringify(stopped),
  );
  const down = stopped.filter((one) => one.down);
  assert.ok((down[0]?.at ?? Number.POSITIVE_INFINITY) - stoppedAt < 2500, JSON.stringify(stopped));
  assert.ok(
    down.every((one) => one.detail === STOPPED),
    JSON.stringify(down),
  );
  assert.equal(starts(), 1, "one stopped by someone else isn't started");
  await units.remove({ instance });
});

test("this computer whose service here has gone says so at once: AgentOrg Mac's, or the one this machine runs", async (t) => {
  for (const mac of [true, false])
    await t.test(mac ? "AgentOrg Mac" : "the service this machine runs", async (t) => {
      const command = onPathThatSays(t);
      const { units, apply, local, asPerson, connected, macRecord, data } = await setup(t, {
        service: false,
        path: command.bin,
        mac,
      });
      const app = await standIn(t, {}, { mcp: true });
      const folder = mac ? macRecord : data;
      const alive = recordIn(t, folder, app);
      const made = await apply(local("terminal"));
      await connected(made.instance);
      const held = await asPerson(made.capability?.actor as string);
      // It quits: its record stays, naming a process that has gone.
      alive.kill();
      await once(alive, "exit");
      const words = mac
        ? "The AgentOrg app isn't open on this Mac. Open it to use this computer."
        : "No AgentComputer is running on this machine. Start it with agentcomputer up.";
      await until(async () => (await held.call.state({})).detail === words, 3000);
      const status = await units.status({ instance: made.instance });
      assert.equal(status.state, "down");
      assert.ok(status.connections.every((one) => one.state === "down" && one.detail === words));
      // Open again, it is connected again; nothing of AgentComputer was started meanwhile.
      recordIn(t, folder, app);
      await until(async () => (await held.call.state({})).state === "connected", 3000);
      assert.equal(command.ran(), false);
      await units.remove({ instance: made.instance });
    });
});

test("a service here that goes and comes back: its computer is said gone, then reached again at once, never in a connection's own words", async (t) => {
  // A connection waits 20 s before it tries again: only being told makes it in time.
  const { units, apply, local, asPerson, connected, data } = await setup(t, {
    service: false,
    firstDelayMs: 20_000,
  });
  const app = await standIn(t, {}, { mcp: true });
  let alive = recordIn(t, data, app);
  const made = await apply(local("terminal"));
  const { instance } = made;
  await connected(instance);
  const held = await asPerson(made.capability?.actor as string);
  /** Every word the capability and the unit's status said, read every 100 ms until `done`. */
  const said = new Set<string>();
  let done = false;
  t.after(() => {
    done = true;
  });
  const sampling = (async () => {
    while (!done) {
      const read = await Promise.all([held.call.state({}), units.status({ instance })]).catch(
        () => undefined,
      );
      const [stands, status] = read ?? [];
      for (const one of [
        stands?.detail,
        status?.detail,
        ...(status?.connections ?? []).map((c) => c.detail),
      ])
        if (one) said.add(one);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  // It goes, as `agentcomputer down` makes it: its record names a process gone, and nothing
  // answers at its address.
  alive.kill();
  await once(alive, "exit");
  app.stop();
  const GONE = "No AgentComputer is running on this machine. Start it with agentcomputer up.";
  await until(async () => (await held.call.state({})).detail === GONE);
  await until(async () =>
    (await units.status({ instance })).connections.every((one) => one.state === "down"),
  );
  // Back at the same address, as `agentcomputer up` makes it.
  await app.listenAgain();
  const back = Date.now();
  alive = recordIn(t, data, app);
  await until(async () => (await units.status({ instance })).state === "connected", 5000);
  assert.ok(Date.now() - back < 4000, `connected ${Date.now() - back} ms after`);
  done = true;
  await sampling;
  // Only the computer's own words were said meanwhile.
  assert.ok(
    [...said].every((one) => one === GONE || one === "Its computer is being reached again."),
    [...said].join(" | "),
  );
  await units.remove({ instance });
});

test("a service here started again on another port: its computer's tools come back within seconds, with nothing reading how it stands", async (t) => {
  // A connection waits 20 s before it tries again, and asks its server only each minute: only the
  // service coming back makes it in time.
  const { apply, local, asAgent, connected, data } = await setup(t, {
    service: false,
    firstDelayMs: 20_000,
    pingEveryMs: 60_000,
  });
  const app = await standIn(t, {}, { mcp: true });
  let alive = recordIn(t, data, app);
  const made = await apply(local("terminal"));
  await connected(made.instance);
  const tools = await asAgent(made.connections[0]?.connection as string);
  const echoes = () =>
    tools.call({ name: "echo", arguments: {} }).then(
      (answer) => !answer.failed && answer.output.includes("echoed"),
      () => false,
    );
  assert.ok(await echoes());
  // It goes, and comes back on another port, as the AgentOrg app starts its service again: its
  // connection hasn't noticed, and is still taken for connected.
  alive.kill();
  await once(alive, "exit");
  app.stop();
  const apiUrl = await app.listenAgain(true);
  const back = Date.now();
  alive = recordIn(t, data, { apiUrl, apiKey: app.apiKey });
  // With nothing asked of it, neither a call nor how it stands, it is connected again there.
  await until(
    () =>
      app.asked.some(
        (one) => one.at >= back && one.path.endsWith("/mcp") && one.body?.method === "initialize",
      ),
    8000,
  );
  assert.ok(Date.now() - back < 6000, `connected again ${Date.now() - back} ms after`);
  assert.ok(await echoes());
});

test("a computer made before today's words says in its status what it is in them; one made now doesn't", async (t) => {
  const { apply, units, dir, restart } = await setup(t, { service: false });
  const there = await standIn(t);
  const away = { kind: "new", made: "remote", address: there.apiUrl, access: "files" };
  const { instance, capability } = await apply(away, { token: there.apiKey });
  assert.equal((await units.status({ instance })).now, undefined, "made in today's words");
  assert.deepEqual(capability?.rows?.where, [
    { label: "Computer", value: new URL(there.apiUrl).host, note: "At another address" },
  ]);
  // As kept by a version before: with no words, or with the words before its page showed who is
  // acting on it, the answers it was made with.
  for (const words of [undefined, 1]) {
    const file = JSON.parse(readFileSync(join(dir, "instances.json"), "utf8"));
    file[instance].words = words;
    writeFileSync(join(dir, "instances.json"), JSON.stringify(file));
    await restart();
    // Its folder the service made, which goes with it, isn't an answer.
    assert.deepEqual((await units.status({ instance })).now, {
      values: {
        kind: "new",
        made: "remote",
        address: there.apiUrl,
        access: "files",
        browser: false,
      },
      rows: {
        where: [
          { label: "Computer", value: new URL(there.apiUrl).host, note: "At another address" },
        ],
        workspace: [
          { label: "Reaches", value: "Files" },
          { label: "Browser", value: "None" },
        ],
      },
    });
  }
  await units.remove({ instance });
});

test("a container from before with a folder of yours says so in today's words", async (t) => {
  const { units, dir, data, root, hub, restart } = await setup(t, { service: false });
  const kept = join(root, "Agents", "Scout");
  mkdirSync(kept, { recursive: true });
  // As 0.0.13 made it, and as the service says of it now: a container, with that folder mounted.
  const here = await standIn(t, {
    old: {
      computerID: "old",
      name: "Scout's computer",
      state: "running",
      access: "files",
      isolation: "container",
      attached: false,
      browser: true,
      workspace: kept,
      metadata: { agent: "act_scout" },
      surfaces: [],
      endpoints: { computer: "http://127.0.0.1:9/mcp" },
    },
  });
  const alive = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"]);
  t.after(() => alive.kill());
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "server.json"), JSON.stringify({ url: here.apiUrl, pid: alive.pid }));
  writeFileSync(join(data, "control-token"), here.apiKey);
  const link = hub.state.createActor(PERSON, { name: "Scout's computer" });
  writeFileSync(
    join(dir, "instances.json"),
    JSON.stringify({
      computer_old: {
        agent: "act_scout",
        links: [
          {
            slot: "computer",
            actor: link.actorId,
            credential: link.credential,
            url: "http://127.0.0.1:9/mcp",
          },
        ],
        computer: { id: "old", token: "its-own-token", service: { local: true } },
      },
    }),
  );
  await restart();
  assert.deepEqual((await units.status({ instance: "computer_old" })).now, {
    values: { kind: "new", made: "container", access: "files", browser: true },
    rows: {
      where: [{ label: "Computer", value: "A container", note: "Made for it on this machine" }],
      workspace: [
        {
          label: "Its work happens in",
          value: kept,
          path: true,
          note: "A folder of yours, kept from before",
        },
        { label: "Reaches", value: "Files" },
        { label: "Browser", value: "Its own browser" },
      ],
    },
  });
});

/** An `agentcomputer` on the path that only says it was run, and AgentComputer's record. */
function onPathThatSays(t: test.TestContext) {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-bin-")));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(join(bin, "agentcomputer"), `#!/bin/sh\ntouch "${join(bin, "ran")}"\nexit 1\n`, {
    mode: 0o755,
  });
  return { bin, ran: () => existsSync(join(bin, "ran")) };
}
/** A service's record in `folder`, as a running one writes it, for a stand-in. */
function recordIn(
  t: test.TestContext,
  folder: string,
  service: { apiUrl: string; apiKey: string },
) {
  const alive = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"]);
  t.after(() => alive.kill());
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, "server.json"),
    JSON.stringify({ url: service.apiUrl, pid: alive.pid }),
  );
  writeFileSync(join(folder, "control-token"), service.apiKey);
  return alive;
}

test("on a Mac with AgentOrg Mac open, this computer is attached through it, nothing is started, and no container is offered", async (t) => {
  const command = onPathThatSays(t);
  const { units, dir, root, macRecord } = await setup(t, {
    service: false,
    path: command.bin,
    mac: true,
  });
  const app = await standIn(t);
  recordIn(t, macRecord, app);
  const unit = (await units.units({})).units.find((one) => one.id === "computer");
  const kind = form(unit, "kind")?.options?.find((one) => one.value === "this");
  assert.equal(kind?.unavailable, undefined);
  assert.deepEqual(
    form(unit, "made")?.options?.map((one) => one.value),
    ["remote"],
  );
  assert.equal(form(unit, "made")?.default, "remote");
  const workspace = join(root, "work");
  const made = await units.apply({
    unit: "computer",
    values: { kind: "this", access: "files", workspace },
    secrets: {},
    needs: {},
    agent: "act_agent",
    name: "Mine",
  });
  assert.ok(app.asked.some((one) => one.method === "POST" && one.path === "/v1/computers/attach"));
  const kept = JSON.parse(readFileSync(join(dir, "instances.json"), "utf8"));
  assert.deepEqual(kept[made.instance].computer.service, { local: true, mac: true });
  const { problems } = await units.check({
    unit: "computer",
    values: { kind: "new", made: "container", access: "files" },
    secrets: [],
  });
  assert.deepEqual(
    problems.map((one) => one.field),
    ["made"],
  );
  assert.equal(command.ran(), false, "nothing of AgentComputer was started");
  await units.remove({ instance: made.instance });
});

test("on a Mac with AgentOrg Mac not open, this computer says to open it, and nothing is started", async (t) => {
  const command = onPathThatSays(t);
  const { units, apply, local, macRecord } = await setup(t, {
    service: false,
    path: command.bin,
    mac: true,
  });
  // It has been opened once: its folder is there, with no service running.
  mkdirSync(macRecord, { recursive: true });
  const unit = (await units.units({})).units.find((one) => one.id === "computer");
  assert.equal(
    form(unit, "kind")?.options?.find((one) => one.value === "this")?.unavailable,
    "The AgentOrg app isn't open on this Mac. Open it to use this computer.",
  );
  await assert.rejects(apply(local("files")), /The AgentOrg app isn't open on this Mac/);
  assert.equal(command.ran(), false, "nothing of AgentComputer was started");
});

test("this computer with its files switched off can't be chosen, in the AgentOrg app's words on a Mac and its service's elsewhere; its terminal off is its service's to refuse", async (t) => {
  for (const mac of [true, false])
    await t.test(mac ? "AgentOrg Mac" : "the service this machine runs", async (t) => {
      const command = onPathThatSays(t);
      const { units, apply, local, macRecord, data } = await setup(t, {
        service: false,
        path: command.bin,
        mac,
      });
      const app = await standIn(t);
      recordIn(t, mac ? macRecord : data, app);
      const where = mac ? "this Mac" : "this machine";
      const off = (part: string) => ({
        capability: part,
        ready: false,
        reason: `The person turned off the ${part} for agents on ${where}.`,
      });
      const thisOne = async () =>
        form(
          (await units.units({})).units.find((one) => one.id === "computer"),
          "kind",
        )?.options?.find((one) => one.value === "this")?.unavailable;
      // All off, as a Mac lending itself starts: this computer can't be chosen, and says why.
      app.setup.push(
        ...["terminal", "files", "screen", "browser"].map((part) => ({
          capability: part,
          on: false,
        })),
      );
      app.thisComputer.capabilities = [
        { capability: "about", ready: true },
        off("terminal"),
        off("files"),
        off("screen"),
      ];
      assert.equal(
        await thisOne(),
        mac
          ? "Files are turned off in the AgentOrg app. Turn them on there to use this computer."
          : "The person turned off the files for agents on this machine.",
      );
      // Its files on and its terminal still off: chosen with its terminal, which its service
      // refuses the agent until the person turns it on.
      app.thisComputer.capabilities[2] = { capability: "files", ready: true };
      assert.equal(await thisOne(), undefined);
      const made = await apply(local("terminal"));
      assert.equal(command.ran(), false);
      await units.remove({ instance: made.instance });
    });
});

test("this computer with its screen and the person's browser: attached with both, each its own connection, and its row says whose browser it is", async (t) => {
  const command = onPathThatSays(t);
  const { units, macRecord, root } = await setup(t, {
    service: false,
    path: command.bin,
    mac: true,
  });
  const app = await standIn(t, {}, { mcp: true });
  recordIn(t, macRecord, app);
  app.thisComputer.capabilities = [
    { capability: "files", ready: true },
    { capability: "screen", ready: true },
  ];
  app.thisComputer.browsers = [{ kind: "own", ready: true }];
  const values = {
    kind: "this",
    access: "none",
    workspace: join(root, "work"),
    screen: "on",
    ownBrowser: "yours",
  };
  // With no files or terminal, its screen and browser are its computer.
  assert.deepEqual(
    (await units.check({ unit: "computer", values: values as never, secrets: [] })).problems,
    [],
  );
  const made = await units.apply({
    unit: "computer",
    values: values as never,
    secrets: {},
    needs: {},
    agent: "act_agent",
    name: "Mine",
  });
  const attached = app.asked.find(
    (one) => one.method === "POST" && one.path === "/v1/computers/attach",
  );
  assert.equal(attached?.body?.screen, true);
  assert.equal(attached?.body?.browser, "own");
  assert.deepEqual(
    made.connections.map((one) => [one.slot, one.target]),
    [
      ["browser", "This computer, as you: your browser"],
      ["screen", "This computer, as you: your screen"],
    ],
  );
  // It reaches the screen, and its browser is the person's, as the rows say.
  assert.deepEqual(made.capability?.rows?.workspace?.slice(-2), [
    { label: "Reaches", value: "Your screen" },
    { label: "Browser", value: "Your browser", note: "Signed in as you" },
  ]);
  // With neither, and no files or terminal, there's no computer.
  const none = await units.check({
    unit: "computer",
    values: { ...values, screen: "off", ownBrowser: "none" } as never,
    secrets: [],
  });
  assert.deepEqual(
    none.problems.map((one) => one.message),
    ["With no files, no commands, no screen and no browser, there's no computer."],
  );
  // On a Mac with AgentOrg Mac, what the person switched off was read from its setup.
  assert.ok(app.asked.some((one) => one.method === "GET" && one.path === "/v1/setup"));
  assert.equal(command.ran(), false);
  await units.remove({ instance: made.instance });
});

test("this computer made before it had a screen or the person's browser to answer for says it has neither, in today's words", async (t) => {
  const { apply, local, units, dir, data, restart } = await setup(t, { service: false });
  const app = await standIn(t);
  recordIn(t, data, app);
  const { instance } = await apply(local("files"));
  assert.equal((await units.status({ instance })).now, undefined, "made in today's words");
  const file = JSON.parse(readFileSync(join(dir, "instances.json"), "utf8"));
  file[instance].words = 2;
  writeFileSync(join(dir, "instances.json"), JSON.stringify(file));
  await restart();
  const { now } = await units.status({ instance });
  assert.equal(now?.values.screen, "off");
  assert.equal(now?.values.ownBrowser, "none");
  // The service here was never asked for its setup: this isn't a Mac with AgentOrg Mac.
  assert.ok(!app.asked.some((one) => one.path === "/v1/setup"));
  await units.remove({ instance });
});

test("on a Mac with AgentOrg Mac, this computer attached through the service you run gets the one way on; that service is never started", async (t) => {
  const command = onPathThatSays(t);
  const { units, dir, data, root, hub, restart, macRecord, asPerson } = await setup(t, {
    service: false,
    path: command.bin,
    mac: true,
  });
  mkdirSync(macRecord, { recursive: true });
  const kept = join(root, "Agents", "Kept");
  mkdirSync(kept, { recursive: true });
  const link = hub.state.createActor(PERSON, { name: "Kept's computer" });
  const windows = hub.state.createActor(PERSON, { name: "Kept's computer (windows)" });
  writeFileSync(
    join(dir, "instances.json"),
    JSON.stringify({
      computer_old: {
        agent: "act_kept",
        links: [
          {
            slot: "computer",
            actor: link.actorId,
            credential: link.credential,
            url: "http://127.0.0.1:9/mcp",
          },
        ],
        capability: { actor: windows.actorId, credential: windows.credential },
        computer: { id: "old", token: "its-own-token", service: { local: true } },
      },
    }),
  );
  // That service not running: it says so, with how to start it.
  await restart();
  await until(async () => (await units.status({ instance: "computer_old" })).state === "down");
  assert.equal(
    (await units.status({ instance: "computer_old" })).detail,
    "The AgentComputer you run yourself isn't running. Start it with agentcomputer up.",
  );
  assert.equal(command.ran(), false, "nothing of AgentComputer was started");
  // Running: this computer is offered again, through AgentOrg Mac, with its folder.
  const own = await standIn(t, {
    old: {
      computerID: "old",
      name: "Kept's computer",
      state: "running",
      access: "files",
      isolation: "none",
      attached: true,
      browser: false,
      workspace: kept,
      metadata: { agent: "act_kept" },
      surfaces: [],
      endpoints: { computer: "http://127.0.0.1:9/mcp" },
    },
  });
  recordIn(t, data, own);
  await restart();
  const state = await (await asPerson(windows.actorId)).call.state({});
  assert.equal(state.state, "down");
  assert.equal(
    state.detail,
    `This computer was attached through the AgentComputer you run yourself. Attach it again through the AgentOrg app. Its folder stays ${kept}.`,
  );
  assert.deepEqual(state.ways, [
    {
      title: "Attach this computer",
      description: `Its work happens in ${kept}, as before.`,
      unit: "computer",
      values: { kind: "this", access: "files", workspace: kept },
    },
  ]);
});

test("on a Mac with AgentOrg Mac open, a container on the service you run is still reached at that service", async (t) => {
  const { dir, data, hub, restart, macRecord } = await setup(t, { service: false, mac: true });
  const app = await standIn(t);
  recordIn(t, macRecord, app);
  const own = await standIn(t, {
    c1: {
      computerID: "c1",
      name: "Its container",
      state: "running",
      access: "files",
      isolation: "container",
      attached: false,
      browser: false,
      workspace: "/service/computers/c1/workspace",
      metadata: {},
      surfaces: [],
      endpoints: { computer: "http://127.0.0.1:9/v1/computers/c1/mcp" },
    },
  });
  recordIn(t, data, own);
  const link = hub.state.createActor(PERSON, { name: "Its container" });
  writeFileSync(
    join(dir, "instances.json"),
    JSON.stringify({
      computer_c1: {
        agent: "act_one",
        links: [
          {
            slot: "computer",
            actor: link.actorId,
            credential: link.credential,
            url: "http://127.0.0.1:9/v1/computers/c1/mcp",
          },
        ],
        computer: { id: "c1", token: "its-own-token", service: { local: true } },
      },
    }),
  );
  await restart();
  const dialled = (service: { asked: { path: string }[] }) =>
    service.asked.some((one) => one.path === "/v1/computers/c1/mcp");
  await until(() => dialled(own));
  assert.equal(dialled(app), false);
});

test("a connection is held open to the service here, made again when it ends, and closed when the connector stops", async (t) => {
  const { macRecord, restart } = await setup(t, { service: false, mac: true });
  const app = await standIn(t);
  recordIn(t, macRecord, app);
  await restart();
  await until(() => app.held.length === 1);
  assert.equal(app.held[0]?.name, "AgentOrg");
  // Ended by the service, as when the connector stops answering it: made again.
  app.held[0]?.socket.terminate();
  await until(() => app.held.length === 2);
  // The connector stopping closes it, and makes no more: the next one opens with the next start.
  const second = app.held[1]?.socket as WebSocket;
  const closed = once(second, "close");
  await restart();
  await closed;
  await until(() => app.held.length === 3);
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  assert.equal(app.held.length, 3, "none from the connector that stopped");
});

test("a new computer here is a container with a workspace of its own, and no folder of yours", async (t) => {
  const { units, dir, data } = await setup(t, { service: false });
  // The service here, as the stand-in, recorded where the connector looks for it.
  const here = await standIn(t);
  const alive = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"]);
  t.after(() => alive.kill());
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "server.json"), JSON.stringify({ url: here.apiUrl, pid: alive.pid }));
  writeFileSync(join(data, "control-token"), here.apiKey);
  const made = await units.apply({
    unit: "computer",
    values: { kind: "new", made: "container", access: "files", browser: true },
    secrets: {},
    needs: {},
    agent: "act_agent",
    name: "Docs' computer",
  });
  const asked = here.asked.find((one) => one.method === "POST" && one.path === "/v1/computers");
  assert.deepEqual(
    [asked?.body?.isolation, asked?.body?.workspace, asked?.body?.copyFrom, asked?.body?.browser],
    ["container", undefined, undefined, true],
  );
  assert.deepEqual(
    made.connections.map((one) => [one.slot, one.target]),
    [
      ["computer", "A container on this machine: reads and changes files"],
      ["browser", "A browser, A container on this machine"],
    ],
  );
  assert.deepEqual(made.capability?.rows, {
    where: [{ label: "Computer", value: "A container", note: "Made for it on this machine" }],
    workspace: [
      { label: "Reaches", value: "Files" },
      { label: "Browser", value: "Its own browser" },
    ],
  });
  assert.ok(JSON.parse(readFileSync(join(dir, "instances.json"), "utf8"))[made.instance]);
});

test("a computer an earlier version made with no isolation isn't started: its capability says the two ways on, and removing it keeps its folder", async (t) => {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-bin-")));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(join(bin, "agentcomputer"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const { hub, units, asPerson, restart, data, dir, root } = await setup(t, {
    service: false,
    path: bin,
  });
  const kept = join(root, "Agents", "Support");
  mkdirSync(kept, { recursive: true });
  // As 0.0.18 made it, and as the service now says of it: no isolation, not attached.
  const here = await standIn(t, {
    old: {
      computerID: "old",
      name: "Support's computer",
      state: "failed",
      access: "files",
      isolation: "none",
      attached: false,
      browser: true,
      workspace: kept,
      metadata: { agent: "act_support" },
      surfaces: [],
      endpoints: { computer: "http://127.0.0.1:9/mcp" },
    },
  });
  const alive = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"]);
  t.after(() => alive.kill());
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "server.json"), JSON.stringify({ url: here.apiUrl, pid: alive.pid }));
  writeFileSync(join(data, "control-token"), here.apiKey);
  // Kept here as the connector kept it then.
  const link = hub.state.createActor(PERSON, { name: "Support's computer" });
  const windows = hub.state.createActor(PERSON, { name: "Support's computer (windows)" });
  writeFileSync(
    join(dir, "instances.json"),
    JSON.stringify({
      computer_old: {
        agent: "act_support",
        links: [
          {
            slot: "computer",
            actor: link.actorId,
            credential: link.credential,
            url: "http://127.0.0.1:9/mcp",
          },
        ],
        capability: { actor: windows.actorId, credential: windows.credential },
        computer: { id: "old", token: "its-own-token", service: { local: true } },
      },
    }),
  );
  await restart();
  const held = await asPerson(windows.actorId);
  const state = await held.call.state({});
  assert.equal(state.state, "down");
  assert.equal(
    state.detail,
    `A computer with no isolation is no longer made. Its folder is kept at ${kept}. Either way, its own browser and what it was signed in to aren't kept.`,
  );
  assert.deepEqual(state.surfaces, []);
  assert.deepEqual(state.ways, [
    {
      title: "Attach this computer",
      description: `Its work happens in ${kept}, as before. Unlike before, it reaches the whole machine, as you.`,
      unit: "computer",
      values: { kind: "this", access: "files", workspace: kept },
    },
    {
      title: "Make a container",
      description: `Its workspace starts with what's in ${kept}.`,
      unit: "computer",
      values: { kind: "new", made: "container", access: "files", browser: true },
    },
  ]);
  // Nothing of it is reached: its unit's status says the same, and nothing of it opens.
  const status = await units.status({ instance: "computer_old" });
  assert.equal(status.state, "down");
  assert.deepEqual(status.surfaces, []);
  await assert.rejects(held.call.live({ surface: "files", mode: "watch" }), refused("state"));
  assert.ok(!here.asked.some((one) => one.path.endsWith("/live")));
  // Removing it is the first step either way: the service forgets it, and keeps its folder.
  await units.remove({ instance: "computer_old" });
  assert.equal(here.computers.size, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "instances.json"), "utf8")), {});
  // The agent's next computer, as a container, starts with what's in it, and only that one.
  const next = () =>
    units.apply({
      unit: "computer",
      values: { kind: "new", made: "container", access: "files", browser: true },
      secrets: {},
      needs: {},
      agent: "act_support",
      name: "Support's computer",
    });
  await next();
  await next();
  const copies = here.asked
    .filter((one) => one.method === "POST" && one.path === "/v1/computers")
    .map((one) => one.body?.copyFrom);
  assert.deepEqual(copies, [kept, undefined]);
  // A folder kept from before that is gone since is forgotten, and the container is made empty.
  writeFileSync(
    join(dir, "earlier-folders.json"),
    JSON.stringify({ act_gone: join(root, "gone") }),
  );
  await restart();
  await units.apply({
    unit: "computer",
    values: { kind: "new", made: "container", access: "files", browser: false },
    secrets: {},
    needs: {},
    agent: "act_gone",
    name: "Gone's computer",
  });
  const last = here.asked.filter((one) => one.method === "POST" && one.path === "/v1/computers");
  assert.equal(last.at(-1)?.body?.copyFrom, undefined);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "earlier-folders.json"), "utf8")), {});
});

test("a computer the service says is from before, found only once it is read, is ended and says the ways on", async (t) => {
  const { hub, asPerson, restart, data, dir } = await setup(t, { service: false });
  const here = await standIn(t, {
    late: {
      computerID: "late",
      name: "Late's computer",
      state: "running",
      access: "read",
      isolation: "container",
      attached: false,
      browser: false,
      workspace: "/Users/someone/Agents/Late",
      metadata: { agent: "act_late" },
      surfaces: [],
      endpoints: { computer: "http://127.0.0.1:9/mcp" },
    },
  });
  const alive = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"]);
  t.after(() => alive.kill());
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "server.json"), JSON.stringify({ url: here.apiUrl, pid: alive.pid }));
  writeFileSync(join(data, "control-token"), here.apiKey);
  const link = hub.state.createActor(PERSON, { name: "Late's computer" });
  const windows = hub.state.createActor(PERSON, { name: "Late's computer (windows)" });
  writeFileSync(
    join(dir, "instances.json"),
    JSON.stringify({
      computer_late: {
        agent: "act_late",
        links: [
          {
            slot: "computer",
            actor: link.actorId,
            credential: link.credential,
            url: "http://127.0.0.1:9/mcp",
          },
        ],
        capability: { actor: windows.actorId, credential: windows.credential },
        computer: { id: "late", token: "its-own-token", service: { local: true } },
      },
    }),
  );
  // With no `agentcomputer` here, nothing is looked at as the connector starts: it is opened.
  await restart();
  await until(() => hub.connected(link.actorId));
  const held = await asPerson(windows.actorId);
  let changed = 0;
  held.on("changed", () => void changed++);
  // The service is updated meanwhile, and now says it is from before.
  Object.assign(here.computers.get("late") as object, { isolation: "none" });
  await until(async () => (await held.call.state({})).state === "down");
  assert.ok(changed > 0, "the person is told");
  assert.match(
    (await held.call.state({})).detail ?? "",
    /Its folder is kept at \/Users\/someone\/Agents\/Late\./,
  );
  await until(() => !hub.connected(link.actorId));
  assert.deepEqual(
    (await held.call.state({})).ways?.map((one) => one.title),
    ["Attach this computer", "Make a container"],
  );
});

test("an agent with no folder named works in one with its name, which stays", async (t) => {
  const { units, connected, running, root } = await setup(t);
  const reached = running as Service;
  const unit = (await units.units({})).units.find((one) => one.id === "computer");
  assert.equal(
    (form(unit, "workspace") as { placeholder?: string }).placeholder,
    "~/Agents/{name}",
  );
  const make = (agentName?: string) =>
    units.apply({
      unit: "computer",
      values: { kind: "this", access: "files" },
      secrets: {},
      needs: {},
      agent: "act_agent",
      name: "Its computer",
      ...(agentName ? { agentName } : {}),
    });
  const { instance } = await make("Scout / ../two");
  await connected(instance);
  const folder = join(root, "Agents", "Scout - ..-two");
  assert.ok(statSync(folder).isDirectory());
  assert.deepEqual(
    (await Computer.list(reached)).map((one) => one.workspace),
    [folder],
  );
  await units.remove({ instance });
  assert.ok(existsSync(folder));
  // An agent's own child gets no name to go by: its folder has its computer's.
  const child = await make();
  const [made] = await Computer.list(reached);
  assert.equal(made?.workspace, join(root, "Agents", "Its computer"));
  await units.remove({ instance: child.instance });
  // A name that would be somewhere else stays a folder in there.
  for (const odd of [" ..", " ."]) {
    const made2 = await make(odd);
    const [one] = await Computer.list(reached);
    assert.equal(one?.workspace, join(root, "Agents", "agent"));
    await units.remove({ instance: made2.instance });
  }
  writeFileSync(join(root, "Agents", "taken"), "a file");
  await assert.rejects(make("taken"), refused("invalid"));
});

test("a service that crashed isn't found, and its port gets no token", async (t) => {
  const { units, root } = await setup(t, { service: false });
  mkdirSync(join(root, "service"), { recursive: true });
  writeFileSync(
    join(root, "service", "server.json"),
    JSON.stringify({ url: "http://127.0.0.1:9", pid: 999_999 }),
  );
  writeFileSync(join(root, "service", "control-token"), "stale\n");
  const unit = (await units.units({})).units.find((one) => one.id === "computer");
  assert.match(form(unit, "kind")?.options?.[0]?.unavailable ?? "", /npm install -g/);
});

test("a computer whose Actors are gone is killed, not forgotten", async (t) => {
  const { apply, local, connected, dir, running, restart, hub } = await setup(t);
  const reached = running as Service;
  const { instance, connections } = await apply(local("read"));
  await connected(instance);
  const id = JSON.parse(readFileSync(join(dir, "instances.json"), "utf8"))[instance].computer.id;
  hub.state.closeActor(PERSON, connections[0]?.connection as string);
  await restart();
  await assert.rejects(Computer.getInfo(id, reached), /no computer/);
});

test("a computer whose capability's Actor is gone is killed and forgotten, with nothing left running", async (t) => {
  const { apply, local, connected, dir, running, restart, hub, units } = await setup(t);
  const reached = running as Service;
  const made = await apply(local("read"));
  await connected(made.instance);
  const id = JSON.parse(readFileSync(join(dir, "instances.json"), "utf8"))[made.instance].computer
    .id;
  hub.state.closeActor(PERSON, made.capability?.actor as string);
  await restart();
  await assert.rejects(Computer.getInfo(id, reached), /no computer/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "instances.json"), "utf8")), {});
  await assert.rejects(units.status({ instance: made.instance }), refused("unknown"));
});

test("an agent can go even when its service no longer takes the token", async (t) => {
  const { apply, dir, restart, units } = await setup(t, { service: false });
  const there = await standIn(t);
  const { instance } = await apply(
    { kind: "new", made: "remote", address: there.apiUrl, access: "read" },
    { token: there.apiKey },
  );
  const file = join(dir, "instances.json");
  writeFileSync(file, readFileSync(file, "utf8").replaceAll(there.apiKey, "rotated"));
  await restart();
  await units.remove({ instance });
  await assert.rejects(units.status({ instance }), refused("unknown"));
});

test("a computer comes back after a restart, and goes even if its service has", async (t) => {
  const { apply, local, asAgent, connected, restart, units, running, workspace } = await setup(t);
  const { instance, connections } = await apply(local("terminal"));
  await connected(instance);
  await restart();
  await connected(instance);
  const computer = await asAgent(connections[0]?.connection as string);
  await computer.call({ name: "exec_command", arguments: { cmd: "echo back > back.txt" } });
  assert.equal(readFileSync(join(workspace, "back.txt"), "utf8"), "back\n");
  await (running as Service).stop();
  await units.remove({ instance });
  await assert.rejects(units.status({ instance }), refused("unknown"));
});

test("the web unit gives its slot and skill, at the service's address", async (t) => {
  const { units } = await setup(t, {
    service: false,
    webUrl: "http://127.0.0.1:9/mcp?tools=web_search_exa",
  });
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

test("a computer's capability is an Actor of its own: its fixed rows, how it stands, its windows, the agent's about, a restart, and its removal", async (t) => {
  const { hub, apply, local, asAgent, asPerson, connected, restart, workspace, units } =
    await setup(t);
  const made = await apply(local("terminal"));
  // What the person reads beside its windows is fixed as it is made.
  assert.deepEqual(made.capability?.rows, {
    where: [{ label: "Computer", value: "This computer" }],
    workspace: [
      { label: "Acts as", value: "You, with all you can reach", caution: true },
      {
        label: "Its work happens in",
        value: workspace,
        path: true,
        note: "Said to it, not a wall",
      },
      { label: "Reaches", value: "Files and terminal" },
      { label: "Browser", value: "None" },
    ],
  });
  const actor = made.capability?.actor as string;
  assert.ok(
    !made.connections.some((one) => one.connection === actor),
    "not one of its connections",
  );
  await connected(made.instance);

  // The person asks the Actor, and no unit: its state as the unit's own status has it.
  const held = await asPerson(actor);
  const state = await held.call.state({});
  assert.equal(state.state, "connected");
  assert.deepEqual(state.surfaces, (await units.status({ instance: made.instance })).surfaces);
  assert.deepEqual(state.surfaces.map((one) => `${one.surface} ${one.protocol}`).sort(), [
    "files files@1",
    "load metrics@1",
    "presence presence@1",
    "terminal terminal@1",
  ]);
  const ticket = await held.call.live({ surface: "terminal", mode: "watch" });
  assert.equal(ticket.protocol, "terminal@1");
  assert.match(ticket.url, /^ws:\/\/127\.0\.0\.1:/);
  await assert.rejects(held.call.live({ surface: "nothing", mode: "watch" }), refused("unknown"));

  // That it acts as the person is the agent's own tool's to say too.
  const computer = await asAgent(made.connections[0]?.connection as string);
  const about = JSON.parse((await computer.call({ name: "about", arguments: {} })).output) as {
    rows: { label: string; value: string; caution?: true }[];
  };
  const isolation = about.rows.find((row) => row.label === "Isolation");
  assert.match(isolation?.value ?? "", /acts as you/);
  assert.equal(isolation?.caution, true);

  // After the provider has been away the Actor is there again, and says its state changed
  // when its connection came back.
  let changed = 0;
  held.on("changed", () => void changed++);
  await restart();
  await until(
    async () => (await held.call.state({}).catch(() => undefined))?.state === "connected",
  );
  await until(() => changed > 0);

  // It goes with the instance.
  await units.remove({ instance: made.instance });
  assert.equal(
    hub.state.actors().some((one) => one.actorId === actor && one.state !== "closed"),
    false,
  );
});

test("a computer's rows say its browser apart from what it reaches, and a browser alone", async (t) => {
  const { apply, units } = await setup(t, { service: false });
  const there = await standIn(t);
  const away = { kind: "new", made: "remote", address: there.apiUrl };
  const both = await apply({ ...away, access: "files", browser: true }, { token: there.apiKey });
  assert.deepEqual(both.capability?.rows?.workspace?.slice(-2), [
    { label: "Reaches", value: "Files" },
    { label: "Browser", value: "Its own browser" },
  ]);
  await units.remove({ instance: both.instance });
  const alone = await apply({ ...away, access: "none", browser: true }, { token: there.apiKey });
  assert.deepEqual(
    alone.capability?.rows?.workspace?.map((row) => row.label),
    ["Browser"],
  );
  await units.remove({ instance: alone.instance });
});

test("each skill's text is among the texts shipped.json says it shipped", () => {
  const skills = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
  const shipped = JSON.parse(readFileSync(join(skills, "shipped.json"), "utf8")) as Record<
    string,
    string[]
  >;
  for (const name of readdirSync(skills, { withFileTypes: true })
    .filter((one) => one.isDirectory())
    .map((one) => one.name)) {
    const now = createHash("sha256")
      .update(readFileSync(join(skills, name, "SKILL.md"), "utf8"))
      .digest("hex");
    assert.ok(
      shipped[`${name}/SKILL.md`]?.includes(now),
      `append ${now} to "${name}/SKILL.md" in packages/computer/skills/shipped.json, and keep the others`,
    );
  }
});
