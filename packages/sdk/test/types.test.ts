import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// dist/test/types.test.js → the package root.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tsc = join(
  dirname(createRequire(import.meta.url).resolve("typescript/package.json")),
  "bin",
  "tsc",
);

test("handles are typed from their interfaces: right uses compile and every wrong one is an error", () => {
  const result = spawnSync(process.execPath, [tsc, "-p", join(root, "test-types")], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
