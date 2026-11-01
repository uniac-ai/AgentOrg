/** Private waiter checkpoints preserve feed coverage across process restarts. */
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

test("Form cursor positions re-read the asks while preserving the incoming Message baseline", (t) => {
  const directory = fixture(t);
  const file = join(directory, "inbox");
  for (const forms of ["90", '{"requested":10,"designated":20}']) {
    writeFileSync(file, `{"messages":40,"forms":${forms}}\n`, { mode: 0o600 });
    assert.deepEqual(sessions.inbox("fixture"), { messages: 40, forms: null });
  }
  const next = { messages: 40, forms: "2026-11-01T00:00:00.000Z" };
  sessions.advanceInbox("fixture", next);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), next);
  assert.deepEqual(sessions.inbox("fixture"), next, "reopening reads each committed feed position");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(directory).sort(), ["inbox", "position"]);
});

test("invalid private positions cannot silently reset or skip incoming Messages", (t) => {
  const file = join(fixture(t), "inbox");
  for (const value of [
    { messages: -1, forms: 90 },
    { messages: "40", forms: 90 },
    { messages: 40, forms: { requested: 10 } },
    { messages: 40, forms: { requested: 10, designated: -1 } },
    { messages: 40, forms: "not a time" },
  ]) {
    writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    assert.throws(() => sessions.inbox("fixture"), /invalid local inbox position/);
  }
});
