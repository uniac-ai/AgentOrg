/** Exercise the ordinary SDK in an isolated GC-enabled process, using only a public provider seam. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("catalog validator owners are collectible across fresh schemas and preserve validation/discovery", () => {
  const fixture = fileURLToPath(
    new URL("../../test/fixtures/catalog-lifetime.mjs", import.meta.url),
  );
  const actor = fileURLToPath(new URL("../src/actor/index.js", import.meta.url));
  const result = spawnSync(process.execPath, ["--expose-gc", fixture, actor], {
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const proof = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}");
  assert.equal(proof.ok, true);
  assert.equal(proof.bounded, true);
  assert.equal(proof.freshParsedSchemas, true);
  assert.equal(proof.ownedListenerClosed, true);
});
