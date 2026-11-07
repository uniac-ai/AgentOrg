import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildPackage } from "@agentorg/sdk/build";
import { type Browser, chromium } from "@playwright/test";
import WebSocket from "ws";
import { type App, startApp } from "../src/index.ts";
import { packageArchive } from "../src/transfer.ts";

// dist/test/settings.test.js → this package's test sources, and the repository's packages.
const here = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test");
const packages = join(here, "..", "..");

const until = async (condition: () => boolean, ms = 20_000) => {
  for (let waited = 0; !condition(); waited += 20) {
    if (waited > ms) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

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

let browser: Browser;
const out = mkdtempSync(join(tmpdir(), "agentorg-settings-"));
const archives = { installer: "", board: "", counter: "", assistant: "" };
test.before(async () => {
  browser = await chromium.launch();
  for (const [name, path] of [
    ["installer", join(packages, "installer")],
    ["board", join(packages, "..", "examples", "board")],
    ["counter", join(here, "fixtures", "counter-widget")],
    ["assistant", join(here, "fixtures", "assistant")],
  ] as const)
    archives[name] = (await buildPackage(path, { out: join(out, name) })).file;
});
test.after(async () => {
  await browser.close();
  rmSync(out, { recursive: true, force: true });
});

/** A home whose person is bound to an installer, as the first run binds it, and a signed-in tab. */
async function home(t: test.TestContext, name: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `agentorg-settings-${name}-`)));
  const app = await startApp({ home: dir, firstRun: false });
  const person = personOf(app, readFileSync(join(dir, "cli-token"), "utf8").trim());
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    acceptDownloads: true,
  });
  t.after(async () => {
    await context.close();
    person.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const { hash } = await person.call<{ hash: string }>("packages", "add", {
    path: archives.installer,
  });
  const { actorId } = await person.call<{ actorId: string }>("actors", "create", {
    name: "installer",
    package: hash,
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
  await person.call("actors", "start", { actorId });
  await until(() => app.hub.connected(actorId));
  await person.call("grants", "bind", {
    consumer: "person",
    slot: "installer",
    provider: actorId,
    export: "installer.installer",
  });
  const page = await context.newPage();
  await page.goto(app.signInUrl());
  await page.waitForURL(`${app.url}/`);
  return { dir, app, person, page };
}

test("Settings: download a package, install one from a file, and carry the system to another home", async (t) => {
  const a = await home(t, "a");
  const { page } = a;
  const board = await a.person.call<{ hash: string }>("packages", "add", { path: archives.board });

  // Download: the archive exactly as stored, under its name and version.
  await page.goto(`${a.app.url}/#/settings`);
  await page.getByRole("tab", { name: "Packages" }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download board" }).click(),
  ]);
  assert.equal(download.suggestedFilename(), "board-0.1.0.agentorg");
  const saved = join(a.dir, "downloaded.agentorg");
  await download.saveAs(saved);
  assert.deepEqual(readFileSync(saved), Buffer.from(packageArchive(a.dir, board.hash) ?? []));

  // Install from a file: checked, then the plan with the only candidate preselected.
  await page.locator('input[aria-label="Package file"]').setInputFiles(archives.counter);
  const dialog = page.getByRole("dialog", { name: "Install a package" });
  const store = dialog.getByRole("combobox", { name: "counter.store" });
  await store.waitFor();
  assert.equal(await store.locator("option:checked").textContent(), "storage · kv");
  assert.equal(await dialog.getByRole("textbox", { name: "Name" }).inputValue(), "Counter");
  // Left unconnected, it's listed once installed; then its view is placed on home.
  await store.selectOption("");
  await dialog.getByRole("button", { name: "Install", exact: true }).click();
  await dialog.getByText("is installed and running.").waitFor();
  await dialog.getByText("Not connected").waitFor();
  await dialog.getByText("counter.store", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Place", exact: true }).click();
  await page.waitForURL(`${a.app.url}/#/`);
  await page.locator('[aria-label="Counter"] iframe').waitFor();
  const actors = await a.person.call<{ actors: { name: string; state: string }[] }>(
    "actors",
    "list",
  );
  assert.equal(actors.actors.find((actor) => actor.name === "Counter")?.state, "running");

  // The person is "you" in Settings.
  await page.goto(`${a.app.url}/#/settings`);
  await page.getByRole("cell", { name: "you", exact: true }).waitFor();

  // An Actor whose connection to the Hub's management an import never makes on its own.
  const assistant = await a.person.call<{ hash: string }>("packages", "add", {
    path: archives.assistant,
  });
  await a.person.call("actors", "create", {
    name: "Helper",
    package: assistant.hash,
    bindings: [{ slot: "logic.packages", provider: "hub", export: "packages" }],
  });

  // Export: one file, and what it leaves out.
  await page.getByRole("tab", { name: "System" }).click();
  const [system] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export system" }).click(),
  ]);
  assert.equal(system.suggestedFilename(), "system.agentorg-system");
  const file = join(a.dir, "my.agentorg-system");
  await system.saveAs(file);
  await page.getByText("Saved system.agentorg-system · 2 Actors, 2 packages").waitFor();

  // Import into another home: made, and the management connection is the person's to grant.
  const b = await home(t, "b");
  await b.page.goto(`${b.app.url}/#/settings`);
  await b.page.getByRole("tab", { name: "System" }).click();
  await b.page.locator('input[aria-label="System file"]').setInputFiles(file);
  await b.page.getByText(/Made (Counter and Helper|Helper and Counter)$/).waitFor();
  const imported = b.page.getByRole("region", { name: "Import" });
  await imported.getByText("Helper.logic.packages → hub.packages").waitFor();
  const still = JSON.stringify(await imported.boundingBox());
  await imported.getByRole("button", { name: "Grant" }).click();
  await imported.getByText("Granted").waitFor();
  assert.equal(JSON.stringify(await imported.boundingBox()), still, "granting moves nothing");
  const helper = (
    await b.person.call<{ actors: { actorId: string; name: string }[] }>("actors", "list")
  ).actors.find((actor) => actor.name === "Helper");
  const { bindings } = await b.person.call<{ bindings: { consumer: string; slot: string }[] }>(
    "bindings",
    "list",
  );
  assert.ok(
    bindings.some(
      (binding) => binding.consumer === helper?.actorId && binding.slot === "logic.packages",
    ),
  );
});
