import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildPackage, verifyPackage } from "@agentorg/sdk/build";
import { readTar } from "@agentorg/sdk/manifest";
import { build } from "esbuild";
import { EXAMPLE, INSTRUCTIONS } from "../src/logic.ts";

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
        installer: "installer@1",
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
    // No import of any kind, as esbuild reads the code (the instructions hold imports as text).
    const { metafile } = await build({
      stdin: { contents: code },
      bundle: true,
      write: false,
      metafile: true,
      logLevel: "silent",
      // Every import is kept and listed, whatever it names, so none goes unseen.
      plugins: [
        {
          name: "list",
          setup: (b) => b.onResolve({ filter: /.*/ }, (a) => ({ path: a.path, external: true })),
        },
      ],
    });
    assert.deepEqual(metafile.inputs["<stdin>"]?.imports, [], entry);
    // And none that esbuild can't name: an import of a computed name, or the module's own address.
    // A method named `import` (a call `x.import(…)`, or its definition `import(…){`) isn't one.
    assert.doesNotMatch(code, /(?<![.\w$])import\s*\((?![^()]*\)\s*\{)|import\.meta/, entry);
    assert.doesNotMatch(code, /\brequire\(/, entry);
    assert.doesNotMatch(code, /["']node:/, entry);
    // React's mode is decided at build: a frame has no `process` to read it from.
    assert.doesNotMatch(code, /process\.env\.NODE_ENV/, entry);
  }
});

test("the instructions' example builds as packages__build builds it, to a logic and a panel", async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "assistant-example-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(EXAMPLE)) {
    await mkdir(dirname(join(dir, "source", path)), { recursive: true });
    await writeFile(join(dir, "source", path), text);
    assert.ok(INSTRUCTIONS.includes(`--- ${path}\n${text}`), `${path} is in the instructions`);
  }
  // As the Hub builds: only these by name, found from a folder that has them.
  const { manifest } = await buildPackage(join(dir, "source"), {
    out: join(dir, "out"),
    packages: { allowed: ["@agentorg/sdk", "@agentorg/interfaces", "zod"], from: root },
  });
  assert.deepEqual(manifest.modules, {
    logic: {
      placement: "host",
      entry: "dist/logic.js",
      slots: { store: "kv@1" },
      exports: { counter: "counter@1" },
    },
    panel: {
      placement: "view",
      entry: "dist/panel.js",
      slots: { counter: "counter@1" },
      exports: { view: "ui.view@1" },
    },
  });
  assert.deepEqual(manifest.connections, [["panel.counter", "logic.counter"]]);
});
