/**
 * Workspace records through the real Hub/SDK boundary as ordinary admitted Actors: canonical
 * positions, open Message conversations, shared Work and asks with role-bound writes, opaque list
 * positions, restart survival and unknown write outcomes over MCP.
 */
import assert from "node:assert/strict";
import { dirname } from "node:path";
import { test } from "node:test";
import type { Actor } from "../src/actor/index.ts";
import { done, refused, startCore, until } from "./harness.ts";
import { command } from "./process.ts";

async function members() {
  const core = await startCore();
  const root = await core.client(core.root);
  const make = async (name: string, manager: Actor = root) => {
    const created = await done(manager.call("actor_create", { name, purpose: name }));
    return { id: created.actor.id as string, client: await core.client(created.credential) };
  };
  const owner = await make("owner");
  const peer = await make("peer");
  const third = await make("third");
  return { core, root, owner, peer, third, make };
}

test("positions are canonical, resolve after closure, and are distinct from actual presence", async (t) => {
  const { core, root, owner, peer, third } = await members();
  t.after(() => core.close());
  const [profile] = (await done(owner.client.call("team", { depth: 0 }))).positions;
  assert.deepEqual(
    [profile.id, profile.name, profile.purpose, profile.closed_at],
    [owner.id, "owner", "owner", null],
  );
  const closed = (await done(root.call("actor_close", { actor: owner.id }))).actor;
  assert.ok(closed.closed_at);
  assert.equal(
    (await done(peer.client.call("team", { actor: owner.id, depth: 0 }))).positions[0].closed_at,
    closed.closed_at,
  );
  const team = await done(peer.client.call("team", { actor: core.rootId, depth: 20 }));
  assert.deepEqual(
    team.positions.map((position: { id: string }) => position.id),
    [core.rootId, peer.id, third.id],
  );
  assert.deepEqual(Object.keys(team).sort(), ["positions", "root"]);
  assert.deepEqual(Object.keys(team.positions[0]).sort(), [
    "asks",
    "branchAsks",
    "closed_at",
    "created_at",
    "headline",
    "id",
    "lastActiveAt",
    "manager",
    "name",
    "online",
    "path",
    "purpose",
    "state",
  ]);
  await third.client.close();
  await until(
    "third loses actual admitted presence",
    () => !core.org.connections.connected(third.id),
  );
  const [offline] = (await done(peer.client.call("team", { actor: third.id, depth: 0 }))).positions;
  assert.deepEqual([offline.closed_at, offline.online], [null, false]);
});

test("Messages are immutable P2P conversations that any Actor reads, with no receipt surface", async (t) => {
  const { core, root, owner, peer, third } = await members();
  t.after(() => core.close());
  const sent = await done(
    owner.client.call("message_send", { recipientID: peer.id, text: "Hello" }),
  );
  assert.equal(sent.senderID, owner.id);
  assert.deepEqual(Object.keys(sent).sort(), [
    "conversationID",
    "createdAt",
    "messageID",
    "recipientID",
    "senderID",
    "seq",
    "text",
  ]);
  for (const reader of [owner.client, peer.client, root, third.client])
    assert.deepEqual(await done(reader.call("message_get", { messageID: sent.messageID })), sent);
  const incoming = await done(
    peer.client.call("message_list", { counterpartyID: owner.id, limit: 1 }),
  );
  assert.deepEqual(incoming, {
    items: [sent],
    next: null,
    older: null,
    actors: { [owner.id]: { name: "owner" }, [peer.id]: { name: "peer" } },
  });
  assert.deepEqual(
    await done(peer.client.call("message_list", { counterpartyID: owner.id, after: sent.seq })),
    { items: [], next: null, older: null, actors: {} },
  );
  const reply = await done(
    peer.client.call("message_send", { recipientID: owner.id, text: "Reply" }),
  );
  assert.notEqual(reply.messageID, sent.messageID);
  assert.equal(reply.conversationID, sent.conversationID);
  assert.ok(reply.seq > sent.seq);
  assert.deepEqual(
    await done(owner.client.call("message_get", { messageID: sent.messageID })),
    sent,
  );
  assert.equal(
    await refused(
      owner.client.call("message_send", { recipientID: peer.id, text: "", senderID: third.id }),
    ),
    "invalid",
  );
  for (const retired of [
    "messages",
    "message_read",
    "message_acknowledge",
    "message_handle",
    "question_ask",
    "question_answer",
    "questions",
    "progress",
    "progress_set",
    "status_set",
    "status_get",
    "actor_get",
    "actor_list",
    "form_create",
    "form_get",
    "form_list",
    "form_respond",
    "form_close",
    "work_review",
  ])
    assert.equal(await refused(root.call(retired, {})), "not_found", retired);
});

