import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolDescriptor } from "../../../src/domain/model/index.ts";
import { json, setup } from "./harness.ts";

test("the web client exposes nothing of its own to the core", async () => {
  const { core } = await setup();
  assert.deepEqual(core.org.connections.interfaces(core.rootId), []);
});

test("the user's Tool catalog is the root's, with local interfaces and unchanged call aliases", async () => {
  const { core, get, post, storage } = await setup();
  const [review] = core.store.exposures.get(storage.id);
  assert.ok(review);
  core.store.exposures.put(storage.id, [review, { ...review, description: "Cached duplicate" }]);
  const catalog = await json(get("/api/interfaces"));
  assert.deepEqual(Object.keys(catalog), ["tools"]);
  const tools = catalog.tools as ToolDescriptor[];
  const available = await (await core.client(core.root)).available();
  assert.deepEqual(tools, available);
  const listed = tools.flatMap((tool) => tool.interfaces.map((offer) => offer.call));
  assert.ok(listed.includes("activity") && listed.includes("storage.review"));
  const advertised = tools.find((tool) => tool.id === storage.id);
  assert.equal(advertised?.name, "storage");
  assert.equal(advertised?.interfaces[0]?.interface.name, "review");
  assert.equal(advertised?.interfaces.length, 1);
  assert.equal(tools.length, 8, "cached duplicate advertisements preserve the full web catalog");

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

test("the web API preserves an Actor and its credential when optional execution fails", async () => {
  const { core, post } = await setup();
  const response = await post("/api/interfaces/actor_create", {
    name: "external-worker",
    purpose: "Use an external Provider",
    execution: { providerId: "unavailable", config: {} },
  });
  assert.equal(response.status, 200);
  const created = await json(response);
  assert.equal(created.execution.providerId, "unavailable");
  assert.equal(created.execution.status, "failed");
  assert.equal(typeof created.execution.error?.code, "string");
  assert.equal((await core.org.registry.byCredential(created.credential))?.id, created.actor.id);
  const read = await post("/api/interfaces/team", { actor: created.actor.id, depth: 0 });
  assert.equal(read.status, 200);
  assert.equal((await json(read)).positions[0].id, created.actor.id);
});
