import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createActivity } from "../src/activity.ts";

const folder = (t: test.TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), "agentorg-activity-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "activity.jsonl");
};
const entry = (tool: string) => ({ caller: "a", tool, outcome: "refused" as const });

test("a line a crash cut off loses nothing after it, and numbering goes on", (t) => {
  const path = folder(t);
  const log = createActivity(path);
  log.add(entry("one"));
  log.add(entry("two"));
  appendFileSync(path, '{"seq":2,"at":"x","cal');
  const again = createActivity(path);
  again.add(entry("three"));
  const { entries } = again.read({});
  assert.deepEqual(
    entries.map((one) => [one.seq, one.tool]),
    [
      [2, "three"],
      [1, "two"],
      [0, "one"],
    ],
  );
});

test("the log is kept to a size, newest kept", (t) => {
  const path = folder(t);
  const log = createActivity(path, 4096);
  for (let i = 0; i < 200; i++) log.add({ ...entry(`t${i}`), reason: "x".repeat(100) });
  assert.ok(statSync(path).size <= 4096);
  const { entries } = log.read({ limit: 200 });
  assert.equal(entries[0]?.tool, "t199");
  assert.ok(entries.length < 200);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(readFileSync(path, "utf8").endsWith("\n"));
});
