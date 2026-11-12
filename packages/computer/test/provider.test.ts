// The connector against a real Hub and a real AgentComputer: the published service, on a port and
// in a folder of each test's own, driving the headless shell Playwright installed.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
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
import { Computer } from "@agentorg/computer";
import { Hub, listen, PERSON } from "@agentorg/hub";
import { capability, tools, Unit, unitProvider } from "@agentorg/interfaces";
import { Refused } from "@agentorg/sdk";
import { connect } from "@agentorg/sdk/client";
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

async function setup(t: test.TestContext, { service = true, webUrl = "" } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-computer-")));
  const dir = join(root, "provider");
  const data = join(root, "service");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "seen.txt"), "the person's file\n");
  const leaving: (() => void | Promise<void>)[] = [];
  const hub = Hub.open(join(root, "home"));
  const server = await listen(hub);
  t.after(async () => {
    for (const leave of leaving.reverse()) await leave();
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
  const apply = (values: Record<string, unknown>, secrets: Record<string, string> = {}) =>
    units.apply({
      unit: "computer",
      values: values as never,
      secrets,
      needs: {},
      agent: "act_agent",
      name: "Scout's computer",
    });
  const local = (access: string, more: object = {}) => ({
    service: "local",
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
  };
}

const form = (unit: { form: { id: string }[] } | undefined, id: string) =>
  unit?.form.find((field) => field.id === id) as
    | {
        id: string;
        value: string;
        required?: true;
        visible?: { field: string; in: unknown[] };
        options?: { value: string; description?: string; adds?: { skills: { name: string }[] } }[];
      }
    | undefined;

test("the form says which service, found when it is read, and what each answer grants", async (t) => {
  const { units } = await setup(t);
  const unit = (await units.units({})).units.find((one) => one.id === "computer");
  Unit.parse(unit);
  const service = form(unit, "service");
  assert.equal((service as { default?: unknown }).default, "local", "found, so preselected");
  assert.deepEqual(
    service?.options?.map((one) => one.value),
    ["local", "another"],
  );
  assert.match(service?.options?.[0]?.description ?? "", /No isolation: it acts as you/);
  assert.deepEqual(form(unit, "address")?.visible, { field: "service", in: ["another"] });
  assert.equal(form(unit, "token")?.value, "secret");
  assert.deepEqual(form(unit, "workspace")?.visible, { field: "service", in: ["local"] });
  assert.deepEqual(form(unit, "path")?.visible, { field: "service", in: ["another"] });
  assert.equal(form(unit, "where"), undefined);
  // What an agent may set: how far it reaches, within bounds. Where it runs, never.
  const authority = (id: string) =>
    (form(unit, id) as { authority?: string } | undefined)?.authority;
  assert.deepEqual(
    ["service", "address", "token", "access", "browser", "workspace", "path"].map(authority),
    [undefined, undefined, undefined, "setting", "setting", undefined, undefined],
  );
  assert.deepEqual(
    form(unit, "access")
      ?.options?.at(-1)
      ?.adds?.skills.map((one) => one.name),
    ["terminal", "files", "computer"],
  );
});

test("each skill the form names can be read, and an unknown one is refused", async (t) => {
  const { units } = await setup(t, { service: false });
  for (const name of ["terminal", "files", "computer", "browser"])
    assert.match(
      (await units.skill({ unit: "computer", name, path: "SKILL.md" })).text,
      new RegExp(`name: ${name}`),
    );
  assert.match(
    (await units.skill({ unit: "computer", name: "computer", path: "SKILL.md" })).text,
    /another machine/,
  );
  await assert.rejects(
    units.skill({ unit: "computer", name: "nothing", path: "SKILL.md" }),
    refused("unknown"),
  );
});

test("with no service here, it says what to install and start, and nothing is made", async (t) => {
  const { units, apply, local, hub } = await setup(t, { service: false });
  const unit = (await units.units({})).units.find((one) => one.id === "computer");
  assert.match(form(unit, "service")?.options?.[0]?.description ?? "", /npm install -g/);
  assert.equal(
    (form(unit, "service") as { default?: unknown }).default,
    undefined,
    "nothing to preselect",
  );
  for (const values of [local("terminal"), { access: "terminal" }]) {
    const { problems } = await units.check({ unit: "computer", values, secrets: [] });
    assert.deepEqual(
      problems.map((one) => one.field),
      ["service"],
    );
    assert.match(problems[0]?.message ?? "", /agentcomputer serve/);
  }
  const before = hub.state.actors().length;
  await assert.rejects(apply(local("terminal")), refused("invalid"));
  assert.equal(hub.state.actors().length, before);
});

test("check says what's wrong by field, and changes nothing", async (t) => {
  const { units, running, root, workspace } = await setup(t);
  const fields = async (values: object, secrets: string[] = []) =>
    (await units.check({ unit: "computer", values: values as never, secrets })).problems.map(
      (one) => one.field,
    );
  assert.deepEqual(await fields({ service: "local", access: "terminal" }), []);
  assert.deepEqual(await fields({ service: "local", access: "none" }), ["access"]);
  assert.deepEqual(await fields({ service: "local", access: "none", browser: true }), []);
  // A folder that isn't there yet will do: it is made with the computer. A path that isn't a
  // full one, and one where something that isn't a folder is, won't.
  const typed = (folder: string) =>
    fields({ service: "local", access: "terminal", workspace: folder });
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
  assert.deepEqual(await fields({ service: "other", access: "read" }), ["service"]);
  const away = { service: "another", access: "read" };
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
  assert.match(connections[0]?.target ?? "", /this computer, no isolation: files and terminal/);
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

test("on a real service, an agent reads a page with its browser", async (t) => {
  const page = createServer((_, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<title>A page</title><p>Words only a browser could fetch.</p>");
  });
  page.listen(0, "127.0.0.1");
  await once(page, "listening");
  t.after(() => page.close());
  const { port } = page.address() as AddressInfo;
  const { apply, local, asAgent, connected, units, running } = await setup(t);
  const { instance, connections } = await apply(local("none", { browser: true }));
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
  assert.equal((await Computer.serviceInfo(running as Service)).isolation, "none");
});

test("a typed workspace folder that is missing is made; one that can't be made is refused and leaves no computer", async (t) => {
  const { apply, root, workspace, running, dir } = await setup(t);
  const folder = join(root, "deep", "er", "work");
  const made = await apply({ service: "local", access: "files", workspace: folder });
  assert.ok(statSync(folder).isDirectory());
  const kept = JSON.parse(readFileSync(join(dir, "instances.json"), "utf8"));
  const info = await Computer.getInfo(kept[made.instance].computer.id, running as Service);
  assert.equal(info.workspace, folder, "and it is the computer's folder");
  // Under a file nothing can be made.
  const before = (await Computer.list(running as Service)).length;
  await assert.rejects(
    apply({ service: "local", access: "files", workspace: join(workspace, "seen.txt", "under") }),
    (error: Error & { code?: string }) =>
      error.code === "invalid" && /can't be made/.test(error.message),
  );
  assert.equal((await Computer.list(running as Service)).length, before);
});

test("removing kills the computer: a named folder stays, one the service made goes", async (t) => {
  const { apply, local, connected, workspace, units, running, dir } = await setup(t);
  const reached = running as Service;
  const named = await apply(local("terminal"));
  const made = await apply({ service: "local", access: "files" });
  await connected(named.instance);
  const kept = JSON.parse(readFileSync(join(dir, "instances.json"), "utf8"));
  const idOf = (instance: string) => kept[instance].computer.id as string;
  const [namedId, madeId] = [idOf(named.instance), idOf(made.instance)];
  const folder = (await Computer.getInfo(madeId, reached)).workspace as string;
  assert.ok(statSync(folder).isDirectory());
  assert.ok(made.connections[0]?.target.endsWith(`in ${folder}`), "so the person can find it");
  assert.ok(named.connections[0]?.target.endsWith(`in ${workspace}`));

  await units.remove({ instance: named.instance });
  await units.remove({ instance: made.instance });
  for (const id of [namedId, madeId])
    await assert.rejects(Computer.getInfo(id, reached), /no computer/);
  assert.equal(readFileSync(join(workspace, "seen.txt"), "utf8"), "the person's file\n");
  assert.equal(existsSync(folder), false);
  await assert.rejects(units.status({ instance: named.instance }), refused("unknown"));
});

test("another address is reached with its token, which stays in the private file", async (t) => {
  const { apply, units, connected, running, dir, hub, workspace } = await setup(t);
  const reached = running as Service;
  const away = { service: "another", address: reached.apiUrl, access: "terminal", path: workspace };
  const { instance, connections } = await apply(away, { token: reached.apiKey });
  await connected(instance);
  const status = await units.status({ instance });
  const file = readFileSync(join(dir, "instances.json"), "utf8");
  assert.ok(file.includes(reached.apiKey), "kept to reach it again");
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  for (const seen of [
    JSON.stringify(status),
    JSON.stringify(connections),
    JSON.stringify(hub.state.audit(0, 100_000)),
  ])
    assert.ok(!seen.includes(reached.apiKey));
  const before = (await Computer.list(reached)).length;
  await units.remove({ instance });
  assert.equal((await Computer.list(reached)).length, before - 1);

  // A wrong token makes nothing.
  const actors = hub.state.actors().length;
  await assert.rejects(apply(away, { token: "wrong" }));
  assert.equal(hub.state.actors().length, actors);
});

test("endpoints are at the address given, whatever the service calls itself", async (t) => {
  const { apply, connected, dir, running, units, workspace } = await setup(t);
  const reached = running as Service;
  const { port } = new URL(reached.apiUrl);
  const { instance } = await apply(
    {
      service: "another",
      address: `http://localhost:${port}`,
      access: "terminal",
      path: workspace,
    },
    { token: reached.apiKey },
  );
  await connected(instance);
  const kept = JSON.parse(readFileSync(join(dir, "instances.json"), "utf8"));
  assert.match(kept[instance].links[0].url, new RegExp(`^http://localhost:${port}/`));
  // So is a live session's socket.
  const status = await units.status({ instance });
  assert.ok(status.surfaces?.some((one) => one.surface === "terminal"));
  const ticket = await units.live({ instance, surface: "terminal", mode: "watch" });
  assert.match(ticket.url, new RegExp(`^ws://localhost:${port}/`));
  assert.equal(ticket.protocol, "terminal@1");
  await assert.rejects(
    units.live({ instance, surface: "nothing", mode: "watch" }),
    refused("unknown"),
  );
  await units.remove({ instance });
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
      values: { service: "local", access: "files" },
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
  // An agent's own child gets no name to go by, and a folder the service makes.
  const child = await make();
  const [made] = await Computer.list(reached);
  assert.ok(!made?.workspace?.startsWith(join(root, "Agents")));
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
    JSON.stringify({ url: "http://127.0.0.1:9", pid: 999_999, isolation: "none" }),
  );
  writeFileSync(join(root, "service", "control-token"), "stale\n");
  const unit = (await units.units({})).units.find((one) => one.id === "computer");
  assert.match(form(unit, "service")?.options?.[0]?.description ?? "", /npm install -g/);
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
  const { apply, connected, dir, running, restart, units, workspace } = await setup(t);
  const reached = running as Service;
  const { instance } = await apply(
    { service: "another", address: reached.apiUrl, access: "read", path: workspace },
    { token: reached.apiKey },
  );
  await connected(instance);
  const file = join(dir, "instances.json");
  writeFileSync(file, readFileSync(file, "utf8").replaceAll(reached.apiKey, "rotated"));
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
    where: [{ label: "Where", value: "This computer" }],
    workspace: [
      { label: "Folder", value: workspace, path: true },
      { label: "Reaches", value: "Files and terminal" },
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
    "terminal terminal@1",
  ]);
  const ticket = await held.call.live({ surface: "terminal", mode: "watch" });
  assert.equal(ticket.protocol, "terminal@1");
  assert.match(ticket.url, /^ws:\/\/127\.0\.0\.1:/);
  await assert.rejects(held.call.live({ surface: "nothing", mode: "watch" }), refused("unknown"));

  // How it is isolated is the agent's own tool's to say, which the person's view names.
  const computer = await asAgent(made.connections[0]?.connection as string);
  const about = JSON.parse((await computer.call({ name: "about", arguments: {} })).output) as {
    rows: { label: string; value: string; caution?: true }[];
  };
  assert.deepEqual(
    about.rows.find((row) => row.label === "Isolation"),
    { label: "Isolation", value: "None: it acts as you", caution: true },
  );

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

test("a computer's rows say a browser beside what it reaches, and a browser alone", async (t) => {
  const { apply, local, units } = await setup(t);
  const both = await apply(local("files", { browser: true }));
  assert.deepEqual(both.capability?.rows?.workspace?.at(-1), {
    label: "Reaches",
    value: "Files, Browser",
  });
  await units.remove({ instance: both.instance });
  const alone = await apply({ service: "local", access: "none", browser: true });
  assert.deepEqual(
    alone.capability?.rows?.workspace
      ?.map((row) => row.label === "Reaches" && row.value)
      .filter(Boolean),
    ["Browser"],
  );
  await units.remove({ instance: alone.instance });
});
