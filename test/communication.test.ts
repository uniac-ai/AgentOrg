/**
 * The communication standard: progress, questions and messages, between actors on the actor
 * library and a real core.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Actor } from "../src/actor/index.ts";
import { communication } from "../src/domain/communication.ts";
import {
  ActorCreate,
  COMMUNICATION,
  MessageSend,
  objectSchema,
  ProgressSet,
  QuestionAnswerRequest,
  QuestionAsk,
} from "../src/domain/model/index.ts";
import { progress } from "../src/domain/progress.ts";
import { type Core, done, type Json, refused, startCore, until } from "./harness.ts";

const issues = (result: { error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  (result.error?.issues ?? []).map((issue) => `${issue.path.join(".")}: ${issue.message}`);

test("each method's request and result is an object schema, as interfaces declare them", () => {
  for (const spec of Object.values(COMMUNICATION)) {
    assert.equal(objectSchema(spec.request, "input").type, "object");
    assert.equal(objectSchema(spec.response, "output").type, "object");
  }
});

test("a request breaking the records' rules is refused before it reaches the core", () => {
  assert.deepEqual(
    issues(
      QuestionAsk.safeParse({
        text: "Which order?",
        options: [{ label: "a" }, { label: "a" }],
        recommendation: "b",
      }),
    ),
    ["options: labels must be unique", "recommendation: must be the label of one of the options"],
  );
  assert.deepEqual(issues(QuestionAnswerRequest.safeParse({ questions: ["q_1"] })), [
    "text: an answer needs a choice or text",
  ]);
  assert.deepEqual(
    issues(QuestionAnswerRequest.safeParse({ questions: ["q_1"], choice: "a", recorded: true })),
    ["text: a recorded answer quotes the user's words"],
  );
  assert.deepEqual(
    issues(
      ProgressSet.safeParse({
        items: [
          { title: "Schemas", state: "running", waits_on: [{ item: "Review" }] },
          { title: "Schemas", state: "planned", waits_on: [{ actor: "act_1", item: "Review" }] },
        ],
      }),
    ),
    ["items: titles must be unique", "items.0.waits_on: there is no item Review"],
  );
  assert.equal(
    issues(
      MessageSend.safeParse({ to: "act_1", text: "Hi", links: [{ url: "javascript:alert(1)" }] }),
    ).length,
    1,
  );
});

test("Actor handles follow lowercase naming rules independently of Hub interface names", () => {
  const named = (name: string) => issues(ActorCreate.safeParse({ name, purpose: "Work" }));
  for (const name of [
    "actor",
    "call",
    "progress",
    "question",
    "message",
    "manager",
    "team",
    "storage",
  ]) {
    assert.deepEqual(named(name), [], name);
  }
  for (const name of ["", "Not-Lowercase", "name.with.dots", "name_with_underscores"])
    assert.ok(named(name).length > 0, name);
});

interface Member {
  id: string;
  actor: Actor;
}

async function member(core: Core, manager: Actor, name: string) {
  const created = await done(manager.call("actor_create", { name, purpose: `The ${name} work` }));
  const actor = await core.client(created.credential as string);
  return { id: created.actor.id as string, actor };
}

/** The root; release, its report, and storage, release's; and web, another report of the root. */
async function organization(options: Parameters<typeof startCore>[0] = {}) {
  const core = await startCore({ stepMs: 50, timeoutMs: 2000, ...options });
  const root: Member = { id: core.rootId, actor: await core.client(core.root) };
  const release = await member(core, root.actor, "release");
  const storage = await member(core, release.actor, "storage");
  const web = await member(core, root.actor, "web");
  return { core, root, release, storage, web };
}

const call = (from: Member, name: string, request: Record<string, unknown> = {}) =>
  done(from.actor.call(name, request));
const ids = (records: Json[]) => records.map((record: Json) => record.id);
const SHIP = { options: [{ label: "Ship" }, { label: "Wait" }], recommendation: "Ship" };

/** A read that must return before its wait ends: it fails, naming it, after a generous guard. */
const returns = <T>(what: string, read: Promise<T>) =>
  Promise.race([
    read,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`never happened: ${what}`)), 10_000).unref();
    }),
  ]);

