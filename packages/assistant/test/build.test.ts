import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildPackage, verifyPackage } from "@agentorg/sdk/build";
import { readTar } from "@agentorg/sdk/manifest";

// dist/test/build.test.js → the package folder.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("the assistant builds to its logic and its chat view, each self-contained", async (t) => {
  const out = await mkdtemp(join(tmpdir(), "assistant-build-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const { manifest, file, hash } = await buildPackage(root, { out });
  assert.deepEqual(manifest.modules, {
    logic: {
      placement: "host",
      entry: "dist/logic.js",
      slots: {
        model: "llm.session@1",
        store: "kv@1",
        layout: "layout@1",
        packages: "hub.packages@1",
        actors: "hub.actors@1",
        grants: "hub.grants@1",
        exports: "hub.exports@1",
      },
      exports: { chat: "chat@1" },
    },
    chat: {
      placement: "view",
      entry: "dist/chat.js",
      slots: { chat: "chat@1", shell: "ui.shell@1" },
      exports: { view: "ui.view@1" },
    },
  });
  assert.deepEqual(manifest.connections, [["chat.chat", "logic.chat"]]);
  assert.equal(manifest.name, "assistant");
  const verified = await verifyPackage(file);
  assert.ok(verified.ok, verified.ok ? "" : verified.problems.join("\n"));
  assert.equal(verified.hash, hash);
  const files = readTar(new Uint8Array(await readFile(file)));
  for (const entry of ["dist/logic.js", "dist/chat.js"]) {
    const code = new TextDecoder().decode(files.get(entry));
    assert.doesNotMatch(code, /\bimport\s*[{*"'(]/, entry);
    assert.doesNotMatch(code, /\brequire\(/, entry);
    assert.doesNotMatch(code, /["']node:/, entry);
  }
});