test("Work retains role authority, revision conflicts, exact submissions and dynamic ownership", async (t) => {
  const { core, root, owner, peer, third } = await members();
  t.after(() => core.close());
  let work = await done(peer.client.call("work_create", { ownerID: owner.id, title: "Build" }));
  assert.equal(work.requesterID, peer.id);
  assert.equal("history" in work, false);
  assert.deepEqual(await done(root.call("work_get", { ticketID: work.ticketID })), {
    ...work,
    asks: [],
  });
  assert.equal(
    await refused(
      owner.client.call("work_update", {
        ticketID: work.ticketID,
        expectedRevision: 1,
        goal: "Change scope",
      }),
    ),
    "forbidden",
  );
  work = await done(
    owner.client.call("work_update", {
      ticketID: work.ticketID,
      expectedRevision: 1,
      status: "active",
      progress: "Building",
    }),
  );
  assert.equal(
    await refused(
      owner.client.call("work_submit", {
        ticketID: work.ticketID,
        expectedRevision: 1,
        result: "Done",
        evidence: [],
      }),
    ),
    "conflict",
  );
  work = await done(
    owner.client.call("work_submit", {
      ticketID: work.ticketID,
      expectedRevision: work.revision,
      result: "Result",
      evidence: ["proof"],
    }),
  );
  const earlier = work.submission.submissionID;
  assert.deepEqual(await done(third.client.call("work_get", { ticketID: work.ticketID })), {
    ...work,
    asks: [],
  });
  assert.equal(
    await refused(
      root.call("work_answer", {
        ticketID: work.ticketID,
        askID: work.submission.submissionID,
        answers: { verdict: "accepted" },
        note: "Not requester",
      }),
    ),
    "forbidden",
  );
  assert.equal(
    await refused(
      peer.client.call("work_answer", {
        ticketID: work.ticketID,
        askID: "wrong",
        answers: { verdict: "accepted" },
        note: "Wrong",
      }),
    ),
    "not_found",
  );
  work = await done(
    peer.client.call("work_answer", {
      ticketID: work.ticketID,
      askID: work.submission.submissionID,
      answers: { verdict: "changes_requested" },
      note: "Revise",
    }),
  );
  work = await done(
    peer.client.call("work_update", {
      ticketID: work.ticketID,
      expectedRevision: work.revision,
      ownerID: third.id,
    }),
  );
  assert.deepEqual(await done(owner.client.call("work_get", { ticketID: work.ticketID })), {
    ...work,
    asks: [],
  });
  assert.equal(
    await refused(
      owner.client.call("work_submit", {
        ticketID: work.ticketID,
        expectedRevision: work.revision,
        result: "Old owner",
        evidence: [],
      }),
    ),
    "forbidden",
  );
  assert.deepEqual((await done(third.client.call("work_list", {}))).items, [{ ...work, asks: [] }]);
  work = await done(
    third.client.call("work_submit", {
      ticketID: work.ticketID,
      expectedRevision: work.revision,
      result: "Revised",
      evidence: [],
    }),
  );
  assert.equal(
    await refused(
      peer.client.call("work_answer", {
        ticketID: work.ticketID,
        askID: earlier,
        answers: { verdict: "accepted" },
      }),
    ),
    "conflict",
  );
  work = await done(
    peer.client.call("work_answer", {
      ticketID: work.ticketID,
      askID: work.submission.submissionID,
      answers: { verdict: "accepted" },
    }),
  );
  assert.equal(work.status, "accepted");
  assert.deepEqual(await done(root.call("work_get", { ticketID: work.ticketID })), {
    ...work,
    asks: [],
  });
  const { history, ...current } = await done(
    root.call("work_get", { ticketID: work.ticketID, history: true }),
  );
  assert.deepEqual(current, { ...work, asks: [] });
  assert.equal(history.length, work.revision);
  assert.equal(
    await refused(
      third.client.call("work_update", {
        ticketID: work.ticketID,
        expectedRevision: work.revision,
        progress: "Late",
      }),
    ),
    "conflict",
  );
});

