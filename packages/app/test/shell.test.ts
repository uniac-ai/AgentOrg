import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { accountLogin, httpEgress, hubGrants, kv } from "@agentorg/interfaces";
import { Refused } from "@agentorg/sdk";
import { buildPackage } from "@agentorg/sdk/build";
import { connect } from "@agentorg/sdk/client";
import { type Browser, chromium, type Page } from "@playwright/test";
import { completed, fakeOpenAI, text } from "chatgpt/fake-openai";
import WebSocket from "ws";
import { type App, firstRun, startApp } from "../src/index.ts";

// dist/test/shell.test.js → the package folder, and the repository root.
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures");
const root = join(fixtures, "..", "..", "..", "..");

let browser: Browser;
const until = async (condition: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((done) => setTimeout(done, 50));
  }
};
/** The test packages, built once. */
const out = mkdtempSync(join(tmpdir(), "agentorg-shell-pkg-"));
const built: Record<"assistant" | "board" | "chatgpt", string> = {
  assistant: "",
  board: "",
  chatgpt: "",
};
test.before(async () => {
  browser = await chromium.launch();
  for (const [name, path] of [
    ["assistant", join(fixtures, "assistant")],
    ["board", join(root, "examples", "board")],
    ["chatgpt", join(fixtures, "chatgpt")],
  ] as const)
    built[name] = (await buildPackage(path, { out: join(out, name) })).file;
});
test.after(async () => {
  await browser.close();
  rmSync(out, { recursive: true, force: true });
});

/** The person, through the CLI's way in: one call at a time is all a test needs. */
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
      if (reply.error) {
        // Named and coded as /api says, for the first run, which waits out NotConnected.
        const { name, code } = reply.error as { name?: string; code?: string };
        throw Object.assign(new Error(JSON.stringify(reply.error)), { name, code });
      }
      return reply.result as T;
    },
  };
}

/** An app in a fresh home with the test packages added (unless `bare`), and a signed-in tab. */
async function setup(t: test.TestContext, bare = false) {
  const home = mkdtempSync(join(tmpdir(), "agentorg-shell-"));
  const app = await startApp({ home, firstRun: false });
  const person = personOf(app, readFileSync(join(home, "cli-token"), "utf8").trim());
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  t.after(async () => {
    await context.close();
    person.close();
    await app.close();
    rmSync(home, { recursive: true, force: true });
  });
  const add = async (name: keyof typeof built) =>
    (await person.call<{ hash: string }>("packages", "add", { path: built[name] })).hash;
  const hashes = bare
    ? { assistant: "", board: "" }
    : { assistant: await add("assistant"), board: await add("board") };
  const create = async (name: string, hash: string, start = true) => {
    const { actorId } = await person.call<{ actorId: string }>("actors", "create", {
      name,
      package: hash,
    });
    if (start) await person.call("actors", "start", { actorId });
    return actorId;
  };
  const page = await context.newPage();
  return { app, person, context, page, hashes, create, add };
}

type LoginState = "signed_out" | "signed_in" | "ineligible";

/**
 * A stand-in for the model Actor's login, bound to the person's `login`: `state` says what status
 * answers, `tell` emits `changed`, and its logout is refused.
 */
