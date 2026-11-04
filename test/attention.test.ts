/**
 * `attention` reads what concerns its caller from the audited writes after its position, by the
 * next mover, names what anyone's writes touched, and waits for the next write.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Actor } from "../src/actor/index.ts";
import { done, type Json, refused, startCore } from "./harness.ts";

async function organization() {
  const core = await startCore();
  const root = await core.client(core.root);
  const make = async (name: string, manager: Actor = root) => {
    const created = await done(manager.call("actor_create", { name, purpose: `The ${name}` }));
    return { id: created.actor.id as string, client: await core.client(created.credential) };
  };
  const lead = await make("lead");
  const worker = await make("worker", lead.client);
  const peer = await make("peer");
  return { core, root, lead, worker, peer, make };
}

const choice = [
  {
    name: "choice",
    label: "Which?",
    required: true,
    options: [{ value: "a" }, { value: "b" }],
    recommended: "a",
  },
];
const position = async (client: Actor) => (await done(client.call("attention"))).next as string;
const read = (client: Actor, since: string, wait = 0) =>
  done(client.call("attention", { since, wait }, { timeoutMs: (wait + 5) * 1000 }));
const kinds = (result: Json) =>
  result.items.map((item: Json) => [item.kind, item.recordID, item.from.name, item.title]);
const sorted = (ids: string[]) => [...ids].sort();
/** An ask on Work the caller owns, on new Work of its own unless it names one. */
async function ask(client: Actor, title: string, ticketID?: string, options: Json = {}) {
  const on =
    ticketID ?? (await done(client.call("work_create", { title: `For ${title}` }))).ticketID;
  return done(
    client.call("work_update", { ticketID: on, ask: { title, fields: choice, ...options } }),
  );
}

test("attention names what concerns its caller, made by someone else, and what changed", async (t) => {
  const { core, lead, worker, peer } = await organization();
  t.after(() => core.close());
  const start = await position(lead.client);
  assert.match(start, /^\d+$/);
  assert.deepEqual(await read(lead.client, start), {
    items: [],
    changed: { actorIDs: [], workIDs: [], conversationIDs: [] },
    next: start,
  });
  const leadAsk = await ask(lead.client, "Lead's ask");
  const workerAsk = await ask(worker.client, "Worker's ask");
  const peerAsk = await ask(peer.client, "Peer's ask");
  await done(peer.client.call("work_answer", { askID: leadAsk.formID, answers: { choice: "b" } }));
  const assigned = await done(
    lead.client.call("work_create", { title: "Build it", ownerID: worker.id }),
  );
  const toLead = await done(
    worker.client.call("work_create", { title: "Review it", ownerID: lead.id }),
  );
  await done(lead.client.call("work_submit", { ticketID: toLead.ticketID, result: "Done" }));
  const submitted = await done(
    worker.client.call("work_submit", { ticketID: assigned.ticketID, result: "Built" }),
  );
  const message = await done(
    peer.client.call("message_send", { recipientID: lead.id, text: "Look at this\nplease" }),
  );
  const forLead = await read(lead.client, start);
  assert.deepEqual(kinds(forLead), [
    ["ask", workerAsk.formID, "worker", "Worker's ask"],
    ["answer", leadAsk.formID, "peer", "Lead's ask"],
    ["assigned", toLead.ticketID, "worker", "Review it"],
    ["review_due", assigned.ticketID, "worker", "Build it"],
    ["message", message.messageID, "peer", "Look at this"],
  ]);
  assert.deepEqual(sorted(forLead.changed.actorIDs), sorted([lead.id, worker.id, peer.id]));
  assert.deepEqual(
    sorted(forLead.changed.workIDs),
    sorted([leadAsk.workID, workerAsk.workID, peerAsk.workID, assigned.ticketID, toLead.ticketID]),
  );
  assert.deepEqual(forLead.changed.conversationIDs, [message.conversationID]);
  await done(
    lead.client.call("work_answer", {
      ticketID: assigned.ticketID,
      askID: submitted.submission.submissionID,
      answers: { verdict: "accepted" },
    }),
  );
  const forWorker = await read(worker.client, forLead.next);
  assert.deepEqual(kinds(forWorker), [["reviewed", assigned.ticketID, "lead", "Build it"]]);
  const forPeer = await read(peer.client, start);
  assert.deepEqual(kinds(forPeer), [], "the peer's own writes and others' records are no items");
  assert.equal(JSON.stringify(forPeer).includes(message.messageID), false);
  assert.equal(JSON.stringify(forWorker).includes(message.messageID), false);
  assert.equal(await refused(lead.client.call("attention", { since: "999999999" })), "invalid");
});

