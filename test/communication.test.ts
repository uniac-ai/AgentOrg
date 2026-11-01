/** Workspace records through the real Hub/SDK boundary as ordinary admitted Actors. */
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

test("directory is canonical, stable across closure, and distinct from actual presence", async (t) => {
  const { core, root, owner, peer, third } = await members();
  t.after(() => core.close());
  const profile = await done(owner.client.call("actor_get"));
  assert.deepEqual(profile, {
    actorID: owner.id,
    name: "owner",
    purpose: "owner",
    state: "active",
  });
  const first = await done(root.call("actor_list", { limit: 2 }));
  assert.deepEqual(
    first.items.map((actor: { actorID: string }) => actor.actorID),
    [core.rootId, owner.id],
  );
  await done(root.call("actor_close", { actor: owner.id }));
  assert.equal((await done(peer.client.call("actor_get", { actorID: owner.id }))).state, "closed");
  const remaining = await done(root.call("actor_list", { after: first.after }));
  assert.deepEqual(
    remaining.items.map((actor: { actorID: string }) => actor.actorID),
    [peer.id, third.id],
  );
  assert.equal(await refused(root.call("actor_list", { after: 999 })), "invalid");
  const team = await done(peer.client.call("team", { actor: core.rootId, depth: 20 }));
  assert.deepEqual(Object.keys(team).sort(), ["positions", "root"]);
  assert.deepEqual(Object.keys(team.positions[0]).sort(), [
    "closed_at",
    "created_at",
    "id",
    "manager",
    "name",
    "online",
    "path",
    "purpose",
  ]);
  await third.client.close();
  await until(
    "third loses actual admitted presence",
    () => !core.org.connections.connected(third.id),
  );
  assert.equal((await done(peer.client.call("actor_get", { actorID: third.id }))).state, "active");
  assert.equal(
    (await done(peer.client.call("team", { actor: third.id, depth: 0 }))).positions[0].online,
    false,
  );
});

test("Messages are immutable P2P correspondence with no manager/root bypass or receipt surface", async (t) => {
  const { core, root, owner, peer, third } = await members();
  t.after(() => core.close());
  const sent = await done(
    owner.client.call("message_send", { recipientID: peer.id, text: "Hello" }),
  );
  assert.equal(sent.senderID, owner.id);
  assert.deepEqual(Object.keys(sent).sort(), [
    "createdAt",
    "cursor",
    "history",
    "messageID",
    "recipientID",
    "revision",
    "senderID",
    "text",
  ]);
  assert.equal(sent.history[0].action, "sent");
  for (const stranger of [root, third.client])
    assert.equal(
      await refused(stranger.call("message_get", { messageID: sent.messageID })),
      "not_found",
    );
  for (const party of [owner.client, peer.client])
    assert.deepEqual(await done(party.call("message_get", { messageID: sent.messageID })), sent);
  const incoming = await done(
    peer.client.call("message_list", { direction: "incoming", limit: 1 }),
  );
  assert.deepEqual(incoming.items, [sent]);
  assert.deepEqual(
    await done(peer.client.call("message_list", { direction: "incoming", after: incoming.after })),
    { items: [], after: incoming.after },
  );
  const reply = await done(
    peer.client.call("message_send", { recipientID: owner.id, text: "Reply" }),
  );
  assert.notEqual(reply.messageID, sent.messageID);
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
  ])
    assert.equal(await refused(root.call(retired, {})), "not_found", retired);
});

