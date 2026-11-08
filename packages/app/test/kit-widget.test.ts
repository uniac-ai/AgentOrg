import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import WebSocket from "ws";
import { startApp } from "../src/index.ts";

// dist/test/kit-widget.test.js → the repository root, and the Hub's kit widget fixture.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const fixture = join(root, "packages", "hub", "test", "fixtures", "kit-widget");

const until = async (condition: () => boolean, ms = 15_000) => {
  for (let waited = 0; !condition(); waited += 20) {
    if (waited > ms) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

test("a widget built by the Hub from the kit renders in its frame", async (t) => {
  // The real path: --allow-fs-read matches resolved paths, and macOS's tmpdir is behind a symlink.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "agentorg-kit-widget-")));
  const home = join(dir, "home");
  const app = await startApp({ home, firstRun: false });
  const socket = new WebSocket(`${app.url.replace("http", "ws")}/api`, {
    headers: { Authorization: `Bearer ${readFileSync(join(home, "cli-token"), "utf8").trim()}` },
  });
  // Its open is awaited later: listened for now, so it isn't missed.
  const opened = new Promise((done) => socket.once("open", done));
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    socket.close();
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await opened;
  let id = 0;
  const call = <T>(slot: string, method: string, input: unknown) =>
    new Promise<T>((done, failed) => {
      const mine = ++id;
      const listen = (data: WebSocket.RawData) => {
        const reply = JSON.parse(String(data));
        if (reply.id !== mine) return;
        socket.off("message", listen);
        if (reply.error) failed(new Error(JSON.stringify(reply.error)));
        else done(reply.result as T);
      };
      socket.on("message", listen);
      socket.send(JSON.stringify({ id: mine, op: "call", slot, method, input }));
    });

  // Built by the Hub from source, as an agent builds one: JSX, React, react-dom and the kit.
  const files = {
    "package.json": readFileSync(join(fixture, "package.json"), "utf8"),
    "src/panel.tsx": readFileSync(join(fixture, "src", "panel.tsx"), "utf8"),
  };
  const { hash } = await call<{ hash: string }>("packages", "build", { files });
  const { actorId } = await call<{ actorId: string }>("actors", "create", {
    name: "Kit",
    package: hash,
  });
  await call("actors", "start", { actorId });
  await until(() => app.hub.connected(actorId));
  await call("layout", "place", { actor: actorId, module: "panel", title: "Kit" });

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(app.signInUrl());
  await page.waitForURL(`${app.url}/`);
  const panel = page.frameLocator('[aria-label="Kit"] iframe');
  // The kit's Button, live in the frame, and its Chat with the message given.
  await panel.getByRole("button", { name: "Pressed 0" }).click();
  await panel.getByRole("button", { name: "Pressed 1" }).waitFor();
  await panel.getByText("Hello from the kit").waitFor();
  assert.ok(await panel.getByRole("textbox").count(), "the Chat's composer is there");
});
