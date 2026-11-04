/**
 * `team` derives each position's state, headline and ask counts at read time from the Work on it
 * and the open asks under it; `actor_view.actor` names its manager and when it was closed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Actor } from "../src/actor/index.ts";
import { done, type Json, startCore } from "./harness.ts";

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
  return { core, root, make, lead, worker, peer };
}

const fields = [{ name: "answer", label: "Answer", required: false }];

test("a position's state and headline come from the Work on it, most urgent first", async (t) => {
  const { core, lead, worker, peer } = await organization();
  t.after(() => core.close());
  const seen = async (actorID: string, by: Actor = peer.client) =>
    (await done(by.call("team", { actor: actorID, depth: 0 }))).positions[0];
  const headline = async (by?: Actor) => (await seen(worker.id, by)).headline;
  const subject = (work: Json, state: string) => ({
    ticketID: work.ticketID,
    title: work.title,
    state,
  });

  const empty = await seen(worker.id);
  assert.equal(empty.state, "idle");
  assert.deepEqual(empty.headline, {
    subject: null,
    clause: null,
    more: 0,
    notStarted: 0,
    finished: null,
  });
  assert.equal(empty.lastActiveAt, null);

  const quick = await done(worker.client.call("work_create", { title: "Quick" }));
  const accepted = await done(
    worker.client.call("work_submit", { ticketID: quick.ticketID, result: "Done" }),
  );
  await done(worker.client.call("work_create", { title: "Later" }));
  const idle = await seen(worker.id);
  assert.equal(idle.state, "idle", "Work not started and Work done don't count");
  assert.deepEqual(idle.headline, {
    subject: null,
    clause: null,
    more: 0,
    notStarted: 1,
    finished: { ticketID: quick.ticketID, title: "Quick", at: accepted.completedAt },
  });

  const stream = await done(worker.client.call("work_create", { title: "Stream" }));
  await done(
    worker.client.call("work_update", {
      ticketID: stream.ticketID,
      status: "active",
      progress: "Moving   the data.\nThen the rest.",
    }),
  );
  assert.equal((await seen(worker.id)).state, "active");
  assert.deepEqual((await headline()).clause, { kind: "step", text: "Moving the data." });

  const held = await done(worker.client.call("work_create", { title: "Held" }));
  await done(
    worker.client.call("work_update", {
      ticketID: held.ticketID,
      status: "blocked",
      progress: "Installing.\n\n- [x] Order\n- [ ] Install\n- [ ] Verify",
    }),
  );
  const blocked = await headline();
  assert.equal((await seen(worker.id)).state, "active", "a stored blocked reads as active");
  assert.deepEqual(blocked.subject, subject(held, "active"), "ties go to the latest update");
  assert.deepEqual(blocked.clause, { kind: "step", text: "Install" });
  assert.equal(blocked.more, 1);

  const ci = await done(worker.client.call("work_create", { title: "CI" }));
  const waits = async (waitsOn: Json, by?: Actor) => {
    await done(
      worker.client.call("work_update", { ticketID: ci.ticketID, status: "active", waitsOn }),
    );
    return (await headline(by)).clause;
  };
  assert.deepEqual(await waits({ text: "the CI run" }), { kind: "waits", text: "the CI run" });
  assert.deepEqual(await waits({ actorID: peer.id }, lead.client), { kind: "waits", text: "peer" });
  assert.deepEqual(await waits({ actorID: peer.id }), { kind: "waits", text: "you" });
  assert.deepEqual(await waits({ ticketID: stream.ticketID }), { kind: "waits", text: "Stream" });
  const outside = await done(peer.client.call("work_create", { title: "Peer work" }));
  assert.deepEqual(await waits({ ticketID: outside.ticketID }), {
    kind: "waits",
    text: "Peer work",
  });

  await done(
    peer.client.call("form_create", { title: "Not the owner's", workID: ci.ticketID, fields }),
  );
  await done(worker.client.call("form_create", { title: "Loose", fields }));
  assert.equal(
    (await seen(worker.id)).state,
    "active",
    "an ask by another Actor, or on no Work, never makes Work waiting",
  );

  const redo = await done(lead.client.call("work_create", { title: "Redo", ownerID: worker.id }));
  await done(worker.client.call("work_update", { ticketID: redo.ticketID, status: "active" }));
  const submitted = await done(
    worker.client.call("work_submit", { ticketID: redo.ticketID, result: "First try" }),
  );
  assert.equal((await seen(worker.id)).state, "review");
  assert.deepEqual(await headline(), {
    subject: subject(redo, "review"),
    clause: { kind: "review", text: "with lead for review" },
    more: 3,
    notStarted: 1,
    finished: { ticketID: quick.ticketID, title: "Quick", at: accepted.completedAt },
  });
  assert.deepEqual((await headline(lead.client)).clause, {
    kind: "review",
    text: "with you for review",
  });
  await done(
    lead.client.call("work_review", {
      ticketID: redo.ticketID,
      expectedRevision: submitted.revision,
      submissionID: submitted.submission.submissionID,
      verdict: "changes_requested",
      comment: "Again",
    }),
  );
  await done(worker.client.call("work_update", { ticketID: redo.ticketID, status: "active" }));
  await done(worker.client.call("work_update", { ticketID: ci.ticketID, progress: "Later" }));
  const changes = await headline();
  assert.deepEqual(
    changes.subject,
    subject(redo, "active"),
    "changes requested outranks a later update, after the owner resumes",
  );
  assert.equal(changes.clause, null);

  const approval = await done(
    worker.client.call("form_create", {
      title: "Delete the bucket?",
      workID: stream.ticketID,
      approval: true,
      fields,
    }),
  );
  const waiting = await seen(worker.id);
  assert.equal(waiting.state, "waiting");
  assert.deepEqual(waiting.headline.subject, subject(stream, "waiting"));
  assert.deepEqual(waiting.headline.clause, { kind: "approval", text: "Delete the bucket?" });
  assert.equal(waiting.headline.more, 3);
  assert.equal(waiting.asks, 2);
  assert.equal(waiting.branchAsks, 0);
  assert.ok(waiting.lastActiveAt);
  assert.equal(
    waiting.lastActiveAt,
    (await done(peer.client.call("actor_view", { actorID: worker.id }))).actor.lastActiveAt,
  );

  await done(
    worker.client.call("form_close", {
      formID: approval.formID,
      expectedRevision: approval.revision,
      status: "cancelled",
      resolution: "Kept",
    }),
  );
  assert.equal((await seen(worker.id)).state, "active", "a closed ask no longer waits");
});

test("a manager's state is its own Work's, and its branch counts every ask below it", async (t) => {
  const { core, root, make, lead, worker, peer } = await organization();
  t.after(() => core.close());
  const stream = await done(worker.client.call("work_create", { title: "Stream" }));
  await done(worker.client.call("work_update", { ticketID: stream.ticketID, status: "active" }));
  await done(worker.client.call("form_create", { title: "Mine", workID: stream.ticketID, fields }));
  await done(peer.client.call("form_create", { title: "Peer's", fields }));
  const temp = await make("temp", lead.client);
  await done(temp.client.call("form_create", { title: "Left open", fields }));
  await done(lead.client.call("actor_close", { actor: temp.id }));

  const team = await done(lead.client.call("team", { actor: core.rootId, depth: 20 }));
  const at = (id: string) => team.positions.find((position: Json) => position.id === id);
  assert.deepEqual(
    team.positions.map((position: Json) => position.name),
    ["root", "lead", "worker", "peer"],
  );
  assert.equal(at(worker.id).state, "waiting");
  assert.equal(at(lead.id).state, "idle", "Work on its report doesn't raise its state");
  assert.deepEqual(
    [at(lead.id).asks, at(lead.id).branchAsks],
    [0, 2],
    "a closed report's ask still counts",
  );
  assert.deepEqual([at(core.rootId).asks, at(core.rootId).branchAsks], [0, 3]);
  assert.deepEqual([at(worker.id).asks, at(worker.id).branchAsks], [1, 0]);

  const closed = (await done(root.call("team", { actor: temp.id, depth: 0 }))).positions[0];
  assert.ok(closed.closed_at);
  assert.deepEqual([closed.state, closed.asks], ["idle", 1]);

  const viewed = (await done(peer.client.call("actor_view", { actorID: worker.id }))).actor;
  assert.equal(viewed.managerID, lead.id);
  assert.equal(viewed.closed_at, null);
  assert.equal((await done(lead.client.call("actor_view"))).actor.managerID, core.rootId);
  assert.equal((await done(root.call("actor_view"))).actor.managerID, null);
  assert.equal(
    (await done(root.call("actor_view", { actorID: temp.id }))).actor.closed_at,
    closed.closed_at,
  );
});
