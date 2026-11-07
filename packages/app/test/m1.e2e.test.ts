// Milestone 1, end to end: the experience as one run against the real app, with a scripted fake of
// OpenAI in place of the real one. An agent adds a widget, builds an Actor of its own, and the
// result is shared with another home.
//
// Some steps wait on the Workspace lane's first run (step 5, PR D): signing in with ChatGPT in the
// shell, New agent, the installer's bootstrap and the assistant's installer slot. Until then this
// test does those steps the way that code will, through the person's /api and the Hub, and the
// UI-only parts are listed as todo below.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { accountLogin, httpEgress, hubBindings, installer } from "@agentorg/interfaces";
import { buildPackage, writeTar } from "@agentorg/sdk/build";
import { connect } from "@agentorg/sdk/client";
import { type Browser, chromium, type Page } from "@playwright/test";
import WebSocket from "ws";
import { type App, startApp } from "../src/index.ts";

// dist/test/m1.e2e.test.js → this package's test sources, and the repository's packages.
const here = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test");
const packages = join(here, "..", "..");
const counterSource = join(here, "fixtures", "counter-widget");

/** The chatgpt package's fake of OpenAI, as its own tests use it (built with that package). */
interface FakeOpenAI {
  script(...next: { events: Record<string, unknown>[] }[]): void;
  authorize(authorizeUrl: string): Promise<string>;
  handle(request: Request): Promise<Response>;
}
type Fake = {
  fakeOpenAI(): Promise<FakeOpenAI>;
  completed(output: Record<string, unknown>[]): Record<string, unknown>;
  text(content: string): Record<string, unknown>;
};
const fake: Fake = await import(
  pathToFileURL(join(packages, "chatgpt", "dist", "test", "fake-openai.js")).href
);
/** One model turn that calls a tool, then the turn that answers after it. */
const callsTool = (name: string, args: unknown, then: string) => [
  {
    events: [
      fake.completed([
        { type: "function_call", call_id: `call_${name}`, name, arguments: JSON.stringify(args) },
      ]),
    ],
  },
  { events: [fake.completed([fake.text(then)])] },
];

let browser: Browser;
const out = mkdtempSync(join(tmpdir(), "agentorg-m1-"));
/** The packages, built once: the app's agent and model, the board, and the installer. */
const archives: Record<"assistant" | "chatgpt" | "board" | "installer", string> = {
  assistant: "",
  chatgpt: "",
  board: "",
  installer: "",
};
test.before(async () => {
  browser = await chromium.launch();
  for (const [name, path] of [
    ["assistant", join(packages, "assistant")],
    ["chatgpt", join(packages, "chatgpt")],
    ["board", join(packages, "..", "examples", "board")],
    ["installer", join(packages, "installer")],
  ] as const)
    archives[name] = (await buildPackage(path, { out: join(out, name) })).file;
});
test.after(async () => {
  await browser.close();
  rmSync(out, { recursive: true, force: true });
});

