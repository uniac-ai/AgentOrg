#!/usr/bin/env node
// The conversation runner: plays the employee's conversation set (set.mjs) against the real app
// and the real model, and writes what it measured to a JSON file that compare.mjs sets beside
// another run. It never runs in CI: a run spends ChatGPT plan usage, and runs only when asked.
//
//   node scripts/conversations/run.mjs sign-in --dir DIR
//   node scripts/conversations/run.mjs run --dir DIR --out FILE [--core | --only 1,4,9]
//                                      [--max-requests N] [--dry] [--open]
//
// `--dir` is the runner's own folder: the app's home is DIR/home, the AgentComputer service's data
// DIR/computer, and nothing of the person's AgentOrg is used. `sign-in` opens a browser on the app
// for the person to sign in with ChatGPT once; it prints no link and no token. `run` then plays the
// set on agents made for it, each with a computer in a container, and removes them after.
//
// A run stops when it would pass `--max-requests` model requests, 150 at most, and prints at its end
// how many it made and how many tokens they took, and how many of the input tokens the provider
// read from its cache. Each conversation keeps the files its check read, as they were, so a check
// can be gone over after the computer is removed. `--dry` plays the set against a stand-in model
// that answers every message in one line, to check the runner itself: it makes no request to
// OpenAI, and needs no sign-in. It works in a folder of its own, never one a real sign-in is in.
//
// `--open` opens the app's page in the person's browser, signed in, once the app is up and before
// the first conversation, so the person can watch it played; the address carries a one-time code
// and is never printed. After the run it removes the computers but keeps the agents and their
// conversations, and the app, up for the person to look over, until the runner is stopped or the
// next run or sign-in in the folder ends it.
//
// The app is started on any free port, never 7731, and everything the runner starts it ends by the
// PID it recorded. It needs a build (`npm run build`) and Docker for the containers.
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Computer } from "@agentorg/computer-sdk";
import { OWN_FUNCTIONS } from "@agentorg/looper";
import WebSocket from "ws";
import { CHECKS, CORE, FIXTURE, GROUPS } from "./set.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CAP = 150;
/**
 * The functions of the looper's own, the front desk's and each worker's: how the agent speaks and
 * keeps its work, never a tool it uses, so never counted as one. Named here rather than read from
 * the looper, so runs of builds that offer different ones are counted alike. A run refuses to
 * start while the looper offers its workers one not named here; one only the front desk gains,
 * like `route`, is added by hand.
 */
const OWN = new Set(["send", "route", "hand_back", "status", "no_reply_needed"]);
const MARK = ".conversation-runner";
const API = "https://api.openai.com/v1";
/** The computer each agent gets: a new one, in a container, with commands and no browser. */
const COMPUTER = { kind: "new", made: "container", access: "terminal", browser: false };
const TURN_MS = 8 * 60_000;
const READY_MS = 15 * 60_000;

