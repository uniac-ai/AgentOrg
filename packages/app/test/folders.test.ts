import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { callFolders } from "../src/folders.ts";
import { startApp } from "../src/index.ts";

const refused = (code: string) => (error: { code?: string }) => error.code === code;

function tree(t: test.TestContext) {
  const root = mkdtempSync(join(tmpdir(), "agentorg-folders-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "beta"));
  mkdirSync(join(root, "Alpha"));
  mkdirSync(join(root, ".hidden"));
  writeFileSync(join(root, "secret-plans.txt"), "");
  symlinkSync(join(root, "beta"), join(root, "linked"));
  symlinkSync(join(root, "secret-plans.txt"), join(root, "linked-file"));
  symlinkSync(join(root, "nowhere"), join(root, "dangling"));
  return root;
}

test("it names folders only: no files, no dot folders, links that lead to folders", async (t) => {
  const root = tree(t);
  assert.deepEqual(await callFolders("list", { path: root }), {
    path: root,
    parent: dirname(root),
    folders: [{ name: "Alpha" }, { name: "beta" }, { name: "linked" }],
  });
});

test("it starts at home, and the top has no parent", async () => {
  assert.equal(((await callFolders("list", {})) as { path: string }).path, homedir());
  const top = (await callFolders("list", { path: "/" })) as { parent?: string };
  assert.equal(top.parent, undefined);
});

test("what isn't a folder, or isn't absolute, is refused", async (t) => {
  const root = tree(t);
  await assert.rejects(
    callFolders("list", { path: join(root, "gone") }) as Promise<unknown>,
    refused("unknown"),
  );
  await assert.rejects(
    callFolders("list", { path: join(root, "secret-plans.txt") }) as Promise<unknown>,
    refused("unknown"),
  );
  await assert.rejects(
    callFolders("list", { path: "relative/path" }) as Promise<unknown>,
    refused("invalid"),
  );
  assert.throws(() => callFolders("read", {}), refused("invalid"));
});

test("the person's socket reaches it", async (t) => {
  const root = tree(t);
  const home = mkdtempSync(join(tmpdir(), "agentorg-app-"));
  const app = await startApp({ home, firstRun: { log: () => {} } });
  t.after(async () => {
    await app.close();
    rmSync(home, { recursive: true, force: true });
  });
  const token = readFileSync(join(home, "cli-token"), "utf8").trim();
  const socket = new WebSocket(`${app.url.replace("http", "ws")}/api`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  t.after(() => socket.close());
  await new Promise((done) => socket.once("open", done));
  const reply = new Promise<{ result?: { path: string } }>((done) =>
    socket.once("message", (data) => done(JSON.parse(String(data)))),
  );
  socket.send(
    JSON.stringify({ id: 1, op: "call", slot: "folders", method: "list", input: { path: root } }),
  );
  assert.equal((await reply).result?.path, root);
});
