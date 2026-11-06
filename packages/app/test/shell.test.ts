import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { accountLogin, hubGrants, kv } from "@agentorg/interfaces";
import { Refused } from "@agentorg/sdk";
import { buildPackage } from "@agentorg/sdk/build";
import { connect } from "@agentorg/sdk/client";
import { type Browser, chromium, type Page } from "@playwright/test";
import WebSocket from "ws";
import { type App, startApp } from "../src/index.ts";

// dist/test/shell.test.js → the package folder, and the repository root.
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures");
const root = join(fixtures, "..", "..", "..", "..");

let browser: Browser;
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
      if (reply.error) throw new Error(JSON.stringify(reply.error));
      return reply.result as T;
    },
  };
}

/** An app in a fresh home with the test packages added, and a signed-in tab. */
async function setup(t: test.TestContext) {
  const home = mkdtempSync(join(tmpdir(), "agentorg-shell-"));
  const app = await startApp({ home });
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
  const hashes = { assistant: await add("assistant"), board: await add("board") };
  const create = async (name: string, hash: string, start = true) => {
    const { actorId } = await person.call<{ actorId: string }>("actors", "create", {
      name,
      package: hash,
    });
    if (start) await person.call("actors", "start", { actorId });
    return actorId;
  };
  const page = await context.newPage();
  const logs: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  return { app, person, context, page, logs, hashes, create, add };
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
  const model = await connect({
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
    bind: bindIt,
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
  const { app, page, logs, hashes, create } = await setup(t);
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
  // Its log lines go to the console, named by the view.
  assert.ok(logs.some((line) => line.startsWith(`[${planner}.chat] mounted`)));
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
  await page.getByRole("cell", { name: "person.store" }).waitFor();
  assert.deepEqual(await rows.filter({ hasText: "person.store" }).locator("td").allInnerTexts(), [
    "person.store",
    "→",
    "storage.kv",
    "kv@1",
  ]);
});

test("New agent creates the assistant with the grants left on, starts it and opens it", async (t) => {
  const { app, page, person, add, create } = await setup(t);
  const chatgpt = await create("chatgpt", await add("chatgpt"));
  await signIn(page, app);
  await page.getByRole("button", { name: "New agent" }).click();
  const dialog = page.getByRole("dialog", { name: "New agent" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("Scout");
  assert.equal(await dialog.getByRole("switch", { name: "ChatGPT" }).isDisabled(), true);
  await dialog.getByRole("switch", { name: "create and run Actors" }).click();
  await dialog.getByRole("switch", { name: "install packages" }).click();
  await dialog.getByRole("button", { name: "Create" }).click();
  await page.waitForURL(/#\/a\//);
  const scout = decodeURIComponent(new URL(page.url()).hash.slice("#/a/".length));
  await page
    .frameLocator(".container.main iframe")
    .getByText(/^chat /)
    .waitFor();
  const actor = await person.call<{ name: string; state: string }>("actors", "get", {
    actorId: scout,
  });
  assert.deepEqual([actor.name, actor.state], ["Scout", "running"]);
  const { bindings } = await person.call<{
    bindings: { consumer: string; slot: string; provider: string; export: string }[];
  }>("bindings", "list", { actor: scout });
  assert.deepEqual(
    bindings
      .filter((binding) => binding.consumer === scout)
      .map((binding) => `${binding.slot} ${binding.provider}.${binding.export}`)
      .sort(),
    [
      "logic.exports hub.exports",
      "logic.grants hub.grants",
      "logic.layout person.layout",
      `logic.model ${chatgpt}.model.session`,
      "logic.store storage.kv",
    ],
  );
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
