// The assistant's real chat view in a real sandboxed frame, over a scripted chat@1: what only a
// browser shows (a frame without allow-forms, the order of a slow send, a provider arriving late).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildPackage } from "@agentorg/sdk/build";
import { type Browser, chromium, type FrameLocator, type Page } from "@playwright/test";
import WebSocket from "ws";
import { type App, startApp } from "../src/index.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures");

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

let browser: Browser;
let app: App;
let person: ReturnType<typeof personOf>;
let hash: string;
let dir: string;

test.before(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-chat-frame-")));
  const home = join(dir, "home");
  app = await startApp({ home, firstRun: false });
  person = personOf(app, readFileSync(join(home, "cli-token"), "utf8").trim());
  browser = await chromium.launch();
  const built = await buildPackage(join(fixtures, "chat-view"), { out: join(dir, "out") });
  ({ hash } = await person.call<{ hash: string }>("packages", "add", { path: built.file }));
});
test.after(async () => {
  await browser.close();
  person.close();
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const create = async (name: string) =>
  (await person.call<{ actorId: string }>("actors", "create", { name, package: hash })).actorId;

const connected = async (actorId: string) => {
  for (let waited = 0; ; waited += 25) {
    const actor = await person.call<{ connected?: boolean }>("actors", "get", { actorId });
    if (actor.connected) return;
    assert.ok(waited < 20_000, "its process never connected");
    await new Promise((done) => setTimeout(done, 25));
  }
};

/** A signed-in page on the agent's chat; the agent is started first unless told otherwise. */
async function open(
  name: string,
  start = true,
): Promise<{
  page: Page;
  actorId: string;
  chat: FrameLocator;
  close(): Promise<void>;
}> {
  const actorId = await create(name);
  if (start) {
    await person.call("actors", "start", { actorId });
    // `start` returns before the process has said hello: a send until then is refused.
    await connected(actorId);
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(app.signInUrl());
  await page.waitForURL(`${app.url}/`);
  await page.goto(`${app.url}/#/a/${encodeURIComponent(actorId)}`);
  const chat = page.frameLocator(".container.main iframe");
  await chat.getByRole("textbox", { name: "Message" }).waitFor();
  return { page, actorId, chat, close: () => page.close() };
}

const users = (chat: FrameLocator) => chat.locator(".kit-chat-user");

test("Enter sends in a real frame, Shift+Enter doesn't, and the box empties", async () => {
  const { chat, close } = await open("Enter");
  const input = chat.getByRole("textbox", { name: "Message" });
  await input.fill("first line");
  await input.press("Shift+Enter");
  await input.pressSequentially("second line");
  assert.equal(await users(chat).count(), 0, "Shift+Enter sends nothing");
  assert.equal(await input.inputValue(), "first line\nsecond line");
  await input.press("Enter");
  await chat.getByText("Echo: first line").waitFor();
  assert.equal(await input.inputValue(), "");
  assert.equal(await users(chat).count(), 1);
  await close();
});

test("a sent message shows at once, once, and in the same place when the record has it", async () => {
  const { chat, close } = await open("Quick");
  const input = chat.getByRole("textbox", { name: "Message" });
  await input.fill("slow to record");
  await input.press("Enter");
  // The logic takes a second to record it; the person's text is there before its reply.
  await users(chat).getByText("slow to record").waitFor();
  assert.equal(await chat.getByText("Echo: slow to record").count(), 0);
  const before = await users(chat).boundingBox();
  await chat.getByText("Echo: slow to record").waitFor();
  assert.equal(await users(chat).count(), 1, "never twice");
  assert.deepEqual(await users(chat).boundingBox(), before, "it doesn't move when it's recorded");
  await close();
});

test("a refused send goes from the conversation, and its text is back in the box", async () => {
  const { chat, close } = await open("Refused");
  const input = chat.getByRole("textbox", { name: "Message" });
  await input.fill("refuse this");
  await input.press("Enter");
  await chat.getByRole("alert").getByText("A turn is running.").waitFor();
  assert.equal(await users(chat).count(), 0);
  assert.equal(await input.inputValue(), "refuse this");
  await close();
});

test("the conversation starts clear of the top edge", async () => {
  const { chat, close } = await open("Room");
  const input = chat.getByRole("textbox", { name: "Message" });
  await input.fill("hello");
  await input.press("Enter");
  await chat.getByText("Echo: hello").waitFor();
  const viewport = await chat.locator(".kit-chat-viewport").boundingBox();
  const first = await users(chat).boundingBox();
  assert.ok(viewport && first);
  assert.ok(first.y - viewport.y >= 20, `${first.y - viewport.y} px from the top`);
  await close();
});

test("what stopped the chat being read goes by itself when the agent's process is up", async () => {
  const { page, actorId, chat, close } = await open("Starting", false);
  // Not started: the read was refused, and the view says so.
  await chat.getByRole("alert").waitFor();
  await person.call("actors", "start", { actorId });
  // The provider's arrival is told to the view, which reads again: no turn, no click.
  await chat.getByRole("alert").waitFor({ state: "detached" });
  const input = chat.getByRole("textbox", { name: "Message" });
  await input.fill("hello");
  await input.press("Enter");
  await chat.getByText("Echo: hello").waitFor();
  assert.equal(await page.locator(".container.main iframe").count(), 1);
  await close();
});

test("an agent is deleted from its screen after asking, and its views leave Home", async () => {
  const { page, actorId, close } = await open("Doomed");
  await person.call("layout", "place", { actor: actorId, module: "chat", title: "Doomed chat" });
  await page.getByRole("button", { name: "Doomed options" }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete Doomed?" });
  await dialog.waitFor();
  // Cancel leaves it as it was.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await dialog.waitFor({ state: "detached" });
  const agents = page.getByRole("navigation", { name: "Agents" });
  await agents.getByRole("button", { name: /Doomed/ }).waitFor();

  await page.getByRole("button", { name: "Doomed options" }).click();
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await dialog.getByRole("button", { name: "Delete" }).click();
  await page.waitForURL(`${app.url}/#/`);
  await agents.getByRole("button", { name: /Doomed/ }).waitFor({ state: "detached" });
  await page.getByRole("region", { name: "Doomed chat" }).waitFor({ state: "detached" });
  const { actors } = await person.call<{ actors: { actorId: string; state: string }[] }>(
    "actors",
    "list",
  );
  assert.equal(actors.find((a) => a.actorId === actorId)?.state, "closed");
  await close();
});

test("however an Actor is closed, its views leave the layout, and others' stay", async () => {
  const gone = await create("Closed elsewhere");
  const stays = await create("Stays");
  await person.call("actors", "start", { actorId: gone });
  await person.call("actors", "start", { actorId: stays });
  await person.call("layout", "place", { actor: gone, module: "chat", title: "Gone" });
  await person.call("layout", "place", { actor: stays, module: "chat", title: "Kept" });
  await person.call("actors", "close", { actorId: gone });
  const titles = async () =>
    (await person.call<{ home: { title?: string }[] }>("layout", "get")).home.map((p) => p.title);
  for (let waited = 0; (await titles()).includes("Gone"); waited += 50) {
    assert.ok(waited < 5000, "its placement stayed");
    await new Promise((done) => setTimeout(done, 50));
  }
  assert.ok((await titles()).includes("Kept"));
});

test("only an agent's screen offers Delete: not the person's, not a built-in's", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(app.signInUrl());
  await page.waitForURL(`${app.url}/`);
  for (const id of ["person", "hub"]) {
    await page.goto(`${app.url}/#/a/${id}`);
    await page.getByRole("navigation", { name: "Path" }).waitFor();
    await page.waitForTimeout(200);
    // A view placed beside it has its own menu; the Actor itself has none.
    assert.equal(
      await page.getByRole("button", { name: /^(you|person|hub) options$/ }).count(),
      0,
      id,
    );
  }
  await page.close();
});