test("progress is replaced field by field, read by anyone, and kept as history outside the default read", async (t) => {
  const { core, release, storage, web } = await organization();
  t.after(() => core.close());
  assert.equal(
    await refused(storage.actor.call("progress_set", { summary: "Reviewing" })),
    "invalid",
  );
  const set = await call(storage, "progress_set", {
    state: "running",
    summary: "Reviewing schema v2",
    items: [
      { title: "Schema", state: "running", links: [{ url: "https://example.com/pr/1" }] },
      { title: "Index", state: "planned", waits_on: [{ item: "Schema" }] },
    ],
    links: [{ url: "https://example.com/pr/1", title: "Schema v2" }],
  });
  assert.equal(set.version, 1);
  const second = await call(storage, "progress_set", { state: "review" });
  assert.deepEqual(
    [second.version, second.state, second.summary, second.items.length, second.links.length],
    [2, "review", "Reviewing schema v2", 2, 1],
  );

  const read = await call(web, "progress", { actor: storage.id });
  assert.deepEqual([read.progress.version, read.history], [2, []]);
  const withHistory = await call(web, "progress", { actor: storage.id, history: 5 });
  assert.deepEqual(
    withHistory.history.map((version: Json) => [version.version, version.state]),
    [[1, "running"]],
  );

  await call(release, "progress_set", {
    state: "running",
    items: [{ title: "Storage", state: "review", owner: storage.id }],
  });
  const named = await call(web, "progress", { actor: release.id });
  assert.equal(named.names[storage.id], "release.storage");
  const unknown = release.actor.call("progress_set", {
    items: [{ title: "Lost", state: "waiting", waits_on: [{ actor: "act_nobody" }] }],
  });
  assert.equal(await refused(unknown), "invalid");

  await core.restart();
  await until(
    "web resumes Hub calls after restart",
    async () => (await web.actor.call("team").catch(() => undefined))?.state === "done",
  );
  const kept = await call(web, "progress", { actor: storage.id, history: 1 });
  assert.deepEqual([kept.progress.version, kept.history.length], [2, 1]);
  const actor = core.org.registry.found(storage.id);
  const updates = progress(core.store.progress, core.org.registry, () => new Date().toISOString());
  const notes = communication(
    {
      questions: core.store.questions,
      messages: core.store.messages,
      head: () => core.store.head(),
      transaction: (work) => core.store.transaction(work),
    },
    core.org.registry,
    () => new Date().toISOString(),
  );
  const before = updates.latest(actor.id, 2);
  notes.ask(actor, { text: "Independent question" });
  assert.deepEqual(updates.latest(actor.id, 2), before);
  const questions = notes.openQuestions(actor.id);
  updates.set(actor, { summary: "Independent progress" });
  assert.deepEqual(notes.openQuestions(actor.id), questions);
});

test("team shows each position's purpose, presence, progress and open questions", async (t) => {
  const { core, root, release, storage, web } = await organization();
  t.after(() => core.close());
  await call(storage, "progress_set", { state: "blocked", summary: "Needs a call" });
  const question = await call(storage, "question_ask", { text: "Ship v2?", ...SHIP });

  const own = await call(release, "team");
  assert.equal(own.root, root.id);
  assert.deepEqual(
    own.positions.map((position: Json) => [
      position.path,
      position.online,
      position.progress?.state ?? null,
      ids(position.questions),
    ]),
    [
      ["release", true, null, []],
      ["release.storage", true, "blocked", [question.id]],
    ],
  );

  const whole = await call(web, "team", { actor: root.id, depth: 5 });
  assert.deepEqual(
    whole.positions.map((position: Json) => position.path),
    ["", "release", "release.storage", "web"],
  );
  const fromRoot = await call(root, "team", { actor: storage.id, depth: 0 });
  assert.equal(fromRoot.positions[0].purpose, "The storage work");
  for (const position of whole.positions) {
    assert.equal("interfaces" in position, false);
    assert.equal("created_at_attach" in position, false);
  }
});

test("a message goes to any position, is private to its parties, the manager of either and the root, and unread until read", async (t) => {
  const { core, root, release, storage, web } = await organization();
  t.after(() => core.close());
  const index = await member(core, storage.actor, "index");
  const finding = await call(web, "message_send", { to: storage.id, text: "The index is slow." });
  const built = await call(index, "message_send", { to: storage.id, text: "Index built." });

  const inbox = await call(storage, "messages", { unread: true });
  assert.deepEqual(ids(inbox.messages), [built.id, finding.id]);
  assert.equal(inbox.cursor, built.cursor);
  assert.deepEqual(ids((await call(web, "messages", { unread: true })).messages), []);
  assert.deepEqual(ids((await call(web, "messages", { box: "out" })).messages), [finding.id]);
  const seenBy = async (viewer: Member) =>
    ids((await call(viewer, "messages", { actor: storage.id })).messages);
  assert.deepEqual(await seenBy(root), [built.id, finding.id]);
  assert.deepEqual(await seenBy(release), [built.id, finding.id], "manager of a party");
  assert.deepEqual(await seenBy(web), [finding.id], "a party");
  const outsider = await member(core, root.actor, "outsider");
  assert.deepEqual(await seenBy(outsider), []);
  const hidden = outsider.actor.call("message_read", { ids: [finding.id] });
  assert.equal(await refused(hidden), "not_found");
  const notTheirs = release.actor.call("message_read", { ids: [finding.id] });
  assert.equal(await refused(notTheirs), "forbidden");

  const read = await call(storage, "message_read", { ids: [built.id] });
  assert.notEqual(read.messages[0].read_at, null);
  const sent = await call(index, "messages", { box: "out", with: storage.id });
  assert.equal(sent.messages[0].read_at, read.messages[0].read_at, "the sender sees the read");

  const reply = await call(storage, "message_send", {
    to: web.id,
    text: "Thanks; looking.",
    reply_to: finding.id,
  });
  assert.equal(reply.reply_to, finding.id);
  assert.deepEqual(ids((await call(storage, "messages", { unread: true })).messages), []);
  const astray = storage.actor.call("message_send", {
    to: release.id,
    text: "Forwarded",
    reply_to: finding.id,
  });
  assert.equal(await refused(astray), "invalid");
  assert.equal(
    await refused(storage.actor.call("message_send", { to: storage.id, text: "Me" })),
    "invalid",
  );

  const activity = await call(root, "activity", { limit: 50 });
  assert.ok(
    activity.entries.some(
      (entry: Json) => entry.operation === "message_send" && entry.target === finding.id,
    ),
  );
});

