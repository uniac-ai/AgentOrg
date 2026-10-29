import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessageRecord, QuestionRecord } from "../../../src/clients/web/types.ts";
import { json, setup } from "./harness.ts";

/** A built-in's value, called by a program actor. */
async function value<T>(answer: Promise<unknown>): Promise<T> {
  const settled = (await answer) as { state: string; value?: unknown };
  assert.equal(settled.state, "done", JSON.stringify(settled));
  return settled.value as T;
}

test("the user answers two questions at once, and the asker finds the answers by its cursor", async () => {
  const { core, post, storage } = await setup();
  const asks = storage.connection;
  const ask = (input: Record<string, unknown>) =>
    value<QuestionRecord>(asks.call("question_ask", input));
  await value(
    asks.call("progress_set", {
      state: "waiting",
      summary: "Moving storage to SQLite.",
      items: [{ title: "Drop the v1 tables", state: "waiting" }],
    }),
  );
  const tables = await ask({
    text: "Keep the v1 tables?",
    options: [{ label: "Keep" }, { label: "Drop", detail: "Nothing has shipped." }],
    recommendation: "Drop",
  });
  const release = await ask({
    text: "Promote to prod?",
    options: [{ label: "Promote" }, { label: "Hold" }],
    recommendation: "Promote",
    answerer: core.rootId,
  });
  const note = await value<MessageRecord>(
    asks.call("message_send", { to: core.rootId, text: "The migration starts tonight." }),
  );

  const open = await json(post("/api/interfaces/questions", { to: core.rootId, open: true }));
  assert.deepEqual(
    open.questions.map((each: QuestionRecord) => each.id).sort(),
    [tables.id, release.id].sort(),
  );
  const unread = await json(post("/api/interfaces/messages", { unread: true }));
  assert.deepEqual(
    unread.messages.map((each: MessageRecord) => each.id),
    [note.id],
  );
  const { positions } = await json(post("/api/interfaces/team", { depth: 1 }));
  const position = positions.find((each: { id: string }) => each.id === storage.id);
  assert.equal(position.progress.state, "waiting");
  assert.deepEqual(
    position.questions.map((each: QuestionRecord) => each.id),
    [tables.id, release.id],
  );

  const waiting = value<{ questions: QuestionRecord[] }>(
    asks.call("questions", { from: storage.id, since: release.cursor, wait: 5 }),
  );
  const answered = await json(
    post("/api/interfaces/question_answer", {
      questions: [tables.id, release.id],
      text: "Drop them, and promote once the tests pass.",
    }),
  );
  assert.ok(answered);
  const { questions } = await waiting;
  assert.deepEqual(questions.map((each) => each.id).sort(), [tables.id, release.id].sort());
  for (const each of questions) {
    assert.deepEqual(
      { by: each.answer?.by, text: each.answer?.text, recorded: each.answer?.recorded },
      { by: core.rootId, text: "Drop them, and promote once the tests pass.", recorded: false },
    );
  }

  assert.equal((await post("/api/interfaces/message_read", { ids: [note.id] })).status, 200);
  assert.deepEqual((await json(post("/api/interfaces/messages", { unread: true }))).messages, []);
  const left = await json(post("/api/interfaces/questions", { to: core.rootId, open: true }));
  assert.deepEqual(left.questions, []);
});

test("the user messages any actor, which reads it from its inbox", async () => {
  const { post, storage } = await setup();
  const waiting = storage.connection.call("messages", { wait: 5 });
  const sent = await json(
    post("/api/interfaces/message_send", { to: storage.id, text: "Pause the backfill." }),
  );
  const inbox = await value<{ messages: MessageRecord[] }>(waiting);
  assert.deepEqual(
    inbox.messages.map((each) => [each.id, each.text]),
    [[sent.id, "Pause the backfill."]],
  );
});