test("asks on Work have shared full-history reads, owner-only asking, responder-keyed answers and asker-only close", async (t) => {
  const { core, root, owner, peer, third } = await members();
  t.after(() => core.close());
  const fields = [
    {
      name: "choice",
      label: "Choose",
      required: true,
      options: [{ value: "yes" }, { value: "no" }],
    },
  ];
  const own = await done(peer.client.call("work_create", { title: "Asks" }));
  // An ask names no cause and no other Work, and finished Work takes no new ask.
  for (const extra of [{ cause: "form1" }, { workID: own.ticketID }])
    assert.equal(
      await refused(
        peer.client.call("work_update", {
          ticketID: own.ticketID,
          ask: { title: "Extra?", fields, ...extra },
        }),
      ),
      "invalid",
    );
  const finished = await done(peer.client.call("work_create", { title: "Finished" }));
  await done(peer.client.call("work_submit", { ticketID: finished.ticketID, result: "Done" }));
  assert.equal(
    await refused(
      peer.client.call("work_update", {
        ticketID: finished.ticketID,
        ask: { title: "Too late?", fields },
      }),
    ),
    "conflict",
  );
  const ask = (caller: Actor, ticketID: string, input: object) =>
    caller.call("work_update", { ticketID, ask: { fields, ...input } });
  let form = await done(ask(peer.client, own.ticketID, { title: "Choose" }));
  assert.equal(form.workID, own.ticketID);
  assert.deepEqual(await done(third.client.call("work_get", { askID: form.formID })), {
    ...own,
    asks: [form],
  });
  assert.equal(
    await refused(
      root.call("work_update", {
        close: { askID: form.formID, status: "resolved", resolution: "Not requester" },
      }),
    ),
    "forbidden",
  );
  assert.equal(
    await refused(
      owner.client.call("work_answer", { askID: form.formID, answers: { choice: "other" } }),
    ),
    "invalid",
  );
  form = await done(
    owner.client.call("work_answer", {
      askID: form.formID,
      answers: { choice: "yes" },
      note: "Because",
    }),
  );
  assert.equal(form.status, "resolved");
  assert.deepEqual(Object.keys(form.responses), [owner.id]);
  assert.deepEqual(form.responses[owner.id], {
    answers: { choice: "yes" },
    note: "Because",
    at: form.updatedAt,
  });
  for (const caller of [third.client, peer.client])
    assert.equal(
      await refused(caller.call("work_answer", { askID: form.formID, answers: { choice: "no" } })),
      "conflict",
    );
  let poll = await done(ask(peer.client, own.ticketID, { title: "Collect", collect: true }));
  for (const [caller, choice] of [
    [owner.client, "yes"],
    [third.client, "no"],
    [owner.client, "no"],
  ] as const)
    poll = await done(caller.call("work_answer", { askID: poll.formID, answers: { choice } }));
  assert.equal(poll.status, "open");
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(poll.responses).map(([id, response]) => [
        id,
        (response as { answers: unknown }).answers,
      ]),
    ),
    { [owner.id]: { choice: "no" }, [third.id]: { choice: "no" } },
  );
  for (const caller of [root, owner.client])
    assert.equal(
      await refused(
        caller.call("work_update", {
          close: { askID: poll.formID, status: "resolved", resolution: "Not requester" },
        }),
      ),
      "forbidden",
    );
  poll = await done(
    peer.client.call("work_update", {
      close: { askID: poll.formID, status: "resolved", resolution: "Decided" },
    }),
  );
  assert.equal(
    await refused(
      owner.client.call("work_answer", { askID: poll.formID, answers: { choice: "yes" } }),
    ),
    "conflict",
  );
  assert.deepEqual(
    (await done(owner.client.call("work_get", { ticketID: own.ticketID }))).asks.map(
      (item: { formID: string }) => item.formID,
    ),
    [form.formID, poll.formID],
  );
  assert.equal(await refused(ask(peer.client, "missing", { title: "Missing Work" })), "not_found");
  const work = await done(peer.client.call("work_create", { ownerID: owner.id, title: "Linked" }));
  assert.equal(
    await refused(ask(third.client, work.ticketID, { title: "Not the owner's" })),
    "forbidden",
  );
  const linked = await done(ask(owner.client, work.ticketID, { title: "Linked ask" }));
  assert.equal(
    (await done(owner.client.call("work_get", { askID: linked.formID }))).ticketID,
    work.ticketID,
  );
  assert.deepEqual(await done(third.client.call("work_get", { ticketID: work.ticketID })), {
    ...work,
    asks: [linked],
  });
  await done(
    peer.client.call("work_update", {
      ticketID: work.ticketID,
      expectedRevision: 1,
      ownerID: third.id,
    }),
  );
  const [reassigned] = (await done(owner.client.call("work_get", { askID: linked.formID }))).asks;
  assert.deepEqual(
    [reassigned.formID, reassigned.status, reassigned.resolution.reason],
    [linked.formID, "cancelled", "reassigned"],
  );
  assert.deepEqual((await done(root.call("work_get", { askID: form.formID }))).asks, [form, poll]);
  const { history, ...current } = (
    await done(root.call("work_get", { askID: poll.formID, history: true }))
  ).asks[1];
  assert.deepEqual(current, poll);
  assert.equal(history.length, poll.revision);
});

