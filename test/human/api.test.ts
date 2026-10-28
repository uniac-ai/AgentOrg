import assert from "node:assert/strict";
import { test } from "node:test";
import { STORAGE } from "./fake-core.ts";
import { json, setup } from "./harness.ts";

test("the user's available tools come from the core, and calling one goes through the core", async () => {
  const { core, get, post } = await setup();
  const { tools } = await json(get("/api/tools"));
  assert.deepEqual(
    tools.map((tool: { name: string }) => tool.name),
    ["view", "activity", "release.storage.review"],
  );

  const called = await post("/api/tools/release.storage.review", { change: "#41" });
  assert.equal(called.status, 200);
  assert.deepEqual((await json(called)).structuredContent, { approved: true });
  assert.deepEqual(core.routed, [["release.storage.review", { change: "#41" }]]);
  assert.equal((await json(post("/api/tools/nothing.here", {}))).isError, true);
});

test("view and activity pass through from the core", async () => {
  const { core, get, pending } = await setup();
  const call = core.deliver("note", { text: "Read me." });
  await pending(call);

  const view = await json(get("/api/view"));
  assert.deepEqual(
    view.pending.map((each: { call: string }) => each.call),
    [call],
  );
  assert.equal((await json(get(`/api/view/${STORAGE}`))).actor.id, STORAGE);
  const unknown = await get("/api/view/act_nobody");
  assert.equal(unknown.status, 400);
  assert.deepEqual(await json(unknown), {
    code: "refused",
    message: "not_found: no actor act_nobody",
  });
  assert.deepEqual((await json(get("/api/activity?since=7&limit=20"))).request, {
    since: 7,
    limit: 20,
  });
});

test("while the core is down, the API says so, and the session holds", async () => {
  const { core, get } = await setup();
  await core.close();

  const down = await get("/api/view");
  assert.equal(down.status, 503);
  assert.equal((await json(down)).code, "core_unreachable");
  assert.equal((await get("/api/session")).status, 200);
});