test("new Work is assigned to the Actor that owns it when read, and to no one else", async (t) => {
  const { core, root, lead, worker, peer } = await organization();
  t.after(() => core.close());
  const workerStart = await position(worker.client);
  const peerStart = await position(peer.client);
  const rootStart = await position(root);
  const given = await done(lead.client.call("work_create", { title: "Given", ownerID: worker.id }));
  await done(lead.client.call("work_create", { title: "Kept" }));
  const moved = await done(
    lead.client.call("work_create", { title: "Moved on", ownerID: worker.id }),
  );
  await done(
    lead.client.call("work_update", {
      ticketID: moved.ticketID,
      ownerID: peer.id,
      expectedRevision: 1,
    }),
  );
  assert.deepEqual(kinds(await read(worker.client, workerStart)), [
    ["assigned", given.ticketID, "lead", "Given"],
  ]);
  assert.deepEqual(kinds(await read(peer.client, peerStart)), [
    ["assigned", moved.ticketID, "lead", "Moved on"],
  ]);
  assert.deepEqual(kinds(await read(root, rootStart)), []);
});

test("Work reassigned to an Actor by its requester is assigned to it", async (t) => {
  const { core, lead, worker, peer } = await organization();
  t.after(() => core.close());
  const work = await done(lead.client.call("work_create", { title: "Moved", ownerID: peer.id }));
  const start = await position(worker.client);
  await done(
    lead.client.call("work_update", {
      ticketID: work.ticketID,
      goal: "Unrelated",
      expectedRevision: 1,
    }),
  );
  assert.deepEqual(kinds(await read(worker.client, start)), []);
  await done(
    lead.client.call("work_update", {
      ticketID: work.ticketID,
      ownerID: worker.id,
      expectedRevision: 2,
    }),
  );
  assert.deepEqual(kinds(await read(worker.client, start)), [
    ["assigned", work.ticketID, "lead", "Moved"],
  ]);
});

test("a requester's goal edit and cancel are updated for the owner, and the owner's own edits reach no one", async (t) => {
  const { core, root, lead, worker } = await organization();
  t.after(() => core.close());
  const edited = await done(
    lead.client.call("work_create", { title: "Edited", ownerID: worker.id }),
  );
  const cancelled = await done(
    lead.client.call("work_create", { title: "Cancelled", ownerID: worker.id }),
  );
  const workerStart = await position(worker.client);
  const leadStart = await position(lead.client);
  const rootStart = await position(root);
  await done(
    lead.client.call("work_update", {
      ticketID: edited.ticketID,
      goal: "A new goal",
      expectedRevision: 1,
    }),
  );
  await done(
    lead.client.call("work_update", {
      ticketID: cancelled.ticketID,
      status: "cancelled",
      expectedRevision: 1,
    }),
  );
  await done(
    worker.client.call("work_update", {
      ticketID: edited.ticketID,
      progress: "Half way",
      status: "active",
    }),
  );
  assert.deepEqual(kinds(await read(worker.client, workerStart)), [
    ["updated", edited.ticketID, "lead", "Edited"],
    ["updated", cancelled.ticketID, "lead", "Cancelled"],
  ]);
  assert.deepEqual(kinds(await read(lead.client, leadStart)), []);
  assert.deepEqual(kinds(await read(root, rootStart)), []);
});

test("Work given to an Actor, edited, and moved on before the read reaches it as nothing", async (t) => {
  const { core, lead, worker, peer } = await organization();
  t.after(() => core.close());
  const work = await done(lead.client.call("work_create", { title: "Passing", ownerID: peer.id }));
  const start = await position(worker.client);
  let expectedRevision = 1;
  for (const edit of [{ ownerID: worker.id }, { goal: "Changed" }, { ownerID: peer.id }])
    await done(
      lead.client.call("work_update", {
        ticketID: work.ticketID,
        ...edit,
        expectedRevision: expectedRevision++,
      }),
    );
  assert.deepEqual(kinds(await read(worker.client, start)), []);
});

test("a reassignment and a goal edit read together are assigned and updated", async (t) => {
  const { core, lead, worker, peer } = await organization();
  t.after(() => core.close());
  const work = await done(lead.client.call("work_create", { title: "Moved", ownerID: peer.id }));
  const start = await position(worker.client);
  await done(
    lead.client.call("work_update", {
      ticketID: work.ticketID,
      ownerID: worker.id,
      expectedRevision: 1,
    }),
  );
  await done(
    lead.client.call("work_update", {
      ticketID: work.ticketID,
      goal: "Then this",
      expectedRevision: 2,
    }),
  );
  assert.deepEqual(kinds(await read(worker.client, start)), [
    ["assigned", work.ticketID, "lead", "Moved"],
    ["updated", work.ticketID, "lead", "Moved"],
  ]);
});

