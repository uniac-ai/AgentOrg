/**
 * `team` derives each position's state, headline and ask counts at read time from the Work on it
 * and the open asks under it; `actor_view` reads one Actor's report with the same state and
 * headline, and what needs it.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { Actor } from "../src/actor/index.ts";
import { Team } from "../src/contract/index.ts";
import { type Core, done, type Json, refused, startCore } from "./harness.ts";

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
const ask = (client: Actor, work: Json, title: string, input: Json = {}) =>
  done(client.call("work_update", { ticketID: work.ticketID, ask: { title, fields, ...input } }));
const close = (client: Actor, form: Json) =>
  done(
    client.call("work_update", {
      close: { askID: form.formID, status: "cancelled", resolution: "Withdrawn" },
    }),
  );
/** An older ask, written raw: by any Actor, on any Work or on none. */
function stored(core: Core, requesterID: string, title: string, input: Json = {}) {
  const { workspace } = core.store;
  const at = new Date().toISOString();
  const formID = randomUUID();
  const row = {
    formID,
    requesterID,
    title,
    links: [],
    approval: false,
    collect: false,
    fields,
    status: "open",
    createdAt: at,
    responses: {},
    ...input,
  };
  workspace.transaction(() =>
    workspace.forms.save(formID, row as never, {
      actorID: requesterID,
      at,
      action: "created",
      detail: row,
    }),
  );
  return formID;
}
/** Work stored blocked before blocked was refused, written raw. */
function blocked(core: Core, work: Json) {
  const { workspace } = core.store;
  const {
    revision,
    cursor: _cursor,
    updatedAt: _updatedAt,
    ...row
  }: Json = workspace.work.get(work.ticketID);
  const detail = { status: "blocked" };
  workspace.transaction(() =>
    workspace.work.save(
      work.ticketID,
      { ...row, ...detail },
      { actorID: row.ownerID, at: new Date().toISOString(), action: "updated", detail },
      revision,
    ),
  );
}
/** Lets the next write's time follow the last one's: ties in time go to the earlier write. */
const later = () => new Promise((resolve) => setTimeout(resolve, 2));
const view = (by: Actor, actorID: string, input: Json = {}) =>
  done(by.call("actor_view", { actorID, ...input }));