test("Work retains role authority, revision conflicts, exact submissions and dynamic ownership", async (t) => {
  const { core, root, owner, peer, third } = await members();
  t.after(() => core.close());
  let work = await done(peer.client.call("work_create", { ownerID: owner.id, goal: "Build" }));
  assert.equal(work.requesterID, peer.id);
  assert.deepEqual(await done(root.call("work_get", { ticketID: work.ticketID })), work);
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
  assert.deepEqual(await done(third.client.call("work_get", { ticketID: work.ticketID })), work);
  assert.equal(
    await refused(
      root.call("work_review", {
        ticketID: work.ticketID,
        expectedRevision: work.revision,
        submissionID: work.submission.submissionID,
        verdict: "accepted",
        comment: "Not requester",
      }),
    ),
    "forbidden",
  );
  assert.equal(
    await refused(
      peer.client.call("work_review", {
        ticketID: work.ticketID,
        expectedRevision: work.revision,
        submissionID: "wrong",
        verdict: "accepted",
        comment: "Wrong",
      }),
    ),
    "conflict",
  );
  work = await done(
    peer.client.call("work_review", {
      ticketID: work.ticketID,
      expectedRevision: work.revision,
      submissionID: work.submission.submissionID,
      verdict: "changes_requested",
      comment: "Revise",
    }),
  );
  work = await done(
    peer.client.call("work_update", {
      ticketID: work.ticketID,
      expectedRevision: work.revision,
      ownerID: third.id,
    }),
  );
  assert.deepEqual(await done(owner.client.call("work_get", { ticketID: work.ticketID })), work);
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
  assert.deepEqual((await done(third.client.call("work_list", {}))).items, [work]);
  work = await done(
    third.client.call("work_submit", {
      ticketID: work.ticketID,
      expectedRevision: work.revision,
      result: "Revised",
      evidence: [],
    }),
  );
  work = await done(
    peer.client.call("work_review", {
      ticketID: work.ticketID,
      expectedRevision: work.revision,
      submissionID: work.submission.submissionID,
      verdict: "accepted",
      comment: "Accepted",
    }),
  );
  assert.deepEqual(await done(root.call("work_get", { ticketID: work.ticketID })), work);
  assert.equal(work.history.length, work.revision);
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

test("standalone and linked Forms have shared full-history reads and role-bound writes", async (t) => {
  const { core, root, owner, peer, third } = await members();
  t.after(() => core.close());
  const fields = [{ name: "choice", label: "Choose", required: true, options: ["yes", "no"] }];
  let form = await done(peer.client.call("form_create", { respondentIDs: [owner.id], fields }));
  assert.equal("workID" in form, false);
  assert.deepEqual(await done(third.client.call("form_get", { formID: form.formID })), form);
  assert.equal(
    await refused(
      root.call("form_close", {
        formID: form.formID,
        expectedRevision: 1,
        status: "resolved",
        resolution: "Not requester",
      }),
    ),
    "forbidden",
  );
  assert.equal(
    await refused(
      peer.client.call("form_respond", {
        formID: form.formID,
        expectedRevision: 1,
        answers: { choice: "yes" },
      }),
    ),
    "forbidden",
  );
  assert.equal(
    await refused(
      owner.client.call("form_respond", {
        formID: form.formID,
        expectedRevision: 1,
        answers: { choice: "other" },
      }),
    ),
    "invalid",
  );
  form = await done(
    owner.client.call("form_respond", {
      formID: form.formID,
      expectedRevision: 1,
      answers: { choice: "yes" },
    }),
  );
  assert.equal(form.status, "open");
  form = await done(
    peer.client.call("form_close", {
      formID: form.formID,
      expectedRevision: form.revision,
      status: "resolved",
      resolution: "Decided",
    }),
  );
  assert.equal(
    await refused(
      owner.client.call("form_respond", {
        formID: form.formID,
        expectedRevision: form.revision,
        answers: { choice: "no" },
      }),
    ),
    "conflict",
  );
  assert.equal((await done(owner.client.call("form_list", {}))).items[0].formID, form.formID);
  assert.equal(
    await refused(
      peer.client.call("form_create", { workID: "missing", respondentIDs: [owner.id], fields }),
    ),
    "not_found",
  );
  const work = await done(peer.client.call("work_create", { ownerID: owner.id, goal: "Linked" }));
  const linked = await done(
    third.client.call("form_create", { workID: work.ticketID, respondentIDs: [owner.id], fields }),
  );
  assert.equal(
    (await done(owner.client.call("form_get", { formID: linked.formID }))).formID,
    linked.formID,
  );
  assert.deepEqual(await done(third.client.call("work_get", { ticketID: work.ticketID })), work);
  await done(
    peer.client.call("work_update", {
      ticketID: work.ticketID,
      expectedRevision: 1,
      ownerID: third.id,
    }),
  );
  assert.deepEqual(await done(owner.client.call("form_get", { formID: linked.formID })), linked);
  assert.deepEqual(await done(root.call("form_get", { formID: form.formID })), form);
  assert.equal(form.history.length, form.revision);
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

test("Workspace state and module cursors survive a Hub restart under the same admitted identity", async (t) => {
  const { core, root, owner, peer, third } = await members();
  t.after(() => core.close());
  await done(root.call("message_send", { recipientID: third.id, text: "Private unrelated" }));
  const sent = await done(
    owner.client.call("message_send", { recipientID: peer.id, text: "Kept" }),
  );
  const work = await done(
    owner.client.call("work_create", { ownerID: peer.id, goal: "Keep Work" }),
  );
  const form = await done(
    peer.client.call("form_create", {
      respondentIDs: [owner.id],
      fields: [{ name: "answer", label: "Answer", required: true }],
    }),
  );
  const page = await done(peer.client.call("message_list", { direction: "incoming", limit: 1 }));
  assert.deepEqual(page.items, [sent], "invisible rows do not exhaust the page limit");
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
  assert.deepEqual(await done(peer.client.call("work_get", { ticketID: work.ticketID })), work);
  assert.deepEqual(await done(owner.client.call("form_get", { formID: form.formID })), form);
  assert.deepEqual(await done(peer.client.call("message_list", { after: page.after })), {
    items: [],
    after: page.after,
  });
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
  const received = await done(peer.client.call("message_list", { direction: "incoming" }));
  assert.equal(received.items.length, 1);
  assert.equal(received.items[0].text, "Committed once");
  assert.equal(received.items[0].history.length, 1);
  const append = t.mock.method(core.store.audit, "append", () => {
    throw new Error("private audit error");
  });
  await assert.rejects(
    owner.client.call("message_send", { recipientID: peer.id, text: "Audit failed after commit" }),
    /write outcome may be unknown/,
  );
  append.mock.restore();
  assert.equal((await done(peer.client.call("message_list", {}))).items.length, 2);
});

test("Work filters AND before pagination and never select the caller's identity", async (t) => {
  const { core, root, owner, peer, third } = await members();
  t.after(() => core.close());
  const active = async (caller: Actor, ownerID: string, goal: string) => {
    const work = await done(caller.call("work_create", { ownerID, goal }));
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
  await done(peer.client.call("work_create", { ownerID: owner.id, goal: "Wrong status" }));
  const second = await active(peer.client, owner.id, "Second match");
  const filter = { ownerID: owner.id, requesterID: peer.id, status: "active", limit: 1 };
  const page = await done(third.client.call("work_list", filter));
  assert.deepEqual(page, { items: [first], after: first.cursor });
  const next = await done(third.client.call("work_list", { ...filter, after: page.after }));
  assert.deepEqual(next, { items: [second], after: second.cursor });
  assert.deepEqual(await done(third.client.call("work_list", { ...filter, after: next.after })), {
    items: [],
    after: next.after,
  });
  assert.equal((await done(third.client.call("actor_get"))).actorID, third.id);
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
    assert.deepEqual(await done(third.client.call("work_list", unknown)), { items: [], after: 0 });
  for (const bad of [{ status: "closed" }, { ownerID: "" }, { requesterID: 1 }])
    assert.equal(await refused(root.call("work_list", bad)), "invalid");
});

test("Form attention predicates precede pagination and an own empty response counts as answered", async (t) => {
  const { core, root, owner, peer, third } = await members();
  t.after(() => core.close());
  const work = await done(
    root.call("work_create", { ownerID: third.id, goal: "Shared association" }),
  );
  const fields = [{ name: "answer", label: "Optional answer", required: false }];
  const create = (caller: Actor, respondentIDs: string[], linked = true) =>
    done(
      caller.call("form_create", {
        respondentIDs,
        fields,
        ...(linked ? { workID: work.ticketID } : {}),
      }),
    );
  await create(root, [owner.id, third.id]);
  const answered = await create(peer.client, [owner.id, third.id]);
  await done(
    owner.client.call("form_respond", {
      formID: answered.formID,
      expectedRevision: 1,
      answers: {},
    }),
  );
  const closed = await create(peer.client, [owner.id, third.id]);
  await done(
    peer.client.call("form_close", {
      formID: closed.formID,
      expectedRevision: 1,
      status: "cancelled",
      resolution: "No longer needed",
    }),
  );
  await create(peer.client, [third.id]);
  await create(peer.client, [owner.id, third.id], false);
  const first = await create(peer.client, [owner.id, third.id]);
  const second = await create(peer.client, [owner.id, third.id]);
  const filter = {
    workID: work.ticketID,
    requesterID: peer.id,
    respondentID: third.id,
    status: "open",
    awaitingActorID: owner.id,
    limit: 1,
  };
  const page = await done(root.call("form_list", filter));
  assert.deepEqual(page, { items: [first], after: first.cursor });
  const next = await done(root.call("form_list", { ...filter, after: page.after }));
  assert.deepEqual(next, { items: [second], after: second.cursor });
  assert.deepEqual(await done(root.call("form_list", { ...filter, after: next.after })), {
    items: [],
    after: next.after,
  });
  const response = await done(root.call("form_get", { formID: answered.formID }));
  assert.equal(Object.hasOwn(response.responses, owner.id), true);
  assert.deepEqual(response.responses[owner.id], {});
  assert.equal(
    (await done(root.call("form_list", { awaitingActorID: third.id }))).items.some(
      (item: { formID: string }) => item.formID === answered.formID,
    ),
    true,
    "another respondent still awaits their own response",
  );
  assert.equal(
    (await done(root.call("form_list", { respondentID: owner.id, status: "open" }))).items.some(
      (item: { formID: string }) => item.formID === answered.formID,
    ),
    true,
    "answered Forms remain available to revise",
  );
  assert.equal(
    (await done(root.call("form_list", { status: "cancelled", awaitingActorID: owner.id }))).items
      .length,
    0,
  );
  assert.equal(
    await refused(
      root.call("form_respond", { formID: first.formID, expectedRevision: 1, answers: {} }),
    ),
    "forbidden",
  );
  assert.equal((await done(root.call("actor_get"))).actorID, core.rootId);
  for (const field of ["workID", "requesterID", "respondentID", "awaitingActorID"])
    assert.deepEqual(await done(root.call("form_list", { [field]: "unknown-id" })), {
      items: [],
      after: 0,
    });
  for (const bad of [{ status: "active" }, { awaitingActorID: "" }, { respondentID: 1 }])
    assert.equal(await refused(root.call("form_list", bad)), "invalid");
});

test("shared Work/Form history and Hub diagnostics do not disclose private linked Message data", async (t) => {
  const { core, root, owner, peer, third } = await members();
  t.after(() => core.close());
  const work = await done(
    owner.client.call("work_create", { ownerID: peer.id, goal: "Public goal" }),
  );
  const secret = "private-p2p-body-sentinel";
  const message = await done(
    owner.client.call("message_send", {
      recipientID: peer.id,
      workID: work.ticketID,
      text: secret,
    }),
  );
  let form = await done(
    owner.client.call("form_create", {
      workID: work.ticketID,
      respondentIDs: [peer.id],
      fields: [{ name: "answer", label: "Public question", required: true }],
    }),
  );
  form = await done(
    peer.client.call("form_respond", {
      formID: form.formID,
      expectedRevision: form.revision,
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
    assert.deepEqual(await done(observer.call("work_get", { ticketID: work.ticketID })), changed);
    assert.deepEqual(await done(observer.call("form_get", { formID: form.formID })), form);
    for (const name of ["work_list", "form_list", "team", "actor_list"])
      projections.push(await done(observer.call(name, {})));
    projections.push(await observer.call("activity", {}), await observer.available());
    assert.equal(
      await refused(observer.call("message_get", { messageID: message.messageID })),
      "not_found",
    );
    for (const direction of ["incoming", "outgoing", "all"]) {
      const inbox = await done(observer.call("message_list", { direction }));
      assert.deepEqual(inbox, { items: [], after: 0 });
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
  assert.equal(form.history.length, 2);
  assert.equal(changed.history.length, 2);
  const output = JSON.stringify(projections);
  assert.equal(output.includes(secret), false);
  assert.doesNotMatch(output, /"(?:read_at|readAt|handledAt|unread|deliveryStatus)"/);
});
