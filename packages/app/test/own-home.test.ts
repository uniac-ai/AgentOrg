import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("the app's tests run in a home of their own, and what they start too: no AgentOrg Mac of the person's is there", () => {
  const ownHome = (home: string) => realpathSync(home).startsWith(realpathSync(tmpdir()));
  assert.ok(ownHome(homedir()), "the tests' home is a folder of their own");
  const started = execFileSync(process.execPath, ["-p", "require('node:os').homedir()"], {
    encoding: "utf8",
  }).trim();
  assert.ok(ownHome(started), "a program a test starts has it too");
  assert.equal(existsSync(join(homedir(), "Library", "Application Support", "AgentOrg")), false);
});
