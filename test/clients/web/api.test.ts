import assert from "node:assert/strict";
import { test } from "node:test";
import { json, setup } from "./harness.ts";

test("the web client exposes nothing of its own to the core", async () => {
  const { core } = await setup();
  assert.deepEqual(core.org.registry.get(core.rootId)?.interfaces, []);
});

test("the user's available interfaces are the root's, listed and called through the core", async () => {
  const { core, get, post, storage } = await setup();
  const { interfaces } = await json(get("/api/interfaces"));
  const listed = interfaces.map((offer: { interface: { name: string } }) => offer.interface.name);
  const available = await (await core.client(core.root)).available();
  assert.deepEqual(
    listed,
    available.map((offer) => offer.interface.name),
  );
  assert.ok(listed.includes("activity") && listed.includes("storage.review"));

  const called = await post("/api/interfaces/storage.review", { change: "#41" });
  assert.equal(called.status, 200);
  assert.deepEqual(await json(called), { verdict: "looked at #41" });
  assert.deepEqual(
    storage.received.map((each) => [each.name, each.input]),
    [["review", { change: "#41" }]],
  );

  const { entries } = await json(post("/api/interfaces/activity", { limit: 2 }));
  assert.equal(entries.length, 2);

  const refused = await post("/api/interfaces/nothing.here", {});
  assert.equal(refused.status, 400);
  assert.equal((await json(refused)).code, "refused");
  const invalid = await post("/api/interfaces/activity", { limit: "two" });
  assert.equal(invalid.status, 400);
  assert.equal((await json(invalid)).code, "refused");
});

test("while the core is down, the API says so, and the session holds", async () => {
  const { core, get, post } = await setup();
  await core.close();

  for (const down of [await get("/api/interfaces"), await post("/api/interfaces/activity")]) {
    assert.equal(down.status, 503);
    assert.equal((await json(down)).code, "core_unreachable");
  }
  assert.equal((await get("/api/session")).status, 200);
});