const { values: flags, positionals } = parseArgs({
  options: {
    dir: { type: "string" },
    out: { type: "string" },
    only: { type: "string" },
    core: { type: "boolean" },
    "max-requests": { type: "string" },
    dry: { type: "boolean" },
    open: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
});
const [command] = positionals;
const usage = (problem) => {
  if (problem) console.error(problem);
  console.error(
    "Usage: run.mjs sign-in --dir DIR\n       run.mjs run --dir DIR --out FILE [--core | --only 1,4,9] [--max-requests N] [--dry] [--open]",
  );
  process.exit(2);
};
if (flags.help) usage();
if (command !== "sign-in" && command !== "run") usage(`Unknown command ${command ?? "(none)"}.`);
if (!flags.dir) usage("--dir names the runner's own folder.");
const dir = resolve(flags.dir);
const cap = Math.min(CAP, Number(flags["max-requests"] ?? CAP));
if (!Number.isInteger(cap) || cap < 1) usage(`--max-requests takes a number from 1 to ${CAP}.`);
if (command === "run" && !flags.out) usage("--out names the file the run is written to.");
if (command === "sign-in" && flags.dry) usage("--dry needs no sign-in.");
if (command === "sign-in" && flags.open) usage("--open is for a run: sign-in opens its own page.");
// A function the built looper offers its workers that OWN doesn't name would count as a tool.
const unnamed = OWN_FUNCTIONS.filter((name) => !OWN.has(name));
if (command === "run" && unnamed.length > 0)
  usage(`The looper offers ${unnamed.join(", ")}, which OWN doesn't name: add it there first.`);

// --- The runner's folder: its own, never the person's AgentOrg --------------------------------

const under = (path, folder) => path === folder || path.startsWith(`${folder}${sep}`);
for (const theirs of [
  join(homedir(), ".agentorg"),
  join(homedir(), ".local", "share", "agentorg"),
  join(homedir(), "Library", "Application Support", "AgentOrg"),
  ...(process.env.XDG_DATA_HOME ? [join(process.env.XDG_DATA_HOME, "agentorg")] : []),
  ...(process.env.AGENTORG_HUB_HOME ? [resolve(process.env.AGENTORG_HUB_HOME)] : []),
])
  if (under(dir, theirs) || under(theirs, dir))
    usage(`${dir} holds or is inside ${theirs}: the runner keeps to a folder of its own.`);
if (existsSync(dir) && readdirSync(dir).length > 0 && !existsSync(join(dir, MARK)))
  usage(`${dir} isn't empty and isn't the runner's: give it a new folder.`);
mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(join(dir, MARK), "The conversation runner's folder.\n");
const home = join(dir, "home");
const data = join(dir, "computer");
const signInFile = join(home, "programs", "chatgpt", "sign-in.json");
for (const folder of [home, data, join(dir, "agents"), join(dir, "docker")])
  mkdirSync(folder, { recursive: true, mode: 0o700 });
const logFd = openSync(join(dir, "runner.log"), "a");
const note = (line) => writeFileSync(logFd, `${new Date().toISOString()} ${line}\n`);

/**
 * A runner an earlier run of this folder kept up for its page, ended by the PID it recorded once
 * its command line shows it is a runner, and waited for: this one takes the folder's app after it.
 */
async function endEarlierRunner() {
  const file = join(dir, "runner.pid");
  let pid;
  try {
    pid = Number(readFileSync(file, "utf8").trim());
  } catch {}
  if (pid && pid !== process.pid) {
    let command = "";
    try {
      command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    } catch {}
    if (command.includes(join("conversations", "run.mjs"))) {
      note(`Ending ${pid}, the runner an earlier run kept up`);
      process.kill(pid, "SIGTERM");
      for (let waited = 0; ; waited++) {
        try {
          process.kill(pid, 0);
        } catch {
          break;
        }
        if (waited === 120) usage(`The runner ${pid} kept up in ${dir} didn't end: end it first.`);
        await new Promise((done) => setTimeout(done, 500));
      }
    }
  }
  writeFileSync(file, `${process.pid}\n`);
}

/** A stand-in sign-in for `--dry`, refused where a real one is kept. */
const STAND_IN = "stand-in";
const heldClient = () =>
  existsSync(signInFile)
    ? JSON.parse(readFileSync(signInFile, "utf8")).credential?.clientId
    : undefined;
if (!flags.dry && heldClient() === STAND_IN)
  usage(`${dir} was used for --dry: give a real run a folder of its own.`);
function standInSignIn() {
  if (existsSync(signInFile)) {
    const held = JSON.parse(readFileSync(signInFile, "utf8")).credential;
    if (held?.clientId !== STAND_IN)
      usage(`${dir} holds a real sign-in: --dry runs in a folder of its own.`);
    return;
  }
  mkdirSync(dirname(signInFile), { recursive: true, mode: 0o700 });
  const credential = {
    clientId: STAND_IN,
    accessToken: STAND_IN,
    refreshToken: STAND_IN,
    expiresAt: Date.now() + 365 * 24 * 3600_000,
    scopes: ["openid"],
  };
  writeFileSync(signInFile, JSON.stringify({ credential }), { mode: 0o600 });
}

// --- What the runner starts, and ends by its PID -----------------------------------------------

/** What the runner started, by its child process: ended by that, never a PID that was reused. */
const started = new Set();
let app;
let person;
let service;
/** The one ending of what the runner started: whoever asks for it waits for the same one. */
let ended;
const AGENTCOMPUTER = join(
  root,
  "node_modules",
  "@agentorg",
  "computer",
  "dist",
  "agentcomputer.js",
);
const serviceEnv = () => ({
  ...process.env,
  DOCKER_CONFIG: join(dir, "docker"),
  AGENTCOMPUTER_DATA: data,
});
function end() {
  ended ??= ending();
  return ended;
}
async function ending() {
  try {
    if (readFileSync(join(dir, "runner.pid"), "utf8").trim() === String(process.pid))
      unlinkSync(join(dir, "runner.pid"));
  } catch {}
  try {
    await person?.close();
    await app?.close();
  } catch (error) {
    note(`Closing the app: ${error}`);
  }
  // Any computer an agent's removal left, killed while the service still answers.
  await killComputers("left behind");
  const running = () =>
    [...started].filter((child) => child.exitCode === null && child.signalCode === null);
  for (const child of running()) child.kill("SIGTERM");
  for (let waited = 0; waited < 20 && running().length > 0; waited++) await sleep(500);
  for (const child of running()) {
    note(`${child.pid} outlived its TERM; KILL`);
    child.kill("SIGKILL");
  }
}
/** Kill each computer the service still holds, while it answers: `why` is said in the log. */
async function killComputers(why) {
  if (!service) return;
  for (const { computerID } of await Computer.list(service).catch(() => [])) {
    note(`Killing a computer ${why}: ${computerID}`);
    try {
      execFileSync(process.execPath, [AGENTCOMPUTER, "kill", computerID, "--data", data], {
        env: serviceEnv(),
        stdio: ["ignore", logFd, logFd],
      });
    } catch {}
  }
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
// Ended by any of these, the runner ends what it started first; one more while it does changes
// nothing.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(signal, () => void end().then(() => process.exit(130)));

/**
 * A service an earlier run of this folder started and couldn't end, as when it was killed: ended
 * now, by the PID it recorded, once its command line shows it is that service.
 */
function endEarlier() {
  let pids = [];
  try {
    pids = readFileSync(join(dir, "pids"), "utf8").split("\n").filter(Boolean).map(Number);
  } catch {}
  for (const pid of pids) {
    let command = "";
    try {
      command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    } catch {}
    if (command.includes(AGENTCOMPUTER) && command.includes(data)) {
      note(`Ending ${pid}, a service an earlier run left`);
      process.kill(pid, "SIGTERM");
    }
  }
}

/** The AgentComputer service, in the runner's folder, on any free port: `{ apiUrl, apiKey }`. */
async function startService() {
  const record = join(data, "server.json");
  endEarlier();
  // A bare Docker config, so no credential helper is asked for anything. A process group of its
  // own, so a closed terminal ends it only through the runner, which stops its computers first.
  const child = spawn(
    process.execPath,
    [AGENTCOMPUTER, "serve", "--data", data, "--listen", "127.0.0.1:0"],
    {
      env: serviceEnv(),
      stdio: ["ignore", logFd, logFd],
      detached: true,
    },
  );
  started.add(child);
  writeFileSync(join(dir, "pids"), `${child.pid}\n`);
  for (let waited = 0; waited < 120; waited++) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("The AgentComputer service ended at its start: see runner.log.");
    try {
      const { url, pid } = JSON.parse(readFileSync(record, "utf8"));
      if (pid === child.pid) {
        await fetch(url);
        service = { apiUrl: url, apiKey: readFileSync(join(data, "control-token"), "utf8").trim() };
        return service;
      }
    } catch {}
    await sleep(500);
  }
  throw new Error("The AgentComputer service didn't answer within a minute.");
}

// --- The model's requests: counted, capped, and in `--dry` answered by a stand-in --------------

const spent = {
  total: 0,
  frontDesk: 0,
  /** The front desk's input tokens, which grow by the functions it is offered. */
  frontDeskInput: 0,
  /** Messages heard apart while the agent alone ran a call, and their input tokens. */
  hearing: 0,
  hearingInput: 0,
  input: 0,
  cached: 0,
  output: 0,
  reasoning: 0,
  models: new Set(),
};
const requests = [];
/** Woken as each response that called one of the agent's tools ends: see `firstTool`. */
const calledWaiters = new Set();
/** How a request to hear a message apart, while the agent alone runs a call, begins. */
const HEARING = "You are given the agent's work in a conversation";
/** What conversation 12 says to stop: a request whose input holds it has read the stop. */
const STOP = GROUPS.flatMap((group) => group.steps).find((step) => step.n === 12)?.say;
/** A message's text, as a request's input holds it. */
const textOf = (item) =>
  typeof item?.content === "string"
    ? item.content
    : (item?.content ?? []).map((part) => part.text ?? "").join("");
/** What the colleague is for, by which its requests are told apart from the agent's. */
const COLLEAGUE = "Asks the other agents what the person tells it to ask.";
/** Each agent's colleague, made for a step another agent says, by the agent it may reach. */
const colleagues = new Map();

/** Where an agent's own store keeps its keys, one file each. */
const storeOf = (agent) => join(home, "programs", "agents", "agents", agent, "kv");
/** The words of the agent's memory lines, as its memory keeps them. */
function memoryOf(agent) {
  try {
    const kept = JSON.parse(
      readFileSync(join(storeOf(agent), encodeURIComponent("plugin/memory/lines")), "utf8"),
    );
    return kept.lines.map((line) => line.text);
  } catch {
    return [];
  }
}
/**
 * Clear the agent's conversations and keep its memory, its plugins' other keys and its settings,
 * as when a conversation is shortened or replaced: run with the app stopped.
 */
function forgetConversations(agent) {
  const keep = [encodeURIComponent("plugin/"), encodeURIComponent("settings/")];
  for (const key of readdirSync(storeOf(agent)))
    if (!keep.some((prefix) => key.startsWith(prefix))) unlinkSync(join(storeOf(agent), key));
}

/**
 * An agent that may reach every other, to say a step from another agent: made once for the agent
 * measured, with no computer, and removed with it.
 */
async function colleagueOf(agent) {
  if (colleagues.has(agent)) return colleagues.get(agent);
  const { units, bases } = await person.call("agents", "units");
  const management = units.find((one) => one.id === "control")?.provider;
  const base = bases.find((one) => one.id === "assistant");
  const { agent: colleague } = await person.call("agents", "create", {
    stack: {
      base: { provider: base.provider, creatable: base.id },
      units: [
        {
          provider: management,
          unit: "control",
          values: { agents: "all", templates: ["assistant"] },
        },
      ],
    },
    name: "Colleague",
    purpose: COLLEAGUE,
  });
  colleagues.set(agent, colleague);
  return colleague;
}

let stoppedWhy;
/**
 * While held, no model request leaves, and none is counted: through `sign-in`, and in a run until
 * what an earlier, cut-off run left is removed, so its turns going on spend nothing.
 */
let holding = true;
const refusal = (code, message) =>
  new Response(JSON.stringify({ error: { code, message } }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
const t0 = performance.now();
const now = () => (performance.now() - t0) / 1000;

async function counting(request, init) {
  const req = request instanceof Request ? request : new Request(request, init);
  const url = new URL(req.url);
  const model = req.method === "POST" && `${url.origin}${url.pathname}` === `${API}/responses`;
  if (!model) return flags.dry ? standIn(req) : fetch(req);
  let body = {};
  try {
    body = await req.clone().json();
  } catch {}
  if (holding) return refusal("runner_hold", "The runner sends no model request now.");
  if (spent.total >= cap) {
    stoppedWhy ??= `The run reached its cap of ${cap} model requests.`;
    return refusal("runner_cap", "The runner's cap is reached.");
  }
  const frontDesk =
    typeof body.instructions === "string" && body.instructions.startsWith("You are the front desk");
  const hearing = typeof body.instructions === "string" && body.instructions.startsWith(HEARING);
  spent.total++;
  if (frontDesk) spent.frontDesk++;
  if (hearing) spent.hearing++;
  const input = Array.isArray(body.input) ? body.input : [];
  // The message the front desk answers: the last one said to it.
  const said = frontDesk ? input.findLast((item) => item.role === "user") : undefined;
  const record = {
    at: now(),
    frontDesk,
    hearing,
    // The agent's own, having read the stop: what it calls then is after it read it.
    readStop: !hearing && input.some((item) => item.role === "user" && textOf(item).endsWith(STOP)),
    colleague: typeof body.instructions === "string" && body.instructions.includes(COLLEAGUE),
    ...(said
      ? { message: textOf(said), offered: (body.tools ?? []).map((tool) => tool.name) }
      : {}),
    model: body.model,
    tools: [],
    input: 0,
    cached: 0,
    output: 0,
    reasoning: 0,
  };
  requests.push(record);
  const response = flags.dry ? standInResponse(body) : await fetch(req);
  if (!response.body) return response;
  const [mine, theirs] = response.body.tee();
  void readUsage(mine, record);
  return new Response(theirs, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** The tokens and the calls of a response, from its stream's `response.completed`. */
async function readUsage(stream, record) {
  let text = "";
  const decoder = new TextDecoder();
  try {
    for await (const piece of stream) {
      text += decoder.decode(piece, { stream: true });
      // When its first output came: the first item the model writes.
      if (record.first === undefined && text.includes('"response.output_item.added"'))
        record.first = now();
    }
  } catch {}
  for (const block of text.split(/\r?\n\r?\n/)) {
    const line = block.split(/\r?\n/).find((one) => one.startsWith("data: "));
    let event;
    try {
      event = JSON.parse(line?.slice(6) ?? "");
    } catch {
      continue;
    }
    if (event?.type !== "response.completed") continue;
    const usage = event.response?.usage ?? {};
    record.input = usage.input_tokens ?? 0;
    // Of the input, what the provider read from its cache: a prefix it had seen.
    record.cached = usage.input_tokens_details?.cached_tokens ?? 0;
    record.output = usage.output_tokens ?? 0;
    record.reasoning = usage.output_tokens_details?.reasoning_tokens ?? 0;
    record.tools = (event.response?.output ?? [])
      .filter((item) => item.type === "function_call")
      .map((item) => item.name);
    record.done = now();
    if (record.tools.some((name) => !OWN.has(name))) for (const wake of calledWaiters) wake();
    // What the front desk called beyond its own functions, with what it was given.
    if (record.hearing) spent.hearingInput += usage.input_tokens ?? 0;
    if (record.frontDesk) {
      spent.frontDeskInput += usage.input_tokens ?? 0;
      record.calls = (event.response?.output ?? [])
        .filter((item) => item.type === "function_call" && !OWN.has(item.name))
        .map((item) => ({ name: item.name, arguments: item.arguments }));
    }
    if (event.response?.model) spent.models.add(event.response.model);
    spent.input += record.input;
    spent.cached += record.cached;
    spent.output += record.output;
    spent.reasoning += record.reasoning;
  }
}

const json = (value, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
/** The stand-in's answer to anything but a model request: its one model, and nothing else. */
function standIn(req) {
  const url = new URL(req.url);
  if (req.method === "GET" && `${url.origin}${url.pathname}` === `${API}/models`)
    return json({ models: [{ slug: STAND_IN, display_name: "Stand-in", visibility: "list" }] });
  return json({ error: { message: "The stand-in answers only the model's requests." } }, 404);
}
/** The stand-in model: the front desk makes new work; a worker answers each open message once. */
function standInResponse(body) {
  const items = Array.isArray(body.input) ? body.input : [];
  const textOf = (item) =>
    typeof item.content === "string"
      ? item.content
      : (item.content ?? []).map((part) => part.text ?? "").join("");
  let call;
  if (String(body.instructions ?? "").startsWith("You are the front desk"))
    call = { name: "route", arguments: { title: "Stand-in work" } };
  else {
    const asked = items
      .filter((item) => item.role === "user")
      .flatMap((item) => /^\[(\d+)\]/.exec(textOf(item))?.[1] ?? [])
      .map(Number);
    const sent = items
      .filter((item) => item.type === "function_call" && item.name === "send")
      .map((item) => JSON.parse(item.arguments).message);
    const open = asked.find((n) => !sent.includes(n));
    if (open !== undefined)
      call = { name: "send", arguments: { message: open, text: `Stand-in reply to [${open}].` } };
  }
  const events = [];
  const output = [];
  if (call) {
    const item = {
      type: "function_call",
      id: `fc_${requests.length}`,
      call_id: `call_${requests.length}`,
      name: call.name,
    };
    const args = JSON.stringify(call.arguments);
    events.push({ type: "response.output_item.added", item: { ...item, arguments: "" } });
    events.push({ type: "response.function_call_arguments.delta", item_id: item.id, delta: args });
    output.push({ ...item, arguments: args });
  }
  events.push({
    type: "response.completed",
    response: {
      model: STAND_IN,
      output,
      usage: { input_tokens: Math.ceil(JSON.stringify(body).length / 4), output_tokens: 12 },
    },
  });
  const text = events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

// --- The app, and the person's side of it ------------------------------------------------------

async function startTheApp() {
  const { startApp } = await import(join(root, "packages", "app", "dist", "src", "gateway.js"));
  app = await startApp({
    home,
    port: 0,
    firstRun: {
      fetch: counting,
      log: note,
      assistant: false,
      // An empty path: the runner starts the service itself; no Mac's service is looked at. Its
      // agents each get a new computer, which the service it starts makes.
      computer: {
        dataFolder: data,
        agentsFolder: join(dir, "agents"),
        path: "",
        macRecord: null,
        makes: true,
        ...(flags.dry ? { webUrl: "http://127.0.0.1:9/mcp" } : {}),
      },
    },
  });
  await app.firstRun;
  person = await connect();
}

/** The person's socket on the app, as the CLI reaches it, by the token in the home. */
async function connect() {
  const token = readFileSync(join(home, "cli-token"), "utf8").trim();
  const ws = new WebSocket(`${app.url.replace(/^http/, "ws")}/api`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await new Promise((done, failed) => {
    ws.once("open", done);
    ws.once("error", failed);
  });
  let next = 1;
  const waiting = new Map();
  const subscriptions = new Map();
  let closed = false;
  const closing = new Promise((done) => ws.once("close", done));
  // A closed socket answers nothing more: what waits on it is refused.
  void closing.then(() => {
    closed = true;
    for (const { failed } of waiting.values()) failed(new Error("The app's socket closed."));
    waiting.clear();
  });
  ws.on("error", (error) => note(`The app's socket: ${error}`));
  ws.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.id !== undefined && waiting.has(message.id)) {
      const { done, failed } = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) failed(new Error(`${message.error.name}: ${message.error.message}`));
      else done(message.result);
    } else if (message.sub !== undefined && !message.end)
      subscriptions.get(message.sub)?.(message.payload);
  });
  return {
    call: (slot, method, input = {}) =>
      new Promise((done, failed) => {
        if (closed) return failed(new Error("The app's socket is closed."));
        const id = next++;
        const timer = setTimeout(() => {
          waiting.delete(id);
          failed(new Error(`${slot}.${method} had no answer in a minute.`));
        }, 60_000);
        waiting.set(id, {
          done: (value) => {
            clearTimeout(timer);
            done(value);
          },
          failed: (error) => {
            clearTimeout(timer);
            failed(error);
          },
        });
        ws.send(JSON.stringify({ id, op: "call", slot, method, input }));
      }),
    subscribe: (slot, event, fn) => {
      const sub = next++;
      subscriptions.set(sub, fn);
      ws.send(JSON.stringify({ sub, op: "subscribe", slot, event }));
    },
    close: () => {
      if (!closed) ws.close();
      return closing;
    },
  };
}

async function until(what, check, ms) {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (stoppedWhy) throw new Error(stoppedWhy);
    try {
      const found = await check();
      if (found) return found;
    } catch {}
    await sleep(500);
  }
  throw new Error(`${what} didn't happen in ${Math.round(ms / 1000)} s.`);
}

/**
 * The app's page in the person's browser, signed in. Never printed: its address carries a
 * one-time code.
 */
function openPage() {
  const child = spawn(process.platform === "darwin" ? "open" : "xdg-open", [app.signInUrl()], {
    stdio: "ignore",
    detached: true,
  });
  return new Promise((done) => {
    child.once("error", (error) => {
      note(`The page couldn't be opened: ${error.code}`);
      done(false);
    });
    child.once("spawn", () => {
      child.unref();
      done(true);
    });
  });
}
/** Whether this run's page was opened: only then is it kept up after the run. */
let opened = false;

// --- sign-in -----------------------------------------------------------------------------------

if (command === "sign-in") {
  await endEarlierRunner();
  await startTheApp();
  const { state } = await person.call("login", "status");
  if (state !== "signed_in") {
    await openPage();
    console.log("Sign in with ChatGPT on the page that opened. This waits for it.");
    await until(
      "The sign-in",
      async () => (await person.call("login", "status")).state === "signed_in",
      15 * 60_000,
    );
  }
  console.log("Signed in. The runner's home keeps it for its runs.");
  await end();
  process.exit(0);
}

// --- run ---------------------------------------------------------------------------------------

const only = flags.core ? CORE : flags.only ? flags.only.split(",").map(Number) : undefined;
// With a choice, a group plays up to the last step chosen, which needs those before it; those not
// chosen are played and not measured.
const groups = GROUPS.flatMap((group) => {
  if (!only) return [group];
  const last = group.steps.findLastIndex((step) => only.includes(step.n));
  if (last < 0) return [];
  return [
    {
      steps: group.steps
        .slice(0, last + 1)
        .map((step) => (only.includes(step.n) ? step : { ...step, measured: false })),
    },
  ];
});
if (flags.dry) standInSignIn();
const run = {
  startedAt: new Date().toISOString(),
  head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  version: JSON.parse(readFileSync(join(root, "packages", "app", "package.json"), "utf8")).version,
  dry: Boolean(flags.dry),
  cap,
  conversations: [],
};
let exitCode = 0;
await endEarlierRunner();
try {
  await startService();
  await startTheApp();
  if ((await person.call("login", "status")).state !== "signed_in")
    throw new Error("The runner's home isn't signed in with ChatGPT: run sign-in first.");
  // Agents a cut-off run left are removed before any request may leave.
  for (const { agent, name } of (await person.call("agents", "list")).agents) {
    note(`Removing ${name}, which an earlier run left`);
    await person.call("agents", "remove", { agent });
  }
  if (flags.open) {
    opened = await openPage();
    if (opened) console.log("Its page is open in the browser, signed in.");
  }
  holding = false;
  for (const [at, group] of groups.entries()) {
    if (stoppedWhy) break;
    run.conversations.push(...(await playGroup(group, at, service)));
  }
} catch (error) {
  exitCode = 1;
  run.error = error instanceof Error ? error.message : String(error);
} finally {
  // With its page open, the agents and the app stay up for the person to look over; only the
  // computers go.
  if (opened) await killComputers("after the run");
  else await end();
}
if (stoppedWhy) {
  run.stopped = stoppedWhy;
  exitCode = 3;
}
run.finishedAt = new Date().toISOString();
run.requests = { ...spent, models: [...spent.models] };
// Every function the front desk called beyond its own, with the message it answered.
run.frontDeskCalls = requests
  .filter((r) => r.frontDesk && r.calls?.length)
  .map(({ at, message, offered, calls }) => ({ at: round(at), message, offered, calls }));
writeFileSync(resolve(flags.out), `${JSON.stringify(run, null, 2)}\n`);
for (const c of run.conversations)
  console.log(
    `#${c.n}: right ${c.right === null ? "for a person" : c.right ? "yes" : "no"}, first seen ${c.seconds.firstSeen ?? "-"} s, final ${c.seconds.finalReply ?? "-"} s, ${c.words.total} words, ${c.requests.total} requests${c.timedOut ? ", timed out" : ""}`,
  );
if (run.error) console.error(run.error);
if (stoppedWhy) console.error(stoppedWhy);
console.log(
  `Model requests: ${spent.total} (front desk ${spent.frontDesk}, hearing ${spent.hearing}, ${spent.hearingInput} input tokens); input tokens ${spent.input}, ${spent.cached} of them cached; output tokens ${spent.output}, ${spent.reasoning} of them reasoning.`,
);
if (opened) {
  console.log(
    `The run is over (exit ${exitCode}). Its page stays up with its agents until the runner is stopped, or the next run in ${dir} starts.`,
  );
  await new Promise(() => {});
}
process.exit(exitCode);

/**
 * An agent measured: the Assistant's base, a computer, the web, and memory. Memory is on offer in
 * no template and no list of units, so this stack names management's Memory unit, as a test does,
 * finding management as the provider of its own Skill unit: a test's arrangement, not how a
 * person gets memory.
 */
async function measuredAgent(name) {
  const { units, bases } = await person.call("agents", "units");
  const by = (id) => units.find((one) => one.id === id)?.provider;
  const base = bases.find((one) => one.id === "assistant");
  const { agent } = await person.call("agents", "create", {
    stack: {
      base: { provider: base.provider, creatable: base.id },
      units: [
        { provider: by("computer"), unit: "computer", values: COMPUTER },
        { provider: by("web"), unit: "web", values: { service: "exa" } },
        { provider: by("skill"), unit: "memory" },
      ],
    },
    name,
  });
  return agent;
}

/** One group on an agent of its own: made, played, measured and removed. */
async function playGroup(group, at, service) {
  const name = `Runner ${at + 1}`;
  const agent = await measuredAgent(name);
  try {
    await until(
      `${name} running`,
      async () =>
        (await person.call("agents", "list")).agents.find((one) => one.agent === agent)?.status
          ?.state === "running",
      READY_MS,
    );
    const slot = await until(
      `${name}'s chat`,
      async () =>
        (await person.call("bindings", "list", { actor: "person" })).bindings.find(
          (b) => b.provider === agent && b.export === "chat",
        )?.slot,
      60_000,
    );
    const computer = await until(`${name}'s computer`, () => computerOf(agent, service), READY_MS);
    const folders = [...new Set(Object.keys(FIXTURE).map((path) => dirname(path)))];
    await computer.commands.run(`mkdir -p ${folders.join(" ")}`);
    for (const [path, text] of Object.entries(FIXTURE)) await computer.files.write(path, text);
    const files = {
      read: (path) => computer.files.read(path).catch(() => undefined),
      list: () => listAll(computer),
    };
    return await playSteps(group, at, slot, files, { agent, name });
  } finally {
    if (colleagues.has(agent))
      await person
        .call("agents", "remove", { agent: colleagues.get(agent) })
        .catch((error) => note(`Removing ${name}'s colleague: ${error}`));
    colleagues.delete(agent);
    // Kept with its page open, for the person to look over, but stopped, and its computer gone, so
    // nothing of it reaches the next group; the next run removes it.
    if (opened) {
      await person
        .call("agents", "stop", { agent })
        .catch((error) => note(`Stopping ${name}: ${error}`));
      await killComputers(`of ${name}`);
    } else
      await person
        .call("agents", "remove", { agent })
        .catch((error) => note(`Removing ${name}: ${error}`));
  }
}

/** The agent's computer, as the connector keeps it, reached with the service's control token. */
async function computerOf(agent, service) {
  const kept = JSON.parse(
    readFileSync(join(home, "programs", "computer", "instances.json"), "utf8"),
  );
  const { computer } = Object.values(kept).find((one) => one.agent === agent && one.computer) ?? {};
  if (!computer) return undefined;
  const reached = await Computer.connect(computer.id, { ...service, accessToken: computer.token });
  await reached.files.list();
  return reached;
}

/** Every file of the workspace with its size, to tell whether anything changed. */
async function listAll(computer, path = ".") {
  const found = [];
  for (const entry of await computer.files.list(path)) {
    const at = path === "." ? entry.name : `${path}/${entry.name}`;
    if (entry.type === "dir") found.push(...(await listAll(computer, at)));
    else found.push(`${at} ${entry.size}`);
  }
  return found.sort().join("\n");
}

/**
 * Each step sent when its `when` says, with the chat's events and the model's requests recorded
 * with their times. A measured step is read from its window, from its send to the idle before the
 * next step that waits for idle, or the group's last idle, and checked then.
 */
async function playSteps(group, at, slot, files, { agent, name }) {
  const events = [];
  const watch = () => {
    for (const event of ["message", "delta", "status", "progress"])
      person.subscribe(slot, event, (payload) => events.push({ at: now(), event, payload }));
  };
  watch();
  // The turn's end: the agent's latest status is idle, said after `since`, and still so 2 s later,
  // for a message or a turn that follows its idle. A message sent while it works makes no new
  // "working", so only the idle after it is looked for.
  const idleAfter = (since) =>
    until(
      "The turn's end",
      async () => {
        const latest = events.findLast((e) => e.event === "status");
        return latest?.payload.state === "idle" && latest.at >= since && now() - latest.at > 2
          ? latest.at
          : false;
      },
      TURN_MS,
    );
  /**
   * Once a response since `since` called one of the agent's tools: at once, as that response ends,
   * so what is said next comes while the call runs. Given up after a while.
   */
  const firstTool = (since) =>
    new Promise((resolve) => {
      const found = () =>
        requests.some((r) => r.at >= since && r.tools.some((name) => !OWN.has(name)));
      if (found()) return resolve(true);
      const done = () => {
        calledWaiters.delete(wake);
        clearTimeout(timer);
        resolve(true);
      };
      const wake = () => found() && done();
      const timer = setTimeout(done, flags.dry ? 5_000 : 90_000);
      calledWaiters.add(wake);
    });

  const sent = [];
  /** Each step's memory lines as it was sent. */
  const before = [];
  const measured = [];
  /** The steps sent and not yet measured, and whether the wait for their turn's end gave up. */
  let pending = [];
  let timedOut = false;
  /** For 12: when the stop was sent, and the workspace's files as they stood when it was said. */
  let stop;
  const measurePending = async (windowEnd) => {
    for (const i of pending) {
      const step = group.steps[i];
      if (step.measured === false || !CHECKS[step.n]) continue;
      measured.push(await measure(i, step, windowEnd));
    }
    pending = [];
    timedOut = false;
  };
  for (const [i, step] of group.steps.entries()) {
    const when = step.when ?? "idle";
    // Said once a call has begun: a moment after the response that made it, so it has started.
    if (i > 0 && when === "working") await firstTool(sent[i - 1]).then(() => sleep(200));
    else if (i > 0 && when === "soon") await sleep(1000);
    else if (i > 0) {
      await idleAfter(sent[i - 1]).catch(() => (timedOut = true));
      // The steps before this one are measured now, with the workspace as their turn left it.
      await measurePending(now());
    }
    // A stopped run sends nothing more.
    if (stoppedWhy) break;
    if (step.fresh) {
      await person.close();
      await app.close();
      app = undefined;
      forgetConversations(agent);
      await startTheApp();
      if (opened) opened = await openPage();
      watch();
      await until(
        `${name} back`,
        async () =>
          (await person.call("agents", "list")).agents.find((one) => one.agent === agent)?.status
            ?.state === "running",
        READY_MS,
      );
    }
    // For 12, what nothing may change after the stop: the files as they stand as it is said.
    const standing = step.n === 12 ? await files.list().catch(() => "") : undefined;
    sent[i] = now();
    // Its memory as the step is sent, which a check may need to have held what it asks of.
    before[i] = memoryOf(agent);
    pending.push(i);
    if (step.from === "agent") {
      const colleague = await colleagueOf(agent);
      const theirs = await until(
        "The colleague's chat",
        async () =>
          (await person.call("bindings", "list", { actor: "person" })).bindings.find(
            (b) => b.provider === colleague && b.export === "chat",
          )?.slot,
        60_000,
      );
      sent[i] = now();
      await person.call(theirs, "send", { text: step.say.replaceAll("{name}", name) });
      // The colleague's turn, and this agent's answer to it, end before it is measured.
      await sleep(5_000);
      await until(
        "Both turns' end",
        async () =>
          (await person.call(theirs, "state")).state === "idle" &&
          (await person.call(slot, "state")).state === "idle",
        TURN_MS,
      ).catch(() => (timedOut = true));
      step.answered = async () =>
        (await person.call(slot, "history", { with: colleague })).messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.text);
    } else await person.call(slot, "send", { text: step.say });
    if (step.n === 12) stop = { at: sent[i], files: standing };
    if (step.restart) {
      await firstTool(sent[i]);
      await person.close();
      await app.close();
      app = undefined;
      await startTheApp();
      // Its page went with the app it had: opened again on the app that came back.
      if (opened) opened = await openPage();
      watch();
    }
  }
  // A last step said by another agent was waited for already: this agent may take no turn of
  // the person's after it.
  const last =
    group.steps.at(-1)?.from === "agent"
      ? now()
      : await idleAfter(sent.at(-1) ?? now()).catch(() => {
          timedOut = true;
          return now();
        });
  if (stop) {
    await sleep(15_000);
    stop.changed = stop.files !== (await files.list().catch(() => ""));
  }
  await measurePending(last + 3);
  return measured;

  /** One step, read from its window: from its send to `windowEnd`. */
  async function measure(i, step, windowEnd) {
    const inWindow = (e) => e.at >= sent[i] && e.at < windowEnd;
    const asked = sent.filter((at) => at >= sent[i] && at < windowEnd).length;
    const mine = events.filter(inWindow);
    const replies = mine.filter((e) => e.event === "message" && e.payload.role === "assistant");
    const shown = mine.find(
      (e) =>
        (e.event === "delta" && e.payload.text) ||
        (e.event === "message" && e.payload.role === "assistant"),
    );
    const idle = mine.findLast((e) => e.event === "status" && e.payload.state === "idle");
    // A message closed with no reply: when that, with its reaction, was shown.
    const closed = mine.find((e) => e.event === "progress" && e.payload.state === "closed");
    // This agent's: the colleague's requests, in the same window, are its own.
    const theirs = requests.filter((r) => r.at >= sent[i] && r.at < windowEnd && !r.colleague);
    // Said by another agent, it is what this agent answered that agent.
    const texts = step.answered ? await step.answered() : replies.map((e) => e.payload.text);
    const words = texts.map((text) => text.split(/\s+/).filter(Boolean).length);
    const all = texts.join("\n\n");
    // Stopped: the agent was idle within 30 s of being asked to stop.
    const idleAfterStop =
      stop &&
      events.find((e) => e.event === "status" && e.payload.state === "idle" && e.at >= stop.at);
    const c = {
      replies: texts,
      text: all,
      words: words.reduce((a, b) => a + b, 0),
      lastWords: words.at(-1) ?? 0,
      questions: (all.match(/\?/g) ?? []).length,
      // Replies that carry a decision card: a card asks as a question mark does.
      cards: replies.filter((e) => e.payload.ask).length,
      headings: (all.match(/^#{1,6}\s/gm) ?? []).length,
      lists: (all.match(/^\s*([-*]|\d+\.)\s/gm) ?? []).length,
      bold: (all.match(/\*\*[^*]+\*\*/g) ?? []).length,
      tools: theirs.flatMap((r) => r.tools).filter((name) => !OWN.has(name)),
      firstSeen: shown ? round(shown.at - sent[i]) : undefined,
      // Up to its last reply: a request after it, which calls nothing, adds no wait.
      requests: {
        total: theirs.length,
        toReply: replies.length
          ? theirs.filter((r) => r.at <= replies.at(-1).at).length
          : theirs.length,
      },
      unanswered: Math.max(0, asked - replies.length),
      stopped:
        step.n === 12 ? Boolean(idleAfterStop && idleAfterStop.at - stop.at <= 30) : undefined,
      changedAfterStop: step.n === 12 ? stop?.changed : undefined,
      // For 12: whether the stop was said while a call of the agent's ran, as its latest request
      // before the stop had called a tool, and it was asked nothing more until after.
      stopWhileCalling:
        step.n === 12
          ? (() => {
              const latest = requests
                .filter((r) => !r.colleague && !r.hearing && r.at <= stop.at)
                .at(-1);
              return Boolean(
                latest?.done !== undefined &&
                  latest.done <= stop.at &&
                  latest.tools.some((name) => !OWN.has(name)),
              );
            })()
          : undefined,
      // For 12: what the agent called of its tools once it had read the stop.
      callsAfterStop:
        step.n === 12
          ? theirs
              .filter((r) => r.readStop)
              .flatMap((r) => r.tools)
              .filter((name) => !OWN.has(name))
          : undefined,
      memory: memoryOf(agent),
      memoryBefore: before[i] ?? [],
    };
    // What the check reads is kept with the conversation, as it was read.
    const read = {};
    const judged = {
      ...files,
      read: async (path) => {
        const text = await files.read(path);
        read[path] = text ?? null;
        return text;
      },
    };
    const checked = await CHECKS[step.n](c, judged).catch((error) => ({
      right: false,
      notes: { error: String(error) },
    }));
    return {
      n: step.n,
      group: at + 1,
      said: step.say,
      seconds: {
        firstSeen: c.firstSeen,
        finalReply: replies.length ? round(replies.at(-1).at - sent[i]) : undefined,
        idle: idle ? round(idle.at - sent[i]) : undefined,
        ...(closed ? { closed: round(closed.at - sent[i]) } : {}),
      },
      replies: texts.map((text, k) => ({
        text,
        words: words[k],
        // The decision card under it, if it carries one.
        ...(replies[k]?.payload.ask ? { ask: replies[k].payload.ask } : {}),
      })),
      // The emoji a message was closed with, each time one was.
      reactions: mine.flatMap((e) =>
        e.event === "progress" && e.payload.reaction ? [e.payload.reaction] : [],
      ),
      words: { total: c.words, longest: Math.max(0, ...words) },
      form: {
        headings: c.headings,
        lists: c.lists,
        questions: c.questions,
        bold: c.bold,
        message: c.headings === 0 && c.lists === 0 && c.questions <= 1 && c.bold === 0,
      },
      requests: {
        total: theirs.length,
        toReply: c.requests.toReply,
        frontDesk: theirs.filter((r) => r.frontDesk).length,
        hearing: theirs.filter((r) => r.hearing).length,
        worker: theirs.filter((r) => !r.frontDesk && !r.hearing).length,
        input: theirs.reduce((a, r) => a + r.input, 0),
        cached: theirs.reduce((a, r) => a + r.cached, 0),
        output: theirs.reduce((a, r) => a + r.output, 0),
        reasoning: theirs.reduce((a, r) => a + r.reasoning, 0),
        // Each request, from the step's send: when it started, when its first output came and
        // when it ended, what it read and what it called.
        each: [
          ...theirs,
          // Said by another agent, that agent's requests too: what it called, as it asked.
          ...(step.from === "agent"
            ? requests.filter((r) => r.at >= sent[i] && r.at < windowEnd && r.colleague)
            : []),
        ]
          .sort((a, b) => a.at - b.at)
          .map((r) => ({
            kind: r.colleague
              ? "colleague"
              : r.hearing
                ? "hearing"
                : r.frontDesk
                  ? "front desk"
                  : "agent",
            at: hundredths(r.at - sent[i]),
            ...(r.first === undefined ? {} : { first: hundredths(r.first - sent[i]) }),
            ...(r.done === undefined ? {} : { done: hundredths(r.done - sent[i]) }),
            input: r.input,
            cached: r.cached,
            output: r.output,
            tools: r.tools,
          })),
      },
      tools: c.tools,
      ...(c.callsAfterStop ? { callsAfterStop: c.callsAfterStop } : {}),
      ...(c.stopWhileCalling === undefined ? {} : { stopWhileCalling: c.stopWhileCalling }),
      // The agent's memory lines after its turn, as its store keeps them.
      memory: c.memory,
      right: checked.right,
      notes: checked.notes,
      ...(Object.keys(read).length ? { files: read } : {}),
      ...(timedOut ? { timedOut: true } : {}),
    };
  }
}

function hundredths(seconds) {
  return Math.round(seconds * 100) / 100;
}

function round(seconds) {
  return Math.round(seconds * 10) / 10;
}
