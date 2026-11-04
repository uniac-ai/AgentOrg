/**
 * `team` derives each position's state, headline and ask counts at read time from the Work on it
 * and the open asks under it; `actor_view.actor` names its manager and when it was closed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Actor } from "../src/actor/index.ts";
import { Team } from "../src/contract/index.ts";
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
/** Its position as `by` reads it alone. */
const position = async (by: Actor, actorID: string) =>
  (await done(by.call("team", { actor: actorID, depth: 0 }))).positions[0];
const create = (client: Actor, title: string, input: Json = {}) =>
  done(client.call("work_create", { title, ...input }));
const update = (client: Actor, work: Json, input: Json) =>
  done(client.call("work_update", { ticketID: work.ticketID, ...input }));
const ask = (client: Actor, title: string, input: Json = {}) =>
  done(client.call("form_create", { title, fields, ...input }));
const close = (client: Actor, form: Json) =>
  done(
    client.call("form_close", {
      formID: form.formID,
      expectedRevision: form.revision,
      status: "cancelled",
      resolution: "Withdrawn",
    }),
  );
/** Lets the next write's time follow the last one's: ties in time go to the earlier write. */
const later = () => new Promise((resolve) => setTimeout(resolve, 2));
const subject = (work: Json, state: string) => ({
  ticketID: work.ticketID,
  title: work.title,
  state,
});

test("a Work's state, and an Actor's from the Work on it only", async (t) => {
  const { core, root, make, lead, worker, peer } = await organization();
  t.after(() => core.close());
  const state = async (actorID: string) => (await position(peer.client, actorID)).state;
  const stream = await create(lead.client, "Stream", { ownerID: worker.id });
  assert.deepEqual(
    [await state(worker.id), (await position(peer.client, worker.id)).headline.notStarted],
    ["idle", 1],
  );
  const early = await ask(worker.client, "Before starting?", { workID: stream.ticketID });
  const waiting = await position(peer.client, worker.id);
  assert.deepEqual(
    [waiting.state, waiting.headline.notStarted],
    ["waiting", 0],
    "Work not started waits once its owner asks on it",
  );
  const manager = (await done(peer.client.call("team", { actor: lead.id, depth: 1 }))).positions;
  assert.deepEqual(
    manager.map((each: Json) => each.state),
    ["idle", "waiting"],
    "Work it requested of its report doesn't count",
  );
  await close(worker.client, early);
  await update(worker.client, stream, { status: "active" });
  await ask(peer.client, "Not the owner's", { workID: stream.ticketID });
  await ask(worker.client, "On no Work");
  assert.equal(
    await state(worker.id),
    "active",
    "an ask by another Actor, or on no Work, never makes Work waiting",
  );
  await update(worker.client, stream, { status: "blocked" });
  assert.equal(await state(worker.id), "active", "a stored blocked reads as active");

  const temp = await make("temp", lead.client);
  const handover = await create(lead.client, "Handover", { ownerID: temp.id });
  await update(temp.client, handover, { status: "active" });
  await ask(temp.client, "Left open");
  await done(lead.client.call("actor_close", { actor: temp.id }));
  const closed = await position(root, temp.id);
  assert.ok(closed.closed_at);
  assert.deepEqual(
    [closed.state, closed.headline.subject, closed.asks],
    ["active", subject(handover, "active"), 1],
    "a closed Actor's position comes from the Work it still owns",
  );
});

test("the headline's subject: waiting, review, changes requested, active, then the latest", async (t) => {
  const { core, lead, worker, peer } = await organization();
  t.after(() => core.close());
  const headline = async () => (await position(peer.client, worker.id)).headline;
  const first = await create(worker.client, "First");
  await update(worker.client, first, { status: "active" });
  await later();
  const second = await create(worker.client, "Second");
  await update(worker.client, second, { status: "active" });
  const two = await headline();
  assert.deepEqual([two.subject, two.more], [subject(second, "active"), 1]);
  await later();
  await update(worker.client, first, { progress: "Moved on." });
  assert.deepEqual(
    (await headline()).subject,
    subject(first, "active"),
    "ties go to the latest update",
  );

  const redo = await create(lead.client, "Redo", { ownerID: worker.id });
  await update(worker.client, redo, { status: "active" });
  let submitted = await done(
    worker.client.call("work_submit", { ticketID: redo.ticketID, result: "First try" }),
  );
  await later();
  await update(worker.client, first, { progress: "Later still." });
  const review = await position(peer.client, worker.id);
  assert.deepEqual([review.state, review.headline.subject], ["review", subject(redo, "review")]);
  assert.equal(review.headline.more, 2);

  const question = await ask(worker.client, "Which one?", { workID: second.ticketID });
  const waiting = await position(peer.client, worker.id);
  assert.deepEqual(
    [waiting.state, waiting.headline.subject],
    ["waiting", subject(second, "waiting")],
    "waiting outranks review",
  );
  await close(worker.client, question);

  await done(
    lead.client.call("work_review", {
      ticketID: redo.ticketID,
      expectedRevision: submitted.revision,
      submissionID: submitted.submission.submissionID,
      verdict: "changes_requested",
      comment: "Again",
    }),
  );
  await later();
  await update(worker.client, first, { progress: "Later again." });
  assert.deepEqual(
    (await headline()).subject,
    subject(redo, "active"),
    "changes requested outrank later active Work, before the owner resumes",
  );
  await update(worker.client, redo, { status: "active" });
  await later();
  await update(worker.client, first, { progress: "And again." });
  assert.deepEqual(
    (await headline()).subject,
    subject(redo, "active"),
    "and after the owner resumes",
  );
  submitted = await done(
    worker.client.call("work_submit", { ticketID: redo.ticketID, result: "Second try" }),
  );
  assert.deepEqual((await headline()).subject, subject(redo, "review"));
});