test("claims remain Hub-owned and close/expiry release eligibility without Workspace side effects", async (t) => {
  let instant = Date.parse("2026-10-30T00:00:00Z");
  const core = await startCore({ now: () => new Date(instant) });
  t.after(() => core.close());
  const root = await core.client(core.root);
  const child = await done(root.call("actor_create", { name: "worker", purpose: "Work" }));
  const actor = await core.client(child.credential);
  await done(actor.call("claim", { resource: "lane", note: "Use", until: "2026-10-30T00:01:00Z" }));
  assert.equal(await refused(root.call("claim", { resource: "lane", note: "Other" })), "conflict");
  instant += 61_000;
  await done(root.call("claim", { resource: "lane", note: "Now" }));
  assert.equal(await refused(actor.call("release", { resource: "lane" })), "forbidden");
  await done(root.call("release", { resource: "lane" }));
  await done(actor.call("claim", { resource: "lane", note: "Again" }));
  await done(root.call("actor_close", { actor: child.actor.id }));
  await done(root.call("claim", { resource: "lane", note: "Closed owner" }));
});

test("Workspace state and list positions survive a Hub restart under the same admitted identity", async (t) => {
  const { core, root, owner, peer, third } = await members();
  t.after(() => core.close());
  await done(root.call("message_send", { recipientID: third.id, text: "Unrelated" }));
  const sent = await done(
    owner.client.call("message_send", { recipientID: peer.id, text: "Kept" }),
  );
  const later = await done(
    owner.client.call("message_send", { recipientID: peer.id, text: "Kept later" }),
  );
  const work = await done(
    owner.client.call("work_create", { ownerID: peer.id, title: "Keep Work" }),
  );
  const form = await done(
    peer.client.call("work_update", {
      ticketID: work.ticketID,
      ask: { title: "Keep ask", fields: [{ name: "answer", label: "Answer", required: true }] },
    }),
  );
  const page = await done(peer.client.call("message_list", { counterpartyID: owner.id, limit: 1 }));
  assert.deepEqual(page.items, [sent], "other pairs' rows do not exhaust the page limit");
  assert.equal(typeof page.next, "string");
  await core.restart();
  await until("the SDK reconnects for read-only checks", async () => {
    try {
      return (
        (await peer.client.call("message_get", { messageID: sent.messageID })).state === "done"
      );
    } catch {
      return false;
    }
  });
  assert.deepEqual(
    await done(peer.client.call("message_get", { messageID: sent.messageID })),
    sent,
  );
  assert.deepEqual(await done(peer.client.call("work_get", { ticketID: work.ticketID })), {
    ...work,
    asks: [form],
  });
  assert.deepEqual(await done(owner.client.call("work_get", { askID: form.formID })), {
    ...work,
    asks: [form],
  });
  const resumed = await done(
    peer.client.call("message_list", { counterpartyID: owner.id, after: page.next }),
  );
  assert.deepEqual(resumed.items, [later]);
  assert.equal(resumed.next, null);
  assert.deepEqual(
    (await done(peer.client.call("message_list", { counterpartyID: owner.id, after: later.seq })))
      .items,
    [],
  );
});

