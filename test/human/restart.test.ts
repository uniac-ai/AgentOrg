import assert from "node:assert/strict";
import { test } from "node:test";
import { browser, DECISION, human, setup } from "./harness.ts";

test("after the human actor restarts, the core delivers its pending calls again, and sessions hold", async () => {
  const { core, actor, cookie, pending } = await setup();
  const decide = core.deliver("decide", DECISION);
  const report = core.deliver("report", { outcome: "Storage moved to SQLite." });
  await pending(decide, report);

  await actor.close();
  const restarted = await human(core);

  const session = await fetch(`${restarted.url}/api/session`, { headers: { Cookie: cookie } });
  assert.equal(session.status, 200);
  const again = await browser(restarted.url, core.credential);
  await again.pending(decide, report);
  const answer = { choice: "Keep", words: null };
  assert.equal((await again.post(`/api/pending/${decide}`, answer)).status, 200);
  assert.deepEqual((await core.settled(decide)).output, answer);
  assert.equal(core.calls.get(report)?.state, "pending");
});

test("when the reverse connection drops, the human actor dials it again and keeps its tasks", async () => {
  const { core, pending, post } = await setup();
  const call = core.deliver("decide", DECISION);
  await pending(call);
  const task = core.calls.get(call)?.task;
  const online = core.onlines();

  await core.drop();
  for (const deadline = Date.now() + 5000; core.onlines() === online; ) {
    assert.ok(Date.now() < deadline, "never happened: the human actor dialed again");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await pending(call);
  assert.equal(core.calls.get(call)?.task, task);
  const answer = { choice: "Drop", words: null };
  assert.equal((await post(`/api/pending/${call}`, answer)).status, 200);
  assert.deepEqual((await core.settled(call)).output, answer);
});
