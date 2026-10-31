/** Authenticated caller presence, revocation and reconnection on real Hub sockets. */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";
import { connectClient } from "../src/actor/index.ts";
import { CONNECTION_PATH } from "../src/connection/index.ts";
import { organization } from "../src/domain/index.ts";
import { CLOSE_REVOKED } from "../src/network/index.ts";
import { rootCredential } from "../src/server/index.ts";
import { SqliteStore } from "../src/storage/sqlite/index.ts";
import { startCore, until } from "./harness.ts";

test("the first start creates private root credentials and rotating them keeps the Actor identity", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agentorg-root-"));
  const store = new SqliteStore(join(directory, "core.db"));
  try {
    const file = join(directory, "root-credential");
    const { registry } = organization(store);
    const credential = await rootCredential(registry, file);
    const root = registry.root();
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(readFileSync(join(directory, "root-actor"), "utf8").trim(), root?.id);
    assert.equal(statSync(join(directory, "root-actor")).mode & 0o777, 0o600);
    assert.equal((await registry.byCredential(credential))?.id, root?.id);
    assert.equal(await rootCredential(registry, file), credential);
    rmSync(file);
    const rotated = await rootCredential(registry, file);
    assert.notEqual(rotated, credential);
    assert.equal(await registry.byCredential(credential), undefined);
    assert.equal(registry.root()?.id, root?.id);
    writeFileSync(file, "not-the-credential\n", { mode: 0o600 });
    await assert.rejects(rootCredential(registry, file), /does not hold the root's credential/);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Actor admission requires the matching credential and refuses a browser Origin", async (t) => {
  const core = await startCore();
  t.after(() => core.close());
  for (const identity of [
    { actorId: core.rootId },
    { actorId: core.rootId, credential: "sentinel-not-a-credential" },
    { actorId: "missing-actor", credential: core.root },
  ])
    await assert.rejects(connectClient({ url: core.url, ...identity }), /admission/);
  const fromPage = await new Promise<boolean>((resolve) => {
    const socket = new WebSocket(`${core.url.replace("http", "ws")}${CONNECTION_PATH}`, {
      headers: { Origin: "http://evil.test" },
    });
    socket.on("open", () => {
      socket.close();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
  assert.equal(fromPage, false);
  assert.equal((await (await core.client(core.root)).call("team")).state, "done");
});

test("multiple admitted caller sockets coexist and presence ends only after the last closes", async (t) => {
  const core = await startCore();
  t.after(() => core.close());
  const { actor, credential } = await core.org.registry.create(core.rootId, "worker", "Work");
  assert.equal(core.org.connections.connected(actor.id), false);
  const first = await core.client(credential);
  const second = await core.client(credential);
  assert.equal(core.org.connections.connected(actor.id), true);
  assert.equal(first.ended, undefined);
  assert.equal((await first.call("team")).state, "done");
  await first.close();
  assert.equal((await second.call("team")).state, "done");
  assert.equal(core.org.connections.connected(actor.id), true);
  await second.close();
  await until("the final caller closes", () => !core.org.connections.connected(actor.id));
});

test("Actor closure revokes every admitted socket and refuses its credential thereafter", async (t) => {
  const core = await startCore();
  t.after(() => core.close());
  const { actor, credential } = await core.org.registry.create(core.rootId, "worker", "Work");
  const first = await core.client(credential);
  const second = await core.client(credential);
  const root = await core.client(core.root);
  assert.equal((await root.call("actor_close", { actor: actor.id })).state, "done");
  await until("all caller sockets are revoked", () =>
    [first, second].every((caller) => caller.ended === CLOSE_REVOKED),
  );
  assert.equal(core.org.connections.connected(actor.id), false);
  for (const caller of [first, second]) await assert.rejects(caller.call("team"));
  await assert.rejects(
    connectClient({ url: core.url, actorId: actor.id, credential }),
    /admission/,
  );
});

test("a caller reconnects with fresh admission after each core restart", async (t) => {
  const core = await startCore();
  t.after(() => core.close());
  const caller = await core.client(core.root);
  for (let round = 0; round < 3; round++) {
    assert.equal((await caller.call("team")).state, "done");
    await core.restart();
    await until(
      `the caller resumes after restart ${round + 1}`,
      async () => (await caller.call("team").catch(() => undefined))?.state === "done",
    );
    assert.equal(core.org.connections.connected(core.rootId), true);
  }
});
