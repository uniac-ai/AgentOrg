/** The calls Tool reads retained history with the original caller's authority. */

import assert from "node:assert/strict";
import { test } from "node:test";
import { done, historicalCall, refused, startCore } from "./harness.ts";

test("call_result returns retained history only to its caller, without live invocation controls", async (t) => {
  const core = await startCore();
  t.after(() => core.close());
  const { actor, credential } = await core.org.registry.create(core.rootId, "worker", "Work");
  const history = historicalCall(core, actor.id, core.rootId);
  const caller = await core.client(credential);
  const root = await core.client(core.root);
  assert.deepEqual(await done(caller.call("call_result", { call: history.id })), history);
  assert.equal(await refused(root.call("call_result", { call: history.id })), "forbidden");
  assert.equal(await refused(caller.call("call_result", { call: "call_missing" })), "not_found");
  assert.equal(await refused(caller.call("call_result", { call: history.id, wait: 1 })), "invalid");
  assert.equal(await refused(caller.call("call_withdraw", { call: history.id })), "not_found");
  const calls = (await caller.available()).find((tool) => tool.id === "hub:calls");
  assert.deepEqual(
    calls?.interfaces.map((offer) => offer.call),
    ["call_result"],
  );
  assert.deepEqual(Object.keys(await caller.call("team")).sort(), ["state", "value"]);
});
