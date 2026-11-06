import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildPackage } from "@agentorg/sdk/build";
import { chromium } from "@playwright/test";
import WebSocket from "ws";
import { type App, startApp } from "../src/index.ts";

// dist/test/board.test.js → the repository root.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const until = async (condition: () => boolean, ms = 15_000) => {
  for (let waited = 0; !condition(); waited += 20) {
    if (waited > ms) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** The person, through the CLI's way in: one call at a time, optionally as a view. */
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
  const send = async (slot: string, method: string, input: unknown, view?: unknown) => {
    await opened;
    return new Promise<{ result?: unknown; error?: { name: string; code?: string } }>((done) => {
      waiting.set(++id, done as never);
      socket.send(JSON.stringify({ id, op: "call", slot, method, input, view }));
    });
  };
  return {
    close: () => socket.close(),
    send,
    async call<T = Record<string, unknown>>(slot: string, method: string, input: unknown = {}) {
      const reply = await send(slot, method, input);
      if (reply.error) throw new Error(JSON.stringify(reply.error));
      return reply.result as T;
    },
  };
}

test("the board in the shell: a card added in its panel outlives a reload and a restart", async (t) => {
  // The real path: --allow-fs-read matches resolved paths, and macOS's tmpdir is behind a symlink.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-board-e2e-")));
  const home = join(dir, "home");
  const app = await startApp({ home });
  const person = personOf(app, readFileSync(join(home, "cli-token"), "utf8").trim());
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    person.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // As the CLI does, through /api: add the board, create it with its store, start it, place it.
  const built = await buildPackage(join(root, "examples", "board"), { out: join(dir, "out") });
  const { hash } = await person.call<{ hash: string }>("packages", "add", { path: built.file });
  const { actorId } = await person.call<{ actorId: string }>("actors", "create", {
    name: "Board",
    package: hash,
    bindings: [{ slot: "logic.store", provider: "storage", export: "kv" }],
  });
  // The Hub spawns its process, sandboxed, and it is running once it says hello.
  await person.call("actors", "start", { actorId });
  await until(() => app.hub.connected(actorId));
  await person.call("layout", "place", { actor: actorId, module: "panel", title: "Launch" });

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(app.signInUrl());
  await page.waitForURL(`${app.url}/`);
  const panel = page.frameLocator('[aria-label="Launch"] iframe');
  // Added inside the panel's frame, through its slot to the board's logic in its own process.
  await panel.getByRole("textbox", { name: "New card" }).fill("Write the release notes");
  await panel.getByRole("textbox", { name: "New card" }).press("Enter");
  await panel.getByText("Write the release notes").waitFor();
  assert.equal(await panel.getByRole("img").getAttribute("aria-label"), "0 of 1 done");

  await page.reload();
  await panel.getByText("Write the release notes").waitFor();

  // The board's process stopped and started again: the card is in its store, not its memory.
  await person.call("actors", "stop", { actorId });
  assert.equal(app.hub.connected(actorId), false, "stop returns once the process is gone");
  await person.call("actors", "start", { actorId });
  await until(() => app.hub.connected(actorId));
  // The open panel reads its cards again when its slot is usable again.
  await panel.getByText("Write the release notes").waitFor();
  await page.reload();
  await panel.getByText("Write the release notes").waitFor();

  // A view's calls reach only its own module's slots: the panel's `board`, not the logic's store.
  const asPanel = (slot: string, module = "panel") =>
    person.send(slot, slot === "board" ? "list" : "get", slot === "board" ? {} : { key: "cards" }, {
      actor: actorId,
      module,
    });
  assert.deepEqual(
    ((await asPanel("board")).result as { cards: { title: string }[] }).cards.map((c) => c.title),
    ["Write the release notes"],
  );
  for (const slot of ["store", "logic.store"]) {
    const refused = await asPanel(slot);
    assert.equal(refused.result, undefined, slot);
    assert.ok(refused.error, slot);
  }
  assert.equal((await asPanel("store", "logic")).error?.code, "forbidden");
});