test("a closed requester's stand-in edits the Work as updated, and the submission is due for it", async (t) => {
  const { core, root, lead, peer, make } = await organization();
  t.after(() => core.close());
  const sub = await make("sub", lead.client);
  const work = await done(sub.client.call("work_create", { title: "Handed up", ownerID: peer.id }));
  await done(lead.client.call("actor_close", { actor: sub.id }));
  const peerStart = await position(peer.client);
  const leadStart = await position(lead.client);
  const rootStart = await position(root);
  await done(
    lead.client.call("work_update", {
      ticketID: work.ticketID,
      goal: "Finish it for me",
      expectedRevision: 1,
    }),
  );
  await done(peer.client.call("work_submit", { ticketID: work.ticketID, result: "Finished" }));
  assert.deepEqual(kinds(await read(peer.client, peerStart)), [
    ["updated", work.ticketID, "lead", "Handed up"],
  ]);
  assert.deepEqual(kinds(await read(lead.client, leadStart)), [
    ["review_due", work.ticketID, "peer", "Handed up"],
  ]);
  assert.deepEqual(kinds(await read(root, rootStart)), []);
});

test("a submission is due for its requester while it waits, and its answer is the owner's review", async (t) => {
  const { core, root, lead, worker } = await organization();
  t.after(() => core.close());
  const waiting = await done(
    lead.client.call("work_create", { title: "Waiting", ownerID: worker.id }),
  );
  const returned = await done(
    lead.client.call("work_create", { title: "Returned", ownerID: worker.id }),
  );
  const own = await done(worker.client.call("work_create", { title: "Own" }));
  const leadStart = await position(lead.client);
  const rootStart = await position(root);
  const workerStart = await position(worker.client);
  await done(worker.client.call("work_submit", { ticketID: waiting.ticketID, result: "Done" }));
  const submitted = await done(
    worker.client.call("work_submit", { ticketID: returned.ticketID, result: "Done" }),
  );
  await done(
    lead.client.call("work_answer", {
      askID: submitted.submission.submissionID,
      answers: { verdict: "changes_requested" },
      note: "Add tests",
    }),
  );
  await done(worker.client.call("work_submit", { ticketID: own.ticketID, result: "Done" }));
  assert.deepEqual(kinds(await read(lead.client, leadStart)), [
    ["review_due", waiting.ticketID, "worker", "Waiting"],
  ]);
  assert.deepEqual(kinds(await read(root, rootStart)), []);
  assert.deepEqual(kinds(await read(worker.client, workerStart)), [
    ["reviewed", returned.ticketID, "lead", "Returned"],
  ]);
});

test("an ask is routed to its asker's manager while it is open, and its answer is the asker's", async (t) => {
  const { core, root, lead, worker, peer } = await organization();
  t.after(() => core.close());
  const leadStart = await position(lead.client);
  const rootStart = await position(root);
  const peerStart = await position(peer.client);
  const open = await ask(worker.client, "Open");
  const answered = await ask(worker.client, "Answered");
  const closed = await ask(worker.client, "Closed");
  const workerStart = await position(worker.client);
  await done(peer.client.call("work_answer", { askID: answered.formID, answers: { choice: "b" } }));
  await done(
    worker.client.call("work_update", {
      close: { askID: closed.formID, status: "resolved", resolution: "Settled elsewhere" },
    }),
  );
  assert.deepEqual(kinds(await read(lead.client, leadStart)), [
    ["ask", open.formID, "worker", "Open"],
  ]);
  assert.deepEqual(kinds(await read(root, rootStart)), []);
  assert.deepEqual(kinds(await read(peer.client, peerStart)), []);
  assert.deepEqual(kinds(await read(worker.client, workerStart)), [
    ["answer", answered.formID, "peer", "Answered"],
  ]);
});

test("two asks on one Work are two ask items", async (t) => {
  const { core, lead, worker } = await organization();
  t.after(() => core.close());
  const start = await position(lead.client);
  const first = await ask(worker.client, "First");
  const second = await ask(worker.client, "Second", first.workID);
  assert.deepEqual(kinds(await read(lead.client, start)), [
    ["ask", first.formID, "worker", "First"],
    ["ask", second.formID, "worker", "Second"],
  ]);
});

test("an ask item drops once the ask is answered or raised past its reader", async (t) => {
  const { core, lead, worker, peer } = await organization();
  t.after(() => core.close());
  const start = await position(lead.client);
  const answered = await ask(worker.client, "Answered");
  const raised = await ask(worker.client, "Raised");
  assert.deepEqual(kinds(await read(lead.client, start)), [
    ["ask", answered.formID, "worker", "Answered"],
    ["ask", raised.formID, "worker", "Raised"],
  ]);
  await done(peer.client.call("work_answer", { askID: answered.formID, answers: { choice: "a" } }));
  await done(lead.client.call("work_answer", { askID: raised.formID, raise: true }));
  assert.deepEqual(kinds(await read(lead.client, start)), []);
});