const ids = (items: Json[], key = "ticketID") => items.map((item: Json) => item[key]);
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
  const early = await ask(worker.client, stream, "Before starting?");
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
  // Older asks: one by another Actor on the Work, and one on no Work.
  stored(core, peer.id, "Not the owner's", { workID: stream.ticketID });
  stored(core, worker.id, "On no Work");
  assert.equal(
    await state(worker.id),
    "active",
    "an ask by another Actor, or on no Work, never makes Work waiting",
  );
  assert.equal(
    await refused(
      worker.client.call("work_update", { ticketID: stream.ticketID, status: "blocked" }),
    ),
    "invalid",
  );
  blocked(core, stream);
  assert.equal(await state(worker.id), "active", "a stored blocked reads as active");

  const temp = await make("temp", lead.client);
  const handover = await create(lead.client, "Handover", { ownerID: temp.id });
  await update(temp.client, handover, { status: "active" });
  stored(core, temp.id, "Left open");
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

  const question = await ask(worker.client, second, "Which one?");
  const waiting = await position(peer.client, worker.id);
  assert.deepEqual(
    [waiting.state, waiting.headline.subject],
    ["waiting", subject(second, "waiting")],
    "waiting outranks review",
  );
  await close(worker.client, question);

  await done(
    lead.client.call("work_answer", {
      ticketID: redo.ticketID,
      askID: submitted.submission.submissionID,
      answers: { verdict: "changes_requested" },
      note: "Again",
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
  const older = await ask(worker.client, work, "Which region?");
  await ask(worker.client, work, "Delete the bucket?", { approval: true });
  assert.deepEqual(await clause(), { kind: "ask", text: "Which region?" }, "the oldest ask");
  await close(worker.client, older);
  assert.deepEqual(await clause(), { kind: "approval", text: "Delete the bucket?" });

  const reviewer = await make("reviewer", lead.client);
  const leftover = await create(lead.client, "Leftover", { ownerID: reviewer.id });
  await update(reviewer.client, leftover, { status: "active" });
  await done(reviewer.client.call("work_submit", { ticketID: leftover.ticketID, result: "Done" }));
  // Submitting cancels the Work's open asks, so one left open is an older row.
  stored(core, reviewer.id, "Ship it?", { workID: leftover.ticketID, approval: true });
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
    stored(core, peer.id, `Question ${n}`);
  }
  const stream = await create(worker.client, "Stream");
  await update(worker.client, stream, { status: "active" });
  await ask(worker.client, stream, "Mine");
  const temp = await make("temp", worker.client);
  stored(core, temp.id, "Left open");
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

test("a few positions read their own Work, and give what a read of the whole tree gives", async (t) => {
  const { core, root, make, lead, worker, peer } = await organization();
  t.after(() => core.close());
  const members = [lead, worker, peer];
  for (let n = 0; n < 20; n += 1)
    members.push(await make(`member-${n}`, n % 2 ? lead.client : root));
  for (const [n, member] of members.entries()) {
    const work = await create(member.client, `Work ${n}`);
    if (n % 3 !== 0)
      await update(member.client, work, { status: "active", progress: `Step ${n}.` });
    if (n % 4 === 1) await ask(member.client, work, `Question ${n}`);
    if (n % 6 === 3) await update(member.client, work, { waitsOn: { actorID: peer.id } });
    if (n % 5 === 2) {
      const finished = await create(member.client, `Done ${n}`);
      await done(
        member.client.call("work_submit", { ticketID: finished.ticketID, result: "Done" }),
      );
    }
  }
  // Past the most recent page of finished Work, a large read reads the rest on its own.
  for (let n = 0; n < 101; n += 1) {
    const other = await create(peer.client, `Other ${n}`);
    await done(peer.client.call("work_submit", { ticketID: other.ticketID, result: "Done" }));
  }
  const whole = (await done(root.call("team", { actor: core.rootId, depth: 20 }))).positions;
  assert.ok(whole.length > 20, "the whole tree takes the organization's pass");
  assert.ok(whole.filter((each: Json) => each.headline.finished).length > 1);
  const read = (id: string) => whole.find((each: Json) => each.id === id);
  for (const each of whole) assert.deepEqual(await position(root, each.id), each, each.name);
  const small = (await done(root.call("team", { actor: lead.id }))).positions;
  assert.ok(small.length > 1 && small.length <= 20);
  for (const each of small) assert.deepEqual(each, read(each.id), each.name);
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

test("actor_view reads an Actor's report with team's state and headline, and what needs it", async (t) => {
  const { core, root, lead, worker, peer } = await organization();
  t.after(() => core.close());
  const empty = await view(peer.client, worker.id);
  assert.deepEqual(
    [empty.state, empty.headline, empty.actor.actorID, empty.actor.lastActiveAt],
    [
      "idle",
      { subject: null, clause: null, more: 0, notStarted: 0, finished: null },
      worker.id,
      null,
    ],
  );
  const stream = await create(worker.client, "Stream");
  await update(worker.client, stream, { status: "active" });
  const linked = await ask(worker.client, stream, "Linked");
  const onStream = stored(core, peer.id, "On the stream", { workID: stream.ticketID });
  const later = await create(worker.client, "Later");
  const early = await create(worker.client, "Asked before starting");
  const before = await ask(worker.client, early, "Which way?");
  const others = await create(worker.client, "Only another's ask");
  const peers = stored(core, peer.id, "Not the owner's", { workID: others.ticketID });
  const loose = stored(core, worker.id, "On no Work");
  const elsewhere = stored(core, worker.id, "On peer's Work", {
    workID: (await create(peer.client, "Peer's")).ticketID,
  });
  const quick = await create(worker.client, "Quick");
  await done(worker.client.call("work_submit", { ticketID: quick.ticketID, result: "Done" }));
  const leftover = stored(core, worker.id, "On finished Work", { workID: quick.ticketID });
  const withdrawn = await ask(worker.client, stream, "Withdrawn");
  await close(worker.client, withdrawn);
  const yours = await create(lead.client, "Yours", { ownerID: worker.id });
  const redo = await create(lead.client, "Redo", { ownerID: worker.id });
  await update(worker.client, redo, { status: "active" });
  const submitted = await done(
    worker.client.call("work_submit", { ticketID: redo.ticketID, result: "First" }),
  );
  await done(
    lead.client.call("work_answer", {
      askID: submitted.submission.submissionID,
      answers: { verdict: "changes_requested" },
      note: "Again",
    }),
  );
  const review = await create(lead.client, "In review", { ownerID: worker.id });
  await update(worker.client, review, { status: "active" });
  await done(worker.client.call("work_submit", { ticketID: review.ticketID, result: "Over" }));
  const dropped = await create(lead.client, "Dropped", { ownerID: worker.id });
  await done(
    lead.client.call("work_update", {
      ticketID: dropped.ticketID,
      expectedRevision: dropped.revision,
      status: "cancelled",
    }),
  );
  const accepted = await create(peer.client, "Accepted", { ownerID: worker.id });
  await update(worker.client, accepted, { status: "active" });
  const sent = await done(
    worker.client.call("work_submit", { ticketID: accepted.ticketID, result: "Done" }),
  );
  await done(
    peer.client.call("work_answer", {
      askID: sent.submission.submissionID,
      answers: { verdict: "accepted" },
    }),
  );

  const report = await view(peer.client, worker.id);
  const seen = await position(peer.client, worker.id);
  assert.deepEqual([report.state, report.headline], [seen.state, seen.headline]);
  assert.equal(report.state, "waiting");
  assert.deepEqual(
    [report.actor.name, report.actor.path, report.actor.online, report.actor.managerID],
    ["worker", "lead.worker", true, lead.id],
  );
  assert.deepEqual(
    report.workstreams.map((item: Json) => [item.ticketID, ids(item.asks, "formID")]),
    [
      [stream.ticketID, [linked.formID, onStream]],
      [early.ticketID, [before.formID]],
      [redo.ticketID, []],
      [review.ticketID, []],
    ],
    "Work on it that is waiting, in review or active, with its open asks",
  );
  assert.equal(report.headline.more, report.workstreams.length - 1);
  assert.deepEqual(
    ids(report.asks, "formID").sort(),
    [linked.formID, before.formID, loose, elsewhere, leftover].sort(),
    "its own open asks wherever they are, and no closed one",
  );
  assert.deepEqual(ids(report.assigned), [yours.ticketID, redo.ticketID]);
  assert.deepEqual(ids(report.followUps), [later.ticketID, early.ticketID, others.ticketID]);
  assert.deepEqual(ids(report.completed), [accepted.ticketID, quick.ticketID]);
  assert.deepEqual(report.headline.finished?.ticketID, accepted.ticketID, "not the cancelled");
  assert.ok(report.actors[peer.id], "a requester only completed Work names");
  assert.deepEqual([report.needs, report.reports, report.answered], [[], [], undefined]);
  assert.deepEqual((await view(peer.client, worker.id, { completed: 0 })).completed, []);

  const manager = await view(lead.client, lead.id);
  assert.equal(manager.state, "idle", "its reports' Work doesn't make its state");
  assert.deepEqual(manager.workstreams, []);
  assert.deepEqual(ids(manager.reviews), [review.ticketID]);
  assert.deepEqual(
    ids(manager.needs, "formID").sort(),
    [linked.formID, before.formID, loose, elsewhere, leftover].sort(),
    "its reports' open asks",
  );
  assert.deepEqual(ids(manager.reports, "id"), [worker.id]);
  await done(lead.client.call("work_answer", { askID: linked.formID, raise: true }));
  assert.equal(
    ids((await view(lead.client, lead.id)).needs, "formID").includes(linked.formID),
    false,
  );
  assert.deepEqual(
    ids((await view(root, core.rootId)).needs, "formID").sort(),
    [linked.formID, peers, onStream].sort(),
    "the raised ask, and its own report's",
  );
  assert.equal(await refused(lead.client.call("actor_view", { actorID: "missing" })), "not_found");
});

test("actor_view routes a closed requester's part to its stand-in", async (t) => {
  const { core, make, lead, worker, peer } = await organization();
  t.after(() => core.close());
  const outer = await make("outer", lead.client);
  const inner = await make("inner", outer.client);
  const handed = await create(inner.client, "Handed up", { ownerID: worker.id });
  await update(worker.client, handed, { status: "active" });
  await done(worker.client.call("work_submit", { ticketID: handed.ticketID, result: "Done" }));
  const quit = await make("quit", lead.client);
  const finished = await create(lead.client, "Submitted, then its owner left", {
    ownerID: quit.id,
  });
  await update(quit.client, finished, { status: "active" });
  await done(quit.client.call("work_submit", { ticketID: finished.ticketID, result: "Done" }));
  await done(lead.client.call("actor_close", { actor: quit.id }));
  const gone = await make("gone", lead.client);
  const stranded = await create(inner.client, "Stranded", { ownerID: gone.id });
  const going = await create(inner.client, "Still owned", { ownerID: worker.id });
  await done(lead.client.call("actor_close", { actor: gone.id }));
  await done(outer.client.call("actor_close", { actor: inner.id }));
  await done(lead.client.call("actor_close", { actor: outer.id }));
  const manager = await view(lead.client, lead.id);
  assert.deepEqual(
    ids(manager.reviews),
    [handed.ticketID, finished.ticketID],
    "past two closed requesters, and submitted Work whose owner left",
  );
  assert.deepEqual(
    ids(manager.ownerClosed),
    [stranded.ticketID],
    "a closed requester's Work with its owner closed, not Work its owner still holds",
  );
  assert.equal(ids(manager.ownerClosed).includes(going.ticketID), false);
  assert.ok(manager.actors[inner.id] && manager.actors[gone.id], "the parties it returns");
  assert.deepEqual(
    (await position(peer.client, worker.id)).headline.clause,
    { kind: "review", text: "with lead for review" },
    "the review is with the closed requester's stand-in",
  );
  const owner = await make("owner", lead.client);
  const orphaned: string[] = [];
  for (let n = 0; n < 101; n += 1)
    orphaned.push((await create(lead.client, `Orphan ${n}`, { ownerID: owner.id })).ticketID);
  await done(lead.client.call("actor_close", { actor: owner.id }));
  assert.deepEqual(
    ids((await view(lead.client, lead.id)).ownerClosed),
    [stranded.ticketID, ...orphaned],
    "every page, past a hundred",
  );
});

test("actor_view's needs pass closed managers and pages, and answered crosses Work", async (t) => {
  const { core, root, make, lead, worker, peer } = await organization();
  t.after(() => core.close());
  const sub = await make("sub", worker.client);
  const left = await ask(sub.client, await create(sub.client, "Sub's"), "Left open");
  await done(worker.client.call("actor_close", { actor: sub.id }));
  await done(lead.client.call("actor_close", { actor: worker.id }));
  assert.deepEqual(
    ids((await view(lead.client, lead.id)).needs, "formID"),
    [left.formID],
    "routed past closed managers",
  );
  const asker = await make("asker", lead.client);
  const many = Array.from({ length: 101 }, (_, n) => stored(core, asker.id, `Question ${n}`));
  assert.deepEqual(
    ids((await view(lead.client, lead.id)).needs, "formID").sort(),
    [left.formID, ...many].sort(),
    "every page, past a hundred",
  );
  const collecting = await ask(asker.client, await create(asker.client, "Poll"), "Who's in?", {
    collect: true,
  });
  await done(
    peer.client.call("work_answer", { askID: collecting.formID, answers: { answer: "Me" } }),
  );
  const theirs = stored(core, asker.id, "On root's Work?", {
    workID: (await create(root, "Root's")).ticketID,
    status: "resolved",
    responses: { [peer.id]: { answers: { answer: "No" }, at: new Date().toISOString() } },
  });
  assert.deepEqual(
    (await view(root, asker.id, { answeredBy: peer.id })).answered.map((each: Json) => each.formID),
    [collecting.formID, theirs],
    "its asks that Actor answered, open or closed, on any Work",
  );
});
