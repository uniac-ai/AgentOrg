import assert from "node:assert/strict";
import { test } from "node:test";
import { DECISION, json, setup } from "./harness.ts";

test("the core learns the human's three interfaces, each long-running and note one-way", async () => {
  const { core } = await setup();
  const interfaces = core.org.registry.get(core.rootId)?.interfaces ?? [];
  assert.deepEqual(
    interfaces.map((each) => [each.name, each.long_running, each.one_way]),
    [
      ["decide", true, false],
      ["note", true, true],
      ["report", true, false],
    ],
  );
  const output: Record<string, unknown> =
    interfaces.find((each) => each.name === "decide")?.output ?? {};
  assert.deepEqual(output.required, ["choice", "words"]);
  assert.deepEqual(output.anyOf, [
    { properties: { choice: { type: "string" } } },
    { properties: { words: { type: "string" } } },
  ]);
  const note = interfaces.find((each) => each.name === "note")?.output;
  assert.deepEqual(note, { type: "object", properties: {}, additionalProperties: false });
});

test("a program's decide waits on the user, with who it is from, and the program gets the answer", async () => {
  const { storage, pending, post } = await setup();
  const call = await storage.ask("decide", DECISION);

  const [held] = await pending(call);
  assert.deepEqual(
    { ...held, received_at: undefined },
    {
      call,
      from: storage.id,
      cause: null,
      interface: "decide",
      input: DECISION,
      received_at: undefined,
    },
  );
  assert.equal((await storage.result(call, 0)).state, "pending");

  const answer = { choice: "Drop", words: "Start clean." };
  assert.equal((await post(`/api/pending/${call}`, answer)).status, 200);
  const settled = await storage.result(call);
  assert.equal(settled.state, "done");
  assert.deepEqual(settled.output?.value, answer);
  await pending();
});

test("a decision's answer is one of its options, the user's words, or both", async () => {
  const { storage, pending, post } = await setup();
  const call = await storage.ask("decide", DECISION);
  await pending(call);

  for (const answer of [
    { choice: "Maybe", words: null },
    { choice: null, words: null },
    { choice: "Keep" },
  ]) {
    const refused = await post(`/api/pending/${call}`, answer);
    assert.equal(refused.status, 400, JSON.stringify(answer));
    assert.equal((await json(refused)).code, "invalid");
  }
  assert.equal((await storage.result(call, 0)).state, "pending");

  const answer = { choice: null, words: "Ask me tomorrow." };
  assert.equal((await post(`/api/pending/${call}`, answer)).status, 200);
  assert.deepEqual((await storage.result(call)).output?.value, answer);
});

test("a note completes with nothing once read, and a report once acknowledged", async () => {
  const { storage, pending, post } = await setup();
  const note = await storage.ask("note", { text: "The migration starts tonight." });
  await pending(note);
  const report = await storage.ask("report", { outcome: "Storage moved to SQLite." });
  await pending(note, report);

  assert.equal((await post(`/api/pending/${note}`, {})).status, 200);
  assert.deepEqual((await storage.result(note)).output?.value, {});
  assert.equal((await post(`/api/pending/${report}`, {})).status, 400);
  assert.equal((await post(`/api/pending/${report}`, { acknowledged: true })).status, 200);
  const acknowledged = await storage.result(report);
  assert.deepEqual(acknowledged.output?.value, { acknowledged: true });
});

test("a call the human's interface refuses fails at the core and never waits on the user", async () => {
  const { storage, pending } = await setup();
  const call = await storage.ask("decide", { ...DECISION, recommendation: "Neither" });
  const failed = await storage.result(call);
  assert.equal(failed.state, "failed");
  assert.match(failed.error ?? "", /recommendation/);
  await pending();
});

test("a call answered or withdrawn no longer waits, and answering it is not found", async () => {
  const { storage, pending, post } = await setup();
  const answered = await storage.ask("note", { text: "Read me." });
  const withdrawn = await storage.ask("decide", DECISION);
  await pending(answered, withdrawn);

  assert.equal((await post(`/api/pending/${answered}`)).status, 200);
  await storage.withdraw(withdrawn);
  await pending();
  for (const call of [answered, withdrawn]) {
    const again = await post(`/api/pending/${call}`, { choice: "Keep", words: null });
    assert.equal(again.status, 404);
    assert.equal((await json(again)).code, "not_found");
  }
});
