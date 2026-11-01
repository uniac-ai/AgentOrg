/**
 * `attention` reads what concerns its caller from the audited writes after its position and waits
 * for the next write; `actor_view` joins an Actor's records into its report at read time.
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
  const leadAsk = await done(
    lead.client.call("form_create", { title: "Lead's ask", fields: choice }),
  );
  const workerAsk = await done(
    worker.client.call("form_create", { title: "Worker's ask", fields: choice }),
  );
  await done(peer.client.call("form_create", { title: "Peer's ask", fields: choice }));
  await done(
    peer.client.call("form_respond", { formID: leadAsk.formID, answers: { choice: "b" } }),
  );
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
  await done(lead.client.call("status_set", { line: "Reviewing" }));
  const forLead = await read(lead.client, start);
  assert.deepEqual(kinds(forLead), [
    ["ask", workerAsk.formID, "worker", "Worker's ask"],
    ["answer", leadAsk.formID, "peer", "Lead's ask"],
    ["assigned", toLead.ticketID, "worker", "Review it"],
    ["review_due", assigned.ticketID, "worker", "Build it"],
    ["message", message.messageID, "peer", "Look at this"],
  ]);
  assert.deepEqual(forLead.changed.actorIDs, [lead.id]);
  assert.equal(forLead.changed.formIDs.length, 3);
  assert.deepEqual(forLead.changed.workIDs.sort(), [assigned.ticketID, toLead.ticketID].sort());
  await done(
    lead.client.call("work_review", {
      ticketID: assigned.ticketID,
      submissionID: submitted.submission.submissionID,
      verdict: "accepted",
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

test("a waiting read returns at the next write, or empty when its wait ends, and holds no socket", async (t) => {
  const { core, lead, worker } = await organization();
  t.after(() => core.close());
  const start = await position(lead.client);
  const begun = Date.now();
  const waiting = read(lead.client, start, 30);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const held = core.org.connections
    .entries()
    .filter((entry) => "actorId" in entry.principal && entry.principal.actorId === lead.id);
  assert.ok(held.length > 0);
  for (const entry of held) assert.equal(core.org.connections.busy(entry), false);
  const ask = await done(worker.client.call("form_create", { title: "Now", fields: choice }));
  const woke = await waiting;
  assert.ok(Date.now() - begun < 10_000);
  assert.deepEqual(kinds(woke), [["ask", ask.formID, "worker", "Now"]]);
  const quiet = Date.now();
  assert.deepEqual(await read(lead.client, woke.next, 1), {
    items: [],
    changed: { actorIDs: [], workIDs: [], formIDs: [] },
    next: woke.next,
  });
  assert.ok(Date.now() - quiet >= 900);
});

test("actor_view joins an Actor's report at read time, for itself and its manager", async (t) => {
  const { core, lead, worker, peer } = await organization();
  t.after(() => core.close());
  const empty = await done(worker.client.call("actor_view"));
  assert.equal(empty.state, "idle");
  assert.equal(empty.status, null);
  assert.equal(empty.actor.actorID, worker.id);
  assert.equal(empty.actor.lastActiveAt, null);
  const status = await done(worker.client.call("status_set", { line: "Building" }));
  const stream = await done(worker.client.call("work_create", { title: "Stream" }));
  await done(worker.client.call("work_update", { ticketID: stream.ticketID, status: "active" }));
  const linked = await done(
    worker.client.call("form_create", { title: "Linked", workID: stream.ticketID, fields: choice }),
  );
  const unlinked = await done(
    worker.client.call("form_create", { title: "Loose", fields: choice }),
  );
  const followUp = await done(worker.client.call("work_create", { title: "Later" }));
  const assigned = await done(
    lead.client.call("work_create", { title: "Yours", ownerID: worker.id }),
  );
  const quick = await done(worker.client.call("work_create", { title: "Quick" }));
  await done(worker.client.call("work_submit", { ticketID: quick.ticketID, result: "Done" }));
  const view = await done(peer.client.call("actor_view", { actorID: worker.id }));
  assert.equal(view.state, "waiting");
  assert.deepEqual(view.status, status);
  assert.equal(view.actor.name, "worker");
  assert.equal(view.actor.path, "lead.worker");
  assert.equal(view.actor.online, true);
  assert.ok(view.actor.lastActiveAt);
  assert.deepEqual(
    view.workstreams.map((item: Json) => [item.ticketID, item.asks.map((ask: Json) => ask.formID)]),
    [[stream.ticketID, [linked.formID]]],
  );
  assert.deepEqual(
    view.asks.map((ask: Json) => ask.formID),
    [unlinked.formID],
  );
  assert.deepEqual(
    view.followUps.map((item: Json) => item.ticketID),
    [followUp.ticketID],
  );
  assert.deepEqual(
    view.assigned.map((item: Json) => item.ticketID),
    [assigned.ticketID],
  );
  assert.deepEqual(
    view.completed.map((item: Json) => item.ticketID),
    [quick.ticketID],
  );
  assert.deepEqual(view.needs, []);
  assert.deepEqual(view.reports, []);
  assert.deepEqual(view.actors[lead.id], { name: "lead" });
  await done(worker.client.call("work_update", { ticketID: assigned.ticketID, status: "active" }));
  const submitted = await done(
    worker.client.call("work_submit", { ticketID: assigned.ticketID, result: "Built" }),
  );
  const manager = await done(lead.client.call("actor_view"));
  assert.equal(manager.state, "review", "Work it assigned and must review is its workstream");
  assert.deepEqual(
    manager.workstreams.map((item: Json) => [item.ticketID, item.ownerID]),
    [[submitted.ticketID, worker.id]],
  );
  assert.deepEqual(
    manager.reviews.map((item: Json) => item.ticketID),
    [submitted.ticketID],
  );
  assert.deepEqual(
    manager.needs.map((ask: Json) => ask.formID),
    [linked.formID, unlinked.formID],
  );
  assert.deepEqual(
    manager.reports.map((report: Json) => report.id),
    [worker.id],
  );
  assert.deepEqual(
    (await done(lead.client.call("actor_view", { completed: 0, actorID: worker.id }))).completed,
    [],
  );
  assert.equal(await refused(lead.client.call("actor_view", { actorID: "missing" })), "not_found");
});