test("a raise reaches the asker as raised and the next manager as an ask, and an ask closed before the read reaches nobody", async (t) => {
  const { core, root, lead, worker } = await organization();
  t.after(() => core.close());
  const leadStart = await position(lead.client);
  const raised = await ask(worker.client, "Raise me");
  const withdrawn = await ask(worker.client, "Withdrawn");
  await done(
    worker.client.call("work_update", {
      close: { askID: withdrawn.formID, status: "cancelled", resolution: "No longer needed" },
    }),
  );
  assert.deepEqual(kinds(await read(lead.client, leadStart)), [
    ["ask", raised.formID, "worker", "Raise me"],
  ]);
  const workerStart = await position(worker.client);
  const rootStart = await position(root);
  await done(lead.client.call("work_answer", { askID: raised.formID, raise: true }));
  assert.deepEqual(kinds(await read(worker.client, workerStart)), [
    ["raised", raised.formID, "lead", "Raise me"],
  ]);
  assert.deepEqual(kinds(await read(root, rootStart)), [
    ["ask", raised.formID, "lead", "Raise me"],
  ]);
});

test("an ask raised twice routes to its last raiser's manager", async (t) => {
  const { core, root, lead, worker, make } = await organization();
  t.after(() => core.close());
  const sub = await make("sub", worker.client);
  const leadStart = await position(lead.client);
  const subStart = await position(sub.client);
  const twice = await ask(sub.client, "Twice");
  await done(worker.client.call("work_answer", { askID: twice.formID, raise: true }));
  assert.deepEqual(
    kinds(await read(lead.client, leadStart)),
    [["ask", twice.formID, "worker", "Twice"]],
    "a raised ask names its raiser",
  );
  const rootStart = await position(root);
  await done(lead.client.call("work_answer", { askID: twice.formID, raise: true }));
  assert.deepEqual(kinds(await read(lead.client, leadStart)), []);
  assert.deepEqual(kinds(await read(root, rootStart)), [["ask", twice.formID, "lead", "Twice"]]);
  assert.deepEqual(kinds(await read(sub.client, subStart)), [
    ["raised", twice.formID, "worker", "Twice"],
  ]);
});

test("an open ask whose asker and its manager are closed routes to their nearest open manager", async (t) => {
  const { core, lead, worker, make } = await organization();
  t.after(() => core.close());
  const sub = await make("sub", worker.client);
  const start = await position(lead.client);
  const left = await ask(sub.client, "Left open");
  await done(worker.client.call("actor_close", { actor: sub.id }));
  await done(lead.client.call("actor_close", { actor: worker.id }));
  assert.deepEqual(kinds(await read(lead.client, start)), [
    ["ask", left.formID, "sub", "Left open"],
  ]);
});

test("a manager's answer to a collecting ask and its raise read together are answer and raised", async (t) => {
  const { core, root, lead, worker } = await organization();
  t.after(() => core.close());
  const poll = await ask(worker.client, "Poll", undefined, { collect: true });
  const workerStart = await position(worker.client);
  const rootStart = await position(root);
  await done(lead.client.call("work_answer", { askID: poll.formID, answers: { choice: "b" } }));
  await done(lead.client.call("work_answer", { askID: poll.formID, raise: true }));
  assert.deepEqual(kinds(await read(worker.client, workerStart)), [
    ["answer", poll.formID, "lead", "Poll"],
    ["raised", poll.formID, "lead", "Poll"],
  ]);
  assert.deepEqual(kinds(await read(root, rootStart)), [["ask", poll.formID, "lead", "Poll"]]);
});

test("an answer and a raise stay theirs once the same Actor's cancel of the Work closes the asks", async (t) => {
  const { core, root, lead, worker } = await organization();
  t.after(() => core.close());
  const work = await done(
    lead.client.call("work_create", { title: "Called off", ownerID: worker.id }),
  );
  const poll = await ask(worker.client, "Poll", work.ticketID, { collect: true });
  const passed = await ask(worker.client, "Passed up", work.ticketID);
  const workerStart = await position(worker.client);
  const rootStart = await position(root);
  await done(lead.client.call("work_answer", { askID: poll.formID, answers: { choice: "a" } }));
  await done(lead.client.call("work_answer", { askID: passed.formID, raise: true }));
  await done(
    lead.client.call("work_update", {
      ticketID: work.ticketID,
      status: "cancelled",
      expectedRevision: 1,
    }),
  );
  assert.deepEqual(kinds(await read(worker.client, workerStart)), [
    ["answer", poll.formID, "lead", "Poll"],
    ["raised", passed.formID, "lead", "Passed up"],
    ["updated", work.ticketID, "lead", "Called off"],
  ]);
  assert.deepEqual(kinds(await read(root, rootStart)), [], "a cancelled ask is routed to no one");
});

