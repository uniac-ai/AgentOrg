/** Credentials, both endpoints, one channel per actor, reachability and exposed interfaces. */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PATHS, SUBPROTOCOL } from "../src/bindings/mcp/index.ts";
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

test("both endpoints refuse a missing or wrong credential and any request from a web page", async (t) => {
  const core = await startCore();
  t.after(() => core.close());
  const post = (headers: Record<string, string>) =>
    fetch(`${core.url}${PATHS.request}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ Authorization: "Bearer sentinel-not-a-credential" })).status, 401);
  const fromPage = await post({
    Authorization: `Bearer ${core.root}`,
    Origin: "http://evil.test",
  });
  assert.equal(fromPage.status, 403);

  const upgrade = (headers: Record<string, string>) =>
    new Promise<number>((resolve) => {
      const url = `${core.url.replace("http", "ws")}${PATHS.channel}`;
      const socket = new WebSocket(url, {
        protocols: [SUBPROTOCOL],
        headers,
      } as unknown as string[]);
      socket.onopen = () => {
        socket.close();
        resolve(101);
      };
      socket.onerror = () => resolve(-1);
    });
  assert.equal(await upgrade({ Authorization: "Bearer sentinel-not-a-credential" }), -1);
  assert.equal(
    await upgrade({ Authorization: `Bearer ${core.root}`, Origin: "http://evil.test" }),
    -1,
  );
  assert.equal(await upgrade({ Authorization: `Bearer ${core.root}` }), 101);
});

test("the core learns an actor's interfaces when it connects, again when they change, and marks it online", async (t) => {
  const core = await startCore();
  t.after(() => core.close());
  const { actor: storage, credential } = await core.org.registry.create(
    core.rootId,
    "storage",
    "Storage",
  );
  assert.equal(core.org.connections.link(storage.id), undefined);
  const fake = fakeActor([iface("review"), iface("not.a.handle"), iface("archive")]);
  const connection = await core.connect(credential, fake);
  await until("storage online", () => core.org.connections.link(storage.id) !== undefined);
  const listed = core.org.connections.interfaces(storage.id).map((each) => each.name);
  assert.deepEqual(listed, ["review", "archive"], "an interface whose name has a dot is dropped");
  assert.ok(core.org.connections.link(storage.id));

  await connection.expose([...fake.exposed, ...fakeActor([iface("restore")]).exposed]);
  await until("restore listed", () =>
    core.org.connections.interfaces(storage.id).some((each) => each.name === "restore"),
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
  const refused = await fetch(`${core.url}${PATHS.request}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${credential}` },
  });
  assert.equal(refused.status, 401);
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

test("a caller's first request after the core restarts is answered, though its kept-alive connection closed", async (t) => {
  const core = await startCore();
  t.after(() => core.close());
  const client = await core.client(core.root);
  for (let round = 0; round < 3; round += 1) {
    assert.equal((await client.call("team")).state, "done");
    await core.restart();
    assert.equal((await client.call("team")).state, "done", `after restart ${round + 1}`);
  }
});
