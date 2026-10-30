/** Actor admission, delivery ownership, reachability and exposed interfaces. */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import { connectClient } from "../src/actor/index.ts";
import { CONNECTION_PATH } from "../src/connection/index.ts";
import { organization } from "../src/domain/index.ts";
import { CLOSE_REPLACED, CLOSE_REVOKED } from "../src/network/index.ts";
import { rootCredential } from "../src/server/index.ts";
import { SqliteStore } from "../src/storage/sqlite/index.ts";
import { fakeActor, iface, startCore, until } from "./harness.ts";

test("the first start creates the root and its credential file, readable only by its owner", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentorg-root-"));
  try {
    const file = join(directory, "root-credential");
    const store = new SqliteStore(join(directory, "core.db"));
    const { registry } = organization(store);
    const credential = await rootCredential(registry, file);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const root = registry.root();
    const identity = join(directory, "root-actor");
    assert.equal(readFileSync(identity, "utf8").trim(), root?.id);
    assert.equal(statSync(identity).mode & 0o777, 0o600);
    assert.equal(root?.manager, null);
    assert.equal((await registry.byCredential(credential))?.id, root?.id);
    // A later start reads the same credential.
    assert.equal(await rootCredential(registry, file), credential);

    // Without the file, a new credential is minted and the old one stops working.
    rmSync(file);
    const minted = await rootCredential(registry, file);
    assert.notEqual(minted, credential);
    assert.equal(await registry.byCredential(credential), undefined);
    assert.equal(registry.root()?.id, root?.id);

    // A file that holds something else is refused rather than overwritten.
    writeFileSync(file, "not-the-credential\n", { mode: 0o600 });
    await assert.rejects(rootCredential(registry, file), /does not hold the root's credential/);
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Actor admission requires the matching credential and refuses a web page's socket", async (t) => {
  const core = await startCore();
  t.after(() => core.close());
  for (const identity of [
    { actorId: core.rootId },
    { actorId: core.rootId, credential: "sentinel-not-a-credential" },
    { actorId: "missing-actor", credential: core.root },
  ]) {
    await assert.rejects(connectClient({ url: core.url, ...identity }), /admission/);
  }
  const fromPage = await new Promise<boolean>((resolve) => {
    const url = `${core.url.replace("http", "ws")}${CONNECTION_PATH}`;
    const socket = new WebSocket(url, { headers: { Origin: "http://evil.test" } });
    socket.on("open", () => {
      socket.close();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
  assert.equal(fromPage, false);
  const client = await core.client(core.root);
  assert.equal((await client.call("team")).state, "done");
});

test("fresh and replaced Actor advertisements retain the first valid descriptor for each local name", async (t) => {
  const core = await startCore();
  t.after(() => core.close());
  const { actor: storage, credential } = await core.org.registry.create(
    core.rootId,
    "storage",
    "Storage",
  );
  assert.equal(core.org.connections.link(storage.id), undefined);
  const first = iface("review", { description: "First review contract" });
  const fake = fakeActor([first, iface("review"), iface("not.a.handle"), iface("archive")]);
  const connection = await core.connect(credential, fake);
  await until("storage online", () => core.org.connections.link(storage.id) !== undefined);
  const listed = core.org.connections.interfaces(storage.id).map((each) => each.name);
  assert.deepEqual(listed, ["review", "archive"]);
  assert.deepEqual(core.store.exposures.get(storage.id), [first, iface("archive")]);
  assert.ok(core.org.connections.link(storage.id));
  const caller = await core.client(core.root);
  const catalog = await caller.available();
  assert.equal(catalog.length, 8, "the Actor's Tool and all seven Hub Tools remain available");
  assert.deepEqual(
    catalog.find((tool) => tool.id === storage.id)?.interfaces.map((offer) => offer.interface),
    [first, iface("archive")],
  );

  const restored = iface("restore", { description: "First restore contract" });
  await connection.expose(fakeActor([restored, iface("restore"), iface("not.a.handle")]).exposed);
  await until("restore listed", () =>
    core.org.connections.interfaces(storage.id).some((each) => each.name === "restore"),
  );
  assert.deepEqual(core.store.exposures.get(storage.id), [restored]);
  assert.deepEqual(
    (await caller.available())
      .find((tool) => tool.id === storage.id)
      ?.interfaces.map((offer) => offer.interface),
    [restored],
  );
});

test("cached duplicate advertisements remain usable offline and after a core restart", async (t) => {
  const core = await startCore();
  t.after(() => core.close());
  const { actor } = await core.org.registry.create(core.rootId, "cached", "Cached");
  const first = iface("review", { description: "Cached first contract" });
  const cached = [first, iface("review"), iface("invalid.name"), iface("archive")];
  core.store.exposures.put(actor.id, cached);
  const caller = await core.client(core.root);
  const check = async () => {
    assert.equal(core.org.connections.link(actor.id), undefined);
    assert.deepEqual(core.org.connections.interfaces(actor.id), [first, iface("archive")]);
    const catalog = await caller.available();
    assert.equal(catalog.length, 8);
    assert.deepEqual(
      catalog.find((tool) => tool.id === actor.id)?.interfaces.map((offer) => offer.interface),
      [first, iface("archive")],
    );
  };
  await check();
  await core.restart();
  await until(
    "the catalog caller reconnects",
    async () => (await caller.call("team").catch(() => undefined))?.state === "done",
  );
  await check();
  assert.deepEqual(
    core.store.exposures.get(actor.id),
    cached,
    "reads normalize existing rows without migrating storage",
  );
});

test("a newer connection of the same actor replaces the older, which does not connect again", async (t) => {
  const core = await startCore();
  t.after(() => core.close());
  const { actor, credential } = await core.org.registry.create(core.rootId, "web", "Web");
  const first = await core.connect(credential, fakeActor([iface("one")]));
  await until("first online", () => core.org.connections.link(actor.id) !== undefined);
  const firstLink = core.org.connections.link(actor.id);

  await core.connect(credential, fakeActor([iface("two")]));
  await until("first replaced", () => first.ended === CLOSE_REPLACED);
  await until("second's interfaces listed", () =>
    core.org.connections.interfaces(actor.id).some((each) => each.name === "two"),
  );
  assert.notEqual(core.org.connections.link(actor.id), firstLink);
  await until("online through the second", () => core.org.connections.link(actor.id) !== undefined);
  assert.ok(firstLink);
  core.org.changed(actor.id, firstLink, [iface("stale")]);
  core.org.offline(actor.id, firstLink);
  assert.ok(core.org.connections.link(actor.id));
  assert.deepEqual(
    core.org.connections.interfaces(actor.id).map((each) => each.name),
    ["two"],
  );
  const fresh = organization(core.store);
  assert.equal(fresh.connections.link(actor.id), undefined);
  assert.deepEqual(fresh.connections.interfaces(actor.id), [iface("two")]);
  assert.ok(!("online" in core.org.registry.found(actor.id)));
});

test("a closed actor's credential is refused and its connection ends for good", async (t) => {
  const core = await startCore();
  t.after(() => core.close());
  const { actor, credential } = await core.org.registry.create(core.rootId, "old", "Old");
  const connection = await core.connect(credential);
  await until("online", () => core.org.connections.link(actor.id) !== undefined);

  const root = await core.client(core.root);
  assert.equal((await root.call("actor_close", { actor: actor.id })).state, "done");
  await until("ended", () => connection.ended === CLOSE_REVOKED);
  assert.equal(core.org.connections.link(actor.id), undefined);
  assert.equal(await core.org.identify(credential), undefined);
  await assert.rejects(
    connectClient({ url: core.url, actorId: actor.id, credential }),
    /admission/,
  );
});

test("an actor connects again after its connection drops", async (t) => {
  const core = await startCore();
  t.after(() => core.close());
  const { actor, credential } = await core.org.registry.create(core.rootId, "batch", "Batch");
  await core.connect(credential, fakeActor([iface("run")]));
  await until("online", () => core.org.connections.link(actor.id) !== undefined);
  const before = core.org.connections.link(actor.id);
  core.drop();
  await until("online again on a new link", () => {
    const link = core.org.connections.link(actor.id);
    return (
      link !== undefined && link !== before && core.org.connections.link(actor.id) !== undefined
    );
  });
});

test("a caller reconnects with fresh admission after the core restarts", async (t) => {
  const core = await startCore();
  t.after(() => core.close());
  const client = await core.client(core.root);
  for (let round = 0; round < 3; round += 1) {
    assert.equal((await client.call("team")).state, "done");
    await core.restart();
    await until(`the caller answers after restart ${round + 1}`, async () => {
      return (await client.call("team").catch(() => undefined))?.state === "done";
    });
  }
});
