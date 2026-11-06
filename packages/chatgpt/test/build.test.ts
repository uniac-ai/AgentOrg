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

test("the model Actor builds to one self-contained host module", async (t) => {
  const out = await mkdtemp(join(tmpdir(), "chatgpt-build-"));
  t.after(() => rm(out, { recursive: true, force: true }));
  const { manifest, file, hash } = await buildPackage(root, { out });
  assert.deepEqual(manifest.modules, {
    model: {
      placement: "host",
      entry: "dist/model.js",
      slots: { web: "http.egress@1", store: "kv@1" },
      exports: { login: "account.login@1", session: "llm.session@1" },
    },
  });
  assert.equal(manifest.name, "chatgpt");
  const verified = await verifyPackage(file);
  assert.ok(verified.ok, verified.ok ? "" : verified.problems.join("\n"));
  assert.equal(verified.hash, hash);
  const code = new TextDecoder().decode(
    readTar(new Uint8Array(await readFile(file))).get("dist/model.js"),
  );
  assert.doesNotMatch(code, /\bimport\s*[{*"'(]/);
  assert.doesNotMatch(code, /\brequire\(/);
  assert.doesNotMatch(code, /["']node:/);
});
