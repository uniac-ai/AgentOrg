import assert from "node:assert/strict";
import { test } from "node:test";
import { until } from "../harness.ts";
import { browser, DECISION, human, online, setup } from "./harness.ts";

test("after the human actor restarts, the core delivers its pending calls again, and sessions hold", async () => {
  const { core, actor, cookie, storage, pending } = await setup();
  const decide = await storage.ask("decide", DECISION);
  const report = await storage.ask("report", { outcome: "Storage moved to SQLite." });
  await pending(decide, report);

  await actor.close();
  await until("the human actor goes offline", () => !online(core));
  const restarted = await human(core);

  const session = await fetch(`${restarted.url}/api/session`, { headers: { Cookie: cookie } });
  assert.equal(session.status, 200);
  const again = await browser(restarted.url, core.root);
  await again.pending(decide, report);
  const answer = { choice: "Keep", words: null };
  assert.equal((await again.post(`/api/pending/${decide}`, answer)).status, 200);
  assert.deepEqual((await storage.result(decide)).output?.value, answer);
  assert.equal((await storage.result(report, 0)).state, "pending");
});

test("when the reverse connection drops, the human actor dials it again and keeps its tasks", async () => {
  const { core, storage, pending, post } = await setup();
  const call = await storage.ask("decide", DECISION);
  await pending(call);
  const { run } = await storage.result(call, 0);

  core.drop();
  await until("the human actor goes offline", () => !online(core));
  await until("the human actor dials again", () => online(core));
  await pending(call);
  assert.equal((await storage.result(call, 0)).run, run);
  const answer = { choice: "Drop", words: null };
  assert.equal((await post(`/api/pending/${call}`, answer)).status, 200);
  assert.deepEqual((await storage.result(call)).output?.value, answer);
});
