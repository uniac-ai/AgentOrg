/** Private conversation queries through ordinary admitted SDK/MCP calls. */
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import type { z } from "zod";
import type { Actor } from "../src/actor/index.ts";
import { BUILTINS, Message, SystemStatus } from "../src/contract/index.ts";
import { done, refused, startCore } from "./harness.ts";

type Row = z.output<typeof Message>;
const list = async (client: Actor, input: Record<string, unknown> = {}) =>
  BUILTINS.message_list.response.parse(await done(client.call("message_list", input)));
async function fixture(t: TestContext) {
  const core = await startCore();
  t.after(() => core.close());
  const root = await core.client(core.root);
  const make = async (name: string) => {
    const record = await done(root.call("actor_create", { name, purpose: name }));
    return {
      id: record.actor.id as string,
      credential: record.credential as string,
      client: await core.client(record.credential),
    };
  };
  return {
    core,
    root,
    owner: await make("owner"),
    peer: await make("peer"),
    other: await make("other"),
  };
}
const send = async (client: Actor, recipientID: string, text: string) =>
  Message.parse(await done(client.call("message_send", { recipientID, text })));

test("private pair/direction qualify before pagination; recent and older retain chronological history", async (t) => {
  const { core, root, owner, peer, other } = await fixture(t);
  const catalog = await owner.client.available();
  assert.equal(catalog.length, 10);
  assert.equal(catalog.flatMap((tool) => tool.interfaces).length, 27);
  assert.deepEqual(await peer.client.available(), catalog);
  const offered = catalog
    .flatMap((tool) => tool.interfaces)
    .find((item) => item.call === "message_list");
  assert.ok(offered);
  const properties = offered.interface.input.properties as Record<string, unknown>;
  assert.ok(properties.counterpartyID);
  assert.ok(properties.before);
  assert.equal(offered.read_only, true);
  assert.deepEqual(BUILTINS.message_list.request.parse({}), {
    after: 0,
    limit: 50,
    direction: "all",
  });
  const pairs: Row[] = [],
    incoming: Row[] = [],
    outgoing: Row[] = [];
  for (let i = 0; i < 130; i++) {
    await send(owner.client, other.id, `noise-${i}`);
    const left = await send(peer.client, owner.id, `incoming-${i}`),
      right = await send(owner.client, peer.id, `outgoing-${i}`);
    pairs.push(left, right);
    incoming.push(left);
    outgoing.push(right);
  }
  const traverse = async (direction: string) => {
    let after = 0;
    const rows: Row[] = [];
    while (true) {
      const page = await list(owner.client, {
        counterpartyID: peer.id,
        direction,
        after,
        limit: 100,
      });
      assert.deepEqual(Object.keys(page).sort(), ["after", "items"]);
      rows.push(...page.items);
      if (!page.items.length) {
        assert.equal(page.after, after);
        return rows;
      }
      assert.equal(page.after, page.items.at(-1)?.cursor);
      after = page.after;
    }
  };
  assert.deepEqual(await traverse("all"), pairs);
  assert.deepEqual(await traverse("incoming"), incoming);
  assert.deepEqual(await traverse("outgoing"), outgoing);
  assert.deepEqual((await list(owner.client, { counterpartyID: ` ${peer.id} `, limit: 1 })).items, [
    pairs[0],
  ]);
  let recent = await list(owner.client, { counterpartyID: peer.id, before: "latest", limit: 20 });
  assert.deepEqual(recent.items, pairs.slice(-20));
  assert.equal(recent.after, pairs.at(-1)?.cursor);
  const all = [...recent.items];
  while (recent.items.length) {
    recent = await list(owner.client, {
      counterpartyID: peer.id,
      before: recent.items[0]?.cursor,
      limit: 20,
    });
    all.unshift(...recent.items);
  }
  assert.equal(recent.after, 0);
  assert.deepEqual(all, pairs);
  assert.deepEqual(
    (
      await list(owner.client, {
        counterpartyID: peer.id,
        direction: "incoming",
        before: "latest",
        limit: 3,
      })
    ).items,
    incoming.slice(-3),
  );
  assert.deepEqual(
    (
      await list(owner.client, {
        counterpartyID: peer.id,
        direction: "outgoing",
        before: Number.MAX_SAFE_INTEGER,
        limit: 3,
      })
    ).items,
    outgoing.slice(-3),
  );
  for (const client of [root, other.client])
    assert.deepEqual(await list(client, { counterpartyID: peer.id, before: "latest" }), {
      items: [],
      after: 0,
    });
  assert.deepEqual(await list(owner.client, { counterpartyID: "unknown", before: "latest" }), {
    items: [],
    after: 0,
  });
  const self = await send(owner.client, owner.id, "self exactly once");
  for (const direction of ["all", "incoming", "outgoing"])
    assert.deepEqual(
      (await list(owner.client, { counterpartyID: owner.id, direction, before: "latest" })).items,
      [self],
    );
  await done(root.call("actor_close", { actor: peer.id }));
  const get = core.store.actors.get.bind(core.store.actors);
  const profile = t.mock.method(core.store.actors, "get", (id: string) => {
    assert.notEqual(id, peer.id, "selection cannot resolve a closed peer");
    return get(id);
  });
  const before = core.store.workspace.messages.all();
  assert.deepEqual(
    (await list(owner.client, { counterpartyID: peer.id, before: "latest", limit: 20 })).items,
    pairs.slice(-20),
  );
  assert.deepEqual(core.store.workspace.messages.all(), before);
  profile.mock.restore();
  await core.restart();
  const reopened = await core.client(owner.credential);
  assert.deepEqual(
    (await list(reopened, { counterpartyID: peer.id, before: "latest", limit: 20 })).items,
    pairs.slice(-20),
  );
});

