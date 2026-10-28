import assert from "node:assert/strict";
import { test } from "node:test";
import { json, setup } from "./harness.ts";

test("the user's available tools come from the core, and calling one goes through the core", async () => {
  const { get, post, storage } = await setup();
  const { tools } = await json(get("/api/tools"));
  const names = tools.map((tool: { name: string }) => tool.name);
  for (const name of ["view", "activity", "actor_create", "storage.review"]) {
    assert.ok(names.includes(name), name);
  }

  const called = await post("/api/tools/storage.review", { change: "#41" });
  assert.equal(called.status, 200);
  assert.deepEqual(await json(called), { verdict: "looked at #41" });
  assert.deepEqual(
    storage.received.map((each) => [each.name, each.input]),
    [["review", { change: "#41" }]],
  );
  const refused = await post("/api/tools/nothing.here", {});
  assert.equal(refused.status, 400);
  assert.equal((await json(refused)).code, "refused");
});

test("view and activity pass through from the core", async () => {
  const { core, get, pending, storage } = await setup();
  const call = await storage.ask("note", { text: "Read me." });
  await pending(call);

  const view = await json(get("/api/view"));
  assert.equal(view.actor.id, core.rootId);
  assert.deepEqual(
    view.pending.map((each: { id: string }) => each.id),
    [call],
  );
  assert.equal(view.names[storage.id], "storage");
  assert.equal((await json(get(`/api/view/${storage.id}`))).actor.name, "storage");
  const unknown = await get("/api/view/act_nobody");
  assert.equal(unknown.status, 400);
  assert.equal((await json(unknown)).code, "refused");

  const { entries } = await json(get("/api/activity?limit=2"));
  assert.equal(entries.length, 2);
  const older = await json(get(`/api/activity?since=${entries[1].id - 1}`));
  assert.deepEqual(
    older.entries.map((entry: { id: number }) => entry.id),
    entries.map((entry: { id: number }) => entry.id),
  );
});

test("while the core is down, the API says so, and the session holds", async () => {
  const { core, get } = await setup();
  await core.close();

  const down = await get("/api/view");
  assert.equal(down.status, 503);
  assert.equal((await json(down)).code, "core_unreachable");
  assert.equal((await get("/api/session")).status, 200);
});
