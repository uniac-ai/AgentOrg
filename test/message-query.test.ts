/**
 * Conversation queries through ordinary admitted SDK/MCP calls: one pair's conversation by
 * `between` or `counterpartyID`, read forward by opaque `next` or `seq` or as newest windows with
 * `older` positions, by any Actor; and an Actor's conversations by `of`, newest first.
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

test("one pair's conversation qualifies before pagination for any reader; newest windows and older positions keep its order", async (t) => {
  const { core, root, owner, peer, other } = await fixture(t);
  const catalog = await owner.client.available();
  assert.equal(catalog.length, 9);
  assert.equal(catalog.flatMap((tool) => tool.interfaces).length, 26);
  assert.deepEqual(await peer.client.available(), catalog);
  const offered = catalog
    .flatMap((tool) => tool.interfaces)
    .find((item) => item.call === "message_list");
  assert.ok(offered);
  const properties = offered.interface.input.properties as Record<string, unknown>;
  assert.deepEqual(Object.keys(properties).sort(), [
    "after",
    "before",
    "between",
    "counterpartyID",
    "limit",
    "of",
  ]);
  assert.equal(offered.read_only, true);
  assert.equal(BUILTINS.message_list.request.safeParse({}).success, false, "one selector is named");
  assert.deepEqual(BUILTINS.message_list.request.parse({ counterpartyID: "x" }), {
    counterpartyID: "x",
    limit: 50,
  });
  const pairs: Row[] = [];
  let noise: Row | undefined;
  for (let i = 0; i < 130; i++) {
    noise = await send(owner.client, other.id, `noise-${i}`);
    pairs.push(
      await send(peer.client, owner.id, `incoming-${i}`),
      await send(owner.client, peer.id, `outgoing-${i}`),
    );
  }
  const named = { [owner.id]: { name: "owner" }, [peer.id]: { name: "peer" } };
  const traverse = async (client: Actor, selector: Record<string, unknown>) => {
    let after: string | undefined;
    const rows: Row[] = [];
    while (true) {
      const page = await list(client, {
        ...selector,
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
  assert.deepEqual(await traverse(owner.client, { counterpartyID: peer.id }), pairs);
  for (const reader of [owner.client, peer.client, other.client, root])
    for (const between of [
      [owner.id, peer.id],
      [peer.id, owner.id],
    ])
      assert.deepEqual(await traverse(reader, { between }), pairs, "any Actor reads any pair");
  assert.deepEqual((await list(owner.client, { counterpartyID: ` ${peer.id} `, limit: 1 })).items, [
    pairs[0],
  ]);
  assert.deepEqual(
    (await list(owner.client, { counterpartyID: peer.id, after: pairs[9]?.seq, limit: 2 })).items,
    pairs.slice(10, 12),
  );
  let recent = await list(other.client, {
    between: [owner.id, peer.id],
    before: "latest",
    limit: 20,
  });
  assert.deepEqual(recent.items, pairs.slice(-20));
  assert.equal(recent.next, null);
  const all = [...recent.items];
  while (recent.older !== null) {
    recent = await list(other.client, {
      between: [owner.id, peer.id],
      before: recent.older,
      limit: 20,
    });
    all.unshift(...recent.items);
  }
  assert.deepEqual(all, pairs);
  const conversations = await list(root, { of: owner.id });
  assert.deepEqual(
    conversations.items,
    [pairs.at(-1), noise],
    "an Actor's conversations, newest first, each as its latest message",
  );
  assert.equal(conversations.next, null);
  assert.deepEqual(await list(owner.client, { counterpartyID: "unknown", before: "latest" }), {
    items: [],
    next: null,
    older: null,
    actors: {},
  });
  assert.equal(
    await refused(owner.client.call("message_send", { recipientID: owner.id, text: "self" })),
    "invalid",
    "an Actor doesn't message itself",
  );
  await done(root.call("actor_close", { actor: peer.id }));
  const get = core.store.actors.get.bind(core.store.actors);
  const profile = t.mock.method(core.store.actors, "get", (id: string) => {
    assert.notEqual(id, peer.id, "selection cannot resolve a closed peer");
    return get(id);
  });
  const before = core.store.workspace.messages.where({});
  assert.deepEqual(
    await list(owner.client, { counterpartyID: peer.id, after: pairs.at(-1)?.seq }),
    { items: [], next: null, older: null, actors: {} },
  );
  profile.mock.restore();
  const closed = await list(owner.client, { counterpartyID: peer.id, before: "latest", limit: 20 });
  assert.deepEqual(closed.items, pairs.slice(-20));
  assert.deepEqual(closed.actors, named, "the closed peer stays named in actors");
  assert.deepEqual(core.store.workspace.messages.where({}), before);
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
    (await list(owner.client, { counterpartyID: peer.id, before: "latest" })).items,
    [first, second, unseen, own],
  );
  const where = core.store.workspace.messages.where.bind(core.store.workspace.messages);
  let appended: Promise<Row> | undefined;
  const snapshot = t.mock.method(core.store.workspace.messages, "where", (filter: object) => {
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
    return where(filter);
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
  const { core, root, owner, peer, other } = await fixture(t);
  for (const text of ["one", "two"]) await send(peer.client, owner.id, text);
  await send(other.client, owner.id, "three");
  const pair = await list(owner.client, { counterpartyID: peer.id, limit: 1 });
  const conversations = await list(owner.client, { of: owner.id, limit: 1 });
  assert.equal(typeof pair.next, "string");
  assert.equal(typeof conversations.next, "string");
  const recorded = t.mock.method(core.org.diagnostics, "record");
  const invalid = [
    {},
    { after: 1 },
    { direction: "incoming", counterpartyID: peer.id },
    { counterpartyID: peer.id, between: [owner.id, peer.id] },
    { counterpartyID: peer.id, of: owner.id },
    { between: [owner.id] },
    { between: [owner.id, peer.id, other.id] },
    { counterpartyID: peer.id, before: "latest", after: 1 },
    ...[0, 1, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "newest", "", null, true].map((before) => ({
      counterpartyID: peer.id,
      before,
    })),
    { of: owner.id, before: "latest" },
    { of: owner.id, after: 1 },
    { of: owner.id, after: pair.next },
    { counterpartyID: peer.id, after: conversations.next },
    { counterpartyID: peer.id, before: pair.next },
    { between: [owner.id, other.id], after: pair.next },
    { counterpartyID: " " },
    { counterpartyID: peer.id, before: "latest", actorID: core.rootId },
    { counterpartyID: peer.id, before: "latest", limit: 101 },
    { counterpartyID: peer.id, after: -1 },
    { counterpartyID: peer.id, after: 99 },
  ];
  for (const input of invalid)
    assert.equal(
      await refused(owner.client.call("message_list", input)),
      "invalid",
      JSON.stringify(input),
    );
  const storage = t.mock.method(core.store.workspace.messages, "where", () => {
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
