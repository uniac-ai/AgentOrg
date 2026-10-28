/**
 * The communication standard: progress, messages and questions, between actors on the actor
 * library and a real core.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Actor } from "../src/actor/index.ts";
import {
  COMMUNICATION,
  MessageSend,
  objectSchema,
  ProgressSet,
} from "../src/domain/model/index.ts";
import {
  type Core,
  done,
  fakeActor,
  iface,
  type Json,
  refused,
  startCore,
  until,
} from "./harness.ts";

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
      MessageSend.safeParse({
        text: "Which order?",
        options: [{ label: "a" }, { label: "a" }],
        recommendation: "b",
        choice: "a",
      }),
    ),
    [
      "options: labels must be unique",
      "recommendation: must be the label of one of the options",
      "choice: only a reply has one",
    ],
  );
  assert.deepEqual(issues(MessageSend.safeParse({ text: "FYI", answerer: "act_1" })), [
    "answerer: only a question has one",
  ]);
  assert.deepEqual(issues(MessageSend.safeParse({ text: "Go?", expects_reply: true })), []);
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
  assert.deepEqual(
    issues(ProgressSet.safeParse({ links: [{ url: "javascript:alert(1)" }] })).length,
    1,
  );
});

const REVIEW = iface("review", { output: { type: "object" } });

interface Member {
  id: string;
  actor: Actor;
}

async function member(core: Core, manager: Actor, name: string, exposed = fakeActor()) {
  const created = await done(manager.call("actor_create", { name, purpose: `The ${name} work` }));
  const actor = await core.connect(created.credential as string, exposed);
  return { id: created.actor.id as string, actor };
}

/** The root; release, its report, and storage, release's; and web, another report of the root. */
async function organization(options: Parameters<typeof startCore>[0] = {}) {
  const core = await startCore({ waitMs: 2000, stepMs: 50, timeoutMs: 2000, ...options });
  const root: Member = { id: core.rootId, actor: await core.client(core.root) };
  const release = await member(core, root.actor, "release");
  const storage = await member(core, release.actor, "storage", fakeActor([REVIEW]));
  const web = await member(core, root.actor, "web");
  return { core, root, release, storage, web };
}

const send = (from: Member, request: Record<string, unknown>) =>
  done(from.actor.call("message_send", request));
const ids = (result: Json) => result.messages.map((message: Json) => message.id);
const QUESTION = { options: [{ label: "Ship" }, { label: "Wait" }], recommendation: "Ship" };

test("progress is replaced field by field, read by anyone, and kept as history outside the default read", async () => {
  const { core, release, storage, web } = await organization();
  try {
    const first = storage.actor.call("progress_set", { summary: "Reviewing" });
    assert.equal(await refused(first), "invalid");
    const set = await done(
      storage.actor.call("progress_set", {
        state: "running",
        summary: "Reviewing schema v2",
        items: [
          { title: "Schema", state: "running", links: [{ url: "https://example.com/pr/1" }] },
          { title: "Index", state: "planned", waits_on: [{ item: "Schema" }] },
        ],
        links: [{ url: "https://example.com/pr/1", title: "Schema v2" }],
      }),
    );
    assert.equal(set.version, 1);
    const second = await done(storage.actor.call("progress_set", { state: "review" }));
    assert.deepEqual(
      [second.version, second.state, second.summary, second.items.length, second.links.length],
      [2, "review", "Reviewing schema v2", 2, 1],
    );

    const read = await done(web.actor.call("progress", { actor: storage.id }));
    assert.deepEqual([read.progress.version, read.history], [2, []]);
    const withHistory = await done(web.actor.call("progress", { actor: storage.id, history: 5 }));
    assert.deepEqual(
      withHistory.history.map((version: Json) => [version.version, version.state]),
      [[1, "running"]],
    );

    const owned = await done(
      release.actor.call("progress_set", {
        state: "running",
        items: [{ title: "Storage", state: "review", owner: storage.id }],
      }),
    );
    assert.equal(owned.items[0].owner, storage.id);
    const named = await done(web.actor.call("progress", { actor: release.id }));
    assert.equal(named.names[storage.id], "release.storage");
    const unknown = release.actor.call("progress_set", {
      items: [{ title: "Lost", state: "waiting", waits_on: [{ actor: "act_nobody" }] }],
    });
    assert.equal(await refused(unknown), "invalid");

    await core.restart();
    await until("web connected again", () => core.org.registry.get(web.id)?.online === true);
    const kept = await done(web.actor.call("progress", { actor: storage.id, history: 1 }));
    assert.deepEqual([kept.progress.version, kept.history.length], [2, 1]);
  } finally {
    await core.close();
  }
});