test("changed names a Work write's owner, requester and previous owner", async (t) => {
  const { core, root, lead, worker, peer } = await organization();
  t.after(() => core.close());
  const work = await done(lead.client.call("work_create", { title: "Moved", ownerID: peer.id }));
  const start = await position(root);
  await done(
    lead.client.call("work_update", {
      ticketID: work.ticketID,
      ownerID: worker.id,
      expectedRevision: 1,
    }),
  );
  const seen = await read(root, start);
  assert.deepEqual(seen.items, []);
  assert.deepEqual(sorted(seen.changed.actorIDs), sorted([worker.id, lead.id, peer.id]));
  assert.deepEqual(seen.changed.workIDs, [work.ticketID]);
  assert.deepEqual(seen.changed.conversationIDs, []);
});

test("changed names an ask write's Work and its asker", async (t) => {
  const { core, root, worker, peer } = await organization();
  t.after(() => core.close());
  const own = await done(worker.client.call("work_create", { title: "Asks" }));
  const start = await position(root);
  const question = await ask(worker.client, "Which?", own.ticketID);
  const asked = await read(root, start);
  assert.deepEqual(asked.items, []);
  assert.deepEqual(asked.changed, {
    actorIDs: [worker.id],
    workIDs: [own.ticketID],
    conversationIDs: [],
  });
  await done(peer.client.call("work_answer", { askID: question.formID, answers: { choice: "a" } }));
  assert.deepEqual((await read(root, asked.next)).changed, asked.changed);
});

test("changed names a message's conversation and both its Actors, and the message is the recipient's alone", async (t) => {
  const { core, root, lead, worker, peer } = await organization();
  t.after(() => core.close());
  const rootStart = await position(root);
  const leadStart = await position(lead.client);
  const peerStart = await position(peer.client);
  const message = await done(
    worker.client.call("message_send", { recipientID: peer.id, text: "Hello there" }),
  );
  const seen = await read(root, rootStart);
  assert.deepEqual(seen.items, []);
  assert.deepEqual(sorted(seen.changed.actorIDs), sorted([worker.id, peer.id]));
  assert.deepEqual(seen.changed.workIDs, []);
  assert.deepEqual(seen.changed.conversationIDs, [message.conversationID]);
  assert.deepEqual(kinds(await read(lead.client, leadStart)), []);
  assert.deepEqual(kinds(await read(peer.client, peerStart)), [
    ["message", message.messageID, "worker", "Hello there"],
  ]);
});

test("changed names an Actor created or closed and its manager", async (t) => {
  const { core, lead, peer, make } = await organization();
  t.after(() => core.close());
  const start = await position(peer.client);
  const temp = await make("temp", lead.client);
  const created = await read(peer.client, start);
  assert.deepEqual(created.items, []);
  assert.deepEqual(created.changed, {
    actorIDs: [temp.id, lead.id],
    workIDs: [],
    conversationIDs: [],
  });
  await done(lead.client.call("actor_close", { actor: temp.id }));
  const closed = await read(peer.client, created.next);
  assert.deepEqual([closed.items, closed.changed], [[], created.changed]);
});

test("a report reads the organization's activity", async (t) => {
  const { core, lead, worker } = await organization();
  t.after(() => core.close());
  const work = await done(lead.client.call("work_create", { title: "Seen", ownerID: worker.id }));
  const { entries } = await done(worker.client.call("activity", {}));
  const last = entries.at(-1);
  assert.deepEqual(
    [last.actor, last.operation, last.target, last.outcome],
    [lead.id, "work_create", work.ticketID, "ok"],
  );
});

test("audit entries earlier builds made under their tool names keep their items", async (t) => {
  const { core, lead, worker } = await organization();
  t.after(() => core.close());
  const workerStart = await position(worker.client);
  const leadStart = await position(lead.client);
  const answered = await ask(worker.client, "Old question");
  await done(lead.client.call("work_answer", { askID: answered.formID, answers: { choice: "a" } }));
  const work = await done(
    lead.client.call("work_create", { title: "Old review", ownerID: worker.id }),
  );
  await done(worker.client.call("work_update", { ticketID: work.ticketID, status: "active" }));
  const submitted = await done(
    worker.client.call("work_submit", { ticketID: work.ticketID, result: "Old result" }),
  );
  await done(
    lead.client.call("work_answer", {
      askID: submitted.submission.submissionID,
      answers: { verdict: "accepted" },
    }),
  );
  const open = await ask(worker.client, "Still open");
  const closed = await ask(worker.client, "Closed then");
  await done(
    worker.client.call("work_update", {
      close: { askID: closed.formID, status: "resolved", resolution: "Settled" },
    }),
  );
  // An earlier build audited these writes under the tools they went through then.
  const rename = (operation: string, from: string, actor: string, target: string) =>
    core.store.database.run(
      "UPDATE audit SET operation = ? WHERE operation = ? AND actor = ? AND target = ?",
      [operation, from, actor, target],
    );
  rename("form_create", "work_update", worker.id, open.formID);
  rename("form_create", "work_update", worker.id, closed.formID);
  rename("form_close", "work_update", worker.id, closed.formID);
  rename("form_respond", "work_answer", lead.id, answered.formID);
  rename("work_review", "work_answer", lead.id, work.ticketID);
  const legacy = core.store.database.all(
    "SELECT operation FROM audit WHERE operation GLOB 'form_*' OR operation = 'work_review'",
  );
  assert.ok(legacy.length >= 4, "the reads below cover the earlier names");
  const seen = await read(worker.client, workerStart);
  assert.deepEqual(
    kinds(seen).filter(([kind]: string[]) => kind !== "assigned"),
    [
      ["answer", answered.formID, "lead", "Old question"],
      ["reviewed", work.ticketID, "lead", "Old review"],
    ],
  );
  assert.ok(seen.changed.workIDs.includes(open.workID));
  assert.deepEqual(kinds(await read(lead.client, leadStart)), [
    ["ask", open.formID, "worker", "Still open"],
  ]);
});

