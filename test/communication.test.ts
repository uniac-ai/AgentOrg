/** The communication standard: progress, messages and questions. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ActorCreate,
  COMMUNICATION,
  MessageSend,
  objectSchema,
  ProgressSet,
  QuestionAnswerRequest,
  QuestionAsk,
} from "../src/domain/model/index.ts";

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

test("a handle that begins a built-in's name is refused, and one that is a whole built-in's is not", () => {
  const named = (name: string) => issues(ActorCreate.safeParse({ name, purpose: "Work" }));
  for (const name of ["actor", "call", "status"]) {
    assert.deepEqual(named(name), ["name: begins a built-in's name, as call does"], name);
  }
  for (const name of ["team", "messages", "questions", "activity", "storage"]) {
    assert.deepEqual(named(name), [], name);
  }
});
