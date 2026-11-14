// First run on a fresh home: the programs made once and started in this process, and the person
// reaching management and each agent's chat through `/api`, as `agentorg call` does.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { Computer } from "@agentorg/computer";
import { HubState } from "@agentorg/hub";
import { completed, fakeOpenAI } from "chatgpt/fake-openai";
import WebSocket from "ws";
import { type App, startApp } from "../src/index.ts";

type Reply = {
  id?: number;
  sub?: number;
  result?: unknown;
  error?: { code?: string };
  payload?: unknown;
};

function personOf(app: App, home: string) {
  const socket = new WebSocket(`${app.url.replace("http", "ws")}/api`, {
    headers: { Authorization: `Bearer ${readFileSync(join(home, "cli-token"), "utf8").trim()}` },
  });
  const opened = new Promise((done) => socket.once("open", done));
  let id = 0;
  const waiting = new Map<number, (reply: Reply) => void>();
  const heard: Reply[] = [];
  socket.on("message", (data) => {
    const reply = JSON.parse(String(data)) as Reply;
    if (reply.sub !== undefined) heard.push(reply);
    else if (reply.id !== undefined) waiting.get(reply.id)?.(reply);
  });
  return {
    heard,
    close: async () => {
      await opened;
      socket.close();
    },
    async subscribe(slot: string, event: string) {
      await opened;
      socket.send(JSON.stringify({ sub: ++id, op: "subscribe", slot, event }));
      return id;
    },
    async call<T = Record<string, never>>(
      slot: string,
      method: string,
      input: unknown = {},
    ): Promise<T> {
      await opened;
      const reply = await new Promise<Reply>((done) => {
        waiting.set(++id, done);
        socket.send(JSON.stringify({ id, op: "call", slot, method, input }));
      });
      if (reply.error)
        throw Object.assign(new Error(JSON.stringify(reply.error)), { code: reply.error.code });
      return reply.result as T;
    },
  };
}
type Person = ReturnType<typeof personOf>;