test("a refused ask write is audited under its ask", async (t) => {
  const { core, root, peer, worker } = await organization();
  t.after(() => core.close());
  const question = await ask(worker.client, "Whose to close?");
  const approval = await done(
    worker.client.call("work_update", {
      ticketID: question.workID,
      ask: { title: "Delete it?", approval: true, fields: choice },
    }),
  );
  assert.equal(
    await refused(
      peer.client.call("work_update", {
        close: { askID: question.formID, status: "cancelled", resolution: "Not mine" },
      }),
    ),
    "forbidden",
  );
  assert.equal(
    await refused(
      peer.client.call("work_answer", { askID: approval.formID, answers: { choice: "a" } }),
    ),
    "forbidden",
  );
  const { entries } = await done(root.call("activity", {}));
  assert.deepEqual(
    entries
      .filter((entry: Json) => entry.actor === peer.id)
      .map((entry: Json) => [entry.operation, entry.target, entry.outcome]),
    [
      ["work_update", question.formID, "forbidden"],
      ["work_answer", approval.formID, "forbidden"],
    ],
  );
});

test("a waiting read returns at the next write, or empty when its wait ends, and holds no socket", async (t) => {
  const { core, lead, worker } = await organization();
  t.after(() => core.close());
  const own = await done(worker.client.call("work_create", { title: "Asks" }));
  const start = await position(lead.client);
  const begun = Date.now();
  const waiting = read(lead.client, start, 30);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const held = core.org.connections
    .entries()
    .filter((entry) => "actorId" in entry.principal && entry.principal.actorId === lead.id);
  assert.ok(held.length > 0);
  for (const entry of held) assert.equal(core.org.connections.busy(entry), false);
  const now = await ask(worker.client, "Now", own.ticketID);
  const woke = await waiting;
  assert.ok(Date.now() - begun < 10_000);
  assert.deepEqual(kinds(woke), [["ask", now.formID, "worker", "Now"]]);
  const quiet = Date.now();
  assert.deepEqual(await read(lead.client, woke.next, 1), {
    items: [],
    changed: { actorIDs: [], workIDs: [], conversationIDs: [] },
    next: woke.next,
  });
  assert.ok(Date.now() - quiet >= 900);
});

test("an answered submission reaches its submitter, and a raised ask names its raiser", async (t) => {
  const { core, root, lead, worker, peer } = await organization();
  t.after(() => core.close());
  const work = await done(
    lead.client.call("work_create", { title: "Moved on", ownerID: worker.id }),
  );
  await done(worker.client.call("work_update", { ticketID: work.ticketID, status: "active" }));
  const submitted = await done(
    worker.client.call("work_submit", { ticketID: work.ticketID, result: "First" }),
  );
  const workerStart = await position(worker.client);
  const peerStart = await position(peer.client);
  await done(
    lead.client.call("work_answer", {
      askID: submitted.submission.submissionID,
      answers: { verdict: "changes_requested" },
      note: "Again",
    }),
  );
  const reviewed = await done(lead.client.call("work_get", { ticketID: work.ticketID }));
  await done(
    lead.client.call("work_update", {
      ticketID: work.ticketID,
      ownerID: peer.id,
      expectedRevision: reviewed.revision,
    }),
  );
  assert.deepEqual(kinds(await read(worker.client, workerStart)), [
    ["reviewed", work.ticketID, "lead", "Moved on"],
  ]);
  assert.deepEqual(kinds(await read(peer.client, peerStart)), [
    ["assigned", work.ticketID, "lead", "Moved on"],
  ]);

  const rootStart = await position(root);
  const raised = await ask(worker.client, "Up the chain");
  await done(lead.client.call("work_answer", { askID: raised.formID, raise: true }));
  assert.deepEqual(kinds(await read(root, rootStart)), [
    ["ask", raised.formID, "lead", "Up the chain"],
  ]);
});

