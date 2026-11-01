/** The private waiter checkpoint is the session's attention position, kept across restarts. */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { sessions } from "../src/clients/mcp/sessions.ts";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "agentorg-session-"));
  const previous = process.env.AGENTORG_HOME;
  process.env.AGENTORG_HOME = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.AGENTORG_HOME;
    else process.env.AGENTORG_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  sessions.fill("fixture", "fixture-actor");
  return join(directory, "sessions/fixture");
}

test("the attention position is kept privately and read back after a restart", (t) => {
  const directory = fixture(t);
  assert.equal(sessions.inbox("fixture"), undefined);
  sessions.advanceInbox("fixture", "42");
  const file = join(directory, "inbox");
  assert.equal(readFileSync(file, "utf8"), "42\n");
  assert.equal(sessions.inbox("fixture"), "42");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(directory).sort(), ["inbox", "position"]);
});

test("an earlier kind of checkpoint counts as no position, so delivery starts from now", (t) => {
  const file = join(fixture(t), "inbox");
  for (const kept of ['{"messages":40,"forms":90}', '{"messages":40,"forms":null}', "-1", ""]) {
    writeFileSync(file, kept, { mode: 0o600 });
    assert.equal(sessions.inbox("fixture"), undefined);
  }
});
