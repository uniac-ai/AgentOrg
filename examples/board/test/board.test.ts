import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildPackage, verifyPackage } from "@agentorg/sdk/build";
import { readTar } from "@agentorg/sdk/manifest";
import { createTestContext } from "@agentorg/sdk/testing";
import logic from "../src/logic.ts";

// dist/test/board.test.js → the package folder.
const board = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function build(t: test.TestContext) {
  const out = await mkdtemp(join(tmpdir(), "board-build-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  return buildPackage(board, { out });
}

test("the board builds to the manifest the spec describes", async (t) => {
  const { manifest } = await build(t);
  const hashes = Object.fromEntries(
    Object.entries(manifest.interfaces).map(([id, entry]) => [id, entry.hash]),
  );
  assert.deepEqual(
    { ...manifest, interfaces: Object.keys(manifest.interfaces) },
    {
      format: "agentorg.package/1",
      name: "board",
      version: "0.1.0",
      description: "A shared task board",
      modules: {
        logic: {
          placement: "host",
          entry: "dist/logic.js",
          slots: { store: "kv@1" },
          exports: { board: "board@1" },
        },
        panel: {
          placement: "view",
          entry: "dist/panel.js",
          slots: { board: "board@1" },
          exports: { view: "ui.view@1" },
        },
      },
      interfaces: ["board@1", "kv@1", "ui.view@1"],
      connections: [["panel.board", "logic.board"]],
      seed: null,
    },
  );
  for (const hash of Object.values(hashes)) assert.match(hash, /^sha256-[0-9a-f]{64}$/);
  const boardEntry = manifest.interfaces["board@1"];
  assert.ok(boardEntry?.kind === "rpc");
  assert.deepEqual(Object.keys(boardEntry.methods).sort(), ["add", "list"]);
  assert.deepEqual(Object.keys(boardEntry.events), ["changed"]);
});

test("two builds hash the same, and the archive verifies", async (t) => {
  const first = await build(t);
  const second = await build(t);
  assert.equal(second.hash, first.hash);
  const verified = await verifyPackage(first.file);
  assert.ok(verified.ok, verified.ok ? "" : verified.problems.join("\n"));
  assert.equal(verified.hash, first.hash);
});

test("each module is one self-contained ESM file: no imports at run time", async (t) => {
  const { file } = await build(t);
  const files = readTar(new Uint8Array(await readFile(file)));
  assert.deepEqual([...files.keys()], ["agentorg.json", "dist/logic.js", "dist/panel.js"]);
  for (const path of ["dist/logic.js", "dist/panel.js"]) {
    const code = new TextDecoder().decode(files.get(path));
    assert.doesNotMatch(code, /\bimport\s*[{*"'(]/, `${path} imports`);
    assert.doesNotMatch(code, /\brequire\(/, `${path} requires`);
  }
});

test("the board's logic keeps cards in its kv@1 slot and tells of each change", async () => {
  const t = createTestContext(logic);
  await t.start();
  assert.deepEqual(await t.call("board", "list", {}), { cards: [] });
  const store = new Map<string, unknown>();
  t.bind("store", {
    get: ({ key }) => (store.has(key) ? { value: store.get(key) as never } : {}),
    set: ({ key, value }) => {
      store.set(key, value);
      return {};
    },
  });
  const card = (await t.call("board", "add", { title: "Ship it" })) as { id: string };
  assert.deepEqual(await t.call("board", "list", {}), {
    cards: [{ id: card.id, title: "Ship it", done: false }],
  });
  assert.deepEqual(
    t.emitted.map((e) => e.payload),
    [{ id: "*" }, { id: card.id }],
  );
});
