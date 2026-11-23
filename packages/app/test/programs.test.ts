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
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after } from "node:test";
import { Computer } from "@agentorg/computer-sdk";
import { HubState, PERSON } from "@agentorg/hub";
import { agents } from "@agentorg/interfaces";
import { connect } from "@agentorg/sdk/client";
import type { AgentPlugin } from "assistant/plugins";
import { completed, fakeOpenAI, type Script } from "chatgpt/fake-openai";
import type { Context } from "cordis";
import WebSocket from "ws";
import { type App, type ProgramsOptions, startApp } from "../src/index.ts";
import { FIRST_CONTROL } from "../src/programs.ts";

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
/** This machine's screen and the person's own browser are never a test's: off, whatever is ready. */
const NEITHER = { screen: "off", ownBrowser: "none" };
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
async function startService(t: test.TestContext, data: string, more: string[] = []) {
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
      ...more,
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
  computer?: {
    dataFolder: string;
    webUrl: string;
    agentsFolder: string;
    macRecord?: string;
  },
  fetch?: (request: Request) => Promise<Response>,
  firstRun: {
    assistant?: boolean;
    log?: (line: string) => void;
    carried?: ProgramsOptions["carried"];
  } = {},
) {
  const home = newFolder("agentorg-programs-");
  const started: { app: App; person: Person }[] = [];
  const start = async () => {
    const app = await startApp({
      home,
      defaultPort: 0,
      firstRun: {
        log: firstRun.log ?? (() => {}),
        // An empty path: the test starts any service itself.
        computer: { path: "", ...computer },
        ...(fetch ? { fetch } : {}),
        // Made only where a test asks for it, so no other test's agents change.
        assistant: firstRun.assistant ?? false,
        ...(firstRun.carried ? { carried: firstRun.carried } : {}),
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

test("an agent given Memory keeps a line it writes, and is told it at its next turn and after the app starts again", async (t) => {
  // The model, scripted: each of the agent's requests answered in turn, nothing once those run out,
  // and a message heard apart asks for no stop. What each of its requests is told and offered is
  // kept.
  const fake = await fakeOpenAI();
  const worker: { instructions: string; tools: string[] }[] = [];
  const answers: object[][] = [];
  const s = await open(t, undefined, async (request) => {
    if (!request.url.endsWith("/responses")) return fake.handle(request);
    const body = (await request.clone().json()) as {
      instructions: string;
      input: unknown[];
      tools?: { name: string }[];
    };
    const tools = (body.tools ?? []).map((tool) => tool.name);
    if (tools.includes("route")) {
      fake.script({ events: [completed([])] });
      return fake.handle(request);
    }
    worker.push({ instructions: body.instructions, tools });
    fake.script({ events: [completed((answers.shift() ?? []) as never)] });
    return fake.handle(request);
  });
  let { person } = await s.start();
  const { authorizeUrl } = await person.call<{ authorizeUrl: string }>("login", "start", {
    redirectUri: "http://127.0.0.1:4321/oauth/chatgpt",
  });
  await person.call("login", "complete", { callbackUrl: await fake.authorize(authorizeUrl) });
  // Made from a stack that names management's Memory unit, which isn't on offer: management is
  // found as the provider of its own Skill unit, which is.
  const { units } = await person.call<{ units: { id: string; provider: string }[] }>(
    "agents",
    "units",
  );
  const management = units.find((one) => one.id === "skill")?.provider;
  assert.ok(management);
  const { creatables } = await person.call<{ creatables: { provider: string; id: string }[] }>(
    "agents",
    "creatable",
  );
  const [assistant] = creatables;
  assert.ok(assistant);
  const { agent } = await person.call<{ agent: string }>("agents", "create", {
    stack: {
      base: { provider: assistant.provider, creatable: assistant.id },
      units: [{ provider: management, unit: "memory" }],
    },
    name: "Keeper",
  });
  const slot = await chatSlot(person, agent);
  const reached = (one: Person) =>
    one.call(slot, "list").then(
      () => true,
      () => false,
    );
  /** Send a message and wait for the agent's turn to end; what its first worker request was told. */
  const turn = async (text: string) => {
    const from = worker.length;
    await person.call(slot, "send", { text });
    await until(() => worker.length > from, "the worker to be asked");
    await until(
      async () => (await person.call<{ state: string }>(slot, "state")).state === "idle",
      "the turn to end",
    );
    return worker[from] as (typeof worker)[number];
  };
  const line = /\nWhat you remember:\n- \[1\] The person is called Sam\. \(\d{4}-\d{2}-\d{2}\)\n/;
  await until(() => reached(person), "the chat to be exposed");

  // Told "Call me Sam.", the worker writes it down.
  answers.push([
    {
      type: "function_call",
      call_id: "m1",
      name: "memory__edit",
      arguments: JSON.stringify({ action: "add", text: "The person is called Sam." }),
    },
  ]);
  const first = await turn("Call me Sam.");
  assert.ok(first.tools.includes("memory__edit"), "offered memory's function");
  assert.match(first.instructions, /\nYou remember nothing yet\.\n/, "nothing remembered yet");
  // At its next turn it is told the line.
  assert.match((await turn("What's my name?")).instructions, line);
  // And after the app starts again, from the agent's own store.
  await s.stop();
  ({ person } = await s.start());
  await until(() => reached(person), "the chat to be back");
  assert.match((await turn("Still there?")).instructions, line);
});

test("an agent whose settings name a plugin the app doesn't carry runs without it, and says why", async (t) => {
  const s = await open(t);
  let { person } = await s.start();
  const agent = await createAssistant(person, "Scout");
  await s.stop();
  // A capability made of a plugin this version doesn't carry, as a later version may have kept.
  const path = join(s.home, "programs", "management", "manager.json");
  const kept = JSON.parse(readFileSync(path, "utf8"));
  kept.agents[agent].capabilities.push({
    id: "search",
    title: "Search",
    slots: [],
    surfaces: [],
    views: [],
    plugins: [{ name: "search" }],
  });
  writeFileSync(path, JSON.stringify(kept));
  ({ person } = await s.start());
  const status = async () =>
    (await person.call<{ status: { state: string; detail?: string } }>("agents", "get", { agent }))
      .status;
  const without = {
    state: "running",
    detail: "It runs without search: this provider doesn't carry it.",
  };
  await until(
    async () => (await status()).detail !== undefined,
    "the agent to say what it runs without",
  );
  assert.deepEqual(await status(), without);
});

test("a turn cut off as the app stops goes on when it is started again, with the agent's settings", async (t) => {
  // The model, scripted: its next answer stays out while `held`, as when the app stops mid-turn.
  const fake = await fakeOpenAI();
  const asked: { instructions: string; said: unknown }[] = [];
  let held = false;
  const s = await open(t, undefined, async (request) => {
    if (!request.url.endsWith("/responses")) return fake.handle(request);
    const body = (await request.clone().json()) as { instructions: string; input: unknown[] };
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
  // It answers by sending, which answers all its turn took.
  const sent = { type: "function_call", call_id: "s1", name: "send" };
  fake.script({
    events: [completed([{ ...sent, arguments: '{"message":1,"text":"Went on."}' }])],
  });
  ({ person } = await s.start());
  await until(() => reached(person), "the chat to be back");
  const texts = async () =>
    (await person.call<{ messages: { text: string }[] }>(slot, "history", {})).messages.map(
      (message) => message.text,
    );
  await until(async () => (await texts()).at(-1) === "Went on.", "the turn to go on");
  // The chat has the reply; the line that says it went on is its work's.
  assert.deepEqual(await texts(), ["a long one", "Went on."]);
  // Told what its settings say, which only management can answer.
  assert.match(String(asked[1]?.instructions), /What you are for: Scouting ahead\./);
  assert.match(JSON.stringify(asked[1]?.said), /cut off by a restart/);
  await until(
    async () => (await person.call<{ state: string }>(slot, "state")).state === "idle",
    "the turn to end",
  );
  // Asked as it went on, and once more after its reply, which called nothing: its turn ended there.
  assert.equal(asked.length, 3);
});

test("a model request being tried again is on the agent's Activity, on the conversation's entry, gone at the answer and at giving up", async (t) => {
  // OpenAI's responses on a port of this machine. A request of the conversation's own loop is
  // dropped while it is cut, as a connection that breaks; else each is answered with the next
  // answer. A message heard apart asks for no stop.
  const fake = await fakeOpenAI();
  const cut = { work: false };
  type Answer = Script | ((number: number) => Script);
  const answers: Answer[] = [];
  /** The number the newest message a request reads starts with, as a loop is shown it. */
  const numberOf = (input: { role?: string; content?: unknown }[]) => {
    const words = (item: { content?: unknown }) =>
      typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? "");
    const said = input.findLast((item) => item.role === "user" && /^\[\d+\]/.test(words(item)));
    return Number(/\[(\d+)\]/.exec(said ? words(said) : "")?.[1] ?? 0);
  };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const asked = JSON.parse(String(body)) as {
      tools?: { name: string }[];
      input: { role?: string; content?: unknown }[];
    };
    const heard = (asked.tools ?? []).some((tool) => tool.name === "route");
    if (!heard && cut.work) {
      request.socket.destroy();
      return;
    }
    const next = (heard ? undefined : answers.shift()) ?? { events: [completed([])] };
    fake.script(typeof next === "function" ? next(numberOf(asked.input)) : next);
    const answer = await fake.handle(
      new Request(`https://api.openai.com${request.url}`, {
        method: request.method,
        headers: { authorization: request.headers.authorization ?? "" },
        body,
      }),
    );
    response.writeHead(answer.status, Object.fromEntries(answer.headers));
    if (answer.body) for await (const chunk of answer.body) response.write(chunk);
    response.end();
  });
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
  t.after(() => {
    server.close();
    server.closeAllConnections();
  });
  const s = await open(t, undefined, async (request) => {
    const url = new URL(request.url);
    if (!url.pathname.endsWith("/responses")) return fake.handle(request);
    return fetch(`http://127.0.0.1:${port}${url.pathname}`, {
      method: request.method,
      headers: request.headers,
      body: await request.text(),
      signal: request.signal,
    });
  });
  const { person } = await s.start();
  const { authorizeUrl } = await person.call<{ authorizeUrl: string }>("login", "start", {
    redirectUri: "http://127.0.0.1:4321/oauth/chatgpt",
  });
  await person.call("login", "complete", { callbackUrl: await fake.authorize(authorizeUrl) });
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
  // Its Activity, read as a page reads it: the view's operation, through the person's own slot.
  type Retry = { attempt: number; of: number; at: string };
  type Read = {
    works: { id: string; title: string; state: string; failed?: true; retrying?: Retry }[];
    retrying?: Retry;
  };
  const { capabilities } = await person.call<{
    capabilities: {
      views: { kind: string; operation?: string; slot?: string }[];
      person: { operations: Record<string, string> };
    }[];
  }>("agents", "get", { agent });
  const held = capabilities.find((one) => one.views.some((view) => view.kind === "activity"));
  const view = held?.views.find((one) => one.kind === "activity");
  const tools = view?.slot ? held?.person.operations[view.slot] : undefined;
  assert.ok(tools && view?.operation, "the agent's Activity is read through the person's slot");
  const activity = async () =>
    JSON.parse(
      (
        await person.call<{ output: string }>(tools, "call", {
          name: view.operation,
          arguments: {},
        })
      ).output,
    ) as Read;
  const texts = async () =>
    (await person.call<{ messages: { text: string }[] }>(slot, "history", {})).messages.map(
      (message) => message.text,
    );
  const idle = () =>
    until(
      async () => (await person.call<{ state: string }>(slot, "state")).state === "idle",
      "the agent to be idle",
    );
  /** Each retry Activity said, in the order it changed, read from `read` until `done`. */
  const watch = async (
    read: () => Promise<Retry | undefined>,
    done: (seen: Retry[]) => boolean,
  ) => {
    const seen: Retry[] = [];
    await until(async () => {
      const now = await read();
      if (now && now.attempt !== seen.at(-1)?.attempt) seen.push(now);
      return done(seen);
    }, "the retries to be said");
    return seen;
  };
  /**
   * The retries as they were said: each one later than the one before, of ten at most, beginning
   * after it was asked for, and soon. A slow read may miss one, as a page would; not the order.
   */
  const sane = (seen: Retry[], asked: number) => {
    for (const [i, retry] of seen.entries()) {
      if (i > 0) assert.ok(retry.attempt > (seen[i - 1] as Retry).attempt, JSON.stringify(seen));
      assert.equal(retry.of, 10);
      const at = Date.parse(retry.at);
      assert.ok(at > asked && at <= Date.now() + 2 ** retry.attempt * 1100, retry.at);
    }
  };

  const sent = { type: "function_call", call_id: "s1", name: "send" };
  const sends = (text: string) => (number: number) => ({
    events: [completed([{ ...sent, arguments: JSON.stringify({ message: number, text }) }])],
  });
  /** The conversation's own entry in Activity. */
  const conversation = async () =>
    (await activity()).works.find((one) => one.title === "This conversation");

  // A message: the conversation's own loop's request, cut, is tried again, said on its entry, and
  // goes when it answers once the connection is back.
  cut.work = true;
  answers.push(sends("Here."));
  let asked = Date.now();
  await person.call(slot, "send", { text: "Are you there?" });
  const first = await watch(
    async () => (await conversation())?.retrying,
    (seen) => (seen.at(-1)?.attempt ?? 0) >= 2,
  );
  sane(first, asked);
  cut.work = false;
  await until(async () => (await texts()).at(-1) === "Here.", "the conversation to answer");
  await idle();
  assert.equal((await conversation())?.retrying, undefined);
  assert.equal((await activity()).retrying, undefined);

  // Given up: the try after a retry asks for a wait longer than a minute, so its failure is the
  // answer, and the retry goes with it.
  answers.push({ status: 429, code: "rate_limit_exceeded", retryAfterMs: "61000" });
  cut.work = true;
  asked = Date.now();
  await person.call(slot, "send", { text: "Once more." });
  const again = await watch(
    async () => (await conversation())?.retrying,
    (seen) => seen.length === 1,
  );
  sane(again, asked);
  cut.work = false;
  await until(async () => (await conversation())?.failed === true, "the conversation to fail");
  await idle();
  assert.equal((await conversation())?.retrying, undefined);
  assert.equal((await activity()).retrying, undefined);
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
  const app = await startApp({
    home,
    defaultPort: 0,
    firstRun: { log: (line) => problems.push(line) },
  });
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

test("with no provider that makes, the person's computer is this one: a new one is no answer of its", async (t) => {
  const root = newFolder("agentorg-which-");
  const s = await open(t, {
    dataFolder: join(root, "service"),
    webUrl: "http://127.0.0.1:9/mcp",
    agentsFolder: join(root, "Agents"),
  });
  const { person } = await s.start();
  const { units, bases } = await person.call<{
    units: { id: string; provider: string; form: { id: string }[] }[];
    bases: { id: string; provider: string }[];
  }>("agents", "units");
  const computer = units.find((one) => one.id === "computer");
  assert.equal(
    computer?.form.some((field) => field.id === "kind"),
    false,
  );
  const { problems } = await person.call<{ problems: { field?: string; message: string }[] }>(
    "agents",
    "check",
    {
      stack: {
        base: { provider: bases[0]?.provider, creatable: "assistant" },
        units: [
          {
            provider: computer?.provider,
            unit: "computer",
            values: { kind: "new", made: "container", access: "read" },
          },
        ],
      },
    },
  );
  assert.deepEqual(
    problems.map((one) => one.message),
    ["This unit has no field kind.", "This unit has no field made."],
  );
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
    values: { access: "read" },
  };
  const { problems } = await person.call<{ problems: { message: string }[] }>("agents", "check", {
    stack: { base, units: [unit] },
  });
  assert.match(problems[0]?.message ?? "", /npm install -g @agentorg\/computer/);
  // An untouched Assistant is refused too: its computer, this one, can't be had yet.
  await assert.rejects(
    person.call("agents", "create", { template: "assistant", name: "Too soon" }),
    /npm install -g @agentorg\/computer/,
  );
  assert.deepEqual((await person.call<{ agents: unknown[] }>("agents", "list")).agents, []);
  assert.equal(existsSync(join(data, "server.json")), false);

  const reached = await startService(t, data);

  const { agent } = await person.call<{ agent: string }>("agents", "create", {
    template: "assistant",
    fill: [{ values: { workspace, ...NEITHER } }],
    name: "Helper",
  });
  const read = await person.call<{
    template: string;
    mcp: { slot: string }[];
    skills: { name: string }[];
  }>("agents", "get", { agent });
  assert.equal(read.template, "assistant");
  // This computer has no browser of its own, and the template asks none.
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
    fill: [{ values: { ...NEITHER } }],
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

/** What the first Assistant's file under the home's programs says, once it says `made`. */
async function firstMade(home: string) {
  const file = join(home, "programs", "assistant.json");
  for (const end = Date.now() + 60_000; Date.now() < end; ) {
    try {
      const read = JSON.parse(readFileSync(file, "utf8")) as { made?: boolean; agent?: string };
      if (read.made !== undefined) return read;
    } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("The first Assistant's file never said whether it was made.");
}
/** AgentOrg Mac's parts, as its service says: which are on. */
async function partsOn(service: { apiUrl: string; apiKey: string }) {
  const { capabilities } = (await (
    await fetch(`${service.apiUrl}/v1/setup`, {
      headers: { Authorization: `Bearer ${service.apiKey}` },
    })
  ).json()) as { capabilities: { capability: string; on: boolean }[] };
  return Object.fromEntries(capabilities.map((one) => [one.capability, one.on]));
}

test("a fresh home's first start makes the Assistant once AgentOrg Mac comes, with its parts switched on, and never again", async (t) => {
  const root = newFolder("agentorg-first-");
  // AgentOrg Mac's folder, where its service, which starts with its parts off, keeps its record.
  const mac = join(root, "mac");
  const agentsFolder = join(root, "Agents");
  const said: string[] = [];
  const s = await open(
    t,
    {
      dataFolder: join(root, "unused"),
      webUrl: "http://127.0.0.1:9/mcp",
      agentsFolder,
      macRecord: mac,
    },
    undefined,
    { assistant: true, log: (line) => said.push(line) },
  );
  const { person } = await s.start();
  type Listed = { agents: { agent: string; name: string }[] };
  // No AgentOrg Mac yet: nothing is made, and the app goes on waiting for it.
  assert.deepEqual((await person.call<Listed>("agents", "list")).agents, []);
  assert.equal(existsSync(join(s.home, "programs", "assistant.json")), false);

  const reached = await startService(t, mac, ["--lend"]);
  const first = await firstMade(s.home);
  assert.equal(first.made, true);
  const listed = (await person.call<Listed>("agents", "list")).agents;
  assert.deepEqual(
    listed.map((one) => [one.agent, one.name]),
    [[first.agent, "Assistant"]],
  );
  // Its parts were switched on, all but the person's own browser.
  assert.deepEqual(await partsOn(reached), {
    terminal: true,
    files: true,
    screen: true,
    browser: false,
  });
  // This computer, with commands, the screen when it can be had, the web, and its own agents.
  const read = await person.call<{
    units: { unit: string; values: Record<string, unknown> }[];
    skills: { name: string }[];
  }>("agents", "get", { agent: first.agent });
  assert.deepEqual(
    read.units.map((one) => one.unit),
    ["computer", "web", "control"],
  );
  const [computer, web, control] = read.units;
  // Which computer isn't asked, and the person's browser, which can't be had here, isn't either.
  assert.deepEqual(
    { ...computer?.values, screen: undefined },
    { access: "terminal", screen: undefined },
  );
  // Here the screen can't be had (no driver), and the log says so.
  const withoutScreen = said.filter((line) =>
    line.startsWith("First run: the Assistant was made without the screen: "),
  );
  // A screen that can't be had isn't asked, so no answer for it is kept.
  assert.equal(computer?.values.screen, withoutScreen.length ? undefined : "on");
  assert.equal(web?.values.service, "exa");
  assert.deepEqual(
    {
      agents: control?.values.agents,
      templates: control?.values.templates,
      places: control?.values.places,
      access: control?.values.access,
      browser: control?.values.browser,
    },
    {
      agents: "own",
      templates: ["assistant"],
      places: ["own"],
      access: "terminal",
      browser: false,
    },
  );
  assert.ok(read.skills.some((one) => one.name === "delegating"));
  assert.ok(
    existsSync(join(agentsFolder, "Assistant")),
    "its work happens in a folder named for it",
  );
  assert.deepEqual(
    said.filter((line) => line.includes("couldn't")),
    [],
  );

  // Made once: removed, and a part switched off, neither comes back at the next start.
  await person.call("agents", "remove", { agent: first.agent });
  await fetch(`${reached.apiUrl}/v1/setup/screen`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${reached.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ on: false }),
  });
  await s.stop();
  const again = await s.start();
  assert.deepEqual((await again.person.call<Listed>("agents", "list")).agents, []);
  assert.equal((await partsOn(reached)).screen, false);
});

test("a home that has agents gets no first Assistant, also one the person makes while the app waits, and its parts stay off", async (t) => {
  const root = newFolder("agentorg-first-");
  const mac = join(root, "mac");
  const s = await open(
    t,
    {
      dataFolder: join(root, "unused"),
      webUrl: "http://127.0.0.1:9/mcp",
      agentsFolder: join(root, "Agents"),
      macRecord: mac,
    },
    undefined,
    { assistant: true },
  );
  const { person } = await s.start();
  // While the app waits for AgentOrg Mac, the person makes an agent of their own.
  const mine = await createAssistant(person, "Mine");
  const reached = await startService(t, mac, ["--lend"]);
  const marked = await firstMade(s.home);
  assert.equal(marked.made, false);
  assert.equal(marked.agent, undefined);
  type Listed = { agents: { agent: string }[] };
  assert.deepEqual(
    (await person.call<Listed>("agents", "list")).agents.map((one) => one.agent),
    [mine],
  );
  assert.deepEqual(await partsOn(reached), {
    terminal: false,
    files: false,
    screen: false,
    browser: false,
  });
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
    fill: [{ values: { workspace, ...NEITHER } }],
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

/**
 * A saved copy of what the model is told, in test/told: a change of words shows as a diff here.
 * With WRITE_TOLD=1 the copy is written instead, for a change that is meant.
 */
function matchesSaved(name: string, text: string) {
  // From dist/test, the sources' test folder.
  const file = new URL(`../../test/told/${name}`, import.meta.url);
  if (process.env.WRITE_TOLD === "1") writeFileSync(file, text);
  assert.equal(
    text,
    readFileSync(file, "utf8"),
    `${name} changed: if that is meant, run with WRITE_TOLD=1`,
  );
}

test("an agent made from the Assistant template, with nothing mounted, is told the saved words and offered the saved functions, by its conversation's own loop", async (t) => {
  const root = newFolder("agentorg-told-");
  const data = join(root, "data");
  const workspace = join(root, "work");
  mkdirSync(workspace);
  await startService(t, data);
  // The model, scripted: one reply. What each request is told is kept.
  const fake = await fakeOpenAI();
  const told: string[] = [];
  const offered: unknown[] = [];
  const s = await open(
    t,
    { dataFolder: data, webUrl: "http://127.0.0.1:9/mcp", agentsFolder: join(root, "Agents") },
    async (request) => {
      if (!request.url.endsWith("/responses")) return fake.handle(request);
      const body = (await request.clone().json()) as { instructions: string; tools?: unknown[] };
      told.push(body.instructions);
      offered.push(body.tools ?? []);
      const sent = { type: "function_call", call_id: "s1", name: "send" };
      fake.script({
        events: [
          completed(
            told.length === 1 ? [{ ...sent, arguments: '{"message":1,"text":"Hello."}' }] : [],
          ),
        ],
      });
      return fake.handle(request);
    },
  );
  const { person } = await s.start();
  const { authorizeUrl } = await person.call<{ authorizeUrl: string }>("login", "start", {
    redirectUri: "http://127.0.0.1:4321/oauth/chatgpt",
  });
  await person.call("login", "complete", { callbackUrl: await fake.authorize(authorizeUrl) });
  const { agent } = await person.call<{ agent: string }>("agents", "create", {
    template: "assistant",
    fill: [{ values: { workspace, ...NEITHER } }],
    name: "Told",
    purpose: "Checks what it is told.",
  });
  const slot = await chatSlot(person, agent);
  await until(
    () =>
      person.call(slot, "list").then(
        () => true,
        () => false,
      ),
    "the chat to be exposed",
  );
  await person.call(slot, "send", { text: "Hi!" });
  await until(() => told.length >= 1, "the agent to be asked");
  await until(
    async () => (await person.call<{ state: string }>(slot, "state")).state === "idle",
    "the turn to end",
  );
  // Its workspace is this test's own folder, said as <root>. The functions it is offered are
  // saved beside what it is told, as each tool's whole description.
  matchesSaved("assistant.txt", (told[0] ?? "").replaceAll(root, "<root>"));
  matchesSaved(
    "assistant-tools.txt",
    `${JSON.stringify(offered[0] ?? [], null, 2).replaceAll(root, "<root>")}\n`,
  );
  await person.call("agents", "remove", { agent });
});

test("an Assistant made empty with the assistant template mounted is told and offered what one made as the first start makes it is, but memory's words and function, and its computer, web and memory said as mounted", async (t) => {
  const root = newFolder("agentorg-assistant-");
  const data = join(root, "data");
  const workspace = join(root, "work");
  mkdirSync(workspace);
  await startService(t, data);
  // The model, scripted: no reply. What each request is told and offered is kept.
  const fake = await fakeOpenAI();
  type Tool = { name: string };
  const asked: { instructions: string; tools: Tool[] }[] = [];
  const s = await open(
    t,
    { dataFolder: data, webUrl: "http://127.0.0.1:9/mcp", agentsFolder: join(root, "Agents") },
    async (request) => {
      if (!request.url.endsWith("/responses")) return fake.handle(request);
      const body = (await request.clone().json()) as { instructions: string; tools?: Tool[] };
      asked.push({ instructions: body.instructions, tools: body.tools ?? [] });
      fake.script({ events: [completed([])] });
      return fake.handle(request);
    },
  );
  const { person, ran } = await s.start();
  const { management } = ran as NonNullable<typeof ran>;
  const { authorizeUrl } = await person.call<{ authorizeUrl: string }>("login", "start", {
    redirectUri: "http://127.0.0.1:4321/oauth/chatgpt",
  });
  await person.call("login", "complete", { callbackUrl: await fake.authorize(authorizeUrl) });
  // As the first start makes it: the Assistant template's computer and web, then its control unit.
  const { agent: units } = await person.call<{ agent: string }>("agents", "create", {
    template: "assistant",
    fill: [{ values: { workspace, ...NEITHER } }],
    name: "Ada",
  });
  await person.call("agents", "addUnit", {
    agent: units,
    unit: { provider: management, unit: "control", values: FIRST_CONTROL },
  });
  // Made empty, then the template mounted, given the same computer.
  const { agent: mounts } = await person.call<{ agent: string }>("agents2", "create", {
    name: "Bea",
  });
  const made = await person.call<{ mounted?: string }>("agents2", "mount", {
    agent: mounts,
    provider: management,
    capability: "assistant",
    arguments: { computer: { workspace, ...NEITHER } },
  });
  assert.ok(made.mounted, JSON.stringify(made));
  /** What its first message's first request is told and offered. */
  const firstAsked = async (agent: string) => {
    const before = asked.length;
    const slot = await chatSlot(person, agent);
    await until(
      () =>
        person.call(slot, "list").then(
          () => true,
          () => false,
        ),
      "the chat to be exposed",
    );
    await person.call(slot, "send", { text: "Hi!" });
    await until(() => asked.length > before, "the agent to be asked");
    await until(
      async () => (await person.call<{ state: string }>(slot, "state")).state === "idle",
      "the turn to end",
    );
    const one = asked[before] as (typeof asked)[number];
    return { ...one, instructions: one.instructions.replaceAll(root, "<root>") };
  };
  const byUnits = await firstAsked(units);
  const byMounts = await firstAsked(mounts);
  // Told the same, but memory's section, added whole, and what is said as mounted: memory, and the
  // computer and the web, which its settings name though their provider is outside the agent.
  const marks = /^- (memory|computer|web) \(([^)]*?), mounted\)/gm;
  assert.deepEqual(
    [...byMounts.instructions.matchAll(marks)].map((one) => one[1]),
    ["memory", "computer", "web"],
  );
  assert.equal([...byUnits.instructions.matchAll(marks)].length, 0);
  const told = byUnits.instructions;
  const unmarked = byMounts.instructions.replace(marks, "- $1 ($2)");
  let same = 0;
  while (same < told.length && told[same] === unmarked[same]) same++;
  let after = 0;
  while (after < told.length - same && told.at(-1 - after) === unmarked.at(-1 - after)) after++;
  assert.equal(same + after, told.length, "nothing of what it was told is changed or gone");
  matchesSaved("assistant-memory.txt", unmarked.slice(same, unmarked.length - after));
  // Offered the same functions, and memory's.
  assert.deepEqual(
    byMounts.tools.filter((one) => one.name !== "memory__edit"),
    byUnits.tools,
  );
  assert.equal(byMounts.tools.length, byUnits.tools.length + 1);
  for (const agent of [units, mounts]) await person.call("agents", "remove", { agent });
});

test("the person, the agent itself and another program each mount memory on a running agent through management and take it off; the agent mounts it through its control, which reaches management once mounted, and the lines outlast each and a restart", async (t) => {
  // The model, scripted: each of the agent's requests answered in turn, nothing once those run out.
  // What each request is told, and its input, are kept.
  const fake = await fakeOpenAI();
  const told: string[] = [];
  const inputs: { type: string; call_id?: string; output?: string }[][] = [];
  const answers: object[][] = [];
  const s = await open(t, undefined, async (request) => {
    if (!request.url.endsWith("/responses")) return fake.handle(request);
    const body = (await request.clone().json()) as {
      instructions: string;
      input: (typeof inputs)[number];
    };
    told.push(body.instructions);
    inputs.push(body.input);
    fake.script({ events: [completed((answers.shift() ?? []) as never)] });
    return fake.handle(request);
  });
  let { person, app, ran } = await s.start();
  const { agents: executor, management } = ran as NonNullable<typeof ran>;
  assert.ok(executor && management);
  const { authorizeUrl } = await person.call<{ authorizeUrl: string }>("login", "start", {
    redirectUri: "http://127.0.0.1:4321/oauth/chatgpt",
  });
  await person.call("login", "complete", { callbackUrl: await fake.authorize(authorizeUrl) });
  const agent = await createAssistant(person, "Keeper");
  const made = app.hub.state.createActor(PERSON, {
    name: "Another program",
    bindings: [{ slot: "agents", provider: management, export: "agents" }],
  });
  const joinProgram = async (hubUrl: string) => {
    const joined = await connect({
      hubUrl,
      actorId: made.actorId,
      credential: made.credential as string,
      slots: { agents },
    });
    t.after(() => joined.close());
    await until(() => joined.slots.agents.bound, "the program's binding");
    return joined.slots.agents.call;
  };
  let program = await joinProgram(app.hubUrl);
  type Mounted = { mounted?: { mounted: string; capability: string; by: string }[] };
  const memory = { agent, provider: executor, capability: "memory", arguments: {} };
  /** The tree as the person and the program read it: the same, whoever asks. */
  const tree = async () => {
    const byPerson = (await person.call<Mounted>("agents", "get", { agent })).mounted;
    const byProgram = (await program.get({ agent })).mounted;
    assert.deepEqual(byProgram, byPerson);
    return (byPerson ?? []).map(({ capability, by }) => `${capability} by ${by}`);
  };
  const idOf = async (capability: string) =>
    (await person.call<Mounted>("agents", "get", { agent })).mounted?.find(
      (one) => one.capability === capability,
    )?.mounted as string;
  /** Whether management's agents@1 is exposed to the agent. */
  const reaches = async () =>
    (
      await person.call<{ bindings: { consumer: string; slot: string; provider: string }[] }>(
        "bindings",
        "list",
        { actor: agent },
      )
    ).bindings.some(
      (b) => b.consumer === agent && b.slot === "agents" && b.provider === management,
    );
  const slot = await chatSlot(person, agent);
  await until(
    () =>
      person.call(slot, "list").then(
        () => true,
        () => false,
      ),
    "the chat to be exposed",
  );
  /** Send a message and wait for its turn to end; what its first request was told. */
  const turn = async (text: string) => {
    const from = told.length;
    await person.call(slot, "send", { text });
    await until(() => told.length > from, "the agent to be asked");
    await until(
      async () => (await person.call<{ state: string }>(slot, "state")).state === "idle",
      "the turn to end",
    );
    return told[from] as string;
  };
  /** What a call of the agent's returned, by its id, as the model was next sent it. */
  const output = (id: string) =>
    inputs.flat().find((item) => item.type === "function_call_output" && item.call_id === id)
      ?.output;
  const call = (id: string, name: string, args: object) => ({
    type: "function_call",
    call_id: id,
    name,
    arguments: JSON.stringify(args),
  });
  const line = /- \[1\] The person is called Sam\. \(\d{4}-\d{2}-\d{2}\)/;
  const mounted = async (by: string, mount: () => Promise<unknown>) => {
    const result = (await mount()) as { mounted?: string };
    assert.ok(result.mounted, `${by}: ${JSON.stringify(result)}`);
    return result.mounted;
  };

  // The person mounts control, which reaches management's agents@1 for as long as it is mounted.
  assert.equal(await reaches(), false);
  await mounted("person", () =>
    person.call("agents", "mount", {
      ...memory,
      capability: "control",
      arguments: { templates: ["assistant"] },
    }),
  );
  assert.equal(await reaches(), true);

  // The person mounts memory; told "Call me Sam.", the agent writes it down.
  const byPerson = await mounted("person", () => person.call("agents", "mount", memory));
  assert.deepEqual(await tree(), ["control by person", "memory by person"]);
  answers.push([call("m1", "memory__edit", { action: "add", text: "The person is called Sam." })]);
  await turn("Call me Sam.");
  assert.match(await turn("What's my name?"), line);
  // Taken off by the person, it tells the agent nothing.
  await person.call("agents", "unmount", { agent, mounted: byPerson });
  assert.deepEqual(await tree(), ["control by person"]);
  assert.doesNotMatch(await turn("Still there?"), line);

  // The agent mounts it itself, through its control: it lists what it may mount, and mounts it.
  answers.push(
    [call("l1", "control__capability_list", {})],
    [call("c1", "control__capability_mount", { provider: executor, capability: "memory" })],
  );
  await turn("Remember things for me from now on.");
  const listed = JSON.parse(output("l1") ?? "{}") as { capabilities?: { id: string }[] };
  assert.ok(
    listed.capabilities?.some((one) => one.id === "memory"),
    output("l1"),
  );
  assert.match(output("c1") ?? "", /"mounted":"mnt_/);
  assert.deepEqual(await tree(), ["control by person", `memory by ${agent}`]);
  assert.match(await turn("Remember me?"), line);
  // And takes it off itself.
  answers.push([call("u1", "control__capability_unmount", { mounted: await idOf("memory") })]);
  await turn("Forget all that.");
  assert.equal(output("u1"), "{}");
  assert.deepEqual(await tree(), ["control by person"]);

  // Another program mounts it, and the app starts again: it is still mounted, the line told, and
  // control still reaches management.
  await mounted(made.actorId, () => program.mount(memory));
  assert.deepEqual(await tree(), ["control by person", `memory by ${made.actorId}`]);
  await s.stop();
  ({ person, app, ran } = await s.start());
  program = await joinProgram(app.hubUrl);
  const again = await chatSlot(person, agent);
  assert.equal(again, slot);
  await until(
    () =>
      person.call(slot, "list").then(
        () => true,
        () => false,
      ),
    "the chat to be exposed again",
  );
  assert.deepEqual(await tree(), ["control by person", `memory by ${made.actorId}`]);
  assert.match(await turn("And now?"), line);
  assert.equal(await reaches(), true);
  await program.unmount({ agent, mounted: await idOf("memory") });
  assert.deepEqual(await tree(), ["control by person"]);
  // Control taken off, it reaches management no more.
  await person.call("agents", "unmount", { agent, mounted: await idOf("control") });
  assert.deepEqual(await tree(), []);
  assert.equal(await reaches(), false);
  // Removed with memory mounted on it, the agent goes, and memory with it.
  await mounted("person", () => person.call("agents", "mount", memory));
  await person.call("agents", "remove", { agent });
  const { agents: left } = await person.call<{ agents: { agent: string }[] }>("agents", "list");
  assert.ok(!left.some((one) => one.agent === agent));
});

test("the person's get and the agent's capability_list give one tree of what the agent is made of: a capability, the child it mounted and the plugin it loaded, with what each added", async (t) => {
  const fake = await fakeOpenAI();
  const inputs: { type: string; call_id?: string; output?: string }[][] = [];
  const answers: object[][] = [];
  // A capability that loads a plugin, which gives the model a function, and mounts a child.
  function nestWatcher(ctx: Context) {
    ctx.tools.register({
      name: "look",
      description: "Look in the nest.",
      parameters: { type: "object" },
      run: async () => ({ output: "Empty.", ok: true }),
    });
  }
  const nest: AgentPlugin = {
    name: "nest",
    title: "Nest",
    inject: ["capabilities", "tools"],
    async apply(ctx: Context) {
      ctx.plugin(nestWatcher);
      await ctx.capabilities.mount({
        name: "nest-child",
        title: "Nest child",
        inject: [],
        apply() {},
      });
    },
  };
  const carried = [
    {
      plugin: nest,
      offer: {
        id: "nest",
        title: "Nest",
        description: "A nest, for a test.",
        arguments: { type: "object" as const, properties: {} },
      },
    },
  ];
  const s = await open(
    t,
    undefined,
    async (request) => {
      if (!request.url.endsWith("/responses")) return fake.handle(request);
      const body = (await request.clone().json()) as { input: (typeof inputs)[number] };
      inputs.push(body.input);
      fake.script({ events: [completed((answers.shift() ?? []) as never)] });
      return fake.handle(request);
    },
    { carried },
  );
  const { person, ran } = await s.start();
  const { agents: executor } = ran as NonNullable<typeof ran>;
  const { authorizeUrl } = await person.call<{ authorizeUrl: string }>("login", "start", {
    redirectUri: "http://127.0.0.1:4321/oauth/chatgpt",
  });
  await person.call("login", "complete", { callbackUrl: await fake.authorize(authorizeUrl) });
  const agent = await createAssistant(person, "Nester");
  // Control takes its unit's answers: at least a template its agents can be made from.
  for (const capability of ["control", "nest"]) {
    const made = await person.call<{ mounted?: string }>("agents", "mount", {
      agent,
      provider: executor,
      capability,
      arguments: capability === "control" ? { templates: ["assistant"] } : {},
    });
    assert.ok(made.mounted, capability);
  }
  const slot = await chatSlot(person, agent);
  await until(
    () =>
      person.call(slot, "list").then(
        () => true,
        () => false,
      ),
    "the chat to be exposed",
  );
  // The agent reads its own tree through its control.
  answers.push([
    { type: "function_call", call_id: "l1", name: "control__capability_list", arguments: "{}" },
  ]);
  await person.call(slot, "send", { text: "What are you made of?" });
  await until(
    () =>
      inputs.flat().some((item) => item.type === "function_call_output" && item.call_id === "l1"),
    "the agent to read its tree",
  );
  await until(
    async () => (await person.call<{ state: string }>(slot, "state")).state === "idle",
    "the turn to end",
  );
  const output = inputs
    .flat()
    .find((item) => item.type === "function_call_output" && item.call_id === "l1")?.output;
  type Part = { name: string; parent?: string; kind?: string; added?: { functions: string[] } };
  const byAgent = (JSON.parse(output ?? "{}") as { composition?: Part[] }).composition;
  const byPerson = (await person.call<{ composition?: Part[] }>("agents", "get", { agent }))
    .composition;
  // One tree, whoever reads it.
  assert.deepEqual(byAgent, byPerson);
  const parts = new Map((byPerson ?? []).map((one) => [one.name.replace(/-\d+$/, "-#"), one]));
  assert.deepEqual(
    [...parts.keys()].filter((name) => name.startsWith("nest") || name === "control"),
    ["control", "nest", "nest-watcher-#", "nest-child"],
  );
  assert.equal(parts.get("nest-watcher-#")?.kind, "plugin");
  assert.equal(parts.get("nest-watcher-#")?.parent, "nest");
  assert.equal(parts.get("nest-child")?.parent, "nest");
  assert.equal(parts.get("nest-child")?.kind, undefined);
  // What the plugin gave the model is its own, offered under its capability's name.
  assert.deepEqual(parts.get("nest-watcher-#")?.added?.functions, ["nest__look"]);
  assert.ok(parts.get("control")?.added?.functions.includes("control__capability_list"));
});

test("a computer mounted on agents@2 gives the agent and the person what the same answers give as a unit, through management: its capability's title, slots, surfaces and views, its skills, its connection and the same functions, and its terminal opens live; unmounted, all of it goes", async (t) => {
  const root = newFolder("agentorg-mount-");
  const data = join(root, "service");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const s = await open(t, {
    dataFolder: data,
    webUrl: "http://127.0.0.1:9/mcp",
    agentsFolder: join(root, "Agents"),
  });
  await startService(t, data);
  const { person, app } = await s.start();
  const answers = { workspace, access: "terminal", ...NEITHER };
  type Held = {
    id: string;
    from?: string;
    actor?: string;
    person?: { capability: string; operations: Record<string, string> };
  };
  type Got = {
    capabilities?: Held[];
    skills: { name: string }[];
    mcp: { slot: string; origin?: { kind?: string; target?: string } }[];
  };
  // As a unit, on agents@1.
  const [assistant] = (
    await person.call<{ creatables: { provider: string; id: string }[] }>("agents", "creatable")
  ).creatables;
  const units = (
    await person.call<{ units: { id: string; provider: string }[] }>("agents", "units")
  ).units;
  const computers = units.find((one) => one.id === "computer")?.provider;
  const byUnit = (
    await person.call<{ agent: string }>("agents", "create", {
      stack: {
        base: { provider: assistant?.provider, creatable: assistant?.id },
        units: [{ provider: computers, unit: "computer", values: answers }],
      },
      name: "By a unit",
    })
  ).agent;
  // The same answers, mounted on an agent made empty on agents@2.
  const byMount = (
    await person.call<{ agent: string }>("agents2", "create", { name: "By a mount" })
  ).agent;
  const offered = (
    await person.call<{ capabilities: { id: string; provider: string }[] }>(
      "agents2",
      "capabilities",
    )
  ).capabilities;
  const computer = offered.find((one) => one.id === "computer");
  assert.equal(computer?.provider, computers);
  const made = await person.call<{ mounted?: string }>("agents2", "mount", {
    agent: byMount,
    provider: computers,
    capability: "computer",
    arguments: answers,
  });
  assert.ok(made.mounted, JSON.stringify(made));
  const got = (agent: string) => person.call<Got>("agents2", "get", { agent });
  const [unitGot, mountGot] = [await got(byUnit), await got(byMount)];
  const held = (one: Got) => one.capabilities?.find(({ id }) => id === "computer");
  const own = (one: Held | undefined) => {
    const { from: _, actor: __, person: ___, ...rest } = one ?? { id: "" };
    return rest;
  };
  // The capability the page draws: the same title, slots, surfaces, views and fixed rows.
  assert.ok(held(unitGot));
  assert.deepEqual(own(held(mountGot)), own(held(unitGot)));
  // The same skills given to the agent, and the same connection, from the same provider.
  assert.deepEqual(
    mountGot.skills.map(({ name }) => name),
    unitGot.skills.map(({ name }) => name),
  );
  const connected = (one: Got) =>
    one.mcp.map(({ slot, origin }) => [slot, origin?.kind, origin?.target]);
  assert.deepEqual(connected(mountGot), connected(unitGot));
  // The same functions, listed through the person's own slot to each one's connection.
  const listed = async (one: Got) =>
    (
      await person.call<{ tools: unknown[] }>(
        held(one)?.person?.operations.computer as string,
        "list",
      )
    ).tools;
  assert.deepEqual(await listed(mountGot), await listed(unitGot));
  // Its terminal opens live, as the page opens it: by the agent and what its capability is from.
  const cli = readFileSync(join(s.home, "cli-token"), "utf8").trim();
  const socket = new WebSocket(
    `${app.url.replace("http", "ws")}/live?agent=${byMount}&instance=${held(mountGot)?.from}&surface=terminal&mode=watch`,
    { headers: { Authorization: `Bearer ${cli}` } },
  );
  const frames: string[] = [];
  socket.on("message", (data) => frames.push(String(data)));
  t.after(() => socket.close());
  await until(() => frames.length > 0, "the mounted computer's terminal to open");
  assert.deepEqual(JSON.parse(frames[0] as string), { op: "live", protocol: "terminal@1" });
  socket.close();
  // Unmounted, with no restart: its capability, its skills and its connection go.
  await person.call("agents2", "unmount", { agent: byMount, mounted: made.mounted });
  const after = await got(byMount);
  assert.equal(held(after), undefined);
  assert.deepEqual(after.skills, []);
  assert.deepEqual(after.mcp, []);
});