test("a question is public and pending on its addressee until answered; a manager carries it up with cause", async (t) => {
  const { core, root, release, storage, web } = await organization();
  t.after(() => core.close());
  const asked = await call(storage, "question_ask", { text: "Ship v2 first?", ...SHIP });
  assert.deepEqual([asked.to, asked.answer], [release.id, null]);
  const waitingOn = async (actor: Member) =>
    ids((await call(web, "questions", { to: actor.id, open: true })).questions);
  assert.deepEqual(await waitingOn(release), [asked.id]);
  assert.deepEqual(await waitingOn(root), []);
  const lateral = storage.actor.call("question_ask", { to: web.id, text: "Ship web?" });
  assert.equal(await refused(lateral), "forbidden");
  const wrongCause = web.actor.call("question_ask", { text: "Mine?", cause: asked.id });
  assert.equal(await refused(wrongCause), "invalid");
  assert.equal(await refused(root.actor.call("question_ask", { text: "Whom?" })), "invalid");

  const escalated = await call(release, "question_ask", {
    text: "Storage would ship v2 before the index. I recommend shipping.",
    ...SHIP,
    cause: asked.id,
  });
  assert.deepEqual([escalated.to, escalated.cause], [root.id, asked.id]);
  const { cursor } = await call(storage, "questions", { from: storage.id });
  const answered = call(storage, "questions", { from: storage.id, since: cursor, wait: 30 });

  await call(root, "question_answer", { questions: [escalated.id], choice: "Ship" });
  const answer = await call(release, "question_answer", {
    questions: [asked.id],
    choice: "Ship",
    text: "Ship it.",
  });
  const [seen] = (await answered).questions;
  assert.deepEqual(
    [seen.id, seen.answer.by, seen.answer.choice, seen.answer.recorded, seen.cursor > cursor],
    [asked.id, release.id, "Ship", false, true],
  );
  assert.equal(answer.questions[0].id, asked.id);
  const again = release.actor.call("question_answer", { questions: [asked.id], text: "Wait." });
  assert.equal(await refused(again), "conflict");
  assert.deepEqual(await waitingOn(release), []);
  const team = await call(web, "team", { actor: storage.id, depth: 0 });
  assert.deepEqual(team.positions[0].questions, []);
});

test("an approval names its answerer: that actor or the root answers it, and the asker may not record it", async (t) => {
  const { core, root, release, storage } = await organization();
  t.after(() => core.close());
  const { root: rootId } = await call(storage, "team");
  const gate = await call(storage, "question_ask", {
    text: "Promote v2 to prod?",
    options: [{ label: "Approve" }, { label: "Hold" }],
    answerer: rootId,
  });
  const relayed = release.actor.call("question_answer", {
    questions: [gate.id],
    choice: "Approve",
    text: "The user said approve.",
  });
  assert.equal(await refused(relayed), "forbidden");
  const recorded = storage.actor.call("question_answer", {
    questions: [gate.id],
    text: "Approve",
    recorded: true,
  });
  assert.equal(await refused(recorded), "forbidden");
  const approval = await call(root, "question_answer", {
    questions: [gate.id],
    choice: "Approve",
  });
  assert.deepEqual(
    [approval.questions[0].answer.by, approval.questions[0].answer.recorded],
    [root.id, false],
  );

  const lane = await call(storage, "question_ask", {
    text: "Which lane?",
    ...SHIP,
    answerer: release.id,
  });
  const steppedIn = await call(root, "question_answer", { questions: [lane.id], text: "Wait" });
  assert.equal(steppedIn.questions[0].answer.by, root.id, "the root may always answer");
});