test("an answered submission reaches the Actor that made it, after its Work moves on", async (t) => {
  const { core, lead, worker, peer } = await organization();
  t.after(() => core.close());
  const work = await done(
    lead.client.call("work_create", { title: "Handed on", ownerID: worker.id }),
  );
  await done(worker.client.call("work_update", { ticketID: work.ticketID, status: "active" }));
  const first = await done(
    worker.client.call("work_submit", { ticketID: work.ticketID, result: "First" }),
  );
  const workerStart = await position(worker.client);
  const peerStart = await position(peer.client);
  await done(
    lead.client.call("work_answer", {
      askID: first.submission.submissionID,
      answers: { verdict: "changes_requested" },
      note: "Again",
    }),
  );
  const changed = await done(lead.client.call("work_get", { ticketID: work.ticketID }));
  await done(
    lead.client.call("work_update", {
      ticketID: work.ticketID,
      ownerID: peer.id,
      expectedRevision: changed.revision,
    }),
  );
  await done(peer.client.call("work_update", { ticketID: work.ticketID, status: "active" }));
  await done(peer.client.call("work_submit", { ticketID: work.ticketID, result: "Second" }));
  assert.deepEqual(kinds(await read(worker.client, workerStart)), [
    ["reviewed", work.ticketID, "lead", "Handed on"],
  ]);
  assert.deepEqual(kinds(await read(peer.client, peerStart)), [
    ["assigned", work.ticketID, "lead", "Handed on"],
  ]);
});

test("each entry keeps its own label: a claim on the ticket, a refused write, a lost entry", async (t) => {
  const { core, lead, worker, peer } = await organization();
  t.after(() => core.close());
  const edit = async (work: Json, input: Json) => {
    const current = await done(lead.client.call("work_get", { ticketID: work.ticketID }));
    return done(
      lead.client.call("work_update", {
        ticketID: work.ticketID,
        expectedRevision: current.revision,
        ...input,
      }),
    );
  };
  const claimed = await done(
    lead.client.call("work_create", { title: "Claimed", ownerID: peer.id }),
  );
  let start = await position(worker.client);
  await edit(claimed, { ownerID: worker.id });
  await done(lead.client.call("claim", { resource: claimed.ticketID, note: "Named after it" }));
  assert.deepEqual(kinds(await read(worker.client, start)), [
    ["assigned", claimed.ticketID, "lead", "Claimed"],
  ]);

  const refusedEdit = await done(
    lead.client.call("work_create", { title: "Refused between", ownerID: peer.id }),
  );
  start = await position(worker.client);
  await edit(refusedEdit, { ownerID: worker.id });
  assert.equal(
    await refused(
      lead.client.call("work_update", {
        ticketID: refusedEdit.ticketID,
        expectedRevision: 1,
        goal: "Stale",
      }),
    ),
    "conflict",
  );
  await edit(refusedEdit, { goal: "Current" });
  assert.deepEqual(kinds(await read(worker.client, start)), [
    ["assigned", refusedEdit.ticketID, "lead", "Refused between"],
    ["updated", refusedEdit.ticketID, "lead", "Refused between"],
  ]);

  const lost = await done(
    lead.client.call("work_create", { title: "Lost entry", ownerID: peer.id }),
  );
  start = await position(worker.client);
  await edit(lost, { ownerID: worker.id });
  // The fallback compares times, so the lost write comes at a later millisecond.
  await new Promise((resolve) => setTimeout(resolve, 2));
  await edit(lost, { goal: "Its entry is lost" });
  core.store.database.run("DELETE FROM audit WHERE id = (SELECT max(id) FROM audit)");
  assert.deepEqual(
    kinds(await read(worker.client, start)),
    [["assigned", lost.ticketID, "lead", "Lost entry"]],
    "a lost entry doesn't move its neighbour's label",
  );
});

test("an owner restated is updated, and Work moved away and back is assigned once", async (t) => {
  const { core, lead, worker, peer } = await organization();
  t.after(() => core.close());
  const edit = async (work: Json, input: Json) => {
    const current = await done(lead.client.call("work_get", { ticketID: work.ticketID }));
    return done(
      lead.client.call("work_update", {
        ticketID: work.ticketID,
        expectedRevision: current.revision,
        ...input,
      }),
    );
  };
  const kept = await done(lead.client.call("work_create", { title: "Kept", ownerID: worker.id }));
  let start = await position(worker.client);
  await edit(kept, { ownerID: worker.id, goal: "Restated" });
  assert.deepEqual(kinds(await read(worker.client, start)), [
    ["updated", kept.ticketID, "lead", "Kept"],
  ]);
  const moved = await done(lead.client.call("work_create", { title: "Moved", ownerID: peer.id }));
  start = await position(worker.client);
  await edit(moved, { ownerID: worker.id });
  await edit(moved, { ownerID: peer.id });
  await edit(moved, { ownerID: worker.id });
  assert.deepEqual(kinds(await read(worker.client, start)), [
    ["assigned", moved.ticketID, "lead", "Moved"],
  ]);
});

