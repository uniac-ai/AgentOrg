/**
 * Private conversation queries through ordinary admitted SDK/MCP calls: forward reads by opaque
 * `next` or `seq`, newest windows and `older` positions, with and without a counterparty.
 */
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

test("private pair/direction qualify before pagination; newest windows and older positions retain chronological history", async (t) => {
  const { core, root, owner, peer, other } = await fixture(t);
  const catalog = await owner.client.available();
  assert.equal(catalog.length, 10);
  assert.equal(catalog.flatMap((tool) => tool.interfaces).length, 28);
  assert.deepEqual(await peer.client.available(), catalog);
  const offered = catalog
    .flatMap((tool) => tool.interfaces)
    .find((item) => item.call === "message_list");
  assert.ok(offered);
  const properties = offered.interface.input.properties as Record<string, unknown>;
  assert.deepEqual(Object.keys(properties).sort(), [
    "after",
    "before",
    "counterpartyID",
    "direction",
    "limit",
  ]);
  assert.equal(offered.read_only, true);
  assert.deepEqual(BUILTINS.message_list.request.parse({}), { limit: 50, direction: "all" });
  const pairs: Row[] = [],
    incoming: Row[] = [],
    outgoing: Row[] = [],
    everything: Row[] = [];
  for (let i = 0; i < 130; i++) {
    const noise = await send(owner.client, other.id, `noise-${i}`);
    const left = await send(peer.client, owner.id, `incoming-${i}`),
      right = await send(owner.client, peer.id, `outgoing-${i}`);
    pairs.push(left, right);
    incoming.push(left);
    outgoing.push(right);
    everything.push(noise, left, right);
  }
  const named = { [owner.id]: { name: "owner" }, [peer.id]: { name: "peer" } };
  const traverse = async (direction: string) => {
    let after: string | undefined;
    const rows: Row[] = [];
    while (true) {
      const page = await list(owner.client, {
        counterpartyID: peer.id,
        direction,
        ...(after === undefined ? {} : { after }),
        limit: 100,
      });
      assert.deepEqual(Object.keys(page).sort(), ["actors", "items", "next", "older"]);
      assert.deepEqual(page.actors, named);
      rows.push(...page.items);
      if (page.next === null) return rows;
      after = page.next;
    }
  };
  assert.deepEqual(await traverse("all"), pairs);
  assert.deepEqual(await traverse("incoming"), incoming);
  assert.deepEqual(await traverse("outgoing"), outgoing);
  assert.deepEqual((await list(owner.client, { counterpartyID: ` ${peer.id} `, limit: 1 })).items, [
    pairs[0],
  ]);
  assert.deepEqual(
    (await list(owner.client, { counterpartyID: peer.id, after: pairs[9]?.seq, limit: 2 })).items,
    pairs.slice(10, 12),
  );
  let recent = await list(owner.client, { counterpartyID: peer.id, before: "latest", limit: 20 });
  assert.deepEqual(recent.items, pairs.slice(-20));
  assert.equal(recent.next, null);
  const all = [...recent.items];
  while (recent.older !== null) {
    recent = await list(owner.client, {
      counterpartyID: peer.id,
      before: recent.older,
      limit: 20,
    });
    all.unshift(...recent.items);
  }
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
        before: "latest",
        limit: 3,
      })
    ).items,
    outgoing.slice(-3),
  );
  assert.deepEqual(
    (await list(owner.client, { before: "latest", limit: 3 })).items,
    everything.slice(-3),
  );
  for (const client of [root, other.client])
    assert.deepEqual(await list(client, { counterpartyID: peer.id, before: "latest" }), {
      items: [],
      next: null,
      older: null,
      actors: {},
    });
  assert.deepEqual(await list(owner.client, { counterpartyID: "unknown", before: "latest" }), {
    items: [],
    next: null,
    older: null,
    actors: {},
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
  assert.deepEqual(await list(owner.client, { counterpartyID: peer.id, after: self.seq }), {
    items: [],
    next: null,
    older: null,
    actors: {},
  });
  profile.mock.restore();
  const closed = await list(owner.client, { counterpartyID: peer.id, before: "latest", limit: 20 });
  assert.deepEqual(closed.items, pairs.slice(-20));
  assert.deepEqual(closed.actors, named, "the closed peer stays named in the directory");
  assert.deepEqual(core.store.workspace.messages.all(), before);
  await core.restart();
  const reopened = await core.client(owner.credential);
  assert.deepEqual(
    (await list(reopened, { counterpartyID: peer.id, before: "latest", limit: 20 })).items,
    pairs.slice(-20),
  );
});

