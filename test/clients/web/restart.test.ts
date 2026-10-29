import assert from "node:assert/strict";
import { test } from "node:test";
import { until } from "../../harness.ts";
import { human, json, online, setup } from "./harness.ts";

test("after the web client restarts, it is the root again, and sessions hold", async () => {
  const { core, actor, cookie, csrf } = await setup();
  await actor.close();
  await until("the web client goes offline", () => !online(core));
  const restarted = await human(core);

  const session = await fetch(`${restarted.url}/api/session`, { headers: { Cookie: cookie } });
  assert.equal(session.status, 200);
  assert.equal((await json(session)).csrf_token, csrf);
  const called = await fetch(`${restarted.url}/api/interfaces/activity`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: "{}",
  });
  assert.equal(called.status, 200);
});

test("when its connection drops, the web client dials again", async () => {
  const { core, post } = await setup();
  core.drop();
  await until("the web client goes offline", () => !online(core));
  await until("the web client dials again", () => online(core));
  assert.equal((await post("/api/interfaces/activity")).status, 200);
});