async function standInLogin(
  t: test.TestContext,
  app: App,
  person: ReturnType<typeof personOf>,
  initial: LoginState,
  bind = true,
) {
  const made = await person.call<{ actorId: string; credential: string }>("actors", "create", {
    name: "chatgpt",
  });
  const login = { state: initial };
  const open = () =>
    connect({
      hubUrl: app.hubUrl,
      actorId: made.actorId,
      credential: made.credential,
      exports: { login: accountLogin },
      start(ctx) {
        ctx.exports.login.implement({
          status: () => ({
            state: login.state,
            ...(login.state === "signed_in" ? { account: { plan: "Plus" } } : {}),
          }),
          start: ({ redirectUri }) => ({
            authorizeUrl: `https://auth.example/?redirect=${encodeURIComponent(redirectUri)}`,
          }),
          complete: () => ({ account: {} }),
          logout: () => {
            throw new Refused("unavailable", "ChatGPT didn't answer.");
          },
        });
      },
    });
  let model = await open();
  t.after(() => model.close());
  const bindIt = () =>
    person.call("grants", "bind", {
      consumer: "person",
      slot: "login",
      provider: made.actorId,
      export: "login",
    });
  if (bind) await bindIt();
  return {
    login,
    id: made.actorId,
    bind: bindIt,
    /** Its channel dropped, as a process that went; `back` connects it again. */
    drop: () => model.close(),
    back: async () => {
      model = await open();
    },
    tell: (state: LoginState) => {
      login.state = state;
      model.exports.login.emit("changed", { state });
    },
  };
}

async function signIn(page: Page, app: App) {
  await page.goto(app.signInUrl());
  await page.waitForURL(`${app.url}/`);
}

/** Every box of these elements, to prove an interaction moved none of them. */
const boxes = (page: Page, selector: string) =>
  page.$$eval(selector, (elements) =>
    elements.map((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return [x, y, width, height].map(Math.round).join(" ");
    }),
  );
const LAID_OUT = ".sidebar, .row, .topbar, .stage, .container, .widgets, .placed, .request";

test("with no session, or a dead one, the shell says to run agentorg open", async (t) => {
  const { app, page } = await setup(t);
  await page.goto(`${app.url}/`);
  await page.getByText("Run agentorg open for a new sign-in link.").waitFor();
  // A session the gateway doesn't know: closed with 4401, and the same screen.
  await page.evaluate(() => localStorage.setItem("agentorg.session", "x".repeat(43)));
  await page.reload();
  await page.getByText("Run agentorg open for a new sign-in link.").waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem("agentorg.session")), null);
});