test("the clause, first that applies: the owner's oldest ask, review, what it waits on, the step", async (t) => {
  const { core, make, lead, worker, peer } = await organization();
  t.after(() => core.close());
  const clause = async (actorID = worker.id, by: Actor = peer.client) =>
    (await position(by, actorID)).headline.clause;
  const work = await create(worker.client, "Work");
  await update(worker.client, work, { status: "active" });
  const older = await ask(worker.client, "Which region?", { workID: work.ticketID });
  await ask(worker.client, "Delete the bucket?", { workID: work.ticketID, approval: true });
  assert.deepEqual(await clause(), { kind: "ask", text: "Which region?" }, "the oldest ask");
  await close(worker.client, older);
  assert.deepEqual(await clause(), { kind: "approval", text: "Delete the bucket?" });

  const reviewer = await make("reviewer", lead.client);
  const leftover = await create(lead.client, "Leftover", { ownerID: reviewer.id });
  await update(reviewer.client, leftover, { status: "active" });
  await ask(reviewer.client, "Ship it?", { workID: leftover.ticketID, approval: true });
  await done(reviewer.client.call("work_submit", { ticketID: leftover.ticketID, result: "Done" }));
  const kept = await position(peer.client, reviewer.id);
  assert.deepEqual(
    [kept.state, kept.headline.clause],
    ["review", { kind: "approval", text: "Ship it?" }],
    "an owner's ask left open on submitted Work comes before the review",
  );

  const typist = await make("typist", lead.client);
  const draft = await create(lead.client, "Draft", { ownerID: typist.id });
  await update(typist.client, draft, { status: "active" });
  await done(typist.client.call("work_submit", { ticketID: draft.ticketID, result: "Draft" }));
  assert.deepEqual(await clause(typist.id), { kind: "review", text: "with lead for review" });
  assert.deepEqual(await clause(typist.id, lead.client), {
    kind: "review",
    text: "with you for review",
  });

  const waiter = await make("waiter", lead.client);
  const held = await create(waiter.client, "Held");
  const waits = async (waitsOn: Json, by?: Actor) => {
    await update(waiter.client, held, { status: "active", waitsOn });
    return clause(waiter.id, by);
  };
  assert.deepEqual(await waits({ text: "the CI run" }), { kind: "waits", text: "the CI run" });
  assert.deepEqual(await waits({ actorID: peer.id }, lead.client), { kind: "waits", text: "peer" });
  assert.deepEqual(await waits({ actorID: peer.id }), { kind: "waits", text: "you" });
  const mine = await create(waiter.client, "Mine");
  assert.deepEqual(await waits({ ticketID: mine.ticketID }), { kind: "waits", text: "Mine" });
  assert.deepEqual(
    await waits({ ticketID: work.ticketID }),
    { kind: "waits", text: "Work" },
    "Work outside the pass is read by its ID",
  );
});

test("the step is the current one, else the first sentence of the progress", async (t) => {
  const { core, worker, peer } = await organization();
  t.after(() => core.close());
  const work = await create(worker.client, "Steps");
  await update(worker.client, work, { status: "active" });
  const cases: [string, string | null][] = [
    ["Where it stands.\n\n- [x] One\n- [ ] Two\n- [ ] Three", "Two"],
    ["Only a paragraph.", "Only a paragraph."],
    ["1. One\n2. Two", null],
    ["The board renders.\nLive updates are next.", "The board renders."],
    ["Ahead of plan. More soon.\n- One\n- Two", "Ahead of plan."],
    ["Mixed markers.\n* [X] One\n+ [x] Two\n1) [ ] Three", "Three"],
    ["All done.\n- [x] One\n- [x] Two", "All done."],
    ["- [x] One\n- Two", "Two"],
    ["Version 0.5.0 ships today. Then docs.", "Version 0.5.0 ships today."],
    ["Why? Because.", "Why?"],
    ["  Spread\n\n  over   lines  ", "Spread over lines"],
  ];
  for (const [progress, text] of cases) {
    await update(worker.client, work, { progress });
    assert.deepEqual(
      (await position(peer.client, worker.id)).headline.clause,
      text === null ? null : { kind: "step", text },
      progress,
    );
  }
});