test("unexpected write failures keep unknown outcome over MCP and never become no-effect refusals", async (t) => {
  const { core, owner, peer } = await members();
  t.after(() => core.close());
  const store = core.store.workspace;
  const transaction = store.transaction.bind(store);
  const injected = t.mock.method(store, "transaction", (callback: () => unknown) => {
    const result = transaction(callback);
    throw new Error(`private failure after commit ${String(result)}`);
  });
  await assert.rejects(
    owner.client.call("message_send", { recipientID: peer.id, text: "Committed once" }),
    /Hub operation failed; a write outcome may be unknown/,
  );
  injected.mock.restore();
  const received = await done(peer.client.call("message_list", { counterpartyID: owner.id }));
  assert.equal(received.items.length, 1, "the committed send is stored exactly once");
  assert.equal(received.items[0].text, "Committed once");
  const append = t.mock.method(core.store.audit, "append", () => {
    throw new Error("private audit error");
  });
  await assert.rejects(
    owner.client.call("message_send", { recipientID: peer.id, text: "Audit failed after commit" }),
    /write outcome may be unknown/,
  );
  append.mock.restore();
  assert.equal(
    (await done(peer.client.call("message_list", { counterpartyID: owner.id }))).items.length,
    2,
  );
});

test("Work filters AND before pagination, positions continue only their filter, and queries never select the caller's identity", async (t) => {
  const { core, root, owner, peer, third } = await members();
  t.after(() => core.close());
  const active = async (caller: Actor, ownerID: string, title: string) => {
    const work = await done(caller.call("work_create", { ownerID, title }));
    return done(
      (ownerID === owner.id ? owner.client : third.client).call("work_update", {
        ticketID: work.ticketID,
        expectedRevision: 1,
        status: "active",
      }),
    );
  };
  await active(root, owner.id, "Wrong requester");
  const first = await active(peer.client, owner.id, "First match");
  await active(peer.client, third.id, "Wrong owner");
  await done(peer.client.call("work_create", { ownerID: owner.id, title: "Wrong status" }));
  const second = await active(peer.client, owner.id, "Second match");
  const filter = { ownerID: owner.id, requesterID: peer.id, status: ["active"], limit: 1 };
  const actors = { [peer.id]: { name: "peer" }, [owner.id]: { name: "owner" } };
  const page = await done(third.client.call("work_list", filter));
  assert.deepEqual(page.items, [{ ...first, asks: [] }]);
  assert.deepEqual(page.actors, actors);
  assert.equal(typeof page.next, "string");
  assert.deepEqual(await done(third.client.call("work_list", { ...filter, after: page.next })), {
    items: [{ ...second, asks: [] }],
    next: null,
    actors,
  });
  for (const other of [{ ownerID: third.id }, { status: ["open"] }, { order: "recent" }])
    assert.equal(
      await refused(third.client.call("work_list", { ...filter, ...other, after: page.next })),
      "invalid",
    );
  assert.equal((await done(third.client.call("team", { depth: 0 }))).positions[0].id, third.id);
  assert.equal(
    await refused(
      third.client.call("work_update", {
        ticketID: first.ticketID,
        expectedRevision: first.revision,
        progress: "Query is not impersonation",
      }),
    ),
    "forbidden",
  );
  for (const unknown of [{ ownerID: "unknown-actor" }, { requesterID: "unknown-actor" }])
    assert.deepEqual(await done(third.client.call("work_list", unknown)), {
      items: [],
      next: null,
      actors: {},
    });
  for (const bad of [
    { status: "active" },
    { status: ["closed"] },
    { status: ["blocked"] },
    { ownerID: "" },
    { requesterID: 1 },
    { after: 1 },
  ])
    assert.equal(await refused(root.call("work_list", bad)), "invalid");
});