test("newest window observes the head once; older positions and own sends cannot skip the forward tail resumed by seq", async (t) => {
  const { core, owner, peer } = await fixture(t);
  const first = await send(peer.client, owner.id, "first"),
    second = await send(peer.client, owner.id, "second");
  const head = t.mock.method(core.store.workspace.messages, "head");
  const recent = await list(owner.client, { counterpartyID: peer.id, before: "latest", limit: 1 });
  assert.equal(head.mock.callCount(), 1);
  head.mock.restore();
  assert.deepEqual(recent.items, [second]);
  assert.equal(recent.next, null);
  assert.equal(typeof recent.older, "string");
  const unseen = await send(peer.client, owner.id, "unseen inbound"),
    own = await send(owner.client, peer.id, "own send does not advance the tail");
  const older = await list(owner.client, { counterpartyID: peer.id, before: recent.older });
  assert.deepEqual(older, {
    items: [first],
    next: older.next,
    older: null,
    actors: { [peer.id]: { name: "peer" }, [owner.id]: { name: "owner" } },
  });
  assert.equal(typeof older.next, "string", "an older page continues toward newer rows");
  assert.deepEqual(
    (await list(owner.client, { counterpartyID: peer.id, after: older.next ?? undefined })).items,
    [second, unseen, own],
  );
  assert.deepEqual(
    (await list(owner.client, { counterpartyID: peer.id, after: second.seq })).items,
    [unseen, own],
  );
  assert.deepEqual(
    (
      await list(owner.client, {
        counterpartyID: peer.id,
        direction: "incoming",
        after: second.seq,
      })
    ).items,
    [unseen],
  );
  assert.deepEqual(
    (await list(owner.client, { counterpartyID: peer.id, before: "latest" })).items,
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
  const window = await list(owner.client, { counterpartyID: peer.id, before: "latest" });
  assert.deepEqual(window.items, [first, second, unseen, own]);
  assert.equal(window.next, null);
  assert.ok(appended);
  const last = await appended;
  assert.deepEqual((await list(owner.client, { counterpartyID: peer.id, after: own.seq })).items, [
    last,
  ]);
});

test("invalid/refused/unexpected selected queries never call System diagnostics; public failures remain observable", async (t) => {
  const { core, root, owner, peer } = await fixture(t);
  for (const text of ["one", "two"]) await send(peer.client, owner.id, text);
  const incoming = await list(owner.client, { direction: "incoming", limit: 1 });
  assert.equal(typeof incoming.next, "string");
  const recorded = t.mock.method(core.org.diagnostics, "record");
  const invalid = [
    { counterpartyID: peer.id, before: "latest", after: 1 },
    ...[0, 1, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "newest", "", null, true].map((before) => ({
      counterpartyID: peer.id,
      before,
    })),
    { direction: "outgoing", after: incoming.next },
    { direction: "incoming", counterpartyID: peer.id, after: incoming.next },
    { direction: "incoming", before: incoming.next },
    { counterpartyID: " " },
    { counterpartyID: peer.id, before: "latest", actorID: core.rootId },
    { counterpartyID: peer.id, before: "latest", limit: 101 },
    { counterpartyID: peer.id, before: "latest", direction: "wrong" },
    { counterpartyID: peer.id, after: -1 },
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
