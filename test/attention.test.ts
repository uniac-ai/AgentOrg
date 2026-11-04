/**
 * `attention` reads what concerns its caller from the audited writes after its position and waits
 * for the next write.
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
  return { core, root, lead, worker, peer };
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
/** An ask on Work the caller owns, on new Work of its own unless it names one. */
async function ask(client: Actor, title: string, ticketID?: string) {
  const on =
    ticketID ?? (await done(client.call("work_create", { title: `For ${title}` }))).ticketID;
  return done(client.call("work_update", { ticketID: on, ask: { title, fields: choice } }));
}

test("attention names what concerns its caller, made by someone else, and what changed", async (t) => {
  const { core, lead, worker, peer } = await organization();
  t.after(() => core.close());
  const start = await position(lead.client);
  assert.match(start, /^\d+$/);
  assert.deepEqual(await read(lead.client, start), {
    items: [],
    changed: { actorIDs: [], workIDs: [], formIDs: [] },
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
  assert.deepEqual(forLead.changed.actorIDs, []);
  assert.deepEqual(
    forLead.changed.formIDs.sort(),
    [leadAsk.formID, workerAsk.formID, peerAsk.formID].sort(),
  );
  assert.deepEqual(
    forLead.changed.workIDs.sort(),
    [leadAsk.workID, workerAsk.workID, peerAsk.workID, assigned.ticketID, toLead.ticketID].sort(),
  );
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

test("a raise reaches the next manager as an ask, and an ask closed before the read reaches nobody", async (t) => {
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
  assert.deepEqual(kinds(await read(worker.client, workerStart)), [], "a raise is no answer");
  assert.deepEqual(kinds(await read(root, rootStart)), [
    ["ask", raised.formID, "lead", "Raise me"],
  ]);
});

test("audit entries 0.5.0 made under its tool names keep their items", async (t) => {
  const { core, lead, worker } = await organization();
  t.after(() => core.close());
  const answered = await ask(worker.client, "Old question");
  await done(lead.client.call("work_answer", { askID: answered.formID, answers: { choice: "a" } }));
  const work = await done(
    lead.client.call("work_create", { title: "Old review", ownerID: worker.id }),
  );
  const open = await ask(worker.client, "Still open");
  const workerStart = await position(worker.client);
  const leadStart = await position(lead.client);
  const at = new Date().toISOString();
  for (const [actor, operation, target] of [
    [worker.id, "form_create", open.formID],
    [lead.id, "form_respond", answered.formID],
    [lead.id, "work_review", work.ticketID],
  ])
    core.store.audit.append({ at, actor, operation, target, outcome: "ok" });
  const seen = await read(worker.client, workerStart);
  assert.deepEqual(kinds(seen), [
    ["answer", answered.formID, "lead", "Old question"],
    ["reviewed", work.ticketID, "lead", "Old review"],
  ]);
  assert.deepEqual(seen.changed.formIDs.sort(), [answered.formID, open.formID].sort());
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
    changed: { actorIDs: [], workIDs: [], formIDs: [] },
    next: woke.next,
  });
  assert.ok(Date.now() - quiet >= 900);
});
