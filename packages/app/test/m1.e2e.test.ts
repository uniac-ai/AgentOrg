// Milestone 1, end to end: the experience as one run against the real app, with a scripted fake of
// OpenAI in place of the real one. The person signs in with ChatGPT and makes an agent in the
// shell; the agent adds a widget, builds an Actor of its own and installs it; and the system is
// shared with another home through Settings.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { httpEgress } from "@agentorg/interfaces";
import { buildPackage } from "@agentorg/sdk/build";
import { connect } from "@agentorg/sdk/client";
import { type Browser, type BrowserContext, chromium, type Page } from "@playwright/test";
import { completed, fakeOpenAI, text } from "chatgpt/fake-openai";
import WebSocket from "ws";
import { type App, firstRun, startApp } from "../src/index.ts";

// dist/test/m1.e2e.test.js → this package's test sources, and the repository's packages.
const here = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test");
const packages = join(here, "..", "..");
const counterSource = join(here, "fixtures", "counter-widget");

let browser: Browser | undefined;
const out = mkdtempSync(join(tmpdir(), "agentorg-m1-"));
/** The board, built once to be added in a home; the counter, built as the agent's build will be. */
const built = { board: "", counterHash: "" };
test.before(async () => {
  browser = await chromium.launch();
  built.board = (
    await buildPackage(join(packages, "..", "examples", "board"), { out: join(out, "board") })
  ).file;
  built.counterHash = (await buildPackage(counterSource, { out: join(out, "counter") })).hash;
});
test.after(async () => {
  try {
    await browser?.close();
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

/**
 * The person, through the CLI's way in. A refusal throws named and coded as /api says (the first
 * run waits out NotConnected); a socket that fails or closes fails what waits on it.
 */
function personOf(app: App, token: string) {
  const socket = new WebSocket(`${app.url.replace("http", "ws")}/api`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const waiting = new Map<number, { done(reply: Reply): void; failed(error: Error): void }>();
  type Reply = { result?: unknown; error?: { name?: string; code?: string } };
  let gone: Error | undefined;
  const fail = (error: Error) => {
    gone ??= error;
    for (const { failed } of waiting.values()) failed(gone);
    waiting.clear();
  };
  const opened = new Promise<void>((done, failed) => {
    socket.once("open", () => done());
    socket.once("error", failed);
  });
  // Reported by the call that waits on it (or by `gone`), never as an unhandled rejection.
  opened.catch(() => {});
  socket.on("error", fail);
  socket.on("close", () => fail(new Error("The /api socket closed.")));
  socket.on("message", (data) => {
    const reply = JSON.parse(String(data));
    waiting.get(reply.id)?.done(reply);
    waiting.delete(reply.id);
  });
  let id = 0;
  return {
    close: () => socket.close(),
    async call<T = Record<string, unknown>>(slot: string, method: string, input: unknown = {}) {
      await opened;
      if (gone) throw gone;
      const reply = await new Promise<Reply>((done, failed) => {
        waiting.set(++id, { done, failed });
        socket.send(JSON.stringify({ id, op: "call", slot, method, input }));
      });
      if (reply.error) {
        const { name, code } = reply.error;
        throw Object.assign(new Error(JSON.stringify(reply.error)), { name, code });
      }
      return reply.result as T;
    },
  };
}

/**
 * One home: the app in a fresh folder, and its first run, with "OpenAI" a fake behind a stand-in
 * for `net` (an Actor serving http.egress@1 in this process, which the model's `web` connects
 * to); ChatGPT's sign-in page approves at once. A signed-in tab on the shell.
 */
async function home(t: test.TestContext, name: string) {
  const dir = mkdtempSync(join(tmpdir(), `agentorg-m1-${name}-`));
  let app: App | undefined;
  let context: BrowserContext | undefined;
  const open: { close(): void }[] = [];
  t.after(async () => {
    try {
      for (const client of open) client.close();
      await context?.close();
    } finally {
      await app?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  app = await startApp({ home: dir, firstRun: false });
  const person = personOf(app, readFileSync(join(dir, "cli-token"), "utf8").trim());
  open.push(person);
  const openai = await fakeOpenAI();
  const made = await person.call<{ actorId: string; credential: string }>("actors", "create", {
    name: "openai (fake)",
  });
  const egress = await connect({
    hubUrl: app.hubUrl,
    actorId: made.actorId,
    credential: made.credential,
    exports: { web: httpEgress },
    start(ctx) {
      ctx.exports.web.serve((request) => openai.handle(request));
    },
  });
  open.push(egress);
  const { hub } = app;
  const ran = await firstRun(person, {
    egress: { actor: made.actorId, export: "web" },
    connected: (actorId) => hub.connected(actorId),
  });
  assert.ok(ran.installer && ran.chatgpt, "the first run made the installer and ChatGPT");
  // Started by the first run; its sign-in answers once its process has connected.
  const chatgpt = ran.chatgpt;
  await until(() => hub.connected(chatgpt));
  context = await browser?.newContext({ viewport: { width: 1400, height: 900 } });
  assert.ok(context);
  await context.route("https://auth.openai.com/**", async (route) =>
    route.fulfill({
      status: 302,
      headers: { location: await openai.authorize(route.request().url()) },
    }),
  );
  const page = await context.newPage();
  await page.goto(app.signInUrl());
  await page.waitForURL(`${app.url}/`);
  return { dir, app, person, openai, ran, context, page };
}

/**
 * Continue with ChatGPT in a home's shell: its page opens in a tab, approves, and sends the tab
 * back through /oauth/chatgpt; the shell then says the plan is in use.
 */
async function signInWithChatGPT({ context, page }: Awaited<ReturnType<typeof home>>) {
  const opened = context.waitForEvent("page");
  await page.getByRole("button", { name: "Continue with ChatGPT" }).click();
  const tab = await opened;
  await tab.getByText("Signed in to ChatGPT. You can close this tab.").waitFor();
  assert.equal(new URL(tab.url()).pathname, "/oauth/chatgpt");
  await tab.close();
  await page.getByRole("status").getByText("You're using your ChatGPT plan").waitFor();
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

/** The model's turns: each tool call by an id of its own, and the words that end the turn. */
let calls = 0;
const toolCall = (name: string, args: unknown) => {
  const id = `call_${++calls}`;
  return {
    id,
    turn: {
      events: [
        completed([{ type: "function_call", call_id: id, name, arguments: JSON.stringify(args) }]),
      ],
    },
  };
};
const says = (words: string) => ({ events: [completed([text(words)])] });

test("milestone 1: sign in, an agent adds a widget, builds an Actor, and the system is shared", async (t) => {
  // 1. Install and run: the app on a fresh home, through its first run.
  const a = await home(t, "a");
  const page = a.page;
  /**
   * The fake was asked exactly the scripted turns, and the request after each tool call carried
   * that call's output: what the tools answered, by call, parsed.
   */
  const answered = (before: number, ids: string[]) => {
    const asked = a.openai.requests.filter((r) => r.url.endsWith("/responses")).slice(before);
    assert.equal(asked.length, ids.length + 1, "every scripted turn was used");
    return ids.map((id, i) => {
      const { input } = JSON.parse(asked[i + 1]?.body ?? "{}") as {
        input?: { type: string; call_id?: string; output?: string }[];
      };
      const output = input?.find(
        (item) => item.type === "function_call_output" && item.call_id === id,
      )?.output;
      assert.ok(output !== undefined, `${id}'s output went back to the model`);
      return output;
    });
  };
  const responses = () => a.openai.requests.filter((r) => r.url.endsWith("/responses")).length;

  // 2. Sign in with ChatGPT in the shell: its page opens in a tab, approves, and sends the tab back
  // through /oauth/chatgpt; the shell then says the plan is in use.
  await signInWithChatGPT(a);

  // 3. Create an agent with New agent: it opens as its chat.
  await page.getByRole("button", { name: "New agent" }).click();
  const dialog = page.getByRole("dialog", { name: "New agent" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("Planner");
  await dialog.getByRole("button", { name: "Create" }).click();
  await page.waitForURL(/#\/a\//);
  const agent = decodeURIComponent(new URL(page.url()).hash.slice("#/a/".length));
  const chat = page.frameLocator(".container.main iframe");
  await chat.getByRole("textbox", { name: "Message" }).waitFor();
  // Its process takes the chat's messages once it has connected.
  await until(() => a.app.hub.connected(agent));

  // 4. The agent adds a widget: it places a running board's panel, which appears beside its chat.
  const board = (await a.person.call<{ hash: string }>("packages", "add", { path: built.board }))
    .hash;
  const { actorId: boardId } = await a.person.call<{ actorId: string }>("installer", "install", {
    package: board,
    name: "Board",
    connections: { "logic.store": { actor: "storage", export: "kv" } },
    start: true,
  });
  let before = responses();
  const placeBoard = toolCall("layout__place", {
    actor: boardId,
    module: "panel",
    title: "Launch",
  });
  a.openai.script(placeBoard.turn, says("The board is on your home."));
  await tell(page, "Put the board on my home.");
  await chat.getByText("The board is on your home.").waitFor();
  answered(before, [placeBoard.id]);
  const beside = page.getByRole("complementary", { name: "Placed beside this agent" });
  await beside
    .getByRole("region", { name: "Launch" })
    .frameLocator("iframe")
    .getByRole("textbox", { name: "New card" })
    .waitFor();

  // 5. The agent builds an Actor: a counter, from source it writes, through its packages slot;
  // plans it and installs it through its installer slot, its store on storage's kv; then places it.
  const files = {
    "package.json": readFileSync(join(counterSource, "package.json"), "utf8"),
    ...Object.fromEntries(
      readdirSync(join(counterSource, "src")).map((file) => [
        `src/${file}`,
        readFileSync(join(counterSource, "src", file), "utf8"),
      ]),
    ),
  };
  const counter = built.counterHash;
  const build = toolCall("packages__build", { files });
  const plan = toolCall("installer__plan", { package: counter });
  const install = toolCall("installer__install", {
    package: counter,
    name: "Counter",
    connections: { "counter.store": { actor: "storage", export: "kv" } },
    start: true,
  });
  before = responses();
  a.openai.script(build.turn, plan.turn, install.turn, says("The counter is installed."));
  await tell(page, "Make me a counter widget.");
  await chat.getByText("The counter is installed.").waitFor();
  const [buildOutput, planOutput] = answered(before, [build.id, plan.id, install.id]);
  // Its build is the one made here from the same source; the plan offered storage's kv.
  assert.equal((JSON.parse(buildOutput ?? "{}") as { hash?: string }).hash, counter);
  assert.deepEqual(
    (
      JSON.parse(planOutput ?? "{}") as {
        slots?: { slot: string; candidates: { actor: string; export: string }[] }[];
      }
    ).slots,
    [
      {
        slot: "counter.store",
        interface: "kv@1",
        candidates: [{ actor: "storage", export: "kv" }],
      },
    ],
  );
  const { actors } = await a.person.call<{
    actors: { actorId: string; name: string; package: string; state: string }[];
  }>("actors", "list");
  const counterActor = actors.find((actor) => actor.name === "Counter");
  assert.equal(counterActor?.package, counter);
  assert.equal(counterActor?.state, "running");
  const counterId = counterActor.actorId;
  before = responses();
  const placeCounter = toolCall("layout__place", {
    actor: counterId,
    module: "panel",
    title: "Counter",
  });
  a.openai.script(placeCounter.turn, says("Your counter is beside us."));
  await tell(page, "Show it to me.");
  await chat.getByText("Your counter is beside us.").waitFor();
  answered(before, [placeCounter.id]);
  const counterA = beside.getByRole("region", { name: "Counter" }).frameLocator("iframe");
  await counterA.getByText("Count: 0").waitFor();
  await counterA.getByRole("button", { name: "Add one" }).click();
  await counterA.getByText("Count: 1").waitFor();
  // The count is in its store, not its process: still 1 after the counter is stopped and started
  // again, and the page loaded again.
  await a.person.call("actors", "stop", { actorId: counterId });
  await a.person.call("actors", "start", { actorId: counterId });
  await page.reload();
  await beside
    .getByRole("region", { name: "Counter" })
    .frameLocator("iframe")
    .getByText("Count: 1")
    .waitFor();

  // 6. Share: the system exported from Settings as one file, with its packages, and imported in
  // another home's Settings. The counter works there, from a fresh store.
  await page.goto(`${a.app.url}/#/settings`);
  await page.getByRole("tab", { name: "System" }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export system" }).click(),
  ]);
  const file = join(out, "m1.agentorg-system");
  await download.saveAs(file);
  // What connects itself (the fake's stand-in for net) is left out, not guessed.
  await page
    .getByRole("region", { name: "Export" })
    .getByText("openai (fake)", { exact: true })
    .waitFor();

  const b = await home(t, "b");
  await signInWithChatGPT(b);
  await b.page.goto(`${b.app.url}/#/settings`);
  await b.page.getByRole("tab", { name: "System" }).click();
  await b.page.locator('input[aria-label="System file"]').setInputFiles(file);
  await b.page
    .getByRole("region", { name: "Import" })
    .getByText(/Made .*\bCounter\b/)
    .waitFor();
  await b.page.goto(`${b.app.url}/`);
  const counterOnB = b.page.getByRole("region", { name: "Counter" }).frameLocator("iframe");
  await counterOnB.getByText("Count: 0").waitFor();
  await counterOnB.getByRole("button", { name: "Add one" }).click();
  await counterOnB.getByText("Count: 1").waitFor();
});
