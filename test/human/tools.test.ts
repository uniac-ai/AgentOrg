import assert from "node:assert/strict";
import { test } from "node:test";
import { STORAGE } from "./fake-core.ts";
import { DECISION, json, setup } from "./harness.ts";

test("the core lists the human's three tools, each run as a task", async () => {
  const { core } = await setup();
  const { tools } = (await core.peer()?.listTools()) ?? { tools: [] };
  assert.deepEqual(
    tools.map((tool) => [tool.name, tool.execution?.taskSupport]),
    [
      ["decide", "required"],
      ["note", "required"],
      ["report", "required"],
    ],
  );
  const output: Record<string, unknown> =
    tools.find((tool) => tool.name === "decide")?.outputSchema ?? {};
  assert.deepEqual(output.required, ["choice", "words"]);
  assert.deepEqual(output.anyOf, [
    { properties: { choice: { type: "string" } } },
    { properties: { words: { type: "string" } } },
  ]);
  const note = tools.find((tool) => tool.name === "note")?.outputSchema;
  assert.deepEqual(note, { type: "object", properties: {}, additionalProperties: false });
});

test("a decide waits on the user, with who it is from, and its caller gets the user's answer", async () => {
  const { core, pending, post } = await setup();
  const call = core.deliver("decide", DECISION);

  const [held] = await pending(call);
  assert.deepEqual(
    { ...held, received_at: undefined },
    { call, from: STORAGE, cause: null, tool: "decide", input: DECISION, received_at: undefined },
  );

  const answered = await post(`/api/pending/${call}`, { choice: "Drop", words: "Start clean." });
  assert.equal(answered.status, 200);
  const settled = await core.settled(call);
  assert.equal(settled.state, "done");
  assert.deepEqual(settled.output, { choice: "Drop", words: "Start clean." });
  await pending();
});

test("a decision's answer is one of its options, the user's words, or both", async () => {
  const { core, pending, post } = await setup();
  const call = core.deliver("decide", DECISION);
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
  assert.equal(core.calls.get(call)?.state, "pending");

  const answer = { choice: null, words: "Ask me tomorrow." };
  assert.equal((await post(`/api/pending/${call}`, answer)).status, 200);
  assert.deepEqual((await core.settled(call)).output, answer);
});

test("a note completes with nothing once read, and a report once acknowledged", async () => {
  const { core, pending, post } = await setup();
  const note = core.deliver("note", { text: "The migration starts tonight." });
  await pending(note);
  const report = core.deliver("report", { outcome: "Storage moved to SQLite." });
  await pending(note, report);

  assert.equal((await post(`/api/pending/${note}`, {})).status, 200);
  assert.deepEqual((await core.settled(note)).output, {});
  assert.equal((await post(`/api/pending/${report}`, {})).status, 400);
  assert.equal((await post(`/api/pending/${report}`, { acknowledged: true })).status, 200);
  assert.deepEqual((await core.settled(report)).output, { acknowledged: true });
});

test("a call the human's tool refuses fails at the core and never waits on the user", async () => {
  const { core, pending } = await setup();
  const call = core.deliver("decide", { ...DECISION, recommendation: "Neither" });
  const failed = await core.settled(call);
  assert.equal(failed.state, "failed");
  assert.match(failed.error ?? "", /recommendation/);
  await pending();
});

test("a call answered or withdrawn no longer waits, and answering it is not found", async () => {
  const { core, pending, post } = await setup();
  const answered = core.deliver("note", { text: "Read me." });
  const withdrawn = core.deliver("decide", DECISION);
  await pending(answered, withdrawn);

  assert.equal((await post(`/api/pending/${answered}`)).status, 200);
  await core.withdraw(withdrawn);
  await pending();
  for (const call of [answered, withdrawn]) {
    const again = await post(`/api/pending/${call}`, { choice: "Keep", words: null });
    assert.equal(again.status, 404);
    assert.equal((await json(again)).code, "not_found");
  }
});