test("team shows each position's purpose, presence, progress and open questions, and the interfaces the caller can call", async () => {
  const { core, root, release, storage, web } = await organization();
  try {
    await done(storage.actor.call("progress_set", { state: "blocked", summary: "Needs a call" }));
    const question = await send(storage, { text: "Ship v2?", ...QUESTION });

    const own = await done(release.actor.call("team"));
    assert.equal(own.root, root.id);
    assert.deepEqual(
      own.positions.map((position: Json) => [
        position.path,
        position.online,
        position.progress?.state ?? null,
        position.questions.map((each: Json) => each.id),
        position.interfaces,
      ]),
      [
        ["release", true, null, [], []],
        ["release.storage", true, "blocked", [question.id], ["storage.review"]],
      ],
    );

    const whole = await done(web.actor.call("team", { actor: root.id, depth: 5 }));
    assert.deepEqual(
      whole.positions.map((position: Json) => [position.path, position.interfaces]),
      [
        ["", []],
        ["release", []],
        ["release.storage", []],
        ["web", []],
      ],
    );
    const fromRoot = await done(root.actor.call("team", { actor: storage.id, depth: 0 }));
    assert.deepEqual(fromRoot.positions[0].interfaces, ["release.storage.review"]);
    assert.equal(fromRoot.positions[0].purpose, "The storage work");
  } finally {
    await core.close();
  }
});

test("a message is private to its parties, the manager of either and the root, and pending on its addressee until read", async () => {
  const { core, root, release, storage, web } = await organization();
  try {
    const index = await member(core, storage.actor, "index");
    const brief = await send(release, { to: storage.id, text: "Review schema v2 first." });
    assert.equal(brief.public, false);
    const done1 = await send(index, { text: "Index built." });

    assert.deepEqual(ids(await done(storage.actor.call("messages", { pending: true }))), [
      done1.id,
      brief.id,
    ]);
    assert.deepEqual(ids(await done(release.actor.call("messages", { pending: true }))), []);
    assert.deepEqual(ids(await done(release.actor.call("messages", { box: "out" }))), [brief.id]);
    const seenBy = async (viewer: Member) =>
      ids(await done(viewer.actor.call("messages", { actor: storage.id })));
    assert.deepEqual(await seenBy(root), [done1.id, brief.id]);
    assert.deepEqual(await seenBy(release), [done1.id, brief.id], "manager of a party");
    assert.deepEqual(await seenBy(web), []);
    assert.equal(await refused(web.actor.call("message_read", { ids: [brief.id] })), "not_found");
    assert.equal(
      await refused(release.actor.call("message_read", { ids: [brief.id] })),
      "forbidden",
    );

    const read = await done(storage.actor.call("message_read", { ids: [brief.id] }));
    assert.notEqual(read.messages[0].read_at, null);
    const sent = await done(release.actor.call("messages", { box: "out", with: storage.id }));
    assert.equal(sent.messages[0].read_at, read.messages[0].read_at, "the sender sees the read");
    assert.deepEqual(ids(await done(storage.actor.call("messages", { pending: true }))), [
      done1.id,
    ]);

    assert.equal(
      await refused(storage.actor.call("message_send", { to: web.id, text: "Hi" })),
      "forbidden",
    );
    assert.equal(await refused(root.actor.call("message_send", { text: "To whom?" })), "invalid");
    assert.equal(
      (await send(root, { to: storage.id, text: "Anyone, from the root" })).to,
      storage.id,
    );

    const activity = await done(root.actor.call("activity", { limit: 50 }));
    assert.ok(
      activity.entries.some(
        (entry: Json) => entry.operation === "message_send" && entry.target === brief.id,
      ),
    );
  } finally {
    await core.close();
  }
});