test("a collecting ask's answers come one per responder, and of two raises the later names its raiser", async (t) => {
  const { core, root, lead, worker, make } = await organization();
  t.after(() => core.close());
  const poll = await ask(worker.client, "Who's in?", undefined, { collect: true });
  const start = await position(worker.client);
  await done(lead.client.call("work_answer", { askID: poll.formID, answers: { choice: "a" } }));
  await done(root.call("work_answer", { askID: poll.formID, answers: { choice: "b" } }));
  assert.deepEqual(kinds(await read(worker.client, start)), [
    ["answer", poll.formID, "lead", "Who's in?"],
    ["answer", poll.formID, "root", "Who's in?"],
  ]);
  const sub = await make("sub", worker.client);
  const rootStart = await position(root);
  const twice = await ask(sub.client, "Twice in one read");
  await done(worker.client.call("work_answer", { askID: twice.formID, raise: true }));
  await done(lead.client.call("work_answer", { askID: twice.formID, raise: true }));
  assert.deepEqual(kinds(await read(root, rootStart)), [
    ["ask", twice.formID, "lead", "Twice in one read"],
  ]);
});

test("closing an Actor gives its stand-in what the close re-routes, past one closed manager or two", async (t) => {
  const { core, root, make, lead, worker, peer } = await organization();
  t.after(() => core.close());
  // One closed manager: worker's report asked, and worker requested Work that waits on it.
  const sub = await make("sub", worker.client);
  const near = await ask(sub.client, "Near");
  const given = await done(worker.client.call("work_create", { title: "Given", ownerID: peer.id }));
  await done(peer.client.call("work_update", { ticketID: given.ticketID, status: "active" }));
  await done(peer.client.call("work_submit", { ticketID: given.ticketID, result: "Done" }));
  await done(worker.client.call("actor_close", { actor: sub.id }));
  let start = await position(lead.client);
  await done(root.call("actor_close", { actor: worker.id }));
  assert.deepEqual(kinds(await read(lead.client, start)), [
    ["ask", near.formID, "root", "Near"],
    ["review_due", given.ticketID, "root", "Given"],
  ]);

  // Two closed managers: the asker's and the requester's managers close first, then the next.
  const middle = await make("middle", lead.client);
  const inner = await make("inner", middle.client);
  const leaf = await make("leaf", inner.client);
  const far = await ask(leaf.client, "Far");
  const deep = await done(inner.client.call("work_create", { title: "Deep", ownerID: peer.id }));
  await done(peer.client.call("work_update", { ticketID: deep.ticketID, status: "active" }));
  await done(peer.client.call("work_submit", { ticketID: deep.ticketID, result: "Done" }));
  await done(inner.client.call("actor_close", { actor: leaf.id }));
  await done(middle.client.call("actor_close", { actor: inner.id }));
  start = await position(lead.client);
  await done(root.call("actor_close", { actor: middle.id }));
  assert.deepEqual(kinds(await read(lead.client, start)), [
    ["ask", far.formID, "root", "Far"],
    ["review_due", deep.ticketID, "root", "Deep"],
  ]);
});

test("a close that re-routes nothing gives no item", async (t) => {
  const { core, root, make, lead } = await organization();
  t.after(() => core.close());
  const quiet = await make("quiet", lead.client);
  const own = await ask(quiet.client, "Its own");
  const start = await position(lead.client);
  await done(root.call("actor_close", { actor: quiet.id }));
  assert.deepEqual(
    kinds(await read(lead.client, start)),
    [],
    "its own ask waited on lead already, and still does",
  );
  assert.deepEqual(
    (await done(lead.client.call("actor_view", {}))).needs.map((each: Json) => each.formID),
    [own.formID],
  );
});

test("one read queries each writer's later writes on a record once, however many entries it reads", async (t) => {
  const { core, lead, worker, peer } = await organization();
  t.after(() => core.close());
  const work = await done(lead.client.call("work_create", { title: "Busy", ownerID: worker.id }));
  const starts = { peer: await position(peer.client), lead: await position(lead.client) };
  for (let step = 0; step < 40; step++)
    await done(worker.client.call("work_update", { ticketID: work.ticketID, progress: `${step}` }));
  await done(
    lead.client.call("work_update", {
      ticketID: work.ticketID,
      goal: "Sooner",
      expectedRevision: (await done(lead.client.call("work_get", { ticketID: work.ticketID })))
        .revision,
    }),
  );
  const queried = t.mock.method(core.store.audit, "writesAfter");
  // The worker's edits concern the peer in nothing, and the lead's edit the worker alone.
  assert.deepEqual(kinds(await read(peer.client, starts.peer)), []);
  assert.equal(queried.mock.callCount(), 2, "one query per writer on the record");
  queried.mock.resetCalls();
  assert.deepEqual(kinds(await read(lead.client, starts.lead)), []);
  assert.equal(queried.mock.callCount(), 2);
});