test("with nothing live: Work not started, and the last finished, newest first", async (t) => {
  const { core, lead, worker, peer } = await organization();
  t.after(() => core.close());
  const empty = await position(peer.client, worker.id);
  assert.equal(empty.state, "idle");
  assert.deepEqual(empty.headline, {
    subject: null,
    clause: null,
    more: 0,
    notStarted: 0,
    finished: null,
  });
  const finish = async (title: string) => {
    const work = await create(worker.client, title);
    const accepted = await done(
      worker.client.call("work_submit", { ticketID: work.ticketID, result: "Done" }),
    );
    return { ticketID: work.ticketID, title, at: accepted.completedAt };
  };
  await finish("Old");
  await later();
  const latest = await finish("New");
  await create(worker.client, "Later");
  assert.deepEqual((await position(peer.client, worker.id)).headline, {
    subject: null,
    clause: null,
    more: 0,
    notStarted: 1,
    finished: latest,
  });
  for (let n = 0; n < 101; n += 1) {
    const other = await create(peer.client, `Other ${n}`);
    await done(peer.client.call("work_submit", { ticketID: other.ticketID, result: "Done" }));
  }
  const team = await done(peer.client.call("team", { actor: lead.id, depth: 1 }));
  assert.deepEqual(
    team.positions[1].headline.finished,
    latest,
    "past the most recent page of finished Work",
  );
});

test("ask counts, paging past one page, recency, and the schema", async (t) => {
  const { core, root, make, lead, worker, peer } = await organization();
  t.after(() => core.close());
  for (let n = 0; n < 101; n += 1) {
    const other = await create(peer.client, `Other ${n}`);
    await update(peer.client, other, { status: "active" });
    await ask(peer.client, `Question ${n}`);
  }
  const stream = await create(worker.client, "Stream");
  await update(worker.client, stream, { status: "active" });
  await ask(worker.client, "Mine", { workID: stream.ticketID });
  const temp = await make("temp", worker.client);
  await ask(temp.client, "Left open");
  await done(worker.client.call("actor_close", { actor: temp.id }));

  const team = await done(lead.client.call("team", { actor: core.rootId, depth: 20 }));
  assert.doesNotThrow(() => Team.parse(team));
  const at = (id: string) => team.positions.find((each: Json) => each.id === id);
  assert.deepEqual(
    team.positions.map((each: Json) => each.name),
    ["root", "lead", "worker", "peer"],
  );
  assert.deepEqual(
    [at(worker.id).state, at(worker.id).headline.subject],
    ["waiting", subject(stream, "waiting")],
    "Work and asks past the first page",
  );
  assert.equal(at(peer.id).headline.more, 100);
  const counts = (id: string) => [at(id).asks, at(id).branchAsks];
  assert.deepEqual(counts(worker.id), [1, 1], "a closed report's ask still counts");
  assert.deepEqual(counts(lead.id), [0, 2]);
  assert.deepEqual(counts(peer.id), [101, 0]);
  assert.deepEqual(counts(core.rootId), [0, 103]);
  assert.ok(at(worker.id).lastActiveAt);
  assert.equal(
    at(worker.id).lastActiveAt,
    (await done(root.call("actor_view", { actorID: worker.id }))).actor.lastActiveAt,
  );
});

test("actor_view names an Actor's manager and when it was closed", async (t) => {
  const { core, root, make, lead, worker, peer } = await organization();
  t.after(() => core.close());
  const actor = async (by: Actor, actorID?: string) =>
    (await done(by.call("actor_view", actorID === undefined ? {} : { actorID }))).actor;
  const viewed = await actor(peer.client, worker.id);
  assert.deepEqual([viewed.managerID, viewed.closed_at], [lead.id, null]);
  assert.equal((await actor(lead.client)).managerID, core.rootId);
  assert.equal((await actor(root)).managerID, null);
  const temp = await make("temp", lead.client);
  const closed = (await done(lead.client.call("actor_close", { actor: temp.id }))).actor;
  assert.equal((await actor(root, temp.id)).closed_at, closed.closed_at);
});