test("a question is public and pending on its addressee until answered; a manager escalates it with cause", async () => {
  const { core, root, release, storage, web } = await organization();
  try {
    const asked = await send(storage, { text: "Ship v2 before the index?", ...QUESTION });
    assert.deepEqual([asked.to, asked.public, asked.expects_reply], [release.id, true, true]);
    assert.deepEqual(ids(await done(release.actor.call("messages", { pending: true }))), [
      asked.id,
    ]);
    assert.deepEqual(ids(await done(root.actor.call("messages", { pending: true }))), []);
    const outside = await done(web.actor.call("messages", { actor: storage.id, box: "out" }));
    assert.deepEqual(ids(outside), [asked.id]);
    const wrongCause = web.actor.call("message_send", { text: "Mine?", cause: asked.id });
    assert.equal(await refused(wrongCause), "invalid");

    const escalated = await send(release, {
      text: "Storage would ship v2 before the index. I recommend shipping.",
      ...QUESTION,
      cause: asked.id,
    });
    assert.deepEqual([escalated.to, escalated.cause], [root.id, asked.id]);
    const waiting = done(storage.actor.call("messages", { reply_to: asked.id, wait: 30 }));

    const settled = await send(root, { reply_to: [escalated.id], choice: "Ship", text: "Ship" });
    assert.deepEqual([settled.to, settled.public], [release.id, true]);
    const answer = await send(release, { reply_to: [asked.id], choice: "Ship", text: "Ship it." });
    assert.deepEqual(ids(await waiting), [answer.id]);

    const question = await done(storage.actor.call("messages", { box: "out" }));
    assert.deepEqual(
      [question.messages[0].answer, question.messages[0].read_at !== null],
      [answer.id, true],
    );
    assert.deepEqual(ids(await done(release.actor.call("messages", { pending: true }))), [
      settled.id,
    ]);
    const again = release.actor.call("message_send", { reply_to: [asked.id], text: "Wait." });
    assert.equal(await refused(again), "conflict");
    const team = await done(web.actor.call("team", { actor: storage.id, depth: 0 }));
    assert.deepEqual(team.positions[0].questions, []);
  } finally {
    await core.close();
  }
});

test("an approval names its answerer: only that actor answers, and the reply records who did", async () => {
  const { core, root, release, storage, web } = await organization();
  try {
    const { root: rootId } = await done(storage.actor.call("team"));
    const gate = await send(storage, {
      text: "Promote v2 to prod?",
      options: [{ label: "Approve" }, { label: "Hold" }],
      answerer: rootId,
    });
    const relayed = release.actor.call("message_send", {
      reply_to: [gate.id],
      choice: "Approve",
      text: "The user said approve.",
    });
    assert.equal(await refused(relayed), "forbidden");
    const escalated = await send(release, {
      text: "Storage asks to promote v2 to prod; only you may approve.",
      expects_reply: true,
      cause: gate.id,
    });
    const both = { reply_to: [escalated.id, gate.id], choice: "Approve", text: "Approved." };
    assert.equal(await refused(root.actor.call("message_send", both)), "invalid");
    const approval = await send(root, { ...both, to: storage.id });
    assert.equal(approval.from, root.id);

    const found = await done(storage.actor.call("messages", { reply_to: gate.id }));
    assert.deepEqual(ids(found), [approval.id]);
    const byRelease = await done(release.actor.call("messages", { reply_to: escalated.id }));
    assert.deepEqual(ids(byRelease), [approval.id], "an answer is public with its question");
    const seen = await done(web.actor.call("progress", { actor: storage.id }));
    assert.deepEqual(seen.questions, []);
  } finally {
    await core.close();
  }
});

test("one reply answers several questions, a choice is optional, and replying to a message marks it read", async () => {
  const { core, root, release } = await organization();
  try {
    const order = await send(release, { to: root.id, text: "Release order?", ...QUESTION });
    const lane = await send(release, { text: "Which lane?", expects_reply: true });
    const offered = root.actor.call("message_send", {
      reply_to: [order.id, lane.id],
      choice: "Later",
      text: "Later",
    });
    assert.equal(await refused(offered), "invalid");
    const reply = await send(root, {
      reply_to: [order.id, lane.id],
      text: "Neither: hold both until the index lands.",
    });
    assert.deepEqual(
      [reply.to, reply.choice, reply.reply_to],
      [release.id, null, [order.id, lane.id]],
    );
    const asked = await done(release.actor.call("messages", { box: "out" }));
    assert.deepEqual(
      asked.messages.map((message: Json) => message.answer),
      [reply.id, reply.id],
    );

    const fyi = await send(root, { to: release.id, text: "The index landed." });
    await send(release, { reply_to: [fyi.id], text: "Thanks." });
    const inbox = await done(release.actor.call("messages", { pending: true }));
    assert.deepEqual(ids(inbox), [reply.id]);
  } finally {
    await core.close();
  }
});

test("messages waits until a match exists, and ends empty when none comes in time", async () => {
  // No progress step and the longest wait, so only the new message can end the read in time.
  const { core, release, storage } = await organization({ stepMs: 60_000 });
  try {
    const empty = await done(storage.actor.call("messages", { wait: 0.2 }));
    assert.deepEqual(empty.messages, []);
    const waiting = done(storage.actor.call("messages", { pending: true, wait: 600 }));
    const brief = await send(release, { to: storage.id, text: "Start the index." });
    const guard = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error("never happened: the waiting read returned")),
        10_000,
      ).unref();
    });
    assert.deepEqual(ids(await Promise.race([waiting, guard])), [brief.id]);
  } finally {
    await core.close();
  }
});
