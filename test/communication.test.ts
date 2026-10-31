/** Workspace records through the real Hub/SDK boundary as ordinary admitted Actors. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Actor } from "../src/actor/index.ts";
import { done, refused, startCore, until } from "./harness.ts";

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
  assert.equal(await refused(root.call("work_get", { ticketID: work.ticketID })), "not_found");
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
  assert.equal(
    await refused(owner.client.call("work_get", { ticketID: work.ticketID })),
    "not_found",
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

test("standalone Forms need no Work; linked visibility follows real current Work parties", async (t) => {
  const { core, root, owner, peer, third } = await members();
  t.after(() => core.close());
  const fields = [{ name: "choice", label: "Choose", required: true, options: ["yes", "no"] }];
  let form = await done(peer.client.call("form_create", { respondentIDs: [owner.id], fields }));
  assert.equal("workID" in form, false);
  assert.equal(await refused(root.call("form_get", { formID: form.formID })), "not_found");
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
    peer.client.call("form_create", { workID: work.ticketID, respondentIDs: [third.id], fields }),
  );
  assert.equal(
    (await done(owner.client.call("form_get", { formID: linked.formID }))).formID,
    linked.formID,
  );
  assert.equal(
    await refused(third.client.call("work_get", { ticketID: work.ticketID })),
    "not_found",
  );
  await done(
    peer.client.call("work_update", {
      ticketID: work.ticketID,
      expectedRevision: 1,
      ownerID: third.id,
    }),
  );
  assert.equal(
    await refused(owner.client.call("form_get", { formID: linked.formID })),
    "not_found",
  );
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