/** The person, through the CLI's way in. */
function personOf(app: App, token: string) {
  const socket = new WebSocket(`${app.url.replace("http", "ws")}/api`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const opened = new Promise((done) => socket.once("open", done));
  let id = 0;
  const waiting = new Map<number, (reply: { result?: unknown; error?: unknown }) => void>();
  socket.on("message", (data) => {
    const reply = JSON.parse(String(data));
    waiting.get(reply.id)?.(reply);
  });
  return {
    close: () => socket.close(),
    async call<T = Record<string, unknown>>(slot: string, method: string, input: unknown = {}) {
      await opened;
      const reply = await new Promise<{ result?: unknown; error?: unknown }>((done) => {
        waiting.set(++id, done);
        socket.send(JSON.stringify({ id, op: "call", slot, method, input }));
      });
      if (reply.error) throw new Error(JSON.stringify(reply.error));
      return reply.result as T;
    },
  };
}

/**
 * One home: the app in a fresh folder, its packages added, and the installer made as the first run
 * will make it (bound to the Hub's management, storage.admin and the person's layout). `manager`
 * calls the installer as the shell will, as a manager.
 */
async function home(t: test.TestContext, name: string) {
  const dir = mkdtempSync(join(tmpdir(), `agentorg-m1-${name}-`));
  const app = await startApp({ home: dir, firstRun: false });
  const person = personOf(app, readFileSync(join(dir, "cli-token"), "utf8").trim());
  const open: { close(): void }[] = [];
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  t.after(async () => {
    for (const client of open) client.close();
    await context.close();
    person.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const add = async (path: string) =>
    (await person.call<{ hash: string }>("packages", "add", { path })).hash;
  const hashes = {
    assistant: await add(archives.assistant),
    chatgpt: await add(archives.chatgpt),
    board: await add(archives.board),
    installer: await add(archives.installer),
  };
  const { actorId: installerId } = await person.call<{ actorId: string }>("actors", "create", {
    name: "installer",
    package: hashes.installer,
    bindings: [
      ...["packages", "actors", "grants", "exports", "bindings"].map((exported) => ({
        slot: `installer.${exported}`,
        provider: "hub",
        export: exported,
      })),
      { slot: "installer.storage", provider: "storage", export: "admin" },
      { slot: "installer.layout", provider: "person", export: "layout" },
    ],
  });
  await person.call("actors", "start", { actorId: installerId });
  await until(() => app.hub.connected(installerId));
  /** An external Actor, its slots bound as given, connected with what it declares. */
  const external = async (
    actorName: string,
    bindings: { slot: string; provider: string; export: string }[] = [],
  ) => {
    const made = await person.call<{ actorId: string; credential: string }>("actors", "create", {
      name: actorName,
      bindings,
    });
    return { hubUrl: app.hubUrl, actorId: made.actorId, credential: made.credential };
  };
  const manager = await connect({
    ...(await external("shell stand-in", [
      { slot: "installer", provider: installerId, export: "installer.installer" },
      { slot: "bindings", provider: "hub", export: "bindings" },
    ])),
    slots: { installer, bindings: hubBindings },
  });
  open.push(manager);
  await until(() => manager.slots.installer.bound);
  const page = await context.newPage();
  await page.goto(app.signInUrl());
  await page.waitForURL(`${app.url}/`);
  return { dir, app, person, hashes, manager, external, page, open };
}

async function until(condition: () => boolean, ms = 20_000) {
  for (let waited = 0; !condition(); waited += 20) {
    if (waited > ms) throw new Error("timed out waiting");
    await new Promise((done) => setTimeout(done, 20));
  }
}

/** Send the agent a message in its chat, in the frame on the agent's page. */
async function tell(page: Page, message: string) {
  const chat = page.frameLocator(".container.main iframe");
  await chat.getByRole("textbox", { name: "Message" }).fill(message);
  await chat.getByRole("button", { name: "Send" }).click();
}

test("milestone 1: an agent adds a widget, builds an Actor, and the system is shared", async (t) => {
  // 1. Install and run: the app on a fresh home.
  const a = await home(t, "a");
  const openai = await fake.fakeOpenAI();

  // 2. Sign in with ChatGPT. The model Actor reaches "OpenAI" only through its web slot, here
  // bound to the fake; it signs in through its own login, as the shell's /oauth/chatgpt will drive
  // it (todo below).
  const egressWho = await a.external("openai (fake)");
  const egress = await connect({
    ...egressWho,
    exports: { web: httpEgress },
    start(ctx) {
      ctx.exports.web.serve((request) => openai.handle(request));
    },
  });
  a.open.push(egress);
  const { actorId: chatgpt } = await a.person.call<{ actorId: string }>("actors", "create", {
    name: "ChatGPT",
    package: a.hashes.chatgpt,
    bindings: [
      { slot: "model.web", provider: egressWho.actorId, export: "web" },
      { slot: "model.store", provider: "storage", export: "kv" },
    ],
  });
  await a.person.call("actors", "start", { actorId: chatgpt });
  await until(() => a.app.hub.connected(chatgpt));
  const signer = await connect({
    ...(await a.external("sign-in stand-in", [
      { slot: "login", provider: chatgpt, export: "model.login" },
    ])),
    slots: { login: accountLogin },
  });
  a.open.push(signer);
  await until(() => signer.slots.login.bound);
  const { authorizeUrl } = await signer.slots.login.call.start({
    redirectUri: `${a.app.url}/oauth/chatgpt`,
  });
  await signer.slots.login.call.complete({ callbackUrl: await openai.authorize(authorizeUrl) });
  assert.equal((await signer.slots.login.call.status({})).state, "signed_in");

  // 3. Create an agent, with New agent's bindings, and open it: its chat.
  const { actorId: agent } = await a.person.call<{ actorId: string }>("actors", "create", {
    name: "Planner",
    package: a.hashes.assistant,
    bindings: [
      { slot: "logic.model", provider: chatgpt, export: "model.session" },
      { slot: "logic.store", provider: "storage", export: "kv" },
      { slot: "logic.layout", provider: "person", export: "layout" },
      { slot: "logic.packages", provider: "hub", export: "packages" },
      { slot: "logic.actors", provider: "hub", export: "actors" },
      { slot: "logic.grants", provider: "hub", export: "grants" },
      { slot: "logic.exports", provider: "hub", export: "exports" },
    ],
  });
  await a.person.call("actors", "start", { actorId: agent });
  await until(() => a.app.hub.connected(agent));
  const page = a.page;
  await page
    .getByRole("navigation", { name: "Agents" })
    .getByRole("button", { name: /Planner/ })
    .click();
  await page.waitForURL(`${a.app.url}/#/a/${agent}`);
  const chat = page.frameLocator(".container.main iframe");
  await chat.getByRole("textbox", { name: "Message" }).waitFor();

  // 4. The agent adds a widget: it places a running board's panel, which appears beside its chat.
  const { actorId: board } = await a.person.call<{ actorId: string }>("actors", "create", {
    name: "Board",
    package: a.hashes.board,
    bindings: [{ slot: "logic.store", provider: "storage", export: "kv" }],
  });
  await a.person.call("actors", "start", { actorId: board });
  await until(() => a.app.hub.connected(board));
  openai.script(
    ...callsTool(
      "layout__place",
      { actor: board, module: "panel", title: "Launch" },
      "The board is on your home.",
    ),
  );
  await tell(page, "Put the board on my home.");
  await chat.getByText("The board is on your home.").waitFor();
  const beside = page.getByRole("complementary", { name: "Placed beside this agent" });
  await beside
    .getByRole("region", { name: "Launch" })
    .frameLocator("iframe")
    .getByRole("textbox", { name: "New card" })
    .waitFor();

  // 5. The agent builds an Actor: a counter, from source it writes, through packages.build.
  const files = {
    "package.json": readFileSync(join(counterSource, "package.json"), "utf8"),
    ...Object.fromEntries(
      readdirSync(join(counterSource, "src")).map((file) => [
        `src/${file}`,
        readFileSync(join(counterSource, "src", file), "utf8"),
      ]),
    ),
  };
  openai.script(...callsTool("packages__build", { files }, "I built the counter."));
  await tell(page, "Make me a counter widget.");
  await chat.getByText("I built the counter.").waitFor();
  const counterPackage = (
    await a.person.call<{ packages: { hash: string; name: string }[] }>("packages", "list")
  ).packages.find((p) => p.name === "counter")?.hash as string;
  assert.ok(counterPackage, "the agent's build was added");
  // Planned and installed with its store on storage's kv. The assistant's installer slot comes
  // with the Workspace lane; until then the shell's stand-in installs what the agent built.
  const plan = await a.manager.slots.installer.call.plan({ package: counterPackage });
  assert.deepEqual(plan.slots, [
    { slot: "counter.store", interface: "kv@1", candidates: [{ actor: "storage", export: "kv" }] },
  ]);
  assert.deepEqual(plan.views, ["panel"]);
  const { actorId: counterId } = await a.manager.slots.installer.call.install({
    package: counterPackage,
    name: "Counter",
    connections: { "counter.store": { actor: "storage", export: "kv" } },
    start: true,
  });
  // Running once its process says hello. A view placed before that stays blank (its frame isn't
  // told when the provider connects: reported to the Human lane), so the test waits for it.
  await until(() => a.app.hub.connected(counterId));
  openai.script(
    ...callsTool(
      "layout__place",
      { actor: counterId, module: "panel", title: "Counter" },
      "Your counter is beside us.",
    ),
  );
  await tell(page, "Show it to me.");
  await chat.getByText("Your counter is beside us.").waitFor();
  const counterA = beside.getByRole("region", { name: "Counter" }).frameLocator("iframe");
  await counterA.getByText("Count: 0").waitFor();
  await counterA.getByRole("button", { name: "Add one" }).click();
  await counterA.getByText("Count: 1").waitFor();

  // 6. Share: the system as data, and its packages as files, made again in another home.
  const { composition, unresolved } = await a.manager.slots.installer.call.exportSystem({});
  assert.ok(composition.actors.Counter, "the counter is part of the system");
  assert.ok(
    unresolved.some((u) => u.what === "openai (fake)"),
    "the fake connects itself",
  );
  // Each package as its file: the gateway's download (step 7) isn't there yet, so the package as
  // A keeps it is archived here exactly as that download will serve it.
  const b = await home(t, "b");
  for (const actor of Object.values(composition.actors)) {
    const hash = actor.package.split("#")[1] as string;
    if (Object.values(b.hashes).includes(hash)) continue;
    const tree = join(a.dir, "packages", hash);
    const entries = new Map<string, Uint8Array>([
      ["agentorg.json", readFileSync(join(tree, "agentorg.json"))],
      ...readdirSync(join(tree, "dist")).map(
        (file) => [`dist/${file}`, readFileSync(join(tree, "dist", file))] as [string, Uint8Array],
      ),
    ]);
    const file = join(out, `${hash}.agentorg`);
    writeFileSync(file, writeTar(entries));
    await b.person.call("packages", "add", { path: file });
  }
  const imported = await b.manager.slots.installer.call.importSystem({ composition });
  const counterB = imported.created.Counter as string;
  assert.ok(counterB);
  // What needs a sign-in, or a program that connects itself, is listed, not guessed.
  assert.ok(imported.unresolved.some((u) => u.what === "ChatGPT" && /sign-in/.test(u.why)));
  // The counter works there: placed on B's home, a fresh store (stores aren't shared).
  await until(() => b.app.hub.connected(counterB));
  await b.page.reload();
  const counterOnB = b.page.getByRole("region", { name: "Counter" }).frameLocator("iframe");
  await counterOnB.getByText("Count: 0").waitFor();
  await counterOnB.getByRole("button", { name: "Add one" }).click();
  await counterOnB.getByText("Count: 1").waitFor();
});

// The steps that wait on the Workspace lane's first run (step 5, PR D), in the shell itself.
test.todo(
  "milestone 1: signing in with ChatGPT in the shell, through /oauth/chatgpt, then the plan notice",
);
test.todo("milestone 1: New agent in the shell creates the assistant, which opens as a chat");
test.todo("milestone 1: the agent installs what it built itself, through its installer slot");
test.todo(
  "milestone 1: a package downloaded from the shell (GET /packages/<hash>.agentorg) and uploaded",
);