test("the asker records the user's words for its own questions; one answer resolves several, its choice optional", async (t) => {
  const { core, root, release, storage } = await organization();
  t.after(() => core.close());
  const order = await call(release, "question_ask", { to: root.id, text: "Order?", ...SHIP });
  const lane = await call(release, "question_ask", { text: "Which lane?" });
  const notOffered = root.actor.call("question_answer", {
    questions: [order.id, lane.id],
    choice: "Later",
  });
  assert.equal(await refused(notOffered), "invalid");
  const recorded = await call(release, "question_answer", {
    questions: [order.id, lane.id],
    text: '"Neither: hold both until the index lands."',
    recorded: true,
  });
  assert.deepEqual(
    recorded.questions.map((question: Json) => [
      question.id,
      question.answer.by,
      question.answer.recorded,
      question.answer.choice,
    ]),
    [
      [lane.id, release.id, true, null],
      [order.id, release.id, true, null],
    ],
  );
  const asked = await call(storage, "question_ask", { text: "Start?" });
  const others = release.actor.call("question_answer", {
    questions: [asked.id],
    text: "Yes",
    recorded: true,
  });
  assert.equal(await refused(others), "forbidden");
});

test("since a cursor, a wait returns at the next message, question or answer, and a read but open question does not match again", async (t) => {
  // No progress step and the longest wait, so only a write can end each read in time.
  const { core, release, storage } = await organization({ stepMs: 60_000 });
  t.after(() => core.close());
  const empty = await call(storage, "messages", { wait: 0.2 });
  assert.deepEqual(empty.messages, []);

  const start = empty.cursor;
  const inbox = call(storage, "messages", { since: start, wait: 600 });
  const brief = await call(release, "message_send", { to: storage.id, text: "Start the index." });
  assert.deepEqual(ids((await returns("a new message", inbox)).messages), [brief.id]);

  const asked = await call(storage, "question_ask", { text: "Ship v2?", ...SHIP });
  const { cursor } = await call(release, "questions", { to: release.id, open: true });
  const seen = await call(release, "questions", { to: release.id, open: true, since: cursor });
  assert.deepEqual(seen.questions, [], "an open question already seen");

  const answers = call(storage, "questions", { from: storage.id, since: cursor, wait: 600 });
  await call(release, "question_answer", { questions: [asked.id], choice: "Ship" });
  const answered = await returns("a new answer", answers);
  assert.deepEqual(
    [ids(answered.questions), answered.questions[0].answer.choice],
    [[asked.id], "Ship"],
  );
});

test("a claim holds a shared resource for one actor at a time, shown in team, until released, past its until or its holder closed", async (t) => {
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const { core, root, release, storage, web } = await organization({ now: () => new Date(clock) });
  t.after(() => core.close());
  const lane = { resource: "prod-lane", note: "Promoting v2", until: "2026-01-01T01:00:00Z" };
  assert.equal((await call(storage, "claim", lane)).holder, storage.id);
  const taken = await web.actor.call("claim", { resource: "prod-lane", note: "Promoting web" });
  assert.equal(
    taken.state === "refused" && taken.message,
    "prod-lane is held by release.storage until 2026-01-01T01:00:00.000Z: Promoting v2",
  );
  const team = await call(web, "team", { actor: root.id, depth: 2 });
  assert.deepEqual(
    team.positions.map((position: Json) => [
      position.path,
      position.claims.map((claim: Json) => claim.resource),
    ]),
    [
      ["", []],
      ["release", []],
      ["release.storage", ["prod-lane"]],
      ["web", []],
    ],
  );
  assert.equal(await refused(web.actor.call("release", { resource: "prod-lane" })), "forbidden");

  clock = Date.parse("2026-01-01T01:00:01Z");
  await call(web, "claim", { resource: "prod-lane", note: "Promoting web" });
  assert.equal((await call(web, "release", { resource: "prod-lane" })).holder, web.id);
  assert.equal(await refused(web.actor.call("release", { resource: "prod-lane" })), "not_found");
  assert.equal(await refused(web.actor.call("claim", { ...lane, note: "Late" })), "invalid");

  await call(storage, "claim", { resource: "dev-cluster", note: "Load test" });
  const renewed = await call(storage, "claim", { resource: "dev-cluster", note: "Soak" });
  assert.equal(renewed.note, "Soak");
  await call(release, "actor_close", { actor: storage.id });
  await call(web, "claim", { resource: "dev-cluster", note: "Next" });
  assert.equal((await call(root, "release", { resource: "dev-cluster" })).holder, web.id);

  const activity = await call(root, "activity", { limit: 50 });
  assert.ok(
    activity.entries.some(
      (entry: Json) => entry.operation === "claim" && entry.target === "dev-cluster",
    ),
  );
});