test("a Work's asks come with it, all from work_get and the open ones from work_list, and an empty answer is kept under its responder", async (t) => {
  const { core, root, owner, third } = await members();
  t.after(() => core.close());
  const work = await done(
    root.call("work_create", { ownerID: third.id, title: "Shared association" }),
  );
  const other = await done(root.call("work_create", { ownerID: third.id, title: "Other Work" }));
  const fields = [{ name: "answer", label: "Optional answer", required: false }];
  const create = (title: string, ticketID = work.ticketID) =>
    done(third.client.call("work_update", { ticketID, ask: { title, fields } }));
  const own = await done(root.call("work_create", { title: "The root's own" }));
  assert.equal(
    await refused(
      root.call("work_update", { ticketID: own.ticketID, ask: { title: "Root", fields } }),
    ),
    "forbidden",
  );
  const answered = await create("Answered");
  await done(owner.client.call("work_answer", { askID: answered.formID, answers: {} }));
  const closed = await create("Cancelled");
  await done(
    third.client.call("work_update", {
      close: { askID: closed.formID, status: "cancelled", resolution: "No longer needed" },
    }),
  );
  await create("On other Work", other.ticketID);
  const first = await create("First match");
  const second = await create("Second match");
  const read = await done(root.call("work_get", { ticketID: work.ticketID }));
  assert.deepEqual(
    read.asks.map((item: { formID: string; status: string }) => [item.formID, item.status]),
    [
      [answered.formID, "resolved"],
      [closed.formID, "cancelled"],
      [first.formID, "open"],
      [second.formID, "open"],
    ],
  );
  const listed = (await done(root.call("work_list", { ownerID: third.id }))).items.find(
    (item: { ticketID: string }) => item.ticketID === work.ticketID,
  );
  assert.deepEqual(listed.asks, [first, second]);
  const response = (await done(root.call("work_get", { askID: answered.formID }))).asks[0];
  assert.deepEqual(Object.keys(response.responses), [owner.id]);
  assert.deepEqual(response.responses[owner.id].answers, {});
  assert.equal((await done(root.call("team", { depth: 0 }))).positions[0].id, core.rootId);
});

test("shared Work/Form history and Hub diagnostics do not disclose Message data", async (t) => {
  const { core, root, owner, peer, third } = await members();
  t.after(() => core.close());
  const work = await done(
    owner.client.call("work_create", { ownerID: peer.id, title: "Public goal" }),
  );
  const secret = "private-p2p-body-sentinel";
  const message = await done(
    owner.client.call("message_send", { recipientID: peer.id, text: secret }),
  );
  let form = await done(
    peer.client.call("work_update", {
      ticketID: work.ticketID,
      ask: {
        title: "Public question",
        fields: [{ name: "answer", label: "Public question", required: true }],
      },
    }),
  );
  form = await done(
    owner.client.call("work_answer", {
      askID: form.formID,
      answers: { answer: "Public response" },
    }),
  );
  const changed = await done(
    peer.client.call("work_update", {
      ticketID: work.ticketID,
      expectedRevision: 1,
      progress: "Public progress",
      status: "active",
    }),
  );
  const projections: unknown[] = [];
  for (const observer of [root, third.client]) {
    assert.deepEqual(await done(observer.call("work_get", { ticketID: work.ticketID })), {
      ...changed,
      asks: [form],
    });
    assert.deepEqual(await done(observer.call("work_get", { askID: form.formID })), {
      ...changed,
      asks: [form],
    });
    const histories = await done(observer.call("work_get", { askID: form.formID, history: true }));
    assert.deepEqual(
      [histories, ...histories.asks].map((record) => record.history.length),
      [2, 2],
    );
    projections.push(histories);
    for (const name of ["work_list", "team"]) projections.push(await done(observer.call(name, {})));
    projections.push(await observer.call("activity", {}), await observer.available());
    assert.deepEqual(
      await done(observer.call("message_get", { messageID: message.messageID })),
      message,
    );
    for (const query of [{ between: [owner.id, peer.id] }, { of: owner.id }, { of: peer.id }])
      assert.deepEqual((await done(observer.call("message_list", query))).items, [message]);
    for (const query of [
      { counterpartyID: owner.id, before: "latest" },
      { counterpartyID: peer.id, before: "latest" },
    ]) {
      const inbox = await done(observer.call("message_list", query));
      assert.deepEqual(inbox, { items: [], next: null, older: null, actors: {} });
      projections.push(inbox);
    }
  }
  const status = await command("server", ["status"], {
    AGENTORG_HOME: dirname(core.credentialFile),
    AGENTORG_URL: core.url,
  });
  projections.push(status.stdout, status.stderr);
  const injected = t.mock.method(core.store.workspace.messages, "get", () => {
    throw new Error(`${secret} read_at=private`);
  });
  await assert.rejects(
    third.client.call("message_get", { messageID: message.messageID }),
    (error) => {
      projections.push(String(error));
      return String(error).includes("write outcome may be unknown");
    },
  );
  injected.mock.restore();
  assert.deepEqual(
    await done(peer.client.call("message_get", { messageID: message.messageID })),
    message,
  );
  const output = JSON.stringify(projections);
  assert.equal(output.includes(secret), false);
  assert.doesNotMatch(output, /"(?:read_at|readAt|handledAt|unread|deliveryStatus)"/);
});
