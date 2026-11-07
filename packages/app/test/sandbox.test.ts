import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildPackage } from "@agentorg/sdk/build";
import { chromium } from "@playwright/test";
import WebSocket from "ws";
import { startApp } from "../src/index.ts";

// dist/test/sandbox.test.js → the package folder, where the probe view's source is.
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures");

test("a view's frame reaches nothing of the shell, the gateway or the network", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "agentorg-sandbox-"));
  const out = mkdtempSync(join(tmpdir(), "agentorg-probe-"));
  const app = await startApp({ home, firstRun: false });
  t.after(async () => {
    await app.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });
  // The probe package, added as the person, through the CLI's way in.
  const built = await buildPackage(join(fixtures, "probe"), { out });
  const token = readFileSync(join(home, "cli-token"), "utf8").trim();
  const added = await new Promise<{ hash: string }>((done, failed) => {
    const socket = new WebSocket(`${app.url.replace("http", "ws")}/api`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    socket.once("open", () =>
      socket.send(
        JSON.stringify({
          id: 1,
          op: "call",
          slot: "packages",
          method: "add",
          input: { path: built.file },
        }),
      ),
    );
    socket.once("message", (data) => {
      socket.close();
      const reply = JSON.parse(String(data));
      if (reply.result) done(reply.result);
      else failed(new Error(JSON.stringify(reply.error)));
    });
  });

  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  // Signed in as a tab is: the one-time address, then the shell.
  await page.goto(app.signInUrl());
  await page.waitForURL(`${app.url}/`);
  // Signed in: the session is in the shell origin's own storage, and the address keeps no code.
  assert.match(
    String(await page.evaluate(() => localStorage.getItem("agentorg.session"))),
    /^[\w-]{43}$/,
  );
  assert.equal(new URL(page.url()).hash, "");
  page.on("popup", () => assert.fail("A frame opened a window."));
  const outcome = await page.evaluate(async (hash) => {
    // The shell's side of the frame protocol, as FrameHost speaks it.
    // Every wait here is bounded, so a frame that stalls fails the test with what it waited for.
    const within = <T>(promise: Promise<T>, what: string) =>
      Promise.race([
        promise,
        new Promise<never>((_, failed) =>
          setTimeout(() => failed(new Error(`The frame didn't ${what} within 10 s.`)), 10_000),
        ),
      ]);
    const frame = document.createElement("iframe");
    frame.sandbox.add("allow-scripts");
    frame.src = `/frames/${hash}/probe.html`;
    const loaded = new Promise((done) => frame.addEventListener("load", done, { once: true }));
    document.body.append(frame);
    await within(loaded, "load");
    const channel = new MessageChannel();
    const logs: { message: string; fields?: Record<string, string> }[] = [];
    const replies = new Map<number, (reply: unknown) => void>();
    channel.port1.onmessage = (event) => {
      const message = event.data;
      if (message.op === "log") logs.push(message);
      else if (message.op === "reply") replies.get(message.id)?.(message);
    };
    frame.contentWindow?.postMessage("frame/1", "*", [channel.port2]);
    const request = (message: { id: number } & Record<string, unknown>) =>
      within(
        new Promise((done) => {
          replies.set(message.id, done);
          channel.port1.postMessage(message);
        }),
        `answer ${message.op}`,
      );
    const load = await request({
      op: "load",
      id: 1,
      src: `${location.origin}/frames/${hash}/probe.js`,
      self: { actorId: "probe", module: "probe" },
      slots: {},
    });
    const mount = await request({
      op: "mount",
      id: 2,
      theme: {},
      size: { width: 200, height: 100 },
    });
    for (let i = 0; i < 100 && !logs.some((line) => line.message === "probe"); i++)
      await new Promise((done) => setTimeout(done, 50));
    localStorage.setItem("shell", "the shell's own");
    return { load, mount, probe: logs.find((line) => line.message === "probe")?.fields };
  }, added.hash);

  assert.deepEqual(outcome.load, { op: "reply", id: 1, result: {} });
  assert.deepEqual(outcome.mount, { op: "reply", id: 2, result: {} });
  assert.deepEqual(outcome.probe, {
    // An opaque origin: nothing of the gateway's.
    origin: "null",
    parentDom: "blocked: SecurityError",
    cookie: "blocked: SecurityError",
    localStorage: "blocked: SecurityError",
    // The frame's policy: nothing fetched, from the gateway or anywhere.
    fetchGateway: "blocked: TypeError",
    fetchOutside: "blocked: TypeError",
    xhr: "blocked: TypeError",
    // No popups in the sandbox; and ui.shell@1 opens https only.
    openWindow: "blocked: Error",
    shellHttp: "blocked: Refused",
  });
});

test("a frame's address opened top-level is still sandboxed, so it can't read the shell's session", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "agentorg-toplevel-"));
  const out = mkdtempSync(join(tmpdir(), "agentorg-probe-"));
  const app = await startApp({ home, firstRun: false });
  t.after(async () => {
    await app.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });
  const built = await buildPackage(join(fixtures, "probe"), { out });
  app.hub.state.addPackage("person", built.file);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(app.signInUrl());
  await page.waitForURL(`${app.url}/`);
  // Another page in the same browser opens a frame's address, and its bundle's, as a top page.
  for (const path of [
    `/frames/${built.hash}/probe.html`,
    `/frames/${built.hash}/probe.js`,
    "/frames/runtime.js",
  ]) {
    // The same browser context as the signed-in shell: the same storage, were the origin the same.
    const top = await context.newPage();
    const response = await top.goto(`${app.url}${path}`);
    assert.match(
      response?.headers()["content-security-policy"] ?? "",
      /sandbox allow-scripts/,
      path,
    );
    const reached = await top.evaluate(() => {
      try {
        return `read: ${localStorage.getItem("agentorg.session")}`;
      } catch (error) {
        return `blocked: ${(error as Error).name}`;
      }
    });
    assert.equal(reached, "blocked: SecurityError", path);
    assert.equal(await top.evaluate(() => self.origin), "null", path);
    await top.close();
  }
});