test("recent head is observed once; older navigation and own sends cannot skip the forward tail", async (t) => {
  const { core, owner, peer } = await fixture(t);
  const first = await send(peer.client, owner.id, "first"),
    second = await send(peer.client, owner.id, "second");
  const head = t.mock.method(core.store.workspace.messages, "head");
  const recent = await list(owner.client, { counterpartyID: peer.id, before: "latest", limit: 1 });
  assert.equal(head.mock.callCount(), 1);
  head.mock.restore();
  assert.deepEqual(recent.items, [second]);
  const unseen = await send(peer.client, owner.id, "unseen inbound"),
    own = await send(owner.client, peer.id, "own send does not advance the tail");
  assert.deepEqual(
    (await list(owner.client, { counterpartyID: peer.id, before: second.cursor })).items,
    [first],
  );
  assert.deepEqual(
    (await list(owner.client, { counterpartyID: peer.id, after: recent.after })).items,
    [unseen, own],
  );
  assert.deepEqual(
    (
      await list(owner.client, {
        counterpartyID: peer.id,
        direction: "incoming",
        after: recent.after,
      })
    ).items,
    [unseen],
  );
  assert.deepEqual(await list(owner.client, { counterpartyID: peer.id, before: 1 }), {
    items: [],
    after: 0,
  });
  assert.deepEqual(
    (await list(owner.client, { counterpartyID: peer.id, before: Number.MAX_SAFE_INTEGER })).items,
    [first, second, unseen, own],
  );
  const all = core.store.workspace.messages.all.bind(core.store.workspace.messages);
  let appended: Promise<Row> | undefined;
  const snapshot = t.mock.method(core.store.workspace.messages, "all", () => {
    snapshot.mock.restore();
    // Inject a canonical fixture send after this query observed head, before reading rows.
    appended = done(
      core.org.invoke(
        peer.id,
        "message_send",
        { recipientID: owner.id, text: "append after head" },
        { signal: new AbortController().signal, progress: async () => {} },
      ),
    ).then((row) => Message.parse(row));
    return all();
  });
  assert.deepEqual(
    (await list(owner.client, { counterpartyID: peer.id, before: "latest" })).items,
    [first, second, unseen, own],
  );
  assert.ok(appended);
  const last = await appended;
  assert.deepEqual(
    (await list(owner.client, { counterpartyID: peer.id, after: own.cursor })).items,
    [last],
  );
});

test("invalid/refused/unexpected selected queries never call System diagnostics; public failures remain observable", async (t) => {
  const { core, root, owner, peer } = await fixture(t);
  const recorded = t.mock.method(core.org.diagnostics, "record");
  const invalid = [
    { before: "latest" },
    { counterpartyID: peer.id, before: "latest", after: 1 },
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "newest", null, true].map((before) => ({
      counterpartyID: peer.id,
      before,
    })),
    { counterpartyID: " " },
    { counterpartyID: peer.id, before: "latest", actorID: core.rootId },
    { counterpartyID: peer.id, before: "latest", limit: 101 },
    { counterpartyID: peer.id, before: "latest", direction: "wrong" },
  ];
  for (const input of invalid)
    assert.equal(await refused(owner.client.call("message_list", input)), "invalid");
  assert.equal(await refused(owner.client.call("message_list", { after: 99 })), "invalid");
  const storage = t.mock.method(core.store.workspace.messages, "all", () => {
    throw new Error("PRIVATE_QUERY_STORAGE_SENTINEL");
  });
  await assert.rejects(
    owner.client.call("message_list", { counterpartyID: peer.id, before: "latest" }),
    /write outcome may be unknown/,
  );
  storage.mock.restore();
  assert.equal(recorded.mock.callCount(), 0);
  assert.deepEqual(
    SystemStatus.parse(await done(root.call("system_status"))).diagnostics.items,
    [],
  );
  assert.equal(await refused(root.call("work_list", { limit: -1 })), "invalid");
  assert.equal(recorded.mock.callCount(), 1);
  const observed = SystemStatus.parse(await done(root.call("system_status")));
  assert.equal(observed.diagnostics.items[0]?.operation, "work_list");
  const encoded = JSON.stringify(observed.diagnostics);
  for (const secret of [
    peer.id,
    owner.id,
    "PRIVATE_QUERY_",
    "counterpartyID",
    "message_list",
    "before",
  ])
    assert.equal(encoded.includes(secret), false);
});