async function until(condition: () => boolean | Promise<boolean>, what: string) {
  for (let i = 0; i < 2000; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
}
const refused = (code: string) => (error: unknown) => (error as { code?: string }).code === code;
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
/**
 * A real service on `data`, as the person would start it, stopped when the test ends. It drives the
 * headless shell: left to itself, the service starts the Chrome installed on the machine.
 */
async function startService(t: test.TestContext, data: string) {
  const service = spawn(
    process.execPath,
    [
      join(
        dirname(createRequire(import.meta.url).resolve("@agentorg/computer")),
        "agentcomputer.js",
      ),
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
  t.after(async () => {
    if (service.exitCode === null) {
      service.kill("SIGTERM");
      await once(service, "exit");
    }
  });
  await until(() => existsSync(join(data, "server.json")), "the service to start");
  return {
    apiUrl: JSON.parse(readFileSync(join(data, "server.json"), "utf8")).url as string,
    apiKey: readFileSync(join(data, "control-token"), "utf8").trim(),
  };
}
type Binding = { consumer: string; slot: string; provider: string; export: string };
const wiring = async (person: Person, actor: string) =>
  (await person.call<{ bindings: Binding[] }>("bindings", "list", { actor })).bindings
    .filter((b) => b.consumer === actor)
    .map((b) => `${b.slot} ${b.provider}.${b.export}`)
    .sort();
/** The slot the agent's chat was exposed to the person under, found as the pages find it. */
const chatSlot = async (person: Person, agent: string) => {
  const { bindings } = await person.call<{ bindings: Binding[] }>("bindings", "list", {
    actor: "person",
  });
  return bindings.find((b) => b.provider === agent && b.export === "chat")?.slot as string;
};

const folders: string[] = [];
after(() => {
  for (const one of folders) rmSync(one, { recursive: true, force: true });
});
/**
 * A new folder, removed after the file's last test. A test's after hooks run in the order added,
 * so one added here would run before the hook that stops the app writing in it.
 */
const newFolder = (prefix: string) => {
  const one = mkdtempSync(join(tmpdir(), prefix));
  folders.push(one);
  return one;
};

async function open(
  t: test.TestContext,
  computer?: { dataFolder: string; webUrl: string; agentsFolder: string },
  fetch?: (request: Request) => Promise<Response>,
) {
  const home = newFolder("agentorg-programs-");
  const started: { app: App; person: Person }[] = [];
  const start = async () => {
    const app = await startApp({
      home,
      firstRun: {
        log: () => {},
        // An empty path: the test starts any service itself.
        computer: { path: "", ...computer },
        ...(fetch ? { fetch } : {}),
      },
    });
    const person = personOf(app, home);
    started.push({ app, person });
    return { app, person, ran: await app.firstRun };
  };
  const stop = async () => {
    const last = started.pop();
    await last?.person.close();
    await last?.app.close();
  };
  t.after(async () => {
    while (started.length) await stop();
  });
  return { home, start, stop };
}

const createAssistant = async (person: Person, name: string, purpose?: string) => {
  const { creatables } = await person.call<{ creatables: { provider: string; id: string }[] }>(
    "agents",
    "creatable",
  );
  const [assistant] = creatables;
  assert.equal(assistant?.id, "assistant");
  return (
    await person.call<{ agent: string }>("agents", "create", {
      stack: { base: { provider: assistant.provider, creatable: assistant.id }, units: [] },
      name,
      ...(purpose ? { purpose } : {}),
    })
  ).agent;
};

test("first run makes the programs once, connected to each other, with no installer", async (t) => {
  const s = await open(t);
  const { person, ran, app } = await s.start();
  const { chatgpt, agents, mcp, computer, management } = ran as NonNullable<typeof ran>;
  for (const id of [chatgpt, agents, mcp, computer, management])
    assert.ok(id && app.hub.connected(id));
  assert.deepEqual(await wiring(person, agents as string), [
    "actors hub.actors",
    `model ${chatgpt}.session`,
  ]);
  assert.deepEqual(await wiring(person, mcp as string), ["actors hub.actors"]);
  const person_ = await wiring(person, "person");
  for (const expected of [
    `login ${chatgpt}.login`,
    `agents ${management}.agents`,
    `connections ${management}.connections`,
    `skills ${management}.skills`,
  ])
    assert.ok(person_.includes(expected), expected);
  assert.ok(!person_.some((line) => line.startsWith("installer ") || line.startsWith("store ")));
  const { actors } = await person.call<{ actors: { name: string; state: string }[] }>(
    "actors",
    "list",
  );
  assert.ok(!actors.some((actor) => actor.name === "Installer"));
  // Each provider is connected by exposing its export to management.
  assert.equal(
    (await person.call<{ providers: unknown[] }>("agents", "providers")).providers.length,
    1,
  );
  assert.equal(
    (await person.call<{ providers: unknown[] }>("connections", "providers")).providers.length,
    1,
  );
  // Each credential is the person's to keep: readable only by this user.
  for (const name of ["chatgpt", "agents", "mcp", "management"]) {
    const { mode } = statSync(join(s.home, "programs", `${name}.identity`));
    assert.equal(mode & 0o777, 0o600);
  }

  await s.stop();
  const again = await s.start();
  assert.deepEqual(
    [again.ran?.chatgpt, again.ran?.agents, again.ran?.mcp, again.ran?.management],
    [chatgpt, agents, mcp, management],
  );
  assert.equal(
    (await again.person.call<{ providers: unknown[] }>("agents", "providers")).providers.length,
    1,
  );
});

test("an agent is made through agents, and the person reaches its chat, across a restart", async (t) => {
  const s = await open(t);
  let { person } = await s.start();
  const agent = await createAssistant(person, "Scout");
  const slot = await chatSlot(person, agent);
  assert.ok(slot);
  await until(
    () =>
      person.call(slot, "list").then(
        () => true,
        () => false,
      ),
    "the chat to be exposed",
  );
  assert.deepEqual(await person.call(slot, "list"), { conversations: [], more: false });

  // Its events reach the person too; with no sign-in, the chat is told to have that problem.
  const sub = await person.subscribe(slot, "chat");
  await person.call(slot, "send", { text: "hello" });
  type Told = { with?: string; problem?: { code: string } } | undefined;
  await until(
    () =>
      person.heard.some(
        (reply) => reply.sub === sub && (reply.payload as Told)?.problem?.code === "not_signed_in",
      ),
    "the chat to be told it has no sign-in",
  );
  const { messages } = await person.call<{ messages: { text: string }[] }>(slot, "history", {});
  assert.deepEqual(
    messages.map((message) => message.text),
    ["hello"],
  );

  await s.stop();
  ({ person } = await s.start());
  await until(
    () =>
      person.call(slot, "history", {}).then(
        () => true,
        () => false,
      ),
    "the chat to be back",
  );
  assert.deepEqual(
    (await person.call<{ messages: { text: string }[] }>(slot, "history", {})).messages.map(
      (message) => message.text,
    ),
    ["hello"],
  );
  // The person's one conversation with the agent, found by who they are.
  assert.deepEqual(
    (
      await person.call<{ conversations: { with: string; latest?: { text: string } }[] }>(
        slot,
        "list",
      )
    ).conversations.map((one) => [one.with, one.latest?.text]),
    [["person", "hello"]],
  );
  assert.equal(
    (await person.call<{ agents: { name: string }[] }>("agents", "list")).agents[0]?.name,
    "Scout",
  );
});

test("a turn cut off as the app stops goes on when it is started again, with the agent's settings", async (t) => {
  // The model, scripted: its next answer stays out while `held`, as when the app stops mid-turn.
  const fake = await fakeOpenAI();
  const asked: { instructions: string; said: unknown }[] = [];
  let held = false;
  /** How often the agent's main loop was asked whose a message is: it says new work. */
  let routed = 0;
  const s = await open(t, undefined, async (request) => {
    if (!request.url.endsWith("/responses")) return fake.handle(request);
    const body = (await request.clone().json()) as {
      instructions: string;
      input: unknown[];
      tools?: { name: string }[];
    };
    if (body.tools?.some((tool) => tool.name === "route")) {
      const call = { type: "function_call", call_id: `r${++routed}`, name: "route" };
      fake.script({
        events: [completed([{ ...call, arguments: '{"title":"Long"}' }])],
      });
      return fake.handle(request);
    }
    asked.push({ instructions: body.instructions, said: body.input.at(-1) });
    return held ? new Promise<Response>(() => {}) : fake.handle(request);
  });
  let { person } = await s.start();
  const { authorizeUrl } = await person.call<{ authorizeUrl: string }>("login", "start", {
    redirectUri: "http://127.0.0.1:4321/oauth/chatgpt",
  });
  await person.call("login", "complete", { callbackUrl: await fake.authorize(authorizeUrl) });
  const agent = await createAssistant(person, "Scout", "Scouting ahead.");
  const slot = await chatSlot(person, agent);
  const reached = (one: Person) =>
    one.call(slot, "list").then(
      () => true,
      () => false,
    );
  await until(() => reached(person), "the chat to be exposed");
  held = true;
  await person.call(slot, "send", { text: "a long one" });
  await until(() => asked.length === 1, "the model to be asked");
  await s.stop();

  // The agent is back before management, which holds its settings: the turn waits for them.
  held = false;
  // It answers by sending, and has nothing more to say after.
  const sent = { type: "function_call", call_id: "s1", name: "send" };
  fake.script(
    { events: [completed([{ ...sent, arguments: '{"message":1,"text":"Went on."}' }])] },
    { events: [completed([])] },
  );
  ({ person } = await s.start());
  await until(() => reached(person), "the chat to be back");
  const texts = async () =>
    (await person.call<{ messages: { text: string }[] }>(slot, "history", {})).messages.map(
      (message) => message.text,
    );
  await until(async () => (await texts()).at(-1) === "Went on.", "the turn to go on");
  // The chat has the reply; the line that says it went on is its work's.
  assert.deepEqual(await texts(), ["a long one", "Went on."]);
  // The message was given to its work before the stop: nobody is asked whose it is again.
  assert.equal(routed, 1);
  // Told what its settings say, which only management can answer.
  assert.match(String(asked[1]?.instructions), /What you are for: Scouting ahead\./);
  assert.match(JSON.stringify(asked[1]?.said), /cut off by a restart/);
  await until(
    async () => (await person.call<{ state: string }>(slot, "state")).state === "idle",
    "the turn to end",
  );
  // Asked as it went on, and once more after it had sent, before its turn ended.
  assert.equal(asked.length, 3);
});

test("a slot not bound to the person is refused, and an exposure's name reaches nothing once gone", async (t) => {
  const s = await open(t);
  const { person } = await s.start();
  await assert.rejects(person.call("nothing", "state"), refused("invalid"));
  await assert.rejects(person.call("agents", "nothing"), refused("invalid"));
  const agent = await createAssistant(person, "Scout");
  const slot = await chatSlot(person, agent);
  await until(
    () =>
      person.call(slot, "list").then(
        () => true,
        () => false,
      ),
    "the chat to be exposed",
  );
  await assert.rejects(person.call(slot, "nothing"), refused("invalid"));
  await person.call("agents", "remove", { agent });
  await until(
    () => person.call(slot, "list").then(() => false, refused("invalid")),
    "the slot to go",
  );
});

test("the app's notes are its own file, and the person's store answers from it", async (t) => {
  const s = await open(t);
  const { person } = await s.start();
  assert.deepEqual(await person.call("store", "get", { key: "a" }), {});
  await person.call("store", "set", { key: "a", value: { b: 1 } });
  assert.deepEqual(await person.call("store", "get", { key: "a" }), { value: { b: 1 } });
  assert.deepEqual(JSON.parse(readFileSync(join(s.home, "app-notes.json"), "utf8")).a, { b: 1 });
  assert.equal(statSync(join(s.home, "app-notes.json")).mode & 0o777, 0o600);
  assert.ok(existsSync(join(s.home, "programs", "agents")));
  await assert.rejects(person.call("store", "nothing"), refused("invalid"));
});

test("a home an earlier release ran starts as a fresh one: its package Actors closed, its files left", async (t) => {
  const home = newFolder("agentorg-programs-");
  // Made as an earlier release made them: a package Actor recorded in the Hub, and its stores.
  const earlier = HubState.open(home);
  earlier.close();
  const db = new DatabaseSync(join(home, "hub.db"));
  const agent = "act_earlier";
  db.prepare(
    "INSERT INTO actors (id, name, package, state, created_at) VALUES (?, 'Old agent', ?, 'running', ?)",
  ).run(agent, `sha256-${"0".repeat(64)}`, new Date().toISOString());
  db.close();
  writeFileSync(join(home, "storage.db"), "what an earlier release stored");
  const sha = () =>
    createHash("sha256")
      .update(readFileSync(join(home, "storage.db")))
      .digest("hex");
  const stored = sha();

  const problems: string[] = [];
  const app = await startApp({ home, firstRun: { log: (line) => problems.push(line) } });
  const person = personOf(app, home);
  t.after(async () => {
    await person.close();
    await app.close();
  });
  const ran = await app.firstRun;
  assert.deepEqual(problems, []);
  assert.ok(ran?.management && app.hub.connected(ran.management));
  assert.equal(app.hub.state.actor(agent).state, "closed");
  // Nothing is made again: the person creates agents anew.
  assert.deepEqual((await person.call<{ agents: unknown[] }>("agents", "list")).agents, []);
  assert.ok(await createAssistant(person, "New agent"));
  assert.equal(sha(), stored);
});

test("the templates' listing says which came with the app: it can't be removed, and one saved under its id takes its place", async (t) => {
  const root = newFolder("agentorg-templates-");
  const s = await open(t, {
    dataFolder: join(root, "service"),
    webUrl: "http://127.0.0.1:9/mcp",
    agentsFolder: join(root, "Agents"),
  });
  const { person } = await s.start();
  type Listed = { id: string; title: string; shipped?: true };
  const all = async () =>
    (await person.call<{ templates: Listed[] }>("agents", "templates")).templates;
  const listed = async () =>
    (await all()).map(({ id, title, shipped }) => ({ id, title, shipped }));
  const [assistant] = await all();
  assert.ok(assistant);
  assert.deepEqual(await listed(), [{ id: "assistant", title: assistant.title, shipped: true }]);
  await assert.rejects(
    person.call("agents", "removeTemplate", { id: "assistant" }),
    refused("unknown"),
  );
  // A template to save takes no member it doesn't name, so what was listed is saved without
  // `shipped`.
  await assert.rejects(person.call("agents", "saveTemplate", assistant), refused("invalid"));
  const { shipped: _, ...mine } = assistant;
  await person.call("agents", "saveTemplate", { ...mine, title: "Mine" });
  assert.deepEqual(await listed(), [{ id: "assistant", title: "Mine", shipped: undefined }]);
  // Removing the saved one brings back the app's own.
  await person.call("agents", "removeTemplate", { id: "assistant" });
  assert.deepEqual(await listed(), [{ id: "assistant", title: assistant.title, shipped: true }]);
});

test("the bundled Assistant is a computer and the web, and its computer goes with it", async (t) => {
  const root = newFolder("agentorg-assistant-");
  const data = join(root, "service");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const agentsFolder = join(root, "Agents");
  const s = await open(t, { dataFolder: data, webUrl: "http://127.0.0.1:9/mcp", agentsFolder });
  const { person } = await s.start();
  const { templates } = await person.call<{
    templates: { id: string; units: { unit: string }[] }[];
  }>("agents", "templates");
  assert.deepEqual(
    templates.map((one) => [one.id, one.units.map((unit) => unit.unit)]),
    [["assistant", ["computer", "web"]]],
  );
  // With AgentComputer not installed, the app says how to install it, and starts nothing.
  const { units } = await person.call<{
    units: { id: string; provider: string }[];
  }>("agents", "units");
  const computers = units.find((one) => one.id === "computer")?.provider as string;
  const { bases } = await person.call<{ bases: { id: string; provider: string }[] }>(
    "agents",
    "units",
  );
  const base = { provider: bases[0]?.provider, creatable: "assistant" };
  const unit = {
    provider: computers,
    unit: "computer",
    values: { kind: "this", access: "read" },
  };
  const { problems } = await person.call<{ problems: { message: string }[] }>("agents", "check", {
    stack: { base, units: [unit] },
  });
  assert.match(problems[0]?.message ?? "", /npm install -g @agentorg\/computer/);
  // An untouched Assistant is refused: which computer is the person's to choose.
  await assert.rejects(
    person.call("agents", "create", { template: "assistant", name: "Too soon" }),
    /Which computer must be filled in/,
  );
  assert.deepEqual((await person.call<{ agents: unknown[] }>("agents", "list")).agents, []);
  assert.equal(existsSync(join(data, "server.json")), false);

  const reached = await startService(t, data);

  const { agent } = await person.call<{ agent: string }>("agents", "create", {
    template: "assistant",
    fill: [{ values: { kind: "this", workspace } }],
    name: "Helper",
  });
  const read = await person.call<{
    template: string;
    mcp: { slot: string }[];
    skills: { name: string }[];
  }>("agents", "get", { agent });
  assert.equal(read.template, "assistant");
  // This computer has no browser of its own: the template's answer is a made computer's.
  assert.deepEqual(read.mcp.map((one) => one.slot).sort(), ["computer", "web"]);
  assert.deepEqual(read.skills.map((one) => one.name).sort(), [
    "computer",
    "files",
    "terminal",
    "web-research",
  ]);
  assert.equal((await Computer.list(reached)).length, 1);

  await person.call("agents", "remove", { agent });
  assert.equal((await Computer.list(reached)).length, 0);
  assert.ok(existsSync(workspace), "the named folder stays");

  // With no folder named, its work happens in one named for the agent.
  const { agent: untouched } = await person.call<{ agent: string }>("agents", "create", {
    template: "assistant",
    fill: [{ values: { kind: "this" } }],
    name: "Right away",
  });
  const folder = join(agentsFolder, "Right away");
  const [computer] = await Computer.list(reached);
  assert.equal(computer?.access, "terminal");
  assert.equal(computer?.attached, true);
  assert.equal(computer?.workspace, folder);
  assert.ok(existsSync(folder));
  const shown = await person.call<{
    mcp: { slot: string; origin?: { target: string } }[];
  }>("agents", "get", { agent: untouched });
  assert.ok(
    shown.mcp.find((one) => one.slot === "computer")?.origin?.target.endsWith(`in ${folder}`),
    "the agent page says where it is",
  );
  await person.call("agents", "remove", { agent: untouched });
  assert.equal((await Computer.list(reached)).length, 0);
  assert.ok(existsSync(folder), "it's a folder someone can see, so it stays");
});

test("a socket from the person reaches a computer's surfaces live, with no token in it", async (t) => {
  const root = newFolder("agentorg-live-");
  const data = join(root, "service");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const s = await open(t, {
    dataFolder: data,
    webUrl: "http://127.0.0.1:9/mcp",
    agentsFolder: join(root, "Agents"),
  });
  const reached = await startService(t, data);
  const { app, person } = await s.start();
  const { agent } = await person.call<{ agent: string }>("agents", "create", {
    template: "assistant",
    fill: [{ values: { kind: "this", workspace } }],
    name: "Watched",
  });
  type Surfaces = { surface: string; protocol: string }[];
  const units = (
    await person.call<{
      units: { instance: string; unit: string; status: { surfaces?: Surfaces } }[];
    }>("agents", "get", { agent })
  ).units;
  const computer = units.find((one) => one.unit === "computer");
  const surfaces = computer?.status.surfaces ?? [];
  assert.deepEqual(
    surfaces.map((one) => [one.surface, one.protocol]),
    [
      ["terminal", "terminal@1"],
      ["files", "files@1"],
      ["load", "metrics@1"],
      ["presence", "presence@1"],
    ],
  );
  // A page never holds a ticket: `/api` won't give one.
  await assert.rejects(
    person.call("agents", "live", {
      agent,
      instance: computer?.instance,
      surface: "terminal",
      mode: "watch",
    }),
    refused("forbidden"),
  );

  const kept = Object.values(
    JSON.parse(readFileSync(join(s.home, "programs", "computer", "instances.json"), "utf8")),
  ) as { computer?: { id: string; token: string } }[];
  const held = kept.find((one) => one.computer)?.computer as { id: string; token: string };
  const cli = readFileSync(join(s.home, "cli-token"), "utf8").trim();
  const heard: string[] = [];
  const live = async (surface: string, mode: string) => {
    const socket = new WebSocket(
      `${app.url.replace("http", "ws")}/live?agent=${agent}&instance=${computer?.instance}&surface=${surface}&mode=${mode}`,
      { headers: { Authorization: `Bearer ${cli}` } },
    );
    const frames: string[] = [];
    socket.on("message", (data) => {
      frames.push(String(data));
      heard.push(String(data));
    });
    t.after(() => socket.close());
    await until(() => frames.length > 0, "the surface to open");
    return { socket, frames };
  };

  // A terminal@1 event is one JSON frame.
  type Event = { type?: string; id?: string; by?: string; text?: string; message?: string };
  const events = (frames: string[]) => frames.map((one) => JSON.parse(one) as Event);
  const wrote = (frames: string[], text: string) =>
    events(frames).some((one) => one.type === "output" && one.text?.includes(text));

  // Watching, a person sees what the agent's command wrote.
  const watch = await live("terminal", "watch");
  assert.deepEqual(JSON.parse(watch.frames[0] as string), { op: "live", protocol: "terminal@1" });
  const run = await Computer.connect(held.id, { ...reached, accessToken: held.token });
  await run.commands.run("echo live-proof");
  await run.close();
  await until(() => wrote(watch.frames, "live-proof"), "the command to be seen");

  // Operating, a person opens a shell of their own and types into it. A service without node-pty
  // refuses the shell, and the rest isn't shown here.
  const shell = await live("terminal", "operate");
  shell.socket.send(JSON.stringify({ type: "open", columns: 80, rows: 24 }));
  const opened = () =>
    events(shell.frames).find(
      (one) => one.type === "refused" || (one.type === "start" && one.by === "person"),
    );
  await until(() => opened() !== undefined, "the shell to open, or to be refused");
  const answer = opened();
  if (answer?.type === "start") {
    const typed = { type: "input", id: answer.id, text: "echo shell-$((40+2))\n" };
    shell.socket.send(JSON.stringify(typed));
    await until(() => wrote(shell.frames, "shell-42"), "the shell to answer");
  } else assert.match(answer?.message ?? "", /node-pty/);
  for (const secret of [reached.apiKey, held.token])
    assert.ok(!heard.some((one) => one.includes(secret)), "no token reaches the page");
  await person.call("agents", "remove", { agent });
});