test("the sidebar lists the agents, and selecting one mounts its chat view in a sandboxed frame", async (t) => {
  const { app, page, person, hashes, create } = await setup(t);
  const planner = await create("Planner", hashes.assistant);
  await create("Research", hashes.assistant, false);
  await create("Board", hashes.board);
  await signIn(page, app);
  const agents = page.getByRole("navigation", { name: "Agents" }).locator("li");
  await assert.doesNotReject(() => agents.nth(1).waitFor());
  // Actors with a chat view only, in the list's order, each with its state.
  assert.deepEqual(await agents.allInnerTexts(), ["P\nPlanner", "R\nResearch"]);
  assert.equal(await agents.nth(0).getByRole("img").getAttribute("aria-label"), "running");
  assert.equal(await agents.nth(1).getByRole("img").getAttribute("aria-label"), "created");
  await agents.nth(0).getByRole("button").click();
  await page.waitForURL(`${app.url}/#/a/${planner}`);
  await page.getByRole("navigation", { name: "Path" }).getByText("Planner").waitFor();
  assert.equal(await page.getByRole("navigation", { name: "Path" }).textContent(), "Home/PPlanner");
  const frame = page.locator(".container.main iframe");
  assert.equal(await frame.getAttribute("sandbox"), "allow-scripts");
  assert.equal(await frame.getAttribute("src"), `/frames/${hashes.assistant}/chat.html`);
  // Loaded and mounted with the shell's theme and its frame's size; its unbound slot refuses.
  const body = page.frameLocator(".container.main iframe").locator("body");
  await body.getByText(/NotConnected/).waitFor();
  const box = await frame.boundingBox();
  assert.equal(
    await body.textContent(),
    `chat rgb(20 20 20) ${Math.round(box?.width ?? 0)}x${Math.round(box?.height ?? 0)} NotConnected`,
  );
  // The shell's font, from its theme, and its text color.
  const chatFrame = page.frames().find((f) => f.url().endsWith("/chat.html"));
  assert.match(
    String(await chatFrame?.evaluate(() => getComputedStyle(document.body).fontFamily)),
    /^ui-sans-serif, system-ui/,
  );
  assert.equal(
    await chatFrame?.evaluate(() => getComputedStyle(document.body).color),
    "rgb(250, 250, 250)",
  );
  // Its log lines go to its Actor's log, named by the module.
  const logged = async () =>
    (
      await person.call<{ lines: { message: string; module?: string; data?: unknown }[] }>(
        "actors",
        "logs",
        { actorId: planner },
      )
    ).lines.find((line) => line.message === "mounted");
  for (let i = 0; !(await logged()); i++) {
    assert.ok(i < 100, "the view's line is in its Actor's log");
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.deepEqual(await logged(), {
    ...(await logged()),
    module: "chat",
    data: { canvas: "rgb(20 20 20)" },
  });
  // Smaller: the view hears its new size.
  await page.setViewportSize({ width: 1000, height: 700 });
  await body.getByText(/ \d+x6\d\d /).waitFor();
});

test("placements appear on home as they're placed, move up, and go when removed", async (t) => {
  const { app, page, person, hashes, create } = await setup(t);
  const planner = await create("Planner", hashes.assistant);
  const board = await create("Board", hashes.board, false);
  await signIn(page, app);
  await page.getByText("Ask an agent to place something here.").waitFor();
  // Placed as the CLI does: on home at once, with no reload.
  const notes = await person.call<{ id: string }>("layout", "place", {
    actor: planner,
    module: "panel",
    title: "Notes",
  });
  await person.call("layout", "place", { actor: board, module: "panel", title: "Launch" });
  const placed = page.locator(".placed");
  await placed.nth(1).waitFor();
  // Each placement names its agent once the Actors are read, which may come after it shows.
  await placed.nth(1).getByText("· Board").waitFor();
  await placed.nth(0).getByText("· Planner").waitFor();
  assert.deepEqual(await placed.locator(".view-head").allInnerTexts(), [
    "Notes\n· Planner",
    "Launch\n· Board",
  ]);
  await page.frameLocator('[aria-label="Notes"] iframe').getByText("panel").waitFor();
  // Beside Planner's chat: its own view, not the board's.
  await page.getByRole("button", { name: "Planner" }).click();
  const beside = page.getByRole("complementary", { name: "Placed beside this agent" });
  await beside.getByRole("region", { name: "Notes" }).waitFor();
  assert.equal(await beside.locator("section").count(), 1);
  await page.getByRole("button", { name: "Home" }).click();
  // Move up, from the view's menu.
  await page.getByRole("button", { name: "Launch options" }).click();
  await page.getByRole("menuitem", { name: "Move up" }).click();
  await page.waitForFunction(() =>
    document.querySelector(".placed")?.getAttribute("aria-label")?.startsWith("Launch"),
  );
  const ids = async () =>
    (await person.call<{ home: { id: string }[] }>("layout", "get")).home.map((p) => p.id);
  assert.equal((await ids())[1], notes.id);
  // Remove: gone from home and from the layout.
  await page.getByRole("button", { name: "Notes options" }).click();
  // Its own agent's view: the menu opens that agent too.
  await page.getByRole("menuitem", { name: "Open Planner" }).waitFor();
  await page.getByRole("menuitem", { name: "Remove" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".placed").length === 1);
  assert.deepEqual(await ids(), [(await ids())[0]]);
  assert.ok(!(await ids()).includes(notes.id));
});

test("a placement names the agent that placed it, and moves up among those beside it", async (t) => {
  const { app, page, person, hashes, create } = await setup(t);
  const planner = await create("Planner", hashes.assistant);
  const research = await create("Research", hashes.assistant);
  const board = await create("Board", hashes.board, false);
  // As the layout keeps them: the board placed by Planner, then Research's, then Planner's own.
  await person.call("store", "set", {
    key: "layout",
    value: [
      { id: "launch", actor: board, module: "panel", title: "Launch", by: planner },
      { id: "other", actor: research, module: "panel", title: "Other" },
      { id: "notes", actor: planner, module: "panel", title: "Notes" },
    ],
  });
  await signIn(page, app);
  const launch = page.getByRole("region", { name: "Launch" });
  await launch.getByText("· Planner").waitFor();
  assert.equal(await launch.locator(".view-head").textContent(), "Launch· Planner");
  await page.getByRole("button", { name: "Launch options" }).click();
  await page.getByRole("menuitem", { name: "Open Planner" }).click();
  await page.waitForURL(`${app.url}/#/a/${planner}`);
  // Beside Planner: what it placed and its own, in the layout's order; Move up is among those.
  const beside = page.getByRole("complementary", { name: "Placed beside this agent" });
  await beside.getByRole("region", { name: "Notes" }).waitFor();
  assert.deepEqual(
    await beside.locator("section").evaluateAll((all) => all.map((e) => e.ariaLabel)),
    ["Launch", "Notes"],
  );
  await page.getByRole("button", { name: "Notes options" }).click();
  await page.getByRole("menuitem", { name: "Move up" }).click();
  await page.getByRole("menu").waitFor({ state: "detached" });
  const ids = async () =>
    (await person.call<{ home: { id: string }[] }>("layout", "get")).home.map((p) => p.id);
  assert.deepEqual(await ids(), ["notes", "launch", "other"]);
  await page.waitForFunction(
    () => document.querySelector(".widgets section")?.getAttribute("aria-label") === "Notes",
  );
});

test("grant requests wait on home, counted, until allowed or declined", async (t) => {
  const { app, page, person } = await setup(t);
  // A second program, which asks for two connections the person holds.
  const made = await person.call<{ actorId: string; credential: string }>("actors", "create", {
    name: "Asker",
  });
  const asker = await connect({
    hubUrl: app.hubUrl,
    actorId: made.actorId,
    credential: made.credential,
    slots: { notes: kv, cache: kv, grants: hubGrants },
  });
  t.after(() => asker.close());
  await person.call("grants", "bind", {
    consumer: made.actorId,
    slot: "grants",
    provider: "hub",
    export: "grants",
  });
  for (let i = 0; !asker.slots.grants.bound; i++) {
    assert.ok(i < 300, "the grants slot is bound");
    await new Promise((done) => setTimeout(done, 10));
  }
  const ask = async (slot: string) => {
    const { requestId } = (await asker.slots.grants.call.request({
      consumer: made.actorId,
      slot,
      provider: "storage",
      export: "kv",
      reason: `wants somewhere to keep ${slot}`,
    })) as { requestId: string };
    return requestId;
  };
  await signIn(page, app);
  await page.getByText("Ask an agent to place something here.").waitFor();
  await ask("notes");
  await ask("cache");
  const count = page.locator(".home-row .count");
  await page.waitForFunction(() => document.querySelector(".home-row .count")?.textContent === "2");
  const card = page.getByRole("group", { name: "Request from Asker" });
  await card.nth(1).getByText("cache → storage · kv@1").waitFor();
  assert.deepEqual(await card.locator(".what").allInnerTexts(), [
    "Asker wants somewhere to keep notes\nnotes → storage · kv@1",
    "Asker wants somewhere to keep cache\ncache → storage · kv@1",
  ]);
  await card.first().getByRole("button", { name: "Allow" }).click();
  await page.waitForFunction(() => document.querySelector(".home-row .count")?.textContent === "1");
  const { bindings } = await person.call<{ bindings: { slot: string }[] }>("bindings", "list", {
    actor: made.actorId,
  });
  assert.ok(bindings.some((binding) => binding.slot === "notes"));
  await card.first().getByRole("button", { name: "Decline" }).click();
  await card.first().waitFor({ state: "detached" });
  assert.equal(await count.isHidden(), true);
});

test("settings read the Actors, packages and connections through hub.*", async (t) => {
  const { app, page, hashes, create } = await setup(t);
  await create("Planner", hashes.assistant);
  await signIn(page, app);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.waitForURL(`${app.url}/#/settings`);
  // No model sign-in is bound: no account row.
  assert.equal(await page.locator(".account").count(), 0);
  const rows = page.locator("tbody tr");
  await page.getByRole("cell", { name: "Planner" }).waitFor();
  const planner = await rows.filter({ hasText: "Planner" }).locator("td").allInnerTexts();
  assert.deepEqual(planner, ["Planner", "assistant", "running", "0"]);
  assert.deepEqual(await rows.filter({ hasText: "hub" }).first().locator("td").allInnerTexts(), [
    "hub",
    "built in",
    "running",
    "–",
  ]);
  // The person is "you".
  assert.deepEqual(
    (
      await rows
        .filter({ has: page.getByRole("cell", { name: "you", exact: true }) })
        .locator("td")
        .allInnerTexts()
    ).slice(0, 2),
    ["you", "person"],
  );
  await page.getByRole("tab", { name: "Packages" }).click();
  await page.getByRole("cell", { name: "logic, chat, panel" }).waitFor();
  assert.equal(
    await page.getByRole("tab", { name: "Packages" }).getAttribute("aria-selected"),
    "true",
  );
  assert.equal(
    await rows.filter({ hasText: "assistant" }).locator("td").nth(2).textContent(),
    `${hashes.assistant.slice(0, 11)}…${hashes.assistant.slice(-4)}`,
  );
  await page.getByRole("tab", { name: "Connections" }).click();
  await page.getByRole("cell", { name: "you.actors" }).waitFor();
  assert.deepEqual(await rows.filter({ hasText: "you.actors" }).locator("td").allInnerTexts(), [
    "you.actors",
    "→",
    "hub.actors",
    "hub.actors@1",
  ]);
});

test("from the first run to a chat: sign in with ChatGPT, New agent, a turn", async (t) => {
  const { app, page, person, context } = await setup(t, true);
  // OpenAI is a fake behind a stand-in for net: an Actor serving http.egress@1 in this process.
  const fake = await fakeOpenAI();
  const made = await person.call<{ actorId: string; credential: string }>("actors", "create", {
    name: "egress",
  });
  const egress = await connect({
    hubUrl: app.hubUrl,
    actorId: made.actorId,
    credential: made.credential,
    exports: { egress: httpEgress },
    start(ctx) {
      ctx.exports.egress.serve((request) => fake.handle(request));
    },
  });
  t.after(() => egress.close());
  const ran = await firstRun(person, {
    egress: { actor: made.actorId, export: "egress" },
    connected: (id) => app.hub.connected(id),
  });
  const chatgpt = ran.chatgpt as string;
  await until(() => app.hub.connected(chatgpt));
  // ChatGPT's page approves at once and sends the browser back to the app.
  await context.route("https://auth.openai.com/**", async (route) =>
    route.fulfill({
      status: 302,
      headers: { location: await fake.authorize(route.request().url()) },
    }),
  );

  await signIn(page, app);
  const opened = context.waitForEvent("page");
  await page.getByRole("button", { name: "Continue with ChatGPT" }).click();
  const tab = await opened;
  await tab.getByText("Signed in to ChatGPT. You can close this tab.").waitFor();
  // Sent on to an address without the code.
  assert.equal(new URL(tab.url()).pathname, "/oauth/chatgpt");
  assert.equal(new URL(tab.url()).search, "?result=signed_in");
  await page.getByRole("status").getByText("You're using your ChatGPT plan").waitFor();

  await page.getByRole("button", { name: "New agent" }).click();
  const dialog = page.getByRole("dialog", { name: "New agent" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("Scout");
  // Installing creates and starts Actors: without that, it's off and can't be switched on.
  const actors = dialog.getByRole("switch", { name: "create and run Actors" });
  const install = dialog.getByRole("switch", { name: "install Actors" });
  await actors.click();
  assert.deepEqual(
    [await install.getAttribute("aria-checked"), await install.isDisabled()],
    ["false", true],
  );
  await actors.click();
  assert.deepEqual(
    [await install.getAttribute("aria-checked"), await install.isDisabled()],
    ["true", false],
  );
  await dialog.getByRole("switch", { name: "install packages" }).click();
  await dialog.getByRole("button", { name: "Create" }).click();
  await page.waitForURL(/#\/a\//);
  const scout = decodeURIComponent(new URL(page.url()).hash.slice("#/a/".length));
  const actor = await person.call<{ name: string; state: string }>("actors", "get", {
    actorId: scout,
  });
  assert.deepEqual([actor.name, actor.state], ["Scout", "running"]);
  const { bindings } = await person.call<{
    bindings: {
      consumer: string;
      slot: string;
      provider: string;
      export: string;
      madeBy: string;
    }[];
  }>("bindings", "list", { actor: scout });
  const own = bindings.filter((binding) => binding.consumer === scout);
  assert.deepEqual(
    own.map((binding) => `${binding.slot} ${binding.provider}.${binding.export}`).sort(),
    [
      `chat.chat ${scout}.logic.chat`,
      "logic.actors hub.actors",
      "logic.exports hub.exports",
      "logic.grants hub.grants",
      `logic.installer ${ran.installer}.installer.installer`,
      "logic.layout person.layout",
      `logic.model ${chatgpt}.model.session`,
      "logic.store storage.kv",
    ].sort(),
  );
  // Made by the installer, on the person's say; the package's own connection, by the Hub.
  assert.ok(own.every((b) => b.madeBy === (b.slot === "chat.chat" ? "hub" : ran.installer)));

  // A turn in the agent's chat, answered by the plan through the fake.
  fake.script({ events: [completed([text("Hello from the plan.")])] });
  const chat = page.frameLocator(".container.main iframe");
  // The view opened as the agent's process started; its frame follows the slot as it connects.
  await until(() => app.hub.connected(scout));
  await chat.getByRole("textbox", { name: "Message" }).fill("Hi.");
  await chat.getByRole("button", { name: "Send" }).click();
  await chat.getByText("Hello from the plan.").waitFor();
  const asked = fake.requests.filter((r) => r.url.endsWith("/responses"));
  assert.equal(asked.length, 1);
  assert.match(asked[0]?.body ?? "", /Hi\./);
  // Nothing the fake issued reaches the person's side: not the page, nor any Actor's log.
  const shown = (await page.content()) + (await tab.content()) + tab.url();
  const logs = await Promise.all(
    [chatgpt, scout, ran.installer as string].map((actorId) =>
      person.call("actors", "logs", { actorId, limit: 1000 }),
    ),
  );
  for (const secret of fake.secrets) {
    assert.ok(!shown.includes(secret));
    assert.ok(!JSON.stringify(logs).includes(secret));
  }
  // Without creating and running Actors, it can't install them either: neither is connected.
  await page.getByRole("button", { name: "New agent" }).click();
  await dialog.getByRole("textbox", { name: "Name" }).fill("Quiet");
  await dialog.getByRole("switch", { name: "create and run Actors" }).click();
  await dialog.getByRole("button", { name: "Create" }).click();
  await page.waitForURL((url) => url.hash.startsWith("#/a/") && !url.hash.endsWith(scout));
  const quiet = decodeURIComponent(new URL(page.url()).hash.slice("#/a/".length));
  const slots = (
    await person.call<{ bindings: { consumer: string; slot: string }[] }>("bindings", "list", {
      actor: quiet,
    })
  ).bindings
    .filter((binding) => binding.consumer === quiet)
    .map((binding) => binding.slot);
  assert.ok(slots.includes("logic.packages"));
  assert.ok(!slots.includes("logic.actors") && !slots.includes("logic.installer"));
});

test("ChatGPT's first run: sign-in opens in a new tab, and the plan notice shows once", async (t) => {
  const { app, page, person, context } = await setup(t);
  const model = await standInLogin(t, app, person, "signed_out");
  await context.route("https://auth.example/**", (route) => route.fulfill({ body: "consent" }));
  await signIn(page, app);
  const opened = context.waitForEvent("page");
  await page.getByRole("button", { name: "Continue with ChatGPT" }).click();
  const consent = await opened;
  assert.equal(
    consent.url(),
    `https://auth.example/?redirect=${encodeURIComponent(`${app.url}/oauth/chatgpt`)}`,
  );
  await page.getByText("Approve AgentOrg on ChatGPT's page, then come back here.").waitFor();
  // Signed in on ChatGPT's side: the shell moves on, and says once that the plan is in use.
  model.tell("signed_in");
  await page.getByRole("status").getByText("You're using your ChatGPT plan").waitFor();
  assert.deepEqual(await person.call("store", "get", { key: "ui/plan-notice" }), { value: true });
  await page.getByRole("button", { name: "Settings" }).click();
  assert.equal(await page.locator(".account").textContent(), "ChatGPT PlusSign out");
  // A sign-out that fails says so in place, and moves nothing.
  const account = await boxes(page, ".account, .account button");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.locator(".account").getByRole("alert").getByText("That didn't work.").waitFor();
  assert.deepEqual(await boxes(page, ".account, .account button"), account);
  await page.reload();
  await page.getByRole("button", { name: "Settings" }).waitFor();
  assert.equal(await page.getByText("You're using your ChatGPT plan").count(), 0);
});

test("ChatGPT's sign-in waits for its process, and the shell hears it again once it's back", async (t) => {
  const { app, page, person } = await setup(t);
  const model = await standInLogin(t, app, person, "signed_out");
  // The shell's socket, through the test, which can end a subscription as the gateway would.
  const subscribed: { sub: number; slot: string; event: string }[] = [];
  let toShell: ((message: string) => void) | undefined;
  await page.routeWebSocket(/\/api$/, (ws) => {
    const gateway = ws.connectToServer();
    ws.onMessage((message) => {
      const sent = JSON.parse(String(message));
      if (sent.op === "subscribe") subscribed.push(sent);
      gateway.send(message);
    });
    gateway.onMessage((message) => ws.send(message));
    toShell = (message) => ws.send(message);
  });
  await signIn(page, app);
  const button = page.getByRole("button", { name: "Continue with ChatGPT" });
  await page.getByText("Runs on your ChatGPT plan. Nothing is billed by us.").waitFor();
  assert.equal(await button.isEnabled(), true);
  const where = await boxes(page, "#signin button");

  // Its channel drops: the Hub tells `actors.changed`, and sign-in can't start until it's back.
  model.drop();
  await page.getByText("ChatGPT is starting…").waitFor();
  assert.equal(await button.isEnabled(), false);
  assert.deepEqual(await boxes(page, "#signin button"), where);
  await model.back();
  await page.getByText("Runs on your ChatGPT plan. Nothing is billed by us.").waitFor();
  assert.equal(await button.isEnabled(), true);

  // The gateway ends the shell's `login.changed` (as one refused output once ended every audit
  // subscription): it's made again after a wait, so a sign-in ChatGPT tells still moves it on.
  const logins = () => subscribed.filter((s) => s.slot === "login" && s.event === "changed");
  const ended = logins();
  assert.ok(ended.length > 0);
  for (const { sub } of ended) toShell?.(JSON.stringify({ sub, end: true }));
  for (let waited = 0; logins().length < ended.length * 2; waited += 50) {
    if (waited > 10_000) assert.fail("the ended subscriptions weren't made again");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  model.tell("signed_in");
  await page.getByRole("button", { name: "Settings" }).click();

  // External Actors, the person included, show whether they're connected, as it changes.
  const rows = page.locator("tbody tr");
  const stateOf = async (name: string) =>
    (
      await rows
        .filter({ has: page.getByRole("cell", { name, exact: true }) })
        .locator("td")
        .allInnerTexts()
    )[2];
  await page.getByRole("cell", { name: "chatgpt", exact: true }).waitFor();
  assert.equal(await stateOf("you"), "connected");
  assert.equal(await stateOf("chatgpt"), "connected");
  assert.equal(await stateOf("storage"), "running");
  model.drop();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("tbody tr")].some(
      (row) => row.textContent === "chatgptexternalnot connected–",
    ),
  );
});

test("a login bound after the shell loaded shows, and ineligible is past the first run", async (t) => {
  const { app, page, person } = await setup(t);
  const model = await standInLogin(t, app, person, "ineligible", false);
  await signIn(page, app);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Actors" }).waitFor();
  assert.equal(await page.locator(".account").count(), 0);
  // Bound now: read again, with no first run for an ineligible plan, and no Continue.
  await model.bind();
  await page.locator(".account").waitFor();
  assert.equal(
    await page.locator(".account").textContent(),
    "ChatGPT This ChatGPT plan isn't eligible.",
  );
  assert.equal(await page.getByRole("button", { name: "Continue with ChatGPT" }).count(), 0);
  await page.reload();
  await page.locator(".account").waitFor();
  assert.equal(await page.getByRole("button", { name: "Continue with ChatGPT" }).count(), 0);
});

test("opening a menu, the dialog and a theme switch move nothing", async (t) => {
  const { app, page, person, hashes, create } = await setup(t);
  const planner = await create("Planner", hashes.assistant);
  await person.call("layout", "place", { actor: planner, module: "panel", title: "Notes" });
  // New agent is offered for the assistant the first run recorded; this home had none.
  await person.call("store", "set", {
    key: "app/first-run",
    value: { assistant: hashes.assistant },
  });
  await signIn(page, app);
  await page.getByRole("button", { name: "Planner" }).click();
  // Everything read and mounted: what arrives moves nothing after this.
  const chat = page.frameLocator(".container.main iframe");
  await chat.getByText(/^chat rgb\(20 20 20\)/).waitFor();
  await page.frameLocator(".widgets iframe").getByText("panel").waitFor();
  await page.getByRole("button", { name: "New agent" }).waitFor();
  const before = await boxes(page, LAID_OUT);

  await page.getByRole("button", { name: "Notes options" }).click();
  await page.getByRole("menu").waitFor();
  assert.deepEqual(await boxes(page, LAID_OUT), before, "a menu");
  // Focus moving into a view's frame closes it, as a click elsewhere does.
  await chat.locator("body").click();
  await page.getByRole("menu").waitFor({ state: "detached" });

  await page.getByRole("button", { name: "New agent" }).click();
  await page.getByRole("dialog").waitFor();
  assert.deepEqual(await boxes(page, LAID_OUT), before, "the dialog");
  // This home's first run never ran: the dialog says so plainly, in room it kept for it.
  const dialog = page.getByRole("dialog", { name: "New agent" });
  const createButton = dialog.getByRole("button", { name: "Create" });
  const where = JSON.stringify([await dialog.boundingBox(), await createButton.boundingBox()]);
  await dialog.getByRole("textbox", { name: "Name" }).fill("Early");
  await createButton.click();
  await dialog
    .getByRole("alert")
    .getByText("AgentOrg isn't set up yet. Restart it to finish setting up.")
    .waitFor();
  assert.equal(
    JSON.stringify([await dialog.boundingBox(), await createButton.boundingBox()]),
    where,
    "a refusal",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });

  // A switch, and the view is mounted again with the light theme where it is.
  await page.getByRole("button", { name: "Color: dark" }).click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    "rgb(243, 243, 243)",
  );
  await chat.getByText(/^chat rgb\(243 243 243\)/).waitFor();
  assert.deepEqual(await boxes(page, LAID_OUT), before, "a theme switch");
  // Two quick switches: back where it was, mounted once more, not twice at once.
  await page.getByRole("button", { name: "Color: light" }).click();
  await page.getByRole("button", { name: "Color: dark" }).click();
  await page.getByRole("button", { name: "Color: light" }).click();
  await chat.getByText(/^chat rgb\(20 20 20\)/).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
});
